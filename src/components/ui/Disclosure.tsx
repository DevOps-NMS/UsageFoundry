"use client";

import type { ReactNode } from "react";

/**
 * A fold, as the browser draws one.
 *
 * There were seven hand-rolled `<details>` in this app and they did not agree
 * on the one part of it that is invisible from any file that has it: the hit
 * target. A `<summary>` cannot buy the 44px below the breakpoint the way every
 * other control here does, because its `list-item` display is what draws the
 * disclosure triangle and a min-height on a list-item leaves the word and its
 * triangle at the top of a box the finger is aiming at the middle of. Padding
 * is the answer instead, three of the seven carried it, and a recipe kept at
 * call sites is one the eighth call site will not carry either.
 *
 * Everything else is the browser's, and that is the reason this is a native
 * `<details>` rather than a hand-rolled show/hide: keyboard operation, the
 * triangle, find-in-page expansion in the engines that have it, and correct
 * semantics with no ARIA at all. So this states **none** — a `role`, an
 * `aria-expanded` or an `aria-controls` on a native disclosure is redundant or
 * actively wrong in at least one engine, and which one is not visible from
 * here. It also states no height animation: `ui-transition` omits `height` for
 * the reason written beside it, and an animated fold is content moving under a
 * pointer that is already travelling towards it.
 */

/**
 * The whole recipe, and deliberately only the target and the states.
 *
 * The desktop box stays the caller's. The landed call sites disagree on it —
 * `py-2` on the runs list, nothing on the branches and chat folds — because it
 * is each page's own vertical rhythm, so a figure stated here would move all
 * of them to fix none of them; `ui/Patch`'s file row states `--control-h` for
 * the pointer where it sits. `hover:text-ink` is a colour rather than a fill
 * precisely so a caller can add a background hover without the two
 * declarations setting one property and the winner being Tailwind's sort
 * order. There is no press state and no disabled state: the press *is* the
 * fold opening, which says more than a tint, and a `<summary>` cannot be
 * disabled.
 */
const SUMMARY =
  "ui-transition cursor-pointer max-md:py-3.5 marker:text-ink-faint hover:text-ink";

export function Disclosure({
  summary,
  count,
  defaultOpen = false,
  open,
  onToggle,
  children,
  className = "",
  summaryClassName = "",
}: {
  /** The always-visible line. A phrase, never a sentence with a full stop. */
  summary: ReactNode;
  /**
   * How much is behind the fold. A fold that does not say is a fold nobody
   * opens — and `(0)` says there is nothing behind it, so a caller with an
   * empty list owes an `Empty` rather than a fold and this does not second
   * guess one that renders it anyway.
   */
  count?: number;
  /** Read at mount and never again — see the note on `open`. */
  defaultOpen?: boolean;
  /**
   * Controlled, and there is exactly one reason to be: opening has to fetch.
   *
   * `open` and `onToggle` are one pair and a lone half of it throws in
   * development. Uncontrolled is the default because a controlled fold invites
   * a page to *close* one in answer to a poll, which is this app's own
   * "nothing switches tabs on its own" rule a component over. Even here the
   * browser still drives the toggle: this reports the new state and never
   * forces it.
   */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
  /** The caller's own box and rhythm, on the `<details>`. */
  className?: string;
  /**
   * The summary's own box. It exists for a `<summary>` that has to be
   * `sticky`: the header of an open patch scrolls away first and the fact it
   * takes with it is which file you are in, and sticky on the `<details>`
   * would pin a box taller than the pane. Not a variant hatch — a second
   * *size* or *tone* is a union in this file, with a call site in the same
   * commit.
   */
  summaryClassName?: string;
}) {
  if (
    process.env.NODE_ENV !== "production" &&
    (open === undefined) !== (onToggle === undefined)
  ) {
    throw new Error(
      "Disclosure: `open` and `onToggle` are one pair — expected both or " +
        `neither, got \`${open === undefined ? "onToggle" : "open"}\` alone. ` +
        "A lone `open` goes stale the first time the browser toggles it; a " +
        "lone `onToggle` is the fetch-on-open this component refuses.",
    );
  }

  return (
    // `open` and nothing else: React writes a boolean attribute at mount and
    // only writes it again when the prop itself changes, so an uncontrolled
    // fold is left exactly where the reader put it however often the page
    // polls behind it.
    <details
      className={className}
      open={open ?? defaultOpen}
      onToggle={
        onToggle ? (event) => onToggle(event.currentTarget.open) : undefined
      }
    >
      <summary className={`${SUMMARY} ${summaryClassName}`}>
        {summary}
        {count !== undefined && (
          <span className="text-ink-faint"> ({count})</span>
        )}
      </summary>
      {children}
    </details>
  );
}
