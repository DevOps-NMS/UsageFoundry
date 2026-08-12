import { NextResponse } from "next/server";
import { duplicateWorkflow } from "@/lib/workflows";
import { workflowDTO } from "../../dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A copy, under a free name.
 *
 * The whole point is editing a variant without losing the original, so the copy
 * is saved as it stands rather than opened unsaved in the editor — a form that
 * has to be submitted before it exists is one navigation away from losing the
 * work it was meant to protect.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const copy = duplicateWorkflow(id);
    if (!copy) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ workflow: workflowDTO(copy) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
