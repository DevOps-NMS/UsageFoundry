import v8 from "node:v8";
import { NextResponse } from "next/server";
import { scanUsage, transcriptCacheStats } from "@/lib/transcripts";
import {
  agentOriginIndex,
  buildPeriods,
  buildSnapshot,
  resolveTimeZone,
} from "@/lib/windows";
import { listAgents, listAmbientAgents } from "@/lib/agents";
import { getSettings, limitConfig, newWorkPaused } from "@/lib/settings";
import { readAccountProfile } from "@/lib/account";
import { planUsage } from "@/lib/planUsage";
import { telemetryWindow } from "@/lib/otlp";
import { retentionCutoff } from "@/lib/retention";
import { installSpendReport } from "@/lib/installBudget";
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
    // The transcript horizon, carried onto the card rather than enforced
    // against it. This offers twelve months and the shipped horizon is thirty
    // days, so a longer history than the retention would need the retention to
    // be a year — which would defeat it. `buildPeriods` already drops buckets
    // that closed before the first entry, so pruning makes the history
    // *shorter* rather than wrong; this is the sentence for the one bucket the
    // cutoff falls inside. Read from the same setting `sweepTranscripts` reads.
    const completeFrom = retentionCutoff(settings.transcriptRetentionDays, now);
    const periods = {
      day: buildPeriods(entries, "day", limits, now, timeZone, completeFrom),
      week: buildPeriods(entries, "week", limits, now, timeZone, completeFrom),
      month: buildPeriods(entries, "month", limits, now, timeZone, completeFrom),
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
      // Unconditional, unlike `telemetry`: the ceiling is what the operator
      // typed and the reading is money this app recorded spending, so there is
      // no setting to gate it on and nothing to leak by reporting it. Its own
      // key rather than a field on `snapshot`, because it is a fourth reading
      // over a different span and must never be summed with the meters.
      install: installSpendReport(now),
      meta: {
        transcriptDir: PROJECTS_DIR,
        fileCount: scan.fileCount,
        entryCount: entries.length,
        unpricedModels: scan.unpricedModels,
        scannedAt: scan.scannedAt,
        // Capped for the reason a shortened diff is, and the count is the whole
        // set so the page can say how much it is not showing. Every figure on
        // this response is a floor while this is non-empty.
        readFailures: scan.readFailures.slice(0, 5),
        readFailureCount: scan.readFailures.length,
        // What this process is holding, and what V8 will let it hold. The
        // transcript cache is the largest thing on this heap by a wide margin
        // and used to grow with every turn ever written, so the two are read
        // together: a rising `heapUsedBytes` beside a flat `entries` at
        // `maxEntries` is the cache doing its job, and beside a climbing
        // `entries` it is something else.
        memory: {
          cache: transcriptCacheStats(),
          heapUsedBytes: process.memoryUsage().heapUsed,
          heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
        },
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
        // On the dashboard because a held fleet and a quiet one are identical
        // here otherwise: the meters read the same, and the only difference is
        // that nothing new ever starts. One boolean off a settings row rather
        // than a second poll — this route is already the page's heartbeat.
        newWorkPaused: newWorkPaused(),
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
