import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { KnowledgeEdgeDTO, KnowledgeNodeDTO } from "./apiTypes";
import {
  GRAPH_DEFAULTS,
  GRAPH_RANGES,
  MAX_GROUPS,
  capGraph,
  coerceGraphSettings,
  defaultGraphSettings,
  filterGraph,
  groupIndexFor,
  localGraph,
  matchesGraphQuery,
  noteNodeId,
  parseGraphQuery,
  type GraphFilters,
  type GraphSlice,
} from "./knowledgeGraph";

/**
 * Every decision here fails silently, which is why they are all in one file.
 *
 * **The query is answered per keystroke and there is nothing to check it
 * against.** A term that parsed wrongly hides notes, and a graph with fewer
 * nodes in it looks exactly like a graph with fewer notes in it. The same
 * parser decides which colour group claims a node, so the same bug also paints
 * the wrong things.
 *
 * **The filter order decides what an orphan is.** Hiding attachments turns a
 * note whose only link was an embedded image into a note joined to nothing, so
 * an orphan filter answered against the *unfiltered* graph leaves it standing
 * in a view that was asked to hide orphans. Nothing throws either way.
 *
 * **The local graph is a traversal a person cannot verify by eye.** Depth,
 * direction and the neighbour-links toggle each change what is drawn, and a
 * wrong one reads as a vault with different links in it.
 *
 * **Saved settings are a browser value that survives an upgrade.** They arrive
 * as `unknown`, from a store an operator can edit and a previous release wrote,
 * and one field falling to `undefined` is a slider whose position is `NaN`.
 */

function note(path: string, over: Partial<KnowledgeNodeDTO> = {}): KnowledgeNodeDTO {
  return {
    id: noteNodeId(path),
    kind: "note",
    title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
    path,
    tags: [],
    aliases: [],
    inDegree: 0,
    outDegree: 0,
    ...over,
  };
}

function other(
  id: string,
  kind: KnowledgeNodeDTO["kind"],
  over: Partial<KnowledgeNodeDTO> = {},
): KnowledgeNodeDTO {
  return {
    id,
    kind,
    title: id.slice(id.indexOf(":") + 1),
    path: null,
    tags: [],
    aliases: [],
    inDegree: 0,
    outDegree: 0,
    ...over,
  };
}

function edge(from: string, to: string): KnowledgeEdgeDTO {
  return {
    from,
    to,
    kind: "wikilink",
    target: to,
    label: null,
    heading: null,
    block: null,
    line: 1,
    resolved: true,
    toNotePath: to.startsWith("note:") ? to.slice(5) : null,
  };
}

const FILTERS: GraphFilters = { ...GRAPH_DEFAULTS.filters };

/* -------------------------------- queries ------------------------------- */

test("an empty query matches every node", () => {
  const query = parseGraphQuery("   ");
  assert.equal(query.clauses.length, 0);
  assert.equal(matchesGraphQuery(note("a.md"), query), true);
});

test("bare terms are AND, and match title, alias, path and tag", () => {
  const target = note("Areas/Context rot.md", { aliases: ["Rot"], tags: ["research"] });

  assert.equal(matchesGraphQuery(target, parseGraphQuery("context rot")), true);
  assert.equal(matchesGraphQuery(target, parseGraphQuery("areas research")), true);
  assert.equal(matchesGraphQuery(target, parseGraphQuery("rot")), true, "an alias counts");
  assert.equal(matchesGraphQuery(target, parseGraphQuery("context missing")), false);
});

test("a quoted phrase stays one term, closed or not", () => {
  const target = note("Areas/Context rot.md");
  assert.equal(matchesGraphQuery(target, parseGraphQuery('"context rot"')), true);
  assert.equal(matchesGraphQuery(target, parseGraphQuery('"rot context"')), false);
  // Mid-typing: the closing quote has not been reached yet and the graph must
  // still answer, or the view blanks between the two keystrokes.
  assert.equal(matchesGraphQuery(target, parseGraphQuery('"context ro')), true);
});

test("a leading minus negates a term", () => {
  const kept = note("Areas/One.md", { tags: ["research"] });
  const dropped = note("Archive/Two.md", { tags: ["research"] });

  const query = parseGraphQuery("research -archive");
  assert.equal(matchesGraphQuery(kept, query), true);
  assert.equal(matchesGraphQuery(dropped, query), false);

  // A bare `-` is somebody about to type a term, not a negation of nothing.
  assert.equal(matchesGraphQuery(kept, parseGraphQuery("-")), true);
});

test("path:, file: and tag: each ask a different question", () => {
  const target = note("Areas/LLM/Context rot.md", { tags: ["research", "llm"] });

  assert.equal(matchesGraphQuery(target, parseGraphQuery("path:areas/llm")), true);
  assert.equal(matchesGraphQuery(target, parseGraphQuery("file:areas")), false, "file: is the basename");
  assert.equal(matchesGraphQuery(target, parseGraphQuery("file:context")), true);
  assert.equal(matchesGraphQuery(target, parseGraphQuery("tag:llm")), true);
  assert.equal(matchesGraphQuery(target, parseGraphQuery("tag:#llm")), true, "a written # is stripped");
  assert.equal(matchesGraphQuery(target, parseGraphQuery("tag:areas")), false);

  // A tag node answers to its own name, so `tag:` selects the tag itself too.
  assert.equal(matchesGraphQuery(other("tag:llm", "tag"), parseGraphQuery("tag:llm")), true);

  // Half a field prefix is a plain term, never a filter that matches nothing.
  assert.equal(matchesGraphQuery(target, parseGraphQuery("tag:")), true);
});

test("OR opens a second clause, and a leading or doubled OR does not blank the query", () => {
  const one = note("One.md");
  const two = note("Two.md");
  const neither = note("Three.md");

  const query = parseGraphQuery("one OR two");
  assert.equal(query.clauses.length, 2);
  assert.equal(matchesGraphQuery(one, query), true);
  assert.equal(matchesGraphQuery(two, query), true);
  assert.equal(matchesGraphQuery(neither, query), false);

  const ragged = parseGraphQuery("OR one OR OR two OR");
  assert.equal(ragged.clauses.length, 2);
  assert.equal(matchesGraphQuery(neither, ragged), false);
});

/* --------------------------------- groups ------------------------------- */

test("the first matching group wins, which is what the reorder controls are for", () => {
  const target = note("Areas/One.md", { tags: ["research"] });
  const research = parseGraphQuery("tag:research");
  const areas = parseGraphQuery("path:areas");

  assert.equal(groupIndexFor(target, [research, areas]), 0);
  assert.equal(groupIndexFor(target, [areas, research]), 0);
  assert.equal(groupIndexFor(note("Other.md"), [research, areas]), -1);
});

test("a group whose query is still empty claims nothing", () => {
  // The other reading paints the whole graph the instant Add group is pressed.
  assert.equal(groupIndexFor(note("a.md"), [parseGraphQuery("")]), -1);
  assert.equal(groupIndexFor(note("a.md"), [parseGraphQuery(""), parseGraphQuery("a")]), 1);
});

/* -------------------------------- filters ------------------------------- */

test("each kind toggle drops its own kind and the edges that reached it", () => {
  const graph: GraphSlice = {
    nodes: [
      note("a.md"),
      other("tag:x", "tag"),
      other("attachment:img.png", "attachment", { path: "img.png" }),
      other("phantom:ghost", "phantom"),
    ],
    edges: [
      edge(noteNodeId("a.md"), "tag:x"),
      edge(noteNodeId("a.md"), "attachment:img.png"),
      edge(noteNodeId("a.md"), "phantom:ghost"),
    ],
  };

  const bare = filterGraph(graph, FILTERS);
  assert.deepEqual(bare.nodes.map((n) => n.kind).sort(), ["note", "phantom"]);
  assert.equal(bare.edges.length, 1, "only the phantom edge has both ends left");

  const all = filterGraph(graph, { ...FILTERS, showTags: true, showAttachments: true });
  assert.equal(all.nodes.length, 4);
  assert.equal(all.edges.length, 3);

  const existing = filterGraph(graph, { ...FILTERS, existingOnly: true });
  assert.deepEqual(existing.nodes.map((n) => n.kind), ["note"]);
  assert.equal(existing.edges.length, 0);
});

test("orphan is decided against what the other filters left, not against the vault", () => {
  // `a.md`'s only link is to an attachment. Hide attachments and it is joined
  // to nothing — which is exactly what the orphan toggle is being asked about.
  const graph: GraphSlice = {
    nodes: [
      note("a.md"),
      other("attachment:img.png", "attachment", { path: "img.png" }),
      note("b.md"),
      note("c.md"),
    ],
    edges: [edge(noteNodeId("a.md"), "attachment:img.png"), edge(noteNodeId("b.md"), noteNodeId("c.md"))],
  };

  const hidden = filterGraph(graph, { ...FILTERS, showOrphans: false });
  assert.deepEqual(
    hidden.nodes.map((n) => n.path).sort(),
    ["b.md", "c.md"],
    "a.md is an orphan once its attachment is gone",
  );

  const withAttachments = filterGraph(graph, {
    ...FILTERS,
    showOrphans: false,
    showAttachments: true,
  });
  assert.equal(withAttachments.nodes.length, 4, "and it is not one when the attachment is drawn");
});

test("the search box narrows before orphans are counted", () => {
  const graph: GraphSlice = {
    nodes: [note("a.md"), note("b.md")],
    edges: [edge(noteNodeId("a.md"), noteNodeId("b.md"))],
  };
  const narrowed = filterGraph(graph, { ...FILTERS, query: "a.md", showOrphans: false });
  assert.equal(narrowed.nodes.length, 0, "a.md alone has nothing left to be joined to");
});

test("a self-link is never drawn", () => {
  const graph: GraphSlice = {
    nodes: [note("a.md")],
    edges: [edge(noteNodeId("a.md"), noteNodeId("a.md"))],
  };
  assert.equal(filterGraph(graph, FILTERS).edges.length, 0);
});

/* ----------------------------- the local graph -------------------------- */

/**
 *   hub ──▶ out1 ──▶ out2        in1 ──▶ hub        out1 ──▶ side
 * `side` is a neighbour of a neighbour reached the other way, which is what
 * `neighbourLinks` is about.
 */
function chain(): GraphSlice {
  const nodes = ["hub.md", "out1.md", "out2.md", "in1.md", "side.md"].map((p) => note(p));
  const id = noteNodeId;
  return {
    nodes,
    edges: [
      edge(id("hub.md"), id("out1.md")),
      edge(id("out1.md"), id("out2.md")),
      edge(id("in1.md"), id("hub.md")),
      edge(id("out1.md"), id("side.md")),
      edge(id("side.md"), id("out2.md")),
    ],
  };
}

const LOCAL = { depth: 1, incoming: true, outgoing: true, neighbourLinks: false };

test("depth is how many hops, and it is clamped to what the slider offers", () => {
  const graph = chain();
  const one = localGraph(graph, noteNodeId("hub.md"), LOCAL);
  assert.deepEqual(one.nodes.map((n) => n.path).sort(), ["hub.md", "in1.md", "out1.md"]);

  const two = localGraph(graph, noteNodeId("hub.md"), { ...LOCAL, depth: 2 });
  assert.deepEqual(
    two.nodes.map((n) => n.path).sort(),
    ["hub.md", "in1.md", "out1.md", "out2.md", "side.md"],
  );

  // A depth off the wire, or off a settings object an operator edited.
  const clamped = localGraph(graph, noteNodeId("hub.md"), { ...LOCAL, depth: 900 });
  assert.equal(clamped.nodes.length, 5);
  const floored = localGraph(graph, noteNodeId("hub.md"), { ...LOCAL, depth: 0 });
  assert.equal(floored.nodes.length, 3, "zero hops is one hop, never the focus alone");
});

test("each direction toggle drops the links it names", () => {
  const graph = chain();
  const outOnly = localGraph(graph, noteNodeId("hub.md"), { ...LOCAL, incoming: false });
  assert.deepEqual(outOnly.nodes.map((n) => n.path).sort(), ["hub.md", "out1.md"]);

  const inOnly = localGraph(graph, noteNodeId("hub.md"), { ...LOCAL, outgoing: false });
  assert.deepEqual(inOnly.nodes.map((n) => n.path).sort(), ["hub.md", "in1.md"]);

  const neither = localGraph(graph, noteNodeId("hub.md"), {
    ...LOCAL,
    incoming: false,
    outgoing: false,
  });
  assert.deepEqual(neither.nodes.map((n) => n.path), ["hub.md"]);
  assert.equal(neither.edges.length, 0);
});

test("neighbour links add the edges between neighbours that the walk did not use", () => {
  const graph = chain();
  const without = localGraph(graph, noteNodeId("hub.md"), { ...LOCAL, depth: 2 });
  const with_ = localGraph(graph, noteNodeId("hub.md"), {
    ...LOCAL,
    depth: 2,
    neighbourLinks: true,
  });

  assert.equal(with_.nodes.length, without.nodes.length, "the same nodes either way");
  // side → out2 joins two nodes both found at hop 2, so no traversal used it.
  assert.equal(without.edges.length, 4);
  assert.equal(with_.edges.length, 5);
});

test("a focus that is not in the graph answers with nothing, never with everything", () => {
  const graph = chain();
  const gone = localGraph(graph, noteNodeId("deleted.md"), LOCAL);
  assert.deepEqual(gone, { nodes: [], edges: [] });
});

/* ------------------------------- settings ------------------------------- */

test("settings out of storage are made total, whatever is in there", () => {
  assert.deepEqual(coerceGraphSettings(null), defaultGraphSettings());
  assert.deepEqual(coerceGraphSettings("not an object"), defaultGraphSettings());
  assert.deepEqual(coerceGraphSettings({}), defaultGraphSettings());

  const half = coerceGraphSettings({ view: "local", forces: { repel: 3 } });
  assert.equal(half.view, "local");
  assert.equal(half.forces.repel, 3);
  assert.equal(half.forces.link, GRAPH_DEFAULTS.forces.link, "a field nobody wrote keeps its default");
});

test("every slider is clamped on the way out of storage", () => {
  const wild = coerceGraphSettings({
    local: { depth: 99 },
    display: { nodeSize: -5, textFade: Number.NaN, linkThickness: "1" },
    forces: { center: 40, repel: -1, linkDistance: 10_000 },
  });

  assert.equal(wild.local.depth, GRAPH_RANGES.depth.max);
  assert.equal(wild.display.nodeSize, GRAPH_RANGES.nodeSize.min);
  assert.equal(wild.display.textFade, GRAPH_DEFAULTS.display.textFade, "NaN is not a position");
  assert.equal(wild.display.linkThickness, GRAPH_DEFAULTS.display.linkThickness);
  assert.equal(wild.forces.center, GRAPH_RANGES.center.max);
  assert.equal(wild.forces.repel, GRAPH_RANGES.repel.min);
  assert.equal(wild.forces.linkDistance, GRAPH_RANGES.linkDistance.max);
});

test("a stored group keeps its order, gets an id, and never carries an unusable colour", () => {
  const settings = coerceGraphSettings({
    groups: [
      { id: "g1", query: "tag:a", color: "#ff0000" },
      { query: "tag:b", color: "red" },
      null,
      { id: "g3", query: 7 },
    ],
  });

  assert.deepEqual(settings.groups.map((g) => g.query), ["tag:a", "tag:b", ""]);
  assert.equal(settings.groups[0].color, "#ff0000");
  assert.match(settings.groups[1].color, /^#[0-9a-f]{6}$/, "`red` is not what a canvas fill takes");
  assert.ok(settings.groups[1].id, "a group with no id has no React key and no colour input");
});

test("the stored group list is capped where the panel is", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, query: "a", color: "#112233" }));
  assert.equal(coerceGraphSettings({ groups: many }).groups.length, MAX_GROUPS);
});

test("reset hands back a fresh object, not the shared defaults", () => {
  const first = defaultGraphSettings();
  first.forces.repel = 19;
  first.groups.push({ id: "x", query: "a", color: "#000000" });

  assert.equal(GRAPH_DEFAULTS.forces.repel, 10);
  assert.equal(GRAPH_DEFAULTS.groups.length, 0);
  assert.equal(defaultGraphSettings().forces.repel, 10);
});

/* --------------------------------- the cap ------------------------------ */

test("over the cap the hubs are what survives, and the loss is reported", () => {
  const nodes = Array.from({ length: 10 }, (_, i) =>
    note(`n${i}.md`, { inDegree: i, outDegree: 0 }),
  );
  const graph: GraphSlice = {
    nodes,
    edges: [edge(noteNodeId("n9.md"), noteNodeId("n8.md")), edge(noteNodeId("n0.md"), noteNodeId("n1.md"))],
  };

  const capped = capGraph(graph, 3);
  assert.equal(capped.dropped, 7);
  assert.deepEqual(capped.nodes.map((n) => n.path), ["n9.md", "n8.md", "n7.md"]);
  assert.equal(capped.edges.length, 1, "an edge whose other end was dropped goes with it");

  const under = capGraph(graph, 50);
  assert.equal(under.dropped, 0);
  assert.equal(under.nodes.length, 10);
});
