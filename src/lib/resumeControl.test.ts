import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resumeControl } from "./contextPruning";
import type { UsageEntry } from "./transcripts";

/**
 * The control group's reading of which turn a clean resume actually was.
 *
 * `resumeControl` used to answer each probe by walking every main-thread turn on
 * the machine and skipping the ones belonging to another session; it now groups
 * the turns by session once and reads one group per probe. That is meant to be
 * the same loop over the only entries that could ever have answered it, and the
 * failure mode of being wrong is the silent kind: `warmShare` feeds
 * `netReceipt`, so a control that quietly picked another session's turn would
 * move every priced receipt's netUSD — the figure that decides whether pruning
 * looks worth keeping — with nothing throwing and nothing failing to typecheck.
 *
 * Untested before the change, so these pin the behaviour rather than describing
 * it: each case is one thing the old whole-corpus walk did that the grouped read
 * has to keep doing.
 */

const T0 = Date.UTC(2026, 0, 10, 9, 0, 0);

function entry(
  sessionId: string,
  ts: number,
  tokens: Partial<UsageEntry["tokens"]> = {},
): UsageEntry {
  return {
    key: `${sessionId}:${ts}`,
    ts,
    model: "claude-opus-4-5-20251101",
    sessionId,
    project: "/workspace/x",
    isSidechain: false,
    unpriced: false,
    tokens: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      ...tokens,
    },
  } as UsageEntry;
}

/** A resume that read almost everything back out of cache. */
const WARM = { cacheRead: 90_000, cacheWrite5m: 1_000 };
/** A resume that had to write the conversation back in. */
const COLD = { cacheRead: 1_000, cacheWrite5m: 90_000 };

describe("resumeControl reads only the probe's own session", () => {
  it("does not answer a probe with another session's turn", () => {
    // The turn that would win on time alone belongs to someone else. The whole
    // corpus walk skipped it on `sessionId`; the grouped read must never see it.
    const mainThread = [
      entry("other", T0 + 1_000, WARM),
      entry("mine", T0 + 5_000, COLD),
    ];

    const control = resumeControl(
      [{ ts: T0, sessionId: "mine" }],
      mainThread,
    );

    assert.equal(control.cleanResumes, 1);
    assert.equal(control.warmShare, 0, "the cold turn in `mine` is the answer");
  });

  it("takes the earliest billed turn after the probe, not the first in the array", () => {
    const mainThread = [
      entry("mine", T0 + 9_000, COLD),
      entry("mine", T0 + 2_000, WARM), // earlier, later in the array
    ];

    const control = resumeControl([{ ts: T0, sessionId: "mine" }], mainThread);

    assert.equal(control.cleanResumes, 1);
    assert.equal(control.warmShare, 1);
  });

  it("skips a turn that billed nothing — a restart writes one", () => {
    const mainThread = [
      entry("mine", T0 + 1_000), // present, entirely zero
      entry("mine", T0 + 4_000, WARM),
    ];

    const control = resumeControl([{ ts: T0, sessionId: "mine" }], mainThread);

    assert.equal(control.cleanResumes, 1);
    assert.equal(control.warmShare, 1);
  });

  it("ignores turns at or before the probe", () => {
    const mainThread = [
      entry("mine", T0 - 1_000, WARM),
      entry("mine", T0, WARM), // exactly at the probe: `ts <= after`
    ];

    const control = resumeControl([{ ts: T0, sessionId: "mine" }], mainThread);

    assert.equal(control.cleanResumes, 0, "nothing has resumed yet");
    assert.equal(control.warmShare, 0);
  });

  it("skips a probe whose session has not resumed rather than counting it cold", () => {
    // The newest row in the table is ordinarily this, and letting it vote drags
    // `warmShare` toward zero — the direction that restores the assumption the
    // control exists to replace.
    const control = resumeControl(
      [
        { ts: T0, sessionId: "resumed" },
        { ts: T0, sessionId: "never-resumed" },
        { ts: T0, sessionId: null },
      ],
      [entry("resumed", T0 + 1_000, WARM)],
    );

    assert.equal(control.cleanResumes, 1);
    assert.equal(control.warmShare, 1);
  });

  it("shares the rate across many probes and many sessions", () => {
    const mainThread = [
      entry("a", T0 + 1_000, WARM),
      entry("b", T0 + 1_000, COLD),
      entry("c", T0 + 1_000, WARM),
      entry("d", T0 + 1_000, COLD),
    ];
    const probes = ["a", "b", "c", "d"].map((sessionId) => ({
      ts: T0,
      sessionId,
    }));

    const control = resumeControl(probes, mainThread);

    assert.equal(control.cleanResumes, 4);
    assert.equal(control.warmShare, 0.5);
  });

  it("answers zero for no probes and for no turns", () => {
    assert.deepEqual(resumeControl([], [entry("a", T0, WARM)]), {
      cleanResumes: 0,
      warmShare: 0,
    });
    assert.deepEqual(resumeControl([{ ts: T0, sessionId: "a" }], []), {
      cleanResumes: 0,
      warmShare: 0,
    });
  });
});
