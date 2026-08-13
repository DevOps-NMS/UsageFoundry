import { NextResponse } from "next/server";
import {
  dependenciesOf,
  describeFolder,
  getRun,
  haltedWorkflowOf,
  isRunning,
  queuePosition,
  runEvents,
  stopRun,
} from "@/lib/orchestrator";
import { telemetryForRun } from "@/lib/otlp";
import { normalizePolicy } from "@/lib/budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Cap on the events returned when the caller asks for all of them.
 *
 * The run page polls this route every few seconds and reads the row, not the
 * log — the log arrives over SSE. Serialising a multi-day run's entire history
 * on each poll is pure waste, and on a long run it is a hard failure.
 */
const EVENT_LIMIT = 500;

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);

  const { mountId, mountLabel, relPath } = describeFolder(run.folder);

  // Normalised on read: rows created before enforcement modes existed have no
  // `enforcement` or `continueAfterDone` key, and the DTO would otherwise say
  // they do. One place to default them, rather than every client defaulting
  // them and one client forgetting.
  const rawBudget = JSON.parse(run.budget) as Record<string, unknown>;
  const events = runEvents(id, Number.isFinite(after) ? after : 0, EVENT_LIMIT);

  return NextResponse.json({
    run: {
      ...run,
      budget: {
        ...normalizePolicy(rawBudget),
        permissionMode: rawBudget.permissionMode,
      },
      mountId,
      mountLabel,
      relPath,
      dependsOn: dependenciesOf([id]).get(id) ?? [],
      queuePosition: run.status === "queued" ? queuePosition(id) : undefined,
      // What `reopenRun` will refuse this run for, sent so the page can decline
      // to offer the button rather than let the operator find out by pressing it.
      haltedWorkflow: haltedWorkflowOf(id),
    },
    running: isRunning(id),
    // Reported alongside spent_usd, never merged into it. The two are
    // independent measurements of the same run and disagreeing is
    // informative — telemetry counts requests the CLI's `result` event
    // never got to report.
    telemetry: telemetryForRun(id),
    events: events.events,
    eventsDropped: events.dropped,
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // "cancelled" is a success, not a fallback: between work cycles there is no
  // child to signal and the loop stops on its own at the next check.
  const outcome = stopRun(id);
  return NextResponse.json({ ok: outcome !== "not-active", outcome });
}
