import { NextResponse } from "next/server";
import { getRun, setRunPriority } from "@/lib/orchestrator";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Say which queued run should go first.
 *
 * A number rather than a "move up" verb, and the reason is the same one
 * `set-aside` gives for two verbs on one path: this is a value being set, it is
 * idempotent, and two operators pressing it at once end with the value they
 * both asked for rather than a run that moved twice. A relative move would also
 * need the queue's current order to mean something at the moment of the press,
 * which over a queue that is being promoted underneath is a race with no
 * correct answer.
 *
 * Clamping is `setRunPriority`'s and is not repeated here — a second copy of
 * the band is a second thing to forget when it changes.
 */
async function putHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const raw = (body as { priority?: unknown })?.priority;
  const outcome = setRunPriority(id, Number(raw));
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, priority: outcome.priority });
}

/** Wrapped so the request that changed the queue is on the audit log. */
export const PUT = auditMutation(putHandler);
