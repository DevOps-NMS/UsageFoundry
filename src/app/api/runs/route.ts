import { NextResponse } from "next/server";
import { createRun, describeFolder, listRuns, queuePosition } from "@/lib/orchestrator";
import { PERMISSION_MODES, type PermissionMode } from "@/lib/settings";
import { ENFORCEMENT_MODES, normalizePolicy } from "@/lib/budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const runs = listRuns(100).map((r) => {
    const { mountId, mountLabel, relPath } = describeFolder(r.folder);
    // Normalised on read: rows predating enforcement modes carry no
    // `enforcement` or `continueAfterDone` key, and the DTO must not claim they
    // do. See the same note in the single-run route.
    const rawBudget = JSON.parse(r.budget) as Record<string, unknown>;
    return {
      ...r,
      budget: {
        ...normalizePolicy(rawBudget),
        permissionMode: rawBudget.permissionMode,
      },
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

  const rawBudget = (body.budget ?? {}) as Record<string, unknown>;

  // Narrowed for the same reason permissionMode is: this value decides whether
  // a running agent is killed part-way through a work cycle, so an unrecognised
  // one is reported rather than quietly downgraded to the safe default.
  if (rawBudget.enforcement !== undefined && rawBudget.enforcement !== null) {
    const candidate = String(rawBudget.enforcement);
    if (!(ENFORCEMENT_MODES as readonly string[]).includes(candidate)) {
      return NextResponse.json(
        { error: `Unknown enforcement mode: ${candidate}` },
        { status: 400 },
      );
    }
  }

  // Normalised here so the rules below read the same values the run will. The
  // wire form carries strings and blanks, and "5" is not > null. createRun
  // normalises again, which is a no-op by construction.
  const policy = normalizePolicy(rawBudget);

  if (policy.maxIterations === null && policy.maxDurationMinutes === null) {
    return NextResponse.json(
      {
        error:
          "A run with no work-cycle limit needs a time limit. Wall-clock time " +
          "is the only limit that keeps advancing whether or not the agent " +
          "reports what it spent, so it is the only thing that would end this run.",
      },
      { status: 400 },
    );
  }

  // A 5-hour percentage used to be required here, on the reasoning that without
  // one nothing could ever ask the run to step aside. That is no longer true:
  // the run also steps aside when Claude itself refuses a cycle for want of
  // allowance, which needs no percentage and no configured ceiling. Requiring
  // one now would reject exactly the setup that needs this mode most — the
  // default one, where no ceiling is known and the wall arrives unannounced.

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
      budget: policy,
    });

    const storedBudget = JSON.parse(run.budget) as Record<string, unknown>;
    return NextResponse.json({
      run: {
        ...run,
        budget: {
          ...normalizePolicy(storedBudget),
          permissionMode: storedBudget.permissionMode,
        },
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
