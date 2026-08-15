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
 *
 * And it carries a measure, the same 68ch `ListRow`'s description already had.
 * The pane fills the window by design, so an uncapped hint is as wide as the
 * monitor — 370 characters a line on a 2560px display, which is the same note
 * the row one card over sets at 68. A max-width can only ever narrow, so this
 * changes nothing wherever the field is already in a column.
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
      className={`mt-1.5 max-w-[68ch] text-xs leading-snug ${TONE[tone]} ${className}`}
    >
      {children}
    </div>
  );
}
