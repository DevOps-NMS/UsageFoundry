import { NextResponse } from "next/server";
import {
  deleteTemplate,
  getTemplate,
  normalizeTemplateInput,
  updateTemplate,
} from "@/lib/templates";
import { currentAgentKnowledge } from "@/lib/agents";
import { auditMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const template = getTemplate(id);
  if (!template) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ template });
}

/**
 * Replace a template wholesale. The same validation as creating one — a
 * template edited into a shape that cannot be instantiated is the same mistake
 * as saving one that way, and refusing it only at `POST /api/runs` would put
 * the error a week away from the edit that caused it.
 */
async function putHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const parsed = normalizeTemplateInput(body, {
    agents: currentAgentKnowledge(),
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const template = updateTemplate(id, parsed.value);
    if (!template) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ template });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

/**
 * Deleting a template affects nothing that is running. A run copies every value
 * it needs at creation, so there is no cascade and no run left dangling.
 */
async function deleteHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!deleteTemplate(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

/** Wrapped so the request that changed something is on the audit log. */
export const PUT = auditMutation(putHandler);
/** Wrapped so the request that changed something is on the audit log. */
export const DELETE = auditMutation(deleteHandler);
