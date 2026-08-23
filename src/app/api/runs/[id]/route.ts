import { NextResponse } from "next/server";
import {
  dependenciesOf,
  describeFolder,
  getRun,
  haltedWorkflowOf,
  isRunning,
  queuePosition,
  stopRun,
} from "@/lib/orchestrator";
import { telemetryForRun } from "@/lib/otlp";
import { runAgentDTO } from "@/lib/agents";
import { normalizePolicy } from "@/lib/budget";
import { auditMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One run's row, and nothing that belongs to its log.
 *
 * The run page polls this every three seconds for as long as the tab is open,
 * and what it reads is the row: status, spend, guards, telemetry. The log
 * arrives over `/api/runs/[id]/stream`, which is the one place that bounds a
 * history — it replays under both a row cap and a byte budget and says what it
 * dropped.
 *
 * This route used to ship up to 500 events beside the row under a comment
 * warning that doing so would be pure waste, and nothing read them: the page's
 * own response type names `run`, `telemetry` and `error`, and `setEvents` is
 * fed solely by the EventSource. Measured on the live container before they
 * went — 582,469 bytes of a 591,574-byte response, repeated 20 times a minute
 * per open tab.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { mountId, mountLabel, relPath } = describeFolder(run.folder);

  // Normalised on read: rows created before enforcement modes existed have no
  // `enforcement` or `continueAfterDone` key, and the DTO would otherwise say
  // they do. One place to default them, rather than every client defaulting
  // them and one client forgetting.
  const rawBudget = JSON.parse(run.budget) as Record<string, unknown>;

  return NextResponse.json({
    run: {
      ...run,
      budget: {
        ...normalizePolicy(rawBudget),
        permissionMode: rawBudget.permissionMode,
      },
      // The whole definition is on the row, including the agent's own system
      // prompt; the page needs the name and the description and this route is
      // polled while the run is live. The only reader left — the runs list
      // stopped shipping `agent` at all, since nothing on it draws one.
      agent: runAgentDTO(run.agent),
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
  });
}

async function deleteHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // "cancelled" is a success, not a fallback: between work cycles there is no
  // child to signal and the loop stops on its own at the next check.
  const outcome = stopRun(id);
  return NextResponse.json({ ok: outcome !== "not-active", outcome });
}

/** Wrapped so the request that changed something is on the audit log. */
export const DELETE = auditMutation(deleteHandler);
