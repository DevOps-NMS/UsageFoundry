import { NextResponse } from "next/server";
import { scanUsage } from "@/lib/transcripts";
import {
  agentOriginIndex,
  buildPeriods,
  buildSnapshot,
  resolveTimeZone,
} from "@/lib/windows";
import { listAgents, listAmbientAgents } from "@/lib/agents";
import { getSettings, limitConfig } from "@/lib/settings";
import { readAccountProfile } from "@/lib/account";
import { planUsage } from "@/lib/planUsage";
import { telemetryWindow } from "@/lib/otlp";
import { PROJECTS_DIR } from "@/lib/config";
import { configProblems } from "@/lib/configCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const settings = getSettings();
    const [scan, account, plan] = await Promise.all([
      scanUsage(),
      readAccountProfile(),
      settings.planUsageFromApi ? planUsage() : Promise.resolve(null),
    ]);
    const entries = settings.includeSidechains
      ? scan.entries
      : scan.entries.filter((e) => !e.isSidechain);

    const now = Date.now();
    const limits = limitConfig(settings);
    // Read here rather than inside `buildSnapshot`, which is the function the
    // orchestrator calls before every work cycle: this is a SQLite read and a
    // directory walk, and it decides nothing — it only annotates a column with
    // where each agent name's definition lives. Only the user scope of the
    // ambient set is available, for the reason `GET /api/agents` gives: the
    // project scope depends on a cwd, and this column covers every transcript
    // on the machine rather than one checkout. A repository's own agent
    // therefore reads as `unknown`, and the card says what unmarked means.
    const agentNames = agentOriginIndex(
      listAgents().map((a) => a.name),
      listAmbientAgents().map((a) => a.name),
    );
    const snapshot = buildSnapshot(
      entries,
      limits,
      now,
      settings.sessionResetOverrideAt,
      plan,
      agentNames,
    );

    // Calendar buckets are wrong at every edge if they are cut in the wrong
    // zone, and the container runs in UTC — so the browser names the zone it is
    // displaying in and `resolveTimeZone` refuses anything that is not one.
    // All three granularities on every poll: the client toggle then costs no
    // request, and the whole set is a tenth of what the snapshot already is.
    const timeZone = resolveTimeZone(
      new URL(req.url).searchParams.get("tz"),
    );
    const periods = {
      day: buildPeriods(entries, "day", limits, now, timeZone),
      week: buildPeriods(entries, "week", limits, now, timeZone),
      month: buildPeriods(entries, "month", limits, now, timeZone),
    };

    // Bounded by the snapshot's own window so the card describes the same five
    // hours as the session meter — and read only when the setting is on, so a
    // stock install carries no telemetry key on the wire at all. It is never
    // folded into `snapshot`: see the DTO comment on `UsageResponse.telemetry`.
    const telemetry = settings.telemetryForRuns
      ? telemetryWindow(snapshot.session.startsAt)
      : null;

    return NextResponse.json({
      snapshot,
      periods,
      telemetry,
      meta: {
        transcriptDir: PROJECTS_DIR,
        fileCount: scan.fileCount,
        entryCount: entries.length,
        unpricedModels: scan.unpricedModels,
        scannedAt: scan.scannedAt,
        // "Can this window show a percentage at all", which the provider's own
        // reading answers without anything being configured — the whole point
        // of it. Reading the snapshot rather than the settings is what keeps
        // the "no ceilings" banner off a dashboard that is showing real
        // percentages.
        hasSessionCeiling:
          snapshot.session.fraction !== null ||
          settings.sessionCostLimit !== null ||
          settings.sessionTokenLimit !== null,
        hasWeeklyCeiling:
          snapshot.weekly.fraction !== null ||
          settings.weeklyCostLimit !== null ||
          settings.weeklyTokenLimit !== null,
        // Whether the setting is on, so the UI can tell "switched off" apart
        // from "on, but the provider did not answer" — the second is worth a
        // sentence and the first is not.
        planUsageFromApi: settings.planUsageFromApi,
        reservedHeadroomFraction: settings.reservedHeadroomFraction ?? 0,
        // What the user typed, so the meters can name it alongside the reduced
        // ceiling they are actually measured against.
        configuredCeilings: {
          sessionCost: settings.sessionCostLimit,
          weeklyCost: settings.weeklyCostLimit,
          sessionTokens: settings.sessionTokenLimit,
          weeklyTokens: settings.weeklyTokenLimit,
        },
        sessionResetOverrideAt: settings.sessionResetOverrideAt,
        includeSidechains: settings.includeSidechains,
        account,
        entrypoints: [
          ...new Set(entries.map((e) => e.entrypoint).filter(Boolean)),
        ] as string[],
        // Cached from the boot probe, so this costs a property read rather than
        // a stat per mount on a ten-second poll. On this page because a wrongly
        // pointed mount and a wrongly pointed CLAUDE_HOME both present as the
        // zeros above it, which is also what a quiet week looks like.
        configProblems: configProblems(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
