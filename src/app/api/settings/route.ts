import { NextResponse } from "next/server";
import { getSettings, saveSettings, type Settings } from "@/lib/settings";
import {
  hasAdminKey,
  WORKSPACE_MOUNTS,
  WORKSPACE_ROOT,
  CLAUDE_HOME,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    settings: getSettings(),
    env: {
      workspaceRoot: WORKSPACE_ROOT,
      workspaceMounts: WORKSPACE_MOUNTS,
      claudeHome: CLAUDE_HOME,
      adminKeyConfigured: hasAdminKey(),
    },
  });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const optionalNumber = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const patch: Partial<Settings> = {};

  if ("sessionCostLimit" in body)
    patch.sessionCostLimit = optionalNumber(body.sessionCostLimit);
  if ("weeklyCostLimit" in body)
    patch.weeklyCostLimit = optionalNumber(body.weeklyCostLimit);
  if ("sessionTokenLimit" in body)
    patch.sessionTokenLimit = optionalNumber(body.sessionTokenLimit);
  if ("weeklyTokenLimit" in body)
    patch.weeklyTokenLimit = optionalNumber(body.weeklyTokenLimit);

  if ("reservedHeadroomFraction" in body) {
    const n = optionalNumber(body.reservedHeadroomFraction);
    // Accept a percentage typed as 0–100 as well as a 0–1 fraction. Capped at
    // 0.95 so a slip cannot drive the effective ceiling to zero and wedge
    // every run behind a guard that can never pass.
    patch.reservedHeadroomFraction =
      n === null ? null : Math.min(n > 1 ? n / 100 : n, 0.95);
  }

  if ("weeklyAnchor" in body) {
    const a = body.weeklyAnchor as { weekday?: unknown; hourUTC?: unknown } | null;
    if (!a) patch.weeklyAnchor = null;
    else {
      const weekday = Number(a.weekday);
      const hourUTC = Number(a.hourUTC);
      patch.weeklyAnchor =
        Number.isInteger(weekday) &&
        weekday >= 0 &&
        weekday <= 6 &&
        Number.isInteger(hourUTC) &&
        hourUTC >= 0 &&
        hourUTC <= 23
          ? { weekday, hourUTC }
          : null;
    }
  }

  if ("defaultPermissionMode" in body) {
    const allowed = ["default", "acceptEdits", "bypassPermissions", "plan"];
    const v = String(body.defaultPermissionMode);
    if (allowed.includes(v)) patch.defaultPermissionMode = v as Settings["defaultPermissionMode"];
  }

  if ("defaultModel" in body) {
    const v = body.defaultModel;
    patch.defaultModel = typeof v === "string" && v.trim() ? v.trim() : null;
  }

  if ("continuationPrompt" in body) {
    const v = String(body.continuationPrompt ?? "").trim();
    if (v) patch.continuationPrompt = v;
  }

  if ("includeSidechains" in body) {
    patch.includeSidechains = Boolean(body.includeSidechains);
  }

  return NextResponse.json({ settings: saveSettings(patch) });
}
