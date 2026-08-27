/**
 * A force-directed layout, stepped one frame at a time.
 *
 * Separate from `canvasGraph.ts`, which is the *workflow* canvas's geometry:
 * that one lays a DAG out in deterministic columns and never moves again, and
 * the two have no force, no velocity and no cooling in common. Nothing in this
 * file is shared with either — what a surface has in common with any other
 * canvas is the world/screen transform, hit testing, the pixel ratio and the
 * gestures, and that is `canvasView.ts`, which this file does not import and
 * `KnowledgeGraphCanvas` does.
 *
 * ## Why the layout is hand-rolled
 *
 * The repository carries four runtime dependencies and hand-rolls its own
 * Markdown renderer rather than taking one. A force layout is roughly two
 * hundred lines of arithmetic with no ecosystem to keep up with, and the two
 * candidates (`d3-force`, `ngraph.forcelayout`) would each pull a transitive
 * tree in for it. The arithmetic is here and it is unit tested.
 *
 * ## Why Barnes-Hut and not every pair
 *
 * `MAX_GRAPH_NODES` is 4000, so the honest worst case is 16 million pair
 * distances per frame — about a tenth of a second of arithmetic, which is a
 * graph nobody can drag. The quadtree makes that O(n log n): a distant clump of
 * nodes is summed once and treated as its centre of mass. `THETA` is the
 * threshold for "distant enough", and at 0.9 the error is invisible at the
 * scale a person reads a graph at — `forceLayout.test.ts` measures it against
 * the exact all-pairs sum rather than asserting it looks right.
 *
 * ## Cooling is a feature, not an optimisation
 *
 * `alpha` decays every step and the simulation is **frozen** below `ALPHA_MIN`.
 * A settled graph that keeps integrating is a tab that never gives the CPU
 * back, and on a laptop that is a fan nobody asked for. Anything that
 * invalidates the layout — a filter, a force slider, a drag — calls `reheat()`.
 */

/** One node under the forces. Mutated in place: a frame allocates nothing. */
export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /**
   * Where a drag pinned this node, or `null` when the forces own it.
   *
   * A pin is a position and not a zero velocity, because the neighbours keep
   * pulling: releasing the pin without it would fling the node away by whatever
   * momentum had accumulated underneath.
   */
  fx: number | null;
  fy: number | null;
  /** Edges landing here, in either direction. Both link bias and the spring
   * stiffness are shares of it, so a hub does not drag its whole fan around. */
  degree: number;
}

/** An edge, by index into the node array rather than by id — the inner loop
 * runs once per edge per frame and a map lookup there is the whole budget. */
export interface SimEdge {
  source: number;
  target: number;
}

/**
 * The four sliders, on the ranges the graph panel offers.
 *
 * These are the *operator's* numbers, not the integrator's: `FORCE_SCALE` turns
 * each one into the coefficient the arithmetic wants. Keeping the two apart is
 * what lets the panel say "Repel force 10" and mean something stable while the
 * step function is retuned.
 */
export interface SimForces {
  /** 0–1. Pull toward the origin, which is what keeps a graph on screen. */
  center: number;
  /** 0–20. How hard every node pushes every other one apart. */
  repel: number;
  /** 0–1. Spring stiffness along an edge. */
  link: number;
  /** 30–500, in world units. The length a spring is happy at. */
  linkDistance: number;
}

export interface SimState {
  nodes: SimNode[];
  edges: SimEdge[];
  /** Falls to zero as the layout settles; every force is scaled by it. */
  alpha: number;
}

/** Below this the layout has stopped moving and `step` returns `false`. */
export const ALPHA_MIN = 0.005;

/** A cooling curve that settles in roughly 250 frames — about four seconds. */
export const ALPHA_DECAY = 0.021;

/** Friction. A velocity survives this share of it into the next frame. */
export const VELOCITY_DECAY = 0.6;

/**
 * Barnes-Hut opening angle: a cell is summarised when its width over its
 * distance is under this. Zero degrades to exact all-pairs.
 */
export const THETA = 0.9;

/**
 * Slider units to integrator coefficients.
 *
 * `repel` is negative because a charge that repels is one that attracts with
 * the sign flipped, and folding the sign in here keeps the inner loop from
 * carrying a `-` nobody can trace back to a slider.
 */
const FORCE_SCALE = {
  repel: -12,
  center: 0.06,
  link: 1,
} as const;

/**
 * Deterministic starting positions on a phyllotaxis spiral.
 *
 * Deterministic rather than random for two reasons: a test can assert on a
 * layout, and re-opening the page gives the operator the graph they had rather
 * than a new arrangement of the same vault. The spiral is used instead of a
 * uniform disc because it has no two nodes at the same point — a pair at
 * exactly one position has a zero distance between them, and the repulsion
 * step would divide by it.
 */
export function seedPositions(nodes: SimNode[], spread = 30): void {
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < nodes.length; i++) {
    const radius = spread * Math.sqrt(0.5 + i);
    const angle = i * GOLDEN;
    const node = nodes[i];
    node.x = radius * Math.cos(angle);
    node.y = radius * Math.sin(angle);
    node.vx = 0;
    node.vy = 0;
  }
}

/**
 * A simulation over `nodes` and `edges`, seeded and hot.
 *
 * `carry` supplies positions a previous simulation had reached, keyed by id, so
 * that a filter which removes a hundred nodes does not throw the other six
 * hundred back onto the spiral. A node it has nothing for is seeded and left
 * hot to find its own place among the settled ones.
 */
export function createSimulation(
  nodes: SimNode[],
  edges: SimEdge[],
  carry?: ReadonlyMap<string, { x: number; y: number }>,
): SimState {
  seedPositions(nodes);
  if (carry) {
    for (const node of nodes) {
      const at = carry.get(node.id);
      if (at) {
        node.x = at.x;
        node.y = at.y;
      }
    }
  }
  return { nodes, edges, alpha: 1 };
}

/** Put the heat back in: a slider moved, a node was dragged, a filter changed. */
export function reheat(state: SimState, alpha = 0.4): void {
  state.alpha = Math.max(state.alpha, alpha);
}

/** Edges landing on each node, in either direction, written onto `degree`. */
export function countDegrees(nodes: SimNode[], edges: readonly SimEdge[]): void {
  for (const node of nodes) node.degree = 0;
  for (const edge of edges) {
    const source = nodes[edge.source];
    const target = nodes[edge.target];
    if (source) source.degree++;
    if (target) target.degree++;
  }
}

/* ------------------------------------------------------------------ */
/* The quadtree                                                        */
/* ------------------------------------------------------------------ */

/**
 * One cell of the Barnes-Hut tree: either a leaf holding the nodes inside it,
 * or a branch whose four children partition it.
 *
 * The tree is rebuilt from scratch every frame, which sounds wasteful and is
 * not: the nodes have all moved, and an incremental rebalance costs more than
 * the build. It is one flat array of cells rather than a graph of objects so
 * that a frame allocates one buffer rather than n of them.
 */
export interface QuadCell {
  /** Centre of the square this cell covers, and half its side. */
  cx: number;
  cy: number;
  half: number;
  /** Aggregate charge, and where it acts from. */
  mass: number;
  mx: number;
  my: number;
  /**
   * The nodes sitting directly in this cell. One in an ordinary leaf, none in
   * a branch, and more than one only at `MAX_DEPTH` — where two nodes are at
   * coordinates no further subdivision can separate.
   *
   * A list rather than a single index because the alternative was silently
   * dropping the second of two coincident nodes out of the tree, which is a
   * node that then exerts no repulsion on anything: the pair it is stuck to
   * has nothing left to push it out, so it stays stuck for good.
   */
  members: number[];
  /** Indices into the cell array, or -1. Order is NW, NE, SW, SE. */
  kids: [number, number, number, number];
}

/** A tree over the given nodes, or `null` when there is nothing to build one
 * from. `charge` is per node so a hub can weigh more than a leaf later. */
export function buildQuadtree(nodes: readonly SimNode[]): QuadCell[] | null {
  if (nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  // A square, never a rectangle: the opening test compares a cell's width to a
  // distance, and a cell with two widths has no single answer to give it. The
  // floor keeps a graph whose nodes have collapsed onto one point from
  // producing a zero-sided root that no subdivision can ever separate.
  const half = Math.max((maxX - minX) / 2, (maxY - minY) / 2, 1) * 1.01;
  const cells: QuadCell[] = [makeCell((minX + maxX) / 2, (minY + maxY) / 2, half)];

  for (let i = 0; i < nodes.length; i++) insert(cells, 0, i, nodes);

  // Aggregate bottom-up. A cell always appears in the array before its
  // children — `insert` only ever pushes — so one backwards pass is enough and
  // no recursion is needed.
  for (let c = cells.length - 1; c >= 0; c--) {
    const cell = cells[c];
    let mass = 0;
    let mx = 0;
    let my = 0;
    // Members and children both, rather than one or the other: at MAX_DEPTH a
    // cell that already had children can still take a member, and a branch that
    // ignored it would drop that node's charge out of every sum above it.
    for (const m of cell.members) {
      mass += 1;
      mx += nodes[m].x;
      my += nodes[m].y;
    }
    for (const kid of cell.kids) {
      if (kid < 0) continue;
      const child = cells[kid];
      mass += child.mass;
      mx += child.mx * child.mass;
      my += child.my * child.mass;
    }
    cell.mass = mass;
    if (mass > 0) {
      cell.mx = mx / mass;
      cell.my = my / mass;
    }
  }

  return cells;
}

function makeCell(cx: number, cy: number, half: number): QuadCell {
  return { cx, cy, half, mass: 0, mx: 0, my: 0, members: [], kids: [-1, -1, -1, -1] };
}

/** Which of the four children of `cell` a point falls in. */
function quadrantOf(cell: QuadCell, x: number, y: number): number {
  return (y >= cell.cy ? 2 : 0) + (x >= cell.cx ? 1 : 0);
}

/**
 * Push node `index` into the subtree rooted at `at`.
 *
 * The depth is capped rather than recursing until two points separate. Two
 * notes can sit at coordinates that differ below what a double can represent —
 * a drag that pins one node onto another does exactly that — and without the
 * cap the subdivision never terminates. Past the cap the cell simply holds
 * both, which costs an exact pair calculation and nothing else.
 */
const MAX_DEPTH = 24;

function insert(cells: QuadCell[], at: number, index: number, nodes: readonly SimNode[]): void {
  let cursor = at;
  let depth = 0;
  const x = nodes[index].x;
  const y = nodes[index].y;

  for (;;) {
    const cell = cells[cursor];
    const isBranch = cell.kids[0] >= 0 || cell.kids[1] >= 0 || cell.kids[2] >= 0 || cell.kids[3] >= 0;

    // Out of depth, or an empty leaf: this cell takes it. Taking it is what
    // makes the cap safe — returning instead would drop the node.
    if (depth >= MAX_DEPTH || (!isBranch && cell.members.length === 0)) {
      cell.members.push(index);
      return;
    }

    if (!isBranch) {
      // Split: the sitting tenants move down before the newcomer does. All of
      // them, because past MAX_DEPTH a cell can hold more than one.
      const sitting = cell.members;
      cell.members = [];
      for (const s of sitting) {
        cells[descendOne(cells, cursor, nodes[s].x, nodes[s].y)].members.push(s);
      }
    }

    cursor = descendOne(cells, cursor, x, y);
    depth++;
  }
}

/** The child of `at` covering (x, y), created if it does not exist yet. */
function descendOne(cells: QuadCell[], at: number, x: number, y: number): number {
  const cell = cells[at];
  const q = quadrantOf(cell, x, y);
  if (cell.kids[q] >= 0) return cell.kids[q];
  const half = cell.half / 2;
  const cx = cell.cx + (q & 1 ? half : -half);
  const cy = cell.cy + (q & 2 ? half : -half);
  cells.push(makeCell(cx, cy, half));
  const index = cells.length - 1;
  cell.kids[q] = index;
  return index;
}

/**
 * The repulsion `tree` exerts on node `i`, added to its velocity.
 *
 * `strength` is already negative for a repulsion. The force falls off as 1/d
 * rather than 1/d² — the inverse-square law is the physical one and it makes a
 * graph explode, because the near pairs then dominate everything and a
 * two-node component shoots off the canvas before the springs can answer.
 */
export function applyRepulsion(
  cells: QuadCell[],
  nodes: SimNode[],
  i: number,
  strength: number,
  alpha: number,
): void {
  const node = nodes[i];
  const stack = [0];

  while (stack.length > 0) {
    const cell = cells[stack.pop() as number];
    if (cell.mass === 0) continue;

    const isBranch = cell.kids[0] >= 0 || cell.kids[1] >= 0 || cell.kids[2] >= 0 || cell.kids[3] >= 0;
    const dx = cell.mx - node.x;
    const dy = cell.my - node.y;
    const d2 = dx * dx + dy * dy;

    // A leaf is summarised by its own members, which is the same sum done
    // exactly — and it is the one place the pair can be coincident, so it is
    // the one place the zero distance has to be handled rather than divided by.
    if (!isBranch) {
      for (const m of cell.members) if (m !== i) pairRepulsion(nodes, i, m, strength, alpha);
      continue;
    }

    if (cell.half * 2 * cell.half * 2 < d2 * THETA * THETA) {
      const d = Math.sqrt(d2);
      const force = (strength * cell.mass * alpha) / d;
      node.vx += (dx / d) * force;
      node.vy += (dy / d) * force;
      continue;
    }

    for (const m of cell.members) if (m !== i) pairRepulsion(nodes, i, m, strength, alpha);
    for (const kid of cell.kids) if (kid >= 0) stack.push(kid);
  }
}

/** The repulsion node `j` exerts on node `i`, added to `i`'s velocity alone. */
function pairRepulsion(
  nodes: SimNode[],
  i: number,
  j: number,
  strength: number,
  alpha: number,
): void {
  const node = nodes[i];
  const other = nodes[j];
  let dx = other.x - node.x;
  let dy = other.y - node.y;
  let d2 = dx * dx + dy * dy;

  if (d2 === 0) {
    // Coincident. Nudge along a fixed axis rather than a random one: a random
    // jitter is a layout that differs between two runs over the same vault, and
    // this is rare enough that the bias never shows. The *sign* comes from the
    // index order so the pair disagrees about which way apart is — a nudge both
    // of them read the same way moves them together and leaves them stuck.
    dx = j > i ? 1e-6 : -1e-6;
    dy = 0;
    d2 = 1e-12;
  }

  const d = Math.sqrt(d2);
  const force = (strength * alpha) / d;
  node.vx += (dx / d) * force;
  node.vy += (dy / d) * force;
}

/* ------------------------------------------------------------------ */
/* The step                                                            */
/* ------------------------------------------------------------------ */

/**
 * Advance the layout one frame.
 *
 * Returns `false` once `alpha` has fallen below `ALPHA_MIN`, which is the
 * caller's cue to stop asking for frames. A frozen simulation is not an error
 * state: it is the settled graph, and it stays exactly where it is until
 * something calls `reheat`.
 */
export function step(state: SimState, forces: SimForces): boolean {
  if (state.alpha < ALPHA_MIN) return false;

  const { nodes, edges } = state;
  const alpha = state.alpha;

  // Repulsion, over the quadtree.
  if (forces.repel > 0) {
    const tree = buildQuadtree(nodes);
    if (tree) {
      const strength = FORCE_SCALE.repel * forces.repel;
      for (let i = 0; i < nodes.length; i++) applyRepulsion(tree, nodes, i, strength, alpha);
    }
  }

  // Springs, along the edges.
  if (forces.link > 0) {
    for (const edge of edges) {
      const source = nodes[edge.source];
      const target = nodes[edge.target];
      if (!source || !target || source === target) continue;

      const dx = target.x + target.vx - (source.x + source.vx);
      const dy = target.y + target.vy - (source.y + source.vy);
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      // Stiffness is shared out by degree, d3's rule and for its reason: a hub
      // with three hundred edges would otherwise be pulled three hundred times
      // per frame and sit rigid while its whole fan orbits it.
      const stiffness =
        (FORCE_SCALE.link * forces.link) / Math.max(1, Math.min(source.degree, target.degree));
      const push = ((d - forces.linkDistance) / d) * alpha * stiffness;
      // The bias hands the displacement to the *less* connected end. Splitting
      // it evenly moves a hub as far as the leaf that just linked to it.
      const total = source.degree + target.degree || 2;
      const toTarget = source.degree / total;
      target.vx -= dx * push * toTarget;
      target.vy -= dy * push * toTarget;
      source.vx += dx * push * (1 - toTarget);
      source.vy += dy * push * (1 - toTarget);
    }
  }

  // Centering, toward the origin.
  if (forces.center > 0) {
    const pull = FORCE_SCALE.center * forces.center * alpha;
    for (const node of nodes) {
      node.vx -= node.x * pull;
      node.vy -= node.y * pull;
    }
  }

  // Integrate. A pinned node takes its position from the pin and keeps a zero
  // velocity, so releasing it does not launch whatever had built up.
  for (const node of nodes) {
    if (node.fx !== null) {
      node.x = node.fx;
      node.vx = 0;
    } else {
      node.vx *= VELOCITY_DECAY;
      node.x += node.vx;
    }
    if (node.fy !== null) {
      node.y = node.fy;
      node.vy = 0;
    } else {
      node.vy *= VELOCITY_DECAY;
      node.y += node.vy;
    }
  }

  state.alpha += (0 - state.alpha) * ALPHA_DECAY;
  return true;
}

/**
 * The exact all-pairs repulsion, which the quadtree approximates.
 *
 * Exported for the test that measures one against the other, and used nowhere
 * on the page: at `MAX_GRAPH_NODES` this is sixteen million distances a frame.
 */
export function repulsionExact(nodes: SimNode[], strength: number, alpha: number): void {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < nodes.length; j++) {
      // Through the same pair function the tree's leaves use, so the thing
      // being measured is the summarising and not two spellings of one force.
      if (i !== j) pairRepulsion(nodes, i, j, strength, alpha);
    }
  }
}
