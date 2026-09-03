import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers what the retention sweep deletes from the database, and what it must
 * leave exactly as it found it.
 *
 * `run_events` grew monotonically — every assistant block, every tool call with
 * its whole input, every stderr chunk, ~13 MB per thousand tool events — into a
 * named volume with no size limit, and there was not one `DELETE` for growth
 * anywhere in the codebase. When such a volume fills, every SQLite write fails
 * at once: no run is admitted, no status is written, and `promoteQueued`
 * swallows the rejection, so runs simply stop starting with nothing on any page
 * saying why.
 *
 * It earns a test on the same grounds `mergeQueueOrder.test.ts` does: the
 * decision *is* the SQL. A predicate written beside the query would be a second
 * copy of the rule, and the copy is the one that would stay right — while both
 * ways of getting the real one wrong are silent and expensive in opposite
 * directions. Delete too little and the store is still unbounded; delete too
 * much and a run's own spend record, or the log of a run whose page somebody is
 * reading right now, goes with it.
 *
 * Its own file for that file's reason: `config.ts` reads `DATA_DIR` at module
 * load, so the throwaway directory has to be named before anything that reaches
 * the database is imported — otherwise the path is bound to the repository's
 * own `.data`, which on a developer's machine is the real one.
 */

let retention: typeof import("./retention");
let dbMod: typeof import("./db");
let settings: typeof import("./settings");
let root: string;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_786_470_000_000;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-retention-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // Nothing here reaches a spawn, and a `claude` that does not exist makes a
  // regression that somehow got that far a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  retention = await import("./retention");
  dbMod = await import("./db");
  settings = await import("./settings");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A run with spend on it, and `n` events spread either side of the horizon. */
function seed(o: {
  id: string;
  status: string;
  oldEvents: number;
  freshEvents: number;
}): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, created_at,
                         spent_usd, spent_tokens, iterations, stop_reason)
       VALUES (?, '/workspace/repo', 'task', ?, '{}', ?, 12.5, 4000, 3, 'done')`,
    )
    .run(o.id, o.status, NOW - 90 * DAY);

  const event = dbMod
    .db()
    .prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, 'tool', '{}')",
    );
  const telemetry = dbMod
    .db()
    .prepare(
      `INSERT INTO otlp_requests (request_id, ts, run_id, cost_usd)
       VALUES (?, ?, ?, 0.25)`,
    );

  for (let i = 0; i < o.oldEvents; i++) {
    event.run(o.id, NOW - 60 * DAY);
    telemetry.run(`${o.id}-old-${i}`, NOW - 60 * DAY, o.id);
  }
  for (let i = 0; i < o.freshEvents; i++) {
    event.run(o.id, NOW - 1 * DAY);
    telemetry.run(`${o.id}-new-${i}`, NOW - 1 * DAY, o.id);
  }
}

const eventCount = (runId: string) =>
  (
    dbMod
      .db()
      .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?")
      .get(runId) as { n: number }
  ).n;

const telemetryCount = (runId: string) =>
  (
    dbMod
      .db()
      .prepare("SELECT COUNT(*) AS n FROM otlp_requests WHERE run_id = ?")
      .get(runId) as { n: number }
  ).n;

describe("run_events retention", () => {
  before(() => {
    settings.saveSettings({ eventRetentionDays: 30 });
    seed({ id: "done-run", status: "completed", oldEvents: 5, freshEvents: 2 });
    seed({ id: "failed-run", status: "failed", oldEvents: 3, freshEvents: 0 });
    // The run whose page somebody could be reading right now. Its events are as
    // old as the settled runs' — age is not what protects them.
    seed({ id: "live-run", status: "running", oldEvents: 4, freshEvents: 1 });
    seed({ id: "parked-run", status: "paused", oldEvents: 6, freshEvents: 0 });
  });

  it("discards a settled run's events past the horizon and keeps the rest", () => {
    const swept = retention.sweepRunEvents(NOW);

    assert.equal(eventCount("done-run"), 2, "the fresh events should survive");
    assert.equal(eventCount("failed-run"), 0);
    assert.equal(swept.events, 8, "five from one settled run and three from the other");
  });

  it("leaves a run still in flight untouched", () => {
    // The acceptance criterion this whole sweep is bounded by: a `running` row
    // and a `paused` one keep every line, however far past the horizon they
    // are. The alternative is a log losing rows under the reader, and a parked
    // run coming back hours later to a history with a hole in it.
    assert.equal(eventCount("live-run"), 5);
    assert.equal(eventCount("parked-run"), 6);
    assert.equal(telemetryCount("live-run"), 5);
    assert.equal(telemetryCount("parked-run"), 6);
  });

  it("never touches the run row or what it spent", () => {
    const rows = dbMod
      .db()
      .prepare(
        "SELECT id, spent_usd, spent_tokens, iterations, stop_reason, status FROM runs ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;

    assert.equal(rows.length, 4, "no run may be deleted by a retention sweep");
    for (const row of rows) {
      assert.equal(row.spent_usd, 12.5, `${row.id} lost its spend`);
      assert.equal(row.spent_tokens, 4000);
      assert.equal(row.iterations, 3);
      assert.equal(row.stop_reason, "done");
    }
  });

  it("discards the telemetry rows beside them, on the same horizon", () => {
    assert.equal(telemetryCount("done-run"), 2);
    assert.equal(telemetryCount("failed-run"), 0);
  });

  it("keeps everything when the horizon is blank", () => {
    settings.saveSettings({ eventRetentionDays: null });
    seed({ id: "no-horizon", status: "completed", oldEvents: 4, freshEvents: 0 });

    const swept = retention.sweepRunEvents(NOW);
    // Deep-equal rather than three field checks, and that is the point of the
    // case: a store added to this sweep later must be named here or it is one
    // this blank horizon does not cover, which is a silent deletion on an
    // install that asked to keep everything.
    assert.deepEqual(swept, {
      events: 0,
      telemetry: 0,
      samples: 0,
      decisions: 0,
      compositions: 0,
    });
    assert.equal(eventCount("no-horizon"), 4);
  });

  it("records what it did, so the page can say when it last ran", async () => {
    settings.saveSettings({ eventRetentionDays: 30 });
    const result = await retention.runRetentionSweep(NOW);

    assert.equal(result.at, NOW);
    assert.equal(result.events, 4, "the run seeded under a blank horizon");
    assert.deepEqual(retention.lastSweep(), result);
  });
});

describe("retentionCutoff", () => {
  it("reads a blank horizon as keep-for-ever rather than as now", () => {
    // The reading that matters: a zero falling through as a cutoff of `now`
    // would delete every settled run's log the first time somebody typed one.
    assert.equal(retention.retentionCutoff(null, NOW), null);
    assert.equal(retention.retentionCutoff(0, NOW), null);
    assert.equal(retention.retentionCutoff(-5, NOW), null);
    assert.equal(retention.retentionCutoff(30, NOW), NOW - 30 * DAY);
  });
});
