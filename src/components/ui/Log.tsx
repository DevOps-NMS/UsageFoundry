"use client";

import type { ReactNode } from "react";
import type { RunEventDTO } from "@/lib/apiTypes";

/**
 * Exhaustive over the event union on purpose. As a CSS `[data-kind=…]` list
 * this covered seven of the ten kinds and the other three rendered unstyled,
 * indistinguishable from a kind nobody had thought about. Adding an eleventh
 * kind to RunEventDTO is now a compile error here.
 */
const KIND: Record<RunEventDTO["kind"], string> = {
  assistant: "text-ink",
  tool: "text-accent",
  iteration: "text-warn font-semibold",
  budget: "text-ink-muted",
  error: "text-danger",
  result: "text-ok",
  status: "text-ink-muted font-semibold",
  handoff: "text-accent font-semibold",
  land: "text-ok font-semibold",
  review: "text-accent",
  log: "text-ink-muted",
  "replay-complete": "text-ink-faint",
};

export function Log({
  children,
  ref,
  onScroll,
  label = "Run output",
}: {
  children: ReactNode;
  ref?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  label?: string;
}) {
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      // A scrollable region that is not focusable cannot be read by anyone
      // navigating with a keyboard — the content past the fold is simply
      // unreachable. tabIndex is what fixes that; the outline comes from
      // @layer base, so the tab stop is visible when it is taken.
      tabIndex={0}
      role="log"
      // role="log" is politely live by default, and this one emits a line every
      // second or so for the length of a work cycle. Off keeps the region
      // named and navigable without narrating an agent's entire transcript.
      aria-live="off"
      aria-label={label}
      className="max-h-[560px] overflow-y-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-3 font-mono text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </div>
  );
}

export function LogLine({
  kind,
  timestamp,
  children,
}: {
  kind: RunEventDTO["kind"];
  timestamp: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5 py-0.5" data-kind={kind}>
      <span className="shrink-0 tabular-nums text-ink-faint">{timestamp}</span>
      <span className={`min-w-0 flex-1 ${KIND[kind]}`}>{children}</span>
    </div>
  );
}

/**
 * Indeterminate progress. Decorative on purpose — every call site puts a word
 * beside it ("working", "streaming"), and that word is what carries the state.
 *
 * Frozen by prefers-reduced-motion, which is correct: the broken ring still
 * reads as "not finished", where a full ring would read as a bullet.
 */
export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
    />
  );
}
