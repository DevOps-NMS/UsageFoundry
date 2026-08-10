"use client";

import type { ReactNode } from "react";
import type { NoticeTone } from "@/lib/format";

const TONE: Record<NoticeTone, string> = {
  neutral: "border-l-ink-faint",
  info: "border-l-accent",
  warn: "border-l-warn",
  danger: "border-l-danger",
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
  className = "",
}: {
  children: ReactNode;
  tone?: NoticeTone;
  quiet?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`mb-4 rounded-sm border border-line border-l-[3px] bg-inset leading-normal text-ink-muted ${
        quiet ? "px-3.5 py-2 text-xs" : "px-3.5 py-3 text-sm"
      } ${TONE[tone]} [&_strong]:font-semibold [&_strong]:text-ink ${className}`}
    >
      {children}
    </div>
  );
}
