"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { WorkflowNodeKind } from "@/lib/apiTypes";
import {
  NODE_H,
  NODE_W,
  edgeGeometry,
  freeSpot,
  layoutBounds,
  linkKey,
  type BlockDraft,
  type LinkDraft,
  type Point,
} from "@/lib/canvasGraph";
import { Badge } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";

/**
 * The surface a workflow is drawn on.
 *
 * It owns the gestures and nothing else: where a block sits, what links what and
 * what is selected all live in `WorkflowEditor`, and every rule about what a
 * workflow may *be* lives on the server. This file decides only how a pointer
 * and a keyboard reach the same three actions — add a block, link two, remove a
 * link — because a canvas that needs a mouse excludes an operator, and this one
 * starts billed agents.
 *
 * Each of the three has both routes:
 *   add     — drag a block off the palette, or press Enter on it
 *   link    — drag from a block's Link handle onto another, or press Enter on
 *             the handle and then Enter on the target
 *   unlink  — Delete or Backspace on the link's own control, or Remove in the
 *             inspector beside the canvas
 *
 * Pointer and keyboard reach those through *different* events on the same
 * controls, and `handledByPointer` is what keeps them from both firing: a
 * captured pointer sequence still dispatches a `click` at the end, so the
 * keyboard's handler would add a second block or re-arm a link that had just
 * been drawn. The `click` handler stays because it is also what a screen reader
 * or voice control dispatches, with no pointer events in front of it.
 *
 * Nothing here animates position. A dragged block follows the pointer exactly,
 * which is why it is an inline `left`/`top` with no transition on it —
 * `ui-transition` deliberately omits `transform` and `width`, and a block that
 * eased into place would lag the hand holding it.
 */

export type CanvasSelection =
  | { kind: "block"; id: string }
  | { kind: "link"; from: string; to: string };

/** What a block of each kind is called, wherever one is named. */
export const KIND_LABEL: Record<WorkflowNodeKind, string> = {
  run: "Runs a task",
  orchestrator: "Decides what to run",
};

/**
 * The card's edge, per kind and per state, as one complete string each.
 *
 * The border colour and the elevation are decided together rather than half in
 * a shared string: two class strings setting one property under one variant
 * resolve by Tailwind's own sort order, which is not a contract.
 *
 * An orchestrator block wears the warn tint permanently, which is what the tint
 * is for — it starts runs with no approval, and that is a standing fact about
 * the block rather than a conditional alarm.
 */
const CARD_REST: Record<WorkflowNodeKind, string> = {
  run: "border-line shadow-e1",
  orchestrator: "border-warn-line shadow-e1",
};
const CARD_SELECTED = "border-accent shadow-e2";

type LinkTone = "chosen" | "unchosen" | "selected";

const LINK_STROKE: Record<LinkTone, string> = {
  chosen: "stroke-line-strong",
  unchosen: "stroke-warn",
  selected: "stroke-accent",
};
const LINK_FILL: Record<LinkTone, string> = {
  chosen: "fill-line-strong",
  unchosen: "fill-warn",
  selected: "fill-accent",
};
const LINK_CHIP: Record<LinkTone, string> = {
  chosen: "border-line-strong bg-surface text-ink-muted",
  unchosen: "border-warn-line bg-surface text-warn",
  selected: "border-accent bg-surface text-accent",
};

/** What the link's own control says. Never a default — see `LinkDraft`. */
const CONDITION_CHIP: Record<LinkDraft["edge"], string> = {
  "": "needs a condition",
  "on-success": "if it completes",
  "on-finish": "either way",
};

/** How far a block moves per arrow key, and per arrow key with Shift held. */
const STEP = 24;
const FINE_STEP = 8;

/** A pointer that travelled less than this was a click, not a drag. */
const DRAG_SLOP = 6;

/** The smallest surface, so an empty canvas is still a place to drop onto. */
const MIN_W = 640;
const MIN_H = 420;

interface DragState {
  id: string;
  /** Pointer offset within the block, so it does not jump to its own corner. */
  dx: number;
  dy: number;
  /** Still false at the release means it was a click on the card, not a drag. */
  moved: boolean;
}

interface PlaceState {
  kind: WorkflowNodeKind;
  /** Where the press began, so a click can be told from a drag. */
  originX: number;
  originY: number;
  /** Where it has been dragged to, or null while it is still a click. */
  at: Point | null;
}

export function WorkflowCanvas({
  blocks,
  links,
  positions,
  selection,
  full,
  onSelect,
  onMove,
  onAddBlock,
  onConnect,
  onRemoveLink,
}: {
  blocks: readonly BlockDraft[];
  links: readonly LinkDraft[];
  positions: ReadonlyMap<string, Point>;
  selection: CanvasSelection | null;
  /** The graph is at `MAX_WORKFLOW_NODES`, so nothing more may be added. */
  full: boolean;
  onSelect: (next: CanvasSelection | null) => void;
  onMove: (id: string, at: Point) => void;
  onAddBlock: (kind: WorkflowNodeKind, at: Point) => void;
  onConnect: (from: string, to: string) => void;
  onRemoveLink: (from: string, to: string) => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const handledByPointer = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [place, setPlace] = useState<PlaceState | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [pointerAt, setPointerAt] = useState<Point | null>(null);

  const bounds = layoutBounds(positions);
  const width = Math.max(bounds.width, MIN_W);
  const height = Math.max(bounds.height, MIN_H);

  const linkSource = blocks.find((b) => b.id === linkFrom);
  const linkOrigin = linkFrom === null ? undefined : positions.get(linkFrom);
  const linking = linkSource !== undefined && linkOrigin !== undefined;

  // A block that has gone takes the half-drawn link with it, or the next choice
  // lands an edge on something that is no longer there.
  useEffect(() => {
    if (linkFrom !== null && !blocks.some((b) => b.id === linkFrom)) {
      setLinkFrom(null);
    }
  }, [blocks, linkFrom]);

  const pointIn = useCallback((clientX: number, clientY: number): Point => {
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const overSheet = useCallback((clientX: number, clientY: number): boolean => {
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }, []);

  /** Which block is under a point, for a link dropped rather than clicked. */
  const blockAt = useCallback(
    (p: Point): string | null => {
      for (const block of blocks) {
        const at = positions.get(block.id);
        if (!at) continue;
        if (
          p.x >= at.x &&
          p.x <= at.x + NODE_W &&
          p.y >= at.y &&
          p.y <= at.y + NODE_H
        ) {
          return block.id;
        }
      }
      return null;
    },
    [blocks, positions],
  );

  /* ---------------------------------------------------------------- */
  /* Moving a block                                                    */
  /* ---------------------------------------------------------------- */

  function startDrag(event: ReactPointerEvent<HTMLDivElement>, id: string) {
    // The buttons on the card are the keyboard's whole route in; a press on one
    // has to reach it rather than being swallowed as the start of a drag.
    if ((event.target as HTMLElement).closest("button")) return;
    const at = positions.get(id);
    if (!at) return;
    const p = pointIn(event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, dx: p.x - at.x, dy: p.y - at.y, moved: false });
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const p = pointIn(event.clientX, event.clientY);
    const next = {
      x: Math.max(0, p.x - drag.dx),
      y: Math.max(0, p.y - drag.dy),
    };
    if (!drag.moved) {
      const at = positions.get(drag.id);
      const travelled = at
        ? Math.hypot(next.x - at.x, next.y - at.y)
        : DRAG_SLOP + 1;
      if (travelled <= DRAG_SLOP) return;
      setDrag({ ...drag, moved: true });
    }
    onMove(drag.id, next);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const { id, moved } = drag;
    setDrag(null);
    // A press that went nowhere is a click on the card, and the whole card is
    // the target: the name is a button because the keyboard needs one, not
    // because it is the only place worth aiming at.
    if (moved) return;
    if (chooseTarget(id)) return;
    onSelect({ kind: "block", id });
  }

  function nudge(id: string, dx: number, dy: number) {
    const at = positions.get(id);
    if (!at) return;
    onMove(id, { x: Math.max(0, at.x + dx), y: Math.max(0, at.y + dy) });
  }

  /* ---------------------------------------------------------------- */
  /* Adding a block                                                    */
  /* ---------------------------------------------------------------- */

  function addAtFreeSpot(kind: WorkflowNodeKind) {
    onAddBlock(kind, freeSpot(positions));
  }

  function startPlace(
    event: ReactPointerEvent<HTMLButtonElement>,
    kind: WorkflowNodeKind,
  ) {
    if (full) return;
    handledByPointer.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    setPlace({
      kind,
      originX: event.clientX,
      originY: event.clientY,
      at: null,
    });
  }

  function movePlace(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!place) return;
    const travelled = Math.hypot(
      event.clientX - place.originX,
      event.clientY - place.originY,
    );
    if (place.at === null && travelled <= DRAG_SLOP) return;
    setPlace({ ...place, at: pointIn(event.clientX, event.clientY) });
  }

  function endPlace(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!place) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const dropped = place.at;
    const kind = place.kind;
    const onCanvas = overSheet(event.clientX, event.clientY);
    setPlace(null);
    handledByPointer.current = true;
    // A press that never travelled is a click, and a click still adds the block
    // — a palette that appears to do nothing unless you think to drag is a
    // palette half the operators cannot use.
    if (dropped === null) {
      addAtFreeSpot(kind);
      return;
    }
    // Released away from the surface: nothing is added, and the ghost that was
    // following the pointer has already gone.
    if (!onCanvas) return;
    onAddBlock(kind, {
      x: Math.max(0, dropped.x - NODE_W / 2),
      y: Math.max(0, dropped.y - NODE_H / 2),
    });
  }

  /* ---------------------------------------------------------------- */
  /* Linking two blocks                                               */
  /* ---------------------------------------------------------------- */

  function startLink(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    handledByPointer.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    setLinkFrom(id);
    setPointerAt(null);
  }

  function moveLink(event: ReactPointerEvent<HTMLButtonElement>) {
    if (linkFrom === null) return;
    setPointerAt(pointIn(event.clientX, event.clientY));
  }

  function endLink(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPointerAt(null);
    // Set either way, before anything else: this pointer sequence has already
    // armed the mode at its `pointerdown`, and the `click` that follows would
    // otherwise reach `toggleLink` and disarm it again — a handle that appears
    // to do nothing when it is clicked rather than dragged.
    handledByPointer.current = true;
    // Read off this event rather than off the last move: they are at the same
    // place, and one of them is state that may not have flushed.
    const target = blockAt(pointIn(event.clientX, event.clientY));
    // Released on nothing, or back where it started: the mode stays armed, so
    // one handle answers a click as well as a drag and the keyboard route is
    // the same state rather than a second one.
    if (target === null || target === id) return;
    setLinkFrom(null);
    onConnect(id, target);
  }

  /** The keyboard's and assistive technology's route through the handle. */
  function toggleLink(id: string) {
    if (linkFrom === null) setLinkFrom(id);
    else if (linkFrom === id) setLinkFrom(null);
    else chooseTarget(id);
  }

  function chooseTarget(id: string): boolean {
    if (linkFrom === null || linkFrom === id) return false;
    onConnect(linkFrom, id);
    setLinkFrom(null);
    return true;
  }

  function claimedByPointer(): boolean {
    if (!handledByPointer.current) return false;
    handledByPointer.current = false;
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  function blockKeys(event: ReactKeyboardEvent<HTMLButtonElement>, id: string) {
    const step = event.shiftKey ? FINE_STEP : STEP;
    switch (event.key) {
      case "ArrowLeft":
        nudge(id, -step, 0);
        break;
      case "ArrowRight":
        nudge(id, step, 0);
        break;
      case "ArrowUp":
        nudge(id, 0, -step);
        break;
      case "ArrowDown":
        nudge(id, 0, step);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape" && linkFrom !== null) {
          setLinkFrom(null);
          event.stopPropagation();
        }
      }}
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1.5 text-xs font-medium text-ink-muted">Add</div>
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(KIND_LABEL) as WorkflowNodeKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                disabled={full}
                onPointerDown={(event) => startPlace(event, kind)}
                onPointerMove={movePlace}
                onPointerUp={endPlace}
                onPointerCancel={() => setPlace(null)}
                onClick={() => {
                  if (claimedByPointer()) return;
                  addAtFreeSpot(kind);
                }}
                className="ui-transition inline-flex min-h-[var(--control-h-lg)] cursor-grab
                  touch-none select-none items-center gap-2 rounded-sm border border-line-strong
                  bg-inset px-3 py-1.5 text-sm font-medium text-ink
                  focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
                  enabled:hover:border-ink-faint enabled:hover:bg-surface
                  enabled:active:shadow-press
                  disabled:cursor-not-allowed disabled:opacity-50"
              >
                {KIND_LABEL[kind]}
              </button>
            ))}
          </div>
          <Hint>
            {full
              ? "This workflow is full"
              : "Drag onto the canvas, or press Enter to place it"}
          </Hint>
        </div>

        <div className="text-xs tabular-nums text-ink-muted">
          {blocks.length} block{blocks.length === 1 ? "" : "s"} · {links.length}{" "}
          link{links.length === 1 ? "" : "s"}
        </div>
      </div>

      {linking && (
        <Notice tone="info" quiet>
          Linking from <strong>{label(linkSource)}</strong> — choose the block
          that starts after it. Escape cancels.
        </Notice>
      )}

      {/* The mode is a fact about the whole surface and a screen reader has no
          other way to learn it: the banner above is nowhere near the handle that
          was just pressed. */}
      <p className="sr-only" role="status" aria-live="polite">
        {linking
          ? `Linking from ${label(linkSource)}. Choose the block that starts after it, or press Escape.`
          : ""}
      </p>

      <div className="relative max-h-[70vh] overflow-auto rounded-sm border border-line bg-inset">
        <div
          ref={sheetRef}
          className="relative"
          style={{ width, height }}
          onPointerDown={(event) => {
            // A press on the surface itself rather than on a block: clear what
            // the inspector is showing, and drop out of link mode for anyone
            // who did not find Escape.
            if (event.target === event.currentTarget) {
              onSelect(null);
              setLinkFrom(null);
            }
          }}
        >
          {blocks.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Empty>
                <div className="font-medium text-ink">No blocks yet</div>
                <div className="mt-1">Drag one from Add, or press Enter on it</div>
              </Empty>
            </div>
          )}

          <svg
            className="pointer-events-none absolute left-0 top-0"
            width={width}
            height={height}
            aria-hidden
          >
            {links.map((link) => {
              const from = positions.get(link.from);
              const to = positions.get(link.to);
              if (!from || !to) return null;
              const geometry = edgeGeometry(from, to);
              const tone = linkTone(link, selection);
              return (
                <g key={linkKey(link)}>
                  <path
                    d={geometry.d}
                    fill="none"
                    strokeWidth={tone === "selected" ? 2.5 : 1.5}
                    className={LINK_STROKE[tone]}
                  />
                  <path
                    d={`M ${geometry.tip.x} ${geometry.tip.y} l -9 -5 l 0 10 z`}
                    className={LINK_FILL[tone]}
                  />
                </g>
              );
            })}

            {linking && pointerAt && (
              <path
                d={`M ${linkOrigin.x + NODE_W} ${linkOrigin.y + NODE_H / 2} L ${pointerAt.x} ${pointerAt.y}`}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray="5 4"
                className="stroke-accent"
              />
            )}
          </svg>

          {links.map((link) => {
            const from = positions.get(link.from);
            const to = positions.get(link.to);
            if (!from || !to) return null;
            const { mid } = edgeGeometry(from, to);
            const tone = linkTone(link, selection);
            const source = blocks.find((b) => b.id === link.from);
            const target = blocks.find((b) => b.id === link.to);
            return (
              <button
                key={linkKey(link)}
                type="button"
                onClick={() =>
                  onSelect({ kind: "link", from: link.from, to: link.to })
                }
                onKeyDown={(event) => {
                  if (event.key !== "Delete" && event.key !== "Backspace") return;
                  event.preventDefault();
                  onRemoveLink(link.from, link.to);
                }}
                aria-label={`${label(target)} starts after ${label(source)}, ${
                  CONDITION_CHIP[link.edge]
                }${link.continueBranch ? ", carries on its branch" : ""}. Delete removes this link.`}
                style={{ left: mid.x, top: mid.y }}
                className={`ui-transition absolute z-10 inline-flex min-h-[var(--control-h)]
                  -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center gap-1.5
                  whitespace-nowrap rounded-full border px-2.5 py-1 text-2xs font-semibold
                  hover:shadow-e1
                  focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
                  ${LINK_CHIP[tone]}`}
              >
                {CONDITION_CHIP[link.edge]}
                {link.continueBranch && <span className="text-accent">· branch</span>}
              </button>
            );
          })}

          {blocks.map((block) => {
            const at = positions.get(block.id);
            if (!at) return null;
            const selected =
              selection?.kind === "block" && selection.id === block.id;
            const armed = linkFrom === block.id;
            return (
              <div
                key={block.id}
                style={{ left: at.x, top: at.y, width: NODE_W, height: NODE_H }}
                className="absolute"
              >
                <div
                  onPointerDown={(event) => startDrag(event, block.id)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={`ui-transition flex h-full touch-none select-none flex-col
                    rounded-lg border bg-surface p-2.5 ${
                      drag?.id === block.id ? "cursor-grabbing" : "cursor-grab"
                    } ${selected ? CARD_SELECTED : CARD_REST[block.kind]}`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (chooseTarget(block.id)) return;
                      onSelect({ kind: "block", id: block.id });
                    }}
                    onKeyDown={(event) => blockKeys(event, block.id)}
                    aria-label={`${label(block)} — ${KIND_LABEL[block.kind]}${
                      linking && !armed ? ". Starts after " + label(linkSource) : ""
                    }`}
                    className="ui-transition -mx-1 mb-1 cursor-pointer rounded-sm border
                      border-transparent bg-transparent px-1 py-0.5 text-left text-sm
                      font-medium text-ink hover:bg-inset
                      focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <span className="block truncate">{label(block)}</span>
                  </button>

                  <div className="mono truncate text-ink-muted">
                    {block.mountId || "—"} / {block.folder || "."}
                  </div>
                  <div className="mt-0.5 flex-1 overflow-hidden text-xs leading-snug text-ink-faint">
                    <span className="line-clamp-2">
                      {block.task.trim() || "No task yet"}
                    </span>
                  </div>

                  <div className="mt-1 flex items-center justify-between gap-2">
                    {block.kind === "orchestrator" ? (
                      <Badge tone="warn">up to {block.fanOut || "?"}</Badge>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      onPointerDown={(event) => startLink(event, block.id)}
                      onPointerMove={moveLink}
                      onPointerUp={(event) => endLink(event, block.id)}
                      onPointerCancel={() => setPointerAt(null)}
                      onClick={() => {
                        if (claimedByPointer()) return;
                        toggleLink(block.id);
                      }}
                      aria-pressed={armed}
                      aria-label={
                        armed
                          ? `Cancel linking from ${label(block)}`
                          : linking
                            ? `Start ${label(block)} after ${label(linkSource)}`
                            : `Link from ${label(block)}`
                      }
                      className={`ui-transition inline-flex min-h-[var(--control-h)] cursor-pointer
                        touch-none items-center rounded-sm border px-2 py-1 text-2xs font-semibold
                        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
                        ${
                          armed
                            ? "border-accent bg-accent-dim text-ink"
                            : "border-line-strong bg-inset text-ink-muted hover:border-ink-faint hover:text-ink"
                        }`}
                    >
                      {armed ? "Cancel" : linking ? "Link here" : "Link"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {place?.at && (
            <div
              aria-hidden
              style={{
                left: place.at.x - NODE_W / 2,
                top: place.at.y - NODE_H / 2,
                width: NODE_W,
                height: NODE_H,
              }}
              className="pointer-events-none absolute rounded-lg border border-dashed border-accent bg-accent-dim/40"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** What a block is called on screen before it has been given a name. */
function label(block: { name: string; id: string } | undefined): string {
  if (!block) return "a block that is gone";
  return block.name.trim() || block.id;
}

function linkTone(link: LinkDraft, selection: CanvasSelection | null): LinkTone {
  if (
    selection?.kind === "link" &&
    selection.from === link.from &&
    selection.to === link.to
  ) {
    return "selected";
  }
  return link.edge === "" ? "unchosen" : "chosen";
}
