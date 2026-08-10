import { NextResponse } from "next/server";
import { createRun, describeFolder, listRuns, startRun } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const runs = listRuns(100).map((r) => {
    const { mountLabel, relPath } = describeFolder(r.folder);
    return { ...r, budget: JSON.parse(r.budget), mountLabel, relPath };
  });
  return NextResponse.json({ runs });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  try {
    const run = createRun({
      folder: String(body.folder ?? ""),
      mountId: body.mountId ? String(body.mountId) : null,
      prompt: String(body.prompt ?? ""),
      model: body.model ? String(body.model) : null,
      permissionMode: body.permissionMode as never,
      budget: body.budget,
    });

    // Fire and forget: the run loop reports through the event stream, and the
    // HTTP response should not block for the lifetime of an agent session.
    void startRun(run.id).catch(() => {
      /* terminal state is recorded by startRun's own finally block */
    });

    return NextResponse.json({ run: { ...run, budget: JSON.parse(run.budget) } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
