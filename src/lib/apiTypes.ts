/**
 * Wire shapes shared between the API routes and the client.
 *
 * Declared here rather than imported from the server modules so that a client
 * component never transitively pulls `node:fs` into the browser bundle.
 */

export interface TokenCountsDTO {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface AggregateDTO {
  tokens: TokenCountsDTO;
  costUSD: number;
  /** Guard-only cost: unpriced models charged a fallback rate. Never rendered. */
  costGuardUSD: number;
  entryCount: number;
}

export interface WindowStateDTO {
  label: string;
  startsAt: number;
  endsAt: number;
  agg: AggregateDTO;
  tokens: number;
  costUSD: number;
  fraction: number | null;
  fractionMetric: "plan" | "cost" | "tokens" | null;
  /**
   * What Anthropic itself reports for this window, 0–1.
   *
   * Present whenever the provider answered, and then it *is* `fraction` — a
   * measured percentage outranks one derived from a typed ceiling. Null falls
   * back to the derived readings below.
   */
  planFraction: number | null;
  costFraction: number | null;
  tokenFraction: number | null;
  /**
   * What the budget guard compares. Equals `fraction` unless the window holds
   * a model with no known price, in which case it is higher — the dashboard
   * draws the gap so the guard's stricter view is visible rather than
   * surprising.
   */
  guardFraction: number | null;
  limit: number | null;
  limitMetric: "plan" | "tokens" | "cost" | null;
}

/** Mirror of `PlanWindow` in `windows.ts`. */
export interface PlanWindowDTO {
  utilization: number;
  resetsAt: number | null;
}

/** Mirror of `PlanUsage` in `windows.ts`. */
export interface PlanUsageDTO {
  session: PlanWindowDTO | null;
  weekly: PlanWindowDTO | null;
  scopedWeekly: Array<{ label: string; window: PlanWindowDTO }>;
  fetchedAt: number;
}

/**
 * Mirror of `AgentOrigin` in `windows.ts` — where the definition behind an
 * agent bucket lives, as far as this install can see.
 *
 * It annotates a transcript-derived bucket and never moves one: the rollup is
 * the CLI's own `attributionAgent` through the same `groupBy` as every other
 * column, so the rows still reconcile to the window total whatever this says.
 */
export type AgentOriginDTO =
  | "main"
  | "registry"
  | "ambient"
  | "both"
  | "unknown";

/** Mirror of `ToolCompositionRow` in `toolComposition.ts`. Never money. */
export interface ToolCompositionRowDTO {
  tool: string;
  calls: number;
  /** Characters of text this tool's results placed into a context. */
  resultChars: number;
  /** Share of `totalResultChars`, 0–1. */
  share: number;
}

/**
 * Mirror of `ToolComposition` — what filled the contexts, and what filling one
 * costs.
 *
 * **Not a cost source and never summed with one.** The five breakdowns beside
 * it on `SnapshotDTO` reconcile to the window total because every turn lands in
 * exactly one bucket; this cannot, because a `tool_result` is not a billable
 * turn and carries no usage block at all. Its rows are denominated in
 * characters and carry no dollar figure by construction, and the three
 * placement figures are **rates** — a price per million tokens placed and a
 * re-read multiple — so there is nothing here that could be added to a bill
 * even by accident. The argument in full is on `toolComposition.ts`.
 */
export interface ToolCompositionDTO {
  from: number;
  rows: ToolCompositionRowDTO[];
  totalCalls: number;
  totalResultChars: number;
  /** Calls with no result recorded — interrupted, or answered in a file we could not read. */
  unansweredCalls: number;
  /** Tokens that entered a context in this window, counted once each. */
  placedTokens: number;
  /** How many times the average placed token was read back. Null when none was. */
  reReadRatio: number | null;
  /** The window's whole bill over the tokens placed into it. Null when none was. */
  costPerMillionPlacedUSD: number | null;
}

export interface SessionBlockDTO {
  startsAt: number;
  endsAt: number;
  lastActivityAt: number;
  isActive: boolean;
  agg: AggregateDTO;
  models: string[];
  projects: string[];
}

export interface SnapshotDTO {
  now: number;
  session: WindowStateDTO;
  weekly: WindowStateDTO;
  blocks: SessionBlockDTO[];
  burnTokensPerHour: number;
  burnCostPerHour: number;
  projectedExhaustionAt: number | null;
  byModel: Array<{ model: string; agg: AggregateDTO }>;
  byProject: Array<{ project: string; agg: AggregateDTO }>;
  byAgent: Array<{
    agent: string;
    agg: AggregateDTO;
    /** Null when nothing looked the names up — not the same as `unknown`. */
    origin: AgentOriginDTO | null;
    /**
     * The same recorded turns repriced at `counterfactualModel`'s rates, or
     * null when nobody asked.
     *
     * A counterfactual over the tokens that were actually produced, **not** a
     * forecast: the same task on a smaller model may take more turns, and this
     * figure does not know that. Anything rendering it has to say so.
     */
    counterfactualUSD: number | null;
  }>;
  bySkill: Array<{ skill: string; agg: AggregateDTO }>;
  byEffort: Array<{ effort: string; agg: AggregateDTO }>;
  /** Which model the counterfactual above was priced at. Null when none was. */
  counterfactualModel: string | null;
  /** A composition reading, never a cost source — see `ToolCompositionDTO`. */
  byTool: ToolCompositionDTO;
  totalCostUSD: number;
  /** The provider's own reading, when it answered. Never a cost. */
  plan: PlanUsageDTO | null;
}

export type PeriodGranularityDTO = "day" | "week" | "month";

/**
 * One calendar period's spend.
 *
 * Leaner than `WindowStateDTO` on purpose: three series ship on every poll of a
 * page that already re-reads the whole snapshot on every poll, and the
 * per-bucket token *breakdown* is the half of an `AggregateDTO` nothing on this
 * card renders.
 */
export interface PeriodBucketDTO {
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
  guardFraction: number | null;
  limit: number | null;
  /** The bucket `now` falls in. It is still filling, so its share is partial. */
  isCurrent: boolean;
}

export interface PeriodSeriesDTO {
  granularity: PeriodGranularityDTO;
  /** IANA zone the boundaries were cut in — the browser's, echoed back. */
  timeZone: string;
  /**
   * Where a bucket's ceiling came from. `weekly` is the configured weekly
   * ceiling used as it stands; `prorated` is that ceiling spread evenly over a
   * period Anthropic publishes no allowance for, which the card has to say out
   * loud. Null when no weekly ceiling is set at all.
   */
  limitBasis: "weekly" | "prorated" | null;
  /**
   * Epoch ms before which this history may be incomplete — the transcript
   * retention horizon, when a bucket on screen starts before it. Null when
   * nothing shown is affected, which includes retention being switched off.
   */
  completeFrom: number | null;
  /** Newest first. Shorter than the granularity's span when history is. */
  buckets: PeriodBucketDTO[];
}

/**
 * One thing the boot found wrong with the environment this process was given.
 *
 * The client mirror of `ConfigProblem` in `configCheck.ts`, which imports
 * `node:fs` and so cannot be reached from a `"use client"` file.
 */
export interface ConfigProblemDTO {
  severity: "refuse" | "warn";
  variable: string;
  message: string;
}

/**
 * What confines a tool call below the uid it runs as.
 *
 * Four readings rather than a boolean, because two of them are the ways a
 * sandbox lies about itself and both must be sayable on the page: `empty` is a
 * policy that is switched on and names nothing, which runs every command
 * unwrapped, and `unknown` is a policy file that could not be read, which is not
 * evidence of absence. `none` is the stock install and is the honest word for
 * it. The client mirror of `sandbox.ts`, which imports `node:fs`.
 */
export type SandboxStateDTO = "none" | "on" | "empty" | "unknown";

/**
 * What a `sandbox` run event's matched text says happened.
 *
 * Here rather than beside the matcher because the log renders it and
 * `sandbox.ts` imports `node:fs`. Every one is a sandbox that is not working;
 * `sandbox.ts` says why a policy *denial* is not in the list.
 */
export type SandboxRefusalKindDTO =
  | "seccomp-unavailable"
  | "sandbox-unavailable"
  | "dependency-missing"
  | "bwrap-failed"
  | "sandbox-message";

export interface SandboxDTO {
  state: SandboxStateDTO;
  /** The whole sentence, in words an operator can check against the file. */
  detail: string;
  /**
   * Whether the CLI refuses to start rather than running unsandboxed. Null when
   * nothing asked for a sandbox, since there is then no such promise to report.
   */
  failIfUnavailable: boolean | null;
}

/**
 * What context pruning was worth over a span — netted, never gross.
 *
 * **Not a cost source and never summed with a window's spend.** It is the value
 * of an intervention: `cacheSavedUSD` is re-reads that demonstrably did not
 * happen, and `invalidationUSD` is what buying that cost. Adding either to a
 * meter would be adding a counterfactual to a measurement.
 *
 * `tokensRemoved` counts only what was actually being sent — `message` content,
 * never the transcript's bytes. The two differ by about 3.4× here, because most
 * of what the tool removes is an envelope the CLI writes and never transmits.
 *
 * `pricedPrunes` below `prunes` means the money covers only part of what is
 * described: a run on a model with no price here contributes tokens and no
 * dollars, and rendering that gap is the difference between an incomplete total
 * and a wrong one.
 */
export interface PruneSavingsDTO {
  prunes: number;
  pricedPrunes: number;
  /**
   * Priced prunes whose invalidation cost has not been settled yet.
   *
   * These contribute $0 to `invalidationUSD`, so a total carrying them is an
   * **upper bound** on the net rather than a measurement of it. Render the count
   * whenever it is non-zero: the alternative is a page reporting a saving it has
   * not finished checking, which is exactly the failure the panel's own docblock
   * accuses every other tool of.
   */
  unsettledPrunes: number;
  tokensRemoved: number;
  /**
   * Total turns the savings are measured over, summed across prunes.
   *
   * A total of turn-savings rather than a count of distinct turns — two prunes
   * on one run each earned over their own tail, and the second's tail is inside
   * the first's. Render it beside the money as what the measurement spans, never
   * as "the run took this many turns".
   */
  turnsAfter: number;
  cacheSavedUSD: number;
  invalidationUSD: number;
  netUSD: number;
}

/**
 * Which engine is configured, and whether the tool behind it is here.
 *
 * `FilterSavingsDTO`'s `running`/`ledger` split, one mechanism over. The pruner
 * half of the context-control card carried arithmetic and no state, so an image
 * built with `WINNOW_REF=` empty rendered a byte-identical dashboard while every
 * prune no-opped.
 *
 * Three readings and not a boolean, because one of them is the way an install
 * lies about itself: `unavailable` is pruning switched **on** with no tool
 * behind it, and it is the only one of the three drawn as a fault.
 *
 * `engine` is what is configured **now**, and it may never be printed as a
 * label on money. `pricedCuts` unions both engines' tables deliberately, so
 * every figure on these screens is a blend — naming one for the current setting
 * would attribute one engine's earnings to the other the moment the switch
 * moved.
 */
export type PrunerStateDTO = "off" | "unavailable" | "ready";

export interface ContextPrunerDTO {
  state: PrunerStateDTO;
  engine: "legacy" | "winnow";
  /**
   * The server's own sentence for `unavailable`, null otherwise.
   *
   * The server's and not the page's: it is the same string the run log carries,
   * from the same constant, and a second copy authored in a component is a
   * second thing to keep true.
   */
  detail: string | null;
  /** Seconds of quiet the fork engine needs. Null under the edit-in-place engine. */
  minColdAgeSeconds: number | null;
}

/**
 * What the pruner did at the cycle boundaries inside one span.
 *
 * **Event counts, never money, and never summed with anything on
 * `PruneSavingsDTO`.** They exist because five different outcomes at a boundary
 * — a cut, a payback decline, nothing worth removing, a fork refusal, a missing
 * tool — all rendered as the same absent section, which reads as "pruning never
 * ran" for a run winnow was spawned at every cycle of.
 *
 * The six outcome counts sum to `boundaries` exactly, and that is what makes the
 * sentence built from them checkable: a breakdown that did not add up would be a
 * filter dropping rows with nothing saying what it left out.
 *
 * An early end counts as a boundary, because it manufactures one.
 */
export interface PruneActivityDTO {
  boundaries: number;
  cut: number;
  nothing: number;
  declined: number;
  refused: number;
  unavailable: number;
  failed: number;
  /** Newest non-cut `detail`, server-written; null when every boundary cut. */
  lastDetail: string | null;
}

/**
 * Which measure a context sample was taken in.
 *
 * `api` is `apiContextTokens` — the whole prompt as the API was billed for it,
 * and the same basis the cycle ceiling acts on. `transcript` is the byte
 * estimate that reading falls back to when the conversation holds no usable
 * `usage` frame yet, which is a different quantity rather than a rougher one:
 * the two are tens of thousands of tokens apart **in either direction** on this
 * install, since the prompt carries a system prompt and tool list no transcript
 * holds while the intake filter drops tool results the transcript keeps.
 *
 * On the wire so a consumer can see a basis change for what it is. A series that
 * silently mixed the two would draw a step where only the measure moved, and
 * every arithmetic across that step would be wrong in a way that typechecks.
 */
export type ContextSampleBasisDTO = "api" | "transcript";

/** One reading of how full a run's context was. */
export interface ContextSampleDTO {
  ts: number;
  /** The work cycle in flight when it was taken, 1-based. */
  iteration: number;
  tokens: number;
  basis: ContextSampleBasisDTO;
  /**
   * Main-thread assistant turns behind this reading — a sub-agent's turns and
   * the CLI's `<synthetic>` refusal frames are not this conversation's context
   * and do not advance it.
   */
  turnIndex: number;
  /**
   * False when `turnIndex` is a **floor** rather than a count: the scan behind
   * it is bounded at a megabyte of transcript, so a run whose first sample
   * landed on a larger conversation cannot know what preceded it. Render the
   * distinction or render neither — a floor drawn as an axis is a graph that
   * states a number it does not have.
   */
  turnsExact: boolean;
}

/**
 * The last time the live-guard tick read a run's transcript, whatever it found.
 *
 * Separate from the newest sample, and that separation is the point. Samples are
 * deduplicated on the `usage` frame they came from, so the series only gains a
 * point when the run's **main thread** finishes another request — and a run that
 * has spent twenty minutes inside one sub-agent, whose frames this measure
 * excludes, has a newest sample twenty minutes old and a figure that is
 * nonetheless current. Labelling the sample's own timestamp as "read Xm ago" put
 * that on screen as a stalled poll, which is the one reading it must not have:
 * an operator who cannot tell "nothing has changed" from "nothing is looking"
 * has no indicator at all.
 *
 * Held in memory rather than in a row, because it describes the *process* that
 * is doing the reading and not the run: a server that has just restarted has not
 * looked at anything yet, however recently the run it inherited was read by the
 * server before it. Null until the first tick of this process, and the caller
 * then has nothing to claim.
 */
export interface ContextCheckDTO {
  ts: number;
  /**
   * What that read found — `unreadable` when the transcript could not be read at
   * all, which is a different statement from a reading that has not moved and is
   * the one an operator must not see as freshness.
   */
  basis: ContextSampleBasisDTO | "unreadable";
}

/**
 * One node below a provenance — the tool or attachment class, then the artefact.
 *
 * The tree `winnow context --depth 3` draws, minus its top level, which is
 * `ContextCompositionSliceDTO`. **Not a band.** The stacked area is one band per
 * provenance and these are what one band is made of, for a detail view that
 * answers a different question of the same reading.
 */
export interface ContextCompositionNodeDTO {
  /**
   * Winnow's own key. The `×N` it composes onto an artefact it saw more than
   * once is **not** here — it is `repeat`, so that a view sorting by path is not
   * sorting by how many times, and one that renders the label as a path is not
   * printing a count inside it.
   */
  label: string;
  tokens: number;
  /** `exact` | `derived` | `estimated` | `residual`, as winnow reported it. */
  kind: string;
  /**
   * How many times winnow saw this artefact, or null where it attached no count
   * — which it does for every node above the artefact level and for an artefact
   * seen once. Null is "winnow said nothing", never "once".
   */
  repeat: number | null;
  /** The level below, empty at the deepest level the reading was taken at. */
  children: ContextCompositionNodeDTO[];
}

/**
 * One provenance's share of one reading of the window — `winnow context`, depth 3.
 *
 * `kind` is winnow's own word for how the figure was reached and is carried
 * rather than dropped, because a stacked band cannot show it: `prefix` is a
 * subtraction of two exact readings, `tool traffic` is characters over a
 * constant, and `unattributed` is what nothing accounted for. A picture that
 * drew all three the same way would claim a precision only one of them has.
 */
export interface ContextCompositionSliceDTO {
  /** Winnow's own label, passed through — never mapped to a closed set here. */
  label: string;
  tokens: number;
  /** `exact` | `derived` | `estimated` | `residual`, as winnow reported it. */
  kind: string;
  /**
   * What this provenance is made of, and **only on the newest reading** —
   * `ContextOccupancyDTO.composition`'s last entry, and empty on every other.
   *
   * An older reading's empty `children` is not a statement that its window held
   * no tool traffic. The tree is stored for one reading per run and replaced on
   * each, because a tree per reading is a row per path per reading per run and
   * nothing caps how many distinct files a run touches. Read it as "what is in
   * this window now", which is the question it can answer, and never as a
   * series — the bands above are the series.
   */
  children: ContextCompositionNodeDTO[];
}

/**
 * What one run's context was made of at one moment.
 *
 * **A second measure of the same window, and it may not be subtracted from the
 * samples.** `window` is winnow's own total, anchored on the last priced
 * request in the transcript whatever wrote it; `ContextSampleDTO.tokens` is
 * anchored on the last *main-thread* frame, sidechains excluded. The two agree
 * on an idle conversation and come apart for as long as a sub-agent runs — 22
 * minutes, measured on this install — so the slices are drawn against `window`
 * and against nothing else.
 *
 * `slices` sum to `window` by construction: the residual is one of them. Their
 * `children` do **not** sum to their parent, and are not meant to: a node
 * unreadable at the parse and a tail past the per-node cap are both dropped
 * rather than pooled into a manufactured bin, so a subtree that falls short is
 * saying so out loud.
 */
export interface ContextCompositionDTO {
  ts: number;
  /** The work cycle in flight when it was taken, 1-based. */
  iteration: number;
  window: number;
  slices: ContextCompositionSliceDTO[];
}

/** A cut, on the same axis as the samples, so a fall in context has a cause. */
export interface ContextPruneMarkDTO {
  ts: number;
  /** `boundary` or `early-end`; only the second manufactured its own moment. */
  trigger: string;
  /** In `contextTokens`, which is **not** the samples' basis — see `tokens`. */
  tokensRemoved: number;
}

/**
 * How full one run's context has been, over the run's life.
 *
 * **Not spend and not a meter.** It is an occupancy reading, sampled off the
 * live-guard tick at whatever cadence `liveGuardIntervalSeconds` runs at, and
 * deduplicated on the `usage` frame it came from — so the gaps between points
 * are the conversation's own turns rather than a fixed interval, and two points
 * far apart in time mean one long tool call rather than missing data. That is
 * what `lastCheck` exists to say out loud: the tick's own cadence, carried
 * beside a series whose cadence is the conversation's.
 *
 * `ceilingTokens` travels with the series because the constant behind it has
 * already moved twice; a consumer computing a percentage against a hardcoded
 * 200,000 would go on drawing the old number after the next move, silently.
 *
 * `sampleCount` and `pruneCount` are the **stored** totals. Either one greater
 * than its array's length means the array is the newest tail of something
 * longer — a tail rather than a thinned series, because thinning needs a rule
 * about which points survive and a series thinned by a rule the reader cannot
 * see misstates its own peaks.
 *
 * `prunes[].tokensRemoved` is in `contextTokens` and `samples[].tokens` is in
 * `apiContextTokens`. **They may not be subtracted from one another** — the
 * marks say *when* a cut happened, never how far the series should fall.
 */
export interface ContextOccupancyDTO {
  ceilingTokens: number;
  samples: ContextSampleDTO[];
  sampleCount: number;
  prunes: ContextPruneMarkDTO[];
  pruneCount: number;
  /**
   * When this run's transcript was last *read*, which is not when the series
   * last gained a point — see `ContextCheckDTO`. Render the age of this and the
   * age of the newest sample as two different facts, or the routine case of a
   * long tool call reads as a poll that has died.
   */
  lastCheck: ContextCheckDTO | null;
  /**
   * What the window was made of, over the same span — oldest first, empty when
   * nothing has read it.
   *
   * Its cadence is **not** the samples': a reading costs a winnow subprocess,
   * so it is paced by the conversation's growth rather than by the tick, and it
   * is taken only where context pruning is switched on — read-only is not the
   * same as permitted, which is the rule `observePlan` already follows. So a
   * dense sample series beside a sparse composition is the ordinary case, and
   * an empty one is an operator who turned the feature off rather than a fault.
   */
  composition: ContextCompositionDTO[];
  /**
   * Stored readings, where `composition.length` is what was returned. Greater
   * than it means the array is the newest tail — a tail rather than a thinning,
   * on `sampleCount`'s rule.
   */
  compositionCount: number;
  /**
   * Why there is no composition, or null when there is one — `off` when context
   * pruning is switched off and winnow is deliberately not spawned, `pending`
   * when it is on and nothing has been read yet. Two blanks that look identical
   * on the page and have opposite fixes.
   */
  compositionAbsence: "off" | "pending" | null;
}

/**
 * The netted arithmetic over one span — the whole reading, or one of the two
 * windows inside it. Every field here answers "over this span"; the ones on
 * `FilterSavingsDTO` describe the reading itself and have no span.
 */
export interface FilterWindowDTO {
  /**
   * Distinct results, never ledger lines. The filter is stateless and re-drops
   * the same result on every request that still carries it — summing the lines
   * overstated this install by 24.8×.
   */
  results: number;
  /** How many of those the money covers; the rest ran on a model with no price here. */
  pricedResults: number;
  /**
   * Results seen only as `deferred` and therefore excluded from every figure
   * above. The filter moves the cache breakpoint in front of the newest match
   * instead of replacing it, and that move fails silently when the request
   * already holds the maximum number of breakpoints — so these are results this
   * app cannot prove escaped the cache, which makes the total a floor.
   */
  deferredOnly: number;
  /** How many were identified by `(session, tool, rule, bytes)` for want of a `tool_use_id`. */
  fallbackKeyed: number;
  tokensRemoved: number;
  /** Turns the read saving is measured over, summed across results. */
  turnsAfter: number;
  cacheWriteAvoidedUSD: number;
  uncachedSendUSD: number;
  cacheReadAvoidedUSD: number;
  netUSD: number;
}

/**
 * What winnow's intake filter kept off the wire — the second half of context
 * control, and the one that acts first.
 *
 * **Not a cost source and never summed with a meter**, on `PruneSavingsDTO`'s
 * rule: the meters are priced from `usage` frames, which are the API's report
 * of the request the filter had already rewritten, so this money is a
 * counterfactual — the same work without the filter — and is already absent
 * from every figure it sits next to.
 *
 * **It is added to `PruneSavingsDTO` in exactly one place**, the
 * context-control card, where the two are the halves of one intervention and
 * the question the card answers is what the intervention was worth. The sum
 * overstates, because the two overlap by construction: winnow's C1, C3 and B2
 * rules fire in both mechanisms, and the filter takes that mass first because
 * it sees the request before the transcript is written, so a prune that then
 * removes the same result counts tokens the API never held. Measured at 4.06%
 * of pruned tokens across this install's ten largest transcripts, and an upper
 * bound. Correcting it needs a `tool_use_id` on each ledger line that winnow
 * does not write yet, so until then the card prints the overlap rather than
 * implying the halves are disjoint — and nothing else adds them.
 *
 * The three money fields are the arithmetic rather than its result: `2.0·D`
 * saved on the cache write, `1.0·D` still paid to send it once uncached, and
 * `0.1·D·T` saved on reads that never happened. There is no invalidation term —
 * nothing is edited, so no prefix is thrown away.
 *
 * `running` and `ledger` are separate because they are separate facts. A filter
 * that is not running still has a history worth reading; a ledger that is there
 * and unreadable is not an empty one; and none of the four states is `$0.00`.
 */
export interface FilterSavingsDTO extends FilterWindowDTO {
  running: boolean;
  ledger: "missing" | "unreadable" | "empty" | "read";
  /**
   * The same reading over the two windows the meters draw, so a window's
   * saving can name the share of itself the filter is responsible for.
   *
   * A **floor by more than the total is**: the ledger has no clock, so a
   * result is dated by the transcript turn its request joined to, and one that
   * joined to nothing is left out of both windows rather than guessed into
   * one. That is `unjoinedRequests`, which is most of them here.
   */
  session: FilterWindowDTO;
  weekly: FilterWindowDTO;
  requests: number;
  /**
   * Requests whose `request_id` matched no **main-thread** assistant turn: a
   * sub-agent's, or one whose transcript has been swept. What they saved is
   * missing from every figure here rather than counted as nothing, so the whole
   * DTO is a floor while this is non-zero — 82 of 125 when this was written,
   * because the filter's B2 rule fires hardest on exactly the tool-heavy
   * sub-agent turns the join excludes.
   */
  unjoinedRequests: number;
  /** Earliest instant the figures cover, or null when nothing bounded them. */
  totalFrom: number | null;
}

export interface UsageResponse {
  snapshot: SnapshotDTO;
  /**
   * The intake filter's own reading. Its own key beside `pruning` and never
   * inside it: the card adds the two, but it adds them where it can also print
   * how much they overlap. A shape that pre-added them on the wire would carry
   * the overstatement into every later reader with nothing left saying so.
   */
  intakeFilter: FilterSavingsDTO;
  /**
   * Pruning's value over the same two windows the meters draw, so the three are
   * comparable, plus `total` — every receipt still priceable, which is the
   * figure the tile leads with. Its own key for `install`'s reason and one more:
   * it is not spend, and a field on `snapshot` is one somebody eventually adds
   * up.
   *
   * `total` is a superset of both windows and a **floor**: it starts at
   * `totalFrom`, the transcript horizon, because a receipt whose transcript has
   * been swept prices at zero saving with its invalidation still charged and
   * would drag the total below what pruning really earned. `totalFrom` is null
   * when nothing bounded it — render "all time" for that and never a date.
   */
  pruning: {
    session: PruneSavingsDTO;
    weekly: PruneSavingsDTO;
    total: PruneSavingsDTO;
    totalFrom: number | null;
    /**
     * Not a span reading: what is configured now, and whether it can act.
     *
     * Shipped unconditionally, never behind a `pruningEnabled()` on the route —
     * or the readout would go missing on exactly the installs whose operators
     * need it, which is the failure it was added to end.
     */
    pruner: ContextPrunerDTO;
    /**
     * The same three spans as the savings above, from one read, so a span with
     * no money can still say what happened in it — and so a card can never
     * print a boundary count over one window beside a figure over another.
     */
    activity: {
      session: PruneActivityDTO;
      weekly: PruneActivityDTO;
      total: PruneActivityDTO;
    };
  };
  /**
   * Spend cut into calendar buckets, all three granularities at once so the
   * toggle switches without a refetch.
   *
   * A history, never a guard input: `evaluateBudget` is passed windows, and a
   * day and a month have no published allowance to guard against — see the
   * `limitBasis` note above.
   */
  periods: Record<PeriodGranularityDTO, PeriodSeriesDTO>;
  meta: {
    transcriptDir: string;
    fileCount: number;
    entryCount: number;
    unpricedModels: string[];
    scannedAt: number;
    /**
     * Paths the last scan could not read, capped — `readFailureCount` is the
     * whole set. Anything here means every cost, token and percentage on this
     * response is short by an unknown amount.
     */
    readFailures: { path: string; message: string }[];
    readFailureCount: number;
    /**
     * This process's own footprint, so the heap is readable without attaching a
     * debugger to a container that has usually already died by then.
     */
    memory: {
      cache: {
        /** Transcript files with a cached byte offset. */
        files: number;
        /** Parsed turns held across those files. */
        entries: number;
        /**
         * Tool calls held across those files — the composition reading's own
         * records, which are not turns and are not billable.
         */
        toolCalls: number;
        /** The bound `entries` **plus** `toolCalls` is kept at or below. */
        maxEntries: number;
        /**
         * Files dropped to stay under that bound since boot. Non-zero means the
         * history on disk no longer fits, and the excess is re-parsed from disk
         * on every scan — correct, and slower every time.
         */
        evictions: number;
      };
      heapUsedBytes: number;
      /** V8's own ceiling for this process, which it derives from system memory. */
      heapLimitBytes: number;
    };
    /**
     * Whether the window can show a percentage at all — true when the provider
     * answered, whatever is or is not configured.
     */
    hasSessionCeiling: boolean;
    hasWeeklyCeiling: boolean;
    /** Whether the provider's own reading was asked for at all. */
    planUsageFromApi: boolean;
    /**
     * New work is held across the install: nothing starts, nothing in flight is
     * touched. Said on the dashboard in words, because a held fleet and an idle
     * one look identical — the meters are the same and the queue simply never
     * moves.
     */
    newWorkPaused: boolean;
    /** Headroom reserved for surfaces this tool cannot observe (0–1). */
    reservedHeadroomFraction: number;
    /**
     * The ceilings as *typed in Settings*, before reserved headroom.
     *
     * `WindowState.limit` is the effective ceiling — `limitConfig()` has already
     * taken the reserve off it — so it is the wrong number to describe as the
     * one the user set. Carried separately rather than reconstructed by
     * dividing `limit` by `1 - reserve`: that reproduces $650 as
     * $650.0000000001, and it silently invents a ceiling whenever the reserve
     * is later applied somewhere else too.
     */
    configuredCeilings: {
      sessionCost: number | null;
      weeklyCost: number | null;
      sessionTokens: number | null;
      weeklyTokens: number | null;
    };
    /**
     * Manual 5-hour reset instant, when one is configured. Present so the
     * session card can say the window was anchored by hand rather than derived
     * — a meter that silently disagrees with the transcripts is worse than no
     * override at all.
     */
    sessionResetOverrideAt: number | null;
    /** Which Claude Code entrypoints the parsed transcripts came from. */
    entrypoints: string[];
    /** Whether sub-agent turns are in these totals — the by-agent table depends on it. */
    includeSidechains: boolean;
    /**
     * The subscription the scanned transcripts belong to, when Claude Code's
     * own state files can be read. All fields null means "plan unknown", which
     * is a normal state — never an error, and never a ceiling.
     */
    account: AccountProfileDTO;
    /**
     * What the boot made of this process's own configuration — a mount that is
     * not a directory, a `CLAUDE_HOME` with no transcripts under it, a variable
     * set to the empty string.
     *
     * Only ever warnings in practice: a refusal exits the process before it
     * serves, so nothing that reads this can be looking at one. It rides on the
     * usage payload because that is the page an operator is on when the figures
     * are zero, and "the mount is empty" is the answer to the question they are
     * about to ask. Computed once at boot, not per request.
     */
    configProblems: ConfigProblemDTO[];
  };
  /**
   * What runs have reported over their own telemetry inside the same 5-hour
   * window as `snapshot.session`. `null` when agent self-reporting is off or
   * nothing has reported — a normal state, not an error.
   *
   * A third reading on a page whose meters are transcript-derived, and kept
   * apart from them: it moves while a work cycle is still going, which neither
   * `runs.spent_usd` nor the guard can. Never add it to `snapshot` figures.
   */
  telemetry: TelemetryWindowDTO | null;
  /**
   * What this whole installation has spent inside the rolling window the
   * install-wide ceiling covers, and that ceiling.
   *
   * A **fourth** reading on this page and, like the third, never added to the
   * others: the meters above it are our price table over every transcript on the
   * machine, and this is the money *this app* recorded spending — one run row,
   * one block row and one chat row at a time — over a different span. Summing
   * the two would count the same work twice.
   *
   * `limitUSD` is null when no ceiling is configured, and the meter must be the
   * hatched indeterminate one rather than an empty 0% bar: an install whose
   * share of a limit is unknown and one that has spent nothing must not look
   * alike.
   */
  install: InstallSpendDTO;
}

/**
 * The install-wide ceiling and what has been spent against it.
 *
 * `spentUSD` is the measured floor — every figure a CLI itself reported — and
 * `spentGuardUSD` adds killed cycles' reconciled estimates and what telemetry
 * says the cycles in flight have cost so far. The same display-versus-guard
 * split a window, a run and a workflow instance already make, and drawn the same
 * way: solid fill to the measured figure, hatched band out to the guard's.
 */
export interface InstallSpendDTO {
  spentUSD: number;
  spentGuardUSD: number;
  limitUSD: number | null;
  /** The span the two figures cover. Rolling, not a calendar day. */
  windowHours: number;
}

/** One run's first-party total inside the window. */
export interface TelemetryRunDTO {
  runId: string;
  /** `null` only if the run row has gone — runs are not deleted, so in practice set. */
  status: RunDTO["status"] | null;
  requests: number;
  costUSD: number;
  tokens: number;
  lastAt: number;
}

export interface TelemetryWindowDTO {
  requests: number;
  costUSD: number;
  tokens: number;
  lastAt: number;
  runCount: number;
  workingRunCount: number;
  /** Heaviest first, and shorter than `runCount` when there were more. */
  runs: TelemetryRunDTO[];
}

/**
 * First-party per-request totals for one run, from Claude Code's own OTLP
 * export. Shown beside `spent_usd`, never merged into it: the two are
 * independent measurements and their disagreement is the useful part.
 */
export interface RunTelemetryDTO {
  requests: number;
  costUSD: number;
  tokens: number;
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * Whether the container's own Claude Code has a credential, and whose.
 *
 * Next to `AccountProfileDTO` and not merged into it because they answer
 * different questions from different sources. That one reads the credential
 * file to name a *plan*, and reports `UNKNOWN_ACCOUNT` for every failure — it
 * cannot tell a missing file from an unparsable one, and it is not meant to.
 * This one asks the CLI who it would authenticate as, which is the question a
 * run ending on `Not logged in` actually raises.
 */
export interface ClaudeAuthDTO {
  loggedIn: boolean;
  /** `claude.ai` for a subscription, `none` when signed out. */
  method: string | null;
  email: string | null;
  organization: string | null;
  plan: string | null;
  /**
   * The variable an API key was found in. Non-null means that key, not the
   * subscription below it, is what a work cycle will bill against.
   */
  apiKeySource: string | null;
}

/** `GET /api/claude-auth`. */
export interface ClaudeAuthStateDTO {
  /** Null exactly when the CLI could not be asked; `error` then says why. */
  auth: ClaudeAuthDTO | null;
  error: string | null;
  /**
   * A sign-in that has printed its link and is waiting for the code.
   *
   * Reported so the flow survives a page reload: the child holding the PKCE
   * verifier outlives the tab that started it, and without this the operator
   * would be shown a fresh Sign in button while the code in their clipboard
   * still belonged to the old one.
   */
  pending: { url: string; startedAt: number } | null;
}

/** Names a plan. Carries no ceiling, no email, no account UUID. */
export interface AccountProfileDTO {
  subscriptionType: string | null;
  rateLimitTier: string | null;
  label: string | null;
  fingerprint: string | null;
  source: "credentials" | "profile" | null;
}

/** One top-level directory tree the agent may be pointed at. */
export interface WorkspaceMountDTO {
  id: string;
  label: string;
  path: string;
  /** False when the configured path is missing — a bad mount, not an empty one. */
  available: boolean;
  error: string | null;
  folderCount: number;
  /** True when the listing hit its per-mount cap and is incomplete. */
  truncated: boolean;
  /** Run currently working here or in anything under it. */
  busyRunId?: string | null;
  /** Parked run that will want this folder back. Does not block a new run. */
  parkedRunId?: string | null;
  /** Runs waiting on this folder. */
  queuedCount?: number;
}

export interface WorkspaceFolderDTO {
  mountId: string;
  /** Path relative to the mount root. */
  path: string;
  name: string;
  isGitRepo: boolean;
  /** Run currently working here, in a parent of it, or in a child of it. */
  busyRunId?: string | null;
  /** Parked run that will want this folder back. Does not block a new run. */
  parkedRunId?: string | null;
  queuedCount?: number;
}

export interface FoldersResponse {
  /** First mount's path. Predates multiple mounts. */
  root: string;
  mounts: WorkspaceMountDTO[];
  folders: WorkspaceFolderDTO[];
}

/**
 * Duplicated from `budget.ts` rather than imported, exactly as
 * `RunDTO["status"]` duplicates `RunStatus`: this file is the client-safe
 * mirror and must not pull a server module into the browser bundle.
 */
export type EnforcementModeDTO = "between-cycles" | "live" | "live-resume";

export interface BudgetPolicyDTO {
  maxWeeklyFraction: number | null;
  maxSessionFraction: number | null;
  maxRunCostUSD: number | null;
  /** The relative guard: a multiple of this task's own median, or null. */
  maxRunCostFactor: number | null;
  maxRunTokens: number | null;
  /** null = no cap on work cycles. Legal only alongside maxDurationMinutes. */
  maxIterations: number | null;
  maxDurationMinutes: number | null;
  enforcement: EnforcementModeDTO;
  continueAfterDone: boolean;
  permissionMode?: string;
}

/**
 * One "start after that run" edge, as a run reports it.
 *
 * `satisfied` is computed on the server so that what counts as a settled
 * dependency has one definition — `edgeSatisfied` in `orchestrator.ts` — rather
 * than one there and a second one in every page that renders a waiting run.
 */
export interface RunDependencyDTO {
  /** The run this one is waiting for. */
  runId: string;
  edge: "on-success" | "on-finish";
  /** That run's status right now. */
  status: RunDTO["status"];
  /** Whether it has settled in a way that lets this run start. */
  satisfied: boolean;
  /**
   * Whether this run takes that one's branch over instead of cutting its own.
   * At most one dependency of a run can, and it is what `continues_run` on the
   * run itself resolves to.
   */
  continueBranch?: boolean;
}

/**
 * The last time a restart closed runs out, as the runs list reads it.
 *
 * On the wire because the alternative was one `console.warn` at boot: twenty-
 * five runs terminated, each needing an operator to pick it up by hand, into a
 * stream nobody is tailing — and afterwards a screen full of `failed` runs with
 * nothing in this app saying they died together and why. `closed` is what the
 * boot ended; `kept` is the parked runs it deliberately spared.
 */
export interface BootReconcileDTO {
  at: number;
  closed: number;
  kept: number;
}

export interface RunDTO {
  id: string;
  /** Absolute, canonicalised folder the operator picked. */
  folder: string;
  /** Mount the folder belongs to, or null if that mount is gone. */
  mountId?: string | null;
  mountLabel?: string | null;
  /** `folder` relative to its mount; "" means the mount root itself. */
  relPath?: string;
  prompt: string;
  model: string | null;
  /**
   * Duplicated from `RunStatus` in `orchestrator.ts` rather than imported, for
   * this file's stated rule: it is the client-safe mirror and must not pull a
   * server module into the browser bundle. No compiler compares the two — the
   * three route handlers that build a run payload return anonymous objects into
   * `NextResponse.json` — so a member added on one side and not the other
   * typechecks clean and surfaces only where a client indexes a `Record` keyed
   * on this union.
   */
  status:
    | "waiting"
    | "queued"
    | "running"
    | "paused"
    | "completed"
    | "needs-review"
    | "stopped"
    | "failed"
    | "blocked";
  budget: BudgetPolicyDTO;
  /**
   * What this run was told to start after. Present on every run; empty for the
   * ordinary one. A `waiting` run has at least one entry with `satisfied:
   * false`, and that is what the row says it is waiting for.
   */
  dependsOn?: RunDependencyDTO[];
  /** Cap on work cycles. **0 means no cap** — see the note in db.ts. */
  max_iterations: number;
  /** Work cycles that have *finished*. A cycle in flight is not counted here. */
  iterations: number;
  /**
   * The work cycle open right now, or null when no child is running. Read
   * through `fmtCycleInFlight`, which also refuses to trust it on a row that is
   * no longer running.
   */
  active_iteration?: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  stop_reason: string | null;
  exit_code: number | null;
  spent_usd: number;
  spent_tokens: number;
  session_id?: string | null;
  /** Where the agent ran. Differs from `folder` only for an isolated run. */
  work_dir?: string | null;
  isolation?: "none" | "worktree" | null;
  worktree_branch?: string | null;
  worktree_base?: string | null;
  /** Branch this run's work lands into. Null on rows created before it was recorded. */
  worktree_base_branch?: string | null;
  /**
   * The run whose branch this one carries on, or null for a branch of its own.
   * Its `worktree_base` is the chain's, so the diff above covers every link.
   */
  continues_run?: string | null;
  /** When this tool merged the branch into its target. Null means never. */
  landed_at?: number | null;
  landed_into?: string | null;
  landed_strategy?: string | null;
  /** Paused runs only: epoch ms at which the run next tries again. */
  resume_at?: number | null;
  paused_at?: number | null;
  pause_count?: number;
  /** How many times the agent said DONE and was sent back in anyway. */
  done_retriggers?: number;
  /**
   * Whether the last work cycle replied DONE. Separates a run that finished
   * from one that used up its cycle cap — both are `completed`, and they are
   * picked up with different prompts.
   */
  reported_done?: number;
  /**
   * What the agent said when it reported it could not finish, clipped at the
   * write. Present only while the row records the `needs-review` ending —
   * picking the run up clears it, because it describes an ending rather than
   * the run.
   */
  needs_review_reason?: string | null;
  /**
   * 1 when this run ended because the server went down under it, rather than
   * for any reason of its own. Cleared when it is picked up again, so it says
   * "still waiting to be picked up" rather than "was interrupted once".
   */
  restart_closed?: number;
  /**
   * When an operator set this run aside, or null. Both bulk pick-ups skip it
   * while it is set; the run's own Resume clears it. Says nothing about how the
   * run ended — a set-aside run keeps the status and stop reason it had.
   */
  set_aside_at?: number | null;
  /**
   * Spend reconciled from transcripts for work cycles killed before Claude Code
   * reported theirs. Shown beside `spent_usd`, never folded into it.
   */
  spent_usd_est?: number;
  spent_tokens_est?: number;
  /** Queued runs only: how many are ahead of it. 0 means next up. */
  queuePosition?: number;
  /**
   * The workflow run this one was halted with, or null for every other run —
   * one started outside a workflow, or a member of an instance still going.
   *
   * On the DTO because the run page cannot work it out: a halted member is an
   * ordinary `blocked` or `stopped` row, and the only difference is a join the
   * page has no route for. `reopenRun` refuses one, so this is what keeps the
   * page from offering a button whose whole answer is a refusal.
   */
  haltedWorkflow?: string | null;
  /**
   * The specialised agent this run was started with, or null for the ordinary
   * run. The run's own frozen copy, so it still names the agent it was given
   * after that agent has been renamed or deleted.
   */
  agent?: RunAgentDTO | null;
  /**
   * Which gate created this run: the form, an approved chat proposal, a press
   * of Run on a workflow, an orchestrator block's own decision, or a schedule
   * firing with nobody present. Null on runs created before it was recorded.
   */
  origin?: RunOriginDTO | null;
  /** The record that authorised it — a proposal, an instance, a schedule. */
  origin_ref?: string | null;
  /** When an operator last picked this run up again. Never rewrites `origin`. */
  reopened_at?: number | null;
}

/**
 * How much of a run's task the *list* carries.
 *
 * Long enough that the line the table truncates at `56ch` and the `title` on it
 * are both still the task rather than a fragment of one, short enough that a
 * hundred of them are not the response. Measured before it existed: 522,541 of
 * a 696,197-byte list was prompts, on a page that polls every four seconds.
 * `GET /api/runs/[id]` is the full-text source and is what the task page reads.
 */
export const MAX_LIST_PROMPT = 400;

/**
 * A run as the runs list and quick open read it, which is less than a run.
 *
 * Its own type rather than a quietly weakened `RunDTO`, because `RunDTO` is what
 * the single-run route ships and that one must keep the whole prompt — a shared
 * shape whose `prompt` had silently become a prefix would be wrong on the page
 * that renders the task in full and correct nowhere it was checked.
 *
 * Three fields are absent rather than clipped. `budget` is the whole normalised
 * policy and `agent` the run's frozen copy of its role, 37KB between them over a
 * hundred rows, and neither list reads either: the list draws status, task,
 * folder, cycles, tokens, spend and what a run is waiting on, and quick open
 * draws an id, a status and a folder. The guards belong to the run's own page,
 * which asks the route that has them.
 *
 * `needs_review_reason` is the third and it is the same argument with a delay
 * on it. It holds up to `MAX_NEEDS_REVIEW_REASON` characters of what an agent
 * said when it could not finish, only the run's own page renders it, and it cost
 * nothing in the payload measured above **only because that capture happened to
 * hold no `needs-review` rows**. A fleet that ends that way puts it back on
 * every row of a list polled every four seconds. A field that is free on one
 * install's data and expensive on the next is not a field this list carries.
 */
export type RunListItemDTO = Omit<
  RunDTO,
  "prompt" | "budget" | "agent" | "needs_review_reason"
> & {
  /**
   * The task, clipped to `MAX_LIST_PROMPT` with a trailing `…` when it did not
   * fit — `clipReason`'s marker, so a shortened value cannot read as a whole
   * one. The hover `title` on the list is therefore a prefix on a long task.
   */
  prompt: string;
  /**
   * What context pruning netted this run, in dollars.
   *
   * One number rather than the `PruneSavingsDTO` the run's own page is given,
   * on the rule the three absent fields above were dropped for: seven fields a
   * row over a hundred rows is not a figure this list carries. The breakdown —
   * how many prunes, how many of them priced, over how many turns — stays on
   * the route that answers about one run.
   *
   * **Absent means pruning never ran here**, which is why it is optional rather
   * than 0: `/api/runs/[id]` drops its whole section on the same distinction.
   * Signed, because an early end's invalidation can exceed what it saved.
   *
   * **Not spend, and never summed with `spent_usd`** — see `PruneSavingsDTO`
   * for why adding it to a meter is adding a counterfactual to a measurement.
   */
  prunedNetUSD?: number;
};

/**
 * One page of the runs list, as `/api/runs` answers it.
 *
 * The three figures beside the rows are the whole of what makes the history
 * reachable: `total` is counted over every run matching the filter rather than
 * over this page, so a page can say what it is a slice of, and `offset`/`limit`
 * are the applied ones rather than the asked-for ones — both are clamped, so a
 * caller that pages off the end is told where it actually landed.
 *
 * `lastBootReconcile` rides along for the runs page's poll and is ignored by
 * every other reader. It is the explanation for the rows in the list, and this
 * is the request that already carries them.
 */
export interface RunListDTO {
  runs: RunListItemDTO[];
  lastBootReconcile: BootReconcileDTO | null;
  total: number;
  offset: number;
  limit: number;
}

/** Mirrors `RunOrigin` in `orchestrator.ts`; see the column note in `db.ts`. */
export type RunOriginDTO =
  | "form"
  | "chat"
  | "workflow"
  | "orchestrator-block"
  | "schedule";

/**
 * What a run records about the agent it was started as.
 *
 * The agent's own `prompt` is deliberately absent: it is the run's own system
 * prompt, nothing on the run page acts on it, and this payload is polled every
 * three seconds. The name and the description are what a reader needs — the
 * description because it is what the operator read when they chose, so it is
 * what explains the run they are looking at.
 */
export interface RunAgentDTO {
  name: string;
  description: string;
  /** Null means the session ran on the run's own model. */
  model: string | null;
}

/** Mirror of `AgentSpendRow` in `windows.ts`. */
export interface AgentSpendRowDTO {
  agent: string;
  origin: AgentOriginDTO;
  costUSD: number;
  costGuardUSD: number;
  tokens: number;
  entryCount: number;
}

/**
 * What one run's turns cost, split by who produced them.
 *
 * A **fifth** reading of a run's spend and never a correction to any of the
 * other four. It is our price table over the transcripts this run's session
 * wrote — the same source, the same dedupe key and the same cache weighting the
 * dashboard meters use, and the same one `spent_usd_est` already comes from —
 * scoped to one session id and one time range. `runs.spent_usd` stays a floor of
 * what the CLI itself measured, telemetry stays Claude Code's own per-request
 * figure, and no two of the three are ever added: they measure the same work by
 * different routes, so a sum double-counts it.
 *
 * Null on the wire when there is nothing to read — a run with no session id yet,
 * or an unreadable transcript directory. That is "no reading", which the card
 * renders as the hatched indeterminate meter; a run whose agents spent nothing
 * and a run nobody could measure must not look alike.
 */
export interface RunAgentSpendDTO {
  costUSD: number;
  costGuardUSD: number;
  tokens: number;
  entryCount: number;
  /** Everything outside `(main thread)` — a historical name, see `AgentSpend`. */
  delegatedCostUSD: number;
  delegatedCostGuardUSD: number;
  rows: AgentSpendRowDTO[];
  /** The instants the session was read between, so the card can say what it covers. */
  from: number;
  to: number;
  /**
   * True when Settings excludes sub-agent turns from the dashboard totals.
   *
   * This card counts them regardless — it exists to say what the work outside
   * the main thread cost, and a card that silently answered $0 because of a
   * setting about the *meters* would be the worst of both. Carried so the card
   * can say so. That setting keys on the transcript's own `isSidechain`, which
   * is a genuinely delegated turn and is a different question from which agent
   * name a turn carries — so it is untouched by the move to `--agent`.
   */
  excludedFromTotals: boolean;
}

/**
 * Long enough for a sentence-shaped template name, short enough that the picker
 * stays one line. Here rather than in `templates.ts` so the form can bound the
 * input without a client component importing a module that opens SQLite.
 */
export const MAX_TEMPLATE_NAME = 80;

/**
 * A saved task prompt and the guards to run it under.
 *
 * `permissionMode` is top-level here rather than folded into `budget` the way
 * `RunDTO` folds it: on a run that key is a historical record of what was used,
 * on a template it is a setting the operator is choosing again every time they
 * apply it, and the UI has to warn about it separately.
 */
export interface RunTemplateDTO {
  id: string;
  name: string;
  prompt: string;
  /** Null means the template does not name a folder — the form asks for one. */
  mountId: string | null;
  /** Path within the mount. `""` is the mount root, and is not null. */
  folder: string | null;
  isolate: boolean;
  permissionMode: string;
  /**
   * The saved agent a run from this template is started as, by id.
   *
   * An id rather than a copy, unlike `RunDTO.agent`: a template is applied again
   * and again, so it should follow the agent as the operator edits it. A form
   * that cannot find this id in the registry must say so rather than start
   * without one — the run door refuses it by name either way.
   */
  agentId: string | null;
  /**
   * The model a run from this template is started on, or null for none.
   *
   * Free-form — an alias, a full id, or one released after this build — because
   * a list this build knows would refuse next week's. It is a seed on the run
   * form, where the field's own value is what starts the run, and it is
   * *inherited* by `planProposal` and `planNode`, where there is no field.
   */
  model: string | null;
  budget: BudgetPolicyDTO;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Agents: a saved role a run is started as                            */
/* ------------------------------------------------------------------ */

/** Bounded for the reason a template name is: it is picked out of a list. */
export const MAX_AGENT_NAME = 80;

/**
 * How long an agent's description may be.
 *
 * Not a form-tidiness bound. A registered agent's description is carried in the
 * session's context for the whole run — it is paid for on every request the run
 * makes, and an unbounded one is a cost multiplier with no ceiling on a run
 * whose spend guards are all denominated in dollars.
 */
export const MAX_AGENT_DESCRIPTION = 1_000;

/**
 * A saved agent: a role a run is started as.
 *
 * There is deliberately no tool list, no permission mode and no budget here, and
 * the absence is the design: what a run may do comes from its own guard set and
 * never from the role it takes. The reasoning is in `agents.ts` beside the
 * refusal that enforces it.
 */
export interface AgentDTO {
  id: string;
  name: string;
  description: string;
  prompt: string;
  /** Null means the session keeps whatever model the run already had. */
  model: string | null;
  /**
   * Whether this row can actually be attached to a spawn.
   *
   * False for a row whose description or prompt is empty — the CLI will not
   * register such a member, so a run started as it fails at the spawn. On the
   * DTO because nothing on the page can work it out: the row looks complete
   * either way.
   */
  usable: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * An agent definition Claude Code finds on disk that this app did not write.
 *
 * The operator's `~/.claude/agents/` is bind-mounted into the container and a
 * repository's own `.claude/agents/` is in an isolated run's worktree, so both
 * reach every child this app spawns and always have. They are left in play
 * rather than excluded — see `agents.ts` — which makes the saved registry a
 * *part* of the set rather than the whole of it, and this is what a surface
 * reads to say so where an agent is chosen.
 */
export interface AmbientAgentDTO {
  name: string;
  description: string | null;
  /** `user` is `~/.claude/agents`; `project` is a repository's own. */
  scope: "user" | "project";
  path: string;
}

/* ------------------------------------------------------------------ */
/* Workflows: a saved graph of run blocks                              */
/* ------------------------------------------------------------------ */

/** Bounded for the reason a template name is: it is picked out of a list. */
export const MAX_WORKFLOW_NAME = 80;

/**
 * How many blocks one workflow may hold.
 *
 * Every block becomes a run in a single synchronous pass, each claiming a
 * folder, so this bounds what one click can put on the machine at once.
 */
export const MAX_WORKFLOW_NODES = 25;

/**
 * How many runs one orchestrator block may start.
 *
 * Tighter than `MAX_WORKFLOW_NODES` on purpose, and the difference is who wrote
 * them: those blocks are typed by a person one at a time, where these are chosen
 * by a model and start with no approval between the decision and the spawn. The
 * per-block cap an operator sets is what actually bounds a graph; this is the
 * ceiling on what they may set.
 */
export const MAX_FAN_OUT = 10;

/**
 * How many passes one loop block may take.
 *
 * The ceiling on the cap an operator sets, exactly as `MAX_FAN_OUT` is: a loop
 * unrolls into one fresh run per pass, so this bounds what one press of Run can
 * put on the machine over the life of a block whose repetitions nobody watches.
 */
export const MAX_LOOP_PASSES = 20;

/**
 * What a block *is*.
 *
 * `run` is the original and the default: a fixed task, decided when the graph
 * was written. `orchestrator` is a short agent turn that decides, at the moment
 * the workflow reaches it, which runs to create next — and those runs start
 * without an approval step, because the approval happened when a person saved a
 * graph naming this block's folder, its guard set and its fan-out cap. `merge`
 * spawns no agent of its own: it lands the branches the blocks in front of it
 * left behind, through the same queue the Branches page uses, and its one
 * optional expense is paying a model to reconcile a conflict. `loop` repeats one
 * task until the agent reports it done, a pass fails, or one of its two caps is
 * reached — a fresh run per pass, each carrying on the previous pass's branch.
 */
export type WorkflowNodeKind = "run" | "orchestrator" | "merge" | "loop";

/** How a branch is put onto its target. `settings.landStrategy`'s vocabulary. */
export type MergeStrategyDTO = "merge" | "squash";

/**
 * One block of work in a workflow.
 *
 * There is deliberately no budget, permission mode, isolation choice or model
 * here. Those come from `templateId`, or from `settings.chatDefaultGuards` when
 * it is null — always from something a person wrote. A block holds the *work*.
 * That holds for an orchestrator block too: the runs it emits take their guards
 * from the same two places, and nothing it emits can name a third.
 */
export interface WorkflowNodeDTO {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  /** Null means the block runs under the untemplated guards in Settings. */
  templateId: string | null;
  mountId: string;
  /** Path within the mount. `""` is the mount root, and is a real answer. */
  folder: string;
  /**
   * A run block's task; an orchestrator block's brief for what to decide.
   */
  task: string;
  /**
   * Standing instructions replacing the template's prompt. For a run block,
   * this block's own prompt; for an orchestrator block, the prompt every run it
   * emits is started with.
   */
  promptOverride: string | null;
  /**
   * A saved agent this block's own child is started as, by id.
   *
   * On the *work* side of the block, beside the mount, the folder and the task,
   * and never on the guard side: an agent holds no tool list and no permission
   * mode, so what it changes is who the child *is* and never what the block may
   * do. It is the block's own rather than its template's — the reason is in
   * `WorkflowNode.agentId`.
   *
   * Null on a merge block always, and naming one there is refused rather than
   * dropped: that block spawns no child, so there is nothing for the agent to
   * be.
   */
  agentId: string | null;
  /**
   * How many runs an orchestrator block may start. Null on a run block, and
   * **never** null on an orchestrator one — a block that starts agents with no
   * approval and no ceiling is an unbounded number of billed agents from one
   * press of Run, so it is refused at save the way the `no_terminus` pair is.
   */
  fanOut: number | null;
  /**
   * How a merge block lands each branch. Null on every other kind, and never
   * null on a merge one: it is recorded on the graph rather than read from
   * `settings.landStrategy` at Run, so a saved workflow cannot change what it
   * does to a repository because a setting moved underneath it.
   */
  mergeStrategy: MergeStrategyDTO | null;
  /**
   * Whether a merge block may pay a model to resolve a conflict. False on every
   * other kind. On the graph rather than in settings for `merge_queue`'s
   * reason: automatic spend has to be authorised where it can be read back, and
   * saving the workflow with this on *is* that authorisation.
   */
  mergeAutoResolve: boolean;
  /**
   * How many passes a loop block may take. Null on every other kind, and
   * **never** null on a loop one.
   *
   * The `maxIterations`/`maxDurationMinutes` argument applied one level up: a
   * loop manufactures its own next unit of work, so it needs a quantity that
   * moves one way and keeps moving, and this is the only one it has. Refused at
   * save rather than at Run.
   */
  maxPasses: number | null;
  /**
   * Everything this loop's passes may spend together, or null for no cap.
   *
   * Nullable because the pass cap is already the terminus. It is a *bound on
   * repetition*, not a guard on an agent — it can only end the loop earlier, it
   * never reaches a run's own budget, a permission mode or an isolation choice,
   * and it never widens the workflow-wide limit, which still halts the whole
   * instance at every member's cycle boundary.
   */
  maxLoopCostUSD: number | null;
}

export interface WorkflowEdgeDTO {
  /** The block that must settle first. */
  from: string;
  /** The block that starts once it has. */
  to: string;
  edge: "on-success" | "on-finish";
  /** Whether `to` carries on `from`'s branch instead of cutting its own. */
  continueBranch: boolean;
}

/**
 * Limits on a whole press of Run, as against one block's.
 *
 * Every field nullable and `null` means off, this app's standing rule for a
 * budget field. There is deliberately no cycle or time limit here: an instance
 * is a finite graph whose members each carry their own terminus, so it needs no
 * monotone quantity of its own to be sure of ending.
 */
export interface InstanceBudgetDTO {
  maxInstanceCostUSD: number | null;
  /** 0–1. The form asks for a percentage. */
  maxSessionFraction: number | null;
  maxWeeklyFraction: number | null;
}

/**
 * How often a workflow starts itself.
 *
 * Three plain choices rather than a cron expression, so that the page can render
 * the rule back in words *and* state the instant it next means — an operator who
 * cannot verify a schedule at a glance will not leave an unattended agent behind
 * it. The mirror of `ScheduleSpec` in `schedules.ts`.
 */
export type ScheduleSpecDTO =
  | { kind: "everyHours"; hours: number; anchorAt: number }
  | { kind: "daily"; minutes: number }
  | { kind: "weekly"; weekday: number; minutes: number };

/** What the last fire decision came to. See `ScheduleOutcomeCode`. */
export type ScheduleOutcomeCodeDTO =
  | "started"
  | "overlap"
  | "unbudgeted"
  | "refused"
  | "missed";

/**
 * A workflow's schedule, and the evidence an operator needs to trust it.
 *
 * `nextFireAt` is an absolute instant rather than "in about an hour", and
 * `lastCode`/`lastReason`/`streak` are what it last did — a schedule whose
 * skips are invisible is one that looks like it is working while it does
 * nothing.
 */
export interface WorkflowScheduleDTO {
  spec: ScheduleSpecDTO;
  /** The IANA zone the wall-clock times in `spec` are read in. */
  timeZone: string;
  paused: boolean;
  /** The recurrence in words, zone included. */
  description: string;
  /** Null when it cannot be worked out — never a plausible stand-in instant. */
  nextFireAt: number | null;
  lastCode: ScheduleOutcomeCodeDTO | null;
  lastReason: string | null;
  lastAt: number | null;
  /** The occurrence `lastCode` is about, which is not when it was recorded. */
  lastFireAt: number | null;
  lastInstanceId: string | null;
  /** Consecutive outcomes with the same code, collapsed into one state. */
  streak: number;
  streakSince: number | null;
  /** Why it cannot fire as things stand — a cleared budget — or null. */
  refusal: string | null;
}

export interface WorkflowDTO {
  id: string;
  name: string;
  nodes: WorkflowNodeDTO[];
  edges: WorkflowEdgeDTO[];
  instanceBudget: InstanceBudgetDTO;
  createdAt: number;
  updatedAt: number;
  /** Runs from this workflow that have not finished. Empty on most reads. */
  liveRunCount?: number;
  /** When it was last started, or null if it never has been. */
  lastRunAt?: number | null;
  /** Null when nothing starts this workflow but a person. */
  schedule?: WorkflowScheduleDTO | null;
}

/**
 * A workflow as the workflows list and quick open read it, which is less than a
 * workflow.
 *
 * Its own type rather than a quietly weakened `WorkflowDTO`, for the reason
 * `RunListItemDTO` is one: `WorkflowDTO` is what the detail route, the editor
 * and the duplicate route ship, and all three need the whole graph to do their
 * job — a shared shape whose `nodes` had silently become optional would be
 * wrong on the page that draws the canvas and correct nowhere it was checked.
 *
 * Three fields are absent rather than clipped, and a node's body is why. A node
 * holds a task prompt, so the graph is nearly the whole response: measured over
 * two saved workflows, `nodes` was 28,934 bytes of 30,290, `edges` 513 and
 * `instanceBudget` 156. Neither reader opens any of them — the list prints a
 * block count in one column and quick open prints the same count as a detail
 * line — and the list polls every ten seconds, so what was being carried was a
 * graph that grows without bound in service of one integer. `nodeCount` is that
 * integer, and the same two workflows come to 471 bytes. The graph and the
 * instance budget belong to the workflow's own pages, which ask the route that
 * has them.
 */
export type WorkflowListItemDTO = Omit<
  WorkflowDTO,
  "nodes" | "edges" | "instanceBudget"
> & {
  /** How many blocks the saved graph holds. Both lists print exactly this. */
  nodeCount: number;
};

/**
 * One block of an instance, and what became of its run.
 *
 * `run` is null when the run row has gone — the mapping is a historical record
 * and says so, rather than dropping the block out of the instance.
 *
 * `emittedBy` names the orchestrator block that created this run, for a row that
 * was not in the saved graph at all. Null for a block a person wrote.
 */
export interface WorkflowInstanceNodeDTO {
  nodeId: string;
  nodeName: string;
  position: number;
  runId: string;
  run: {
    status: RunDTO["status"];
    stopReason: string | null;
    iterations: number;
    maxIterations: number;
    /** The cycle open right now. See `fmtCycleInFlight` — never added to the count. */
    activeIteration: number | null;
    startedAt: number | null;
    /** Null for a mount that has since been removed; `relPath` is then absolute. */
    mountLabel: string | null;
    relPath: string;
    spentUSD: number;
  } | null;
  /** Node ids this block was told to start after, from the instance's graph. */
  waitsFor: string[];
  /**
   * The orchestrator block that decided on this run, or null for a block of the
   * saved graph. Nobody approved the runs this names — see the orchestrator
   * block invariant — so the page lists them apart from the graph's own.
   */
  emittedBy: string | null;
}

/**
 * One block of an instance that never became a run.
 *
 * An orchestrator turn — with its own spend, which is never a run's — a merge
 * block, a loop block, which is not a run either but creates one per pass, or a
 * block that was never created because the block in front of it had nothing to
 * hand it. All four are here for the same reason: a block that simply disappears
 * from the instance is indistinguishable from one still waiting.
 */
export interface WorkflowInstanceBlockDTO {
  nodeId: string;
  nodeName: string;
  position: number;
  kind: WorkflowNodeKind;
  status: "waiting" | "thinking" | "looping" | "emitted" | "failed" | "blocked";
  startedAt: number | null;
  finishedAt: number | null;
  /** The turn's own cost. Never added to a run's spend or to a meter. */
  costUSD: number;
  /**
   * How many runs this block started — passes, for a loop block. 0 is a real
   * answer, not "not yet".
   */
  emitted: number;
  /**
   * Whether the turn ever called `emit_runs`. The two ways a block starts
   * nothing read alike without it: one decided there was nothing worth doing,
   * the other never reached a decision.
   */
  decided: boolean;
  /**
   * What the turn replied, verbatim — the block's own account of what it
   * emitted and what it left out. Null on a turn that failed or said nothing.
   */
  reply: string | null;
  /**
   * What this app recorded about the turn: an `emit_runs` it refused, a tool
   * call the CLI declined, an instance guard it could not read. Separate from
   * `reply` because one is the model's voice and one is ours, and separate from
   * `error` because neither is the turn failing.
   */
  notes: string[];
  /** Branches a merge block put onto their target. 0 on every other kind. */
  branchesLanded: number;
  /**
   * Branches a merge block could not land — including the ones it never
   * attempted because the checkout stopped the whole repository. Counted apart
   * from `branchesLanded` rather than subtracted from it, because a block that
   * landed three of four is not the same fact as one that landed three of three.
   */
  branchesFailed: number;
  error: string | null;
  waitsFor: string[];
}

export interface WorkflowInstanceDTO {
  id: string;
  workflowId: string;
  /** The workflow's name when Run was pressed; it may have been renamed since. */
  workflowName: string;
  createdAt: number;
  /**
   * Four of the six are derived from the members rather than written, because
   * nothing would run the pass that wrote them: a signalled child takes seconds
   * to die, and a graph whose last member settles has nobody left to close it
   * out. `stopping` and `stopped` are one halted row either side of its last
   * live member; `started`, `finished` and `blocked` are one unhalted row —
   * still working, reached its end, or had part of it written off because
   * something in front of it satisfied nothing.
   *
   * `finished` is about the graph, not about the work: how a member ended is on
   * the member's own row.
   */
  status:
    | "started"
    | "finished"
    | "blocked"
    | "failed"
    | "stopping"
    | "stopped";
  error: string | null;
  /** When the halt closed the door — not when the last child died. */
  stoppedAt: number | null;
  /**
   * What halted it. The way a member can end that is *not* here — stopped on
   * its own run page — is not an instance-level event and reads null.
   *
   * `fleet` is an operator's stop that was not aimed at this workflow: one
   * install-wide stop took every run in flight, this one among them. Kept apart
   * from `operator` because afterwards that is the only difference an operator
   * can still see.
   */
  stopCause: "operator" | "guard" | "fleet" | null;
  /** A guard's verdict in full. Null for an operator's stop, which needs none. */
  stopReason: string | null;
  /** Members that have not finished. Non-zero for as long as `stopping` is. */
  liveRunCount: number;
  /**
   * Members that never ran, because something in front of them did not satisfy
   * its edge. What `blocked` is counted from, and what says how much of the
   * graph is missing rather than merely that some of it is.
   */
  blockedCount: number;
  /** The limits it was started under — a copy, not the live workflow's. */
  instanceBudget: InstanceBudgetDTO;
  /**
   * What its blocks have spent together.
   *
   * Two figures, never one. `spentUSD` is the sum of what each block's own CLI
   * measured and is a **floor** — a cycle in flight has reported nothing and
   * contributes zero for its whole duration. `spentGuardUSD` is what the guard
   * acts on: that, plus reconciled estimates for killed cycles, plus what
   * telemetry says the cycles in flight have cost so far. Neither is ever added
   * to a dashboard meter or to `runs.spent_usd`. Both include what this
   * instance's orchestrator blocks spent deciding, which is measured the same
   * way a run's is and belongs to the same press of Run.
   */
  spentUSD: number;
  spentGuardUSD: number;
  nodes: WorkflowInstanceNodeDTO[];
  /** Blocks that are not runs: orchestrator turns, and blocks never created. */
  blocks: WorkflowInstanceBlockDTO[];
}

export interface RunEventDTO {
  id?: number;
  runId: string;
  ts: number;
  kind:
    | "status"
    | "log"
    /** The main thread's own words. Never a delegated turn's — see `subagent`. */
    | "assistant"
    /**
     * What a sub-agent said, forwarded by `--forward-subagent-text`.
     *
     * Its own kind rather than an `assistant` event with a flag on it, because
     * three readers must not be able to disagree about which voice a line is:
     * `cycleOutputs` takes the last `assistant` text as the cycle's report, the
     * log sets the two differently, and the orchestrator's `DONE` test runs
     * against the main thread's text alone.
     */
    | "subagent"
    | "tool"
    /**
     * A tool call that came back an error, named with the command it failed on.
     *
     * Its own kind rather than a flag on `tool` for `subagent`'s reason: a call
     * and its outcome are two statements, the log sets them differently, and a
     * failure filed as a call is a row an operator reads as an attempt that
     * went fine. Errors only — a successful result is not recorded at all.
     */
    | "tool_error"
    /**
     * A tool call that failed for a sandbox reason, carrying the words that
     * said so.
     *
     * Its own kind rather than a flag on `tool_error`, and emitted *beside* one
     * rather than instead of it, because the two answer different questions and
     * an operator asks the second one about a whole run: `kind = 'sandbox'` is
     * "did the policy refuse anything here", where the failure itself stays
     * where every other failed call is. It is also the one class of tool failure
     * that reaches stdout, for the reason a tripped guard does — a fleet whose
     * allowlist is too narrow fails inside tool calls nobody is reading.
     */
    | "sandbox"
    | "iteration"
    | "budget"
    | "result"
    | "handoff"
    | "land"
    // The other exit. `land` is work entering the operator's own
    // checkout; `deliver` is it leaving the machine for a remote.
    | "deliver"
    | "review"
    | "error"
    | "replay-complete";
  payload: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Reviewing and landing a run's work                                  */
/* ------------------------------------------------------------------ */

export type DiffFileStatusDTO =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "changed";

export interface DiffFileDTO {
  path: string;
  oldPath: string | null;
  status: DiffFileStatusDTO;
  /** Null for a binary file — git reports no line counts for one. */
  added: number | null;
  deleted: number | null;
  binary: boolean;
  /** Null when the patch was withheld to stay inside the size budget. */
  patch: string | null;
  patchTruncated: boolean;
}

export interface RunDiffDTO {
  /** `range` is exact; `worktree` includes the operator's own edits. */
  kind: "range" | "worktree" | "none";
  reason: string | null;
  base: string | null;
  branch: string | null;
  files: DiffFileDTO[];
  filesChanged: number;
  added: number;
  deleted: number;
  omittedPatches: number;
  uncommitted: string[];
  caveat: string | null;
}

/**
 * One file a run's tool events named, collapsed over the calls that named it
 * the same way.
 *
 * A row is an *attempt*: `run_events` records a tool call when it is made and a
 * result only when it failed, so nothing here says the call worked. The header
 * carries that hedge once rather than every row carrying a mark it cannot
 * honestly draw.
 */
export interface RunTouchDTO {
  /**
   * Relative to the run's checkout where it fell inside one, and the absolute
   * path where it did not — which is what `outside` distinguishes.
   */
  path: string;
  /** Matched neither `runs.work_dir` nor `runs.folder`. */
  outside: boolean;
  /** The tool's own name, as the CLI reported it. */
  tool: string;
  /** The sub-agent's own name, when the `Task` call that opened it was seen. */
  subagent: string | null;
  /** Set on any delegated call, named or not. */
  parentToolUseId: string | null;
  calls: number;
}

/**
 * One file-naming tool call, in the order the run made it.
 *
 * The uncollapsed form of `RunTouchDTO` and deliberately not a superset of it:
 * there is no `calls`, because a step *is* one call, and a file read forty times
 * is forty of these. That is the unit the replay steps through, and it is not
 * the unit the table draws.
 *
 * **Position is the array index and is not a field.** The wire order is the
 * sequence, so a number beside it would be a second thing that can disagree
 * with the first — and the one the surface would read is the one that got it
 * wrong.
 *
 * A step is an *attempt*, on `RunTouchDTO`'s own grounds: a result is stored
 * only when the tool failed and carries no id joining it back. Nothing here may
 * grow a field that could be read as an outcome.
 */
export interface RunTouchStepDTO {
  /** Relative to the checkout, or absolute when `outside` — `RunTouchDTO`'s rule. */
  path: string;
  /** Matched neither `runs.work_dir` nor `runs.folder`. */
  outside: boolean;
  /**
   * When the call was recorded. Ordering is the array's, never this: several
   * calls routinely share a millisecond.
   */
  at: number;
  /** The tool's own name, as the CLI reported it. */
  tool: string;
  /** The sub-agent's own name, when the `Task` call that opened it was seen. */
  subagent: string | null;
  /** Set on any delegated call, named or not. */
  parentToolUseId: string | null;
}

/**
 * What a run's tool events say it touched.
 *
 * Four answers rather than one plus an empty list, because "swept", "made no
 * file-naming call" and "no such run" are three different facts that all render
 * as nothing at all. An empty list standing for any of them reads as a run that
 * touched nothing.
 */
export type RunTouchedDTO =
  | {
      /** Terminal and past `eventRetentionDays`, so its events were deleted. */
      kind: "swept";
      horizonDays: number;
    }
  | { kind: "empty"; cycles: number }
  | { kind: "none"; reason: string }
  | { kind: "report"; touches: RunTouchDTO[]; cycles: number };

/**
 * One billed Claude invocation about a run, outside its work cycles: a review
 * of what it changed, or a resolution of a merge conflict on its branch.
 */
export interface RunReviewDTO {
  id: string;
  kind: "review" | "resolve";
  createdAt: number;
  finishedAt: number | null;
  status: "running" | "completed" | "failed";
  model: string | null;
  /** Never added to `RunDTO.spent_usd` — a review is not a work cycle. */
  costUSD: number;
  tokens: number;
  text: string | null;
  error: string | null;
  diffFiles: number;
  diffShown: number;
  truncated: boolean;
  /** The files a resolution was handed. Empty for a review. */
  paths: string[];
  /**
   * What a completed resolution changed on the branch, against the branch as it
   * stood before the merge. Null while it is running, when it failed, and for a
   * review — and for resolutions made before this was recorded.
   */
  changed: ResolutionChangeDTO | null;
}

export interface ResolutionChangeDTO {
  commit: string;
  files: DiffFileDTO[];
  omittedPatches: number;
}

/** One `<<<<<<< … >>>>>>>` block, as the merge would leave it. */
export interface ConflictRegionDTO {
  text: string;
  truncated: boolean;
}

export interface ConflictFileDTO {
  path: string;
  /**
   * git's own name for the conflict, from `merge-tree -z`'s *type* field.
   *
   * Its spelling is not the one its message uses, and `conflictMap.ts` reads
   * this: a content clash arrives as `contents` (plural) where the message says
   * `CONFLICT (content)`, and an `add/add` arrives as `contents` too. The rest
   * are as they read — `modify/delete`, `rename/rename`, `file/directory`,
   * `binary`. Measured against git 2.39.5, which is what the container ships.
   */
  type: string | null;
  message: string | null;
  regions: ConflictRegionDTO[];
  regionsOmitted: number;
  /** False when the merged content was not read, so `regions` says nothing. */
  regionsRead: boolean;
}

export type MergePreviewDTO =
  | { outcome: "already-merged" }
  | { outcome: "fast-forward" }
  | { outcome: "clean" }
  | { outcome: "conflict"; files: ConflictFileDTO[] }
  | { outcome: "unknown"; reason: string };

/** One changed, uncommitted path in a run's own checkout. */
export interface PendingChangeDTO {
  path: string;
  origPath: string | null;
  /** git's two status letters — `??` untracked, `" M"` edited, `"A "` staged. */
  code: string;
}

export interface PendingWorkDTO {
  path: string;
  /** Every changed path, including the ones `files` leaves out. */
  count: number;
  files: PendingChangeDTO[];
  /** False when `git status` failed, so `files` says nothing about this checkout. */
  readable: boolean;
  /** The run's task as a commit subject, offered as the default. */
  suggestedMessage: string;
}

export interface LandStateDTO {
  runId: string;
  runStatus: RunDTO["status"];
  branch: string;
  target: string | null;
  /** True when the target was deduced from the base commit, not recorded. */
  targetInferred: boolean;
  branchExists: boolean;
  ahead: number;
  behind: number;
  merged: boolean;
  /** Landed by this tool and unchanged since — how a squash reads as done. */
  landedUnchanged: boolean;
  preview: MergePreviewDTO;
  checkout: {
    path: string;
    headBranch: string | null;
    dirty: boolean;
    readable: boolean;
  } | null;
  /** Uncommitted work in the run's own checkout. Null when there is none to see. */
  pending: PendingWorkDTO | null;
  /** Why landing is refused right now. Null means it is offered. */
  blocked: string | null;
  landedAt: number | null;
  landedInto: string | null;
  landedStrategy: string | null;
}

/** One branch waiting to be landed, or already dealt with. */
export interface MergeQueueItemDTO {
  id: string;
  runId: string;
  branch: string | null;
  target: string | null;
  /**
   * The repository this branch belongs to.
   *
   * On the wire because the queue is drained one worker per repository, so what
   * a row is waiting behind is the unfinished rows *in its own* repository —
   * counting the rest would tell an operator their branch is sixth in line when
   * it is next.
   */
  repo: string | null;
  position: number;
  status:
    | "queued"
    | "landing"
    | "resolving"
    | "landed"
    | "failed"
    | "skipped"
    | "cancelled";
  strategy: string;
  autoResolve: boolean;
  message: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** What its conflict resolution cost. Never added to the run's spend. */
  resolveCostUSD: number;
}

/** One press of Land, and every branch it queued. */
export interface MergeQueueBatchDTO {
  batchId: string;
  createdAt: number;
  items: MergeQueueItemDTO[];
}

export interface MergeQueueDTO {
  /**
   * True while the worker is between or inside merges.
   *
   * It is the worker's own flag and says nothing about which batch is in flight
   * — which is why `batches` carries every outstanding one rather than the
   * newest: the row being worked is always one of these, so the distinction has
   * nothing left to hide.
   */
  working: boolean;
  /**
   * Every batch with something still to do, oldest first, then the last one
   * that finished. Drain order: what is at the top is what lands next.
   */
  batches: MergeQueueBatchDTO[];
  /**
   * How many finished batches are *not* in `batches` — what the closed history
   * disclosure is labelled with. Counted over every earlier batch rather than
   * over the ones read, so a history that stops at its own cap still says how
   * much it stopped short of.
   */
  historyCount: number;
  /**
   * Those earlier batches, newest first, and only when they were asked for.
   *
   * `null` is "not read yet" and `[]` is "there are none" — the card says
   * different things for the two, and collapsing them would make a queue whose
   * history had not loaded read as an install that has only ever pressed Land
   * once.
   */
  history: MergeQueueBatchDTO[] | null;
}

export interface BranchSummaryDTO {
  runId: string;
  runStatus: RunDTO["status"];
  branch: string;
  target: string | null;
  repoRoot: string;
  repoLabel: string;
  createdAt: number;
  ahead: number;
  merged: boolean;
  landedUnchanged: boolean;
  /**
   * Uncommitted paths in the checkout holding this branch. Null when nothing
   * holds it, its status was unreadable, or the probe cap was reached — never
   * a claim that it is clean.
   */
  uncommitted: number | null;
  exists: boolean;
  /** The producing run can still commit to it. */
  active: boolean;
  landedAt: number | null;
  prompt: string;
}

export interface DirtySlotDTO {
  /** Directory name inside the store — what the operator has to go and find. */
  name: string;
  /** Uncommitted paths in it, or null when its status could not be read. */
  uncommitted: number | null;
}

export interface CheckoutStoreDTO {
  repoRoot: string;
  repoLabel: string;
  store: string;
  ceiling: number;
  /** Slots a queued, running or paused run holds. */
  heldByRuns: number;
  /** Existing checkouts nothing holds that cannot be reused, lowest slot first. */
  dirty: DirtySlotDTO[];
  /** Slot numbers still allocatable, or null when the probe cap stopped the walk. */
  free: number | null;
}

/**
 * What one repository cost over a span.
 *
 * A rollup of `runs.spent_usd` and nothing else — reporting, never a guard, and
 * never summed with the transcript-derived meters or with telemetry: those three
 * describe overlapping work, so any sum double-counts.
 */
export interface RepoSpendRowDTO {
  key: string;
  label: string;
  /** False for the one bucket holding runs that were not in a repository. */
  isRepository: boolean;
  runCount: number;
  /**
   * A **floor**. A cycle in flight has emitted no `result` and contributes
   * nothing for its whole duration, so this only ever understates.
   */
  spentUSD: number;
  /**
   * Killed cycles reconciled from transcripts — carried beside the measured
   * figure and never inside it, the display-versus-guard split this codebase
   * makes everywhere else.
   */
  spentEstUSD: number;
  spentTokens: number;
  spentEstTokens: number;
}

export interface RepoSpendDTO {
  /** The span, in days, as the route resolved it. */
  days: number;
  since: number;
  until: number;
  rows: RepoSpendRowDTO[];
  /** The same figures over every row, so the columns can be checked against it. */
  totals: Omit<RepoSpendRowDTO, "key" | "label" | "isRepository">;
}

/** What the install is doing, and whether new work is held. */
export interface FleetStateDTO {
  /**
   * New work is held: nothing starts, nothing already started is touched.
   *
   * On the dashboard in words, because a held fleet and a quiet one look
   * identical — the meters read the same, the runs list is the same length, and
   * the only difference is that the queue never moves.
   */
  newWorkPaused: boolean;
  /** Runs not finished, by status. Every key present, including zeroes. */
  counts: Record<string, number>;
  /** Workflow instances a stop would still act on. */
  startedInstances: number;
}

/** What one install-wide stop did. */
export interface FleetStopReportDTO {
  signalled: string[];
  cancelled: string[];
  blocked: string[];
  untouched: string[];
  instances: Array<{ workflowName: string; acted: boolean; note: string | null }>;
}

/** What one bulk pick-up did, per run. */
export interface FleetReopenReportDTO {
  reopened: string[];
  refused: Array<{ id: string; reason: string }>;
}

/** One repository holding branches, for the filter. */
export interface BranchRepoDTO {
  repoRoot: string;
  repoLabel: string;
  branches: number;
}

export interface BranchInventoryDTO {
  branches: BranchSummaryDTO[];
  /**
   * Branches matching the filter that this page does not show. Counted over
   * every branch-bearing run, not over a window of the newest ones — a count
   * that is itself truncated cannot say a branch has fallen out of reach.
   */
  notShown: number;
  /** Branches matching the filter, in total. */
  total: number;
  /** Where this page starts in that list. */
  offset: number;
  /** The page size actually applied, after the per-request cap. */
  limit: number;
  /** The repository filter in force, or null for every repository. */
  repo: string | null;
  /** Every repository holding a branch, whatever the filter is set to. */
  repos: BranchRepoDTO[];
  /**
   * Checkout-slot pressure for the repositories on this page. An isolated run on
   * a repository with no slot left is refused rather than moved into the
   * operator's own checkout, so this is the reading that says a refusal is
   * coming.
   */
  checkouts: CheckoutStoreDTO[];
  /** `settings.landStrategy`, so the queue form can default to it. */
  defaultStrategy: "merge" | "squash";
}

export interface RateLimitEntryDTO {
  type: string;
  group_type: string;
  models: string[] | null;
  limits: Array<{ type: string; value: number }>;
}

export interface AccountResponse {
  configured: boolean;
  reason?: string;
  error?: string;
  rateLimits?: RateLimitEntryDTO[];
  cost?: { last30dUSD: number; daily: Array<{ date: string; usd: number }> };
  usage?: { buckets: Array<{ starting_at: string; results: Array<Record<string, unknown>> }> };
}

/**
 * How much a context prune takes out.
 *
 * Winnow ships a third, `gentle`, which is deliberately not offered: its only
 * strategy that fires on an ordinary session is `metadata-strip`, and that one
 * deletes the `usage` frames every window and every budget guard here is
 * computed from. `contextPruning.ts`'s `PRUNE_TIERS` carries the full reason.
 */
export type PruneTier = "standard" | "aggressive";

export interface SettingsDTO {
  sessionCostLimit: number | null;
  weeklyCostLimit: number | null;
  sessionTokenLimit: number | null;
  weeklyTokenLimit: number | null;
  weeklyAnchor: { weekday: number; hourUTC: number } | null;
  /** Epoch ms of a provider-side 5-hour reset the transcripts cannot show. */
  sessionResetOverrideAt: number | null;
  reservedHeadroomFraction: number | null;
  /** Read the account's own utilisation from Anthropic rather than deriving it. */
  planUsageFromApi: boolean;
  defaultPermissionMode: string;
  defaultModel: string | null;
  /**
   * The saved agent the new-run form starts on. An id, never a definition, and
   * it carries no capability — see `settings.defaultAgentId`.
   */
  defaultAgentId: string | null;
  continuationPrompt: string;
  includeSidechains: boolean;
  /** Put a delegated turn's own words in the run log. */
  forwardSubAgentText: boolean;
  /**
   * Refuse a `Read` this session has already made, and cap one whole read.
   * Off by default — see `settings.readGuard`, which states what is measured
   * about it and what is not.
   */
  readGuard: boolean;
  /**
   * The most one whole `Read` may add, in tokens. Null caps nothing, and the
   * whole field is inert while `readGuard` is off.
   */
  readGuardMaxTokens: number | null;
  /**
   * Prune the transcript at each cycle boundary, and end a cycle early once its
   * context passes the ceiling. Off by default — and note that it is what
   * replaced `--autocompact`, so an install with it off has nothing bounding a
   * long cycle. See `settings.contextPruning`.
   */
  contextPruning: boolean;
  /** How much a prune takes out. Inert while `contextPruning` is off. */
  contextPruningStrictness: PruneTier;
  /**
   * Which of winnow's two engines does the cutting.
   *
   * `"legacy"` rewrites the conversation in place and keeps the session id;
   * `"winnow"` writes a new conversation with the removed output replaced by
   * recoverable pointers and moves the run onto it, leaving the original as the
   * way back. Ships `"legacy"`.
   */
  contextPruningEngine: "legacy" | "winnow";
  /**
   * Seconds of quiet a conversation needs before the fork engine will cut it.
   *
   * Null uses winnow's own default of an hour — and a work-cycle boundary is
   * seconds old, so at that value the fork engine never fires. Lowering it is a
   * deliberate call, which is why it is a number an operator sets rather than a
   * flag the app passes: the value is recorded against every fork attempt.
   */
  contextPruningForkMinColdAge: number | null;
  /**
   * Open the next work cycle without `--resume` once the last one's context
   * passed this many tokens. Null is off, which is what every install does
   * today.
   */
  freshStartContextTokens: number | null;
  /** Work cycles only. Null means no limit. */
  maxConcurrentRuns: number | null;
  /**
   * Every `claude` child that is not a work cycle — a review, a conflict
   * resolution, a chat turn, a workflow block's deciding turn. Null means no
   * limit.
   */
  maxConcurrentAssists: number | null;
  isolationCopyGlobs: string[];
  /** Folders whose seeding list replaces the one above. */
  isolationCopyGlobsByRepo: Record<string, string[]>;
  /**
   * `--allowedTools` patterns a conflict resolution may use to check its merge.
   * Empty means none, which is what it had before this existed.
   */
  resolveVerifyTools: string[];
  isolationPreamble: string;
  /** What a run is told when it picks up the branch the run before it had. */
  continuedWorkPrompt: string;
  telemetryForRuns: boolean;
  donePushbackPrompt: string;
  liveGuardIntervalSeconds: number;
  /** How long a work cycle may print nothing before it is ended. Never null. */
  maxCycleSilenceMinutes: number;
  resumeGraceHours: number;
  /** How an isolated run's branch is brought into the branch it started from. */
  landStrategy: "merge" | "squash";
  killProcessGroup: boolean;
  /** Hard ceiling on one orchestrator-chat turn. Null means no cap. */
  chatTurnBudgetUSD: number | null;
  /** How long a settled run's event log is kept. Null keeps it for ever. */
  eventRetentionDays: number | null;
  /** How long an idle isolated checkout is kept. Null keeps it for ever. */
  checkoutRetentionDays: number | null;
  /** How long a session transcript is kept. Null keeps it for ever. */
  transcriptRetentionDays: number | null;
  /**
   * Hard ceiling on what this whole install may spend in a rolling 24 hours,
   * across every run, workflow block and chat turn. Null means no cap, which is
   * the shipped default — every other limit here bounds one spender.
   */
  installDailyCostLimitUSD: number | null;
  /** What a chat proposal runs under when it names no template. */
  chatDefaultGuards: RunGuardsDTO;
  /**
   * The mount holding the knowledge base, by id. Null is off. Names one of the
   * mounts already configured — it cannot add one — see
   * `settings.knowledgeBaseMountId`.
   */
  knowledgeBaseMountId: string | null;
  /** A directory inside that mount. `""` is the mount root. */
  knowledgeBaseSubpath: string;
  /**
   * Let a nightly run write recurring failures into that vault.
   *
   * The only field on this payload that authorises an unattended write into a
   * store this app does not own. The readout on `/dreaming` needs none of it.
   */
  dreamingEnabled: boolean;
  /** Minutes past local midnight, in `dreamingTimeZone`. */
  dreamingMinutes: number;
  /** Read twice: when the pass fires, and where a day begins. */
  dreamingTimeZone: string;
  /** Separate days a failure must span before it is written down. */
  dreamingMinDays: number;
  /** Never null — a clock removes the person who would have seen the cost. */
  dreamingMaxCostUSD: number;
  dreamingMaxPerNight: number;
}

/**
 * What each append-only store holds right now.
 *
 * A Claude Code plugin found in a workspace mount.
 *
 * Its own payload rather than a block on `SettingsDTO`, and its own row in the
 * database rather than a key of `Settings`, for one reason: the settings form
 * sends the whole object on Save, so a plugin switched on in one tab would be
 * switched back off by an unrelated save from a tab opened before it. That is a
 * nuisance for a preference and the wrong failure entirely for the list
 * deciding what code every unattended agent loads — the same reasoning that
 * keeps `newWorkPaused` out of the blob.
 */
export interface PluginDTO {
  /** Canonical absolute path as the server sees it, and the toggle's key. */
  path: string;
  /** Path relative to its mount root, which is what a person recognises. */
  relPath: string;
  mountId: string;
  mountLabel: string;
  name: string;
  version: string | null;
  description: string | null;
  /**
   * What the plugin ships — `hooks`, `skills`, `agents`, `commands`, `mcp`.
   *
   * Shown because the kinds differ in what switching one on costs. Skills,
   * agents and MCP servers put definitions into every session's context; hooks
   * and commands do not.
   */
  components: string[];
  enabled: boolean;
}

export interface PluginsReportDTO {
  plugins: PluginDTO[];
  /**
   * Malformed manifests, unavailable mounts, and enabled plugins that have
   * stopped resolving. Carried beside the list rather than dropped, because
   * every entry here is a plugin that is *absent* from it — and a list that
   * silently omits them cannot explain why what an operator is looking for is
   * not there.
   */
  problems: string[];
}

/**
 * Its own payload rather than a block on `SettingsDTO` because the two answer
 * different questions — the settings are the horizons, this is what is on disk
 * inside them — and because measuring it walks directories, which a form's own
 * read must not.
 */
export interface StorageReportDTO {
  database: {
    path: string;
    bytes: number;
    /** The write-ahead log and its index, which are the same store. */
    walBytes: number;
    runEvents: number;
    telemetryRows: number;
  };
  /** One entry per mount's `.uf-worktrees`. */
  checkouts: Array<{
    mountId: string;
    label: string;
    path: string;
    count: number;
    bytes: number;
    /** The walk hit its budget: `bytes` is a floor, never a total. */
    partial: boolean;
  }>;
  transcripts: {
    path: string;
    files: number;
    bytes: number;
    partial: boolean;
  };
  lastSweep: {
    at: number;
    events: number;
    telemetry: number;
    /** Absent on a sweep recorded before `context_samples` was swept at all. */
    samples?: number;
    /** Absent on a sweep recorded before `prune_decisions` was swept at all. */
    decisions?: number;
    /** Absent on a sweep recorded before `context_compositions` was swept at all. */
    compositions?: number;
    checkouts: number;
    transcripts: number;
    transcriptBytes: number;
  } | null;
}

/** What an agent may do, as against what it is asked to do. */
export interface RunGuardsDTO {
  permissionMode: string;
  isolate: boolean;
  budget: BudgetPolicyDTO;
}

/* ------------------------------------------------------------------ */
/* Orchestrator chat                                                   */
/* ------------------------------------------------------------------ */

export interface ChatMessageDTO {
  id: string;
  ts: number;
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * One block of a workflow the chat proposed, as the approval card reads it.
 *
 * Guard-shaped facts only. The graph itself is on the row and the canvas will
 * draw it after approval; what a card has to carry is what a person is
 * agreeing to — where each block runs, what it may do, how many agents a
 * deciding block may start, and whether a merge block may spend on a conflict.
 * An approval gate that does not show those is a gate that gets clicked
 * through, which is `spellGuards`' reasoning one level up.
 */
export interface ProposedBlockDTO {
  name: string;
  kind: WorkflowNodeKind;
  /** The template's name, or the untemplated guard set written out. */
  guardsLabel: string;
  /**
   * The agent this block's child is started as, or null for none.
   *
   * Beside the guards and never inside them: an agent holds no tool list and no
   * permission mode, so it says who the child is rather than what the block may
   * do. `"agent deleted"` for an id the registry no longer has, which approval
   * refuses by name.
   */
  agentLabel: string | null;
  /** Where it runs. Null on a merge block, which names no workspace. */
  folderLabel: string | null;
  /** How many runs a deciding block may start, with nobody looking. */
  fanOut: number | null;
  mergeAutoResolve: boolean;
  /** The blocks it starts after, by name. */
  after: string[];
}

export interface ChatProposalDTO {
  id: string;
  createdAt: number;
  /**
   * What approving this does. `run` queues a run; `workflow` **saves** a
   * workflow and starts nothing — the press of Run is still the operator's.
   */
  kind: "run" | "workflow";
  /** Null when the proposal runs under the operator's default guard set. */
  templateId: string | null;
  /** Null when there is no template, or when it has since been deleted. */
  templateName: string | null;
  /**
   * Where the guards come from. `missing` is a named template that has been
   * deleted since — approval will refuse it rather than fall back.
   */
  guardsSource: "template" | "defaults" | "missing";
  /** The template's name, or the default guards written out. */
  guardsLabel: string;
  /**
   * A *templated* proposal's guards written out, or null.
   *
   * Built by the same function that writes out the untemplated set, so the two
   * cannot come to disagree about what a ceiling means. Null where there is
   * nothing left to write: an untemplated proposal already carries the figures
   * in `guardsLabel`, and a deleted template has no values to read.
   *
   * This is deliberately *not* on the card. The name is the card's answer —
   * a template is a thing the operator wrote and can go and read — and the
   * numbers go behind the fold, because `Bug fix` on its own does not say that
   * approving it authorises twelve cycles and $4.00.
   */
  guardsDetail: string | null;
  /**
   * The prompt the chat wrote for this run in place of the template's, or null
   * where the template's own prompt stands.
   *
   * The text rather than a flag, which is what it was: the card said *that* the
   * one half of a run a model may write had been rewritten, and offered no way
   * to read it.
   */
  promptOverride: string | null;
  /**
   * The saved agent this run would be started as, by name, or null for none.
   *
   * Null when the id names nothing, because the row holds only an id — the card
   * then says the agent is gone from `agentMissing` rather than inventing a
   * name. The two are separate fields for the same reason `guardsSource` is
   * separate from `guardsLabel`: "no agent was asked for" and "the one that was
   * asked for is gone" are different facts, and approval refuses only the
   * second.
   */
  agentName: string | null;
  /**
   * This proposal names an agent that is gone, or one the CLI will not
   * register. Approval refuses it by name rather than starting the run as none.
   */
  agentMissing: boolean;
  /**
   * The model the chat named for this run, or null where it named none.
   *
   * The proposal's own, never the template's resolved through it: a templated
   * card's answer is the template's name, which the operator can go and read,
   * and drawing a figure the proposal did not choose would be this card making
   * a promise about a value that is free to change before the click. Null draws
   * nothing at all — the run then uses the template's model, or the operator's
   * default, which is what every card said before this field existed.
   *
   * Beside the agent rather than inside the guard mark, and for its reason: a
   * model bounds nothing, so a figure under the shield would claim it did.
   */
  model: string | null;
  title: string;
  task: string;
  /** Where it would run, as a person reads it. Null means "as the template says". */
  folderLabel: string | null;
  /**
   * The chat's own label for this proposal, which is the name a sibling's
   * `dependsOn` holds. Null where the model gave it none.
   *
   * On the card for `dependsOn`'s own reason: "Starts after `auth-fix`" is an
   * instruction with no referent unless the card being waited for says which
   * one it is, and the label resolves to a run at approval and nowhere else.
   */
  specId: string | null;
  /**
   * What this run waits for, by the chat's own labels. Empty on nearly every
   * proposal. Shown rather than only acted on, because a dependency that
   * silently did not survive approval reads exactly like one that was never
   * asked for — and the runs then work in the same checkout in whatever order
   * the queue felt like.
   */
  dependsOn: Array<{ label: string; edge: "on-success" | "on-finish"; continueBranch: boolean }>;
  /** A workflow proposal's blocks. Empty on a run proposal. */
  blocks: ProposedBlockDTO[];
  status: "pending" | "approved" | "rejected" | "failed";
  runId: string | null;
  /** The workflow an approved workflow proposal saved. Never a run. */
  workflowId: string | null;
  error: string | null;
}

/**
 * One question the chat put to the operator, as the panel reads it.
 *
 * Every question the thread has ever held is carried, decided ones included,
 * for `ChatProposalDTO`'s reason: a card that vanished when it was answered
 * reads as one nobody was ever asked, and the answer is part of what the
 * conversation *was*. `status` is what a reader keys on — `pending` is the only
 * one with anything left to do.
 *
 * Note what this deliberately does not carry, and cannot be made to: a guard, a
 * budget, a permission mode, a run. A question is a sentence and an answer is a
 * sentence, and the only thing answering one starts is another chat turn.
 */
export interface ChatQuestionDTO {
  id: string;
  createdAt: number;
  question: string;
  /** Concrete answers offered. Empty when the question has no shortlist. */
  choices: string[];
  /**
   * The operator may type instead of picking. Separate from `choices` being
   * empty: "pick one of these three" and "pick one of these three or say
   * something else" are different questions, and only the second may be
   * answered with prose.
   */
  allowText: boolean;
  /**
   * `superseded` is the operator having answered by saying something else. It
   * is not a failure and should not read as one — the question was overtaken.
   */
  status: "pending" | "answered" | "superseded";
  /** What the operator said, verbatim. Null unless `status` is `answered`. */
  answer: string | null;
  answeredAt: number | null;
}

export interface ChatDTO {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  status: "idle" | "thinking" | "failed";
  /** This chat's own spend. Never added to any run's, or to the meters. */
  costUSD: number;
  tokens: number;
  error: string | null;
  /**
   * When the turn in flight was claimed, null when there is none.
   *
   * The clock the page draws beside "Thinking…" is measured from this and not
   * from the last message in the thread. A turn writes into the thread itself —
   * `save_template` appends a note mid-turn — and reading the thread restarted
   * the elapsed time at zero on the one surface whose job is to say how long
   * this has been going. It is the same instant `staleTurn` measures the
   * deadline against, which is what lets the page state that deadline.
   */
  turnStartedAt: number | null;
  /**
   * `CHAT_TIMEOUT_MS`, carried rather than imported.
   *
   * The page says the ceiling in words, so the number has to be the one the
   * server enforces rather than a copy that can drift from it — and the
   * constant lives in `chat.ts`, which reaches SQLite and
   * `node:child_process`, so a `"use client"` file may not import it even for
   * a plain number.
   */
  turnTimeoutMs: number;
  messages: ChatMessageDTO[];
  proposals: ChatProposalDTO[];
  /**
   * Every question this thread has asked, oldest first.
   *
   * A pending question is derived from these rather than from `status`, which
   * stays the three states a *turn* can be in — see the note above
   * `listQuestions`. A chat waiting on an answer is `idle`: there is no child,
   * the operator may type anything they like into the composer, and doing so
   * supersedes what is open.
   */
  questions: ChatQuestionDTO[];
}

export interface ChatListEntryDTO {
  id: string;
  title: string | null;
  updatedAt: number;
  status: "idle" | "thinking" | "failed";
  costUSD: number;
  pendingCount: number;
  /**
   * Questions waiting on this thread. Beside `pendingCount` rather than added
   * to it: both are things waiting for the operator, but one is approving work
   * and the other is answering a sentence, and a list that summed them would
   * send the reader to the wrong half of the page.
   */
  pendingQuestionCount: number;
}

/* ------------------------------------------------------------------ */
/*                           Knowledge base                            */
/* ------------------------------------------------------------------ */

/**
 * What one node in the link graph is.
 *
 * `phantom` is the one that carries a decision. A link naming a note that does
 * not exist is how a vault records an intention, and Obsidian draws it — so it
 * is a node here rather than a dropped edge, flagged separately so a count of
 * "notes" never quietly includes the ones nobody has written.
 */
export type KnowledgeNodeKindDTO = "note" | "phantom" | "tag" | "attachment";

/** How an edge was written. `tag` is an edge from a note to a `tag` node. */
export type KnowledgeLinkKindDTO = "wikilink" | "embed" | "markdown" | "tag";

export interface KnowledgeNodeDTO {
  /** Namespaced by kind, so a tag named like a path can never collide. */
  id: string;
  kind: KnowledgeNodeKindDTO;
  title: string;
  /** Vault-relative path. `null` on a tag and on a phantom, which have none. */
  path: string | null;
  tags: string[];
  aliases: string[];
  inDegree: number;
  outDegree: number;
}

export interface KnowledgeEdgeDTO {
  from: string;
  to: string;
  kind: KnowledgeLinkKindDTO;
  /** The target as it was written, which is what a broken link is reported by. */
  target: string;
  label: string | null;
  heading: string | null;
  block: string | null;
  line: number;
  /** `false` means `to` is a phantom. The edge is still on the wire. */
  resolved: boolean;
  /**
   * The target's vault-relative path when the target is a **note**, and `null`
   * for everything else.
   *
   * One field rather than a path plus a kind, because the three states a reader
   * has to tell apart are exactly the three this makes: a path is somewhere the
   * page can open, `null` beside `resolved: true` is a real target the page
   * does not open (a tag, an attachment), and `null` beside `resolved: false`
   * is a link that goes nowhere. A plain `toPath` carrying an attachment's path
   * would put the third and the second on the same footing and render an
   * embedded image as a broken link.
   */
  toNotePath: string | null;
}

export interface KnowledgeHeadingDTO {
  level: number;
  text: string;
  line: number;
}

export interface KnowledgeBrokenLinkDTO {
  /** Vault-relative path of the note the link was written in. */
  from: string;
  fromTitle: string;
  target: string;
  kind: KnowledgeLinkKindDTO;
  line: number;
}

export interface KnowledgeNoteDTO {
  path: string;
  title: string;
  /** Whatever the note's frontmatter held, arbitrary keys included. */
  frontmatter: Record<string, unknown>;
  tags: string[];
  aliases: string[];
  headings: KnowledgeHeadingDTO[];
  /** The note's text with its frontmatter block removed. */
  body: string;
  outgoing: KnowledgeEdgeDTO[];
  incoming: KnowledgeEdgeDTO[];
}

export interface KnowledgeSearchHitDTO {
  path: string;
  title: string;
  tags: string[];
  score: number;
  /** Where the query matched, which is the whole of this search's ranking. */
  matched: "title" | "alias" | "tag" | "path";
}

/**
 * Whether a knowledge base is configured, whether it can be read, and what is
 * in it.
 *
 * `configured` and `available` are separate because the settings page has to
 * tell them apart: nothing chosen yet is a prompt to choose, and a mount that
 * has gone is a fault to fix. Every count is `null` rather than `0` when the
 * vault could not be read, so an unreachable mount and an empty one never
 * render alike.
 */
export interface KnowledgeStatusDTO {
  configured: boolean;
  available: boolean;
  /** A full sentence naming what is wrong, or `null` when nothing is. */
  error: string | null;
  mountId: string | null;
  mountLabel: string | null;
  /** Vault-relative to the mount. `""` is the mount root. */
  subpath: string;
  noteCount: number | null;
  orphanCount: number | null;
  brokenLinkCount: number | null;
  tagCount: number | null;
  attachmentCount: number | null;
  /** Epoch ms of the scan these figures came from. */
  scannedAt: number | null;
  /**
   * The walk hit its cap, so every figure above is a floor rather than a
   * total. Reported rather than swallowed: a partial graph reads as complete.
   */
  truncated: boolean;
  /** Are runs handed the vault-lookup skill? Its own settings row, not a field
   * of `Settings`, for the reason `plugins.enabled` is: the settings page saves
   * the whole object, so a stale tab pressing Save would silently clear it. */
  skillEnabled: boolean;
  /**
   * The vault's own ranked search, vault-relative, or `null` if it has none.
   *
   * On the wire because the skill's behaviour turns on it and nothing else
   * would tell the operator which one they got: with a script the skill ranks,
   * without one it greps and says so. Reported even when the skill is off, so
   * the answer is visible before the switch is pressed rather than after.
   */
  skillSearchScript: string | null;
}

/**
 * One link of `GET /api/knowledge/graph`: two positions in the same answer's
 * `nodes`.
 *
 * Its own type rather than a quietly weakened `KnowledgeEdgeDTO`, because that
 * one is what `knowledgeNoteView` ships and the reader genuinely needs all ten
 * of its fields — `target`, `resolved` and `toNotePath` are the three answers a
 * wikilink in a body resolves to, and `label`, `heading`, `block` and `line`
 * are what the backlink lists draw. A shared shape whose fields had silently
 * gone would be wrong on the page that renders those links and correct nowhere
 * it was checked. The graph reads two: which node each end is.
 *
 * Positions rather than the ids, and a pair rather than an object, because the
 * ratio is what makes this the payload: measured on the vault this was written
 * against, on the URL `KnowledgeGraphView` actually requests, 26,886 edges over
 * 1,134 nodes — so every node id, which is a vault path, was on the wire an
 * average of forty-seven times. 9,864,990 bytes whole; 4,601,846 with the eight
 * unread fields dropped and the ids kept; 1,056,865 as `{ from, to }` positions;
 * 734,233 as a pair.
 *
 * Nothing past the fetch ever sees one. `expandGraph` turns them back into ids
 * at the boundary, so every filter, the local-graph walk, `capGraph` and the
 * canvas keep reading `from`/`to` as the ids they always were — see the note on
 * `GraphLink` for why an index must not survive a stage that drops nodes.
 */
export type KnowledgeGraphEdgeDTO = readonly [from: number, to: number];

export interface KnowledgeGraphDTO {
  nodes: KnowledgeNodeDTO[];
  edges: KnowledgeGraphEdgeDTO[];
  /** The vault walk hit its cap — not everything was indexed. */
  truncated: boolean;
  /** This answer hit its node cap — not everything indexed was sent. */
  capped: boolean;
}

/** One note as the browse list draws it. The body is deliberately not here. */
export interface KnowledgeListEntryDTO {
  path: string;
  title: string;
  /** The directory the note sits in. `""` is the vault root. */
  folder: string;
  tags: string[];
  /** Frontmatter `type`, which is how a vault classifies a note, or `null`. */
  type: string | null;
  /** Degrees in the **whole** graph, not in the filtered page. */
  inDegree: number;
  outDegree: number;
  /** The file's mtime, epoch ms. */
  updatedAt: number;
  /** No frontmatter block at all, which is one of the three health lists. */
  missingFrontmatter: boolean;
}

/**
 * One value a filter offers, with how many notes carry it.
 *
 * The count is over the **whole vault** and not over the current result set,
 * which is the branches page's rule: a filter that hides the values you would
 * use to change it is a filter you cannot get out of.
 */
export interface KnowledgeFacetDTO {
  value: string;
  count: number;
}

/** How the browse list is ordered. */
export type KnowledgeSortDTO = "title" | "updated" | "links";

export interface KnowledgeBrowseDTO {
  notes: KnowledgeListEntryDTO[];
  /** Notes matching the filter, before the page window is applied. */
  total: number;
  offset: number;
  limit: number;
  /** Every folder and every ancestor of one, in path order — it is a tree. */
  folders: KnowledgeFacetDTO[];
  /** Most-used first: a tag list has no order of its own to preserve. */
  tags: KnowledgeFacetDTO[];
  types: KnowledgeFacetDTO[];
  sort: KnowledgeSortDTO;
  /** The vault walk hit its cap, so `total` is a floor rather than a total. */
  truncated: boolean;
}

/** A note named by one of the health lists. */
export interface KnowledgeNoteRefDTO {
  path: string;
  title: string;
  folder: string;
}

/**
 * What is wrong with the vault, in the three shapes an operator can act on.
 *
 * Each list is cut to `listLimit` and each count is the whole of it, derived in
 * the same pass — the count and the list can therefore never disagree, which is
 * `restartClosedRuns`' rule: a badge computed by a second query is a badge that
 * drifts from the list it opens onto.
 */
export interface KnowledgeHealthDTO {
  /** Notes joined to no other note in either direction. Tags do not count. */
  orphans: KnowledgeNoteRefDTO[];
  orphanCount: number;
  /** Every link that resolved to nothing, with the note that wrote it. */
  brokenLinks: KnowledgeBrokenLinkDTO[];
  brokenLinkCount: number;
  /** Notes with no frontmatter block at all. */
  missingFrontmatter: KnowledgeNoteRefDTO[];
  missingFrontmatterCount: number;
  /** Notes indexed, which every count above is a share of. */
  noteCount: number;
  /** How many rows each list above was cut to. */
  listLimit: number;
  truncated: boolean;
  scannedAt: number;
}

/* ------------------------------------------------------------------ */
/*                             Dreaming                                */
/* ------------------------------------------------------------------ */

/**
 * One normalised failure signature, everywhere it has appeared.
 *
 * **`signature` is a string, not a cause**, and every surface that renders one
 * has to say so somewhere the reader will see it. Normalisation collapses
 * numbers, hex runs and path interiors, so one cause routinely appears as
 * several rows — the four `bwrap` denials at four different files are one
 * denial — and one row routinely carries many causes, of which `Exit code N` is
 * the worst in this corpus. A count here is a count of strings that recurred.
 */
export interface DreamingSignatureDTO {
  signature: string;
  /** The machine's own words, clipped. Never a description of them. */
  sample: string;
  /** Distinct days it appeared on, ascending. */
  days: string[];
  instances: number;
  /** Sessions it was seen in, cut to a link list rather than an audit. */
  sessions: string[];
  /** Whether this app has already written a note for it. */
  written: boolean;
}

/** A note this app wrote, and whether the file is still there. */
export interface DreamingNoteDTO {
  signature: string;
  sample: string;
  writtenAt: number;
  night: string;
  runId: string | null;
  /** Vault-relative. Null when the run wrote nothing for this signature. */
  notePath: string | null;
  daysSeen: number;
  instances: number;
  /**
   * `true` when the file is on disk, `false` when it is gone, `null` when there
   * is no path to check or the vault is unreachable.
   *
   * Three values rather than two because the vault has no version control: a
   * note deleted in Obsidian leaves no trace except its absence, and "we cannot
   * tell" must not render as "it is gone".
   */
  present: boolean | null;
}

export type DreamingNightOutcomeDTO = "selected" | "quiet" | "refused" | "failed";

export interface DreamingNightDTO {
  night: string;
  startedAt: number;
  outcome: DreamingNightOutcomeDTO;
  reason: string | null;
  runId: string | null;
  selected: number;
}

/**
 * What `/dreaming` reads.
 *
 * `writerConfigured` and `refusal` are separate from `enabled` on purpose: the
 * readout half needs no configuration at all and is always available, so a page
 * that conflated them would tell an operator with no vault that there is
 * nothing to see.
 */
export interface DreamingDTO {
  /** Signatures spanning two or more days, by days spanned then instances. */
  recurring: DreamingSignatureDTO[];
  totalSignatures: number;
  totalInstances: number;
  recurringInstances: number;
  /** Days in the scanned window that carried at least one error. */
  days: string[];
  filesWalked: number;
  filesRead: number;
  /**
   * Records dropped as copies of one already counted.
   *
   * A resumed session rewrites its earlier records into the new transcript.
   * Reported rather than absorbed, because it is the difference between this
   * readout and a naive count of the same corpus, and the first note this
   * feature ever wrote flagged that gap by re-deriving the numbers.
   */
  duplicates: number;
  scannedInMs: number;
  scannedAt: number;

  /** The write half. */
  enabled: boolean;
  /** Why a night would refuse right now, or null if it would run. */
  refusal: string | null;
  /** Local time of day the nightly pass fires, and the zone it is read in. */
  fireAtMinutes: number;
  timeZone: string;
  minDays: number;
  maxPerNight: number;
  maxCostUSD: number;
  /** The vault it would write into, as a label rather than a container path. */
  vaultLabel: string | null;

  notes: DreamingNoteDTO[];
  nights: DreamingNightDTO[];
  /**
   * Whether either list above was cut, and to what.
   *
   * `git-and-review.md`'s rule: a shortened list must say it is shortened. A
   * ledger that silently stopped at 500 would read as the complete record of
   * what this app has written into somebody's vault, which is the one thing it
   * must never be wrong about.
   */
  noteLimit: number;
  notesTruncated: boolean;
  nightLimit: number;
  nightsTruncated: boolean;
}
