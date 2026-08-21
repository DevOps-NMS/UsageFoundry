import fs from "node:fs";
import path from "node:path";

import type {
  KnowledgeBrokenLinkDTO,
  KnowledgeBrowseDTO,
  KnowledgeEdgeDTO,
  KnowledgeFacetDTO,
  KnowledgeHeadingDTO,
  KnowledgeHealthDTO,
  KnowledgeLinkKindDTO,
  KnowledgeListEntryDTO,
  KnowledgeNodeDTO,
  KnowledgeNoteDTO,
  KnowledgeNoteRefDTO,
  KnowledgeSearchHitDTO,
  KnowledgeSortDTO,
  KnowledgeStatusDTO,
} from "./apiTypes";
import { mountById } from "./config";
import { SKIP_DIRS } from "./plugins";
import type { Settings } from "./settings";

/**
 * An Obsidian vault in one of the workspace mounts, read as a link graph.
 *
 * ## What this is not
 *
 * It is not a mount source. `WORKSPACE_ROOTS` is fixed at boot and this module
 * adds nothing to it: `knowledgeBaseMountId` **names** one of the mounts that
 * are already configured, exactly as `defaultAgentId` names a saved agent, and
 * a subpath narrows the walk to a directory inside it. So the vault is always
 * somewhere an agent could already have been pointed at, and nothing here can
 * widen what this container can read.
 *
 * It is also read-only, end to end. Nothing in this module or in the routes
 * over it opens a file for writing, creates a directory or removes one. That is
 * a deliberate bound rather than a stage not reached yet: the vault is a live
 * document store that a person edits in another application, and a background
 * index that can write into it is one that can lose somebody's paragraph while
 * they are typing it.
 *
 * ## Why the parse is hand-rolled
 *
 * There is no YAML dependency here and this does not add one — the runtime
 * dependency list is four packages and a frontmatter block is a small enough
 * grammar to read honestly. `parseFrontmatter` handles the subset Obsidian
 * itself writes and the subset this vault uses: flat and nested block mappings,
 * block sequences, inline flow sequences, quoted and bare scalars. Anything it
 * cannot classify is preserved as its own string rather than dropped, because
 * the payload promises arbitrary keys survive.
 *
 * ## Resolution is Obsidian's, and the order is the whole of it
 *
 * `[[Terraform State]]` names a note by *basename*, not by path, and this vault
 * has 759 of them in a four-deep tree — so a resolver that only matched paths
 * would report nearly every link in it as broken, which is a page full of red
 * that says nothing. The order in `resolveTarget` is therefore load-bearing and
 * is stated there rather than here.
 *
 * A target that resolves to nothing is recorded as a **broken link** and gets a
 * `phantom` node, never dropped. Dropping it is what turns "this vault has 340
 * dangling links" into a graph that reads as complete, which is the one reading
 * an operator would act on and the one that would be wrong.
 *
 * ## The cache is the point
 *
 * Reading 759 files per request is what this exists to avoid. The index is held
 * on `globalThis` (dev hot reload otherwise resets it on every request) and
 * every call re-walks the tree for *stat* only — `mtimeMs` and `size` per file
 * — and re-reads exactly the files whose stamp moved. A vault nobody has
 * touched since the last call costs one `readdir` per directory and no reads at
 * all.
 */

/* ------------------------------------------------------------------ */
/*                               Bounds                                */
/* ------------------------------------------------------------------ */

/**
 * Cap on notes indexed from one vault, `MAX_FOLDERS_PER_MOUNT`'s reasoning.
 *
 * A mount pointed at a large tree would otherwise turn a page load into a full
 * walk and a megabyte of JSON. 5000 is chosen against the vault this was
 * written for (759 notes) with room for it to grow by most of an order of
 * magnitude before anybody has to think about the number again.
 *
 * Reaching it sets `truncated` on every payload derived from the index rather
 * than silently answering short: a partial graph that reads as complete is the
 * failure this flag exists to prevent, because "this note has no backlinks" and
 * "the walk stopped before the notes that link to it" look identical.
 */
export const MAX_NOTES_PER_VAULT = 5000;

/**
 * Cap on directory entries visited, which is the bound the note cap cannot be.
 *
 * A mount whose vault subpath is wrong points this walk at a repository tree,
 * where the note cap is never reached and the walk is unbounded in the only
 * dimension that costs anything — syscalls on the one event loop that also
 * drains every agent's stdout.
 */
export const MAX_ENTRIES_PER_VAULT = 40_000;

/** Cap on nodes one `/api/knowledge/graph` answer may carry. */
export const MAX_GRAPH_NODES = 4000;

/**
 * File extensions read as notes. Everything else in the tree is an attachment.
 *
 * `.markdown` is included because Obsidian accepts it; `.canvas` deliberately
 * is not, since a canvas is a JSON document with its own link model and reading
 * it as prose would report every one of its edges as broken.
 */
const NOTE_EXTENSIONS = new Set([".md", ".markdown"]);

/* ------------------------------------------------------------------ */
/*                            Internal shapes                          */
/* ------------------------------------------------------------------ */

/** One link as it was written, before anything is resolved. */
export interface ParsedLink {
  kind: KnowledgeLinkKindDTO;
  /** The text naming the target, e.g. `Terraform State` or `img/a.png`. */
  target: string;
  /** `[[note|alias]]`'s alias, or a markdown link's text. */
  label: string | null;
  /** `[[note#heading]]`. */
  heading: string | null;
  /** `[[note#^block]]` or `[[note^block]]`. */
  block: string | null;
  /** 1-based line in the note it was written in. */
  line: number;
}

/** One note, parsed. Held in the cache and re-used until its stamp moves. */
export interface ParsedNote {
  /** Vault-relative path with forward slashes, extension included. */
  rel: string;
  /** Absolute path, which is the only path anything here opens. */
  abs: string;
  /** Filename without its extension — what `[[…]]` matches against first. */
  basename: string;
  /** Frontmatter `title` where there is one, otherwise the basename. */
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  aliases: string[];
  headings: KnowledgeHeadingDTO[];
  links: ParsedLink[];
  mtimeMs: number;
  size: number;
}

/** The whole index, which is what everything on the wire is derived from. */
export interface KnowledgeIndex {
  /** Absolute vault root, as this process sees it. */
  root: string;
  scannedAt: number;
  truncated: boolean;
  notes: Map<string, ParsedNote>;
  nodes: Map<string, KnowledgeNodeDTO>;
  edges: KnowledgeEdgeDTO[];
  /** Edges into a node, keyed by node id. */
  backlinks: Map<string, KnowledgeEdgeDTO[]>;
  /** Edges out of a note, keyed by note id. */
  outgoing: Map<string, KnowledgeEdgeDTO[]>;
  brokenLinks: KnowledgeBrokenLinkDTO[];
  /** Vault-relative paths with no note-to-note link in either direction. */
  orphans: string[];
}

/**
 * Where the vault is, or why it is not readable.
 *
 * A result union rather than a throw because every one of these is an expected
 * state with a sentence an operator can act on — nothing configured yet, a
 * mount that has gone, a subpath that names a file. The settings page renders
 * the reason; a thrown error there would render as "something went wrong".
 */
export type KnowledgeRoot =
  | {
      ok: true;
      root: string;
      mountId: string;
      mountLabel: string;
      /** Vault-relative to the mount. `""` means the mount root. */
      subpath: string;
    }
  | { ok: false; configured: boolean; reason: string };

/* ------------------------------------------------------------------ */
/*                          Root resolution                            */
/* ------------------------------------------------------------------ */

/**
 * Containment inside a mount, both phases.
 *
 * This mirrors `containedIn` in `plugins.ts` (which itself mirrors
 * `resolveInMount` in `orchestrator.ts`) rather than calling it, and for the
 * same reason that one gives: the duplication buys a module that does not have
 * to import a stranger's internals, and both phases are load-bearing exactly as
 * they are there — the lexical check first, so an escape reports as an escape
 * rather than as whatever ENOENT it produces, and again after `realpathSync`,
 * because a symlink inside the root can still point out of it.
 */
function containedIn(mountPath: string, input: string): string | null {
  let root: string;
  try {
    root = fs.realpathSync(mountPath);
  } catch {
    return null;
  }
  const contained = (p: string) => {
    const rel = path.relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const candidate = path.resolve(root, input);
  if (!contained(candidate)) return null;
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (!contained(real)) return null;
  return real;
}

/**
 * Which directory the vault is, from the two settings that name it.
 *
 * Takes the settings rather than reading them so the resolution can be driven
 * from a test without a database, and so a caller that already has the object
 * does not read the row twice.
 */
export function resolveKnowledgeRoot(s: Settings): KnowledgeRoot {
  const id = (s.knowledgeBaseMountId ?? "").trim();
  if (!id) {
    return {
      ok: false,
      configured: false,
      reason: "No knowledge base is configured.",
    };
  }

  const mount = mountById(id);
  if (!mount) {
    // The save door refuses an id naming no mount, so reaching this means the
    // mounts themselves changed under a stored value — a compose edit that
    // dropped a slot. Named rather than degraded to "nothing configured",
    // because the two want opposite things done about them.
    return {
      ok: false,
      configured: true,
      reason: `The knowledge base names mount "${id}", which is not configured.`,
    };
  }

  const subpath = normalizeSubpath(s.knowledgeBaseSubpath ?? "");
  const root = containedIn(mount.path, subpath || ".");
  if (!root) {
    const where = subpath ? `${mount.label}/${subpath}` : mount.label;
    return {
      ok: false,
      configured: true,
      reason: `The knowledge base at ${where} could not be read.`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch (err) {
    return {
      ok: false,
      configured: true,
      reason: `The knowledge base at ${root} could not be read: ${(err as Error).message}`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      configured: true,
      reason: `The knowledge base at ${root} is a file, not a directory.`,
    };
  }

  return { ok: true, root, mountId: mount.id, mountLabel: mount.label, subpath };
}

/**
 * A stored subpath in the one form the rest of this module expects.
 *
 * Exported because the save door narrows with it: what is refused there and
 * what is walked here have to be the same string, or a subpath accepted by the
 * form resolves somewhere else on the next read.
 */
export function normalizeSubpath(raw: string): string {
  return String(raw)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

/* ------------------------------------------------------------------ */
/*                             Frontmatter                             */
/* ------------------------------------------------------------------ */

/** A scalar as YAML would read it, with the quoting Obsidian actually emits. */
function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (!v) return null;
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
    (v.startsWith("'") && v.endsWith("'") && v.length > 1)
  ) {
    return v.slice(1, -1);
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    return splitFlow(v.slice(1, -1)).map(parseScalar);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  // Deliberately not `Number(v)`: a date such as `2026-08-11` and a version
  // such as `1.2.3` are both strings, and `Number` would make the first NaN and
  // the second NaN too while turning `007` into 7.
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Split an inline flow sequence, respecting quotes so `"a, b"` stays one. */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

const INDENT = /^(\s*)(.*)$/;

/**
 * The YAML subset an Obsidian frontmatter block is written in.
 *
 * Not a general YAML parser and does not pretend to be one: anchors, multi-line
 * scalars, tagged values and documents are all outside it. What it does cover
 * is what Obsidian's own property editor emits and what this vault's 759 notes
 * contain — flat keys, nested mappings, block sequences and inline flow
 * sequences — and an unrecognised line is kept as a string under its key rather
 * than discarded, because the payload promises arbitrary keys survive and a
 * silently dropped `sources:` block is a note that looks unsourced.
 */
export function parseFrontmatter(block: string): Record<string, unknown> {
  const lines = block
    .split("\n")
    .filter((l) => l.trim() !== "" && !/^\s*#/.test(l));

  const parseBlock = (start: number, end: number, indent: number): unknown => {
    // A sequence and a mapping cannot mix at one indent level in YAML, so the
    // first line at this level decides which this is.
    if (start >= end) return null;
    const first = INDENT.exec(lines[start]) as RegExpExecArray;
    if (first[2].startsWith("- ") || first[2] === "-") {
      const items: unknown[] = [];
      for (let i = start; i < end; i++) {
        const m = INDENT.exec(lines[i]) as RegExpExecArray;
        if (m[1].length !== indent || !m[2].startsWith("-")) continue;
        const rest = m[2].slice(1).trim();
        const next = blockEnd(i + 1, end, indent);
        if (rest) items.push(parseScalar(rest));
        else if (next > i + 1) items.push(parseBlock(i + 1, next, indentAt(i + 1)));
        else items.push(null);
      }
      return items;
    }

    const out: Record<string, unknown> = {};
    for (let i = start; i < end; i++) {
      const m = INDENT.exec(lines[i]) as RegExpExecArray;
      if (m[1].length !== indent) continue;
      const colon = keyEnd(m[2]);
      if (colon === -1) continue;
      const key = m[2].slice(0, colon).trim().replace(/^["']|["']$/g, "");
      const rest = m[2].slice(colon + 1).trim();
      const next = blockEnd(i + 1, end, indent);
      if (rest) out[key] = parseScalar(rest);
      else if (next > i + 1) out[key] = parseBlock(i + 1, next, indentAt(i + 1));
      else out[key] = null;
    }
    return out;
  };

  const indentAt = (i: number) => (INDENT.exec(lines[i]) as RegExpExecArray)[1].length;

  /** Where the run of lines indented deeper than `indent` ends. */
  const blockEnd = (from: number, end: number, indent: number): number => {
    let i = from;
    while (i < end && indentAt(i) > indent) i++;
    return i;
  };

  const parsed = parseBlock(0, lines.length, lines.length ? indentAt(0) : 0);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** The `key:` in `key: value`, ignoring a colon inside quotes or a URL. */
function keyEnd(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // A key ends at a colon followed by whitespace or end of line, which is
    // what keeps `https://x` from splitting a bare-scalar value in two.
    if (ch === ":" && (i + 1 === line.length || /\s/.test(line[i + 1]))) return i;
  }
  return -1;
}

/** Frontmatter and the body it sits above, split on the `---` fence. */
export function splitFrontmatter(raw: string): { front: string; body: string } {
  if (!raw.startsWith("---")) return { front: "", body: raw };
  const firstBreak = raw.indexOf("\n");
  if (firstBreak === -1 || raw.slice(3, firstBreak).trim() !== "") {
    return { front: "", body: raw };
  }
  const rest = raw.slice(firstBreak + 1);
  const close = /^(?:---|\.\.\.)\s*$/m.exec(rest);
  if (!close || close.index === undefined) return { front: "", body: raw };
  const front = rest.slice(0, close.index);
  const after = rest.slice(close.index);
  const afterBreak = after.indexOf("\n");
  return { front, body: afterBreak === -1 ? "" : after.slice(afterBreak + 1) };
}

/** A frontmatter value that may be a list, a comma-separated string, or one. */
function stringList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap(stringList);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n]/)
      .map((s) => s.trim().replace(/^#/, ""))
      .filter(Boolean);
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  return [];
}

/* ------------------------------------------------------------------ */
/*                             Body scanning                           */
/* ------------------------------------------------------------------ */

/**
 * The body with every code span blanked out, offsets and lines preserved.
 *
 * Obsidian renders no link and no tag inside a code block, and a vault of
 * engineering notes is mostly code blocks — this vault's own `AGENTS.md` shows
 * `[[Do Hand-Tuned Field Weights Beat Flat Weights]]` in prose beside a dozen
 * fenced shell examples full of `#` comments. Scanning the raw text would file
 * every one of those comments as a tag and every bracketed placeholder as a
 * broken link, which is a graph made mostly of noise.
 *
 * Blanking rather than deleting is what keeps every offset and every line
 * number in this function's output pointing at the same character it did in the
 * input, so a link's reported line is the line an editor will open on.
 */
export function stripCode(body: string): string {
  const lines = body.split("\n");
  let fence: string | null = null;
  const out = lines.map((line) => {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const closes = opener && opener[1][0] === fence[0] && opener[1].length >= fence.length;
      if (closes) fence = null;
      return " ".repeat(line.length);
    }
    if (opener) {
      fence = opener[1];
      return " ".repeat(line.length);
    }
    // Inline spans, longest run of backticks first so ``a `b` c`` stays whole.
    return line.replace(/(`+)(?:(?!\1)[\s\S])*\1/g, (m) => " ".repeat(m.length));
  });
  return out.join("\n");
}

/** Turn a character offset into a 1-based line number. */
function lineCounter(text: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const WIKILINK = /(!?)\[\[([^\[\]]+)\]\]/g;
const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^()\s]*(?:\([^()\s]*\))?[^()\s]*)(?:\s+"[^"\n]*")?\s*\)/g;

/**
 * Tags as Obsidian defines them: `#` then at least one non-digit, and never
 * mid-word.
 *
 * The leading boundary is what keeps `https://example.com#frag` and a CSS hex
 * colour out, and the "at least one letter" rule is what keeps `#1` — an issue
 * number, which this vault's notes are full of — from becoming a node.
 */
const TAG = /(^|[\s(\[{<,;:'"])#([A-Za-z0-9_\-/]*[A-Za-z][A-Za-z0-9_\-/]*)/g;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Split the inner text of a wikilink into its four parts. */
function parseWikilinkTarget(inner: string): {
  target: string;
  label: string | null;
  heading: string | null;
  block: string | null;
} {
  const pipe = inner.indexOf("|");
  const spec = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const label = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;

  const hash = spec.indexOf("#");
  if (hash !== -1) {
    const frag = spec.slice(hash + 1).trim();
    return frag.startsWith("^")
      ? { target: spec.slice(0, hash).trim(), label, heading: null, block: frag.slice(1) }
      : { target: spec.slice(0, hash).trim(), label, heading: frag || null, block: null };
  }
  // `[[note^block]]` without the `#` Obsidian writes. Accepted because a link
  // written by hand or by another tool takes this form and refusing it would
  // report a resolvable note as missing.
  const caret = spec.indexOf("^");
  if (caret > 0) {
    return { target: spec.slice(0, caret).trim(), label, heading: null, block: spec.slice(caret + 1) };
  }
  return { target: spec, label, heading: null, block: null };
}

/** Whether a markdown link target points outside this vault. */
function isExternalTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

/**
 * Every link and tag in one note's body, in source order.
 *
 * Link spans are blanked before tags are scanned, which is the one ordering
 * that matters here: `[[Terraform#State Locking]]` carries a `#` that is a
 * heading reference, and a tag scan over the raw text would file `#State` as a
 * tag on every note that links to a heading.
 */
export function extractLinks(body: string): ParsedLink[] {
  const scan = stripCode(body);
  const lineAt = lineCounter(scan);
  const links: ParsedLink[] = [];
  const blanked = scan.split("");

  const blank = (from: number, length: number) => {
    for (let i = from; i < from + length; i++) {
      if (blanked[i] !== "\n") blanked[i] = " ";
    }
  };

  for (const m of scan.matchAll(WIKILINK)) {
    const at = m.index ?? 0;
    blank(at, m[0].length);
    const parts = parseWikilinkTarget(m[2]);
    // `[[#heading]]` is a jump inside the same note and is not an edge.
    if (!parts.target) continue;
    links.push({
      kind: m[1] === "!" ? "embed" : "wikilink",
      target: parts.target,
      label: parts.label,
      heading: parts.heading,
      block: parts.block,
      line: lineAt(at),
    });
  }

  for (const m of scan.matchAll(MARKDOWN_LINK)) {
    const at = m.index ?? 0;
    blank(at, m[0].length);
    let target = m[3].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (!target || isExternalTarget(target) || target.startsWith("#")) continue;
    const hash = target.indexOf("#");
    const heading = hash === -1 ? null : decodeTarget(target.slice(hash + 1)) || null;
    const file = decodeTarget(hash === -1 ? target : target.slice(0, hash));
    if (!file) continue;
    links.push({
      kind: m[1] === "!" ? "embed" : "markdown",
      target: file,
      label: m[2].trim() || null,
      heading: heading && heading.startsWith("^") ? null : heading,
      block: heading && heading.startsWith("^") ? heading.slice(1) : null,
      line: lineAt(at),
    });
  }

  const withoutLinks = blanked.join("");
  for (const m of withoutLinks.matchAll(TAG)) {
    const at = (m.index ?? 0) + m[1].length;
    links.push({
      kind: "tag",
      target: m[2].replace(/\/+$/, ""),
      label: null,
      heading: null,
      block: null,
      line: lineAt(at),
    });
  }

  return links.sort((a, b) => a.line - b.line);
}

/** `%20` and friends, without letting a malformed escape throw. */
function decodeTarget(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

/** Every ATX heading in the body, outside code. */
export function extractHeadings(body: string): KnowledgeHeadingDTO[] {
  const out: KnowledgeHeadingDTO[] = [];
  const lines = stripCode(body).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*                              Note parsing                           */
/* ------------------------------------------------------------------ */

/** Case-insensitive dedupe that keeps the first spelling seen. */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * One note, read from its text.
 *
 * Pure and exported so every link form above can be pinned without a vault on
 * disk, which is `parsePluginManifest`'s precedent and its reasoning: every way
 * this goes wrong is quiet. A link form the scanner misses is a note that reads
 * as having fewer connections than it has, and nothing anywhere reports it.
 *
 * Frontmatter wikilinks are scanned as well as body ones, because Obsidian
 * resolves them and this vault's notes carry their map-of-content edges in a
 * `related:` property — reading the body alone would report a third of the
 * graph's real edges as absent.
 */
export function parseNote(rel: string, raw: string): Omit<ParsedNote, "abs" | "mtimeMs" | "size"> {
  const text = raw.replace(/\r\n/g, "\n");
  const { front, body } = splitFrontmatter(text);
  const frontmatter = front ? parseFrontmatter(front) : {};

  const basename = path.basename(rel).replace(/\.[^.]+$/, "");
  const titleValue = frontmatter.title;
  const title = typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : basename;

  const links = extractLinks(body);
  const bodyTags = links.filter((l) => l.kind === "tag").map((l) => l.target);
  const frontTags = [...stringList(frontmatter.tags), ...stringList(frontmatter.tag)];

  if (front) {
    const lineAt = lineCounter(front);

    // A property holding `[[Other Note]]` is a link in Obsidian's own graph.
    // Only wikilinks are read here: a markdown-link scan over frontmatter would
    // file every `sources:` URL's bracketed text as an edge.
    for (const m of front.matchAll(WIKILINK)) {
      const parts = parseWikilinkTarget(m[2]);
      if (!parts.target) continue;
      links.push({
        kind: m[1] === "!" ? "embed" : "wikilink",
        target: parts.target,
        label: parts.label,
        heading: parts.heading,
        block: parts.block,
        line: lineAt(m.index ?? 0),
      });
    }

    // And a frontmatter tag is a tag, exactly as a body `#tag` is. Measured
    // against the vault this was written for: 747 of its 772 notes carry tags
    // and not one writes them in the body, so reading only the body reported a
    // fully organised vault as having no tags whatsoever — a zero in the one
    // figure that says how the vault is arranged, with nothing to suggest it
    // was the reader that was wrong.
    // Declared in both places, the tag is still one tag on this note — unlike
    // two wikilinks to the same note, which are two places worth showing in a
    // backlinks list.
    const inBody = new Set(bodyTags.map((t) => t.toLowerCase()));
    for (const tag of frontTags) {
      if (inBody.has(tag.toLowerCase())) continue;
      const at = front.indexOf(tag);
      links.push({
        kind: "tag",
        target: tag,
        label: null,
        heading: null,
        block: null,
        // Line 1 when the value cannot be found verbatim — a tag written
        // `#topic/x` in the property, say, whose stored form dropped the hash.
        line: at === -1 ? 1 : lineAt(at),
      });
    }
  }

  return {
    rel,
    basename,
    title,
    frontmatter,
    tags: dedupe([...frontTags, ...bodyTags]),
    aliases: dedupe([...stringList(frontmatter.aliases), ...stringList(frontmatter.alias)]),
    headings: extractHeadings(body),
    links,
  };
}

/* ------------------------------------------------------------------ */
/*                                The walk                             */
/* ------------------------------------------------------------------ */

interface WalkResult {
  /** Note paths, vault-relative, with their invalidation stamp. */
  notes: Map<string, { abs: string; mtimeMs: number; size: number }>;
  /** Everything else, vault-relative — the attachments links can reach. */
  attachments: Map<string, string>;
  truncated: boolean;
}

function isNotePath(rel: string): boolean {
  return NOTE_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

/**
 * Every file under the vault root, stat only.
 *
 * Skips `.obsidian`, `.git` and every other dot-directory — a vault's own
 * configuration is not part of its graph, and `.trash` holds notes an operator
 * deleted — plus `SKIP_DIRS`, which `plugins.ts` already defines for exactly
 * this question one module over.
 */
function walkVault(root: string): WalkResult {
  const notes = new Map<string, { abs: string; mtimeMs: number; size: number }>();
  const attachments = new Map<string, string>();
  let entries = 0;
  let truncated = false;

  const walk = (dir: string, prefix: string) => {
    if (truncated) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory this process cannot read is skipped rather than fatal: one
      // permission-denied subfolder must not cost the whole vault.
      return;
    }
    for (const entry of dirents) {
      if (++entries > MAX_ENTRIES_PER_VAULT || notes.size >= MAX_NOTES_PER_VAULT) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs, rel);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isNotePath(rel)) {
        attachments.set(rel, abs);
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      notes.set(rel, { abs, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  };

  walk(root, "");
  return { notes, attachments, truncated };
}

/* ------------------------------------------------------------------ */
/*                              Resolution                             */
/* ------------------------------------------------------------------ */

interface Resolver {
  byName: Map<string, string[]>;
  byAlias: Map<string, string[]>;
  byPath: Map<string, string[]>;
  attachmentByName: Map<string, string[]>;
  attachmentByPath: Map<string, string[]>;
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** A link target, in the one form the indexes are keyed by. */
function targetKey(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim()
    .toLowerCase();
}

function withoutExtension(rel: string): string {
  return rel.replace(/\.[^./]+$/, "");
}

function buildResolver(notes: Map<string, ParsedNote>, attachments: Map<string, string>): Resolver {
  const r: Resolver = {
    byName: new Map(),
    byAlias: new Map(),
    byPath: new Map(),
    attachmentByName: new Map(),
    attachmentByPath: new Map(),
  };

  for (const note of notes.values()) {
    push(r.byName, note.basename.toLowerCase(), note.rel);
    for (const alias of note.aliases) push(r.byAlias, alias.toLowerCase(), note.rel);
    // Every path suffix, so `[[Terraform/State]]` reaches
    // `3 Resources/Terraform/State.md` without a scan per unresolved link.
    const stripped = withoutExtension(note.rel).toLowerCase();
    const parts = stripped.split("/");
    for (let i = 0; i < parts.length; i++) {
      push(r.byPath, parts.slice(i).join("/"), note.rel);
    }
  }

  for (const rel of attachments.keys()) {
    push(r.attachmentByName, path.basename(rel).toLowerCase(), rel);
    const parts = rel.toLowerCase().split("/");
    for (let i = 0; i < parts.length; i++) {
      push(r.attachmentByPath, parts.slice(i).join("/"), rel);
    }
  }

  return r;
}

/** Of several candidates, the one Obsidian picks: the shortest path. */
function shortest(candidates: readonly string[]): string {
  return [...candidates].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.length - b.length || a.localeCompare(b),
  )[0];
}

/**
 * A link target, resolved the way Obsidian resolves it.
 *
 * The order is the decision this function exists to record, and getting it
 * wrong is silent in both directions — a link that resolves to the wrong note
 * draws an edge nobody wrote, and one that resolves to nothing is reported as
 * broken on a page whose whole job is to say which links are broken.
 *
 * 1. **Basename.** `[[Terraform State]]` names a file, from anywhere in the
 *    vault, at any depth. This is how nearly every link in a real vault is
 *    written, which is why it is first.
 * 2. **Path, then shortest-unique suffix.** `[[Terraform/State]]` names a
 *    place; the suffix map means a link may write as much of the path as it
 *    takes to be unambiguous and no more.
 * 3. **Alias.** Last of the three, because a real file whose *name* is the
 *    target must beat a different note that merely answers to it — otherwise
 *    adding an alias to one note silently repoints every link to another.
 *
 * Ties inside a step go to the shortest path, which is Obsidian's own rule.
 */
function resolveTarget(
  r: Resolver,
  raw: string,
): { kind: "note" | "attachment"; rel: string } | null {
  const key = targetKey(raw);
  if (!key) return null;

  const ext = path.extname(key);
  if (ext && !NOTE_EXTENSIONS.has(ext)) {
    const byName = r.attachmentByName.get(path.basename(key));
    if (byName?.length) return { kind: "attachment", rel: shortest(byName) };
    const byPath = r.attachmentByPath.get(key);
    if (byPath?.length) return { kind: "attachment", rel: shortest(byPath) };
    return null;
  }

  const bare = ext ? key.slice(0, -ext.length) : key;
  const byName = r.byName.get(path.basename(bare));
  if (byName?.length) return { kind: "note", rel: shortest(byName) };
  const byPath = r.byPath.get(bare);
  if (byPath?.length) return { kind: "note", rel: shortest(byPath) };
  const byAlias = r.byAlias.get(bare);
  if (byAlias?.length) return { kind: "note", rel: shortest(byAlias) };
  return null;
}

/* ------------------------------------------------------------------ */
/*                            Graph assembly                           */
/* ------------------------------------------------------------------ */

const NOTE_ID = (rel: string) => `note:${rel}`;
const ATTACHMENT_ID = (rel: string) => `attachment:${rel}`;
const TAG_ID = (tag: string) => `tag:${tag.toLowerCase()}`;
const PHANTOM_ID = (target: string) => `phantom:${targetKey(target)}`;

/**
 * Nodes, edges, backlinks and orphans from a set of parsed notes.
 *
 * Separated from the walk and the cache so the whole graph can be built from
 * text in a test, and rebuilt in memory when one file out of 759 changed.
 */
export function buildIndex(
  root: string,
  notes: Map<string, ParsedNote>,
  attachments: Map<string, string>,
  truncated: boolean,
): KnowledgeIndex {
  const resolver = buildResolver(notes, attachments);
  const nodes = new Map<string, KnowledgeNodeDTO>();
  const edges: KnowledgeEdgeDTO[] = [];
  const brokenLinks: KnowledgeBrokenLinkDTO[] = [];
  const backlinks = new Map<string, KnowledgeEdgeDTO[]>();
  const outgoing = new Map<string, KnowledgeEdgeDTO[]>();

  const node = (n: KnowledgeNodeDTO): KnowledgeNodeDTO => {
    const found = nodes.get(n.id);
    if (found) return found;
    nodes.set(n.id, n);
    return n;
  };

  for (const note of notes.values()) {
    node({
      id: NOTE_ID(note.rel),
      kind: "note",
      title: note.title,
      path: note.rel,
      tags: note.tags,
      aliases: note.aliases,
      inDegree: 0,
      outDegree: 0,
    });
  }

  /** Whether a note is joined to another note, which is what orphan negates. */
  const connected = new Set<string>();

  for (const note of notes.values()) {
    const fromId = NOTE_ID(note.rel);
    for (const link of note.links) {
      let toId: string;
      let resolved = true;
      // Set only where the target is a note, which is what makes the edge say
      // "somewhere you can open" rather than merely "somewhere that exists".
      let toNotePath: string | null = null;

      if (link.kind === "tag") {
        toId = TAG_ID(link.target);
        node({
          id: toId,
          kind: "tag",
          title: link.target,
          path: null,
          tags: [],
          aliases: [],
          inDegree: 0,
          outDegree: 0,
        });
      } else {
        const hit = resolveTarget(resolver, link.target);
        if (hit?.kind === "note") {
          toId = NOTE_ID(hit.rel);
          toNotePath = hit.rel;
          if (hit.rel !== note.rel) {
            connected.add(fromId);
            connected.add(toId);
          }
        } else if (hit?.kind === "attachment") {
          toId = ATTACHMENT_ID(hit.rel);
          node({
            id: toId,
            kind: "attachment",
            title: path.basename(hit.rel),
            path: hit.rel,
            tags: [],
            aliases: [],
            inDegree: 0,
            outDegree: 0,
          });
        } else {
          resolved = false;
          toId = PHANTOM_ID(link.target);
          node({
            id: toId,
            kind: "phantom",
            title: link.target,
            path: null,
            tags: [],
            aliases: [],
            inDegree: 0,
            outDegree: 0,
          });
          brokenLinks.push({
            from: note.rel,
            fromTitle: note.title,
            target: link.target,
            kind: link.kind,
            line: link.line,
          });
        }
      }

      const edge: KnowledgeEdgeDTO = {
        from: fromId,
        to: toId,
        kind: link.kind,
        target: link.target,
        label: link.label,
        heading: link.heading,
        block: link.block,
        line: link.line,
        resolved,
        toNotePath,
      };
      edges.push(edge);

      const out = outgoing.get(fromId);
      if (out) out.push(edge);
      else outgoing.set(fromId, [edge]);
      const back = backlinks.get(toId);
      if (back) back.push(edge);
      else backlinks.set(toId, [edge]);

      const fromNode = nodes.get(fromId);
      const toNode = nodes.get(toId);
      if (fromNode) fromNode.outDegree++;
      if (toNode) toNode.inDegree++;
    }
  }

  // Orphan is Obsidian's own reading: no link to another note and none from
  // one. Tags and attachments deliberately do not count — a note carrying
  // `#terraform` and nothing else is exactly the note this list is for.
  const orphans = [...notes.keys()].filter((rel) => !connected.has(NOTE_ID(rel))).sort();

  return {
    root,
    scannedAt: Date.now(),
    truncated,
    notes,
    nodes,
    edges,
    backlinks,
    outgoing,
    brokenLinks,
    orphans,
  };
}

/* ------------------------------------------------------------------ */
/*                               The cache                             */
/* ------------------------------------------------------------------ */

/**
 * The one index this process holds, on `globalThis` for the usual reason: dev
 * hot reload replaces the module and would otherwise re-read the whole vault on
 * every request.
 *
 * A **new** key rather than a reused one, which is the rule `__ufInterrupts`
 * records — `??=` only initialises when the key is absent, so a value of an
 * older shape survives a reload and every call on it throws.
 */
const cacheHome = globalThis as unknown as {
  __ufKnowledgeIndex?: { index: KnowledgeIndex | null };
};
cacheHome.__ufKnowledgeIndex ??= { index: null };
const cache = cacheHome.__ufKnowledgeIndex;

/**
 * The index for a vault root, re-reading only what changed.
 *
 * The walk is stat-only and runs every call, because it *is* the invalidation:
 * a file whose `mtimeMs` and `size` both match what the cache holds is not read
 * again. On the vault this was written against that is 759 `stat` calls and
 * zero `readFile`s for a call after nothing has been edited, against 759 reads
 * and a full parse for the version without it.
 *
 * A time-based staleness floor was considered and deliberately left out: it
 * would make an edit invisible for as long as the floor, and the walk it saves
 * is the cheap half.
 */
export function knowledgeIndex(root: string): KnowledgeIndex {
  const walked = walkVault(root);
  const previous = cache.index && cache.index.root === root ? cache.index : null;

  const notes = new Map<string, ParsedNote>();
  let changed = previous === null || previous.truncated !== walked.truncated;

  for (const [rel, stamp] of walked.notes) {
    const cached = previous?.notes.get(rel);
    if (cached && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) {
      notes.set(rel, cached);
      continue;
    }
    changed = true;
    let raw: string;
    try {
      raw = fs.readFileSync(stamp.abs, "utf8");
    } catch {
      // A note that vanished between the walk and the read is simply not in
      // this index. The next call picks it up if it comes back.
      continue;
    }
    notes.set(rel, { ...parseNote(rel, raw), ...stamp });
  }

  if (previous && previous.notes.size !== notes.size) changed = true;

  if (previous && !changed) return previous;

  const index = buildIndex(root, notes, walked.attachments, walked.truncated);
  cache.index = index;
  return index;
}

/**
 * Drop the cached index.
 *
 * Exported for the tests that pin the invalidation itself, which have to be
 * able to establish a cold process — and used by nothing else, because the
 * stamp comparison above is what invalidation is in normal operation.
 */
export function clearKnowledgeCache(): void {
  cache.index = null;
}

/* ------------------------------------------------------------------ */
/*                            Wire projections                         */
/* ------------------------------------------------------------------ */

/** Filters `/api/knowledge/graph` accepts. Every one of them is optional. */
export interface GraphFilter {
  /** Node kinds to include. Empty means notes only. */
  kinds?: readonly KnowledgeNodeDTO["kind"][];
  /** Only notes carrying this tag, and what they reach. */
  tag?: string | null;
  /** Substring over title, alias and path. */
  q?: string | null;
  limit?: number;
}

/**
 * Nodes and edges, filtered.
 *
 * The node cap is separate from the walk's and reports separately, because they
 * mean different things: the walk's says the vault was not all read, this one
 * says the answer was not all sent. Reporting one as the other would tell an
 * operator to widen a subpath that was never the problem.
 */
export function knowledgeGraphView(
  index: KnowledgeIndex,
  filter: GraphFilter = {},
): {
  nodes: KnowledgeNodeDTO[];
  edges: KnowledgeEdgeDTO[];
  truncated: boolean;
  capped: boolean;
} {
  const kinds = new Set(filter.kinds?.length ? filter.kinds : (["note"] as const));
  const tag = filter.tag?.trim().replace(/^#/, "").toLowerCase() || null;
  const q = filter.q?.trim().toLowerCase() || null;
  const limit = Math.max(1, Math.min(filter.limit ?? MAX_GRAPH_NODES, MAX_GRAPH_NODES));

  const matches = (n: KnowledgeNodeDTO) => {
    if (!kinds.has(n.kind)) return false;
    if (tag && !n.tags.some((t) => t.toLowerCase() === tag)) return false;
    if (q) {
      const haystack = [n.title, n.path ?? "", ...n.aliases].join("\n").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  };

  // The nodes keep the degrees they have in the *whole* graph, not in this
  // view. That is deliberate and the other reading would be worse: filtered to
  // notes, a note whose only links are tags would report a degree of zero and
  // read as isolated, which is the opposite of what it is.
  const all = [...index.nodes.values()].filter(matches);
  const capped = all.length > limit;
  const nodes = all.slice(0, limit);
  const kept = new Set(nodes.map((n) => n.id));
  const edges = index.edges.filter((e) => kept.has(e.from) && kept.has(e.to));

  return { nodes, edges, truncated: index.truncated, capped };
}

/** One note, with its text and both directions of its links. */
export function knowledgeNoteView(index: KnowledgeIndex, rel: string): KnowledgeNoteDTO | null {
  const note = index.notes.get(rel);
  if (!note) return null;

  let body = "";
  try {
    // `note.abs` came from the walk rather than from the request, so the path
    // being opened is one this module has already proved is inside the vault.
    body = splitFrontmatter(fs.readFileSync(note.abs, "utf8").replace(/\r\n/g, "\n")).body;
  } catch (err) {
    body = `This note could not be read: ${(err as Error).message}`;
  }

  const id = NOTE_ID(note.rel);
  return {
    path: note.rel,
    title: note.title,
    frontmatter: note.frontmatter,
    tags: note.tags,
    aliases: note.aliases,
    headings: note.headings,
    body,
    outgoing: index.outgoing.get(id) ?? [],
    incoming: index.backlinks.get(id) ?? [],
  };
}

/**
 * Whether a vault is configured, whether it could be read, and what is in it.
 *
 * Every count is `null` when the vault could not be read, rather than 0. That
 * is `StorageFigures`' rule — a store that could not be measured and a store
 * with nothing in it must not read alike — and it matters more here, because a
 * knowledge base showing "0 notes, 0 broken links" is the reading an operator
 * would take as *good news*.
 *
 * The two skill fields of `KnowledgeStatusDTO` are the route's to add rather
 * than this function's: they come from a settings row and a stat of the vault,
 * and this module deliberately reads nothing but `Settings` and the filesystem
 * — a `db` import here would put a database behind every test in
 * `knowledge.test.ts`.
 */
export function knowledgeStatus(
  s: Settings,
): Omit<KnowledgeStatusDTO, "skillEnabled" | "skillSearchScript"> {
  const blank = {
    noteCount: null,
    orphanCount: null,
    brokenLinkCount: null,
    tagCount: null,
    attachmentCount: null,
    scannedAt: null,
    truncated: false,
  };

  const root = resolveKnowledgeRoot(s);
  if (!root.ok) {
    return {
      configured: root.configured,
      available: false,
      error: root.reason,
      mountId: (s.knowledgeBaseMountId ?? "").trim() || null,
      mountLabel: null,
      subpath: normalizeSubpath(s.knowledgeBaseSubpath ?? ""),
      ...blank,
    };
  }

  const base = {
    configured: true,
    mountId: root.mountId,
    mountLabel: root.mountLabel,
    subpath: root.subpath,
  };

  let index: KnowledgeIndex;
  try {
    index = knowledgeIndex(root.root);
  } catch (err) {
    return {
      ...base,
      available: false,
      error: `The knowledge base could not be scanned: ${(err as Error).message}`,
      ...blank,
    };
  }

  let tagCount = 0;
  let attachmentCount = 0;
  for (const node of index.nodes.values()) {
    if (node.kind === "tag") tagCount++;
    else if (node.kind === "attachment") attachmentCount++;
  }

  return {
    ...base,
    available: true,
    error: null,
    noteCount: index.notes.size,
    orphanCount: index.orphans.length,
    brokenLinkCount: index.brokenLinks.length,
    tagCount,
    attachmentCount,
    scannedAt: index.scannedAt,
    truncated: index.truncated,
  };
}

/**
 * Substring search over titles, aliases, tags and body-less metadata.
 *
 * Deliberately not a ranked retrieval engine: this vault ships its own BM25
 * search, and a second, worse one built here would be the thing an operator
 * reaches for and the thing that answers badly. What this is for is finding the
 * note you already know the name of, so the ranking is only "where did it
 * match" and it says so on the wire.
 */
export function searchKnowledge(
  index: KnowledgeIndex,
  query: string,
  limit = 50,
): KnowledgeSearchHitDTO[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: KnowledgeSearchHitDTO[] = [];
  for (const note of index.notes.values()) {
    const title = note.title.toLowerCase();
    let score = 0;
    let matched: KnowledgeSearchHitDTO["matched"] = "path";
    if (title === q) {
      score = 100;
      matched = "title";
    } else if (title.includes(q)) {
      score = 70;
      matched = "title";
    } else if (note.aliases.some((a) => a.toLowerCase().includes(q))) {
      score = 50;
      matched = "alias";
    } else if (note.tags.some((t) => t.toLowerCase().includes(q))) {
      score = 30;
      matched = "tag";
    } else if (note.rel.toLowerCase().includes(q)) {
      score = 10;
      matched = "path";
    } else {
      continue;
    }
    hits.push({ path: note.rel, title: note.title, tags: note.tags, score, matched });
  }

  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, limit));
}

/* ------------------------------------------------------------------ */
/*                          Browsing and health                        */
/* ------------------------------------------------------------------ */

/** Notes one `/api/knowledge/notes` answer carries by default. */
export const KNOWLEDGE_PAGE_SIZE = 50;

/** The most one answer will carry, however large a `limit` asks for. */
export const KNOWLEDGE_MAX_PAGE_SIZE = 200;

/**
 * Rows each health list is cut to.
 *
 * A vault with 300 broken links is exactly the vault this page is for, and a
 * list of 300 rows is one nobody reads — but the *count* beside it is what an
 * operator acts on, so the count is always the whole figure and the list says
 * it was cut. Both come from one pass, which is what stops them disagreeing.
 */
export const KNOWLEDGE_HEALTH_LIST = 200;

const SORTS: readonly KnowledgeSortDTO[] = ["title", "updated", "links"];

/** Whether a string off the wire names one of the orders this offers. */
export function isKnowledgeSort(raw: string | null): raw is KnowledgeSortDTO {
  return raw !== null && (SORTS as readonly string[]).includes(raw);
}

/** The directory part of a vault-relative path. `""` is the vault root. */
export function noteFolder(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at === -1 ? "" : rel.slice(0, at);
}

/**
 * The note's own classification, which is a frontmatter `type` and nothing
 * else.
 *
 * Deliberately not inferred from a `type/…` tag or from the folder: a vault
 * that classifies its notes says so in a property, and a page that guesses when
 * it does not would show a filter full of values the operator never wrote.
 */
export function noteType(frontmatter: Record<string, unknown>): string | null {
  const raw = frontmatter.type;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function listEntry(note: ParsedNote, nodes: Map<string, KnowledgeNodeDTO>): KnowledgeListEntryDTO {
  const node = nodes.get(NOTE_ID(note.rel));
  return {
    path: note.rel,
    title: note.title,
    folder: noteFolder(note.rel),
    tags: note.tags,
    type: noteType(note.frontmatter),
    inDegree: node?.inDegree ?? 0,
    outDegree: node?.outDegree ?? 0,
    updatedAt: note.mtimeMs,
    missingFrontmatter: Object.keys(note.frontmatter).length === 0,
  };
}

/** Filters `/api/knowledge/notes` accepts. Every one of them is optional. */
export interface BrowseFilter {
  /** A folder and everything under it. `""` or absent is the whole vault. */
  folder?: string | null;
  tag?: string | null;
  type?: string | null;
  /** Substring over title, alias and path. */
  q?: string | null;
  sort?: KnowledgeSortDTO;
  offset?: number;
  limit?: number;
}

/**
 * A folder filter is a prefix, not an equality test.
 *
 * This vault is four deep and its top level is five folders, so an equality
 * test would make `1 Projects` — the value an operator reaches for first —
 * select the nothing that sits directly in it. The failure is silent: an empty
 * list reads as "no notes there" rather than as "that is not what this filter
 * means".
 */
function inFolder(folder: string, prefix: string): boolean {
  return prefix === "" || folder === prefix || folder.startsWith(`${prefix}/`);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** A facet map as the wire wants it: most notes first, then alphabetical. */
function facets(counts: Map<string, number>): KnowledgeFacetDTO[] {
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

const BY_SORT: Record<
  KnowledgeSortDTO,
  (a: KnowledgeListEntryDTO, b: KnowledgeListEntryDTO) => number
> = {
  title: (a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path),
  // Every order breaks its tie on the path, so a page window is stable across
  // two reads of an unchanged vault — without it, the same note can appear on
  // page 1 and page 2 and another on neither.
  updated: (a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path),
  links: (a, b) =>
    b.inDegree + b.outDegree - (a.inDegree + a.outDegree) || a.path.localeCompare(b.path),
};

/**
 * The browse list: notes matching a filter, one page of them, and the values
 * every filter offers.
 *
 * The facets are counted over the **whole** vault rather than over the result
 * set, which is the rule the branches page's repository filter already records:
 * a filter that hides the values you would use to change it is one you cannot
 * get out of. So a folder that this tag rules out still appears, with the
 * number of notes it holds, and choosing it replaces the tag rather than
 * landing on an empty list with no way back.
 */
export function knowledgeBrowse(index: KnowledgeIndex, filter: BrowseFilter = {}): KnowledgeBrowseDTO {
  const folder = (filter.folder ?? "").trim().replace(/^\/+|\/+$/g, "");
  const tag = filter.tag?.trim().replace(/^#/, "").toLowerCase() || null;
  const type = filter.type?.trim().toLowerCase() || null;
  const q = filter.q?.trim().toLowerCase() || null;
  const sort = filter.sort ?? "title";
  const limit = Math.max(1, Math.min(filter.limit ?? KNOWLEDGE_PAGE_SIZE, KNOWLEDGE_MAX_PAGE_SIZE));

  const folderCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const matched: KnowledgeListEntryDTO[] = [];

  for (const note of index.notes.values()) {
    const entry = listEntry(note, index.nodes);

    // A folder facet counts every note *beneath* it, one entry per ancestor,
    // because that is what selecting it will show. The counts therefore sum
    // past the vault's note count, which is what a hierarchy does and not a
    // figure to reconcile against `total`.
    const parts = entry.folder ? entry.folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) bump(folderCounts, parts.slice(0, i).join("/"));
    for (const t of entry.tags) bump(tagCounts, t);
    if (entry.type) bump(typeCounts, entry.type);

    if (!inFolder(entry.folder, folder)) continue;
    if (tag && !entry.tags.some((t) => t.toLowerCase() === tag)) continue;
    if (type && entry.type?.toLowerCase() !== type) continue;
    if (q) {
      const haystack = [entry.title, entry.path, ...note.aliases].join("\n").toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    matched.push(entry);
  }

  matched.sort(BY_SORT[sort]);

  // An offset past the end lands on the last page rather than on nothing. The
  // vault is a store somebody else is editing, so a pager two clicks deep can
  // be past the end by the time it is followed — and an empty page there reads
  // as "these notes are gone".
  const lastPage = Math.max(0, Math.floor(Math.max(0, matched.length - 1) / limit) * limit);
  const offset = Math.min(Math.max(0, filter.offset ?? 0), lastPage);

  return {
    notes: matched.slice(offset, offset + limit),
    total: matched.length,
    offset,
    limit,
    folders: facets(folderCounts),
    tags: facets(tagCounts),
    types: facets(typeCounts),
    sort,
    truncated: index.truncated,
  };
}

function noteRef(note: ParsedNote): KnowledgeNoteRefDTO {
  return { path: note.rel, title: note.title, folder: noteFolder(note.rel) };
}

/**
 * The three things wrong with a vault that an operator can go and fix.
 *
 * All three are absences, and an absence is what a browse list cannot show:
 * a note nothing links to looks exactly like a note you have not scrolled to,
 * and a `[[link]]` that resolves to nothing renders as a link until you press
 * it. So they are counted here and named, with the note and — for a broken
 * link — the target that failed to resolve and the line it was written on,
 * which together are enough to find it in Obsidian.
 *
 * "Missing frontmatter" is deliberately the narrowest reading available: no
 * frontmatter block at all. A schema — a required `title`, `tags`, `type` —
 * would be this app inventing a rule for somebody else's vault, and every note
 * it flagged would be a false positive the operator has to learn to ignore.
 */
export function knowledgeHealth(index: KnowledgeIndex): KnowledgeHealthDTO {
  const orphanSet = new Set(index.orphans);
  const orphans: KnowledgeNoteRefDTO[] = [];
  const missingFrontmatter: KnowledgeNoteRefDTO[] = [];

  for (const note of index.notes.values()) {
    if (orphanSet.has(note.rel)) orphans.push(noteRef(note));
    if (Object.keys(note.frontmatter).length === 0) missingFrontmatter.push(noteRef(note));
  }
  orphans.sort((a, b) => a.path.localeCompare(b.path));
  missingFrontmatter.sort((a, b) => a.path.localeCompare(b.path));

  const broken = [...index.brokenLinks].sort(
    (a, b) => a.from.localeCompare(b.from) || a.line - b.line,
  );

  return {
    orphans: orphans.slice(0, KNOWLEDGE_HEALTH_LIST),
    orphanCount: orphans.length,
    brokenLinks: broken.slice(0, KNOWLEDGE_HEALTH_LIST),
    brokenLinkCount: broken.length,
    missingFrontmatter: missingFrontmatter.slice(0, KNOWLEDGE_HEALTH_LIST),
    missingFrontmatterCount: missingFrontmatter.length,
    noteCount: index.notes.size,
    listLimit: KNOWLEDGE_HEALTH_LIST,
    truncated: index.truncated,
    scannedAt: index.scannedAt,
  };
}
