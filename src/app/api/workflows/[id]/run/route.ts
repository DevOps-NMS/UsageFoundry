import { NextResponse } from "next/server";
import { startWorkflow } from "@/lib/workflows";
import { instanceDTO } from "../../dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Turn a saved graph into runs.
 *
 * This is the second route in the app that starts unattended agents from
 * something other than the run form — the chat's approval gate is the first —
 * and it is narrow in the same way: the graph decides *what work to do*, and
 * every guard comes from the template each block names or from
 * `settings.chatDefaultGuards`. Nothing on the wire here sets a budget or a
 * permission mode; the request body is not read at all.
 *
 * `startWorkflow` creates every run in one synchronous pass and rolls the whole
 * thing back if any of them cannot be created, so this answers either "all of
 * them started" or "none of them are running", never a count in between. The
 * refusal is a 400 with a sentence for the same reason every other refusal here
 * is: it names something the operator can act on.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;

  const outcome = startWorkflow(id);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.reason }, { status: 400 });
  }
  return NextResponse.json({ instance: instanceDTO(outcome.instance) });
}
