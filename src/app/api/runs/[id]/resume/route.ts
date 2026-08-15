import { NextResponse } from "next/server";
import { getRun, resumeRun } from "@/lib/orchestrator";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Put a parked run back in the queue now instead of at its next wake.
 *
 * Mirrors DELETE's shape: a wrong-state request is a 200 carrying an outcome
 * rather than an error status, because the UI has to render it either way.
 *
 * This does not override the guard. `startRun` re-reads the budget before it
 * spawns anything, so asking early while the 5-hour window is still full parks
 * the run again — which is the honest outcome.
 */
async function postHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outcome = resumeRun(id);
  return NextResponse.json({ ok: outcome === "requeued", outcome });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
