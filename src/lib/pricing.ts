/**
 * Model pricing and cost derivation.
 *
 * All rates are USD per million tokens, expressed as the *input* base rate.
 * Cache tokens are multiples of that base rate rather than independent numbers:
 *
 *   cache read            0.10x input  (per-model; see below)
 *   cache write (5m TTL)  1.25x input
 *   cache write (1h TTL)  2.00x input
 *
 * This matters: Claude Code uses 1h-TTL cache writes heavily, which cost 2x
 * input, not 1.25x. Collapsing both into one "cache creation" number
 * understates spend on exactly the workload this tool is built to measure.
 *
 * **The cache read multiplier is a property of the model, not a constant.**
 * It was 0.10x on every model this table knew until Claude Fable 5.1 and
 * Claude Mythos 5.1 shipped at 0.025x ($0.25/MTok against a $10 input), and
 * that is 4x, on the line item this tool exists to measure — a Claude Code
 * workload is ~98% cache reads, so a hard-coded 0.10x would overstate a Fable
 * 5.1 run's bill by nearly 4x and refuse it against a ceiling it never
 * reached. `CACHE_READ_MULTIPLIER` remains the default every entry inherits;
 * an entry that overrides it says so, and `cacheReadMultiplierOf` is the only
 * thing that may read either. The write multipliers are still constants
 * because no model has departed from them; when one does, it takes the same
 * shape rather than a second mechanism.
 */

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /**
   * Cache read as a multiple of `input`, when this model departs from
   * `CACHE_READ_MULTIPLIER`. Absent means the default, which is what every
   * entry but the 5.1 pair means.
   */
  cacheReadMultiplier?: number;
}

/**
 * The cache read multiplier in force for a price, default included.
 *
 * Every site that prices a cache read — this module's `costOf`, and the two
 * counterfactuals in `contextPruning.ts` and `intakeFilter.ts` that price a
 * read that did *not* happen — goes through here rather than reading the
 * constant, so a model that departs from it cannot be right in one place and
 * wrong in three.
 */
export function cacheReadMultiplierOf(price: ModelPrice): number {
  return price.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER;
}

/**
 * Keys are matched longest-prefix-first against the model string reported in
 * the transcript, so `claude-opus-4-5-20251101` resolves via `claude-opus-4-5`.
 */
const PRICES: Record<string, ModelPrice> = {
  // Fable / Mythos tier. The 5.1 pair is listed ahead of the 5 pair it would
  // otherwise prefix-match, and exists *only* to carry the cache read rate:
  // input and output are the same $10/$50, so an entry left out here would be
  // priced correctly on both visible columns and 4x wrong on the invisible one.
  "claude-fable-5-1": { input: 10, output: 50, cacheReadMultiplier: 0.025 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheReadMultiplier: 0.025 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-mythos-preview": { input: 10, output: 50 },

  // Opus tier
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4-0": { input: 15, output: 75 },
  "claude-3-opus": { input: 15, output: 75 },

  // Sonnet tier (claude-sonnet-5 has promotional pricing — see resolvePrice)
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-0": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },

  // Haiku tier
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
};

/** Fast mode runs the same model at premium rates. */
const FAST_MODE_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 10, output: 50 },
};

/** Claude Sonnet 5 introductory pricing runs through 2026-08-31 inclusive. */
const SONNET_5_INTRO_PRICE: ModelPrice = { input: 2, output: 10 };
const SONNET_5_INTRO_ENDS = Date.parse("2026-09-01T00:00:00Z");

/**
 * Rate charged to a model this table cannot place — for the budget guard only.
 *
 * $10/$50 is the most expensive *current-generation* entry above (Fable /
 * Mythos), deliberately not the $5/$25 Opus tier: an unrecognised ID must not
 * be able to look cheaper than a model that is actually in the table. The
 * $15/$75 entries are deprecated snapshots rather than a plausible shape for a
 * future launch, so they are not the benchmark.
 *
 * This is the same trade the Claude apps gateway's spend meter makes, and for
 * the same reason — an ID nothing can price must not go unmetered, or a cap
 * stops being a cap.
 *
 * It carries no `cacheReadMultiplier`, so it inherits the 0.10x default rather
 * than Fable 5.1's cheaper 0.025x, and that is the same trade again: the
 * unknown rate must be the dearest plausible shape, and 0.10x on a $10 input
 * is dearer than 0.025x on one.
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 10, output: 50 };

const PREFIXES = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/**
 * Reduce a provider-decorated model string to the first-party form the table
 * is keyed on.
 *
 * Bedrock serves `us.anthropic.claude-…-v1:0` and Google's Agent Platform
 * serves `claude-…@20250929` — both name a model this table knows perfectly
 * well, but either would miss the prefix match and be charged the unknown
 * rate. Only decoration is stripped; nothing here maps one model onto another.
 * Note what is deliberately absent: no short catch-all keys like
 * `claude-opus-4`, because those would price an unreleased `claude-opus-4-9`
 * at a confident wrong number instead of surfacing it as unknown.
 */
function canonicalModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/^(us|us-gov|eu|apac|global)\./, "")
    .replace(/^anthropic\./, "")
    .replace("@", "-");
}

/**
 * Resolve pricing for a model string at a point in time.
 *
 * Returns null for unknown models rather than guessing — an unpriced model
 * should surface as "unknown" in the UI, not silently contribute $0 and make
 * a budget look safer than it is.
 */
export function resolvePrice(
  model: string | undefined,
  opts: { at?: number; speed?: string } = {},
): ModelPrice | null {
  if (!model) return null;
  const id = canonicalModelId(model);

  const key = PREFIXES.find((p) => id.startsWith(p));
  if (!key) return null;

  if (opts.speed === "fast" && FAST_MODE_PRICES[key]) {
    return FAST_MODE_PRICES[key];
  }
  if (key === "claude-sonnet-5") {
    const at = opts.at ?? Date.now();
    if (at < SONNET_5_INTRO_ENDS) return SONNET_5_INTRO_PRICE;
  }
  return PRICES[key];
}

export function isKnownModel(model: string | undefined): boolean {
  return resolvePrice(model) !== null;
}

/** Token counts broken out by how each class is billed. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const ZERO_TOKENS: TokenCounts = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
};

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

/**
 * Total tokens, for limit windows that are measured in raw token volume.
 * Cache reads are included because they still consume the window even though
 * they are cheap in dollar terms.
 */
export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

/** Tokens excluding cache reads — a closer proxy for "real" work done. */
export function billableWeightedTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h;
}

/**
 * Cost for budget-guard purposes, charging an unknown model the fallback rate
 * rather than nothing.
 *
 * `costOf` returns 0 for an unpriced model, which is the honest number to
 * *display* — but it also means a model this table cannot place contributes
 * nothing to a cost-denominated guard. With a whole window unpriced the
 * fraction is exactly 0 and the guard can never fire, so the one setting a
 * user reaches for to bound spend silently stops existing at exactly the
 * moment a new model ships.
 *
 * Only `evaluateBudget` reads this. The dashboard keeps reporting the $0 floor
 * and naming the model, so no figure shown to a user is ever a guess.
 */
export function guardCostOf(
  tokens: TokenCounts,
  price: ModelPrice | null,
): number {
  return costOf(tokens, price ?? UNKNOWN_MODEL_PRICE);
}

export function costOf(tokens: TokenCounts, price: ModelPrice | null): number {
  if (!price) return 0;
  const perToken = price.input / 1_000_000;
  const outPerToken = price.output / 1_000_000;
  return (
    tokens.input * perToken +
    tokens.output * outPerToken +
    tokens.cacheRead * perToken * cacheReadMultiplierOf(price) +
    tokens.cacheWrite5m * perToken * CACHE_WRITE_5M_MULTIPLIER +
    tokens.cacheWrite1h * perToken * CACHE_WRITE_1H_MULTIPLIER
  );
}


/**
 * Where a bill actually went, in dollars, by term.
 *
 * ## Why this is worth a function
 *
 * MEASURED across 90 deduplicated usage frames on one install, priced with the
 * table in this file at the one-hour write class:
 *
 *     cache writes    48.1% of the bill   from  7% of the tokens
 *     cache reads     31.6%               from 92% of the tokens
 *     output          20.2%               from  1% of the tokens
 *
 * A loop can be almost entirely cache reads by volume and still spend half its
 * money on writes, because the multipliers are 0.1x and 2.0x - a twentyfold
 * ratio that no token count shows. An operator looking at a token chart is
 * looking at the 92% that costs a third, and the term that actually decides
 * their bill is the one that barely appears.
 *
 * `costOf` above already sums these five terms and is the figure everything
 * else in this app trusts. This returns the SAME arithmetic broken out rather
 * than a second computation of it, and `costSplitOf(t, p).total` is asserted
 * equal to `costOf(t, p)` in the tests - a split that could drift from the
 * total would be two statements of one policy, which is how a readout starts
 * telling an operator something the guard does not believe.
 */
export interface CostSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function costSplitOf(
  tokens: TokenCounts,
  price: ModelPrice | null,
): CostSplit {
  if (!price) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
  const perToken = price.input / 1_000_000;
  const split = {
    input: tokens.input * perToken,
    output: tokens.output * (price.output / 1_000_000),
    cacheRead: tokens.cacheRead * perToken * cacheReadMultiplierOf(price),
    // The two write classes are one line on a receipt: an operator cannot
    // choose between them and the distinction is the API's, not theirs.
    cacheWrite:
      tokens.cacheWrite5m * perToken * CACHE_WRITE_5M_MULTIPLIER +
      tokens.cacheWrite1h * perToken * CACHE_WRITE_1H_MULTIPLIER,
  };
  // `costOf`, not a re-sum of the four terms above. Adding them again gives a
  // number that differs from it in the last bits of a float, and a receipt that
  // disagrees with the guard by a rounding error is still a receipt that
  // disagrees. One definition of the total, and this is not it.
  return { ...split, total: costOf(tokens, price) };
}

/** The same split as shares of the total, or null when nothing was spent. */
export function costSharesOf(split: CostSplit): Record<keyof Omit<CostSplit, "total">, number> | null {
  if (!(split.total > 0)) return null;
  return {
    input: split.input / split.total,
    output: split.output / split.total,
    cacheRead: split.cacheRead / split.total,
    cacheWrite: split.cacheWrite / split.total,
  };
}

export function knownModelIds(): string[] {
  return [...PREFIXES];
}
