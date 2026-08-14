import fs from "node:fs";

import { DB_PATH } from "./config";
import { db, getJSON, setJSON } from "./db";
import { TERMINAL_STATUSES } from "./orchestrator";
import { getSettings } from "./settings";

/**
 * What this app throws away, and what it promises to keep.
 *
 * Three stores grow with the work rather than with the configuration —
 * `run_events` in the named volume, `.uf-worktrees` on the workspace bind
 * mount, `~/.claude/projects` in the operator's own home — on three different
 * media, at three different rates. They are one module rather than three caps
 * because they share one question: what is safe to discard, and what does this
 * app promise about history it has already shown somebody.
 *
 * The answer is one sentence. **A run's row is permanent; everything behind it
 * is evidence, and evidence has a horizon.** Nothing here deletes a `runs` row,
 * a review, a workflow record or a setting, so every figure this app has put on
 * the dashboard, the runs list or a run's own state card keeps reading true —
 * the spend, the cycle count, the stop reason, the branch, the landing record.
 * What goes is the working material those figures were derived from: the event
 * log's payloads, the checkout on disk, the session transcript.
 *
 * Four properties are shared by every sweep here and none is optional.
 *
 *  - **Nothing in flight is touched.** A run that has not settled keeps its
 *    whole log; a checkout an active run holds is skipped by name; a transcript
 *    whose session belongs to a live run is not a candidate. Each sweep asks the
 *    *database* what is live rather than inferring it from a file's age.
 *  - **The decision is pure, the syscall is not.** What goes is decided by
 *    functions that are unit-tested against fixtures, for `releasableRuns`'
 *    reason: every way of being wrong here is silent, lands on somebody's disk,
 *    and throws nothing.
 *  - **A removal is recorded where the operator would look for it** — in the
 *    run's own log where there is a run, and in `retention.lastSweep`, which the
 *    Settings page shows beside the sizes.
 *  - **No sweep destroys the only copy of anything.** It removes no branch and
 *    no commit, it never touches the operator's own checkout, and what it does
 *    remove is evidence for a figure that is already recorded elsewhere.
 *
 * Every horizon is `null`-able and `null` means keep for ever, the reading
 * every switchable rule in this app takes.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How often the sweep runs. Retention is a horizon, not a deadline. */
const SWEEP_MS = 6 * 60 * 60 * 1000;

/**
 * Where the last sweep's counts live.
 *
 * A settings key rather than a table: it is one row that is overwritten, read
 * by one card, and a table for it would be a fifth store with no retention of
 * its own — which is the joke this module exists to stop being funny.
 */
const LAST_SWEEP_KEY = "retention.lastSweep";

export interface RetentionSweep {
  at: number;
  /** Rows removed from `run_events`. */
  events: number;
  /** Rows removed from `otlp_requests`. */
  telemetry: number;
}

export function lastSweep(): RetentionSweep | null {
  return getJSON<RetentionSweep | null>(LAST_SWEEP_KEY, null);
}

/**
 * The instant a horizon of `days` puts the boundary at, or null for "keep all".
 *
 * Its own function because all three sweeps read a horizon the same way and the
 * `null` reading is the one that must not drift: a blank field disables a rule
 * here exactly as it disables a budget guard, and a zero that fell through as a
 * cutoff of `now` would delete everything the first time somebody typed one.
 */
export function retentionCutoff(days: number | null, now: number): number | null {
  if (days === null || !Number.isFinite(days) || days <= 0) return null;
  return now - days * DAY_MS;
}

/* ------------------------------------------------------------------ */
/* run_events, and the telemetry rows beside them                      */
/* ------------------------------------------------------------------ */

/**
 * Drop the event payloads of settled runs past the horizon.
 *
 * Two tables, one horizon, because they are the same fact about the same run
 * seen from two sides: `run_events` is what this app recorded about a cycle and
 * `otlp_requests` is what the CLI reported about the requests inside it. Both
 * are bounded by the run having *settled*, so a log the run page is streaming
 * cannot lose lines under the reader and `telemetrySpendSince` — which reads a
 * live run's current cycle — can never be asked about a row that has gone.
 *
 * A telemetry row with no `run_id` is something else pointed at the ingest
 * route; it ages out on the horizon alone, since there is no run whose being
 * finished could protect it.
 *
 * No `VACUUM`. SQLite reuses the freed pages, so this bounds the database's
 * growth to a steady state; returning the space to the filesystem rewrites the
 * whole file and blocks the single writer while it does, which is not something
 * to do to a process that is also carrying live budget guards. The file's size
 * is reported instead, and `README.md` gives the command.
 */
export function sweepRunEvents(now = Date.now()): {
  events: number;
  telemetry: number;
} {
  const cutoff = retentionCutoff(getSettings().eventRetentionDays, now);
  if (cutoff === null) return { events: 0, telemetry: 0 };

  const settled = TERMINAL_STATUSES.map(() => "?").join(",");
  const events = db()
    .prepare(
      `DELETE FROM run_events
        WHERE ts < ?
          AND run_id IN (SELECT id FROM runs WHERE status IN (${settled}))`,
    )
    .run(cutoff, ...TERMINAL_STATUSES).changes;

  const telemetry = db()
    .prepare(
      `DELETE FROM otlp_requests
        WHERE ts < ?
          AND (run_id IS NULL
               OR run_id IN (SELECT id FROM runs WHERE status IN (${settled})))`,
    )
    .run(cutoff, ...TERMINAL_STATUSES).changes;

  return { events, telemetry };
}

/* ------------------------------------------------------------------ */
/* What each store currently holds                                     */
/* ------------------------------------------------------------------ */

export interface StorageReport {
  database: {
    path: string;
    /** The database file itself. */
    bytes: number;
    /** The write-ahead log and its index, which are the same store. */
    walBytes: number;
    runEvents: number;
    telemetryRows: number;
  };
  lastSweep: RetentionSweep | null;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * What is on disk right now, for the one card that says so.
 *
 * Measured rather than derived from the retention settings: a horizon says what
 * *will* be discarded, and an operator deciding whether to change it is asking
 * what is there now.
 */
export async function storageReport(): Promise<StorageReport> {
  const count = (sql: string) =>
    (db().prepare(sql).get() as { n: number }).n;

  return {
    database: {
      path: DB_PATH,
      bytes: sizeOf(DB_PATH),
      walBytes: sizeOf(`${DB_PATH}-wal`) + sizeOf(`${DB_PATH}-shm`),
      runEvents: count("SELECT COUNT(*) AS n FROM run_events"),
      telemetryRows: count("SELECT COUNT(*) AS n FROM otlp_requests"),
    },
    lastSweep: lastSweep(),
  };
}

/* ------------------------------------------------------------------ */
/* The sweep, and its one timer                                        */
/* ------------------------------------------------------------------ */

/**
 * One timer per process, `globalThis`-pinned, the shape `sweepPaused` and the
 * schedule timer already have and for their reason: module state that is not
 * pinned silently resets on every request in dev, and two of these would be two
 * sweeps deciding about one checkout.
 */
const timer = ((globalThis as unknown as {
  __ufRetention?: { handle: NodeJS.Timeout | null; running: boolean };
}).__ufRetention ??= { handle: null, running: false });

/**
 * Run every retention sweep once and record what it did.
 *
 * Exported so a test can drive it, and because the boot hook runs it once
 * rather than waiting six hours for the first tick — an install that has just
 * been upgraded into a retention policy is the one most likely to be over it.
 */
export async function runRetentionSweep(
  now = Date.now(),
): Promise<RetentionSweep> {
  const events = sweepRunEvents(now);
  const result: RetentionSweep = { at: now, ...events };
  setJSON(LAST_SWEEP_KEY, result);
  return result;
}

export function startRetentionSweeper(): void {
  if (timer.handle) return;
  timer.handle = setInterval(() => void tick(), SWEEP_MS);
  timer.handle.unref?.();
  void tick();
}

export function stopRetentionSweeper(): void {
  if (!timer.handle) return;
  clearInterval(timer.handle);
  timer.handle = null;
}

async function tick(): Promise<void> {
  if (timer.running) return;
  timer.running = true;
  try {
    await runRetentionSweep();
  } catch (err) {
    // A failed sweep must not kill the timer: the next one retries, and the
    // store it could not read is still bounded by the one after that.
    console.warn(
      `[usagefoundry] retention sweep failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    timer.running = false;
  }
}
