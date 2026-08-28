import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContextPrunerDTO, PruneActivityDTO } from "./apiTypes";
import {
  PRUNE_ENGINE_LABEL,
  pruneStatement,
  prunerIsFault,
  prunerLine,
} from "./pruneStatement";
import { sumPruneActivity, type PruneDecisionRow } from "./contextPruning";

/**
 * Covers the resolver that decides what the two context-control surfaces say
 * when there is no money to show.
 *
 * It earns a test on `paybackTurns`' grounds, transposed from arithmetic to
 * copy: **every way of getting this wrong renders a confident, well-formed
 * sentence.** Five distinct facts — pruning switched off, winnow missing from
 * the image, nothing worth removing, every boundary declined, and a run that
 * simply has not reached a boundary yet — shared one blank before this, and a
 * blank reads as "the feature did nothing". A resolver that returns the wrong
 * branch does not throw, does not fail to typecheck, and does not look broken;
 * it tells an operator something untrue in a complete English sentence, on the
 * one page built to say whether context control earns its keep.
 *
 * The sum case is the load-bearing one. The clause list is built by filtering
 * zeroes out, so a clause dropped by a typo produces a *shorter* sentence that
 * is still grammatical and still adds up to a plausible story — the failure the
 * `boundaries` denominator exists to make visible.
 */

const READY: ContextPrunerDTO = {
  state: "ready",
  engine: "legacy",
  detail: null,
  minColdAgeSeconds: null,
};

function activity(patch: Partial<PruneActivityDTO>): PruneActivityDTO {
  return {
    boundaries: 0,
    cut: 0,
    nothing: 0,
    declined: 0,
    refused: 0,
    unavailable: 0,
    failed: 0,
    lastDetail: null,
    ...patch,
  };
}

function decision(
  outcome: PruneDecisionRow["outcome"],
  detail: string | null = null,
): PruneDecisionRow {
  return {
    ts: 0,
    runId: "r",
    trigger: "boundary",
    engine: "legacy",
    outcome,
    detail,
    predictedTurns: null,
  };
}

describe("prunerLine", () => {
  it("gives the three configured states three different sentences", () => {
    const off = prunerLine({ ...READY, state: "off" });
    const missing = prunerLine({
      ...READY,
      state: "unavailable",
      detail: "winnow is not installed at /opt/winnow",
    });
    const ready = prunerLine(READY);

    assert.equal(new Set([off, missing, ready]).size, 3);
    for (const t of [off, missing, ready]) {
      assert.notEqual(t.trim(), "");
      // The failure this whole change is against: a state rendering as money.
      assert.doesNotMatch(t, /\$0/);
    }
  });

  it("is never absent, which is the reason it exists apart", () => {
    // The live install had fourteen prunes on the card and no way to tell which
    // engine made them. A function allowed to return null here would have gone
    // on saying nothing on exactly that install.
    for (const state of ["off", "unavailable", "ready"] as const) {
      assert.ok(prunerLine({ ...READY, state, detail: "x" }).length > 0);
    }
  });

  it("carries the server's own reason verbatim rather than re-authoring it", () => {
    // The run log and the page must word one failure identically, or an
    // operator comparing them is reading two accounts of one event.
    const reason =
      "winnow is not installed at /opt/winnow — this image was built with WINNOW_REF empty";
    assert.ok(
      prunerLine({ ...READY, state: "unavailable", detail: reason }).includes(reason),
    );
  });

  it("names the engine by what it does, never by module name", () => {
    assert.match(prunerLine(READY), /edit in place/);
    assert.match(prunerLine({ ...READY, engine: "winnow" }), /fork/);
    for (const e of ["legacy", "winnow"] as const) {
      assert.doesNotMatch(prunerLine({ ...READY, engine: e }), /legacy|winnow|cozempic/i);
    }
    assert.equal(PRUNE_ENGINE_LABEL.legacy, "Edit in place");
    assert.equal(PRUNE_ENGINE_LABEL.winnow, "Fork");
  });

  it("marks a missing tool as a fault and a switched-off feature as not one", () => {
    // Off is an operator's decision. A warning standing permanently over one
    // trains the eye to skip the warnings that mean something.
    assert.equal(prunerIsFault({ ...READY, state: "off" }), false);
    assert.equal(prunerIsFault(READY), false);
    assert.equal(prunerIsFault({ ...READY, state: "unavailable" }), true);
  });
});

describe("pruneStatement", () => {
  it("prints every non-zero outcome, and the counts sum to the denominator", () => {
    const a = activity({
      boundaries: 12,
      cut: 4,
      declined: 3,
      nothing: 2,
      refused: 1,
      unavailable: 1,
      failed: 1,
      lastDetail: "cold-age",
    });
    const s = pruneStatement(a);
    assert.ok(s);

    // Each clause present exactly once, by its count. A dropped clause is the
    // silent failure: the sentence stays grammatical and stays plausible.
    for (const [n, phrase] of [
      [4, "ended in a cut"],
      [3, "left alone on the payback test"],
      [2, "where nothing was worth removing"],
      [1, "refused by the fork engine"],
      [1, "where winnow was not installed"],
      [1, "that could not be read"],
    ] as const) {
      assert.match(s.text, new RegExp(`${n} ${phrase}`));
    }
    // The denominator is what makes the breakdown checkable at a glance.
    assert.equal(
      a.cut + a.declined + a.nothing + a.refused + a.unavailable + a.failed,
      a.boundaries,
    );
    assert.match(s.text, /^12 cycle boundaries in this span:/);
  });

  it("drops zero clauses instead of printing them", () => {
    const s = pruneStatement(activity({ boundaries: 5, declined: 5 }));
    assert.match(s!.text, /5 left alone on the payback test/);
    assert.doesNotMatch(s!.text, /\b0 /);
  });

  it("says nothing when the money already says it", () => {
    // Every boundary cut, so the figures beside it are the whole story and a
    // caption would only repeat them. `prunerLine` still names the engine.
    assert.equal(pruneStatement(activity({ boundaries: 3, cut: 3 })), null);
    assert.equal(pruneStatement(null), null);
    assert.equal(pruneStatement(activity({ boundaries: 0 })), null);
  });

  it("warns only where an operator has something to fix", () => {
    assert.equal(
      pruneStatement(activity({ boundaries: 4, declined: 4 }))?.severity,
      "neutral",
    );
    assert.equal(
      pruneStatement(activity({ boundaries: 4, cut: 3, failed: 1 }))?.severity,
      "warn",
    );
  });

  it("uses the singular for one boundary", () => {
    const s = pruneStatement(activity({ boundaries: 1, nothing: 1 }));
    assert.match(s!.text, /^1 cycle boundary in this span:/);
  });
});

describe("sumPruneActivity", () => {
  it("counts each outcome and keeps the newest non-cut reason", () => {
    const rows: PruneDecisionRow[] = [
      decision("cut"),
      decision("refused", "cold-age"),
      decision("declined"),
      decision("nothing", "nothing worth removing"),
      decision("cut"),
    ];
    const a = sumPruneActivity(rows);
    assert.equal(a.boundaries, 5);
    assert.equal(a.cut, 2);
    assert.equal(a.refused, 1);
    assert.equal(a.declined, 1);
    assert.equal(a.nothing, 1);
    // Newest wins, and a cut never supplies one — the row after it here is a
    // cut, and the reason must survive it.
    assert.equal(a.lastDetail, "nothing worth removing");
  });

  it("sums to its own denominator for any input", () => {
    const a = sumPruneActivity([
      decision("cut"),
      decision("failed", "unreadable"),
      decision("unavailable", "no winnow"),
    ]);
    assert.equal(
      a.cut + a.nothing + a.declined + a.refused + a.unavailable + a.failed,
      a.boundaries,
    );
  });

  it("has no reason to report when every boundary cut", () => {
    assert.equal(sumPruneActivity([decision("cut"), decision("cut")]).lastDetail, null);
  });
});
