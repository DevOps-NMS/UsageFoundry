import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers what `queueView` puts in front of the operator, and only that.
 *
 * `selectQueueBatches` is the rule and is tested pure in `mergeQueue.test.ts`.
 * This is the other half, and it is the half that was wrong: the query never
 * consulted a rule at all — it took the newest `batch_id` and returned that
 * batch, whatever else was outstanding. So a second press of Land hid the first
 * one's rows while the worker, which has never been batch-aware, went on merging
 * them into the operator's own checkout; and `cancelBatch` is scoped by
 * `batch_id`, so a batch the page could not name was a batch nobody could stop.
 *
 * Every way of getting this wrong again is silent. The page renders whatever
 * list it is handed, correctly, and says nothing about the merges missing from
 * it — and a merge has no undo.
 *
 * Its own file, on `chatOrder.test.ts`'s grounds: `config.ts` reads `DATA_DIR`
 * at module load and `mergeQueue.test.ts` imports `./mergeQueue` statically, so
 * by the time a test body ran the path would already be bound to the
 * repository's own `.data` directory — which on a developer's machine is the
 * real one.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uf-merge-queue-view-"));
process.env.DATA_DIR = dataDir;

type QueueModule = typeof import("./mergeQueue");
type DbModule = typeof import("./db");

let queue: QueueModule;
let dbMod: DbModule;

before(async () => {
  queue = await import("./mergeQueue");
  dbMod = await import("./db");

  const runs = dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, created_at)
       VALUES (?, '/workspace/repo', 'task', 'completed', '{}', 1)`,
    );
  const rows = dbMod.db().prepare(
    `INSERT INTO merge_queue
       (id, batch_id, run_id, position, strategy, auto_resolve, status, created_at)
     VALUES (?, ?, ?, ?, 'merge', 0, ?, ?)`,
  );

  // The reproduction from the issue, shortened: one repository's branches
  // queued and part-way through, another's queued while the worker is still on
  // them.
  const at = (batchId: string, when: number, statuses: string[]) =>
    statuses.forEach((status, i) => {
      const runId = `${batchId}-${i}`;
      runs.run(runId);
      rows.run(`${batchId}-row-${i}`, batchId, runId, i, status, when);
    });

  at("web", 1_000, ["landed", "landing", "queued", "queued"]);
  at("billing", 2_000, ["queued", "queued", "queued"]);
});

after(() => {
  (globalThis as { __ufDb?: Database.Database }).__ufDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the merge queue view", () => {
  it("covers a batch still working under a newer one, oldest first", () => {
    const view = queue.queueView();
    assert.deepEqual(
      view.map((b) => b.batchId),
      ["web", "billing"],
    );
    // Whole, landed rows included: "1 landed · 2 waiting" is a sentence about a
    // batch, and a batch trimmed to its unfinished rows reads as one that had
    // not started.
    assert.deepEqual(
      view[0].rows.map((r) => r.status),
      ["landed", "landing", "queued", "queued"],
    );
    assert.equal(view[0].createdAt, 1_000);
  });

  it("hands every unfinished row to the page, across batches", () => {
    const active = queue
      .queueView()
      .flatMap((b) => b.rows)
      .filter((r) => queue.isQueueActive(r.status));
    assert.equal(active.length, 6);
  });

  it("lets Cancel reach a batch that is not the newest, and leaves the merge in flight alone", () => {
    assert.equal(queue.cancelBatch("web"), 2);
    const view = queue.queueView();
    assert.deepEqual(
      view.find((b) => b.batchId === "web")?.rows.map((r) => r.status),
      // The `landing` row is a multi-step write into a directory a person works
      // in; interrupting it part-way is worse than the second it takes to end.
      ["landed", "landing", "cancelled", "cancelled"],
    );
    // The other batch is untouched: cancelling is per batch, which is the whole
    // reason the page has to be able to name each one.
    assert.deepEqual(
      view.find((b) => b.batchId === "billing")?.rows.map((r) => r.status),
      ["queued", "queued", "queued"],
    );
  });
});
