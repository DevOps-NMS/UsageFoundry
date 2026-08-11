import { NextResponse } from "next/server";
import {
  createTemplate,
  listTemplates,
  normalizeTemplateInput,
} from "@/lib/templates";

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
 */

export async function GET() {
  return NextResponse.json({ templates: listTemplates() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const parsed = normalizeTemplateInput(body);
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
