/** Presentation helpers. Client-safe — no node builtins in here. */

import type { AgentOriginDTO, RunDependencyDTO, RunDTO } from "./apiTypes";

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

/**
 * Bytes on disk, in the units `du -h` uses.
 *
 * Powers of 1024 and the `KB`/`MB`/`GB` spelling, because the number an
 * operator checks this against is `du -sh` or `df -h` and a decimal megabyte
 * would disagree with both by 5% at exactly the moment somebody is deciding
 * whether a store is the reason their disk is full.
 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
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

/**
 * Which gate started a run, as a person reads it.
 *
 * Prose rather than the stored slug, because the distinction that matters to
 * somebody looking at an unexpected run is *whether a person was present*, and
 * "orchestrator-block" does not say that where "an orchestrator block decided
 * it" does. An unrecognised value is reported as itself rather than hidden: a
 * row written by a newer build saying something this one does not know is still
 * a true thing about that run.
 */
export function fmtRunOrigin(origin: string | null | undefined): string {
  switch (origin) {
    case "form":
      return "started from the run form";
    case "chat":
      return "started from an approved chat proposal";
    case "workflow":
      return "started by a press of Run on a workflow";
    case "orchestrator-block":
      return "started by an orchestrator block's own decision";
    case "schedule":
      return "started by a schedule, with nobody present";
    case null:
    case undefined:
    case "":
      // Every run created before the column existed. Saying "unknown" is the
      // honest answer; guessing "the run form" would make the audit column a
      // liability the first time somebody trusted it.
      return "started before this app recorded where runs came from";
    default:
      return `started by ${origin}`;
  }
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

/**
 * Which guard set a block runs under, as the badge beside it says it.
 *
 * Three states rather than two, and the third is the whole point: `templates`
 * is null until the list has been read, and "not in a list we have not got" is
 * a different fact from "not in the list". Collapsed into one, an unread list —
 * the value on every cold load, and the permanent value when the request fails
 * — calls every templated block's guards deleted, which is the one thing on
 * that page that says the workflow will not run, and it is untrue: Run works.
 *
 * The deleted case stays loud, because `planNode` refuses a node whose template
 * has gone by name rather than falling back to the untemplated guards, and this
 * is where an operator sees that before pressing Run.
 *
 * The list is taken structurally rather than as `RunTemplateDTO[]` because only
 * the two fields are read, and because the caller may hold either.
 */
export function guardBadge(
  templateId: string | null,
  templates: ReadonlyArray<{ id: string; name: string }> | null,
): { text: string; tone: BadgeTone } {
  if (templateId === null) return { text: "Settings guards", tone: "neutral" };
  if (templates === null) return { text: "guards not read", tone: "neutral" };
  const found = templates.find((t) => t.id === templateId);
  return found
    ? { text: found.name, tone: "neutral" }
    : { text: "template deleted", tone: "danger" };
}

/**
 * What the operator's own `~/.claude` puts in play whatever a picker picks.
 *
 * The saved registry is a *part* of the set of agents in play and never the
 * whole of it: the mounted config directory reaches every child this app spawns,
 * `--agents` merges with it rather than replacing it, and `--agent` resolves its
 * name against the merged set — so starting a run as a saved agent withdraws
 * none of them. Every surface that offers a choice has to say so, or the picker
 * reads as the complete answer to "which agents exist here". The wording stays
 * "in play whatever you pick here" rather than anything about delegation for
 * exactly that reason: what these definitions do inside a run is the CLI's
 * business, and what this sentence knows is that they are still there.
 *
 * One sentence rather than one per surface, for the reason `GET /api/agents`
 * answers with `ambient` beside `agents`: the run form and the workflow canvas
 * are describing the same set, and two wordings of it would be two claims that
 * could drift apart. Null when there is nothing to declare.
 */
export function describeAmbientAgents(
  ambient: ReadonlyArray<{ name: string }>,
): string | null {
  if (ambient.length === 0) return null;
  const names = ambient.slice(0, 3).map((a) => a.name);
  const rest = ambient.length - names.length;
  const list = rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
  return ambient.length === 1
    ? `Your own ~/.claude also carries ${list}, in play whatever you pick here`
    : `Your own ~/.claude also carries ${ambient.length} agents (${list}), in play whatever you pick here`;
}

/**
 * The chip beside an agent bucket, or null for a bucket that gets none.
 *
 * Two rows get no chip and each for its own reason. `(main thread)` is the
 * bucket for a turn carrying no agent name at all, so there is no name to look
 * up — which is a narrower claim than "not an agent" since a session started as
 * one may or may not name itself on its own turns, and the card's footnote is
 * where that is said. An `unknown` name is the
 * *ordinary* case rather than a fault — a CLI built-in, a repository's own
 * `.claude/agents`, an agent since deleted — so chipping it would put a mark on
 * most of the column and say nothing. What "unmarked" means is stated once, in
 * the card's own footnote, which is the place a sentence can carry it.
 *
 * `both` is a real hazard rather than a curiosity, so it is the one that is not
 * neutral: a saved agent and a file on disk answering to one name is a state
 * nothing in this app can resolve — which definition the CLI used is unverified
 * — and the operator is the only one who can.
 *
 * Shared with the run page for `guardBadge`'s reason: two wordings of one fact
 * are two claims that can drift.
 */
export function agentOriginBadge(
  origin: AgentOriginDTO | null,
): { text: string; tone: BadgeTone } | null {
  switch (origin) {
    case "registry":
      return { text: "saved", tone: "accent" };
    case "ambient":
      return { text: "on disk", tone: "neutral" };
    case "both":
      return { text: "name clash", tone: "warn" };
    default:
      return null;
  }
}

export type Severity = "ok" | "warn" | "danger";

export function severityFor(fraction: number | null): Severity {
  if (fraction === null) return "ok";
  if (fraction >= 0.9) return "danger";
  if (fraction >= 0.7) return "warn";
  return "ok";
}
