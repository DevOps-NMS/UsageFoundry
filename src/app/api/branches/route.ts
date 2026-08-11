import { NextResponse } from "next/server";
import { branchInventory } from "@/lib/land";

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
 * branch and nothing in it changes on its own.
 */
export async function GET() {
  return NextResponse.json(await branchInventory());
}
