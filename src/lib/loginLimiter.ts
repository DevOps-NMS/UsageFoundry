/**
 * What `/api/login` is allowed to do about a guess.
 *
 * `middleware.ts` exempts `/login` and `/api/login`, correctly — the page has to
 * be reachable for anyone to sign in — which makes that handler the one
 * unauthenticated write surface in the app, and nothing bounded it. There was
 * no counter, no per-source state, no lockout and no record: the whole of the
 * defence was a 400 ms `await` on a timer, which delays a request without
 * serialising anything, so two hundred concurrent connections guess at the rate
 * of the event loop. The same load competes with every running agent for the
 * single Node process this app is built around, so it is a denial of service on
 * the runs as well as a brute force.
 *
 * Two budgets, because they answer different attacks, and the second exists
 * precisely because the first can be evaded. A source is identified from
 * `x-forwarded-for`, which is client-controlled unless a trusted proxy sets it,
 * so an attacker who rotates that header gets a fresh per-source budget every
 * request. The global budget is what still bounds them.
 *
 * Pure, and the same reasoning as every other decision separated from its
 * effect here: both ways of getting it wrong are silent. A limiter that never
 * fires looks exactly like one that is working, and one that fires too eagerly
 * locks the operator out of the app with no way in but the environment.
 */

export interface AttemptState {
  failures: number;
  firstAt: number;
  lastAt: number;
  /** Epoch ms this bucket is refused until, or null. */
  lockedUntil: number | null;
}

export interface LimiterConfig {
  /** Consecutive failures from one source before it is locked out. */
  maxSourceFailures: number;
  /** How long a source stays locked out. */
  sourceLockoutMs: number;
  /** Failures across every source inside `windowMs` before everything is locked. */
  maxGlobalFailures: number;
  /**
   * How long the *global* lock lasts, and it is deliberately much shorter than
   * the per-source one. A global lock refuses the operator too, so it is a
   * denial of service an unauthenticated caller can trigger; short enough that
   * a sustained attack degrades sign-in rather than removing it, long enough
   * that guessing is bounded to a rate no token this app documents survives.
   */
  globalLockoutMs: number;
  /** A bucket with no failure inside this window starts again from zero. */
  windowMs: number;
}

export const DEFAULT_LIMITER: LimiterConfig = {
  maxSourceFailures: 10,
  sourceLockoutMs: 15 * 60_000,
  maxGlobalFailures: 100,
  globalLockoutMs: 60_000,
  windowMs: 15 * 60_000,
};

/** The bucket every source shares. Not a valid address, so it cannot collide. */
export const GLOBAL_SOURCE = "*";

export type LoginVerdict =
  | { allow: true }
  | { allow: false; scope: "source" | "global"; retryAfterMs: number };

/**
 * Whether this attempt may be made at all — asked *before* the token is
 * compared, so a locked-out caller learns nothing about their guess.
 *
 * The source lock is tested first so its `Retry-After` is the one reported: it
 * is the longer of the two and the one the caller can do something about.
 */
export function planLoginAttempt(o: {
  now: number;
  source: AttemptState | null;
  global: AttemptState | null;
}): LoginVerdict {
  for (const [scope, state] of [
    ["source", o.source],
    ["global", o.global],
  ] as const) {
    if (state?.lockedUntil != null && state.lockedUntil > o.now) {
      return { allow: false, scope, retryAfterMs: state.lockedUntil - o.now };
    }
  }
  return { allow: true };
}

/**
 * The bucket after one more failure.
 *
 * A lock that has passed resets the count rather than carrying it: left
 * standing, the first attempt after a lockout expires would immediately re-lock
 * at the threshold, which is a permanent lock reached in `maxFailures` guesses
 * and no way for the operator to ever get in.
 */
export function recordFailure(
  state: AttemptState | null,
  now: number,
  max: number,
  lockoutMs: number,
  config: LimiterConfig = DEFAULT_LIMITER,
): AttemptState {
  const decayed =
    state === null ||
    now - state.lastAt > config.windowMs ||
    (state.lockedUntil != null && state.lockedUntil <= now);

  const failures = decayed ? 1 : state.failures + 1;
  return {
    failures,
    firstAt: decayed ? now : state.firstAt,
    lastAt: now,
    lockedUntil: failures >= max ? now + lockoutMs : null,
  };
}
