"use client";

import type { ReactNode } from "react";

/**
 * `emphasis` is the point of this component. Every card in the app previously
 * had identical padding and an identical uppercase 12px title, so a headline
 * window meter and a footnote table read as equally important and nothing on
 * a page told you where to look first.
 */
export type CardEmphasis = "primary" | "default" | "quiet";

const EMPHASIS: Record<CardEmphasis, string> = {
  primary: "p-5 shadow-e2",
  default: "p-4 shadow-e1",
  quiet: "p-4",
};

export function Card({
  children,
  emphasis = "default",
  className = "",
}: {
  children: ReactNode;
  emphasis?: CardEmphasis;
  className?: string;
}) {
  return (
    // A div, not a <section>. The legacy stylesheet still carries
    // `section + section { margin-top: 24px }`, which fired between sibling
    // cards inside a grid and pushed every card but the first down 24px.
    // A card is a surface anyway, not a document section.
    <div
      className={`rounded-lg border border-line bg-surface ${EMPHASIS[emphasis]} ${className}`}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={`mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted ${className}`}
    >
      {children}
    </h2>
  );
}

/** The headline figure on a card. Tabular so it does not jitter while polling. */
export function Stat({
  children,
  size = "default",
}: {
  children: ReactNode;
  size?: "default" | "large";
}) {
  return (
    <div
      className={`font-semibold tabular-nums tracking-tight ${
        size === "large" ? "text-2xl" : "text-xl"
      }`}
    >
      {children}
    </div>
  );
}

export function StatSub({ children }: { children: ReactNode }) {
  return <div className="mt-0.5 text-xs text-ink-muted">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="py-5 text-center text-sm text-ink-faint">{children}</div>
  );
}
