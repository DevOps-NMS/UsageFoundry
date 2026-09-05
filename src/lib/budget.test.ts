import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BudgetPolicy,
  type InstanceBudgetPolicy,
  INSTANCE_ENFORCEABLE_CODES,
  RUN_ENFORCEABLE_CODES,
  enforceableForRun,
  evaluateBudget,
  evaluateInstallBudget,
  evaluateInstanceBudget,
  installBudgetIsOff,
  instanceBudgetIsOff,
  normalizeInstallBudget,
  normalizeInstanceBudget,
  normalizePolicy,
  planReadingAgeMs,
  readWindowGuard,
  windowGuardRefusal,
} from "./budget";
import { pctField, pctSubmit } from "./format";
import type { UsageSnapshot, WindowState } from "./windows";

/**
 * Covers the policy coercion and the guard's decision order, and only those.
 *
 * They earn a test on the same grounds `overlaps()` does: both are pure, and
 * both have failure modes that are silent and expensive. `normalizePolicy` runs
 * twice over the same policy — once at creation and again after the row is read
 * back — so a term that is not idempotent turns a legal run fatal at restart.
 * `evaluateBudget`'s ordering is what stops a run that is out of time from
 * parking forever instead of ending.
 */

function window(guardFraction: number | null, endsAt = 0): WindowState {
  return {
    label: "w",
    startsAt: 0,
    endsAt,
    agg: {
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
      costUSD: 0,
      costGuardUSD: 0,
      entryCount: 0,
    },
    tokens: 0,
    costUSD: 0,
    // `fraction` and `guardFraction` are null together by construction in
    // windows.ts, and the "no ceiling" refusal depends on that. Keep them tied
    // here so a test cannot accidentally exercise a state that cannot occur.
    fraction: guardFraction,
    fractionMetric: guardFraction === null ? null : "cost",
    planFraction: null,
    costFraction: guardFraction,
    tokenFraction: null,
    guardFraction,
    limit: guardFraction === null ? null : 100,
    limitMetric: guardFraction === null ? null : "cost",
  };
}

function snapshot(sessionFraction: number | null, weeklyFraction: number | null) {
  return {
    now: 0,
    session: window(sessionFraction, 5_000),
    weekly: window(weeklyFraction),
    blocks: [],
    burnTokensPerHour: 0,
    burnCostPerHour: 0,
    projectedExhaustionAt: null,
    byModel: [],
    byProject: [],
    byAgent: [],
    bySkill: [],
    byEffort: [],
    totalCostUSD: 0,
  } as unknown as UsageSnapshot;
}

/**
 * The same snapshot, but with the 5-hour reading coming from the provider and
 * carrying the instant it was read.
 *
 * That reading is cached — five minutes in the ordinary case, up to an hour
 * while requests are being refused — so a verdict reached on it can be an hour
 * behind the window it describes, and nothing in the verdict or the run log
 * used to say so.
 */
function planSnapshot(sessionFraction: number, fetchedAt: number): UsageSnapshot {
  const snap = snapshot(sessionFraction, null);
  return {
    ...snap,
    session: {
      ...snap.session,
      fractionMetric: "plan",
      planFraction: sessionFraction,
    },
    plan: { session: null, weekly: null, scopedWeekly: [], fetchedAt },
  };
}

const base: BudgetPolicy = {
  maxWeeklyFraction: null,
  maxSessionFraction: null,
  maxRunCostUSD: null,
  maxRunCostFactor: null,
  maxRunTokens: null,
  maxIterations: 5,
  maxDurationMinutes: null,
  enforcement: "between-cycles",
  continueAfterDone: false,
};

/**
 * A real start instant, not 0: `evaluateBudget` treats a falsy `startedAt` as
 * "never started" and reads zero elapsed time from it, so epoch 0 would quietly
 * disable the duration guard. No stored row can hold 0, but a fixture can.
 */
const STARTED_AT = 1_700_000_000_000;

const noProgress = {
  iterations: 0,
  spentUSD: 0,
  spentTokens: 0,
  startedAt: STARTED_AT,
};

describe("normalizePolicy", () => {
  it("is idempotent across a JSON round trip", () => {
    const inputs: unknown[] = [
      {},
      { maxIterations: "5", maxRunCostUSD: "2.5", maxDurationMinutes: "60" },
      { maxIterations: null, maxDurationMinutes: 30 },
      { enforcement: "live-resume", maxSessionFraction: 0.85 },
      { continueAfterDone: true, maxWeeklyFraction: 80 },
    ];
    for (const raw of inputs) {
      const once = normalizePolicy(raw);
      const twice = normalizePolicy(JSON.parse(JSON.stringify(once)));
      assert.deepEqual(twice, once, `not idempotent for ${JSON.stringify(raw)}`);
    }
  });

  it("distinguishes an explicit null cycle cap from a blank one", () => {
    // Blank, zero, negative and missing all still mean one cycle. Only an
    // explicit null asks for an uncapped loop, which is what keeps a typo in
    // the field from producing a run nothing would end.
    assert.equal(normalizePolicy({ maxIterations: null }).maxIterations, null);
    assert.equal(normalizePolicy({}).maxIterations, 1);
    assert.equal(normalizePolicy({ maxIterations: "" }).maxIterations, 1);
    assert.equal(normalizePolicy({ maxIterations: 0 }).maxIterations, 1);
    assert.equal(normalizePolicy({ maxIterations: -4 }).maxIterations, 1);
  });

  it("reads a non-boolean continueAfterDone as off", () => {
    // This flag makes a run refuse to stop when the agent says it is finished,
    // so a string off the wire must fail safe rather than fail consistent.
    assert.equal(normalizePolicy({ continueAfterDone: "false" }).continueAfterDone, false);
    assert.equal(normalizePolicy({ continueAfterDone: "true" }).continueAfterDone, false);
    assert.equal(normalizePolicy({ continueAfterDone: 1 }).continueAfterDone, false);
    assert.equal(normalizePolicy({ continueAfterDone: true }).continueAfterDone, true);
  });

  it("falls back to between-cycles for an unknown enforcement mode", () => {
    assert.equal(normalizePolicy({ enforcement: "nonsense" }).enforcement, "between-cycles");
    assert.equal(normalizePolicy({}).enforcement, "between-cycles");
    assert.equal(normalizePolicy({ enforcement: "live" }).enforcement, "live");
  });

  it("accepts a fraction as either 0-1 or 0-100", () => {
    assert.equal(normalizePolicy({ maxWeeklyFraction: 80 }).maxWeeklyFraction, 0.8);
    assert.equal(normalizePolicy({ maxWeeklyFraction: 0.8 }).maxWeeklyFraction, 0.8);
    assert.equal(normalizePolicy({ maxWeeklyFraction: 400 }).maxWeeklyFraction, 1);
  });

  it("round-trips a stored fraction through the form's percentage field", () => {
    // `pctField` fills the run form's 0-100 boxes from a stored 0-1 fraction —
    // loading a template, or copying an earlier run — and the form submits
    // `Number(field) / 100` straight back here. The two have to be exact
    // inverses: a guard that came back a hundredth of what was saved parks a
    // live-resume run on its first check and reads, from the outside, as a run
    // patiently waiting for a window that is never going to satisfy it.
    const submit = (field: string) => (field ? Number(field) / 100 : null);
    for (const f of [0.05, 0.5, 0.8, 0.855, 0.999, 1]) {
      const back = normalizePolicy({
        maxSessionFraction: submit(pctField(f)),
      }).maxSessionFraction;
      // Within float noise rather than bit-identical: a decimal percentage
      // cannot survive binary division exactly (0.999 comes back as
      // 0.9990000000000001), and the error this guards against is three orders
      // of magnitude larger than that.
      assert.ok(
        back !== null && Math.abs(back - f) < 1e-9,
        `round trip failed for ${f}: got ${back}`,
      );
    }
    // No guard stays no guard. A "0" in the box would be a guard set to zero
    // percent, which trips on the first check of every run.
    assert.equal(pctField(null), "");
    assert.equal(submit(pctField(null)), null);
    assert.equal(normalizePolicy({ maxSessionFraction: null }).maxSessionFraction, null);
  });
});

describe("readWindowGuard", () => {
  it("reads a window sitting exactly on the guard as over it", () => {
    // Not a corner case, the expected one: on a stock install `fraction` comes
    // from the provider's own utilisation, which arrives as a whole-number
    // percentage divided by 100, so an 80% guard is compared against a reading
    // that lands on 0.8 exactly rather than near it. `>=`, so a window at the
    // guard has reached it. This is the only implementation of that comparison,
    // so it decides the run guard and the workflow guard together.
    assert.deepEqual(readWindowGuard(window(0.8), 0.8), { state: "over", at: 0.8 });
    assert.deepEqual(readWindowGuard(window(0.81), 0.8), { state: "over", at: 0.81 });
    assert.deepEqual(readWindowGuard(window(0.79), 0.8), { state: "under", at: 0.79 });
  });

  it("answers no-ceiling off fraction, and reads guardFraction for the rest", () => {
    // Two fields for two questions: whether there is a reading at all, and
    // whether it is past the threshold. A window made of an unpriced model
    // displays 0 and guards on the fallback rate, and it is the second figure
    // the comparison above is made on.
    assert.deepEqual(readWindowGuard(window(null), 0.8), { state: "no-ceiling" });
    assert.deepEqual(readWindowGuard(splitWindow(0, 0.8, 100), 0.8), {
      state: "over",
      at: 0.8,
    });
  });
});

describe("evaluateBudget", () => {
  it("refuses a policy with no terminus, ahead of every other check", () => {
    const verdict = evaluateBudget(
      { ...base, maxIterations: null, maxDurationMinutes: null },
      snapshot(null, null),
      noProgress,
      0,
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.allowed === false && verdict.code, "no_terminus");
  });

  it("parks on the 5-hour window only under live-resume", () => {
    const policy = { ...base, maxSessionFraction: 0.8 };
    const snap = snapshot(0.9, null);

    for (const enforcement of ["between-cycles", "live"] as const) {
      const v = evaluateBudget({ ...policy, enforcement }, snap, noProgress, 0);
      assert.equal(v.allowed, false);
      assert.equal(v.allowed === false && v.disposition, "stop");
    }

    const parked = evaluateBudget(
      { ...policy, enforcement: "live-resume" },
      snap,
      noProgress,
      0,
    );
    assert.equal(parked.allowed, false);
    assert.equal(parked.allowed === false && parked.disposition, "pause");
    // Past the boundary, not on it: the boundary comes from transcripts flushed
    // as turns complete, so waking exactly at endsAt can read the closing
    // window one more time and park again in a tight loop.
    assert.ok(
      parked.allowed === false &&
        parked.disposition === "pause" &&
        parked.resumeAt > snap.session.endsAt,
    );
  });

  it("never parks on the weekly window", () => {
    // The weekly window has no reset instant in its default rolling mode, so
    // there is nothing to wait for. It is the terminus, not a gate.
    const v = evaluateBudget(
      { ...base, maxWeeklyFraction: 0.8, enforcement: "live-resume" },
      snapshot(null, 0.9),
      noProgress,
      0,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "weekly_fraction");
    assert.equal(v.allowed === false && v.disposition, "stop");
  });

  it("ends rather than parks a run that is also out of time", () => {
    // The ordering is load-bearing. If the session check ran first, a run whose
    // wall clock had expired would park, wake, park again, and never terminate.
    const v = evaluateBudget(
      {
        ...base,
        enforcement: "live-resume",
        maxSessionFraction: 0.8,
        maxDurationMinutes: 10,
      },
      snapshot(0.9, null),
      noProgress,
      STARTED_AT + 11 * 60_000,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "duration");
    assert.equal(v.allowed === false && v.disposition, "stop");
  });

  it("refuses a fraction guard with no ceiling rather than ignoring it", () => {
    const v = evaluateBudget(
      { ...base, maxSessionFraction: 0.8, enforcement: "live-resume" },
      snapshot(null, null),
      noProgress,
      0,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "no_ceiling");
  });

  /**
   * …and one window with nothing to read must not switch the other one off.
   *
   * `no_ceiling` is the one refusal nothing acts on — `RUN_ENFORCEABLE_CODES`
   * below — so returning it the moment the weekly window came back unreadable
   * meant the session check was never reached, and the run spawned its cycle
   * under a log line naming the *weekly* guard. On a stock install that is not
   * an exotic state: ceilings ship null and the weekly reading is the
   * provider's own percentage, which goes away whenever the host does. The runs
   * a workflow member or a chat approval creates never pass
   * `windowGuardRefusal`, so the door does not catch it either.
   */
  it("still enforces the 5-hour guard when the weekly window cannot be read", () => {
    const policy = {
      ...base,
      maxWeeklyFraction: 0.8,
      maxSessionFraction: 0.5,
    };
    const snap = snapshot(0.97, null);

    const stopped = evaluateBudget(policy, snap, noProgress, 0);
    assert.equal(stopped.allowed, false);
    assert.equal(stopped.allowed === false && stopped.code, "session_fraction");
    assert.equal(stopped.allowed === false && stopped.disposition, "stop");

    // And the park survives it: the one verdict here that yields the folder
    // rather than ending the run must not be shadowed by the held refusal.
    const parked = evaluateBudget(
      { ...policy, enforcement: "live-resume" },
      snap,
      noProgress,
      0,
    );
    assert.equal(parked.allowed, false);
    assert.equal(parked.allowed === false && parked.disposition, "pause");
    assert.equal(parked.allowed === false && parked.code, "session_fraction");
  });

  it("still reports the unreadable window once every readable guard passes", () => {
    // Held, not dropped. The operator set a weekly guard that is measuring
    // nothing, and a run proceeding under a guard the user believes is active
    // is the failure the refusal exists to prevent — so it is still the verdict
    // when the guards that *can* be read all have room.
    const v = evaluateBudget(
      { ...base, maxWeeklyFraction: 0.8, maxSessionFraction: 0.5 },
      snapshot(0.1, null),
      noProgress,
      0,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "no_ceiling");
    // The window that could not be read is the one named.
    assert.match(v.allowed === false ? v.reason : "", /weekly-fraction guard/);

    // With neither readable, the one checked first names it — the same
    // precedence `windowGuardRefusal` gives it at the door, so the two doors
    // cannot report different windows for the same snapshot.
    const both = evaluateBudget(
      { ...base, maxWeeklyFraction: 0.8, maxSessionFraction: 0.5 },
      snapshot(null, null),
      noProgress,
      0,
    );
    assert.equal(
      both.allowed === false ? both.reason : "",
      windowGuardRefusal(
        { ...base, maxWeeklyFraction: 0.8, maxSessionFraction: 0.5 },
        snapshot(null, null),
      ),
    );
  });

  it("keeps the documented order when a window cannot be read", () => {
    // Holding the refusal changes *when* an unreadable guard speaks, never the
    // order the readable ones are consulted in: a run out of money is out of
    // money whatever the weekly window can report.
    const spent = evaluateBudget(
      { ...base, maxWeeklyFraction: 0.8, maxRunCostUSD: 5 },
      snapshot(null, null),
      { ...noProgress, spentUSD: 6 },
      0,
    );
    assert.equal(spent.allowed === false && spent.code, "run_cost");

    // Same the other way round: a weekly window with a reading past its guard
    // outranks a 5-hour window with none.
    const weekly = evaluateBudget(
      { ...base, maxWeeklyFraction: 0.8, maxSessionFraction: 0.5 },
      snapshot(null, 0.9),
      noProgress,
      0,
    );
    assert.equal(weekly.allowed === false && weekly.code, "weekly_fraction");
  });

  /**
   * …and the run must not be *ended* on it, which is a separate decision from
   * whether the verdict exists.
   *
   * `INSTANCE_ENFORCEABLE_CODES` already argues this out one level up, in as
   * many words, and every clause of that argument is about a run: ceilings ship
   * null by design, the reading behind `fraction` on a stock install is the
   * provider's own percentage, and it is discarded after an hour without a
   * fresh answer. Acted on, an unreachable Anthropic host ends every running
   * fraction-guarded run at its next cycle boundary, blocks every queued one —
   * cascading `blocked` down every chain behind it — and lets the sweeper end
   * every parked one, with recovery being one manual reopen per run.
   *
   * Every other code stays enforceable, and that is the half that would be
   * quietly expensive to get wrong: a whitelist that swallowed `run_cost` or
   * `duration` is a run nothing ends.
   */
  it("keeps every refusal but that one actionable for a run", () => {
    assert.equal(RUN_ENFORCEABLE_CODES.includes("no_ceiling"), false);
    for (const code of [
      "weekly_fraction",
      "session_fraction",
      "run_cost",
      "run_tokens",
      "iterations",
      "duration",
      "instance_cost",
      "no_terminus",
    ] as const) {
      assert.equal(RUN_ENFORCEABLE_CODES.includes(code), true, code);
    }

    // The predicate the two callers read, rather than the list: an allowed
    // verdict is trivially not something to end a run on.
    const unreadable = evaluateBudget(
      { ...base, maxSessionFraction: 0.8 },
      snapshot(null, null),
      noProgress,
      0,
    );
    assert.equal(enforceableForRun(unreadable), false);
    assert.equal(
      enforceableForRun(
        evaluateBudget({ ...base, maxRunCostUSD: 1 }, snapshot(null, null), {
          ...noProgress,
          spentUSD: 2,
        }, 0),
      ),
      true,
    );
    assert.equal(
      enforceableForRun(evaluateBudget(base, snapshot(null, null), noProgress, 0)),
      true,
    );
  });

  /**
   * The door that the change above moves the refusal to.
   *
   * `POST /api/runs` and the reopen route both call this before anything is
   * created, so the operator is told at the moment they ask rather than by a
   * run that flickers queued → blocked. It reads `readWindowGuard`, the same
   * function the guard reads, so the two cannot come to different conclusions
   * about whether a window has a reading at all.
   */
  it("refuses at the door only where a fraction guard has nothing to read", () => {
    // Both causes are named, because there are two and they call for different
    // actions: a ceiling is a thing to go and set, where the provider's own
    // utilisation simply comes back.
    const session = windowGuardRefusal(
      { ...base, maxSessionFraction: 0.8 },
      snapshot(null, null),
    );
    assert.match(session ?? "", /5-hour window has no reading/);
    assert.match(session ?? "", /provider's own utilisation/);
    assert.match(
      windowGuardRefusal({ ...base, maxWeeklyFraction: 0.8 }, snapshot(null, null)) ??
        "",
      /weekly-fraction guard/,
    );

    // The guard and the door say the same sentence, because there is one.
    const verdict = evaluateBudget(
      { ...base, maxSessionFraction: 0.8 },
      snapshot(null, null),
      noProgress,
      0,
    );
    assert.equal(verdict.allowed === false ? verdict.reason : "", session);

    // A guard with a reading passes, however close to its threshold — the door
    // answers "can this guard be read", never "is it satisfied". That is
    // `evaluateBudget`'s question, and asking it here with no progress to
    // evaluate would refuse a run over limits it cannot yet have reached.
    assert.equal(
      windowGuardRefusal({ ...base, maxSessionFraction: 0.8 }, snapshot(0.99, null)),
      null,
    );
    // And a policy with no fraction guard has nothing to say either way.
    assert.equal(windowGuardRefusal(base, snapshot(null, null)), null);
  });

  /**
   * A guard acting on a percentage that may be an hour old must say how old it
   * was. The reading is the provider's, it is cached, and the two sentences
   * "the window is at 90%" and "the window was at 90% fifty-eight minutes ago"
   * are the same string without this — which is the whole of why an operator
   * reading a stop reason could not tell a live decision from a frozen one.
   */
  it("names the age of a stale provider reading in the verdict it decided", () => {
    const now = 4_000_000;
    const stale = evaluateBudget(
      { ...base, maxSessionFraction: 0.8 },
      planSnapshot(0.9, now - 58 * 60_000),
      noProgress,
      now,
    );
    assert.equal(stale.allowed, false);
    assert.equal(stale.allowed === false && stale.code, "session_fraction");
    assert.match(
      stale.allowed === false ? stale.reason : "",
      /58 minutes old/,
      "a verdict reached on an hour-old reading has to disclose its age",
    );

    // Inside the source's own refresh cadence there is nothing to disclose: the
    // reading is as current as that source ever is, and a note on every verdict
    // would stop being read.
    const fresh = evaluateBudget(
      { ...base, maxSessionFraction: 0.8 },
      planSnapshot(0.9, now - 60_000),
      noProgress,
      now,
    );
    assert.equal(fresh.allowed, false);
    assert.doesNotMatch(
      fresh.allowed === false ? fresh.reason : "",
      /old when this was decided/,
    );
  });

  it("reports no age for a reading that was derived here", () => {
    // A derived reading is recomputed on every check, so it has no age to
    // disclose — and null must not be read as "fresh provider reading", which
    // is a different sentence about a different source.
    const snap = snapshot(0.9, null);
    assert.equal(planReadingAgeMs(snap, snap.session, 10_000_000), null);
    assert.equal(planReadingAgeMs(planSnapshot(0.9, 9_000_000), planSnapshot(0.9, 9_000_000).session, 10_000_000), 1_000_000);
  });

  it("guards on reconciled spend, not just what the CLI reported", () => {
    const policy = { ...base, maxRunCostUSD: 5 };
    const reported = { ...noProgress, spentUSD: 3 };

    assert.equal(evaluateBudget(policy, snapshot(null, null), reported, 0).allowed, true);

    // A killed cycle's spend never reaches `spentUSD`, so a guard reading only
    // that figure would let a run overshoot indefinitely in live mode.
    const withEstimate = { ...reported, spentGuardUSD: 6 };
    const v = evaluateBudget(policy, snapshot(null, null), withEstimate, 0);
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "run_cost");
  });

  /*
   * The four run guards at exactly their limit.
   *
   * Every case above tests comfortably over or comfortably under, which leaves
   * each threshold free to move from "at or past" to "strictly past" with the
   * suite still green. Each of these is `>=`, and a cap that only trips one unit
   * past itself is a cap the operator did not set — `maxIterations` defaults to
   * 1, so off by one there is every run in the app quietly doing two cycles
   * while the run page still says 1/1.
   */
  it("stops at the last allowed work cycle, not one past it", () => {
    const v = evaluateBudget(
      { ...base, maxIterations: 2 },
      snapshot(null, null),
      { ...noProgress, iterations: 2 },
      0,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "iterations");

    // One cycle short of the cap still runs, so the guard is on the boundary
    // rather than simply always tripping.
    assert.equal(
      evaluateBudget(
        { ...base, maxIterations: 2 },
        snapshot(null, null),
        { ...noProgress, iterations: 1 },
        0,
      ).allowed,
      true,
    );
  });

  it("stops at the time limit exactly, because the clock is a terminus", () => {
    const policy = { ...base, maxDurationMinutes: 10 };
    const v = evaluateBudget(
      policy,
      snapshot(null, null),
      noProgress,
      STARTED_AT + 10 * 60_000,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "duration");

    assert.equal(
      evaluateBudget(policy, snapshot(null, null), noProgress, STARTED_AT + 9 * 60_000)
        .allowed,
      true,
    );
  });

  it("stops at the run's spending limit exactly, not a cent past it", () => {
    // The figure moves in whole `result`-event jumps, so "one cent past" is in
    // practice a whole work cycle past.
    const policy = { ...base, maxRunCostUSD: 5 };
    const v = evaluateBudget(
      policy,
      snapshot(null, null),
      { ...noProgress, spentUSD: 5 },
      0,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "run_cost");

    assert.equal(
      evaluateBudget(policy, snapshot(null, null), { ...noProgress, spentUSD: 4.99 }, 0)
        .allowed,
      true,
    );
  });

  it("stops at the run's token limit exactly", () => {
    const policy = { ...base, maxRunTokens: 50_000 };
    const v = evaluateBudget(
      policy,
      snapshot(null, null),
      { ...noProgress, spentTokens: 50_000 },
      0,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "run_tokens");

    assert.equal(
      evaluateBudget(
        policy,
        snapshot(null, null),
        { ...noProgress, spentTokens: 49_999 },
        0,
      ).allowed,
      true,
    );
  });

  it("puts every configured limit on the budget card, and nothing else", () => {
    // `BudgetVerdict.meters` is what the run page draws, and each meter is
    // pushed behind its own condition — so nothing otherwise asserts that a
    // limit the operator set appears on the card, or that one they did not stays
    // off it. A whole-array deepEqual also pins the order the card is read in.
    const v = evaluateBudget(
      {
        ...base,
        maxIterations: 5,
        maxRunCostUSD: 10,
        maxRunCostFactor: null,
        maxRunTokens: 1_000,
        maxWeeklyFraction: 0.8,
        maxSessionFraction: 0.9,
        maxDurationMinutes: 60,
      },
      snapshot(0.5, 0.25),
      { ...noProgress, iterations: 2, spentUSD: 3, spentTokens: 400 },
      STARTED_AT + 30 * 60_000,
    );
    assert.equal(v.allowed, true);
    assert.deepEqual(v.meters, [
      { label: "Work cycles used", value: 2, limit: 5, unit: "count" },
      { label: "Spent on this run", value: 3, limit: 10, unit: "usd" },
      { label: "Tokens used by this run", value: 400, limit: 1_000, unit: "tokens" },
      // The window meters report `guardFraction`, the figure compared below
      // them, so the card shows what the guard decided on.
      { label: "Weekly window", value: 0.25, limit: 0.8, unit: "fraction" },
      { label: "5-hour window", value: 0.5, limit: 0.9, unit: "fraction" },
      { label: "Time elapsed", value: 30, limit: 60, unit: "minutes" },
    ]);

    // Nothing configured but the cycle cap: one meter, and no rows carrying a
    // null limit for a guard that is switched off.
    const one = evaluateBudget(
      { ...base, maxIterations: 5 },
      snapshot(null, null),
      noProgress,
      0,
    );
    assert.deepEqual(one.meters, [
      { label: "Work cycles used", value: 0, limit: 5, unit: "count" },
    ]);
  });

  it("omits a window meter when that window has no reading", () => {
    // A guard the operator set against a window nothing can report is refused
    // rather than metered: a meter with no value is a card that says a guard is
    // active and shows nothing to judge it by.
    const v = evaluateBudget(
      { ...base, maxSessionFraction: 0.9, maxWeeklyFraction: 0.8 },
      snapshot(null, null),
      noProgress,
      0,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "no_ceiling");
    assert.deepEqual(
      v.meters.map((m) => m.label),
      ["Work cycles used"],
    );
  });

  it("omits the work-cycle meter when there is no cap", () => {
    const v = evaluateBudget(
      { ...base, maxIterations: null, maxDurationMinutes: 60 },
      snapshot(null, null),
      noProgress,
      0,
    );
    assert.equal(v.allowed, true);
    assert.equal(
      v.meters.some((m) => m.label === "Work cycles used"),
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/* The whole of one press of Run                                       */
/* ------------------------------------------------------------------ */

/**
 * A window whose displayed and guarded readings differ, and one that carries a
 * percentage with no ceiling behind it.
 *
 * The shared `window()` above ties `fraction` and `guardFraction` together,
 * which is right for every case that does not care — but the two questions the
 * instance guard asks are *which field* answers "is there a reading at all" and
 * *which field* answers "is it past the threshold", and neither can be tested
 * with the two locked to each other.
 */
function splitWindow(
  fraction: number | null,
  guardFraction: number | null,
  limit: number | null,
): WindowState {
  return { ...window(fraction), fraction, guardFraction, limit };
}

const instanceBase: InstanceBudgetPolicy = {
  maxInstanceCostUSD: null,
  maxSessionFraction: null,
  maxWeeklyFraction: null,
};

/** Nothing killed, nothing in flight: the two figures agree. */
function settled(spentUSD: number) {
  return { spentUSD, spentGuardUSD: spentUSD };
}

describe("normalizeInstanceBudget", () => {
  it("reads null, blank, zero and negative as off", () => {
    for (const off of [null, undefined, "", 0, -1, "0", "abc"]) {
      const p = normalizeInstanceBudget({
        maxInstanceCostUSD: off,
        maxSessionFraction: off,
        maxWeeklyFraction: off,
      });
      assert.deepEqual(p, instanceBase, `expected ${String(off)} to mean off`);
      assert.equal(instanceBudgetIsOff(p), true);
    }
    // A missing key is not a default limit either. There is no limit to
    // restore: one nobody typed is not one.
    assert.deepEqual(normalizeInstanceBudget({}), instanceBase);
    assert.deepEqual(normalizeInstanceBudget(null), instanceBase);
  });

  it("is idempotent across a JSON round trip", () => {
    // It runs once on the form and again on every read of the stored blob, so a
    // term that is not idempotent turns a workflow that saved cleanly into one
    // that cannot be started.
    const inputs: unknown[] = [
      { maxInstanceCostUSD: 20, maxSessionFraction: 80, maxWeeklyFraction: 60 },
      { maxInstanceCostUSD: "12.5", maxSessionFraction: "0.8" },
      { maxSessionFraction: 200 },
      {},
    ];
    for (const raw of inputs) {
      const once = normalizeInstanceBudget(raw);
      const twice = normalizeInstanceBudget(JSON.parse(JSON.stringify(once)));
      assert.deepEqual(twice, once, JSON.stringify(raw));
    }
  });

  it("takes a percentage or a fraction, and clamps at the whole window", () => {
    assert.equal(normalizeInstanceBudget({ maxSessionFraction: 80 })
      .maxSessionFraction, 0.8);
    assert.equal(normalizeInstanceBudget({ maxSessionFraction: 0.8 })
      .maxSessionFraction, 0.8);
    assert.equal(normalizeInstanceBudget({ maxWeeklyFraction: 250 })
      .maxWeeklyFraction, 1);
  });

  it("round-trips a stored fraction through the workflow editor's percentage field", () => {
    // The same pairing the run form's guards have, and the reason `frac()`
    // above accepts both formats is the reason this has to be pinned: a bare
    // number at or below 1 is read as an already-normalised fraction, so an
    // editor that sent its field raw would store a typed "1" as the *whole*
    // window — the smallest percentage the field offers, loosened by 100×,
    // and a workflow guard that never trips is indistinguishable from one that
    // was never reached. `pctField`/`pctSubmit` are the editor's own two halves
    // and have to be exact inverses across `normalizeInstanceBudget`.
    for (const f of [0.01, 0.05, 0.5, 0.8, 0.855, 0.999, 1]) {
      const raw = { maxSessionFraction: pctSubmit(pctField(f)) };
      const back = normalizeInstanceBudget(raw).maxSessionFraction;
      // Within float noise rather than bit-identical, for the reason the
      // `normalizePolicy` round trip above says: 0.999 comes back as
      // 0.9990000000000001, and the error guarded against here is two orders
      // of magnitude larger than that.
      assert.ok(
        back !== null && Math.abs(back - f) < 1e-9,
        `round trip failed for ${f}: got ${back}`,
      );
      assert.equal(
        normalizeInstanceBudget({ maxWeeklyFraction: pctSubmit(pctField(f)) })
          .maxWeeklyFraction,
        back,
        `the weekly field must convert exactly as the 5-hour one does (${f})`,
      );
    }
    // No guard stays no guard, rather than becoming a guard set to zero
    // percent — which would halt the instance on its first block boundary.
    assert.equal(pctField(null), "");
    assert.equal(pctSubmit(pctField(null)), null);
    assert.equal(
      normalizeInstanceBudget({ maxSessionFraction: null }).maxSessionFraction,
      null,
    );
  });
});

describe("evaluateInstanceBudget — the cap on everything one press of Run spends", () => {
  it("allows an instance under its cap", () => {
    const v = evaluateInstanceBudget(
      { ...instanceBase, maxInstanceCostUSD: 20 },
      snapshot(null, null),
      settled(19.99),
    );
    assert.equal(v.allowed, true);
  });

  it("stops at the cap exactly, not a cent past it", () => {
    // `>=`, the same comparison every other spend guard here makes. A cap of
    // $20 that only trips at $20.01 is a cap the operator did not set.
    const v = evaluateInstanceBudget(
      { ...instanceBase, maxInstanceCostUSD: 20 },
      snapshot(null, null),
      settled(20),
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "instance_cost");
    assert.equal(v.allowed === false && v.disposition, "stop");
  });

  it("counts what a block has in flight, which the measured figure cannot", () => {
    // `runs.spent_usd` moves only when a block's CLI emits `result`, so a cycle
    // in flight contributes nothing to the measured total for its whole
    // duration. Guarding on that would let a workflow run past its cap for as
    // long as its blocks keep working. The in-flight figure reaches the guard
    // through `telemetrySpendSince` and lands here, and only here.
    const inFlight = { spentUSD: 14, spentGuardUSD: 21 };
    const policy = { ...instanceBase, maxInstanceCostUSD: 20 };

    const v = evaluateInstanceBudget(policy, snapshot(null, null), inFlight);
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "instance_cost");
    // The measured figure alone would have allowed it.
    assert.equal(
      evaluateInstanceBudget(policy, snapshot(null, null), settled(14)).allowed,
      true,
    );
  });

  it("counts a killed cycle's estimate, which never reaches spent_usd", () => {
    // A cycle interrupted mid-flight never reports, so its cost lands in
    // `spent_usd_est` and stays out of `spent_usd` for ever. An instance whose
    // blocks were all killed would otherwise read as having spent nothing at
    // all, and the cap would never trip however many times it happened.
    const estimatedOnly = { spentUSD: 0, spentGuardUSD: 25 };
    const v = evaluateInstanceBudget(
      { ...instanceBase, maxInstanceCostUSD: 20 },
      snapshot(null, null),
      estimatedOnly,
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "instance_cost");
    // …and what is *displayed* is untouched by that: the meter reports the
    // guard's figure, but the reason names the guard's, not a floor of zero.
    assert.match(v.allowed === false ? v.reason : "", /\$25\.00/);
  });

  it("refuses a fraction guard with no ceiling rather than ignoring it", () => {
    // The same rule as a run's: silently passing would leave the operator
    // believing a workflow-wide guard is active.
    for (const [policy, window] of [
      [{ ...instanceBase, maxSessionFraction: 0.8 }, "session"],
      [{ ...instanceBase, maxWeeklyFraction: 0.8 }, "weekly"],
    ] as const) {
      const v = evaluateInstanceBudget(policy, snapshot(null, null), settled(0));
      assert.equal(v.allowed, false, window);
      assert.equal(v.allowed === false && v.code, "no_ceiling", window);
    }
  });

  it("still enforces the 5-hour guard when the weekly window cannot be read", () => {
    // The run guard's failure, one level up: `no_ceiling` halts nothing, so
    // returning it where the weekly reading went missing left the 5-hour guard
    // unread for every block of the instance — and the reading that goes
    // missing on a stock install is the provider's own percentage, which is the
    // same outage this code refuses to halt a graph over.
    const policy = {
      ...instanceBase,
      maxWeeklyFraction: 0.8,
      maxSessionFraction: 0.5,
    };
    const over = evaluateInstanceBudget(policy, snapshot(0.97, null), settled(0));
    assert.equal(over.allowed, false);
    assert.equal(over.allowed === false && over.code, "session_fraction");

    // Held rather than dropped: with every readable guard under its threshold,
    // the unreadable one is still the verdict.
    const under = evaluateInstanceBudget(policy, snapshot(0.1, null), settled(0));
    assert.equal(under.allowed, false);
    assert.equal(under.allowed === false && under.code, "no_ceiling");
    assert.match(under.allowed === false ? under.reason : "", /weekly window/);

    // And the order is untouched: spend is settled where a fraction is not, so
    // it still answers first.
    const spent = evaluateInstanceBudget(
      { ...policy, maxInstanceCostUSD: 20 },
      snapshot(0.1, null),
      settled(25),
    );
    assert.equal(spent.allowed === false && spent.code, "instance_cost");
  });

  it("does not let that refusal halt a workflow that is already running", () => {
    // `no_ceiling` is a fact about configuration, and it is checked at the door
    // where refusing costs nothing. Acting on it *afterwards* would mean the
    // reading going away halts a graph mid-flight — and on a stock install that
    // reading is the provider's own percentage, which is discarded after an
    // hour without a fresh answer. An unreachable host would kill every
    // workflow carrying a fraction guard, and every in-flight cycle with it.
    // Not silent, though: the run whose check found it logs that the guard had
    // nothing to read.
    assert.equal(INSTANCE_ENFORCEABLE_CODES.includes("no_ceiling"), false);
    for (const code of ["instance_cost", "weekly_fraction", "session_fraction"] as const) {
      assert.equal(INSTANCE_ENFORCEABLE_CODES.includes(code), true, code);
    }
  });

  it("accepts the provider's own percentage as the ceiling", () => {
    // The reading that reaches `fraction` is not only a configured ceiling:
    // `windows.ts` prefers the account's own utilisation from `planUsage.ts`,
    // which names a percentage and no number behind it, so `limit` is null
    // while `fraction` is real. Refusing that as "no ceiling" would disable a
    // guard on every install that reads its percentage from Anthropic — which
    // is the default.
    const snap = {
      ...snapshot(null, null),
      session: splitWindow(0.42, 0.42, null),
    } as UsageSnapshot;

    const under = evaluateInstanceBudget(
      { ...instanceBase, maxSessionFraction: 0.8 },
      snap,
      settled(0),
    );
    assert.equal(under.allowed, true);

    const over = evaluateInstanceBudget(
      { ...instanceBase, maxSessionFraction: 0.4 },
      snap,
      settled(0),
    );
    assert.equal(over.allowed, false);
    assert.equal(over.allowed === false && over.code, "session_fraction");
  });

  it("compares against the guard reading, not the displayed one", () => {
    // A window made of a model with no known price shows $0 spent, so its
    // displayed fraction is exactly 0 and no threshold could ever be crossed.
    // The guard charges the fallback rate, and that is the figure compared —
    // otherwise the guard quietly stops existing the week a new model ships.
    const snap = {
      ...snapshot(null, null),
      weekly: splitWindow(0, 0.91, 100),
    } as UsageSnapshot;
    const v = evaluateInstanceBudget(
      { ...instanceBase, maxWeeklyFraction: 0.8 },
      snap,
      settled(0),
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "weekly_fraction");
    assert.match(v.allowed === false ? v.reason : "", /91\.0%/);
  });

  it("allows again once a window falls back under the guard", () => {
    // A window fraction is not monotone: usage ages out of the 5-hour block and
    // the weekly total decays. So a verdict is about *now* and nothing latches
    // — which is the whole reason an instance needs no terminus of its own, and
    // the reason the spend check is ordered ahead of these two.
    const policy = { ...instanceBase, maxSessionFraction: 0.8 };
    const tripped = evaluateInstanceBudget(policy, snapshot(0.85, null), settled(0));
    assert.equal(tripped.allowed, false);

    const recovered = evaluateInstanceBudget(policy, snapshot(0.5, null), settled(0));
    assert.equal(recovered.allowed, true);
  });

  it("reports spend before a window, because only spend is settled", () => {
    // Both trip. The cost verdict is the one that is still true on the next
    // reading, so it is the one recorded against the instance.
    const v = evaluateInstanceBudget(
      { ...instanceBase, maxInstanceCostUSD: 20, maxSessionFraction: 0.8 },
      snapshot(0.9, null),
      settled(30),
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "instance_cost");
  });

  it("never parks: an instance holds no folder and no session to resume", () => {
    // `live-resume` parks a *run*, which yields its folder and keeps its
    // checkout so the same conversation resumes. An instance has neither, so
    // over-budget is a stop and starting again is a press of Run.
    const v = evaluateInstanceBudget(
      { ...instanceBase, maxSessionFraction: 0.8 },
      snapshot(0.9, null),
      settled(0),
    );
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.disposition, "stop");
  });

  it("meters only the limits that are set", () => {
    const off = evaluateInstanceBudget(instanceBase, snapshot(0.5, 0.5), settled(9));
    assert.deepEqual(off.meters, []);

    const on = evaluateInstanceBudget(
      { ...instanceBase, maxInstanceCostUSD: 20 },
      snapshot(0.5, 0.5),
      { spentUSD: 5, spentGuardUSD: 9 },
    );
    const meter = on.meters.find((m) => m.label === "Spent by this workflow run");
    // The guard's figure, so the card shows what the decision was made on.
    assert.deepEqual(meter, {
      label: "Spent by this workflow run",
      value: 9,
      limit: 20,
      unit: "usd",
    });
  });

  it("puts every configured instance limit on the card, in order", () => {
    // The same assertion the run card gets, for the same reason: each meter is
    // pushed behind its own condition, and the instance page draws the result.
    const all = evaluateInstanceBudget(
      { maxInstanceCostUSD: 20, maxSessionFraction: 0.9, maxWeeklyFraction: 0.8 },
      snapshot(0.5, 0.25),
      settled(9),
    );
    assert.equal(all.allowed, true);
    assert.deepEqual(all.meters, [
      { label: "Spent by this workflow run", value: 9, limit: 20, unit: "usd" },
      { label: "Weekly window", value: 0.25, limit: 0.8, unit: "fraction" },
      { label: "5-hour window", value: 0.5, limit: 0.9, unit: "fraction" },
    ]);

    // A fraction guard with no reading behind it is refused, not metered — so
    // the card never carries a window row with nothing in it.
    const noReading = evaluateInstanceBudget(
      { ...instanceBase, maxSessionFraction: 0.9, maxWeeklyFraction: 0.8 },
      snapshot(null, null),
      settled(0),
    );
    assert.equal(noReading.allowed, false);
    assert.deepEqual(noReading.meters, []);
  });
});

/**
 * The ceiling on the *installation*, which is the one thing here that bounds
 * more than one spender.
 *
 * `maxRunCostUSD` bounds a run, `maxInstanceCostUSD` one press of Run,
 * `chatTurnBudgetUSD` one chat turn — and nothing bounded the total or the rate
 * at which new spenders appear, so twenty-five concurrent runs under a $35 run
 * limit reads as $875 and is $875 *per wave*, with waves unbounded. Pure and
 * tested here for `evaluateInstanceBudget`'s reason: the decision is arithmetic
 * whose failure modes are silent, and what reads the database is the caller.
 */
describe("evaluateInstallBudget — the cap on everything this install spends", () => {
  const spend = (spentUSD: number, spentGuardUSD = spentUSD) => ({
    spentUSD,
    spentGuardUSD,
  });

  it("allows an install under its ceiling", () => {
    const v = evaluateInstallBudget({ maxInstallCostUSD: 100 }, spend(99.99));
    assert.equal(v.allowed, true);
    assert.deepEqual(v.meters, [
      { label: "Spent by this install", value: 99.99, limit: 100, unit: "usd" },
    ]);
  });

  it("stops at the ceiling exactly, not a cent past it", () => {
    // `>=`, the same comparison every other spend guard here makes. A $100 cap
    // that only trips at $100.01 is a cap the operator did not set.
    const v = evaluateInstallBudget({ maxInstallCostUSD: 100 }, spend(100));
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "install_cost");
    assert.equal(v.allowed === false && v.disposition, "stop");
    // The reason names the install limit rather than any per-run one, because
    // an operator meeting it will otherwise go looking at the wrong field.
    assert.match(v.allowed === false ? v.reason : "", /\$100\.00 limit set in Settings/);
    assert.match(v.allowed === false ? v.reason : "", /24 hours/);
  });

  it("compares the guard's figure, not the measured floor", () => {
    // A cycle in flight has reported nothing, and a killed one never will, so
    // an install guarding on `spent_usd` alone would read far under its own
    // total for as long as agents keep working — which is exactly when it
    // matters. Same display-versus-guard split as everywhere else.
    const v = evaluateInstallBudget({ maxInstallCostUSD: 100 }, spend(40, 120));
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.code, "install_cost");
    assert.match(v.allowed === false ? v.reason : "", /\$120\.00/);
    assert.equal(
      evaluateInstallBudget({ maxInstallCostUSD: 100 }, spend(40)).allowed,
      true,
    );
  });

  it("is off with no ceiling, however much has been spent", () => {
    const off = { maxInstallCostUSD: null };
    assert.equal(installBudgetIsOff(off), true);
    const v = evaluateInstallBudget(off, spend(10_000));
    assert.equal(v.allowed, true);
    // No ceiling, no meter: a bar with no denominator is the "unknown renders
    // as zero" mistake, and the page draws the indeterminate one instead.
    assert.deepEqual(v.meters, []);
  });

  it("reads null, blank, zero and a negative all as off", () => {
    // `normalizeInstanceBudget`'s rule, for its reason: there is no default
    // limit to restore, because a limit nobody typed is not a limit. Total and
    // idempotent, because it runs over a settings value read back on every
    // door check.
    for (const raw of [null, undefined, "", 0, "0", -5, "nonsense", {}]) {
      const policy = normalizeInstallBudget({ maxInstallCostUSD: raw });
      assert.equal(policy.maxInstallCostUSD, null, String(raw));
      assert.equal(installBudgetIsOff(policy), true, String(raw));
    }
    assert.deepEqual(normalizeInstallBudget(null), { maxInstallCostUSD: null });

    // …and a real figure survives, through a string as the wire sends it.
    assert.deepEqual(normalizeInstallBudget({ maxInstallCostUSD: "250" }), {
      maxInstallCostUSD: 250,
    });
    assert.deepEqual(
      normalizeInstallBudget(normalizeInstallBudget({ maxInstallCostUSD: 250 })),
      { maxInstallCostUSD: 250 },
    );
  });

  it("is a code a run may actually be stopped on", () => {
    // Unlike `no_ceiling`, this is a fact about money that has been spent, so
    // the pre-cycle guard acts on it rather than logging past it.
    assert.equal(RUN_ENFORCEABLE_CODES.includes("install_cost"), true);
  });
});
