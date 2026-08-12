import { NextResponse } from "next/server";
import { getInstance, stopInstance } from "@/lib/workflows";
import { instanceDTO } from "../../../../dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; instanceId: string }> };

/**
 * Halt every block of one press of Run.
 *
 * Its own route rather than a `DELETE` on the instance, the shape
 * `POST /api/chat/[id]/cancel` already uses: the instance record is not being
 * removed, and deleting the record of what a workflow started is a different
 * decision from stopping the runs it started.
 *
 * The request body is not read. `stopInstance` is the one door a halt goes
 * through, and the only thing an operator's stop and a tripped guard differ by
 * is the cause recorded — which is not something the wire may set, for the
 * reason `--permission-mode` is not: it decides what a run's stop reason claims
 * happened, and a guard stop that anyone can spell is not evidence of anything.
 *
 * A second press answers 200 with `acted: false`. It is not an error — the
 * instance is stopping, which is what was asked for — and answering 400 would
 * make a Stop button look broken at exactly the moment it worked.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const { id, instanceId } = await ctx.params;

  const instance = getInstance(instanceId);
  if (!instance || instance.workflowId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const outcome = stopInstance(instanceId, { kind: "operator" });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.reason }, { status: 400 });
  }

  return NextResponse.json({
    report: outcome.report,
    // Read back after the walk, so the page that pressed Stop renders the new
    // statuses without a second request.
    instance: instanceDTO(getInstance(instanceId)!),
  });
}
