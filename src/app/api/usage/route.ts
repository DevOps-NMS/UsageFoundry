import { NextResponse } from "next/server";
import { scanUsage } from "@/lib/transcripts";
import { buildSnapshot } from "@/lib/windows";
import { getSettings, limitConfig } from "@/lib/settings";
import { readAccountProfile } from "@/lib/account";
import { planUsage } from "@/lib/planUsage";
import { telemetryWindow } from "@/lib/otlp";
import { PROJECTS_DIR } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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

    const snapshot = buildSnapshot(
      entries,
      limitConfig(settings),
      Date.now(),
      settings.sessionResetOverrideAt,
      plan,
    );

    // Bounded by the snapshot's own window so the card describes the same five
    // hours as the session meter — and read only when the setting is on, so a
    // stock install carries no telemetry key on the wire at all. It is never
    // folded into `snapshot`: see the DTO comment on `UsageResponse.telemetry`.
    const telemetry = settings.telemetryForRuns
      ? telemetryWindow(snapshot.session.startsAt)
      : null;

    return NextResponse.json({
      snapshot,
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
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
