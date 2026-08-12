import { NextResponse } from "next/server";
import {
  currentKnowledge,
  deleteWorkflow,
  folderRefusal,
  getWorkflow,
  listInstances,
  liveBlocksOf,
  liveRunsOf,
  normalizeWorkflowInput,
  updateWorkflow,
} from "@/lib/workflows";
import { instanceDTO, workflowDTO } from "../dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const workflow = getWorkflow(id);
  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    workflow: workflowDTO(workflow),
    instances: listInstances(id).map(instanceDTO),
  });
}

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getWorkflow(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = normalizeWorkflowInput(body, currentKnowledge());
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const missing = folderRefusal(parsed.value.graph);
  if (missing) return NextResponse.json({ error: missing }, { status: 400 });

  try {
    const workflow = updateWorkflow(id, parsed.value);
    if (!workflow) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ workflow: workflowDTO(workflow) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

/**
 * Deleting takes the workflow's instance records with it and no run.
 *
 * Refused while runs it started are still going, because those records are the
 * only thing saying where those runs came from — and the operator watching a
 * chain of six run rows advance has no other way back to the graph that made
 * them. Nothing is stopped on their behalf: ending a run is the Runs page's
 * decision, not a side effect of tidying a list.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const workflow = getWorkflow(id);
  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const live = liveRunsOf(id);
  const liveBlocks = liveBlocksOf(id);
  if (live.length + liveBlocks > 0) {
    return NextResponse.json(
      {
        error:
          `${live.length} run(s) and ${liveBlocks} block(s) started by this ` +
          "workflow have not finished yet. Deleting it now would leave them " +
          "with nothing saying what they are part of, and a block still " +
          "deciding would lose the graph it is deciding for. Wait for them, or " +
          "stop that run of the workflow.",
      },
      { status: 400 },
    );
  }

  return NextResponse.json({ deleted: deleteWorkflow(id) });
}
