import { NextResponse } from "next/server";
import type { WorkflowListItemDTO } from "@/lib/apiTypes";
import {
  createWorkflow,
  currentKnowledge,
  folderRefusal,
  listWorkflows,
  normalizeWorkflowInput,
} from "@/lib/workflows";
import { workflowDTO, workflowListDTO } from "./dto";
import { jsonMaybeGzipped } from "@/lib/http";
import { auditMutation } from "../../../lib/requestLog";

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

export async function GET(req: Request) {
  // `workflowListDTO`, not `workflowDTO`: this is the only route that ships
  // every saved graph at once, and the two readers of it — the workflows list
  // and quick open — draw a block count and nothing else off the nodes. See
  // `WorkflowListItemDTO`. The POST below keeps the whole shape, because what it
  // answers with is the workflow the editor has just saved.
  //
  // Annotated for the reason `GET /api/runs` annotates its own list: nothing
  // else would catch this being put back to `workflowDTO`, since `json()` takes
  // anything and both clients cast what they get — the graph would simply
  // return to the wire and the block count would keep rendering.
  const workflows: WorkflowListItemDTO[] = listWorkflows().map(workflowListDTO);
  return jsonMaybeGzipped(req, { workflows });
}

async function postHandler(req: Request) {
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

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
