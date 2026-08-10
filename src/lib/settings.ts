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
  /**
   * How many runs may be active at once. Null means no limit.
   *
   * A concurrency knob, not a usage ceiling — the no-default-ceilings rule
   * above does not apply, because unlike a limit this number is not a guess at
   * something Anthropic knows and we do not. It does move the spend bound
   * though: each run carries its own `maxRunCostUSD`, so N runs can overshoot
   * by N work cycles rather than one.
   */
  maxConcurrentRuns: number | null;
  /**
   * Gitignored files copied into a fresh checkout, newest-wins glob order.
   *
   * A worktree contains committed work only, so an isolated agent would
   * otherwise start with no environment file and fail its first command. Kept
   * narrow on purpose: build output and dependency trees are rebuilt by the
   * agent, and copying them would be slow and stale.
   */
  isolationCopyGlobs: string[];
  /** Prepended to the first prompt of an isolated run. */
  isolationPreamble: string;
  /**
   * Ask agents this app spawns to report their own per-request cost over OTLP.
   *
   * Off by default. It turns on telemetry inside a child process and points it
   * at this server, which is a side effect a user should opt into rather than
   * discover. When on, a run gets a first-party cost figure per API request
   * — including requests belonging to an iteration that died before the CLI
   * emitted its `result` event, which is the one number the run row cannot
   * otherwise recover.
   */
  telemetryForRuns: boolean;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export const DEFAULT_CONTINUATION_PROMPT =
  "Continue working on the task. If it is fully complete and verified, reply " +
  "with exactly DONE on its own line and make no further changes.";

/**
 * Without this, the expected outcome of an isolated run is uncommitted edits in
 * a hidden directory the folder picker deliberately skips — the operator looks
 * at their repository, sees nothing changed, and concludes the run did nothing.
 */
export const DEFAULT_ISOLATION_PREAMBLE =
  "You are working in a dedicated git worktree on your own branch, not in the " +
  "user's checkout. Commit your work as you go, with clear messages; anything " +
  "left uncommitted will not be visible to the user.";

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
  maxConcurrentRuns: null,
  isolationCopyGlobs: [".env", ".env.*", "!.env.example"],
  isolationPreamble: DEFAULT_ISOLATION_PREAMBLE,
  telemetryForRuns: false,
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
