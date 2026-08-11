import { NextResponse } from "next/server";
import { scanUsage } from "@/lib/transcripts";
import { buildSnapshot } from "@/lib/windows";
import { getSettings, limitConfig } from "@/lib/settings";
import { readAccountProfile } from "@/lib/account";
import { telemetryWindow } from "@/lib/otlp";
import { PROJECTS_DIR } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scan = await scanUsage();
    const account = await readAccountProfile();
    const settings = getSettings();
    const entries = settings.includeSidechains
      ? scan.entries
      : scan.entries.filter((e) => !e.isSidechain);

    const snapshot = buildSnapshot(
      entries,
      limitConfig(settings),
      Date.now(),
      settings.sessionResetOverrideAt,
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
        hasSessionCeiling:
          settings.sessionCostLimit !== null || settings.sessionTokenLimit !== null,
        hasWeeklyCeiling:
          settings.weeklyCostLimit !== null || settings.weeklyTokenLimit !== null,
        reservedHeadroomFraction: settings.reservedHeadroomFraction ?? 0,
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
