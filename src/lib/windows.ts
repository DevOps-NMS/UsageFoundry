import type { UsageEntry } from "./transcripts";
import {
  type TokenCounts,
  ZERO_TOKENS,
  addTokens,
  totalTokens,
} from "./pricing";

/**
 * Rolls raw usage entries up into the limit windows Claude Code actually
 * enforces: a 5-hour session block and a weekly quota.
 *
 * Caveat that the UI must keep visible: Anthropic does not publish the numeric
 * value of a subscription's limits, and there is no endpoint to read them. The
 * *windows* here are real and computed from your own data; the *ceilings* they
 * are measured against come from user configuration and are estimates.
 */

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface Aggregate {
  tokens: TokenCounts;
  costUSD: number;
  /**
   * Cost with unpriced models charged the fallback rate rather than $0.
   * Consumed only by the budget guard; equal to `costUSD` when every model in
   * the window is priced. Never render this — `costUSD` is the reported
   * figure, and it stays a floor rather than a guess.
   */
  costGuardUSD: number;
  entryCount: number;
}

export const ZERO_AGGREGATE: Aggregate = {
  tokens: ZERO_TOKENS,
  costUSD: 0,
  costGuardUSD: 0,
  entryCount: 0,
};

export function aggregate(entries: UsageEntry[]): Aggregate {
  let tokens = ZERO_TOKENS;
  let costUSD = 0;
  let costGuardUSD = 0;
  for (const e of entries) {
    tokens = addTokens(tokens, e.tokens);
    costUSD += e.costUSD;
    costGuardUSD += e.costGuardUSD;
  }
  return { tokens, costUSD, costGuardUSD, entryCount: entries.length };
}

export interface SessionBlock {
  startsAt: number;
  endsAt: number;
  /** Timestamp of the most recent entry in the block. */
  lastActivityAt: number;
  isActive: boolean;
  agg: Aggregate;
  models: string[];
  projects: string[];
}

function floorToHour(ts: number): number {
  return Math.floor(ts / 3_600_000) * 3_600_000;
}

/**
 * Group entries into 5-hour session blocks.
 *
 * A block opens at the first entry (floored to the hour) and runs for five
 * hours. It also closes early if more than five hours pass with no activity,
 * which is what Claude Code does — an idle gap ends the session rather than
 * carrying the window forward.
 */
export function buildSessionBlocks(
  entries: UsageEntry[],
  now = Date.now(),
): SessionBlock[] {
  const blocks: SessionBlock[] = [];
  let current: UsageEntry[] = [];
  let blockStart = 0;
  let lastTs = 0;

  const flush = () => {
    if (current.length === 0) return;
    const endsAt = blockStart + FIVE_HOURS_MS;
    blocks.push({
      startsAt: blockStart,
      endsAt,
      lastActivityAt: lastTs,
      isActive: now < endsAt,
      agg: aggregate(current),
      models: [...new Set(current.map((e) => e.model))],
      projects: [...new Set(current.map((e) => e.project).filter(Boolean))],
    });
    current = [];
  };

  for (const e of entries) {
    if (current.length === 0) {
      blockStart = floorToHour(e.ts);
      current = [e];
      lastTs = e.ts;
      continue;
    }
    const pastWindow = e.ts >= blockStart + FIVE_HOURS_MS;
    const idleGap = e.ts - lastTs >= FIVE_HOURS_MS;
    if (pastWindow || idleGap) {
      flush();
      blockStart = floorToHour(e.ts);
      current = [e];
    } else {
      current.push(e);
    }
    lastTs = e.ts;
  }
  flush();

  return blocks;
}

export interface WindowState {
  label: string;
  startsAt: number;
  endsAt: number;
  agg: Aggregate;
  /** Raw token volume in the window (cache reads counted at face value). */
  tokens: number;
  /** Equivalent API cost in the window — the cache-weighted measure. */
  costUSD: number;
  /**
   * Primary utilisation. Cost-denominated when a cost ceiling exists, falling
   * back to tokens otherwise.
   *
   * Cost is preferred because a Claude Code workload is overwhelmingly cache
   * reads, which bill at 0.1x. Counting them at face value against a raw-token
   * ceiling measures conversation length far more than it measures work, and
   * the ratio swings with context size. Cost already applies the 0.1x / 1.25x
   * / 2x multipliers, so it is the stabler proxy for "how much of my plan have
   * I used".
   */
  fraction: number | null;
  /** Which metric `fraction` was derived from. */
  fractionMetric: "cost" | "tokens" | null;
  /** Utilisation against the cost ceiling, when one is configured. */
  costFraction: number | null;
  /** Utilisation against the token ceiling, when one is configured. */
  tokenFraction: number | null;
  /**
   * What the budget guard compares against its threshold: the same preference
   * order as `fraction`, but with unpriced models charged the fallback rate.
   *
   * Equal to `fraction` whenever every model in the window is priced. When it
   * is higher, the guard will stop a run before the displayed meter looks
   * full — the meter shows what is known to have been spent, the guard acts on
   * what could have been. The dashboard renders the gap rather than letting
   * the two silently disagree.
   */
  guardFraction: number | null;
  /** The ceiling backing `fraction`. */
  limit: number | null;
  limitMetric: "tokens" | "cost" | null;
}

export interface WeeklyAnchor {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Hour of day (0-23) in UTC at which the week rolls over. */
  hourUTC: number;
}

/** Start of the weekly quota period containing `now`. */
export function weekStart(now: number, anchor: WeeklyAnchor | null): number {
  if (!anchor) return now - WEEK_MS; // rolling 7-day window
  const d = new Date(now);
  const cur = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      anchor.hourUTC,
      0,
      0,
      0,
    ),
  );
  // Walk back to the most recent anchor weekday at or before `now`.
  let delta = (cur.getUTCDay() - anchor.weekday + 7) % 7;
  cur.setUTCDate(cur.getUTCDate() - delta);
  if (cur.getTime() > now) cur.setUTCDate(cur.getUTCDate() - 7);
  return cur.getTime();
}

export interface LimitConfig {
  /** Primary: cost ceiling (USD) for one 5-hour block. */
  sessionCostLimit: number | null;
  /** Primary: cost ceiling (USD) for the weekly window. */
  weeklyCostLimit: number | null;
  /** Secondary: raw-token ceiling for one 5-hour block. */
  sessionTokenLimit: number | null;
  /** Secondary: raw-token ceiling for the weekly window. */
  weeklyTokenLimit: number | null;
  weeklyAnchor: WeeklyAnchor | null;
}

function fractionOf(value: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return value / limit;
}

export interface UsageSnapshot {
  now: number;
  session: WindowState;
  weekly: WindowState;
  /** All blocks, newest first, for history charts. */
  blocks: SessionBlock[];
  /** Tokens per hour over the trailing hour of activity. */
  burnTokensPerHour: number;
  burnCostPerHour: number;
  /**
   * Projected epoch ms at which the binding window is exhausted at the
   * current burn rate, or null when nothing is projected to run out.
   */
  projectedExhaustionAt: number | null;
  byModel: Array<{ model: string; agg: Aggregate }>;
  byProject: Array<{ project: string; agg: Aggregate }>;
  totalCostUSD: number;
}

export function buildSnapshot(
  entries: UsageEntry[],
  limits: LimitConfig,
  now = Date.now(),
): UsageSnapshot {
  const blocks = buildSessionBlocks(entries, now);
  const activeBlock = blocks.find((b) => b.isActive) ?? null;

  /**
   * Build a window, preferring the cost ceiling. Both fractions are exposed so
   * the UI can show the token view alongside without it driving any decision.
   */
  const makeWindow = (
    label: string,
    startsAt: number,
    endsAt: number,
    agg: Aggregate,
    costLimit: number | null,
    tokenLimit: number | null,
  ): WindowState => {
    const tokens = totalTokens(agg.tokens);
    const costFraction = fractionOf(agg.costUSD, costLimit);
    const tokenFraction = fractionOf(tokens, tokenLimit);
    const useCost = costFraction !== null;
    // Same ceiling, same preference order — only the numerator differs, so
    // guardFraction is null exactly when fraction is, and the "no ceiling
    // configured" refusal keeps working off either.
    const guardCostFraction = fractionOf(agg.costGuardUSD, costLimit);

    return {
      label,
      startsAt,
      endsAt,
      agg,
      tokens,
      costUSD: agg.costUSD,
      fraction: costFraction ?? tokenFraction,
      fractionMetric: useCost ? "cost" : tokenFraction !== null ? "tokens" : null,
      costFraction,
      tokenFraction,
      guardFraction: guardCostFraction ?? tokenFraction,
      limit: useCost ? costLimit : tokenLimit,
      limitMetric: useCost ? "cost" : tokenFraction !== null ? "tokens" : null,
    };
  };

  const sessionStart = activeBlock ? activeBlock.startsAt : floorToHour(now);
  const sessionAgg = activeBlock ? activeBlock.agg : ZERO_AGGREGATE;

  const wkStart = weekStart(now, limits.weeklyAnchor);
  const wkEnd = limits.weeklyAnchor ? wkStart + WEEK_MS : now;
  const weekEntries = entries.filter((e) => e.ts >= wkStart);
  const weeklyAgg = aggregate(weekEntries);

  const session = makeWindow(
    "5-hour session",
    sessionStart,
    sessionStart + FIVE_HOURS_MS,
    sessionAgg,
    limits.sessionCostLimit,
    limits.sessionTokenLimit,
  );

  const weekly = makeWindow(
    limits.weeklyAnchor ? "Weekly quota" : "Trailing 7 days",
    wkStart,
    wkEnd,
    weeklyAgg,
    limits.weeklyCostLimit,
    limits.weeklyTokenLimit,
  );

  // Burn rate over the trailing hour, which tracks a bursty agent workload far
  // better than averaging across the whole window.
  const hourAgo = now - 3_600_000;
  const recent = entries.filter((e) => e.ts >= hourAgo);
  const recentAgg = aggregate(recent);
  const burnTokensPerHour = totalTokens(recentAgg.tokens);
  const burnCostPerHour = recentAgg.costUSD;

  // Project against every configured ceiling and report the earliest. Each
  // metric is projected with its own burn rate — projecting a cost ceiling
  // from a token rate (or vice versa) would be meaningless for a workload
  // whose token/cost ratio moves with cache-read volume.
  const etaFor = (
    consumed: number,
    limit: number | null,
    ratePerHour: number,
  ): number | null => {
    if (limit === null || limit <= 0 || ratePerHour <= 0) return null;
    const remaining = limit - consumed;
    return remaining <= 0 ? now : now + (remaining / ratePerHour) * 3_600_000;
  };

  const candidates = [
    etaFor(session.costUSD, limits.sessionCostLimit, burnCostPerHour),
    etaFor(weekly.costUSD, limits.weeklyCostLimit, burnCostPerHour),
    etaFor(session.tokens, limits.sessionTokenLimit, burnTokensPerHour),
    etaFor(weekly.tokens, limits.weeklyTokenLimit, burnTokensPerHour),
  ].filter((v): v is number => v !== null);

  const projectedExhaustionAt = candidates.length ? Math.min(...candidates) : null;

  const modelMap = new Map<string, UsageEntry[]>();
  const projectMap = new Map<string, UsageEntry[]>();
  for (const e of weekEntries) {
    (modelMap.get(e.model) ?? modelMap.set(e.model, []).get(e.model)!).push(e);
    const p = e.project || "(unknown)";
    (projectMap.get(p) ?? projectMap.set(p, []).get(p)!).push(e);
  }

  const byModel = [...modelMap.entries()]
    .map(([model, es]) => ({ model, agg: aggregate(es) }))
    .sort((a, b) => b.agg.costUSD - a.agg.costUSD);

  const byProject = [...projectMap.entries()]
    .map(([project, es]) => ({ project, agg: aggregate(es) }))
    .sort((a, b) => b.agg.costUSD - a.agg.costUSD);

  return {
    now,
    session,
    weekly,
    blocks: blocks.slice(-48).reverse(),
    burnTokensPerHour,
    burnCostPerHour,
    projectedExhaustionAt,
    byModel,
    byProject,
    totalCostUSD: entries.reduce((s, e) => s + e.costUSD, 0),
  };
}
