"use client";

import type { ReactNode } from "react";
import type { BadgeTone } from "@/lib/format";

/**
 * Complete class strings per tone, never interpolated. Tailwind scans source
 * as plain text, so `text-${tone}` would emit nothing at all — and would do it
 * silently, since there is no lint step in this repo to catch it.
 */
const TONE: Record<BadgeTone, string> = {
  neutral: "text-ink-muted border-line-strong",
  ok: "text-ok border-ok",
  warn: "text-warn border-warn",
  danger: "text-danger border-danger",
  accent: "text-accent border-accent",
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
