"use client";

import { useCallback } from "react";
import { PathMapCanvas, type MapPalette, type NodeAt } from "@/components/PathMapCanvas";
import type { MapPlan, PlanNode } from "@/lib/touchedMap";

/**
 * A run's touches, drawn where they sit in the repository.
 *
 * Everything about the *arrangement* is `PathMapCanvas` — the simulation, the
 * fold transitions, the gestures, the framing, the labels — and everything
 * about what a node *means* is here. The split is the same one `canvasView.ts`
 * holds one layer down: that module knows what a pixel is and never what is
 * drawn on it; the canvas above knows what a path hierarchy is and never which
 * fact about a file it is colouring.
 *
 * **Nothing here draws a success.** A recorded call is an *attempt*: this app
 * stores a tool result only when the tool failed, and the failure row carries no
 * id joining it back. So a fill says read, written or both — what the call asked
 * for — and no mark on this surface says any of it worked.
 *
 * **The changed mark is withheld when there is no diff.** With `changedKnown`
 * false the changed set is unknown rather than empty, and a ring meaning "the
 * branch changed this" over a file nobody can speak for is the reconciliation
 * asserting the thing it exists to check.
 */

/**
 * What this encoding needs on top of `MAP_TOKENS`, and nothing the arrangement
 * already reads: the write fill, the hollow of a file with no event behind it,
 * and the two rings.
 */
const TOKENS = ["--accent", "--bg-inset", "--warn", "--danger"] as const;

type Palette = MapPalette<(typeof TOKENS)[number]>;

/**
 * A node's drawn radius, in world units.
 *
 * A file is its call count, damped, over a floor — and the floor is why `calls`
 * is not the only thing a size may come from: a "changed, never named" file has
 * no calls at all, and a zero-radius node is a file silently missing from a
 * picture that promises never to drop one. A fold is its subtree count on the
 * same curve but a coarser one, because it is standing for a directory and has
 * to read as bigger than any single file in it.
 */
export function radiusOf(node: PlanNode): number {
  if (node.kind === "file") return 4 + Math.sqrt(node.file?.calls ?? 0) * 1.6;
  if (node.kind === "folded") return 8 + Math.sqrt(node.files) * 2;
  return 4;
}

/** The fill a file's read/write state is drawn in, and its core when it is both. */
function fillFor(node: PlanNode, palette: Palette): { disc: string; core: string | null } {
  switch (node.file?.state) {
    case "written":
      return { disc: palette["--accent"], core: null };
    case "both":
      // One disc with a core rather than a third colour: "read and written" is
      // literally the two marks, and a third hue would have to be learnt.
      return { disc: palette["--accent"], core: palette["--fg-muted"] };
    case "read":
      return { disc: palette["--fg-muted"], core: null };
    default:
      // `unnamed` — in the diff with no event behind it. Hollow, because the
      // thing it has is a path and the thing it lacks is a call.
      return { disc: palette["--bg-inset"], core: null };
  }
}

export function RunTouchedMap({
  plan,
  changedKnown,
  selectedId,
  onSelect,
  onExpand,
  className = "",
}: {
  plan: MapPlan;
  /** False with no diff: no node may draw the changed ring. */
  changedKnown: boolean;
  selectedId: string | null;
  /** The id to select, never the node — see `nodeId`: a fold changes id as it opens. */
  onSelect: (id: string | null) => void;
  onExpand: (dirPath: string) => void;
  className?: string;
}) {
  // Memoised on `changedKnown` alone, which is the one prop a fill answers to:
  // the canvas holds this in a ref so a frame never depends on it, and redraws
  // when its identity changes. A new function every render would be a frame per
  // render rather than a wrong picture, but the ring it draws is the whole point
  // of the prop, so the dependency has to be exactly this one.
  const paintFile = useCallback(
    (ctx: CanvasRenderingContext2D, node: PlanNode, at: NodeAt, palette: Palette) => {
      const { x, y, radius, k } = at;
      const { disc, core } = fillFor(node, palette);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = disc;
      ctx.fill();
      if (node.file?.state === "unnamed") {
        // Hollow, in danger: it is in the diff and no event names it, which is
        // the group a tool → file graph structurally cannot draw at all.
        ctx.lineWidth = 1.8 / k;
        ctx.strokeStyle = palette["--danger"];
        ctx.stroke();
      }
      if (core) {
        ctx.beginPath();
        ctx.arc(x, y, radius * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = core;
        ctx.fill();
      }
      // The reconciliation, as a ring outside the fill. `unnamed` is in the
      // diff by definition, so it is left to its own hollow rather than
      // carrying two rings that say the same thing.
      if (node.file?.outside) {
        ctx.setLineDash([3 / k, 2.5 / k]);
        ctx.lineWidth = 1.6 / k;
        ctx.strokeStyle = palette["--warn"];
        ctx.beginPath();
        ctx.arc(x, y, radius + 2.5 / k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (changedKnown && node.file?.inDiff && node.file.state !== "unnamed") {
        ctx.lineWidth = 1.8 / k;
        ctx.strokeStyle = palette["--fg"];
        ctx.beginPath();
        ctx.arc(x, y, radius + 2.5 / k, 0, Math.PI * 2);
        ctx.stroke();
      }
    },
    [changedKnown],
  );

  return (
    <PathMapCanvas
      plan={plan}
      tokens={TOKENS}
      radiusOf={radiusOf}
      paintFile={paintFile}
      ariaLabel="The files this run touched, positioned by directory. The same files are listed, ordered and searchable, in the table on the run's Files tab."
      selectedId={selectedId}
      onSelect={onSelect}
      onExpand={onExpand}
      className={className}
    />
  );
}
