import { db } from "./db";

/**
 * Process-level operational counters — what this server has been doing, as
 * numbers rather than as prose on stdout.
 *
 * Everything here is in memory and dies with the process, which is the right
 * lifetime for it: these answer "is *this* server making progress", and a
 * counter that survived a restart would answer that question about a process
 * that is gone. Anything that has to outlive the process is a row in SQLite
 * instead (see `ops_events` in `db.ts`).
 *
 * `globalThis`-pinned under its own key for the reason every other long-lived
 * singleton here is: module state silently resets on every request under
 * `next dev`, and a sweeper-age reading that resets to "never" each time it is
 * read is worse than no reading. Its own key rather than a field added to
 * `__ufTimers` because `??=` only initialises when the key is *absent* — a
 * hot reload would keep the pre-upgrade object and every new field would read
 * `undefined` for the life of the dev server.
 */

/** What the two background timers last did, and how often they failed. */
interface OpsState {
  bootedAt: number;
  /** When `sweepPaused` last ran to completion. Null until the first sweep. */
  lastSweepAt: number | null;
  /**
   * Sweeps that threw and were swallowed.
   *
   * The catch in `sweepPaused` is right — a failed sweep must not kill the
   * timer — but it was also completely silent, so a sweep failing on *every*
   * tick (an unwritable database, a `currentSnapshot()` that throws) left every
   * parked run waiting indefinitely with no evidence anywhere. This is that
   * evidence.
   */
  sweepFailures: number;
  lastSweepFailureAt: number | null;
  /** The last failure's message, for the status endpoint. Never a stack. */
  lastSweepError: string | null;
  lastLiveTickAt: number | null;
  liveTickFailures: number;
  lastLiveTickFailureAt: number | null;
  lastLiveTickError: string | null;
}

const state = ((globalThis as unknown as { __ufOps?: OpsState }).__ufOps ??= {
  bootedAt: Date.now(),
  lastSweepAt: null,
  sweepFailures: 0,
  lastSweepFailureAt: null,
  lastSweepError: null,
  lastLiveTickAt: null,
  liveTickFailures: 0,
  lastLiveTickFailureAt: null,
  lastLiveTickError: null,
});

/** A message with no stack, for a payload that goes to an operator. */
function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 300);
}

/** Severity, in the three words every log aggregator already understands. */
export type OpsLevel = "info" | "warn" | "error";

/**
 * What a structured line may carry: primitives, and null for "known to be
 * absent". Deliberately not `unknown` — an object here would be serialised
 * whole, which is how a prompt or a folder path ends up on stdout. Every caller
 * names its fields.
 */
export type OpsFields = Record<string, string | number | boolean | null>;

/**
 * One JSON object per line on stdout, beside the `[usagefoundry]` prose.
 *
 * The whole server had eight `console.*` sites, all of them English sentences
 * with values interpolated into them — nothing a monitor can parse, no level,
 * no run id. This is the second sink, and it is deliberately `console.log` and
 * `JSON.stringify` rather than a logging dependency: four runtime dependencies
 * is a property of this repository, and one line of JSON satisfies everything a
 * scraper needs.
 *
 * **Never hand this a payload object.** `run_events` payloads carry prompt text
 * (`iteration`), folder paths (`status` at creation) and an agent's own output;
 * container stdout is a different audience with a different lifetime. Callers
 * project the two or three fields that matter and pass those. Nothing here ever
 * carries a credential: no token, no cookie, no request body.
 */
export function opsLog(level: OpsLevel, event: string, fields: OpsFields = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function noteSweep(): void {
  state.lastSweepAt = Date.now();
}

export function noteSweepFailure(err: unknown): void {
  state.sweepFailures += 1;
  state.lastSweepFailureAt = Date.now();
  state.lastSweepError = messageOf(err);
  opsLog("error", "sweep.failed", {
    failures: state.sweepFailures,
    message: state.lastSweepError,
  });
}

export function noteLiveTick(): void {
  state.lastLiveTickAt = Date.now();
}

export function noteLiveTickFailure(err: unknown): void {
  state.liveTickFailures += 1;
  state.lastLiveTickFailureAt = Date.now();
  state.lastLiveTickError = messageOf(err);
  opsLog("error", "live_guard_tick.failed", {
    failures: state.liveTickFailures,
    message: state.lastLiveTickError,
  });
}

export function opsCounters(): Readonly<OpsState> {
  return state;
}

/**
 * Record something that happened to the *server*, durably, and log it.
 *
 * Two sinks for one fact, on purpose: the JSON line is for whatever is
 * scraping stdout, and the row is for the operator who was not scraping
 * anything and opens the page an hour later. `run_events` cannot hold this —
 * it is per run and cascades with it, and the event worth keeping most is the
 * restart that closed every run out.
 *
 * Retention is a count rather than an age: this table is written a handful of
 * times per boot, so a cap keeps it from ever being a store worth reporting on.
 */
export function recordOpsEvent(
  level: OpsLevel,
  event: string,
  detail: OpsFields = {},
): void {
  opsLog(level, event, detail);
  try {
    const handle = db();
    handle
      .prepare("INSERT INTO ops_events (ts, level, event, detail) VALUES (?, ?, ?, ?)")
      .run(Date.now(), level, event, JSON.stringify(detail));
    handle
      .prepare(
        "DELETE FROM ops_events WHERE id <= (SELECT MAX(id) FROM ops_events) - ?",
      )
      .run(OPS_EVENT_RETENTION);
  } catch {
    // The one place a swallow is right: this is the *reporting* path, and a
    // database that cannot take the row is exactly the condition the line
    // already on stdout describes. Throwing here would take down the boot
    // reconciler whose outcome it is recording.
  }
}

/** How many `ops_events` rows are kept. Boot-frequency writes, so generous. */
const OPS_EVENT_RETENTION = 500;

/** One recorded server event, as a page or a monitor reads it. */
export interface OpsEvent {
  ts: number;
  level: OpsLevel;
  event: string;
  detail: Record<string, unknown>;
}

/** The most recent server events, newest first. */
export function recentOpsEvents(limit = 20, event?: string): OpsEvent[] {
  const rows = (
    event
      ? db()
          .prepare(
            "SELECT ts, level, event, detail FROM ops_events WHERE event = ? ORDER BY id DESC LIMIT ?",
          )
          .all(event, limit)
      : db()
          .prepare(
            "SELECT ts, level, event, detail FROM ops_events ORDER BY id DESC LIMIT ?",
          )
          .all(limit)
  ) as Array<{ ts: number; level: string; event: string; detail: string }>;

  return rows.map((r) => ({
    ts: r.ts,
    level: r.level as OpsLevel,
    event: r.event,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  }));
}

/**
 * How late a zero-delay timer actually fires, in milliseconds.
 *
 * Measured on demand rather than from a permanent sampling interval, because an
 * idle server here deliberately holds no timer at all. What it measures is the
 * delay between scheduling work and the loop getting to it, which is congestion
 * — several `buildSnapshot` calls or a `gitSync` landing together. What it
 * cannot measure is a loop blocked *outright*: nothing schedules this, because
 * the request carrying it never gets handled. That case is the healthcheck's
 * own timeout, and the route comment says so.
 */
export function measureEventLoopLagMs(): Promise<number> {
  const start = Date.now();
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(Math.max(0, Date.now() - start)), 0);
  });
}
