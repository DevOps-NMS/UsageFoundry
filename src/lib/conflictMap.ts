import type { ConflictFileDTO, LandStateDTO } from "./apiTypes";
import {
  buildPathTree,
  planPathMap,
  type PathDir,
  type PathEntry,
  type PathFile,
  type PathPlan,
  type PathPlanNode,
  type PathTree,
  type PlanOptions,
} from "./pathMap";

/**
 * A pending merge's conflicted files, arranged by where in the repository they sit.
 *
 * The arrangement itself is `pathMap.ts` and knows nothing about merges; what is
 * here is the payload — what `merge-tree`'s answer can say about one file, what
 * a directory says about the files under it, and which of the several ways of
 * having no conflict this run is in.
 *
 * **The touch map's encoding is not reused, and could not be.** That map sizes a
 * node by `√calls` and fills it by read/written/both/unnamed. A conflicted file
 * has no calls and no tool ever named it, so every node would draw at the floor
 * radius in one colour: a uniform dot dendrogram, which is a picture of nothing.
 * What a conflict carries instead is a *clash count* and a *kind*, and those are
 * the two things `RunConflictMap` draws.
 *
 * **`regionsRead: false` is the load-bearing field.** `land.ts` caps content
 * reads at `MAX_CONTENT_FILES` per preview: the path list is complete — it comes
 * from `merge-tree`'s stage records — but files past the cap were never opened.
 * "We did not look" and "there are no clashes here" are different sentences, and
 * a `modify/delete` really does leave no markers, so a node whose count is
 * unknown carries `clashes: null` rather than a zero. Nothing here may hand a
 * size to a caller that would assert a count nobody read; that is the exact
 * analogue of the touch map's `changedKnown`, and it fails the same way — by
 * drawing a confident picture with no error anywhere.
 *
 * **This module reaches nothing.** The page that draws the map is a `"use
 * client"` file and imports it, so a single server import would follow `node:fs`
 * into the browser bundle — which is why it reads `ConflictFileDTO` off the wire
 * and never `land.ts`'s own `ConflictFile`. It also lives in `src/lib` because
 * that is what `tsconfig.test.json` compiles, and every failure mode below is
 * silent: a tree that files a path under the wrong parent draws a plausible
 * picture of a repository that does not exist, and a nothing-state that falls
 * through to the map draws an empty canvas, which reads as a merge with no
 * conflicts in it.
 */

/* -------------------------------- the facts -------------------------------- */

/**
 * The fill classes, which are what git's own conflict *type* collapses to.
 *
 * `content` and `modify/delete` are the two that matter and must not read alike:
 * one is two edits of the same lines and the operator will read markers, the
 * other is a file one side deleted and there are no markers to read at all.
 *
 * The other two are absences of different kinds and neither may borrow
 * `content`'s colour. `other` is a type git *did* name that is neither of those —
 * `add/add`, `rename/rename`, `file/directory`, `binary` — where the message
 * carries the story and the map can only say "not one of the two". `untyped` is
 * a file the stage records listed and the informational section said nothing
 * about: `parseMergeTree` parses that section defensively on purpose, so an
 * unreadable one loses every type while still listing every conflicting file.
 * Rendering that as `content` would be this surface inventing the annotation the
 * parser deliberately declined to guess at.
 */
export type ClashKind = "content" | "modify-delete" | "other" | "untyped";

/**
 * git's own spellings of a content conflict, both of them.
 *
 * The `-z` informational record's *type* field is `CONFLICT (contents)` — plural
 * — and only its human message says `CONFLICT (content)`. `parseMergeTree` keeps
 * the type field, so `"contents"` is what actually arrives from git 2.39, which
 * is what the container ships; `"content"` is here because the field layout was
 * captured from 2.50 and this file must not be the thing that decides a released
 * git renders as `other`. Verified against `git merge-tree --write-tree -z` on
 * 2.39.5: a content clash and an `add/add` both report `contents`, a deletion
 * reports `modify/delete`, and a binary clash reports `binary`.
 */
const CONTENT_TYPES = new Set(["content", "contents"]);

/** git's spelling of the one conflict that leaves no markers behind. */
const MODIFY_DELETE = "modify/delete";

export function clashKindOf(type: string | null): ClashKind {
  if (type === null) return "untyped";
  const name = type.trim().toLowerCase();
  if (name === "") return "untyped";
  if (CONTENT_TYPES.has(name)) return "content";
  if (name === MODIFY_DELETE) return "modify-delete";
  return "other";
}

/** What this map knows about one conflicted file, on top of where the file sits. */
export interface ClashFacts {
  /** git's own name for the conflict, exactly as it gave it. Null when it gave none. */
  type: string | null;
  kind: ClashKind;
  /** git's one-line explanation. The whole story for a conflict with no markers. */
  message: string | null;
  /**
   * `regions.length + regionsOmitted`, or **null** when the merged content was
   * never read. Null rather than zero, because zero is a real answer a
   * `modify/delete` gives and this is the absence of one.
   */
  clashes: number | null;
  /** False when the merged content was never read, so `clashes` says nothing. */
  regionsRead: boolean;
}

/** What this map says about a directory, summed over the conflicts under it. */
export interface ClashRollup {
  /**
   * Clash regions under it, counted over the files that were read — so it is a
   * floor and never a total. `subtreeUnread` is the other half of the sentence
   * and the two are always shown together.
   */
  subtreeClashes: number;
  /** Files under it whose merged content was never read. */
  subtreeUnread: number;
  /** Every conflict type named under it, distinct and sorted. */
  types: string[];
  /** Files under it git named no type for. Not a type, so not in `types`. */
  subtreeUntyped: number;
}

/** One conflicted file, positioned by its path. */
export type ClashFile = PathFile<ClashFacts>;

/** One directory, with what is under it already summed. */
export type ClashDir = PathDir<ClashFacts, ClashRollup>;

export type ConflictTree = PathTree<ClashFacts, ClashRollup>;

/** One thing the canvas draws — a file, a directory anchor, or a fold. */
export type ClashNode = PathPlanNode<ClashFacts, ClashRollup>;

export type ConflictPlan = PathPlan<ClashFacts, ClashRollup>;

/* -------------------------------- the tree --------------------------------- */

/**
 * What a folded directory stands for — and what it may not claim.
 *
 * Two of these four are not sums. `types` is a union, and `subtreeUnread` is the
 * reason `subtreeClashes` is safe to add up at all: summing a count over files
 * whose count nobody read would make an ancestor state a total it does not have,
 * and there is no field on a fold that would ever contradict it. So the unread
 * files are counted separately and the surface says both numbers.
 *
 * Handed the whole subtree at once by the shared core, rather than folded an
 * ancestor at a time, for `summariseTouches`' reason: a union is not an
 * increment.
 */
export function summariseClashes(files: readonly ClashFacts[]): ClashRollup {
  const types = new Set<string>();
  let subtreeClashes = 0;
  let subtreeUnread = 0;
  let subtreeUntyped = 0;
  for (const file of files) {
    if (file.clashes === null) subtreeUnread++;
    else subtreeClashes += file.clashes;
    if (file.type === null) subtreeUntyped++;
    else types.add(file.type);
  }
  return { subtreeClashes, subtreeUnread, types: [...types].sort(), subtreeUntyped };
}

/**
 * Files directly in a directory, in draw order.
 *
 * Order inside a rosette is not a ranking anybody reads — the count is on the
 * node's size and in the inspector — so a file whose count is unknown is sorted
 * with the other unknowns rather than being given a position among the counts. A
 * `-1` for null is what does that, and it is the only thing here that would be
 * wrong as a zero.
 */
export function byClashesThenName(a: ClashFile, b: ClashFile): number {
  return (b.clashes ?? -1) - (a.clashes ?? -1) || a.name.localeCompare(b.name);
}

/**
 * A preview's conflicted files as one tree, keyed on where each file sits.
 *
 * `merge-tree`'s stage records de-duplicate upstream in `parseMergeTree`, so a
 * path appearing twice here would be a bug there; the shared core lays a
 * duplicate out twice rather than merging it, which is what makes that visible
 * instead of invisible.
 */
export function buildConflictTree(files: readonly ConflictFileDTO[]): ConflictTree {
  const entries: PathEntry<ClashFacts>[] = files.map((file) => ({
    path: file.path,
    payload: {
      type: file.type,
      kind: clashKindOf(file.type),
      message: file.message,
      clashes: file.regionsRead ? file.regions.length + file.regionsOmitted : null,
      regionsRead: file.regionsRead,
    },
  }));

  return buildPathTree(entries, { summarise: summariseClashes, compare: byClashesThenName });
}

/* -------------------------------- the plan --------------------------------- */

/**
 * `planPathMap` with this map's payload bound, and nothing else.
 *
 * A binding rather than a re-export, for `planTouchedMap`'s reason: every rule
 * the plan obeys — the depth cutoff, a root never folding, an expansion carrying
 * its ancestors, no file ever dropped — is written once, over there.
 */
export const planConflictMap: (tree: ConflictTree, options: PlanOptions) => ConflictPlan =
  planPathMap;

/* ------------------------------- the nothings ------------------------------- */

/**
 * What the page has to draw, with the ways of having nothing kept apart.
 *
 * `MergePreview` has five outcomes and four of them are not a conflict, and a
 * run can also have no branch at all or a branch git can no longer find. Every
 * one of those otherwise renders as a blank canvas, and a blank canvas is read
 * as a merge with nothing wrong with it — which is the one reading that costs
 * the operator something, since three of these are states where landing is *not*
 * safe.
 *
 * `already-merged`, `fast-forward` and `clean` are three different true
 * statements and each gets its own sentence. `unknown` is git declining to
 * answer — a git older than 2.38, a command that failed, or a run that can still
 * commit — and it carries `reason` because "we could not tell" is only useful
 * with the because-clause attached.
 */
export type ConflictMapView =
  /** No branch to merge: not isolated, or it stopped before its checkout existed. */
  | { kind: "no-branch" }
  /** The branch or its repository is not there any more, in the land card's own words. */
  | { kind: "gone"; reason: string }
  | { kind: "already-merged" }
  | { kind: "fast-forward" }
  | { kind: "clean" }
  /** git could not work the merge out. Never a clean merge. */
  | { kind: "unknown"; reason: string }
  /** git reported a conflict and named no path. Also never a clean merge. */
  | { kind: "none-named" }
  | {
      kind: "map";
      files: readonly ConflictFileDTO[];
      /** Files whose merged content was never read, so their clash count is unknown. */
      unread: number;
    };

/** Said when a branch is gone and the state carried no sentence of its own. */
const GONE_FALLBACK = "This run's branch is no longer there, so there is no merge to preview.";

/**
 * Choose the view from the one answer the page fetched.
 *
 * **`gone` outranks the preview, and has to.** With `branchExists` false,
 * `landState` returns before it previews anything and the preview it carries is
 * still the `{ outcome: "unknown", reason: "Not checked." }` placeholder it was
 * built with. Read in outcome order first, a deleted branch renders as "git
 * could not work the merge out" — true of nothing, and it buries the sentence
 * that says the work is not there any more. The same shape as `swept` outranking
 * a loaded diff on the touch map, and for the same reason: the more general fact
 * is the one that changes what the reader should do.
 *
 * A conflict naming **no** file gets its own kind rather than an empty map.
 * `parseMergeTree` returns exit 1 with an empty list when the stage records are
 * unreadable, and that is git saying a merge fails while declining to say where
 * — the one state on this page that must not be drawn, because a canvas with
 * nothing on it is exactly what a clean merge would look like.
 */
export function conflictMapView(state: LandStateDTO | null): ConflictMapView {
  if (!state) return { kind: "no-branch" };
  if (!state.branchExists) return { kind: "gone", reason: state.blocked ?? GONE_FALLBACK };

  const preview = state.preview;
  switch (preview.outcome) {
    case "already-merged":
      return { kind: "already-merged" };
    case "fast-forward":
      return { kind: "fast-forward" };
    case "clean":
      return { kind: "clean" };
    case "unknown":
      return { kind: "unknown", reason: preview.reason };
    case "conflict":
      if (preview.files.length === 0) return { kind: "none-named" };
      return {
        kind: "map",
        files: preview.files,
        unread: preview.files.filter((file) => !file.regionsRead).length,
      };
  }
}
