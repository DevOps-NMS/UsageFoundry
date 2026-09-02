"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  boundsOf,
  canvasPoint,
  cssSize,
  fitView as fitViewTo,
  nearestWithin,
  observeCanvasSize,
  observeTheme,
  panBy,
  pixelRatio,
  probeFont,
  probeTokens,
  screenToWorld,
  visibleWorldRect,
  wheelZoomFactor,
  zoomAt,
  CLICK_SLOP,
  HIT_SLOP_PX,
  type View,
} from "@/lib/canvasView";
import {
  countDegrees,
  createSimulation,
  reheat,
  step,
  type SimEdge,
  type SimForces,
  type SimNode,
  type SimState,
} from "@/lib/forceLayout";
import { nodeId, type PathNodeKind, type PathPlan, type PathPlanNode } from "@/lib/pathMap";

/**
 * A `PathPlan`, drawn — the arrangement, and none of what a node means.
 *
 * The app's second `<canvas>`, and it answers none of the questions a canvas
 * asks: the transform, the cull rectangle, the framing, the nearest-within-reach
 * hit test, the pixel-ratio sizing and its observer, the wheel's `deltaMode` and
 * the colour probe all come from `canvasView.ts`, and the layout from
 * `forceLayout.ts`. What is here is everything that knows this is a *repository*
 * — and nothing that knows which repository fact is being drawn.
 *
 * That last split is the reason this is a component and not a copy: what a file
 * node's fill says, what rings it carries and which colour tokens those need are
 * a map's own vocabulary, so they arrive as `radiusOf`, `paintFile`, `tokens`
 * and `ariaLabel` rather than being decided here. A second map that pasted this
 * file to change four of those would also inherit every fold-transition bug
 * fixed below, silently, one copy at a time.
 *
 * **The edges are containment and never causation.** A line means "is in", so
 * the only thing a line asserts is a path. That is the whole reason the node set
 * is files: an attribute promoted to a node is a star, a dozen hubs with nearly
 * everything hanging off one of them, and it draws one fact. What a file *is*
 * rides on the node — its fill — and the rest is a line in an inspector.
 *
 * **A directory anchor is not a hub.** It is where its files hang and a label,
 * drawn as a small hollow ring so it reads as a place; nothing about a count, an
 * actor or an attribute is encoded on it.
 *
 * **The simulation must stop.** A settled layout still asking for frames is a
 * warm laptop on a page that looks finished, so the loop ends when `step`
 * returns false and only a gesture or a new plan starts it again.
 *
 * **Pointer-only, deliberately, and for `KnowledgeGraphCanvas`'s reason.** Every
 * file a map like this draws is also a row in a table that is ordered,
 * searchable and reachable; this is the second route to that content, not the
 * only one, so it stays a way of *looking* rather than growing a spatial
 * keyboard model nobody would find.
 */

/**
 * Fixed rather than offered as sliders, unlike the knowledge graph's.
 *
 * That surface's sliders exist because a vault's shape is the thing under
 * investigation and no single setting reads every vault. Here the shape is the
 * repository's, it is the same shape every time, and a control that changes it
 * would only make two operators' screenshots of one run disagree. The numbers
 * are the graph panel's defaults with a shorter spring: a directory's files sit
 * around it as a rosette rather than at arm's length.
 */
const FORCES: SimForces = { center: 0.4, repel: 10, link: 0.7, linkDistance: 70 };

/** How far off-screen a node still counts as drawable, in screen pixels. */
const CULL_MARGIN_PX = 140;

/** Screen pixels left around the map when it is framed to fit. */
const FIT_PAD = 48;

/** Frames a non-animated build may burn settling before it draws. */
const FREEZE_BUDGET = 300;

/** Scale at which file names begin to appear, and the range they ramp over. */
const FILE_LABEL_FROM = 0.75;
const FILE_LABEL_RAMP = 0.4;

/**
 * How much of itself a dimmed node keeps.
 *
 * Low enough that the undimmed nodes are what an eye lands on, and never zero:
 * a node drawn at no opacity is a node dropped, which is the one thing this
 * arrangement promises never to do. It stays on screen, in place, saying "not
 * this one" rather than "not here".
 */
const DIM_ALPHA = 0.18;

/**
 * The tokens the arrangement itself draws with: links, anchors, folds, labels
 * and the halo. A map's own encoding names whatever else it needs in `tokens`,
 * because the colours a fill picks are the one part of a node that is entirely
 * about what the node means.
 */
export const MAP_TOKENS = [
  "--fg",
  "--fg-muted",
  "--fg-faint",
  "--border",
  "--tint",
  "--bg-raised",
] as const;

export type MapPalette<T extends string = never> = Record<
  (typeof MAP_TOKENS)[number] | T,
  string
> & { font: string };

/** Where a node is and how big, in world units, at the scale it is drawn at. */
export interface NodeAt {
  x: number;
  y: number;
  radius: number;
  /**
   * The view's scale. Every stroke width and ring offset is divided by it, or a
   * hairline drawn at one zoom is a band at the next.
   */
  k: number;
}

/** One file node's fill and every ring it carries, drawn inside the world transform. */
export type PaintFile<P extends object, R extends object, T extends string> = (
  ctx: CanvasRenderingContext2D,
  node: PathPlanNode<P, R>,
  at: NodeAt,
  palette: MapPalette<T>,
) => void;

function probe<T extends string>(host: HTMLElement, tokens: readonly T[]): MapPalette<T> {
  return {
    ...probeTokens(host, [...MAP_TOKENS, ...tokens]),
    font: probeFont(host),
  };
}

/**
 * What a node *is*, across a fold opening or closing under it.
 *
 * A directory is one place in the repository and the surface draws it two ways:
 * `dir:p` when it is open and `folded:p` when it is not. Keying a carried
 * position or a drag pin on the drawn id means the one node that was certainly
 * on screen a moment ago — the fold the operator just clicked, or a sibling the
 * budget just closed — is the one the carry misses, and it lands back on the
 * seeding spiral at the world origin dragging its rosette with it. Both
 * transitions are reachable: opening a directory raises the drawn count, which
 * can drop the cutoff and fold a sibling that was open.
 */
function placeKey(item: { kind: PathNodeKind; path: string }): string {
  return item.kind === "file" ? `file:${item.path}` : `place:${item.path}`;
}

export function PathMapCanvas<P extends object, R extends object, T extends string>({
  plan,
  tokens,
  radiusOf,
  paintFile,
  ariaLabel,
  selectedId,
  dimmedIds = null,
  markedId = null,
  onSelect,
  onExpand,
  className = "",
}: {
  plan: PathPlan<P, R>;
  /** Colour tokens this map's own encoding reads, beyond `MAP_TOKENS`. */
  tokens: readonly T[];
  /** A node's drawn radius in world units — also what the hit test reaches by. */
  radiusOf: (node: PathPlanNode<P, R>) => number;
  paintFile: PaintFile<P, R, T>;
  /** What a screen reader is told the picture is, and where the same rows are listed. */
  ariaLabel: string;
  selectedId: string | null;
  /**
   * Nodes drawn washed out because the surface is currently looking at a subset
   * of the map. A drawing state over the arrangement, like `selectedId` and
   * unlike `paintFile` — this file does not know *why* a node is out of scope
   * and the caller's own legend is what says so.
   *
   * **Null and an empty set are different.** Null is "nothing is narrowed", and
   * the map is then pixel-identical to one that never had the prop; an empty set
   * is "narrowed to nothing", which dims none of them for a reason.
   */
  dimmedIds?: ReadonlySet<string> | null;
  /**
   * A second focus mark, drawn as a filled halo *behind* the node.
   *
   * Deliberately not a third ring: `selectedId` already strokes at
   * `radius + 6`, and a mark that a reader has to measure against it is a mark
   * that reads as the same thing. A fill and a hairline are told apart without
   * being learnt, so a node that is both shows a wash with a ring on it.
   */
  markedId?: string | null;
  /** The id to select, never the node — see `nodeId`: a fold changes id as it opens. */
  onSelect: (id: string | null) => void;
  onExpand: (dirPath: string) => void;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const simRef = useRef<SimState | null>(null);
  const metaRef = useRef<PathPlanNode<P, R>[]>([]);
  /** Where a drag left a node, kept across a re-plan that rebuilds the sim. */
  const pinsRef = useRef(new Map<string, { x: number; y: number }>());

  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const paletteRef = useRef<MapPalette<T> | null>(null);
  const hoverRef = useRef<number | null>(null);
  const dragRef = useRef<{ index: number | null; x: number; y: number; moved: number } | null>(
    null,
  );

  const frameRef = useRef(0);
  const fittedRef = useRef(false);
  const touchedRef = useRef(false);
  const animateRef = useRef(true);

  // Everything a frame reads goes through a ref rather than a closure: `draw`
  // has to be identity-stable, because `schedule` is built from it and every
  // effect below depends on `schedule`. A `draw` that changed on a prop would
  // tear the ResizeObserver down and rebuild the simulation because the operator
  // clicked a node — and the injected encoding is a prop like any other, so it
  // goes through a ref too rather than into `draw`'s dependency list.
  const radiusRef = useRef(radiusOf);
  const paintRef = useRef(paintFile);
  const tokensRef = useRef(tokens);
  const selectedRef = useRef(selectedId);
  const dimmedRef = useRef(dimmedIds);
  const markedRef = useRef(markedId);
  const selectRef = useRef(onSelect);
  const expandRef = useRef(onExpand);

  radiusRef.current = radiusOf;
  paintRef.current = paintFile;
  tokensRef.current = tokens;
  selectedRef.current = selectedId;
  dimmedRef.current = dimmedIds;
  markedRef.current = markedId;
  selectRef.current = onSelect;
  expandRef.current = onExpand;

  /* ------------------------------ drawing ------------------------------ */

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    const palette = paletteRef.current;
    if (!canvas || !sim || !palette) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = pixelRatio();
    const { width, height } = cssSize(canvas, dpr);
    const view = viewRef.current;
    const nodes = sim.nodes;
    const meta = metaRef.current;
    const hover = hoverRef.current;
    const selected = selectedRef.current;
    const dimmed = dimmedRef.current;
    const marked = markedRef.current;
    const radiusFor = radiusRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);

    const { left, top, right, bottom } = visibleWorldRect(view, width, height, CULL_MARGIN_PX);
    const visible = (x: number, y: number) => x >= left && x <= right && y >= top && y <= bottom;

    /* Containment, in one path and one stroke. A `stroke()` is a rasteriser
       dispatch, and one per edge spends the frame before a node is drawn. */
    const links = new Path2D();
    let drew = false;
    for (const edge of sim.edges) {
      const a = nodes[edge.source];
      const b = nodes[edge.target];
      if (!visible(a.x, a.y) && !visible(b.x, b.y)) continue;
      links.moveTo(a.x, a.y);
      links.lineTo(b.x, b.y);
      drew = true;
    }
    if (drew) {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = palette["--border"];
      ctx.lineWidth = 1 / view.k;
      ctx.stroke(links);
      ctx.globalAlpha = 1;
    }

    /* Nodes. */
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!visible(node.x, node.y)) continue;
      const item = meta[i];
      const radius = radiusFor(item);

      // The wash is composed onto whatever each branch below sets rather than
      // applied by them, so a branch that reaches for its own alpha — the fold's
      // 0.2 fill does — multiplies into it instead of resetting it. The injected
      // `paintFile` sets no alpha at all and so inherits this one, which is the
      // whole reason a caller does not have to know the prop exists.
      const base = dimmed !== null && dimmed.has(item.id) ? DIM_ALPHA : 1;
      ctx.globalAlpha = base;

      // Behind the node, so a fill the map's own encoding draws sits on top of
      // it rather than under it. Full opacity whatever the wash says: the mark
      // exists to be found, and a marked node is by construction one the
      // surface has reached.
      if (item.id === marked) {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = palette["--tint"];
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 7 / view.k, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = base;
      }

      if (item.kind === "dir") {
        // An anchor and a label, drawn as a small hollow ring so it reads as a
        // place rather than as a file. It is not a hub: nothing about a count,
        // an actor or an attribute is encoded on it.
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = palette["--bg-raised"];
        ctx.fill();
        ctx.lineWidth = 1.2 / view.k;
        ctx.strokeStyle = palette["--fg-faint"];
        ctx.stroke();
      } else if (item.kind === "folded") {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.globalAlpha = base * 0.2;
        ctx.fillStyle = palette["--fg-muted"];
        ctx.fill();
        ctx.globalAlpha = base;
        ctx.lineWidth = 1.6 / view.k;
        ctx.strokeStyle = palette["--fg-muted"];
        ctx.stroke();
      } else {
        // The map's own encoding, and the only place on this surface that knows
        // what a node means. It draws inside the world transform and leaves the
        // context as it found it — the halo below sets everything it uses.
        paintRef.current(ctx, item, { x: node.x, y: node.y, radius, k: view.k }, palette);
      }
      ctx.globalAlpha = 1;

      // Selection and hover share a halo well clear of every mark above, so
      // neither can be read as part of what the node says about its file. Not
      // `--accent-line`, which is a 40% accent / 60% border mix meant for
      // hairlines: at a ring's width against a canvas it is the same value as
      // the edges, and a selected node that does not read as selected is the
      // failure. `--tint` is what the other canvas rings its focus with.
      const isSelected = item.id === selected;
      if (isSelected || i === hover) {
        ctx.globalAlpha = isSelected ? 1 : 0.55;
        ctx.lineWidth = (isSelected ? 2 : 1.5) / view.k;
        ctx.strokeStyle = isSelected ? palette["--tint"] : palette["--fg-muted"];
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 6 / view.k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    /* Labels. A directory's name is the whole point of the arrangement, so it
       is always drawn; a file's is what would turn 39 nodes into 39 overlapping
       strings, so it ramps in with the zoom and appears at once on whatever the
       pointer is over. */
    const fade =
      view.k <= FILE_LABEL_FROM
        ? 0
        : Math.min(1, (view.k - FILE_LABEL_FROM) / FILE_LABEL_RAMP);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!visible(node.x, node.y)) continue;
      const item = meta[i];
      // The marked node forces its own name on for the reason hover and
      // selection do: a mark an operator has to zoom in to read is a mark they
      // have to hunt for, which is the thing it exists to save them.
      const forced = i === hover || item.id === selected || item.id === marked;
      const alpha = item.kind === "file" ? (forced ? 1 : fade) : 1;
      if (alpha <= 0) continue;

      const radius = radiusFor(item);
      // Composed rather than replaced, so a dimmed node's name dims with it —
      // a full-strength label over a washed node would read as the label of
      // whatever is behind it.
      ctx.globalAlpha =
        alpha * (dimmed !== null && dimmed.has(item.id) && !forced ? DIM_ALPHA : 1);
      ctx.fillStyle = item.kind === "file" ? palette["--fg"] : palette["--fg-muted"];
      ctx.font = `${(item.kind === "file" ? 11 : 12) / view.k}px ${palette.font}`;
      ctx.fillText(item.label, node.x, node.y + radius + 3 / view.k);
      if (item.kind === "folded") {
        ctx.font = `${10 / view.k}px ${palette.font}`;
        ctx.fillStyle = palette["--fg-faint"];
        ctx.fillText(
          `${item.files} file${item.files === 1 ? "" : "s"}`,
          node.x,
          node.y + radius + 16 / view.k,
        );
      }
    }

    ctx.globalAlpha = 1;
  }, []);

  /* ------------------------------ the loop ----------------------------- */

  const fitView = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;
    const bounds = boundsOf(sim.nodes);
    if (!bounds) return;
    const { width, height } = cssSize(canvas, pixelRatio());
    viewRef.current = fitViewTo(bounds, width, height, FIT_PAD);
  }, []);

  const tick = useCallback(() => {
    frameRef.current = 0;
    const sim = simRef.current;
    let hot = false;
    if (sim && animateRef.current) hot = step(sim, FORCES);
    // The first layout to go cold is framed: k = 1 on a settled map shows a
    // corner of it and nothing on a canvas says which way the rest is. Only the
    // first, and only while nobody has moved the view — refitting under an
    // operator who panned somewhere on purpose is worse than never fitting.
    if (!hot && !fittedRef.current && !touchedRef.current && sim && sim.nodes.length > 0) {
      fittedRef.current = true;
      fitView();
    }
    draw();
    if (hot) frameRef.current = requestAnimationFrame(tick);
  }, [draw, fitView]);

  const schedule = useCallback(() => {
    if (frameRef.current === 0) frameRef.current = requestAnimationFrame(tick);
  }, [tick]);

  /* ------------------------------ the size ----------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    // Sizing clears the surface, so every resize is followed by a draw — which
    // is what `schedule` is doing as the callback rather than after the call.
    return observeCanvasSize(host, canvas, schedule);
  }, [schedule]);

  /* ---------------------------- the palette ---------------------------- */

  // Keyed on the tokens' *text* rather than the array's identity: a caller that
  // spells its list inline would otherwise tear the theme observer down and
  // re-probe on every render, which is a cost nothing on screen would report.
  const tokenKey = tokens.join(" ");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reread = () => {
      paletteRef.current = probe(host, tokensRef.current);
      schedule();
    };
    reread();
    return observeTheme(reread);
  }, [tokenKey, schedule]);

  /* ---------------------------- reduced motion -------------------------- */

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      animateRef.current = !motion.matches;
    };
    apply();
    motion.addEventListener("change", apply);
    return () => motion.removeEventListener("change", apply);
  }, []);

  /* ------------------------------ the plan ----------------------------- */

  useEffect(() => {
    // Where each *place* was, rather than where each drawn id was, so a
    // directory that changed which way it is drawn keeps the position it had.
    const previous = simRef.current;
    const previousMeta = metaRef.current;
    const wasAt = new Map<string, { x: number; y: number }>();
    if (previous) {
      for (let i = 0; i < previous.nodes.length; i++) {
        const item = previousMeta[i];
        if (item) wasAt.set(placeKey(item), { x: previous.nodes[i].x, y: previous.nodes[i].y });
      }
    }

    const carry = new Map<string, { x: number; y: number }>();
    for (const item of plan.nodes) {
      const at = wasAt.get(placeKey(item));
      if (at) carry.set(item.id, at);
    }

    // The files a fold was standing for have no previous position at all.
    // Seeded by `seedPositions` they start on a spiral around the world origin
    // and fly in from wherever that is; started beside the directory that just
    // opened, the expansion reads as an unfolding. The golden-angle offset is
    // what keeps two of them off the same point, which is a zero distance the
    // repulsion step would have to nudge apart. Walk order is parent-first, so a
    // directory's own position is in `carry` before its children ask for it.
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    const spread = FORCES.linkDistance * 0.5;
    for (let i = 0; i < plan.edges.length; i++) {
      const child = plan.nodes[plan.edges[i].source];
      const parent = plan.nodes[plan.edges[i].target];
      if (!child || !parent || carry.has(child.id)) continue;
      const at = carry.get(parent.id);
      if (!at) continue;
      carry.set(child.id, {
        x: at.x + spread * Math.cos(i * GOLDEN),
        y: at.y + spread * Math.sin(i * GOLDEN),
      });
    }

    // Last, so a node the operator put somewhere on purpose outranks both.
    for (const item of plan.nodes) {
      const pin = pinsRef.current.get(placeKey(item));
      if (pin) carry.set(item.id, pin);
    }

    const simNodes: SimNode[] = plan.nodes.map((item) => ({
      id: item.id,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
      degree: 0,
    }));
    const simEdges: SimEdge[] = plan.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
    }));

    const sim = createSimulation(simNodes, simEdges, carry);
    countDegrees(sim.nodes, sim.edges);
    for (let i = 0; i < sim.nodes.length; i++) {
      const pin = pinsRef.current.get(placeKey(plan.nodes[i]));
      if (pin) {
        sim.nodes[i].fx = pin.x;
        sim.nodes[i].fy = pin.y;
      }
    }

    simRef.current = sim;
    metaRef.current = plan.nodes;
    hoverRef.current = null;

    if (!animateRef.current) {
      for (let i = 0; i < FREEZE_BUDGET && step(sim, FORCES); i++) {
        /* settle where nobody has to watch it happen */
      }
    }
    schedule();
  }, [plan, schedule]);

  /* None of these moves a node, so none of them reheats. `paintFile` is in the
     list because it is where a prop like the touched map's `changedKnown` ends
     up: a fill that answers to it changes identity, and nothing else would ask
     for the frame that draws the new answer. `dimmedIds` and `markedId` are the
     same case at a much higher rate — a playhead advancing is a new set and a
     new id every step, and this effect is the only thing that draws them. */
  useEffect(() => {
    schedule();
  }, [selectedId, dimmedIds, markedId, radiusOf, paintFile, schedule]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    },
    [],
  );

  /* --------------------------- the gestures ---------------------------- */

  const toWorld = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const point = canvasPoint(canvas.getBoundingClientRect(), event.clientX, event.clientY);
    return screenToWorld(viewRef.current, point.x, point.y);
  }, []);

  /* Nearest wins over first, which is the shared module's rule. What a radius
     *means* is the map's, so it reaches in as `reachOf` rather than as an
     import: here it is whatever `radiusOf` was handed. */
  const nodeAt = useCallback((wx: number, wy: number): number | null => {
    const sim = simRef.current;
    if (!sim) return null;
    const meta = metaRef.current;
    return nearestWithin(
      sim.nodes,
      wx,
      wy,
      (_point, i) => radiusRef.current(meta[i]) + HIT_SLOP_PX / viewRef.current.k,
    );
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const world = toWorld(event);
    dragRef.current = {
      index: nodeAt(world.x, world.y),
      x: event.clientX,
      y: event.clientY,
      moved: 0,
    };
    const sim = simRef.current;
    const grabbed = dragRef.current.index;
    if (sim && grabbed !== null) {
      sim.nodes[grabbed].fx = sim.nodes[grabbed].x;
      sim.nodes[grabbed].fy = sim.nodes[grabbed].y;
      reheat(sim, 0.3);
      schedule();
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    const sim = simRef.current;
    const view = viewRef.current;

    if (!drag) {
      const world = toWorld(event);
      const over = nodeAt(world.x, world.y);
      if (over !== hoverRef.current) {
        hoverRef.current = over;
        // The cursor is the only thing that says a node can be clicked: a canvas
        // has no <a> for the browser to report.
        event.currentTarget.style.cursor = over === null ? "grab" : "pointer";
        schedule();
      }
      return;
    }

    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = event.clientX;
    drag.y = event.clientY;

    if (drag.index === null) {
      touchedRef.current = true;
      viewRef.current = panBy(view, dx, dy);
    } else if (sim) {
      const node = sim.nodes[drag.index];
      node.fx = (node.fx ?? node.x) + dx / view.k;
      node.fy = (node.fy ?? node.y) + dy / view.k;
      // The position too, and not only the pin. `step` is what copies a pin onto
      // a position, and under `prefers-reduced-motion` it is never called from
      // the loop — so a drag would move nothing at all on screen while still
      // recording where it went, and the node would jump there later when
      // something else forced a settle. This is exactly what `step` does with a
      // pinned node, so it is the same arithmetic either way.
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
      reheat(sim, 0.3);
    }
    schedule();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    // `pointercancel` reaches here with the capture already gone, and releasing
    // one that is not held throws.
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const sim = simRef.current;
    const dragged = drag.index === null ? null : metaRef.current[drag.index];
    if (sim && drag.index !== null && dragged) {
      const node = sim.nodes[drag.index];
      // Dropped is where it stays: a node that sprang back would make a drag a
      // way of disturbing the arrangement rather than of making one. Keyed on
      // the place rather than the drawn id, so a directory dragged while folded
      // is still there once it is opened.
      if (node.fx !== null && node.fy !== null) {
        pinsRef.current.set(placeKey(dragged), { x: node.fx, y: node.fy });
      }
    }

    if (drag.moved <= CLICK_SLOP) {
      // A fold opens on the click that would otherwise only select it: it is the
      // one node on this surface standing for something the operator cannot
      // otherwise reach, and the inspector says what it is either way.
      //
      // Selected by the id it is *about to have*, not the one it has. Opening
      // replaces `folded:p` with `dir:p`, and the page looks the selection up by
      // id — so selecting the fold clears the inspector on the very click that
      // was supposed to explain what had just unfolded.
      if (dragged?.kind === "folded") {
        expandRef.current(dragged.path);
        selectRef.current(nodeId("dir", dragged.path));
      } else {
        selectRef.current(dragged?.id ?? null);
      }
    }
    schedule();
  }

  function onPointerLeave() {
    if (hoverRef.current !== null) {
      hoverRef.current = null;
      schedule();
    }
  }

  /* The wheel is a native listener and not an `onWheel` prop, and that is a
     correctness decision: React registers `wheel` at the root as a **passive**
     listener, so `preventDefault()` from a synthetic handler is discarded
     silently — the zoom happens *and* the page scrolls out from under it. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      touchedRef.current = true;
      const rect = canvas.getBoundingClientRect();
      const { x: px, y: py } = canvasPoint(rect, event.clientX, event.clientY);
      viewRef.current = zoomAt(
        viewRef.current,
        px,
        py,
        wheelZoomFactor(event.deltaY, event.deltaMode, rect.height),
      );
      schedule();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [schedule]);

  /* The spiral is centred on the origin and a canvas's origin is its top-left
     corner, so an uncentred map opens as a quarter of itself. Once, on mount. */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    viewRef.current = { x: rect.width / 2, y: rect.height / 2, k: 1 };
  }, []);

  return (
    <div ref={hostRef} className={`relative overflow-hidden ${className}`}>
      <canvas
        ref={canvasRef}
        // `touch-none` or the browser takes the drag for a scroll and the canvas
        // never sees a pointermove.
        //
        // Out of flow, and that is load-bearing rather than tidy: the resize
        // observer writes the host's measured height back onto this element as
        // an inline `style.height`, so an in-flow canvas is a child holding up
        // whatever the host was last time — which ratchets against a host whose
        // box can shrink, silently, because every measurement is correct.
        className="absolute inset-0 block h-full w-full touch-none select-none"
        role="img"
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      />
    </div>
  );
}
