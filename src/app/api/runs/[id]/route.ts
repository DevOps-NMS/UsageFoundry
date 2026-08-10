import { NextResponse } from "next/server";
import {
  describeFolder,
  getRun,
  isRunning,
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

  const { mountLabel, relPath } = describeFolder(run.folder);

  return NextResponse.json({
    run: { ...run, budget: JSON.parse(run.budget), mountLabel, relPath },
    running: isRunning(id),
    events: runEvents(id, Number.isFinite(after) ? after : 0),
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const killed = stopRun(id);
  return NextResponse.json({ ok: true, signalled: killed });
}
