import { NextResponse } from "next/server";
import {
  deleteBranch,
  landRun,
  landState,
  resolutionChange,
  resolveConflicts,
  type LandStrategy,
} from "@/lib/land";
import { latestAssist, reviewPaths } from "@/lib/review";
import { getRun } from "@/lib/orchestrator";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What would happen if this branch were landed.
 *
 * A GET that writes nothing to any working tree: the merge is tried in memory
 * with `merge-tree`, so the answer — fast-forward, clean, or a list of
 * conflicting files — is honest *before* the operator decides anything, and
 * finding it out costs them nothing.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The latest resolution travels with the state so the card polls one route.
  // Its diff is read only once it has one: the card polls this route every few
  // seconds while a resolution runs, and there is nothing to diff until it
  // commits.
  const row = latestAssist(id, "resolve");
  return NextResponse.json({
    state: await landState(id),
    defaultStrategy: getSettings().landStrategy,
    resolution: row
      ? {
          id: row.id,
          kind: row.kind,
          createdAt: row.created_at,
          finishedAt: row.finished_at,
          status: row.status,
          model: row.model,
          costUSD: row.cost_usd,
          tokens: row.tokens,
          text: row.text,
          error: row.error,
          diffFiles: row.diff_files,
          diffShown: row.diff_shown,
          truncated: row.truncated === 1,
          paths: reviewPaths(row),
          changed: await resolutionChange(row),
        }
      : null,
  });
}

/**
 * Land the branch, or delete it once it is in.
 *
 * The branch is never taken from the request — only the run id is, and the
 * branch is read off that row. A body that could name a branch would be a way
 * to ask this app to merge or delete something it never created.
 *
 * Refusals are 400 with a sentence naming what to change, matching `reopen`.
 * The check runs again inside `landRun` from a fresh read: the page the
 * operator pressed the button on may have been open for an hour.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "land");

  if (action === "delete") {
    const outcome = await deleteBranch(id);
    return outcome.ok
      ? NextResponse.json({ ok: true, message: outcome.message })
      : NextResponse.json({ error: outcome.reason }, { status: 400 });
  }

  if (action === "resolve") {
    const outcome = await resolveConflicts(id);
    return outcome.ok
      ? NextResponse.json({ ok: true, message: outcome.message })
      : NextResponse.json({ error: outcome.reason }, { status: 400 });
  }

  if (action !== "land") {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  // Narrowed against the two literals before it selects a git command, for the
  // same reason `permissionMode` is narrowed in `POST /api/runs`.
  const raw = body.strategy === undefined ? getSettings().landStrategy : String(body.strategy);
  if (raw !== "merge" && raw !== "squash") {
    return NextResponse.json({ error: `Unknown strategy: ${raw}` }, { status: 400 });
  }

  const outcome = await landRun(id, raw as LandStrategy);
  return outcome.ok
    ? NextResponse.json({ ok: true, message: outcome.message })
    : NextResponse.json(
        { error: outcome.reason, conflicts: outcome.conflicts ?? [] },
        { status: 400 },
      );
}
