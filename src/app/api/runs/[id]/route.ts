import { NextResponse } from "next/server";
import {
  describeFolder,
  getRun,
  isRunning,
  queuePosition,
  runEvents,
  stopRun,
} from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);

  const { mountId, mountLabel, relPath } = describeFolder(run.folder);

  return NextResponse.json({
    run: {
      ...run,
      budget: JSON.parse(run.budget),
      mountId,
      mountLabel,
      relPath,
      queuePosition: run.status === "queued" ? queuePosition(id) : undefined,
    },
    running: isRunning(id),
    events: runEvents(id, Number.isFinite(after) ? after : 0),
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
