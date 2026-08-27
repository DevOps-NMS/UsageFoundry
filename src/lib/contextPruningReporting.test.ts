import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers one thing: a bookkeeping write or read that fails says so.
 *
 * `fork_attempts` shipped without the `suffix_bytes` column its own INSERT
 * names. The write threw at every fork, `recordForkAttempt` caught it and
 * returned null, and the table stayed empty — which is exactly what a fork
 * engine that had never run would also look like. A day of runs produced no
 * evidence about the thing being tested and nothing anywhere said why.
 *
 * The catch is still right: a receipt must not fail the run it describes. What
 * is under test here is that the failure now reaches `ops_events`, where an
 * operator reading the empty table can find it.
 *
 * It earns its own file for `schemaMigration.test.ts`'s first reason: `DATA_DIR`
 * has to be set before `config.ts` is imported, and a file that imported it at
 * the top would run against the repository's real database.
 */

let root: string;
let dbMod: typeof import("./db");
let pruningMod: typeof import("./contextPruning");

/** The shape the table shipped in, before `suffix_bytes` was added to it. */
const FORK_ATTEMPTS_PRE_SUFFIX = `
  CREATE TABLE fork_attempts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                INTEGER NOT NULL,
    run_id            TEXT NOT NULL,
    source_session_id TEXT,
    new_session_id    TEXT,
    written           INTEGER NOT NULL,
    refused_by        TEXT,
    reason            TEXT,
    removed_bytes     INTEGER NOT NULL,
    net_bytes         INTEGER NOT NULL,
    break_even_turns  REAL,
    cold_age_seconds  REAL,
    min_cold_age      INTEGER,
    resumed           INTEGER
  );`;

const FORK: import("./contextPruning").ForkResult = {
  written: true,
  newSessionId: "s-new",
  out: "/tmp/s-new.jsonl",
  refusedBy: null,
  reason: null,
  removedBytes: 4096,
  netBytes: 3072,
  suffixBytes: 81920,
  breakEvenTurns: 18.5,
  coldAgeSeconds: 4.2,
};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-prune-report-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  dbMod = await import("./db");
  pruningMod = await import("./contextPruning");
});

after(() => {
  (globalThis as { __ufDb?: Database.Database }).__ufDb?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function failures(db: Database.Database): { site: string; message: string }[] {
  return (
    db
      .prepare(
        "SELECT detail FROM ops_events WHERE event = 'context_pruning.record_failed' ORDER BY id",
      )
      .all() as { detail: string }[]
  ).map((r) => JSON.parse(r.detail) as { site: string; message: string });
}

describe("a fork attempt that cannot be recorded", () => {
  // `noteBookkeepingFailure` dedupes per process and deliberately offers no
  // reset, so the first case here is the only one that can observe the first
  // occurrence of this fault. A new case that provokes the same message would
  // see the deduped path instead — give it a different table or a different
  // site.
  it("reports the failure once, however many boundaries hit it", () => {
    const db = dbMod.db();
    db.exec("DROP TABLE IF EXISTS fork_attempts");
    db.exec(FORK_ATTEMPTS_PRE_SUFFIX);
    db.exec("DELETE FROM ops_events");

    const ids = Array.from({ length: 20 }, (_, i) =>
      pruningMod.recordForkAttempt(`r${i}`, "s-old", FORK, 0, "boundary", null),
    );

    // Still non-fatal, and still null: the run carries on without a receipt.
    assert.deepEqual(new Set(ids), new Set([null]));

    // One durable row, not twenty. `ops_events` keeps 500 for the whole server,
    // and a fault that recurs at every cycle boundary would otherwise evict
    // everything else an operator might need to read beside it.
    const reported = failures(db);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].site, "recordForkAttempt");
    // The message names the column, which is what makes the row actionable
    // rather than just an alarm.
    assert.match(reported[0].message, /suffix_bytes/);
  });

  it("writes the row once the columns are there", () => {
    const db = dbMod.db();
    db.exec("DROP TABLE IF EXISTS fork_attempts");
    db.exec(FORK_ATTEMPTS_PRE_SUFFIX);
    // Every column `addColumn` adds in `db.ts`, in the same order. This list
    // failing to keep up is itself the fault under test: the INSERT names these
    // and a table without them throws, which `recordForkAttempt` swallows.
    db.exec("ALTER TABLE fork_attempts ADD COLUMN suffix_bytes INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE fork_attempts ADD COLUMN trigger TEXT");
    db.exec("ALTER TABLE fork_attempts ADD COLUMN context_tokens_after INTEGER");
    db.exec("DELETE FROM ops_events");

    const rowId = pruningMod.recordForkAttempt(
      "r-ok",
      "s-old",
      FORK,
      0,
      "early-end",
      180_000,
    );

    assert.notEqual(rowId, null);
    assert.equal(failures(db).length, 0);
    const stored = db
      .prepare(
        "SELECT suffix_bytes s, trigger t, context_tokens_after c FROM fork_attempts WHERE id = ?",
      )
      .get(rowId) as { s: number; t: string; c: number };
    assert.equal(stored.s, 81920);
    // The two that decide how the cut is priced. A fork recorded without them
    // reads as a free boundary cut, which is how three early-end forks came to
    // be reported at $0 against $5.42 of billed rewrite.
    assert.equal(stored.t, "early-end");
    assert.equal(stored.c, 180_000);
  });
});
