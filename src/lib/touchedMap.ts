import type { RunDiffDTO, RunTouchedDTO } from "./apiTypes";
import { reconcileTouches, type TouchReport, type TouchedFile } from "./runTouches";

/**
 * What a run touched, arranged by where in the repository it sits.
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
 * - **A file is never dropped.** When the drawn count is over budget the tree is
 *   folded at a *depth*, and every folded directory keeps the count of what is
 *   behind it so the surface can say the number out loud. `capGraph`'s
 *   degree-first pruning is deliberately not reused: largest-degree-first over
 *   this graph discards files and keeps directories, which is backwards.
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

/** One file, positioned by its path rather than by what reached it. */
export interface MapFile {
  /** Relative to the checkout, or absolute when `outside`. */
  path: string;
  /** The last segment — what a label shows. */
  name: string;
  /** The directory holding it, as `dirOf` writes one. */
  dir: string;
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

/**
 * One directory, with what is under it already summed.
 *
 * The subtree figures are what a folded node draws, so they are computed once
 * here rather than by a walk at draw time: a frame that recurses a directory
 * tree is a frame that gets slower as the run gets bigger, and the figures
 * cannot change between frames.
 */
export interface MapDir {
  /** `""` is the checkout root and `"/"` the filesystem root. */
  path: string;
  /** `"."` for the checkout root, `"/"` for the filesystem root. */
  name: string;
  parent: string | null;
  /** Hops to a root. Both roots are 0. */
  depth: number;
  /** Files directly in it, busiest first then by name. */
  files: MapFile[];
  /** Directories directly under it, sorted. */
  children: string[];
  /** Files at or under it. Never zero: a directory exists only to hold one. */
  subtreeFiles: number;
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

export interface TouchedTree {
  dirs: ReadonlyMap<string, MapDir>;
  files: readonly MapFile[];
  /** `""` then `"/"`, for whichever of the two has anything under it. */
  roots: readonly string[];
  /** The deepest directory holding a file, which bounds the fold search. */
  maxDepth: number;
}

/* ------------------------------ path arithmetic ----------------------------- */

/**
 * The directory holding `path`.
 *
 * Two roots rather than one, because a run's touches are not all relative:
 * `outside` paths arrive absolute and their chain has to end somewhere that is
 * visibly not the checkout. `"README.md"` sits in `""`; `"/tmp/x.txt"` sits in
 * `"/"`. Collapsing the two would file a path in `/etc` under the repository
 * root, which is a claim about the run that is not true.
 */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return "";
  if (cut === 0) return "/";
  return path.slice(0, cut);
}

/** The directory above this one, or null at either root. */
export function parentOf(dir: string): string | null {
  if (dir === "" || dir === "/") return null;
  return dirOf(dir);
}

/** What a directory is called on screen. Both roots get a name a path could hold. */
export function dirName(dir: string): string {
  if (dir === "") return ".";
  if (dir === "/") return "/";
  const cut = dir.lastIndexOf("/");
  return cut < 0 ? dir : dir.slice(cut + 1);
}

/** The last segment of a path. */
export function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

/* -------------------------------- the tree --------------------------------- */

function stateOf(file: TouchedFile): TouchState {
  if (file.reads > 0 && file.writes > 0) return "both";
  if (file.writes > 0) return "written";
  if (file.reads > 0) return "read";
  return "unnamed";
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
  const files: MapFile[] = [];
  for (const group of [
    report.changedNotTouched,
    report.touchedAndChanged,
    report.touchedNotChanged,
    report.outsideCheckout,
  ]) {
    for (const file of group) {
      files.push({
        path: file.path,
        name: baseName(file.path),
        dir: dirOf(file.path),
        reads: file.reads,
        writes: file.writes,
        calls: file.reads + file.writes,
        state: stateOf(file),
        inDiff: file.inDiff,
        outside: file.outside,
        tools: file.tools,
        by: file.by,
      });
    }
  }

  const dirs = new Map<string, MapDir>();
  const toolsOf = new Map<string, Set<string>>();

  const ensure = (path: string): MapDir => {
    const found = dirs.get(path);
    if (found) return found;
    const parent = parentOf(path);
    const made: MapDir = {
      path,
      name: dirName(path),
      parent,
      // Filled after the parent chain exists, so a deep first file cannot leave
      // an ancestor holding a depth measured from the wrong end.
      depth: 0,
      files: [],
      children: [],
      subtreeFiles: 0,
      subtreeCalls: 0,
      subtreeWritten: 0,
      subtreeInDiff: 0,
      tools: [],
      outside: true,
      };
    dirs.set(path, made);
    toolsOf.set(path, new Set<string>());
    if (parent !== null) ensure(parent).children.push(path);
    return made;
  };

  for (const file of files) {
    ensure(file.dir).files.push(file);
    // Every ancestor, not just the parent: a folded `src/` has to know about a
    // file in `src/lib/db.ts` or its count understates what it is standing for,
    // which is the one number a fold exists to say.
    for (let at: string | null = file.dir; at !== null; at = parentOf(at)) {
      const dir = dirs.get(at);
      if (!dir) continue;
      dir.subtreeFiles++;
      dir.subtreeCalls += file.calls;
      if (file.writes > 0) dir.subtreeWritten++;
      if (file.inDiff) dir.subtreeInDiff++;
      if (!file.outside) dir.outside = false;
      const tools = toolsOf.get(at);
      if (tools) for (const tool of file.tools) tools.add(tool);
    }
  }

  let maxDepth = 0;
  for (const dir of dirs.values()) {
    let depth = 0;
    for (let at = dir.parent; at !== null; at = parentOf(at)) depth++;
    dir.depth = depth;
    dir.children.sort();
    dir.files.sort(byCallsThenName);
    dir.tools = [...(toolsOf.get(dir.path) ?? [])].sort();
    if (dir.files.length > 0 && depth > maxDepth) maxDepth = depth;
  }

  const roots = ["", "/"].filter((root) => dirs.has(root));
  return { dirs, files, roots, maxDepth };
}

/** Busiest first, then by name — the table's tiebreak, for the same reason. */
function byCallsThenName(a: MapFile, b: MapFile): number {
  return b.calls - a.calls || a.name.localeCompare(b.name);
}

/* -------------------------------- the plan --------------------------------- */

/**
 * One thing the canvas draws.
 *
 * A `dir` is an anchor and a label: it is where its files hang, and it is not a
 * hub standing in for a tool. A `folded` is a whole directory drawn as one node
 * because the tree was over budget, and it carries `files` so the surface can
 * say how many are behind it. Nothing is ever dropped, so `folded` is the only
 * way a file goes undrawn and it is always announced.
 */
export interface PlanNode {
  /** Prefixed by kind: a directory and a file can share a path string. */
  id: string;
  kind: "dir" | "file" | "folded";
  path: string;
  label: string;
  /** 1 for a file, the subtree count for a fold, 0 for a directory anchor. */
  files: number;
  file: MapFile | null;
  dir: MapDir | null;
}

export interface MapPlan {
  nodes: PlanNode[];
  /** Containment, as indices into `nodes` — never a tool, never causation. */
  edges: { source: number; target: number }[];
  /** Directories at this depth or shallower are drawn open. */
  cutoff: number;
  /** Directory paths drawn as one node each, deepest-visible first. */
  folded: string[];
  /** Files standing behind a fold, and therefore drawn nowhere else. */
  foldedFiles: number;
  drawnFiles: number;
}

export interface PlanOptions {
  /** Drawn file nodes the surface will accept before it starts folding. */
  budget: number;
  /** Directories the operator opened by hand, which no budget closes again. */
  expanded?: ReadonlySet<string>;
}

/**
 * Fold the tree to a depth that fits, and lay out what is left.
 *
 * **The rule is a depth cutoff, not a top-N.** A cutoff keeps the shape of the
 * repository — the top level stays whole and detail rolls up from the leaves —
 * where dropping the smallest directories would leave an arbitrary sample of it,
 * and dropping the *largest* (which is what reusing `capGraph` would do, since
 * it prunes by degree largest-first) would delete exactly the directory the run
 * worked in.
 *
 * `drawnFilesAt` is monotone in the cutoff — raising it only ever unfolds — so
 * the largest cutoff that fits is found by walking down from `maxDepth`. Zero is
 * the floor: a run whose files all sit at the checkout root has nothing left to
 * fold, and drawing them all is the only honest option left. The surface says
 * the number either way.
 */
export function planTouchedMap(tree: TouchedTree, options: PlanOptions): MapPlan {
  const expanded = withAncestors(options.expanded);
  const budget = Math.max(1, options.budget);

  let cutoff = 0;
  for (let candidate = tree.maxDepth; candidate >= 0; candidate--) {
    if (drawnFilesAt(tree, candidate, expanded) <= budget) {
      cutoff = candidate;
      break;
    }
  }

  const nodes: PlanNode[] = [];
  const edges: { source: number; target: number }[] = [];
  const folded: string[] = [];
  let foldedFiles = 0;
  let drawnFiles = 0;

  const walk = (path: string, parentIndex: number | null): void => {
    const dir = tree.dirs.get(path);
    if (!dir) return;

    if (isFolded(dir, cutoff, expanded)) {
      const index = nodes.length;
      nodes.push({
        id: `folded:${path}`,
        kind: "folded",
        path,
        label: dir.name,
        files: dir.subtreeFiles,
        file: null,
        dir,
      });
      if (parentIndex !== null) edges.push({ source: index, target: parentIndex });
      folded.push(path);
      foldedFiles += dir.subtreeFiles;
      return;
    }

    const index = nodes.length;
    nodes.push({
      id: `dir:${path}`,
      kind: "dir",
      path,
      label: dir.name,
      files: 0,
      file: null,
      dir,
    });
    if (parentIndex !== null) edges.push({ source: index, target: parentIndex });

    for (const file of dir.files) {
      const at = nodes.length;
      nodes.push({
        id: `file:${file.path}`,
        kind: "file",
        path: file.path,
        label: file.name,
        files: 1,
        file,
        dir,
      });
      edges.push({ source: at, target: index });
      drawnFiles++;
    }

    for (const child of dir.children) walk(child, index);
  };

  for (const root of tree.roots) walk(root, null);

  return { nodes, edges, cutoff, folded, foldedFiles, drawnFiles };
}

/**
 * Opening a directory opens every directory above it.
 *
 * A fold hides its whole subtree, so an operator can only ever have clicked a
 * directory whose ancestors were already open — and without this the next plan
 * closes one of them under them, because the ancestor is over the cutoff and
 * nothing said otherwise. The symptom is a click that appears to do nothing: the
 * expansion is recorded, the subtree stays hidden behind the parent's fold, and
 * no state is wrong enough to notice.
 */
function withAncestors(paths: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (!paths || paths.size === 0) return new Set<string>();
  const out = new Set<string>();
  for (const path of paths) {
    for (let at: string | null = path; at !== null; at = parentOf(at)) out.add(at);
  }
  return out;
}

/**
 * A directory is folded when it is deeper than the cutoff and nobody opened it.
 *
 * A root is never folded: folding it would leave the map with one node standing
 * for everything, which is a picture of nothing.
 */
function isFolded(dir: MapDir, cutoff: number, expanded: ReadonlySet<string>): boolean {
  if (dir.parent === null) return false;
  return dir.depth > cutoff && !expanded.has(dir.path);
}

/** Files that would be drawn at this cutoff. Counted, never laid out. */
function drawnFilesAt(
  tree: TouchedTree,
  cutoff: number,
  expanded: ReadonlySet<string>,
): number {
  let total = 0;
  const walk = (path: string): void => {
    const dir = tree.dirs.get(path);
    if (!dir || isFolded(dir, cutoff, expanded)) return;
    total += dir.files.length;
    for (const child of dir.children) walk(child);
  };
  for (const root of tree.roots) walk(root);
  return total;
}

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
