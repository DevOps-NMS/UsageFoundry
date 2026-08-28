import { type TokenCounts } from "./pricing";

/**
 * What is *in* the contexts this machine paid for, read out of the same
 * transcripts `scanUsage` prices.
 *
 * **This is a composition reading and never a cost source.** Everything in
 * `windows.ts` reconciles: `byModel`, `byProject`, `byAgent`, `bySkill` and
 * `byEffort` each put every turn in exactly one bucket, so every column adds
 * back to the window total and a missing bucket is visible as a gap rather than
 * silently absorbed. `byTool` **cannot** do that, and no amount of care would
 * make it: a `tool_result` is not a billable turn. It carries no `usage` block,
 * no model, no `requestId` and no price — the tokens it costs are billed on the
 * *next* assistant turn, mixed in with the system prompt, the conversation so
 * far and every other tool result placed beside it, and nothing in the format
 * says which of them contributed what. So this reading is denominated in
 * characters of tool output, its rows carry no money at all, and any figure
 * here added to `costUSD`, to `runs.spent_usd` or to telemetry is arithmetic
 * over two different units.
 *
 * The precedent is `parseCompactionBoundary` one module over, and the rule it
 * records applies here word for word: every consumer of `UsageEntry` treats a
 * member as a billable turn, so a tool record reaching that array would be
 * counted by `buildSnapshot`, by `agentSpend` and by the budget guard. This
 * reader therefore keeps its own type, its own dedupe key and its own rollup,
 * and shares nothing with the metering path but the file the lines came from.
 *
 * Why it is worth reading at all: the five breakdowns say *who* spent the money
 * and *what model* spent it, and none of them says what the money was spent
 * carrying. On this install cache reads are ~57% of the weekly bill, which is
 * the cost of re-reading a context, and the largest thing in that context is
 * tool output — file reads and command output that an agent asked for once and
 * then paid to carry for the rest of the session. That is the one composition
 * an operator can act on without changing what the work is, and until now no
 * view in this app could see it.
 */

/**
 * One tool call, paired with the size of the result that answered it.
 *
 * `id` is `tool_use.id` — unique per call, which is what makes it the dedupe
 * key across files. A resumed session copies the conversation forward into the
 * new transcript, so the same call is written more than once for exactly the
 * reason a turn is, and summing without a key over-reports by the same rough
 * factor.
 *
 * `resultChars` is null while no matching `tool_result` has been seen. Null
 * rather than 0, because a call still in flight and a call that answered with
 * nothing are different facts and the second is real (`ExitPlanMode`, a `Write`
 * that reports one word). Only null is excluded from the character total; a
 * genuine zero is a zero.
 */
export interface ToolCall {
  id: string;
  /** Epoch ms of the record the call was written on. */
  ts: number;
  /** The tool's own name, verbatim: `Bash`, `Read`, `mcp__…__navigate`. */
  name: string;
  /** From the call's record, so this filters the same way `UsageEntry` does. */
  isSidechain: boolean;
  resultChars: number | null;
}

/** A `tool_result` block's size, keyed by the call it answers. */
export interface ToolResultSize {
  toolUseId: string;
  chars: number;
}

/** What one transcript line contributed, or null for the lines that carry none. */
export interface ToolRecord {
  calls: ToolCall[];
  results: ToolResultSize[];
}

/**
 * Characters of *text* a result placed into the context.
 *
 * A result's content is a plain string on 96% of this corpus and an array of
 * content blocks on the rest — `text`, `image` and `tool_reference` are the
 * three shapes observed. Only `text` is counted, and that is a deliberate
 * understatement rather than an oversight: an image block carries base64, whose
 * character count is roughly four times its byte count and bears no relation at
 * all to the ~1,600 tokens the model is billed for it, so including it would
 * make a screenshot the largest thing on the card by two orders of magnitude.
 * A `tool_reference` names a call and holds no content. So a tool that answers
 * in pictures reads low here, which is the direction a composition reading
 * should err in — it under-claims rather than inventing a number.
 */
function resultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let chars = 0;
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
    }
  }
  return chars;
}

/**
 * The tool blocks on one transcript line, or null for every other line.
 *
 * Separate from `parseLine` for `parseCompactionBoundary`'s stated reason, and
 * with its stated shape: the substring test comes **before** the parse, because
 * a scan reads whole transcripts and JSON-parsing every line of one to find the
 * quarter that carry a tool block is the cost this test exists to avoid. A line
 * whose *content* happens to contain the literal costs one wasted parse and
 * returns null, which is the cheap direction to be wrong in.
 *
 * Every field is read defensively, which makes a rename in the CLI's format
 * **silent** — the card would simply report fewer tools, or none. That is what
 * the unit tests pin against records captured from the pinned build, and it is
 * the same exposure `toolResultFailures` and `permissionDenials` already carry.
 *
 * A call with no parsable timestamp is dropped rather than defaulted: this
 * reading is scoped to a window, and a call at epoch 0 would sit outside every
 * window forever while still being counted in nothing.
 */
export function parseToolRecord(line: string): ToolRecord | null {
  if (!line.startsWith("{")) return null;
  // One pass for both block types rather than two for neither. A line carrying
  // no tool block used to be scanned end to end twice — once failing to find
  // `"tool_use"` and again failing to find `"tool_result"` — and on this store
  // that is 42% of lines averaging 3.3 KB each. `"tool_` is a prefix of both
  // literals, so every line the pair admitted this admits: strictly more
  // permissive, and therefore incapable of changing what the parse below
  // returns. What it lets through extra is a line holding some other `tool_`
  // key, which costs one wasted parse and a null — measured at 9 lines in
  // 20,798, and the direction this test is documented as preferring to be
  // wrong in.
  if (!line.includes('"tool_')) return null;

  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return null; // partially flushed or corrupt — skip, do not abort the file
  }

  const message = rec.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return null;

  const ts = Date.parse(String(rec.timestamp ?? ""));
  const isSidechain = rec.isSidechain === true;

  const calls: ToolCall[] = [];
  const results: ToolResultSize[] = [];

  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;

    if (block.type === "tool_use") {
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      if (!id || !name || !Number.isFinite(ts)) continue;
      calls.push({ id, ts, name, isSidechain, resultChars: null });
      continue;
    }

    if (block.type === "tool_result") {
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (!toolUseId) continue;
      results.push({ toolUseId, chars: resultChars(block.content) });
    }
  }

  if (calls.length === 0 && results.length === 0) return null;
  return { calls, results };
}

/** One tool's share of what was placed into contexts. Never money. */
export interface ToolCompositionRow {
  /** The tool's own name, exactly as the CLI recorded it. */
  tool: string;
  calls: number;
  /** Characters of text this tool's results placed. */
  resultChars: number;
  /** Share of `totalResultChars`, 0–1. Null is impossible — see the rollup. */
  share: number;
}

/**
 * What filled the contexts in one window, and what filling one costs.
 *
 * An object with `rows` rather than an array, and that shape is load-bearing:
 * it sits on `UsageSnapshot` beside five breakdowns that *are* arrays of
 * `{ …, agg: Aggregate }`, and anything written to walk one of those over this
 * fails to compile instead of quietly reporting characters as dollars.
 *
 * The three placement figures are the one thing here derived from the price
 * table, and they are **rates**, not totals — nothing can be summed with them
 * and no row carries a share of them. They exist because the composition above
 * is only actionable once the price of placing a token is visible: on a
 * long-running session a token placed is re-read on every subsequent turn, so
 * its all-in cost is nothing like the list input rate it was first billed at.
 */
export interface ToolComposition {
  /** Start of the window these rows cover — the same one the breakdowns use. */
  from: number;
  /** Character-descending. */
  rows: ToolCompositionRow[];
  totalCalls: number;
  totalResultChars: number;
  /**
   * Calls with no result recorded: interrupted mid-flight, or answered in a
   * transcript this scan could not read. Counted rather than dropped, so the
   * call total and the character total cannot silently describe different sets.
   */
  unansweredCalls: number;
  /**
   * Every token that *entered* a context in this window, counted once.
   *
   * `input` (fresh and uncached), `cacheWrite5m` + `cacheWrite1h` (fresh and
   * cached) and `output` (generated, and part of the context from the next turn
   * on) are the three ways a token gets into a conversation, and the provider
   * reports them disjointly. `cacheRead` is deliberately absent: it is the same
   * token being read again, which is the whole point of the ratio below.
   *
   * It is an **over**-count of distinct tokens, and therefore the figures
   * derived from it are floors: a prefix rewritten or a cache entry whose TTL
   * lapsed is written again, and this counts each write. Erring that way makes
   * `costPerMillionPlacedUSD` too low rather than too high, which is the
   * direction a number an operator might act on should be wrong in.
   */
  placedTokens: number;
  /**
   * How many times the average placed token was read back — `cacheRead` over
   * `placedTokens`. Null when nothing was placed.
   */
  reReadRatio: number | null;
  /**
   * The window's whole bill divided by the tokens placed into it.
   *
   * Not a price anybody is charged and not a per-tool figure: it is the answer
   * to "what does it cost to put a million tokens in front of this workload",
   * which is a much larger number than the list input rate because almost all
   * of the bill is re-reading what is already there. Null when nothing was
   * placed, and a floor whenever the window holds an unpriced model, for the
   * standing reason `costUSD` is one.
   */
  costPerMillionPlacedUSD: number | null;
}

/**
 * Roll deduplicated tool calls up by tool name, over one window.
 *
 * Pure, and deliberately given the window's aggregate rather than reading one:
 * this module knows nothing about `Aggregate`, which lives in `windows.ts` and
 * would import this back. The two numbers it takes are the ones `pricing.ts`
 * already defines, so the dependency runs one way.
 *
 * Every call in `calls` lands in exactly one row and `share` sums to 1 across
 * them whenever anything was placed — which is the *only* reconciliation this
 * reading makes, and it is a reconciliation of characters to characters. It
 * does not reconcile to a window total, cannot be made to, and must never be
 * presented as though it did.
 */
export function buildToolComposition(
  calls: readonly ToolCall[],
  from: number,
  tokens: TokenCounts,
  costUSD: number,
): ToolComposition {
  const byName = new Map<string, { calls: number; resultChars: number }>();
  let totalCalls = 0;
  let totalResultChars = 0;
  let unansweredCalls = 0;

  for (const call of calls) {
    if (call.ts < from) continue;
    const row = byName.get(call.name) ?? { calls: 0, resultChars: 0 };
    row.calls += 1;
    if (call.resultChars === null) unansweredCalls += 1;
    else {
      row.resultChars += call.resultChars;
      totalResultChars += call.resultChars;
    }
    byName.set(call.name, row);
    totalCalls += 1;
  }

  const rows: ToolCompositionRow[] = [...byName.entries()]
    .map(([tool, row]) => ({
      tool,
      calls: row.calls,
      resultChars: row.resultChars,
      share: totalResultChars > 0 ? row.resultChars / totalResultChars : 0,
    }))
    .sort((a, b) => b.resultChars - a.resultChars);

  const placedTokens =
    tokens.input + tokens.output + tokens.cacheWrite5m + tokens.cacheWrite1h;

  return {
    from,
    rows,
    totalCalls,
    totalResultChars,
    unansweredCalls,
    placedTokens,
    reReadRatio: placedTokens > 0 ? tokens.cacheRead / placedTokens : null,
    costPerMillionPlacedUSD:
      placedTokens > 0 ? (costUSD / placedTokens) * 1_000_000 : null,
  };
}
