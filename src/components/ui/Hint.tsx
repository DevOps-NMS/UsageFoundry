"use client";

import type { HTMLAttributes, ReactNode } from "react";

/**
 * The one-line note under a form field.
 *
 * `.hint` was the only tone-carrying element that never got a `data-tone`
 * treatment, which is why thirteen call sites reached for
 * `style={{ color: "var(--warn)" }}` instead. The prop replaces all of them.
 *
 * It stays one size below body text and never bold: a hint that reads as
 * loudly as the thing it is annotating is a hint the eye stops on twice.
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
  ...rest
}: {
  children: ReactNode;
  tone?: HintTone;
  // id and role are passed through because `Field` names its hint and its
  // error so it can point the control's aria-describedby at them, and marks
  // the error as an alert so it is announced when it appears.
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`mt-1.5 text-xs leading-snug ${TONE[tone]} ${className}`}
    >
      {children}
    </div>
  );
}
