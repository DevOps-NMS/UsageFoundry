import { NextResponse } from "next/server";
import { getRun } from "@/lib/orchestrator";
import { scanUsage } from "@/lib/transcripts";
import { agentOriginIndex, agentSpend } from "@/lib/windows";
import { listAgents, listAmbientAgents } from "@/lib/agents";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What this run's turns cost, split by who produced them.
 *
 * A route of its own rather than a field on `/api/runs/[id]`, which the run page
 * polls every three seconds while a run is working. This answer needs a full
 * transcript scan and a linear pass over every entry on the machine, and the
 * agent it is describing is competing for the same CPU — the same reason the
 * dashboard's own poll only speeds up to 5s and never further. The card polls
 * this on its own, slower, cadence.
 *
 * The reading is the **transcript** source scoped to one session, which is what
 * `reconcileKilledCycle` already reads for `spent_usd_est` and not a new source.
 * It is display only: it never reaches `runs.spent_usd`, never reaches
 * `buildSnapshot`, never reaches a budget verdict, and is never added to what
 * the CLI reported or to what telemetry reported.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // No session id is "there is nothing to read yet", not "$0.00": the column is
  // written the moment the stream first names a session, so a run without one
  // has not opened a conversation. The card renders that as the hatched
  // indeterminate bar rather than an empty one.
  if (!run.session_id) {
    return NextResponse.json({ spend: null });
  }

  try {
    const settings = getSettings();
    const { entries } = await scanUsage();

    // Bounded by session id *and* by time, for `reconcileKilledCycle`'s reason:
    // a resumed session copies earlier turns forward carrying their original
    // timestamps, so the id alone is not a bound. `created_at` rather than
    // `started_at` because `reopenRun` clears the latter — a run picked up by
    // hand would otherwise report only what it has spent since the pick-up,
    // under a heading that says it describes the run.
    const from = run.created_at;
    const to = run.finished_at ?? Date.now();
    const mine = entries.filter(
      (e) => e.sessionId === run.session_id && e.ts >= from && e.ts <= to,
    );

    const spend = agentSpend(
      mine,
      agentOriginIndex(
        listAgents().map((a) => a.name),
        // The user scope only, as `GET /api/agents` answers with: the project
        // scope depends on a cwd, and resolving an arbitrary one on the wire is
        // a containment surface this does not need. A repository's own agent
        // therefore reads as `unknown`, which the card explains.
        listAmbientAgents().map((a) => a.name),
      ),
    );

    return NextResponse.json({
      spend: {
        ...spend,
        from,
        to,
        // Sub-agent turns are counted here whatever that setting says — it is
        // about the dashboard meters, and a card that answered $0.00 because of
        // it would be answering a question nobody asked.
        excludedFromTotals: !settings.includeSidechains,
      },
    });
  } catch (err) {
    // An unreadable transcript directory is a failed reading, not a run with no
    // agent work. 500 so the card says it could not read rather than drawing an
    // empty split — `jsonRequest` carries the status and the page says which.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
