"use client";

import type { ReactNode } from "react";
import type { BadgeTone } from "@/lib/format";

/**
 * Complete class strings per tone, never interpolated. Tailwind scans source
 * as plain text, so `text-${tone}` would emit nothing at all — and would do it
 * silently, since there is no lint step in this repo to catch it.
 *
 * The tone is in the *text*, where the 4.5:1 contrast against --bg-inset is
 * met, and only hinted in the border. A full-strength ring around an 11px chip
 * put more colour on screen than the sentence it was annotating, so a row of
 * six runs read as six alarms; the `-line` tints are the same hue at 40% and
 * still tell green from red at a glance. See globals.css.
 */
const TONE: Record<BadgeTone, string> = {
  neutral: "text-ink-muted border-line-strong",
  ok: "text-ok border-ok-line",
  warn: "text-warn border-warn-line",
  danger: "text-danger border-danger-line",
  accent: "text-accent border-accent-line",
};

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border bg-inset px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}
