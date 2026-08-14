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
    // flex-wrap, because a title is also where the card's action button lives
    // ("Refresh", "Review again", "Cancel the 3 still waiting"). A button is a
    // flex item that cannot shrink below its own text, so without wrapping it
    // does not compress — it escapes the card and takes the page's horizontal
    // scrollbar with it. Measured: 92px past the card edge at 380px wide.
    // Sentence case at body size, in the primary label colour. It was 11px
    // uppercase with letter-spacing, which is a web dashboard's idea of a
    // section header; macOS says a group's title in the same voice as the group
    // and lets weight carry the difference. Every call site already passes
    // sentence-case text — the shouting was entirely in the stylesheet.
    <h2
      className={`mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold text-ink ${className}`}
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

/**
 * The other thing a card can hold: not "nothing to show" but "not here yet".
 *
 * Shaped like what is coming, and sized by the caller, so the page does not
 * jump when the poll answers — which is the whole difference between this and
 * a spinner. Every page here polls, so every page has this moment.
 *
 * `aria-hidden`, and the region around it says what it is waiting for: a
 * screen reader announcing four grey rectangles is noise.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-sm ${className}`} aria-hidden />;
}

/** Placeholder lines at body height, for a paragraph or a list that is coming. */
export function SkeletonText({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          // The last line short, because a paragraph's last line is short. A
          // block of equal bars reads as a table, and then the table arrives
          // and it is a paragraph.
          className={`h-3 ${i === lines - 1 ? "w-2/3" : "w-full"}`}
        />
      ))}
    </div>
  );
}
