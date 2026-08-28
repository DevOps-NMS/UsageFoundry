"use client";

import type { ReactNode } from "react";
import type { HintTone } from "./Hint";

/**
 * Complete class strings per tone, looked up rather than interpolated.
 *
 * `neutral` is empty where `Hint`'s own map sets `text-ink-faint`, and the
 * difference is the whole reason this is a second map rather than a reuse of
 * that one: this span sits *inside* a row's description and a neutral clause
 * has to keep the colour of the sentence around it. A block-level hint owns its
 * line and so owns its colour.
 */
const NOTE_TONE: Record<HintTone, string> = {
  neutral: "",
  warn: "text-warn",
  danger: "text-danger",
};

/** A sentence inside a row's description that has to carry a tone of its own. */
export function Toned({
  tone = "neutral",
  children,
}: {
  tone?: HintTone;
  children: ReactNode;
}) {
  return <span className={NOTE_TONE[tone]}>{children}</span>;
}
