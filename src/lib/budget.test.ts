import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BudgetPolicy,
  evaluateBudget,
  normalizePolicy,
} from "./budget";
import { pctField } from "./format";
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

const base: BudgetPolicy = {
  maxWeeklyFraction: null,
  maxSessionFraction: null,
  maxRunCostUSD: null,
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
