import { NextResponse } from "next/server";
import {
  deleteTemplate,
  getTemplate,
  normalizeTemplateInput,
  updateTemplate,
} from "@/lib/templates";

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
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const parsed = normalizeTemplateInput(body);
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
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!deleteTemplate(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
