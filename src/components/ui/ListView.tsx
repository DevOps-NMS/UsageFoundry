"use client";

import type { ReactNode } from "react";

/**
 * A Finder-style list view: a bordered, rounded box that owns its own scroll
 * region, with the column heads stuck to the top of it — rather than a
 * full-width web table running to the card's edges and scrolling the page.
 *
 * The height cap is what gives the sticky head something to stick inside,
 * which is also why `TableWrap` cannot be used here: a scroll container with
 * no height constraint never scrolls vertically, so a head stuck to its top
 * never moves. `overflow-auto` because these tables still overflow sideways on
 * a narrow window, which is the job `TableWrap` was doing.
 *
 * Five files drew one of these and every one of them had written the string
 * out by hand, which is how the fifth drifts: two of the five differ from the
 * other three, both differences are deliberate as far as anyone can tell, and
 * nothing in the code said so where a reader copying the string would look.
 * Naming the three boxes is what makes a difference between them a decision
 * somebody can read rather than a character somebody dropped.
 *
 * **Two of the five callers must reach this relatively** (`./ui/ListView`),
 * and that is what the repetition was bought with: `UsagePeriods` and
 * `LiveTelemetry` are unit-tested against the plain CommonJS
 * `tsconfig.test.json` emits, where a path alias does not resolve at all —
 * `require("@/components/ui/ListView")` throws at run time and the typecheck
 * says nothing, because tsc resolved the alias and then emitted it verbatim.
 */
export type ListViewBox = "capped" | "scrolling" | "plain";

/**
 * Complete class strings per box, never interpolated — Tailwind scans source
 * as plain text, so `max-h-${cap}` emits nothing and does it silently.
 *
 * Each is exactly what its call sites carried before this component existed.
 * Three, because the five call sites are three boxes and not one with two
 * mistakes in it.
 */
const BOX: Record<ListViewBox, string> = {
  // Both halves released below the breakpoint, and it is the same reason
  // twice: the column heads are hidden there and the rows are blocks, so the
  // cap has no sticky head left to give a box to and what is left is a 320px
  // nested scroller inside a scrolling pane with nothing pinned to the top of
  // it — a trap on touch, where the only way past a list is through it.
  capped:
    "max-h-80 overflow-auto max-md:max-h-none max-md:overflow-visible " +
    "rounded-sm border border-line",
  // `capped` without the height cap, for a list something else has already
  // bounded. Whether the missing cap is a decision or an omission is an open
  // question for a person, so this exists to preserve it rather than to bless
  // it: answering it by adding `max-h-80` here would answer it for a list
  // whose length nobody has measured.
  scrolling: "overflow-auto max-md:overflow-visible rounded-sm border border-line",
  // No scrolling at all, and that is the point rather than an omission: a
  // sticky head inside a scroll container pins to a box that never moves, so
  // the runs list is deliberately not one and its head pins to the content
  // pane as the page scrolls, which is what a Finder list does.
  plain: "rounded-lg border border-line bg-surface",
};

export function ListView({
  children,
  box = "capped",
  className = "",
}: {
  children: ReactNode;
  box?: ListViewBox;
  /**
   * The caller's own margin, and nothing else. A `max-h-*` passed here is a
   * bug: two height utilities on one element resolve by stylesheet order
   * rather than class order, so a cap stated at a call site is a cap that
   * sometimes wins.
   */
  className?: string;
}) {
  return <div className={`${BOX[box]} ${className}`}>{children}</div>;
}

/**
 * The pinned column head.
 *
 * `bg-surface` because the rows scroll under it, and the inset shadow because
 * a `border-b` on a sticky cell is not reliably painted under
 * `border-collapse` — the two are the same hairline in the same place wherever
 * both do render.
 */
export const STICKY_HEAD =
  "sticky top-0 z-10 bg-surface shadow-[inset_0_-1px_0_var(--border)]";

/**
 * The same head without the hairline under it. One caller — the repository
 * spend card — and whether that is a decision or an omission is the other
 * open question this component preserves rather than answers.
 */
export const STICKY_HEAD_FLAT = "sticky top-0 z-10 bg-surface";
