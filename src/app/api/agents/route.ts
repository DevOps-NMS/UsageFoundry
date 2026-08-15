import { NextResponse } from "next/server";
// Relative rather than aliased, which is what every route with a test here
// does: `node --test` runs the compiled output, and nothing resolves `@/` there.
import {
  createAgent,
  listAgents,
  listAmbientAgents,
  normalizeAgentInput,
} from "../../../lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Named specialised agents.
 *
 * `/api/templates`' shape throughout: every refusal is a 400 with a sentence
 * naming something the operator can change, because the form has to be able to
 * show it.
 *
 * The list answers with `ambient` beside `agents`, and that is the whole of the
 * decision about the definitions this app did not write. The operator's
 * `~/.claude/agents/` is bind-mounted into the container and reaches every child
 * spawned from here; a repository's own `.claude/agents/` reaches an isolated
 * run through its worktree. They are left in play rather than excluded — the
 * reasoning is in `agents.ts` — so the saved registry is a part of the set and
 * not the whole of it, and every surface that offers a choice has to be able to
 * say so. One payload, so no two of them can say it differently.
 *
 * Only the **user** scope is reported here. It is the half that is true whatever
 * a child's cwd turns out to be, where the project scope depends on a folder
 * this route has not resolved and must not resolve loosely — `listAmbientAgents`
 * takes a directory for a caller that already has one.
 */

export async function GET() {
  return NextResponse.json({
    agents: listAgents(),
    ambient: listAmbientAgents(),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const parsed = normalizeAgentInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    return NextResponse.json({ agent: createAgent(parsed.value) });
  } catch (err) {
    // A duplicate name arrives here as a readable sentence — see
    // `withNameConflict` in agents.ts.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
