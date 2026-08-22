/**
 * Every decision the knowledge graph makes that is not drawing: which nodes are
 * shown, which colour group claims one, what a local graph reaches, and what an
 * operator's saved settings are.
 *
 * Here rather than beside the component for the reason `canvasGraph.ts` states
 * at the top of its own file — `src/lib` is what `tsconfig.test.json` compiles,
 * so this is where a decision can be tested. Nothing below opens a file or a
 * database: it takes `KnowledgeGraphDTO` off the wire and answers questions
 * about it, which is also what makes it importable from a `"use client"` file.
 *
 * ## What "matching Obsidian" means here, and where it stops
 *
 * The controls, their ranges and their interactions are reimplemented from the
 * outside — Obsidian is closed source and none of its code is in this tree. The
 * one place the behaviour genuinely cannot follow is **content search**: a
 * query in Obsidian's graph also matches the text inside a note, and
 * `/api/knowledge/graph` sends no bodies. Sending 759 of them so the browser
 * could grep them is a payload nobody would want; the queries below match a
 * note's title, aliases, path and tags, and the panel says so.
 */

import type { KnowledgeEdgeDTO, KnowledgeNodeDTO } from "./apiTypes";

/** The node id `/api/knowledge/graph` gives a note, from its vault path.
 *
 * Owned here rather than in `knowledge.ts` because both sides need it and only
 * this one is client-safe: the page has a note *path* in the URL and needs the
 * *id* to focus a local graph on it. `knowledge.ts` imports it back. */
export function noteNodeId(path: string): string {
  return `note:${path}`;
}

/* ------------------------------------------------------------------ */
/* The query language                                                  */
/* ------------------------------------------------------------------ */

/** Which part of a node a term is asked about. */
export type GraphQueryField = "any" | "path" | "tag" | "file";

export interface GraphQueryTerm {
  field: GraphQueryField;
  /** Lower-cased at parse time: matching is a hot loop and case-folding a
   * needle once per query beats folding it once per node. */
  text: string;
  negated: boolean;
}

/**
 * A parsed query: OR-ed clauses, each a list of terms that must all hold.
 *
 * No clauses at all means an empty query, which matches everything — that is
 * the one reading that makes a blank search box show the whole vault rather
 * than nothing.
 */
export interface GraphQuery {
  clauses: GraphQueryTerm[][];
}

export const EMPTY_QUERY: GraphQuery = { clauses: [] };

/**
 * Split a query into tokens, keeping a `"quoted phrase"` whole.
 *
 * A closing quote is optional. Somebody typing a phrase has an unterminated
 * quote for as long as it takes them to type the second word, and a parser that
 * discarded the term until they closed it would blank the graph mid-keystroke.
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;

  for (const char of raw) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

const FIELDS: Record<string, GraphQueryField> = {
  path: "path",
  tag: "tag",
  file: "file",
};

/**
 * Parse a search query.
 *
 * The subset is `term`, `-term`, `"a phrase"`, `path:`, `file:`, `tag:`, and a
 * bare `OR` between clauses; whitespace is AND. What is deliberately not here:
 * parentheses, `line:`/`section:`/`block:`, and regular expressions. Each of
 * those only earns its complexity against note *content*, which is not on the
 * wire — see the note at the top of this file.
 *
 * A query this cannot make sense of is never an error. A search box answers
 * every keystroke, including the halves of a term, so an unparseable fragment
 * degrades to a plain substring rather than to an empty graph.
 */
export function parseGraphQuery(raw: string): GraphQuery {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return EMPTY_QUERY;

  const clauses: GraphQueryTerm[][] = [];
  let current: GraphQueryTerm[] = [];

  for (const token of tokens) {
    if (token === "OR") {
      // A leading or doubled `OR` would otherwise open an empty clause, and an
      // empty clause is one that matches everything — the whole query would go
      // inert at the moment somebody typed the O of it.
      if (current.length > 0) clauses.push(current);
      current = [];
      continue;
    }

    const negated = token.startsWith("-");
    const body = negated ? token.slice(1) : token;
    // A bare `-` is somebody about to type a term, not a negation of nothing.
    // Falling through would leave it a literal search for a hyphen, which
    // blanks the graph for as long as it takes to type the next character.
    if (!body) continue;

    const colon = body.indexOf(":");
    const prefix = colon > 0 ? body.slice(0, colon).toLowerCase() : "";
    const field = FIELDS[prefix];

    if (field) {
      const text = body.slice(colon + 1).replace(/^#/, "");
      // `tag:` on its own is somebody halfway through typing one.
      if (text) current.push({ field, text: text.toLowerCase(), negated });
      continue;
    }
    current.push({ field: "any", text: body.toLowerCase(), negated });
  }
  if (current.length > 0) clauses.push(current);

  return { clauses };
}

/** The haystacks a node offers each field, lower-cased once. */
function haystack(node: KnowledgeNodeDTO, field: GraphQueryField): string[] {
  switch (field) {
    case "path":
      return node.path ? [node.path.toLowerCase()] : [];
    case "tag":
      // A tag *node* answers to its own name as well as to its tags, so
      // `tag:project` selects both the notes carrying it and the tag itself.
      return node.kind === "tag"
        ? [node.title.toLowerCase()]
        : node.tags.map((t) => t.toLowerCase());
    case "file": {
      const base = node.path ? node.path.slice(node.path.lastIndexOf("/") + 1) : node.title;
      return [base.toLowerCase()];
    }
    case "any": {
      const parts = [node.title.toLowerCase(), ...node.aliases.map((a) => a.toLowerCase())];
      if (node.path) parts.push(node.path.toLowerCase());
      for (const tag of node.tags) parts.push(tag.toLowerCase());
      return parts;
    }
  }
}

function termHolds(node: KnowledgeNodeDTO, term: GraphQueryTerm): boolean {
  const hit = haystack(node, term.field).some((value) => value.includes(term.text));
  return term.negated ? !hit : hit;
}

/** Whether a node satisfies a parsed query. An empty query matches everything. */
export function matchesGraphQuery(node: KnowledgeNodeDTO, query: GraphQuery): boolean {
  if (query.clauses.length === 0) return true;
  return query.clauses.some((clause) => clause.every((term) => termHolds(node, term)));
}

/* ------------------------------------------------------------------ */
/* Colour groups                                                       */
/* ------------------------------------------------------------------ */

export interface GraphGroup {
  /** Stable across a reorder, so React keys and the colour input agree. */
  id: string;
  query: string;
  /** `#rrggbb`, which is the one form `<input type="color">` reads and writes. */
  color: string;
}

/**
 * Which group claims a node, by index, or `-1` for none.
 *
 * **First match wins**, which is why the panel can reorder groups and why the
 * order is drawn rather than implied: two groups whose queries overlap give
 * different pictures depending on which is above, and a list that did not show
 * its order would make that look like a bug in the colouring.
 */
export function groupIndexFor(node: KnowledgeNodeDTO, compiled: readonly GraphQuery[]): number {
  for (let i = 0; i < compiled.length; i++) {
    // A group with an empty query is one somebody has started and not finished.
    // Treated as matching nothing rather than as matching everything, because
    // the other reading paints the entire graph the instant **Add group** is
    // pressed and the operator never sees what they were adding it to.
    if (compiled[i].clauses.length === 0) continue;
    if (matchesGraphQuery(node, compiled[i])) return i;
  }
  return -1;
}

export interface GraphTag {
  /** As the vault spells it. */
  name: string;
  /** Notes carrying it. */
  count: number;
}

/**
 * The vault's tags, most-used first, then alphabetically.
 *
 * Counted off the note nodes rather than off the tag *nodes* the same fetch
 * carries: a tag node's `inDegree` counts links, and a note naming one tag in
 * its frontmatter and again in its body is still one note that has it. It also
 * keeps the list independent of `kinds=tag` being asked for.
 *
 * Folded case-insensitively, because `tag:` lower-cases both sides and so a
 * group for `#LLM` already paints `#llm` — two chips that paint the same nodes
 * would read as two different tags. The first spelling seen is the one shown,
 * which is arbitrary but stable: the walk returns notes in a fixed order.
 */
export function graphTags(graph: GraphSlice): GraphTag[] {
  const counts = new Map<string, GraphTag>();
  for (const node of graph.nodes) {
    if (node.kind !== "note") continue;
    // Per note, not per mention: the figure beside a chip is how many notes it
    // would paint, and a note counted twice makes the graph look bigger than
    // the picture the chip produces.
    const seen = new Set<string>();
    for (const raw of node.tags) {
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = counts.get(key);
      if (hit) hit.count += 1;
      else counts.set(key, { name: raw, count: 1 });
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/**
 * The query that paints one tag.
 *
 * Quoted only where it has to be: `tokenize` splits on whitespace, so a tag
 * with a space in it would otherwise arrive as `tag:my` and a stray `notes`.
 */
export function tagGroupQuery(tag: string): string {
  return /\s/.test(tag) ? `tag:"${tag}"` : `tag:${tag}`;
}

/** The id a tag's group carries, so a chip can find its own group back. */
export function tagGroupId(tag: string): string {
  return `tag-${tag.toLowerCase()}`;
}

/**
 * Colour groups for the vault's most-used tags, in palette order.
 *
 * What the panel opens on when nobody has set a colour group up yet — see the
 * seed in `KnowledgeGraphView`. Capped at `MAX_GROUPS` because that is what the
 * palette is: a vault with four hundred tags gets its top seven, and the rest
 * are a chip away.
 */
export function tagGroups(tags: readonly GraphTag[]): GraphGroup[] {
  return tags.slice(0, MAX_GROUPS).map((tag, i) => ({
    id: tagGroupId(tag.name),
    query: tagGroupQuery(tag.name),
    color: GROUP_PALETTE[i % GROUP_PALETTE.length],
  }));
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

export interface GraphFilters {
  /** Free text, in the language `parseGraphQuery` reads. */
  query: string;
  showTags: boolean;
  showAttachments: boolean;
  /** Hide the phantoms: a link naming a note nobody has written yet. */
  existingOnly: boolean;
  showOrphans: boolean;
}

export interface GraphSlice {
  nodes: KnowledgeNodeDTO[];
  edges: KnowledgeEdgeDTO[];
}

/**
 * The nodes and edges a set of filters leaves standing.
 *
 * The order the filters run in is the whole of this function and it is not
 * arbitrary. Kind and query go first; **orphan is computed last, over what
 * survived them**, because that is the only reading in which the toggle means
 * what it says. Hiding attachments turns a note whose only link was an embedded
 * image into a note joined to nothing — and an orphan filter that had been
 * decided against the unfiltered graph would then leave it on screen, alone, in
 * a graph the operator had just asked to show no orphans.
 *
 * Edges survive only when both ends do, so hiding a kind never leaves a line
 * running off to a node that is not there.
 */
export function filterGraph(graph: GraphSlice, filters: GraphFilters): GraphSlice {
  const query = parseGraphQuery(filters.query);

  const kept = new Map<string, KnowledgeNodeDTO>();
  for (const node of graph.nodes) {
    if (node.kind === "tag" && !filters.showTags) continue;
    if (node.kind === "attachment" && !filters.showAttachments) continue;
    if (node.kind === "phantom" && filters.existingOnly) continue;
    if (!matchesGraphQuery(node, query)) continue;
    kept.set(node.id, node);
  }

  const edges = graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to) && e.from !== e.to);

  if (filters.showOrphans) return { nodes: [...kept.values()], edges };

  const joined = new Set<string>();
  for (const edge of edges) {
    joined.add(edge.from);
    joined.add(edge.to);
  }
  return { nodes: [...kept.values()].filter((n) => joined.has(n.id)), edges };
}

/* ------------------------------------------------------------------ */
/* The local graph                                                     */
/* ------------------------------------------------------------------ */

export interface LocalGraphOptions {
  /** How many hops from the focus. 1–5, which is the range the panel offers. */
  depth: number;
  /** Follow edges *into* a node when deciding what is a neighbour. */
  incoming: boolean;
  /** Follow edges *out of* a node. */
  outgoing: boolean;
  /**
   * Draw the links **between** neighbours, not only the ones that reached them.
   *
   * Off, the picture is the traversal itself: a ring per hop and nothing across
   * a ring. On, it is the induced subgraph, which is denser and says which of
   * two neighbours are also each other's.
   */
  neighbourLinks: boolean;
}

/**
 * The neighbourhood of one node.
 *
 * Returns an empty slice when the focus is not in `graph` — a note filtered out
 * by the search box, or one whose path no longer resolves. Empty rather than
 * the whole graph: silently widening to everything is how a local view comes to
 * hang a tab that a global one was never asked to draw.
 *
 * With both directions off nothing is reachable and the answer is the focus
 * alone. That is deliberate and is what the panel shows: the two toggles
 * describe what a link *is* here, and a graph with no kind of link in it is one
 * node.
 */
export function localGraph(
  graph: GraphSlice,
  focusId: string,
  options: LocalGraphOptions,
): GraphSlice {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!byId.has(focusId)) return { nodes: [], edges: [] };

  const out = new Map<string, KnowledgeEdgeDTO[]>();
  const into = new Map<string, KnowledgeEdgeDTO[]>();
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    const forward = out.get(edge.from);
    if (forward) forward.push(edge);
    else out.set(edge.from, [edge]);
    const back = into.get(edge.to);
    if (back) back.push(edge);
    else into.set(edge.to, [edge]);
  }

  const depthOf = new Map<string, number>([[focusId, 0]]);
  const treeEdges = new Set<KnowledgeEdgeDTO>();
  let frontier = [focusId];
  const maxDepth = Math.max(1, Math.min(5, Math.floor(options.depth)));

  for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      const reachable: Array<[KnowledgeEdgeDTO, string]> = [];
      if (options.outgoing) for (const e of out.get(id) ?? []) reachable.push([e, e.to]);
      if (options.incoming) for (const e of into.get(id) ?? []) reachable.push([e, e.from]);

      for (const [edge, other] of reachable) {
        if (!byId.has(other)) continue;
        // Recorded even when the other end is already known: an edge between
        // two nodes on the same ring was still walked, and dropping it would
        // make two hops of a cycle look like a line that stops.
        treeEdges.add(edge);
        if (depthOf.has(other)) continue;
        depthOf.set(other, hop);
        next.push(other);
      }
    }
    frontier = next;
  }

  const nodes = [...depthOf.keys()].map((id) => byId.get(id) as KnowledgeNodeDTO);
  const edges = options.neighbourLinks
    ? graph.edges.filter((e) => depthOf.has(e.from) && depthOf.has(e.to) && e.from !== e.to)
    : graph.edges.filter((e) => treeEdges.has(e));

  return { nodes, edges };
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type GraphView = "global" | "local";

export interface GraphDisplay {
  /** Draw the direction a link was written in. */
  arrows: boolean;
  /**
   * The zoom at which labels start to appear, on the scale zoom itself uses.
   *
   * A threshold rather than a boolean because the two failure modes are
   * opposite: labels at every zoom turn a settled global graph into a wall of
   * overlapping text, and no labels at all make a local graph unreadable.
   */
  textFade: number;
  /** Multiplier on the radius a node's degree earns it. */
  nodeSize: number;
  /** Multiplier on a link's stroke width. */
  linkThickness: number;
  /** Off freezes the layout where it stands and stops asking for frames. */
  animate: boolean;
}

export interface KnowledgeGraphSettings {
  view: GraphView;
  local: LocalGraphOptions;
  filters: GraphFilters;
  groups: GraphGroup[];
  display: GraphDisplay;
  forces: {
    center: number;
    repel: number;
    link: number;
    linkDistance: number;
  };
}

/**
 * What the panel opens on before anybody touches it.
 *
 * `showOrphans` is on and `existingOnly` is off, which is the honest default
 * for *this* app: the page's own health card counts orphans and broken links as
 * things to go and fix, and a graph that hid both by default would be a second
 * view of the vault that disagrees with the first about what is in it.
 */
export const GRAPH_DEFAULTS: KnowledgeGraphSettings = {
  view: "global",
  local: { depth: 1, incoming: true, outgoing: true, neighbourLinks: false },
  filters: {
    query: "",
    showTags: false,
    showAttachments: false,
    existingOnly: false,
    showOrphans: true,
  },
  groups: [],
  display: { arrows: false, textFade: 1.1, nodeSize: 1, linkThickness: 1, animate: true },
  forces: { center: 0.4, repel: 10, link: 0.6, linkDistance: 90 },
};

/** The ranges every slider is clamped to, on the way in and on the way out. */
export const GRAPH_RANGES = {
  depth: { min: 1, max: 5, step: 1 },
  textFade: { min: 0, max: 3, step: 0.05 },
  nodeSize: { min: 0.2, max: 3, step: 0.05 },
  linkThickness: { min: 0.2, max: 4, step: 0.05 },
  center: { min: 0, max: 1, step: 0.01 },
  repel: { min: 0, max: 20, step: 0.1 },
  link: { min: 0, max: 1, step: 0.01 },
  linkDistance: { min: 30, max: 500, step: 1 },
} as const;

function clamp(value: unknown, fallback: number, range: { min: number; max: number }): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, value))
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** `#rrggbb` and nothing else: the value goes onto a canvas fill, where a
 * malformed one is silently ignored and the node keeps the last colour drawn. */
function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * A settings object out of storage, made total.
 *
 * Every field is read defensively and falls back to its default rather than
 * failing the parse. What is stored is a browser value an operator can edit,
 * that survives an upgrade which added a field, and whose loss costs the panel
 * settings and nothing else — so a half-readable one is worth more than a
 * refusal to open the page.
 */
export function coerceGraphSettings(raw: unknown): KnowledgeGraphSettings {
  if (!raw || typeof raw !== "object") return structuredCloneDefaults();
  const source = raw as Record<string, unknown>;
  const base = structuredCloneDefaults();

  if (source.view === "local" || source.view === "global") base.view = source.view;

  const local = (source.local ?? {}) as Record<string, unknown>;
  base.local = {
    depth: clamp(local.depth, base.local.depth, GRAPH_RANGES.depth),
    incoming: bool(local.incoming, base.local.incoming),
    outgoing: bool(local.outgoing, base.local.outgoing),
    neighbourLinks: bool(local.neighbourLinks, base.local.neighbourLinks),
  };

  const filters = (source.filters ?? {}) as Record<string, unknown>;
  base.filters = {
    query: typeof filters.query === "string" ? filters.query : base.filters.query,
    showTags: bool(filters.showTags, base.filters.showTags),
    showAttachments: bool(filters.showAttachments, base.filters.showAttachments),
    existingOnly: bool(filters.existingOnly, base.filters.existingOnly),
    showOrphans: bool(filters.showOrphans, base.filters.showOrphans),
  };

  if (Array.isArray(source.groups)) {
    base.groups = source.groups
      .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
      .map((g, i) => ({
        id: typeof g.id === "string" && g.id ? g.id : `group-${i}`,
        query: typeof g.query === "string" ? g.query : "",
        color: isHexColor(g.color) ? g.color : GROUP_PALETTE[i % GROUP_PALETTE.length],
      }))
      .slice(0, MAX_GROUPS);
  }

  const display = (source.display ?? {}) as Record<string, unknown>;
  base.display = {
    arrows: bool(display.arrows, base.display.arrows),
    textFade: clamp(display.textFade, base.display.textFade, GRAPH_RANGES.textFade),
    nodeSize: clamp(display.nodeSize, base.display.nodeSize, GRAPH_RANGES.nodeSize),
    linkThickness: clamp(
      display.linkThickness,
      base.display.linkThickness,
      GRAPH_RANGES.linkThickness,
    ),
    animate: bool(display.animate, base.display.animate),
  };

  const forces = (source.forces ?? {}) as Record<string, unknown>;
  base.forces = {
    center: clamp(forces.center, base.forces.center, GRAPH_RANGES.center),
    repel: clamp(forces.repel, base.forces.repel, GRAPH_RANGES.repel),
    link: clamp(forces.link, base.forces.link, GRAPH_RANGES.link),
    linkDistance: clamp(
      forces.linkDistance,
      base.forces.linkDistance,
      GRAPH_RANGES.linkDistance,
    ),
  };

  return base;
}

/** Deep enough to be safe: `GRAPH_DEFAULTS` is shared and must stay pristine. */
function structuredCloneDefaults(): KnowledgeGraphSettings {
  return {
    view: GRAPH_DEFAULTS.view,
    local: { ...GRAPH_DEFAULTS.local },
    filters: { ...GRAPH_DEFAULTS.filters },
    groups: GRAPH_DEFAULTS.groups.map((g) => ({ ...g })),
    display: { ...GRAPH_DEFAULTS.display },
    forces: { ...GRAPH_DEFAULTS.forces },
  };
}

/** A fresh copy of the defaults, which is what **Reset** writes. */
export function defaultGraphSettings(): KnowledgeGraphSettings {
  return structuredCloneDefaults();
}

/**
 * Colours a new group is offered, in order.
 *
 * Chosen to stay apart from each other and from the graph's own palette on both
 * themes, and deliberately not the app's `--accent`: a group that happened to
 * match the accent would be indistinguishable from the node under the pointer.
 */
export const GROUP_PALETTE = [
  "#e0576a",
  "#e08a2e",
  "#c9b022",
  "#4aa564",
  "#3a9ec2",
  "#7b7ae0",
  "#b062c4",
] as const;

/** More than this is a legend nobody reads, and seven distinct colours is
 * already past what most people can tell apart on a dim node. */
export const MAX_GROUPS = 7;

/**
 * The most tag chips the panel offers.
 *
 * Bounded by count rather than put in a scroll box, and the bound is small
 * because only `MAX_GROUPS` of them can be on at once — a longer list is chips
 * nobody can spend. A vault carrying four hundred tags would otherwise grow the
 * panel without limit, and the panel is now what gives the canvas beside it its
 * height, so an unbounded list is an unbounded graph box as well. What is past
 * the cap is still reachable: `tag:` typed into a group is the same rule.
 */
export const MAX_TAG_CHOICES = 12;

/**
 * The most nodes the canvas will lay out.
 *
 * Below `MAX_GRAPH_NODES`, which is what the API will *send*, because the two
 * limits protect different things: the server's stops an answer being enormous,
 * and this one stops a tab going unresponsive. Reported on the page rather than
 * applied silently — a graph cut to its first 2000 nodes looks exactly like a
 * vault with 2000 notes in it.
 */
export const MAX_DRAWN_NODES = 2500;

/**
 * The nodes to draw, largest first, and how many were dropped.
 *
 * By degree rather than by the order the walk found them: over the cap, the
 * question the picture still answers is which notes are hubs, and an
 * alphabetical prefix of the vault answers nothing at all.
 */
export function capGraph(graph: GraphSlice, limit = MAX_DRAWN_NODES): GraphSlice & {
  dropped: number;
} {
  if (graph.nodes.length <= limit) return { ...graph, dropped: 0 };

  const ranked = [...graph.nodes].sort(
    (a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree),
  );
  const nodes = ranked.slice(0, limit);
  const kept = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    edges: graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
    dropped: graph.nodes.length - limit,
  };
}
