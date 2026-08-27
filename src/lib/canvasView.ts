/**
 * What every `<canvas>` in this app needs and none of them should own.
 *
 * `KnowledgeGraphCanvas` was the first canvas here, so it answered the
 * questions a canvas asks — how a world coordinate becomes a screen one, how a
 * click finds what is under it, how a backing store is sized on a retina
 * display, what a wheel notch is worth — and it answered them privately. A
 * second canvas could only copy those answers, and a copy is where two surfaces
 * start disagreeing about what a drag does. They live here instead.
 *
 * ## What belongs here, and what does not
 *
 * The line is **what a pixel is**, not **what is drawn on it**. This module may
 * know that a view has a pan and a scale, that a hit is the nearest circle
 * within reach, and that a `deltaMode` of 1 means lines. It may not know what a
 * node is, what it should be coloured, what its radius means or where its data
 * came from — that is the consumer's, and a consumer that finds itself passing
 * domain knowledge in as an argument (`reachOf`, `marginPx`, the token list)
 * has the split right. Nothing here imports React or reaches for a ref: the
 * pure arithmetic is testable without a DOM, and the three functions that do
 * touch the DOM take their elements as arguments and return their own teardown.
 *
 * ## Why the transform is functions over a value, not a class
 *
 * A `View` is three numbers and every gesture is a total function from one to
 * the next. Written that way the whole transform is unit-testable — that a zoom
 * leaves the point under the cursor fixed is an assertion, not something a
 * person checks by eye — and the caller keeps its own storage, which in the
 * knowledge graph is a ref that a frame reads without re-rendering.
 *
 * ## Colour cannot be read from a variable
 *
 * Every token in `globals.css` is a `light-dark()` or a `color-mix()` and no
 * `@property` registers any of them, so `getPropertyValue("--fg")` returns the
 * literal source text — which is not a value `ctx.fillStyle` accepts. The only
 * thing that resolves one is an element. `probeTokens` is that element, and
 * `observeTheme` is the pair of boundaries across which its answer changes
 * without the component rendering.
 *
 * Everything here is pure and client-safe: no `node:` import, nothing that
 * opens SQLite. `src/lib` is also what `tsconfig.test.json` compiles, which is
 * why the arithmetic lives here rather than beside a component — a transform
 * that is wrong draws a plausible picture, and the only way to catch that is an
 * assertion.
 */

/** A point in either space. Which one is the parameter name's business. */
export interface Point {
  x: number;
  y: number;
}

/**
 * The world/screen transform: world scaled by `k`, then translated by `x`/`y`.
 *
 * Held as a plain value so a caller can keep it wherever it likes — a ref, a
 * state hook, a field — and so every gesture below can be a pure function of it.
 */
export interface View {
  x: number;
  y: number;
  /** Screen pixels per world unit. */
  k: number;
}

/** The ends the scale is clamped to, unless a caller names its own. */
export interface ZoomLimits {
  min: number;
  max: number;
}

/** World units per screen pixel, at the ends the wheel is clamped to. */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;

/**
 * Frozen because it is the default argument of three exported functions.
 *
 * A caller that wrote `DEFAULT_ZOOM_LIMITS.max = 2` would change the ceiling
 * for every surface in the app from anywhere, and the symptom would be a graph
 * that stops zooming on a page nobody was editing. A caller wanting its own
 * range passes one.
 */
export const DEFAULT_ZOOM_LIMITS: ZoomLimits = Object.freeze({ min: ZOOM_MIN, max: ZOOM_MAX });

/** How far a pointer may travel between down and up and still count as a click. */
export const CLICK_SLOP = 4;

/**
 * Screen pixels of forgiveness added to a hit target's own radius.
 *
 * Small on purpose: it is the difference between missing a node by a pixel and
 * opening the one beside the one you meant.
 */
export const HIT_SLOP_PX = 4;

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
export const LINE_HEIGHT_PX = 16;

/* --------------------------- the transform --------------------------- */

/** A screen point — canvas-relative CSS pixels — as a world one. */
export function screenToWorld(view: View, px: number, py: number): Point {
  return { x: (px - view.x) / view.k, y: (py - view.y) / view.k };
}

/** The inverse: a world point as canvas-relative CSS pixels. */
export function worldToScreen(view: View, wx: number, wy: number): Point {
  return { x: wx * view.k + view.x, y: wy * view.k + view.y };
}

/**
 * A client point as canvas-relative CSS pixels.
 *
 * Every pointer event arrives in client coordinates and every transform above
 * wants canvas ones, so this is the first thing on the path from a gesture to a
 * world position. It reads layout, which is why it takes the element rather
 * than being folded into `screenToWorld`: a caller handling a burst of moves
 * can measure the rect once.
 */
export function canvasPoint(
  rect: { left: number; top: number },
  clientX: number,
  clientY: number,
): Point {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/** The world rectangle a viewport of this size is showing. */
export interface WorldRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * What is on screen, in world units, widened by a screen-pixel margin.
 *
 * Culling against this is where the frame rate at a zoomed-in graph comes from:
 * the cost of a canvas is the drawing, not the arithmetic, and most of a
 * zoomed-in graph is not on the screen. The margin is the caller's because what
 * it has to cover is the caller's — a link whose far end is off-screen still
 * draws, a bare dot does not.
 */
export function visibleWorldRect(
  view: View,
  width: number,
  height: number,
  marginPx: number,
): WorldRect {
  const margin = marginPx / view.k;
  const left = -view.x / view.k - margin;
  const top = -view.y / view.k - margin;
  return {
    left,
    top,
    right: left + width / view.k + margin * 2,
    bottom: top + height / view.k + margin * 2,
  };
}

/* ---------------------------- the gestures ---------------------------- */

export function clampZoom(k: number, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): number {
  return Math.min(limits.max, Math.max(limits.min, k));
}

/** A pan by a screen-pixel delta. The scale is untouched, so world moves with it. */
export function panBy(view: View, dx: number, dy: number): View {
  return { x: view.x + dx, y: view.y + dy, k: view.k };
}

/**
 * Scale about a screen point, leaving whatever is under it under it.
 *
 * That fixed point is the whole difference between a wheel that feels like
 * moving a camera and one that feels like rescaling a picture, and it survives
 * the clamp: at either end of the range the factor is absorbed and the view
 * does not creep.
 */
export function zoomAt(
  view: View,
  px: number,
  py: number,
  factor: number,
  limits: ZoomLimits = DEFAULT_ZOOM_LIMITS,
): View {
  const next = clampZoom(view.k * factor, limits);
  const scale = next / view.k;
  return {
    x: px - (px - view.x) * scale,
    y: py - (py - view.y) * scale,
    k: next,
  };
}

/**
 * What one wheel event is worth as a multiplicative zoom factor.
 *
 * A wheel reports lines or pages as readily as pixels, and Firefox's three
 * lines a notch is a ~1.005 factor here — a zoom that looks broken rather than
 * absent. The two non-pixel modes are scaled to roughly the pixels the same
 * gesture would have produced, which is what `viewportHeightPx` is for: a page
 * is one screenful.
 */
export function wheelZoomFactor(
  deltaY: number,
  deltaMode: number,
  viewportHeightPx: number,
): number {
  const unit = deltaMode === 1 ? LINE_HEIGHT_PX : deltaMode === 2 ? viewportHeightPx : 1;
  return Math.exp(-deltaY * unit * 0.0015);
}

/* ----------------------------- the framing ---------------------------- */

/** The axis-aligned bounds of a set of points, or null if there are none. */
export function boundsOf(points: readonly Point[]): WorldRect | null {
  if (points.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    if (point.x < left) left = point.x;
    if (point.y < top) top = point.y;
    if (point.x > right) right = point.x;
    if (point.y > bottom) bottom = point.y;
  }
  return { left, top, right, bottom };
}

/**
 * The view that puts `bounds` in the middle of a viewport with `pad` to spare.
 *
 * `Math.max(1, …)` on each extent is what stops a single node — zero width and
 * zero height — asking for an infinite scale.
 */
export function fitView(
  bounds: WorldRect,
  width: number,
  height: number,
  pad: number,
  limits: ZoomLimits = DEFAULT_ZOOM_LIMITS,
): View {
  const k = clampZoom(
    Math.min(
      (width - pad * 2) / Math.max(1, bounds.right - bounds.left),
      (height - pad * 2) / Math.max(1, bounds.bottom - bounds.top),
    ),
    limits,
  );
  return {
    k,
    x: width / 2 - ((bounds.left + bounds.right) / 2) * k,
    y: height / 2 - ((bounds.top + bounds.bottom) / 2) * k,
  };
}

/* ---------------------------- the hit test ---------------------------- */

/**
 * The index of the nearest point within its own reach of (`wx`, `wy`), or null.
 *
 * **Nearest wins, not first.** Two nodes overlap often enough at low zoom that
 * taking the first hit would open whichever the data happened to list earlier,
 * which is not a thing an operator can see or predict.
 *
 * `reachOf` is the caller's because a radius is the caller's: it is the one
 * place a domain — a degree, a file size, a fixed box — reaches into this
 * module, and it does so as an argument rather than an import.
 */
export function nearestWithin(
  points: readonly Point[],
  wx: number,
  wy: number,
  reachOf: (point: Point, index: number) => number,
): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const reach = reachOf(point, i);
    const distance = Math.hypot(point.x - wx, point.y - wy);
    if (distance <= reach && distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/* ------------------------------ the size ------------------------------ */

/**
 * The ratio, with the fallback every caller was writing inline.
 *
 * Deliberately not named `devicePixelRatio`: that would shadow the DOM global
 * of that name at every import site, and the next person to write `const dpr =
 * devicePixelRatio` without the parentheses would multiply a width by a
 * function. `NaN` is not a size a canvas complains about — it just draws
 * nothing.
 */
export function pixelRatio(): number {
  return window.devicePixelRatio || 1;
}

/** A canvas's size in CSS pixels, which is its backing store divided back down. */
export function cssSize(canvas: HTMLCanvasElement, dpr: number): { width: number; height: number } {
  return { width: canvas.width / dpr, height: canvas.height / dpr };
}

/**
 * Match the backing store to the host's box at the current pixel ratio.
 *
 * The backing store is in device pixels and the element is in CSS ones. Setting
 * either without the other is the whole of why a canvas looks soft on a retina
 * display, and it also clears the surface — so a resize is always followed by a
 * draw, which is why `observeCanvasSize` takes a callback rather than leaving
 * the caller to notice.
 *
 * Writing the measured box back as an inline `style.width`/`style.height` is
 * the half that looks redundant and is not: it is why the canvas element must
 * be **out of flow** at every call site. An in-flow canvas holding last
 * measurement's height is a child propping its own host up, and against a host
 * whose box can shrink — a grid row sharing space with a panel — that ratchets,
 * silently, because every individual measurement is correct.
 */
export function sizeCanvasToHost(canvas: HTMLCanvasElement, host: HTMLElement): void {
  const dpr = pixelRatio();
  const rect = host.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
}

/**
 * Keep `canvas` sized to `host`, redrawing through `onResize`.
 *
 * Sizes once before observing, because the first measurement is the one the
 * first frame needs. Returns its own teardown so an effect can hand it straight
 * back.
 */
export function observeCanvasSize(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  onResize: () => void,
): () => void {
  const resize = () => {
    sizeCanvasToHost(canvas, host);
    onResize();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  return () => observer.disconnect();
}

/* ----------------------------- the palette ---------------------------- */

/**
 * Resolve CSS custom properties to something a 2D context accepts.
 *
 * One throwaway element rather than one per token: the read is what costs, and
 * a caller is expected to do it on mount and on a theme change, never in a
 * frame.
 */
export function probeTokens<T extends string>(
  host: HTMLElement,
  tokens: readonly T[],
): Record<T, string> {
  const el = document.createElement("span");
  el.style.position = "absolute";
  el.style.width = "0";
  el.style.height = "0";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  host.appendChild(el);
  const out = {} as Record<T, string>;
  for (const token of tokens) {
    el.style.color = `var(${token})`;
    out[token] = getComputedStyle(el).color;
  }
  el.remove();
  return out;
}

/**
 * The host's own type, for a canvas that would otherwise draw in the 2D
 * context's default 10px sans-serif — which reads as a different program.
 */
export function probeFont(host: HTMLElement): string {
  return getComputedStyle(host).fontFamily || "system-ui, sans-serif";
}

/**
 * Call `onChange` whenever a probed colour could have changed.
 *
 * Two boundaries, and each one is a way the answer changes without the
 * component rendering. `data-theme` is what `ThemeToggle` sets; the media query
 * is the OS flipping underneath "Match system", which sets nothing. Returns its
 * own teardown.
 */
export function observeTheme(onChange: () => void): () => void {
  const attribute = new MutationObserver(onChange);
  attribute.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", onChange);
  return () => {
    attribute.disconnect();
    scheme.removeEventListener("change", onChange);
  };
}
