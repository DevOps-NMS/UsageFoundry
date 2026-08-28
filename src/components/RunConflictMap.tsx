"use client";

import { PathMapCanvas, type MapPalette, type NodeAt } from "@/components/PathMapCanvas";
import type { ClashKind, ClashNode, ConflictPlan } from "@/lib/conflictMap";

/**
 * A pending merge's conflicts, drawn where they sit in the repository.
 *
 * Everything about the *arrangement* is `PathMapCanvas` — the simulation, the
 * fold transitions, the gestures, the framing, the labels — and everything about
 * what a node *means* is here, which is the split `RunTouchedMap` already holds
 * one map over.
 *
 * **The list on the land card is the primary route and stays it.** It is
 * ordered, it is readable, and it shows the actual `<<<<<<<` markers, which is
 * what an operator resolving a conflict needs; this is the second route, for the
 * one case the list reads worst — a conflict across many files in many
 * directories, where "which part of the tree is on fire" is a spatial question
 * an ordered list of paths cannot answer. The same thing the touched map is to
 * the Files tab's table.
 *
 * **Nothing here draws a resolution.** A clash count is what `merge-tree` found
 * in a merge nobody performed; no mark on this surface says any of it is hard,
 * or easy, or already dealt with.
 *
 * **A file nobody opened draws the floor and says so.** `land.ts` reads the
 * merged content of at most `MAX_CONTENT_FILES`, so a large conflict arrives
 * with a complete path list and a clash count for ten of them. A size is a claim
 * about how many clashes are in a file; over one nobody read there is no claim
 * to make, so it is drawn hollow and dashed at the smallest radius and the
 * legend beside it says the size is not a count.
 */

/**
 * What this encoding needs on top of `MAP_TOKENS`: three fills for the kinds git
 * names, and the hollow of a file whose content was never read. The fourth kind
 * — the one git named nothing for — takes `--fg-muted`, which the arrangement
 * already reads, because a grey is the only fill that claims nothing.
 */
const TOKENS = ["--accent", "--bg-inset", "--warn", "--danger"] as const;

type Palette = MapPalette<(typeof TOKENS)[number]>;

/** The smallest a file is drawn, and what a file with no readable count draws. */
const FLOOR = 4;

/**
 * A node's drawn radius, in world units.
 *
 * A file is its clash count on the touch map's damped curve over the same floor,
 * so one clash is still visibly a node and twenty do not swallow the directory
 * they sit in. **A null count draws the floor and nothing above it** — that is
 * the whole of the `regionsRead: false` rule as a number.
 *
 * A fold is its subtree *file* count, which is a figure that is always complete:
 * `pathMap` never drops a file, so a fold's size is the one thing on this
 * surface that cannot be understating what is behind it. It is deliberately not
 * the clash count, which for a fold holding unread files would be.
 */
export function radiusOf(node: ClashNode): number {
  if (node.kind === "file") {
    const clashes = node.file?.clashes;
    return clashes == null ? FLOOR : FLOOR + Math.sqrt(clashes) * 1.6;
  }
  if (node.kind === "folded") return 8 + Math.sqrt(node.files) * 2;
  return FLOOR;
}

/**
 * The fill a conflict's kind is drawn in.
 *
 * `content` and `modify/delete` must not read alike: one is two edits of the
 * same lines with markers to read, the other is a file one side deleted with no
 * markers anywhere. `untyped` takes the grey rather than the content colour,
 * because a type git did not give is an absence and drawing it as the commonest
 * case is this map inventing an annotation `parseMergeTree` declined to guess.
 */
const FILL: Record<ClashKind, "--fg-muted" | (typeof TOKENS)[number]> = {
  content: "--warn",
  "modify-delete": "--danger",
  other: "--accent",
  untyped: "--fg-muted",
};

/**
 * One file node: a disc in its kind's colour, hollow and dashed when the count
 * behind it was never read.
 *
 * Module scope rather than a `useCallback`, and that is the point of it having
 * no props: the canvas holds this in a ref and redraws whenever its identity
 * changes, so a fill that answered to nothing and was rebuilt every render would
 * be a frame per render. `RunTouchedMap`'s memoises because its ring answers to
 * `changedKnown`; nothing here answers to anything.
 */
function paintFile(
  ctx: CanvasRenderingContext2D,
  node: ClashNode,
  at: NodeAt,
  palette: Palette,
): void {
  const { x, y, radius, k } = at;
  const hue = palette[FILL[node.file?.kind ?? "untyped"]];

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);

  if (node.file?.regionsRead === false) {
    // Hollow and dashed: the kind is still git's, and the *count* is the thing
    // nobody has. A solid disc here would be a filled node at the floor radius,
    // which is exactly what one clash looks like — so the two states that must
    // never merge would have merged in the one place a reader would not check.
    ctx.fillStyle = palette["--bg-inset"];
    ctx.fill();
    ctx.setLineDash([3 / k, 2.5 / k]);
    ctx.lineWidth = 1.8 / k;
    ctx.strokeStyle = hue;
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  ctx.fillStyle = hue;
  ctx.fill();
}

export function RunConflictMap({
  plan,
  selectedId,
  onSelect,
  onExpand,
  className = "",
}: {
  plan: ConflictPlan;
  selectedId: string | null;
  /** The id to select, never the node — see `nodeId`: a fold changes id as it opens. */
  onSelect: (id: string | null) => void;
  onExpand: (dirPath: string) => void;
  className?: string;
}) {
  return (
    <PathMapCanvas
      plan={plan}
      tokens={TOKENS}
      radiusOf={radiusOf}
      paintFile={paintFile}
      ariaLabel="The files this merge could not reconcile, positioned by directory. The same files are listed in order, with their conflict markers, on the run's Land card."
      selectedId={selectedId}
      onSelect={onSelect}
      onExpand={onExpand}
      className={className}
    />
  );
}
