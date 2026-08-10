"use client";

import type { ReactNode } from "react";

/**
 * The one-line note under a form field.
 *
 * `.hint` was the only tone-carrying element that never got a `data-tone`
 * treatment, which is why thirteen call sites reached for
 * `style={{ color: "var(--warn)" }}` instead. The prop replaces all of them.
 */
export type HintTone = "neutral" | "warn" | "danger";

const TONE: Record<HintTone, string> = {
  neutral: "text-ink-faint",
  warn: "text-warn",
  danger: "text-danger",
};

export function Hint({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: HintTone;
  className?: string;
}) {
  return (
    <div className={`mt-1.5 text-xs leading-snug ${TONE[tone]} ${className}`}>
      {children}
    </div>
  );
}
