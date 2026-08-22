"use client";

import { useId, type ReactNode } from "react";
import { Disclosure } from "./ui/Disclosure";
import { Table, TableWrap, TBody, Td, Th, THead, Tr } from "./ui/Table";

/**
 * Markdown, rendered without a markdown dependency.
 *
 * It began as the three headings a review is asked for — a shape this app
 * specified — grew into how each work cycle's final message is rendered and how
 * the orchestrator's own turns are, and now also carries the knowledge page.
 * Those two inputs are not the same thing and the difference is what shapes
 * everything below. A cycle's report is markdown nobody asked for: a model
 * writes it, and it carries fenced code, inline paths in backticks, numbered
 * steps and the occasional issue URL. A note is markdown somebody *chose*, in
 * Obsidian, using the whole of what Obsidian draws — callouts, tables, task
 * lists, footnotes, tags, `==highlights==`, `[[wikilinks]]`. Text this renderer
 * does not understand falls through as prose, which on a report is a marker
 * left visible and on a vault is the page failing at its one job: a note whose
 * callouts, tables and checkboxes all render as literal punctuation reads as a
 * file that was never rendered at all.
 *
 * So this covers Obsidian's *markdown*, and deliberately not its *rendering
 * plugins*. Four things are left undone rather than guessed at, and each is a
 * dependency or a route rather than a parser: `$…$` and `$$…$$` need a TeX
 * layout engine; a ```mermaid fence needs a diagram renderer (it renders as the
 * code it is, which is honest); `![[note]]` transclusion needs a second fetch
 * and a recursion guard; and a vault-relative image needs a file-serving route
 * with the containment `resolveInMount` does for a folder — so an `![](…)` is
 * drawn only where the URL is one a browser can already fetch, and is its alt
 * text otherwise. Raw HTML stays refused; see below.
 *
 * A dependency was considered and not added. This is string handling that emits
 * React nodes, so there is no `dangerouslySetInnerHTML` and no sanitiser to
 * keep current — which matters precisely because the input is model-written and
 * unreviewed, and because a vault is written into by the very agents this app
 * spawns. Importing a parser to turn that into raw markup would be the one
 * change here that could make it dangerous rather than merely plain. The link
 * support below is where that stops being theoretical, which is why `safeHref`
 * is a scheme allowlist and an unknown scheme renders as its own literal text.
 *
 * Local imports are relative and never `@/`: `tsconfig.test.json` emits plain
 * CommonJS and nothing rewrites the alias at runtime, so a tested component may
 * only import relatively. The three it takes are kit primitives that import
 * nothing but React themselves, and each is here because the alternative is
 * writing out a recipe that already exists — `Disclosure` is what a `<details>`
 * in this app is, and `Table`'s `stack` plus a `label` per cell is the whole of
 * what keeps a table readable below the breakpoint.
 */

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

type Align = "left" | "center" | "right";

type ItemBlock = {
  kind: "item";
  /** "•" or "3." — what is drawn in the marker column. */
  marker: string;
  ordered: boolean;
  /** How many levels in, counted by `depthFor`. */
  depth: number;
  text: string;
  /**
   * `- [ ]` or `- [x]`. **Absent** on an ordinary bullet rather than `null`,
   * so a plain item is the same object it has always been.
   */
  task?: boolean;
};

type QuoteBlock = {
  kind: "quote";
  /** A callout's type, lowercased. `null` for an ordinary blockquote. */
  callout: string | null;
  /** A callout's own first line. `""` where none was written. */
  title: string;
  /** The `+`/`-` after the type. `null` where the callout does not fold. */
  fold: "open" | "closed" | null;
  /** The quoted text with one `>` level taken off, parsed again on the way out. */
  body: string;
};

type TableBlock = {
  kind: "table";
  head: string[];
  /** One entry per column; `null` where the delimiter row stated no alignment. */
  align: (Align | null)[];
  rows: string[][];
};

type FootnoteBlock = { kind: "footnote"; id: string; text: string };

type Block =
  | { kind: "code"; text: string; lang?: string }
  | { kind: "heading"; level: number; text: string }
  | ItemBlock
  | QuoteBlock
  | TableBlock
  | FootnoteBlock
  | { kind: "rule" }
  | { kind: "text"; text: string }
  | { kind: "gap" };

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const COMMENT_LINE = /^\s*%%\s*$/;
const HEADING = /^(#{1,6})\s+/;
const CLOSING_HASHES = /\s+#+$/;
const BULLET = /^[-*+]\s+/;
const ORDERED = /^(\d+)[.)]\s+/;
// `$` as well as a space: `- [ ]` with nothing after it is the empty row a
// template leaves for the reader to fill in, and it is a checkbox in Obsidian.
const TASK = /^\[([ xX])\](?:\s+|$)/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const SETEXT = /^(?:={2,}|-{2,})$/;
const QUOTE = /^\s{0,3}>\s?/;
const CALLOUT = /^\[!([A-Za-z][\w-]*)\]([+-]?)\s*(.*)$/;
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:\s*(.*)$/;
const INDENT = /^[ \t]*/;

/**
 * An Obsidian block id — `^a-quoted-line` at the end of a line — is an anchor
 * rather than words, so it is taken off what is drawn. At least one letter is
 * required: `mc ^2` is arithmetic somebody wrote, and eating it would change
 * what the sentence says.
 */
const BLOCK_ID = /\s+\^[A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*$/;

function indentWidth(line: string): number {
  const lead = INDENT.exec(line)?.[0] ?? "";
  return lead.replace(/\t/g, "    ").length;
}

/**
 * How far in this item sits, against the columns of the list already open.
 *
 * Markdown's indent width is ambiguous — a note nests under two spaces as
 * readily as under four, and one file does both — so a level counted as
 * "column ÷ 4" has to assume a convention and is then wrong about the other
 * one, which silently re-parents somebody's steps. What is unambiguous is the
 * *order* of the columns seen so far, so that is what a level is here: further
 * in than the line above opens one, back out closes however many it has to.
 *
 * Mutates `columns`, which is the running state of one list; `blocksOf` clears
 * it at every block that ends a list.
 */
function depthFor(columns: number[], width: number): number {
  while (columns.length > 0 && width < columns[columns.length - 1]) columns.pop();
  if (columns.length === 0 || width > columns[columns.length - 1]) columns.push(width);
  return columns.length - 1;
}

/**
 * One table row's cells. A `\|` is a pipe the author wanted rather than a cell
 * boundary, so the split is a scan rather than `String.split`.
 */
function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (inner[i] === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += inner[i];
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * A GFM table starting at `start`, or `null` where the two lines are not one.
 *
 * Both lines have to carry a pipe: without that test a paragraph followed by a
 * setext `---` is a one-column table, which is a heading silently turned into a
 * grid.
 */
function tableAt(lines: string[], start: number): { block: TableBlock; end: number } | null {
  const delimLine = lines[start + 1];
  if (!lines[start].includes("|") || !delimLine?.includes("|")) return null;

  const head = splitRow(lines[start]);
  const delim = splitRow(delimLine);
  if (delim.length !== head.length) return null;
  if (!delim.every((cell) => /^:?-+:?$/.test(cell))) return null;

  const align = delim.map((cell): Align | null => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const rows: string[][] = [];
  let i = start + 2;
  for (; i < lines.length; i += 1) {
    if (!lines[i].trim() || !lines[i].includes("|")) break;
    const cells = splitRow(lines[i]);
    // A short row is padded and a long one cut, so the grid stays rectangular
    // whatever was typed — the alternative is a `<td>` count that disagrees
    // with the header and a table the browser lays out somewhere else.
    rows.push(head.map((_, c) => cells[c] ?? ""));
  }
  return { block: { kind: "table", head, align, rows }, end: i - 1 };
}

/** A run of `>`-stripped lines, as a plain quote or as the callout it declares. */
function quoteBlock(quoted: string[]): QuoteBlock {
  const head = CALLOUT.exec(quoted[0]?.trim() ?? "");
  if (!head) {
    return { kind: "quote", callout: null, title: "", fold: null, body: quoted.join("\n") };
  }
  return {
    kind: "quote",
    callout: head[1].toLowerCase(),
    title: head[3].trim(),
    fold: head[2] === "-" ? "closed" : head[2] === "+" ? "open" : null,
    body: quoted.slice(1).join("\n"),
  };
}

/**
 * Lines to blocks. Exported for the test, which is about the fence state
 * machine rather than about any of the styling below it.
 */
export function blocksOf(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  const columns: number[] = [];
  const endList = () => {
    columns.length = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2].trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const close = FENCE.exec(lines[j]);
        // A closer carries no info string, so a second ```ts inside an open
        // fence is code rather than the end of it.
        if (close && close[1][0] === marker && !close[2].trim()) break;
        body.push(lines[j]);
      }
      // An unterminated fence still renders everything it opened over. Dropping
      // it would end a work cycle's report in silence, which reads as a cycle
      // that had nothing to say rather than as markup this did not understand —
      // and a run killed mid-sentence is exactly when a fence is left open.
      out.push(lang ? { kind: "code", text: body.join("\n"), lang } : { kind: "code", text: body.join("\n") });
      endList();
      i = j;
      continue;
    }

    // `%%` on its own line opens a comment block. It is not a gap: a comment
    // between two items must not split the list somebody wrote around it.
    if (COMMENT_LINE.test(line)) {
      let j = i + 1;
      while (j < lines.length && !COMMENT_LINE.test(lines[j])) j += 1;
      i = j;
      continue;
    }

    if (!trimmed) {
      out.push({ kind: "gap" });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      let j = i;
      for (; j < lines.length && QUOTE.test(lines[j]); j += 1) {
        quoted.push(lines[j].replace(QUOTE, ""));
      }
      out.push(quoteBlock(quoted));
      endList();
      i = j - 1;
      continue;
    }

    if (trimmed.includes("|")) {
      const table = tableAt(lines, i);
      if (table) {
        out.push(table.block);
        endList();
        i = table.end;
        continue;
      }
    }

    const foot = FOOTNOTE_DEF.exec(trimmed);
    if (foot) {
      const parts = [foot[2]];
      // An indented line under a definition continues it, which is how a
      // footnote of two sentences is written.
      let j = i + 1;
      while (
        j < lines.length &&
        lines[j].trim() &&
        indentWidth(lines[j]) >= 2 &&
        !FOOTNOTE_DEF.test(lines[j].trim())
      ) {
        parts.push(lines[j].trim());
        j += 1;
      }
      out.push({ kind: "footnote", id: foot[1], text: parts.join("\n") });
      endList();
      i = j - 1;
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      out.push({
        kind: "heading",
        level: heading[1].length,
        text: trimmed.replace(HEADING, "").replace(CLOSING_HASHES, "").replace(BLOCK_ID, ""),
      });
      endList();
      continue;
    }

    // A rule under a paragraph is a setext heading rather than a rule, which is
    // what Obsidian draws for it too. Checked before `RULE` because `---`
    // spells both.
    const above = out[out.length - 1];
    if (SETEXT.test(trimmed) && above?.kind === "text") {
      out[out.length - 1] = {
        kind: "heading",
        level: trimmed.startsWith("=") ? 1 : 2,
        text: above.text,
      };
      endList();
      continue;
    }
    if (RULE.test(trimmed)) {
      out.push({ kind: "rule" });
      endList();
      continue;
    }

    const ordered = ORDERED.exec(trimmed);
    if (ordered || BULLET.test(trimmed)) {
      const rest = trimmed.replace(ordered ? ORDERED : BULLET, "");
      const task = TASK.exec(rest);
      out.push({
        kind: "item",
        // The number is kept rather than bulleted away: "run this third" is the
        // information in an ordered list, and a bullet throws it away.
        marker: ordered ? `${ordered[1]}.` : "•",
        ordered: Boolean(ordered),
        depth: depthFor(columns, indentWidth(line)),
        text: (task ? rest.replace(TASK, "") : rest).replace(BLOCK_ID, ""),
        ...(task ? { task: task[1] !== " " } : {}),
      });
      continue;
    }

    // An indented line with no marker under an item is the rest of that item's
    // sentence, not a paragraph that ends the list.
    if (indentWidth(line) >= 2 && above?.kind === "item") {
      out[out.length - 1] = { ...above, text: `${above.text}\n${trimmed.replace(BLOCK_ID, "")}` };
      continue;
    }

    out.push({ kind: "text", text: trimmed.replace(BLOCK_ID, "") });
    endList();
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

/**
 * One alternation, written a line at a time because it is now seventeen of
 * them. Order matters only where two alternatives can start at the same
 * character, since the scan is leftmost-first: the escape leads so a `\*` is
 * never an emphasis marker, code comes before everything so a URL — or a
 * `[[wikilink]]` — inside backticks stays a literal string, and the longer
 * emphasis runs come before the shorter ones they are a prefix of.
 *
 * Asterisk emphasis requires a non-space after the marker so that arithmetic
 * and a lone separator stay literal. Underscore emphasis additionally refuses a
 * word character on either outside edge, which is the whole of why
 * `snake_case_name` survives: the middle `_` is inside a word, so it can
 * neither open nor close, and the identifiers this text is mostly about are not
 * quietly corrupted. That rule needs a lookbehind, which is older in every
 * engine than the `light-dark()` this app's entire palette is written in.
 *
 * A tag refuses a preceding word character for the same reason (`C#` is a
 * language) and requires a letter somewhere (`#42` is an issue number).
 */
const INLINE = new RegExp(
  [
    /\\[\\`*_~=[\]()#!|^{}<>+.-]/,
    /``[^\n]+?``/,
    /`[^`\n]+`/,
    /%%[^\n]*?%%/,
    /!?\[\[[^\][\n]+\]\]/,
    /!\[[^\]\n]*\]\([^\s()]*\)/,
    /\[\^[^\]\s]+\]/,
    /\[[^\]\n]+\]\([^\s()]*\)/,
    /\*\*\*[^\s*][^*\n]*\*\*\*/,
    /\*\*[^\s*][^*\n]*\*\*/,
    /\*[^\s*][^*\n]*\*/,
    /(?<![A-Za-z0-9_])__[^\s_][^_\n]*__(?![A-Za-z0-9_])/,
    /(?<![A-Za-z0-9_])_[^\s_][^_\n]*_(?![A-Za-z0-9_])/,
    /~~[^\s~][^~\n]*~~/,
    /==[^\s=][^=\n]*==/,
    /(?<![\w#&/])#[A-Za-z0-9_/-]*[A-Za-z_][A-Za-z0-9_/-]*/,
    /https?:\/\/[^\s<>"']+/,
  ]
    .map((part) => part.source)
    .join("|"),
  "g",
);

const MD_LINK = /^!?\[([^\]\n]*)\]\(([^\s()]*)\)$/;
const WIKILINK = /^!?\[\[([^\][\n]+)\]\]$/;

/** A `[[Target#Heading|label]]`, taken apart. */
export type Wikilink = {
  /** `![[…]]` rather than `[[…]]`. */
  embed: boolean;
  /** What the link resolves against. `""` for `[[#Heading]]`, a same-note link. */
  target: string;
  /** `Heading` or `^block-id`, without the `#`. `null` where none was written. */
  heading: string | null;
  /** What is drawn: the explicit `|label`, or the target exactly as written. */
  label: string;
};

/**
 * What a caller's vault says about one wikilink.
 *
 * Three cases rather than a nullable href, because three is what a reader has
 * to tell apart and collapsing any two of them lies. `other` is a target that
 * exists and is not a page — an embedded image, a tag — and rendering it as
 * broken would report a healthy vault as a broken one; `missing` is a link that
 * goes nowhere, and rendering it as ordinary text is the failure this whole
 * extension exists to fix.
 */
export type WikilinkResolution =
  | { kind: "note"; href: string }
  | { kind: "other" }
  | { kind: "missing" };

type Resolve = ((link: Wikilink) => WikilinkResolution) | undefined;

/**
 * What every renderer below needs and neither half of which is a block.
 *
 * `ids` is one instance's own prefix, from `useId`. Footnote anchors are the
 * only ids this file emits and the chat page draws a dozen `Markdown`s at once,
 * so a bare `#fn-1` would be a link that lands in whichever turn rendered
 * first — a jump to the wrong note's footnote, which looks like a footnote that
 * disagrees with the sentence above it.
 *
 * `footnotes` is every definition in the document, by the order it was written
 * in. A reference is drawn as its number rather than its label — `[^why]` is a
 * name for the author, and a superscript "why" beside a word reads as the word
 * having been cut short — and one with no definition behind it is not in the
 * map, which is what keeps it literal text instead of a link to nowhere.
 */
type Ctx = {
  resolve: Resolve;
  ids: string;
  footnotes: Map<string, number>;
  /**
   * Whether a `> [!type]-` may become a real fold here.
   *
   * A nested disclosure is on this app's never-used list and on the vault's,
   * for the same reason: a fold inside a fold is a control the reader has to
   * find twice. `RunOutput` already renders every earlier cycle's report inside
   * one, so a model writing Obsidian's fold syntax into a report would build
   * the nesting from the inside — and a callout's body clears this again, so an
   * author cannot build it either. Where folding is refused the callout renders
   * **open**, which is the safe direction: hiding is the last move.
   */
  canFold: boolean;
};

/**
 * Exported for the test. A wikilink's parts are positional and silent when
 * misread: an alias taken as a heading points the link at a note that exists,
 * and a `|label` swallowed into the target breaks one that resolves.
 */
export function parseWikilink(token: string): Wikilink | null {
  const inner = WIKILINK.exec(token)?.[1];
  if (inner === undefined) return null;

  // Split on the *first* pipe only: Obsidian allows a label containing one, and
  // a display string is not something to reject a link over.
  const pipe = inner.indexOf("|");
  const addressed = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const label = pipe === -1 ? "" : inner.slice(pipe + 1).trim();

  const hash = addressed.indexOf("#");
  const target = (hash === -1 ? addressed : addressed.slice(0, hash)).trim();
  const heading = hash === -1 ? null : addressed.slice(hash + 1).trim() || null;

  // `[[|x]]` addresses nothing. Rendering it as a link would give the reader
  // something to press that no vault can answer for.
  if (!target && !heading) return null;

  return { embed: token.startsWith("!"), target, heading, label: label || addressed };
}

/**
 * The one place model-written text becomes something clickable.
 *
 * A scheme allowlist rather than a `javascript:` denylist: the set of schemes a
 * browser will execute is not fixed and not ours to track, where the set worth
 * linking to here is three long. Anything else keeps its markers and renders as
 * its own literal text — visible, inert, and not quietly deleted, because a
 * link this refused to make is worth seeing.
 */
function safeHref(url: string): string | null {
  const href = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (!scheme) return null;
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? href : null;
}

/**
 * Trailing sentence punctuation is not part of a bare URL. The characters cut
 * here are not dropped — `inline` rewinds its cursor, so they are emitted by
 * the next run of plain text.
 */
function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if (".,;:!?".includes(c)) {
      end -= 1;
      continue;
    }
    // A closing paren belongs to the URL only if the URL opened one.
    if (c === ")" && !url.slice(0, end).includes("(")) {
      end -= 1;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

const LINK_CLASS =
  "text-accent underline decoration-accent/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-accent";

function link(href: string, label: string, key: string): ReactNode {
  return (
    // New tab: everything linked from here is somewhere else (an issue, a run
    // log on GitHub), and losing the conversation to a misclick is the cost of
    // the alternative.
    <a key={key} href={href} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
      {label}
    </a>
  );
}

/**
 * A broken link has to be visible without colour: a dotted underline is the
 * cue, the warn colour reinforces it, and the suffix is what carries it to a
 * reader who gets neither.
 */
const BROKEN_CLASS =
  "text-warn underline decoration-dotted decoration-warn underline-offset-2 [overflow-wrap:anywhere]";

function wikilink(token: string, key: string, ctx: Ctx): ReactNode {
  // No resolver means no vault to resolve against, so the token stays its own
  // literal text — which is what every caller predating this prop already got,
  // and is why adding the prop changed none of them.
  if (!ctx.resolve) return token;
  const parsed = parseWikilink(token);
  if (!parsed) return token;

  const found = ctx.resolve(parsed);
  // The label is text the author wrote, so it is scanned like any other: an
  // alias reading `[[Long Note Title|Wallace et al. (2022, **n = 352**)]]` is
  // one of the few places a citation carries its own emphasis, and a label is
  // the one string here that never contains another wikilink to recurse into.
  const label = inline(parsed.label, `${key}:l`, ctx);

  if (found.kind === "note") {
    return (
      // Same tab, unlike `link()`: a wikilink goes to another note on the page
      // it was pressed from, where an external URL goes somewhere else entirely.
      // A plain href rather than a router call, so this file keeps its promise
      // of importing nothing that reaches the app — the page delegates the
      // click and navigates.
      <a key={key} href={found.href} className={LINK_CLASS}>
        {label}
      </a>
    );
  }
  // A target that exists and is not a page: an embedded image, a tag. It is not
  // broken, so it must not be marked as broken.
  if (found.kind === "other") return label;

  return (
    <span key={key} className={BROKEN_CLASS}>
      {label}
      <span className="sr-only"> — broken link</span>
    </span>
  );
}

/**
 * The text inside an emphasis run, scanned again or taken as written.
 *
 * `INLINE` is one flat alternation, so a `**` token swallows everything up to
 * its closing pair — a bolded wikilink then reaches `<strong>` as the literal
 * characters `[[Coding Principles]]`, which is precisely the "renders as
 * ordinary text" failure this file exists to avoid. Vaults do write them:
 * 213 of the 13,100 wikilinks in the one measured here are inside emphasis.
 *
 * Rescanning is gated on there being a vault to ask, so a caller with no
 * resolver — every caller that predates wikilinks, and every model-written
 * report — renders exactly as it did before.
 */
function emphasised(inner: string, key: string, ctx: Ctx): ReactNode {
  return ctx.resolve ? inline(inner, key, ctx) : inner;
}

/** A tag chip. Not a link: nothing in this file knows where a vault's tag lives. */
const TAG_CLASS =
  "rounded-sm bg-inset px-1 py-px font-mono text-[0.85em] text-ink-muted [overflow-wrap:anywhere]";

function anchorId(prefix: string, id: string): string {
  return `${prefix}-fn-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function inline(text: string, key: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let cut = 0;

  for (const match of text.matchAll(INLINE)) {
    // `typeof` rather than `?? cut`: which of `RegExpExecArray` (index: number)
    // and `RegExpMatchArray` (index?: number) `matchAll` resolves to depends on
    // the TypeScript version, and this narrows correctly under both.
    const at = typeof match.index === "number" ? match.index : cut;
    if (at > cut) out.push(text.slice(cut, at));
    const token = match[0];
    const id = `${key}:${at}`;
    cut = at + token.length;

    if (token.startsWith("\\")) {
      // The escape is consumed and the character it protected is emitted as
      // itself, which is the whole point of writing one.
      out.push(token.slice(1));
      continue;
    }
    if (token.startsWith("%%")) continue;
    if (token.startsWith("`")) {
      const fence = token.startsWith("``") ? 2 : 1;
      out.push(
        <code
          key={id}
          className="rounded-sm bg-inset px-1 py-px font-mono text-[0.9em] text-ink"
        >
          {token.slice(fence, -fence).trim()}
        </code>,
      );
      continue;
    }
    if (token.startsWith("[[") || token.startsWith("![[")) {
      out.push(wikilink(token, id, ctx));
      continue;
    }
    if (token.startsWith("![")) {
      const md = MD_LINK.exec(token);
      const src = md ? safeHref(md[2]) : null;
      // No src a browser can fetch means the alt text, which is what the author
      // wrote the image to say.
      out.push(
        md && src ? (
          <img
            key={id}
            src={src}
            alt={md[1]}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="my-2 max-w-full rounded-sm border border-line"
          />
        ) : (
          (md?.[1] ?? token)
        ),
      );
      continue;
    }
    if (token.startsWith("[^")) {
      const ref = token.slice(2, -1);
      const number = ctx.footnotes.get(ref);
      // A reference nobody defined stays the characters the author typed, for
      // the reason a dangling wikilink is marked rather than linked: a marker
      // that goes nowhere is worse than one that is visibly unfinished.
      if (number === undefined) {
        out.push(token);
        continue;
      }
      out.push(
        <sup key={id}>
          <a href={`#${anchorId(ctx.ids, ref)}`} className={LINK_CLASS}>
            {number}
          </a>
        </sup>,
      );
      continue;
    }
    if (token.startsWith("[")) {
      const md = MD_LINK.exec(token);
      const href = md ? safeHref(md[2]) : null;
      out.push(md && href ? link(href, md[1], id) : token);
      continue;
    }
    if (token.startsWith("***")) {
      out.push(
        <strong key={id} className="font-semibold text-ink">
          <em>{emphasised(token.slice(3, -3), id, ctx)}</em>
        </strong>,
      );
      continue;
    }
    if (token.startsWith("**") || token.startsWith("__")) {
      out.push(
        <strong key={id} className="font-semibold text-ink">
          {emphasised(token.slice(2, -2), id, ctx)}
        </strong>,
      );
      continue;
    }
    if (token.startsWith("*") || token.startsWith("_")) {
      out.push(<em key={id}>{emphasised(token.slice(1, -1), id, ctx)}</em>);
      continue;
    }
    if (token.startsWith("~~")) {
      out.push(
        <s key={id} className="text-ink-muted">
          {emphasised(token.slice(2, -2), id, ctx)}
        </s>,
      );
      continue;
    }
    if (token.startsWith("==")) {
      out.push(
        // `<mark>`'s UA style is a fixed yellow that reads as a foreign object
        // in both schemes, so the tone comes from the palette instead.
        <mark key={id} className="rounded-sm bg-warn/25 px-0.5 text-ink">
          {emphasised(token.slice(2, -2), id, ctx)}
        </mark>,
      );
      continue;
    }
    if (token.startsWith("#")) {
      // A tag is a vault concept, so it is drawn only where there is a vault.
      // In a work cycle's report `#done` is a word somebody wrote.
      out.push(
        ctx.resolve ? (
          <span key={id} className={TAG_CLASS}>
            {token}
          </span>
        ) : (
          token
        ),
      );
      continue;
    }

    const url = trimUrlTail(token);
    const href = safeHref(url);
    // Rewound so the punctuation this dropped is emitted as text, not lost.
    cut = at + url.length;
    out.push(href ? link(href, url, id) : url);
  }

  if (cut < text.length) out.push(text.slice(cut));
  return out;
}

/**
 * Inline text that may hold the author's own line breaks.
 *
 * A newline inside a paragraph is a `<br>` rather than a space, which is what
 * Obsidian's reading view draws with its default settings — and which is also
 * the smaller change from what this used to do, since every line was its own
 * `<p>` and a hard-wrapped sentence came out with a paragraph gap in the middle
 * of it.
 */
function inlineLines(text: string, key: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) out.push(<br key={`${key}:br${i}`} />);
    out.push(...inline(line, `${key}:${i}`, ctx));
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Four visual steps over three ranks, which is deliberate on both counts.
 *
 * Three ranks because this renders inside a chat turn or a card whose own title
 * is already a heading, so the levels an author writes are a relative outline
 * rather than a place in the page's — hence h3 downwards. `#` and `##` share
 * h3 so that a note opening at `##`, which is most of them, does not skip a
 * level under the title above it.
 *
 * Four sizes because a note is an outline somebody wrote and six levels drawn
 * at two near-body classes is a flat wall. Rank and size are allowed to
 * disagree: the rank is the note's place in *this page*, the size is the
 * author's own hierarchy, and only one of the two has to be clamped. `#` and
 * `##` differ by weight, everything below them by size — 15 / 13 / 12 on the
 * app's scale — because hierarchy here is said with size, weight and
 * whitespace, never with a colour or a second border.
 *
 * The top margin carries the rest. A heading has to group with what is under
 * it, and the gap *below* one is not the heading's to set: adjacent margins
 * collapse, so a following paragraph's own `mt-2.5` wins whatever `mb` is
 * written here. The space above is therefore what says "new section" — 28 / 24
 * / 20 / 20 against the 10 a paragraph or a list contributes below and the 12 a
 * table, a fence or a callout does.
 */
const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: "mt-7 mb-1 text-md font-bold tracking-tight text-ink",
  2: "mt-6 mb-1 text-md font-semibold tracking-tight text-ink",
  3: "mt-5 mb-1 text-sm font-semibold text-ink",
  4: "mt-5 mb-1 text-xs font-semibold text-ink",
};

/** `#####` and `######` are the same step as `####`; nothing draws six. */
function headingStep(level: number): 1 | 2 | 3 | 4 {
  if (level <= 1) return 1;
  if (level === 2) return 2;
  if (level === 3) return 3;
  return 4;
}

const LIST_CLASS: Record<"top" | "nested", string> = {
  top: "my-2.5 flex list-none flex-col gap-1",
  nested: "mt-1 flex list-none flex-col gap-1",
};

type CalloutTone = "accent" | "ok" | "warn" | "danger" | "neutral";

/**
 * Obsidian's callout vocabulary, folded onto this app's four tones plus a
 * neutral one. The aliases are Obsidian's own — `tldr` and `summary` are the
 * same callout as `abstract` — and an unrecognised type falls back to the note
 * treatment for the same reason Obsidian does: a typo should read as a callout
 * somebody wrote, not as an error this app invented.
 */
const CALLOUT_TONE: Record<string, CalloutTone> = {
  note: "accent",
  info: "accent",
  todo: "accent",
  abstract: "accent",
  summary: "accent",
  tldr: "accent",
  tip: "accent",
  hint: "accent",
  important: "accent",
  example: "accent",
  success: "ok",
  check: "ok",
  done: "ok",
  question: "warn",
  help: "warn",
  faq: "warn",
  warning: "warn",
  caution: "warn",
  attention: "warn",
  failure: "danger",
  fail: "danger",
  missing: "danger",
  danger: "danger",
  error: "danger",
  bug: "danger",
  quote: "neutral",
  cite: "neutral",
};

const CALLOUT_BOX: Record<CalloutTone, string> = {
  accent: "border-accent-line bg-accent/8",
  ok: "border-ok-line bg-ok/8",
  warn: "border-warn-line bg-warn/8",
  danger: "border-danger-line bg-danger/8",
  neutral: "border-line bg-inset",
};

const CALLOUT_TITLE: Record<CalloutTone, string> = {
  accent: "text-accent",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  neutral: "text-ink-muted",
};

const CALLOUT_SHELL = "my-3 rounded-sm border px-3 py-2.5";

/** A list item, plus whatever hung under it. */
type ListNode = { item: ItemBlock; children: ListNode[] };

/**
 * A flat run of items, by the depth each one recorded.
 *
 * Recursive rather than one level deep: a note is an outline somebody wrote,
 * and flattening its third level puts a sub-point beside the point it belongs
 * to. A run that opens indented has nothing to hang under, so it is the level.
 */
function nest(items: ItemBlock[], depth: number): ListNode[] {
  const out: ListNode[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].depth > depth && out.length > 0) {
      let j = i;
      while (j < items.length && items[j].depth > depth) j += 1;
      out[out.length - 1].children = nest(items.slice(i, j), depth + 1);
      i = j - 1;
      continue;
    }
    out.push({ item: items[i], children: [] });
  }
  return out;
}

function List({
  nodes,
  keyBase,
  ctx,
  nested = false,
}: {
  nodes: ListNode[];
  keyBase: string;
  ctx: Ctx;
  nested?: boolean;
}) {
  const Tag = nodes[0].item.ordered ? "ol" : "ul";
  return (
    // `role="list"` because `list-none` is what strips list semantics in Safari,
    // and the marker column is drawn rather than generated — a wrapped item has
    // to hang, and a two-digit number has to align with a one-digit one.
    <Tag role="list" className={LIST_CLASS[nested ? "nested" : "top"]}>
      {nodes.map((node, i) => {
        const id = `${keyBase}:${i}`;
        return (
          <li key={id} className="flex gap-2">
            {node.item.task === undefined ? (
              <span aria-hidden="true" className="w-4 shrink-0 text-right tabular-nums text-ink-muted">
                {node.item.marker}
              </span>
            ) : (
              // A real checkbox rather than a glyph, so the state is announced
              // rather than drawn. Disabled because this renderer cannot write
              // the file back: a box that answers the pointer and changes
              // nothing on disk is worse than one that says it is not yours.
              <span className="flex w-4 shrink-0 justify-end pt-0.5">
                <input
                  type="checkbox"
                  checked={node.item.task}
                  readOnly
                  disabled
                  aria-label={node.item.task ? "Done" : "Not done"}
                  className="size-3.5 accent-tint"
                />
              </span>
            )}
            <div className="min-w-0 flex-1">
              {inlineLines(node.item.text, id, ctx)}
              {node.children.length > 0 && (
                <List nodes={node.children} keyBase={`${id}:sub`} ctx={ctx} nested />
              )}
            </div>
          </li>
        );
      })}
    </Tag>
  );
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function Callout({ block, keyBase, ctx }: { block: QuoteBlock; keyBase: string; ctx: Ctx }) {
  const type = block.callout ?? "note";
  const tone = CALLOUT_TONE[type] ?? "accent";
  const title = (
    <span className={`font-semibold ${CALLOUT_TITLE[tone]}`}>
      {block.title ? inline(block.title, `${keyBase}:t`, ctx) : titleCase(type)}
    </span>
  );
  const body = (gap: string) =>
    block.body.trim() ? (
      // The first and last block give up their outer margin so the box's own
      // padding is the whole of the gap — a caller's class cancelling a
      // component's spacing is the failure this avoids by not writing one.
      <div className={`${gap} [&>:first-child]:mt-0 [&>:last-child]:mb-0`}>
        {/* Whatever is inside this one may not fold — see `Ctx.canFold`. */}
        {render(blocksOf(block.body), `${keyBase}:b`, { ...ctx, canFold: false })}
      </div>
    ) : null;

  // `+`/`-` is the author saying this one folds, and a fold in a note is their
  // decision rather than this app's — which is the one case the "hiding is the
  // last move" rule does not get to overrule. Only where a fold is theirs to
  // make, though: `canFold` is what keeps this out of a disclosure it is
  // already inside.
  if (block.fold && ctx.canFold) {
    return (
      <Disclosure
        summary={title}
        defaultOpen={block.fold === "open"}
        className={`${CALLOUT_SHELL} ${CALLOUT_BOX[tone]}`}
      >
        {body("mt-1.5")}
      </Disclosure>
    );
  }
  return (
    <div className={`${CALLOUT_SHELL} ${CALLOUT_BOX[tone]}`}>
      <p className={block.body.trim() ? "mb-1.5" : ""}>{title}</p>
      {body("")}
    </div>
  );
}

function MarkdownTable({ block, keyBase, ctx }: { block: TableBlock; keyBase: string; ctx: Ctx }) {
  // Rendered once and used twice — as the column head and as every cell's
  // stacked label. The label is the *only* thing naming a value below the
  // breakpoint, so handing `Td` the raw string there put `**bold**` and
  // `[[wikilinks]]` on the phone in a table that reads correctly on the
  // desktop: 621 of the vault's 785 notes carry a table, and the ones whose
  // heads are written in markdown were showing it.
  const heads = block.head.map((cell, c) => inline(cell, `${keyBase}:h:${c}`, ctx));

  return (
    <div className="my-3">
      <TableWrap>
        {/*
          `stack` with the column head as each cell's `label`: below the
          breakpoint the heads come off the screen, and a note's table is
          exactly the case that rule was written for — the reader has no idea
          what the app's columns are, because they are not the app's.
        */}
        <Table stack>
          <THead>
            <Tr>
              {heads.map((head, c) => (
                <Th key={c} num={block.align[c] === "right"}>
                  {head}
                </Th>
              ))}
            </Tr>
          </THead>
          <TBody>
            {block.rows.map((row, r) => (
              <Tr key={r}>
                {row.map((cell, c) => (
                  <Td
                    key={c}
                    num={block.align[c] === "right"}
                    label={block.head[c] ? heads[c] : undefined}
                  >
                    {/*
                      Centring goes on a wrapper rather than the cell's own
                      class: two `text-align` utilities on one element resolve
                      by stylesheet order, so `Td`'s would win or lose by where
                      Tailwind happened to emit it.
                    */}
                    {block.align[c] === "center" ? (
                      <span className="block text-center">
                        {inline(cell, `${keyBase}:${r}:${c}`, ctx)}
                      </span>
                    ) : (
                      inline(cell, `${keyBase}:${r}:${c}`, ctx)
                    )}
                  </Td>
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>
      </TableWrap>
    </div>
  );
}

function leaf(block: Exclude<Block, ItemBlock>, key: string, ctx: Ctx): ReactNode {
  // A blank line is spacing, and spacing is what the margins below already say.
  if (block.kind === "gap") return null;
  // Collected and drawn once at the end — see `render`.
  if (block.kind === "footnote") return null;
  if (block.kind === "rule") {
    return <hr key={key} className="my-4 border-0 border-t border-line" />;
  }
  if (block.kind === "code") {
    return (
      <div key={key} className="my-3 overflow-hidden rounded-sm border border-line bg-inset">
        {block.lang && (
          // The info string, drawn rather than dropped: on a note it is often
          // the only thing saying what the block is (`dataview`, `mermaid`),
          // and this renders neither.
          <div className="border-b border-line px-3 py-1 font-mono text-[0.85em] text-ink-muted">
            {block.lang}
          </div>
        )}
        {/*
          `em` and not `text-xs`: an inline `` `path` `` is 0.9em, so with the
          block on an absolute step the two drifted apart whenever the base
          moved, and a fenced line came out larger than the same characters
          quoted in the sentence above it. One relationship, stated once.
        */}
        <pre className="overflow-x-auto p-3 font-mono text-[0.9em] leading-relaxed text-ink">
          <code>{block.text}</code>
        </pre>
      </div>
    );
  }
  if (block.kind === "heading") {
    const Tag = block.level <= 2 ? "h3" : block.level === 3 ? "h4" : "h5";
    return (
      <Tag key={key} className={HEADING_CLASS[headingStep(block.level)]}>
        {inline(block.text, key, ctx)}
      </Tag>
    );
  }
  if (block.kind === "table") {
    return <MarkdownTable key={key} block={block} keyBase={key} ctx={ctx} />;
  }
  if (block.kind === "quote") {
    if (block.callout) return <Callout key={key} block={block} keyBase={key} ctx={ctx} />;
    return (
      // Body colour, with the rule carrying the emphasis — which is what
      // Obsidian draws and what a quote is: somebody else's sentence, not a
      // disabled one. Muting the text made a quoted paragraph read as
      // unavailable, and it is often the most-cited thing on the page.
      <blockquote key={key} className="my-3 border-l-2 border-line-strong pl-3">
        {render(blocksOf(block.body), `${key}:q`, ctx)}
      </blockquote>
    );
  }
  return (
    <p key={key} className="my-2.5">
      {inlineLines(block.text, key, ctx)}
    </p>
  );
}

function Footnotes({ notes, keyBase, ctx }: { notes: FootnoteBlock[]; keyBase: string; ctx: Ctx }) {
  return (
    // A `<div>` and not a `<section>`: the legacy layer still carries
    // `section + section { margin-top: 24px }`, which would push this down by a
    // figure nobody chose.
    //
    // `leading-normal` is stated rather than inherited: an arbitrary `text-[…]`
    // carries no line height of its own, so trading `text-xs` for a relative
    // step would otherwise have handed footnotes the root's `leading-relaxed`
    // too, moving two things where one was meant.
    <div className="mt-5 border-t border-line pt-2 text-[0.9em] leading-normal text-ink-muted">
      <ol role="list" className="flex list-none flex-col gap-1">
        {notes.map((note, i) => (
          // `scroll-mt-4` because this is where a reference lands, and a note
          // flush against the top edge of the pane's scroller reads as the top
          // of the document rather than as the thing that was jumped to. Four
          // and not the toolbar's height: the toolbar is a sibling *above*
          // `<main>` rather than sticky over it, so nothing here is ever under
          // it — `settings/page.tsx` picked the same figure for the same
          // reason.
          <li
            key={`${keyBase}:${i}`}
            id={anchorId(ctx.ids, note.id)}
            className="flex scroll-mt-4 gap-2"
          >
            <span aria-hidden="true" className="shrink-0 tabular-nums">
              {ctx.footnotes.get(note.id) ?? i + 1}.
            </span>
            <div className="min-w-0 flex-1">
              {inlineLines(note.text, `${keyBase}:${i}`, ctx)}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Consecutive items become one list. A blank line between two items does not
 * end it — that is a loose list, not two lists — but a change of marker kind
 * does, so a numbered sequence is never announced as an unordered pile.
 *
 * Consecutive text lines become one paragraph rather than one each, and
 * footnote definitions are pulled out wherever they were written and drawn
 * together at the end, which is where a reader looks for them.
 */
function render(blocks: Block[], keyBase: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  const notes: FootnoteBlock[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];
    const key = `${keyBase}:${i}`;

    if (block.kind === "footnote") {
      notes.push(block);
      i += 1;
      continue;
    }

    if (block.kind === "text") {
      const lines: string[] = [];
      let j = i;
      for (; j < blocks.length; j += 1) {
        const next = blocks[j];
        if (next.kind !== "text") break;
        lines.push(next.text);
      }
      out.push(
        <p key={key} className="my-2.5">
          {inlineLines(lines.join("\n"), key, ctx)}
        </p>,
      );
      i = j;
      continue;
    }

    if (block.kind !== "item") {
      out.push(leaf(block, key, ctx));
      i += 1;
      continue;
    }

    const items: ItemBlock[] = [];
    let j = i;
    while (j < blocks.length) {
      const next = blocks[j];
      if (next.kind === "item") {
        if (items.length > 0 && next.depth === 0 && next.ordered !== items[0].ordered) break;
        items.push(next);
        j += 1;
        continue;
      }
      if (next.kind === "gap") {
        let k = j;
        while (k < blocks.length && blocks[k].kind === "gap") k += 1;
        if (k < blocks.length && blocks[k].kind === "item") {
          j = k;
          continue;
        }
      }
      break;
    }
    out.push(<List key={key} nodes={nest(items, 0)} keyBase={key} ctx={ctx} />);
    i = j;
  }

  if (notes.length > 0) {
    out.push(<Footnotes key={`${keyBase}:fn`} notes={notes} keyBase={`${keyBase}:fn`} ctx={ctx} />);
  }
  return out;
}

export function Markdown({
  text,
  resolveWikilink,
}: {
  text: string;
  /**
   * A vault to resolve `[[wikilinks]]` against, and the switch on the two
   * extensions that only mean something inside one — a `#tag` is a chip in a
   * note and a word in a report.
   *
   * Optional, and absent everywhere this renderer draws model-written text: a
   * work cycle's report is not a note and has no vault behind it, so a `[[…]]`
   * there stays exactly the text the model wrote rather than becoming a link to
   * somewhere or a warning about nowhere.
   */
  resolveWikilink?: (link: Wikilink) => WikilinkResolution;
}) {
  const ids = useId().replace(/[^A-Za-z0-9]/g, "");
  const blocks = blocksOf(text);
  // Numbered where they were defined, not where they were first cited: that is
  // what Obsidian draws, and a list whose numbers run 2, 1, 3 down the page
  // reads as the list itself being out of order.
  const footnotes = new Map(
    blocks
      .filter((block): block is FootnoteBlock => block.kind === "footnote")
      .map((block, i) => [block.id, i + 1] as const),
  );

  return (
    // The first and last block lose their outer margin so this composes into a
    // chat turn or a card without adding a gap nobody asked for. Block layout,
    // not flex, so adjacent paragraph margins collapse to one gap rather than
    // stacking into two.
    <div className="text-sm leading-relaxed text-ink [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      {render(blocks, "b", {
        resolve: resolveWikilink,
        ids,
        footnotes,
        // The vault is the switch: the knowledge page is the one caller that
        // renders a note, and the only one that does not already sit inside a
        // `Disclosure` of its own.
        canFold: resolveWikilink !== undefined,
      })}
    </div>
  );
}
