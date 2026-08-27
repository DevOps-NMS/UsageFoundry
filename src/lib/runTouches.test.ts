import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcileTouches, touchActor } from "./runTouches";
import type { RunTouchDTO } from "./apiTypes";

/**
 * Covers the set difference and the merge, and only those.
 *
 * Every failure mode here is silent and every one of them produces a confident
 * wrong sentence rather than an error. A file on the wrong side of the
 * difference reads as "this run changed a file it never opened" — the one claim
 * on this card an operator would act on, by going and looking at a diff hunk
 * nothing wrote. A path that fails to merge shows one file as two with its
 * counts split between them, which is a run that read something half as often
 * as it did. And `distinctTouched` is not decoration: it is one of the two
 * numbers this slice exists to produce, and it is what the next decision about
 * drawing any of this is made from, so a miscount is a design decision taken
 * from a wrong figure.
 *
 * The database side is deliberately not tested. `scanTouches` is a query, and
 * the suite has no fixture database — what it would assert is SQLite's
 * behaviour rather than this app's.
 */

/** A touch, with the fields a test does not care about filled in. */
function touch(over: Partial<RunTouchDTO> & Pick<RunTouchDTO, "path">): RunTouchDTO {
  return {
    outside: false,
    tool: "Read",
    subagent: null,
    parentToolUseId: null,
    calls: 1,
    ...over,
  };
}

const paths = (rows: readonly { path: string }[]) => rows.map((r) => r.path);

describe("reconcileTouches", () => {
  it("splits touched and changed into the four groups", () => {
    const report = reconcileTouches(
      [
        touch({ path: "src/a.ts", tool: "Read" }),
        touch({ path: "src/b.ts", tool: "Edit" }),
      ],
      ["src/b.ts", "src/c.ts"],
    );

    assert.deepEqual(paths(report.changedNotTouched), ["src/c.ts"]);
    assert.deepEqual(paths(report.touchedAndChanged), ["src/b.ts"]);
    assert.deepEqual(paths(report.touchedNotChanged), ["src/a.ts"]);
    assert.deepEqual(report.outsideCheckout, []);
    assert.equal(report.distinctTouched, 2);
  });

  it("keeps a path outside the checkout out of the other three groups", () => {
    // The rows `readCountsFor` drops at its `ELSE NULL`. They cannot be
    // reconciled against a diff at all — nothing in the branch range can speak
    // for a file that is not in the checkout — so a group of their own is the
    // only honest place for them.
    const report = reconcileTouches(
      [
        touch({ path: "/tmp/scratch.txt", outside: true, tool: "Write" }),
        touch({ path: "src/a.ts" }),
      ],
      ["src/a.ts"],
    );

    assert.deepEqual(paths(report.outsideCheckout), ["/tmp/scratch.txt"]);
    assert.deepEqual(paths(report.touchedAndChanged), ["src/a.ts"]);
    assert.deepEqual(report.touchedNotChanged, []);
    assert.deepEqual(report.changedNotTouched, []);
    // Counted, because it *was* touched — the header's figure is about the
    // run's reach and a file outside the checkout is the most of it.
    assert.equal(report.distinctTouched, 2);
  });

  it("counts reads and writes apart, and sorts the busiest file first", () => {
    const report = reconcileTouches(
      [
        touch({ path: "src/quiet.ts", calls: 1 }),
        touch({ path: "src/busy.ts", tool: "Read", calls: 3 }),
        touch({ path: "src/busy.ts", tool: "Edit", calls: 1 }),
      ],
      [],
    );

    assert.deepEqual(paths(report.touchedNotChanged), ["src/busy.ts", "src/quiet.ts"]);
    const busy = report.touchedNotChanged[0];
    assert.equal(busy.reads, 3);
    assert.equal(busy.writes, 1);
  });

  it("names the caller, and falls back rather than claiming the main thread", () => {
    assert.equal(touchActor({ subagent: "Explore", parentToolUseId: "toolu_1" }), "Explore");
    // A delegated call whose `Task` was never seen: "some sub-agent" is true
    // where "the main thread" is not.
    assert.equal(touchActor({ subagent: null, parentToolUseId: "toolu_1" }), "delegated");
    assert.equal(touchActor({ subagent: null, parentToolUseId: null }), "main");

    const report = reconcileTouches(
      [touch({ path: "src/a.ts", subagent: "Explore", parentToolUseId: "toolu_1" })],
      [],
    );
    assert.deepEqual(report.touchedNotChanged[0].by, ["Explore"]);
  });

  it("lists every caller of one file, sorted", () => {
    // A file the main thread read and a sub-agent edited is the ordinary case
    // in this app, and showing one of the two would make the other disappear.
    const report = reconcileTouches(
      [
        touch({ path: "src/a.ts" }),
        touch({ path: "src/a.ts", tool: "Edit", subagent: "Explore", parentToolUseId: "t" }),
      ],
      [],
    );
    assert.deepEqual(report.touchedNotChanged[0].by, ["Explore", "main"]);
  });

  it("puts every touch in touchedNotChanged when nothing changed", () => {
    // A run whose branch has no commits on it. The empty side must not read as
    // "everything the run touched was also changed".
    const report = reconcileTouches([touch({ path: "src/a.ts" })], []);

    assert.deepEqual(report.changedNotTouched, []);
    assert.deepEqual(report.touchedAndChanged, []);
    assert.deepEqual(paths(report.touchedNotChanged), ["src/a.ts"]);
  });

  it("merges one path reached two ways into one row", () => {
    // The scan relativises against `work_dir` and then `folder`, so an isolated
    // run that reached the same file through both resolves to one string — but
    // as two rows, because the query also groups by tool and by caller. Merging
    // is this function's job and nothing else does it.
    const report = reconcileTouches(
      [
        touch({ path: "src/a.ts", tool: "Read", calls: 2 }),
        touch({ path: "src/a.ts", tool: "Write", calls: 1 }),
      ],
      [],
    );

    assert.equal(report.touchedNotChanged.length, 1);
    assert.equal(report.distinctTouched, 1);
    assert.equal(report.touchedNotChanged[0].reads, 2);
    assert.equal(report.touchedNotChanged[0].writes, 1);
  });

  it("orders a group with no counts by path rather than by arrival", () => {
    // `changedNotTouched` has no calls to rank by, and the diff's own order
    // varies between two reads of the same run.
    const report = reconcileTouches([], ["z.ts", "a.ts", "m.ts"]);
    assert.deepEqual(paths(report.changedNotTouched), ["a.ts", "m.ts", "z.ts"]);
    assert.equal(report.distinctTouched, 0);
  });

  it("counts a tool it has never heard of as a read", () => {
    // The fallback is chosen so being wrong is cheap: one column understates
    // and the group the file lands in — the load-bearing part — is unaffected.
    const report = reconcileTouches(
      [touch({ path: "src/a.ts", tool: "SomeFutureTool", calls: 2 })],
      ["src/a.ts"],
    );
    assert.deepEqual(paths(report.touchedAndChanged), ["src/a.ts"]);
    assert.equal(report.touchedAndChanged[0].reads, 2);
    assert.equal(report.touchedAndChanged[0].writes, 0);
  });
});
