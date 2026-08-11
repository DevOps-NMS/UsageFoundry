/** Presentation helpers. Client-safe — no node builtins in here. */

import type { RunDTO } from "./apiTypes";

/**
 * Badges and notices carry *different* vocabularies — a badge can be `accent`
 * and a notice cannot, a notice can be `info` and a badge cannot. As untyped
 * `data-tone` strings a wrong pairing rendered as the default with nothing to
 * say so; as separate unions it is a compile error.
 *
 * These live here rather than beside the components because `src/lib` is what
 * `tsconfig.test.json` compiles, and a `.tsx` import would drag JSX into the
 * test build.
 */
export type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "accent";
export type NoticeTone = "neutral" | "info" | "warn" | "danger";

/** Badge tone per run status. Shared so the list and detail pages cannot drift. */
export const STATUS_TONE: Record<RunDTO["status"], BadgeTone> = {
  queued: "neutral",
  running: "accent",
  // Alive *and* needing attention: it will spend money again, unattended, and
  // it is holding a folder meanwhile. "accent" would imply progress and "" would
  // let it disappear into the history table.
  paused: "warn",
  completed: "ok",
  stopped: "warn",
  blocked: "warn",
  failed: "danger",
};

/** "3/5", or "3 · no cap" when the run has no work-cycle limit (stored as 0). */
export function fmtCycles(used: number, cap: number): string {
  return cap > 0 ? `${used}/${cap}` : `${used} · no cap`;
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtUSD(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(f: number | null): string {
  if (f === null || !Number.isFinite(f)) return "—";
  return `${(f * 100).toFixed(1)}%`;
}

/**
 * A stored 0–1 window fraction as the 0–100 the run form's percentage fields
 * hold, and blank for "no guard".
 *
 * The exact inverse of the `Number(field) / 100` those fields submit, and it has
 * to stay that way: a guard that loaded as a hundredth of what was saved parks a
 * `live-resume` run on its first check and looks like a run patiently waiting
 * for a window. Blank rather than "0", because the fields read blank as off and
 * a literal 0 as a guard set to zero percent — which trips immediately.
 */
export function pctField(f: number | null | undefined): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return "";
  // Rounded to one decimal: 0.855 is 85.5, not 85.50000000000001.
  return String(Math.round(f * 1000) / 10);
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 2h 14m" / "3m ago" — relative to now, with direction. */
export function fmtRelative(ts: number, now = Date.now()): string {
  const delta = ts - now;
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return delta >= 0 ? "now" : "just now";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const body = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return delta >= 0 ? `in ${body}` : `${body} ago`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Shorten an absolute path for display, keeping the tail meaningful. */
export function shortPath(p: string, keep = 3): string {
  if (!p) return "—";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= keep) return p;
  return `…/${parts.slice(-keep).join("/")}`;
}

export type Severity = "ok" | "warn" | "danger";

export function severityFor(fraction: number | null): Severity {
  if (fraction === null) return "ok";
  if (fraction >= 0.9) return "danger";
  if (fraction >= 0.7) return "warn";
  return "ok";
}
