import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  NODE_H,
  NODE_W,
  autoLayout,
  draftToGraph,
  freeSpot,
  layoutBounds,
  resolveLayout,
  resolveLinkRelease,
  type BlockDraft,
  type CanvasDraft,
  type LinkDraft,
} from "./canvasGraph";

/**
 * Three decisions on the canvas fail silently, and each one is here.
 *
 * A condition the operator never chose must reach the wire unchosen: filled in
 * with either value it is wrong half the time, and both ways of being wrong are
 * a billed agent — `on-success` terminates a chain that was meant to run
 * regardless, `on-finish` starts a run on top of a dependency that crashed. It
 * typechecks either way and nothing on the page would say.
 *
 * The layout has to survive a cycle, because a cycle is legal to *draw*: the
 * server is the authority on refusing one and can only answer about a graph it
 * has been sent, so a loop is on screen between the second click and the
 * answer. An unbounded relaxation there is a frozen tab, which no test of the
 * refusal itself would catch.
 *
 * And every block has to have a position. One without would render at the
 * origin under whatever is already there — invisible, still saved, still able
 * to start an agent.
 */

function block(id: string, over: Partial<BlockDraft> = {}): BlockDraft {
  return {
    id,
    name: id,
    kind: "run",
    templateId: "",
    mountId: "main",
    folder: "",
    task: "do the thing",
    promptOverride: "",
    fanOut: "3",
    mergeStrategy: "merge",
    mergeAutoResolve: false,
    ...over,
  };
}

function link(from: string, to: string, over: Partial<LinkDraft> = {}): LinkDraft {
  return { from, to, edge: "", continueBranch: false, ...over };
}

/* ------------------------------------------------------------------ */
/* The condition is the operator's, or it is absent                     */
/* ------------------------------------------------------------------ */

test("a link with no condition reaches the wire with none", () => {
  const draft: CanvasDraft = {
    blocks: [block("a"), block("b")],
    links: [link("a", "b")],
  };
  const wire = draftToGraph(draft);
  assert.equal(wire.edges.length, 1);
  assert.equal(wire.edges[0].edge, "", "an unanswered picker must not default");
  assert.equal(wire.edges[0].continueBranch, false);
});

test("a chosen condition and hand-over survive unchanged", () => {
  const wire = draftToGraph({
    blocks: [block("a"), block("b")],
    links: [link("a", "b", { edge: "on-finish", continueBranch: true })],
  });
  assert.deepEqual(wire.edges[0], {
    from: "a",
    to: "b",
    edge: "on-finish",
    continueBranch: true,
  });
});

test("a fan-out cap is carried only by the block that has one", () => {
  const wire = draftToGraph({
    blocks: [
      block("a"),
      block("b", { kind: "orchestrator", fanOut: "4" }),
      // Blank rather than absent: the operator cleared the field, and the
      // refusal naming the block is what has to come back.
      block("c", { kind: "orchestrator", fanOut: "" }),
    ],
    links: [],
  });
  assert.equal(wire.nodes[0].fanOut, null, "a run block states no cap");
  assert.equal(wire.nodes[1].fanOut, 4);
  assert.ok(
    wire.nodes[2].fanOut === null || (wire.nodes[2].fanOut ?? 0) < 1,
    "a blank cap must not arrive as a number the server would accept",
  );
});

test("no template is null on the wire, not an empty string", () => {
  const wire = draftToGraph({
    blocks: [block("a"), block("b", { templateId: "tpl-1" })],
    links: [],
  });
  assert.equal(wire.nodes[0].templateId, null);
  assert.equal(wire.nodes[1].templateId, "tpl-1");
});

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

test("a chain is laid out left to right, one column per step", () => {
  const blocks = [block("a"), block("b"), block("c")];
  const at = autoLayout(blocks, [link("a", "b"), link("b", "c")]);
  assert.ok(at.get("a")!.x < at.get("b")!.x);
  assert.ok(at.get("b")!.x < at.get("c")!.x);
});

test("blocks that wait for nothing share the first column", () => {
  // The parallel case, which is not a concept — it is what the graph says when
  // two blocks have nothing in front of them.
  const at = autoLayout([block("a"), block("b")], []);
  assert.equal(at.get("a")!.x, at.get("b")!.x);
  assert.notEqual(at.get("a")!.y, at.get("b")!.y);
});

test("a fan-in sits past the deepest thing it waits for", () => {
  const blocks = [block("a"), block("b"), block("c"), block("d")];
  const at = autoLayout(blocks, [
    link("a", "b"),
    link("b", "d"),
    link("c", "d"),
  ]);
  assert.ok(at.get("d")!.x > at.get("b")!.x);
  assert.ok(at.get("d")!.x > at.get("c")!.x);
});

test("a cycle is laid out rather than looped over", () => {
  const blocks = [block("a"), block("b"), block("c"), block("d")];
  const at = autoLayout(blocks, [
    link("a", "b"),
    link("b", "c"),
    link("c", "a"),
    link("a", "d"),
  ]);
  assert.equal(at.size, 4, "every block in a loop still gets a place");
  const seen = new Set(Array.from(at.values(), (p) => `${p.x},${p.y}`));
  assert.equal(seen.size, 4, "no two blocks may occupy one spot");
});

test("a block pointing at itself is drawn, not counted as a step", () => {
  const at = autoLayout([block("a")], [link("a", "a")]);
  assert.deepEqual(at.get("a"), { x: 24, y: 24 });
});

test("every block has a position, whatever was stored", () => {
  const blocks = [block("a"), block("b"), block("c")];
  const at = resolveLayout(blocks, [link("a", "b")], {
    a: { x: 500, y: 300 },
    // A block that has since been deleted, and a coordinate that is not one.
    gone: { x: 10, y: 10 },
    b: { x: Number.NaN, y: 0 },
    c: { x: -40, y: 12 },
  });
  assert.equal(at.size, 3);
  assert.deepEqual(at.get("a"), { x: 500, y: 300 }, "a dragged block stays put");
  assert.ok(Number.isFinite(at.get("b")!.x), "an unusable entry falls back");
  assert.ok(at.get("c")!.x >= 0, "a block may not be placed off the surface");
  assert.equal(at.has("gone"), false);
});

test("no stored layout at all is the same as a fresh graph", () => {
  const blocks = [block("a"), block("b")];
  const links = [link("a", "b")];
  assert.deepEqual(
    Array.from(resolveLayout(blocks, links, null)),
    Array.from(autoLayout(blocks, links)),
  );
});

test("the surface is big enough for the block furthest out", () => {
  const at = resolveLayout([block("a")], [], { a: { x: 900, y: 400 } });
  const { width, height } = layoutBounds(at);
  assert.ok(width >= 900 + NODE_W);
  assert.ok(height >= 400 + NODE_H);
});

test("a block added without a pointer lands clear of the others", () => {
  const at = resolveLayout([block("a"), block("b")], [], null);
  const spot = freeSpot(at);
  for (const p of at.values()) {
    assert.ok(spot.y > p.y, "a new block must not land on an existing one");
  }
});

test("an empty canvas still offers somewhere to put the first block", () => {
  const spot = freeSpot(new Map());
  assert.ok(spot.x >= 0 && spot.y >= 0);
});

/* ------------------------------------------------------------------ */
/* The Link handle                                                     */
/* ------------------------------------------------------------------ */

/**
 * Three gestures reach one control, and telling them apart is the whole of what
 * this decides. Getting it wrong is silent in the direction that matters: the
 * handle relabels itself **Link here**, the operator clicks it, the banner
 * changes to name a different block and no edge is drawn — a canvas that reads
 * as working and cannot connect two blocks by the one button labelled for it.
 * Nothing throws and the graph that is saved is simply smaller than the one on
 * screen.
 */

test("clicking Link here completes the link the other block armed", () => {
  // Armed from a, pressed and released on b's own handle. The direction is the
  // whole point: b starts after a, not the other way round.
  assert.deepEqual(resolveLinkRelease("b", "a", "b"), {
    kind: "connect",
    from: "a",
    to: "b",
  });
});

test("dragging out of a handle links from that handle's block", () => {
  // Even with another block armed: the pointer left this handle, so this block
  // is the source and the armed one is abandoned.
  assert.deepEqual(resolveLinkRelease("b", "a", "c"), {
    kind: "connect",
    from: "b",
    to: "c",
  });
  assert.deepEqual(resolveLinkRelease("b", null, "c"), {
    kind: "connect",
    from: "b",
    to: "c",
  });
});

test("clicking a handle with nothing armed arms it", () => {
  assert.deepEqual(resolveLinkRelease("a", null, "a"), {
    kind: "arm",
    from: "a",
  });
});

test("clicking the armed block's own handle disarms it", () => {
  // The same handle reads "Cancel" while it is armed, and that is what it does.
  assert.deepEqual(resolveLinkRelease("a", "a", "a"), { kind: "disarm" });
});

test("a drag that arrives nowhere leaves the handle armed", () => {
  // Released over bare canvas: nothing is connected and nothing is lost, so the
  // link can still be finished with a click on the target.
  assert.deepEqual(resolveLinkRelease("b", null, null), {
    kind: "arm",
    from: "b",
  });
  assert.deepEqual(resolveLinkRelease("b", "a", null), {
    kind: "arm",
    from: "b",
  });
});

test("no gesture on a handle ever links a block to itself", () => {
  // The server refuses a self-edge, but it can only answer about a graph it was
  // sent, and one drawn on the canvas is one the operator has to undo by hand.
  for (const armed of [null, "a", "b"]) {
    for (const over of [null, "a", "b"]) {
      const gesture = resolveLinkRelease("a", armed, over);
      if (gesture.kind !== "connect") continue;
      assert.notEqual(gesture.from, gesture.to, `armed=${armed} over=${over}`);
    }
  }
});
