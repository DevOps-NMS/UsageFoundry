import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers what the merge-queue card puts in front of the operator, and only that
 * — `queueView` for the panel and `queueHistory` for the disclosure under it.
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

  // Three finished batches older than either of those, which is what the
  // history disclosure exists for: they used to be on the card for as long as
  // they were in the newest three, and then gone from the app entirely.
  at("done-ancient", 50, ["landed"]);
  at("done-oldest", 100, ["landed", "landed"]);
  at("done-newer", 200, ["landed", "failed"]);

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
    // Both unfinished batches, however old — the worker drains the whole table,
    // so one it is still merging must be on the panel without anybody opening a
    // disclosure. Plus `done-newer`, which is the last thing that finished: this
    // is the two-repositories case the tail exists for, where one repository's
    // report of what landed would otherwise go the moment the next press of Land
    // arrived. `done-oldest` is the history's.
    assert.deepEqual(
      view.map((b) => b.batchId),
      ["done-newer", "web", "billing"],
    );
    // Whole, landed rows included: "1 landed · 2 waiting" is a sentence about a
    // batch, and a batch trimmed to its unfinished rows reads as one that had
    // not started.
    const web = view.find((b) => b.batchId === "web");
    assert.deepEqual(
      web?.rows.map((r) => r.status),
      ["landed", "landing", "queued", "queued"],
    );
    assert.equal(web?.createdAt, 1_000);
  });

  it("hands every unfinished row to the page, across batches", () => {
    const active = queue
      .queueView()
      .flatMap((b) => b.rows)
      .filter((r) => queue.isQueueActive(r.status));
    assert.equal(active.length, 6);
  });

  it("counts the earlier batches without reading a row of them", () => {
    // What the closed disclosure is labelled with. The card polls every three
    // seconds while the worker runs, so this is the case that has to stay cheap
    // — and it still has to be a true count, or a history that had not loaded
    // would read as an install that has only ever pressed Land twice.
    const history = queue.queueHistory(false);
    assert.equal(history.total, 2);
    assert.deepEqual(history.batches, []);
  });

  it("hands the earlier batches over whole, newest first, when they are asked for", () => {
    const history = queue.queueHistory(true);
    assert.deepEqual(
      history.batches.map((b) => b.batchId),
      ["done-oldest", "done-ancient"],
    );
    // Whole, and in the operator's own order within the batch — a past press of
    // Land reads exactly as it did while it was running.
    assert.deepEqual(
      history.batches[0].rows.map((r) => r.status),
      ["landed", "landed"],
    );
    assert.equal(history.batches[0].createdAt, 100);
  });

  it("puts every batch in exactly one of the two lists", () => {
    // The pair is one decision read from both ends. A batch in neither is a
    // press of Land with no record anywhere in the app; in both, it is the same
    // rows twice on one card. Both are silent.
    const shown = queue.queueView().map((b) => b.batchId);
    const hidden = queue.queueHistory(true).batches.map((b) => b.batchId);
    assert.deepEqual([...shown, ...hidden].sort(), [
      "billing",
      "done-ancient",
      "done-newer",
      "done-oldest",
      "web",
    ]);
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
