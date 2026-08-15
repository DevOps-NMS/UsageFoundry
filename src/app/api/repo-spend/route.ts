import { NextResponse } from "next/server";
import { repoSpend } from "@/lib/repoSpend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Spans the card offers, in days. Anything else is refused rather than clamped. */
const SPANS = [1, 7, 30] as const;

/**
 * What each repository cost, over a span.
 *
 * Its own route rather than a field on `/api/usage`, which is `agentSpend`'s
 * precedent: that one is the dashboard's heartbeat and re-aggregates the whole
 * transcript history on every request, where this is one indexed read of the
 * `runs` table and does not need the same cadence.
 *
 * It is reporting and never a guard. Nothing here reaches `buildSnapshot()`, a
 * window meter or `evaluateBudget` — a threshold on a repository is a limit
 * nobody set, the reason `buildPeriods` is kept out of the guard path too.
 */
export async function GET(req: Request) {
  const raw = Number(new URL(req.url).searchParams.get("days") ?? 7);
  const days = (SPANS as readonly number[]).includes(raw) ? raw : 7;
  const now = Date.now();
  return NextResponse.json({
    days,
    ...repoSpend(now - days * 24 * 60 * 60 * 1000, now),
  });
}
