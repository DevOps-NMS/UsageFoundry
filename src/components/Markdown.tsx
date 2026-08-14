"use client";

import type { ReactNode } from "react";

/**
 * Markdown, rendered without a markdown dependency.
 *
 * It began as the three headings a review is asked for — a shape this app
 * specified — and is now also how each work cycle's final message is rendered,
 * and how the orchestrator's own turns are. That text is markdown nobody asked
 * for: a model writes it, and it routinely carries fenced code, inline paths in
 * backticks, numbered steps and the occasional issue URL. So this grew those,
 * and nothing else. Anything it is not sure of still falls through as text
 * rather than as markup it guessed at.
 *
 * A dependency was considered and not added. This is string handling that emits
 * React nodes, so there is no `dangerouslySetInnerHTML` and no sanitiser to
 * keep current — which matters precisely because the input is model-written and
 * unreviewed. Importing a parser to turn that into raw markup would be the one
 * change here that could make it dangerous rather than merely plain. The link
 * support below is where that stops being theoretical, which is why `safeHref`
 * is a scheme allowlist and an unknown scheme renders as its own literal text.
 *
 * No local imports on purpose: `tsconfig.test.json` emits plain CommonJS and
 * nothing rewrites the `@/` alias at runtime, so a tested component may only
 * import relatively — and this one needs nothing at all.
 */

type ItemBlock = {
  kind: "item";
  /** "•" or "3." — what is drawn in the marker column. */
  marker: string;
  ordered: boolean;
  /** 0 or 1 only; see `indentDepth`. */
  depth: number;
  text: string;
};

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | ItemBlock
  | { kind: "text"; text: string }
  | { kind: "gap" };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s*/;
const BULLET = /^[-*+]\s+/;
const ORDERED = /^(\d+)[.)]\s+/;
const INDENT = /^[ \t]*/;

/**
 * Nesting, one level and no more.
 *
 * Markdown's indent width is ambiguous — a model writes a sub-item under two
 * spaces as readily as under four — so counting levels from the column has to
 * assume a convention and is then wrong about the other one, which silently
 * re-parents somebody's steps. "Indented at all" is the one reading both
 * conventions agree on, so that is all this claims.
 */
function indentDepth(line: string): number {
  const lead = INDENT.exec(line)?.[0] ?? "";
  return lead.replace(/\t/g, "    ").length >= 2 ? 1 : 0;
}

/**
 * Lines to blocks. Exported for the test, which is about the fence state
 * machine rather than about any of the styling below it.
 */
export function blocksOf(text: string): Block[] {
  const out: Block[] = [];
  let fenced: string[] | null = null;

  for (const line of text.split("\n")) {
    const isFence = FENCE.test(line);

    if (fenced) {
      if (isFence) {
        out.push({ kind: "code", text: fenced.join("\n") });
        fenced = null;
      } else {
        fenced.push(line);
      }
      continue;
    }
    if (isFence) {
      fenced = [];
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      out.push({ kind: "gap" });
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading) {
      out.push({
        kind: "heading",
        level: heading[1].length,
        text: trimmed.replace(HEADING, ""),
      });
      continue;
    }
    const depth = indentDepth(line);
    const ordered = ORDERED.exec(trimmed);
    if (ordered) {
      // The number is kept rather than bulleted away: "run this third" is the
      // information in an ordered list, and a bullet throws it away.
      out.push({
        kind: "item",
        marker: `${ordered[1]}.`,
        ordered: true,
        depth,
        text: trimmed.replace(ORDERED, ""),
      });
      continue;
    }
    if (BULLET.test(trimmed)) {
      out.push({
        kind: "item",
        marker: "•",
        ordered: false,
        depth,
        text: trimmed.replace(BULLET, ""),
      });
      continue;
    }
    out.push({ kind: "text", text: trimmed });
  }

  // An unterminated fence still renders everything it opened over. Dropping it
  // would end a work cycle's report in silence, which reads as a cycle that had
  // nothing to say rather than as markup this did not understand — and a run
  // killed mid-sentence is exactly when a fence is left open.
  if (fenced) out.push({ kind: "code", text: fenced.join("\n") });

  return out;
}

/**
 * Code, bold, italic, a markdown link and a bare URL. Deliberately not
 * underscore emphasis: `snake_case_name` would render its middle word italic
 * and drop the underscores, which is a quiet corruption of the identifiers this
 * text is mostly about. Both emphasis forms require a non-space after the
 * marker so that arithmetic and a lone separator stay literal. Code comes first
 * in the alternation so a URL inside backticks stays a literal string.
 */
const INLINE =
  /`[^`\n]+`|\*\*[^\s*][^*\n]*\*\*|\*[^\s*][^*\n]*\*|\[[^\]\n]+\]\([^\s()]*\)|https?:\/\/[^\s<>"']+/g;

const MD_LINK = /^\[([^\]\n]+)\]\(([^\s()]*)\)$/;

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

function inline(text: string, key: string): ReactNode[] {
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

    if (token.startsWith("`")) {
      out.push(
        <code
          key={id}
          className="rounded-sm bg-inset px-1 py-px font-mono text-[0.9em] text-ink"
        >
          {token.slice(1, -1)}
        </code>,
      );
      continue;
    }
    if (token.startsWith("**")) {
      out.push(
        <strong key={id} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
      continue;
    }
    if (token.startsWith("*")) {
      out.push(<em key={id}>{token.slice(1, -1)}</em>);
      continue;
    }
    if (token.startsWith("[")) {
      const md = MD_LINK.exec(token);
      const href = md ? safeHref(md[2]) : null;
      out.push(md && href ? link(href, md[1], id) : token);
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

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Two tiers, not six. This renders inside a chat turn or a card whose own title
 * is already an <h2>, so the levels a model writes are a relative outline
 * rather than a place in the page's — hence h3 downwards, and a size that says
 * "section of this answer" rather than competing with the page heading.
 *
 * `text-md` on the lead, not `text-base`: the two are 15px and 13px now, and
 * `text-sm` under it is also 13px — so on the macOS type scale the previous
 * pair rendered at one size in one weight, which is one tier wearing two names.
 * A model writing `#` and `###` in the same report got no outline at all.
 */
const HEADING_CLASS: Record<"lead" | "sub", string> = {
  lead: "mt-4 mb-1.5 text-md font-semibold tracking-tight text-ink",
  sub: "mt-3.5 mb-1 text-sm font-semibold text-ink",
};

const LIST_CLASS: Record<"top" | "nested", string> = {
  top: "my-2.5 flex list-none flex-col gap-1",
  nested: "mt-1 flex list-none flex-col gap-1",
};

/** A list item, plus whatever indented items followed it. */
type ListNode = { item: ItemBlock; children: ItemBlock[] };

function nest(items: ItemBlock[]): ListNode[] {
  const out: ListNode[] = [];
  for (const item of items) {
    // A run that opens indented has nothing to hang under, so it is the level.
    if (item.depth > 0 && out.length > 0) out[out.length - 1].children.push(item);
    else out.push({ item, children: [] });
  }
  return out;
}

function List({
  items,
  keyBase,
  nested = false,
}: {
  items: ItemBlock[];
  keyBase: string;
  nested?: boolean;
}) {
  // Only the outer call nests. `indentDepth` yields 0 or 1, so every item in a
  // child list is depth 1 — running them through `nest` again would file the
  // second sub-item under the first instead of beside it.
  const nodes = nested ? items.map((item) => ({ item, children: [] })) : nest(items);
  const ordered = nodes[0].item.ordered;
  const Tag = ordered ? "ol" : "ul";
  return (
    // `role="list"` because `list-none` is what strips list semantics in Safari,
    // and the marker column is drawn rather than generated — a wrapped item has
    // to hang, and a two-digit number has to align with a one-digit one.
    <Tag role="list" className={LIST_CLASS[nested ? "nested" : "top"]}>
      {nodes.map((node, i) => {
        const id = `${keyBase}:${i}`;
        return (
          <li key={id} className="flex gap-2">
            <span
              aria-hidden="true"
              className="w-4 shrink-0 text-right tabular-nums text-ink-muted"
            >
              {node.item.marker}
            </span>
            <div className="min-w-0 flex-1">
              {inline(node.item.text, id)}
              {node.children.length > 0 && (
                <List items={node.children} keyBase={`${id}:sub`} nested />
              )}
            </div>
          </li>
        );
      })}
    </Tag>
  );
}

function leaf(block: Exclude<Block, ItemBlock>, key: string): ReactNode {
  // A blank line is spacing, and spacing is what the margins below already say.
  if (block.kind === "gap") return null;
  if (block.kind === "code") {
    return (
      <pre
        key={key}
        className="my-3 overflow-x-auto rounded-sm border border-line bg-inset p-3 font-mono text-xs leading-relaxed text-ink"
      >
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "heading") {
    const Tag = block.level <= 2 ? "h3" : block.level === 3 ? "h4" : "h5";
    return (
      <Tag key={key} className={HEADING_CLASS[block.level <= 2 ? "lead" : "sub"]}>
        {inline(block.text, key)}
      </Tag>
    );
  }
  return (
    <p key={key} className="my-2.5">
      {inline(block.text, key)}
    </p>
  );
}

/**
 * Consecutive items become one list. A blank line between two items does not
 * end it — that is a loose list, not two lists — but a change of marker kind
 * does, so a numbered sequence is never announced as an unordered pile.
 */
function render(blocks: Block[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind !== "item") {
      out.push(leaf(block, String(i)));
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
    out.push(<List key={String(i)} items={items} keyBase={String(i)} />);
    i = j;
  }

  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    // The first and last block lose their outer margin so this composes into a
    // chat turn or a card without adding a gap nobody asked for. Block layout,
    // not flex, so adjacent paragraph margins collapse to one gap rather than
    // stacking into two.
    <div className="text-sm leading-relaxed text-ink [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      {render(blocksOf(text))}
    </div>
  );
}
