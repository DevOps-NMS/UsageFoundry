import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SignatureRollup } from "./dreaming";

/**
 * The ledger's two bookkeeping rules, both of which were wrong until a smoke
 * test against the real corpus caught them, and both of which fail silently.
 *
 * A night that wrote six notes read back as `quiet`, so the one surface that
 * shows this feature reported a night that touched somebody's vault as a night
 * that did nothing. And a second pass in the same calendar night had its
 * report's item numbers mapped onto the *first* pass's signatures, attaching a
 * real file path to a row about a different failure — two rows that both look
 * right, with only the pairing wrong.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `runOrigin.test.ts`'s reason: `config.ts` is read at module load, so a file
 * that imported the ledger at the top would already be bound to the
 * repository's own `.data` — which on a developer's machine is the real one.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-dreaming-ledger-"));
process.env.DATA_DIR = DATA_DIR;

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

type Ledger = typeof import("./dreamingLedger");
type Db = typeof import("./db");

let ledger: Ledger;
let dbMod: Db;

before(async () => {
  ledger = await import("./dreamingLedger");
  dbMod = await import("./db");
});

beforeEach(() => {
  dbMod.db().exec("DELETE FROM dreaming_notes; DELETE FROM dreaming_nights;");
});

const rollup = (signature: string, days: number): SignatureRollup => ({
  signature,
  sample: `${signature} said this`,
  days: Array.from({ length: days }, (_, i) => `2026-08-${String(10 + i).padStart(2, "0")}`),
  instances: days * 2,
  sessions: ["s1"],
});

describe("claimSignatures", () => {
  it("claims before the run writes, so a crash cannot re-hand them to tomorrow", () => {
    const claimed = ledger.claimSignatures("2026-09-02", "run-1", [
      rollup("a", 2),
      rollup("b", 3),
    ]);
    assert.equal(claimed, 2);
    assert.deepEqual([...ledger.writtenSignatures()].sort(), ["a", "b"]);
    // No path yet: claimed is not written, and the pane draws the difference.
    assert.deepEqual(
      ledger.listNotes().map((n) => n.notePath),
      [null, null],
    );
  });

  it("is idempotent, so a retried night does not double-claim", () => {
    ledger.claimSignatures("2026-09-02", "run-1", [rollup("a", 2)]);
    assert.equal(ledger.claimSignatures("2026-09-02", "run-2", [rollup("a", 2)]), 0);
    assert.equal(ledger.listNotes().length, 1);
    // And the first run keeps it — the row names who actually claimed it.
    assert.equal(ledger.listNotes()[0].runId, "run-1");
  });

  it("freezes the readings at the moment of writing", () => {
    // The note in the vault says "seen on 3 days"; re-deriving that later would
    // leave the row disagreeing with the file it points at.
    ledger.claimSignatures("2026-09-02", "run-1", [rollup("a", 3)]);
    const [row] = ledger.listNotes();
    assert.equal(row.daysSeen, 3);
    assert.equal(row.instances, 6);
  });
});

describe("forgetNote", () => {
  it("stops suppressing the signature so a later night may write it again", () => {
    ledger.claimSignatures("2026-09-02", "run-1", [rollup("a", 2)]);
    assert.ok(ledger.writtenSignatures().has("a"));
    assert.equal(ledger.forgetNote("a"), true);
    assert.equal(ledger.writtenSignatures().has("a"), false);
  });

  it("reports a signature it does not hold rather than claiming success", () => {
    assert.equal(ledger.forgetNote("never-claimed"), false);
  });
});

describe("recordNight", () => {
  const night = (outcome: "selected" | "quiet" | "refused", extra = {}) => ({
    night: "2026-09-02",
    startedAt: 1_700_000_000_000,
    outcome,
    reason: null,
    runId: null,
    selected: 0,
    ...extra,
  });

  it("does not let a later quiet pass erase a night that wrote", () => {
    // The bug: a press at noon that selected three, then the 03:04 timer
    // finding nothing left, read back as "nothing recurred" — about a night
    // that had started a run against the operator's vault.
    ledger.recordNight(night("selected", { runId: "run-1", selected: 3 }));
    ledger.recordNight(night("quiet"));

    const [row] = ledger.listNights();
    assert.equal(row.outcome, "selected");
    assert.equal(row.selected, 3);
    assert.equal(row.runId, "run-1");
  });

  it("does not let a refusal erase one either", () => {
    ledger.recordNight(night("selected", { runId: "run-1", selected: 2 }));
    ledger.recordNight(night("refused", { reason: "Dreaming is off." }));
    assert.equal(ledger.listNights()[0].outcome, "selected");
  });

  it("moves to the newer run when a second pass also selects", () => {
    // The reconciler reads the run's own report, so the row has to name the run
    // whose report is worth reading — and the counts add up rather than replace.
    ledger.recordNight(night("selected", { runId: "run-1", selected: 2 }));
    ledger.recordNight(night("selected", { runId: "run-2", selected: 3 }));

    const [row] = ledger.listNights();
    assert.equal(row.runId, "run-2");
    assert.equal(row.selected, 5);
  });

  it("still records a night that only ever refused", () => {
    // "Never ran" and "ran and refused" are two of the three kinds of nothing
    // the pane must keep apart, so a refusal has to leave a row behind.
    ledger.recordNight(night("refused", { reason: "No knowledge base is configured." }));
    const [row] = ledger.listNights();
    assert.equal(row.outcome, "refused");
    assert.equal(row.reason, "No knowledge base is configured.");
  });
});

describe("noteStillPresent", () => {
  it("says null for a row with no path, which is not the same as gone", () => {
    assert.equal(ledger.noteStillPresent(DATA_DIR, null), null);
  });

  it("says false for a path the vault no longer holds", () => {
    assert.equal(ledger.noteStillPresent(DATA_DIR, "not/there.md"), false);
  });

  it("says true for a file that is there", () => {
    fs.writeFileSync(path.join(DATA_DIR, "there.md"), "# hi");
    assert.equal(ledger.noteStillPresent(DATA_DIR, "there.md"), true);
  });

  it("refuses a path that escapes the vault rather than reporting on it", () => {
    // A stored path is not evidence about the filesystem it is read back into.
    assert.equal(ledger.noteStillPresent(DATA_DIR, "../escaped.md"), false);
    assert.equal(ledger.noteStillPresent(DATA_DIR, "/etc/hosts"), false);
  });

  it("says null when the vault itself is unreachable", () => {
    // Distinct from "the note is gone": a mount that has gone must not report
    // every note this app ever wrote as deleted.
    assert.equal(ledger.noteStillPresent(path.join(DATA_DIR, "no-such-mount"), "x.md"), null);
  });
});
