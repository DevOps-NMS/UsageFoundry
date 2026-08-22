"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { KnowledgeNodeDTO } from "@/lib/apiTypes";
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
import {
  groupIndexFor,
  parseGraphQuery,
  type GraphDisplay,
  type GraphGroup,
  type GraphSlice,
} from "@/lib/knowledgeGraph";

/**
 * The vault's link graph, drawn.
 *
 * This is the app's first `<canvas>`, so nothing above it settles the questions
 * a canvas asks and they are answered here rather than assumed:
 *
 * **Colour cannot be read from a variable.** Every token in `globals.css` is a
 * `light-dark()` or a `color-mix()`, no `@property` registers any of them, and
 * `getComputedStyle(root).getPropertyValue("--ink")` therefore returns the
 * literal source text — which is not a value `ctx.fillStyle` accepts. The only
 * thing that resolves one is an element: set `color` to `var(--token)` on a real
 * node and read the *computed* `color` back as `rgb(…)`. That is what `probe`
 * does, and it has to run again whenever the answer could change — on an
 * explicit theme switch, which `ThemeToggle` makes by setting `data-theme` on
 * `<html>`, and on an OS scheme flip while the app is following the system.
 *
 * **The simulation must stop.** A settled graph that kept asking for frames is a
 * warm laptop on a page that looks finished, so the loop ends when `step`
 * returns false and only an interaction or a changed setting starts it again.
 *
 * **The pointer is the only input here that has no keyboard route, and that is
 * deliberate.** Panning and zooming a force layout is a way of *looking*; every
 * note this can open is also a row in the list above it, which is reachable,
 * ordered and searchable. A graph is the second route to that content, not the
 * only one, so it stays a pointer surface rather than growing a spatial
 * keyboard model nobody would find.
 */

/** World units per screen pixel, at the ends the wheel is clamped to. */
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;

/** How far a pointer may travel between down and up and still count as a click. */
const CLICK_SLOP = 4;

/**
 * Pixels one line of `deltaMode: DOM_DELTA_LINE` is taken to be worth.
 *
 * Firefox reports a mouse wheel in lines and the other engines report pixels,
 * and the two differ by about two orders of magnitude — so the same notch that
 * zooms in Chrome moves this by a factor of 1.005 there, which reads as broken
 * rather than absent. The browser will not say what a line is worth, and this
 * is an estimate rather than a measurement: a rough line box at this app's
 * 13px body, chosen so one notch travels about the same distance in both.
 * Nobody has held the two side by side; a Firefox mouse is what would settle it.
 */
const LINE_HEIGHT_PX = 16;

/** Zoom range over which a label ramps from invisible to solid. */
const LABEL_RAMP = 0.35;

/**
 * Frames a non-animated build is allowed to burn settling before it draws.
 *
 * The layout is synchronous, so this is a freeze the operator sits through.
 * 300 frames is most of the way down the cooling curve and about a third of a
 * second at the real vault's size — long enough to be seen, short enough not to
 * read as a hang, and only ever paid when animation is off.
 */
const FREEZE_BUDGET = 300;

const TOKENS = [
  "--fg",
  "--fg-muted",
  "--fg-faint",
  "--border",
  "--accent",
  "--tint",
  "--bg-raised",
] as const;

type Palette = Record<(typeof TOKENS)[number], string> & { font: string };

/**
 * Resolve the theme's colours to something a 2D context accepts.
 *
 * One throwaway element rather than one per token: the read is what costs, and
 * it happens on mount and on a theme change, never in a frame.
 */
function probe(host: HTMLElement): Palette {
  const el = document.createElement("span");
  el.style.position = "absolute";
  el.style.width = "0";
  el.style.height = "0";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  host.appendChild(el);
  const out = { font: "" } as Palette;
  for (const token of TOKENS) {
    el.style.color = `var(${token})`;
    out[token] = getComputedStyle(el).color;
  }
  // The graph's labels are the app's type, not the canvas default — which is
  // 10px sans-serif and reads as a different program.
  out.font = getComputedStyle(host).fontFamily || "system-ui, sans-serif";
  el.remove();
  return out;
}

/** A node's drawn radius: its degree, damped, times the operator's multiplier. */
function radiusOf(node: SimNode, nodeSize: number): number {
  return (2.5 + Math.sqrt(node.degree) * 1.7) * nodeSize;
}

interface View {
  x: number;
  y: number;
  k: number;
}

export function KnowledgeGraphCanvas({
  graph,
  focusId,
  groups,
  display,
  forces,
  onOpenNote,
  className = "",
}: {
  /** Already filtered and capped: this draws what it is given, whole. */
  graph: GraphSlice;
  /** The note open in the reader, ringed so it can be found again. */
  focusId: string | null;
  groups: readonly GraphGroup[];
  display: GraphDisplay;
  forces: SimForces;
  onOpenNote: (path: string) => void;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const simRef = useRef<SimState | null>(null);
  const metaRef = useRef<KnowledgeNodeDTO[]>([]);
  const groupOfRef = useRef<Int8Array>(new Int8Array(0));
  /** Neighbours by index, for the hover highlight. Rebuilt with the graph. */
  const neighboursRef = useRef<Set<number>[]>([]);
  /** Where a drag left a node, kept across a filter change that rebuilds the sim. */
  const pinsRef = useRef(new Map<string, { x: number; y: number }>());

  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const paletteRef = useRef<Palette | null>(null);
  const hoverRef = useRef<number | null>(null);
  const dragRef = useRef<{ index: number | null; x: number; y: number; moved: number } | null>(null);

  const frameRef = useRef(0);
  /** One automatic framing per mount, and only while the view is untouched. */
  const fittedRef = useRef(false);
  const touchedRef = useRef(false);
  /** Reduced motion, or the operator's own switch: either one freezes the build. */
  const animateRef = useRef(display.animate);
  // Everything a frame reads goes through a ref rather than a closure. `draw`
  // has to be identity-stable — it is what `schedule` is built from, and every
  // effect below depends on `schedule`, so a `draw` that changed on a prop
  // would tear down the ResizeObserver and rebuild the simulation because the
  // operator moved a colour swatch.
  const forcesRef = useRef(forces);
  const displayRef = useRef(display);
  const focusRef = useRef(focusId);
  const openRef = useRef(onOpenNote);
  const groupsRef = useRef(groups);

  forcesRef.current = forces;
  displayRef.current = display;
  focusRef.current = focusId;
  openRef.current = onOpenNote;
  groupsRef.current = groups;

  /* ------------------------------ drawing ------------------------------ */

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    const palette = paletteRef.current;
    if (!canvas || !sim || !palette) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const view = viewRef.current;
    const { arrows, textFade, nodeSize, linkThickness } = displayRef.current;
    const nodes = sim.nodes;
    const meta = metaRef.current;
    const hover = hoverRef.current;
    const lit = hover === null ? null : neighboursRef.current[hover];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);

    // The world rectangle the canvas is currently showing, with a margin wide
    // enough that a node just off the edge still draws the link coming in.
    // Culling is where the frame rate at a zoomed-in vault comes from: the cost
    // of a graph is the drawing, not the arithmetic, and most of a zoomed-in
    // graph is not on the screen.
    const margin = 120 / view.k;
    const left = -view.x / view.k - margin;
    const top = -view.y / view.k - margin;
    const right = left + width / view.k + margin * 2;
    const bottom = top + height / view.k + margin * 2;
    const visible = (x: number, y: number) => x >= left && x <= right && y >= top && y <= bottom;

    /* Links first, so a node is never drawn under one of its own edges.
       Every link that survives the cull goes into one of two paths, and each
       path is stroked once. This vault has ~16k edges among 785 notes, and a
       `stroke()` is a rasteriser dispatch: one per edge spends the whole frame
       budget before a node is drawn. Two paths is all it takes because a link
       has exactly two appearances — inside the hovered neighbourhood or dimmed
       out of it — so nothing interleaves and the draw order stays dim-then-lit.

       The visible consequence is that overlapping links no longer composite
       against each other, since a path is stroked as one region. A hairball
       reads as one translucent mass rather than saturating to solid, which is
       the more honest picture of it. */
    ctx.lineCap = "round";
    const dimPath = new Path2D();
    const litPath = new Path2D();
    const dimHeads = arrows ? new Path2D() : null;
    const litHeads = arrows ? new Path2D() : null;
    let dimCount = 0;
    let litCount = 0;
    for (const edge of sim.edges) {
      const a = nodes[edge.source];
      const b = nodes[edge.target];
      if (a === b) continue;
      if (!visible(a.x, a.y) && !visible(b.x, b.y)) continue;
      const involved = hover === null || edge.source === hover || edge.target === hover;
      const path = involved ? litPath : dimPath;
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
      if (involved) litCount++;
      else dimCount++;
      if (arrows) {
        arrowInto(
          involved ? (litHeads as Path2D) : (dimHeads as Path2D),
          a,
          b,
          radiusOf(b, nodeSize),
          linkThickness / view.k,
        );
      }
    }
    if (dimCount > 0) {
      ctx.globalAlpha = 0.08;
      ctx.strokeStyle = palette["--border"];
      ctx.fillStyle = palette["--border"];
      ctx.lineWidth = linkThickness / view.k;
      ctx.stroke(dimPath);
      if (dimHeads) ctx.fill(dimHeads);
    }
    if (litCount > 0) {
      const stroke = hover === null ? palette["--border"] : palette["--accent"];
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = stroke;
      ctx.fillStyle = stroke;
      ctx.lineWidth = ((hover === null ? 1 : 1.6) * linkThickness) / view.k;
      ctx.stroke(litPath);
      if (litHeads) ctx.fill(litHeads);
    }

    /* Nodes. */
    const groups = groupsRef.current;
    const groupOf = groupOfRef.current;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!visible(node.x, node.y)) continue;
      const dimmed = lit !== null && i !== hover && !lit.has(i);
      ctx.globalAlpha = dimmed ? 0.15 : 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radiusOf(node, nodeSize), 0, Math.PI * 2);
      const group = groupOf[i];
      ctx.fillStyle =
        group >= 0
          ? groups[group].color
          : i === hover
            ? palette["--accent"]
            : colourFor(meta[i], palette);
      ctx.fill();
      // A phantom is a link nobody has written the note for yet, so it is drawn
      // hollow: the same position in the graph, visibly not a file.
      if (meta[i].kind === "phantom") {
        ctx.lineWidth = 1.2 / view.k;
        ctx.strokeStyle = palette["--bg-raised"];
        ctx.stroke();
      }
      if (meta[i].id === focusRef.current) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = palette["--tint"];
        ctx.beginPath();
        ctx.arc(node.x, node.y, radiusOf(node, nodeSize) + 3 / view.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    /* Labels last and only where they can be read. The ramp is what stops the
       whole vault's titles appearing between one wheel notch and the next. */
    const fade = view.k <= textFade ? 0 : Math.min(1, (view.k - textFade) / LABEL_RAMP);
    if (fade > 0) {
      ctx.font = `${11 / view.k}px ${palette.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = palette["--fg"];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!visible(node.x, node.y)) continue;
        const dimmed = lit !== null && i !== hover && !lit.has(i);
        ctx.globalAlpha = dimmed ? 0.1 * fade : fade;
        ctx.fillText(meta[i].title, node.x, node.y + radiusOf(node, nodeSize) + 3 / view.k);
      }
    }

    ctx.globalAlpha = 1;
  }, []);

  /* ------------------------------ the loop ----------------------------- */

  /** Frame the whole graph. Cheap enough to be exact rather than incremental. */
  const fitView = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim || sim.nodes.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of sim.nodes) {
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x > maxX) maxX = node.x;
      if (node.y > maxY) maxY = node.y;
    }
    const pad = 40;
    const k = Math.min(
      ZOOM_MAX,
      Math.max(
        ZOOM_MIN,
        Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY)),
      ),
    );
    viewRef.current = {
      k,
      x: width / 2 - ((minX + maxX) / 2) * k,
      y: height / 2 - ((minY + maxY) / 2) * k,
    };
  }, []);

  const tick = useCallback(() => {
    frameRef.current = 0;
    const sim = simRef.current;
    let hot = false;
    if (sim && animateRef.current) hot = step(sim, forcesRef.current);
    // The first layout to go cold is framed, because k = 1 on a settled vault
    // shows about a quarter of it and nothing on a canvas says which way the
    // rest is. Only the first, and only if nobody has moved the view yet:
    // refitting under an operator who panned somewhere on purpose is worse
    // than never fitting at all.
    if (!hot && !fittedRef.current && !touchedRef.current && sim && sim.nodes.length > 0) {
      fittedRef.current = true;
      fitView();
    }
    draw();
    // Only a hot simulation keeps the loop alive. Everything else — a hover, a
    // pan, a slider — asks for exactly one more frame through `schedule`.
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

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = host.getBoundingClientRect();
      // The backing store is in device pixels and the element is in CSS ones.
      // Setting either without the other is the whole of why a canvas looks
      // soft on a retina display, and it also clears the surface — so a resize
      // is always followed by a draw.
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      schedule();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [schedule]);

  /* ---------------------------- the palette ---------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reread = () => {
      paletteRef.current = probe(host);
      schedule();
    };
    reread();

    // Two boundaries, and each one is a way the answer changes without this
    // component rendering. `data-theme` is what ThemeToggle sets; the media
    // query is the OS flipping underneath "Match system", which sets nothing.
    const attribute = new MutationObserver(reread);
    attribute.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", reread);
    return () => {
      attribute.disconnect();
      scheme.removeEventListener("change", reread);
    };
  }, [schedule]);

  /* ---------------------------- reduced motion -------------------------- */

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      animateRef.current = display.animate && !motion.matches;
    };
    apply();
    motion.addEventListener("change", apply);
    return () => motion.removeEventListener("change", apply);
  }, [display.animate]);

  /* ----------------------------- the graph ----------------------------- */

  useEffect(() => {
    const previous = simRef.current;
    const carry = new Map<string, { x: number; y: number }>();
    if (previous) for (const node of previous.nodes) carry.set(node.id, { x: node.x, y: node.y });
    for (const [id, at] of pinsRef.current) carry.set(id, at);

    const index = new Map<string, number>();
    const simNodes: SimNode[] = graph.nodes.map((dto, i) => {
      index.set(dto.id, i);
      return { id: dto.id, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, degree: 0 };
    });

    const simEdges: SimEdge[] = [];
    const neighbours: Set<number>[] = simNodes.map(() => new Set<number>());
    for (const edge of graph.edges) {
      const source = index.get(edge.from);
      const target = index.get(edge.to);
      if (source === undefined || target === undefined || source === target) continue;
      simEdges.push({ source, target });
      neighbours[source].add(target);
      neighbours[target].add(source);
    }

    const sim = createSimulation(simNodes, simEdges, carry);
    countDegrees(sim.nodes, sim.edges);
    for (const node of sim.nodes) {
      const pin = pinsRef.current.get(node.id);
      if (pin) {
        node.fx = pin.x;
        node.fy = pin.y;
      }
    }

    simRef.current = sim;
    metaRef.current = graph.nodes;
    neighboursRef.current = neighbours;
    hoverRef.current = null;

    if (!animateRef.current) {
      for (let i = 0; i < FREEZE_BUDGET && step(sim, forcesRef.current); i++) {
        /* settle where nobody has to watch it happen */
      }
    }
    schedule();
  }, [graph, schedule]);

  /* The colour groups, resolved once per graph rather than once per frame: the
     first matching group wins, which is the whole meaning of their order. Its
     own effect because changing a colour must not rebuild the simulation. */
  useEffect(() => {
    const compiled = groups.map((group) => parseGraphQuery(group.query));
    const groupOf = new Int8Array(graph.nodes.length);
    for (let i = 0; i < graph.nodes.length; i++) {
      groupOf[i] = groupIndexFor(graph.nodes[i], compiled);
    }
    groupOfRef.current = groupOf;
    schedule();
  }, [graph, groups, schedule]);

  /* A force moved: the layout the operator is looking at is no longer the one
     the sliders describe, so it has to be given the heat to find the new one. */
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    reheat(sim);
    if (!animateRef.current) {
      for (let i = 0; i < FREEZE_BUDGET && step(sim, forcesRef.current); i++) {
        /* as above */
      }
    }
    schedule();
  }, [forces, schedule]);

  /* Display settings change nothing about where a node is, only how it looks. */
  useEffect(() => {
    schedule();
  }, [display, focusId, schedule]);

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
    const view = viewRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - view.x) / view.k,
      y: (event.clientY - rect.top - view.y) / view.k,
    };
  }, []);

  const nodeAt = useCallback((wx: number, wy: number): number | null => {
    const sim = simRef.current;
    if (!sim) return null;
    const size = displayRef.current.nodeSize;
    // Nearest wins, not first: two nodes overlap often enough at low zoom that
    // taking the first hit would open whichever the vault happened to list
    // earlier, which is not a thing the operator can see or predict.
    let best: number | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < sim.nodes.length; i++) {
      const node = sim.nodes[i];
      const reach = radiusOf(node, size) + 4 / viewRef.current.k;
      const distance = Math.hypot(node.x - wx, node.y - wy);
      if (distance <= reach && distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    return best;
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const world = toWorld(event);
    dragRef.current = { index: nodeAt(world.x, world.y), x: event.clientX, y: event.clientY, moved: 0 };
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
        // The cursor is the only thing that says a node is a link, since the
        // canvas has no <a> for the browser to report in the status bar.
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
      view.x += dx;
      view.y += dy;
    } else if (sim) {
      const node = sim.nodes[drag.index];
      node.fx = (node.fx ?? node.x) + dx / view.k;
      node.fy = (node.fy ?? node.y) + dy / view.k;
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
    if (sim && drag.index !== null) {
      const node = sim.nodes[drag.index];
      // Dropped is where it stays. A node that sprang back to wherever the
      // forces wanted it would make the drag a way of *disturbing* the layout
      // rather than a way of arranging it, and arranging it is the point.
      if (node.fx !== null && node.fy !== null) {
        pinsRef.current.set(node.id, { x: node.fx, y: node.fy });
      }
    }

    if (drag.moved <= CLICK_SLOP && drag.index !== null) {
      const path = metaRef.current[drag.index]?.path;
      if (path && metaRef.current[drag.index].kind === "note") openRef.current(path);
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
     correctness decision rather than a style one. React registers `wheel` at
     the root as a **passive** listener, so `preventDefault()` from a synthetic
     handler is discarded silently — the zoom happens *and* the page scrolls
     out from under it, which is the one gesture this surface cannot share.
     `{ passive: false }` is the only thing that lets the canvas take it. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      touchedRef.current = true;
      const view = viewRef.current;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      // A wheel reports lines or pages as readily as pixels, and Firefox's
      // three lines a notch is a ~1.005 factor here — a zoom that looks broken
      // rather than absent. The two non-pixel modes are scaled to roughly the
      // pixels the same gesture would have produced.
      const unit =
        event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? rect.height : 1;
      // Zoom about the pointer: the thing under it stays under it, which is what
      // makes a wheel feel like moving a camera rather than rescaling a picture.
      const factor = Math.exp(-event.deltaY * unit * 0.0015);
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.k * factor));
      const scale = next / view.k;
      view.x = px - (px - view.x) * scale;
      view.y = py - (py - view.y) * scale;
      view.k = next;
      schedule();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [schedule]);

  /* The graph is centred on first sight rather than left wherever the spiral
     put it: the spiral is centred on the origin and the canvas's origin is its
     top-left corner, so an uncentred graph opens as a quarter of itself.
     Once, on mount — any later re-centre would move the graph out from under an
     operator who had panned it somewhere on purpose. */
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
        // `touch-none` or the browser takes the drag for a scroll and the
        // canvas never sees a pointermove — the same reason WorkflowCanvas
        // carries it on everything draggable.
        className="block h-full w-full touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      />
    </div>
  );
}

/** The kind a node is, as a colour, for everything no group has claimed. */
function colourFor(node: KnowledgeNodeDTO, palette: Palette): string {
  if (node.kind === "tag") return palette["--accent"];
  if (node.kind === "phantom") return palette["--fg-faint"];
  if (node.kind === "attachment") return palette["--fg-muted"];
  return palette["--fg-muted"];
}

/** A head on the target end of a link, clear of the node it points at. */
function arrowInto(
  path: Path2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  clearance: number,
  width: number,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < clearance + 1) return;
  const ux = dx / length;
  const uy = dy / length;
  const tipX = to.x - ux * clearance;
  const tipY = to.y - uy * clearance;
  const size = Math.max(3, width * 4);
  path.moveTo(tipX, tipY);
  path.lineTo(tipX - ux * size + uy * size * 0.5, tipY - uy * size - ux * size * 0.5);
  path.lineTo(tipX - ux * size - uy * size * 0.5, tipY - uy * size + ux * size * 0.5);
  path.closePath();
}
