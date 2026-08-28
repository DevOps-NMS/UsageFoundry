/**
 * A repository's path hierarchy, arranged for drawing, over any per-file payload.
 *
 * **The node set is files and the edges are containment.** A line means *is in*
 * and asserts a path, never a cause. Whatever a caller knows about a file rides
 * on the node as its payload, and whatever a directory says about the files
 * under it is that payload summarised over the subtree — so a map that made one
 * of those attributes into a node instead (tool → file being the one this was
 * written against) draws a star, and a star draws one fact.
 *
 * **A file is never dropped.** When the drawn count is over budget the tree is
 * folded at a *depth*, and every folded directory keeps the count of what is
 * behind it so the surface can say the number out loud. `capGraph`'s
 * degree-first pruning is deliberately not reused: largest-degree-first over
 * this graph discards files and keeps directories, which is backwards.
 *
 * **This module reaches nothing, and holds no map's vocabulary.** Nothing here
 * is server-side — the surfaces that draw one of these are `"use client"` files
 * and import it, so a single server import would follow `node:fs` into the
 * browser bundle — and nothing here names a field of anybody's payload, because
 * a field belonging to one map is a field the next map has to carry and cannot
 * fill. It also lives in `src/lib` because that is what `tsconfig.test.json`
 * compiles, and every failure mode below is silent: a tree that files a path
 * under the wrong parent draws a plausible picture of a repository that does
 * not exist.
 */

/* ------------------------------ path arithmetic ----------------------------- */

/**
 * The directory holding `path`.
 *
 * Two roots rather than one, because the paths a map is given are not all
 * relative: a path outside the checkout arrives absolute and its chain has to
 * end somewhere that is visibly not the checkout. `"README.md"` sits in `""`;
 * `"/tmp/x.txt"` sits in `"/"`. Collapsing the two would file a path in `/etc`
 * under the repository root, which is a claim that is not true.
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

/**
 * One file, positioned by its path, carrying whatever its map knows about it.
 *
 * The payload sits *on* the node rather than under a `payload` key, because
 * every consumer of one of these — an inspector, a comparator, a fill — reads a
 * fact about the file and not a fact about this module's boxing of it.
 */
export type PathFile<P extends object> = {
  /** Relative to the checkout, or absolute when the path is outside it. */
  path: string;
  /** The last segment — what a label shows. */
  name: string;
  /** The directory holding it, as `dirOf` writes one. */
  dir: string;
} & P;

/**
 * One directory, with its map's summary of what is under it already computed.
 *
 * The subtree figures are what a folded node draws, so `summarise` runs once
 * here rather than by a walk at draw time: a frame that recurses a directory
 * tree is a frame that gets slower as the run gets bigger, and the figures
 * cannot change between frames.
 *
 * The summary is spread *under* these fields rather than over them, so a rollup
 * that happens to name `depth` or `files` loses its own field rather than
 * replacing the one the fold walks on. Neither is checkable — an intersection
 * says both are present and says nothing about which value survived — and of
 * the two silent failures, a rollup field that reads as `undefined` on screen
 * is the one somebody notices.
 */
export type PathDir<P extends object, R extends object> = {
  /** `""` is the checkout root and `"/"` the filesystem root. */
  path: string;
  /** `"."` for the checkout root, `"/"` for the filesystem root. */
  name: string;
  parent: string | null;
  /** Hops to a root. Both roots are 0. */
  depth: number;
  /** Files directly in it, in the spec's comparator order. */
  files: PathFile<P>[];
  /** Directories directly under it, sorted. */
  children: string[];
  /** Files at or under it. Never zero: a directory exists only to hold one. */
  subtreeFiles: number;
} & R;

export interface PathTree<P extends object, R extends object> {
  dirs: ReadonlyMap<string, PathDir<P, R>>;
  files: readonly PathFile<P>[];
  /** `""` then `"/"`, for whichever of the two has anything under it. */
  roots: readonly string[];
  /** The deepest directory holding a file, which bounds the fold search. */
  maxDepth: number;
}

/** One file on the way in: where it sits, and what its map knows about it. */
export interface PathEntry<P extends object> {
  path: string;
  payload: P;
}

/** The two questions this module cannot answer about somebody else's payload. */
export interface PathMapSpec<P extends object, R extends object> {
  /**
   * Every payload at or under a directory, rolled into what that directory says.
   *
   * Handed the whole subtree once rather than folded an ancestor at a time,
   * because a rollup is not always a sum: the touched map's tool list is a
   * union and its `outside` is an *all*, and neither is an increment. Order is
   * the order the entries arrived in.
   */
  summarise(payloads: readonly P[]): R;
  /**
   * Files directly in a directory, in draw order.
   *
   * Out here because it is a payload question and nothing else: one map sorts
   * by how busy a file is, and the next map has no such figure to sort by.
   */
  compare(a: PathFile<P>, b: PathFile<P>): number;
}

/** A directory mid-build, before its map has been asked what it holds. */
interface BuildingDir<P extends object> {
  path: string;
  name: string;
  parent: string | null;
  depth: number;
  files: PathFile<P>[];
  children: string[];
  subtreeFiles: number;
  /** Every payload at or under it, in arrival order, waiting for `summarise`. */
  under: P[];
}

/**
 * A flat list of paths as one tree, keyed on where each file sits.
 *
 * Duplicate paths are laid out twice rather than merged: a caller whose groups
 * are disjoint by construction has a bug if one appears here twice, and hiding
 * it behind a `Map` would make it invisible instead of wrong.
 */
export function buildPathTree<P extends object, R extends object>(
  entries: readonly PathEntry<P>[],
  spec: PathMapSpec<P, R>,
): PathTree<P, R> {
  const files: PathFile<P>[] = [];
  const building = new Map<string, BuildingDir<P>>();

  const ensure = (path: string): BuildingDir<P> => {
    const found = building.get(path);
    if (found) return found;
    const parent = parentOf(path);
    const made: BuildingDir<P> = {
      path,
      name: dirName(path),
      parent,
      // Filled after the parent chain exists, so a deep first file cannot leave
      // an ancestor holding a depth measured from the wrong end.
      depth: 0,
      files: [],
      children: [],
      subtreeFiles: 0,
      under: [],
    };
    building.set(path, made);
    if (parent !== null) ensure(parent).children.push(path);
    return made;
  };

  for (const entry of entries) {
    const dir = dirOf(entry.path);
    const file = {
      ...entry.payload,
      path: entry.path,
      name: baseName(entry.path),
      dir,
    } as PathFile<P>;
    files.push(file);
    ensure(dir).files.push(file);
    // Every ancestor, not just the parent: a folded `src/` has to know about a
    // file in `src/lib/db.ts` or its count understates what it is standing for,
    // which is the one number a fold exists to say.
    for (let at: string | null = dir; at !== null; at = parentOf(at)) {
      const held = building.get(at);
      if (!held) continue;
      held.subtreeFiles++;
      held.under.push(entry.payload);
    }
  }

  let maxDepth = 0;
  const dirs = new Map<string, PathDir<P, R>>();
  for (const dir of building.values()) {
    let depth = 0;
    for (let at = dir.parent; at !== null; at = parentOf(at)) depth++;
    dir.depth = depth;
    dir.children.sort();
    dir.files.sort(spec.compare);
    if (dir.files.length > 0 && depth > maxDepth) maxDepth = depth;
    dirs.set(dir.path, {
      ...spec.summarise(dir.under),
      path: dir.path,
      name: dir.name,
      parent: dir.parent,
      depth,
      files: dir.files,
      children: dir.children,
      subtreeFiles: dir.subtreeFiles,
    } as PathDir<P, R>);
  }

  const roots = ["", "/"].filter((root) => dirs.has(root));
  return { dirs, files, roots, maxDepth };
}

/* -------------------------------- the plan --------------------------------- */

export type PathNodeKind = "dir" | "file" | "folded";

/**
 * One thing the canvas draws.
 *
 * A `dir` is an anchor and a label: it is where its files hang, and it is not a
 * hub standing in for anything an edge does not mean. A `folded` is a whole
 * directory drawn as one node because the tree was over budget, and it carries
 * `files` so the surface can say how many are behind it. Nothing is ever
 * dropped, so `folded` is the only way a file goes undrawn and it is always
 * announced.
 */
export interface PathPlanNode<P extends object, R extends object> {
  /** Prefixed by kind: a directory and a file can share a path string. */
  id: string;
  kind: PathNodeKind;
  path: string;
  label: string;
  /** 1 for a file, the subtree count for a fold, 0 for a directory anchor. */
  files: number;
  file: PathFile<P> | null;
  dir: PathDir<P, R> | null;
}

/**
 * A drawn node's id, built in one place.
 *
 * A directory has two of them — `dir:p` open and `folded:p` closed — and the
 * transition between them happens on the click that opens it. Anything holding
 * an id across that click has to know which one it is about to become, and a
 * consumer spelling `` `dir:${path}` `` itself is how the surface ends up
 * clearing its own inspector on the one click that was supposed to explain
 * something. `planPathMap` builds every id through here and so does the canvas.
 */
export function nodeId(kind: PathNodeKind, path: string): string {
  return `${kind}:${path}`;
}

export interface PathPlan<P extends object, R extends object> {
  nodes: PathPlanNode<P, R>[];
  /** Containment, as indices into `nodes` — never an attribute, never causation. */
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
export function planPathMap<P extends object, R extends object>(
  tree: PathTree<P, R>,
  options: PlanOptions,
): PathPlan<P, R> {
  const expanded = withAncestors(options.expanded);
  const budget = Math.max(1, options.budget);

  let cutoff = 0;
  for (let candidate = tree.maxDepth; candidate >= 0; candidate--) {
    if (drawnFilesAt(tree, candidate, expanded) <= budget) {
      cutoff = candidate;
      break;
    }
  }

  const nodes: PathPlanNode<P, R>[] = [];
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
        id: nodeId("folded", path),
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
      id: nodeId("dir", path),
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
        id: nodeId("file", file.path),
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
function isFolded(
  dir: { path: string; parent: string | null; depth: number },
  cutoff: number,
  expanded: ReadonlySet<string>,
): boolean {
  if (dir.parent === null) return false;
  return dir.depth > cutoff && !expanded.has(dir.path);
}

/** Files that would be drawn at this cutoff. Counted, never laid out. */
function drawnFilesAt<P extends object, R extends object>(
  tree: PathTree<P, R>,
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
