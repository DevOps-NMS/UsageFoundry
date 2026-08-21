import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildIndex,
  clearKnowledgeCache,
  extractHeadings,
  extractLinks,
  knowledgeBrowse,
  knowledgeHealth,
  knowledgeIndex,
  normalizeSubpath,
  noteFolder,
  noteType,
  parseFrontmatter,
  parseNote,
  searchKnowledge,
  splitFrontmatter,
  stripCode,
  type ParsedNote,
} from "./knowledge";

/**
 * The vault parser, its resolver and its cache.
 *
 * Every failure mode here is silent, which is the bar `docs/agent/testing.md`
 * sets. A link form the scanner does not know is not an error: it is a note
 * that reads as having fewer connections than it has, on a page whose whole
 * purpose is to show connections. A resolution order that puts aliases before
 * filenames draws edges nobody wrote. And a cache that does not notice an
 * edited file shows yesterday's graph indefinitely, with a "last scan" beside
 * it saying the scan just happened.
 *
 * ## Why the fixture is a literal
 *
 * There is no fixture-directory convention in this repo — every test that needs
 * files builds them in `fs.mkdtempSync` and removes them in `after()`, which is
 * what this does. Declaring the vault as a `Record<path, contents>` keeps the
 * fixture in git where it can be read beside the assertions, and materialising
 * it on disk is what makes the last test in this file possible at all: cache
 * invalidation is a claim about `mtimeMs` and `size`, and nothing that is not a
 * real file has either.
 */

const VAULT: Record<string, string> = {
  "INDEX.md": [
    "---",
    "title: Vault Index",
    "tags: [type/moc, status/stable]",
    "aliases: [Home, Start Here]",
    'related: ["[[Terraform State]]", "[[Nothing Written Yet]]"]',
    "sources:",
    '  - "https://example.com/a:b"',
    "  - https://example.com/second",
    "nested:",
    "  depth: 2",
    "  label: inner",
    "---",
    "",
    "# Vault Index",
    "",
    "Start at [[Terraform State]] or the [[Terraform State|state file]].",
    "Jump to [[Terraform State#Locking]] and to [[Terraform State#^abc123]].",
    "See the diagram: ![[diagrams/state.png]]",
    "And a markdown link to [locking](3%20Resources/State%20Locking.md).",
    "",
    "```bash",
    "# not a tag",
    "echo '[[Not A Link]]'",
    "```",
    "",
    "Inline `#alsonottag` and `[[also not a link]]` stay out.",
    "",
    "#topic/terraform #1 https://example.com#fragment",
  ].join("\n"),

  "3 Resources/Terraform State.md": [
    "---",
    "title: Terraform State",
    "aliases:",
    "  - tfstate",
    "  - The State File",
    "tags:",
    "  - topic/terraform/state",
    "---",
    "",
    "# Terraform State",
    "",
    "## Locking",
    "",
    "Back to [[INDEX]] and across to [[State Locking]].",
    "A path link: [[3 Resources/State Locking]].",
    "A dangling one: [[Nothing Written Yet]].",
  ].join("\n"),

  "3 Resources/State Locking.md": [
    "# State Locking",
    "",
    "Written up in [[tfstate]] — the alias, not the filename.",
    "",
    "#topic/terraform",
  ].join("\n"),

  // Same basename as the note above, one level deeper. A bare `[[State
  // Locking]]` has to reach the shallower one.
  "4 Archive/old/State Locking.md": ["# State Locking (archived)", "", "Superseded."].join("\n"),

  "1 Projects/Lonely.md": [
    "---",
    "tags: [status/seed]",
    "---",
    "",
    "# Lonely",
    "",
    "Nothing links here and this links to nothing. #status/seed",
  ].join("\n"),

  // Skipped by the walk, all three: a dot-directory, the vault's own config,
  // and a name in `SKIP_DIRS`.
  ".obsidian/plugins/notes.md": "# Should never be indexed",
  ".git/COMMIT_EDITMSG.md": "# Nor this",
  "node_modules/pkg/README.md": "# Nor this either",

  "diagrams/state.png": "not really a png",
};

function materialize(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-knowledge-"));
  for (const [rel, contents] of Object.entries(VAULT)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

const ROOT = materialize();
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** A fresh index of the fixture, from cold. */
function index() {
  clearKnowledgeCache();
  return knowledgeIndex(ROOT);
}

/* ------------------------------- parsing -------------------------------- */

test("frontmatter keeps arbitrary keys, nested maps and both sequence forms", () => {
  const { front, body } = splitFrontmatter(VAULT["INDEX.md"]);
  assert.ok(front.includes("title: Vault Index"));
  assert.ok(body.startsWith("\n# Vault Index"), "the body kept the frontmatter fence");

  const fm = parseFrontmatter(front);
  assert.equal(fm.title, "Vault Index");
  assert.deepEqual(fm.tags, ["type/moc", "status/stable"], "an inline flow sequence");
  assert.deepEqual(
    fm.sources,
    ["https://example.com/a:b", "https://example.com/second"],
    "a block sequence, and a URL's colon is not a key separator",
  );
  // The payload promises arbitrary keys survive, so a key nothing here knows
  // about has to come through rather than be dropped to keep the shape tidy.
  assert.deepEqual(fm.nested, { depth: 2, label: "inner" });
});

test("a note with no frontmatter is not read as having some", () => {
  const { front, body } = splitFrontmatter(VAULT["3 Resources/State Locking.md"]);
  assert.equal(front, "");
  assert.equal(body, VAULT["3 Resources/State Locking.md"]);
});

test("code fences and inline spans carry no links and no tags", () => {
  const stripped = stripCode(VAULT["INDEX.md"]);
  assert.ok(!stripped.includes("Not A Link"), "a fenced block still yields a link");
  assert.ok(!stripped.includes("alsonottag"), "an inline span still yields a tag");
  assert.equal(
    stripped.length,
    VAULT["INDEX.md"].length,
    "blanking must preserve every offset, or a link's reported line is wrong",
  );
});

test("every link form Obsidian writes is recognised", () => {
  const note = parseNote("INDEX.md", VAULT["INDEX.md"]);
  const wiki = note.links.filter((l) => l.kind !== "tag");

  const plain = wiki.find((l) => l.target === "Terraform State" && !l.label && !l.heading);
  assert.ok(plain, "[[note]]");

  const aliased = wiki.find((l) => l.label === "state file");
  assert.ok(aliased, "[[note|alias]]");
  assert.equal(aliased.target, "Terraform State");

  const heading = wiki.find((l) => l.heading === "Locking");
  assert.ok(heading, "[[note#heading]]");
  assert.equal(heading.target, "Terraform State");

  const block = wiki.find((l) => l.block === "abc123");
  assert.ok(block, "[[note#^block]]");

  const embed = wiki.find((l) => l.kind === "embed");
  assert.ok(embed, "![[embed]]");
  assert.equal(embed.target, "diagrams/state.png");

  const markdown = wiki.find((l) => l.kind === "markdown");
  assert.ok(markdown, "a markdown link to a local .md file");
  assert.equal(markdown.target, "3 Resources/State Locking.md", "percent-escapes are decoded");
  assert.equal(markdown.label, "locking");

  // Frontmatter wikilinks are edges in Obsidian's own graph, and this vault
  // carries its map-of-content links in a `related:` property — reading the
  // body alone would report them as absent.
  assert.ok(
    wiki.some((l) => l.target === "Nothing Written Yet"),
    "a wikilink written in frontmatter",
  );
});

test("tags come from the body and the frontmatter, and nothing else does", () => {
  const note = parseNote("INDEX.md", VAULT["INDEX.md"]);
  assert.ok(note.tags.includes("type/moc"), "a frontmatter tag");
  assert.ok(note.tags.includes("topic/terraform"), "a body tag");
  // `#1` is an issue number and `#fragment` is part of a URL. Both would be
  // nodes in the graph if the boundary rules were loose, and both are the kind
  // of noise that makes a tag list useless without anything ever failing.
  assert.ok(!note.tags.includes("1"), "an issue number became a tag");
  assert.ok(!note.tags.includes("fragment"), "a URL fragment became a tag");
});

test("aliases and headings are read in both YAML spellings", () => {
  const note = parseNote("3 Resources/Terraform State.md", VAULT["3 Resources/Terraform State.md"]);
  assert.deepEqual(note.aliases, ["tfstate", "The State File"]);
  assert.deepEqual(note.tags, ["topic/terraform/state"]);
  assert.equal(note.title, "Terraform State");

  const headings = extractHeadings(splitFrontmatter(VAULT["INDEX.md"]).body);
  assert.deepEqual(
    headings.map((h) => [h.level, h.text]),
    [[1, "Vault Index"]],
    "a heading inside a fence is not a heading",
  );
});

test("a link with no target is not an edge", () => {
  // `[[#Locking]]` is a jump inside the same note. Recorded as an edge it would
  // give every note a self-link and hide it from the orphan list.
  const links = extractLinks("See [[#Locking]] below.");
  assert.deepEqual(links, []);
});

/* ------------------------------ resolution ------------------------------ */

test("a bare name resolves by basename, shallowest first", () => {
  const idx = index();
  const from = idx.notes.get("3 Resources/Terraform State.md");
  assert.ok(from);
  const out = idx.outgoing.get("note:3 Resources/Terraform State.md") ?? [];

  const bare = out.find((e) => e.target === "State Locking");
  assert.ok(bare, "the bare-name link is missing");
  assert.equal(
    bare.to,
    "note:3 Resources/State Locking.md",
    "a bare name reached the deeper of two files with that basename",
  );
});

test("a path resolves by its suffix, and an alias resolves last", () => {
  const idx = index();
  const fromState = idx.outgoing.get("note:3 Resources/Terraform State.md") ?? [];
  const byPath = fromState.find((e) => e.target === "3 Resources/State Locking");
  assert.ok(byPath, "the path link is missing");
  assert.equal(byPath.to, "note:3 Resources/State Locking.md");

  const fromLocking = idx.outgoing.get("note:3 Resources/State Locking.md") ?? [];
  const byAlias = fromLocking.find((e) => e.target === "tfstate");
  assert.ok(byAlias, "the alias link is missing");
  assert.equal(byAlias.to, "note:3 Resources/Terraform State.md");
  assert.equal(byAlias.resolved, true);
});

test("a filename beats an alias that names something else", () => {
  // The order this pins: were aliases tried first, giving one note an alias
  // equal to another note's filename would silently repoint every link written
  // with that filename — an edge nobody wrote, and no error anywhere.
  const notes = new Map<string, ParsedNote>();
  const add = (rel: string, raw: string) => {
    notes.set(rel, { ...parseNote(rel, raw), abs: rel, mtimeMs: 0, size: raw.length });
  };
  add("Real.md", "# Real");
  add("Impostor.md", ["---", "aliases: [Real]", "---", "", "# Impostor"].join("\n"));
  add("Source.md", "Points at [[Real]].");

  const idx = buildIndex("/nowhere", notes, new Map(), false);
  const out = idx.outgoing.get("note:Source.md") ?? [];
  assert.equal(out.length, 1);
  assert.equal(out[0].to, "note:Real.md", "an alias outranked a real filename");
});

test("a link that resolves to nothing is recorded as broken, never dropped", () => {
  const idx = index();

  const broken = idx.brokenLinks.filter((b) => b.target === "Nothing Written Yet");
  assert.equal(broken.length, 2, "both notes naming the missing target should be listed");
  assert.ok(
    broken.every((b) => b.line > 0),
    "a broken link with no line cannot be found in the note",
  );

  // And it is still an edge, to a node flagged as a phantom — this is how a
  // vault records an intention, and dropping it is what turns "340 dangling
  // links" into a graph that reads as complete.
  const phantom = [...idx.nodes.values()].find((n) => n.kind === "phantom");
  assert.ok(phantom, "no phantom node for an unresolved target");
  assert.equal(phantom.title, "Nothing Written Yet");
  assert.equal(phantom.inDegree, 2);
  assert.ok(
    idx.edges.some((e) => e.to === phantom.id && !e.resolved),
    "the unresolved edge is not on the wire",
  );
});

test("an embedded attachment resolves to an attachment node, not a phantom", () => {
  const idx = index();
  const attachment = [...idx.nodes.values()].find((n) => n.kind === "attachment");
  assert.ok(attachment, "the embedded png was not resolved");
  assert.equal(attachment.path, "diagrams/state.png");
  assert.ok(
    !idx.brokenLinks.some((b) => b.target === "diagrams/state.png"),
    "a file that exists was reported as a broken link",
  );
});

/* -------------------------------- graph --------------------------------- */

test("the walk skips dot-directories and the shared skip set", () => {
  const idx = index();
  const paths = [...idx.notes.keys()];
  assert.ok(!paths.some((p) => p.startsWith(".obsidian/")), "the vault's config was indexed");
  assert.ok(!paths.some((p) => p.startsWith(".git/")), ".git was indexed");
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")), "node_modules was indexed");
  assert.equal(idx.notes.size, 5, "the fixture has five real notes");
});

test("a tag becomes a node whether it was written in the body or the frontmatter", () => {
  const idx = index();
  const tags = [...idx.nodes.values()].filter((n) => n.kind === "tag").map((n) => n.title);

  assert.ok(tags.includes("topic/terraform"), "a body tag is not a node");
  // The one that was missing: this vault writes every tag as a property, so a
  // reader that only scanned bodies reported 95 tags as none — and a count of
  // zero reads as a fact about the vault rather than about the reader.
  assert.ok(tags.includes("type/moc"), "a frontmatter tag is not a node");
  assert.ok(tags.includes("status/seed"), "a frontmatter tag on a tags-only note is not a node");

  const seed = idx.nodes.get("tag:status/seed");
  assert.ok(seed);
  assert.equal(seed.inDegree, 1, "the tag node has no edge into it");
});

test("orphans are notes joined to no other note, and tags do not count", () => {
  const idx = index();
  assert.deepEqual(
    idx.orphans,
    ["1 Projects/Lonely.md", "4 Archive/old/State Locking.md"],
    "a note carrying only tags is exactly what this list is for",
  );
});

test("backlinks are the incoming edges, and degrees agree with them", () => {
  const idx = index();
  const id = "note:3 Resources/Terraform State.md";
  const incoming = idx.backlinks.get(id) ?? [];
  assert.ok(incoming.length >= 2, "INDEX.md and State Locking.md both link here");
  assert.ok(incoming.every((e) => e.to === id));

  const node = idx.nodes.get(id);
  assert.ok(node);
  assert.equal(node.inDegree, incoming.length, "inDegree disagrees with the backlinks");
  assert.equal(
    node.outDegree,
    (idx.outgoing.get(id) ?? []).length,
    "outDegree disagrees with the outgoing edges",
  );
});

test("search finds a note by title, alias, tag and path", () => {
  const idx = index();
  const byTitle = searchKnowledge(idx, "Terraform State");
  assert.equal(byTitle[0]?.path, "3 Resources/Terraform State.md");
  assert.equal(byTitle[0]?.matched, "title");

  const byAlias = searchKnowledge(idx, "tfstate");
  assert.equal(byAlias[0]?.path, "3 Resources/Terraform State.md");
  assert.equal(byAlias[0]?.matched, "alias");

  assert.ok(searchKnowledge(idx, "status/seed").some((h) => h.path === "1 Projects/Lonely.md"));
  assert.ok(searchKnowledge(idx, "4 Archive").some((h) => h.path.startsWith("4 Archive/")));
  assert.deepEqual(searchKnowledge(idx, "   "), [], "a blank query is not a match-everything");
});

/* ------------------------- browsing and health --------------------------- */

/**
 * An index built from text alone, so a case can name the notes it needs.
 *
 * The fixture above is a vault, not a table: it has no `type:` property on any
 * note and five notes is not enough to page. Both would be a fixture edit that
 * every assertion above this line would have to be re-read against.
 */
function synthetic(notes: Array<{ rel: string; raw: string; mtimeMs?: number }>) {
  const parsed = new Map<string, ParsedNote>();
  for (const { rel, raw, mtimeMs } of notes) {
    parsed.set(rel, { ...parseNote(rel, raw), abs: rel, mtimeMs: mtimeMs ?? 0, size: raw.length });
  }
  return buildIndex("/nowhere", parsed, new Map(), false);
}

const paths = (view: { notes: Array<{ path: string }> }) => view.notes.map((n) => n.path);

test("a folder filter selects everything beneath it, not what sits directly in it", () => {
  const idx = index();
  assert.equal(noteFolder("4 Archive/old/State Locking.md"), "4 Archive/old");
  assert.equal(noteFolder("INDEX.md"), "", "a note at the root is in no folder");

  // `4 Archive` holds no note of its own — the one note is a level down. An
  // equality test answers zero here, and zero reads as an empty folder rather
  // than as the wrong question, which is the whole reason this is pinned.
  assert.deepEqual(paths(knowledgeBrowse(idx, { folder: "4 Archive" })), [
    "4 Archive/old/State Locking.md",
  ]);
  assert.equal(knowledgeBrowse(idx, { folder: "3 Resources" }).total, 2);
  assert.equal(knowledgeBrowse(idx, {}).total, 5, "no folder is the whole vault");
  assert.equal(knowledgeBrowse(idx, { folder: "/3 Resources/" }).total, 2, "one spelling");
  // A prefix that is not a path segment is not a folder. `3 Res` matching
  // `3 Resources` would be a filter nobody could have chosen from the facets.
  assert.equal(knowledgeBrowse(idx, { folder: "3 Res" }).total, 0);
});

test("a filter's own values are counted over the whole vault", () => {
  const idx = index();
  const seeded = knowledgeBrowse(idx, { tag: "status/seed" });
  assert.deepEqual(paths(seeded), ["1 Projects/Lonely.md"]);

  // Counted over the vault rather than over the one matched note: a facet list
  // narrowed to the result set offers only the filter you already have, and the
  // way out of it is the browser's back button.
  const folder = (value: string) => seeded.folders.find((f) => f.value === value)?.count;
  assert.equal(folder("3 Resources"), 2);
  // One entry per ancestor, because selecting `4 Archive` is what shows the
  // note beneath it.
  assert.equal(folder("4 Archive"), 1);
  assert.equal(folder("4 Archive/old"), 1);
  assert.equal(folder(""), undefined, "the vault root is not a folder to select");

  assert.equal(seeded.tags.find((t) => t.value === "topic/terraform")?.count, 2);
  assert.equal(seeded.total, 1, "the counts are the vault's, the total is the filter's");
});

test("a note's type is a frontmatter property and is never guessed", () => {
  // INDEX.md is tagged `type/moc`, which is how this vault says what a note is
  // — and is still not a `type:` property. Reading it as one fills the filter
  // with values the operator never wrote and cannot correct from Obsidian.
  const idx = index();
  const indexEntry = knowledgeBrowse(idx, { q: "INDEX" }).notes[0];
  assert.equal(indexEntry?.path, "INDEX.md");
  assert.equal(indexEntry?.type, null);
  assert.deepEqual(knowledgeBrowse(idx).types, [], "a tag was read as a type");

  assert.equal(noteType({ type: "  reference  " }), "reference");
  assert.equal(noteType({ type: "" }), null, "an empty property is not a type");
  assert.equal(noteType({ type: ["a", "b"] }), null, "a list is not a type");

  const typed = synthetic([
    { rel: "a.md", raw: "---\ntype: reference\n---\n\n# A" },
    { rel: "b.md", raw: "---\ntype: Reference\n---\n\n# B" },
    { rel: "c.md", raw: "# C" },
  ]);
  // Case-insensitive against the property, so a facet chosen as written matches.
  assert.deepEqual(paths(knowledgeBrowse(typed, { type: "reference" })), ["a.md", "b.md"]);
});

test("a query matches an alias, which is the name the link was written with", () => {
  const idx = index();
  assert.deepEqual(paths(knowledgeBrowse(idx, { q: "tfstate" })), [
    "3 Resources/Terraform State.md",
  ]);
  assert.deepEqual(paths(knowledgeBrowse(idx, { q: "4 archive" })), [
    "4 Archive/old/State Locking.md",
  ]);
});

test("every page window is stable, and an offset past the end lands on the last page", () => {
  // Two notes share a title, which is what the tie-break is for: without it the
  // sort is whatever the engine does with equal keys, and the same note can
  // appear on page 1 and page 2 while another appears on neither.
  const idx = synthetic([
    { rel: "a.md", raw: "# Same", mtimeMs: 5 },
    { rel: "b.md", raw: "# Same", mtimeMs: 4 },
    { rel: "c.md", raw: "# Same", mtimeMs: 3 },
    { rel: "d.md", raw: "# Same", mtimeMs: 2 },
    { rel: "e.md", raw: "# Same", mtimeMs: 1 },
  ]);

  assert.deepEqual(paths(knowledgeBrowse(idx, { limit: 2 })), ["a.md", "b.md"]);
  assert.deepEqual(paths(knowledgeBrowse(idx, { limit: 2, offset: 2 })), ["c.md", "d.md"]);
  assert.deepEqual(paths(knowledgeBrowse(idx, { limit: 2, offset: 4 })), ["e.md"]);

  // Past the end lands on the last *page*, not on the last note: a pager two
  // clicks deep can be past the end by the time it is followed, and a page of
  // one row there reads as "the rest of these are gone".
  const beyond = knowledgeBrowse(idx, { limit: 2, offset: 40 });
  assert.equal(beyond.offset, 4);
  assert.deepEqual(paths(beyond), ["e.md"]);
  assert.equal(beyond.total, 5, "the total is the match count, never the page's");

  const empty = knowledgeBrowse(idx, { limit: 2, offset: 40, q: "no such note" });
  assert.equal(empty.offset, 0, "an offset into an empty result set is the first page");
  assert.deepEqual(paths(empty), []);
});

test("the sort orders are the ones the page offers, each breaking its tie on the path", () => {
  const idx = synthetic([
    { rel: "old.md", raw: "# Zebra\n\nLinks to [[hub]] and [[leaf]].", mtimeMs: 10 },
    { rel: "hub.md", raw: "# Apple", mtimeMs: 30 },
    { rel: "leaf.md", raw: "# Mango", mtimeMs: 20 },
  ]);

  assert.deepEqual(paths(knowledgeBrowse(idx, { sort: "title" })), ["hub.md", "leaf.md", "old.md"]);
  assert.deepEqual(paths(knowledgeBrowse(idx, { sort: "updated" })), [
    "hub.md",
    "leaf.md",
    "old.md",
  ]);
  // `links` is both directions summed: the note that wrote two links is as
  // connected as the note two links point at.
  assert.equal(knowledgeBrowse(idx, { sort: "links" }).notes[0]?.path, "old.md");
});

test("the health lists and their counts come out of one pass", () => {
  const health = knowledgeHealth(index());

  assert.deepEqual(
    health.orphans.map((o) => o.path),
    ["1 Projects/Lonely.md", "4 Archive/old/State Locking.md"],
  );
  assert.equal(health.orphanCount, health.orphans.length);

  // Both notes naming the missing target, each with the note and the target
  // that failed — a count on its own tells an operator there is work and not
  // where it is.
  assert.equal(health.brokenLinkCount, 2);
  assert.deepEqual(
    health.brokenLinks.map((b) => b.target),
    ["Nothing Written Yet", "Nothing Written Yet"],
  );
  assert.ok(health.brokenLinks.every((b) => b.line > 0 && b.from));

  // The narrowest reading available: no frontmatter block at all. A required
  // `title` or `tags` would be this app inventing a schema for somebody else's
  // vault, and every note it flagged would be a false positive.
  assert.deepEqual(
    health.missingFrontmatter.map((m) => m.path),
    ["3 Resources/State Locking.md", "4 Archive/old/State Locking.md"],
  );
  assert.equal(health.missingFrontmatterCount, 2);
  assert.equal(health.noteCount, 5);
  assert.equal(health.truncated, false);
});

/* -------------------------------- cache --------------------------------- */

test("a second scan reuses the parse, and a changed mtime invalidates it", () => {
  const first = index();
  const second = knowledgeIndex(ROOT);
  assert.equal(second, first, "an unchanged vault was re-parsed");

  const target = path.join(ROOT, "1 Projects/Lonely.md");
  const before = first.notes.get("1 Projects/Lonely.md");
  assert.ok(before);
  assert.deepEqual(before.tags, ["status/seed"]);

  // Written with an explicitly later timestamp rather than trusting the clock:
  // on a filesystem with coarse mtime granularity a rewrite inside the same
  // tick keeps the old stamp, and the test would then pass by measuring
  // nothing.
  fs.writeFileSync(
    target,
    ["---", "tags: [status/growing]", "---", "", "# Lonely", "", "Now links to [[INDEX]]."].join(
      "\n",
    ),
  );
  const stamp = new Date(Date.now() + 2000);
  fs.utimesSync(target, stamp, stamp);

  const third = knowledgeIndex(ROOT);
  assert.notEqual(third, second, "an edited note did not invalidate the index");
  assert.deepEqual(
    third.notes.get("1 Projects/Lonely.md")?.tags,
    ["status/growing"],
    "the edited note was answered from the cache",
  );
  assert.ok(
    !third.orphans.includes("1 Projects/Lonely.md"),
    "the note now links to another note, so it is no longer an orphan",
  );
  // The rest of the vault came out of the cache rather than off disk — same
  // objects, which is what "invalidate incrementally" means here.
  assert.equal(
    third.notes.get("INDEX.md"),
    second.notes.get("INDEX.md"),
    "an untouched note was re-parsed",
  );
});

test("a deleted note leaves the index on the next scan", () => {
  const target = path.join(ROOT, "1 Projects/Lonely.md");
  const before = knowledgeIndex(ROOT);
  assert.ok(before.notes.has("1 Projects/Lonely.md"));

  fs.rmSync(target);
  const after = knowledgeIndex(ROOT);
  assert.ok(
    !after.notes.has("1 Projects/Lonely.md"),
    "a removed note survived in the cache, which is a graph showing a file that is gone",
  );
});

/* ------------------------------- subpath -------------------------------- */

test("a stored subpath is normalized to one spelling", () => {
  assert.equal(normalizeSubpath("  /Knowledge Vault/  "), "Knowledge Vault");
  assert.equal(normalizeSubpath("a//b/"), "a/b");
  assert.equal(normalizeSubpath("a\\b"), "a/b");
  assert.equal(normalizeSubpath(""), "");
  // Left visible rather than collapsed away, so the save door can refuse it
  // instead of storing a different directory than the one that was typed.
  assert.equal(normalizeSubpath("../outside"), "../outside");
});
