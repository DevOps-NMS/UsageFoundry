import { NextResponse } from "next/server";
import {
  createTemplate,
  listTemplates,
  normalizeTemplateInput,
} from "@/lib/templates";
import { currentAgentKnowledge } from "@/lib/agents";
import { auditMutation } from "../../../lib/requestLog";
import { jsonMaybeGzipped } from "../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Named run templates.
 *
 * Every refusal is a 400 with a sentence, like `POST /api/runs/[id]/reopen` and
 * unlike the stop/resume routes' 200-plus-outcome shape: each one names
 * something the operator can change, and the form has to be able to show it.
 *
 * There is deliberately no folder validation here. A template records a folder
 * as a *preference* — it holds no claim on it, and the folder may not even
 * exist when the template is saved. `POST /api/runs` resolves it inside a mount
 * and refuses if it cannot, which is the check that actually guards anything.
 *
 * The agent is the opposite case and is checked, because an agent that is not
 * in the registry is one no run could ever be started with: the same refusal
 * `POST /api/runs` gives, in the same words, at the moment it can still be
 * fixed. `currentAgentKnowledge()` is the read both doors share.
 */

export async function GET(req: Request) {
  // Gzipped: 14,788 bytes to 5,674, measured. A template carries a whole
  // prompt and a whole normalised policy, and the shape repeats per row.
  return jsonMaybeGzipped(req, { templates: listTemplates() });
}

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const parsed = normalizeTemplateInput(body, {
    agents: currentAgentKnowledge(),
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    return NextResponse.json({ template: createTemplate(parsed.value) });
  } catch (err) {
    // A duplicate name arrives here as a readable sentence — see
    // `withNameConflict` in templates.ts.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
