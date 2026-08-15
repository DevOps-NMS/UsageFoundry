import { db } from "./db";
import {
  DEFAULT_LIMITER,
  GLOBAL_SOURCE,
  type AttemptState,
  type LoginVerdict,
  planLoginAttempt,
  recordFailure,
} from "./loginLimiter";

/**
 * The durable half of the login limiter.
 *
 * `loginLimiter.ts` decides; this reads and writes the rows it decides from,
 * the same split as `sessionToken.ts` and `sessions.ts` one file over. Kept in
 * SQLite rather than in a module-level `Map` because both of the things this is
 * for outlive a process: a burst has to be visible to an operator afterwards —
 * before this, nothing anywhere recorded that anybody had ever guessed at the
 * token — and a lockout held only in memory is one an attacker clears by
 * restarting the container, which `restart: unless-stopped` will do for them.
 */

type Row = {
  source: string;
  failures: number;
  first_at: number;
  last_at: number;
  locked_until: number | null;
};

const toState = (r: Row): AttemptState => ({
  failures: r.failures,
  firstAt: r.first_at,
  lastAt: r.last_at,
  lockedUntil: r.locked_until,
});

function read(source: string): AttemptState | null {
  const row = db()
    .prepare("SELECT * FROM login_attempts WHERE source=?")
    .get(source) as Row | undefined;
  return row ? toState(row) : null;
}

function write(source: string, state: AttemptState): void {
  db()
    .prepare(
      "INSERT INTO login_attempts (source, failures, first_at, last_at, locked_until)" +
        " VALUES (?,?,?,?,?)" +
        " ON CONFLICT(source) DO UPDATE SET failures=excluded.failures," +
        " first_at=excluded.first_at, last_at=excluded.last_at," +
        " locked_until=excluded.locked_until",
    )
    .run(source, state.failures, state.firstAt, state.lastAt, state.lockedUntil);
}

/** May this attempt be made? Asked before the token is compared, never after. */
export function checkLoginAllowed(source: string, now = Date.now()): LoginVerdict {
  return planLoginAttempt({
    now,
    source: read(source),
    global: read(GLOBAL_SOURCE),
  });
}

/**
 * Count one failure against the source and against the install.
 *
 * A lockout that has just been reached is logged, because the table is where it
 * is recorded and the server log is where somebody watching will see it. The
 * ordinary failure is not: this route is unauthenticated, so a line per attempt
 * is a log an attacker can write.
 */
export function recordLoginFailure(source: string, now = Date.now()): void {
  const before = { source: read(source), global: read(GLOBAL_SOURCE) };

  const next = recordFailure(
    before.source,
    now,
    DEFAULT_LIMITER.maxSourceFailures,
    DEFAULT_LIMITER.sourceLockoutMs,
  );
  const nextGlobal = recordFailure(
    before.global,
    now,
    DEFAULT_LIMITER.maxGlobalFailures,
    DEFAULT_LIMITER.globalLockoutMs,
  );

  write(source, next);
  write(GLOBAL_SOURCE, nextGlobal);

  if (next.lockedUntil !== null && before.source?.lockedUntil == null) {
    console.warn(
      `[usagefoundry] Sign-in locked out for ${source} after ${next.failures} ` +
        `failed attempts. See Settings for the running total.`,
    );
  }
  if (nextGlobal.lockedUntil !== null && before.global?.lockedUntil == null) {
    console.warn(
      `[usagefoundry] Sign-in locked out install-wide after ` +
        `${nextGlobal.failures} failed attempts across every source.`,
    );
  }

  // Bounded growth: a bucket that has decayed and is not locked says nothing
  // the global row does not already carry.
  db()
    .prepare(
      "DELETE FROM login_attempts WHERE source<>? AND last_at < ?" +
        " AND (locked_until IS NULL OR locked_until <= ?)",
    )
    .run(GLOBAL_SOURCE, now - DEFAULT_LIMITER.windowMs, now);
}

/**
 * A correct token clears both buckets.
 *
 * The global one as well as the source's, deliberately: it is the bucket that
 * refuses the operator too, and somebody who just presented the token is the
 * operator. Leaving it standing would keep the install locked out on the
 * strength of an attack that has already failed.
 */
export function clearLoginFailures(source: string): void {
  db()
    .prepare("DELETE FROM login_attempts WHERE source=? OR source=?")
    .run(source, GLOBAL_SOURCE);
}

export interface LoginFailureSummary {
  /** Failures across every source inside the current window. */
  failures: number;
  firstAt: number | null;
  lastAt: number | null;
  /** How many sources are refused right now. */
  lockedSources: number;
  /** True while the whole install is refusing sign-ins. */
  lockedGlobally: boolean;
}

/** What the Settings page reports, so a burst is visible after it happened. */
export function loginFailureSummary(now = Date.now()): LoginFailureSummary {
  const global = read(GLOBAL_SOURCE);
  const locked = db()
    .prepare(
      "SELECT COUNT(*) AS n FROM login_attempts" +
        " WHERE source<>? AND locked_until IS NOT NULL AND locked_until > ?",
    )
    .get(GLOBAL_SOURCE, now) as { n: number };

  return {
    failures: global?.failures ?? 0,
    firstAt: global?.firstAt ?? null,
    lastAt: global?.lastAt ?? null,
    lockedSources: locked.n,
    lockedGlobally: global?.lockedUntil != null && global.lockedUntil > now,
  };
}
