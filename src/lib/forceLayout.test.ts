import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ALPHA_MIN,
  applyRepulsion,
  buildQuadtree,
  countDegrees,
  createSimulation,
  reheat,
  repulsionExact,
  seedPositions,
  step,
  type SimEdge,
  type SimForces,
  type SimNode,
} from "./forceLayout";

/**
 * Four things about this layout fail silently, and each one is here.
 *
 * **The quadtree is an approximation of a sum nobody sees.** Every node's
 * velocity is the sum of a few hundred contributions, and a tree that opened a
 * cell it should have descended into produces a graph that is merely laid out
 * differently — plausible, wrong, and indistinguishable from a tuning choice.
 * `repulsionExact` is the definition the approximation is measured against.
 *
 * **Cooling is what gives the CPU back.** A `step` that kept returning `true`
 * would leave a settled graph asking for sixty frames a second forever, and the
 * only symptom is a warm laptop on a page that looks finished.
 *
 * **A pin has to hold.** A dragged node whose velocity is still integrating
 * drifts out from under the pointer, which reads as the drag having missed.
 *
 * **Two nodes can land on the same point.** A drag can put one exactly on
 * another, and the distance between them is then zero: a divide by it puts
 * `NaN` into a velocity, `NaN` propagates through every subsequent sum, and the
 * whole graph disappears at once with nothing in the console.
 */

function node(id: string, x: number, y: number): SimNode {
  return { id, x, y, vx: 0, vy: 0, fx: null, fy: null, degree: 0 };
}

const FORCES: SimForces = { center: 0.4, repel: 10, link: 0.6, linkDistance: 90 };

/* ------------------------------- seeding -------------------------------- */

test("seedPositions is deterministic and never puts two nodes on one point", () => {
  const first = [node("a", 0, 0), node("b", 0, 0), node("c", 0, 0)];
  const second = [node("a", 9, 9), node("b", -4, 2), node("c", 100, 100)];
  seedPositions(first);
  seedPositions(second);

  assert.deepEqual(
    first.map((n) => [n.x, n.y]),
    second.map((n) => [n.x, n.y]),
    "the same node count must seed to the same arrangement, whatever it held before",
  );

  const seen = new Set(first.map((n) => `${n.x},${n.y}`));
  assert.equal(seen.size, first.length);
});

test("createSimulation carries over the positions a previous graph had reached", () => {
  const nodes = [node("a", 0, 0), node("b", 0, 0)];
  const state = createSimulation(
    nodes,
    [],
    new Map([["a", { x: 500, y: -250 }]]),
  );

  assert.deepEqual([state.nodes[0].x, state.nodes[0].y], [500, -250]);
  // The one with nothing carried is seeded rather than left at the origin,
  // which is where it would sit on top of whatever else is there.
  assert.notDeepEqual([state.nodes[1].x, state.nodes[1].y], [0, 0]);
});

/* ------------------------------ the quadtree ---------------------------- */

test("the quadtree's root carries every node's mass and their centre", () => {
  const nodes = [node("a", -10, -10), node("b", 10, -10), node("c", -10, 10), node("d", 10, 10)];
  const cells = buildQuadtree(nodes);
  assert.ok(cells);

  assert.equal(cells[0].mass, 4);
  assert.ok(Math.abs(cells[0].mx) < 1e-9);
  assert.ok(Math.abs(cells[0].my) < 1e-9);
});

test("Barnes-Hut agrees with the exact all-pairs sum it stands in for", () => {
  // A real-ish spread rather than a lattice: a lattice has every node the same
  // distance from every cell it summarises, which is the one case the opening
  // test cannot get wrong.
  const nodes: SimNode[] = [];
  for (let i = 0; i < 400; i++) {
    const angle = i * 2.399963;
    const radius = 14 * Math.sqrt(0.5 + i);
    nodes.push(node(`n${i}`, radius * Math.cos(angle), radius * Math.sin(angle) * 0.6));
  }

  const exact = nodes.map((n) => ({ ...n }));
  repulsionExact(exact, -120, 1);

  const approx = nodes.map((n) => ({ ...n }));
  const cells = buildQuadtree(approx);
  assert.ok(cells);
  for (let i = 0; i < approx.length; i++) applyRepulsion(cells, approx, i, -120, 1);

  let worst = 0;
  let scale = 0;
  for (let i = 0; i < exact.length; i++) {
    worst = Math.max(worst, Math.hypot(approx[i].vx - exact[i].vx, approx[i].vy - exact[i].vy));
    scale = Math.max(scale, Math.hypot(exact[i].vx, exact[i].vy));
  }

  // Ten per cent of the largest force in the graph. Loose on purpose: the point
  // is that the tree is summing the same field, not that it is exact — an
  // opening test that had gone the wrong way is off by whole multiples.
  assert.ok(
    worst < scale * 0.1,
    `worst tree-vs-exact disagreement ${worst.toFixed(3)} against a largest force of ${scale.toFixed(3)}`,
  );
});

test("two nodes on exactly one point push apart rather than producing NaN", () => {
  const nodes = [node("a", 42, 42), node("b", 42, 42)];
  const cells = buildQuadtree(nodes);
  assert.ok(cells);
  applyRepulsion(cells, nodes, 0, -120, 1);
  applyRepulsion(cells, nodes, 1, -120, 1);

  for (const n of nodes) {
    assert.ok(Number.isFinite(n.vx), `${n.id} vx is ${n.vx}`);
    assert.ok(Number.isFinite(n.vy), `${n.id} vy is ${n.vy}`);
  }
  assert.notEqual(nodes[0].vx, 0);
});

test("a node contributes no repulsion to itself", () => {
  const alone = [node("a", 3, 4)];
  const cells = buildQuadtree(alone);
  assert.ok(cells);
  applyRepulsion(cells, alone, 0, -120, 1);
  assert.equal(alone[0].vx, 0);
  assert.equal(alone[0].vy, 0);
});

/* -------------------------------- the step ------------------------------ */

test("degrees count both directions and reset between passes", () => {
  const nodes = [node("a", 0, 0), node("b", 1, 0), node("c", 2, 0)];
  const edges: SimEdge[] = [
    { source: 0, target: 1 },
    { source: 1, target: 2 },
  ];
  countDegrees(nodes, edges);
  assert.deepEqual(nodes.map((n) => n.degree), [1, 2, 1]);
  countDegrees(nodes, edges);
  assert.deepEqual(nodes.map((n) => n.degree), [1, 2, 1]);
});

test("the simulation cools to a stop and then stops asking for frames", () => {
  const nodes = [node("a", 0, 0), node("b", 30, 0), node("c", -30, 12)];
  const state = createSimulation(nodes, [{ source: 0, target: 1 }]);
  countDegrees(state.nodes, state.edges);

  let frames = 0;
  while (step(state, FORCES)) {
    frames++;
    assert.ok(frames < 5000, "the layout never cooled below ALPHA_MIN");
  }

  assert.ok(state.alpha < ALPHA_MIN);
  assert.ok(frames > 50, `settled in ${frames} frames, which is too few to watch`);
  // And it stays stopped: a frozen simulation that answered `true` once more
  // would restart the whole loop from the render callback.
  assert.equal(step(state, FORCES), false);
});

test("reheat restarts a settled layout", () => {
  const state = createSimulation([node("a", 0, 0)], []);
  state.alpha = 0;
  assert.equal(step(state, FORCES), false);
  reheat(state);
  assert.equal(step(state, FORCES), true);
});

test("a pinned node stays exactly where the drag left it", () => {
  const nodes = [node("a", 0, 0), node("b", 20, 20), node("c", -20, 5)];
  const state = createSimulation(nodes, [
    { source: 0, target: 1 },
    { source: 0, target: 2 },
  ]);
  countDegrees(state.nodes, state.edges);

  nodes[0].fx = 123.5;
  nodes[0].fy = -77.25;

  for (let i = 0; i < 200; i++) step(state, FORCES);

  assert.equal(nodes[0].x, 123.5);
  assert.equal(nodes[0].y, -77.25);
  assert.equal(nodes[0].vx, 0);
  assert.equal(nodes[0].vy, 0);
  // The neighbours were still free to move, or the pin would have frozen the
  // graph rather than one node in it.
  assert.notEqual(nodes[1].x, 20);
});

test("a link pulls two nodes toward the distance the slider asks for", () => {
  const near = [node("a", 0, 0), node("b", 6, 0)];
  const state = createSimulation(near, [{ source: 0, target: 1 }]);
  // Seeding overwrote the coordinates; the test is about the spring, so put
  // them back much closer together than the rest length.
  near[0].x = 0;
  near[0].y = 0;
  near[1].x = 6;
  near[1].y = 0;
  countDegrees(state.nodes, state.edges);

  const before = Math.hypot(near[1].x - near[0].x, near[1].y - near[0].y);
  for (let i = 0; i < 400; i++) step(state, { ...FORCES, repel: 0, center: 0 });
  const after = Math.hypot(near[1].x - near[0].x, near[1].y - near[0].y);

  assert.ok(after > before, `pair went from ${before} to ${after} against a rest length of 90`);
  assert.ok(after <= FORCES.linkDistance + 1);
});

test("every coordinate stays finite over a full settle", () => {
  const nodes: SimNode[] = [];
  for (let i = 0; i < 120; i++) nodes.push(node(`n${i}`, 0, 0));
  const edges: SimEdge[] = [];
  for (let i = 1; i < 120; i++) edges.push({ source: i - 1, target: i });
  // A self-link and a duplicate, both of which a vault really writes.
  edges.push({ source: 4, target: 4 }, { source: 7, target: 8 }, { source: 7, target: 8 });

  const state = createSimulation(nodes, edges);
  countDegrees(state.nodes, state.edges);
  while (step(state, FORCES)) {
    /* to a standstill */
  }

  for (const n of state.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} settled at ${n.x},${n.y}`);
  }
});
