import type { UsageSnapshot, WindowState } from "./windows";

/**
 * Budget policy: the rules that decide whether a run may keep working.
 *
 * How a tripped rule is acted on is the operator's choice, expressed as
 * `enforcement`:
 *
 * - `between-cycles` reads the rules only before each iteration. A Claude Code
 *   turn cannot be interrupted without losing its work, so the guarantee is "no
 *   new work starts past the threshold", not "spend never exceeds the
 *   threshold". Overshoot is bounded by one iteration.
 *
 *   `maxRunCostUSD` is the one exception, and it is enforced somewhere else
 *   entirely: `buildArgs` hands each cycle what is left of the limit as
 *   `--max-budget-usd`, so the CLI stops the cycle that *crosses* the threshold
 *   rather than only the one after it. Read this whole list as a statement
 *   about the count of cycles — it is money for every rule but that one, where
 *   a cycle of arbitrary size is exactly what the flag exists to prevent.
 * - `live` also reads them on a timer while an iteration is in flight and kills
 *   the agent when one trips. That trades the in-flight cycle's work — and its
 *   self-reported cost — for a tighter bound: one model turn plus one check
 *   interval plus the kill, rather than a whole cycle. It is still not a hard
 *   cap, and the staleness that makes it one is worth stating in full rather
 *   than as "transcripts are flushed as each turn completes", which describes
 *   the *fallback* source. The window fractions prefer the provider's own
 *   percentage (`planUsage.ts`), which is cached: five minutes in the ordinary
 *   case, and up to an hour while requests are being refused. What keeps that
 *   from being the guard's real resolution is that `guardFraction` also takes
 *   the derived reading, recomputed from the transcripts on every check, and
 *   uses whichever is worse — so locally observed spend inside a refresh
 *   interval still moves the number a run is stopped on, wherever a ceiling is
 *   configured for it to be measured against. A verdict reached on a reading
 *   older than `STALE_PLAN_READING_MS` says so in as many words.
 * - `live-resume` is `live`, except that the one rule which comes back on its
 *   own — the 5-hour window — parks the run instead of ending it.
 *
 * This module stays pure and synchronous. *When* a verdict is evaluated and
 * *what is done* with a blocked one both live in the orchestrator; deciding
 * either here would mean teaching the budget rules about processes and timers.
 */

export const ENFORCEMENT_MODES = [
  /** Guards are read before each work cycle, only. */
  "between-cycles",
  /** Also read on a timer during a cycle; a trip kills the agent mid-flight. */
  "live",
  /** As "live", but a 5-hour-window trip parks the run instead of ending it. */
  "live-resume",
] as const;

export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

export interface BudgetPolicy {
  /** Stop when the weekly window reaches this fraction of its ceiling (0–1). */
  maxWeeklyFraction: number | null;
  /**
   * Threshold on the 5-hour window (0–1).
   *
   * Under `live-resume` this is where the run *steps aside* rather than where
   * it stops — the number means the same thing either way ("this run must not
   * push the 5-hour window past here"); only the response differs, and
   * `enforcement` is what selects the response.
   */
  maxSessionFraction: number | null;
  /**
   * Stop when this run alone has spent this many USD. null = no limit.
   *
   * Read in two places, and it is the second one that makes it a limit on
   * money rather than on cycles: the comparison below refuses the *next*
   * cycle, and `buildArgs` gives the cycle about to spawn what is left of this
   * figure as `--max-budget-usd`. Without the second, a run one cent under its
   * limit was authorised for a cycle of any size at all.
   */
  maxRunCostUSD: number | null;
  /**
   * Stop when this run costs more than this multiple of its own task's median.
   *
   * Null or <= 1 is off. Relative where `maxRunCostUSD` is absolute: a ceiling
   * has to be set high enough for the worst legitimate run, which leaves it
   * blind to a run that is merely three times its own normal - and MEASURED on
   * this loop, the same task varies 2.28x run to run, so the tail is where the
   * money is rather than the mean.
   */
  maxRunCostFactor: number | null;
  /**
   * Stop when this run alone has consumed this many tokens. null = no limit.
   *
   * No in-cycle equivalent: the CLI's own ceiling is denominated in dollars,
   * so this one really is bounded by a whole cycle under `between-cycles`.
   */
  maxRunTokens: number | null;
  /**
   * Cap on iterations ("work cycles" in the UI). `null` means no cap.
   *
   * The loop must always have a *monotone terminus* — a quantity that only ever
   * moves one way — or nothing would end it. `maxIterations` and
   * `maxDurationMinutes` are the only two that qualify: this run's own spend
   * stops accruing the moment a cycle is killed before it reports, and both
   * window fractions can fall as usage ages out. So `null` here is legal only
   * alongside a `maxDurationMinutes`.
   *
   * That rule is enforced in `POST /api/runs`, which can tell the user, and
   * refused again here as `no_terminus`. It is deliberately *not* enforced in
   * `normalizePolicy`, which has no error channel and must stay total.
   */
  maxIterations: number | null;
  /**
   * Wall-clock cap for the whole run, measured from when it first started and
   * **including any time spent parked**. That is what makes it the terminus of
   * a resuming run. null = run for as long as it takes.
   */
  maxDurationMinutes: number | null;
  /** When a tripped guard is acted on. */
  enforcement: EnforcementMode;
  /**
   * Ignore the agent's DONE and send it back to the same task, so the run ends
   * on a limit rather than on the agent's own judgement. The wording it is sent
   * back with is `settings.donePushbackPrompt`.
   */
  continueAfterDone: boolean;
}

export interface RunProgress {
  iterations: number;
  spentUSD: number;
  spentTokens: number;
  /**
   * Spend the guard acts on: `spentUSD` plus spend reconciled from cycles that
   * were killed before Claude Code reported theirs. Equal to `spentUSD` in the
   * ordinary case, and never displayed as the run's cost — the same split
   * `costUSD`/`costGuardUSD` already makes for windows, and for the same
   * reason: what is shown stays a floor of measured fact, what is guarded on
   * includes what could have been spent.
   */
  spentGuardUSD?: number;
  spentGuardTokens?: number;
  /**
   * What this run's own task has cost before, or null when too little is known.
   *
   * Passed in rather than read here, so `evaluateBudget` stays a pure function
   * of numbers - the query that builds it belongs to the caller, and a guard
   * that reached into the database would be untestable in exactly the place it
   * most needs to be tested.
   */
  costBaseline?: { medianUSD: number; samples: number } | null;
  startedAt: number | null;
}

export type BudgetMeter = {
  label: string;
  value: number;
  limit: number;
  unit: "fraction" | "usd" | "tokens" | "count" | "minutes";
};

import { outlierVerdict } from "./costBaseline";

export type BudgetStopCode =
  | "weekly_fraction"
  | "session_fraction"
  | "run_cost"
  /**
   * Not a ceiling: this run has left its own task's cost distribution. Its own
   * code because "you set a limit and reached it" and "this is three times what
   * this task normally costs" are different things to have happened, and an
   * operator triaging a stopped run wants to know which.
   */
  | "run_cost_outlier"
  | "run_tokens"
  | "iterations"
  | "duration"
  /** Everything one press of Run on a workflow has spent, across its blocks. */
  | "instance_cost"
  /** Everything this installation has spent, across every run, block and chat. */
  | "install_cost"
  | "no_ceiling"
  | "no_terminus";

/**
 * A union rather than one object with optional fields, so that `resumeAt` is
 * unreachable without first narrowing to the paused case. The alternative — an
 * optional `disposition` — lets a caller read a pause as a stop and still
 * compile, which is the one mistake this type exists to prevent.
 */
export type BudgetVerdict =
  | { allowed: true; meters: BudgetMeter[] }
  | {
      allowed: false;
      code: BudgetStopCode;
      reason: string;
      disposition: "stop";
      meters: BudgetMeter[];
    }
  | {
      allowed: false;
      /**
       * Only one cause can be waited out, and this is it: the 5-hour window is
       * the sole quantity here that refills on its own, on a schedule, with no
       * configuration. The weekly window does not qualify — in its default
       * rolling mode it has no reset instant at all, only a total that decays
       * over days.
       */
      code: "session_fraction";
      reason: string;
      disposition: "pause";
      /** Epoch ms at which the run should try again. */
      resumeAt: number;
      meters: BudgetMeter[];
    };

/**
 * Codes a mid-cycle check may act on.
 *
 * `iterations` is excluded because the loop increments before it spawns, so a
 * live check would read the run as over its cap and kill the very cycle the
 * guard just authorised. `no_ceiling` and `no_terminus` are excluded because
 * they describe configuration that was checked before the cycle started —
 * re-reading them mid-flight means a Settings edit in another browser tab kills
 * a running agent.
 */
export const LIVE_ENFORCEABLE_CODES: readonly BudgetStopCode[] = [
  "duration",
  "run_cost",
  "run_tokens",
  "weekly_fraction",
  "session_fraction",
];

/**
 * Codes a run may actually be *ended* on, once it exists.
 *
 * `INSTANCE_ENFORCEABLE_CODES`' reasoning, one level down, and the argument is
 * the same one word for word — which is why this list exists rather than a
 * second policy: `no_ceiling` is checked **at the door**, where there is a
 * person and an error channel (`POST /api/runs`, and the reopen route), and is
 * deliberately not acted on afterwards. `fraction` going null under a run in
 * flight is not the operator having failed to set a ceiling. On a stock install
 * ceilings ship null by design and that reading comes from the provider, which
 * is discarded after an hour without a fresh answer — so an unreachable
 * Anthropic host would otherwise end every fraction-guarded run at its next
 * cycle boundary, block every queued one (cascading `blocked` down every chain
 * behind it) and let the sweeper end every parked one. Turning a provider
 * outage into a stopped fleet is a worse failure than the one the refusal
 * exists to prevent, and recovery is one manual reopen per run.
 *
 * It is not silently ignored either. The run whose check found it logs that the
 * guard has nothing to read — once per segment, the same answer this app
 * already gives for a live spending limit whose telemetry never arrived and for
 * an instance limit that could not be read — and carries on under its remaining
 * guards, which are per-run and still bind.
 *
 * `no_terminus` stays on this list and is not a second configuration code to
 * treat the same way: it says nothing would ever end the run, so ignoring it
 * would leave an agent nothing stops. It is also refused at the same door.
 */
export const RUN_ENFORCEABLE_CODES: readonly BudgetStopCode[] = [
  "duration",
  "run_cost",
  "run_tokens",
  "weekly_fraction",
  "session_fraction",
  "iterations",
  "instance_cost",
  "install_cost",
  "no_terminus",
];

/** Whether a refusal is one a run in flight may be ended on. */
export function enforceableForRun(verdict: BudgetVerdict): boolean {
  return verdict.allowed || RUN_ENFORCEABLE_CODES.includes(verdict.code);
}

/**
 * Slack past the window boundary before a parked run tries again.
 *
 * The boundary comes from transcripts, which are flushed as turns complete, so
 * waking exactly at `endsAt` risks reading the closing window one last time and
 * parking again in a tight loop.
 */
export const RESUME_MARGIN_MS = 60_000;

/**
 * How old the provider's own percentage may be before a verdict reached on it
 * says how old it was.
 *
 * The same 5 minutes as `planUsage.REFRESH_MS`, written out here rather than
 * imported: that module reads the filesystem and this one is pure and
 * synchronous, and one number restated with the reason beside it is cheaper
 * than an import that drags `node:fs` into every caller of this file. Past
 * this the reading has aged beyond the point where the source itself would
 * still call it current, which is exactly when the difference between "the
 * window is at 61%" and "the window was at 61% fifty-eight minutes ago" starts
 * to matter — a distinction neither the guard nor the run log could make.
 *
 * It is a *disclosure* threshold and deliberately not a refusal one. Discarding
 * a stale reading would leave the guard with nothing to read, and a percentage
 * that is behind reality is still a floor under it; what is unsafe is acting on
 * one while believing it is fresh.
 */
export const STALE_PLAN_READING_MS = 300_000;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * How old the provider reading behind a window's fraction is, or null.
 *
 * Null covers both "this window's fraction is derived, so there is no cached
 * reading behind it" and "the provider never answered" — in neither case is
 * there an age to disclose. `fractionMetric` is what says which of the two
 * sources the number came from, so it is what this reads.
 */
export function planReadingAgeMs(
  snapshot: UsageSnapshot,
  window: WindowState,
  now: number,
): number | null {
  const plan = snapshot.plan ?? null;
  if (plan === null || window.fractionMetric !== "plan") return null;
  return Math.max(0, now - plan.fetchedAt);
}

/** What a verdict adds when the reading it was reached on had aged. */
function stalenessNote(ageMs: number | null): string {
  if (ageMs === null || ageMs < STALE_PLAN_READING_MS) return "";
  const minutes = Math.round(ageMs / 60_000);
  return ` The provider's own reading was ${minutes} ${
    minutes === 1 ? "minute" : "minutes"
  } old when this was decided.`;
}

/**
 * Where one window stands against one fraction threshold.
 *
 * The **only** implementation of that comparison in this app, because it reads
 * two different fields for two different questions and getting either the wrong
 * way round is silent:
 *
 * - "is there a ceiling at all" reads `fraction`. That is the reading the meter
 *   shows, and — this is the part that is easy to assume wrongly — it is *not*
 *   only the configured ceiling. `windows.ts` prefers the provider's own
 *   utilisation from `planUsage.ts` when it answered, so a window can have a
 *   perfectly good `fraction` with nothing typed into Settings, and refusing
 *   that as "no ceiling" would disable a guard the provider is happy to feed.
 *   `guardFraction` is null exactly when `fraction` is (`buildWindow` derives
 *   both from the same ceiling, and `makeWindow` sets both from the plan
 *   reading), so either would answer this — `fraction` is what the refusal
 *   below says out loud, and a missing ceiling is a configuration fact rather
 *   than a pricing one.
 * - "is it past the threshold" reads `guardFraction`. A model with no known
 *   price contributes $0 to the displayed cost, so a window made entirely of
 *   one has `fraction === 0` and no threshold could ever be crossed — the guard
 *   would quietly stop existing the week a new model ships.
 *
 * `at` is the guard's reading, so a caller that prints it prints the number the
 * decision was made on.
 */
export type WindowGuardReading =
  | { state: "no-ceiling" }
  | { state: "over"; at: number }
  | { state: "under"; at: number };

export function readWindowGuard(
  window: WindowState,
  threshold: number,
): WindowGuardReading {
  if (window.fraction === null) return { state: "no-ceiling" };
  const at = window.guardFraction ?? 0;
  return at >= threshold ? { state: "over", at } : { state: "under", at };
}

/**
 * What a fraction guard with nothing to read is told, in one place.
 *
 * Two readers — the door, which refuses, and the pre-cycle guard, which now
 * only logs — so the wording lives here rather than at either. It names both
 * causes because there are two and they need different actions: the provider's
 * own utilisation is what a stock install measures against, and it can simply
 * be unavailable for a while, where a typed ceiling is a thing to go and set.
 */
const NO_READING_REASON: Record<"weekly" | "session", string> = {
  weekly:
    "A weekly-fraction guard is set but that window has no reading to " +
    "measure against: the provider's own utilisation was not available and " +
    "no weekly ceiling is configured. Set one in Settings (or run Calibrate), " +
    "or wait for the provider's reading to come back.",
  session:
    "A session-fraction guard is set but the 5-hour window has no reading to " +
    "measure against: the provider's own utilisation was not available and " +
    "no 5-hour ceiling is configured. Set one in Settings (or run Calibrate), " +
    "or wait for the provider's reading to come back.",
};

/**
 * The refusal a fraction guard with nothing to read earns **at a door**.
 *
 * `RUN_ENFORCEABLE_CODES` moves this condition out of the pre-cycle guard, so
 * something has to say it where there is still a person: `POST /api/runs` and
 * the reopen route both call this before anything is created. Separate from
 * `evaluateBudget` rather than a mode of it, because the door has no progress
 * to evaluate — no cycles used, no clock running, no spend — and putting a
 * zeroed `RunProgress` through the full guard would answer about limits that
 * cannot have been reached yet. It reads exactly what the guard reads,
 * `readWindowGuard`, so the two cannot disagree about whether a window has a
 * reading.
 */
export function windowGuardRefusal(
  policy: BudgetPolicy,
  snapshot: UsageSnapshot,
): string | null {
  if (
    policy.maxWeeklyFraction !== null &&
    readWindowGuard(snapshot.weekly, policy.maxWeeklyFraction).state ===
      "no-ceiling"
  ) {
    return NO_READING_REASON.weekly;
  }
  if (
    policy.maxSessionFraction !== null &&
    readWindowGuard(snapshot.session, policy.maxSessionFraction).state ===
      "no-ceiling"
  ) {
    return NO_READING_REASON.session;
  }
  return null;
}

export function evaluateBudget(
  policy: BudgetPolicy,
  snapshot: UsageSnapshot,
  progress: RunProgress,
  now = Date.now(),
): BudgetVerdict {
  const meters: BudgetMeter[] = [];

  const elapsedMinutes = progress.startedAt
    ? (now - progress.startedAt) / 60_000
    : 0;

  // Both read the guard figure rather than the reported one, for the same
  // reason the window meters below do: what the run page shows should be what
  // the guard decided on.
  const spentUSD = progress.spentGuardUSD ?? progress.spentUSD;
  const spentTokens = progress.spentGuardTokens ?? progress.spentTokens;

  if (policy.maxIterations !== null) {
    meters.push({
      label: "Work cycles used",
      value: progress.iterations,
      limit: policy.maxIterations,
      unit: "count",
    });
  }
  if (policy.maxRunCostUSD !== null) {
    meters.push({
      label: "Spent on this run",
      value: spentUSD,
      limit: policy.maxRunCostUSD,
      unit: "usd",
    });
  }
  if (policy.maxRunTokens !== null) {
    meters.push({
      label: "Tokens used by this run",
      value: spentTokens,
      limit: policy.maxRunTokens,
      unit: "tokens",
    });
  }
  // These meters report `guardFraction`, the figure actually compared below,
  // so what the run page shows is what the guard decided on. It matches the
  // dashboard's meter unless the window contains a model with no known price.
  if (policy.maxWeeklyFraction !== null && snapshot.weekly.guardFraction !== null) {
    meters.push({
      label: "Weekly window",
      value: snapshot.weekly.guardFraction,
      limit: policy.maxWeeklyFraction,
      unit: "fraction",
    });
  }
  if (
    policy.maxSessionFraction !== null &&
    snapshot.session.guardFraction !== null
  ) {
    meters.push({
      label: "5-hour window",
      value: snapshot.session.guardFraction,
      limit: policy.maxSessionFraction,
      unit: "fraction",
    });
  }
  if (policy.maxDurationMinutes !== null) {
    meters.push({
      label: "Time elapsed",
      value: elapsedMinutes,
      limit: policy.maxDurationMinutes,
      unit: "minutes",
    });
  }

  const block = (code: BudgetStopCode, reason: string): BudgetVerdict => ({
    allowed: false,
    code,
    reason,
    disposition: "stop",
    meters,
  });

  const park = (reason: string, resumeAt: number): BudgetVerdict => ({
    allowed: false,
    code: "session_fraction",
    reason,
    disposition: "pause",
    resumeAt,
    meters,
  });

  // Same reasoning as the "no ceiling" refusal below: a rule that cannot bind
  // is refused, not ignored. POST /api/runs rejects this combination outright,
  // so reaching it here means the policy came from somewhere other than this
  // app's form — refuse rather than spawn an agent nothing would ever stop.
  if (policy.maxIterations === null && policy.maxDurationMinutes === null) {
    return block(
      "no_terminus",
      "This run has no work-cycle limit and no time limit, so nothing would " +
        "ever end it.",
    );
  }

  if (
    policy.maxIterations !== null &&
    progress.iterations >= policy.maxIterations
  ) {
    return block(
      "iterations",
      `Used all ${policy.maxIterations} work ${
        policy.maxIterations === 1 ? "cycle" : "cycles"
      } allowed for this run.`,
    );
  }

  if (
    policy.maxDurationMinutes !== null &&
    elapsedMinutes >= policy.maxDurationMinutes
  ) {
    return block(
      "duration",
      `Reached the ${policy.maxDurationMinutes}-minute time limit for this run.`,
    );
  }

  if (policy.maxRunCostUSD !== null && spentUSD >= policy.maxRunCostUSD) {
    return block(
      "run_cost",
      `This run has spent $${spentUSD.toFixed(2)}, reaching its $${policy.maxRunCostUSD.toFixed(2)} spending limit.`,
    );
  }

  // AFTER the absolute ceiling and before the token one. A run that has hit
  // both should be reported as having hit the limit it was given, because that
  // is the one the operator set on purpose; the outlier code is for the run
  // nobody set anything for.
  const outlier = outlierVerdict({
    spentUSD,
    baseline: progress.costBaseline ?? null,
    factor: policy.maxRunCostFactor ?? null,
  });
  if (outlier.over) {
    return block("run_cost_outlier", outlier.reason);
  }

  if (policy.maxRunTokens !== null && spentTokens >= policy.maxRunTokens) {
    return block(
      "run_tokens",
      `This run has used ${spentTokens.toLocaleString()} tokens, reaching its token limit.`,
    );
  }

  // A fraction-of-limit rule is only meaningful when there is a reading to
  // measure against, and the verdict says so rather than passing silently: a
  // run proceeding under a guard the user believes is active is the failure
  // this refusal exists to prevent. What is done with it is the caller's, and
  // it is deliberately not "end the run" — see `RUN_ENFORCEABLE_CODES`, which
  // moves this one code to the door and leaves a log line here.
  // Which field answers which question is `readWindowGuard`'s business.
  //
  // It is *held* rather than returned where it is found, because returning it
  // there disables every guard below it. `no_ceiling` is the one refusal
  // nothing acts on, so an install whose weekly window has no reading — the
  // ordinary state of a stock install while the provider is unreachable — would
  // otherwise never reach the session check at all: a `live-resume` run at 97%
  // of a 50% 5-hour guard logs a line about the *weekly* guard and spawns the
  // cycle anyway, and the runs a workflow member or a chat approval creates
  // never pass `windowGuardRefusal`, so nothing catches it at the door either.
  // A guard that can be read still wins, in the documented order, and the held
  // refusal is returned only once every readable one has passed.
  let unreadable: BudgetVerdict | null = null;

  if (policy.maxWeeklyFraction !== null) {
    const weekly = readWindowGuard(snapshot.weekly, policy.maxWeeklyFraction);
    if (weekly.state === "no-ceiling") {
      // `??=` throughout, so the window checked first names the refusal — the
      // same precedence `windowGuardRefusal` gives it at the door.
      unreadable ??= block("no_ceiling", NO_READING_REASON.weekly);
    }
    if (weekly.state === "over") {
      return block(
        "weekly_fraction",
        `Weekly window is at ${pct(weekly.at)}, at or past the ${pct(policy.maxWeeklyFraction)} guard.` +
          stalenessNote(planReadingAgeMs(snapshot, snapshot.weekly, now)),
      );
    }
  }

  if (policy.maxSessionFraction !== null) {
    const session = readWindowGuard(snapshot.session, policy.maxSessionFraction);
    if (session.state === "no-ceiling") {
      unreadable ??= block("no_ceiling", NO_READING_REASON.session);
    }
    if (session.state === "over") {
      const at = pct(session.at);
      const guard = pct(policy.maxSessionFraction);
      const aged = stalenessNote(planReadingAgeMs(snapshot, snapshot.session, now));
      // A full 5-hour window is the one tripped guard that comes back on its
      // own, so it is the one a run can wait out. Every check above measures
      // something that only moves one way — cycles used, wall clock, this run's
      // own spend, the weekly window — and they are ordered ahead of it
      // deliberately: a run that is out of time *and* out of window must end,
      // not park, or the clock stops being a terminus. Keep that order.
      if (policy.enforcement === "live-resume") {
        return park(
          `5-hour window is at ${at}, at or past the ${guard} guard. ` +
            "Waiting for the next 5-hour window." +
            aged,
          snapshot.session.endsAt + RESUME_MARGIN_MS,
        );
      }
      return block(
        "session_fraction",
        `5-hour window is at ${at}, at or past the ${guard} guard.` + aged,
      );
    }
  }

  // Last, and only here: a park is a decision about a guard that *was* read, so
  // it must have had its chance above before a guard that could not be read
  // gets to speak.
  if (unreadable !== null) return unreadable;

  return { allowed: true, meters };
}

export function normalizePolicy(raw: unknown): BudgetPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number | null): number | null => {
    if (v === null || v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const frac = (v: unknown): number | null => {
    const n = num(v, null);
    if (n === null) return null;
    // Accept either 0–1 or a percentage typed as 0–100.
    return n > 1 ? Math.min(n / 100, 1) : n;
  };

  // The one rule that may not be switched off by accident, so the only way to
  // ask for an uncapped loop is an explicit `null`. A blank field, a zero, a
  // negative and a missing key all still mean one cycle — the same coercion
  // this has always done. Whether that null is *legal* is decided in
  // POST /api/runs, which can tell the user; this function has no error channel
  // and must stay total, because it runs a second time over an already-stored
  // policy in startRun and a run that was legal when it was created must not
  // become fatal at restart.
  const maxIterations: number | null = !("maxIterations" in o)
    ? 1
    : o.maxIterations === null
      ? null
      : Math.max(1, Math.floor(num(o.maxIterations, 1) ?? 1));

  // Degrades rather than throws, for the same reason. POST /api/runs rejects an
  // unrecognised mode outright, so this branch is only ever reached by a blob
  // written by an older or newer build — and "behave like it always did" is the
  // safe reading of a mode this build does not understand.
  const enforcement: EnforcementMode = (
    ENFORCEMENT_MODES as readonly string[]
  ).includes(String(o.enforcement))
    ? (o.enforcement as EnforcementMode)
    : "between-cycles";

  return {
    maxWeeklyFraction: frac(o.maxWeeklyFraction),
    maxSessionFraction: frac(o.maxSessionFraction),
    maxRunCostUSD: num(o.maxRunCostUSD, null),
    maxRunCostFactor: num(o.maxRunCostFactor, null),
    maxRunTokens: num(o.maxRunTokens, null),
    maxIterations,
    maxDurationMinutes: num(o.maxDurationMinutes, null),
    enforcement,
    // `=== true`, not `Boolean(...)`: this flag makes a run refuse to stop when
    // the agent says it is finished, so a string "false" off the wire must read
    // as off, not as on. Fail safe beats fail consistent.
    continueAfterDone: o.continueAfterDone === true,
  };
}

/* ------------------------------------------------------------------ */
/* The whole of one press of Run                                       */
/* ------------------------------------------------------------------ */

/**
 * Limits on a workflow instance rather than on one run.
 *
 * Per-run guards bound one block. A graph of ten blocks under a $5 run limit is
 * a $50 workflow with nothing standing between the operator and that number,
 * which is what this bounds.
 *
 * **There is no monotone terminus here, and none is needed.** The run loop
 * requires one because the loop itself manufactures the next unit of work: with
 * every guard switched off nothing would ever end it, so `maxIterations` and
 * `maxDurationMinutes` are the two quantities that only move one way and one of
 * them must be set. An instance manufactures nothing. It is a finite graph
 * created in a single pass, every member of which already carries its own
 * terminus — enforced by `POST /api/runs`, and refused again as `no_terminus`
 * above — so an instance with all three of these null still ends, when its last
 * member does. These are *early* stops on a thing that was already going to
 * stop, which is why all three are nullable together and why the illegal-pair
 * check that `maxIterations` needs has no analogue here.
 */
export interface InstanceBudgetPolicy {
  /** Everything this instance's blocks spend, together. null = no limit. */
  maxInstanceCostUSD: number | null;
  /** Stop the whole instance once the 5-hour window passes this (0–1). */
  maxSessionFraction: number | null;
  /** Stop the whole instance once the weekly window passes this (0–1). */
  maxWeeklyFraction: number | null;
}

export interface InstanceProgress {
  /**
   * What the members' own CLIs measured, summed. A **floor**: a cycle in flight
   * has emitted no `result`, so it contributes nothing here for its whole
   * duration. Displayed, never guarded on.
   */
  spentUSD: number;
  /**
   * What the guard acts on: `spentUSD`, plus every member's reconciled estimate
   * for cycles killed before they reported, plus what telemetry says the cycles
   * in flight have cost so far. Equal to `spentUSD` when nothing is running and
   * nothing was ever killed.
   *
   * The same display-versus-guard split `costUSD`/`costGuardUSD` makes for a
   * window and `spentUSD`/`spentGuardUSD` makes for a run, for the same reason:
   * what is shown stays a floor of measured fact, what is guarded on includes
   * what could have been spent.
   */
  spentGuardUSD: number;
}

/**
 * Codes a workflow instance may actually be halted on.
 *
 * `LIVE_ENFORCEABLE_CODES`'s reasoning, applied to the one code it excludes for
 * being about configuration rather than about spending. `no_ceiling` is checked
 * **at the door** — `startWorkflow`, which has an error channel and refuses the
 * press of Run by name — and deliberately not acted on afterwards, because
 * `fraction` going null under a running instance is not the operator having
 * failed to set a ceiling. On a stock install that reading comes from the
 * provider (`planUsage.ts`, preferred over any configured ceiling), and it is
 * discarded after an hour without a fresh answer: an unreachable Anthropic host
 * would otherwise halt every workflow carrying a fraction guard, killing the
 * in-flight cycles of every one of their blocks. Turning a provider outage into
 * a stopped graph is a worse failure than the one the refusal exists to prevent.
 *
 * It is not silently ignored either. The run whose check found it logs a line
 * saying the guard had nothing to read — the same answer this app already gives
 * for a live spending limit whose telemetry never arrived, and for the same
 * reason: a guard reading nothing refuses nothing and looks exactly like a guard
 * that was never reached.
 */
export const INSTANCE_ENFORCEABLE_CODES: readonly BudgetStopCode[] = [
  "instance_cost",
  "weekly_fraction",
  "session_fraction",
];

/** Nothing is set, so there is no guard to evaluate and no card to render. */
export function instanceBudgetIsOff(policy: InstanceBudgetPolicy): boolean {
  return (
    policy.maxInstanceCostUSD === null &&
    policy.maxSessionFraction === null &&
    policy.maxWeeklyFraction === null
  );
}

/**
 * Whether one press of Run may put another block to work.
 *
 * Deliberately the same `BudgetVerdict`, the same `BudgetStopCode` vocabulary
 * and the same `readWindowGuard` reading as the per-run guard above — an
 * instance limit that used its own words for "no ceiling configured", or that
 * compared against `fraction` where the run guard compares against
 * `guardFraction`, would be a second set of budget rules to keep in step.
 *
 * What it does **not** share is the run guard's body, and the two differences
 * are why: an instance has no terminus to require (see `InstanceBudgetPolicy`),
 * and no `pause` disposition. Parking is for the one quantity that refills on
 * its own, and it is a decision about *a run* — it yields the run's folder and
 * keeps its checkout so the same conversation resumes later. An instance holds
 * no folder and no session; "park the graph" would mean parking every member
 * individually under limits none of them was given, so an instance that is over
 * its budget stops, and starting again is a press of Run.
 */
export function evaluateInstanceBudget(
  policy: InstanceBudgetPolicy,
  snapshot: UsageSnapshot,
  progress: InstanceProgress,
): BudgetVerdict {
  const meters: BudgetMeter[] = [];

  if (policy.maxInstanceCostUSD !== null) {
    meters.push({
      label: "Spent by this workflow run",
      // The guard's figure, so the card shows what the decision was made on —
      // the same choice the run meters make.
      value: progress.spentGuardUSD,
      limit: policy.maxInstanceCostUSD,
      unit: "usd",
    });
  }
  if (policy.maxWeeklyFraction !== null && snapshot.weekly.guardFraction !== null) {
    meters.push({
      label: "Weekly window",
      value: snapshot.weekly.guardFraction,
      limit: policy.maxWeeklyFraction,
      unit: "fraction",
    });
  }
  if (
    policy.maxSessionFraction !== null &&
    snapshot.session.guardFraction !== null
  ) {
    meters.push({
      label: "5-hour window",
      value: snapshot.session.guardFraction,
      limit: policy.maxSessionFraction,
      unit: "fraction",
    });
  }

  const block = (code: BudgetStopCode, reason: string): BudgetVerdict => ({
    allowed: false,
    code,
    reason,
    disposition: "stop",
    meters,
  });

  // Spend first, for the reason the run guard checks its own spend before the
  // windows: it is the one quantity here that only grows, so a verdict from it
  // is settled, where a window fraction can fall back under the threshold on
  // the next reading.
  if (
    policy.maxInstanceCostUSD !== null &&
    progress.spentGuardUSD >= policy.maxInstanceCostUSD
  ) {
    return block(
      "instance_cost",
      `This workflow run has spent $${progress.spentGuardUSD.toFixed(2)} across its blocks, ` +
        `reaching its $${policy.maxInstanceCostUSD.toFixed(2)} limit for the whole workflow.`,
    );
  }

  // Held rather than returned, for `evaluateBudget`'s reason one level up: this
  // code is on nothing's enforceable list, so returning it where it is found
  // makes an unreadable weekly window switch the 5-hour guard off silently for
  // every block of the instance. The refusal is returned once every guard that
  // *can* be read has passed, and `??=` keeps the weekly wording in front.
  let unreadable: BudgetVerdict | null = null;

  if (policy.maxWeeklyFraction !== null) {
    const weekly = readWindowGuard(snapshot.weekly, policy.maxWeeklyFraction);
    if (weekly.state === "no-ceiling") {
      unreadable ??= block(
        "no_ceiling",
        "This workflow stops at a share of the weekly window, but no weekly " +
          "ceiling is configured. Set one in Settings (or run Calibrate) " +
          "before using this guard.",
      );
    }
    if (weekly.state === "over") {
      return block(
        "weekly_fraction",
        `Weekly window is at ${pct(weekly.at)}, at or past this workflow's ${pct(policy.maxWeeklyFraction)} guard.`,
      );
    }
  }

  if (policy.maxSessionFraction !== null) {
    const session = readWindowGuard(snapshot.session, policy.maxSessionFraction);
    if (session.state === "no-ceiling") {
      unreadable ??= block(
        "no_ceiling",
        "This workflow stops at a share of the 5-hour window, but no 5-hour " +
          "ceiling is configured. Set one in Settings (or run Calibrate) " +
          "before using this guard.",
      );
    }
    if (session.state === "over") {
      return block(
        "session_fraction",
        `5-hour window is at ${pct(session.at)}, at or past this workflow's ${pct(policy.maxSessionFraction)} guard.`,
      );
    }
  }

  if (unreadable !== null) return unreadable;

  return { allowed: true, meters };
}

/**
 * Read an instance budget off the wire or out of a stored blob.
 *
 * Total and idempotent, for `normalizePolicy`'s reasons: it runs once on the
 * saved form and again every time the stored row is read back, so a term that
 * is not idempotent would turn a workflow that saved cleanly into one that
 * cannot be started. `null`, `""`, `0` and a negative all mean **off**, which is
 * this app's standing rule for every budget field — there is no default limit to
 * restore, because a limit nobody typed is not a limit.
 */
export function normalizeInstanceBudget(raw: unknown): InstanceBudgetPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const frac = (v: unknown): number | null => {
    const n = num(v);
    if (n === null) return null;
    // Accept either 0–1 or a percentage typed as 0–100, exactly as a run's
    // fraction guards do — the form asks for a percentage.
    return n > 1 ? Math.min(n / 100, 1) : n;
  };

  return {
    maxInstanceCostUSD: num(o.maxInstanceCostUSD),
    maxSessionFraction: frac(o.maxSessionFraction),
    maxWeeklyFraction: frac(o.maxWeeklyFraction),
  };
}

/* ------------------------------------------------------------------ */
/* The whole of what this installation spends                          */
/* ------------------------------------------------------------------ */

/**
 * How far back the install-wide ceiling looks.
 *
 * A **rolling** 24 hours, not a calendar day, and both halves of that are
 * deliberate. A calendar day would have to be cut in some zone — the container
 * runs in UTC and the operator does not, which is the failure `zonedMidnight`
 * already exists to fix for the dashboard's history — and a guard cut in the
 * wrong zone refuses work for hours or authorises it for hours. It would also
 * be a cliff every run in the install crosses at the same instant, which is the
 * lockstep this app already has enough of.
 *
 * Fixed rather than configurable: a second field to get wrong, for a period
 * nobody has asked to vary. The number the operator types is the money.
 */
export const INSTALL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one limit here that is about the *installation* rather than about a run,
 * a press of Run, or a chat turn.
 *
 * Every other guard in this module bounds one thing that spends: `maxRunCostUSD`
 * a run, `maxInstanceCostUSD` a workflow instance, `chatTurnBudgetUSD` a turn.
 * None of them bounds the total, and nothing bounds the *rate* at which new
 * spenders are created — `promoteQueued` starts the next queued run the instant
 * a slot frees, a schedule presses Run with nobody present, and an orchestrator
 * block starts up to `MAX_FAN_OUT` runs with no approval — so the fleet's spend
 * is `waves × concurrency × per-run limit` with no term under an operator-set
 * maximum. This is that term.
 *
 * It is **not** the calendar rollup wearing a different hat. `buildPeriods`
 * measures history against a weekly ceiling spread over a day or a month, which
 * is a threshold nobody set, and `CLAUDE.md` is right that it must never reach a
 * guard. This is a number the operator typed, meaning what it says, compared
 * against money this app itself recorded spending.
 *
 * One field, so no `no_ceiling` analogue and no terminus question: an install
 * that has spent nothing is under any limit, and the reading only grows within
 * the window and only shrinks as spend ages out of it.
 */
export interface InstallBudgetPolicy {
  /** USD across `INSTALL_WINDOW_MS`, for everything. null = no limit. */
  maxInstallCostUSD: number | null;
}

export interface InstallProgress {
  /**
   * What was measured: every run's `spent_usd`, every orchestrator block's
   * `cost_usd` and every chat's `cost_usd` inside the window. A **floor**, for
   * `InstanceProgress.spentUSD`'s reason — a cycle in flight has reported
   * nothing. Displayed, never guarded on.
   */
  spentUSD: number;
  /**
   * What the guard acts on: the above, plus every run's reconciled estimate for
   * cycles killed before they reported, plus what telemetry says the cycles in
   * flight have cost so far. The same display-versus-guard split `costUSD`/
   * `costGuardUSD` makes for a window and `instanceSpend` makes for one press of
   * Run, and for the same reason.
   */
  spentGuardUSD: number;
}

/** Nothing is set, so there is no ceiling to evaluate and no meter to fill. */
export function installBudgetIsOff(policy: InstallBudgetPolicy): boolean {
  return policy.maxInstallCostUSD === null;
}

/**
 * Whether this installation may start something else that spends.
 *
 * Deliberately the same `BudgetVerdict` and the same `BudgetStopCode`
 * vocabulary as the two guards above — a third set of budget words for the same
 * kind of decision would be a third thing to keep in step — and pure for
 * `evaluateInstanceBudget`'s reason: what reads the database is the caller.
 */
export function evaluateInstallBudget(
  policy: InstallBudgetPolicy,
  progress: InstallProgress,
): BudgetVerdict {
  const meters: BudgetMeter[] = [];

  if (policy.maxInstallCostUSD !== null) {
    meters.push({
      label: "Spent by this install",
      // The guard's figure, so a card shows what the decision was made on —
      // the same choice the run and instance meters make.
      value: progress.spentGuardUSD,
      limit: policy.maxInstallCostUSD,
      unit: "usd",
    });
  }

  if (
    policy.maxInstallCostUSD !== null &&
    progress.spentGuardUSD >= policy.maxInstallCostUSD
  ) {
    return {
      allowed: false,
      code: "install_cost",
      reason:
        `This install has spent $${progress.spentGuardUSD.toFixed(2)} in the last ` +
        `${INSTALL_WINDOW_MS / 3_600_000} hours, reaching the $${policy.maxInstallCostUSD.toFixed(2)} ` +
        "limit set in Settings for everything it runs. Nothing new will start " +
        "until spend ages out of that window or the limit is raised.",
      disposition: "stop",
      meters,
    };
  }

  return { allowed: true, meters };
}

/**
 * Read the install ceiling off a settings value.
 *
 * `normalizeInstanceBudget`'s rules, for its reasons: total, idempotent, and
 * `null`/`""`/`0`/negative all meaning **off**, which is this app's standing
 * rule for every budget field — there is no default limit to restore, because a
 * limit nobody typed is not a limit.
 */
export function normalizeInstallBudget(raw: unknown): InstallBudgetPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  const v = o.maxInstallCostUSD;
  if (v === null || v === undefined || v === "") {
    return { maxInstallCostUSD: null };
  }
  const n = Number(v);
  return {
    maxInstallCostUSD: Number.isFinite(n) && n > 0 ? n : null,
  };
}
