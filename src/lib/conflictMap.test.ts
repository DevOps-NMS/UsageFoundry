import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildConflictTree,
  clashKindOf,
  conflictMapView,
  planConflictMap,
  summariseClashes,
} from "./conflictMap";
import { nodeId } from "./pathMap";
import type { ConflictFileDTO, LandStateDTO, MergePreviewDTO } from "./apiTypes";

/**
 * Covers the three things on the conflicts map that have a decidable answer.
 *
 * Every one of them fails silently and draws a plausible picture instead of
 * throwing. A path filed under the wrong parent puts a clash in a directory that
 * is not on fire. A clash count summed over files nobody opened states a total
 * the preview never had, and there is nothing on a canvas that would contradict
 * it — which is why `regionsRead: false` has to survive the reduction as `null`
 * and not as a zero. And the several ways of having no conflict all render as an
 * empty canvas, which reads as a merge that is safe to land: three of them are
 * states where it is not.
 *
 * `clashKindOf` is in here for a fourth reason and it is the narrowest of the
 * lot: git's `-z` type field says `contents` where its prose says `content`, so
 * a classifier written from the message would put every ordinary conflict in the
 * "some other kind" bucket, on a map where nothing would look broken.
 *
 * The drawing is deliberately not tested, for `touchedMap.test.ts`'s reason:
 * there is no DOM here and an assertion over a radius or a colour restates the
 * code rather than checking it.
 */

function file(over: Partial<ConflictFileDTO> & Pick<ConflictFileDTO, "path">): ConflictFileDTO {
  return {
    type: "contents",
    message: null,
    regions: [],
    regionsOmitted: 0,
    regionsRead: true,
    ...over,
  };
}

/** A file that was read and holds `n` clashes, `shown` of them rendered. */
function withClashes(path: string, n: number, type = "contents"): ConflictFileDTO {
  const shown = Math.min(n, 5);
  return file({
    path,
    type,
    regions: Array.from({ length: shown }, () => ({ text: "<<<<<<< a\n=======\n>>>>>>> b", truncated: false })),
    regionsOmitted: n - shown,
    regionsRead: true,
  });
}

/** A file past `MAX_CONTENT_FILES`: listed by the stage records, never opened. */
function unread(path: string, type: string | null = "contents"): ConflictFileDTO {
  return file({ path, type, regions: [], regionsOmitted: 0, regionsRead: false });
}

function landState(over: Partial<LandStateDTO> = {}): LandStateDTO {
  return {
    runId: "r1",
    runStatus: "completed",
    branch: "uf/r1",
    target: "main",
    targetInferred: false,
    branchExists: true,
    ahead: 3,
    behind: 1,
    merged: false,
    landedUnchanged: false,
    preview: { outcome: "clean" },
    checkout: null,
    pending: null,
    blocked: null,
    landedAt: null,
    landedInto: null,
    landedStrategy: null,
    ...over,
  };
}

const previewOf = (files: ConflictFileDTO[]): MergePreviewDTO => ({ outcome: "conflict", files });

describe("what git's conflict type collapses to", () => {
  it("takes git's own spelling of a content conflict, which is the plural one", () => {
    // The `-z` informational record's *type* field is `CONFLICT (contents)` and
    // only its message says `content`. Verified against git 2.39.5, which is
    // what the container ships. A classifier written from the message alone puts
    // every ordinary conflict in `other`, and nothing on the map looks wrong.
    assert.equal(clashKindOf("contents"), "content");
    assert.equal(clashKindOf("content"), "content");
    assert.equal(clashKindOf("modify/delete"), "modify-delete");
  });

  it("keeps a type git did not give apart from a content conflict", () => {
    // `parseMergeTree` parses the informational section defensively on purpose:
    // a git whose format differs loses every type and still lists every
    // conflicting file. Rendering those as `content` would be this map
    // inventing the annotation the parser declined to guess at.
    assert.equal(clashKindOf(null), "untyped");
    assert.equal(clashKindOf(""), "untyped");
    assert.equal(clashKindOf("   "), "untyped");
  });

  it("keeps every other kind git names apart from both", () => {
    // All observed on real `merge-tree --write-tree -z` output. An `add/add`
    // arrives with the type field `contents`, so this is about the ones that do
    // not: their story is in the message and the map can only say "not one of
    // the two".
    for (const type of ["binary", "file/directory", "rename/rename", "rename/delete"]) {
      assert.equal(clashKindOf(type), "other", type);
    }
  });
});

describe("the tree", () => {
  it("files each conflict under its own directory and sums to every ancestor", () => {
    const tree = buildConflictTree([
      withClashes("src/lib/land.ts", 3),
      withClashes("src/lib/db.ts", 1),
      withClashes("src/app/page.tsx", 2),
      withClashes("README.md", 1),
    ]);

    assert.deepEqual([...tree.dirs.keys()].sort(), ["", "src", "src/app", "src/lib"]);
    assert.deepEqual(tree.roots, [""]);

    assert.equal(tree.dirs.get("src/lib")?.subtreeClashes, 4);
    assert.equal(tree.dirs.get("src/app")?.subtreeClashes, 2);
    // Every ancestor, not just the parent: a folded `src` that undercounts what
    // is behind it says the wrong number in the one place a fold exists to say a
    // number at all.
    assert.equal(tree.dirs.get("src")?.subtreeClashes, 6);
    assert.equal(tree.dirs.get("")?.subtreeClashes, 7);
    assert.equal(tree.dirs.get("")?.subtreeFiles, 4);
  });

  it("counts the clashes a file was cut short of showing", () => {
    // `regions` is capped at MAX_REGIONS_PER_FILE and the rest are counted, so a
    // size read off `regions.length` alone would draw a nine-clash file the same
    // as a five-clash one.
    const tree = buildConflictTree([withClashes("a.ts", 9)]);
    assert.equal(tree.files[0].clashes, 9);
    assert.equal(tree.files[0].regionsRead, true);
  });

  it("carries an unread file as an unknown count, never as a zero", () => {
    // The whole point of the surface. A file past MAX_CONTENT_FILES was listed
    // by the stage records and never opened; a `modify/delete` that *was* opened
    // legitimately holds zero regions. Collapsing the two makes the map claim
    // there is nothing to reconcile in a file nobody looked at.
    const tree = buildConflictTree([
      unread("src/lib/a.ts"),
      file({ path: "src/lib/b.ts", type: "modify/delete", regionsRead: true }),
    ]);

    const byPath = new Map(tree.files.map((f) => [f.path, f]));
    assert.equal(byPath.get("src/lib/a.ts")?.clashes, null);
    assert.equal(byPath.get("src/lib/b.ts")?.clashes, 0);

    const dir = tree.dirs.get("src/lib");
    // The read zero is added; the unknown is counted apart, so `subtreeClashes`
    // is a floor and the surface has the second number it needs to say so.
    assert.equal(dir?.subtreeClashes, 0);
    assert.equal(dir?.subtreeUnread, 1);
  });

  it("rolls types up as a union and counts the untyped separately", () => {
    const rollup = summariseClashes([
      { type: "contents", kind: "content", message: null, clashes: 2, regionsRead: true },
      { type: "contents", kind: "content", message: null, clashes: 1, regionsRead: true },
      { type: "modify/delete", kind: "modify-delete", message: null, clashes: 0, regionsRead: true },
      { type: null, kind: "untyped", message: null, clashes: null, regionsRead: false },
    ]);

    assert.deepEqual(rollup.types, ["contents", "modify/delete"]);
    // Not a type, so not in the list — a `null` sorted into `types` would render
    // as a conflict kind called "null" on a directory nobody could check.
    assert.equal(rollup.subtreeUntyped, 1);
    assert.equal(rollup.subtreeUnread, 1);
    assert.equal(rollup.subtreeClashes, 3);
  });

  it("sorts unknown counts with the unknowns rather than among the counts", () => {
    const tree = buildConflictTree([
      unread("d/b.ts"),
      withClashes("d/a.ts", 1),
      withClashes("d/c.ts", 4),
    ]);
    assert.deepEqual(
      tree.dirs.get("d")?.files.map((f) => f.name),
      ["c.ts", "a.ts", "b.ts"],
    );
  });
});

describe("the fold", () => {
  it("draws or folds every conflicted file and never drops one", () => {
    const paths = Array.from({ length: 24 }, (_, i) => `src/lib/deep/nest/f${i}.ts`);
    const tree = buildConflictTree(paths.map((p) => withClashes(p, 1)));
    const plan = planConflictMap(tree, { budget: 4 });

    assert.equal(plan.drawnFiles + plan.foldedFiles, 24);
    assert.ok(plan.folded.length > 0);
  });

  it("keeps a directory open once the operator opens it", () => {
    const tree = buildConflictTree([
      withClashes("src/lib/a.ts", 1),
      withClashes("src/lib/b.ts", 1),
      withClashes("docs/c.md", 1),
    ]);
    const plan = planConflictMap(tree, { budget: 1, expanded: new Set(["src/lib"]) });

    const ids = new Set(plan.nodes.map((n) => n.id));
    assert.ok(ids.has(nodeId("dir", "src/lib")));
    assert.ok(ids.has(nodeId("file", "src/lib/a.ts")));
  });
});

describe("the ways of having no conflict", () => {
  it("keeps a run with no branch apart from a merge with nothing wrong with it", () => {
    // `landState` answers null for a run that was never isolated. Drawn as a
    // clean merge that is an invitation to land work that is not on a branch.
    assert.deepEqual(conflictMapView(null), { kind: "no-branch" });
  });

  it("says a branch is gone rather than that git could not tell", () => {
    // `landState` returns before it previews anything when the branch or its
    // repository has gone, so the preview it carries is still the placeholder it
    // was built with. Read in outcome order first, a deleted branch renders as
    // "git could not work the merge out", which is true of nothing and buries
    // the sentence that says the work is not there.
    const view = conflictMapView(
      landState({
        branchExists: false,
        blocked: "Branch uf/r1 no longer exists.",
        preview: { outcome: "unknown", reason: "Not checked." },
      }),
    );
    assert.deepEqual(view, { kind: "gone", reason: "Branch uf/r1 no longer exists." });
  });

  it("gives already-merged, fast-forward and clean three different answers", () => {
    // Three true statements about three different branches. One sentence over
    // all three tells two of them something false.
    assert.equal(conflictMapView(landState({ preview: { outcome: "already-merged" } })).kind, "already-merged");
    assert.equal(conflictMapView(landState({ preview: { outcome: "fast-forward" } })).kind, "fast-forward");
    assert.equal(conflictMapView(landState({ preview: { outcome: "clean" } })).kind, "clean");
  });

  it("never renders git declining to answer as a clean merge", () => {
    // A git older than 2.38 and a run that can still commit both arrive here.
    // Neither has said the merge is safe.
    const view = conflictMapView(
      landState({
        preview: { outcome: "unknown", reason: "This run can still commit to it." },
      }),
    );
    assert.deepEqual(view, { kind: "unknown", reason: "This run can still commit to it." });
  });

  it("keeps a conflict that named no file off the canvas", () => {
    // Exit 1 with unreadable stage records is git saying a merge fails while
    // declining to say where. An empty canvas is what a clean merge looks like,
    // so this is the one state that must not be drawn.
    assert.deepEqual(conflictMapView(landState({ preview: previewOf([]) })), { kind: "none-named" });
  });

  it("draws a conflict and says how many files it could not open", () => {
    const files = [withClashes("src/lib/a.ts", 2), unread("src/lib/b.ts"), unread("docs/c.md")];
    const view = conflictMapView(landState({ preview: previewOf(files) }));

    assert.equal(view.kind, "map");
    if (view.kind !== "map") return;
    assert.equal(view.files.length, 3);
    // The count the surface has to say out loud, decided here rather than at
    // draw time so it is the tested function that produces it.
    assert.equal(view.unread, 2);
  });
});
