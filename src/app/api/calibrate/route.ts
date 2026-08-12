import { NextResponse } from "next/server";
import { scanUsage } from "@/lib/transcripts";
import { buildSessionBlocks, WEEK_MS } from "@/lib/windows";
import { totalTokens } from "@/lib/pricing";
import { getSettings } from "@/lib/settings";
import { planUsage } from "@/lib/planUsage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Propose limit ceilings from observed history.
 *
 * Anthropic publishes no numeric value for a Pro/Max limit and exposes no
 * endpoint to read one, so a ceiling has to come from somewhere. The least-bad
 * source is the user's own peak usage: if a 5-hour block reached N without
 * being cut off, the real ceiling is at least N.
 *
 * Both a cost and a token figure are returned, but **cost is the headline**.
 * A Claude Code workload is overwhelmingly cache reads billed at 0.1x, so raw
 * token peaks vary with context size far more than with work performed; the
 * cost peak is the steadier signal.
 *
 * Either way these are **lower bounds on the true limit**, which makes any
 * percentage computed against them conservative — it reads high rather than
 * low, so a budget guard trips early rather than late.
 */
/**
 * The utilisation below which a measured ceiling is not worth reporting.
 *
 * The provider reports whole-ish percentage points, so a window at 2% divides
 * a cost by a number carrying ±25% of relative error — and it divides by a
 * denominator that is mostly rounding. At 10% the same absolute granularity is
 * a few percent, which is well inside the error the coverage caveat already
 * carries.
 */
const MEASURABLE_UTILIZATION = 0.1;

/**
 * The ceiling implied by a window that is part spent: what we can see it cost,
 * over the share of the allowance the provider says it took.
 *
 * This is a measurement rather than the peak-derived lower bound below, and it
 * is the only way to put a number on a limit Anthropic publishes nowhere. It
 * still errs low, for a reason worth keeping: the numerator is Claude Code's
 * transcripts and the denominator counts every surface, so a week that also
 * held Desktop or web work divides a partial cost by a full percentage.
 * Reading low means percentages computed against it read high, which is the
 * same direction the peak method already errs in.
 */
function measuredCeiling(
  costUSD: number,
  utilization: number | undefined,
): number | null {
  if (utilization === undefined || utilization < MEASURABLE_UTILIZATION) {
    return null;
  }
  if (!(costUSD > 0)) return null;
  return Math.round((costUSD / utilization) * 100) / 100;
}

export async function GET() {
  const settings = getSettings();
  const [{ entries }, plan] = await Promise.all([
    scanUsage(),
    settings.planUsageFromApi ? planUsage() : Promise.resolve(null),
  ]);
  const filtered = settings.includeSidechains
    ? entries
    : entries.filter((e) => !e.isSidechain);

  if (filtered.length === 0) {
    return NextResponse.json({
      ok: false,
      reason: "No usage history found to calibrate against.",
    });
  }

  const now = Date.now();
  const blocks = buildSessionBlocks(
    filtered,
    now,
    plan?.session?.resetsAt ?? settings.sessionResetOverrideAt,
  );

  // Only fully-elapsed blocks represent a complete window; an active block is
  // still filling and would drag the estimate down.
  const closed = blocks.filter((b) => !b.isActive);
  const blockTokens = closed.map((b) => totalTokens(b.agg.tokens)).sort((a, b) => a - b);
  const blockCost = closed.map((b) => b.agg.costUSD).sort((a, b) => a - b);

  // Slide a 7-day window across history in daily steps and take the peak.
  const weeklyTokens: number[] = [];
  const weeklyCost: number[] = [];
  const firstTs = filtered[0].ts;
  const DAY = 24 * 60 * 60 * 1000;
  for (let start = firstTs; start + WEEK_MS <= now; start += DAY) {
    const end = start + WEEK_MS;
    let tok = 0;
    let usd = 0;
    for (const e of filtered) {
      if (e.ts >= start && e.ts < end) {
        tok += totalTokens(e.tokens);
        usd += e.costUSD;
      }
    }
    weeklyTokens.push(tok);
    weeklyCost.push(usd);
  }
  weeklyTokens.sort((a, b) => a - b);
  weeklyCost.sort((a, b) => a - b);

  const historyDays = (now - firstTs) / DAY;
  const peak = (xs: number[]) => (xs.length ? xs[xs.length - 1] : null);

  // The window the provider is describing right now, measured our way, so the
  // two halves of the division cover the same span.
  const activeBlock = blocks.find((b) => b.isActive) ?? null;
  const planWeekStart = plan?.weekly?.resetsAt
    ? plan.weekly.resetsAt - WEEK_MS
    : null;
  const planWeekCost =
    planWeekStart === null
      ? 0
      : filtered.reduce((sum, e) => (e.ts >= planWeekStart ? sum + e.costUSD : sum), 0);

  const measured = {
    sessionCostLimit: measuredCeiling(
      activeBlock?.agg.costUSD ?? 0,
      plan?.session?.utilization,
    ),
    weeklyCostLimit: measuredCeiling(planWeekCost, plan?.weekly?.utilization),
  };

  const suggestion = {
    // A measured ceiling wins over an observed peak: the peak only says "at
    // least this much", where this says how much of the allowance a known
    // amount of work actually took.
    sessionCostLimit:
      measured.sessionCostLimit ??
      // Rounded up to the nearest cent so the ceiling is never *below* the
      // observed peak it was derived from.
      (blockCost.length ? Math.ceil(peak(blockCost)! * 100) / 100 : null),
    weeklyCostLimit:
      measured.weeklyCostLimit ??
      (weeklyCost.length ? Math.ceil(peak(weeklyCost)! * 100) / 100 : null),
    sessionTokenLimit: blockTokens.length ? Math.round(peak(blockTokens)!) : null,
    weeklyTokenLimit: weeklyTokens.length ? Math.round(peak(weeklyTokens)!) : null,
  };

  // Usage that is all inside one still-open block, or spanning less than a full
  // week, yields nothing to calibrate against — unless the provider named a
  // utilisation, which needs no history at all. Reporting that plainly beats
  // returning success with null suggestions the UI then has to special-case.
  if (suggestion.sessionCostLimit === null && suggestion.weeklyCostLimit === null) {
    return NextResponse.json({
      ok: false,
      reason:
        closed.length === 0
          ? "All recorded usage is inside a single 5-hour block that has not " +
            "finished yet, so there is no completed window to measure. Come " +
            "back after a few hours of normal use."
          : "Not enough history yet — a full 7-day window has not elapsed " +
            "since your first recorded turn.",
      evidence: {
        historyDays: Number(historyDays.toFixed(1)),
        closedBlocks: closed.length,
        weeklyWindowsSampled: weeklyCost.length,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    suggestion,
    evidence: {
      historyDays: Number(historyDays.toFixed(1)),
      closedBlocks: closed.length,
      blockCostP50: Number(quantile(blockCost, 0.5).toFixed(2)),
      blockCostP95: Number(quantile(blockCost, 0.95).toFixed(2)),
      blockCostMax: Number((peak(blockCost) ?? 0).toFixed(2)),
      blockTokensMax: peak(blockTokens) ?? 0,
      weeklyWindowsSampled: weeklyCost.length,
      weeklyCostMax: Number((peak(weeklyCost) ?? 0).toFixed(2)),
      weeklyTokensMax: peak(weeklyTokens) ?? 0,
      measuredFrom:
        measured.sessionCostLimit !== null || measured.weeklyCostLimit !== null
          ? {
              sessionUtilization: plan?.session?.utilization ?? null,
              weeklyUtilization: plan?.weekly?.utilization ?? null,
              sessionCostUSD: Number((activeBlock?.agg.costUSD ?? 0).toFixed(2)),
              weeklyCostUSD: Number(planWeekCost.toFixed(2)),
            }
          : null,
    },
    caveat:
      measured.sessionCostLimit !== null || measured.weeklyCostLimit !== null
        ? "Measured: what a window cost here, over the share of your " +
          "allowance Anthropic says it took. Still a lower bound, because " +
          "the cost covers Claude Code and the percentage covers every " +
          "surface — so a window that also held web or Desktop work divides " +
          "part of the spend by all of the usage."
        : "These are peaks observed in your own transcripts, so they are lower " +
          "bounds on your real limits, not the limits themselves. Percentages " +
          "computed against them read high rather than low. If you have never " +
          "hit your limit, the true ceiling is higher than suggested here.",
    confidence:
      historyDays < 7 ? "low" : historyDays < 21 ? "moderate" : "reasonable",
  });
}
