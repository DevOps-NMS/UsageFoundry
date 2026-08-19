"use client";

import type { ReactNode } from "react";
import type { RunDTO } from "@/lib/apiTypes";
import { STATUS_TONE, type BadgeTone } from "@/lib/format";

/**
 * A shape per run status, at the leading edge of a row the way a native list
 * puts its state marker.
 *
 * The word is the accessible fallback and is always somewhere on the same row;
 * this is what makes nine rows separable at a glance without reading any of
 * them. Tone alone cannot do that job — `paused`, `stopped`, `blocked` and
 * `needs-review` are all amber, so in greyscale or to a colour-blind operator
 * the badge carries no signal until it is read word by word.
 *
 * One copy. The runs list and the run card each drew their own set, and the two
 * had drifted: one paused run wore two rounded bars and the other two square
 * ones, and a third caller was about to make it three.
 */
const GLYPH: Record<RunDTO["status"], ReactNode> = {
  // Filled: spending right now.
  running: <circle cx="5" cy="5" r="3.4" fill="currentColor" />,
  // Held behind something: an arrow stopped by a bar. Deliberately not another
  // circle — `queued` and `blocked` are both circles already, and a third would
  // make the one state that is waiting on *a run* the hardest to pick out.
  waiting: (
    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M1 5h3.6M3.4 3.2 5.2 5 3.4 6.8" />
      <path d="M7.4 1.6v6.8" strokeWidth="1.7" />
    </g>
  ),
  // Hollow: alive but doing nothing.
  queued: (
    <circle cx="5" cy="5" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
  ),
  // The universal pause bars: held, will resume itself.
  paused: (
    <>
      <rect x="2.4" y="1.9" width="1.8" height="6.2" rx="0.6" fill="currentColor" />
      <rect x="5.8" y="1.9" width="1.8" height="6.2" rx="0.6" fill="currentColor" />
    </>
  ),
  completed: (
    <path
      d="M2 5.3 4.2 7.5 8 2.9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // A bang: the one mark in this set that asks the reader for something rather
  // than reporting a state. Deliberately not a variant of the tick or the cross
  // — this ending sits between them and must not be mistaken for either at a
  // glance, which is the whole failure it exists to fix.
  "needs-review": (
    <>
      <path
        d="M5 1.7v4.1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="5" cy="8.2" r="0.95" fill="currentColor" />
    </>
  ),
  // A stop square: ended, but by a decision rather than a fault.
  stopped: <rect x="2.3" y="2.3" width="5.4" height="5.4" rx="1.2" fill="currentColor" />,
  blocked: (
    <>
      <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2.7 7.3 7.3 2.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </>
  ),
  failed: (
    <path
      d="M2.7 2.7 7.3 7.3M7.3 2.7 2.7 7.3"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  ),
};

/**
 * The glyph's own colour, as `currentColor` for the svg inside it.
 *
 * Only the text half of `Badge`'s tone map, and only because the mark leads the
 * row from outside the badge, where nothing else supplies a colour: nine shapes
 * all drawn in `--fg` would make a failed run and a completed one differ only in
 * outline, which is the distinction the leading edge should make first.
 */
const TONE: Record<BadgeTone, string> = {
  neutral: "text-ink-muted",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  accent: "text-accent",
};

export function StatusMark({ status }: { status: RunDTO["status"] }) {
  return (
    // aria-hidden: the status word is on the same row, so announcing the shape
    // would read the state twice.
    <span className={`inline-flex shrink-0 ${TONE[STATUS_TONE[status]]}`}>
      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0" aria-hidden="true">
        {GLYPH[status]}
      </svg>
    </span>
  );
}
