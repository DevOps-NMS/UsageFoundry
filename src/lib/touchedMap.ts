import type { RunDiffDTO, RunTouchedDTO } from "./apiTypes";
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
import { reconcileTouches, type TouchReport, type TouchedFile } from "./runTouches";

/**
 * What a run touched, arranged by where in the repository it sits.
 *
 * The arrangement itself is `pathMap.ts` and knows nothing about touches; what
 * is here is the payload — what a call log can say about one file, and what a
 * directory says about the files under it.
 *
 * **The node set is files, and the arrangement is the path hierarchy.** The
 * obvious graph over this data is tool → file, and it is the wrong one at every
 * size: a dozen tool hubs with nearly every file hanging off `Read` is a star,
 * and a star draws one fact — that the run read a lot — which is a fact the
 * count above the table already states. `src/lib/` against `docs/agent/` is a
 * question with a spatial answer; "what did `Read` touch" is not. So tool
 * identity is an *attribute* here (`TouchedFile.tools`, and the union of them on
 * a directory) and never a node, and the edges are containment rather than
 * causation.
 *
 * Two consequences worth stating, because both are invisible if they go wrong:
 *
 * - **Nothing here says a touch succeeded.** `reconcileTouches` is upstream of
 *   this file and its rows are attempts; this module adds no field that could be
 *   read as an outcome. `state` distinguishes read from written from both, which
 *   is what the call *asked for*, not what it got.
 * - **A file is never dropped.** That is `pathMap.ts`'s rule and the reason the
 *   fold there is a depth cutoff rather than `capGraph`'s degree-first prune,
 *   but it is this map's promise: the surface prints the folded count out loud.
 *
 * **This module reaches nothing** — the same rule `runTouches.ts` states, and
 * for the same reason: the page that draws the map is a `"use client"` file and
 * imports it, so one server import would follow `node:fs` into the browser
 * bundle. It also lives in `src/lib` because that is what `tsconfig.test.json`
 * compiles, and every failure mode below is silent: a tree that files a path
 * under the wrong parent draws a plausible picture of a repository that does not
 * exist.
 */

/**
 * What the run did to a file, as far as the call log can say.
 *
 * `unnamed` is not an absence of information — it is the "changed, never named
 * by a tool call" group, which has a diff entry and no event. It is the group
 * the SessionFlow proposal recorded a tool → file graph as *structurally unable*
 * to show, because a file with no event has no edge to any tool. Laid out by
 * path it has a position like everything else.
 */
export type TouchState = "read" | "written" | "both" | "unnamed";

/** What this map knows about one file, on top of where the file sits. */
export interface TouchFacts {
  reads: number;
  writes: number;
  /** `reads + writes`. Zero for `unnamed`, which is why it is not a size alone. */
  calls: number;
  state: TouchState;
  /** Listed by the branch diff. Always false when the changed set is unknown. */
  inDiff: boolean;
  /** Matched neither `runs.work_dir` nor `runs.folder`. */
  outside: boolean;
  tools: string[];
  by: string[];
}

/** What this map says about a directory, summed over the files under it. */
export interface TouchRollup {
  subtreeCalls: number;
  /** Files under it with at least one write. */
  subtreeWritten: number;
  /** Files under it the diff lists. */
  subtreeInDiff: number;
  /** Every tool named under it, distinct and sorted. */
  tools: string[];
  /** True when everything under it is outside the checkout. */
  outside: boolean;
}

/** One file, positioned by its path rather than by what reached it. */
export type MapFile = PathFile<TouchFacts>;

/** One directory, with what is under it already summed. */
export type MapDir = PathDir<TouchFacts, TouchRollup>;

export type TouchedTree = PathTree<TouchFacts, TouchRollup>;

/** One thing the canvas draws — a file, a directory anchor, or a fold. */
export type PlanNode = PathPlanNode<TouchFacts, TouchRollup>;

export type MapPlan = PathPlan<TouchFacts, TouchRollup>;

/* -------------------------------- the tree --------------------------------- */

function stateOf(file: TouchedFile): TouchState {
  if (file.reads > 0 && file.writes > 0) return "both";
  if (file.writes > 0) return "written";
  if (file.reads > 0) return "read";
  return "unnamed";
}

/** Busiest first, then by name — the table's tiebreak, for the same reason. */
function byCallsThenName(a: MapFile, b: MapFile): number {
  return b.calls - a.calls || a.name.localeCompare(b.name);
}

/**
 * What a folded directory stands for.
 *
 * Two of these five are not sums, which is why the shared core hands the whole
 * subtree over at once rather than folding an ancestor at a time: `tools` is a
 * union, and `outside` is an *all* — a directory is outside the checkout only
 * when every file under it is.
 */
function summariseTouches(files: readonly TouchFacts[]): TouchRollup {
  const tools = new Set<string>();
  let subtreeCalls = 0;
  let subtreeWritten = 0;
  let subtreeInDiff = 0;
  let outside = true;
  for (const file of files) {
    subtreeCalls += file.calls;
    if (file.writes > 0) subtreeWritten++;
    if (file.inDiff) subtreeInDiff++;
    if (!file.outside) outside = false;
    for (const tool of file.tools) tools.add(tool);
  }
  return {
    subtreeCalls,
    subtreeWritten,
    subtreeInDiff,
    tools: [...tools].sort(),
    outside,
  };
}

/**
 * A `TouchReport`'s four groups as one tree, keyed on where each file sits.
 *
 * The groups are disjoint by construction upstream, so this concatenates them
 * rather than merging: a path appearing twice here would be a bug in
 * `reconcileTouches`, and hiding it behind a `Map` would make it invisible
 * instead of wrong.
 *
 * `changedNotTouched` carries no counts, and that is why `state` exists as a
 * field rather than being derived from `calls` at draw time — a zero there means
 * "no event named this", not "nothing happened".
 */
export function buildTouchTree(report: TouchReport): TouchedTree {
  const entries: PathEntry<TouchFacts>[] = [];
  for (const group of [
    report.changedNotTouched,
    report.touchedAndChanged,
    report.touchedNotChanged,
    report.outsideCheckout,
  ]) {
    for (const file of group) {
      entries.push({
        path: file.path,
        payload: {
          reads: file.reads,
          writes: file.writes,
          calls: file.reads + file.writes,
          state: stateOf(file),
          inDiff: file.inDiff,
          outside: file.outside,
          tools: file.tools,
          by: file.by,
        },
      });
    }
  }

  return buildPathTree(entries, { summarise: summariseTouches, compare: byCallsThenName });
}

/* -------------------------------- the plan --------------------------------- */

/**
 * `planPathMap` with this map's payload bound, and nothing else.
 *
 * A binding rather than a re-export, because the name is what the page and its
 * test reach for and the fold is not this module's decision to restate — every
 * rule the plan obeys (the depth cutoff, a root never folding, an expansion
 * carrying its ancestors) is written once, over there.
 */
export const planTouchedMap: (tree: TouchedTree, options: PlanOptions) => MapPlan = planPathMap;

/* ------------------------------- the nothings ------------------------------- */

/**
 * What the page has to draw, with the ways of having nothing kept apart.
 *
 * The same rule the card below the diff obeys and for the same reason: swept,
 * named-no-file and no-such-run are three different facts that all render as a
 * blank canvas, and a blank canvas is read as a run that touched nothing.
 * `changedKnown` is the fourth: with no diff the changed set is *unknown* rather
 * than empty, so nothing on the map may draw the "in the diff" mark or claim a
 * file was not changed.
 */
export type TouchedMapView =
  | { kind: "swept"; horizonDays: number }
  | { kind: "gone"; reason: string }
  | { kind: "idle"; cycles: number }
  | {
      kind: "map";
      report: TouchReport;
      cycles: number;
      changedKnown: boolean;
      /** The diff route's own sentence, when there is no diff to reconcile against. */
      diffReason: string | null;
      /** Every node came from the diff: no tool call in this run named a file. */
      unnamedOnly: boolean;
    };

/**
 * Choose the view from the two answers the page fetched.
 *
 * `swept` outranks everything, including a diff that loaded: a checkout is kept
 * on a different clock from `run_events`, so an old run routinely has changes
 * and no events, and drawing its diff without saying the events are gone would
 * be a map claiming the run read nothing.
 *
 * The one place this is more complete than the table is `empty` *with* a diff.
 * A run that wrote through `Bash` alone named no file and has changed files
 * anyway; the table renders that as its "no tool call named a file" sentence and
 * stops, because it holds no report. Here every one of those files has a path
 * and therefore a position, so they are drawn — `unnamedOnly` is what the
 * surface says over them, so the picture is not read as a run that read them.
 */
export function touchedMapView(
  touched: RunTouchedDTO,
  diff: RunDiffDTO | null,
): TouchedMapView {
  if (touched.kind === "swept") return { kind: "swept", horizonDays: touched.horizonDays };
  if (touched.kind === "none") return { kind: "gone", reason: touched.reason };

  const changedKnown = diff !== null && diff.kind !== "none";
  // `path` alone and never `oldPath`, for the table's own reason: a rename's old
  // name is a path no tool call would have named, and listing it would put a
  // file on the map that was never there under that name.
  const changed = changedKnown ? diff.files.map((f) => f.path) : [];

  if (touched.kind === "empty") {
    if (changed.length === 0) return { kind: "idle", cycles: touched.cycles };
    return {
      kind: "map",
      report: reconcileTouches([], changed),
      cycles: touched.cycles,
      changedKnown: true,
      diffReason: null,
      unnamedOnly: true,
    };
  }

  return {
    kind: "map",
    report: reconcileTouches(touched.touches, changed),
    cycles: touched.cycles,
    changedKnown,
    diffReason: changedKnown ? null : (diff?.reason ?? null),
    unnamedOnly: false,
  };
}
