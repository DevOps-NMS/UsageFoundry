import { NextResponse } from "next/server";
import { getRun, setRunAside, stopRun } from "@/lib/orchestrator";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Hold one run back from the bulk pick-ups, and stop it on the way if it is
 * still going.
 *
 * Two verbs on one path rather than an action field: this is a mark being set
 * and unset, both are single presses on the run page, and the pair reads the
 * way `DELETE /api/runs/[id]` already does one directory up.
 *
 * The stop is composed here rather than inside `setRunAside`, which marks and
 * nothing else — but the *order* is not the caller's choice and the comment on
 * that function says why: the mark goes on first, because stopping first leaves
 * the row terminal and unmarked for as long as the loop takes to notice, and
 * that is exactly the set a bulk pick-up sweeps. So a press meant to hold a run
 * back could hand it to one instead.
 *
 * `stopRun` is called whatever the status is, rather than behind a list of the
 * live ones kept here: it already answers `not-active` for a row with nothing to
 * stop, and a second copy of "which statuses are still going" is a second thing
 * to forget when one is added. Its answer is reported rather than swallowed —
 * "set aside, and it was already finished" and "set aside, and its agent was
 * interrupted" are different things to have just done, and the page says which.
 */
async function postHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const marked = setRunAside(id, true);
  if (!marked.ok) {
    return NextResponse.json({ error: marked.reason }, { status: 400 });
  }

  return NextResponse.json({ ok: true, stopped: stopRun(id) });
}

/**
 * Put it back among them. Never restarts anything: the run keeps the terminal
 * status it had, and picking it up is still a separate press.
 */
async function deleteHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outcome = setRunAside(id, false);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
export const DELETE = auditMutation(deleteHandler);
