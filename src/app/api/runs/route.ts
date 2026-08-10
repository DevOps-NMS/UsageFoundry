import { NextResponse } from "next/server";
import { createRun, describeFolder, listRuns, queuePosition } from "@/lib/orchestrator";
import type { PermissionMode } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

export async function GET() {
  const runs = listRuns(100).map((r) => {
    const { mountId, mountLabel, relPath } = describeFolder(r.folder);
    return {
      ...r,
      budget: JSON.parse(r.budget),
      mountId,
      mountLabel,
      relPath,
      queuePosition: r.status === "queued" ? queuePosition(r.id) : undefined,
    };
  });
  return NextResponse.json({ runs });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // This value reaches `--permission-mode` on a process that edits files, so it
  // is narrowed against the allowed set rather than trusted from the wire.
  let permissionMode: PermissionMode | undefined;
  if (body.permissionMode !== undefined && body.permissionMode !== null) {
    const candidate = String(body.permissionMode);
    if (!PERMISSION_MODES.includes(candidate as PermissionMode)) {
      return NextResponse.json(
        { error: `Unknown permission mode: ${candidate}` },
        { status: 400 },
      );
    }
    permissionMode = candidate as PermissionMode;
  }

  try {
    // createRun admits or queues the run and starts whatever is now startable.
    // It never blocks on the agent: the run loop reports through the event
    // stream, and the response should not last the lifetime of a session.
    const run = createRun({
      folder: String(body.folder ?? ""),
      mountId: body.mountId ? String(body.mountId) : null,
      prompt: String(body.prompt ?? ""),
      model: body.model ? String(body.model) : null,
      permissionMode,
      isolate: body.isolate === undefined ? undefined : body.isolate !== false,
      budget: body.budget,
    });

    return NextResponse.json({
      run: {
        ...run,
        budget: JSON.parse(run.budget),
        queuePosition: run.status === "queued" ? queuePosition(run.id) : undefined,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
