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

/** A batch as `enqueue` writes one: one timestamp, positions from 0. */
function queueBatch(batchId: string, createdAt: number, runIds: string[]): void {
  const run = dbMod
    .db()
    .prepare(
      "INSERT INTO runs (id, folder, prompt, status, budget, created_at)" +
        " VALUES (?, '/workspace/repo', 'task', 'completed', '{}', ?)",
    );
  const item = dbMod
    .db()
    .prepare(
      `INSERT INTO merge_queue
         (id, batch_id, run_id, position, strategy, auto_resolve, status, created_at)
       VALUES (?, ?, ?, ?, 'merge', 0, 'queued', ?)`,
    );
  runIds.forEach((runId, i) => {
    run.run(runId, createdAt);
    item.run(`q-${runId}`, batchId, runId, i, createdAt);
  });
}

/**
 * The sequence the worker would land in.
 *
 * `startWorker`'s loop with everything that touches git taken out: take the
 * next row, settle it, ask again. Settling is what makes the next call move on,
 * so a selector that returned the same row for ever would hang here rather than
 * pass.
 */
function drain(): string[] {
  const settled: string[] = [];
  for (let row = mergeQueue.nextQueued(); row; row = mergeQueue.nextQueued()) {
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
