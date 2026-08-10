import { NextResponse } from "next/server";
import {
  AdminApiError,
  fetchCostReport,
  fetchRateLimits,
  fetchUsageReport,
  sumCostUSD,
} from "@/lib/adminApi";
import { hasAdminKey } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Console/API-account view: configured rate limits plus recent billed cost.
 *
 * Entirely separate from the subscription view. These numbers come from
 * Anthropic and are authoritative; the subscription numbers are derived
 * locally and are estimates. The UI keeps them in separate panels so the two
 * are never read as one total.
 */
export async function GET() {
  if (!hasAdminKey()) {
    return NextResponse.json({
      configured: false,
      reason:
        "No ANTHROPIC_ADMIN_KEY set. The Admin API needs an organization " +
        "Admin key (sk-ant-admin01-…) and is unavailable to individual accounts.",
    });
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    const [rateLimits, costBuckets, usageBuckets] = await Promise.all([
      fetchRateLimits(),
      fetchCostReport({ startingAt: thirtyDaysAgo, groupBy: ["description"] }),
      // 1d buckets cap at 31; 7 days keeps us well inside that and matches the
      // weekly framing used elsewhere in the UI.
      fetchUsageReport({
        startingAt: sevenDaysAgo,
        bucketWidth: "1d",
        groupBy: ["model"],
      }),
    ]);

    const dailyCost = costBuckets.map((b) => ({
      date: b.starting_at,
      usd: sumCostUSD([b]),
    }));

    return NextResponse.json({
      configured: true,
      rateLimits,
      cost: {
        last30dUSD: sumCostUSD(costBuckets),
        daily: dailyCost,
      },
      usage: { buckets: usageBuckets },
    });
  } catch (err) {
    const status = err instanceof AdminApiError ? err.status || 502 : 502;
    return NextResponse.json(
      {
        configured: true,
        error: err instanceof Error ? err.message : String(err),
      },
      { status },
    );
  }
}
