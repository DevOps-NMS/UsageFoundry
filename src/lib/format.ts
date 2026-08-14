/** Presentation helpers. Client-safe — no node builtins in here. */

import type { RunDependencyDTO, RunDTO } from "./apiTypes";

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
  // Neutral like `queued`: it is waiting rather than in trouble. What it is
  // waiting for is a run, not a folder, and only the detail line says which.
  waiting: "neutral",
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

/**
 * The work cycle a run has open right now, or null when it has none.
 *
 * `fmtCycles` counts cycles that *finished*, because that is what the guard
 * counts. So a run reads `0/2` for the whole of its first cycle — tens of
 * minutes — which is exactly what a run that was marked running and never
 * started reads, and telling those two apart is the question an operator opens
 * this page to answer. This is the other half of the sentence, and it is worded
 * as "in flight" precisely so it can never be added to the count beside it.
 *
 * Gated on `running` as well as on the column: nothing clears the row when the
 * container dies mid-cycle, and a finished run claiming an open cycle is the
 * same lie in the other direction.
 */
export function fmtCycleInFlight(
  run: Pick<RunDTO, "status" | "max_iterations" | "active_iteration">,
): string | null {
  if (run.status !== "running") return null;
  const n = run.active_iteration;
  if (n === null || n === undefined || n < 1) return null;
  // 0 is the stored sentinel for "no cap" — see db.ts.
  return run.max_iterations > 0
    ? `cycle ${n} of ${run.max_iterations} in flight`
    : `cycle ${n} in flight`;
}

/**
 * What a run told to start after other runs is still waiting for, or null.
 *
 * Reads only `satisfied`, which the server computed — "settled" is one
 * definition in `orchestrator.ts` and must not become a second one here. Names
 * the run while there is one to name, because "waiting" on its own is what a
 * queued and a parked run also say, and the whole point of this state is which
 * of the three it is.
 */
export function fmtWaitingFor(
  deps: readonly RunDependencyDTO[] | undefined,
): string | null {
  const pending = (deps ?? []).filter((d) => !d.satisfied);
  if (pending.length === 0) return null;
  if (pending.length === 1) return `waiting for run ${pending[0].runId.slice(0, 8)}`;
  return `waiting for ${pending.length} runs`;
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

/**
 * What a percentage field puts on the wire: the 0–1 fraction behind it, or
 * `null` for "no guard". The exact inverse of `pctField`.
 *
 * A named function rather than the `Number(field) / 100` written at each call
 * site, because forgetting it is silent and unbounded: `normalizePolicy`'s and
 * `normalizeInstanceBudget`'s `frac()` both read a bare number ≤ 1 as an
 * already-normalised fraction, so a `1` typed into a field labelled % is stored
 * as the whole window — the smallest value the fields offer, loosened by 100×,
 * and a guard that never trips reads exactly like one that was never reached.
 */
export function pctSubmit(field: string): number | null {
  return field ? Number(field) / 100 : null;
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

/**
 * A calendar bucket's span, as a person reads it.
 *
 * The boundaries were cut in the browser's own zone (`/api/usage?tz=`), so
 * rendering them with the browser's own locale is the one thing that keeps the
 * label and the arithmetic describing the same day. A week is shown as its span
 * rather than as "week of", because an anchored week does not start on a
 * Monday and a label that implies it would be wrong for the operators who
 * configured one.
 */
export function fmtPeriodLabel(
  granularity: "day" | "week" | "month",
  startsAt: number,
  endsAt: number,
): string {
  const start = new Date(startsAt);
  if (granularity === "month") {
    return start.toLocaleDateString([], { month: "long", year: "numeric" });
  }
  if (granularity === "day") {
    return start.toLocaleDateString([], {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }
  // The last *instant* of the week belongs to the next one, so name the day
  // before it — otherwise a midnight-aligned week reads as eight days long.
  const last = new Date(endsAt - 1);
  // `formatRange`, not two `toLocaleDateString` calls joined by a dash: where
  // the month goes in a range is a locale decision, and concatenating produced
  // "12 – Aug 19" — the month attached to the wrong end of the span.
  return new Intl.DateTimeFormat([], {
    day: "numeric",
    month: "short",
    // Only when the span straddles one, so an ordinary week is not stamped
    // with a year twelve rows in a column already sorted by date.
    ...(start.getFullYear() === last.getFullYear()
      ? {}
      : { year: "numeric" }),
  }).formatRange(start, last);
}

/** Shorten an absolute path for display, keeping the tail meaningful. */
export function shortPath(p: string, keep = 3): string {
  if (!p) return "—";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= keep) return p;
  return `…/${parts.slice(-keep).join("/")}`;
}

/**
 * What a polling page says when a poll fails.
 *
 * `status` is null when the request never got an answer at all — a rejected
 * `fetch`: the server restarting, the container rebuilt, a dropped connection.
 * 401 is called out by name because it is the one failure the operator can
 * clear themselves, and `middleware.ts` answers `/api/*` with it rather than a
 * redirect, so nothing else on screen would say the session had lapsed.
 *
 * The return is never empty, and that is the point rather than a nicety: the
 * caller renders it as `{message && <Notice…>}`, so a blank string is a
 * swallowed failure — the exact defect this exists to fix. A server that
 * answers `{"error":""}` must still put a sentence on the page.
 */
export function pollFailureMessage(
  status: number | null,
  detail?: string | null,
): string {
  const cause = detail?.trim();
  const stale = "This page has stopped refreshing, so what is shown may be out of date.";
  if (status === 401) {
    return `Signed out${cause ? ` (${cause})` : ""} — sign in again. ${stale}`;
  }
  const head =
    status === null ? "The server could not be reached" : `The server answered ${status}`;
  return `${head}${cause ? ` — ${cause}` : ""}. ${stale}`;
}

export type Severity = "ok" | "warn" | "danger";

export function severityFor(fraction: number | null): Severity {
  if (fraction === null) return "ok";
  if (fraction >= 0.9) return "danger";
  if (fraction >= 0.7) return "warn";
  return "ok";
}
