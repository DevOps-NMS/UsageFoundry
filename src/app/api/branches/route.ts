import { NextResponse } from "next/server";
import { branchInventory } from "@/lib/land";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every branch this app has produced, across runs.
 *
 * The gap this fills: a branch is created per *run*, not per checkout slot, so
 * a few dozen runs leave a few dozen `uf/*` refs and the only record of which
 * ones mattered was a run detail page opened one at a time.
 *
 * Deliberately not polled by its page — the inventory costs a `rev-list` per
 * branch and nothing in it changes on its own. The merge queue is the one thing
 * on that page that does, and it has its own route.
 */
export async function GET() {
  return NextResponse.json({
    ...(await branchInventory()),
    // Carried here so the queue form can default to it without a second
    // request. The queue still narrows whatever comes back on the wire.
    defaultStrategy: getSettings().landStrategy,
  });
}
