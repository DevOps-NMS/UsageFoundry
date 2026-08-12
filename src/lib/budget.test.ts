import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BudgetPolicy,
  type InstanceBudgetPolicy,
  evaluateBudget,
  evaluateInstanceBudget,
  instanceBudgetIsOff,
  normalizeInstanceBudget,
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
});
