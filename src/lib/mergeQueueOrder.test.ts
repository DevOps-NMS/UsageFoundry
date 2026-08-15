import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers the order the merge worker takes rows in, and only that.
 *
 * `position` is an index within one batch and restarts at 0 for the next, so
 * the worker's old `ORDER BY position, created_at` sorted a batch queued while
 * it was still draining an earlier one *ahead* of that batch's remaining rows:
 * three branches at 0,1,2 and two at 0,1 came out A0, B0, A1, B1, A2. Nothing
 * crashes — every item is re-previewed against git at its own turn, so nothing
 * merges that git would refuse — and that is exactly why it earns a test: what
 * is lost is the operator's sequence, silently, in merge commits in their own
 * checkout, and a merge has no undo.
 *
 * It opens a database because the decision is the SQL, the same grounds
 * `chatOrder.test.ts` is on: a comparator beside the query would be a second
 * copy of the rule, and the copy is the one that would stay right. Its own file
 * for that file's reason too — `config.ts` reads `DATA_DIR` at module load, and
 * `mergeQueue.test.ts` imports `./mergeQueue` statically, so by the time any
 * test body ran the path would be bound to the repository's own `.data`
 * directory, which on a developer's machine is the real one.
 */

let mergeQueue: typeof import("./mergeQueue");
let dbMod: typeof import("./db");
let root: string;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-merge-order-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // Nothing here should reach a spawn — this drives the selector, never the
  // worker. A `claude` that does not exist makes a regression that gets that
  // far a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  mergeQueue = await import("./mergeQueue");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const REPO = "/workspace/repo";

/** A batch as `enqueue` writes one: one timestamp, positions from 0. */
function queueBatch(
  batchId: string,
  createdAt: number,
  runIds: string[],
  repo: string = REPO,
): void {
  const run = dbMod
    .db()
    .prepare(
      "INSERT INTO runs (id, folder, repo_root, prompt, status, budget, created_at)" +
        " VALUES (?, ?, ?, 'task', 'completed', '{}', ?)",
    );
  const item = dbMod
    .db()
    .prepare(
      `INSERT INTO merge_queue
         (id, batch_id, run_id, position, strategy, auto_resolve, status, created_at)
       VALUES (?, ?, ?, ?, 'merge', 0, 'queued', ?)`,
    );
  runIds.forEach((runId, i) => {
    run.run(runId, repo, repo, createdAt);
    item.run(`q-${runId}`, batchId, runId, i, createdAt);
  });
}

/**
 * The sequence one repository's worker would land in.
 *
 * `drainRepo`'s loop with everything that touches git taken out: take the next
 * row for this repository, settle it, ask again. Settling is what makes the
 * next call move on, so a selector that returned the same row for ever would
 * hang here rather than pass.
 */
function drain(repo: string = REPO): string[] {
  const settled: string[] = [];
  for (let row = mergeQueue.nextQueuedIn(repo); row; row = mergeQueue.nextQueuedIn(repo)) {
    settled.push(row.run_id);
    dbMod.db().prepare("UPDATE merge_queue SET status='landed' WHERE id=?").run(row.id);
    if (settled.length > 20) assert.fail("the queue never drained");
  }
  return settled;
}

describe("merge queue order", () => {
  it("drains a batch whole before starting one queued after it", () => {
    const t = 1_786_470_000_000;
    queueBatch("batch-a", t, ["a0", "a1", "a2"]);
    // Queued while the worker was mid-way through the first, which is the
    // ordinary case: the worker is a single sequential loop, and with several
    // repositories in flight the queue is essentially never empty.
    queueBatch("batch-b", t + 60_000, ["b0", "b1"]);

    // Not a0, b0, a1, b1, a2 — b0 there is a branch merging into the operator's
    // checkout between two branches they had already put in order.
    assert.deepEqual(drain(), ["a0", "a1", "a2", "b0", "b1"]);
  });

  it("keeps the operator's order inside a batch", () => {
    const t = 1_786_471_000_000;
    queueBatch("batch-c", t, ["c0", "c1", "c2", "c3"]);
    assert.deepEqual(drain(), ["c0", "c1", "c2", "c3"]);
  });

  it("does not interleave two batches that share a millisecond", () => {
    // Reachable rather than theoretical: a workflow instance releases its merge
    // blocks in one synchronous pass, so two of them call `enqueue` on the same
    // `Date.now()`. Which batch goes first cannot be the operator's order —
    // they were queued at the same instant — but interleaving is still the one
    // outcome nobody chose.
    const t = 1_786_472_000_000;
    queueBatch("batch-d", t, ["d0", "d1", "d2"]);
    queueBatch("batch-e", t, ["e0", "e1"]);

    const settled = drain();
    const batches = settled.map((id) => id[0]);
    assert.equal(
      new Set(batches).size,
      2,
      `both batches should be drained, got ${settled.join(",")}`,
    );
    assert.equal(
      batches.filter((b, i) => i > 0 && b !== batches[i - 1]).length,
      1,
      `one batch should follow the other whole, got ${settled.join(",")}`,
    );
    // And within whichever went first, the operator's order still holds.
    assert.deepEqual(
      settled.filter((id) => id.startsWith("d")),
      ["d0", "d1", "d2"],
    );
  });
});

/**
 * Which branches are eligible while one is in flight.
 *
 * One global worker took the globally-lowest queued row whatever repository it
 * belonged to, and awaited it to completion — so a twelve-minute conflict
 * resolution in one repository held every clean branch in all the others, with
 * nothing in their rows saying why. Nothing was ever *wrong*, which is exactly
 * why it needs a test rather than a bug report: throughput collapsed and every
 * page in this app showed a queue behaving normally.
 *
 * The two halves are one question and are asserted together, because the way to
 * "fix" the first is to drop the second: within one repository the sequence
 * must still be strictly one at a time in the operator's order, since each
 * landing changes the base for the next.
 */
describe("merge queue concurrency", () => {
  /**
   * Every earlier case in this file leaves its rows settled; the first case
   * below deliberately does not, since a row held in flight is the whole point
   * of it. So each starts from an empty queue rather than inheriting one.
   */
  function settleAll(): void {
    dbMod
      .db()
      .prepare("UPDATE merge_queue SET status='landed' WHERE status IN ('queued','resolving')")
      .run();
  }

  it("leaves another repository's branch eligible while one is in flight", () => {
    settleAll();
    const t = 1_786_473_000_000;
    queueBatch("batch-f", t, ["f0", "f1"], "/workspace/alpha");
    queueBatch("batch-g", t + 1_000, ["g0"], "/workspace/beta");

    // The worker claims alpha's first row and holds it — a conflict resolution
    // is bounded at twelve minutes, so this is the ordinary case rather than an
    // edge one.
    const inFlight = mergeQueue.nextQueuedIn("/workspace/alpha");
    assert.equal(inFlight?.run_id, "f0");
    dbMod.db().prepare("UPDATE merge_queue SET status='resolving' WHERE id=?").run(inFlight!.id);

    // beta has work and no worker, so a worker starts there.
    assert.deepEqual(mergeQueue.queuedRepos(), ["/workspace/alpha", "/workspace/beta"]);
    assert.equal(mergeQueue.nextQueuedIn("/workspace/beta")?.run_id, "g0");

    // And alpha's own second branch is not: it waits for f0, which is the whole
    // of what one merge per repository means.
    assert.equal(mergeQueue.nextQueuedIn("/workspace/alpha")?.run_id, "f1");
    assert.notEqual(inFlight!.run_id, "f1");
  });

  it("orders the repositories by their oldest queued work", () => {
    settleAll();
    // Only decides which repository waits when the worker cap is reached, and
    // the operator's oldest press of Land should not be the one that does.
    const t = 1_786_474_000_000;
    queueBatch("batch-h", t + 5_000, ["h0"], "/workspace/zulu");
    queueBatch("batch-i", t, ["i0"], "/workspace/yankee");
    assert.deepEqual(mergeQueue.queuedRepos(), ["/workspace/yankee", "/workspace/zulu"]);
  });

  it("still reaches a row whose run is missing", () => {
    settleAll();
    // Why the join is a LEFT one. `merge_queue.run_id` cascades on delete, so
    // nothing this app does produces such a row today — but an inner join makes
    // the worker's own "that run no longer exists" branch unreachable *and*
    // leaves the row `queued` for ever if it ever does, with no worker that
    // could fail it. The cascade is switched off here rather than pretended
    // around, because a state reached by a restore or a schema change is still
    // a state the selector has to have an answer for.
    const t = 1_786_475_000_000;
    queueBatch("batch-j", t, ["j0"], "/workspace/kilo");
    dbMod.db().pragma("foreign_keys = OFF");
    try {
      dbMod.db().prepare("DELETE FROM runs WHERE id='j0'").run();
    } finally {
      dbMod.db().pragma("foreign_keys = ON");
    }

    assert.deepEqual(mergeQueue.queuedRepos(), [""]);
    assert.equal(mergeQueue.nextQueuedIn("")?.run_id, "j0");
  });
});
