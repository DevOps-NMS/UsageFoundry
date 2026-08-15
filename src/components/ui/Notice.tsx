"use client";

import type { ReactNode } from "react";
import type { NoticeTone } from "@/lib/format";

/**
 * The tone bar, at two strengths.
 *
 * A conditional warning gets the full colour — it appeared because something is
 * wrong and it should be the loudest thing in its column. A `quiet` notice is
 * permanently on screen, so it gets the 40% tint instead: a standing banner
 * drawn at alarm strength is a banner the eye learns to skip, and it takes the
 * real warnings with it.
 */
const TONE: Record<NoticeTone, string> = {
  neutral: "border-l-ink-faint",
  info: "border-l-accent",
  warn: "border-l-warn",
  danger: "border-l-danger",
};

const TONE_QUIET: Record<NoticeTone, string> = {
  neutral: "border-l-line-strong",
  info: "border-l-accent-line",
  warn: "border-l-warn-line",
  danger: "border-l-danger-line",
};

/**
 * A block of standing context, not a transient alert — several of these are
 * permanently on screen because the thing they describe is structural (the
 * dashboard's "this covers Claude Code only", for one). `quiet` exists for
 * exactly those: an always-present banner rendered at the same weight as a
 * conditional warning trains the eye to skip both.
 */
export function Notice({
  children,
  tone = "neutral",
  quiet = false,
  live = false,
  className = "",
}: {
  children: ReactNode;
  tone?: NoticeTone;
  quiet?: boolean;
  /**
   * This notice appears in response to something the user just did, so it is
   * announced when it arrives. Off by default: most notices here are standing
   * context, and a live region that re-announces on every poll is worse than
   * one that never speaks.
   */
  live?: boolean;
  className?: string;
}) {
  return (
    <div
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      className={`mb-4 rounded-sm border border-line border-l-[3px] bg-inset leading-normal text-ink-muted ${
        quiet ? "px-3.5 py-2 text-xs" : "px-3.5 py-3 text-sm"
      } ${quiet ? TONE_QUIET[tone] : TONE[tone]} [&_strong]:font-semibold [&_strong]:text-ink ${className}`}
    >
      {/* The bar spans its container and the words inside it do not. The tone
          edge is the thing that has to reach the card's width to read as a
          banner; the sentence is prose, and this pane fills the window, so
          uncapped it ran 370 characters a line on a 2560px display. 80ch is
          what the card footnotes one section over already use. */}
      <div className="max-w-[80ch]">{children}</div>
    </div>
  );
}
