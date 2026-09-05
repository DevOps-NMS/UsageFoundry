import { NextResponse } from "next/server";
import { deliverRun } from "@/lib/land";
import { getRun } from "@/lib/orchestrator";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Push this run's branch and open a pull request for it.
 *
 * One press, one run, and nothing in the run loop reaches this: delivery is the
 * only thing here that leaves the machine, and an outward-facing action taken
 * by a loop is a different product from one taken by a person.
 *
 * A body is optional. When it carries a title or body they are used verbatim,
 * because the operator standing at the button is better placed to describe the
 * change than a template built from the prompt — but a press with no body still
 * works, since needing to write a title is a reason not to press it.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { title?: string; body?: string } = {};
  try {
    body = (await req.json()) as { title?: string; body?: string };
  } catch {
    // No body is the ordinary press. Only a malformed one lands here, and it is
    // not worth a 400 when the defaults are what most presses want anyway.
    body = {};
  }

  const outcome = await deliverRun(id, body);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, url: outcome.url, number: outcome.number });
}

/** Wrapped so the request that published something is on the audit log. */
export const POST = auditMutation(postHandler);
