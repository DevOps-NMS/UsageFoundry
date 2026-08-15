import { NextResponse } from "next/server";
import { currentSnapshot, getRun, reopenRun } from "@/lib/orchestrator";
import {
  ENFORCEMENT_MODES,
  normalizePolicy,
  windowGuardRefusal,
} from "@/lib/budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Put a finished run back in the queue, under a budget the operator has had a
 * chance to raise, and optionally with something further to say to it.
 *
 * Sibling of `POST /api/runs`, and the budget rules are deliberately the same
 * ones: a reopened run spawns the same agent under the same loop, so anything
 * that would refuse it as a new run has to refuse it here. `permissionMode` is
 * the one field not accepted from the wire — `reopenRun` carries the stored
 * value forward, because reopening is not a reason to open a second route to
 * `--permission-mode`.
 *
 * `followUp` is optional and blank is a legitimate answer, not an error: a run
 * stopped mid-task usually needs nothing said to it, and one that reported
 * itself complete gets the DONE pushback instead. `reopenRun` decides which.
 *
 * Refusals are 400 with a message rather than the 200-plus-outcome shape the
 * sibling stop/resume routes use: every one of them names something the
 * operator can change, and the form has to show it.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const rawBudget = (body.budget ?? {}) as Record<string, unknown>;

  // Narrowed rather than trusted, for the reason given in `POST /api/runs`:
  // this decides whether a running agent is killed part-way through a cycle.
  if (rawBudget.enforcement !== undefined && rawBudget.enforcement !== null) {
    const candidate = String(rawBudget.enforcement);
    if (!(ENFORCEMENT_MODES as readonly string[]).includes(candidate)) {
      return NextResponse.json(
        { error: `Unknown enforcement mode: ${candidate}` },
        { status: 400 },
      );
    }
  }

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

  // The other door, and the same refusal for the same reason: a fraction guard
  // with nothing to read is answered where there is a person, because the
  // pre-cycle guard no longer ends a run over it. Refused before `reopenRun`
  // touches the row, so a run whose guard cannot be read is left exactly as it
  // was rather than flickering queued → stopped.
  if (policy.maxWeeklyFraction !== null || policy.maxSessionFraction !== null) {
    const refusal = windowGuardRefusal(policy, await currentSnapshot());
    if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
  }

  const outcome = reopenRun(id, policy, String(body.followUp ?? ""));
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
