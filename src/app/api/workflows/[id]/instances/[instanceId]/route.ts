import { NextResponse } from "next/server";
import { getInstance } from "@/lib/workflows";
import { instanceDTO } from "../../../dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; instanceId: string }> };

/**
 * One press of Run, with each block's run as it stands now.
 *
 * Nested under the workflow so the page it feeds can offer a way back without a
 * second request, and checked against it rather than trusted: an instance id
 * that belongs to another workflow is a 404, not a page showing one workflow's
 * runs under another one's name.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id, instanceId } = await ctx.params;
  const instance = getInstance(instanceId);
  if (!instance || instance.workflowId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ instance: instanceDTO(instance) });
}
