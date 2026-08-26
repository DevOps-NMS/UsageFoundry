import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The `fork_attempts` row, written and read back against a real database.
 *
 * This file exists because of a bug the arithmetic tests could not see. The
 * INSERT listed twelve columns and bound thirteen values; better-sqlite3
 * rejects that at bind time, `recordForkAttempt` catches and returns null, and
 * the whole feature went quiet — no fork was ever recorded, `forkSavings`
 * summed an empty table, and `resumed` (which is milestone 2's acceptance
 * criterion) could never be written. Nothing threw, nothing logged, and the
 * savings panel showed $0, which reads as "the fork engine did nothing".
 *
 * `parseFork` and `forkCutFromRow` were both tested. The defect sat between
 * them, in the one step that needs a driver and a schema, so it survived. That
 * is the argument for this file: the arity of a prepared statement is not
 * checked by the type system, and a mock would have accepted it.
 *
 * The fixture's numbers are deliberately all different from one another. An
 * all-zeros row passes even when two columns are transposed; distinct values
 * catch an off-by-one shift as well as the arity error that prompted this.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uf-fork-attempts-"));

before(() => {
  process.env.DATA_DIR = path.join(TMP, ".data");
  process.env.CLAUDE_HOME = path.join(TMP, "claude");
  fs.mkdirSync(path.join(TMP, "claude", "projects"), { recursive: true });
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const WRITTEN = {
  written: true,
  newSessionId: "4356069f-3111-569c-842e-a766dbbfbeab",
  out: "/tmp/x/4356069f.jsonl",
  refusedBy: null,
  reason: null,
  removedBytes: 24_029,
  netBytes: 22_725,
  suffixBytes: 122_902,
  breakEvenTurns: 82.8,
  coldAgeSeconds: 12.5,
};

const REFUSED = {
  written: false,
  newSessionId: null,
  out: null,
  refusedBy: "cold-age",
  reason: "this session's last request finished 0s ago",
  removedBytes: 24_029,
  netBytes: 22_725,
  suffixBytes: 122_902,
  breakEvenTurns: 82.8,
  coldAgeSeconds: 0.1,
};

describe("recordForkAttempt", () => {
  it("writes a row at all, and every column lands where it belongs", async () => {
    const { recordForkAttempt } = await import("./contextPruning.js");
    const { db } = await import("./db.js");

    const rowId = recordForkAttempt("run-a", "src-session", WRITTEN, 300);
    assert.notEqual(
      rowId,
      null,
      "a null row id is the shape of a silently refused insert",
    );

    const row = db()
      .prepare("SELECT * FROM fork_attempts WHERE id = ?")
      .get(rowId) as Record<string, unknown>;
    assert.equal(row.run_id, "run-a");
    assert.equal(row.source_session_id, "src-session");
    assert.equal(row.new_session_id, WRITTEN.newSessionId);
    assert.equal(row.written, 1);
    assert.equal(row.removed_bytes, 24_029);
    assert.equal(row.net_bytes, 22_725);
    // The column whose absence from the INSERT list caused the failure.
    assert.equal(row.suffix_bytes, 122_902);
    assert.equal(row.break_even_turns, 82.8);
    assert.equal(row.cold_age_seconds, 12.5);
    assert.equal(row.min_cold_age, 300);
    assert.equal(row.resumed, null, "a fork has no verdict until one resumes it");
  });

  it("records a refusal, because that is the common outcome at a boundary", async () => {
    // At winnow's default cold age every boundary refuses. An operator who
    // switched the engine on and saw nothing happen has to be able to read
    // forty cold-age rows rather than find an empty table and conclude the
    // feature is broken.
    const { recordForkAttempt } = await import("./contextPruning.js");
    const { db } = await import("./db.js");

    const rowId = recordForkAttempt("run-b", "src-session", REFUSED, 3600);
    assert.notEqual(rowId, null);

    const row = db()
      .prepare("SELECT * FROM fork_attempts WHERE id = ?")
      .get(rowId) as Record<string, unknown>;
    assert.equal(row.written, 0);
    assert.equal(row.new_session_id, null, "nothing was written, so nothing is named");
    assert.equal(row.refused_by, "cold-age");
    assert.equal(row.min_cold_age, 3600);
  });

  it("carries the verdict a resume gives it, in both directions", async () => {
    const { recordForkAttempt, markForkResumed } = await import("./contextPruning.js");
    const { db } = await import("./db.js");
    const read = (id: number) =>
      (db().prepare("SELECT resumed FROM fork_attempts WHERE id = ?").get(id) as {
        resumed: number | null;
      }).resumed;

    const good = recordForkAttempt("run-c", "s", WRITTEN, 0)!;
    markForkResumed(good, true);
    assert.equal(read(good), 1);

    // The kill condition. It has to be writable, or milestone 2's guardrail
    // cannot fail — which is worse than failing it.
    const bad = recordForkAttempt("run-d", "s", WRITTEN, 0)!;
    markForkResumed(bad, false);
    assert.equal(read(bad), 0);
  });

  it("finds a fork a parked run came back holding, and only that one", async () => {
    const { recordForkAttempt, markForkResumed, pendingForkFor } = await import(
      "./contextPruning.js"
    );

    const rowId = recordForkAttempt("run-e", "before-the-fork", WRITTEN, 0)!;
    const found = pendingForkFor("run-e", WRITTEN.newSessionId);
    assert.equal(found?.rowId, rowId);
    assert.equal(found?.fallbackSessionId, "before-the-fork");

    // Not a fork the run has already moved off.
    assert.equal(pendingForkFor("run-e", "some-other-session"), null);
    // Not one that already has a verdict.
    markForkResumed(rowId, true);
    assert.equal(pendingForkFor("run-e", WRITTEN.newSessionId), null);
  });

  it("turns a recorded fork into a saving, which is the point of recording it", async () => {
    // Ties the row to the symptom. Before the INSERT was fixed this returned
    // zero for every install, and a zero on that panel reads as the engine
    // having done nothing rather than as nothing having been written down.
    const { recordForkAttempt, forkSavings } = await import("./contextPruning.js");
    const { db } = await import("./db.js");
    db()
      .prepare(
        "INSERT OR REPLACE INTO runs (id, folder, prompt, status, budget, created_at, model) VALUES (?,?,?,?,?,?,?)",
      )
      .run("run-f", "/x", "t", "completed", 10, Date.now() - 1000, "claude-opus-5");

    recordForkAttempt("run-f", "s", WRITTEN, 0);
    const savings = await forkSavings({ runId: "run-f" });
    assert.equal(savings.prunes, 1);
    assert.ok(savings.tokensRemoved > 0);
  });
});
