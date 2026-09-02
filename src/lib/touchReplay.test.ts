import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { placeTouches, replayFrame } from "./touchReplay";
import { buildTouchTree, planTouchedMap } from "./touchedMap";
import { nodeId } from "./pathMap";
import { reconcileTouches } from "./runTouches";
import type { RunTouchDTO, RunTouchStepDTO } from "./apiTypes";

/**
 * What the playhead is standing on, which is the only thing here an eye reads.
 *
 * Every one of these fails silently and draws a plausible replay of something
 * that did not happen. A step placed on the wrong node walks an operator through
 * a run that read files in an order it never read them in. A step placed on
 * nothing — which is what a touch behind a fold gets without `placeTouches`'
 * ancestor walk — makes the mark disappear for as many frames as that file was
 * read, and reads as the run pausing rather than as a directory the map rolled
 * up. A frame that dims at rest replaces the map instead of riding over it, and
 * the resting map is what this page was before the replay existed. And a
 * `changedNotTouched` file counted as reached at position 0 would say the branch
 * changed it *because* the run touched it, which is the reconciliation asserting
 * the thing it exists to check.
 *
 * The control is deliberately not tested. `touchedMap.test.ts` states the same
 * exemption for the canvas and it holds here: a rAF loop has no clock in this
 * runner, and an assertion over a button's disabled attribute would restate the
 * component rather than check it.
 */

function touch(over: Partial<RunTouchDTO> & Pick<RunTouchDTO, "path">): RunTouchDTO {
  return { outside: false, tool: "Read", subagent: null, parentToolUseId: null, calls: 1, ...over };
}

function step(
  over: Partial<RunTouchStepDTO> & Pick<RunTouchStepDTO, "path">,
): RunTouchStepDTO {
  return {
    outside: false,
    at: 1_700_000_000_000,
    tool: "Read",
    subagent: null,
    parentToolUseId: null,
    ...over,
  };
}

/**
 * The plan an operator is looking at, from the same steps the replay walks.
 *
 * Built through `reconcileTouches` rather than hand-assembled, because the thing
 * under test is that a step's path resolves to a node the *real* pipeline drew —
 * and a fixture plan that happened to hold every path would pass while the map
 * behind it folded half of them.
 */
function planFor(
  steps: readonly RunTouchStepDTO[],
  options: { budget?: number; changed?: string[]; expanded?: Set<string> } = {},
) {
  const distinct = new Map<string, RunTouchDTO>();
  for (const s of steps) {
    const existing = distinct.get(s.path);
    if (existing) existing.calls += 1;
    else
      distinct.set(
        s.path,
        touch({
          path: s.path,
          outside: s.outside,
          tool: s.tool,
          subagent: s.subagent,
          parentToolUseId: s.parentToolUseId,
        }),
      );
  }
  const report = reconcileTouches([...distinct.values()], options.changed ?? []);
  return planTouchedMap(buildTouchTree(report), {
    budget: options.budget ?? 200,
    expanded: options.expanded,
  });
}

describe("placeTouches", () => {
  it("puts every touch on the file node it named", () => {
    const steps = [step({ path: "src/a.ts" }), step({ path: "docs/b.md", tool: "Edit" })];
    const placed = placeTouches(steps, planFor(steps).nodes);

    assert.deepEqual(placed, [nodeId("file", "src/a.ts"), nodeId("file", "docs/b.md")]);
  });

  it("lands a touch behind a fold on the fold, not on nothing", () => {
    // The page's whole promise is that no file is dropped and the folded count
    // is printed out loud. A playhead that went blank for these touches would be
    // that promise broken in the one place it is checkable — and it would read
    // as the run pausing rather than as a directory the map rolled up.
    const steps = [
      ...Array.from({ length: 8 }, (_, i) => step({ path: `src/lib/deep/f${i}.ts` })),
      step({ path: "README.md" }),
    ];
    const plan = planFor(steps, { budget: 4 });
    assert.deepEqual(plan.folded, ["src/lib/deep"], "the fixture has to actually fold");

    const placed = placeTouches(steps, plan.nodes);
    const fold = nodeId("folded", "src/lib/deep");

    assert.equal(placed.filter((id) => id === fold).length, 8);
    assert.equal(placed[8], nodeId("file", "README.md"));
    assert.equal(
      placed.some((id) => id === null),
      false,
      "no step may land nowhere",
    );
  });

  it("moves a touch off the fold and onto its file when the fold is opened", () => {
    // What makes opening a directory during a replay do something. The position
    // is an index into the sequence and no fold changes it, so the only thing
    // that can move is where that index resolves to.
    const steps = Array.from({ length: 6 }, (_, i) => step({ path: `src/lib/deep/f${i}.ts` }));

    const shut = placeTouches(steps, planFor(steps, { budget: 1 }).nodes);
    assert.equal(shut[3], nodeId("folded", "src/lib/deep"));

    const open = placeTouches(
      steps,
      planFor(steps, { budget: 1, expanded: new Set(["src/lib/deep"]) }).nodes,
    );
    assert.equal(open[3], nodeId("file", "src/lib/deep/f3.ts"));
  });

  it("gives a touch outside the checkout its own node and its own position", () => {
    const steps = [
      step({ path: "src/a.ts" }),
      step({ path: "/tmp/scratch.txt", outside: true, tool: "Write" }),
      step({ path: "src/a.ts", tool: "Edit" }),
    ];
    const placed = placeTouches(steps, planFor(steps).nodes);

    assert.equal(placed[1], nodeId("file", "/tmp/scratch.txt"));
    assert.equal(placed[0], placed[2], "the same path is the same node both times");
  });

  it("answers null for a path the plan holds nowhere rather than throwing", () => {
    // Not reachable from a well-formed plan, and returned rather than thrown
    // because this runs inside a render: the readout still names the path, so
    // the cost is a highlight rather than the page.
    const steps = [step({ path: "src/a.ts" })];
    const placed = placeTouches([step({ path: "src/ghost.ts" })], planFor(steps).nodes);

    assert.deepEqual(placed, [null]);
  });
});

describe("replayFrame", () => {
  const steps = [
    step({ path: "src/a.ts" }),
    step({ path: "src/b.ts", tool: "Edit" }),
    step({ path: "src/a.ts", tool: "Read", subagent: "reviewer", parentToolUseId: "t1" }),
  ];

  function frameAt(position: number, changed: string[] = []) {
    const plan = planFor(steps, { changed });
    const placed = placeTouches(steps, plan.nodes);
    return { plan, frame: replayFrame(steps, placed, plan.nodes, position) };
  }

  it("dims nothing at rest, so the map is the one that was there before", () => {
    // The replay is a mode over the existing view. At position 0 an operator who
    // never touched the scrubber and one who scrubbed back to the start must be
    // looking at the same picture, and `null` rather than an empty set is the
    // whole of what says so — an empty set is "narrowed to nothing".
    const { frame } = frameAt(0);

    assert.equal(frame.dimmed, null);
    assert.equal(frame.currentId, null);
    assert.equal(frame.step, null);
    assert.equal(frame.reached.size, 0);
    assert.equal(frame.position, 0);
  });

  it("draws everything up to and including the position, and nothing after it", () => {
    const { frame } = frameAt(2);

    assert.equal(frame.position, 2);
    assert.equal(frame.step?.path, "src/b.ts");
    assert.equal(frame.currentId, nodeId("file", "src/b.ts"));
    assert.equal(frame.reached.get(nodeId("file", "src/a.ts")), 1);
    assert.equal(frame.reached.get(nodeId("file", "src/b.ts")), 1);
    assert.equal(frame.dimmed?.has(nodeId("file", "src/a.ts")), false);
  });

  it("accumulates a file read twice rather than counting it once", () => {
    // The step is one tool call and not one distinct file, which is the whole
    // reason the scrubber has more steps than the map has nodes. A count that
    // deduplicated would make the busiest file in the run indistinguishable from
    // one read once.
    const { frame } = frameAt(3);

    assert.equal(frame.reached.get(nodeId("file", "src/a.ts")), 2);
    assert.equal(frame.position, 3);
    assert.equal(frame.currentId, nodeId("file", "src/a.ts"));
  });

  it("keeps the main thread's and a sub-agent's calls on the same node, in order", () => {
    // One file is routinely read by the main thread and edited by a sub-agent.
    // Both calls are the same node and two different positions: the actor is
    // what the readout names at each, and splitting the node by actor would
    // draw one file as two places in the repository.
    const { frame: first } = frameAt(1);
    const { frame: last } = frameAt(3);

    assert.equal(first.step?.subagent, null);
    assert.equal(last.step?.subagent, "reviewer");
    assert.equal(first.currentId, last.currentId);
    assert.equal(last.reached.get(nodeId("file", "src/a.ts")), 2);
  });

  it("leaves a changed-but-never-touched file dimmed for the whole replay", () => {
    // It has no event and so no position in the sequence — the true reading is
    // that the replay never reaches it. Counting it as reached at position 0
    // would say the branch changed it because the run touched it.
    const ghost = nodeId("file", "src/never.ts");
    const { plan, frame } = frameAt(3, ["src/never.ts"]);

    assert.ok(
      plan.nodes.some((n) => n.id === ghost),
      "the diff-only file is still drawn",
    );
    assert.equal(frame.reached.has(ghost), false);
    assert.equal(frame.dimmed?.has(ghost), true);
    assert.notEqual(frame.currentId, ghost);
  });

  it("never dims a directory anchor", () => {
    // The anchors are the arrangement rather than the content. Washing the
    // labels out would take away the orientation the map exists to give while
    // saying nothing at all about the run.
    const { plan, frame } = frameAt(1);
    const dirs = plan.nodes.filter((n) => n.kind === "dir");

    assert.ok(dirs.length > 0);
    assert.equal(
      dirs.some((n) => frame.dimmed?.has(n.id)),
      false,
    );
  });

  it("clamps a position past the end onto the last touch", () => {
    // Reachable from the range input's own max and from a step-forward at the
    // end. Off the end the mark would vanish, which is indistinguishable from
    // the rest state the operator did not ask for.
    const { frame } = frameAt(99);

    assert.equal(frame.position, 3);
    assert.equal(frame.step?.path, "src/a.ts");
    assert.equal(frame.currentId, nodeId("file", "src/a.ts"));
  });

  it("answers rest for an empty sequence rather than a frame with no step in it", () => {
    // A run whose events aged out has no sequence at all, and the page has its
    // own notice for that. What this must not do is produce a frame that dims
    // the whole map on the way there.
    const plan = planFor([step({ path: "src/a.ts" })]);
    const frame = replayFrame([], [], plan.nodes, 0);

    assert.equal(frame.position, 0);
    assert.equal(frame.dimmed, null);
    assert.equal(frame.step, null);
    assert.equal(frame.reached.size, 0);

    // And a position that outlived the sequence it indexed — a run reloaded
    // under a held scrubber — clamps back to rest rather than to a step that is
    // not there.
    assert.equal(replayFrame([], [], plan.nodes, 12).position, 0);
  });
});
