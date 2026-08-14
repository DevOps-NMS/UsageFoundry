import { NextResponse } from "next/server";
import { storageReport } from "@/lib/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What each append-only store currently holds.
 *
 * Its own route rather than a block on `GET /api/settings`, for two reasons.
 * That one is read on every load of a form the operator saves, and this walks
 * directories; and the two answer different questions — one is the
 * configuration, this is the measurement it bounds. The Settings page fetches
 * both and shows them beside each other, which is where a horizon is actually
 * decided.
 */
export async function GET() {
  return NextResponse.json(await storageReport());
}
