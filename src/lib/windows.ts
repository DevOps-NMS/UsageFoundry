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

/**
 * One limit window as the provider itself reports it.
 *
 * This is the only figure here that is not derived. Everything else in this
 * module is our arithmetic over local transcripts measured against a ceiling
 * somebody typed; this is Anthropic's own answer for the account, covering
 * every surface that shares the allowance — Claude Code, the web app, Desktop,
 * Cowork — including all the ones that leave nothing on this disk to read.
 */
export interface PlanWindow {
  /** 0–1. The provider reports a percentage; `planUsage.ts` divides. */
  utilization: number;
  /** Epoch ms at which the window resets, or null when none is named. */
  resetsAt: number | null;
}

export interface PlanUsage {
  /** The 5-hour window. */
  session: PlanWindow | null;
  /** The seven-day window. */
  weekly: PlanWindow | null;
  /**
   * Weekly walls scoped to one model family ("Opus", "Fable").
   *
   * Each is a ceiling in its own right and can stop a run while the all-model
   * weekly window is nowhere near full, so the guard takes the worst of them
   * (`guardFraction`) while the meter keeps reporting the window it is
   * labelled with. Empty on an account that has none.
   */
  scopedWeekly: Array<{ label: string; window: PlanWindow }>;
  /** Epoch ms this was read from the provider — it is cached, so it ages. */
  fetchedAt: number;
}

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

/**
 * Turn an operator-supplied reset instant into the block boundary it implies.
 *
 * Anthropic restarts the 5-hour window on events that leave no trace in a
 * transcript — changing subscription tier is the known one — and from then on
 * the boundary derived from the entries is measuring against a window that no
 * longer exists. The transcripts cannot be corrected, so the reset instant the
 * user reads out of `/usage` is carried as configuration instead, and the
 * window it opened started five hours before it.
 */
function anchorOf(sessionResetAt: number | null): number | null {
  return sessionResetAt === null ? null : sessionResetAt - FIVE_HOURS_MS;
}

/**
 * Group entries into 5-hour session blocks.
 *
 * A block opens at its first entry and runs for five hours; the next one opens
 * at the first entry after that, which is the rule the provider states — the
 * window starts with your first message and lasts five hours.
 *
 * It does **not** floor the start to the hour. That was a guess, and a costly
 * one: Anthropic issues the reset instant itself, in the
 * `anthropic-ratelimit-unified-reset` response header, and Claude Code's own
 * renderer prints the minutes whenever they are non-zero — so resets plainly do
 * not land on the hour. Flooring moved every boundary up to 59 minutes early
 * and, because each block opens where the last one closed, that error carried
 * down the whole chain. The visible damage was not the clock: a window rolled
 * over early reads as a *fresh, empty* session while the provider is still
 * counting the old one, which is the reading the meter and the guard both act
 * on. Anchoring on the entry itself costs the latency of the opening turn
 * instead — the transcript records the response, not the request that opened
 * the window — which is seconds, and errs the other way: a boundary that is
 * late keeps counting spend against the window still being enforced, so the
 * guard trips early rather than late.
 *
 * `sessionResetAt` forces a boundary: a block open at that moment is closed
 * there, and the block that follows starts at the reset rather than at its own
 * first entry. Splitting rather than filtering keeps the pre-reset work in
 * history, where it did happen and did count.
 */
export function buildSessionBlocks(
  entries: UsageEntry[],
  now = Date.now(),
  sessionResetAt: number | null = null,
): SessionBlock[] {
  const anchor = anchorOf(sessionResetAt);
  const blocks: SessionBlock[] = [];
  let current: UsageEntry[] = [];
  let blockStart = 0;
  let lastTs = 0;

  const startFor = (ts: number) =>
    anchor !== null && ts >= anchor && ts < anchor + FIVE_HOURS_MS ? anchor : ts;

  const flush = () => {
    if (current.length === 0) return;
    // A block that was still open when the provider reset the window ended
    // there, not five hours after its own first entry — so it also stops being
    // the active block, which is the whole point of the override.
    const endsAt =
      anchor !== null &&
      blockStart < anchor &&
      anchor < blockStart + FIVE_HOURS_MS
        ? anchor
        : blockStart + FIVE_HOURS_MS;
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
      blockStart = startFor(e.ts);
      current = [e];
      lastTs = e.ts;
      continue;
    }
    // No separate idle-gap rule: `blockStart <= lastTs` always holds, so a gap
    // of five hours has already carried `e` past the window. Reinstating one
    // would assert that going quiet ends a window early, which the provider
    // does not do — five hours elapse whether or not you spend them.
    const pastWindow = e.ts >= blockStart + FIVE_HOURS_MS;
    const crossedReset = anchor !== null && blockStart < anchor && e.ts >= anchor;
    if (pastWindow || crossedReset) {
      flush();
      blockStart = startFor(e.ts);
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
   * Primary utilisation. The provider's own figure when we have it, then the
   * cost ceiling, then the token ceiling.
   *
   * The provider's figure leads because it is the answer rather than an
   * estimate of it: no price table, no ceiling to guess, and it counts the
   * surfaces this app cannot see. Measured on this machine, the derived
   * reading against a hand-typed ceiling was low by ~4x — right arithmetic,
   * wrong denominator — which is exactly the failure a percentage cannot
   * survive.
   *
   * Of the two derived readings cost is preferred, because a Claude Code
   * workload is overwhelmingly cache reads, which bill at 0.1x. Counting them
   * at face value against a raw-token ceiling measures conversation length far
   * more than it measures work, and the ratio swings with context size. Cost
   * already applies the 0.1x / 1.25x / 2x multipliers, so it is the stabler
   * proxy for "how much of my plan have I used".
   */
  fraction: number | null;
  /** Which metric `fraction` was derived from. */
  fractionMetric: "plan" | "cost" | "tokens" | null;
  /** The provider's own utilisation for this window, when it answered. */
  planFraction: number | null;
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
   *
   * On the provider's own figure the same split still applies, for two further
   * reasons. The weekly meter reports the all-model window it is labelled with,
   * while this takes the worst of that and every model-scoped weekly wall,
   * because being cut off by the Opus week is being cut off. And the provider's
   * percentage is *cached* — five minutes in the ordinary case, up to an hour
   * while requests are being refused — so the derived reading, which is
   * recomputed on every guard, is taken as well and the worst of the three
   * wins. The provider's figure can only be raised by that, never lowered.
   */
  guardFraction: number | null;
  /**
   * The ceiling backing `fraction`, or null when the provider supplied the
   * fraction directly — it names a percentage and no number behind it.
   */
  limit: number | null;
  limitMetric: "plan" | "tokens" | "cost" | null;
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

/**
 * A window measured against configured ceilings alone.
 *
 * The two metric fields are narrowed to the derived pair: the provider reports
 * a percentage for the 5-hour and weekly windows and for nothing else, so a
 * calendar bucket can never carry one and `buildWindow` cannot produce it.
 * `makeWindow` is the one place a first-party reading is layered on top.
 */
type DerivedWindow = Omit<
  WindowState,
  "label" | "planFraction" | "fractionMetric" | "limitMetric"
> & {
  fractionMetric: "cost" | "tokens" | null;
  limitMetric: "cost" | "tokens" | null;
};

/**
 * Build a window, preferring the cost ceiling. Both fractions are exposed so
 * the UI can show the token view alongside without it driving any decision.
 *
 * Label-free and closure-free so the calendar-period rollup below measures a
 * bucket exactly the way `buildSnapshot` measures the two live windows — the
 * cost-over-tokens preference and the guard split are decisions this codebase
 * makes once.
 */
function buildWindow(
  startsAt: number,
  endsAt: number,
  agg: Aggregate,
  costLimit: number | null,
  tokenLimit: number | null,
): DerivedWindow {
  const tokens = totalTokens(agg.tokens);
  const costFraction = fractionOf(agg.costUSD, costLimit);
  const tokenFraction = fractionOf(tokens, tokenLimit);
  const useCost = costFraction !== null;
  // Same ceiling, same preference order — only the numerator differs, so
  // guardFraction is null exactly when fraction is, and the "no ceiling
  // configured" refusal keeps working off either.
  const guardCostFraction = fractionOf(agg.costGuardUSD, costLimit);

  return {
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
}

/* ------------------------------------------------------------------ */
/* Agent attribution                                                   */
/* ------------------------------------------------------------------ */

/**
 * The bucket a turn with no sub-agent on it lands in.
 *
 * Named rather than written out twice, because the classifier below has to
 * recognise the same string the rollup emits: a turn that fell into this bucket
 * is main-thread work, not an agent whose definition has gone missing, and the
 * two must never read alike.
 */
export const MAIN_THREAD_BUCKET = "(main thread)";

/**
 * Where the definition behind an agent bucket lives — as far as this install
 * can see.
 *
 * The rollup itself stays exactly what it was: the transcript's own
 * `attributionAgent`, through the same `groupBy` as every other column, so the
 * buckets reconcile to the window total whatever this says. This is an
 * *annotation* on top of it, and the distinction it draws is a real one — an
 * agent the operator wrote down and an agent name that came from somewhere else
 * are different facts, and the card could not tell them apart.
 *
 *  - `main`     — no sub-agent on the turn at all.
 *  - `registry` — a saved agent in this install answers to that name.
 *  - `ambient`  — no saved agent does, but a definition on disk this app did
 *                 not write does. Those reach every child this app spawns and
 *                 always have; see `listAmbientAgents`.
 *  - `both`     — a saved agent *and* an ambient one share the name. Which of
 *                 the two the CLI used is not verified (CLAUDE.md records the
 *                 collision as unverified precisely here), so this says two
 *                 definitions exist rather than picking one and being quietly
 *                 wrong about who did the work.
 *  - `unknown`  — neither. A CLI built-in, a repository's own `.claude/agents`
 *                 in a checkout this classification cannot see, an agent since
 *                 deleted, or a turn from another machine's transcripts.
 *
 * Never null on a row the dashboard renders; null only when nothing looked the
 * names up, which is the orchestrator's guard path — see `buildSnapshot`.
 */
export type AgentOrigin = "main" | "registry" | "ambient" | "both" | "unknown";

/** Case-folded name → where its definition lives. Built by `agentOriginIndex`. */
export type AgentOriginIndex = ReadonlyMap<
  string,
  "registry" | "ambient" | "both"
>;

/** One name as both halves of the index key on it: trimmed and case-folded. */
function agentKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The lookup the classifier wants, out of the two lists a caller can read.
 *
 * Case-folded because `idx_agents_name` is and because `getAgentByName` matches
 * that way: the name the CLI recorded and the name the operator saved are one
 * agent here for the same reason they are one row there.
 *
 * A saved name and an ambient one that collide produce `both` rather than one
 * winning. Nothing in this app knows which definition the CLI actually used, and
 * a row claiming the operator's own agent did work that a file on disk may have
 * done is exactly the quiet wrongness the registry exists to end.
 */
export function agentOriginIndex(
  registry: Iterable<string>,
  ambient: Iterable<string>,
): AgentOriginIndex {
  const index = new Map<string, "registry" | "ambient" | "both">();
  for (const name of registry) {
    const key = agentKey(name);
    if (key) index.set(key, "registry");
  }
  for (const name of ambient) {
    const key = agentKey(name);
    if (!key) continue;
    index.set(key, index.has(key) ? "both" : "ambient");
  }
  return index;
}

/**
 * Which of the five a bucket is, or null when no lookup was supplied.
 *
 * Pure, and deliberately unable to change what bucket a turn landed in: it is
 * handed the key the rollup already produced. A saved agent being renamed moves
 * nothing here — the transcript recorded the name the CLI registered at the
 * time, and the annotation simply stops matching, which is the truth.
 */
export function agentOrigin(
  bucket: string,
  index: AgentOriginIndex | null,
): AgentOrigin | null {
  if (bucket === MAIN_THREAD_BUCKET) return "main";
  if (index === null) return null;
  return index.get(agentKey(bucket)) ?? "unknown";
}

/**
 * One run's own turns, split by who produced them.
 *
 * The same `groupBy` and the same buckets as the dashboard column, over the
 * entries belonging to one session rather than to a window — so a delegated turn
 * lands in its agent's row and everything else lands in `(main thread)`, and the
 * rows add up to `costUSD` with nothing omitted.
 *
 * This is the **transcript** source scoped to one run, which is the source
 * `reconcileKilledCycle` already reads for `spent_usd_est`, not a new one. It is
 * a display figure and only a display figure: it never reaches `runs.spent_usd`,
 * never reaches `buildSnapshot`, never reaches a budget verdict, and is never
 * added to what the CLI reported or to what telemetry reported — those two
 * measure the same run by two other routes and summing any pair of them
 * double-counts the same work.
 */
export interface AgentSpendRow {
  /** The transcript's own bucket key — never a saved agent's current name. */
  agent: string;
  origin: AgentOrigin;
  costUSD: number;
  /** The same turns with unpriced models charged the fallback rate. */
  costGuardUSD: number;
  tokens: number;
  entryCount: number;
}

export interface AgentSpend {
  costUSD: number;
  costGuardUSD: number;
  tokens: number;
  entryCount: number;
  /** Everything that is not `(main thread)` — what was handed to a specialist. */
  delegatedCostUSD: number;
  delegatedCostGuardUSD: number;
  /** Cost-descending, main thread included. */
  rows: AgentSpendRow[];
}

export function agentSpend(
  entries: UsageEntry[],
  index: AgentOriginIndex | null = null,
): AgentSpend {
  const rows = groupBy(entries, (e) => e.agent ?? MAIN_THREAD_BUCKET).map(
    ({ key, agg }): AgentSpendRow => ({
      agent: key,
      // Never null on this shape: a caller with no index gets `unknown` for
      // every named agent, which is the true statement that nothing looked.
      origin: agentOrigin(key, index) ?? "unknown",
      costUSD: agg.costUSD,
      costGuardUSD: agg.costGuardUSD,
      tokens: totalTokens(agg.tokens),
      entryCount: agg.entryCount,
    }),
  );

  const total = aggregate(entries);
  const delegated = rows.filter((r) => r.agent !== MAIN_THREAD_BUCKET);

  return {
    costUSD: total.costUSD,
    costGuardUSD: total.costGuardUSD,
    tokens: totalTokens(total.tokens),
    entryCount: total.entryCount,
    delegatedCostUSD: delegated.reduce((s, r) => s + r.costUSD, 0),
    delegatedCostGuardUSD: delegated.reduce((s, r) => s + r.costGuardUSD, 0),
    rows,
  };
}

/** Roll entries up under an arbitrary label, most expensive first. */
function groupBy(
  entries: UsageEntry[],
  key: (e: UsageEntry) => string,
): Array<{ key: string; agg: Aggregate }> {
  const map = new Map<string, UsageEntry[]>();
  for (const e of entries) {
    const k = key(e);
    const bucket = map.get(k);
    if (bucket) bucket.push(e);
    else map.set(k, [e]);
  }
  return [...map.entries()]
    .map(([k, es]) => ({ key: k, agg: aggregate(es) }))
    .sort((a, b) => b.agg.costUSD - a.agg.costUSD);
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
  /**
   * Cost by sub-agent, with main-thread work in its own bucket, and where each
   * bucket's definition lives.
   *
   * `origin` is null when the caller supplied no lookup — see `buildSnapshot`'s
   * last argument. Null is "nobody checked", which is a different sentence from
   * `unknown` ("checked, and this install has no such agent"), and the two must
   * not collapse: the guard path never checks, and a row there claiming the
   * operator has no such agent would be an invention.
   */
  byAgent: Array<{ agent: string; agg: Aggregate; origin: AgentOrigin | null }>;
  /** Cost by skill, with un-skilled turns in their own bucket. */
  bySkill: Array<{ skill: string; agg: Aggregate }>;
  /** Cost by reasoning effort — usually the largest single lever. */
  byEffort: Array<{ effort: string; agg: Aggregate }>;
  totalCostUSD: number;
  /**
   * The provider's own reading, when it answered, so the UI can say how old it
   * is and name the model-scoped weekly walls that never reach a meter.
   *
   * It is not a fourth cost source and is never added to anything: it carries
   * percentages and reset instants, no money and no tokens.
   */
  plan: PlanUsage | null;
}

export function buildSnapshot(
  entries: UsageEntry[],
  limits: LimitConfig,
  now = Date.now(),
  sessionResetAt: number | null = null,
  plan: PlanUsage | null = null,
  /**
   * Which agent names this install has a definition for, or null to leave the
   * question unasked.
   *
   * An argument rather than a read, `normalizeWorkflowInput`'s shape and its
   * reason: this module knows nothing about the registry or the filesystem, and
   * the one caller that renders the answer (`/api/usage`) is not the one that
   * calls this before every work cycle. The orchestrator passes nothing, so its
   * guard path costs neither a SQLite read nor a directory walk per cycle — and
   * nothing it reads has an `origin` on it to be wrong about.
   */
  agentNames: AgentOriginIndex | null = null,
): UsageSnapshot {
  // The provider's own reset instant outranks the operator's, because
  // `sessionResetOverrideAt` exists only as a way to hand-correct a boundary
  // this app could not observe. Now that it can be observed, a stale typed
  // value must not keep splitting blocks against a window that has moved.
  const effectiveReset = plan?.session?.resetsAt ?? sessionResetAt;

  const blocks = buildSessionBlocks(entries, now, effectiveReset);
  const activeBlock = blocks.find((b) => b.isActive) ?? null;
  const anchor = anchorOf(effectiveReset);
  // Live only until the reset it names; a stale value keeps splitting history
  // but must never re-open a window that has already rolled over.
  const anchorIsCurrent =
    anchor !== null && anchor <= now && now < anchor + FIVE_HOURS_MS;

  const makeWindow = (
    label: string,
    startsAt: number,
    endsAt: number,
    agg: Aggregate,
    costLimit: number | null,
    tokenLimit: number | null,
    planWindow: PlanWindow | null,
    /** Worst of every wall on this window; defaults to the window's own. */
    planGuard: number | null = null,
  ): WindowState => {
    const derived = buildWindow(startsAt, endsAt, agg, costLimit, tokenLimit);
    const planFraction = planWindow ? planWindow.utilization : null;

    // The derived readings survive either way: `costFraction`/`tokenFraction`
    // are what the "your configured ceiling says otherwise" footnote is drawn
    // from, so the provider's figure displaces them at `fraction` without
    // overwriting them.
    if (planFraction === null) return { label, ...derived, planFraction: null };

    return {
      label,
      ...derived,
      planFraction,
      fraction: planFraction,
      fractionMetric: "plan",
      // The worst of every reading of this window, and the third operand is
      // the one that is easy to leave out. The provider's percentage is
      // *cached* — `planUsage.ts` refreshes it at most every five minutes and
      // keeps serving the last good one for up to an hour while requests are
      // being refused — so with several runs sharing one account every cycle
      // that starts inside a refresh interval is authorised by the identical
      // frozen number, and the window can be walked from under the guard to
      // over it without the guard ever seeing a figure that moved. The derived
      // reading is recomputed from the transcripts on every single guard, so it
      // is the only evidence here that is current, and taking the maximum is
      // what lets it *raise* the guard without ever lowering it. It does carry
      // the unpriced-model markup, which is a deliberate over-estimate — that
      // is the safe direction for the number a run is stopped on, and it stays
      // out of `fraction`, which is what the meter shows.
      guardFraction: Math.max(
        planFraction,
        planGuard ?? 0,
        derived.guardFraction ?? 0,
      ),
      // Nothing to describe: the provider names a percentage, not a ceiling.
      limit: null,
      limitMetric: "plan",
    };
  };

  // With no block open and no live override, no window is running: what is
  // reported is the one the next turn would open, which starts when that turn
  // happens. `now` is the only honest stand-in — anything earlier would claim a
  // window is already part-spent.
  const sessionStart = activeBlock
    ? activeBlock.startsAt
    : anchorIsCurrent
      ? anchor
      : now;
  const sessionAgg = activeBlock ? activeBlock.agg : ZERO_AGGREGATE;

  // Same precedence as the session reset, and it retires the same guess: with
  // no `weeklyAnchor` configured this window has no reset instant at all and
  // reports a trailing total, which is a different window from the one the
  // provider is enforcing. Its reset instant makes them the same window.
  const planWeeklyReset = plan?.weekly?.resetsAt ?? null;
  const wkStart =
    planWeeklyReset !== null
      ? planWeeklyReset - WEEK_MS
      : weekStart(now, limits.weeklyAnchor);
  const wkEnd =
    planWeeklyReset !== null
      ? planWeeklyReset
      : limits.weeklyAnchor
        ? wkStart + WEEK_MS
        : now;
  const weekEntries = entries.filter((e) => e.ts >= wkStart);
  const weeklyAgg = aggregate(weekEntries);

  const session = makeWindow(
    "5-hour session",
    sessionStart,
    sessionStart + FIVE_HOURS_MS,
    sessionAgg,
    limits.sessionCostLimit,
    limits.sessionTokenLimit,
    plan?.session ?? null,
  );

  const weekly = makeWindow(
    planWeeklyReset !== null || limits.weeklyAnchor
      ? "Weekly quota"
      : "Trailing 7 days",
    wkStart,
    wkEnd,
    weeklyAgg,
    limits.weeklyCostLimit,
    limits.weeklyTokenLimit,
    plan?.weekly ?? null,
    plan ? Math.max(0, ...plan.scopedWeekly.map((s) => s.window.utilization)) : null,
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

  const byModel = groupBy(weekEntries, (e) => e.model).map(({ key, agg }) => ({
    model: key,
    agg,
  }));
  const byProject = groupBy(weekEntries, (e) => e.project || "(unknown)").map(
    ({ key, agg }) => ({ project: key, agg }),
  );

  // Attribution Claude Code already records on every turn. Turns with no
  // sub-agent or skill get an explicit bucket rather than being dropped, so
  // the rows still add up to the window total and a large "(main thread)"
  // share reads as the fact it is instead of a gap in the data.
  // The bucket key stays the name the CLI recorded, always. `origin` says where
  // this install found a definition for that name, which is a fact about the
  // registry rather than about the turn — renaming a saved agent moves no spend
  // between rows, it only stops the annotation matching.
  const byAgent = groupBy(weekEntries, (e) => e.agent ?? MAIN_THREAD_BUCKET).map(
    ({ key, agg }) => ({ agent: key, agg, origin: agentOrigin(key, agentNames) }),
  );
  const bySkill = groupBy(weekEntries, (e) => e.skill ?? "(no skill)").map(
    ({ key, agg }) => ({ skill: key, agg }),
  );
  const byEffort = groupBy(weekEntries, (e) => e.effort ?? "(unspecified)").map(
    ({ key, agg }) => ({ effort: key, agg }),
  );

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
    byAgent,
    bySkill,
    byEffort,
    totalCostUSD: entries.reduce((s, e) => s + e.costUSD, 0),
    plan,
  };
}

/* ------------------------------------------------------------------ */
/* Calendar periods                                                    */
/* ------------------------------------------------------------------ */

/**
 * A history of spend cut into calendar buckets, which is a different question
 * from the two windows above and deliberately kept apart from them.
 *
 * The windows answer "may I start a run right now"; these answer "what has this
 * been costing me". Nothing here reaches `evaluateBudget` — see the note on
 * `spanLimit` for why a day and a month can carry a percentage at all when
 * Anthropic enforces no allowance over either.
 */
export type PeriodGranularity = "day" | "week" | "month";

/**
 * How far back each granularity looks. A fortnight of days, a quarter of weeks,
 * a year of months — enough to see a trend in each without the card becoming
 * the page. Buckets older than the first recorded turn are dropped before this
 * count is met, so a fresh install shows what it has rather than eleven empty
 * months above one real one.
 */
export const PERIOD_COUNT: Record<PeriodGranularity, number> = {
  day: 14,
  week: 12,
  month: 12,
};

export interface PeriodBucket {
  /** Stable React key: a boundary instant is not unique across granularities. */
  key: string;
  startsAt: number;
  /** Exclusive, and always the next bucket's `startsAt`. */
  endsAt: number;
  costUSD: number;
  tokens: number;
  entryCount: number;
  /** Share of the ceiling for a period this long. Null when none is configured. */
  fraction: number | null;
  fractionMetric: "cost" | "tokens" | null;
  /** The same reading with unpriced models charged the fallback rate. */
  guardFraction: number | null;
  limit: number | null;
  /** True for the bucket `now` falls in — it is still filling. */
  isCurrent: boolean;
}

export interface PeriodSeries {
  granularity: PeriodGranularity;
  /** IANA zone the calendar boundaries were cut in. */
  timeZone: string;
  /**
   * How the ceiling behind `fraction` was arrived at, so the card can say it.
   * Null when no weekly ceiling is configured and every bucket reads unknown.
   */
  limitBasis: "weekly" | "prorated" | null;
  /** Newest first. */
  buckets: PeriodBucket[];
}

/** Cached per zone: `formatToParts` is called once per boundary, not per entry. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(ts: number, timeZone: string): ZonedParts {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(ts));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // `hourCycle: "h23"` is requested above; the modulo is the belt to its
    // braces, because some ICU builds still render midnight as hour 24 and
    // that would push every boundary a day forward.
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Milliseconds `timeZone` is ahead of UTC at `ts`. */
export function zoneOffset(ts: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ts
  );
}

/**
 * Epoch ms of local midnight on a calendar date in `timeZone`.
 *
 * Two passes, because the offset depends on the instant being solved for: the
 * first guess reads the offset at the same wall time in UTC, which is an hour
 * out across a DST change, and the second reads it at the instant that guess
 * produced. On a spring-forward day whose local midnight does not exist this
 * lands an hour to one side of it — harmless here, because a bucket's end is
 * taken from the next bucket's start rather than computed, so the series stays
 * contiguous whatever this returns.
 */
function zonedMidnight(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(first, timeZone);
}

/**
 * The `count` most recent period starts, oldest first, followed by the end of
 * the newest — so `bounds[i]`/`bounds[i + 1]` is bucket `i` and no gap can open
 * between two buckets.
 */
function periodBoundaries(
  granularity: PeriodGranularity,
  count: number,
  now: number,
  timeZone: string,
  weeklyAnchor: WeeklyAnchor | null,
): number[] {
  // With an anchor configured the operator has said when their week rolls over,
  // and the newest bucket has to be the same seven hours-to-the-minute as the
  // weekly meter directly above it on the page — a calendar Monday would put a
  // different total under the same word.
  if (granularity === "week" && weeklyAnchor) {
    const current = weekStart(now, weeklyAnchor);
    const out: number[] = [];
    for (let i = count - 1; i >= 0; i--) out.push(current - i * WEEK_MS);
    out.push(current + WEEK_MS);
    return out;
  }

  const p = zonedParts(now, timeZone);

  if (granularity === "month") {
    const out: number[] = [];
    // Down to -1, so the last boundary is the *next* month's first and the
    // newest bucket is the month in progress rather than the one before it.
    for (let i = count - 1; i >= -1; i--) {
      // Normalised through a UTC date so December rolls the year rather than
      // producing month 13.
      const d = new Date(Date.UTC(p.year, p.month - 1 - i, 1));
      out.push(
        zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, timeZone),
      );
    }
    return out;
  }

  // A day and an anchorless week both step whole local days back from a local
  // midnight. The weekday is read off the *zoned* date, or a Sunday evening in
  // a positive offset would be treated as the Monday that follows it.
  const step = granularity === "week" ? 7 : 1;
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const intoWeek = granularity === "week" ? (weekday + 6) % 7 : 0; // ISO: Monday opens
  const first = intoWeek + step * (count - 1);

  const out: number[] = [];
  for (let i = 0; i <= count; i++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day - first + i * step));
    out.push(
      zonedMidnight(
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate(),
        timeZone,
      ),
    );
  }
  return out;
}

/**
 * The ceiling a bucket of length `spanMs` is measured against.
 *
 * Anthropic enforces a 5-hour window and a weekly one and nothing in between,
 * so the weekly ceiling is the only configured number a calendar bucket can be
 * compared with at all. A week uses it as it stands; a day and a month get it
 * spread evenly over their own length. That is a *rate*, not a published
 * allowance — which is why `PeriodSeries.limitBasis` travels with it and the
 * card says so in words. It is still derived from a number the operator typed,
 * which is what separates it from the invented ceilings `DEFAULTS` refuses to
 * carry, and no guard reads it: `evaluateBudget` never sees a period.
 */
function spanLimit(weeklyLimit: number | null, spanMs: number): number | null {
  if (weeklyLimit === null || spanMs <= 0) return null;
  return weeklyLimit * (spanMs / WEEK_MS);
}

/**
 * Whether this build's ICU knows `name` as a zone.
 *
 * Split out of `resolveTimeZone` because the two callers want opposite things
 * from an unknown name. A calendar bucket falls back to the server's zone — a
 * day cut an hour out is a display error the operator can see and correct. A
 * *schedule* refuses, because nobody is watching when it fires and an hour out
 * is an hour out for the life of the schedule.
 */
export function isTimeZone(name: string): boolean {
  if (!name || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * A timezone name from the wire, or the server's own when it is absent or not
 * a zone this build's ICU knows.
 *
 * Calendar buckets cut in the wrong zone are wrong at every edge — an evening
 * turn in CEST lands on the following UTC day, and the container runs in UTC —
 * so the browser sends the zone it is displaying in and this rejects anything
 * that is not one.
 */
export function resolveTimeZone(requested: string | null | undefined): string {
  if (requested && isTimeZone(requested)) return requested;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Roll entries into calendar buckets of one granularity.
 *
 * Separate from `buildSnapshot` rather than folded into it because the
 * orchestrator calls that on a ticker — once before every work cycle and again
 * every `liveGuardIntervalSeconds` while one is in flight — and none of this
 * feeds a guard decision. Only `/api/usage` pays for it.
 */
export function buildPeriods(
  entries: UsageEntry[],
  granularity: PeriodGranularity,
  limits: LimitConfig,
  now = Date.now(),
  timeZone = "UTC",
): PeriodSeries {
  const count = PERIOD_COUNT[granularity];
  const bounds = periodBoundaries(
    granularity,
    count,
    now,
    timeZone,
    limits.weeklyAnchor,
  );

  // Entries arrive time-sorted (`scanUsage` sorts them), so one cursor walks
  // the whole history into the buckets in a single pass.
  let cursor = 0;
  while (cursor < entries.length && entries[cursor].ts < bounds[0]) cursor++;

  const buckets: PeriodBucket[] = [];
  for (let i = 0; i < count; i++) {
    const startsAt = bounds[i];
    const endsAt = bounds[i + 1];
    const slice: UsageEntry[] = [];
    while (cursor < entries.length && entries[cursor].ts < endsAt) {
      slice.push(entries[cursor]);
      cursor++;
    }

    const agg = aggregate(slice);
    const span = endsAt - startsAt;
    const w = buildWindow(
      startsAt,
      endsAt,
      agg,
      spanLimit(limits.weeklyCostLimit, span),
      spanLimit(limits.weeklyTokenLimit, span),
    );

    buckets.push({
      key: `${granularity}:${startsAt}`,
      startsAt,
      endsAt,
      costUSD: w.costUSD,
      tokens: w.tokens,
      entryCount: agg.entryCount,
      fraction: w.fraction,
      fractionMetric: w.fractionMetric,
      guardFraction: w.guardFraction,
      limit: w.limit,
      isCurrent: now >= startsAt && now < endsAt,
    });
  }

  // A bucket that closed before the first transcript was written is not "$0.00
  // spent", it is a period with nothing recorded — and eleven of those push the
  // months that do have data off the bottom of the card.
  const firstTs = entries.length ? entries[0].ts : now;
  const recorded = buckets.filter((b) => b.endsAt > firstTs);

  return {
    granularity,
    timeZone,
    limitBasis: recorded.some((b) => b.limit !== null)
      ? granularity === "week"
        ? "weekly"
        : "prorated"
      : null,
    buckets: recorded.reverse(),
  };
}
