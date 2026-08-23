// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib and the chat route already do.
import { NextResponse } from "next/server";
import {
  DEPENDENCY_EDGES,
  createRun,
  currentSnapshot,
  dependenciesOf,
  describeFolder,
  listRuns,
  queuePosition,
  type DependencyEdge,
  type RunDependencyInput,
} from "../../../lib/orchestrator";
import { recentOpsEvents } from "../../../lib/ops";
import {
  MAX_LIST_PROMPT,
  type BootReconcileDTO,
  type RunListItemDTO,
} from "../../../lib/apiTypes";
import { PERMISSION_MODES, type PermissionMode } from "../../../lib/settings";
import { resolveAgentForRun, runAgentDTO } from "../../../lib/agents";
import {
  ENFORCEMENT_MODES,
  normalizePolicy,
  windowGuardRefusal,
} from "../../../lib/budget";
import { auditMutation, SUBJECT_HEADER } from "../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The task, short enough that a hundred of them are not the response.
 *
 * `MAX_LIST_PROMPT - 1` plus the ellipsis, `clipReason`'s shape, so a clipped
 * value is the marked length rather than one character over it and cannot be
 * mistaken for a whole task. The list truncates the line it draws anyway; what
 * this bounds is the wire.
 */
function clipPrompt(prompt: string): string {
  return prompt.length <= MAX_LIST_PROMPT
    ? prompt
    : `${prompt.slice(0, MAX_LIST_PROMPT - 1)}…`;
}

export async function GET() {
  const rows = listRuns(100);
  const deps = dependenciesOf(rows.map((r) => r.id));
  const runs: RunListItemDTO[] = rows.map((r) => {
    const { mountId, mountLabel, relPath } = describeFolder(r.folder);
    // Dropped rather than shipped and ignored. `budget` is the whole normalised
    // policy and `agent` the run's frozen copy of its role — 37KB between them
    // over a hundred rows, measured — and neither the runs list nor quick open
    // reads either. The run's own page asks the route that has them, which is
    // one row rather than a hundred. `runAgentDTO` and the budget normalisation
    // that used to happen here are still in the single-run route, and are still
    // the reason a client never sees the stored blob.
    const { budget: _budget, agent: _agent, ...rest } = r;
    return {
      ...rest,
      // Clipped for the reason `budget` is absent, and the reason
      // `MAX_NEEDS_REVIEW_REASON` clips at the write: the column holds whatever
      // an operator typed and this list is polled every four seconds. Measured:
      // 522,541 bytes of a 696,197-byte response.
      prompt: clipPrompt(r.prompt),
      mountId,
      mountLabel,
      relPath,
      dependsOn: deps.get(r.id) ?? [],
      queuePosition: r.status === "queued" ? queuePosition(r.id) : undefined,
    };
  });
  // Beside the runs rather than on a route of its own: it is the explanation
  // for the rows in that list, and this is the one the page already polls.
  const boot = recentOpsEvents(1, "boot.reconciled")[0] ?? null;
  const lastBootReconcile: BootReconcileDTO | null = boot
    ? {
        at: boot.ts,
        closed: Number(boot.detail.closed ?? 0),
        kept: Number(boot.detail.kept ?? 0),
      }
    : null;
  return NextResponse.json({ runs, lastBootReconcile });
}

/**
 * Read `dependsOn` off the wire.
 *
 * The condition is required rather than defaulted, and that is deliberate:
 * whichever way a silent default fell it would be wrong half the time and
 * silent both times. Defaulting to `on-success` terminates a chain the operator
 * meant to run regardless of the outcome; defaulting to `on-finish` starts a
 * run on top of a dependency that crashed. So a dependency states its condition
 * or the request is refused, the same treatment `permissionMode` and
 * `enforcement` get above and for the same reason.
 *
 * `continueBranch` is the one field here that *is* defaulted, and to false.
 * Unlike the condition, it has a reading that was true of every dependency
 * before it existed, and the two mistakes are not symmetric: unset, a second
 * agent starts from the target branch and its first `git log` says so; set
 * wrongly, a run commits onto a branch nobody put it on. So absence is the safe
 * answer rather than an ambiguous one.
 *
 * Everything else about the list — unknown ids, a dependency that has already
 * failed, a self-reference, a loop, two dependencies both handing over a
 * branch — is refused by `createRun`, which is the single admission door and is
 * reached from the chat's approval path too. Its messages arrive here as the
 * 400 below.
 */
function readDependencies(
  raw: unknown,
): { ok: true; value: RunDependencyInput[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "dependsOn must be a list of dependencies." };
  }

  const value: RunDependencyInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return {
        ok: false,
        error: `Each dependency must name a run and a condition, as {"runId": "…", "edge": "${DEPENDENCY_EDGES[0]}"}.`,
      };
    }
    const { runId, edge, continueBranch } = entry as {
      runId?: unknown;
      edge?: unknown;
      continueBranch?: unknown;
    };
    if (typeof runId !== "string" || runId === "") {
      return { ok: false, error: "Each dependency needs a runId." };
    }
    if (!(DEPENDENCY_EDGES as readonly unknown[]).includes(edge)) {
      return {
        ok: false,
        error:
          `Dependency on run ${runId.slice(0, 8)} needs a condition: ` +
          `"on-success" (only if that run completes) or "on-finish" ` +
          `(once it has finished, whatever the outcome).`,
      };
    }
    // `=== true`, for the reason `continueAfterDone` and `auto_resolve` are read
    // that way: it decides which branch a billed agent commits to, so a string
    // `"false"` off the wire has to fail safe.
    value.push({
      runId,
      edge: edge as DependencyEdge,
      continueBranch: continueBranch === true,
    });
  }
  return { ok: true, value };
}

async function postHandler(req: Request) {
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

  // Narrowed against the registry the way the mode above is narrowed against
  // its four literals, and refused rather than dropped when it names nothing:
  // the operator started the run that said "and hand the review to the reviewer
  // agent", and a run silently started without it is bit-for-bit a run that was
  // never given one. What crosses the wire is an id — a definition would be a
  // route to an agent nobody saved.
  const agent = resolveAgentForRun(body.agentId);
  if (!agent.ok) {
    return NextResponse.json({ error: agent.error }, { status: 400 });
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

  const deps = readDependencies(body.dependsOn);
  if (!deps.ok) {
    return NextResponse.json({ error: deps.error }, { status: 400 });
  }

  // A 5-hour percentage used to be required here, on the reasoning that without
  // one nothing could ever ask the run to step aside. That is no longer true:
  // the run also steps aside when Claude itself refuses a cycle for want of
  // allowance, which needs no percentage and no configured ceiling. Requiring
  // one now would reject exactly the setup that needs this mode most — the
  // default one, where no ceiling is known and the wall arrives unannounced.

  // A fraction guard with nothing to read is refused **here**, and nowhere
  // after: `RUN_ENFORCEABLE_CODES` keeps the pre-cycle guard from ending a run
  // over it, because the reading it needs is the provider's own percentage and
  // an unreachable Anthropic host would otherwise stop every fraction-guarded
  // run in the install at its next cycle boundary. This is the moment with a
  // person and an error channel, which is what makes refusing right here and
  // logging everywhere else the same decision `startWorkflow` already makes for
  // an instance. The snapshot is awaited before `createRun` rather than inside
  // it: that function runs from entry to INSERT with no `await` at all, and one
  // here would silently reintroduce two agents in one directory.
  if (policy.maxWeeklyFraction !== null || policy.maxSessionFraction !== null) {
    const refusal = windowGuardRefusal(policy, await currentSnapshot());
    if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
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
      agent: agent.agent,
      budget: policy,
      dependsOn: deps.value,
      // The one route a person reaches with a form in front of them. There is
      // no authorising record beyond the request itself, which the request log
      // holds — see the `x-uf-subject` header set on the response below.
      origin: "form",
    });

    const storedBudget = JSON.parse(run.budget) as Record<string, unknown>;
    // The audit line's subject. Every other mutating route names the row it
    // acts on in its own path; this one mints the id inside the handler, and
    // the wrapper will not read a response body to find it. Stripped before the
    // response leaves.
    const response = NextResponse.json({
      run: {
        ...run,
        budget: {
          ...normalizePolicy(storedBudget),
          permissionMode: storedBudget.permissionMode,
        },
        agent: runAgentDTO(run.agent),
        dependsOn: dependenciesOf([run.id]).get(run.id) ?? [],
        queuePosition: run.status === "queued" ? queuePosition(run.id) : undefined,
      },
    });
    response.headers.set(SUBJECT_HEADER, run.id);
    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
