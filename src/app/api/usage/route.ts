import { NextResponse } from "next/server";
import { scanUsage } from "@/lib/transcripts";
import { buildPeriods, buildSnapshot, resolveTimeZone } from "@/lib/windows";
import { getSettings, limitConfig } from "@/lib/settings";
import { readAccountProfile } from "@/lib/account";
import { telemetryWindow } from "@/lib/otlp";
import { PROJECTS_DIR } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const scan = await scanUsage();
    const account = await readAccountProfile();
    const settings = getSettings();
    const entries = settings.includeSidechains
      ? scan.entries
      : scan.entries.filter((e) => !e.isSidechain);

    const now = Date.now();
    const limits = limitConfig(settings);
    const snapshot = buildSnapshot(
      entries,
      limits,
      now,
      settings.sessionResetOverrideAt,
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
        hasSessionCeiling:
          settings.sessionCostLimit !== null || settings.sessionTokenLimit !== null,
        hasWeeklyCeiling:
          settings.weeklyCostLimit !== null || settings.weeklyTokenLimit !== null,
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
