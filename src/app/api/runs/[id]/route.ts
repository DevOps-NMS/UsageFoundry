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
import {
  contextOccupancy,
  pruneActivity,
  pruneSavings,
  prunerState,
} from "@/lib/contextPruning";
import { runAgentDTO } from "@/lib/agents";
import { normalizePolicy } from "@/lib/budget";
import { auditMutation } from "../../../../lib/requestLog";
import { jsonMaybeGzipped } from "../../../../lib/http";

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
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { mountId, mountLabel, relPath } = describeFolder(run.folder);

  // Normalised on read: rows created before enforcement modes existed have no
  // `enforcement` or `continueAfterDone` key, and the DTO would otherwise say
  // they do. One place to default them, rather than every client defaulting
  // them and one client forgetting.
  const rawBudget = JSON.parse(run.budget) as Record<string, unknown>;

  // Awaited before the response is assembled rather than inside it: it reads the
  // transcript scan to count the turns a saving is measured over, and that scan
  // is coalesced across callers, so a poll on an open run page joins the one the
  // dashboard is already running rather than starting a second.
  const pruned = await pruneSavings({ runId: id });

  // Gzipped: 14,170 bytes to 3,717, measured — the row carries the agent's
  // whole system prompt and the normalised policy, and this is the three-second
  // poll every open run page runs. The 404 above stays plain.
  return jsonMaybeGzipped(req, {
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
    // A third independent reading, and like `telemetry` it is never merged into
    // the row's spend: this is the value of an intervention, not money that
    // moved. Undefined when this run has never been pruned, so the page can drop
    // the section rather than render a row of zeroes — which would read as
    // "pruning saved nothing here" when it means "pruning did not run".
    pruning: pruned.prunes > 0 ? pruned : undefined,
    // What is configured now and whether the tool behind it is here — the pair
    // that turns the absence above from one blank into a sentence. Sent on
    // every poll, and cheap: one settings read and one memoised stat.
    pruner: prunerState(),
    // How this run's cycle boundaries actually ended. Undefined when it reached
    // none, on `pruning`'s rule — and with every boundary now writing a row,
    // undefined here genuinely means nothing happened rather than standing in
    // for four different things that did.
    pruneActivity: pruneActivity({ runId: id }),
    // How full this run's context has been, on the poll the page already runs
    // rather than an endpoint of its own — this is the row's own state and it
    // arrives with the rest of it. Two indexed reads bounded by
    // `CONTEXT_SERIES_MAX_POINTS`, and undefined for a run that has neither
    // samples nor prunes, so nothing is added to the payload of a run that
    // predates the series or never went live.
    //
    // **Not spend, and never summed with anything above.** It is an occupancy
    // reading in the API-visible currency; `pruning` beside it counts the
    // transcript's own turns, and the two bases are tens of thousands of tokens
    // apart in either direction.
    context: contextOccupancy(id),
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
