"use client";

import type { ReactNode } from "react";

/**
 * Markdown, rendered without a markdown dependency.
 *
 * It began as the three headings a review is asked for — a shape this app
 * specified — and is now also how each work cycle's final message is rendered.
 * That text is markdown nobody asked for: a model writes it, and it routinely
 * carries fenced code, inline paths in backticks and numbered steps. So this
 * grew those, and nothing else. Anything it is not sure of still falls through
 * as text rather than as markup it guessed at.
 *
 * A dependency was considered and not added. This is string handling that emits
 * React nodes, so there is no `dangerouslySetInnerHTML` and no sanitiser to
 * keep current — which matters precisely because the input is model-written and
 * unreviewed. Importing a parser to turn that into raw markup would be the one
 * change here that could make it dangerous rather than merely plain.
 *
 * No local imports on purpose: `tsconfig.test.json` emits plain CommonJS and
 * nothing rewrites the `@/` alias at runtime, so a tested component may only
 * import relatively — and this one needs nothing at all.
 */

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "item"; marker: string; text: string }
  | { kind: "text"; text: string }
  | { kind: "gap" };

const FENCE = /^\s*```/;
const HEADING = /^#{1,6}\s*/;
const BULLET = /^[-*+]\s+/;
const ORDERED = /^(\d+)[.)]\s+/;

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
    if (HEADING.test(trimmed)) {
      out.push({ kind: "heading", text: trimmed.replace(HEADING, "") });
      continue;
    }
    const ordered = ORDERED.exec(trimmed);
    if (ordered) {
      // The number is kept rather than bulleted away: "run this third" is the
      // information in an ordered list, and a bullet throws it away.
      out.push({ kind: "item", marker: `${ordered[1]}.`, text: trimmed.replace(ORDERED, "") });
      continue;
    }
    if (BULLET.test(trimmed)) {
      out.push({ kind: "item", marker: "•", text: trimmed.replace(BULLET, "") });
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
 * Code, bold and italic. Deliberately not underscore emphasis: `snake_case_name`
 * would render its middle word italic and drop the underscores, which is a
 * quiet corruption of the identifiers this text is mostly about. Both emphasis
 * forms require a non-space after the marker so that arithmetic and a lone
 * separator stay literal.
 */
const INLINE = /`[^`\n]+`|\*\*[^\s*][^*\n]*\*\*|\*[^\s*][^*\n]*\*/g;

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

    if (token.startsWith("`")) {
      out.push(
        <code key={id} className="rounded-sm bg-inset px-1 font-mono">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={id} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(<em key={id}>{token.slice(1, -1)}</em>);
    }

    cut = at + token.length;
  }

  if (cut < text.length) out.push(text.slice(cut));
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed">
      {blocksOf(text).map((block, i) => {
        const key = String(i);
        if (block.kind === "gap") return <div key={key} className="h-2" />;
        if (block.kind === "code") {
          return (
            <pre
              key={key}
              className="my-2 overflow-x-auto rounded-sm border border-line bg-inset p-2.5 font-mono text-xs leading-relaxed"
            >
              {block.text}
            </pre>
          );
        }
        if (block.kind === "heading") {
          return (
            <div
              key={key}
              className="mt-3.5 mb-1 text-sm font-semibold text-ink first:mt-0"
            >
              {inline(block.text, key)}
            </div>
          );
        }
        if (block.kind === "item") {
          return (
            <div key={key} className="mb-1 flex gap-2 pl-1">
              <span className="shrink-0 tabular-nums text-ink-faint">{block.marker}</span>
              <span className="min-w-0 flex-1">{inline(block.text, key)}</span>
            </div>
          );
        }
        return (
          <p key={key} className="mb-1.5">
            {inline(block.text, key)}
          </p>
        );
      })}
    </div>
  );
}
