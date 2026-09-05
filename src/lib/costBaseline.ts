import { createHash } from "node:crypto";

/**
 * What a task normally costs, and the run that is about to cost triple.
 *
 * ## The measurement this exists because of
 *
 * Six runs of ONE identical task - same folder, same prompt, same model, same
 * cycle cap, on one install, interleaved against time drift - cost:
 *
 *     $0.1937  $0.2560  $0.2716  $0.2834  $0.3779  $0.4417
 *
 * A **2.28x spread**, 30% coefficient of variation, and 2.39x on tokens. The
 * agent's own run-to-run behaviour is the dominant cost term in this loop.
 *
 * Set that beside the mechanisms this pair already instruments precisely, from
 * winnow's own README: the intake filter is worth **+3.76%** and the pruner
 * **+3.27%**. Both are real, and both are an order of magnitude smaller than
 * the noise they sit in. The money is not in the mean. It is in the tail.
 *
 * ## So this guards the tail, and nothing else
 *
 * `maxRunCostUSD` is an absolute ceiling and has to be set high enough for the
 * worst legitimate run, which makes it useless against a run that is merely
 * three times its own task's normal. This is the relative one: it knows what
 * THIS task has cost before and stops the run that has left that distribution.
 *
 * Off unless a factor is set, and silent until there are samples to speak from
 * - a baseline of one run is an anecdote, and a guard that fired on it would
 * teach an operator to switch guards off.
 */

/** Below this many completed runs, a baseline is an anecdote and says nothing. */
export const MIN_BASELINE_SAMPLES = 3;

export type CostBaseline = { medianUSD: number; samples: number };

/**
 * A stable key for "the same task", from the folder and the prompt.
 *
 * Whitespace-normalised and lowercased before hashing, so a reflowed prompt is
 * the same task - an operator who fixed a typo has not created a new
 * distribution, and treating it as one would silently reset the baseline to
 * nothing exactly when they were iterating on the wording.
 *
 * Hashed rather than stored raw because `runs.prompt` for a private repository
 * is a complete product brief, and this key ends up in an index and a log line.
 */
export function taskSignature(folder: string, prompt: string): string {
  const normal = `${(folder ?? "").trim()} ${(prompt ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()}`;
  return createHash("sha256").update(normal).digest("hex").slice(0, 16);
}

/**
 * The middle of what this task has cost, or null when there is not enough.
 *
 * MEDIAN, not mean, and that is the whole point of the module: the thing being
 * guarded against is a heavy tail, and a mean is dragged upward by exactly the
 * runs the guard exists to catch. Two expensive runs would raise a mean enough
 * to admit a third.
 */
export function baselineFrom(costsUSD: readonly number[]): CostBaseline | null {
  const usable = costsUSD
    .filter((c) => Number.isFinite(c) && c > 0)
    .sort((a, b) => a - b);
  if (usable.length < MIN_BASELINE_SAMPLES) return null;
  const mid = Math.floor(usable.length / 2);
  const median =
    usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
  return { medianUSD: median, samples: usable.length };
}

export type OutlierVerdict =
  | { over: false; reason: null }
  | { over: true; reason: string };

/**
 * Has this run left its own task's distribution?
 *
 * Every "no" here is a different no, and none of them is a silent pass: no
 * factor configured, not enough history, or inside the band. They are separated
 * because an operator asking "why did this not fire" is asking which of the
 * three it was.
 */
export function outlierVerdict(o: {
  spentUSD: number;
  baseline: CostBaseline | null;
  factor: number | null;
}): OutlierVerdict {
  if (!o.factor || o.factor <= 1) return { over: false, reason: null };
  if (!o.baseline) return { over: false, reason: null };
  const ceiling = o.baseline.medianUSD * o.factor;
  if (o.spentUSD < ceiling) return { over: false, reason: null };
  return {
    over: true,
    reason:
      `This run has spent $${o.spentUSD.toFixed(2)}, which is ` +
      `${(o.spentUSD / o.baseline.medianUSD).toFixed(1)}x what this task has ` +
      `cost before - a median of $${o.baseline.medianUSD.toFixed(2)} over ` +
      `${o.baseline.samples} runs, against a limit of ${o.factor}x. It was ` +
      `stopped for being unlike itself rather than for reaching a ceiling.`,
  };
}
