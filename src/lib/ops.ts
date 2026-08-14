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

export function noteSweep(): void {
  state.lastSweepAt = Date.now();
}

export function noteSweepFailure(err: unknown): void {
  state.sweepFailures += 1;
  state.lastSweepFailureAt = Date.now();
  state.lastSweepError = messageOf(err);
}

export function noteLiveTick(): void {
  state.lastLiveTickAt = Date.now();
}

export function noteLiveTickFailure(err: unknown): void {
  state.liveTickFailures += 1;
  state.lastLiveTickFailureAt = Date.now();
  state.lastLiveTickError = messageOf(err);
}

export function opsCounters(): Readonly<OpsState> {
  return state;
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
