"use client";

import type { ReactNode } from "react";
import type { LogEntry, LogTone } from "@/lib/logLine";

/**
 * The row an app-written line sits on: a tone-coloured edge, and how loud its
 * body is allowed to be.
 *
 * The tints are the `-line` variables, for the reason Badge documents — a long
 * log is nothing *but* annotations, and full-strength colour on every one of
 * them turns a working run into a screen of alarms. Both properties live in one
 * entry per tone because either alone is a row that says the wrong thing.
 */
const SYSTEM_ROW: Record<LogTone, string> = {
  neutral: "border-l-line-strong text-ink-muted",
  ok: "border-l-ok-line text-ink-muted",
  accent: "border-l-accent-line text-ink-muted",
  // A warning or a failure is the line the reader came for, so it gets full
  // contrast where the routine ones stay muted.
  warn: "border-l-warn-line text-ink",
  danger: "border-l-danger-line text-ink",
};

/** The tag. The tone is carried here rather than on the sentence beside it. */
const SYSTEM_LABEL: Record<LogTone, string> = {
  neutral: "text-ink-faint",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  accent: "text-accent",
};

export function Log({
  children,
  ref,
  onScroll,
  label = "Run output",
}: {
  children: ReactNode;
  ref?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  label?: string;
}) {
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      // A scrollable region that is not focusable cannot be read by anyone
      // navigating with a keyboard — the content past the fold is simply
      // unreachable. tabIndex is what fixes that; the outline comes from
      // @layer base, so the tab stop is visible when it is taken.
      tabIndex={0}
      role="log"
      // role="log" is politely live by default, and this one emits a line every
      // second or so for the length of a work cycle. Off keeps the region
      // named and navigable without narrating an agent's entire transcript.
      aria-live="off"
      aria-label={label}
      // Typeface and wrapping are per line rather than set here: the agent's
      // own words are prose and are set as prose, and only the app's lines and
      // the tool arguments are monospace.
      className="max-h-[560px] overflow-y-auto rounded-sm border border-line bg-inset px-3 py-2.5 text-xs"
    >
      {children}
    </div>
  );
}

/**
 * The time gutter. `shrink-0` rather than a fixed width: every clock in a given
 * locale renders the same string length, and `tabular-nums` makes that the same
 * *pixel* width — so the bodies line up without this file guessing at how wide
 * "09:41 AM" is.
 */
function Time({ at }: { at: string }) {
  return (
    <span className="shrink-0 pt-px text-2xs tabular-nums text-ink-faint">
      {at}
    </span>
  );
}

export function LogLine({
  entry,
  timestamp,
}: {
  entry: LogEntry;
  timestamp: string;
}) {
  // A real rule across the feed, rather than a line of em dashes pretending to
  // be one. This is the only place the log is allowed to take vertical space:
  // it is what turns a scroll of a thousand lines into a countable few groups.
  if (entry.voice === "cycle") {
    return (
      <div className="flex items-center gap-2.5 pb-1.5 pt-5 first:pt-0">
        <Time at={timestamp} />
        <span className="shrink-0 text-2xs font-semibold uppercase tracking-wide text-ink">
          {entry.label}
        </span>
        {entry.text && (
          <span className="shrink-0 text-2xs text-ink-muted">{entry.text}</span>
        )}
        <span aria-hidden className="h-px min-w-4 flex-1 bg-line" />
      </div>
    );
  }

  // The agent's own words, and the only thing here wearing no chrome at all —
  // set as prose, at reading size, because that is what they are.
  if (entry.voice === "agent") {
    return (
      <div className="flex gap-2.5 py-1.5">
        <Time at={timestamp} />
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
          {entry.text}
        </p>
      </div>
    );
  }

  if (entry.voice === "tool") {
    return (
      <div className="flex gap-2.5 py-0.5">
        <Time at={timestamp} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 rounded-sm border border-line bg-surface px-1.5 font-mono text-2xs font-semibold text-accent">
            {entry.label}
          </span>
          {entry.text && (
            // `break-words` rather than `break-all`: a path with no spaces in it
            // has to break somewhere, but a command does not, and break-all
            // would split it mid-word with a space available on the same line.
            <span className="min-w-0 flex-1 break-words font-mono text-xs text-ink-muted">
              {entry.text}
            </span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5 py-0.5">
      <Time at={timestamp} />
      <span
        className={`flex min-w-0 flex-1 items-baseline gap-2 border-l-2 pl-2.5 ${SYSTEM_ROW[entry.tone]}`}
      >
        {entry.label && (
          <span
            className={`shrink-0 text-2xs font-semibold uppercase tracking-wide ${SYSTEM_LABEL[entry.tone]}`}
          >
            {entry.label}
          </span>
        )}
        <span className="min-w-0 flex-1 break-words font-mono text-xs">
          {entry.text}
        </span>
      </span>
    </div>
  );
}

/**
 * Indeterminate progress. Decorative on purpose — every call site puts a word
 * beside it ("working", "streaming"), and that word is what carries the state.
 *
 * Frozen by prefers-reduced-motion, which is correct: the broken ring still
 * reads as "not finished", where a full ring would read as a bullet.
 */
export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
    />
  );
}
