import { NextResponse } from "next/server";
import {
  cancelBatch,
  enqueue,
  isWorking,
  queueHistory,
  queueView,
  type QueueRow,
} from "@/lib/mergeQueue";
import { getRun } from "@/lib/orchestrator";
import { getSettings } from "@/lib/settings";
import { auditMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The merge queue: what is waiting, what is in flight, and what happened.
 *
 * Branch names are never accepted from the wire here, exactly as they are not
 * on `/api/runs/[id]/land` — the request carries run ids and the branch is read
 * off the row, which is the only place this app ever wrote one.
 */

/** One row as the page renders it, with the branch resolved for display. */
function toDTO(row: QueueRow) {
  const run = getRun(row.run_id);
  return {
    id: row.id,
    runId: row.run_id,
    branch: run?.worktree_branch ?? null,
    target: run?.worktree_base_branch ?? null,
    // `repo_root ?? folder` — the key the worker serialises on.
    repo: run?.repo_root ?? run?.folder ?? null,
    position: row.position,
    status: row.status,
    strategy: row.strategy,
    autoResolve: row.auto_resolve === 1,
    message: row.message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    resolveCostUSD: row.resolve_cost,
  };
}

/** A batch as the page groups it. */
function batchDTO(batch: { batchId: string; createdAt: number; rows: QueueRow[] }) {
  return {
    batchId: batch.batchId,
    createdAt: batch.createdAt,
    items: batch.rows.map(toDTO),
  };
}

/**
 * Every outstanding batch, grouped, plus the last one that finished.
 *
 * It answered with the newest batch alone, which the worker has never agreed
 * with — it drains every queued row whatever batch it is in, so an earlier
 * batch went on merging into the operator's checkout with nothing on the page
 * naming it, and `DELETE` takes a `batchId` the page could no longer supply.
 *
 * `working` is still the worker's own flag rather than one scoped to this
 * answer, and that is now honest: the row it can be working on is `landing` or
 * `resolving`, which is a row `queueView` covers by definition.
 *
 * `?history=1` adds the finished batches the panel is not showing. It is a
 * parameter rather than a route because it is the same resource read one screen
 * further back, and it is opt-in because this is the one read on this page that
 * polls: the card asks for it when somebody opens the disclosure and on no tick
 * where that disclosure is shut. `historyCount` rides on every answer either
 * way — it is what the closed disclosure is labelled with, and it costs the
 * `GROUP BY` this route was already paying for.
 */
export async function GET(req: Request) {
  const wantRows = new URL(req.url).searchParams.get("history") === "1";
  const history = queueHistory(wantRows);
  return NextResponse.json({
    working: isWorking(),
    batches: queueView().map(batchDTO),
    historyCount: history.total,
    // `null` rather than `[]` when it was not asked for: an empty list is a
    // real answer here — every earlier batch already on the panel — and the
    // page renders "nothing earlier" for one and "not read yet" for the other.
    history: wantRows ? history.batches.map(batchDTO) : null,
  });
}

/**
 * Queue a set of branches, in the order given.
 *
 * The order in the body is the order they land in — nothing here sorts, because
 * the operator's sequence is the one thing this endpoint cannot work out for
 * itself. Returns as soon as the rows exist; the worker outlives the request,
 * for the same reason a review does.
 */
async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const runIds = Array.isArray(body.runIds)
    ? body.runIds.filter((v): v is string => typeof v === "string")
    : null;
  if (!runIds || runIds.length === 0) {
    return NextResponse.json({ error: "No branches were selected." }, { status: 400 });
  }

  // Narrowed against the two literals before it can select a git command, the
  // same treatment `POST /api/runs/[id]/land` gives it.
  const raw = body.strategy === undefined ? getSettings().landStrategy : String(body.strategy);
  if (raw !== "merge" && raw !== "squash") {
    return NextResponse.json({ error: `Unknown strategy: ${raw}` }, { status: 400 });
  }

  // `=== true`, never `Boolean(...)`: this authorises billed spend, so a string
  // "false" off the wire has to fail safe. Same rule as `continueAfterDone`.
  const autoResolve = body.autoResolve === true;

  const outcome = enqueue(runIds, { strategy: raw, autoResolve });
  return outcome.ok
    ? NextResponse.json({ ok: true, batchId: outcome.batchId, queued: outcome.queued })
    : NextResponse.json({ error: outcome.reason }, { status: 400 });
}

/** Drop everything still waiting. What is in flight is left to finish. */
async function deleteHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const batchId = typeof body.batchId === "string" ? body.batchId : null;
  if (!batchId) {
    return NextResponse.json({ error: "No batch was named." }, { status: 400 });
  }
  const dropped = cancelBatch(batchId);
  return NextResponse.json({ ok: true, cancelled: dropped });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
/** Wrapped so the request that changed something is on the audit log. */
export const DELETE = auditMutation(deleteHandler);
