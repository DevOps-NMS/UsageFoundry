import { NextResponse } from "next/server";
import {
  deleteAgent,
  getAgent,
  normalizeAgentInput,
  updateAgent,
} from "../../../../lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const agent = getAgent(id);
  if (!agent) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ agent });
}

/**
 * Replace an agent wholesale. The same validation as creating one, for
 * `PUT /api/templates/[id]`'s reason: an agent edited into a shape the CLI would
 * drop is the same mistake as saving one that way, and the CLI reports neither —
 * so the refusal has to be here, while the person who typed it is looking.
 */
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const parsed = normalizeAgentInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const agent = updateAgent(id, parsed.value);
    if (!agent) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ agent });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

/**
 * Deleting an agent affects nothing that is running. Every spawn carries the
 * whole definition on its own argv rather than a reference to this row, so there
 * is no cascade and no child left pointing at something that is gone.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!deleteAgent(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
