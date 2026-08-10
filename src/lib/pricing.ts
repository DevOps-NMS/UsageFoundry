/**
 * Model pricing and cost derivation.
 *
 * All rates are USD per million tokens, expressed as the *input* base rate.
 * Cache tokens are multiples of that base rate rather than independent numbers:
 *
 *   cache read            0.10x input
 *   cache write (5m TTL)  1.25x input
 *   cache write (1h TTL)  2.00x input
 *
 * This matters: Claude Code uses 1h-TTL cache writes heavily, which cost 2x
 * input, not 1.25x. Collapsing both into one "cache creation" number
 * understates spend on exactly the workload this tool is built to measure.
 */

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * Keys are matched longest-prefix-first against the model string reported in
 * the transcript, so `claude-opus-4-5-20251101` resolves via `claude-opus-4-5`.
 */
const PRICES: Record<string, ModelPrice> = {
  // Fable / Mythos tier
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

const PREFIXES = Object.keys(PRICES).sort((a, b) => b.length - a.length);

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
  const id = model.toLowerCase().replace(/^anthropic\./, "");

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

export function costOf(tokens: TokenCounts, price: ModelPrice | null): number {
  if (!price) return 0;
  const perToken = price.input / 1_000_000;
  const outPerToken = price.output / 1_000_000;
  return (
    tokens.input * perToken +
    tokens.output * outPerToken +
    tokens.cacheRead * perToken * CACHE_READ_MULTIPLIER +
    tokens.cacheWrite5m * perToken * CACHE_WRITE_5M_MULTIPLIER +
    tokens.cacheWrite1h * perToken * CACHE_WRITE_1H_MULTIPLIER
  );
}

export function knownModelIds(): string[] {
  return [...PREFIXES];
}
