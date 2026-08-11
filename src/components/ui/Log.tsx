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
}: {
  children: ReactNode;
  ref?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="max-h-[560px] overflow-y-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-3 font-mono text-xs leading-relaxed"
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

export function Spinner() {
  return (
    <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
  );
}
