import type { UsageSnapshot } from "./windows";

/**
 * Budget policy: the rules that decide whether a run may start another
 * iteration.
 *
 * Checked *before* each iteration rather than during one. A Claude Code turn
 * cannot be interrupted mid-flight without losing its work, so the guarantee
 * this offers is "no new work starts past the threshold", not "spend never
 * exceeds the threshold". The overshoot is bounded by one iteration, and the
 * UI states this rather than implying a hard cap.
 */

export interface BudgetPolicy {
  /** Stop when the weekly window reaches this fraction of its ceiling (0–1). */
  maxWeeklyFraction: number | null;
  /** Stop when the 5-hour window reaches this fraction of its ceiling (0–1). */
  maxSessionFraction: number | null;
  /** Stop when this run alone has spent this many USD. null = no limit. */
  maxRunCostUSD: number | null;
  /** Stop when this run alone has consumed this many tokens. null = no limit. */
  maxRunTokens: number | null;
  /**
   * Cap on iterations ("work cycles" in the UI). Always set — an unbounded
   * loop is the one failure mode with no natural stopping point.
   */
  maxIterations: number;
  /** Wall-clock cap for the whole run. null = run for as long as it takes. */
  maxDurationMinutes: number | null;
}

export const DEFAULT_POLICY: BudgetPolicy = {
  maxWeeklyFraction: 0.8,
  maxSessionFraction: null,
  maxRunCostUSD: 5,
  maxRunTokens: null,
  maxIterations: 5,
  maxDurationMinutes: 60,
};

export interface RunProgress {
  iterations: number;
  spentUSD: number;
  spentTokens: number;
  startedAt: number | null;
}

export interface BudgetVerdict {
  allowed: boolean;
  /** Human-readable reason the run was stopped. Present only when blocked. */
  reason?: string;
  /** Machine-readable stop code. */
  code?:
    | "weekly_fraction"
    | "session_fraction"
    | "run_cost"
    | "run_tokens"
    | "iterations"
    | "duration"
    | "no_ceiling";
  /** Per-constraint utilisation, for rendering meters. */
  meters: Array<{
    label: string;
    value: number;
    limit: number;
    unit: "fraction" | "usd" | "tokens" | "count" | "minutes";
  }>;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function evaluateBudget(
  policy: BudgetPolicy,
  snapshot: UsageSnapshot,
  progress: RunProgress,
  now = Date.now(),
): BudgetVerdict {
  const meters: BudgetVerdict["meters"] = [];

  const elapsedMinutes = progress.startedAt
    ? (now - progress.startedAt) / 60_000
    : 0;

  meters.push({
    label: "Work cycles used",
    value: progress.iterations,
    limit: policy.maxIterations,
    unit: "count",
  });
  if (policy.maxRunCostUSD !== null) {
    meters.push({
      label: "Spent on this run",
      value: progress.spentUSD,
      limit: policy.maxRunCostUSD,
      unit: "usd",
    });
  }
  if (policy.maxRunTokens !== null) {
    meters.push({
      label: "Tokens used by this run",
      value: progress.spentTokens,
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

  const block = (code: BudgetVerdict["code"], reason: string): BudgetVerdict => ({
    allowed: false,
    code,
    reason,
    meters,
  });

  if (progress.iterations >= policy.maxIterations) {
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

  if (policy.maxRunCostUSD !== null && progress.spentUSD >= policy.maxRunCostUSD) {
    return block(
      "run_cost",
      `This run has spent $${progress.spentUSD.toFixed(2)}, reaching its $${policy.maxRunCostUSD.toFixed(2)} spending limit.`,
    );
  }

  if (policy.maxRunTokens !== null && progress.spentTokens >= policy.maxRunTokens) {
    return block(
      "run_tokens",
      `This run has used ${progress.spentTokens.toLocaleString()} tokens, reaching its token limit.`,
    );
  }

  // A fraction-of-limit rule is only meaningful when a ceiling is configured.
  // Refusing to start is the safe reading of "stop at 80% of my weekly limit"
  // when we have no idea what 100% is — silently ignoring the rule would let a
  // run proceed under a guard the user believes is active.
  //
  // The threshold is compared against `guardFraction`, not `fraction`: a model
  // with no known price contributes $0 to the displayed cost, and with a whole
  // window unpriced the displayed fraction is exactly 0, which no threshold
  // can ever exceed. Guarding on the reported floor would mean the guard
  // quietly ceases to exist the week a new model ships. The "no ceiling"
  // refusal below still reads `fraction` — the two are null together, and a
  // missing ceiling is a configuration fact, not a pricing one.
  if (policy.maxWeeklyFraction !== null) {
    if (snapshot.weekly.fraction === null) {
      return block(
        "no_ceiling",
        "A weekly-fraction guard is set but no weekly ceiling is configured. " +
          "Set one in Settings (or run Calibrate) before using this guard.",
      );
    }
    if ((snapshot.weekly.guardFraction ?? 0) >= policy.maxWeeklyFraction) {
      return block(
        "weekly_fraction",
        `Weekly window is at ${pct(snapshot.weekly.guardFraction ?? 0)}, at or past the ${pct(policy.maxWeeklyFraction)} guard.`,
      );
    }
  }

  if (policy.maxSessionFraction !== null) {
    if (snapshot.session.fraction === null) {
      return block(
        "no_ceiling",
        "A session-fraction guard is set but no 5-hour ceiling is configured. " +
          "Set one in Settings (or run Calibrate) before using this guard.",
      );
    }
    if ((snapshot.session.guardFraction ?? 0) >= policy.maxSessionFraction) {
      return block(
        "session_fraction",
        `5-hour window is at ${pct(snapshot.session.guardFraction ?? 0)}, at or past the ${pct(policy.maxSessionFraction)} guard.`,
      );
    }
  }

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

  return {
    maxWeeklyFraction: frac(o.maxWeeklyFraction),
    maxSessionFraction: frac(o.maxSessionFraction),
    maxRunCostUSD: num(o.maxRunCostUSD, null),
    maxRunTokens: num(o.maxRunTokens, null),
    maxIterations: Math.max(1, Math.floor(num(o.maxIterations, 1) ?? 1)),
    maxDurationMinutes: num(o.maxDurationMinutes, null),
  };
}
