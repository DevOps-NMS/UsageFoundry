"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "default" | "compact";

/**
 * Complete class strings per variant, never interpolated — Tailwind scans
 * source as plain text, so `bg-${variant}` emits nothing and does it silently.
 *
 * Every variant states all five states, and none of them changes a box
 * dimension: rest and hover differ in colour, press differs by an *inset*
 * shadow so the button recesses without moving, focus is an outline (which is
 * outside the box model), and disabled is opacity. A press that nudged the
 * button by a pixel would reflow every sibling in a ButtonRow.
 *
 * `enabled:` rather than a `disabled:hover:` undo. Both were being emitted for
 * a hovered disabled button and which one won came down to Tailwind's variant
 * sort order, which is not a contract. The focus outline colour is in here for
 * the same reason: stated once in a shared string and again per variant, the
 * two would set the same property under the same variant and the winner would
 * be Tailwind's internal order rather than anything written here.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-accent text-white shadow-e1 focus-visible:outline-accent " +
    "enabled:hover:brightness-110 enabled:active:brightness-95 enabled:active:shadow-press",
  secondary:
    "border-line-strong bg-inset text-ink focus-visible:outline-accent " +
    "enabled:hover:border-ink-faint enabled:hover:bg-surface enabled:active:shadow-press",
  // Reads as destructive before it is clicked, and keeps saying so through
  // focus: an accent focus ring on a red button would be the app's "go ahead"
  // colour drawn around the one control that cannot be undone.
  danger:
    "border-transparent bg-danger text-white shadow-e1 focus-visible:outline-danger " +
    "enabled:hover:brightness-110 enabled:active:brightness-95 enabled:active:shadow-press",
  ghost:
    "border-transparent bg-transparent text-ink-muted focus-visible:outline-accent " +
    "enabled:hover:bg-inset enabled:hover:text-ink enabled:active:shadow-press",
};

/**
 * The busy indicator, per variant. A ring in the button's own foreground
 * colour: `border-t-accent` is invisible on an accent-filled button, which is
 * how a "nothing is happening" state gets shipped.
 */
const BUSY_RING: Record<ButtonVariant, string> = {
  primary: "border-white/40 border-t-white",
  secondary: "border-line-strong border-t-accent",
  danger: "border-white/40 border-t-white",
  ghost: "border-line-strong border-t-accent",
};

/** Height, not padding — see --control-h in globals.css. */
const SIZE: Record<ButtonSize, string> = {
  default: "min-h-[var(--control-h-lg)] px-3.5 py-1.5",
  compact: "min-h-[var(--control-h)] px-2.5 py-1",
};

export function Button({
  children,
  variant = "primary",
  size = "default",
  busy = false,
  disabled = false,
  className = "",
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * The action is in flight. The label stays in the DOM and keeps reserving its
   * own width — the spinner is laid over it — so a button does not resize
   * mid-click and shove the rest of the row sideways. Swapping the text for
   * "Saving…" is the version of this that does.
   */
  busy?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      // Pressing a button that is already working is never what was meant, and
      // every call site was already spelling this out in its own `disabled`.
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={
        "ui-transition relative inline-flex cursor-pointer items-center " +
        "justify-center gap-2 rounded-sm border text-sm font-medium " +
        "focus-visible:outline-2 focus-visible:outline-offset-2 " +
        "disabled:cursor-not-allowed " +
        // Busy is disabled, but it must not *look* disabled — a dimmed button
        // with a spinner on it reads as "unavailable", not as "working".
        (busy ? " " : "disabled:opacity-50 ") +
        `${SIZE[size]} ${VARIANT[variant]} ${className}`
      }
    >
      <span className={`inline-flex items-center gap-2 ${busy ? "invisible" : ""}`}>
        {children}
      </span>
      {busy && (
        <span
          className={`absolute h-3.5 w-3.5 animate-spin rounded-full border-2 ${BUSY_RING[variant]}`}
          aria-hidden
        />
      )}
    </button>
  );
}

export function ButtonRow({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {children}
    </div>
  );
}
