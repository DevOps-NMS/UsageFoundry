import { NextResponse } from "next/server";
import { runDiff } from "@/lib/diff";
import { getRun } from "@/lib/orchestrator";
import { jsonMaybeGzipped } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What this run changed.
 *
 * Not folded into `GET /api/runs/[id]`: that route is polled every three
 * seconds by every open run page, and a diff costs several git processes and
 * can run to megabytes. This one is fetched when the operator asks to see it.
 *
 * "Nothing to show" is a 200 with `kind: "none"` and a reason, never a 404 or a
 * 500. A run refused before its first cycle, one that died setting its checkout
 * up, and one that simply committed nothing are all ordinary outcomes.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Gzipped: a unified diff is the most compressible thing this app produces —
  // every hunk repeats the surrounding file — and the docblock above says it
  // can run to megabytes. The `kind: "none"` answers are a couple of hundred
  // bytes and fall under the floor, which is what the floor is for.
  return jsonMaybeGzipped(req, { diff: await runDiff(id) });
}
