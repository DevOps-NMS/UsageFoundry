import { NextResponse } from "next/server";
import {
  deleteSchedule,
  getSchedule,
  normalizeScheduleInput,
  pauseSchedule,
  putSchedule,
  scheduleRefusal,
  scheduleView,
} from "@/lib/schedules";
import { getWorkflow } from "@/lib/workflows";
import { scheduleDTO } from "../../dto";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The one schedule a workflow may have.
 *
 * This is the third route that leads to unattended agents — the chat's approval
 * gate and the workflow's own Run button are the first two — and it is the only
 * one where the agent starts with nobody present. The body carries a recurrence
 * and a timezone and nothing else: there is no guard, no permission mode and no
 * budget on the wire here, for the reason there is none on a workflow node or a
 * chat proposal. A schedule presses Run; what that press is allowed to do was
 * decided when a person saved the graph.
 *
 * PUT replaces, because there is exactly one per workflow. PATCH takes only
 * `paused`. Every refusal is a 400 with a sentence naming something the operator
 * can change, the shape every other refusal here has.
 */

async function putHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const workflow = getWorkflow(id);
  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Refused at the door as well as at every fire. Here because this is the
  // moment with a person and an error channel; there because clearing the
  // workflow's limits afterwards is one edit away.
  const refusal = scheduleRefusal(workflow);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = normalizeScheduleInput(body, Date.now());
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const saved = putSchedule(id, parsed.value.spec, parsed.value.timeZone);
  return NextResponse.json({ schedule: scheduleDTO(scheduleView(saved, workflow)) });
}

async function patchHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const workflow = getWorkflow(id);
  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // `=== true` rather than `Boolean(...)`, the rule `continueAfterDone` follows:
  // this decides whether unattended agents start, so a string off the wire must
  // fail towards not starting them.
  const paused = body.paused === true;
  if (!paused && scheduleRefusal(workflow)) {
    return NextResponse.json(
      { error: scheduleRefusal(workflow) },
      { status: 400 },
    );
  }

  const saved = pauseSchedule(id, paused);
  if (!saved) {
    return NextResponse.json({ error: "This workflow has no schedule." }, { status: 404 });
  }
  return NextResponse.json({ schedule: scheduleDTO(scheduleView(saved, workflow)) });
}

async function deleteHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getWorkflow(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ deleted: deleteSchedule(id) });
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const workflow = getWorkflow(id);
  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const schedule = getSchedule(id);
  return NextResponse.json({
    schedule: schedule ? scheduleDTO(scheduleView(schedule, workflow)) : null,
  });
}

/** Wrapped so the request that changed something is on the audit log. */
export const PUT = auditMutation(putHandler);
/** Wrapped so the request that changed something is on the audit log. */
export const PATCH = auditMutation(patchHandler);
/** Wrapped so the request that changed something is on the audit log. */
export const DELETE = auditMutation(deleteHandler);
