import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  baseName,
  buildTouchTree,
  dirName,
  dirOf,
  nodeId,
  parentOf,
  planTouchedMap,
  touchedMapView,
} from "./touchedMap";
import { reconcileTouches } from "./runTouches";
import type { RunDiffDTO, RunTouchDTO, RunTouchedDTO } from "./apiTypes";

/**
 * Covers the three things on the map that have a decidable answer.
 *
 * Everything here fails silently and draws a plausible picture instead of
 * throwing. A path filed under the wrong parent puts `src/lib/db.ts` in a
 * cluster labelled `docs` and the operator reads a repository that does not
 * exist. A fold that loses a file is the one thing this surface promises never
 * to do — it is a picture, so a missing node is not a missing row somebody would
 * notice, and the count beside it would still be printed with confidence. And
 * the three ways of having nothing all render as an empty canvas, which reads as
 * a run that touched no file at all: `swept` is a retention policy, `idle` is a
 * run that used `Bash` for everything, and an absent diff is an *unknown*
 * changed set that no node may draw a "changed" mark for.
 *
 * The drawing is deliberately not tested. A canvas has no DOM here, and an
 * assertion over a colour or a radius would be a restatement of the code rather
 * than a check on it; `canvasView.test.ts` already holds the arithmetic that
 * would draw a wrong picture without saying so.
 */

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

function diff(over: Partial<RunDiffDTO> = {}): RunDiffDTO {
  return {
    kind: "range",
    reason: null,
    base: "main",
    branch: "uf/x",
    files: [],
    filesChanged: 0,
    added: 0,
    deleted: 0,
    omittedPatches: 0,
    uncommitted: [],
    caveat: null,
    ...over,
  };
}

const changedFiles = (paths: string[]): RunDiffDTO["files"] =>
  paths.map((path) => ({
    path,
    oldPath: null,
    status: "modified" as const,
    added: 1,
    deleted: 0,
    binary: false,
    patch: null,
    patchTruncated: false,
  }));

/** A tree over `paths`, all read once, with nothing in the diff. */
function treeOf(paths: string[]) {
  return buildTouchTree(reconcileTouches(paths.map((path) => touch({ path })), []));
}

describe("path arithmetic", () => {
  it("keeps the checkout root and the filesystem root apart", () => {
    // A run's touches are not all relative, and collapsing the two roots would
    // file /etc/hosts under the repository root — a claim about the run that is
    // not true and that nothing on the canvas would contradict.
    assert.equal(dirOf("README.md"), "");
    assert.equal(dirOf("src/lib/db.ts"), "src/lib");
    assert.equal(dirOf("/tmp/scratch.txt"), "/tmp");
    assert.equal(dirOf("/scratch.txt"), "/");
    assert.equal(dirOf("/home/node/.claude/x.json"), "/home/node/.claude");

    assert.equal(parentOf(""), null);
    assert.equal(parentOf("/"), null);
    assert.equal(parentOf("src"), "");
    assert.equal(parentOf("/tmp"), "/");
    assert.equal(parentOf("src/lib"), "src");
  });

  it("names both roots with something a path could hold", () => {
    assert.equal(dirName(""), ".");
    assert.equal(dirName("/"), "/");
    assert.equal(dirName("src/lib"), "lib");
    assert.equal(baseName("src/lib/db.ts"), "db.ts");
    assert.equal(baseName("README.md"), "README.md");
  });
});

describe("buildTouchTree", () => {
  it("gives every ancestor the count of what is under it", () => {
    // The figure a folded node draws. Summing only onto the parent would make a
    // folded `src` say it stands for the files directly in it — a number that is
    // smaller than the truth and prints just as confidently.
    const tree = treeOf(["src/lib/db.ts", "src/lib/orchestrator.ts", "src/components/Card.tsx"]);

    assert.equal(tree.dirs.get("")?.subtreeFiles, 3);
    assert.equal(tree.dirs.get("src")?.subtreeFiles, 3);
    assert.equal(tree.dirs.get("src/lib")?.subtreeFiles, 2);
    assert.equal(tree.dirs.get("src/components")?.subtreeFiles, 1);
    assert.equal(tree.dirs.get("src")?.files.length, 0);
    assert.deepEqual(tree.dirs.get("src")?.children, ["src/components", "src/lib"]);
    assert.equal(tree.maxDepth, 2);
  });

  it("measures depth from the root rather than from the first file seen", () => {
    // `ensure` creates a directory the moment a file names it, so a deep file
    // ahead of a shallow one is the order that gets an ancestor's depth wrong —
    // and a wrong depth is a wrong fold, which is files missing from a picture.
    const tree = treeOf(["a/b/c/d.ts", "a/x.ts"]);
    assert.equal(tree.dirs.get("")?.depth, 0);
    assert.equal(tree.dirs.get("a")?.depth, 1);
    assert.equal(tree.dirs.get("a/b")?.depth, 2);
    assert.equal(tree.dirs.get("a/b/c")?.depth, 3);
  });

  it("puts a path outside the checkout under its own root", () => {
    const tree = buildTouchTree(
      reconcileTouches(
        [touch({ path: "src/a.ts" }), touch({ path: "/tmp/scratch.txt", outside: true })],
        [],
      ),
    );

    assert.deepEqual([...tree.roots], ["", "/"]);
    assert.equal(tree.dirs.get("")?.subtreeFiles, 1);
    assert.equal(tree.dirs.get("/")?.subtreeFiles, 1);
    assert.equal(tree.dirs.get("/tmp")?.outside, true);
    assert.equal(tree.dirs.get("")?.outside, false);
  });

  it("carries read, written and both onto the node rather than an edge", () => {
    // The whole reason the node set is files: a tool is an attribute here, and
    // what it did to the file is a state on the node. `unnamed` is the group a
    // tool-to-file graph structurally cannot draw, because a file with no event
    // has no edge to hang from.
    const report = reconcileTouches(
      [
        touch({ path: "src/read.ts", tool: "Read", calls: 4 }),
        touch({ path: "src/wrote.ts", tool: "Write" }),
        touch({ path: "src/both.ts", tool: "Read", calls: 2 }),
        touch({ path: "src/both.ts", tool: "Edit" }),
      ],
      ["src/wrote.ts", "src/both.ts", "src/bashed.ts"],
    );
    const tree = buildTouchTree(report);
    const state = (path: string) => tree.files.find((f) => f.path === path);

    assert.equal(state("src/read.ts")?.state, "read");
    assert.equal(state("src/read.ts")?.calls, 4);
    assert.equal(state("src/wrote.ts")?.state, "written");
    assert.equal(state("src/both.ts")?.state, "both");
    assert.equal(state("src/bashed.ts")?.state, "unnamed");
    assert.equal(state("src/bashed.ts")?.calls, 0);
    assert.equal(state("src/bashed.ts")?.inDiff, true);
    assert.deepEqual(state("src/both.ts")?.tools, ["Edit", "Read"]);
    assert.deepEqual(tree.dirs.get("src")?.tools, ["Edit", "Read", "Write"]);
    assert.equal(tree.dirs.get("src")?.subtreeInDiff, 3);
    assert.equal(tree.dirs.get("src")?.subtreeWritten, 2);
  });
});

describe("planTouchedMap", () => {
  /** Every file is drawn or stands behind exactly one fold. Nothing else is allowed. */
  function assertNothingDropped(plan: ReturnType<typeof planTouchedMap>, total: number) {
    assert.equal(plan.drawnFiles + plan.foldedFiles, total);
    const drawn = plan.nodes.filter((n) => n.kind === "file").length;
    assert.equal(drawn, plan.drawnFiles);
  }

  it("draws the whole tree when it fits", () => {
    // The measured case: 39 files across one work cycle is nowhere near any
    // budget worth setting, and a surface that folded it would be defending
    // against a size nobody has seen.
    const paths = Array.from({ length: 39 }, (_, i) => `src/lib/f${i}.ts`);
    const plan = planTouchedMap(treeOf(paths), { budget: 220 });

    assert.deepEqual(plan.folded, []);
    assert.equal(plan.foldedFiles, 0);
    assert.equal(plan.drawnFiles, 39);
    assertNothingDropped(plan, 39);
  });

  it("folds from the leaves up and never loses a file", () => {
    const paths = [
      ...Array.from({ length: 8 }, (_, i) => `src/lib/deep/f${i}.ts`),
      "src/lib/shallow.ts",
      "README.md",
    ];
    const tree = treeOf(paths);
    const plan = planTouchedMap(tree, { budget: 4 });

    // Cutoff 2 keeps `src/lib` open and folds `src/lib/deep` — the deepest
    // directory, so the top level of the repository survives. Folding largest
    // first, which is what reusing `capGraph` would do, would have taken `src`.
    assert.equal(plan.cutoff, 2);
    assert.deepEqual(plan.folded, ["src/lib/deep"]);
    assert.equal(plan.foldedFiles, 8);
    assert.equal(plan.drawnFiles, 2);
    assertNothingDropped(plan, paths.length);

    const fold = plan.nodes.find((n) => n.kind === "folded");
    assert.equal(fold?.files, 8, "a fold has to carry the count it stands for");
    assert.equal(fold?.label, "deep");
  });

  it("keeps a directory the operator opened, and every directory above it", () => {
    // Only the ancestors make the expansion reachable. Without them the next
    // plan folds `src/lib` back over the top of it and the click reads as having
    // done nothing at all — the expansion is recorded and the subtree stays
    // hidden, with no state wrong enough to notice.
    const paths = Array.from({ length: 8 }, (_, i) => `src/lib/deep/f${i}.ts`);
    const plan = planTouchedMap(treeOf(paths), {
      budget: 1,
      expanded: new Set(["src/lib/deep"]),
    });

    assert.deepEqual(plan.folded, []);
    assert.equal(plan.drawnFiles, 8);
    assertNothingDropped(plan, 8);
  });

  it("never folds a root, and draws every file when even depth 0 is over budget", () => {
    // A folded root is one node standing for the whole run, which is a picture
    // of nothing. Drawing more than the budget and saying so is the honest
    // remaining move; dropping files silently is not one of the options.
    const paths = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    const plan = planTouchedMap(treeOf(paths), { budget: 5 });

    assert.equal(plan.cutoff, 0);
    assert.deepEqual(plan.folded, []);
    assert.equal(plan.drawnFiles, 30);
    assertNothingDropped(plan, 30);
  });

  it("gives one directory two ids, and the click that opens it swaps them", () => {
    // The contract the canvas holds a selection and a carried position across.
    // A directory is one place drawn two ways, and opening it is the moment the
    // id changes — so a consumer keying on the drawn id loses the one node that
    // was certainly on screen a moment ago. Nothing throws either way: the
    // inspector clears on the click that was meant to explain the unfolding, and
    // the anchor jumps to the world origin taking its rosette with it.
    const paths = Array.from({ length: 6 }, (_, i) => `src/lib/deep/f${i}.ts`);
    const tree = treeOf(paths);

    const shut = planTouchedMap(tree, { budget: 1 });
    assert.ok(shut.nodes.some((n) => n.id === nodeId("folded", "src/lib/deep")));
    assert.equal(
      shut.nodes.some((n) => n.id === nodeId("dir", "src/lib/deep")),
      false,
    );

    const open = planTouchedMap(tree, { budget: 1, expanded: new Set(["src/lib/deep"]) });
    assert.ok(open.nodes.some((n) => n.id === nodeId("dir", "src/lib/deep")));
    assert.equal(
      open.nodes.some((n) => n.id === nodeId("folded", "src/lib/deep")),
      false,
    );
  });

  it("hangs every drawn file off its own directory and nothing else", () => {
    // Containment, never causation. An edge here means "is in", so an edge count
    // that did not match the node count would be a line asserting a relationship
    // the data does not hold.
    const plan = planTouchedMap(treeOf(["src/lib/db.ts", "docs/x.md"]), { budget: 50 });
    const byId = new Map(plan.nodes.map((n, i) => [i, n]));

    for (const edge of plan.edges) {
      const child = byId.get(edge.source);
      const parent = byId.get(edge.target);
      assert.ok(child && parent);
      assert.notEqual(parent.kind, "file", "a file is never a parent");
      if (child.kind === "file") assert.equal(parent.path, dirOf(child.path));
      else assert.equal(parent.path, parentOf(child.path));
    }
    // One edge per node bar the single root, which has no parent to hang from.
    assert.equal(plan.edges.length, plan.nodes.length - 1);
  });
});

describe("touchedMapView", () => {
  const swept: RunTouchedDTO = { kind: "swept", horizonDays: 30 };

  it("says swept even when the diff loaded", () => {
    // A checkout is kept on a different clock from `run_events`, so an old run
    // routinely has changes and no events. Drawing the diff without saying the
    // events are gone would be a map claiming the run read nothing.
    const view = touchedMapView(swept, diff({ files: changedFiles(["src/a.ts"]) }));
    assert.equal(view.kind, "swept");
    assert.equal(view.kind === "swept" && view.horizonDays, 30);
  });

  it("keeps no-such-run apart from a run that named no file", () => {
    assert.equal(touchedMapView({ kind: "none", reason: "No such run." }, null).kind, "gone");
    assert.equal(touchedMapView({ kind: "empty", cycles: 1 }, diff()).kind, "idle");
  });

  it("draws the diff's files when no tool call named one", () => {
    // A run that wrote through `Bash` alone. The table stops at its sentence
    // because it holds no report; every one of these files has a path and
    // therefore a position, so the map can show them — labelled as coming from
    // the diff, never as files the run read.
    const view = touchedMapView(
      { kind: "empty", cycles: 1 },
      diff({ files: changedFiles(["src/a.ts", "src/b.ts"]) }),
    );

    assert.equal(view.kind, "map");
    if (view.kind !== "map") return;
    assert.equal(view.unnamedOnly, true);
    assert.equal(view.changedKnown, true);
    assert.deepEqual(
      view.report.changedNotTouched.map((f) => f.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.deepEqual(view.report.touchedNotChanged, []);
  });

  it("treats an absent diff as an unknown changed set, not an empty one", () => {
    // With `kind: "none"` nothing may draw the changed mark and nothing may say
    // a file was not changed — that is the reconciliation asserting the thing it
    // exists to check.
    const view = touchedMapView(
      { kind: "report", touches: [touch({ path: "src/a.ts" })], cycles: 1 },
      diff({ kind: "none", reason: "The branch is gone." }),
    );

    assert.equal(view.kind, "map");
    if (view.kind !== "map") return;
    assert.equal(view.changedKnown, false);
    assert.equal(view.diffReason, "The branch is gone.");
    assert.equal(view.unnamedOnly, false);
    assert.deepEqual(view.report.changedNotTouched, []);
    assert.equal(
      view.report.touchedNotChanged.every((f) => !f.inDiff),
      true,
    );
  });

  it("reconciles against the diff when there is one", () => {
    const view = touchedMapView(
      {
        kind: "report",
        touches: [touch({ path: "src/a.ts" }), touch({ path: "src/b.ts", tool: "Edit" })],
        cycles: 2,
      },
      diff({ files: changedFiles(["src/b.ts"]) }),
    );

    assert.equal(view.kind, "map");
    if (view.kind !== "map") return;
    assert.equal(view.changedKnown, true);
    assert.equal(view.cycles, 2);
    assert.deepEqual(
      view.report.touchedAndChanged.map((f) => f.path),
      ["src/b.ts"],
    );
  });
});
