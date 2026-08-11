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
   * Epoch ms at which the provider's current 5-hour window resets, when the
   * transcripts cannot show it.
   *
   * The window normally opens at the first turn after a gap, which is why it is
   * derived rather than configured. But Anthropic restarts it on a subscription
   * change, and that event appears nowhere in a transcript: the entries still
   * describe one continuous block while the limit is being enforced against a
   * window that started later. Setting the reset instant printed by `/usage`
   * splits the block there, so the meter and the guard measure the window that
   * is actually in force.
   *
   * Not a ceiling and not an estimate — it is an observed fact the local data
   * happens not to contain, so it is exempt from the no-default-numbers rule
   * above. It still defaults to null: a wrong value here is worse than none.
   */
  sessionResetOverrideAt: number | null;
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
  /**
   * Sent when an agent reports DONE and the run is set to carry on regardless.
   *
   * Cannot be `continuationPrompt`: that one says "if it is fully complete,
   * reply with exactly DONE", so feeding it back after a DONE produces an
   * immediate second DONE and a tight, billed spin loop.
   */
  donePushbackPrompt: string;
  /**
   * How often a live-enforced run re-reads usage during a work cycle.
   *
   * A cadence, not a ceiling, so the no-default-numbers rule above does not
   * apply. 60s because each check is a transcript scan, and because the
   * underlying data only moves when Claude Code flushes a completed turn — a
   * 5-second interval would re-walk ~/.claude twelve times a minute to learn
   * nothing new. It does not make enforcement precise: the real resolution is
   * one model turn, and the UI says so.
   */
  liveGuardIntervalSeconds: number;
  /**
   * How stale a parked run's pause may be and still survive a restart.
   *
   * A run waiting on the 5-hour window is preserved across a restart, unlike a
   * queued one, because the operator explicitly chose "carry on into the next
   * window" — that is informed consent a bare queued row does not carry. The
   * grace period is what keeps it from becoming "auto-start a days-old prompt".
   */
  resumeGraceHours: number;
  /**
   * How an isolated run's branch is brought into the branch it started from.
   *
   * `merge` keeps what the run actually did — its commits, in order, which is
   * what makes the run page's `<base>...<branch>` diff still mean something
   * afterwards. `squash` collapses it to one commit and loses that, in exchange
   * for a history with one entry per run. Neither is right for everyone, which
   * is why it is a setting rather than a decision baked into the button.
   */
  landStrategy: "merge" | "squash";
  /**
   * Spawn each agent in its own process group, so a kill also reaps the builds,
   * test runners and servers it started.
   *
   * On by default: those grandchildren hold the working tree, and a signal
   * aimed at the CLI alone leaves them running and writing into a directory the
   * orchestrator is about to resume into or hand off. Off restores the older
   * behaviour of signalling only the `claude` process.
   */
  killProcessGroup: boolean;
  /**
   * Hard ceiling on what one orchestrator-chat turn may spend. Null removes it.
   *
   * Not a window ceiling, so the no-default-numbers rule above does not apply:
   * it is not a guess at a limit Anthropic knows and we do not, it is a cap on
   * this app's own behaviour, and unlike every other guard here it is enforced
   * *inside* the CLI (`--max-budget-usd`) rather than between cycles. It needs a
   * default because a chat turn passes through no `evaluateBudget` at all — the
   * only other thing bounding it is the wall-clock timeout, and "read every
   * issue in the repository" can spend a lot inside ten minutes.
   */
  chatTurnBudgetUSD: number | null;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

/**
 * The four literals `--permission-mode` accepts, as a value rather than a type.
 *
 * Every route that can put a value on that flag narrows against this list, and
 * there are now three of them — the run form, a saved template, and reading a
 * template back. One shared constant is what keeps a fourth from being written
 * against a list that has quietly drifted.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

export const DEFAULT_CONTINUATION_PROMPT =
  "Continue working on the task. If it is fully complete and verified, reply " +
  "with exactly DONE on its own line and make no further changes.";

/**
 * Without this, the expected outcome of an isolated run is uncommitted edits in
 * a hidden directory the folder picker deliberately skips — the operator looks
 * at their repository, sees nothing changed, and concludes the run did nothing.
 */
/**
 * Biased hard toward verification rather than new work, and explicit that
 * saying DONE again will not end the run.
 *
 * An agent told only "carry on" against a task it believes finished will invent
 * features, refactor working code and churn dependencies — and on a run that is
 * not isolated, that lands in the operator's own checkout. An instruction it
 * cannot satisfy produces the same churn, hence the last sentence.
 */
export const DEFAULT_DONE_PUSHBACK_PROMPT =
  "You reported the task complete, but this run still has budget left and is " +
  "set to spend it on the same task. Do not start new features and do not " +
  "refactor working code for its own sake. Instead: re-read the original task " +
  "and check every part of it is met; run the tests and fix what fails; look " +
  "for edge cases, error handling and missing tests; and correct any " +
  "documentation your changes made wrong. This run ends when it reaches a " +
  "limit, not when you report it done, so if you truly find nothing worth " +
  "doing, say so and make no changes.";

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
  sessionResetOverrideAt: null,
  reservedHeadroomFraction: null,
  defaultPermissionMode: "acceptEdits",
  defaultModel: null,
  continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
  includeSidechains: true,
  maxConcurrentRuns: null,
  isolationCopyGlobs: [".env", ".env.*", "!.env.example"],
  isolationPreamble: DEFAULT_ISOLATION_PREAMBLE,
  telemetryForRuns: false,
  donePushbackPrompt: DEFAULT_DONE_PUSHBACK_PROMPT,
  liveGuardIntervalSeconds: 60,
  resumeGraceHours: 24,
  landStrategy: "merge",
  killProcessGroup: true,
  chatTurnBudgetUSD: 2,
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
