import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_LIMITER,
  type AttemptState,
  planLoginAttempt,
  recordFailure,
} from "./loginLimiter";

/**
 * The two ways a rate limiter is silently wrong.
 *
 * One that never fires is bit-for-bit the unbounded route this replaced —
 * nothing throws, nothing logs, and the only evidence is a token that falls.
 * One that fires too eagerly, or that never lets go, locks the operator out of
 * an app whose only other credential is an environment variable and a restart.
 */

const NOW = 1_760_000_000_000;
const { maxSourceFailures, sourceLockoutMs, windowMs } = DEFAULT_LIMITER;

function afterFailures(n: number, from = NOW, gap = 1_000): AttemptState {
  let state: AttemptState | null = null;
  for (let i = 0; i < n; i++) {
    state = recordFailure(
      state,
      from + i * gap,
      maxSourceFailures,
      sourceLockoutMs,
    );
  }
  assert.ok(state);
  return state;
}

test("a source with no history is allowed", () => {
  assert.deepEqual(planLoginAttempt({ now: NOW, source: null, global: null }), {
    allow: true,
  });
});

test("failures below the threshold do not lock anything", () => {
  const state = afterFailures(maxSourceFailures - 1);
  assert.equal(state.failures, maxSourceFailures - 1);
  assert.equal(state.lockedUntil, null);
  assert.equal(
    planLoginAttempt({ now: state.lastAt, source: state, global: null }).allow,
    true,
  );
});

test("the threshold locks the source out for the window", () => {
  const state = afterFailures(maxSourceFailures);
  assert.ok(state.lockedUntil);

  const verdict = planLoginAttempt({
    now: state.lastAt,
    source: state,
    global: null,
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.scope, "source");
  assert.equal(verdict.retryAfterMs, sourceLockoutMs);
});

test("the lockout ends, and the count starts again rather than re-locking", () => {
  const locked = afterFailures(maxSourceFailures);
  const after = locked.lockedUntil! + 1;

  assert.equal(
    planLoginAttempt({ now: after, source: locked, global: null }).allow,
    true,
  );
  // The failure that follows must not immediately re-lock: carried forward,
  // `maxSourceFailures` wrong guesses would lock the operator out for ever.
  const next = recordFailure(locked, after, maxSourceFailures, sourceLockoutMs);
  assert.equal(next.failures, 1);
  assert.equal(next.lockedUntil, null);
  assert.equal(next.firstAt, after, "a decayed bucket restarts its window");
});

test("a quiet window decays the count", () => {
  const state = afterFailures(maxSourceFailures - 1);
  const later = state.lastAt + windowMs + 1;
  assert.equal(
    recordFailure(state, later, maxSourceFailures, sourceLockoutMs).failures,
    1,
  );
});

test("the install-wide budget refuses even an unseen source", () => {
  // What the per-source bucket cannot do: `x-forwarded-for` is client-settable
  // with no proxy in front, so an attacker rotating it gets a fresh source
  // every request and never reaches a source threshold.
  const global: AttemptState = {
    failures: DEFAULT_LIMITER.maxGlobalFailures,
    firstAt: NOW,
    lastAt: NOW,
    lockedUntil: NOW + DEFAULT_LIMITER.globalLockoutMs,
  };
  const verdict = planLoginAttempt({ now: NOW, source: null, global });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.scope, "global");
});

test("the source lock outranks the global one in what it reports", () => {
  const source = afterFailures(maxSourceFailures);
  const global: AttemptState = {
    failures: DEFAULT_LIMITER.maxGlobalFailures,
    firstAt: NOW,
    lastAt: NOW,
    lockedUntil: NOW + DEFAULT_LIMITER.globalLockoutMs,
  };
  const verdict = planLoginAttempt({ now: source.lastAt, source, global });
  assert.equal(verdict.allow, false);
  // The longer wait is the honest one to report, and it is the one the caller
  // can act on: a global lock clears on its own in a minute.
  assert.equal(verdict.scope, "source");
});

test("the global lock is much shorter than the per-source one", () => {
  // It refuses the operator too, so it is a denial of service an
  // unauthenticated caller can trigger. Degraded sign-in, not removed.
  assert.ok(DEFAULT_LIMITER.globalLockoutMs < DEFAULT_LIMITER.sourceLockoutMs);
});
