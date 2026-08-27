import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  boundsOf,
  canvasPoint,
  clampZoom,
  cssSize,
  fitView,
  nearestWithin,
  panBy,
  screenToWorld,
  visibleWorldRect,
  wheelZoomFactor,
  worldToScreen,
  zoomAt,
  ZOOM_MAX,
  ZOOM_MIN,
  type Point,
  type View,
} from "./canvasView";

/**
 * Five things about a canvas view fail without anything being thrown.
 *
 * **A wrong transform still draws a picture.** Every mark on a canvas is put
 * where this arithmetic says, and there is no layout engine underneath to
 * disagree with it — a sign error or a scale applied before a translate gives a
 * graph that is merely somewhere else, which is indistinguishable from a
 * layout choice until someone tries to click on it.
 *
 * **A zoom that does not fix the point under the cursor reads as broken input.**
 * That one invariant is the whole difference between a wheel that feels like
 * moving a camera and one that feels like the page fighting back, and it is
 * exactly the kind of thing nobody writes down and everybody checks by eye.
 * Its worst form is at the clamp: a factor absorbed by the limit but still
 * applied to the pan makes a graph creep away under a wheel that is doing
 * nothing, which looks like a rendering fault rather than an arithmetic one.
 *
 * **Culling is a second copy of the transform.** The visible rectangle is
 * derived from `view` by different-looking arithmetic than `screenToWorld`,
 * and if the two ever disagree the symptom is marks vanishing near an edge —
 * on a graph, indistinguishable from having no link there.
 *
 * **A degenerate extent divides by zero.** One node, or a row of them on an
 * exact horizontal, is a bounding box with no height; the scale that frames it
 * is `Infinity`, every coordinate downstream is `NaN`, and the canvas goes
 * blank all at once with nothing in the console.
 *
 * **A hit test that takes the first hit opens the wrong thing.** Overlap is
 * routine at low zoom, and "whichever the data listed earlier" is not a rule an
 * operator can see, predict or complain about precisely.
 */

const VIEW: View = { x: 120, y: -40, k: 2.5 };

function near(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message} — expected ${expected}, got ${actual}`,
  );
}

/* ------------------------------ transform ------------------------------- */

test("screenToWorld and worldToScreen are inverses", () => {
  for (const [px, py] of [
    [0, 0],
    [640, 480],
    [-33, 12.5],
  ]) {
    const world = screenToWorld(VIEW, px, py);
    const back = worldToScreen(VIEW, world.x, world.y);
    near(back.x, px, "a point mapped to world and back must land where it started");
    near(back.y, py, "a point mapped to world and back must land where it started");
  }
});

test("the transform is scale-then-translate, matching what the 2D context is set to", () => {
  // `draw` issues translate(view.x, view.y) then scale(view.k), so a world
  // point lands at world * k + offset. Hit testing that inverted these in the
  // other order would be wrong everywhere except the origin, where it agrees.
  const at = worldToScreen(VIEW, 10, 4);
  near(at.x, 10 * 2.5 + 120, "world x scales before it translates");
  near(at.y, 4 * 2.5 - 40, "world y scales before it translates");
});

test("canvasPoint takes a client point to a canvas-relative one", () => {
  const point = canvasPoint({ left: 32, top: 96 }, 100, 100);
  assert.deepEqual(
    point,
    { x: 68, y: 4 },
    "a pointer event is in client coordinates and every transform above wants canvas ones",
  );
});

/* -------------------------------- zoom ---------------------------------- */

test("zoomAt leaves the point under the cursor exactly where it was", () => {
  const px = 300;
  const py = 200;
  const before = screenToWorld(VIEW, px, py);
  const zoomed = zoomAt(VIEW, px, py, 1.4);
  const after = screenToWorld(zoomed, px, py);
  near(after.x, before.x, "the world point under the cursor must survive the zoom");
  near(after.y, before.y, "the world point under the cursor must survive the zoom");
  near(zoomed.k, VIEW.k * 1.4, "and the scale must actually have changed");
});

test("zoomAt does not pan when the scale is clamped", () => {
  // The clamp is applied to the scale *before* the pan is derived from it, so a
  // factor the limit refuses contributes nothing at all. Deriving the pan from
  // the unclamped factor instead would slide the graph sideways under a wheel
  // that visibly does not zoom.
  const atCeiling: View = { x: 10, y: 20, k: ZOOM_MAX };
  const pushed = zoomAt(atCeiling, 400, 300, 4);
  assert.deepEqual(pushed, atCeiling, "a zoom the ceiling absorbs must move nothing");

  const atFloor: View = { x: 10, y: 20, k: ZOOM_MIN };
  assert.deepEqual(
    zoomAt(atFloor, 400, 300, 0.1),
    atFloor,
    "and the same at the floor, or the graph creeps while the wheel does nothing",
  );
});

test("zoomAt clamps rather than passing an out-of-range scale through", () => {
  assert.equal(zoomAt(VIEW, 0, 0, 1e6).k, ZOOM_MAX, "no zoom may exceed the ceiling");
  assert.equal(zoomAt(VIEW, 0, 0, 1e-6).k, ZOOM_MIN, "and none may fall through the floor");
});

test("clampZoom holds both ends and passes the middle through", () => {
  assert.equal(clampZoom(ZOOM_MAX * 2), ZOOM_MAX);
  assert.equal(clampZoom(ZOOM_MIN / 2), ZOOM_MIN);
  assert.equal(clampZoom(1), 1);
});

test("panBy moves the view and never the scale", () => {
  const panned = panBy(VIEW, -15, 7);
  assert.deepEqual(
    panned,
    { x: 105, y: -33, k: 2.5 },
    "a drag translates in screen pixels; a pan that touched k would zoom on drag",
  );
});

/* -------------------------------- wheel --------------------------------- */

test("wheelZoomFactor zooms in on a negative delta and out on a positive one", () => {
  assert.ok(wheelZoomFactor(-100, 0, 600) > 1, "wheeling away from the operator zooms in");
  assert.ok(wheelZoomFactor(100, 0, 600) < 1, "and towards them zooms out");
  assert.equal(wheelZoomFactor(0, 0, 600), 1, "a zero delta is not a zoom");
});

test("wheelZoomFactor scales a line-mode delta to something a person can feel", () => {
  // Firefox reports a notch as ~3 lines where Chrome reports ~100 pixels. Taken
  // literally, that is a factor of 1.0045 — a zoom that reads as absent rather
  // than broken, and the kind of platform difference nobody sees until they
  // open the other browser.
  const literal = wheelZoomFactor(3, 0, 600);
  const scaled = wheelZoomFactor(3, 1, 600);
  assert.ok(1 - literal < 0.01, "three raw units is very nearly no zoom at all");
  assert.ok(
    scaled < literal,
    "a line-mode delta must be worth appreciably more than the same number of pixels",
  );
  const chromeNotch = wheelZoomFactor(100, 0, 600);
  assert.ok(
    Math.abs(Math.log(scaled) / Math.log(chromeNotch) - 0.48) < 0.05,
    "and land within about a factor of two of the same gesture in a pixel-reporting engine",
  );
});

test("wheelZoomFactor treats a page-mode delta as one screenful", () => {
  assert.equal(
    wheelZoomFactor(1, 2, 600),
    wheelZoomFactor(600, 0, 600),
    "DOM_DELTA_PAGE is the viewport height, or a page scroll zooms by a single pixel",
  );
});

/* -------------------------------- culling -------------------------------- */

test("visibleWorldRect is exactly the viewport inflated by the margin", () => {
  // Written as `left + width / k + margin * 2` it does not obviously agree with
  // the transform, and a cull rectangle that is even slightly too small drops
  // marks at an edge — which on a graph is indistinguishable from there being
  // no link there.
  const width = 800;
  const height = 600;
  const marginPx = 120;
  const rect = visibleWorldRect(VIEW, width, height, marginPx);

  const topLeft = screenToWorld(VIEW, -marginPx, -marginPx);
  const bottomRight = screenToWorld(VIEW, width + marginPx, height + marginPx);
  near(rect.left, topLeft.x, "the left edge is the viewport's left, less the margin");
  near(rect.top, topLeft.y, "the top edge is the viewport's top, less the margin");
  near(rect.right, bottomRight.x, "the right edge is the viewport's right, plus the margin");
  near(rect.bottom, bottomRight.y, "the bottom edge is the viewport's bottom, plus the margin");
});

test("visibleWorldRect widens in world units as the view zooms out", () => {
  const wide = visibleWorldRect({ x: 0, y: 0, k: 0.5 }, 800, 600, 120);
  const close = visibleWorldRect({ x: 0, y: 0, k: 4 }, 800, 600, 120);
  assert.ok(
    wide.right - wide.left > close.right - close.left,
    "zooming out shows more world, so the cull must admit more of it",
  );
});

/* -------------------------------- framing -------------------------------- */

test("boundsOf covers every point, and is null for none", () => {
  assert.equal(boundsOf([]), null, "an empty graph has no bounds to frame");
  assert.deepEqual(
    boundsOf([
      { x: 3, y: -2 },
      { x: -1, y: 8 },
      { x: 0, y: 0 },
    ]),
    { left: -1, top: -2, right: 3, bottom: 8 },
    "the box is the extremes on each axis independently, not one point's corner",
  );
});

test("fitView centres the bounds and leaves the padding on the tight axis", () => {
  const view = fitView({ left: 0, top: 0, right: 100, bottom: 50 }, 400, 300, 40);
  const centre = worldToScreen(view, 50, 25);
  near(centre.x, 200, "the middle of the graph lands in the middle of the viewport");
  near(centre.y, 150, "on both axes");

  const left = worldToScreen(view, 0, 0);
  const right = worldToScreen(view, 100, 0);
  near(left.x, 40, "the wider axis is the one that binds, so it gets exactly the padding");
  near(right.x, 360, "at both ends");
});

test("fitView survives a bounding box with no extent", () => {
  // A single node, or a row of them on an exact horizontal. Dividing by the
  // extent gives Infinity, every coordinate derived from it is NaN, and the
  // canvas goes blank at once with nothing logged.
  for (const bounds of [
    { left: 5, top: 5, right: 5, bottom: 5 },
    { left: 0, top: 7, right: 300, bottom: 7 },
  ]) {
    const view = fitView(bounds, 400, 300, 40);
    assert.ok(Number.isFinite(view.k), "a zero extent must not produce an infinite scale");
    assert.ok(Number.isFinite(view.x) && Number.isFinite(view.y), "nor a NaN pan");
    assert.ok(view.k <= ZOOM_MAX && view.k >= ZOOM_MIN, "and it stays inside the range");
  }
});

test("fitView clamps rather than framing a graph nobody could read", () => {
  const enormous = fitView({ left: 0, top: 0, right: 1e9, bottom: 1e9 }, 400, 300, 40);
  assert.equal(enormous.k, ZOOM_MIN, "a graph too big to fit is shown at the floor, not below it");
});

/* ------------------------------- hit test -------------------------------- */

const REACH_10 = () => 10;

test("nearestWithin returns the nearest hit, not the first", () => {
  // The two overlap, and both are within reach of the query. Taking the first
  // would open whichever the caller happened to list earlier.
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
  ];
  assert.equal(
    nearestWithin(points, 4, 0, REACH_10),
    1,
    "the closer of two overlapping targets wins",
  );
  assert.equal(
    nearestWithin([...points].reverse(), 4, 0, REACH_10),
    0,
    "and it still wins when the order is reversed, which is what makes it a rule",
  );
});

test("nearestWithin misses when nothing is in reach", () => {
  assert.equal(
    nearestWithin([{ x: 0, y: 0 }], 50, 50, REACH_10),
    null,
    "a click on empty space must be a miss, not the nearest thing anywhere",
  );
  assert.equal(nearestWithin([], 0, 0, REACH_10), null, "and an empty surface is all empty space");
});

test("nearestWithin asks each point for its own reach", () => {
  // The reach is the caller's arithmetic — a degree, a file size, a fixed box —
  // and a hit test that used one radius for all of them would make small marks
  // unclickable and large ones greedy.
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
  ];
  const reachOf = (_point: Point, i: number) => (i === 0 ? 100 : 1);
  assert.equal(
    nearestWithin(points, 18, 0, reachOf),
    0,
    "the far point with the generous reach beats the near one that does not reach",
  );
});

test("nearestWithin measures distance, not axis offset", () => {
  const diagonal: Point[] = [{ x: 6, y: 8 }];
  assert.equal(nearestWithin(diagonal, 0, 0, REACH_10), 0, "10 away on the hypotenuse is a hit");
  assert.equal(
    nearestWithin(diagonal, 0, 0, () => 9),
    null,
    "and a reach of 9 is not, which a per-axis comparison would have admitted",
  );
});

/* --------------------------------- size ---------------------------------- */

test("cssSize divides the backing store back down to CSS pixels", () => {
  // Everything drawn is positioned in CSS pixels while the store is in device
  // ones, so a frame that used the raw width would draw the graph into the
  // top-left quarter of a retina canvas.
  const canvas = { width: 1600, height: 1200 } as HTMLCanvasElement;
  assert.deepEqual(cssSize(canvas, 2), { width: 800, height: 600 });
  assert.deepEqual(cssSize(canvas, 1), { width: 1600, height: 1200 });
});
