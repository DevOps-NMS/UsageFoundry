import { NextResponse } from "next/server";
// Relative rather than aliased, which is what every route with a test here
// does: `node --test` runs the compiled output, and nothing resolves `@/` there.
import { auditMutation } from "../../../../lib/requestLog";
import { setVaultSkillEnabled, vaultSkillEnabled } from "../../../../lib/vaultSkill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // Narrowed against the literal rather than coerced, exactly as `/api/plugins`
  // does: `Boolean(body.enabled)` would read a missing field as "switch it
  // off", so a malformed request would silently stop handing runs the skill
  // instead of being refused.
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "`enabled` must be true or false." }, { status: 400 });
  }

  try {
    setVaultSkillEnabled(body.enabled);
  } catch (err) {
    // Switching it on with no knowledge base configured arrives here as a
    // sentence, and it is refused rather than stored: a switch reading as on
    // while every cycle silently passed no skill is the failure this whole
    // area is built against.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  return NextResponse.json({ skillEnabled: vaultSkillEnabled() });
}

/** Wrapped so the request that changed what every agent loads is on the audit log. */
export const POST = auditMutation(postHandler);
