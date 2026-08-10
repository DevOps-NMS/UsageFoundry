import { getJSON, setJSON } from "./db";
import type { LimitConfig, WeeklyAnchor } from "./windows";

/**
 * User-editable preferences.
 *
 * Deliberately ships with **no default numeric ceilings**. Anthropic does not
 * publish the token value of a Pro/Max limit and there is no endpoint to read
 * it, so any number baked in here would be a guess wearing the costume of a
 * fact — and a budget guard built on a wrong ceiling fails in the expensive
 * direction. Instead the ceilings start null (windows still render, just
 * without a percentage) and `/api/calibrate` proposes values derived from the
 * user's own observed history.
 */

export interface Settings {
  /**
   * Primary ceilings, denominated in equivalent API cost.
   *
   * Cost rather than raw tokens because a Claude Code workload is ~95% cache
   * reads, which bill at 0.1x. A raw-token ceiling therefore tracks
   * conversation length more than it tracks work done, and its ratio to any
   * real limit moves around with context size.
   */
  sessionCostLimit: number | null;
  weeklyCostLimit: number | null;
  /** Secondary raw-token ceilings. Used only when no cost ceiling is set. */
  sessionTokenLimit: number | null;
  weeklyTokenLimit: number | null;
  weeklyAnchor: WeeklyAnchor | null;
  /**
   * Fraction of each window (0–1) held back for usage this tool cannot see.
   *
   * The 5-hour and weekly limits are shared across Claude Code, Cowork, Claude
   * Desktop, web, and mobile — but only Claude Code writes local transcripts.
   * Everything else is structurally invisible: the Desktop app stores an
   * Electron profile with no usage ledger, and Cowork's scheduled tasks run in
   * the cloud with the device offline.
   *
   * Without a reserve, a guard fails *unsafe*: the dashboard reads 20% while
   * Cowork has quietly consumed another 50%, and an 80% guard permits a run
   * that overruns the real limit. Reserving headroom shrinks the effective
   * ceiling so the guard trips early instead.
   */
  reservedHeadroomFraction: number | null;
  /** Default permission mode for new runs. */
  defaultPermissionMode: PermissionMode;
  /** Default model passed to Claude Code, or null to use its own default. */
  defaultModel: string | null;
  /** Prompt used for iterations after the first in a multi-step run. */
  continuationPrompt: string;
  /** Whether to include sub-agent (sidechain) turns in usage totals. */
  includeSidechains: boolean;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export const DEFAULT_CONTINUATION_PROMPT =
  "Continue working on the task. If it is fully complete and verified, reply " +
  "with exactly DONE on its own line and make no further changes.";

const DEFAULTS: Settings = {
  sessionCostLimit: null,
  weeklyCostLimit: null,
  sessionTokenLimit: null,
  weeklyTokenLimit: null,
  weeklyAnchor: null,
  reservedHeadroomFraction: null,
  defaultPermissionMode: "acceptEdits",
  defaultModel: null,
  continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
  includeSidechains: true,
};

const KEY = "settings";

export function getSettings(): Settings {
  return { ...DEFAULTS, ...getJSON<Partial<Settings>>(KEY, {}) };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  setJSON(KEY, next);
  return next;
}

/**
 * Ceilings as the rest of the app should see them — reserved headroom already
 * subtracted.
 *
 * Applied here rather than at each call site so meters, budget guards, and the
 * exhaustion projection all agree on one effective number. The raw configured
 * values stay on Settings for display.
 */
export function limitConfig(s: Settings = getSettings()): LimitConfig {
  const reserve = Math.min(Math.max(s.reservedHeadroomFraction ?? 0, 0), 0.95);
  const usable = (v: number | null) => (v === null ? null : v * (1 - reserve));

  return {
    sessionCostLimit: usable(s.sessionCostLimit),
    weeklyCostLimit: usable(s.weeklyCostLimit),
    sessionTokenLimit: usable(s.sessionTokenLimit),
    weeklyTokenLimit: usable(s.weeklyTokenLimit),
    weeklyAnchor: s.weeklyAnchor,
  };
}
