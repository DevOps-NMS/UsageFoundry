"use client";

import type { ReactElement } from "react";

/**
 * The app's glyphs, at one optical weight.
 *
 * There were none before this — only the brand mark in Nav, and three
 * hand-drawn theme shapes inside ThemeToggle. The two rules that make a set
 * read as a set are both enforced here rather than per call site: every glyph
 * is drawn in a 16×16 box, and the stroke attributes are set once on the <svg>
 * so nothing can arrive a half-weight heavier than its neighbour. A glyph that
 * is genuinely a filled shape (the status dot) says so locally.
 *
 * Characters were the alternative and are the thing this replaces: ◐ ☀ ☾ are at
 * the mercy of whichever font on the machine carries them, arriving at
 * different sizes, on different baselines, and on some systems in full colour.
 */
export type IconName =
  // Sidebar and nav, one per destination the app has.
  | "dashboard"
  | "chat"
  | "runs"
  | "workflows"
  | "branches"
  | "account"
  | "settings"
  // The shell's own two controls: collapse the source list, and quick open.
  | "sidebar"
  | "search"
  // Disclosure.
  | "chevron-right"
  | "chevron-down"
  // The two facts a chat proposal is decided on: where it runs, and under
  // whose rules. They were drawn inline on that page, at a different box size
  // and a different stroke weight — which is the drift this file exists to
  // stop, and the reason a glyph belongs here rather than beside its caller.
  | "folder"
  | "guard"
  // Status and affirmation.
  | "dot"
  | "check"
  | "close"
  // Appearance, read by SegmentedControl in ThemeToggle.
  | "display"
  | "sun"
  | "moon";

const GLYPH: Record<IconName, ReactElement> = {
  dashboard: (
    <>
      <path d="M2.75 12a5.25 5.25 0 1 1 10.5 0" />
      <path d="M8 12 10.9 7.6" />
    </>
  ),
  chat: (
    <>
      <path d="M2.75 6.5A2.75 2.75 0 0 1 5.5 3.75h5A2.75 2.75 0 0 1 13.25 6.5v2.25A2.75 2.75 0 0 1 10.5 11.5H6.9l-2.65 1.9V11.4a2.75 2.75 0 0 1-1.5-2.45Z" />
    </>
  ),
  runs: (
    <>
      <circle cx="8" cy="8" r="5.25" />
      <path d="M6.75 5.9 10.4 8l-3.65 2.1Z" />
    </>
  ),
  workflows: (
    <>
      <rect x="2.25" y="2.75" width="4" height="3.5" rx="1" />
      <rect x="9.75" y="9.75" width="4" height="3.5" rx="1" />
      <path d="M4.25 6.25v4.25a1 1 0 0 0 1 1h4.5" />
    </>
  ),
  branches: (
    <>
      <circle cx="4.75" cy="4" r="1.6" />
      <circle cx="4.75" cy="12" r="1.6" />
      <circle cx="11.25" cy="6.25" r="1.6" />
      <path d="M4.75 5.6v4.8M6.35 4h1.9a3 3 0 0 1 3 3v0" />
    </>
  ),
  account: (
    <>
      <circle cx="8" cy="6" r="2.5" />
      <path d="M3.4 13.1a4.75 4.75 0 0 1 9.2 0" />
    </>
  ),
  settings: (
    <>
      <path d="M2.5 5h11M2.5 11h11" />
      <circle cx="6" cy="5" r="1.6" />
      <circle cx="10" cy="11" r="1.6" />
    </>
  ),
  // The macOS sidebar glyph: the window, with the source list partitioned off.
  sidebar: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6.25 3v10" />
    </>
  ),
  search: (
    <>
      <circle cx="7.25" cy="7.25" r="4.25" />
      <path d="m10.5 10.5 2.75 2.75" />
    </>
  ),
  "chevron-right": <path d="M6.25 3.75 10.5 8l-4.25 4.25" />,
  "chevron-down": <path d="M3.75 6.25 8 10.5l4.25-4.25" />,
  folder: (
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3a1.5 1.5 0 0 1 1.06.44l.7.7h5A1.5 1.5 0 0 1 14 5.64v5.86A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
  ),
  guard: <path d="M8 2.2 13 4v3.9c0 3-2.1 4.9-5 5.9-2.9-1-5-2.9-5-5.9V4z" />,
  // Filled, because a status dot is a dot rather than a ring. Stroke is
  // cancelled locally so the shared stroke-width cannot fatten it.
  dot: <circle cx="8" cy="8" r="3.25" fill="currentColor" stroke="none" />,
  check: <path d="M3.25 8.4 6.4 11.5 12.75 4.9" />,
  close: <path d="M4.25 4.25 11.75 11.75M11.75 4.25 4.25 11.75" />,
  display: (
    <>
      <rect x="2.25" y="3.25" width="11.5" height="7.5" rx="1.5" />
      <path d="M6.25 13.25h3.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.35 3.35l1.06 1.06M11.59 11.59l1.06 1.06M12.65 3.35l-1.06 1.06M4.41 11.59l-1.06 1.06" />
    </>
  ),
  // Filled for the same reason the dot is: a crescent drawn as an outline at
  // 16px is two hairlines that touch, which reads as a smudge.
  moon: (
    <path
      d="M13.3 10.1A5.7 5.7 0 0 1 5.9 2.7a5.7 5.7 0 1 0 7.4 7.4Z"
      fill="currentColor"
      stroke="none"
    />
  ),
};

export type IconSize = "sm" | "default" | "lg";

/** Complete class strings per size — never interpolated, for Badge's reason. */
const SIZE: Record<IconSize, string> = {
  sm: "h-3.5 w-3.5",
  default: "h-4 w-4",
  lg: "h-5 w-5",
};

export function Icon({
  name,
  size = "default",
  className = "",
  title,
}: {
  name: IconName;
  size?: IconSize;
  className?: string;
  /**
   * Only where the glyph is the whole message. Every icon here is decorative by
   * default — the control around it carries the name — and an icon a screen
   * reader announces beside a label it duplicates is noise.
   */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`shrink-0 ${SIZE[size]} ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {GLYPH[name]}
    </svg>
  );
}
