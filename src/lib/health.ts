import { db } from "./db";
import { measureEventLoopLagMs, opsCounters } from "./ops";
import { ownsDataDir } from "./serverLock";

/**
 * What `GET /api/health` answers with, and how it decides.
 *
 * The point of this file is that a health check which returns 200 because the
 * HTTP layer is up says nothing about a server that has stopped working. So
 * every field below is something that is *actually false* when this process
 * cannot do its job, and the route's status code is derived from them rather
 * than from having been reached.
 *
 * **What this detects.**
 *  - SQLite unopenable or unwritable — a real read and a real write lock, so a
 *    read-only data directory, a missing file and a corrupt handle all fail.
 *  - This process no longer owning `DATA_DIR` — its heartbeat stopped, so its
 *    reconcilers and sweepers are no longer entitled to act (`serverLock.ts`).
 *  - A sweeper that has stopped making progress while parked runs wait for it,
 *    and one whose every tick is throwing (`ops.ts`).
 *  - Event-loop *congestion*, as the delay a zero-delay timer actually takes.
 *
 * **What it cannot detect, and what covers it instead.**
 *  - A loop blocked outright. Nothing here runs, because the request is never
 *    handled — that case is the probe's own timeout, which is why the
 *    `HEALTHCHECK` in the Dockerfile sets one and why it is short relative to
 *    the interval. A field in this body could never report it.
 *  - Whether there is disk space to *commit* a write. The probe takes the write
 *    lock; it does not fill a page.
 *  - Whether any agent is making progress. That is `/api/status`, which answers
 *    "what is it doing" where this one answers "should Docker restart this".
 *
 * **What must never be added to the response**: run prompts, folder or mount
 * paths, settings values, tokens, model names, or anything read off a
 * transcript. The route is unauthenticated by design (see `middleware.ts`), and
 * it stays safe to leave open only for as long as it carries counts and nothing
 * else.
 */

/** Counts of the run states an operator can act on. */
export interface RunStateCounts {
  running: number;
  queued: number;
  waiting: number;
  paused: number;
}

export interface HealthReport {
  /** False only where this server cannot do its job at all. */
  ok: boolean;
  status: "ok" | "degraded" | "unhealthy";
  /** Why, in short machine-readable slugs. Empty when `status` is "ok". */
  problems: string[];
  checks: {
    /** A real read and a real write lock against SQLite. */
    database: "ok" | "error";
    /** Present only on failure, and a message rather than a stack. */
    databaseError?: string;
    /** Whether this process holds the data-directory lock. */
    dataDirOwned: boolean;
  };
  runs: RunStateCounts;
  sweeper: {
    /** Seconds since the last completed sweep, or null if it has never run. */
    lastTickAgeSeconds: number | null;
    /** Sweeps that threw and were swallowed since boot. */
    failures: number;
    /** The last swallowed message, or null. */
    lastError: string | null;
  };
  /** How late a zero-delay timer actually fired, in milliseconds. */
  eventLoopLagMs: number;
  uptimeSeconds: number;
}

/**
 * Sweep silence past which a parked run is being neglected rather than waited
 * on. Three intervals, so one slow sweep and one missed tick are both ordinary.
 */
const SWEEP_STALE_MS = 3 * 60_000;

/** Loop congestion past which the server is answering but not keeping up. */
const LAG_DEGRADED_MS = 2_000;

/**
 * A read *and* a write against SQLite.
 *
 * `BEGIN IMMEDIATE` takes the database's write lock and `ROLLBACK` gives it
 * back, so nothing is written and no WAL page is dirtied — but a read-only file
 * or directory fails here, which a `SELECT` alone would not. Throws on failure
 * rather than returning a flag, because the caller has to distinguish it from
 * every other field being merely unknown.
 */
function probeDatabase(): RunStateCounts {
  const rows = db()
    .prepare(
      "SELECT status, COUNT(*) AS n FROM runs" +
        " WHERE status IN ('running','queued','waiting','paused') GROUP BY status",
    )
    .all() as Array<{ status: string; n: number }>;

  db().prepare("BEGIN IMMEDIATE").run();
  db().prepare("ROLLBACK").run();

  const counts: RunStateCounts = { running: 0, queued: 0, waiting: 0, paused: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status as keyof RunStateCounts] = row.n;
  }
  return counts;
}

export async function healthReport(now = Date.now()): Promise<HealthReport> {
  const ops = opsCounters();
  const lag = await measureEventLoopLagMs();

  let counts: RunStateCounts = { running: 0, queued: 0, waiting: 0, paused: 0 };
  let databaseError: string | null = null;
  try {
    counts = probeDatabase();
  } catch (err) {
    databaseError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }

  const sweepAge = ops.lastSweepAt === null ? null : now - ops.lastSweepAt;
  const problems: string[] = [];

  if (databaseError !== null) problems.push("database");
  if (!ownsDataDir()) problems.push("data-dir-not-owned");
  // Only meaningful when something is actually parked: the sweeper is lazily
  // started and stopped, so an idle server holding no timer at all is the
  // ordinary case and reporting it as a stall would make the field useless.
  if (
    counts.paused > 0 &&
    (sweepAge === null || sweepAge > SWEEP_STALE_MS)
  ) {
    problems.push("sweeper-stalled");
  }
  if (ops.sweepFailures > 0 && ops.lastSweepFailureAt !== null &&
      now - ops.lastSweepFailureAt < SWEEP_STALE_MS) {
    problems.push("sweeper-failing");
  }
  if (lag > LAG_DEGRADED_MS) problems.push("event-loop-lag");

  // Only the database check fails the probe. Everything else is reported and
  // stays 2xx on purpose: a restart here marks every in-flight run `failed` and
  // leaves its current cycle's spend unreconciled, so the bar for asking for
  // one is "this server cannot do its job", not "something is wrong".
  const ok = databaseError === null;

  return {
    ok,
    status: !ok ? "unhealthy" : problems.length > 0 ? "degraded" : "ok",
    problems,
    checks: {
      database: databaseError === null ? "ok" : "error",
      ...(databaseError === null ? {} : { databaseError }),
      dataDirOwned: ownsDataDir(),
    },
    runs: counts,
    sweeper: {
      lastTickAgeSeconds: sweepAge === null ? null : Math.round(sweepAge / 1000),
      failures: ops.sweepFailures,
      lastError: ops.lastSweepError,
    },
    eventLoopLagMs: lag,
    uptimeSeconds: Math.round((now - ops.bootedAt) / 1000),
  };
}
