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
  knowledgeIndex,
  normalizeSubpath,
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
