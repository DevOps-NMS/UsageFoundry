import { NextResponse } from "next/server";
import {
  createWorkflow,
  currentKnowledge,
  folderRefusal,
  listWorkflows,
  normalizeWorkflowInput,
} from "@/lib/workflows";
import { workflowDTO } from "./dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Saved graphs of run blocks.
 *
 * Every refusal is a 400 with a sentence naming the block it is about, the same
 * shape `POST /api/templates` uses — each one names something the operator can
 * change, and the editor has to be able to show it.
 *
 * Unlike the templates route this one *does* check the folders, and the reason
 * is in `folderRefusal`: a template's folder is a preference the run form asks
 * about again, where a block's folder is what its run will use.
 */

export async function GET() {
  return NextResponse.json({ workflows: listWorkflows().map(workflowDTO) });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const parsed = normalizeWorkflowInput(body, currentKnowledge());
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const missing = folderRefusal(parsed.value.graph);
  if (missing) return NextResponse.json({ error: missing }, { status: 400 });

  try {
    return NextResponse.json({
      workflow: workflowDTO(createWorkflow(parsed.value)),
    });
  } catch (err) {
    // A duplicate name arrives here as a readable sentence — see
    // `withNameConflict` in workflows.ts.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
