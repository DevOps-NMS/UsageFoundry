import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  CLAUDE_BIN,
  CLAUDE_CONFIG_DIR,
  GITHUB_TOKEN,
  OTLP_SELF_URL,
  WORKSPACE_MOUNTS,
  githubTokenFor,
  matchFolderKey,
  mountById,
  type WorkspaceMount,
} from "./config";
import { git, gitSync } from "./git";
import { dataDirRefusal, mayWriteDataDir, requireDataDir } from "./serverLock";
import { childCredentials, chownForChild } from "./privsep";
import { currentSandbox, sandboxRefusal } from "./sandbox";
import { ensureSandboxMountPoints } from "./sandboxMountPoints";
import { baselineFrom, taskSignature, type CostBaseline } from "./costBaseline";
import { db } from "./db";
import {
  getSettings,
  limitConfig,
  newWorkPaused,
  type PermissionMode,
} from "./settings";
import {
  type BudgetPolicy,
  type BudgetStopCode,
  type BudgetVerdict,
  type RunProgress,
  LIVE_ENFORCEABLE_CODES,
  RESUME_MARGIN_MS,
  enforceableForRun,
  evaluateBudget,
  normalizePolicy,
  planReadingAgeMs,
} from "./budget";
import { installBudgetRefusal, installBudgetVerdict } from "./installBudget";
import {
  lastScanReadFailures,
  readCompactions,
  resolveSessionTranscript,
  scanUsage,
  sessionTranscriptResolver,
  type CompactionBoundary,
  type UsageEntry,
} from "./transcripts";
import { totalTokens } from "./pricing";
import { buildSnapshot, type UsageSnapshot } from "./windows";
import { planUsage } from "./planUsage";
import {
  ingestTokenFor,
  revokeIngestTokens,
  telemetrySpendSince,
  type TelemetrySpend,
} from "./otlp";
import { parseRunAgent, sessionAgentArgs, type AgentDefinition } from "./agents";
import { enabledPluginDirs, pluginDirArgs } from "./plugins";
import {
  BOUNDARY_BREAK_EVEN_BUDGET,
  contextTokens,
  sampleContext,
  coldAgeRefusalMessage,
  CYCLE_CONTEXT_CEILING_TOKENS,
  forgetContextCheck,
  freshestPayback,
  PAYBACK_HORIZON_TURNS,
  CEILING_PAYBACK_HORIZON_TURNS,
  paybackTurns,
  type PaybackReading,
  boundaryAction,
  ceilingDeclineMessage,
  ceilingPayback,
  CEILING_REMEASURE_GROWTH_TOKENS,
  COMPOSITION_REMEASURE_GROWTH_TOKENS,
  contextComposition,
  recordComposition,
  forkTranscript,
  pendingForkFor,
  PLAN_TIER,
  markForkResumed,
  ceilingCut,
  planCut,
  pruneTranscript,
  pruningEnabled,
  recordForkAttempt,
  recordPrune,
  recordPlanObservation,
  recordPruneDecision,
  recordResumeProbe,
  WINNOW_MISSING_REASON,
  type PruneOutcome,
  type PruneTrigger,
} from "./contextPruning";
import { BYTES_PER_TOKEN, fileCostNotice } from "./fileCostNotice";
import { prepareReadGuard } from "./readGuard";
import { prepareVaultSkill } from "./vaultSkill";
import {
  noteLiveTick,
  noteLiveTickFailure,
  noteSweep,
  noteSweepFailure,
  opsLog,
  recordOpsEvent,
} from "./ops";
// The outbound half of the same projection `logLifecycle` performs. It imports
// this module's types back, which is why that import is `import type` there: a
// runtime cycle between the run loop and a notifier would be one more thing
// that can fail at module load, and there is nothing here it needs at runtime.
import { notifyLifecycle } from "./notify";
// The log's own extraction of what a tool call is about, so the parser retains
// the same line for a call whose result comes back an error. Client-safe and
// pure; the dependency runs the permitted way round.
import { clipToolInput, MAX_LOG_CHARS, toolArgs } from "./logLine";
// Same direction, same reason: the cycle deadline says how long it waited in
// the words the run page already uses for every other span.
import { fmtDuration, fmtTokens, shortId } from "./format";
import type { RunDependencyDTO, SandboxStateDTO } from "./apiTypes";
import {
  STDERR_TAIL_LIMIT,
  clipReason,
  buildArgs,
  cycleEnding,
  nextPrompt,
  startsFresh,
  type IterationResult,
} from "./cycleInvocation";

/**
 * Runs Claude Code headlessly against a folder, iteration by iteration, and
 * stops when the budget policy says to.
 *
 * The loop shape is deliberate. Claude Code's `--print` mode is a single
 * request/response; there is no way to pause it partway and ask "should I keep
 * going?". So the budget check lives *between* iterations: each iteration is an
 * atomic unit of spend, and the guard decides whether to start the next one.
 * Cost is read from the `result` event Claude Code emits, which is the same
 * figure the CLI reports — we do not re-derive it from token counts, because
 * the CLI already accounts for cache TTLs and any plan-specific rates.
 *
 * A run whose policy asks for live enforcement gets a second check on a timer
 * while a cycle is in flight, and is killed when one trips. That does not
 * change the shape above — the between-cycles check is still the only exact
 * one, and it is what a `live` run falls back to when nothing trips mid-cycle.
 * What it costs is the in-flight cycle's work and its self-reported cost;
 * `reconcileKilledCycle` recovers an estimate of the latter from transcripts.
 */

export type RunStatus =
  /**
   * Waiting for the runs it was told to start after, and holding nothing while
   * it waits: no folder, no checkout slot, no concurrency slot, and absent from
   * `activeRuns()`. It becomes `queued` — and only then takes a claim on
   * anything — when `releaseDependents` decides its dependencies have settled.
   */
  | "waiting"
  | "queued"
  | "running"
  /** Stepped aside for a full 5-hour window; the sweeper will re-queue it. */
  | "paused"
  | "completed"
  /**
   * The agent judged it could not finish the task and said so.
   *
   * A fourth ending, and the only one in the ladder that is a statement about
   * the *task* rather than about the machine. `completed` is written both for a
   * run that replied DONE and for one that used up its cycle cap, and
   * `maxIterations` defaults to 1 — so before this existed a run that met a wall
   * it could not pass was filed green beside runs that did the job. Not
   * `failed`, which is where something went wrong; not `stopped`, which is a
   * person or a rule they configured deciding; not `blocked`, which is refused
   * before its first work cycle. This one worked, spent money, and reached a
   * judgement worth a person's attention.
   */
  | "needs-review"
  | "stopped"
  | "failed"
  | "blocked";

export interface RunRow {
  id: string;
  /** The folder the operator picked. Stays truthful even when isolated. */
  folder: string;
  prompt: string;
  model: string | null;
  status: RunStatus;
  budget: string;
  baseline: string | null;
  max_iterations: number;
  iterations: number;
  created_at: number;
  /** Higher goes first; `created_at` breaks every tie. Default 0. */
  priority: number;
  started_at: number | null;
  finished_at: number | null;
  stop_reason: string | null;
  exit_code: number | null;
  spent_usd: number;
  spent_tokens: number;
  /** Claude Code's own session id, persisted so a run survives a restart. */
  session_id: string | null;
  /** Where the agent actually runs — the worktree when isolated, else `folder`. */
  work_dir: string | null;
  isolation: "none" | "worktree" | null;
  repo_root: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  /**
   * Commit the worktree branched from, for the handoff diff range.
   *
   * For a run continuing another's branch this is the *chain's* base, copied
   * forward from the predecessor rather than taken from its tip: every diff,
   * every review and the merge itself are `<base>...<branch>`, so anchoring on
   * the tip would show and land only the last link's work.
   */
  worktree_base: string | null;
  /**
   * Branch the operator had checked out when the run was created — the branch
   * this run's work is meant to land *into*. A commit is not enough: it names
   * where the work started, not where it belongs, and "merge into whatever you
   * have checked out right now" is a guess the app should not make.
   */
  worktree_base_branch: string | null;
  /**
   * The run whose branch this one carries on, or null for a branch of its own.
   *
   * Recorded at admission while the rest of the isolation columns are still
   * null — see the schema note in `db.ts`. It is what tells `ensureWorktree`
   * the branch already exists, and what tells `landState` that more than one
   * run has commits on it.
   */
  continues_run: string | null;
  /** When this tool merged the branch into its target. Null means never. */
  landed_at: number | null;
  landed_into: string | null;
  landed_strategy: string | null;
  /** Branch tip at that moment — the only proof a squash took these commits. */
  landed_tip: string | null;
  /** Paused runs: when to look again. A hint, not a promise — see sweepPaused. */
  resume_at: number | null;
  paused_at: number | null;
  pause_count: number;
  done_retriggers: number;
  /**
   * Whether the last work cycle replied DONE. `completed` covers both that and
   * a run that merely used up its cycle cap, and the two need different first
   * prompts when the run is picked up again — see `reopenPrompt`.
   */
  reported_done: number;
  /**
   * What the agent said when it reported it could not finish, clipped to
   * `MAX_NEEDS_REVIEW_REASON`.
   *
   * Describes *the ending this row currently records*, which is `stop_reason`'s
   * invariant — so the loop writes null on every other ending and `reopenRun`
   * clears it, or a reopened run that ends without re-entering the loop would
   * carry a reason describing an ending two segments old.
   */
  needs_review_reason: string | null;
  /**
   * The operator's next message, waiting for the next spawn. Set by
   * `reopenRun`, cleared by the loop as soon as it is delivered.
   */
  follow_up: string | null;
  /**
   * The work cycle currently in flight, or null when no child is running.
   *
   * Deliberately not `iterations`, which is written only when a cycle returns
   * and must go on meaning "cycles completed" — the guard reads it. This is the
   * same number one tick earlier, so a run in its first cycle can say so
   * instead of reading `0/N` like a run that never started.
   */
  active_iteration: number | null;
  /**
   * When the cycle named by `active_iteration` was spawned, or null between
   * cycles. Written and cleared with it, always.
   *
   * The bound `telemetrySpendSince` needs to report what a cycle in flight has
   * cost *so far* without re-counting the cycles already in `spent_usd`. A run's
   * own live guard reads that bound off a local in `startRun`'s frame; anything
   * asking about a different run — a workflow instance's guard is the only such
   * caller — has nowhere but the row to read it from. Only meaningful while the
   * row is `running`: nothing clears it when the container dies mid-cycle, the
   * same caveat `active_iteration` carries.
   */
  active_started_at: number | null;
  /**
   * Spend recovered from transcripts for cycles killed before Claude Code
   * reported theirs. Never added into `spent_usd`; the two are shown side by
   * side and summed only where a total is wanted.
   */
  spent_usd_est: number;
  spent_tokens_est: number;
  /**
   * The agent this run was started **as**, as the whole JSON definition rather
   * than an id — see the column note in `db.ts`. Null is the ordinary run. Read
   * through `parseRunAgent`, never parsed at a call site.
   */
  agent: string | null;
  /**
   * What a `Read` of this folder's largest files costs, frozen at creation and
   * put on every cycle's `--append-system-prompt` unchanged.
   *
   * Frozen because the appended prompt is part of the cached prefix — see the
   * column note in `db.ts` and `fileCostNotice.ts`. Null on every run created
   * before the column, and on any run whose folder could not be walked, and both
   * mean the same thing: this run's prompt is exactly what it was before.
   */
  file_cost_notice: string | null;
  /**
   * 1 when this run ended because the server went down under it, rather than
   * for any reason of its own. Cleared when it is picked up again.
   */
  restart_closed: number;
  /**
   * When an operator set this run aside, or null. Both bulk pick-ups skip a run
   * that carries one; picking it up on its own page clears it. Says nothing
   * about how the run ended — see the column note in `db.ts`.
   */
  set_aside_at: number | null;
  /**
   * Which gate this run came through, recorded rather than deduced. Null only
   * for rows written before the column existed.
   */
  origin: RunOrigin | null;
  /** The record that authorised it: a proposal, an instance, a schedule. */
  origin_ref: string | null;
  /** When an operator last put this terminal run back in the queue. */
  reopened_at: number | null;
}

/**
 * The routes a run can arrive from.
 *
 * Five, and three of them start an agent with nobody at the keyboard — which is
 * the whole reason this is a column. Picking a finished run up again is
 * deliberately *not* a sixth value: `reopenRun` creates nothing, so recording
 * it here would overwrite the one fact the column exists to hold while
 * `created_at` went on pointing at the original creation. It lands on
 * `runs.reopened_at`, and on the request log beside it.
 */
export const RUN_ORIGINS = [
  /** The new-run form: a person filled it in and pressed Start. */
  "form",
  /** An approved chat proposal. `origin_ref` is the proposal. */
  "chat",
  /** A press of Run on a saved workflow. `origin_ref` is the instance. */
  "workflow",
  /** An orchestrator block's own decision. `origin_ref` is the block's node. */
  "orchestrator-block",
  /** A schedule firing with nobody present. `origin_ref` is the schedule. */
  "schedule",
] as const;

export type RunOrigin = (typeof RUN_ORIGINS)[number];

/** Where the agent runs. Older rows predate `work_dir` and never isolated. */
export function workDirOf(run: RunRow): string {
  return run.work_dir ?? run.folder;
}

export interface RunEvent {
  runId: string;
  ts: number;
  kind:
    | "status"
    | "log"
    /** The main thread's own words. A delegated turn is `subagent`. */
    | "assistant"
    /** A turn forwarded by `--forward-subagent-text`. See `handleStreamLine`. */
    | "subagent"
    | "tool"
    /** A tool call that came back an error. See `toolResultFailures`. */
    | "tool_error"
    /**
     * A tool call that failed for a sandbox reason. See `sandboxRefusal`, and
     * `RunEventDTO` for why it is beside the `tool_error` rather than on it.
     */
    | "sandbox"
    | "iteration"
    | "budget"
    | "result"
    | "handoff"
    | "land"
    // The other exit. `land` is work entering the operator's own
    // checkout; `deliver` is it leaving the machine for a remote.
    | "deliver"
    | "review"
    | "error";
  payload: Record<string, unknown>;
}

/**
 * An event as it exists once written: the same thing plus the row id.
 *
 * Read history and the live tail are the same type on purpose. The SSE route
 * puts this id on the frame's `id:` line, and a browser's `Last-Event-ID` only
 * advances on frames that carry one — so a live event published without an id
 * leaves the client pinned to the last *replayed* event, and the next reconnect
 * re-sends every live event it already showed.
 */
export type PersistedRunEvent = RunEvent & { id: number };

const bus = ((globalThis as unknown as { __ufBus?: EventEmitter }).__ufBus ??=
  new EventEmitter());
bus.setMaxListeners(0);

/** stdin is "ignore", so the child has readable stdout/stderr and no stdin. */
type AgentProcess = ChildProcessByStdio<null, Readable, Readable>;

const procs = ((globalThis as unknown as {
  __ufProcs?: Map<string, AgentProcess>;
}).__ufProcs ??= new Map<string, AgentProcess>());

/**
 * Why a run is being stopped, and whether it may come back.
 *
 * Replaces a reason-less `Set` of cancelled ids: with live guards there are now
 * two distinct callers, and filing a guard-driven kill as "Stopped by operator"
 * would be a lie in the one place the operator most needs the truth.
 *
 * `deadline` is the third caller and the one that is nobody's decision: the
 * cycle stopped producing output and this app ended it. It is kept apart from
 * `guard` rather than folded into it because a guard is a rule a person
 * configured and this is a fault — see `interruptOutcome`, which is where the
 * difference becomes something the operator reads.
 *
 * `shutdown` is the fourth, and it is kept apart from `operator` for the same
 * reason one level over: the process is going down and is signalling every run
 * so each one gets the `SIGINT` that lets its cycle report its own cost. It
 * ends the run `stopped`, because a restart is somebody's decision even when
 * nobody typed it into this run's page, and `runs.restart_closed` beside it is
 * what lets the whole set be picked up together afterwards.
 */
export interface Interrupt {
  /**
   * `prune` is the one kind that does not end the run.
   *
   * It ends the *cycle*, so that the transcript can be rewritten at a moment no
   * Claude process is holding it, and then the loop carries on. Every other kind
   * here is terminal or a pause, which is why the loop's post-cycle checkpoint
   * has to test for it before it reaches `applyInterrupt` — `interruptOutcome`
   * has no status that means "carry on" and should never be asked for one.
   */
  kind: "operator" | "guard" | "deadline" | "shutdown" | "prune";
  reason: string;
  code?: BudgetStopCode;
  /** True only for a live-resume step-aside; the run parks rather than ends. */
  pause: boolean;
  resumeAt?: number;
  at: number;
}

// A new globalThis key rather than reusing `__ufCancelled`. `??=` only
// initialises when absent, so on a dev hot reload a pre-upgrade Set sitting at
// the old key would survive and every `.get()` on it would throw.
const interrupts = ((globalThis as unknown as {
  __ufInterrupts?: Map<string, Interrupt>;
}).__ufInterrupts ??= new Map<string, Interrupt>());

/**
 * How a run ends, given why it was interrupted.
 *
 * Pure and tested because it is the whole of what an operator reads off a
 * stopped run, and every way of getting it wrong typechecks and looks like an
 * ordinary ending. A cycle killed on its deadline arrives here as the same
 * shape as an operator's Stop — a dead child, a null exit code, no `result`
 * event — so if this collapsed the four kinds into one status the runs list
 * would say a hung agent had been stopped by somebody, which is the sentence
 * that stops anyone looking for the cause.
 *
 * `failed` for a deadline, and that is the deliberate part: `stopped` is what
 * this app writes when a person or a rule they configured decided, and nobody
 * decided this. It is still terminal and still in `REOPENABLE`, so the run can
 * be picked up by hand exactly as a crashed one can.
 */
export function interruptOutcome(it: Interrupt): {
  status: RunStatus;
  reason: string;
  resumeAt: number | null;
} {
  if (it.pause) {
    return { status: "paused", reason: it.reason, resumeAt: it.resumeAt ?? null };
  }
  // `prune` is deliberately not given a case, and this is the safe direction
  // rather than an omission. The run loop consumes that kind before it reaches
  // here — it is the one interrupt that means "carry on" — so arriving with one
  // means the loop ended some other way first, most often a shutdown, and the
  // run really has stopped. A `status` invented for it here would be a run
  // reported as still going by a function whose whole job is to say how it
  // ended.
  return {
    status: it.kind === "deadline" ? "failed" : "stopped",
    reason: it.reason,
    resumeAt: null,
  };
}

/**
 * Runs with a child in flight that asked for live enforcement.
 *
 * The value closes over `startRun`'s locals. That function is suspended on the
 * `await runIteration(...)` for the whole time an entry is registered, so its
 * `iterations` and the completed cycles' spend are current with no database
 * read and no second copy of the run's progress. The *in-flight* cycle's spend
 * is the one thing those locals cannot supply — it does not exist until the
 * cycle ends — so the closure reads it from telemetry instead.
 */
interface LiveGuard {
  policy: BudgetPolicy;
  progress: () => RunProgress;
}

const liveGuards = ((globalThis as unknown as {
  __ufLiveGuards?: Map<string, LiveGuard>;
}).__ufLiveGuards ??= new Map<string, LiveGuard>());

/**
 * Runs whose in-flight cycle is being watched for the context ceiling.
 *
 * Separate from `liveGuards` and not a field on it, because the two answer to
 * different things. That map is registered only when `enforcement` is not
 * `between-cycles` — an opt-in the operator makes about *budgets* — and the
 * ceiling replaced `--autocompact`, which rode every cycle's argv on every run.
 * Folding this into that map would have made the thing bounding a cycle's
 * context an opt-in nobody knew they were declining.
 *
 * Its own `globalThis` key rather than a wider `liveGuards` value, on the rule
 * `__ufInterrupts` records: `??=` only initialises when absent, so a dev hot
 * reload would keep a pre-change value at the old key and every read of the new
 * field would be undefined.
 *
 * `sessionId` is read through a closure rather than stored, because
 * `adoptSession` can move it while the child is running.
 */
interface ContextWatch {
  sessionId: () => string | null;
  /**
   * The work cycle in flight, so a sample can be filed against it. A closure for
   * `sessionId`'s reason — the loop's counter moves between cycles while this
   * entry stays — and the loop's own value rather than the `runs` row, which is
   * written after a cycle ends and would file every live sample one behind.
   */
  iteration: () => number;
}

/**
 * A **new key**, because the value's shape changed when `iteration` was added.
 * `??=` only initialises when absent, so a dev hot reload would keep the old
 * one-field entries at the old key and every read of the new field would be
 * undefined — the trap this file records at `__ufInterrupts`. The cost is one
 * cold rebuild.
 */
const contextWatches = ((globalThis as unknown as {
  __ufContextWatches2?: Map<string, ContextWatch>;
}).__ufContextWatches2 ??= new Map<string, ContextWatch>());

/**
 * How many times one run may have a cycle ended early and refunded.
 *
 * The refund is what keeps this honest against what it replaced: a compaction
 * never cost a work cycle, so a ceiling crossing that consumed one would make
 * `maxIterations` mean something different than it did before. But an unbounded
 * refund breaks the terminus `budgets-and-guards.md` requires — a run whose
 * every cycle crossed the ceiling would loop forever, always ending, always
 * refunded, never finishing.
 *
 * So it is bounded, `MAX_PAUSES_PER_RUN`'s arrangement and its number. Past
 * this, a crossing still prunes and still ends the cycle; it simply counts,
 * and `iterations` climbs monotonically again.
 */
export const MAX_EARLY_ENDS_PER_RUN = 3;

/** Shared empty reading, for a policy whose guards do not need telemetry. */
const NO_TELEMETRY_SPEND: TelemetrySpend = { requests: 0, costUSD: 0, tokens: 0 };

/**
 * The two background timers, and their reentrancy flags.
 *
 * Both are lazily started and stopped when there is nothing left to watch, so
 * an idle server holds no interval at all.
 */
const timers = ((globalThis as unknown as {
  __ufTimers?: {
    live: NodeJS.Timeout | null;
    sweep: NodeJS.Timeout | null;
    ticking: boolean;
    sweeping: boolean;
  };
}).__ufTimers ??= { live: null, sweep: null, ticking: false, sweeping: false });

/** How often a paused run is reconsidered. */
const SWEEP_MS = 60_000;

/** The shortest silence that may end a work cycle. */
const MIN_CYCLE_SILENCE_MS = 5 * 60_000;
/** `DEFAULTS.maxCycleSilenceMinutes`, for a row that says nothing usable. */
const FALLBACK_CYCLE_SILENCE_MINUTES = 120;

/**
 * How long this run's next cycle may be silent, from what is stored.
 *
 * Read-time narrowing, `chatGuards`' rule and for its reason: the settings blob
 * is JSON in a row that outlives the build which wrote it and can be edited by
 * hand, so `PUT /api/settings` flooring what it is *sent* is not enough on its
 * own. Both ways of reading a bad value are silent and each is expensive in the
 * opposite direction — a zero taken at face value switches the deadline off,
 * which is the defect this exists to end, and a zero read as "the shortest
 * allowed" kills healthy cycles, since the stream goes quiet for the whole of
 * one model turn and the whole of one tool call. So off, negative and corrupt
 * take the default, being three ways of saying nothing usable rather than a
 * request for the shortest deadline there is; a positive number below the floor
 * is a request, and gets the floor.
 */
export function cycleSilenceMs(minutes: number): number {
  const asked = Number(minutes);
  const wanted =
    Number.isFinite(asked) && asked > 0 ? asked : FALLBACK_CYCLE_SILENCE_MINUTES;
  return Math.max(MIN_CYCLE_SILENCE_MS, Math.floor(wanted * 60_000));
}

/* ------------------------------------------------------------------ */
/* Persistence helpers                                                 */
/* ------------------------------------------------------------------ */

function emit(e: RunEvent) {
  // Persist first, then publish — that ordering is what makes a reconnect and
  // a late page load lossless. It is also where the id comes from: the row is
  // what orders the log, so the subscriber is handed the id the insert just
  // assigned rather than a number invented before the write.
  const written = db()
    .prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
    )
    .run(e.runId, e.ts, e.kind, JSON.stringify(e.payload));
  const published: PersistedRunEvent = { ...e, id: Number(written.lastInsertRowid) };
  bus.emit(e.runId, published);
  bus.emit("*", published);
  logLifecycle(published);
  // Third sink, same event, same position: after the publish and never before
  // it. It reads what `logLifecycle` reads on purpose — that projection is an
  // already-reviewed decision about what may leave this container — and it
  // starts no request at all unless `UF_WEBHOOK_URL` is set. **It must never
  // become an `await`.** This function is synchronous from the INSERT to here,
  // and a run ending waiting on a receiver's socket is the one way an outbound
  // notification can break the loop it reports on.
  notifyLifecycle(published);
}

/**
 * The statuses whose stdout line routes at `warn`, and its own constant.
 *
 * Deliberately **not** `TERMINAL_STATUSES`: that list carries `completed`,
 * which is the success nobody should be woken for, and it has five readers
 * deciding whether a dependency chain may start — a level is not one of them,
 * and joining the two is how the next person starts paging on success.
 *
 * `stopped` is deliberately absent. An operator's own cancel arrives as
 * `stopped`, and a run a guard took down already has its own `warn` line in
 * `run.guard_tripped` naming the code and the reason, so levelling this one up
 * would page a person for a press they had just made. Typed `RunStatus` at the
 * literal so a renamed member is a compile error here rather than a condition
 * that quietly stops being routed.
 */
const WARN_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
  "needs-review",
  "blocked",
  "failed",
]);

/**
 * A second sink, after the publish and never before it.
 *
 * Persist-then-publish is what makes an SSE reconnect lossless, so this is an
 * addition at the end rather than a reordering. What it adds is a machine-
 * readable line for the handful of events that describe a run's *life* — it
 * started a cycle, a guard refused it, it finished, it broke — because at
 * twenty-five unattended runs the run page is not where anyone finds that out.
 *
 * It **projects** rather than serialising the payload, and that is the whole of
 * why it is a function and not `JSON.stringify(e)`: `iteration` carries the
 * entire prompt, the creation `status` carries the folder, and `assistant`
 * carries the model's own output. Container stdout is a different audience with
 * a different lifetime from `run_events`, and every one of those would be on it.
 *
 * The kinds left out are the noisy ones — `log`, `assistant`, `subagent`,
 * `tool` — which at this scale would be a stream nobody can read, defeating the
 * point. `run_events` still has all of them.
 *
 * Exported for `orchestrator.test.ts` and for nothing else, `tickSchedules`'
 * reason: what a line carries and what level it arrives at are two decisions
 * no pure function beside this one can be asked about, and both are silent.
 */
export function logLifecycle(e: PersistedRunEvent): void {
  const p = e.payload;
  const num = (k: string): number | null =>
    typeof p[k] === "number" ? (p[k] as number) : null;
  const str = (k: string): string | null =>
    typeof p[k] === "string" ? (p[k] as string).slice(0, 300) : null;
  // Same shape as the two above, and `null` means there what it means there:
  // the field is absent, which is not `false`. The `error` case below needs
  // all three — a refusal being retried, one that is not, and an event that is
  // not about a refusal at all and carries neither field.
  const bool = (k: string): boolean | null =>
    typeof p[k] === "boolean" ? (p[k] as boolean) : null;

  switch (e.kind) {
    case "status": {
      // Level is a *routing* decision — the field a shipper filters on to
      // decide whether a person is woken — and one `info` line for all nine
      // statuses makes an ending that asks for somebody indistinguishable
      // from an ordinary completion. Field set and event name unchanged.
      const status = str("status");
      const level = status !== null && WARN_STATUSES.has(status) ? "warn" : "info";
      opsLog(level, "run.status", { run_id: e.runId, status });
      return;
    }
    case "iteration":
      opsLog("info", "run.cycle_started", { run_id: e.runId, cycle: num("n") });
      return;
    case "budget":
      if (p.allowed === true) return; // an allowed guard is the ordinary case
      opsLog("warn", "run.guard_tripped", {
        run_id: e.runId,
        code: str("code"),
        disposition: str("disposition"),
        reason: str("reason"),
      });
      return;
    case "result":
      opsLog("info", "run.cycle_finished", {
        run_id: e.runId,
        subtype: str("subtype"),
        cost_usd: num("costUSD"),
        duration_ms: num("durationMs"),
      });
      return;
    case "error":
      // The 429 ladder is the most expensive wait in the app — roughly 17-26
      // minutes holding the folder, the worktree slot and one of
      // `maxConcurrentRuns` — and it changes no status, so the run reads
      // `running` everywhere state is read and every rung arrives here at the
      // same level as a run that has actually died. These two are what tell
      // the two apart. Two *named* booleans and not a spread of the payload,
      // for the docblock's reason: `apiError`, `exitCode` and `waiting` sit
      // beside them and a spread is how the next field added to an emit site
      // reaches stdout without anybody deciding it should.
      opsLog("error", "run.error", {
        run_id: e.runId,
        message: str("message"),
        retrying: bool("retrying"),
        usage_limit: bool("usageLimit"),
      });
      return;
    case "sandbox":
      // The one tool failure that reaches stdout, and it is here for the
      // reason a tripped guard is: a policy that refuses the work fails inside
      // tool calls, and at twenty-five unattended runs the run page is not
      // where anyone finds that out. Ordinary `tool_error` rows stay off, which
      // is what keeps this line worth reading.
      opsLog("warn", "run.sandbox_refusal", {
        run_id: e.runId,
        sandbox: str("kind"),
        tool: str("name"),
        matched: str("matched"),
        reason: str("reason"),
      });
      return;
    default:
      return;
  }
}

function log(runId: string, message: string, extra: Record<string, unknown> = {}) {
  // Bounded before it is stored, never after: this is where an agent's whole
  // build output arrives, one stderr chunk per row. `truncatedFrom` rides
  // alongside so the line can say it was cut — a shortened message that reads
  // as a short one is the failure the read-side `dropped` count already avoids.
  const cut = message.length > MAX_LOG_CHARS;
  emit({
    runId,
    ts: Date.now(),
    kind: "log",
    payload: {
      message: cut ? `${message.slice(0, MAX_LOG_CHARS)}…` : message,
      ...(cut ? { truncatedFrom: message.length } : {}),
      ...extra,
    },
  });
}

/**
 * Write to a run's log from outside the loop.
 *
 * Landing a branch and reviewing a diff are operator actions that happen after
 * a run is over, and both belong in that run's history rather than only in the
 * response to the request that triggered them. Persist-then-publish is what
 * makes the stream lossless for a page that reconnects, so it stays the one
 * write path.
 */
export function emitRunEvent(e: RunEvent): void {
  emit(e);
}

export function getRun(id: string): RunRow | null {
  return (db().prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow) ?? null;
}

export function listRuns(limit = 50): RunRow[] {
  return db()
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as RunRow[];
}

/**
 * Every status a run may be in, keyed rather than listed.
 *
 * A `Record<RunStatus, true>` because a member added to the union and forgotten
 * here is then a compile error. That is the trap `TERMINAL_STATUSES` records the
 * cost of, one constant over and with a milder ending: a status missing from the
 * set a route narrows against is a filter that refuses a state the app itself
 * writes, so the list it names looks empty rather than wrong.
 */
const RUN_STATUS_KEYS: Record<RunStatus, true> = {
  waiting: true,
  queued: true,
  running: true,
  paused: true,
  completed: true,
  "needs-review": true,
  stopped: true,
  failed: true,
  blocked: true,
};

const RUN_STATUSES = Object.keys(RUN_STATUS_KEYS) as readonly RunStatus[];

/**
 * Whether a value off a query string names a status.
 *
 * `includes` rather than `in`, which walks the prototype chain and would answer
 * yes to `constructor`.
 */
export function isRunStatus(value: unknown): value is RunStatus {
  return RUN_STATUSES.includes(value as RunStatus);
}

/** Rows a run-list request gets when it names no size, or names an unreadable one. */
const DEFAULT_RUN_PAGE = 100;
/**
 * Rows one request may take, whatever it asks for.
 *
 * A hundred clipped rows measured at 698,620 bytes before the prompt clip and
 * 175KB gzipped after it, and this is the response the runs page polls every
 * four seconds. Twice the default is room for a caller that wants a longer page
 * on purpose; a ceiling is what stops `?limit=100000` being one request that
 * serialises the whole table.
 */
const MAX_RUN_PAGE = 200;
/**
 * Characters of the operator's text a search matches on.
 *
 * `LIKE '%…%'` cannot use an index whatever the needle is, so the cost is one
 * scan either way — what this bounds is the per-row comparison, and a needle
 * longer than a couple of lines is a paste rather than a search.
 */
const MAX_RUN_QUERY = 200;

export interface RunListQuery {
  /** Rows to skip. Clamped into the list rather than refused. */
  offset?: number;
  /** Rows to take. Absent, zero, negative or unreadable is `DEFAULT_RUN_PAGE`. */
  limit?: number;
  /** One status, or null for every status. Narrowed by the caller. */
  status?: RunStatus | null;
  /** Free text, matched against the task, the folder and the id. */
  q?: string | null;
  /**
   * Settled runs that ended strictly before this instant, in ms.
   *
   * "Settled" is `TERMINAL_STATUSES` and is part of the filter rather than
   * something a caller adds on top: a `queued` run created three days ago has
   * no end instant at all, and `COALESCE(finished_at, started_at, created_at)`
   * would answer for it with the moment it was *made* — filing a run that has
   * not happened yet under what has.
   */
  settledBefore?: number | null;
}

/** A run-list request in the terms the query below is written in. */
export interface RunListFilters {
  offset: number;
  limit: number;
  status: RunStatus | null;
  /** A `LIKE` pattern with `\` as its escape, or null for no text filter. */
  like: string | null;
  settledBefore: number | null;
}

export interface RunListPage {
  rows: RunRow[];
  /** Runs matching the filter, counted over the table rather than the page. */
  total: number;
  /** Where this page starts, after the clamp below. */
  offset: number;
  /** The page size actually applied, after the cap above. */
  limit: number;
}

/**
 * The operator's text as a `LIKE` needle.
 *
 * The escape is the whole of why this is not an interpolation: `%` and `_` are
 * wildcards, so a search for `50%` or `a_b` typed into the box would silently
 * match rows that hold neither. Both are ordinary characters in a task prompt
 * and in a folder name.
 */
function likeNeedle(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * What a run-list request actually asks for.
 *
 * Pure, and separated from the query below for the reason
 * `selectBranchCandidates` is separated from the git work: the failure mode is
 * silent. Every value here arrives off a query string, so every one of them can
 * be missing, blank, a word or a negative number, and each wrong answer is a
 * list that looks like an answer — a one-row page for a typo'd `limit`, an
 * unescaped wildcard matching rows that hold no such text, an epoch of 0 read as
 * a real boundary and hiding every settled run there is.
 *
 * A limit that is missing, zero, negative or unreadable is the default page
 * rather than the smallest legal one, which is `selectBranchCandidates`'
 * reasoning verbatim: these arrive off a query string and a one-row page is a
 * far worse answer to a typo than the ordinary one.
 */
export function normalizeRunListQuery(query: RunListQuery = {}): RunListFilters {
  const askedLimit = Math.floor(Number(query.limit));
  const limit =
    Number.isFinite(askedLimit) && askedLimit > 0
      ? Math.min(MAX_RUN_PAGE, askedLimit)
      : DEFAULT_RUN_PAGE;

  const askedOffset = Math.floor(Number(query.offset));
  const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;

  const text = (query.q ?? "").trim().slice(0, MAX_RUN_QUERY);

  // A boundary at or before the epoch is nobody's boundary: it is what
  // `Number(null)`, `Number("")` and a blank parameter all come to, and read as
  // a real instant it would answer every history request with an empty page.
  const before = Math.floor(Number(query.settledBefore));

  return {
    offset,
    limit,
    status: query.status ?? null,
    like: text ? likeNeedle(text) : null,
    settledBefore: Number.isFinite(before) && before > 0 ? before : null,
  };
}

/**
 * Where a page starts, once the total is known.
 *
 * Clamped rather than refused, which is `selectBranchCandidates`' reasoning
 * again: an offset past the end is what pressing Next on a list that shrank
 * under you produces, and a short last page with an honest total is a better
 * answer than a 400 or an empty list that reads as "nothing matches".
 */
export function clampRunOffset(offset: number, total: number): number {
  return Math.min(Math.max(0, Math.floor(offset) || 0), Math.max(0, total - 1));
}

/**
 * One page of runs, newest first, with the count the page is a slice of.
 *
 * `total` is counted over every matching row rather than over the page, for the
 * reason `branchInventory` counts over every branch-bearing run: a count that is
 * itself truncated cannot say a run has fallen out of reach, and the hundred-row
 * ceiling this replaces was invisible for the first ninety-nine runs.
 *
 * `id DESC` behind `created_at DESC` is not decoration. `created_at` is a
 * millisecond stamp and a fleet admits several runs inside one, so without a
 * tiebreak two rows with the same stamp may order differently between two
 * requests — which on a paged list means one of them appears twice and the other
 * never appears at all.
 *
 * It also needs no index of its own, which was measured rather than assumed:
 * against 50,000 rows in groups of 25 sharing a millisecond, the plan is `SCAN
 * runs USING INDEX idx_runs_created` plus `USE TEMP B-TREE FOR LAST TERM OF
 * ORDER BY` — SQLite sorts only within each equal-`created_at` group — and the
 * unfiltered first page costs 0.23ms against 0.14ms without the tiebreak. A
 * dedicated `(created_at DESC, id DESC)` index removes the B-tree and brings it
 * to 0.15ms, which is not worth a migration. The two slower shapes are 7.8ms for
 * a status page at offset 20,000 and 4.1ms for a `LIKE` over `prompt`, and
 * neither is on the four-second poll: that one is the unfiltered first page.
 */
export function listRunsPage(query: RunListQuery = {}): RunListPage {
  const filters = normalizeRunListQuery(query);

  const where: string[] = [];
  const args: unknown[] = [];
  if (filters.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  if (filters.settledBefore !== null) {
    where.push(
      `status IN (${TERMINAL_STATUSES.map(() => "?").join(",")})` +
        " AND COALESCE(finished_at, started_at, created_at) < ?",
    );
    args.push(...TERMINAL_STATUSES, filters.settledBefore);
  }
  if (filters.like) {
    where.push(
      "(prompt LIKE ? ESCAPE '\\' OR folder LIKE ? ESCAPE '\\'" +
        " OR id LIKE ? ESCAPE '\\')",
    );
    args.push(filters.like, filters.like, filters.like);
  }
  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  const total = (
    db()
      .prepare(`SELECT COUNT(*) AS n FROM runs${clause}`)
      .get(...args) as { n: number }
  ).n;
  const offset = clampRunOffset(filters.offset, total);

  const rows = db()
    .prepare(
      `SELECT * FROM runs${clause}` +
        " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(...args, filters.limit, offset) as RunRow[];

  return { rows, total, offset, limit: filters.limit };
}

/**
 * Events for a run, oldest first.
 *
 * `limit` keeps the *newest* rows and reports how many were dropped. A run that
 * works for days across hundreds of cycles accumulates tens of thousands of
 * events, and both the detail route and the SSE replay would otherwise serialise
 * every one of them on every request. Callers that pass a limit must surface
 * `dropped` — a truncated log that does not say it is truncated is worse than a
 * slow one.
 */
export function runEvents(
  runId: string,
  afterId = 0,
  limit?: number,
): { events: PersistedRunEvent[]; dropped: number } {
  const total = limit
    ? (
        db()
          .prepare(
            "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND id > ?",
          )
          .get(runId, afterId) as { n: number }
      ).n
    : 0;

  // Newest N, then flipped back into chronological order — SQLite has no
  // "last N rows ascending" without the subquery, and the log reads forwards.
  const rows = (
    limit
      ? db()
          .prepare(
            "SELECT * FROM (SELECT id, run_id, ts, kind, payload FROM run_events" +
              " WHERE run_id = ? AND id > ? ORDER BY id DESC LIMIT ?) ORDER BY id",
          )
          .all(runId, afterId, limit)
      : db()
          .prepare(
            "SELECT id, run_id, ts, kind, payload FROM run_events WHERE run_id = ? AND id > ? ORDER BY id",
          )
          .all(runId, afterId)
  ) as Array<{
    id: number;
    run_id: string;
    ts: number;
    kind: RunEvent["kind"];
    payload: string;
  }>;

  return {
    events: rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      ts: r.ts,
      kind: r.kind,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    })),
    dropped: limit ? Math.max(0, total - rows.length) : 0,
  };
}

export function subscribe(
  runId: string,
  fn: (e: PersistedRunEvent) => void,
): () => void {
  bus.on(runId, fn);
  return () => void bus.off(runId, fn);
}

function setStatus(id: string, status: RunStatus, patch: Partial<RunRow> = {}) {
  const fields: string[] = ["status = ?"];
  const values: unknown[] = [status];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db().prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  emit({ runId: id, ts: Date.now(), kind: "status", payload: { status, ...patch } });
}

/* ------------------------------------------------------------------ */
/* Folder validation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Confine a run to one workspace mount.
 *
 * The folder arrives from an HTTP request and is handed to a process that can
 * write files and run shell commands, so it is resolved to canonical form and
 * checked for containment rather than string-prefixed. `..`, symlinks out of
 * the tree, and absolute escapes all fail this check.
 *
 * Containment is per mount, never against the union: a path being inside *some*
 * mount is checked explicitly by the caller below, and each check still runs
 * both phases against that mount's own root.
 */
function resolveInMount(
  mount: WorkspaceMount,
  input: string,
): { path: string } | { error: string } {
  let root: string;
  try {
    root = fs.realpathSync(mount.path);
  } catch {
    return { error: `Mount "${mount.label}" is not available at ${mount.path}.` };
  }

  const contained = (p: string) => {
    const rel = path.relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  // Check containment on the lexically resolved path first. Doing this before
  // touching the filesystem means an escape attempt reports "outside the
  // workspace" rather than whatever ENOENT the bogus path happens to produce.
  const candidate = path.resolve(root, input);
  if (!contained(candidate)) {
    return { error: `Folder is outside the "${mount.label}" mount: ${input}` };
  }

  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { error: `No such folder in the "${mount.label}" mount: ${input}` };
  }

  // Re-check after resolving symlinks: a symlink inside the root can still
  // point outside it, and only the resolved path reveals that.
  if (!contained(real)) {
    return {
      error: `Folder resolves outside the "${mount.label}" mount: ${input}`,
    };
  }

  if (!fs.statSync(real).isDirectory()) {
    return { error: `Not a directory: ${input}` };
  }
  return { path: real };
}

/**
 * Resolve a folder the UI selected, optionally scoped to a named mount.
 *
 * With a `mountId` the folder must live in that mount and nowhere else. Without
 * one — an absolute path, or a caller that predates mounts — the folder is
 * accepted if any single mount contains it; the per-mount check is unchanged,
 * so this widens *which* roots are legal, not what counts as contained.
 */
export function resolveWorkspaceFolder(
  input: string,
  mountId?: string | null,
): string {
  if (mountId) {
    const mount = mountById(mountId);
    if (!mount) throw new Error(`No such workspace mount: ${mountId}`);
    const res = resolveInMount(mount, input);
    if ("error" in res) throw new Error(res.error);
    return res.path;
  }

  let firstError = "";
  for (const mount of WORKSPACE_MOUNTS) {
    const res = resolveInMount(mount, input);
    if (!("error" in res)) return res.path;
    if (!firstError) firstError = res.error;
  }
  throw new Error(firstError || `No such folder in the workspace: ${input}`);
}

// Mount paths are compared against stored run folders, which were canonicalised
// at creation time — so the mount side has to be canonical too or a mount
// reached through a symlink never matches. Only successes are cached: a mount
// that is temporarily absent should resolve once it appears.
const realMountPaths = new Map<string, string>();

function realMountPath(mount: WorkspaceMount): string {
  const cached = realMountPaths.get(mount.id);
  if (cached !== undefined) return cached;
  try {
    const real = fs.realpathSync(mount.path);
    realMountPaths.set(mount.id, real);
    return real;
  } catch {
    return mount.path;
  }
}

/** Split a stored absolute run folder back into (mount, path within it). */
export function describeFolder(folder: string): {
  mountId: string | null;
  mountLabel: string | null;
  relPath: string;
} {
  for (const mount of WORKSPACE_MOUNTS) {
    const rel = path.relative(realMountPath(mount), folder);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return { mountId: mount.id, mountLabel: mount.label, relPath: rel };
    }
  }
  // A run from a mount that has since been removed or renamed.
  return { mountId: null, mountLabel: null, relPath: folder };
}

/* ------------------------------------------------------------------ */
/* Folder identity for collision detection                             */
/* ------------------------------------------------------------------ */

/**
 * Which folders count as "the same place" for the purpose of keeping two
 * agents apart.
 *
 * Comparing stored folder strings is wrong three ways, and all three are
 * reachable from the shipped configuration:
 *
 *  - The picker offers the mount root itself, so a run there and a run on any
 *    subfolder are the same working tree.
 *  - Two mounts can be the same host directory. `docker-compose.yml` defaults
 *    `UF_WORKSPACE_2..4` to `${UF_WORKSPACE}`, so `/workspace` and `/workspace3`
 *    routinely alias, and `realpathSync` does not collapse a bind mount.
 *  - macOS is case-insensitive by default, so `Repo` and `repo` are one folder.
 *
 * Resolving mount identity once, at first use, keeps the per-check cost at pure
 * string comparison — `/api/folders` annotates up to 400 folders per request and
 * cannot afford a `stat` per candidate. It also means a `stat` failure is
 * absorbed once, into a deterministic fallback, rather than being retried per
 * check where it would fail *open* and permit exactly the collision this
 * prevents.
 */
export interface ConflictKey {
  /** Identifies the physical tree: `dev:ino` when known, else the real path. */
  rootKey: string;
  /** Path segments from that tree's root down to the folder. */
  segs: string[];
}

interface MountKey {
  rootKey: string;
  prefix: string[];
}

function segmentsOf(rel: string): string[] {
  return rel.split(path.sep).filter((s) => s !== "" && s !== ".");
}

function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

let topology: Map<string, MountKey> | null = null;

function mountTopology(): Map<string, MountKey> {
  if (topology) return topology;

  const built = new Map<string, MountKey>();
  // Keyed by inode to the *whole* MountKey, not just the rootKey: a mount can
  // alias a nested mount, and dropping its prefix would make the two views of
  // one directory compare as different folders.
  const byInode = new Map<string, MountKey>();
  const roots: Array<{ real: string; rootKey: string; prefix: string[] }> = [];
  const aliases: string[][] = [];

  // Shallowest first, so a mount nested inside another is always resolved
  // after the mount it sits in and can inherit its identity.
  const ordered = [...WORKSPACE_MOUNTS].sort(
    (a, b) => realMountPath(a).length - realMountPath(b).length,
  );

  for (const mount of ordered) {
    const real = realMountPath(mount);

    let inode: string | null = null;
    try {
      const st = fs.statSync(real);
      inode = `${st.dev}:${st.ino}`;
    } catch {
      inode = null;
    }

    if (inode) {
      const shared = byInode.get(inode);
      if (shared) {
        built.set(mount.id, { rootKey: shared.rootKey, prefix: [...shared.prefix] });
        const group = aliases.find((g) => g[0] === shared.rootKey);
        if (group) group.push(mount.label);
        else aliases.push([shared.rootKey, mount.label]);
        continue;
      }
    }

    const parent = roots.find((r) => within(r.real, real));
    if (parent) {
      const prefix = [...parent.prefix, ...segmentsOf(path.relative(parent.real, real))];
      const key: MountKey = { rootKey: parent.rootKey, prefix };
      built.set(mount.id, key);
      if (inode) byInode.set(inode, key);
      roots.push({ real, rootKey: parent.rootKey, prefix });
      continue;
    }

    // A tree in its own right. Prefer the inode so aliasing mounts agree; the
    // path fallback is deterministic and cannot collide with another mount's.
    const rootKey = inode ?? `path:${real}`;
    const key: MountKey = { rootKey, prefix: [] };
    built.set(mount.id, key);
    if (inode) byInode.set(inode, key);
    roots.push({ real, rootKey, prefix: [] });
  }

  for (const group of aliases) {
    const labels = group.slice(1).join(", ");
    console.warn(
      `[usagefoundry] Workspace mounts point at the same directory (${labels}). ` +
        "Runs started through either will be treated as the same folder.",
    );
  }

  topology = built;
  return built;
}

/** Reduce an absolute run folder to (physical tree, path within it). */
export function conflictKey(folder: string): ConflictKey {
  const topo = mountTopology();
  for (const mount of WORKSPACE_MOUNTS) {
    const key = topo.get(mount.id);
    if (!key) continue;
    // Both forms of the root, because callers disagree: a stored run folder is
    // canonical, while the folder listing builds paths from the configured
    // mount path. When that path is a symlink the two differ, and matching only
    // the canonical one would silently mark every folder in the mount free.
    for (const root of new Set([realMountPath(mount), mount.path])) {
      if (!within(root, folder)) continue;
      return {
        rootKey: key.rootKey,
        segs: [...key.prefix, ...segmentsOf(path.relative(root, folder))],
      };
    }
  }
  // A run whose mount has since been removed. Keying on itself keeps it
  // conflicting with an identical path and with nothing else.
  return { rootKey: `path:${folder}`, segs: [] };
}

/**
 * True when one folder contains the other, or they are the same folder.
 *
 * Segments are compared exactly *and* case-folded, and either match counts as a
 * conflict. On a case-sensitive filesystem holding two folders that differ only
 * in case this over-blocks — which is the direction to be wrong in, and rarer
 * than the case-insensitive host it protects.
 */
export function overlaps(a: ConflictKey, b: ConflictKey): boolean {
  if (a.rootKey !== b.rootKey) return false;
  const [short, long] =
    a.segs.length <= b.segs.length ? [a.segs, b.segs] : [b.segs, a.segs];
  for (let i = 0; i < short.length; i++) {
    if (short[i] !== long[i] && short[i].toLowerCase() !== long[i].toLowerCase()) {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Provider refusals                                                   */
/* ------------------------------------------------------------------ */

/**
 * Whether a refusal is the 5-hour or weekly allowance running out.
 *
 * Text matching, because the CLI exposes no machine-readable marker for it:
 * `result.subtype` has no limit member (`success`, `error_during_execution`,
 * `error_max_turns`, `error_max_structured_output_retries`,
 * `error_max_budget_usd`), and the refusal arrives as an ordinary sentence in
 * a `<synthetic>` assistant turn.
 *
 * Both shapes are matched on purpose. `usage limit reached` is the wording in
 * the CLI's own error taxonomy; `You've hit your <label> limit` is what it
 * renders, where <label> comes from its own table. The label is matched
 * loosely rather than enumerated, because that table is per-window *and* per
 * model — "session limit", "weekly limit", "Opus limit" — so a model shipped
 * next year would fall out of any list written today, and falling out means
 * the wall stops being recognised.
 *
 * Money is the exception, and it is excluded by name. A spend cap or a credit
 * balance is not an allowance that refills on a schedule; waiting for one
 * holds a folder for hours to arrive at the same answer. Those must end the
 * run, which is the same reasoning that keeps the weekly window terminal.
 *
 * The widely-copied `Claude AI usage limit reached|<epoch>` form appears
 * nowhere in the shipped binary, so nothing here parses a reset instant out of
 * the message: the reset time comes from the window model, which the operator
 * can correct with `sessionResetOverrideAt`.
 *
 * Transient failures are excluded too. A 429 burst, an overloaded upstream and
 * a dropped connection all clear in seconds; waiting hours for one turns a
 * retryable blip into a stalled run.
 */
export function isUsageLimit(text: string): boolean {
  if (/\b(spend|credit|credits|balance)\b/i.test(text)) return false;
  return (
    /usage limit reached/i.test(text) ||
    /\b(?:hit|reached) your\s+(?:[\w-]+\s+){0,2}limit/i.test(text)
  );
}

/**
 * Whether a refusal is a transport or upstream failure that clears by itself.
 *
 * The third answer to a refusal, and the one this app used to be missing: a
 * cycle can die because the connection dropped mid-response or the upstream
 * was briefly overloaded, which says nothing about the run, the allowance or
 * the task. Filing that as `failed` ends a run for a fault that fixes itself,
 * and does it in the state where stopping costs most — a live session, a held
 * folder, an agent part-way through the work.
 *
 * The stream-truncation sentences are the CLI's own, read out of the shipped
 * binary rather than guessed. It renders `API Error: ` followed by one of
 * `Connection closed mid-response…`, `Server error mid-response…`, `Response
 * stalled mid-stream…`, or the two `…while thinking, before producing a
 * response. Try again.` variants — so they are matched on the fragments the
 * five share rather than as whole sentences, which is what keeps a reworded
 * sixth one from falling out of the set.
 *
 * The rest is the SDK's own error text arriving by the same route: a status
 * for each code Anthropic documents as retryable, the `error.type` names those
 * bodies carry, and the socket failures that never reach a status at all.
 *
 * Narrow in three deliberate ways. It never sees an allowance refusal, because
 * `isUsageLimit` is tested first and a wall is not a blip. It matches no 4xx
 * but 408 and 429 — a malformed request, a revoked key or an exhausted credit
 * balance fails identically however many times it is retried. And the status
 * match is anchored to the `API Error:` prefix, because a bare `429` or `500`
 * is ordinary text.
 */
export function isTransientApiError(text: string): boolean {
  if (!text) return false;
  return (
    /mid-response|mid-stream|before producing a response/i.test(text) ||
    /\bAPI Error:\s*(?:408|429|500|502|503|504|529)\b/i.test(text) ||
    /\b(?:overloaded_error|api_error|rate_limit_error|timeout_error)\b/i.test(
      text,
    ) ||
    /\bconnection error\b|\bunable to connect to api\b/i.test(text) ||
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)\b/.test(
      text,
    ) ||
    /socket hang up|fetch failed/i.test(text)
  );
}

/**
 * Whether a transient failure is the provider refusing this app's request rate.
 *
 * A **strict subset** of `isTransientApiError`, and deliberately nothing more:
 * both patterns here already match there, so this widens nothing about what is
 * retried at all. All it decides is which ladder and which sentence, and that
 * distinction is the whole of why it exists. A dropped connection is a blip
 * that clears in seconds whatever this app does; a 429 at twenty-five
 * concurrent runs against one account is the provider describing *this app's
 * own steady-state request rate*, so it persists for exactly as long as the
 * fleet keeps asking — and the three fast retries written for a dropped socket
 * then become three synchronised twenty-five-wide waves into the condition
 * that caused it, followed by the whole fleet `failed` inside ninety seconds.
 *
 * `isTransientApiError` is untouched: it is unit-tested against sentences read
 * out of the shipped binary, and the classification was never what was wrong.
 */
export function isRateLimited(text: string): boolean {
  if (!text) return false;
  return /\bAPI Error:\s*429\b/i.test(text) || /\brate_limit_error\b/i.test(text);
}

/** Which of the four things a refused work cycle actually was. */
export type RefusalKind =
  /** The subscription allowance is used up. It refills on its own. */
  | "allowance"
  /** The provider is refusing this app's request rate. Its own ladder. */
  | "rate-limit"
  /** A transport or upstream fault that clears by itself in seconds. */
  | "transient"
  /** Neither: the CLI refused the request for a reason of its own. */
  | "other";

/**
 * Name the refusal, once, so every decision below reads the same answer.
 *
 * The classifiers were called inline and in this order, with `retryable`
 * carrying a `!limited` of its own to keep them apart. Naming the answer is
 * what lets the decision beside it be pure and tested: the predicates are regex
 * matches over sentences read out of the shipped binary, and the thing that
 * goes wrong is not the matching but what is done with it.
 *
 * The order is load-bearing. A wall is tested first, because no backoff refills
 * an allowance and `isTransientApiError` would otherwise claim a 429 the
 * provider meant as a wall. A rate limit is tested before the general transient
 * case for the narrower reason that it *is* one — the wider predicate matches
 * every 429 too, so asking it first would file every rate limit under the
 * ladder written for a dropped socket.
 */
export function refusalKind(refusal: string): RefusalKind {
  if (isUsageLimit(refusal)) return "allowance";
  if (isRateLimited(refusal)) return "rate-limit";
  if (isTransientApiError(refusal)) return "transient";
  return "other";
}

/**
 * An allowance refusal that only ever reached stderr.
 *
 * Deliberately narrower than the `<synthetic>` path: stderr carries build
 * noise, deprecation warnings and whatever the agent's own tooling printed, so
 * only a line that classifies as an allowance refusal is promoted to one.
 * Anything else stays an ordinary log line and the exit code decides, exactly
 * as it does today. `isTransientApiError` is deliberately *not* consulted here:
 * an agent's own build output says "connection error" all the time, and a run
 * must not re-spawn because its test suite could not reach a registry.
 */
function refusalInStderr(tail: string): string | null {
  if (!tail) return null;
  return (
    tail
      .split("\n")
      .filter(Boolean)
      .reverse()
      .find((line) => isUsageLimit(line)) ?? null
  );
}

/**
 * How wide a wait is spread, as a fraction of the wait itself.
 *
 * One design for every wait in this file, because they all fail the same way.
 * Nothing here was randomised, and every input to the arithmetic is shared: the
 * ladders are module constants, and the boundary comes from a `currentSnapshot()`
 * whose file scan is *coalesced* across concurrent callers, so twenty-five runs
 * refused inside the same minute read one block boundary and compute one answer
 * between them. Reproduced by the budgets sweep at exactly that: one distinct
 * `resume_at` across twenty-five runs. They then wake together, spawn together
 * and — because the boundary is approximate in both directions — are refused
 * together, three times, at which point `MAX_PAUSES_PER_RUN` ends the fleet.
 *
 * Half the wait, so the band is wide enough to matter and the ladder still
 * climbs strictly: each rung's floor stays above the one below's ceiling, which
 * is what keeps "the second failure in a row waits longer" true of every pair
 * rather than only on average.
 */
const JITTER_FRACTION = 0.5;

/**
 * The most any one wait is lengthened by the spread.
 *
 * A parked run is holding a checkout and a folder, so the spread has to be paid
 * for out of somebody's throughput. A quarter of an hour is enough to put
 * twenty-five wakes about half a minute apart — the point being that the first
 * few discover the true boundary and the rest re-park with fresh information —
 * and small enough beside a five-hour window to be worth that.
 */
const MAX_JITTER_MS = 15 * 60_000;

/**
 * The narrowest useful spread on a wait the *sweeper* serves.
 *
 * A parked run does not wake at its `resume_at`; it wakes at the first sweep
 * after it, and `SWEEP_MS` is 60 seconds. So a band narrower than a tick is
 * invisible — every run in it is due in the same pass whatever the arithmetic
 * said. Three ticks is the floor, and it is a property of the sweeper rather
 * than of the jitter, which is why the caller passes it and the in-process
 * retry ladder does not.
 */
const REFUSAL_JITTER_FLOOR_MS = 3 * SWEEP_MS;

/**
 * How much to add to one wait so a fleet computing one answer does not act on
 * it as one.
 *
 * Uniform over `[0, width]` and **never negative**: jitter may only ever delay.
 * Both callers have a floor underneath them that exists for its own reason —
 * `MIN_REFUSAL_WAIT_MS` so nothing re-spawns straight back into a wall, and the
 * ladder's own rung so a retry is not a hot loop — and a spread that could
 * shorten a wait would quietly undo either.
 *
 * `random` is a parameter rather than a call to `Math.random` inside, so the
 * determinism the existing cases pin stays reachable: passed `() => 0` this
 * contributes nothing and every wait is exactly what it was before.
 */
export function jitterMs(
  wait: number,
  random: () => number,
  floorMs = 0,
): number {
  const width = Math.min(
    Math.max(wait * JITTER_FRACTION, floorMs),
    MAX_JITTER_MS,
  );
  if (width <= 0) return 0;
  return Math.round(random() * width);
}

/** How long a refused run waits when the boundary it can see has already passed. */
const REFUSAL_BACKOFF_MS = [20 * 60_000, 40 * 60_000, 60 * 60_000];
/** Never re-spawn into the same wall immediately, whatever the arithmetic says. */
const MIN_REFUSAL_WAIT_MS = 5 * 60_000;
/** Never hold a folder longer than one window plus slack on a refusal. */
const MAX_REFUSAL_WAIT_MS = 6 * 3_600_000;
/**
 * How many times one run may wait out a refusal.
 *
 * The guard path needs no such cap — wall clock is checked ahead of the window
 * and terminates the run — but a refusal is someone else's claim about someone
 * else's counter, and a misread one must not re-park forever.
 */
export const MAX_PAUSES_PER_RUN = 3;

/**
 * How long a run waits before re-spawning after a transient API failure.
 *
 * Seconds, not minutes: these are dropped connections and overload bursts, and
 * the whole point of separating them from an allowance refusal is that there
 * is no window to wait out. The ladder still climbs, because the second
 * failure in a row is evidence the first was not a one-off.
 *
 * Retried in place rather than parked. `resume_at` and `sweepPaused` exist to
 * wait out a five-hour window, and parking a run for a 20-second fault would
 * yield its folder to whatever is queued behind it — for a run whose session
 * is intact and whose next cycle is seconds away.
 */
const TRANSIENT_BACKOFF_MS = [5_000, 20_000, 60_000];

/**
 * How long a run waits before re-spawning after the provider refused its rate.
 *
 * Minutes, where the ladder above is seconds, and the difference is what the
 * two faults are. A dropped socket clears in seconds whatever this app does. A
 * 429 at twenty-five concurrent runs against one account *is* this app's own
 * request rate, so it lasts as long as the fleet keeps asking — and 5/20/60
 * seconds against it is three twenty-five-wide waves into the condition that
 * produced it, then the whole fleet `failed` inside ninety seconds with every
 * dependent chain `blocked` behind it.
 *
 * The wait is the back-pressure, and it is the only lever this path has: a run
 * that is sleeping is a run that is not asking. Ordinary jitter spreads the
 * waves on top of it, so twenty-five runs stop arriving as one.
 *
 * ~17 minutes of tolerance at the floor of the spread and ~26 at its ceiling.
 * That bounds the tolerance; it does not promise the fleet survives, and the
 * stop reason at the end says so and names the lever that actually fixes it —
 * `maxConcurrentRuns`, which is the N this whole failure is proportional to.
 * The run's own wall clock still bounds the ladder from the other side: a retry
 * re-enters the loop at the top, so `evaluateBudget` reads `maxDurationMinutes`
 * before every one of these re-spawns.
 */
const RATE_LIMIT_BACKOFF_MS = [30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];

/** Which ladder a retryable refusal climbs. */
const RETRY_LADDERS: Record<"transient" | "rate-limit", readonly number[]> = {
  transient: TRANSIENT_BACKOFF_MS,
  "rate-limit": RATE_LIMIT_BACKOFF_MS,
};

/**
 * How many transient failures **in a row** one run may retry.
 *
 * Counted consecutively and reset by any cycle that gets through, so a long
 * run that meets one blip an hour is never terminated by the total, while an
 * upstream that is actually down ends the run inside ~85 seconds and says so.
 * Held in `startRun`'s own frame rather than on the row, like `resumeRetried`
 * and unlike `pause_count`: a restart hours later is not "in a row".
 */
export const MAX_TRANSIENT_RETRIES = TRANSIENT_BACKOFF_MS.length;

/** The same count for a rate limit, whose ladder is its own. */
export const MAX_RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length;

/** How many retries in a row a refusal of this kind is allowed. */
export function maxRetriesFor(kind: "transient" | "rate-limit"): number {
  return RETRY_LADDERS[kind].length;
}

/**
 * How long to wait before re-spawning, for one attempt of one kind.
 *
 * A pure function of the attempt index and a randomness source, which is the
 * whole point: it was `TRANSIENT_BACKOFF_MS[transientRetries]`, a constant
 * lookup, so twenty-five runs meeting one failure at one instant retried at
 * exactly t+5s, t+25s and t+85s together — each wave twenty-five simultaneous
 * spawns, which is the condition a rate limit is describing.
 *
 * Jitter is the shared `jitterMs`, so this and `refusalResumeAt` spread the
 * same way for the same reason: additive only, and half the rung wide. Half is
 * what keeps the ladder *strictly* climbing — every rung's floor stays above
 * the one below it at the top of its band, so "the second failure in a row
 * waits longer" is true of every pair rather than true on average. No floor is
 * passed: this wait is slept in-process rather than served by the 60-second
 * sweeper, so any spread at all is real.
 */
export function transientBackoffMs(o: {
  attempt: number;
  kind: "transient" | "rate-limit";
  random?: () => number;
}): number {
  const ladder = RETRY_LADDERS[o.kind];
  const base = ladder[Math.min(Math.max(o.attempt, 0), ladder.length - 1)];
  return base + jitterMs(base, o.random ?? Math.random);
}

/** Why a refused run is being ended rather than retried or parked. */
export type RefusalCause =
  /** A wall, met as often as one run may wait one out. */
  | "pauses-spent"
  /** Transport faults in a row, with the ladder spent. */
  | "retries-spent"
  /** The provider refusing this app's request rate, with its ladder spent. */
  | "rate-limited"
  /** Not a wall and not a blip — nothing here would clear. */
  | "other";

/** What the loop does about a work cycle the provider refused. */
export type RefusalPlan =
  /** Sleep the ladder's entry for `attempt` and re-spawn into the same session. */
  | { action: "retry"; attempt: number; kind: "transient" | "rate-limit" }
  /** Park and wait the window out. */
  | { action: "park" }
  /** End the run, and say which of the four endings it was. */
  | { action: "fail"; cause: RefusalCause };

/**
 * What to do about a refused work cycle.
 *
 * Extracted from `startRun` and pure for `releasableRuns`' reason: every way of
 * being wrong here is silent and expensive in one direction or the other — a
 * blip that ends a run holding a live session, or a wall re-spawned into three
 * more times, or a fleet ended for a condition that refills on its own.
 *
 * **There is no `enforcement` argument, and its absence is the fix.** The gate
 * used to be `limited && policy.enforcement === "live-resume"`, so on the
 * default `between-cycles` — which is what the run form starts from, what
 * `DEFAULT_CHAT_GUARDS` carries, and therefore what every untemplated chat
 * proposal, orchestrator-block emission and workflow node runs under — a wall
 * ended the run. That coupled two unrelated facts: `enforcement` is the
 * operator's answer to *when guards are read*, where the 5-hour window
 * refilling on its own is a fact about the provider, and the one quantity this
 * app already reasons about as waitable. Twenty-five runs sharing one account
 * meet that wall as a matter of course, so the ordinary outcome was a fleet
 * written `failed`, terminally, needing a run page opened per run. Nothing on
 * the enforcement control said so, because the control is not about this.
 *
 * What still bounds it is unchanged. `MAX_PAUSES_PER_RUN` caps how often one
 * run may wait — a refusal is someone else's claim about someone else's
 * counter, and a misread one must not park for ever — and the run's wall clock
 * is still a terminus it cannot wait out, checked ahead of the window by
 * `evaluateBudget` at the pre-cycle guard and again by `sweepPaused`, which
 * ends a parked run on a verdict that can never clear rather than leaving it
 * holding a folder.
 */
export function refusalDisposition(o: {
  kind: RefusalKind;
  pauseCount: number;
  transientRetries: number;
}): RefusalPlan {
  if (o.kind === "allowance") {
    return o.pauseCount < MAX_PAUSES_PER_RUN
      ? { action: "park" }
      : { action: "fail", cause: "pauses-spent" };
  }
  if (o.kind === "transient" || o.kind === "rate-limit") {
    return o.transientRetries < maxRetriesFor(o.kind)
      ? { action: "retry", attempt: o.transientRetries, kind: o.kind }
      : {
          action: "fail",
          // Two endings, not one. "The upstream is down" and "we were rate
          // limited and gave up" call for opposite responses — wait, versus
          // reduce how many runs share this account — and a single sentence
          // about "a transient API error" tells the operator neither.
          cause: o.kind === "rate-limit" ? "rate-limited" : "retries-spent",
        };
  }
  return { action: "fail", cause: "other" };
}

/**
 * What a run's row says when a refusal ended it for good.
 *
 * A `switch` rather than the conditional chain this was, because the four
 * sentences are four different instructions to the operator and the chain's
 * final arm was also its fallback: a fifth `RefusalCause` added upstream would
 * have silently rendered as "refused the request", losing the one line telling
 * a person what to do about it. The `never` arm makes that a build failure.
 */
export function refusalStopReason(cause: RefusalCause, refusal: string): string {
  switch (cause) {
    // Named as attempts rather than as the wall, because those are different
    // facts and the operator's next move differs. The allowance may well have
    // refilled by now; what has run out is how often one run may wait for it
    // without anybody looking.
    case "pauses-spent":
      return `Claude refused the work cycle for want of allowance again, after this run had already waited out ${MAX_PAUSES_PER_RUN} windows. Out of waits rather than out of allowance: ${refusal}`;
    // Reached only with the retries spent, so say that rather than reporting
    // the last attempt as if it were the only one.
    case "retries-spent":
      return `Claude Code hit a transient API error on ${MAX_TRANSIENT_RETRIES + 1} attempts in a row: ${refusal}`;
    // A different sentence from the one above, because the operator's response
    // is the opposite. An upstream that is down clears on its own and waiting
    // is right; a rate limit at this concurrency is the account describing how
    // much of it this app is using, and waiting changes nothing that lowering
    // the cap would not change faster.
    case "rate-limited":
      return `Claude Code was rate limited on ${MAX_RATE_LIMIT_RETRIES + 1} attempts in a row, over ${Math.round(
        RATE_LIMIT_BACKOFF_MS.reduce((a, b) => a + b, 0) / 60_000,
      )} minutes or more of backing off. This is the account refusing this app's own request rate rather than being unreachable, so lower the concurrent-run limit rather than waiting: ${refusal}`;
    case "other":
      return `Claude Code refused the request: ${refusal}`;
  }
  const unreachable: never = cause;
  throw new Error(`Unhandled refusal cause: ${String(unreachable)}`);
}

/**
 * Sleep, unless the run is interrupted first.
 *
 * The loop's `cancelled` checkpoints only run between cycles, so sleeping
 * straight through a backoff would leave `stopRun` unacknowledged for its whole
 * length — the operator presses stop and watches the row sit `running`. Polled
 * rather than event-driven because `interruptRun` is the single kill path, and
 * a second notification channel into it is a second thing to keep in sync.
 */
async function waitUnlessInterrupted(id: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (interrupts.has(id)) return;
    const slice = Math.min(500, until - Date.now());
    await new Promise<void>((resolve) => {
      setTimeout(resolve, slice).unref?.();
    });
  }
}

/**
 * When a run refused for want of allowance should try again.
 *
 * `boundary` is the end of the window the refusal belongs to, as far as this
 * app can tell, or null when it cannot tell. Two things make it unreliable,
 * and both are why this is a backoff rather than a single computed instant:
 *
 * A derived boundary is approximate in both directions. It runs late by the
 * opening turn's latency, because a block is anchored on the response we can
 * see rather than the request that actually opened the window; and it runs
 * early whenever the window was really opened by work this app cannot see at
 * all — claude.ai, Desktop and Cowork spend the same allowance and write no
 * local transcript. Only an operator-supplied `sessionResetOverrideAt` is
 * exact.
 *
 * And once that early boundary passes, the derived one becomes actively
 * misleading: a refusal writes a zero-token `<synthetic>` record into the
 * transcript, which opens a *fresh* block, so `session.endsAt` jumps five
 * hours into the future for a window that reopens in minutes. Hence the
 * caller's boundary is drawn from the last block with real spend in it, and a
 * boundary in the past falls through to the backoff instead of being trusted.
 *
 * All of which is a statement about *one* run, and every input to it is shared
 * by the fleet — so the answer is spread before it is returned. See
 * `jitterMs`: the reasoning behind `RESUME_MARGIN_MS`, that waking exactly at a
 * boundary is risky, is the same reasoning at a fleet's scale. The spread lands
 * *after* the floor and the cap, so `MIN_REFUSAL_WAIT_MS` still holds and no
 * run waits past `MAX_REFUSAL_WAIT_MS`; the band collapses only at that cap,
 * which a real 5-hour boundary cannot reach (`lastSpendingWindowEnd` is at most
 * five hours out, and the longest rung of the ladder is one).
 */
export function refusalResumeAt(o: {
  boundary: number | null;
  pauseCount: number;
  now: number;
  /** Injected so the determinism the cases beside this one pin stays reachable. */
  random?: () => number;
}): number {
  const backoff =
    REFUSAL_BACKOFF_MS[Math.min(o.pauseCount, REFUSAL_BACKOFF_MS.length - 1)];
  const target =
    o.boundary !== null && o.boundary > o.now
      ? o.boundary + RESUME_MARGIN_MS
      : o.now + backoff;
  const settled = Math.min(
    Math.max(target, o.now + MIN_REFUSAL_WAIT_MS),
    o.now + MAX_REFUSAL_WAIT_MS,
  );
  const spread = jitterMs(
    settled - o.now,
    o.random ?? Math.random,
    REFUSAL_JITTER_FLOOR_MS,
  );
  return Math.min(settled + spread, o.now + MAX_REFUSAL_WAIT_MS);
}

/**
 * End of the newest window that actually holds spend, or null if none does.
 *
 * `snapshot.session.endsAt` is the wrong input for a refusal: the refusal's own
 * zero-token record opens a block of its own, and an empty block's boundary
 * describes nothing. Blocks arrive newest first.
 */
export function lastSpendingWindowEnd(snapshot: UsageSnapshot): number | null {
  return snapshot.blocks.find((b) => b.agg.costGuardUSD > 0)?.endsAt ?? null;
}

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */

export interface IsolationPlan {
  mode: "worktree" | "none";
  /** Why isolation was not used. Surfaced so a silent downgrade is impossible. */
  reason?: string;
  repoRoot?: string;
  base?: string;
  /** Branch the base commit was taken from — where this work lands. */
  baseBranch?: string;
  worktreePath?: string;
  branch?: string;
}

/**
 * The predecessor's side of a continued branch, as the decision below reads it.
 *
 * A projection of `RunRow` rather than the row itself, so the resolution stays
 * a function of six recorded facts and can be tested without a database.
 */
export interface ContinuedBranch {
  runId: string;
  isolation: RunRow["isolation"];
  repoRoot: string | null;
  branch: string | null;
  /** The chain's original base commit, not this predecessor's tip. */
  base: string | null;
  baseBranch: string | null;
  /** The checkout it worked in, which this run reuses when it is free. */
  worktreePath: string | null;
}

/**
 * Where a run works, on what branch, and measured from where.
 *
 * Three modes, and the third is why this is pure and separated from every
 * syscall around it. `isolate: false` works in the operator's folder;
 * `continueFrom: null` cuts a fresh branch from the folder's HEAD; and a
 * continuation adopts the predecessor's branch *and its base*, which is the
 * whole point — `worktree_base` is what `diff.ts`, `review.ts`, `emitHandoff`
 * and the merge itself measure from, so taking the predecessor's tip instead
 * would show and land only the last link and leave the earlier agents' commits
 * invisible in every one of them.
 *
 * A continuation that cannot be honoured **throws**, and so does an ordinary
 * isolated run on a repository whose checkout slots have run out. What still
 * degrades to `mode: "none"` with a reason is isolation being *unavailable* —
 * not a git repository, a bare one, submodules, isolation switched off — where
 * working in the folder is still the work the operator asked for. Running out
 * of slots is not one of those: isolation is available and used up, and putting
 * the run in the folder instead means an agent editing the operator's own
 * checkout on whatever branch it is standing on, which is the failure isolation
 * exists to prevent rather than a lesser form of it. So both are a sentence and
 * a refusal, never a downgrade.
 */
export function resolveIsolation(o: {
  runId: string;
  isolate: boolean;
  /** `probeIsolation`'s answer for the folder. Ignored when not isolating. */
  probe: IsolationPlan;
  continueFrom: ContinuedBranch | null;
  /**
   * The predecessor's own checkout, when no active run holds it. Null means it
   * has been taken over, and a fresh slot is used instead — see the note on
   * slot choice in `planWorkspace`.
   */
  inheritedSlot: string | null;
  /** The next free checkout slot for this repository, or null when none is. */
  freeSlot: string | null;
  /**
   * What the allocator saw when `freeSlot` is null, for the refusal to name.
   *
   * Required rather than optional so a caller cannot drop it by omission and
   * silently turn a sentence that says which of the three causes took the slots
   * into one that says nothing. Null is legitimate and means no allocation was
   * attempted — a continuation working in the checkout it inherited, or a
   * folder that cannot be isolated at all.
   */
  slotCensus: SlotCensus | null;
}): IsolationPlan {
  const cont = o.continueFrom;

  if (!o.isolate) {
    if (cont) {
      throw new Error(
        `This run is set to continue run ${shortId(cont.runId)}'s branch, which it cannot do ` +
          "without a checkout of its own. Turn isolation back on, or drop the dependency's branch hand-over.",
      );
    }
    return { mode: "none", reason: "Isolation was turned off for this run." };
  }

  if (!cont) {
    if (o.probe.mode !== "worktree" || !o.probe.repoRoot) return o.probe;
    if (!o.freeSlot) {
      // The one downgrade that was never an answer. Every other `mode: "none"`
      // here is isolation being *unavailable* — not a repository, a bare repo,
      // submodules — where working in the folder is still the work the operator
      // asked for. This one is isolation being available and used up, and
      // absorbing it puts an agent in the operator's own checkout on whatever
      // branch it is standing on, unable even to commit. Same reasoning as the
      // continuation refusal below, which has said so since it was written.
      throw new Error(slotExhaustionRefusal(o.probe.repoRoot, o.slotCensus));
    }
    return {
      ...o.probe,
      worktreePath: o.freeSlot,
      // Per run, not per slot: a slot is reused by later runs, and a reused
      // branch name would move the ref off the previous run's commits. It is
      // also what makes a branch unclaimable by anyone else — no other run can
      // ever mint this name, and a continuation only ever adopts one it was
      // explicitly pointed at.
      branch: `uf/${path.basename(o.freeSlot)}-${o.runId.slice(0, 8)}`,
    };
  }

  const name = `run ${shortId(cont.runId)}`;
  if (cont.isolation !== "worktree" || !cont.branch) {
    throw new Error(
      `Set to continue ${name}'s branch, but that run has no branch of its own — it worked directly in the folder.`,
    );
  }
  if (!cont.base || !cont.repoRoot) {
    throw new Error(
      `Set to continue ${name}'s branch (${cont.branch}), but that run never recorded where the branch started, ` +
        "so there is no range for a diff or a merge to measure from.",
    );
  }
  if (o.probe.mode !== "worktree" || !o.probe.repoRoot) {
    throw new Error(
      `Set to continue ${name}'s branch (${cont.branch}), but this folder cannot be given a checkout: ${
        o.probe.reason ?? "isolation is unavailable here."
      }`,
    );
  }
  if (o.probe.repoRoot !== cont.repoRoot) {
    throw new Error(
      `Set to continue ${name}'s branch (${cont.branch}), which is in ${cont.repoRoot}, but this run is on ` +
        `${o.probe.repoRoot}. A branch cannot be carried between repositories.`,
    );
  }

  const slot = o.inheritedSlot ?? o.freeSlot;
  if (!slot) {
    // Its own sentence rather than `slotExhaustionRefusal`, which is worded for
    // a run that merely asked for a checkout: this one names the predecessor,
    // because what is lost is that run's commits and not just the isolation.
    // Both refuse — this branch always did, and the ordinary one now does too.
    throw new Error(
      `Set to continue ${name}'s branch (${cont.branch}), but every isolated checkout for this ` +
        "repository still holds uncommitted work and there is nowhere to put this one. Commit or " +
        "delete what is left in the checkout store, then start this run again.",
    );
  }

  return {
    mode: "worktree",
    repoRoot: o.probe.repoRoot,
    // The predecessor's, not the probe's. `probeIsolation` reports the folder's
    // HEAD, which has moved on since the chain started — measuring from it
    // would drop every commit made before this link.
    base: cont.base,
    baseBranch: cont.baseBranch ?? undefined,
    worktreePath: slot,
    branch: cont.branch,
  };
}

/** Path-safe, readable name for a directory. Anything else becomes a dash. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

/**
 * The name one repository's checkouts are stored under, unique per repository.
 *
 * `slugify` alone is lossy, and the collision that follows is silent and
 * permanent: the path separator and the substitution character are both `-`, so
 * `acme/web` and `acme-web` reduce to one slug and `allocateSlotPath` hands both
 * repositories the same directory. Neither of its two escapes catches it — the
 * other repository's checkout is a clean tree, so it is never `dirty`, and once
 * its run is terminal it is not `taken` either — so every isolated run on the
 * second repository dies at `git worktree add` with `already exists`,
 * deterministically, on the lowest slot, for ever.
 *
 * So the readable part is kept for the operator and a digest of the exact
 * mount-relative path is appended to carry the identity. Escaping the
 * substitution character (`-` → `--`, `/` → `-`) was the alternative and it
 * does not actually work: a run of three dashes has two preimages (`a-/b` and
 * `a/-b` both encode to `a---b`), and `slugify` also lower-cases and collapses
 * runs, so `my  project` and `My project` would go on meeting. A digest is over
 * the string itself, so none of that reaches it, and no later edit to the
 * readable half can quietly reintroduce a collision.
 *
 * It is fixed-width and sits immediately before the caller's own `-<slot>` or
 * `-<suffix>`, which is what keeps the whole directory name unambiguous: the
 * trailing field is the slot, the field before it is the identity.
 */
export function worktreeSlug(relPath: string): string {
  // 48 bits, over the path as it stands on disk — case included, since a path
  // that differs only in case is the same directory on a case-insensitive
  // filesystem and so cannot be a second repository.
  const digest = createHash("sha256").update(relPath).digest("hex").slice(0, 12);
  return `${slugify(relPath)}-${digest}`;
}

/** `worktreeSlug` for a repository, however it is named inside its mount. */
export function repoSlug(repoRoot: string): string {
  return worktreeSlug(describeFolder(repoRoot).relPath || path.basename(repoRoot));
}

/**
 * A `[submodule "…"]` section in git's config format.
 *
 * Its own function, pure and tested, because both ways of being wrong are
 * silent: too lax and a superproject gets the second checkout git says it must
 * not have; too greedy and a repository loses isolation for good, which is what
 * an existence check did here for five days — an unattended run's `git add -A`
 * committed an empty `.gitmodules` along with ten other stray dotfiles, and
 * every run on this repository afterwards worked in the operator's own checkout
 * on whatever branch it was standing on. Nothing threw: a folder run is a
 * legitimate degrade, so the only symptom was a scheduling note.
 *
 * Section names are case-insensitive in that format, and a header may be
 * indented. Read rather than asked of `git config -f`, which would put a fifth
 * subprocess inside `createRun`'s no-`await` window — see `slotProbes.test.ts`.
 */
export function declaresSubmodule(gitmodules: string): boolean {
  return /^[ \t]*\[[ \t]*submodule\b/im.test(gitmodules);
}

/**
 * Whether `repoRoot` is a superproject, by what its `.gitmodules` declares.
 *
 * A file that exists and cannot be read counts as one: that is the case git's
 * multiple-checkout warning is actually about, and refusing isolation is the
 * half of the answer that is only ever slower.
 */
function usesSubmodules(repoRoot: string): boolean {
  try {
    return declaresSubmodule(fs.readFileSync(path.join(repoRoot, ".gitmodules"), "utf8"));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Decide whether a run can be given its own checkout.
 *
 * Every gate here exists because failing it would put a checkout somewhere it
 * does not belong, or hand the agent a tree git cannot maintain. A failure is
 * never fatal — the run falls back to working directly in the folder, which the
 * folder claim then serialises — but the reason is always recorded, because
 * silently running in the live tree when the operator asked for isolation is
 * the one outcome that would surprise in the dangerous direction.
 */
export function probeIsolation(folder: string): IsolationPlan {
  const top = gitSync(folder, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout) {
    // git's own words when it has any, because "not a git repository" is a
    // conclusion this call cannot actually reach. A checkout made on the host
    // records an absolute host gitdir that does not exist under the mount, and
    // git reports exactly that — while the directory is plainly a repository
    // to the operator looking at it.
    const detail = top.stderr.split("\n")[0]?.replace(/^fatal:\s*/, "") ?? "";
    return {
      mode: "none",
      reason: detail
        ? `git cannot use this folder (${detail}) — runs here are serialised.`
        : "Not a git repository — runs here are serialised.",
    };
  }

  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(top.stdout);
  } catch {
    return { mode: "none", reason: "Repository root could not be resolved." };
  }

  // Anything but an exact match means the operator picked a subdirectory (or a
  // path inside someone else's repo). Branching the whole enclosing repository
  // for it would check out far more than was asked for — a $HOME that happens
  // to be a dotfiles repo is the case that makes this non-theoretical.
  if (repoRoot !== folder) {
    return {
      mode: "none",
      reason: `Folder is inside the repository at ${repoRoot}, not its root.`,
    };
  }

  if (gitSync(folder, ["rev-parse", "--is-bare-repository"]).stdout === "true") {
    return { mode: "none", reason: "Bare repository — nothing to check out." };
  }

  // git's own documentation warns against multiple checkouts of a superproject.
  if (usesSubmodules(repoRoot)) {
    return { mode: "none", reason: "Repository uses submodules." };
  }

  const head = gitSync(folder, ["rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) {
    return { mode: "none", reason: "Repository has no commits yet." };
  }

  const { mountId } = describeFolder(folder);
  const mount = mountId ? mountById(mountId) : null;
  if (!mount) {
    return { mode: "none", reason: "Folder is not inside a configured workspace." };
  }
  const mountRoot = realMountPath(mount);

  // The worktree store lives beside the repo, inside the mount. If the repo is
  // the mount root there is no "beside" that is still contained.
  if (repoRoot === mountRoot) {
    return {
      mode: "none",
      reason: "Repository is the workspace root — no place to put a checkout inside it.",
    };
  }

  // Recorded alongside the commit, because the commit alone cannot say where
  // this work is supposed to end up. A detached HEAD answers the literal string
  // "HEAD", which names no branch — stored as null so the landing path refuses
  // rather than merging into something it guessed.
  const headBranch = gitSync(folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseBranch =
    headBranch.ok && headBranch.stdout && headBranch.stdout !== "HEAD"
      ? headBranch.stdout
      : undefined;

  return { mode: "worktree", repoRoot, base: head.stdout, baseBranch };
}

/**
 * The store's own directory name, as a value.
 *
 * One spelling, because the retention sweep and the size figure beside it both
 * name this directory from the mount rather than from a repository — and a
 * second copy of the literal is a directory this app would create and never
 * find again.
 */
export const WORKTREE_STORE_DIR = ".uf-worktrees";

/**
 * Where a repo's isolated checkouts live: a hidden sibling inside the mount.
 *
 * Read-only, unlike `prepareWorktreeStore`, which validates and creates — this
 * is for a caller that wants to look at the store rather than write into it.
 */
export function worktreeStore(repoRoot: string): string | null {
  const { mountId } = describeFolder(repoRoot);
  const mount = mountId ? mountById(mountId) : null;
  if (!mount) return null;
  // Dotfile-prefixed so `/api/folders` never offers a checkout as a run target,
  // and outside the repo so it cannot show up in `git status` or be swept into
  // a commit as a gitlink.
  return path.join(realMountPath(mount), WORKTREE_STORE_DIR);
}

/** Every mount's checkout store, deduplicated by the tree it really names. */
export function worktreeStores(): Array<{
  mountId: string;
  label: string;
  path: string;
}> {
  const seen = new Set<string>();
  const stores: Array<{ mountId: string; label: string; path: string }> = [];
  for (const mount of WORKSPACE_MOUNTS) {
    // Two mounts can be one host directory — compose defaults `UF_WORKSPACE_2..4`
    // to `${UF_WORKSPACE}` — and a figure that counted such a store twice would
    // report double the bytes an operator can actually reclaim.
    const store = path.join(realMountPath(mount), WORKTREE_STORE_DIR);
    if (seen.has(store)) continue;
    seen.add(store);
    stores.push({ mountId: mount.id, label: mount.label, path: store });
  }
  return stores;
}

/**
 * The checkout store, validated and created — the one place that is checked.
 *
 * Extracted so that every caller which is about to let git write a full
 * checkout somewhere gets the same three guarantees: the store is not a
 * symlink (a symlinked `.uf-worktrees` would put a checkout wherever it
 * points), it is a directory, and it still resolves inside the workspace mount.
 * Validating *before* git writes is the whole point — checking afterwards is
 * checking too late.
 */
export function prepareWorktreeStore(repoRoot: string): string {
  const store = worktreeStore(repoRoot);
  if (!store) throw new Error("Workspace mount for this repository is gone.");

  let storeStat: fs.Stats | null = null;
  try {
    storeStat = fs.lstatSync(store);
  } catch {
    storeStat = null;
  }
  if (storeStat?.isSymbolicLink()) {
    throw new Error(`Refusing to use ${store}: it is a symlink.`);
  }
  if (storeStat && !storeStat.isDirectory()) {
    throw new Error(`Refusing to use ${store}: it is not a directory.`);
  }
  if (!storeStat) {
    fs.mkdirSync(store, { recursive: true });
    // Created by the server, used by the child: under privilege separation this
    // process is root and everything it writes into a bind mount lands
    // root-owned, so a checkout store left alone would refuse the very
    // `worktree add` it exists for. Only on the creating pass — a store an
    // earlier release made already belongs to the right uid.
    chownForChild(store);
  }

  const realStore = fs.realpathSync(store);
  const { mountId } = describeFolder(repoRoot);
  const mount = mountId ? mountById(mountId) : null;
  if (!mount || !within(realMountPath(mount), realStore)) {
    throw new Error(`Refusing to use ${store}: it resolves outside the workspace.`);
  }
  return store;
}

/**
 * A path in the store for a checkout that is not a run's own slot.
 *
 * Named from the repository's path within its mount, exactly as
 * `allocateSlotPath` is, so two repositories with the same basename cannot
 * collide on one directory.
 */
export function auxWorktreePath(repoRoot: string, suffix: string): string {
  const store = prepareWorktreeStore(repoRoot);
  return path.join(store, `${repoSlug(repoRoot)}-${slugify(suffix)}`);
}

/**
 * The git directory a checkout is attached to, realpath'd.
 *
 * `--git-common-dir` rather than `--show-toplevel`, which inside a linked
 * checkout answers with the checkout itself and so can never say who owns it.
 * The answer is relative when git is run at the top of an ordinary repository,
 * so it is resolved here rather than asked for with `--path-format=absolute`,
 * which is git 2.31 and buys nothing this cannot do.
 */
function gitCommonDir(dir: string): string | null {
  const out = gitSync(dir, ["rev-parse", "--git-common-dir"]);
  if (!out.ok || !out.stdout) return null;
  try {
    return fs.realpathSync(path.resolve(dir, out.stdout));
  } catch {
    return null;
  }
}

/**
 * The repository a directory in the store belongs to, when it is not this one.
 *
 * `worktreeSlug` is what keeps two repositories out of one directory, so this
 * should now find nothing. It is here because the cost of being wrong is not a
 * bad merge but a run that fails at setup on every attempt, and because a
 * directory in the store can arrive from outside that guarantee: left by hand,
 * or by a build of this app that named slots the lossy way.
 *
 * Null for a path that is not a readable checkout — `slotIsDirty` already
 * refuses one of those, and answering "foreign" about an unreadable directory
 * would name an owner this cannot actually see.
 *
 * `ownGitDir` is the repository's own answer, for a caller in a loop: it is the
 * same value on every iteration and asking git for it again is another
 * subprocess on the admission path. `undefined` means "not supplied"; `null` is
 * a repository git could not read, which is a real answer and must not be
 * mistaken for one.
 */
function foreignSlotOwner(
  slotPath: string,
  repoRoot: string,
  ownGitDir?: string | null,
): string | null {
  if (!fs.existsSync(slotPath)) return null;
  const owner = gitCommonDir(slotPath);
  if (!owner) return null;
  const mine = ownGitDir === undefined ? gitCommonDir(repoRoot) : ownGitDir;
  if (!mine || owner === mine) return null;
  return path.basename(owner) === ".git" ? path.dirname(owner) : owner;
}

/**
 * `worktree add` failed — say whose directory it hit, when that is why.
 *
 * git's own words are `fatal: '<path>' already exists`, which names a path and
 * not the repository the path belongs to, and the operator reading it is
 * looking at a run that failed at setup for a reason nothing on the page
 * explains. Allocation skips such a directory now, so this is the sentence for
 * a slot that became somebody else's between the two.
 */
function checkoutFailure(repoRoot: string, slotPath: string, stderr: string): Error {
  const owner = foreignSlotOwner(slotPath, repoRoot);
  if (!owner) return new Error(`Could not create a checkout: ${stderr}`);
  const name = describeFolder(owner).relPath || owner;
  return new Error(
    `Could not create a checkout: ${stderr} — ${path.basename(slotPath)} is a checkout of ${name}, ` +
      "not of this repository. Remove it once that repository is done with it, then start this run again.",
  );
}

/** True when a checkout exists and has work in it that must not be clobbered. */
function slotIsDirty(slotPath: string): boolean {
  if (!fs.existsSync(slotPath)) return false;
  const st = gitSync(slotPath, ["status", "--porcelain"]);
  // Unreadable counts as dirty: refusing to reuse is the recoverable mistake.
  return !st.ok || st.stdout !== "";
}

/**
 * How many checkouts one admission may ask git about.
 *
 * `createRun` runs from entry to INSERT with no `await`, which is what makes its
 * folder claim atomic — and what makes every subprocess it spawns a hold on the
 * one event loop that also drains every agent's stdout, feeds every SSE stream
 * and beats the server lock's heartbeat. `git status --porcelain` walks the
 * working tree with `core.fsmonitor` cleared, so on a large checkout it is
 * hundreds of milliseconds rather than the single digits the rest of the
 * admission path costs.
 *
 * Nothing bounded that walk before: dirty slots are left behind deliberately
 * (see the loop below), they are never `taken`, and so every admission
 * re-examined every one of them, for ever — 64 slots at git's own 20-second
 * ceiling in the limit. The bound is now this constant and not the repository's
 * history: at most four checkouts inspected, each costing one `status` and, only
 * when that comes back clean, one `rev-parse --git-common-dir`, plus one more
 * for the repository's own git directory. Nine git subprocesses, on top of
 * `probeIsolation`'s four.
 */
export const MAX_SLOT_PROBES_PER_ADMISSION = 4;

/**
 * How long a "this slot is not usable" answer is believed.
 *
 * Only the negative verdicts are remembered, and that asymmetry is the whole
 * safety argument: acting on a stale *dirty* reading costs a slot number, where
 * acting on a stale *clean* one hands a run a checkout `ensureWorktree` then
 * refuses by name — a run that fails at setup rather than one that takes the
 * next number. So a slot is only ever returned after this admission has seen it
 * clean for itself.
 *
 * The window exists because a dirty slot can be cleaned by something this
 * process cannot see: the operator committing or deleting the leftovers by hand.
 * The two buttons that do it from inside this app say so directly
 * (`forgetSlotVerdict`), so what this covers is only the out-of-process case,
 * and five minutes of not reusing one checkout is cheaper than re-walking the
 * whole store on every admission.
 */
const SLOT_VERDICT_TTL_MS = 5 * 60_000;

/**
 * What earlier admissions learned about each checkout slot.
 *
 * `globalThis`-pinned for the reason every other long-lived map here is: a fresh
 * Map per module evaluation silently resets on every request in dev, which would
 * make the bound above the *only* thing keeping the walk cheap and so degrade
 * every admission on a repository with a few dirty slots.
 */
const globalSlots = globalThis as unknown as {
  __ufSlotVerdicts?: Map<string, { verdict: "dirty" | "foreign"; at: number }>;
};
const slotVerdicts: Map<string, { verdict: "dirty" | "foreign"; at: number }> =
  globalSlots.__ufSlotVerdicts ?? (globalSlots.__ufSlotVerdicts = new Map());

/** A remembered refusal, or null when there is none worth believing. */
function recentSlotVerdict(slotPath: string, now: number): "dirty" | "foreign" | null {
  const seen = slotVerdicts.get(slotPath);
  if (!seen) return null;
  if (now - seen.at > SLOT_VERDICT_TTL_MS) {
    slotVerdicts.delete(slotPath);
    return null;
  }
  return seen.verdict;
}

/**
 * Forget what was learned about a checkout this app has just changed.
 *
 * Called by the two controls that exist to make a slot reusable again —
 * committing what an agent left behind, and purging a branch and its checkout
 * together. Both would otherwise be undone by the memo above for up to
 * `SLOT_VERDICT_TTL_MS`, which is the one wait an operator who has just pressed
 * the button would read as the button not having worked.
 */
export function forgetSlotVerdict(slotPath: string | null | undefined): void {
  if (slotPath) slotVerdicts.delete(slotPath);
}

/**
 * Create or reuse this run's checkout and return the directory to work in.
 *
 * Reuse is what keeps isolation practical. A slot is reusable only when
 * `git status --porcelain` is clean, and that command ignores gitignored paths
 * — so `node_modules` and friends survive from the previous run while any
 * leftover source change blocks reuse instead of being silently destroyed.
 *
 * A run continuing another's branch never *creates* one: the branch is already
 * in the repository with the predecessor's commits on it, and every `-b` here
 * would either fail outright or, worse, move the name off those commits. So it
 * takes the third path at each of the three forks below — `checkout` rather
 * than `checkout -b`, `worktree add <path> <branch>` rather than `worktree add
 * -b`, and past the orphaned-branch guard rather than into it.
 */
async function ensureWorktree(run: RunRow): Promise<string> {
  const repoRoot = run.repo_root!;
  const slotPath = run.worktree_path!;
  const branch = run.worktree_branch!;
  const base = run.worktree_base ?? "HEAD";
  const continuing = run.continues_run !== null;

  // Validated before git writes into it — see `prepareWorktreeStore`.
  prepareWorktreeStore(repoRoot);

  // Drop registrations for checkouts that were deleted from disk, so a stale
  // entry does not make `worktree add` refuse a path that is actually free.
  await git(repoRoot, ["worktree", "prune"]);

  const registered = (await git(repoRoot, ["worktree", "list", "--porcelain"]))
    .stdout.split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));

  if (registered.includes(slotPath)) {
    const head = await git(slotPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    // The checkout already holds this branch. Adopt it exactly as it stands:
    // `checkout -b` would fail on an existing branch, the dirty check below
    // would reject work in progress that was legitimately left there, and
    // re-seeding would overwrite files that have since been edited.
    //
    // Two ways to arrive here now. Either this is the run's own checkout coming
    // back from a pause, or it is the predecessor's, handed over. `iterations`
    // and `pause_count` are what tell them apart — a continuing run that has
    // worked is resuming its own tree, whatever it started from.
    if (head.ok && head.stdout === branch) {
      const handover =
        continuing && run.iterations === 0 && (run.pause_count ?? 0) === 0;
      if (handover) {
        // Whatever the predecessor left uncommitted is in this tree, on this
        // chain's branch. `commitRefusal` already settled whose work that is:
        // it belongs to the run whose branch the slot has checked out, and here
        // that is this chain. So it is kept rather than refused — the
        // alternative strands a chain on a directory the operator has a button
        // for and no reason to look at — and the count is said out loud,
        // because inheriting someone else's half-finished edits silently is the
        // part that would be surprising. The agent is told too, by
        // `continuedWorkNotice`.
        const leftover = await git(slotPath, ["status", "--porcelain"]);
        const paths = leftover.ok
          ? leftover.stdout.split("\n").filter(Boolean).length
          : null;
        const from = `run ${shortId(run.continues_run!)}`;
        log(
          run.id,
          paths === null
            ? `Taking over ${from}'s checkout on branch ${branch}. Its status could not be read, so it may still hold uncommitted work.`
            : paths === 0
              ? `Taking over ${from}'s checkout on branch ${branch}, with nothing left uncommitted in it.`
              : `Taking over ${from}'s checkout on branch ${branch}, which still holds ${paths} uncommitted path(s) from that run. They are left exactly as they are, as work in progress this run inherits.`,
          { worktree: slotPath, branch, continuesRun: run.continues_run },
        );
        return slotPath;
      }
      log(run.id, `Resuming in the existing checkout on branch ${branch}.`, {
        worktree: slotPath,
        branch,
      });
      return slotPath;
    }
    const status = await git(slotPath, ["status", "--porcelain"]);
    if (!status.ok || status.stdout !== "") {
      throw new Error(
        `Checkout ${path.basename(slotPath)} still has uncommitted work. Commit or remove it first.`,
      );
    }
    if (continuing) {
      await requireBranch(repoRoot, run, branch);
      const co = await git(slotPath, ["checkout", branch]);
      if (!co.ok) {
        throw new Error(`Could not check out branch ${branch}: ${co.stderr}`);
      }
    } else {
      const co = await git(slotPath, ["checkout", "-b", branch, base]);
      if (!co.ok) throw new Error(`Could not start branch ${branch}: ${co.stderr}`);
    }
  } else if (continuing) {
    // Straight past the orphaned-branch guard below, and it loses nothing by
    // it: that guard exists because `worktree add -b` would create a *second*
    // branch at the base and leave the run's commits on a ref nothing points
    // at. Attaching to the branch that already exists cannot orphan anything —
    // the predecessor's commits and this run's own are the same ref, and that
    // ref is what is being checked out. The half of the guard that is a real
    // fact is kept: a branch that has been deleted is refused by name.
    await requireBranch(repoRoot, run, branch);
    const add = await git(repoRoot, ["worktree", "add", slotPath, branch], {
      timeoutMs: 30 * 60_000,
    });
    if (!add.ok) throw checkoutFailure(repoRoot, slotPath, add.stderr);
  } else if (run.iterations > 0 || (run.pause_count ?? 0) > 0) {
    // A resuming run whose checkout has been removed from under it. Creating a
    // fresh one would silently orphan every commit it already made, so name the
    // branch and stop — the work is still in the repository.
    //
    // `pause_count` and not `iterations` alone: a cycle the live guard cut
    // short is refunded to the counter below, so a run parked during its first
    // cycle is back at zero while its branch very much exists.
    //
    // Unless it does not: `purgeBranch` deletes the branch and the checkout
    // together, and a reopen after that would otherwise be sent to `git log` on
    // a ref that is gone. Both sentences refuse; only one of them is true at a
    // time, and being sure which is the whole reason to look.
    const onDisk = await git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    throw new Error(
      onDisk.ok
        ? `The isolated checkout for this run is gone, but its work is still on branch ${branch}. ` +
          `Inspect it with: git log ${branch}`
        : `Branch ${branch} and its checkout have both been deleted, so there is nothing for ` +
          "this run to carry on from. Start it again as a new run.",
    );
  } else {
    // No timeout worth enforcing: this is a full checkout, and a big repository
    // legitimately takes minutes.
    const add = await git(
      repoRoot,
      ["worktree", "add", "-b", branch, slotPath, base],
      { timeoutMs: 30 * 60_000 },
    );
    if (!add.ok) throw checkoutFailure(repoRoot, slotPath, add.stderr);
  }

  const settings = getSettings();
  const seeding = copyGlobsFor(
    repoRoot,
    settings.isolationCopyGlobs,
    settings.isolationCopyGlobsByRepo,
    WORKSPACE_MOUNTS,
  );
  const copied = seedWorktree(repoRoot, slotPath, seeding.globs);
  // Only asked when nothing was copied: it is a git spawn, and the question it
  // answers — "did this repository have something to seed?" — has no reader
  // once something was seeded.
  const unseeded = copied.length === 0 ? await unseededIgnoredFiles(repoRoot) : [];
  log(
    run.id,
    (continuing
      ? `Working in an isolated checkout, carrying on run ${shortId(run.continues_run!)}'s branch ${branch}`
      : `Working in an isolated checkout on branch ${branch}`) +
      seedReport(copied, unseeded, seeding.globs),
    {
      worktree: slotPath,
      branch,
      ...(seeding.key !== null ? { seedingKey: seeding.key } : {}),
      ...(continuing ? { continuesRun: run.continues_run } : {}),
    },
  );

  return slotPath;
}

/**
 * Refuse a continuation whose branch has gone, naming what is missing.
 *
 * `purgeBranch` destroys a branch and its checkout together, and a chain link
 * released afterwards would otherwise be handed a `worktree add` that quietly
 * created a fresh branch at the chain's base — a run that looks like it is
 * continuing the work and is in fact starting it over.
 */
async function requireBranch(
  repoRoot: string,
  run: RunRow,
  branch: string,
): Promise<void> {
  const onDisk = await git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (onDisk.ok) return;
  throw new Error(
    `Branch ${branch} is gone, so there is nothing of run ${shortId(run.continues_run!)}'s work left to carry on. ` +
      "Start this run again without the branch hand-over if it should begin from scratch.",
  );
}

/** One path segment of a pattern, as a regex; `*` and `?` never cross a `/`. */
function segmentMatcher(segment: string): RegExp {
  // `?` is a glob wildcard and has to be *translated*, not merely escaped:
  // left alone it reached the regex meaning "the previous token is optional",
  // so `.env?` matched `.env` and rejected `.envx` — the opposite of both.
  // Both wildcards are decided in the same pass that escapes everything else,
  // because a second sweep rewriting `\?` would also catch a literal
  // backslash standing in front of one.
  const source = segment.replace(/[.+^${}()|[\]\\?*]/g, (c) =>
    c === "*" ? "[^/]*" : c === "?" ? "[^/]" : `\\${c}`,
  );
  return new RegExp(`^${source}$`);
}

/**
 * A copy pattern split into segments, or `null` if it cannot be honoured.
 *
 * `..` and a leading `/` are refused rather than resolved: this walks the
 * operator's own checkout and copies into an agent's, and a pattern that climbs
 * out of the repository is either a typo or the one thing a seeding list must
 * not be able to express. Refusing costs the pattern; resolving it costs the
 * containment argument every other path in this file makes.
 */
function parseCopyGlob(raw: string): { negate: boolean; segments: string[] } | null {
  const negate = raw.startsWith("!");
  const pattern = negate ? raw.slice(1) : raw;
  if (!pattern || pattern.startsWith("/")) return null;

  const segments = pattern.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return { negate, segments };
}

/**
 * Match a repository-relative path against the settings glob list; later
 * patterns win.
 *
 * A pattern with no `/` still matches a top-level filename and nothing else —
 * segment counts must agree — so `.env` does not suddenly reach
 * `apps/web/.env`, which would silently widen every existing install's list.
 * Naming that file takes writing the path out.
 */
export function matchesCopyGlobs(relPath: string, globs: string[]): boolean {
  const parts = relPath.split("/");
  let hit = false;
  for (const raw of globs) {
    const parsed = parseCopyGlob(raw);
    if (!parsed || parsed.segments.length !== parts.length) continue;
    if (parsed.segments.every((s, i) => segmentMatcher(s).test(parts[i]))) {
      hit = !parsed.negate;
    }
  }
  return hit;
}

/**
 * A repository as this walk needs to see it: one directory's entries.
 *
 * An argument rather than a `readdirSync` inside `planSeedCopies`, for
 * `normalizeWorkflowInput`'s reason — the decision is which paths get copied,
 * every way of getting it wrong is a checkout that silently starts without its
 * configuration, and a decision that reads the disk cannot be pinned.
 */
export interface SeedDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * How many directories one seeding pass may open.
 *
 * The walk is driven by the patterns rather than by the tree — it descends only
 * where a pattern's own segments say to — so a list of literal paths costs one
 * `readdir` per directory named. A wildcard *directory* segment (`apps/=*=/.env`)
 * is what makes that unbounded in principle, and this is what bounds it in
 * practice: it runs before every isolated checkout, against a repository this
 * app did not write.
 */
const MAX_SEED_DIRS = 200;

/**
 * Which paths a glob list selects from a repository, relative to its root.
 *
 * Paths, not filenames. The walk used to be one `readdirSync` of the repository
 * root with `isFile()`, so `apps/web/.env` could not be named by any pattern at
 * all — the setting's name says globs and what it matched was a bare filename in
 * one directory. A monorepo's isolated checkout therefore started without its
 * configuration whatever the operator typed, and the only signal was the
 * *absence* of a clause in one log line.
 *
 * It descends only into directories some pattern's next segment matches, so the
 * default list still costs exactly one `readdir` and no repository is ever
 * walked whole. Symlinks are neither files nor directories to `readdir`'s own
 * lstat semantics, so they are skipped here as they were before — a link is a
 * way out of the tree, and this copies into a checkout an agent then owns.
 */
export function planSeedCopies(
  globs: string[],
  readDir: (relDir: string) => SeedDirEntry[],
): string[] {
  const parsed = globs.map(parseCopyGlob).filter((p) => p !== null);
  // A negated pattern excludes; it never justifies opening a directory.
  const descend = parsed.filter((p) => !p.negate);
  const copied: string[] = [];

  let opened = 0;
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { rel, depth } = queue.shift()!;
    if (opened >= MAX_SEED_DIRS) break;
    opened += 1;

    for (const entry of readDir(rel)) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isFile) {
        if (matchesCopyGlobs(relPath, globs)) copied.push(relPath);
        continue;
      }
      if (!entry.isDirectory) continue;
      const worthOpening = descend.some(
        (p) => p.segments.length > depth + 1 && segmentMatcher(p.segments[depth]).test(entry.name),
      );
      if (worthOpening) queue.push({ rel: relPath, depth: depth + 1 });
    }
  }

  // Sorted so the log line reads the same twice, whatever order the filesystem
  // handed the entries back in.
  return copied.sort();
}

/**
 * The seeding list for one repository: its own if the operator wrote one, the
 * install-wide list otherwise.
 *
 * One global list is correct for one repository and cannot be correct for
 * fifteen — a Next.js app's `.env.local`, an Azure Functions app's
 * `local.settings.json` and a Rails app's `config/master.key` have to be
 * described at once, and every repository then gets every pattern. A key here
 * *replaces* the global list rather than adding to it, which is what lets one
 * repository be told to copy nothing at all.
 *
 * A key is a folder, written either absolute as the container sees it
 * (`/workspace/acme/web`) or relative to any mount (`acme/web`), because both
 * are what the operator is looking at when they write it. The longest match
 * wins, so a key on a parent directory is a default for everything under it and
 * a key on the repository itself still overrides that.
 *
 * Mounts are an argument for `matchesCopyGlobs`' reason, and the key matching
 * itself is `matchFolderKey` in `config.ts` rather than a copy here: the GitHub
 * credential is configured per repository the same way, and two answers to
 * "does this key name this folder" would be two rules to keep in step.
 */
export function copyGlobsFor(
  repoRoot: string,
  globs: string[],
  byRepo: Record<string, string[]>,
  mounts: WorkspaceMount[],
): { globs: string[]; key: string | null } {
  const key = matchFolderKey(repoRoot, Object.keys(byRepo), mounts);
  return key !== null ? { globs: byRepo[key], key } : { globs, key: null };
}

/**
 * Copy the gitignored files an agent needs to run anything at all.
 *
 * Only files, and only where a pattern names them. A checkout carries committed
 * work, so the environment file that every command depends on is exactly what is
 * missing; dependency trees and build output are left for the agent to
 * regenerate.
 */
function seedWorktree(repoRoot: string, slotPath: string, globs: string[]): string[] {
  const copied: string[] = [];

  const planned = planSeedCopies(globs, (relDir) => {
    try {
      return fs
        .readdirSync(path.join(repoRoot, relDir), { withFileTypes: true })
        .map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  });

  for (const rel of planned) {
    const target = path.join(slotPath, rel);
    if (fs.existsSync(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, rel), target);
      // The copy is the server's, the checkout is the child's. An `.env` the
      // agent cannot rewrite is worse than one it never had, because it reads
      // as a configured worktree right up until the first write — so a chown
      // that fails takes the file with it rather than leaving one behind that
      // `copied` claims is there and usable.
      try {
        chownForChild(target);
      } catch (err) {
        fs.rmSync(target, { force: true });
        throw err;
      }
      copied.push(rel);
    } catch {
      /* a file we cannot read is not worth failing the run over */
    }
  }
  return copied;
}

/** How many unseeded gitignored paths the log line names before counting. */
const SEED_REPORT_NAMED = 3;

/**
 * Gitignored files the repository has and no pattern reached.
 *
 * Only ever asked when nothing was copied, and only to tell two things apart
 * that used to read identically: a repository that needs no seeding, and a
 * repository that needed it and got none. Both were the same log line with the
 * `(copied …)` clause missing, and the second one costs a billed cycle that
 * fails on a file the operator believes is there — or worse, an agent under
 * `acceptEdits` writing a placeholder config and committing it onto the branch.
 *
 * `--directory` is what keeps this cheap: a wholly-ignored tree comes back as
 * one entry ending in `/` rather than every file under it, so `node_modules` is
 * one line. Those are dropped — a directory is not something a pattern here
 * copies — and what is left is the ignored *files*, at whatever depth, which is
 * exactly the vocabulary a pattern can now name.
 */
async function unseededIgnoredFiles(repoRoot: string): Promise<string[]> {
  const listed = await git(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "--no-empty-directory",
  ]);
  if (!listed.ok) return [];
  return listed.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.endsWith("/"))
    .sort();
}

/**
 * The clause the checkout's log line ends with.
 *
 * Three outcomes, and the distinction between the last two is the whole point —
 * it is the same one `regionsRead: false` makes in `land.ts` and `notShown`
 * makes on the branch inventory. "Nothing to seed" is a fact about the
 * repository; "nothing matched" is a fact about the list, and only one of them
 * is something the operator can fix.
 */
export function seedReport(
  copied: string[],
  unseeded: string[],
  globs: string[],
): string {
  if (copied.length > 0) return ` (copied ${copied.join(", ")})`;
  if (unseeded.length === 0) return " (nothing to seed)";

  const named = unseeded.slice(0, SEED_REPORT_NAMED).join(", ");
  const rest = unseeded.length - SEED_REPORT_NAMED;
  return (
    ` (nothing seeded: ${unseeded.length} gitignored file${unseeded.length === 1 ? "" : "s"} here — ` +
    `${named}${rest > 0 ? ` and ${rest} more` : ""} — matched none of ${globs.join(", ")})`
  );
}

/**
 * Tell the operator where the work landed and how to look at it.
 *
 * Never a `git merge` command while their own checkout is dirty — a merge
 * suggested into a tree with uncommitted changes is the one instruction here
 * that can lose work if followed literally.
 */
async function emitHandoff(id: string, run: RunRow, workDir: string): Promise<void> {
  const branch = run.worktree_branch ?? "";
  const base = run.worktree_base ?? "";
  const commits = (await git(workDir, ["log", "--oneline", `${base}..HEAD`])).stdout;
  // `trim: false` because the porcelain status carries meaning in its first two
  // columns and trimming the stream eats the leading space off an unstaged
  // record. Only this list's *length* reaches the page today, so nothing is
  // visibly wrong — the flag is here because the payload holds the lines, and
  // whoever renders them next should not have to rediscover this.
  const leftover = (await git(workDir, ["status", "--porcelain"], { trim: false })).stdout;

  // "Could not tell" counts as dirty. A status that timed out or failed on a
  // stray index.lock would otherwise read as an empty stdout — i.e. clean — and
  // publish the merge command precisely when it is least safe to run.
  const mainStatus = await git(run.folder, ["status", "--porcelain"]);
  const mainDirty = !mainStatus.ok || mainStatus.stdout !== "";

  emit({
    runId: id,
    ts: Date.now(),
    kind: "handoff",
    payload: {
      branch,
      base,
      worktree: workDir,
      commits: commits ? commits.split("\n") : [],
      uncommitted: leftover.split("\n").filter(Boolean),
      review: [`git log ${base}..${branch}`, `git diff ${base}...${branch}`],
      // Withheld rather than shown-and-caveated: a copyable command is going to
      // be copied.
      merge: mainDirty ? null : `git merge ${branch}`,
      mergeBlocked: mainDirty
        ? mainStatus.ok
          ? "Your checkout has uncommitted changes — commit or stash them before merging."
          : "Could not read your checkout's status, so no merge command is offered. Check it by hand."
        : null,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Run creation                                                        */
/* ------------------------------------------------------------------ */

export interface CreateRunInput {
  folder: string;
  /** Which workspace mount `folder` is relative to. */
  mountId?: string | null;
  prompt: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  /** Give this run its own checkout. Defaults on for a git repository. */
  isolate?: boolean;
  /**
   * The saved agent this run is started **as**.
   *
   * The whole definition, resolved from the registry by the caller — the door is
   * where an id becomes a definition or a refusal, exactly as it is where a
   * permission mode becomes one of four literals. Frozen onto the row from here,
   * so deleting the saved agent afterwards cannot reach this run's next cycle.
   */
  agent?: AgentDefinition | null;
  budget: unknown;
  /**
   * Runs that must settle before this one starts, each with the condition it
   * must settle under. Absent or empty means it starts as soon as its folder is
   * free, which is every run that existed before this option did.
   */
  dependsOn?: RunDependencyInput[];
  /**
   * Which gate this run came through.
   *
   * Required rather than defaulted, and stated at the call site rather than
   * carried on a plan object, because the point of the column is that it is
   * *recorded* rather than deduced — a default would be a deduction with a
   * compiler behind it, and the two paths that share a plan function (a press
   * of Run and a schedule firing) differ in exactly this field.
   */
  origin: RunOrigin;
  /** The authorising record, where one exists: a proposal, instance, schedule. */
  originRef?: string | null;
}

/**
 * Runs holding, or waiting to hold, a place on disk.
 *
 * `paused` belongs here, but what a parked run holds is narrower than what a
 * live one holds. Its **worktree slot** is reserved outright — it resumes onto
 * the same branch carrying its own commits, and `allocateSlotPath` must never
 * hand that checkout to anyone else. Its **folder** is not: a parked run has no
 * process, so it steps aside for a run that is ready to work now and takes the
 * folder back when that one finishes. See `selectPromotable`.
 *
 * `waiting` is absent, and that absence is the whole point of the status: a run
 * told to start after other runs has no folder, no checkout slot and no place
 * in the queue until they settle. Selecting it here would reserve its folder
 * against every unrelated run submitted afterwards, so one four-run chain would
 * stall a repository for the length of the chain.
 */
export function activeRuns(): RunRow[] {
  return db()
    .prepare(
      "SELECT * FROM runs WHERE status IN ('queued','running','paused') ORDER BY created_at",
    )
    .all() as RunRow[];
}

/**
 * The run currently occupying a folder, if any.
 *
 * Deliberately *not* built on `isRunning()`: `procs` is emptied at the end of
 * every work cycle and only refilled when the next one spawns, so a run sitting
 * in its pre-cycle budget scan looks idle there while very much holding its
 * folder.
 *
 * `paused` is absent from the default set on purpose — a parked run yields its
 * folder, so naming it as the thing a new run is waiting for would describe a
 * wait that does not happen. `sweepPaused` narrows this further to `running`,
 * which is the only status that can actually be in the folder right now.
 */
function occupantOf(
  dir: string,
  exclude?: string,
  statuses: readonly RunStatus[] = ["running", "queued"],
): RunRow | null {
  const key = conflictKey(dir);
  for (const run of activeRuns()) {
    if (run.id === exclude) continue;
    if (!statuses.includes(run.status)) continue;
    if (overlaps(key, conflictKey(workDirOf(run)))) return run;
  }
  return null;
}

/**
 * Checkout slots one repository may have at once.
 *
 * A ceiling on *checkouts*, which is not the same quantity as
 * `settings.maxConcurrentRuns` and is deliberately far above it: a slot is
 * reused, so what consumes this is the number of runs working on the repository
 * right now **plus** every slot `slotIsDirty` has retired until somebody commits
 * or deletes what is in it. Only the first term is what the concurrency cap
 * bounds, and the second has no ceiling of its own and does not decay — so the
 * headroom between them is the whole of the margin, and running out of it is a
 * refusal (`slotExhaustionRefusal`) rather than something to absorb.
 */
export const MAX_WORKTREE_SLOTS = 64;

/**
 * What the allocator saw when it could not find a free checkout.
 *
 * Carried into the refusal because the three causes want different actions from
 * the operator and the old sentence asserted one of them ("every checkout still
 * holds uncommitted work") whatever it had actually found — so a repository
 * whose slots were simply all in use was reported as one needing cleaning up.
 *
 * The fourth number is the probe budget's, and it is separate from the three for
 * the same reason they are separate from each other: what one admission may ask
 * git about is bounded, so a slot it never looked at is not evidence of
 * anything, least of all of uncommitted work.
 */
export interface SlotCensus {
  /** Slot numbers walked: `MAX_WORKTREE_SLOTS`, or 0 when the mount is gone. */
  ceiling: number;
  /** Held by a run that is queued, running or paused. */
  heldByRuns: number;
  /** Holding uncommitted work, or unreadable — `slotIsDirty`'s answer. */
  dirty: number;
  /** A checkout of a different repository sharing the store. */
  foreign: number;
  /**
   * Existing checkouts this admission never put to git.
   *
   * `MAX_SLOT_PROBES_PER_ADMISSION` bounds what one admission may ask about, so
   * the three counts above are what was *seen* rather than what is there. Kept
   * apart from them precisely so the refusal cannot claim to have examined all
   * 64 — absent, or zero, means the walk settled every slot it counted.
   */
  unexamined?: number;
  /** Where the checkouts live, or null when the mount is gone. */
  store: string | null;
}

/**
 * The allocator's answer: a slot, or why there was not one.
 *
 * A union rather than `string | null` beside an always-populated census,
 * because the walk stops at the first free slot and the counts it has by then
 * describe nothing.
 */
type SlotAllocation = { slot: string } | { slot: null; census: SlotCensus };

/**
 * Lowest checkout slot for this repo that no live run already holds.
 *
 * The walk is ordered cheapest-question-first, because every git call here is a
 * subprocess on the admission path — see `MAX_SLOT_PROBES_PER_ADMISSION` for
 * what that costs and why it is bounded.
 *
 *  1. A slot an active run holds is skipped from SQLite, as it always was.
 *  2. A slot an earlier admission found unusable is skipped from the memo.
 *  3. A slot that is not on disk yet cannot be dirty and cannot belong to
 *     another repository, so a `stat` settles it outright.
 *  4. Only what is left is put to git, and only until the probe budget runs out.
 *
 * Past the budget the walk carries on looking for a slot of kind 3 — a number
 * nothing has ever used, which is free by construction — and gives up rather
 * than returning one it has not seen clean for itself. Giving up is the same
 * answer a genuinely full store produces, and that answer is a **refusal**
 * (`slotExhaustionRefusal`) rather than a run moved into the operator's own
 * checkout. It takes a store where all `MAX_WORKTREE_SLOTS` slots exist *and*
 * more than four of the low ones are unusable to reach, and it clears itself,
 * since each admission's budget is spent learning about four slots the next one
 * then skips for nothing — so the census counts those four separately from the
 * ones it never looked at, because the sentence has to say which it is.
 */
function allocateSlotPath(repoRoot: string): SlotAllocation {
  const store = worktreeStore(repoRoot);
  if (!store) {
    return {
      slot: null,
      census: { ceiling: 0, heldByRuns: 0, dirty: 0, foreign: 0, store: null },
    };
  }

  // Named from the repository's path within its mount, not its basename. The
  // folder listing is built for `org/repo` layouts, so two repos called `api`
  // in one workspace is ordinary — and since the store is shared per mount and
  // allocation is deterministic, a basename collision would hand them the same
  // directory and break isolation for the second one permanently. That is also
  // why the name carries a digest rather than a slug: see `worktreeSlug`.
  const slug = repoSlug(repoRoot);
  const taken = new Set(
    activeRuns()
      .map((r) => r.worktree_path)
      .filter((p): p is string => !!p),
  );

  const census: SlotCensus = {
    ceiling: MAX_WORKTREE_SLOTS,
    heldByRuns: 0,
    dirty: 0,
    foreign: 0,
    unexamined: 0,
    store,
  };

  const now = Date.now();
  let probes = 0;
  // Asked for at most once per admission, and only when a candidate has already
  // come back clean. `undefined` is "not asked yet"; `null` is git's own answer.
  let ownGitDir: string | null | undefined;

  for (let slot = 1; slot <= MAX_WORKTREE_SLOTS; slot++) {
    const candidate = path.join(store, `${slug}-${slot}`);
    if (taken.has(candidate)) {
      census.heldByRuns++;
      continue;
    }
    // Skip a slot left dirty by an earlier run: reusing it would either destroy
    // that work or fail at setup. Taking the next number keeps the new run
    // moving and leaves the old one recoverable. Dirty slots accumulate for
    // ever, which is why the answer is remembered rather than re-derived — and
    // a remembered verdict still counts towards the census, since what the
    // refusal describes is the store rather than this admission's git calls.
    const remembered = recentSlotVerdict(candidate, now);
    if (remembered) {
      if (remembered === "dirty") census.dirty++;
      else census.foreign++;
      continue;
    }
    if (!fs.existsSync(candidate)) return { slot: candidate };
    if (probes >= MAX_SLOT_PROBES_PER_ADMISSION) {
      // Counted rather than folded into `dirty`: nothing here has looked at it,
      // and a refusal that named it as uncommitted work would send the operator
      // to clean up a checkout that may be perfectly reusable.
      census.unexamined = (census.unexamined ?? 0) + 1;
      continue;
    }
    probes += 1;

    if (slotIsDirty(candidate)) {
      slotVerdicts.set(candidate, { verdict: "dirty", at: now });
      census.dirty++;
      continue;
    }
    // And skip a checkout of a *different* repository, which neither test above
    // can see — it is clean, and nothing holds it — but which `worktree add`
    // refuses outright. Returning it would mean a run that fails at setup with
    // a git error about a path, where taking the next number costs nothing.
    if (ownGitDir === undefined) ownGitDir = gitCommonDir(repoRoot);
    if (foreignSlotOwner(candidate, repoRoot, ownGitDir)) {
      slotVerdicts.set(candidate, { verdict: "foreign", at: now });
      census.foreign++;
      continue;
    }
    return { slot: candidate };
  }
  return { slot: null, census };
}

/**
 * Why an isolated run cannot be given a checkout, in the operator's terms.
 *
 * A refusal rather than a reason, and the difference is the whole of what this
 * sentence is for. It used to end "…so this run works in the folder directly
 * and waits its turn", which is `mode: "none"` — an agent editing the
 * operator's own checkout, on whatever branch that checkout is standing on,
 * with no grant to commit (`buildArgs` gives `git add`/`git commit` to an
 * isolated run only). The operator asked for isolation and got the one outcome
 * isolation exists to prevent, announced as though it were a scheduling note.
 *
 * So it names what was expected (the ceiling, and where the checkouts live) and
 * what was seen (which of the three causes actually used the slots up), because
 * each of the three wants a different thing done: commit or delete what is left
 * behind, wait for runs to finish, or remove a directory that belongs to
 * another repository. And it says how many slots this admission never examined,
 * rather than describing them as one of the three — `allocateSlotPath` stops
 * asking git after `MAX_SLOT_PROBES_PER_ADMISSION` checkouts, so on a store
 * where every slot already exists it can give up having settled only a few of
 * them, and claiming to have checked all 64 is a sentence it cannot stand
 * behind.
 */
function slotExhaustionRefusal(repoRoot: string, census: SlotCensus | null): string {
  if (census && census.ceiling === 0) {
    return (
      `This run asked for its own checkout of ${repoRoot}, and the workspace mount that would ` +
      "hold one is no longer configured, so there is nowhere to put it."
    );
  }

  const store = census?.store ?? WORKTREE_STORE_DIR;
  const seen = census
    ? [
        census.heldByRuns > 0 ? `${census.heldByRuns} held by runs in flight` : null,
        census.dirty > 0 ? `${census.dirty} still holding uncommitted work` : null,
        census.foreign > 0
          ? `${census.foreign} belonging to another repository`
          : null,
        // Named as its own cause rather than left out or folded into the three
        // above: "the ones this admission looked at" is the whole of what it can
        // stand behind, and an operator sent to clean up a checkout nothing here
        // examined would find one that is very possibly reusable.
        census.unexamined
          ? `${census.unexamined} this admission did not have the budget to look at`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(", ")
    : "";

  return (
    `No checkout is left for ${repoRoot}: all ${census?.ceiling ?? MAX_WORKTREE_SLOTS} slots in ` +
    `${store} are spoken for${seen ? ` — ${seen}` : ""}. This run asked for one of its own, and ` +
    "working in the folder instead would put an agent on your branch, so it is refused rather " +
    "than moved there. Commit or delete what those checkouts hold, or wait for a run to finish, " +
    "then start this run again."
  );
}

/**
 * Where a run will work, and on what branch.
 *
 * Extracted because it is now taken at two moments rather than one: at
 * admission for a run that starts straight away, and at release for a run that
 * was waiting on other runs — which holds no checkout slot while it waits, so
 * the slot has to be chosen when it stops waiting. Both callers are synchronous
 * and stay that way; `probeIsolation` and `allocateSlotPath` are sync syscalls,
 * which is what lets a claim be decided and recorded in one event-loop turn.
 */
function planWorkspace(
  id: string,
  folder: string,
  isolate: boolean,
  continueFrom: RunRow | null,
): { plan: IsolationPlan; workDir: string } {
  // An isolated run gets its own subtree, so it contends with nothing but a run
  // started on the workspace root — which does contain the checkout store, and
  // correctly blocks.
  const probe = isolate ? probeIsolation(folder) : { mode: "none" as const };
  const repoRoot = probe.mode === "worktree" ? probe.repoRoot : null;

  // What a chain claims is the **branch**, not the slot, and that is what makes
  // it safe for an unrelated run to take the predecessor's checkout in between.
  // Three things hold it together:
  //
  //  - The branch cannot be handed to anyone. A fresh branch is named from the
  //    run's own id, so no other run can ever mint this one, and a continuation
  //    adopts only the branch it was explicitly pointed at.
  //  - The predecessor's slot is preferred, and taken in the same event-loop
  //    turn that records it (see `createRun`), so nothing can interleave
  //    between reading `activeRuns()` and the write that puts this run in it —
  //    from which point `allocateSlotPath` skips the slot like any other.
  //  - When an active run does hold it, a fresh slot is used instead and git
  //    attaches the existing branch to it. That run took a slot
  //    `allocateSlotPath` had already found *clean*, so there is never
  //    uncommitted chain work stranded in the slot left behind; and it moved
  //    the slot off this branch with `checkout -b`, so the branch is free to be
  //    checked out elsewhere. If it has not got that far yet, `worktree add`
  //    refuses by name rather than branching from somewhere else.
  const inheritedSlot =
    continueFrom?.worktree_path &&
    !activeRuns().some((r) => r.worktree_path === continueFrom.worktree_path)
      ? continueFrom.worktree_path
      : null;

  // Not allocated for a continuation that already has its slot: allocation is a
  // claim, and claiming a second checkout it will not use would take one out of
  // circulation for every other run on the repository.
  const allocation =
    repoRoot && !inheritedSlot ? allocateSlotPath(repoRoot) : null;

  const plan = resolveIsolation({
    runId: id,
    isolate,
    probe,
    continueFrom: continueFrom ? continuedBranchOf(continueFrom) : null,
    inheritedSlot,
    freeSlot: allocation?.slot ?? null,
    slotCensus: allocation && allocation.slot === null ? allocation.census : null,
  });

  return {
    plan,
    workDir:
      plan.mode === "worktree" && plan.worktreePath ? plan.worktreePath : folder,
  };
}

/**
 * The run whose branch this one continues, or a refusal naming it.
 *
 * Never null when `continues_run` is set. `run_deps` cascade-deletes with
 * either end, so a deleted predecessor normally blocks the dependent long
 * before it gets here — but `continues_run` is a plain column with no foreign
 * key behind it, and reading a dangling one as "no continuation" would cut a
 * fresh branch from the target and lose the chain silently, which is the one
 * outcome this mode exists to prevent.
 */
function predecessorOf(id: string): RunRow {
  const run = getRun(id);
  if (!run) {
    throw new Error(
      `The run whose branch this one continues (${shortId(id)}) is no longer here, so there is no branch to carry on.`,
    );
  }
  return run;
}

/** The six columns a continued branch is resolved from. */
function continuedBranchOf(run: RunRow): ContinuedBranch {
  return {
    runId: run.id,
    isolation: run.isolation,
    repoRoot: run.repo_root,
    branch: run.worktree_branch,
    base: run.worktree_base,
    baseBranch: run.worktree_base_branch,
    worktreePath: run.worktree_path,
  };
}

/**
 * Read the dependency list off a request, and say what it means for admission.
 *
 * Every refusal here is a graph that cannot be satisfied, and each one is
 * cheaper said now than discovered later: a run whose dependency has already
 * failed would otherwise be admitted only to be terminated in the same second,
 * and a loop would be admitted and then never terminated at all.
 *
 * The verdict reuses `releasableRuns` rather than re-deciding what a settled
 * dependency is. A dependency that is already satisfied means this run starts
 * now and never touches the `waiting` status at all — the alternative, always
 * admitting as `waiting` and letting the sweep pick it up, would leave a run
 * created against a finished dependency sitting there until something unrelated
 * finished and triggered a pass.
 */
function admitDependencies(
  id: string,
  input: readonly RunDependencyInput[],
  isolate: boolean,
): { links: DependencyLink[]; waiting: boolean; continuesRun: string | null } {
  const links: DependencyLink[] = [];
  const targets: DependencyState[] = [];
  const seen = new Set<string>();
  let continuesRun: string | null = null;

  for (const raw of input) {
    const runId = String(raw?.runId ?? "");
    const edge = raw?.edge as DependencyEdge;
    if (!runId) throw new Error("A dependency has to name a run.");
    if (runId === id) {
      throw new Error(`A run cannot depend on itself (${shortId(id)}).`);
    }
    if (!(DEPENDENCY_EDGES as readonly string[]).includes(edge)) {
      throw new Error(
        `Dependency on run ${shortId(runId)} needs a condition: ${DEPENDENCY_EDGES.join(" or ")}.`,
      );
    }
    if (seen.has(runId)) {
      throw new Error(
        `Run ${shortId(runId)} is named twice in the dependency list, so it is unclear which condition applies.`,
      );
    }
    const target = getRun(runId);
    if (!target) throw new Error(`No such run to depend on: ${runId}`);
    seen.add(runId);

    const continues = raw?.continueBranch === true;
    if (continues) {
      // One branch, one predecessor. A fan-in has several dependencies and only
      // one of them can hand over the work this run stands on; two would mean
      // two branches, and nothing downstream — not `ensureWorktree`, not
      // `landState` — has a way to be on both.
      if (continuesRun) {
        throw new Error(
          `Runs ${shortId(continuesRun)} and ${shortId(runId)} are both set to hand their branch over. ` +
            "A run can only continue one branch.",
        );
      }
      if (!isolate) {
        throw new Error(
          `Continuing run ${shortId(runId)}'s branch needs a checkout of this run's own, but isolation is turned off for it.`,
        );
      }
      if (target.isolation === "none") {
        throw new Error(
          `Run ${shortId(runId)} has no branch to hand over — isolation was turned off for it, so it works directly in the folder.`,
        );
      }
      // A second run continuing the same predecessor is two runs committing to
      // one branch, which git will not check out twice and which leaves the
      // landing rules with no last link to name. Keeping a chain a single path
      // is what lets `branchOwner` say which run lands it.
      //
      // Except from a link that came to nothing: a dependent blocked because
      // its own dependency failed is recorded against this branch and put no
      // commit on it, and refusing on the strength of that would make a chain
      // unextendable for ever over a run that never opened a file. Same test as
      // `edgeSatisfied` and `branchOwner` — a terminal run with no work cycle
      // is not a link.
      //
      // Built from `TERMINAL_STATUSES` rather than spelled out again: a second
      // copy of "which statuses have settled" is a second thing to forget when
      // one is added, and forgetting it here is the expensive direction — a
      // settled run reads as still holding the branch, so nothing may ever be
      // created to carry it on and the refusal names a run that finished hours
      // ago.
      const rival = db()
        .prepare(
          `SELECT id, status FROM runs
            WHERE continues_run = ?
              AND (iterations > 0 OR status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")}))
            LIMIT 1`,
        )
        .get(runId, ...TERMINAL_STATUSES) as
        | { id: string; status: RunStatus }
        | undefined;
      if (rival) {
        throw new Error(
          `Run ${shortId(rival.id)} is already set to continue run ${shortId(runId)}'s branch (it is ${rival.status}). ` +
            "Two runs cannot extend the same branch; pick that one up again instead.",
        );
      }
      continuesRun = runId;
    }

    links.push({ runId: id, dependsOn: runId, edge, continueBranch: continues });
    targets.push({
      id: target.id,
      status: target.status,
      iterations: target.iterations,
    });
  }

  if (links.length === 0) return { links, waiting: false, continuesRun };

  // Existing edges too: this run's dependencies may themselves be waiting on
  // something, and a loop anywhere in the closure is a loop this run joins.
  const loop = dependencyCycle([...allDependencyLinks(), ...links]);
  if (loop) {
    throw new Error(
      `These dependencies make a loop: ${loop.map(shortId).join(" → ")}.`,
    );
  }

  const { release, block } = releasableRuns(
    [{ id, status: "waiting", iterations: 0 }, ...targets],
    links,
  );
  if (block.length > 0) throw new Error(block[0].reason);
  return { links, waiting: !release.includes(id), continuesRun };
}

/**
 * Admit a run, or park it behind whatever is already in its folder.
 *
 * Everything from here to the INSERT is synchronous — `resolveWorkspaceFolder`,
 * `probeIsolation`, the dependency check, and the occupancy scan are all sync
 * syscalls or sync SQLite — and that is what makes the check-then-insert
 * atomic: one Node event-loop turn runs to completion, so no second request can
 * interleave between deciding a folder is free and recording that this run took
 * it. **Introducing a single `await` in this path silently reintroduces two
 * agents in one directory.** The transaction wrapper does not provide that
 * guarantee (better-sqlite3 is synchronous either way); it is there so the
 * property survives a refactor that adds a second statement.
 *
 * A run with unsettled dependencies is admitted as `waiting` instead, and takes
 * *no* claim: no folder, no checkout slot, no place in the queue. That is the
 * whole reason for the status. A four-run chain admitted as `queued` would
 * reserve its folder against every unrelated run submitted afterwards — see
 * `selectPromotable` — so one chain would stall an entire repository for as long
 * as it took to work through.
 */
export function createRun(input: CreateRunInput): RunRow {
  // Before anything is resolved or written. The claim below is a check-then-
  // insert that is only atomic because one event loop runs it, so a second
  // process admitting runs against this database is two agents in one directory
  // — the collision `db.ts` opens by naming the single process as what prevents
  // it. This is the door every other door goes through: the API route, the
  // chat's approval pass, a workflow's instantiation and an orchestrator
  // block's emission all end up here, so one refusal covers all of them.
  requireDataDir();

  const folder = resolveWorkspaceFolder(input.folder, input.mountId);
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) throw new Error("Prompt is required");

  // The install-wide ceiling, at the one door every run in this app comes
  // through — the form, the chat's approval batch, a workflow's pass and an
  // orchestrator block's emission all end here. Refused rather than queued,
  // because a queued run is a promise to spend as soon as a slot frees and the
  // whole point of this ceiling is that nothing new starts. Synchronous, like
  // everything else in this function: the reading is three SQLite sums and
  // better-sqlite3 has no `await` to offer, so the folder claim's
  // one-event-loop-turn atomicity is untouched.
  const installRefusal = installBudgetRefusal();
  if (installRefusal) throw new Error(installRefusal);

  const policy = normalizePolicy(input.budget);
  const settings = getSettings();
  const id = randomUUID();
  const now = Date.now();

  const budgetBlob = JSON.stringify({
    ...policy,
    permissionMode: input.permissionMode ?? settings.defaultPermissionMode,
  });

  // Frozen at creation, so an agent deleted or edited afterwards cannot change
  // what this run's later cycles are given — the same treatment the guards above
  // get, and the reason deleting a template cannot reach a run started from one.
  const agentBlob = input.agent ? JSON.stringify(input.agent) : null;

  // Frozen here for a sharper reason than the agent above: this text goes on
  // every cycle's `--append-system-prompt`, and the appended prompt is part of
  // the cached prefix, so a version of it that differed between two cycles of
  // one run would leave every token behind it cold on the second. Generating it
  // once, at the one door every run comes through, is what makes "byte-identical
  // on every cycle" a property of the schema rather than of a later editor's
  // care. Synchronous, like everything else between here and the INSERT: a
  // bounded `readdirSync` walk and one SQLite aggregate, no `await` to offer and
  // none introduced.
  //
  // `folder` rather than the worktree the plan below may pick: the worktree is a
  // checkout of this same tree, it does not exist yet at a waiting run's
  // creation, and `folder` is also the key the read history is stored under.
  const costNotice = fileCostNotice(folder);

  const isolate = input.isolate !== false;
  const { links, waiting, continuesRun } = admitDependencies(
    id,
    input.dependsOn ?? [],
    isolate,
  );

  // Deferred entirely for a waiting run: choosing a checkout slot *is* a claim
  // on it, and the run may not start for days. `isolation` is left null to say
  // "not decided yet" — except when the operator turned isolation off, which is
  // an answer already and is recorded as one so the release does not overrule
  // it. Every other column the plan fills is written at release too.
  //
  // `continues_run` is the exception and is written either way: it is an id and
  // a statement of intent rather than a claim on anything, and the landing
  // rules have to be able to see a chain coming before its branch exists.
  const { plan, workDir } = waiting
    ? { plan: null, workDir: null }
    : planWorkspace(
        id,
        folder,
        isolate,
        continuesRun ? predecessorOf(continuesRun) : null,
      );
  const isolation = plan ? plan.mode : isolate ? null : "none";

  const run = db().transaction((): RunRow => {
    const busy = plan ? occupantOf(workDir!) : null;

    db()
      .prepare(
        `INSERT INTO runs
           (id, folder, prompt, model, status, budget, max_iterations, iterations, created_at, spent_usd, spent_tokens,
            work_dir, isolation, repo_root, worktree_path, worktree_branch, worktree_base, worktree_base_branch,
            continues_run, agent, file_cost_notice, origin, origin_ref, task_signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        folder,
        prompt,
        input.model ?? settings.defaultModel,
        waiting ? "waiting" : "queued",
        budgetBlob,
        // 0 is the stored sentinel for "no cap" — see the schema comment in
        // db.ts. The blob above is the source of truth; this column exists so
        // the list view does not have to parse it.
        policy.maxIterations ?? 0,
        now,
        workDir,
        isolation,
        plan?.repoRoot ?? null,
        plan?.worktreePath ?? null,
        plan?.branch ?? null,
        plan?.base ?? null,
        plan?.baseBranch ?? null,
        continuesRun,
        agentBlob,
        // Empty means "nothing worth pricing here" and is stored as null, so
        // that the two ways a run has no notice — this one and a row written
        // before the column — read the same at the spawn.
        costNotice || null,
        input.origin,
        input.originRef ?? null,
        taskSignature(folder, prompt),
      );

    const addLink = db().prepare(
      "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const link of links) {
      addLink.run(
        link.runId,
        link.dependsOn,
        link.edge,
        link.continueBranch ? 1 : 0,
        now,
      );
    }

    emit({
      runId: id,
      ts: now,
      kind: "status",
      payload: {
        status: waiting ? "waiting" : "queued",
        folder,
        prompt,
        ...(plan ? { isolation: plan.mode } : {}),
        ...(plan?.reason ? { isolationReason: plan.reason } : {}),
        ...(busy ? { waitingFor: busy.id } : {}),
        ...(links.length > 0
          ? {
              dependsOn: links.map((l) => ({
                runId: l.dependsOn,
                edge: l.edge,
                continueBranch: l.continueBranch,
              })),
            }
          : {}),
      },
    });

    if (plan?.reason) log(id, plan.reason);
    if (busy) {
      log(
        id,
        `Waiting: ${describeFolder(workDirOf(busy)).relPath || "the workspace root"} is in use by an earlier run.`,
        { waitingFor: busy.id },
      );
    }
    if (waiting) {
      log(
        id,
        `Waiting for ${links.map((l) => `run ${shortId(l.dependsOn)} (${l.edge})`).join(", ")}. It holds no folder and no checkout until then.`,
      );
    }
    if (continuesRun) {
      log(
        id,
        `This run carries on run ${shortId(continuesRun)}'s branch rather than starting a new one, so its work builds on that run's commits.`,
        { continuesRun },
      );
    }
    if (input.agent) {
      // Once, at creation, rather than per cycle: it is a fact about the run
      // and not about a spawn. "runs as" is now the literal truth —
      // `sessionAgentArgs` defines the member *and* selects it with `--agent`,
      // so the saved prompt is this session's own. It still bounds nothing
      // about what the run may do, which is the second sentence's whole job.
      log(
        id,
        `This run is started as the “${input.agent.name}” agent, so its prompt is the run's own. It changes who the run is, not what this run is allowed to do.`,
        { agent: input.agent.name },
      );
    }

    return getRun(id)!;
  })();

  // Outside the transaction: promotion spawns, and a spawn inside a SQLite
  // transaction would hold the write lock for the life of the child. A waiting
  // run has freed nothing and started nothing, so there is nothing to promote.
  if (!waiting) promoteQueued();
  return getRun(run.id)!;
}

/**
 * Which queued runs may start right now, oldest first. `runs` must be ordered
 * by `created_at`, as `activeRuns()` returns it.
 *
 * Pure, and separated from the spawning below so it can be tested: the failure
 * mode is two agents writing in one directory, which stays silent until it has
 * already cost something.
 *
 * Only `running` rows reserve a folder. A parked run does not — it has no
 * process, and holding a folder for hours against work that is ready now is a
 * wait with nothing at the end of it. It takes the folder back through
 * `sweepPaused`, which will not un-park it while a run is in there. Its
 * worktree slot is a separate claim and is *not* yielded; see `activeRuns`.
 *
 * A queued run that cannot start still reserves its folder against everything
 * younger. Without that, a run on the workspace root — which overlaps every
 * folder under it — is overtaken by every small run submitted after it and
 * never starts at all.
 *
 * The cap counts `running` only, and for the same reason the reservation set
 * does: the claim is about what is on disk, the cap is about what is spending
 * money. Counting parked runs against a cap of 1 would starve everything else
 * for hours.
 */
/**
 * The order the queue is considered in: priority first, then age.
 *
 * Every selection over `runs` used to be ordered by `created_at` alone, which
 * made the `queuePosition` the UI shows a report of a position nothing could
 * change — an operator who needed one run before another could only cancel and
 * recreate it, losing that run's history and its spend.
 *
 * Age is still the tie-break and the default priority is 0, so an install that
 * never sets one queues in exactly the order it does today. That is the
 * property worth having: this is not a new scheduler, it is the old one with a
 * lever, and with the lever untouched the behaviour is unchanged.
 *
 * Pure, and separated from `selectPromotable` because it is the half that
 * decides whose work runs first when an allowance is nearly spent, and it
 * fails silently: a comparator that quietly ignored `priority` would look
 * exactly like one that worked, on every install where nobody had set one.
 */
export function queueOrder<T extends { priority?: number | null; created_at: number }>(
  runs: readonly T[],
): T[] {
  return [...runs].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.created_at - b.created_at,
  );
}

export function selectPromotable(
  runs: readonly RunRow[],
  cap: number | null,
  /**
   * The install-wide hold. Nothing starts while it is set, and nothing already
   * running is touched — which is the whole of what this switch means, and why
   * it belongs here rather than beside the spawn: this is the one function that
   * decides what starts, so a hold expressed anywhere else would be a second
   * answer to the same question.
   */
  newWorkPaused = false,
): string[] {
  if (newWorkPaused) return [];

  const reserved: ConflictKey[] = runs
    .filter((r) => r.status === "running")
    .map((r) => conflictKey(workDirOf(r)));

  const promote: string[] = [];
  let live = reserved.length;

  // Priority order, not arrival order. `reserved` above is computed from the
  // RUNNING runs and does not depend on this, but the loop below claims folders
  // as it goes — so ordering here is also what decides which of two runs
  // wanting the same folder gets it, which is exactly what an operator setting
  // a priority is asking for.
  for (const run of queueOrder(runs)) {
    if (run.status !== "queued") continue;
    if (cap !== null && live >= cap) break;

    const key = conflictKey(workDirOf(run));
    reserved.push(key);
    if (reserved.some((r) => r !== key && overlaps(key, r))) continue;

    live += 1;
    promote.push(run.id);
  }
  return promote;
}

/**
 * Start every queued run whose folder is free, oldest first.
 *
 * The cap is enforced here rather than at admission, because here is the only
 * place a run actually starts costing anything. Over the cap a run waits its
 * turn instead of being refused — the queue already exists for exactly that.
 */
export function promoteQueued(): void {
  // The one route to `startRun`, so this is the one place a spawn has to be
  // refused. A process that does not own the data directory leaves the queue
  // exactly as it found it: the rows belong to the server that does, and it
  // will promote them itself. Asked here rather than captured at boot, because
  // the answer moves — the heartbeat clears it if the directory changes hands.
  if (!mayWriteDataDir()) return;

  // The process is going down and the shutdown is waiting out its children.
  // Every run that settles during that wait reaches its `finally` and arrives
  // here, so without this a `docker compose restart` spawns a fresh billed
  // agent for each one, seconds before the process exits.
  if (shutdown.active) return;

  const cap = getSettings().maxConcurrentRuns;
  for (const id of selectPromotable(activeRuns(), cap, newWorkPaused())) {
    void startRun(id).catch(() => {
      /* terminal state is recorded by startRun's own finally block */
    });
  }
}

/**
 * How many runs are ahead of this one **for its folder**. 0 means next up.
 *
 * Counting every queued run would be meaningless: runs waiting on unrelated
 * folders do not delay this one by a second, and reporting them as "ahead of
 * it" describes a wait that will not happen.
 */
export function queuePosition(id: string): number {
  const runs = activeRuns();
  const self = runs.find((r) => r.id === id);
  if (!self) return 0;

  // Queued runs only. The run currently holding the folder is not "ahead in
  // line" — it is the thing being waited on, which is what position 0 means.
  const key = conflictKey(workDirOf(self));
  return runs.filter(
    (r) =>
      r.id !== id &&
      r.status === "queued" &&
      r.created_at <= self.created_at &&
      overlaps(key, conflictKey(workDirOf(r))),
  ).length;
}

/* ------------------------------------------------------------------ */
/* Run dependencies                                                    */
/* ------------------------------------------------------------------ */

export const DEPENDENCY_EDGES = ["on-success", "on-finish"] as const;
export type DependencyEdge = (typeof DEPENDENCY_EDGES)[number];

/** One "start after that run" edge, as a caller states it. */
export interface RunDependencyInput {
  runId: string;
  edge: DependencyEdge;
  /**
   * Carry on this dependency's branch instead of cutting a new one.
   *
   * Absent is false, which is the only default that can be silent here: it is
   * what every dependency meant before this existed, and the unset reading
   * costs a second agent starting from the target branch — visible in its first
   * `git log` — where the wrong reading would put a run on a branch nobody
   * asked for. At most one dependency of a run may set it.
   */
  continueBranch?: boolean;
}

/** The same edge as stored: the dependent, the dependency, the condition. */
export interface DependencyLink {
  runId: string;
  dependsOn: string;
  edge: DependencyEdge;
  /** Whether this is the dependency whose branch the dependent takes over. */
  continueBranch?: boolean;
}

/** Everything the decision below reads off a row, and nothing else. */
export interface DependencyState {
  id: string;
  status: RunStatus;
  /** Work cycles that *finished*, as `runs.iterations` counts them. */
  iterations: number;
}

/**
 * Statuses a run never leaves on its own.
 *
 * Exported because a workflow instance's scheduler asks the same question about
 * the runs an orchestrator block emitted, and "has this settled" answered twice
 * is the failure `edgeSatisfied` below exists to have one answer to.
 */
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "completed",
  // Carries five subsystems at once — dependency release, retention's three
  // sweeps, a loop block's exit test, `edgeVerdict` and `planInstanceStep`.
  // Adding the union member and forgetting this constant produces a run that is
  // terminal everywhere a person looks and unsettled everywhere the machine
  // looks: chains that never start, loops that wait for ever, evidence that
  // never ages out, and not one line anywhere saying so.
  "needs-review",
  "stopped",
  "failed",
  "blocked",
];

/**
 * Whether a dependency has settled in a way that lets its dependent start.
 *
 * **A run that never ran a work cycle satisfies neither condition.** That one
 * rule is what makes a chain terminate rather than sit there: a run refused by
 * a guard at the door, a run whose own dependency failed, a run stopped before
 * it started, and a run closed out by a restart are all `blocked`, `stopped` or
 * `failed` with `iterations === 0`, and every one of them is a dependency that
 * is finished and did nothing. Reading `on-finish` as "it reached a terminal
 * status, whatever that status was" would start the next run in the chain on
 * the strength of a run that never opened a file.
 *
 * `on-success` is `completed`, and deliberately **not** `completed &&
 * reported_done`. `completed` is written for two endings — the agent replying
 * DONE, and the run using up its cycle cap — and `maxIterations` defaults to 1,
 * so on a stock install almost every finished run is the second kind. Keying
 * success on the DONE reply would mean a dependent almost never starts, and
 * would terminate the chain with "its dependency did not report done" about a
 * run that did exactly what it was asked to. Success here is the *absence of a
 * fault*: no crash, no guard, no operator stop — which is the question a person
 * chaining two runs is actually asking. `reported_done` is on the DTO for
 * anyone who wants the stronger reading; it is not what this decides.
 *
 * `needs-review` is therefore terminal and not a success, and both halves are
 * deliberate: an `on-success` dependent stays blocked with a sentence naming the
 * run that asked for review, and an `on-finish` dependent starts — which is what
 * `on-finish` has always meant about a `failed` predecessor. A run that reported
 * it could not get past something did not do the work the next run was chained
 * behind.
 */
export function edgeSatisfied(
  dep: DependencyState,
  edge: DependencyEdge,
): boolean {
  if (dep.iterations < 1) return false;
  if (edge === "on-success") return dep.status === "completed";
  return TERMINAL_STATUSES.includes(dep.status);
}

/** Why a dependent can never start, in words naming the run that stopped it. */
function unsatisfiableReason(dep: DependencyState, edge: DependencyEdge): string {
  const name = `run ${shortId(dep.id)}`;
  if (dep.iterations < 1) {
    return `Set to start after ${name}, which ended ${dep.status} without running a work cycle.`;
  }
  return `Set to start only after ${name} succeeded (${edge}); it ended ${dep.status}.`;
}

/**
 * The first dependency loop in a graph, as the ids around it, or null.
 *
 * A graph that cannot be satisfied is a typo rather than a run: every member of
 * a loop waits for another member for ever, and nothing downstream of it can
 * ever be released either. Nothing else detects that — `releasableRuns` reaches
 * a fixed point and simply leaves those rows alone, which is exactly the
 * "asleep for ever" row this whole design is meant to have none of. So it is
 * refused at admission, which is the only moment an edge is created.
 *
 * That makes acyclicity a property of the *data* rather than of who wrote it.
 * `createRun` cannot construct a loop today — it mints the run's id after
 * reading the edges, so nothing can already point at it — and this check is
 * what keeps that true if a second writer ever appears.
 */
export function dependencyCycle(links: readonly DependencyLink[]): string[] | null {
  const out = new Map<string, string[]>();
  for (const link of links) {
    const list = out.get(link.runId);
    if (list) list.push(link.dependsOn);
    else out.set(link.runId, [link.dependsOn]);
  }

  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const walk = (id: string): string[] | null => {
    if (onStack.has(id)) {
      // The loop itself, not the path that led into it.
      return [...stack.slice(stack.indexOf(id)), id];
    }
    if (done.has(id)) return null;
    stack.push(id);
    onStack.add(id);
    for (const next of out.get(id) ?? []) {
      const loop = walk(next);
      if (loop) return loop;
    }
    stack.pop();
    onStack.delete(id);
    done.add(id);
    return null;
  };

  for (const id of out.keys()) {
    const loop = walk(id);
    if (loop) return loop;
  }
  return null;
}

/**
 * The order a set of things has to be created in: every one after what it waits
 * for.
 *
 * Kahn's algorithm, with ties broken by position in `nodes` — the order the
 * author arranged them in. The determinism is not a nicety: runs are admitted
 * oldest-first and a queued run reserves its folder against everything younger,
 * so an unstable order would make two presses of Run on one graph produce two
 * different queues on the same repository.
 *
 * `unplaced` is every node the pass could not reach: a member of a loop, or
 * anything waiting on one. Nothing downstream of a loop can ever start —
 * `releasableRuns` reaches a fixed point and leaves those rows asleep for ever
 * — so a set that produces any is refused rather than created.
 *
 * **Here rather than in `workflows.ts`, for `dependencyCycle`'s reason.** Both
 * answer a question about the same edge vocabulary, and there are now three
 * callers that create runs in one synchronous pass and need "every one after
 * what it waits for" to mean exactly one thing: a saved graph, the specs an
 * orchestrator block emits, and a batch of chat proposals the operator
 * approves together. Typed against the two fields it reads rather than against
 * any of those three shapes, which is what lets it be shared at all.
 *
 * Defensive about edges naming nodes that are not here: each caller refuses
 * those separately, and an order that silently mis-sequenced would start an
 * agent before the work it extends exists.
 */
export function topologicalOrder(graph: {
  nodes: readonly { id: string }[];
  edges: readonly { from: string; to: string }[];
}): {
  order: string[];
  unplaced: string[];
} {
  const known = new Set(graph.nodes.map((n) => n.id));
  const seen = new Set<string>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const n of graph.nodes) incoming.set(n.id, 0);

  for (const e of graph.edges) {
    if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) continue;
    // A repeated pair is one dependency stated twice, not two: counted twice it
    // would leave its dependent unplaceable and report a healthy graph as a loop.
    const key = `${e.from} ${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    const list = outgoing.get(e.from);
    if (list) list.push(e.to);
    else outgoing.set(e.from, [e.to]);
  }

  const order: string[] = [];
  // Re-scanned each pass rather than kept as a queue, which is what makes the
  // tie-break the declaration order instead of the order things were released.
  // A placed node is marked -1, so it can never match again however many
  // successors are decremented afterwards.
  for (;;) {
    const next = graph.nodes.find((n) => incoming.get(n.id) === 0);
    if (!next) break;
    order.push(next.id);
    incoming.set(next.id, -1);
    for (const to of outgoing.get(next.id) ?? []) {
      incoming.set(to, (incoming.get(to) ?? 0) - 1);
    }
  }

  return {
    order,
    unplaced: graph.nodes.filter((n) => !order.includes(n.id)).map((n) => n.id),
  };
}

/**
 * Which waiting runs may join the queue now, and which can never start.
 *
 * Pure, and separated from the writes below for the same reason
 * `selectPromotable` is: both failure modes are silent and neither is cheap. A
 * run released too early starts on top of work that has not happened yet; a run
 * never released, and never terminated either, sits `waiting` for ever holding
 * a prompt the operator believes is queued.
 *
 * `runs` must carry every waiting run *and* every run named as a dependency of
 * one. A dependency that is missing from it is treated as gone — blocked rather
 * than released, because "not found" is not "finished".
 *
 * The pass repeats until nothing changes, and that loop is the cascade: a run
 * blocked here is itself a settled dependency that ran no cycle, so everything
 * downstream of it blocks on the next pass with its own reason naming it.
 * Termination is by exhaustion — every pass that reports a change decides at
 * least one waiting run, and a decided run is never revisited.
 */
export function releasableRuns(
  runs: readonly DependencyState[],
  links: readonly DependencyLink[],
  /**
   * The install-wide hold, which suppresses the release half and only that half.
   *
   * A run whose dependencies can never settle is still terminated: `blocked`
   * costs nothing, spends nothing and is the true thing to say, and holding it
   * back would leave a chain that can only end when somebody remembers to clear
   * the pause. What the hold stops is the half that puts an agent to work.
   */
  newWorkPaused = false,
): { release: string[]; block: Array<{ id: string; reason: string }> } {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const edges = new Map<string, DependencyLink[]>();
  for (const link of links) {
    const list = edges.get(link.runId);
    if (list) list.push(link);
    else edges.set(link.runId, [link]);
  }

  const release: string[] = [];
  const block: Array<{ id: string; reason: string }> = [];
  const decided = new Set<string>();

  for (;;) {
    let changed = false;
    for (const run of runs) {
      if (run.status !== "waiting" || decided.has(run.id)) continue;

      let stopper: string | null = null;
      let pending = false;
      for (const link of edges.get(run.id) ?? []) {
        const dep = byId.get(link.dependsOn);
        if (!dep) {
          stopper = `Set to start after run ${shortId(link.dependsOn)}, which is no longer there.`;
          break;
        }
        if (edgeSatisfied(dep, link.edge)) continue;
        // Every dependency is checked before the verdict: one that is still
        // running does not make this run "waiting" if another has already made
        // it unstartable, and saying so now is what stops a chain from ending
        // one run at a time as each dependency ahead of it finishes.
        if (TERMINAL_STATUSES.includes(dep.status)) {
          stopper = unsatisfiableReason(dep, link.edge);
          break;
        }
        pending = true;
      }

      if (stopper !== null) {
        block.push({ id: run.id, reason: stopper });
        // Treated as blocked from here on, which is what cascades the verdict
        // down the chain on the next pass.
        byId.set(run.id, { id: run.id, status: "blocked", iterations: 0 });
      } else if (pending) {
        continue;
      } else if (newWorkPaused) {
        // Ready, and deliberately left `waiting` — the status that holds no
        // folder, no checkout and no place in the queue, so a held run costs
        // exactly what it did before. It is decided again on the next release
        // pass, which clearing the hold triggers.
        continue;
      } else {
        release.push(run.id);
      }
      decided.add(run.id);
      changed = true;
    }
    if (!changed) return { release, block };
  }
}

/** Every stored edge. Small table: one row per dependency ever declared. */
function allDependencyLinks(): DependencyLink[] {
  return db()
    .prepare(
      "SELECT run_id AS runId, depends_on AS dependsOn, edge FROM run_deps",
    )
    .all() as DependencyLink[];
}

/**
 * What each of these runs is waiting for, for the list and detail payloads.
 *
 * One query for the whole page rather than one per run: the list route reports
 * a hundred rows, and `satisfied` is computed here rather than on the client so
 * that "what counts as settled" has exactly one definition.
 */
export function dependenciesOf(
  ids: readonly string[],
): Map<string, RunDependencyDTO[]> {
  const out = new Map<string, RunDependencyDTO[]>();
  if (ids.length === 0) return out;

  const rows = db()
    .prepare(
      `SELECT d.run_id AS runId, d.depends_on AS dependsOn, d.edge AS edge,
              d.continue_branch AS continueBranch,
              r.status AS status, r.iterations AS iterations
         FROM run_deps d
         JOIN runs r ON r.id = d.depends_on
        WHERE d.run_id IN (${ids.map(() => "?").join(",")})
        ORDER BY d.created_at, d.depends_on`,
    )
    .all(...ids) as Array<
    // `continue_branch` is stored as SQLite's 0/1, not a boolean — the column
    // is spelled out rather than intersected in, or the widened type would let
    // a falsy `0` through as `true` at the one call site that reads it.
    Omit<DependencyLink, "continueBranch"> & {
      status: RunStatus;
      iterations: number;
      continueBranch: number;
    }
  >;

  for (const row of rows) {
    const list = out.get(row.runId) ?? [];
    list.push({
      runId: row.dependsOn,
      edge: row.edge,
      status: row.status,
      continueBranch: !!row.continueBranch,
      satisfied: edgeSatisfied(
        { id: row.dependsOn, status: row.status, iterations: row.iterations },
        row.edge,
      ),
    });
    out.set(row.runId, list);
  }
  return out;
}

/**
 * Everything downstream of `roots` that is blocked and could be woken.
 *
 * The counterpart to `releasableRuns`, and it exists because that function's
 * verdict is written once and never revisited: `releasePass` selects
 * `WHERE status = 'waiting'`, so the moment a row becomes `blocked` it is
 * invisible to every later pass. That is right while the dependency stays
 * settled and wrong the moment it does not — and `reopenRun` exists precisely
 * to unsettle one. Measured: a four-block workflow lost its last block when
 * block three stopped at its spending limit; the operator raised the limit,
 * reopened it, and it completed, but the block behind it stayed blocked with a
 * sentence about a stop that had since been undone, and no route back — a
 * `blocked` row is not `REOPENABLE` either.
 *
 * Transitive, because the cascade that blocked them was: block three's failure
 * blocked four, and four blocked five with a reason naming four. Waking only
 * the direct dependents would leave the tail of every chain longer than two
 * exactly as stuck as before.
 *
 * Membership is decided structurally rather than by reading `stop_reason` back,
 * which is prose and the wrong kind of evidence — the same reason `splitPatches`
 * matches on position and the merge-tree parser trusts the stage records over
 * the messages. A caller passes only rows that never reached a workspace; a run
 * refused by its *own* guard before its first cycle is `blocked` too, and it has
 * a `work_dir`, so re-planning one through `admitWaiting` would allocate a
 * second checkout slot and orphan the first.
 *
 * Which is why the ids are only ids: `reviveBlockedBlocks` asks the identical
 * question of a workflow's deferred nodes, over the saved graph's own edges
 * rather than `run_deps`, because such a node has no run and so no dependency
 * rows yet. One reachability rather than two, for the reason there is one
 * `topologicalOrder`.
 */
export function revivableDependents(
  roots: readonly string[],
  candidates: readonly string[],
  links: readonly DependencyLink[],
): string[] {
  const dependents = new Map<string, string[]>();
  for (const link of links) {
    const list = dependents.get(link.dependsOn);
    if (list) list.push(link.runId);
    else dependents.set(link.dependsOn, [link.runId]);
  }

  const eligible = new Set(candidates);
  const woken = new Set<string>();
  const frontier = [...roots];

  while (frontier.length > 0) {
    const id = frontier.pop() as string;
    for (const next of dependents.get(id) ?? []) {
      if (!eligible.has(next) || woken.has(next)) continue;
      woken.add(next);
      frontier.push(next);
    }
  }

  return [...woken];
}

/**
 * Queue every waiting run whose dependencies have settled, and end every one
 * whose dependencies can no longer settle in its favour.
 *
 * Called from every path that puts a run into a terminal status — `startRun`'s
 * `finally`, both of `stopRun`'s early branches, and the sweeper's
 * never-clearing verdict. Missing one leaves a dependent asleep with nothing
 * that will ever wake it, which is the failure this whole status exists to have
 * none of. `reconcileOnBoot` is the one deliberate exception and says why.
 *
 * Released runs join the queue rather than starting here, so folder
 * reservation, FIFO order and the concurrency cap stay in `promoteQueued` —
 * the same reason `sweepPaused` re-queues rather than calling `startRun`.
 *
 * The outer loop exists because admitting a released run can *fail* — its
 * repository can have moved since it was created — and a run that fails is
 * itself a settled dependency for whatever was waiting on it. Each pass takes
 * at least one row out of `waiting`, so it terminates.
 */
export function releaseDependents(): boolean {
  let changed = false;
  while (releasePass()) changed = true;

  // A workflow's orchestrator blocks wait on the same terminal transitions this
  // function exists to react to, so they are woken from the same place rather
  // than from a list of call sites that would have to be kept in step with the
  // five above. Imported here for `enforceInstanceBudget`'s reason —
  // `workflows.ts` imports this module — and deliberately not awaited: the
  // advance is its own synchronous pass in a later turn, so nothing it does can
  // interleave with a folder claim being made in this one.
  void import("./workflows")
    .then((m) => m.advanceInstances())
    .catch(() => {
      /* a workflow that cannot be advanced is not a reason to fail a run */
    });

  return changed;
}

function releasePass(): boolean {
  const waiting = db()
    .prepare("SELECT * FROM runs WHERE status = 'waiting' ORDER BY created_at")
    .all() as RunRow[];
  if (waiting.length === 0) return false;

  const links = db()
    .prepare(
      `SELECT run_id AS runId, depends_on AS dependsOn, edge FROM run_deps
        WHERE run_id IN (SELECT id FROM runs WHERE status = 'waiting')`,
    )
    .all() as DependencyLink[];

  const states = db()
    .prepare(
      `SELECT id, status, iterations FROM runs
        WHERE status = 'waiting'
           OR id IN (SELECT depends_on FROM run_deps
                      WHERE run_id IN (SELECT id FROM runs WHERE status = 'waiting'))`,
    )
    .all() as DependencyState[];

  const { release, block } = releasableRuns(states, links, newWorkPaused());
  let acted = false;

  for (const { id, reason } of block) {
    if (blockWaitingRun(id, reason)) acted = true;
  }

  for (const id of release) {
    const run = waiting.find((r) => r.id === id);
    if (run && admitWaiting(run)) acted = true;
  }

  return acted;
}

/**
 * End a run that has not started, in the status that says nothing was spent.
 *
 * `blocked` rather than `stopped`: it is what this app already writes for a run
 * refused before its first work cycle, and it says the true thing — nothing ran,
 * nothing was spent. The reason names whatever stopped it, and the cascade gives
 * every run behind it its own sentence naming the one in front rather than one
 * shared verdict.
 *
 * Guarded on `status='waiting'` and reported by its return value, because two
 * callers now reach it — the dependency cascade and a workflow instance being
 * halted — and a row that left `waiting` between the decision and the write must
 * not be rewritten by the loser. False means the row moved; it is not an error.
 */
export function blockWaitingRun(id: string, reason: string): boolean {
  const done = db()
    .prepare(
      "UPDATE runs SET status='blocked', finished_at=?, stop_reason=? WHERE id=? AND status='waiting'",
    )
    .run(Date.now(), reason, id);
  if (done.changes !== 1) return false;
  emit({
    runId: id,
    ts: Date.now(),
    kind: "status",
    payload: { status: "blocked", stop_reason: reason },
  });
  return true;
}

/**
 * Runs belonging to a workflow run somebody halted, and the workflow's name.
 *
 * One condition rather than one per caller, because the two that read it — the
 * refusal in `reopenRun` and the candidate set in `reviveBlockedDependents` —
 * have to mean the same thing by "halted", or a run refused on its own page is
 * woken anyway by reopening the run in front of it.
 *
 * `stopping` is the whole test, and covers a halt that has finished: `stopped`
 * is derived at read time from whether any member is still live, so the stored
 * row says `stopping` for the rest of its life (see `WorkflowInstanceStatus`).
 * `failed` is deliberately not here — that instance was rolled back as it was
 * created, no member of it ever ran, and nothing was halted.
 */
const HALTED_MEMBERS =
  `SELECT w.run_id AS runId, i.workflow_name AS workflowName
     FROM workflow_instance_runs w
     JOIN workflow_instances i ON i.id = w.instance_id
    WHERE i.status = 'stopping'`;

/**
 * The halted workflow this run was taken down with, or null for every other
 * run — one started outside a workflow, or a member of an instance still going.
 *
 * Here rather than beside `guardedInstanceOf` in `workflows.ts`, which does the
 * same join for the budget guard: that module already imports this one, and one
 * indexed lookup is not worth a cycle between them.
 */
export function haltedWorkflowOf(runId: string): string | null {
  const row = db()
    .prepare(`SELECT workflowName FROM (${HALTED_MEMBERS}) WHERE runId = ?`)
    .get(runId) as { workflowName: string } | undefined;
  return row?.workflowName ?? null;
}

/**
 * Put every run blocked behind `roots` back to `waiting`, so the next release
 * pass decides it again on what is true now.
 *
 * Deliberately not a release: this reopens the *question*, and `releasePass`
 * still answers it. A dependency that is now satisfied admits the run; one that
 * is still terminal re-blocks it within the same call, with a sentence about
 * the current ending rather than the one that has since been undone. So the
 * worst this can do is rewrite a stale reason, and the row never skips the
 * admission that plans its workspace.
 *
 * `work_dir IS NULL` is one half of the safety condition and
 * `revivableDependents` says why: a run refused by its own guard is `blocked`
 * with a checkout already allocated, and must not be sent back through
 * `admitWaiting`. Membership of a halted workflow is the other half, and it is
 * here rather than in the pure function for the same reason the first one is —
 * this is a fact about the row, not about the shape of the graph. `stopInstance`
 * writes `blocked` onto exactly the members this would otherwise select, and a
 * workflow run is halted whole: waking one member would put an agent back to
 * work under an instance the page reports as stopped, where the instance budget
 * guard — which acts only on a `started` instance — could no longer stop it.
 *
 * The count is of *runs*, and the blocks are counted by the function that
 * reopens them: half a workflow's graph is not runs at all — a node deferred
 * behind an orchestrator or a merge block holds a row in
 * `workflow_instance_blocks` and nothing in the candidate set above can ever
 * name one — so `reviveBlockedBlocks` is the other half of this same question
 * and is asked here rather than from a second call site.
 */
export function reviveBlockedDependents(roots: readonly string[]): number {
  if (roots.length === 0) return 0;

  const candidates = (
    db()
      .prepare(
        "SELECT id FROM runs WHERE status='blocked' AND work_dir IS NULL AND iterations = 0" +
          ` AND id NOT IN (SELECT runId FROM (${HALTED_MEMBERS}))`,
      )
      .all() as Array<{ id: string }>
  ).map((r) => r.id);

  const woken: string[] = [];
  if (candidates.length > 0) {
    const links = db()
      .prepare("SELECT run_id AS runId, depends_on AS dependsOn, edge FROM run_deps")
      .all() as DependencyLink[];

    for (const id of revivableDependents(roots, candidates, links)) {
      const done = db()
        .prepare(
          "UPDATE runs SET status='waiting', finished_at=NULL, stop_reason=NULL" +
            " WHERE id=? AND status='blocked'",
        )
        .run(id);
      if (done.changes !== 1) continue;
      woken.push(id);
      emit({
        runId: id,
        ts: Date.now(),
        kind: "status",
        payload: {
          status: "waiting",
          message:
            "Waiting again: a run it depends on was picked up, so what blocked it is being decided afresh.",
        },
      });
    }
  }

  // The deferred half of every workflow those runs belong to, and the runs just
  // woken are roots for it too: a chain runs through both tables — a node
  // created from the ledger is an ordinary run, and what is deferred behind it
  // is not — so a block behind a run this call revived was written off by the
  // same ending and is the same question again.
  //
  // Imported here for `releaseDependents`' reason — `workflows.ts` imports this
  // module — and not awaited for its reason either. Nothing depends on the
  // order: what the revive reopens is only decided when the reopened run next
  // reaches a terminal status, which is the whole of a work cycle away.
  void import("./workflows")
    .then((m) => m.reviveBlockedBlocks([...roots, ...woken]))
    .catch(() => {
      /* a workflow that cannot be reached is not a reason to refuse a reopen */
    });

  return woken.length;
}

/**
 * Give a released run its workspace and put it in the queue.
 *
 * Synchronous from the plan to the UPDATE, for the reason `createRun` is: the
 * checkout slot this picks is claimed by the same statement that records it.
 */
function admitWaiting(run: RunRow): boolean {
  let plan: IsolationPlan;
  let workDir: string;
  try {
    // `isolation === 'none'` on a waiting row is the operator's own answer,
    // recorded at creation; anything else means the question was deferred.
    //
    // The predecessor is read *now* rather than at admission because this is
    // the first moment its branch exists: it may itself have been waiting, and
    // its whole isolation plan was deferred for the same reason this one was.
    ({ plan, workDir } = planWorkspace(
      run.id,
      run.folder,
      run.isolation !== "none",
      run.continues_run ? predecessorOf(run.continues_run) : null,
    ));
  } catch (err) {
    const reason = `Its dependencies cleared, but its workspace could not be prepared: ${
      err instanceof Error ? err.message : String(err)
    }`;
    const failed = db()
      .prepare(
        "UPDATE runs SET status='failed', finished_at=?, stop_reason=? WHERE id=? AND status='waiting'",
      )
      .run(Date.now(), reason, run.id);
    if (failed.changes !== 1) return false;
    emit({
      runId: run.id,
      ts: Date.now(),
      kind: "status",
      payload: { status: "failed", stop_reason: reason },
    });
    return true;
  }

  const flip = db()
    .prepare(
      "UPDATE runs SET status='queued', work_dir=?, isolation=?, repo_root=?," +
        " worktree_path=?, worktree_branch=?, worktree_base=?, worktree_base_branch=?" +
        " WHERE id=? AND status='waiting'",
    )
    .run(
      workDir,
      plan.mode,
      plan.repoRoot ?? null,
      plan.worktreePath ?? null,
      plan.branch ?? null,
      plan.base ?? null,
      plan.baseBranch ?? null,
      run.id,
    );
  if (flip.changes !== 1) return false;

  if (plan.reason) log(run.id, plan.reason);
  emit({
    runId: run.id,
    ts: Date.now(),
    kind: "status",
    payload: {
      status: "queued",
      isolation: plan.mode,
      ...(plan.reason ? { isolationReason: plan.reason } : {}),
      message: "Everything it was waiting for has finished; joining the queue.",
    },
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Claude Code invocation — moved to ./cycleInvocation                 */
/* ------------------------------------------------------------------ */

export {
  MAX_NEEDS_REVIEW_REASON,
  NEEDS_REVIEW_NOTICE,
  SEARCH_TOOLS,
  buildArgs,
  cycleEnding,
  nextPrompt,
  startsFresh,
} from "./cycleInvocation";
export type { CycleEnding } from "./cycleInvocation";

/* ------------------------------------------------------------------ */
/* What a compaction took, read off the argv that put it there          */
/* ------------------------------------------------------------------ */

/**
 * The CLI version Anthropic's compaction survival table pins itself to.
 *
 * The table says which parts of a window survive a compaction — system prompt
 * unchanged, project-root `CLAUDE.md` re-injected from disk, `paths:`-scoped
 * rules lost until a matching file is read again, invoked skill bodies
 * re-injected under a cap, the skill listing not re-injected at all. It is
 * **documentation carrying no measurement of any kind**, and it is pinned here
 * rather than compared against `Dockerfile`'s `CLAUDE_CLI_VERSION` on purpose:
 * what matters is not what this image installs but what version wrote the
 * boundary record being described, which the record itself carries.
 *
 * Sourced at `proposals/ContextControl/01-constraints.md`, which audits the
 * table row by row against this app's own argv.
 */
export const SURVIVAL_TABLE_CLI_VERSION = "2.1.198";

/**
 * One thing this app put into a run's window, and what the table says became of
 * it at a compaction.
 */
export interface WindowInjection {
  /** What it is, in the words an operator reading a run log would recognise. */
  what: string;
  /** The argv flag that carried it. */
  via: string;
  fate: "survives" | "reinjected" | "lost" | "unknown" | "unclassified";
  /** The table's own row, or the reason there is not one. */
  note: string;
}

/**
 * How many values each flag this app emits consumes.
 *
 * The arity is here rather than inferred from "does the next token start with a
 * dash", because two of these flags carry *generated text* as their value —
 * `-p` a whole prompt and `--append-system-prompt` two notices — and a value
 * that happened to begin with a dash would otherwise be read as a flag and
 * reported as unclassified. `many` consumes to the next `--`, which is what the
 * CLI's own variadic options do and what `--allowedTools` and `--add-dir` are.
 *
 * **Every flag `buildArgs` and `sandboxArgs` emit must appear here.** That is
 * the whole anti-drift property of `injectionFates`: a flag with no entry is
 * reported as unclassified rather than silently dropped from the record, so the
 * first change to `buildArgs` that adds an injection says so on the run's log
 * instead of quietly falling out of it.
 */
const ARGV_ARITY: Record<string, "none" | "one" | "many"> = {
  "-p": "one",
  "--output-format": "one",
  "--verbose": "none",
  "--model": "one",
  "--permission-mode": "one",
  "--forward-subagent-text": "none",
  "--agents": "one",
  "--agent": "one",
  "--allowedTools": "many",
  "--disallowedTools": "many",
  "--append-system-prompt": "one",
  "--plugin-dir": "one",
  "--add-dir": "many",
  "--resume": "one",
  "--autocompact": "one",
  "--max-budget-usd": "one",
  "--settings": "one",
};

/** Every flag above that carries no text into the model's context window. */
const CARRIES_NO_CONTEXT = new Set([
  // Stream shape and model selection.
  "--output-format",
  "--verbose",
  "--model",
  "--forward-subagent-text",
  // Capabilities and grants, not text: `--allowedTools` names what skips a
  // prompt, `--add-dir` names a directory the session may reach, and neither
  // puts anything in the window that a compaction could take.
  "--permission-mode",
  "--allowedTools",
  "--disallowedTools",
  "--add-dir",
  // The conversation itself, which is the thing being summarised rather than
  // something injected into it, and the threshold that decides when.
  //
  // `--autocompact` is no longer emitted — `contextPruning.ts` replaced it — but
  // it stays in both this set and `ARGV_ARITY`, because these two describe how
  // to *read* an argv and every cycle spawned before that change stored one
  // carrying the flag. Dropping it here would make those historical rows report
  // an unclassified flag and a stray `200000`.
  "--resume",
  "--autocompact",
  "--max-budget-usd",
  // Hooks and a sandbox write set. The table's own row: "Hooks — not
  // applicable; hooks run as code, not context."
  "--settings",
]);

/**
 * Every flag below that this function turns into a row.
 *
 * Held apart from the `switch` that reads them so that the two sets can be
 * checked against `ARGV_ARITY`: a flag with an arity but in neither set is a
 * flag somebody taught this function to *parse* without deciding whether it
 * injects anything, and it reports itself rather than passing as non-context.
 */
const CLASSIFIED_INJECTIONS = new Set([
  "-p",
  "--append-system-prompt",
  "--agents",
  "--agent",
  "--plugin-dir",
]);

/**
 * What this run's own argv put in the window, classified against the table.
 *
 * **Derived from the argv rather than from a list of what this app injects**,
 * which is the difference between a record that stays true and one that is
 * wrong the first time `buildArgs` changes. A cycle spawned without plugins
 * reports no skills; a cycle spawned with three plugin directories reports
 * three; and a flag this function has never been taught reports itself as
 * unclassified.
 *
 * Unclassified rows sort first, because `log()` cuts a message at
 * `MAX_LOG_CHARS` and the one row that asks somebody to do something is the one
 * that must not be the row that got cut.
 *
 * Nothing here is measured. Every `note` is the vendor's documentation quoted
 * back, and `compactionNotice` is what says so — no caller should render these
 * rows without it.
 */
export function injectionFates(argv: readonly string[]): WindowInjection[] {
  const rows: WindowInjection[] = [];
  const unclassified: WindowInjection[] = [];
  const pluginDirs: string[] = [];
  let appendedPrompt: string | null = null;
  let agentDefinition = false;
  let agentName: string | null = null;
  let prompt: string | null = null;
  let unknownFlag: string | null = null;
  let previousFlag: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const arity = ARGV_ARITY[flag];

    if (arity === undefined) {
      if (flag.startsWith("-")) {
        unknownFlag = flag;
        unclassified.push({
          what: `whatever ${flag} carries`,
          via: flag,
          fate: "unclassified",
          note:
            "This app emits it and nothing here has a row for it. Give it one, or record in `ARGV_ARITY` and `CARRIES_NO_CONTEXT` that it carries no context.",
        });
      } else if (unknownFlag === null) {
        // A bare token that did not follow an unknown flag followed a *known*
        // one, which means the arity recorded for it is short — and that is the
        // failure that silently turns a value into a flag and back again. One
        // row per unknown flag, so an unknown flag's own values do not each add
        // one.
        unclassified.push({
          what: `a value this function did not expect: ${flag}`,
          via: previousFlag ?? flag,
          fate: "unclassified",
          note: "`ARGV_ARITY` records fewer values for this flag than the argv carries.",
        });
      }
      continue;
    }

    unknownFlag = null;
    previousFlag = flag;

    const values: string[] = [];
    if (arity === "one") {
      values.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arity === "many") {
      // Stops at any token starting with a dash, not only at `--`: `-p` is the
      // one short flag on this argv and a variadic scan that ate it would drop
      // the prompt from the record. Every variadic value this app emits is a
      // tool name or an absolute path, so none can be mistaken for a flag.
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        values.push(argv[i + 1]);
        i += 1;
      }
    }

    switch (flag) {
      case "-p":
        prompt = values[0] ?? "";
        break;
      case "--append-system-prompt":
        appendedPrompt = values[0] ?? "";
        break;
      case "--agents":
        agentDefinition = true;
        break;
      // A name, carrying no text of its own — but the definition it selects
      // becomes the session's system prompt, so the row belongs to `--agents`
      // and this is only what makes the line readable.
      case "--agent":
        agentName = values[0] ?? null;
        break;
      case "--plugin-dir":
        if (values[0]) pluginDirs.push(values[0]);
        break;
    }

    if (!CARRIES_NO_CONTEXT.has(flag) && !CLASSIFIED_INJECTIONS.has(flag)) {
      unclassified.push({
        what: `whatever ${flag} carries`,
        via: flag,
        fate: "unclassified",
        note:
          "This function parses it and has not decided whether it injects anything. Give it a row, or name it in `CARRIES_NO_CONTEXT`.",
      });
    }
  }

  if (appendedPrompt !== null) {
    rows.push({
      what: `the appended system prompt (${appendedPrompt.length} characters)`,
      via: "--append-system-prompt",
      fate: "survives",
      note: "System prompt and output style — unchanged; not part of message history.",
    });
  }

  if (agentDefinition) {
    rows.push({
      what: agentName
        ? `the definition of the agent this run is, "${agentName}"`
        : "the definition of the agent this run is",
      via: "--agents",
      fate: "survives",
      note: "Same row: it becomes the session's system prompt, which is not part of message history.",
    });
  }

  for (const dir of pluginDirs) {
    rows.push({
      what: `skill bodies from ${dir}`,
      via: "--plugin-dir",
      fate: "reinjected",
      note:
        "Invoked skill bodies — re-injected, capped at 5,000 tokens per skill and 25,000 in total, oldest dropped first, and a truncated body keeps the start of the file.",
    });
    rows.push({
      what: `the listing that told this cycle those skills exist (${dir})`,
      via: "--plugin-dir",
      fate: "lost",
      note:
        "The skill listing itself is not re-injected. A cycle that had not yet invoked a skill loses the entry saying it is there.",
    });
  }

  if (prompt !== null) {
    rows.push({
      what: `this work cycle's prompt (${prompt.length} characters), and any ending contract inside it`,
      via: "-p",
      fate: "unknown",
      note:
        "No row in the table. Message history is the thing a compaction rewrites, so what is left of it is whatever the summariser kept.",
    });
  }

  return [...unclassified, ...rows];
}

/**
 * One log line for a compaction, and the sentence that keeps it honest.
 *
 * The honesty is the point of the function rather than a caveat on it. The
 * classification above is a vendor table with no measurement behind it, pinned
 * to one CLI version, and the record being described says which version
 * actually compacted the conversation. Where those differ — which is every
 * install of this app today, since it pins a later CLI — the notice has to read
 * as a hypothesis, because an operator who takes it as a reading of their own
 * install will trust a row that was never tested here.
 *
 * It states no judgement about the conversation and quotes none of it: what was
 * summarised is between the run and its own agent, and this app does not read
 * it. `preTokens`/`postTokens` are the summariser's accounting of a window and
 * are never a cost — nothing in this notice reaches `runs.spent_usd`, a
 * snapshot or a guard.
 */
export function compactionNotice(
  boundary: CompactionBoundary,
  injections: readonly WindowInjection[],
): string {
  const seconds = (boundary.durationMs / 1000).toFixed(0);
  const trigger = boundary.trigger || "an unnamed trigger";
  const head =
    `Claude Code compacted this run's conversation (${trigger}): ` +
    `${boundary.preTokens.toLocaleString("en-US")} tokens summarised down to ` +
    `${boundary.postTokens.toLocaleString("en-US")}, taking ${seconds}s.`;

  const version = boundary.cliVersion || "an unreported version";
  const basis =
    boundary.cliVersion === SURVIVAL_TABLE_CLI_VERSION
      ? `Anthropic documents the following for CLI ${SURVIVAL_TABLE_CLI_VERSION}, which is the version that compacted this conversation. It is documentation and not a measurement of this install.`
      : `What follows is what Anthropic documents for CLI ${SURVIVAL_TABLE_CLI_VERSION}; this conversation was compacted by ${version}. Nothing here was measured on this install, so read every line as a hypothesis about it.`;

  const lines = injections.map((i) => `  ${i.fate}: ${i.what} (${i.via}) — ${i.note}`);

  return [head, basis, ...lines].join("\n");
}

/* ------------------------------------------------------------------ */
/* What one child may write                                            */
/* ------------------------------------------------------------------ */

/**
 * A write set, or the reason there is not one.
 *
 * Two states rather than a `string[]`, because an overlay that named nothing
 * must not be able to reach an argv looking like a boundary. `10-validation.md`
 * read `if(!n&&!M&&!N&&!D&&!U) return t;` out of the pinned binary: a policy
 * with no network entry, no read or write restriction and no credential entry
 * hands the command back **unwrapped**, and `sandbox.failIfUnavailable` does not
 * catch it — a sandbox nothing was asked of is not one that failed. So a set
 * that resolved to nothing says so as its own state, the same rule
 * `sandboxArrangement`'s `empty` reading takes one door over.
 */
export type SandboxPolicy =
  | { kind: "confined"; allowWrite: string[] }
  | { kind: "unconfined"; reason: string };

/**
 * Which child is being confined, which is the whole of what differs between the
 * three sets.
 *
 * One union and one function rather than three, so the difference between them
 * is an argument a reader can see beside the others rather than a second code
 * path that drifted. There are four kinds of child (`docs/agent/architecture.md`)
 * and three of them spawn a `claude`; `git.ts`'s two spawn git, which reads no
 * settings file and takes no overlay.
 */
export type SandboxScope =
  /** A work cycle, in its own checkout. */
  | { kind: "run"; workDir: string; repoRoot: string | null }
  /** `review.ts`'s one spawn, which serves the reviewer and the resolver. */
  | { kind: "assist"; cwd: string; permissionMode: "plan" | "acceptEdits" }
  /** `chat.ts`'s one spawn, which serves a chat turn and an orchestrator block. */
  | { kind: "chat"; dirs: readonly string[] };

/**
 * Characters that make the CLI throw a `sandbox.filesystem` entry away.
 *
 * Glob patterns in that block are **silently dropped on Linux** — `"Skipping
 * glob pattern on Linux/WSL: ${n}"`, filtered out of `allowWrite` and
 * `denyWrite` both (`10-validation.md`). Nothing this app names is written as a
 * pattern, and `settings.isolationCopyGlobs` — `[".env", ".env.*",
 * "!.env.example"]` — never reaches here, because what it copies lands *inside*
 * the checkout that is already named as one literal path. What can still arrive
 * is a folder whose own name carries one of these characters: a literal path to
 * this app, a pattern to the CLI, and gone with a debug log.
 *
 * The entry that goes missing that way is the run's own checkout, so the whole
 * set is refused rather than emitted short — a boundary with a hole in exactly
 * the place the boundary exists for is the more expensive of the two ways this
 * is wrong, and the run still works without an overlay.
 */
const SANDBOX_GLOB_CHARS = /[*?[\]{}!]/;

/**
 * Where a toolchain writes that is neither the checkout nor this app's.
 *
 * A write config of any kind makes the CLI bind `/` read-only and rw-bind only
 * the allow set (`10-validation.md`), so every path a build touches has to be
 * named or the build fails inside a tool call the run loop does not read —
 * `docs/verification.md` names these two by name as the ones the set left out.
 * npm's cache is `$HOME/.npm` and Go's is under `GOPATH`, which the image points
 * at a named volume so it survives a container it is meant to outlive.
 *
 * Read off the *environment* rather than written as literals, because the uid
 * that owns them is not the one asking: the server runs as root under compose
 * and the children run as `UF_AGENT_UID`, while `HOME` is `/home/node` for both
 * — which is what makes `os.homedir()` the right answer here and would make
 * `/root/.npm` the silent wrong one.
 *
 * Given to the two children that build. The reviewer installs nothing and the
 * chat is told to look rather than work, so neither is handed a cache it would
 * only fill.
 */
const BUILD_CACHE_DIRS = [
  path.join(os.homedir(), ".npm"),
  process.env.GOPATH || path.join(os.homedir(), "go"),
];

/**
 * The overlay this child gets, on top of a managed policy it cannot weaken.
 *
 * `/etc/claude-code/managed-settings.json` is what enables the sandbox at all —
 * written by `docker-entrypoint.sh` under `UF_SANDBOX=1`, root-owned, and the
 * one policy surface an agent's uid cannot rewrite. This is the per-child half:
 * `--settings` is an honored source for `filesystem.allowWrite` where a
 * repository's own `.claude/settings.json` is ignored for these keys, so the
 * install-wide policy says what nobody may do and this says what *this* child
 * may write.
 *
 * **It is decorative until `~/.claude` stops being agent-writable, and nobody
 * should read it as a boundary before that lands.** `~/.claude/settings.json`
 * is an honored source for `sandbox.filesystem` too and is writable by
 * `UF_AGENT_UID` today (`10-validation.md`, finding 1): a run appends
 * `{"sandbox":{"filesystem":{"allowWrite":["/"]}}}` and the next session — its
 * own and every sibling's — is confined to nothing. Closing it means root-owning
 * the directory itself and handing back the entries the CLI writes, which is a
 * separate piece of work, deliberately after this one because it runs against a
 * bind-mounted host directory the operator also uses and every entry missed
 * shows up as a dashboard of zeros rather than an error. `docs/verification.md`
 * carries it as the dependency it is.
 *
 * **And what nothing here settles either way:** whether the CLI's sandbox wraps
 * the whole session or only Bash (`09-implementation-sketch.md`, Phase 1
 * question 3, never executed). If it is Bash-only, a model using `Edit` against
 * a sibling's path is unconfined whatever this names. The evidence points both
 * ways — the Bash tool's own prompt says "your command will be run in a
 * sandbox", and a `getFsReadConfig` export is the shape a file tool consults —
 * so this asserts neither.
 *
 * Pure, and unit-tested on `CLAUDE.md`'s rule: both ways of being wrong are
 * silent. Too narrow fails inside a tool call the run loop does not read, which
 * is a cycle that spends money and writes nothing; too wide is a boundary that
 * is not there, which is the thing this exists to be. Reading what the install
 * is configured with is `currentSandbox()`, and emitting the argv is
 * `sandboxArgs` — both kept out of here so the decision can be asked without a
 * filesystem.
 */
export function sandboxSettings(scope: SandboxScope): SandboxPolicy {
  switch (scope.kind) {
    case "run":
      return writeSet(
        [
          // This cycle's own checkout — the worktree when isolated, the folder
          // the operator picked when not. The path the loop re-proved inside
          // its mount immediately before the spawn, not the row it was read
          // from hours earlier.
          scope.workDir,
          // **And the repository's real git directory, which widens the
          // boundary past this checkout.** A worktree's `.git` is a file
          // holding `gitdir: <repo>/.git/worktrees/<slug>`
          // (`01-constraints.md`), so an isolated run cannot commit — the thing
          // the isolation preamble orders it to do — unless the repository's
          // own `.git` is writable. The set is therefore "this repository", not
          // "this checkout": two runs on one repository can still rewrite each
          // other's refs, and confining the checkout does not confine the
          // branch. Only a per-run clone would, and that is a different
          // proposal. Named as it is rather than pretended narrower.
          scope.repoRoot === null ? null : path.join(scope.repoRoot, ".git"),
          // And the toolchain caches, which are not this run's work and are
          // where a first `npm install` or `go build` writes. Named for the
          // two children that build; the reviewer never installs anything and
          // the chat is told not to.
          ...BUILD_CACHE_DIRS,
        ],
        "a run with no working directory",
      );

    case "assist":
      // Two children through one spawn, and the difference is the mode. The
      // reviewer runs `--permission-mode plan` and writes nothing at all, so
      // its set is the transcript directory below and nothing else — a
      // read-only child, spelled as one. The conflict resolver runs
      // `acceptEdits` and edits conflict markers in a throwaway checkout
      // (`land.ts`), so that checkout is named and the repository's `.git` is
      // deliberately **not**: it is not asked to run git, and the merge commit
      // is made by this server afterwards once the result has been checked —
      // and, for the resolver only, the toolchain caches, since
      // `settings.resolveVerifyTools` is the operator naming a build command
      // for it to run against the merge it wrote.
      return writeSet(
        scope.permissionMode === "plan" ? [] : [scope.cwd, ...BUILD_CACHE_DIRS],
        "an assist with no working directory",
      );

    case "chat":
      // Deliberately much wider, and the reason is not this function's to
      // narrow. The chat already passes `--add-dir` for every mount that exists
      // and runs `--permission-mode bypassPermissions` (`chat.ts`), because an
      // orchestrator has to be able to look at what an operator has before it
      // proposes work against it. What bounds that child is its MCP tool
      // surface, a capability token that dies with the turn and
      // `chatTurnBudgetUSD` — not its filesystem. A write set narrower than its
      // `--add-dir` list would be this app quietly disagreeing with itself, so
      // the same array is handed to both.
      return writeSet(scope.dirs, "a chat turn with no mounts");
  }
}

/**
 * One set, spelled as absolute literal paths and never as anything else.
 *
 * `CLAUDE_CONFIG_DIR` is added here rather than at the three call sites, so that
 * no call site can leave it out. **It is the metering path.** Every window,
 * every meter and every budget guard but one is derived from the transcripts the
 * CLI writes under it (`scanUsage`, `transcripts.ts`), and a write set that
 * forgets it produces a dashboard of zeros rather than an error —
 * `01-constraints.md` names that as the sharpest way to get this wrong, because
 * nothing throws, nothing fails to typecheck and every page still renders.
 *
 * It is also the directory the hole in `sandboxSettings`' note lives in, which
 * is the constraint pointing both ways at once: metering needs it writable by
 * the agent's uid, policy integrity needs the settings file inside it not to be.
 * The resolution is per-entry ownership, and it is not this function's.
 *
 * The temporary directory is here for the same "no call site can leave it out"
 * reason, and it is not this app's path at all — it is the **sandbox's own**.
 * Measured inside a container running a live policy: a sandboxed session
 * creates `cc-socks/` and `srt-mux-<pid>-0.sock` there, plus `claude-<uid>/`
 * for its own state, all owned by the agent's uid. So a child that cannot write
 * it has a `Bash` tool that fails for a reason with nothing to do with what it
 * was asked to do — which is why `scripts/sandbox-probe/probe.sh` names it in
 * all six of its allowlists, and why it is given even to the reviewer, whose
 * set is otherwise empty and which still runs read-only shell under `plan`.
 * (Shell *snapshots* are not the reason: those go to
 * `$CLAUDE_CONFIG_DIR/shell-snapshots`, which is already named.)
 *
 * `os.tmpdir()` rather than the literal, because the child inherits this
 * process's `TMPDIR` and the CLI resolves its own paths the same way: an
 * install that sets one would otherwise have a write set naming a directory
 * nothing uses.
 */
function writeSet(paths: readonly (string | null)[], empty: string): SandboxPolicy {
  const allowWrite: string[] = [];

  for (const candidate of [...paths, CLAUDE_CONFIG_DIR, os.tmpdir()]) {
    if (candidate === null || candidate === "") continue;
    // A relative entry is not a path the CLI can bind either, and this app's
    // own paths are absolute — one arriving here means a caller passed
    // something it had not resolved, which is a set that would confine the
    // wrong tree rather than one that fails.
    if (!path.isAbsolute(candidate)) {
      return { kind: "unconfined", reason: `${candidate} is not an absolute path` };
    }
    if (SANDBOX_GLOB_CHARS.test(candidate)) {
      return {
        kind: "unconfined",
        reason: `${candidate} reads as a glob pattern, which this CLI drops from a write set on Linux`,
      };
    }
    if (!allowWrite.includes(candidate)) allowWrite.push(candidate);
  }

  return allowWrite.length > 0
    ? { kind: "confined", allowWrite }
    : { kind: "unconfined", reason: empty };
}

/**
 * The overlay as argv, or nothing at all.
 *
 * Withheld on two readings, and they are different failures. An `unconfined`
 * policy is a set this app could not spell, and an empty `sandbox.filesystem`
 * would be worse than no flag: it is the short-circuit above, a policy that
 * resolves to nothing and runs every command unwrapped while an operator reads
 * a boot line saying the sandbox is on. A `none` arrangement is an install with
 * no managed policy at all — the stock one, and every install today — where
 * naming paths configures a sandbox that is not enabled. Withholding it there
 * keeps a stock install's argv byte-identical to what it was, which is what
 * confines the risk of this change to the operators who asked for a sandbox.
 *
 * Emitted for every other reading, `unknown` included: a policy file that cannot
 * be read is not evidence that there is no policy, and naming paths against a
 * sandbox that turns out not to exist costs nothing where withholding them from
 * one that does is the boundary going missing.
 *
 * **It never carries `sandbox.enabled`.** Switching a sandbox on belongs to the
 * managed file the entrypoint writes from `UF_SANDBOX`, because the binary
 * rewrites an enabled policy that omits `failIfUnavailable` to `true`
 * (`10-validation.md`, finding 16) — so an `enabled` on this argv would make
 * every `claude` invocation on an install without bubblewrap exit non-zero,
 * fleet-wide, from a flag no operator can edit. This names paths and nothing
 * else.
 *
 * JSON on the argv rather than a file: `--settings` takes `<file-or-json>`, a
 * file would be a per-child lifecycle to write, chown and remove for something
 * that carries no secret, and nothing here goes through a shell.
 */
export function sandboxArgs(policy: SandboxPolicy, arrangement: SandboxStateDTO): string[] {
  if (arrangement === "none") return [];
  if (policy.kind !== "confined") return [];
  return [
    "--settings",
    JSON.stringify({ sandbox: { filesystem: { allowWrite: policy.allowWrite } } }),
  ];
}

/** The overlay for a child spawned right now, against this install's policy. */
export function sandboxArgsFor(scope: SandboxScope): string[] {
  return sandboxArgs(sandboxSettings(scope), currentSandbox().state);
}

/**
 * Environment for the spawned agent.
 *
 * The child is a full Claude Code session with tool access, so it can read its
 * own environment and so can anything it runs. Two classes are withheld:
 *
 *   `UF_*`, `ANTHROPIC_ADMIN_KEY` — UsageFoundry's own configuration. The
 *   Admin API key is an organisation-wide credential with no bearing on the
 *   task the agent was given, and `UF_AUTH_TOKEN` is the shared secret
 *   guarding this app. Excluding the whole `UF_` namespace means a future
 *   setting is withheld by default rather than by remembering to add it here.
 *
 *   `OTEL_*`, `CLAUDE_CODE_ENABLE_TELEMETRY` — telemetry routing is this
 *   app's decision, not an inheritance from whoever started the server.
 *   Otherwise an operator's ambient collector silently receives every run.
 *
 *   `DATA_DIR` — where this app's SQLite database lives, and the one exclusion
 *   here that the `UF_` namespace rule above does not cover, because the
 *   variable predates it and the CLI's own tooling reads the same name. An
 *   agent working on UsageFoundry itself routinely starts a dev server to check
 *   its work, and `next dev` runs `instrumentation.ts`, whose four reconcilers
 *   close out every row that says `running` on the grounds that its process
 *   died with the last server. Measured, not reasoned: one `setsid npm run dev`
 *   in a worktree marked three runs failed while their agents carried on
 *   working and billing for another minute, and the rows blamed a restart that
 *   never happened. Withheld, that second server falls back to `./.data`,
 *   writes an empty database of its own, and closes out nothing. `serverLock.ts`
 *   is the same failure guarded from the other side, for the routes this does
 *   not cover — a `.env` in the worktree, an agent that sets it by hand.
 *
 *   `NODE_OPTIONS` — compose sets it to give *this* process a stated heap
 *   ceiling, so that the container's `mem_limit` can be derived from a number
 *   rather than from whatever V8 chose off the host's RAM. The CLI is a Node
 *   program too, so inherited it would silently become every agent's heap
 *   ceiling as well — a figure with no measurement behind it for a process
 *   that holds a whole context window, and one whose failure is a fatal
 *   `heap out of memory` part-way through a billed cycle that the loop then
 *   files as the agent crashing. Withheld, a child keeps the default it has
 *   always had.
 *
 * Everything else passes through. The CLI needs PATH, HOME, CLAUDE_CONFIG_DIR,
 * proxy and CA settings, and locale to function at all, so an allowlist would
 * fail in ways that are tedious to diagnose from inside a container.
 */
/**
 * Environment variables that change what a run's conversation carries.
 *
 * All seven pass through `childEnv` untouched, and that is deliberate rather
 * than an oversight to fix: the strip list below exists for credentials and for
 * telemetry routing, and an operator who set one of these in their compose file
 * meant it. Stripping them would be this app overruling a configuration
 * decision it does not own.
 *
 * What was wrong was that nothing recorded it. Two installs whose compose files
 * differ by `CLAUDE_CODE_MAX_CONTEXT_TOKENS` run different context regimes, and
 * every page in this app rendered them identically — so a run whose agent
 * compacted at a third of the usual window, or whose `Read` output was capped
 * at a tenth, looked exactly like one that was not. Named on the run's own log
 * for `githubTokenFor`'s reason: nothing else in this app would ever mention
 * it.
 *
 * Not settings keys, and not compose keys. `docs/agent/environment.md` is
 * explicit that compose renders every optional variable as `${VAR:-}`, so
 * seven new keys would render blank on every stock install — and there is
 * nothing for this app to *decide* here, only something to report. A stock
 * install's argv, environment and boot warnings are byte-identical after this.
 *
 * Verified present in the pinned binary by the survey that found them
 * (`proposals/ContextControl/18-implementation-sketch.md`, phase 0a); this app
 * neither sets nor validates them, so a value the CLI rejects is still the
 * CLI's to reject.
 */
export const CONTEXT_SHAPING_ENV = [
  "DISABLE_AUTO_COMPACT",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS",
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "BASH_MAX_OUTPUT_LENGTH",
] as const;

/**
 * Which of those are set, and to what.
 *
 * Blank counts as unset, which is the same rule `env()`'s blank-is-the-answer
 * sibling in `config.ts` applies and the reason this cannot become a permanent
 * line on a stock install: compose renders an unset optional variable as the
 * empty string, and an empty string is not an operator naming a ceiling.
 */
export function contextShapingEnv(
  env: Record<string, string | undefined> = process.env,
): { key: string; value: string }[] {
  const set: { key: string; value: string }[] = [];
  for (const key of CONTEXT_SHAPING_ENV) {
    const value = env[key];
    if (value === undefined || value === "") continue;
    set.push({ key, value });
  }
  return set;
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("UF_") ||
      key.startsWith("OTEL_") ||
      key === "ANTHROPIC_ADMIN_KEY" ||
      key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
      key === "DATA_DIR" ||
      key === "NODE_OPTIONS"
    ) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

/**
 * Does this policy need telemetry to mean what it says?
 *
 * `run_cost` and `run_tokens` are on `LIVE_ENFORCEABLE_CODES`, but the figures
 * they compare against only move when a cycle's `result` event is folded in
 * after it ends. Under live enforcement that made them between-cycles guards
 * wearing a live label: an operator who asked to be stopped mid-cycle at $5 was
 * stopped at $5 plus a whole cycle, which is the bound they chose live
 * enforcement to escape. `telemetrySpendSince` is the only source that reports a
 * single run's spend while it is still spending, so for these policies it is not
 * an optional enrichment — it is the guard's input.
 *
 * The window fractions are not here: those move on every tick already, off a
 * fresh transcript scan, and a run's own turns land in that scan too.
 */
export function needsLiveSpendTelemetry(policy: BudgetPolicy): boolean {
  return (
    policy.enforcement !== "between-cycles" &&
    (policy.maxRunCostUSD !== null || policy.maxRunTokens !== null)
  );
}

/**
 * Telemetry variables for a run, or nothing when the setting is off.
 *
 * `childEnv` strips inherited `OTEL_*`, so these are the only ones that reach
 * the agent — telemetry routing is decided here or not at all. The base URL
 * carries no signal suffix because the CLI appends `/v1/logs` itself.
 *
 * `required` is set for a policy whose spend guards cannot be enforced without
 * it, and overrides the setting. `settings.telemetryForRuns` opts into
 * *reporting* — the dashboard card and the run card — and a run configured to
 * be stopped mid-cycle at a spending limit has separately asked for the one
 * thing that can do the stopping. Refusing such a run instead would be the
 * consistent alternative, but it would refuse a policy that works today; going
 * silently unenforced is the one option ruled out, because a guard that stops
 * guarding when an unrelated toggle is off is the failure `guardCostOf()`
 * exists to prevent for unpriced models. Nothing else changes: the records go
 * to this app's own endpoint, and `/api/usage` still gates its card on the
 * setting.
 *
 * The exporter authenticates with a capability scoped to this one run, never
 * with `UF_AUTH_TOKEN`. It used to carry that one: `childEnv` deletes `UF_*`
 * from the child's environment and this merge put the app's master credential
 * straight back, inside a variable `env` prints, for a Claude Code session with
 * `Bash` — and it opens `POST /api/runs`, `PUT /api/settings`, every other run's
 * diff and the approval route. `ingestTokenFor` mints something that opens one
 * thing instead: writing telemetry for this run. `middleware.ts` therefore
 * exempts the ingest path, and the route authenticates itself — the two go
 * together, exactly as they do for `/api/mcp`.
 *
 * Exported for the test that pins the absence: no value returned here may
 * contain `UF_AUTH_TOKEN`, and there is nothing else in the app that would
 * notice if one did.
 */
export function telemetryEnv(
  runId: string,
  required = false,
): Record<string, string> {
  if (!required && !getSettings().telemetryForRuns) return {};

  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_SELF_URL,
    // Well under the default 5s, so a killed iteration loses less of its
    // final batch. It cannot be eliminated: a SIGKILL flushes nothing.
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
    // Stamped onto every record so a captured payload still says which run it
    // claims to be. It is no longer what *decides* that: the ingest route takes
    // the run id off the capability below, so a record naming another run
    // cannot move spend onto it.
    OTEL_RESOURCE_ATTRIBUTES: `uf.run_id=${runId}`,
    // base64url, so no comma or `=` to break this header's own key=value list.
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${ingestTokenFor(runId)}`,
  };
}

/**
 * Answers git's credential request for github.com from `$GH_TOKEN`.
 *
 * A `!`-prefixed helper is a command git runs through a shell, with the
 * operation appended as an argument — hence the `test "$1" = get`, so `store`
 * and `erase` are no-ops rather than errors. The token is read from the
 * environment at call time instead of being baked into the value, so it never
 * appears in `git config --list` output the agent may paste into its own log.
 */
const GITHUB_CREDENTIAL_HELPER =
  `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"; }; f`;

/**
 * GitHub credentials for a work cycle, or nothing when no token is configured.
 *
 * Everything an agent does with GitHub — `gh issue view`, `git push`, opening a
 * pull request — needs a credential the container has no other way to get. The
 * `~/.claude` mount carries Claude's login and nothing else: no `~/.gitconfig`,
 * no `~/.ssh`, no `~/.config/gh`. So without this every one of those commands
 * fails, and it fails *inside* a tool call the run loop never inspects — the
 * cycle ends looking like the agent chose not to push.
 *
 * Three things are set, and each covers a different way that failure arrives:
 *
 *   `GH_TOKEN`/`GITHUB_TOKEN` — what the `gh` CLI reads. Both, because scripts
 *   and actions-derived snippets reach for either.
 *
 *   a credential helper for `https://github.com` — what plain `git` reads.
 *   Registered by *resetting the list first* (an empty value, then ours): a
 *   repository cloned on the host can carry `credential.helper` in its own
 *   config naming a program this image does not have — `osxkeychain` is the
 *   common one — and git consults helpers in configured order.
 *
 *   `url.…insteadOf` — an SSH remote rewritten to HTTPS. This container holds
 *   no key and reaches no agent, so `git@github.com:` can never authenticate
 *   here however the token is set; it is the difference between a repository
 *   cloned over SSH and one cloned over HTTPS, which is exactly the kind of
 *   difference that makes this fail on *some* runs and not others.
 *
 * All of it travels as `GIT_CONFIG_*` rather than being written to a config
 * file: the settings then apply to every git the agent runs, in whatever
 * repository, and disappear with the process instead of outliving the run in a
 * mounted working tree.
 *
 * The token is deliberately absent from `reviewEnv()` in `review.ts` — it
 * strips the whole `UF_` namespace, and a reviewer that cannot write files has
 * nothing to authenticate. Same for `gitEnv()` in `git.ts`: hooks are off there
 * and `core.fsmonitor` is cleared, but a `.gitattributes` driver is still
 * repository-controlled code in a child this app never reads the output of,
 * and none of what this app runs git for touches the network. That withholding
 * is by namespace rather than by remembering, so a *second* credential shape is
 * covered by it with no change: `UF_GITHUB_TOKENS` leaves those children the
 * same way `UF_GITHUB_TOKEN` does.
 *
 * *Which* token is decided by `selectGithubToken` in `config.ts`, off the
 * folder the child is working in, and it is decided by the caller rather than
 * here: this function's `credential.https://github.com.helper` answers for
 * github.com as a whole, so how narrow the credential is comes entirely from
 * how narrow the token handed in is. Callers that have a repository pass it;
 * the chat, which roams every mount by design, has none to pass.
 */
export function githubEnv(token: string = GITHUB_TOKEN): Record<string, string> {
  if (!token) return {};

  const config: Array<[string, string]> = [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", GITHUB_CREDENTIAL_HELPER],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];

  const env: Record<string, string> = {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    // A wrong or expired token should end the command, not the cycle: with a
    // helper installed nothing should prompt, and a git that decides to ask
    // anyway has no stdin to ask on and would sit there until the run's own
    // duration limit stopped it.
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(config.length),
  };
  // Every index below the count must carry both halves — git ignores the whole
  // block if one is missing, which would put the run straight back into the
  // failure this function exists to remove, silently.
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Signal a child and everything it started.
 *
 * Falls back to signalling the process alone when the group is unavailable —
 * `detached` turned off, Windows, or a group that has already gone (ESRCH).
 *
 * Exported for the review spawn in `review.ts`, which is `detached` for the
 * same reason the agent is: what actually has to die is whatever the child
 * started, not the CLI wrapper around it.
 */
export function signalTree(
  child: { pid?: number; kill: (sig: NodeJS.Signals) => boolean },
  sig: NodeJS.Signals,
): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      /* not a group leader, or already reaped — fall through */
    }
  }
  try {
    child.kill(sig);
  } catch {
    /* already gone */
  }
}

/**
 * Every directory this argv grants the child beyond its working one.
 *
 * Read off the argv rather than passed in, so that a flag added to
 * `buildArgs` reaches this without a second call site having to remember: what
 * the sandbox neutralises is every tree the session can see, and today that is
 * the vault a run gets through `vaultSkill`.
 */
function addDirsIn(args: readonly string[]): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--add-dir") dirs.push(args[i + 1]!);
  }
  return dirs;
}

/**
 * Spawn one work cycle.
 *
 * `onSession` fires the moment the stream first names a session, and again if it
 * ever names a different one. The caller needs it before the promise settles:
 * the id is what makes the run resumable, and the events that lose it — a crash,
 * a restart, a kill — are exactly the ones that stop this promise settling at
 * all.
 *
 * `silenceMs` is the cycle's deadline, and it is a **required** argument for
 * `buildArgs`' reason one door over: a caller that could omit it would drop the
 * deadline by omission, and a dropped deadline is invisible until the day a
 * child hangs. See the watchdog below for what it measures and why it is
 * silence rather than wall clock.
 */
export function runIteration(
  runId: string,
  cwd: string,
  args: string[],
  telemetryRequired: boolean,
  silenceMs: number,
  onSession: (sessionId: string) => void,
  // Which GitHub credential this cycle gets. `cwd` cannot supply it — an
  // isolated run's cwd is its checkout under `.uf-worktrees`, not the
  // repository the token is about — so the caller resolves it from the
  // repository and hands it over.
  //
  // Defaulted to *none* rather than to the install-wide `GITHUB_TOKEN`, which
  // is `buildArgs`' rule for the run-cost ceiling read the one way round that
  // survives a default: a call site that says nothing must get the narrowest
  // credential, never the widest. The run loop always passes one.
  githubToken: string = "",
): Promise<IterationResult> {
  return new Promise((resolve) => {
    // Before the spawn and not before the run, because what has to be true is
    // the state of each tree at the moment the child constructs its sandbox.
    // Every tree the child is handed, since the list is applied to the working
    // directory and to each `--add-dir` alike.
    const mountPoints = ensureSandboxMountPoints([cwd, ...addDirsIn(args)]);
    if (mountPoints.created.length > 0) {
      // The directories rather than the two dozen paths, which are on the event
      // for anyone who wants them. Said once per tree and then never again,
      // since the second cycle finds everything already there.
      const trees = [...new Set(mountPoints.created.map((p) => path.dirname(p)))];
      log(
        runId,
        `Created ${mountPoints.created.length} mount point(s) in ${trees.join(", ")} ` +
          "so this cycle's tool calls do not fail constructing a sandbox",
        { sandboxMountPoints: mountPoints.created },
      );
    }
    for (const problem of mountPoints.problems) {
      log(runId, `Could not create a sandbox mount point: ${problem}`);
    }

    // No shell: arguments are passed as an array, so a prompt containing
    // quotes, backticks, or semicolons is inert rather than interpreted.
    const child: AgentProcess = spawn(CLAUDE_BIN, args, {
      cwd,
      env: childEnv({ ...telemetryEnv(runId, telemetryRequired), ...githubEnv(githubToken) }),
      // The uid `childEnv`'s strip only means something against: same process,
      // one step down, so `/proc/<server>/environ` and `/data` stop being
      // readable by the thing whose prompt came out of a repository.
      ...childCredentials(),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a kill reaches the builds, test runners and
      // servers the agent started. Those are what actually hold the working
      // tree; a signal aimed at the CLI alone leaves them running and writing
      // into a directory this run is about to resume into or hand off. Windows
      // has no process groups to signal, and `process.kill(-pid)` throws there.
      detached: getSettings().killProcessGroup && process.platform !== "win32",
    });

    procs.set(runId, child);

    /**
     * When this child last showed a sign of life, for the watchdog below.
     *
     * Assignment rather than a call so the two stream handlers stay one line
     * each: this is the hottest path in the loop, and the timer is armed once
     * rather than rescheduled per chunk.
     */
    let lastOutputAt = Date.now();

    const result: IterationResult = {
      exitCode: -1,
      costUSD: 0,
      tokens: 0,
      contextTokens: 0,
      sessionId: null,
      finalText: "",
      isError: false,
      sawResult: false,
      subtype: null,
      apiError: null,
      stderrTail: "",
      subagentNames: new Map(),
      toolCalls: new Map(),
    };

    let stdoutBuf = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      lastOutputAt = Date.now();
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) handleStreamLine(runId, line, result, onSession);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Before the empty-text return: a child writing whitespace is still a
      // child that is running, and the watchdog asks about the process rather
      // than about the log.
      lastOutputAt = Date.now();
      const text = chunk.trim();
      if (!text) return;
      log(runId, text, { stream: "stderr" });
      // Keep the tail as well as logging it: a refusal the CLI writes only to
      // stderr is otherwise unavailable to the branch that decides whether the
      // run failed or the window is simply full.
      result.stderrTail = `${result.stderrTail}${text}\n`.slice(-STDERR_TAIL_LIMIT);
    });

    child.on("error", (err) => {
      result.isError = true;
      emit({
        runId,
        ts: Date.now(),
        kind: "error",
        payload: {
          message: `Failed to launch ${CLAUDE_BIN}: ${err.message}`,
        },
      });
    });

    let settled = false;
    let silenceTimer: NodeJS.Timeout | null = null;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      // Before anything else. `interruptRun` records the interrupt whether or
      // not there is still a child to signal, so a watchdog that fired after
      // the cycle had returned would stop a run whose cycle finished normally.
      if (silenceTimer) clearTimeout(silenceTimer);
      procs.delete(runId);
      if (stdoutBuf.trim())
        handleStreamLine(runId, stdoutBuf.trim(), result, onSession);
      result.exitCode = code ?? -1;
      resolve(result);
    };

    // `close` is preferred because it means stdout has been fully drained, but
    // it waits for every inherited pipe to shut — and the agent's own children
    // hold those. A killed agent that leaves a grandchild behind would never
    // close, and the run would hold its folder until the next restart. `exit`
    // is the guarantee; the grace period is only there to let a normal exit
    // flush its last line through `close`.
    child.on("exit", (code) => {
      setTimeout(() => finish(code), 2_000).unref?.();
    });
    child.on("close", (code) => finish(code));

    /**
     * The deadline, and what "hung" is taken to mean.
     *
     * **Silence, not wall clock.** The clock is the time since the last thing
     * the child printed, and any stdout or stderr chunk resets it. Those are
     * two different guarantees and only this one is safe to apply to every run:
     * a cycle that is still reporting is working, however long it has been at
     * it, and killing one for its *duration* is `maxDurationMinutes` under
     * `enforcement: "live"` — a mode the operator opts into precisely because
     * it costs the in-flight cycle's work and turns its measured cost into an
     * estimate. Deriving this from that limit instead would have made
     * `between-cycles` a live mode without saying so, and `between-cycles` is
     * the default and the only mode whose accounting is exact.
     *
     * What it buys is the case nothing else here notices at all: this promise
     * settles only when the child says so, so a `claude` wedged on a socket
     * read, or an agent's own tool call blocked on a read with no timeout,
     * leaves it pending for the life of the process. The run stays `running`,
     * holding its folder against every other run in that subtree, its checkout
     * slot, and one of `maxConcurrentRuns` — until the container is restarted.
     * Nothing else looks: the live ticker is registered only for the two
     * non-default modes, the sweeper selects `paused` rows, and
     * `reconcileOnBoot` is a restart by definition.
     *
     * It goes through `interruptRun` rather than killing the child here, so
     * there is still exactly one kill path: the `SIGINT`-first ladder gives the
     * cycle its chance to report its own cost, the loop's post-cycle checkpoint
     * picks the interrupt up like any other, and `reconcileKilledCycle`
     * recovers what the cycle spent into `spent_usd_est`. What it deliberately
     * does *not* do is settle this promise itself: the run's folder is handed
     * to whatever is queued behind it the moment this function returns, so
     * resolving while a child might still be writing there would trade a held
     * slot for two agents in one working tree — the one thing the folder claim
     * exists to prevent. The ladder ends in `SIGKILL`, which is the strongest
     * answer there is.
     */
    const onSilence = () => {
      if (settled) return;
      // Re-armed rather than trusted, because output resets `lastOutputAt`
      // without touching the timer — cheap on the hot path, one extra wakeup
      // per busy cycle here.
      const quietFor = Date.now() - lastOutputAt;
      if (quietFor < silenceMs) {
        armSilence(silenceMs - quietFor);
        return;
      }
      interruptRun(runId, {
        kind: "deadline",
        reason:
          `No output from Claude Code for ${fmtDuration(silenceMs)}, so this work ` +
          `cycle was ended. A cycle that has stopped reporting is not going to ` +
          `finish on its own, and one left running holds this run's folder and its ` +
          `place in the queue until the server restarts.`,
        pause: false,
        at: Date.now(),
      });
    };

    const armSilence = (ms: number) => {
      silenceTimer = setTimeout(onSilence, ms);
      // `unref` for the reason every other timer here has it: a deadline must
      // not be what keeps the process alive.
      silenceTimer.unref?.();
    };

    armSilence(silenceMs);
  });
}

/**
 * Prune this run's transcript, and say on the run's log what it took out.
 *
 * Shared by the two moments a prune can happen, so that they cannot drift into
 * reporting the same operation two different ways. What differs between them is
 * `trigger`, and that difference is priced rather than cosmetic —
 * `contextPruning.ts` and the `prune_receipts` schema both turn on it.
 *
 * **Every failure here is a log line and nothing else.** A prune is an
 * optimisation running between two cycles of a run that is otherwise fine, and
 * there is no outcome — a missing tool, an unreadable transcript, a winnow that
 * exited non-zero — where ending the run is a better answer than carrying on
 * with a larger context. The one thing that must not happen quietly is nothing
 * at all: this is now what bounds a cycle, so a prune that could not run says so
 * in the pane the operator is watching.
 */
async function prune(
  id: string,
  sessionId: string | null,
  trigger: PruneTrigger,
): Promise<PruneOutcome | null> {
  const settings = getSettings();
  // The switch and the tool are tested apart, deliberately. Off is silent — that
  // is an operator's decision and needs no line every cycle. On with no tool is
  // the case that must speak: `pruneTranscript` answers `unavailable` and the
  // switch below says so. Collapsing the two into `pruningEnabled` here is what
  // made that branch unreachable, which is the exact silence this whole path is
  // written against.
  if (!settings.contextPruning) return null;
  if (!sessionId) return null;

  const transcript = await resolveSessionTranscript(sessionId);
  if (!transcript) {
    const reason = "the run's transcript could not be found";
    log(id, `Could not find this run's transcript, so its context was not pruned.`);
    recordPruneDecision(id, trigger, "legacy", "failed", reason);
    return null;
  }

  const result = await pruneTranscript(transcript, settings.contextPruningStrictness);
  switch (result.kind) {
    case "pruned": {
      const { tokensRemoved, tokensBefore, apiTokensBefore } = result.outcome;
      recordPrune(id, trigger, result.outcome, getRun(id)?.model ?? null);
      const pct = Math.round((tokensRemoved / tokensBefore) * 100);
      // Reported in the ceiling's currency, because the two lines sit one under
      // the other in the pane the operator is watching. The ceiling names the
      // whole prompt and the transcript figures name the conversation inside it
      // — tens of thousands of tokens apart, either way round — so a line
      // ending "leaving 68.5k" under one saying "reached 183.7k" describes a
      // context the next request will never carry, and was read as the ceiling
      // miscounting.
      //
      // The after is derived rather than measured, and there is no alternative:
      // no request has been made against the smaller conversation yet, so no
      // `usage` frame exists for it. It errs high, because `contextTokens`
      // understates what came out — the one crossing measured by hand took
      // 62.6k off the API's prompt against the 50.3k reported here — and high
      // is the direction to be wrong in, since it never claims more was freed
      // than was. `max` because the intake filter can leave the API carrying
      // less than the transcript holds.
      //
      // Subtracted rather than scaled by `contextAfterPrune`'s ratio, and the
      // difference is the reason that function's basis-independence argument
      // does not reach here: most of the gap between the two measures is a
      // *fixed* system prompt and tool list, which a proportion shrinks along
      // with the conversation. On the crossing measured by hand the ratio gave
      // 105.6k against a real 120.6k, which is a line telling an operator the
      // context is smaller than the next request will find it.
      const apiTokensAfter = Math.max(0, apiTokensBefore - tokensRemoved);
      log(
        id,
        `Pruned ${fmtTokens(tokensRemoved)} tokens of conversation ` +
          `(${pct}% of the ${fmtTokens(tokensBefore)} of turns on this run's transcript), ` +
          `taking the context from ${fmtTokens(apiTokensBefore)} to about ` +
          `${fmtTokens(apiTokensAfter)}.`,
      );
      recordPruneDecision(id, trigger, "legacy", "cut");
      return result.outcome;
    }
    case "nothing":
      // A result and not an absence, winnow's own rule for its hook lines: a
      // cycle whose conversation held nothing worth removing has to be
      // distinguishable from one where the tool never ran.
      log(id, `Nothing worth removing from this run's conversation.`);
      // Written beside the line rather than instead of it: the line is one
      // cycle in a pane somebody may not be reading, and the row is what the
      // span's own sentence is counted from a week later.
      recordPruneDecision(id, trigger, "legacy", "nothing");
      break;
    case "unavailable":
      log(id, `Context pruning is switched on but ${result.reason}.`);
      recordPruneDecision(id, trigger, "legacy", "unavailable", result.reason);
      break;
    case "failed":
      log(id, `This run's context could not be pruned: ${result.reason}.`);
      recordPruneDecision(id, trigger, "legacy", "failed", result.reason);
      break;
  }
  return null;
}

/**
 * The boundary case, named so the call site inside the loop reads as one line.
 *
 * ## Why this is gated at all
 *
 * A cut pays `1.9·S − 2·D` once and earns `0.1·D` a turn back, so it needs
 * `19·(S/D) − 20` further turns to pay for itself — `paybackTurns`, which this
 * app already computes and already acts on, but only on the early-end path
 * (`declineOrEndEarly`). The boundary path ran unconditionally on the argument
 * that its edit is free because `--resume` was going to rewrite the prefix
 * anyway.
 *
 * That argument is about the *cost* side and it may well be right. It says
 * nothing about the *earning* side, and the earning side is where a boundary
 * prune actually fails: `S` grows every cycle while `D` is only the newest
 * cycle's strippable results, so `S/D` drifts up and the payback horizon with
 * it. Measured with `winnow inspect` on real orchestrated transcripts from this
 * install, `T*` at tier CB runs from 68 to 598 turns — against runs that billed
 * 113 to 520. A cut needing 598 turns to break even, taken at a boundary with
 * perhaps one cycle left, is not free even if the write was.
 *
 * ## One-sided, on purpose
 *
 * Every unknown resolves to **prune**. `predictedPayback` returns null on a
 * run's first cut, and null means go: the repo's own corpus has always-prune
 * netting +$214.46 over 175 sessions, so refusing too readily costs more in
 * aggregate than allowing too readily does. This gate is here to catch the tail
 * where the arithmetic has already said no once, not to second-guess the median.
 *
 * ## The side effect that is worth as much as the gate
 *
 * Every decline leaves a cycle boundary with no prune at it — a **clean resume**,
 * which is the only observation that can settle what a boundary prune's edit
 * actually costs (`contextPruning.ts`'s `classifyResume`). The probe is recorded
 * either way, so the control group grows whichever branch is taken.
 */
async function pruneAtBoundary(
  id: string,
  sessionId: string | null,
  contextTokensNow: number,
  adopt: (sid: string) => void,
): Promise<PruneOutcome | null> {
  const settings = getSettings();
  // Above the payback gate rather than below it, and that ordering is the whole
  // point. Below, an install with pruning switched **off** still ran the gate,
  // still incremented `boundaryDeclines`, and still wrote "the last prune here
  // removed too little to pay for another one" into the pane every cycle — a
  // considered decision the app had not made, about a feature nobody had asked
  // for. `prune()` opens by checking this itself, so the legacy path was
  // covered and the two newer ones were not: the fork engine spawned winnow and
  // rewrote a conversation, and the plan observation spawned winnow every
  // cycle. An operator who turned it off is entitled to a tool that does
  // nothing and says nothing.
  if (!settings.contextPruning) {
    await settleBoundary(id, sessionId, false, contextTokensNow);
    return null;
  }

  const predicted = predictedPayback(id);
  const declinesSoFar = boundaryDeclines.get(id) ?? 0;
  const action = boundaryAction(predicted, declinesSoFar);
  const declined = action === "decline";

  boundaryDeclines.set(id, declined ? declinesSoFar + 1 : 0);

  if (declined) {
    // Said plainly, and not as a failure. `prune`'s own error path writes "This
    // run's context could not be pruned", and a policy decision arriving in that
    // wording would send an operator looking for a broken install every cycle.
    //
    // Said every time rather than once per run, unlike `earlyEndDeclined`. That
    // one latches because it fires on a minute timer and would otherwise repeat
    // for hours; this fires once per work cycle, and a cycle that silently did
    // not prune is exactly the thing an operator reading the pane needs told.
    log(
      id,
      `Left this run's conversation alone at the cycle boundary: the last prune ` +
        `here removed too little to pay for another one (it would need ` +
        `${predicted} more turns to break even, and the limit is ` +
        `${PAYBACK_HORIZON_TURNS}).`,
    );
    // The one outcome that left no durable trace of any kind: `boundaryDeclines`
    // is a `globalThis` map cleared when the run ends, so "declined at every
    // boundary for forty cycles" and "pruning was never on" were the same empty
    // section a day later.
    recordPruneDecision(
      id,
      "boundary",
      settings.contextPruningEngine,
      "declined",
      null,
      predicted,
    );
    await settleBoundary(id, sessionId, false, contextTokensNow);
    return null;
  }
  if (action === "refresh") {
    log(
      id,
      `Pruning this run's conversation once despite the payback test, to retake ` +
        `the measurement — the figure it refused on is ${declinesSoFar} cycles old.`,
    );
  }

  const outcome =
    settings.contextPruningEngine === "winnow"
      ? await forkAndAdopt(
          id,
          sessionId,
          settings.contextPruningForkMinColdAge,
          BOUNDARY_BREAK_EVEN_BUDGET,
          "boundary",
          adopt,
        )
      : await prune(id, sessionId, "boundary");
  // `sessionId` and not whatever the fork adopted: the probe is a statement
  // about the conversation that was standing at this boundary, and the control
  // group is read by looking for the first billed turn after it.
  await settleBoundary(id, sessionId, outcome !== null, contextTokensNow);
  return outcome;
}

/**
 * Write down what this boundary actually did, once it has done it.
 *
 * Both records used to be written from the gate's *intent* — `!declined` —
 * before the engine had run. That is not the same fact. A boundary the gate
 * allowed but where the pruner found nothing worth removing, or where the fork
 * engine refused on cold-age, left no cut behind and is therefore a **clean**
 * resume: exactly the observation `resumeControl` needs, and the one the label
 * was throwing away. Under the fork engine at its default cold age that is
 * every boundary, so the control group would have stayed empty for ever while
 * appearing to fill up.
 */
async function settleBoundary(
  id: string,
  sessionId: string | null,
  cut: boolean,
  contextTokensNow: number,
): Promise<void> {
  recordResumeProbe(id, sessionId, cut, contextTokensNow);
  // Read-only, and asked whichever way the boundary went — one where nothing
  // was removed is exactly as interesting a comparison as one where something
  // was. Awaited rather than left floating for `pruneAtBoundary`'s own reason:
  // the next spawn must not read the transcript while a subprocess is on it.
  await observePlan(id, sessionId, cut);
}

/**
 * Cut at the boundary this app just manufactured by ending a cycle early.
 *
 * The sibling of `pruneAtBoundary`, and it exists because the engine switch did
 * not: `contextPruningEngine: "winnow"` forked at the natural boundary and then
 * ran the **legacy in-place pruner** here, so a run crossing the ceiling was cut
 * by whichever engine the moment happened to reach, not by the one the operator
 * chose. Two engines with different rules, different guards and different
 * receipts, selected by timing.
 *
 * There is no payback gate here and that is deliberate. The ceiling watcher has
 * already made the only decision with a cost behind it — whether to spend a work
 * cycle manufacturing this boundary, which it takes against
 * `CEILING_PAYBACK_HORIZON_TURNS`. That cycle is spent by the time this runs,
 * cut or no cut, so a second gate on the same arithmetic could only decline to
 * use a boundary already paid for. `BOUNDARY_BREAK_EVEN_BUDGET` carries the
 * argument.
 *
 * That is not in tension with passing `early-end` below, though it reads like
 * it. Two different questions:
 *
 * - **Should this cut happen?** No, the rewrite is already committed; refusing
 *   here forgoes the saving without avoiding the cost. Hence no gate.
 * - **Who owns the rewrite on the books?** The pruning feature, because the
 *   only reason this boundary exists is that the ceiling watcher made it in
 *   order to cut. Hence `early-end`.
 *
 * Measured on this install, that write is ~$1.80 a time — 178k–183k tokens at
 * the one-hour class. So the gate worth arguing about is the ceiling watcher's,
 * which decides whether to spend it at all, and not this one. Reporting it here
 * is what puts the number in front of that argument.
 *
 * `--min-cold-age` does not stand here either, and for the third time it is the
 * same argument: the session was live seconds ago because a fork can only happen
 * seconds after a child exits, so the guard's pass condition is unreachable on
 * this path rather than merely strict. `contextPruningForkMinColdAge` ships at 0
 * and carries the reasoning. An operator who raises it gets the refusal back,
 * and it reads in the log as the guard standing rather than as a breakage.
 */
async function pruneAtEarlyEnd(
  id: string,
  sessionId: string | null,
  adopt: (sid: string) => void,
): Promise<PruneOutcome | null> {
  const settings = getSettings();
  // Checked here as well as inside `prune`, on `pruneAtBoundary`'s reasoning:
  // the fork path does not go through `prune` and would otherwise spawn winnow
  // against an install that has context pruning switched off.
  if (!settings.contextPruning) return null;
  return settings.contextPruningEngine === "winnow"
    ? await forkAndAdopt(
        id,
        sessionId,
        settings.contextPruningForkMinColdAge,
        BOUNDARY_BREAK_EVEN_BUDGET,
        // The trigger the receipt is priced by, and the reason it is passed
        // rather than assumed: a fork here rides a boundary that exists only
        // because this app made it in order to cut, so the rewrite it causes is
        // charged to the cut exactly as the legacy pruner's is. `forkAndAdopt`
        // used to record every fork as a `boundary` and this moment was priced
        // free — see `forkCutFromRow`.
        "early-end",
        adopt,
      )
    : await prune(id, sessionId, "early-end");
}

/**
 * The fork engine: cut into a new transcript and switch the run onto it,
 * provisionally.
 *
 * Called from both moments a resume is already committed — the natural cycle
 * boundary and the manufactured one the ceiling watcher makes by ending a cycle
 * early. The *mechanics* do not distinguish them: the rewrite is spent either
 * way and the cut rides it, which is what `maxBreakEven` carries a position on
 * (see `BOUNDARY_BREAK_EVEN_BUDGET`). The **accounting** must, which is what
 * `trigger` carries — a boundary this app manufactured in order to cut owns the
 * rewrite it causes, and one that was going to happen anyway does not. Recording
 * every fork as a `boundary` is what let an early-end fork be priced free while
 * the identical operation under the legacy engine was charged in full.
 *
 * Returns null on a refusal and a synthesised `PruneOutcome` on success. Only
 * `tokensRemoved` is read from it, by `contextAfterPrune`; the rest is filled
 * from what the fork reported rather than invented. Non-null is therefore also
 * the signal that a cut landed, which is what `settleBoundary` labels the
 * control group by — so this must not go back to returning null on success.
 *
 * The adoption is deliberately not verified here, because it cannot be: the
 * only thing that proves a fork resumes is a resume. `pendingFork` carries the
 * way back, and the resume-failure branch in the run loop takes it.
 */
async function forkAndAdopt(
  id: string,
  sessionId: string | null,
  minColdAge: number | null,
  maxBreakEven: number | null,
  trigger: PruneTrigger,
  adopt: (sid: string) => void,
): Promise<PruneOutcome | null> {
  if (!sessionId) return null;
  const transcript = await resolveSessionTranscript(sessionId);
  if (!transcript) {
    log(id, `Could not find this run's transcript, so its context was not forked.`);
    recordPruneDecision(id, trigger, "winnow", "failed", "the run's transcript could not be found");
    return null;
  }

  const result = await forkTranscript(transcript, minColdAge, maxBreakEven);
  if (!result) {
    log(id, `Context pruning is switched on but winnow is not installed.`);
    recordPruneDecision(id, trigger, "winnow", "unavailable", WINNOW_MISSING_REASON);
    return null;
  }

  // Measured off the written file, in the currency `prune_receipts.tokens_after`
  // already uses, so the two engines' receipts are comparable rather than merely
  // similarly named. This is what the next resume has to write, and the netting
  // prices exactly that until a real turn lands to be read instead. Only for a
  // fork that was written — a refusal wrote no file to measure.
  const contextTokensAfter =
    result.written && result.out ? contextTokens(result.out) : null;

  const rowId = recordForkAttempt(
    id,
    sessionId,
    result,
    minColdAge,
    trigger,
    contextTokensAfter,
  );

  if (!result.written || !result.newSessionId) {
    // A refusal is a result, not a failure, and the two must not read alike.
    if (result.refusedBy === "cold-age") {
      // The wording lives in contextPruning so it can be tested against the
      // thing that actually decides this refusal — see coldAgeRefusalMessage.
      log(id, coldAgeRefusalMessage(result.coldAgeSeconds, minColdAge));
    } else if (result.refusedBy === "break-even") {
      // Reachable only if someone armed the gate: both callers ask for
      // `--max-break-even none` because a boundary cut rides a rewrite that was
      // going to happen (contextPruning's BOUNDARY_BREAK_EVEN_BUDGET). Kept
      // anyway, because a refusal that surprises this app should read as the
      // arithmetic it is rather than as a broken install.
      log(
        id,
        `Left this run's conversation alone: winnow priced the cut at ` +
          `${result.breakEvenTurns ?? "?"} further turns before it would pay for ` +
          `the cache invalidation, which is more than it was told this run has ` +
          `left. Nothing was written.`,
      );
    } else if (result.refusedBy) {
      log(id, `Winnow refused to fork this run's conversation (${result.refusedBy}): ${result.reason ?? "no reason given"}.`);
    } else if (result.reason) {
      log(id, `This run's context could not be forked: ${result.reason}.`);
    } else {
      log(id, `Nothing worth removing from this run's conversation.`);
    }
    // One row after the branches rather than one per branch: `fork_attempts`
    // already carries this refusal in full, and what this table is for is the
    // count an operator reads on a card -- three outcomes, not five wordings.
    // A guard that stood is `refused`; winnow breaking is `failed`; neither is
    // `nothing`, which is the tool working and finding no rule hit.
    recordPruneDecision(
      id,
      trigger,
      "winnow",
      result.refusedBy ? "refused" : result.reason ? "failed" : "nothing",
      result.refusedBy
        ? `${result.refusedBy} — ${result.reason ?? "no reason given"}`
        : result.reason,
    );
    return null;
  }

  const breakEven = result.breakEvenTurns === null
    ? ""
    : `, needing ${Math.round(result.breakEvenTurns)} further turns to pay for itself`;
  log(
    id,
    `Forked this run's conversation: ${fmtTokens(Math.round(result.netBytes / BYTES_PER_TOKEN))} ` +
      `tokens net removed${breakEven}. The original is untouched and stays the ` +
      `recovery path; this run continues in session ${result.newSessionId}.`,
  );
  pendingFork.set(id, {
    fallbackSessionId: sessionId,
    forkSessionId: result.newSessionId,
    rowId,
  });
  // `adoptSession` is a closure over the run loop's own `sessionId` local, and
  // moving that local is the entire point — it is what the next cycle's
  // `--resume` and the live context watch both read. Passed in rather than
  // reached for, because a module-level function could not touch it.
  adopt(result.newSessionId);
  recordPruneDecision(id, trigger, "winnow", "cut");

  // Report what came out, so `contextAfterPrune` can correct the loop's running
  // figure. Returning null here — which this did — left `lastContextTokens`
  // describing the transcript the run had just stopped using, and
  // `startsFresh` reads that figure to decide whether the next cycle should
  // drop the conversation entirely. A fork that shrank a conversation past the
  // fresh-start threshold would therefore be discarded on the *pre*-fork
  // reading: the run pays for the cut and then throws away the result, on the
  // very cycle the cut was made for.
  //
  // `tier` and the api figures are what `PruneOutcome` carries for a prune and
  // has no counterpart here; only `tokensRemoved` is read by
  // `contextAfterPrune`, and the rest is filled from what the fork reported so
  // nothing downstream sees an invented number.
  const removedTokens = Math.max(0, Math.round(result.netBytes / BYTES_PER_TOKEN));
  const before = Math.max(
    removedTokens,
    Math.round(result.suffixBytes / BYTES_PER_TOKEN),
  );
  return {
    tier: PLAN_TIER as PruneOutcome["tier"],
    tokensBefore: before,
    tokensAfter: Math.max(0, before - removedTokens),
    tokensRemoved: removedTokens,
    apiTokensBefore: 0,
    elapsedMs: 0,
  };
}

/**
 * Ask winnow's newer rule engine what it would have removed here, and write the
 * answer down. Acts on nothing.
 *
 * This is the only place in the app where SPEC section 4's rules run at all.
 * The pruner is `winnow treat`, the inherited engine, and the two classifiers
 * share no code — so no amount of pruning produces evidence about which of them
 * is right. `plan` writes nothing and is allowed while a session is live, so it
 * costs one subprocess and cannot affect the run.
 *
 * Silent on every failure. An observation that could end a cycle would be worth
 * less than not taking it.
 */
async function observePlan(
  id: string,
  sessionId: string | null,
  pruned: boolean,
): Promise<void> {
  // Gated here as well as at `pruneAtBoundary`'s head, because this is reached
  // through `settleBoundary` on the off branch too — and an observation is
  // still a subprocess spawned against the operator's transcript. Read-only is
  // not the same as free, and it is emphatically not the same as permitted:
  // the one thing an operator who turned the feature off has asked for is that
  // winnow is not run on their conversation.
  if (!getSettings().contextPruning) return;
  try {
    const transcript = sessionId ? await resolveSessionTranscript(sessionId) : null;
    if (!transcript) return;
    const plan = await planCut(transcript);
    if (!plan) return;
    recordPlanObservation(id, sessionId, plan, pruned);
    // Logged rather than only stored, because a comparison nobody sees is one
    // nobody acts on — and the whole point of the row is to be argued with.
    const breakEven =
      plan.breakEvenTurns === null
        ? "nothing would fire"
        : `it would need ${Math.round(plan.breakEvenTurns)} further turns to pay for itself`;
    log(
      id,
      `winnow's rule engine, asked about this conversation at tier ${plan.tier}: ` +
        `${plan.stripped} of ${plan.toolCalls} tool results, ` +
        `${fmtTokens(Math.round(plan.netBytes / BYTES_PER_TOKEN))} tokens net — ${breakEven}. ` +
        `Recorded for comparison; nothing acted on it.`,
    );
  } catch {
    // See above.
  }
}

/**
 * `lastContextTokens`, corrected for a prune that has just happened.
 *
 * `startsFresh` reads that figure to decide whether the next cycle should drop
 * the conversation, and it comes from the **usage frames of the cycle that just
 * ended** — which were billed before the prune ran and cannot know about it. So
 * with both features on, a prune that shrank a 200k conversation to 124k would
 * be followed immediately by a fresh start triggered on the 200k reading, and
 * the run would pay for the re-discovery of a conversation something had just
 * finished shrinking to fit.
 *
 * That is precisely the failure `IterationResult.contextTokens` documents in its
 * "**Last, not largest**" paragraph, arriving from a direction that did not
 * exist when it was written: there, a compaction is what shrinks the tail and
 * reading a high-water mark is what would get it backwards.
 *
 * Corrected rather than replaced, and that is the careful part. The two figures
 * are not the same measurement — one is exact from `usage`, the other is
 * `contextTokens`' estimate over content — so substituting the estimate would
 * put a different basis into a threshold the operator set against the first.
 * What is carried across is the **amount removed**, which is a quantity of
 * conversation and belongs to neither basis.
 *
 * ## Why the amount and not the ratio
 *
 * This scaled the billed figure by `tokensAfter / tokensBefore` until
 * 2026-08-25, on the argument that a ratio taken over one file twice seconds
 * apart is basis-independent. It is — but the figure it is applied to is not a
 * conversation. Most of the gap between the two measures is a **fixed** system
 * prompt, tool list and set of project instructions, and a proportion shrinks
 * those along with the turns, crediting a prune with freeing context that was
 * never removable. Measured on the crossing in `docs/verification.md`: the
 * ratio put a real 120,595-token remainder at 105,600, low by 15,000, where
 * subtracting what came out puts it at 132,900, high by 12,300. The part a
 * ratio cannot see is ~55,000 tokens wide.
 *
 * High is the direction to be wrong in here for the same reason it is on the
 * log line: `contextTokens` understates what a prune removed, so a subtraction
 * can only ever claim *less* was freed than was, and the failure mode of this
 * function is a fresh start that did not need to happen.
 */
export function contextAfterPrune(
  before: number,
  outcome: PruneOutcome | null,
): number {
  if (!outcome) return before;
  // `max` for the case the intake filter creates: it drops tool results on the
  // wire while the transcript keeps them, so a prune can report removing more
  // conversation than the API was carrying in the first place.
  return Math.max(0, before - outcome.tokensRemoved);
}

/** How much of a refused command is kept. Long enough to name it, not to log it. */
const DENIAL_COMMAND_CHARS = 60;

/**
 * Refused tool calls off a `result` event, as `Tool (what) ×N`, commonest
 * first.
 *
 * The command is part of the label because `tool_name` alone is `Bash` —
 * confirmed on the wire — and "Bash ×7" is the difference between a line an
 * operator acts on and one they scroll past. Grouped, because a refusal
 * repeats: the agent retries and rephrases, and seven near-identical entries
 * are one fact.
 *
 * Pure and tested, because it reads a shape captured from one CLI build and
 * every field of it is optional here: a build that stops sending it, or renames
 * it, must yield an empty list rather than break the cycle that carried it.
 */
export function permissionDenials(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];

  const counts = new Map<string, number>();
  for (const entry of raw) {
    const e = entry as { tool_name?: unknown; tool_input?: unknown } | null;
    const name = String(e?.tool_name ?? "").trim();
    if (!name) continue;

    const command = String(
      (e?.tool_input as { command?: unknown } | null)?.command ?? "",
    )
      .replace(/\s+/g, " ")
      .trim();
    const label = command
      ? `${name} (${command.slice(0, DENIAL_COMMAND_CHARS)}${command.length > DENIAL_COMMAND_CHARS ? "…" : ""})`
      : name;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
}

/**
 * Which `Task` call a forwarded message belongs to, or null for the main thread.
 *
 * `--forward-subagent-text` marks every delegated message with the id of the
 * `tool_use` block that started it. The SDK's own types put that key on the
 * envelope; the message object is read as a fallback because the whole point of
 * this function is that a shape captured from one build must fail *towards*
 * treating a sub-agent's words as a sub-agent's, and a key that moved would
 * otherwise silently promote them to the main thread's.
 */
function parentToolUseId(
  ev: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
): string | null {
  for (const source of [ev, message]) {
    const raw = source?.parent_tool_use_id;
    if (typeof raw === "string" && raw) return raw;
  }
  return null;
}

/** What a `tool_use` block was, kept so the result answering it can name it. */
export interface ToolCall {
  name: string;
  /** `toolArgs`' one bounded line — the command, the path, the query. */
  command: string;
}

/** A tool call that came back an error, as the run's log records it. */
export interface ToolFailure {
  /** The call's own tool, or `tool` when the call was not seen this cycle. */
  name: string;
  command: string;
  /** What the tool said, flattened and clipped. */
  text: string;
  toolUseId: string;
  /** Present only for a delegated call — see `parentToolUseId`. */
  parentToolUseId?: string;
  subagent?: string;
}

/**
 * How much of a failed tool's output is kept.
 *
 * Enough to name the failure — a `403 … not accessible by personal access
 * token`, a compiler's first error — and not enough to be a log of the output.
 * `run_events` already grows without bound, so a tool result is recorded when
 * it failed and never otherwise.
 */
const TOOL_ERROR_TEXT_CHARS = 600;

/**
 * A `tool_result`'s own text. A string on the wire for most tools and an array
 * of content blocks for the ones that answer with several (a `Task`'s report,
 * anything returning an image beside its text) — both shapes measured against
 * the pin, which is why neither is inferred from the other.
 */
function toolResultText(content: unknown): string {
  const parts = Array.isArray(content) ? content : [content];
  const text = parts
    .map((part) => {
      if (typeof part === "string") return part;
      const block = part as { text?: unknown } | null;
      return typeof block?.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > TOOL_ERROR_TEXT_CHARS
    ? `${text.slice(0, TOOL_ERROR_TEXT_CHARS - 1)}…`
    : text;
}

/**
 * The failed tool calls carried by one `user` event, matched to the calls that
 * produced them.
 *
 * A tool's *outcome* arrives on a later event than its call, and until this
 * existed the whole of it was dropped: a `git push` that a token does not reach
 * left a `tool` row saying the command was attempted, no record of the 403, and
 * a run that finished `completed`. The operator's evidence was identical to a
 * push that worked.
 *
 * Errors only, deliberately. `run_events` grows without bound and a full tool
 * log would multiply it, where a failure is the line somebody is looking for.
 *
 * Pure, and separated from `handleStreamLine` for `permissionDenials`' reason:
 * it reads a shape captured from one CLI build, every field of it is optional
 * here, and both ways of being wrong are silent — a build that renames
 * `is_error` must go back to recording nothing rather than filing every
 * successful result as a failure.
 */
export function toolResultFailures(
  ev: Record<string, unknown>,
  acc: {
    toolCalls: ReadonlyMap<string, ToolCall>;
    subagentNames: ReadonlyMap<string, string>;
  },
): ToolFailure[] {
  const message = ev.message as
    | (Record<string, unknown> & { content?: unknown })
    | undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];

  // Off the envelope with the message as a fallback, exactly as a forwarded
  // turn's text is: a sub-agent's failed command must not read as the main
  // thread's, and a key that moved has to fail towards attributing it.
  const parent = parentToolUseId(ev, message);
  const subagent = parent !== null ? acc.subagentNames.get(parent) : undefined;

  const failures: ToolFailure[] = [];
  for (const block of blocks) {
    const b = block as Record<string, unknown> | null;
    // `=== true` rather than truthiness, which is what keeps a renamed or
    // re-typed field quiet: an undefined here is every successful tool result
    // in the cycle, and the log would be nothing else.
    if (b?.type !== "tool_result" || b.is_error !== true) continue;

    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
    // The call, when it was seen this cycle. A stream this app joined
    // mid-conversation names the tool `tool` rather than dropping the failure:
    // the result text is the half an operator acts on.
    const call = id ? acc.toolCalls.get(id) : undefined;

    failures.push({
      name: call?.name ?? "tool",
      command: call?.command ?? "",
      text: toolResultText(b.content),
      toolUseId: id,
      ...(parent !== null
        ? { parentToolUseId: parent, ...(subagent ? { subagent } : {}) }
        : {}),
    });
  }

  return failures;
}

/**
 * What the cycle has cost after one `result` event, given what it stood at.
 *
 * **The two figures on that one event disagree about what they measure, and
 * this is the half that is cumulative.** `total_cost_usd` is the *session's*
 * running total, so a second `result` from the same child already contains
 * everything the first reported; `usage` beside it is only that stretch's own
 * and is still summed at the call site. Adding both costs charges the first
 * stretch twice, and nothing says so — the run page, the log and the exit code
 * are those of a cycle that went well.
 *
 * One child emits two terminal results whenever a turn ends while a background
 * sub-agent is still running and the same session is woken again when it
 * answers. Measured on run `075f7959`: `$7.025419` and `$9.330155` arrived in
 * the same millisecond, the first equal to the session's cumulative telemetry
 * at the instant that turn ended and the second to its total over all 110
 * requests, and `spent_usd` was stored as their sum — 75% above what the
 * session actually cost, on the figure `maxRunCostUSD` is compared against.
 *
 * A **restart** is not this case and must keep summing: a cycle that died at
 * `error_during_execution` and resumed gets a second child, a second
 * `IterationResult` and a CLI accumulator that starts at zero, which is why
 * every such run reconciles to the cent against telemetry today. That is the
 * whole reason this is scoped to one `IterationResult` rather than to the run.
 *
 * The larger rather than the last, and a non-positive reading ignored: a
 * running total does not go backwards, so the two agree on every well-formed
 * stream, and where they differ it is because the field was absent, unparseable
 * or zero — which must leave a figure already reported standing rather than
 * erase it.
 */
export function cycleCostAfterResult(prevUSD: number, reported: unknown): number {
  const cost = Number(reported ?? 0);
  if (!Number.isFinite(cost) || cost <= 0) return prevUSD;
  return Math.max(prevUSD, cost);
}

/** Interpret one line of Claude Code's `stream-json` output. */
function handleStreamLine(
  runId: string,
  line: string,
  acc: IterationResult,
  onSession: (sessionId: string) => void,
) {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    log(runId, line, { stream: "stdout" });
    return;
  }

  const type = String(ev.type ?? "");

  // Announced on change rather than only latched, so the run's row learns its
  // session id while the cycle is still running. Every event carries the id, so
  // the change guard is what keeps this from being one callback per line; the
  // emptiness guard is load-bearing too, because `nextPrompt` and `--resume`
  // key on *having* a session and an empty string would claim one that is not
  // there.
  if (
    typeof ev.session_id === "string" &&
    ev.session_id &&
    ev.session_id !== acc.sessionId
  ) {
    acc.sessionId = ev.session_id;
    onSession(ev.session_id);
  }

  if (type === "assistant") {
    const message = ev.message as
      | (Record<string, unknown> & { content?: unknown[]; model?: unknown })
      | undefined;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    // Claude Code writes provider refusals — not logged in, credit exhausted,
    // usage limit reached — as an assistant turn attributed to `<synthetic>`
    // rather than to a model. Recorded on first sight only: `finalText` is
    // last-write-wins by design, so any later text would otherwise erase the
    // one message that says why the cycle ended.
    const synthetic = message?.model === "<synthetic>";

    // A delegated turn, forwarded by `--forward-subagent-text`. It is a
    // different voice and it is kept apart from the main thread's in all three
    // places that would otherwise absorb it:
    //
    //   `finalText`  — what the `DONE` test is run against, matched per line,
    //                  so a sub-agent reporting "DONE" would end a run whose
    //                  main thread had not finished. It is also the cycle's
    //                  stop reason and its report.
    //   `apiError`   — latched on first sight and never cleared except by the
    //                  CLI's own verdict, so a sub-agent that met a wall would
    //                  park a run whose cycle then completed normally.
    //   `kind`       — its own, so `cycleOutputs` cannot file it as the cycle's
    //                  report and the log can set it as somebody else speaking.
    //                  A report that silently interleaves two voices is worse
    //                  than one that omits the second.
    const parent = parentToolUseId(ev, message);

    // The window this turn was billed against, kept for `startsFresh`. The sum
    // is the whole of what a request carries — fresh input, what was written to
    // cache and what was read back from it — so it is the size of the
    // conversation at that moment rather than any one price band of it. Last
    // one wins: what the next cycle would resume into is the state the last
    // turn left, not the largest the cycle ever reached.
    //
    // Skipped for a forwarded sub-agent turn, whose usage is its own session's
    // and is discarded when it answers, and skipped for a zero, which is what a
    // `<synthetic>` refusal reports and is not a reading of anything.
    if (parent === null) {
      const usage = (message?.usage ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      const window =
        n(usage.input_tokens) +
        n(usage.cache_creation_input_tokens) +
        n(usage.cache_read_input_tokens);
      if (window > 0) acc.contextTokens = window;
    }

    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b.type === "text" && typeof b.text === "string") {
        if (parent !== null) {
          emit({
            runId,
            ts: Date.now(),
            kind: "subagent",
            payload: {
              text: b.text,
              parentToolUseId: parent,
              // The `subagent_type` off the `Task` call that opened it, when
              // that call was seen this cycle. A name is what makes the line
              // readable — "sub-agent" alone says only that it is not the main
              // thread, which the indent already says.
              ...(acc.subagentNames.get(parent)
                ? { name: acc.subagentNames.get(parent) }
                : {}),
            },
          });
          continue;
        }
        acc.finalText = b.text;
        if (synthetic && acc.apiError === null) acc.apiError = b.text;
        emit({
          runId,
          ts: Date.now(),
          kind: "assistant",
          payload: { text: b.text },
        });
      } else if (b.type === "tool_use") {
        // A `Task` call names the sub-agent it is handing work to, and its own
        // block id is what every forwarded message from that sub-agent carries.
        // Recorded so those messages can be labelled; per cycle, because the
        // ids are.
        const id = typeof b.id === "string" ? b.id : "";
        const subagentType = (b.input as { subagent_type?: unknown } | null)
          ?.subagent_type;
        if (id && typeof subagentType === "string" && subagentType) {
          acc.subagentNames.set(id, subagentType);
        }
        // What this call was, for the result that answers it: a `tool_result`
        // carries the id and nothing else, so a failure can only be reported as
        // the command it failed on by something that saw the command.
        if (id) {
          acc.toolCalls.set(id, {
            name: String(b.name ?? "tool"),
            command: toolArgs(b.input),
          });
        }
        // Bounded before it is stored. `b.input` for a `Write` or an `Edit` is
        // the file itself, and the log has only ever rendered one clipped line
        // of it, so the whole of the difference was storage — see
        // `clipToolInput`, which keeps the field that names the call.
        const stored = clipToolInput(b.input);
        emit({
          runId,
          ts: Date.now(),
          kind: "tool",
          payload: {
            name: b.name,
            input: stored.input,
            ...(stored.truncatedFrom !== undefined
              ? { truncatedFrom: stored.truncatedFrom }
              : {}),
            // A tool call a sub-agent made, rather than one the main thread
            // made. Same reasoning as the text above: unattributed, a `Grep`
            // between two of the main thread's lines reads as the main
            // thread's.
            ...(parent !== null
              ? {
                  parentToolUseId: parent,
                  ...(acc.subagentNames.get(parent)
                    ? { subagent: acc.subagentNames.get(parent) }
                    : {}),
                }
              : {}),
          },
        });
      }
      // Everything else — `thinking` above all — is deliberately dropped. The
      // flag forwards a sub-agent's reasoning as well as its text, and a run
      // that delegates twice would bury its own log in somebody else's working
      // out. Named here rather than left to fall through, because a shape that
      // arrives and is silently ignored is indistinguishable from one that
      // never arrived.
    }
    return;
  }

  // Tool output going back up — the main thread's own, and a sub-agent's when
  // `--forward-subagent-text` is on. A *successful* one is dropped by name for
  // the reason `thinking` is: these carry whole file reads and command output,
  // and the log already shows the call that produced them.
  //
  // A failed one is the exception and it is the whole of this branch. It is
  // still not the run's own report and must not be mistaken for one, so it
  // touches none of the three things a forwarded turn is kept out of:
  // `finalText`, which the `DONE` test is matched against per line; `apiError`,
  // which latches on first sight; and the `assistant` kind, which
  // `cycleOutputs` takes the last of as the cycle's report. It has its own
  // kind, like a delegated turn, rather than a flag on `tool`.
  if (type === "user") {
    for (const failure of toolResultFailures(ev, acc)) {
      emit({
        runId,
        ts: Date.now(),
        kind: "tool_error",
        payload: { ...failure },
      });

      // And, when the words say so, the second statement about the same
      // failure: that a *policy* refused it rather than the work being
      // impossible. Beside the row above and never instead of it — a
      // non-match must leave the tool failure exactly as it was, and a match
      // must not move it somewhere a reader looking for failed calls will not
      // look. The reason is carried verbatim: this recognises text read out of
      // one CLI build and never executed, so what it decided has to be
      // checkable against what the tool actually said.
      const sandbox = sandboxRefusal(failure.text);
      if (sandbox) {
        emit({
          runId,
          ts: Date.now(),
          kind: "sandbox",
          payload: {
            ...sandbox,
            name: failure.name,
            command: failure.command,
            toolUseId: failure.toolUseId,
          },
        });
      }
    }
    return;
  }

  if (type === "result") {
    // Authoritative per-iteration accounting from the CLI itself.
    acc.sawResult = true;
    // Assigned through `cycleCostAfterResult` rather than accumulated, and the
    // `+=` on tokens four lines down is deliberately not the same shape: see
    // that function for why one of these two fields is a session running total
    // and the other is not.
    const before = acc.costUSD;
    acc.costUSD = cycleCostAfterResult(acc.costUSD, ev.total_cost_usd);
    const cost = acc.costUSD - before;

    const usage = (ev.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    acc.tokens +=
      n(usage.input_tokens) +
      n(usage.output_tokens) +
      n(usage.cache_creation_input_tokens) +
      n(usage.cache_read_input_tokens);

    // Recorded before it is judged. `isError` collapses every non-success
    // subtype into one boolean, which is the right shape for the exit-code
    // test and the wrong one for the loop's spend-ceiling branch — that has to
    // know *which* non-success this was.
    if (typeof ev.subtype === "string" && ev.subtype) acc.subtype = ev.subtype;
    if (ev.subtype && ev.subtype !== "success") acc.isError = true;
    if (typeof ev.result === "string" && ev.result) acc.finalText = ev.result;

    // Second-best source for a refusal, behind the `<synthetic>` message: the
    // CLI summarises the failure here too. `??=` because the summary can be
    // empty or generic where the assistant turn carried the real sentence.
    if (
      ev.subtype &&
      ev.subtype !== "success" &&
      typeof ev.result === "string" &&
      ev.result &&
      acc.apiError === null
    ) {
      acc.apiError = ev.result;
    }

    // A tool call the agent made and nothing could answer.
    //
    // `chat.ts` has read this since it shipped, on the grounds that a chat
    // which quietly could not run `gh` reads as a chat that found no issues.
    // The same argument is stronger here and was learned the expensive way: a
    // run whose every `git commit` was refused reads as a run that decided not
    // to commit, and it takes reading a transcript by hand to tell the two
    // apart. Counted by tool rather than listed, because a refusal repeats —
    // the agent retries, rephrases, and retries again.
    const denials = permissionDenials(ev.permission_denials);
    if (denials.length > 0) {
      log(
        runId,
        `Refused tool calls this cycle: ${denials.join(", ")}. The agent asked ` +
          "and nothing was there to approve, so those calls did not run.",
        { denials },
      );
    }

    emit({
      runId,
      ts: Date.now(),
      kind: "result",
      payload: {
        subtype: ev.subtype,
        // What this result *added*, not the number the CLI printed. The feed
        // renders one of these per stretch and a reader adds them up, so on the
        // two-result cycle `cycleCostAfterResult` describes the raw figure would
        // put the whole session's total on the second row and invite exactly the
        // double-count the field above no longer makes.
        costUSD: cost,
        numTurns: ev.num_turns,
        durationMs: ev.duration_ms,
      },
    });
    return;
  }

  if (type === "system") {
    // Dropped by name, and only this one. The CLI emits `thinking_tokens`
    // several times per assistant turn carrying `{estimated_tokens,
    // estimated_tokens_delta, uuid, session_id}` and nothing else — no text, no
    // decision, nothing any reader of this log could act on — and `describeEvent`
    // drops every `system:` line from the feed anyway, so each one was a
    // synchronous SQLite insert and a bus publish for a row nothing would ever
    // read. Measured on this install: 72,307 of 113,073 `run_events` rows (64%)
    // and 16.4 MB of 47 MB of payload in eight days, against 2,898 for the next
    // largest `system` subtype. `eventRetentionDays` is 30, so the steady state
    // is roughly four times that.
    //
    // By name rather than by a shape test, and one subtype rather than a
    // category, because the rest of them do carry information — `init` holds the
    // tool list and the session id, `hook_response` is read four lines below,
    // and `task_progress` is three orders of magnitude rarer. A rule broad
    // enough to cover a future content-free subtype would be broad enough to
    // lose those, silently, the way a deny list fails open.
    //
    // `task_started`, `background_tasks_changed`, `task_updated` and
    // `task_notification` are now the source `runTasks.ts` reduces into the run
    // page's background-task panel, and these rows are the only record of them.
    // That the log feed drops the line is not evidence the row is unread.
    if (ev.subtype !== "thinking_tokens") {
      emit({
        runId,
        ts: Date.now(),
        kind: "log",
        payload: { message: `system:${ev.subtype ?? ""}`, raw: ev },
      });
    }

    // A hook that wrote into the session's context, said in words.
    //
    // The event above already carries it, but only inside `raw` behind a
    // message that reads `system:hook_response` — and `describeEvent` drops
    // every `system:`-prefixed line, deliberately, to keep the CLI's own
    // chatter out of the feed. So what a plugin put in front of the agent was
    // on the run's log and invisible on it at the same time. That is the wrong
    // shape for the one kind of opening context this app does not otherwise
    // record: `iteration` holds the prompt, and hook output is the half of what
    // the session opened with that the prompt does not contain.
    //
    // Only the two events whose stdout the CLI documents as reaching the model.
    // A `PreToolUse` hook that merely returns an exit code fires on every tool
    // call, and logging those would bury the run's own output.
    if (ev.subtype === "hook_response") {
      const injects =
        ev.hook_event === "SessionStart" || ev.hook_event === "UserPromptSubmit";
      const output = typeof ev.output === "string" ? ev.output.trim() : "";
      if (injects && output) {
        // Under `MAX_LOG_CHARS`, so this is the only cut and the line does not
        // arrive already shortened for storage and then shortened again.
        const shown = output.length > 2000 ? `${output.slice(0, 2000)}…` : output;
        log(
          runId,
          `${String(ev.hook_name ?? ev.hook_event)} hook added this to the agent's context:\n${shown}`,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

/**
 * Callers sharing one aggregation, the shape `scanUsage` already uses.
 *
 * `globalThis`-pinned for the reason every other long-lived value here is: a
 * fresh module evaluation in dev would silently stop coalescing.
 */
const globalSnapshot = globalThis as unknown as {
  __ufSnapshotInflight?: Promise<UsageSnapshot> | null;
};

/**
 * A fresh read of the transcripts, as the guard sees it.
 *
 * Exported because a review spawn is billed against the same 5-hour window a
 * work cycle is, and refusing one while that window is already over its ceiling
 * has to use the same numbers the loop does — not a second, subtly different
 * reading of them.
 *
 * **Concurrent callers share one aggregation.** `scanUsage` coalesces the file
 * reads and nothing coalesced what comes after them, which is the expensive
 * half on a large history: a filter and a full allocation per caller, then
 * `buildSessionBlocks` plus two more filters plus five `groupBy` rollups over
 * everything the process has ever parsed. `liveGuardTick` states that property
 * and works around it by taking one snapshot for every live guard; the pre-cycle
 * guard is the path every run takes and it had no such sharing, so N runs
 * reaching a cycle boundary together did N full-history aggregations back to
 * back, on the one event loop.
 *
 * Coalescing on the in-flight promise rather than on a time window is
 * deliberate, and it is the *only* shape whose staleness is no larger than what
 * `scanUsage` already accepts: a caller that joins sees the reading as of the
 * moment that aggregation started, which is exactly "at most one refresh
 * stale". It is also self-scaling, where a fixed cache window is not — the
 * slower the aggregation, the wider the window in which arrivals join it, so it
 * costs nothing on a history small enough not to need it and shares almost
 * everything on one large enough that a run is waiting on it.
 *
 * The snapshot object is therefore shared between callers and must stay
 * read-only. Nothing has ever written to one; `buildSnapshot`'s output is
 * derived, and the two things that act on it — `evaluateBudget` and
 * `evaluateInstanceBudget` — are pure.
 */
export async function currentSnapshot(): Promise<UsageSnapshot> {
  const running = globalSnapshot.__ufSnapshotInflight;
  if (running) return running;

  const started = buildCurrentSnapshot().finally(() => {
    if (globalSnapshot.__ufSnapshotInflight === started) {
      globalSnapshot.__ufSnapshotInflight = null;
    }
  });

  globalSnapshot.__ufSnapshotInflight = started;
  return started;
}

async function buildCurrentSnapshot(): Promise<UsageSnapshot> {
  const settings = getSettings();
  // Both are cached and neither throws, so this costs a transcript scan and,
  // at most once every five minutes, one HTTP request. The guard reads the
  // provider's own window fractions when they are there: a figure that can be
  // up to five minutes old but is on the right scale beats one that is
  // instant and low by a factor of four, which is what a fraction guard
  // measured against a typed ceiling was.
  const [{ entries }, plan] = await Promise.all([
    scanUsage(),
    settings.planUsageFromApi ? planUsage() : Promise.resolve(null),
  ]);
  const filtered = settings.includeSidechains
    ? entries
    : entries.filter((e) => !e.isSidechain);
  return buildSnapshot(
    filtered,
    limitConfig(settings),
    Date.now(),
    settings.sessionResetOverrideAt,
    plan,
  );
}

/**
 * Recover an estimate of what a killed work cycle spent.
 *
 * Cost is normally read from the CLI's own `result` event, which a cycle killed
 * mid-flight never emits — so without this it contributes $0 to a run that very
 * much burned tokens. The estimate comes from the same transcript pipeline the
 * dashboard uses: same dedupe key, same price table, same cache-TTL weighting.
 * It is kept in its own column rather than added to `spent_usd`, which stays a
 * floor of what the CLI itself measured.
 *
 * **It returns both sides of the display-versus-guard split, because a killed
 * cycle is exactly where collapsing them costs money.** `costUSD` is the
 * displayed figure and it is what `spent_usd_est` and the run's own log carry;
 * `costGuardUSD` charges an unpriced model the fallback rate and is what the
 * pre-cycle check, the live ticker and `--max-budget-usd`'s remainder read.
 * Summing `costUSD` alone left the guard side of a run on an unpriced model at
 * $0 however much it burned — so `maxRunCostUSD` could never fire on a run
 * whose cycles are always killed before they report, which is precisely the run
 * this function exists for. `metering.md`'s rule, at the one site that had it
 * backwards.
 *
 * Bounded by session *and* by the cycle's own time range, because a resumed
 * session copies earlier turns forward into the same file carrying their
 * original timestamps.
 *
 * Understates by at most the final turn: a record Claude Code had not finished
 * flushing when it died is left unconsumed by the incremental reader, and if the
 * process never writes again it stays that way.
 */
async function reconcileKilledCycle(
  sessionId: string | null,
  from: number,
): Promise<{ costUSD: number; costGuardUSD: number; tokens: number } | null> {
  if (!sessionId) return null;
  try {
    const { entries } = await scanUsage();
    const to = Date.now();
    let costUSD = 0;
    let costGuardUSD = 0;
    let tokens = 0;
    for (const e of entries as UsageEntry[]) {
      if (e.sessionId !== sessionId || e.ts < from || e.ts > to) continue;
      costUSD += e.costUSD;
      costGuardUSD += e.costGuardUSD;
      tokens += totalTokens(e.tokens);
    }
    return costUSD > 0 || costGuardUSD > 0 || tokens > 0
      ? { costUSD, costGuardUSD, tokens }
      : null;
  } catch {
    // An unreadable transcript directory is not a reason to fail a run that has
    // already stopped. The figure stays understated and the run says so.
    return null;
  }
}

export async function startRun(id: string): Promise<void> {
  const run = getRun(id);
  if (!run) throw new Error(`No such run: ${id}`);

  // Claim the run itself before anything else can. The conditional UPDATE is
  // the whole guard: two callers racing to promote the same queued run both
  // reach here, and exactly one sees a row change.
  //
  // COALESCE rather than an unconditional write: a run coming back from a pause
  // keeps its original start instant, so the duration guard measures the whole
  // run including the hours it spent parked. That is what makes wall clock the
  // terminus of a resuming run rather than a limit it can wait out.
  const claim = db()
    .prepare(
      "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?), resume_at = NULL WHERE id = ? AND status = 'queued'",
    )
    .run(Date.now(), id);
  if (claim.changes !== 1) return;

  const startedAt = run.started_at ?? Date.now();
  emit({
    runId: id,
    ts: Date.now(),
    kind: "status",
    payload: { status: "running", started_at: startedAt },
  });

  // Hydrated from the row, not zeroed: this call may be a resume, and the
  // continuation path it then takes (`continuationPrompt` plus `--resume`) is
  // selected purely by whether there is a session id to resume into.
  let spentUSD = run.spent_usd;
  let spentTokens = run.spent_tokens;
  let spentEstUSD = run.spent_usd_est;
  /**
   * The same recovered estimate charged at the guard rate, which is what every
   * `spentGuardUSD` below is built from. Separate from `spentEstUSD` for
   * `costUSD`/`costGuardUSD`'s reason: an unpriced model contributes $0 to the
   * displayed figure and the fallback rate to this one, so a run whose cycles
   * are always killed before they report had a guard reading of exactly zero.
   *
   * Hydrated from `spent_usd_est` because that column is the *displayed*
   * estimate and there is no guard column beside it — so what survives a
   * restart or a pick-up is a floor, and this segment's own killed cycles are
   * the part that is charged correctly. Understating a guard is the direction
   * that admits a cycle it should have refused, so it is named here rather than
   * left to be inferred from a column name.
   */
  let spentGuardEstUSD = run.spent_usd_est;
  let spentEstTokens = run.spent_tokens_est;
  let iterations = run.iterations;
  let doneRetriggers = run.done_retriggers;
  /**
   * Whether the most recent work cycle replied DONE. Hydrated for the same
   * reason `doneRetriggers` is: a segment that ends before any cycle completes
   * has learnt nothing new about what the agent last said.
   */
  let reportedDone = run.reported_done !== 0;
  let sessionId: string | null = run.session_id;
  // A fork this run adopted and never got a verdict for. `pendingFork` is
  // in-memory and dies with the loop, so a run parked or restarted between the
  // fork and its first resume came back holding a session nothing could roll
  // back from — and would fail outright rather than returning to the
  // conversation it had. Recovered from the table, which survives the gap.
  {
    const carried = pendingForkFor(id, sessionId);
    if (carried && !pendingFork.has(id)) pendingFork.set(id, carried);
  }
  // How many cycles the context ceiling has ended and refunded. See
  // `MAX_EARLY_ENDS_PER_RUN`.
  let earlyEnds = 0;
  /** The operator's message for the first cycle of this segment, if any. */
  let followUp: string | null = run.follow_up ?? null;
  let stopReason = "";
  let finalStatus: RunStatus = "completed";
  /** Set only by the needs-review branch, so any other ending clears the row. */
  let needsReviewReason: string | null = null;
  let lastExit = 0;
  let workDir = workDirOf(run);
  let incompleteIteration = false;
  /** Set when the run is stepping aside rather than ending. */
  let pausedUntil: number | null = null;
  /** The next prompt should be the DONE pushback rather than the continuation. */
  let justRetriggered = false;
  /**
   * The window the last cycle of **this segment** ended on, for `startsFresh`.
   *
   * Zero at the top of a segment on purpose, which is what stops a picked-up
   * run from restarting its first cycle: nothing here has read a window yet,
   * and a run resumed after a park is already opening on the conversation it
   * left. `transientRetries`' reasoning — this is a fact about a stretch of
   * work, not about the run, and it is not worth a column.
   */
  let lastContextTokens = 0;
  let cyclesThisSegment = 0;
  let resumeRetried = false;
  /** Transient API failures retried since the last cycle that got through. */
  let transientRetries = 0;
  /**
   * Whether this segment has already said its workflow's guard had nothing to
   * read. Held here rather than on the row for the reason `transientRetries` is
   * — it is about this stretch of work, not about the run for ever — and it
   * keeps a twenty-cycle run from writing the same line twenty times.
   */
  let saidUnenforceable = false;
  /** The same, for this run's *own* guard having nothing to read. */
  let saidGuardUnreadable = false;

  /**
   * Take a session id as the run's own, and record it immediately.
   *
   * `session_id` used to be written only in the post-cycle UPDATE, so anything
   * that stopped a first cycle from *returning* — a spawn failure, a container
   * restart mid-cycle — left the column null however far the cycle had actually
   * got. Picking that run back up then had no session to resume and re-sent the
   * original task: a literal restart, with the previous attempt's work still on
   * the branch and nothing telling the new agent it was there.
   */
  const adoptSession = (sid: string | null) => {
    if (sid === sessionId) return;
    sessionId = sid;
    db().prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(sid, id);
  };

  const applyInterrupt = (it: Interrupt) => {
    const outcome = interruptOutcome(it);
    stopReason = outcome.reason;
    finalStatus = outcome.status;
    pausedUntil = outcome.resumeAt;
  };

  // Everything that can throw belongs inside the try. Parsing the budget blob
  // outside it used to leave the row stuck at 'running' with the finally never
  // reached — which, now that a live row holds its folder, would block that
  // folder until the next restart.
  try {
    const budget = JSON.parse(run.budget) as BudgetPolicy & {
      permissionMode: PermissionMode;
    };
    const policy = normalizePolicy(budget);
    const settings = getSettings();

    // Fixed for the run, because it decides what the child is spawned with. A
    // Settings edit mid-run must not leave one cycle exporting and the next not,
    // which would read as the run's spend jumping backwards.
    const liveSpendTelemetry = needsLiveSpendTelemetry(policy);
    if (liveSpendTelemetry) {
      log(
        id,
        "Live spending limits are enforced from Claude Code's own per-request telemetry, which arrives while a cycle works. Expect a lag of a few seconds rather than an exact cut-off.",
      );
    }

    if (run.isolation === "worktree" && run.worktree_path && run.repo_root) {
      workDir = await ensureWorktree(run);
    }

    // The credential this run's cycles get, chosen once from the *repository*
    // rather than from `workDir` — an isolated run's cwd is its checkout under
    // `.uf-worktrees`, which no operator writes a token entry for. Resolved
    // here rather than per cycle because it is process configuration, fixed at
    // boot, and a run whose token changed between cycles would be a run that
    // pushed from one repository and not another with nothing saying why.
    const github = githubTokenFor(run.repo_root ?? run.folder);
    if (github.scope === "repository") {
      log(id, `GitHub credential scoped to ${github.key}`, { githubScope: github.key });
    } else if (github.scope === "none" && github.key !== null) {
      // Configured to have none, which is different from having none because
      // nothing was set — and the failure it produces looks identical: a `gh`
      // command refused inside a tool call.
      log(id, `No GitHub credential: ${github.key} is configured to get none`);
    }

    // Once per pick-up rather than per cycle, because `process.env` is fixed for
    // the life of this process: a line on every cycle would be the same line
    // eleven times. A reopened run says it again, and that is not redundant —
    // the container may have been recreated under a different compose file
    // since, which is the whole reason this is worth recording.
    //
    // These reach the agent whatever this app does (`CONTEXT_SHAPING_ENV`), and
    // until now nothing said so. A run whose agent compacted at a third of the
    // usual window looked identical to one that did not.
    const shaping = contextShapingEnv();
    if (shaping.length > 0) {
      log(
        id,
        `Context-shaping environment reaching this run's agent: ${shaping
          .map((v) => `${v.key}=${v.value}`)
          .join(", ")}. Set on this container, not by this app.`,
        { contextShapingEnv: shaping },
      );
    }

    for (;;) {
      const preScan = interrupts.get(id);
      if (preScan) {
        applyInterrupt(preScan);
        break;
      }

      const snapshot = await currentSnapshot();

      // A scan that could not read part of the tree answers with a short entry
      // list, and short understates every window below — which is the direction
      // that lets a guard admit a cycle it should have refused. Say so on the
      // run's own log, because the `budget` event beneath this one is
      // indistinguishable from a clean reading of a quiet week.
      const scanFailures = lastScanReadFailures();
      if (scanFailures.length > 0) {
        log(
          id,
          `Budget evaluated against a partial transcript scan: ${scanFailures.length} ` +
            `${scanFailures.length === 1 ? "path" : "paths"} could not be read ` +
            `(${scanFailures[0].path}: ${scanFailures[0].message}). The window ` +
            `figures below are a floor.`,
          { readFailures: scanFailures.length },
        );
      }

      const verdict: BudgetVerdict = evaluateBudget(
        policy,
        snapshot,
        {
          iterations,
          spentUSD,
          spentTokens,
          spentGuardUSD: spentUSD + spentGuardEstUSD,
          spentGuardTokens: spentTokens + spentEstTokens,
          startedAt,
          // What this task has cost before. Read here rather than inside the
          // guard so `evaluateBudget` stays a pure function of numbers.
          costBaseline: costBaselineFor(run),
        },
        Date.now(),
      );

      emit({
        runId: id,
        ts: Date.now(),
        kind: "budget",
        payload: {
          allowed: verdict.allowed,
          reason: verdict.allowed ? null : verdict.reason,
          code: verdict.allowed ? null : verdict.code,
          disposition: verdict.allowed ? null : verdict.disposition,
          // Whether the refusal above is one this run may be ended on. A
          // `no_ceiling` verdict is real and is recorded as one, and the run
          // carries on anyway — so without this the event says `allowed: false`
          // beside a cycle that then started, which reads as the log
          // disagreeing with itself.
          enforceable: enforceableForRun(verdict),
          meters: verdict.meters,
          weeklyFraction: snapshot.weekly.fraction,
          sessionFraction: snapshot.session.fraction,
          // How old the provider's percentage was, when that is what the two
          // fractions above came from. It is cached for five minutes and
          // served for up to an hour under a refusal, so without this a
          // verdict reached on an hour-old reading is indistinguishable in
          // the log from one reached a second after the window moved. Null is
          // "the reading was derived here, from transcripts", which has no age
          // to report — not "the reading was fresh".
          weeklyPlanAgeMs: planReadingAgeMs(snapshot, snapshot.weekly, Date.now()),
          sessionPlanAgeMs: planReadingAgeMs(snapshot, snapshot.session, Date.now()),
        },
      });

      // A refusal this run may not be ended on — `no_ceiling`, and only that:
      // the fraction guard's reading has gone, which on a stock install means
      // the provider's percentage was not readable this minute rather than the
      // operator having failed to configure anything. Logged and carried past,
      // the answer this app already gives an instance limit it cannot read and
      // a live spending limit whose telemetry never arrived, because ending
      // the run instead turns one endpoint's outage into a stopped fleet. Once
      // per segment, not once per cycle. The condition is refused where there
      // is a person: `POST /api/runs` and the reopen route both call
      // `windowGuardRefusal` before anything is created.
      if (!verdict.allowed && !enforceableForRun(verdict)) {
        if (!saidGuardUnreadable) {
          saidGuardUnreadable = true;
          log(
            id,
            `A guard on this run cannot be enforced right now: ${verdict.reason} ` +
              "The run carries on under its remaining guards.",
          );
        }
      } else if (!verdict.allowed) {
        stopReason = verdict.reason;
        if (verdict.disposition === "pause") {
          // The ordinary path for a well-behaved live-resume run: the cycle
          // finished on its own and the *next* one is what gets refused, so
          // nothing is thrown away.
          finalStatus = "paused";
          pausedUntil = verdict.resumeAt;
        } else {
          // Hitting a guard before any work happened is a different outcome
          // from running out mid-task; surface it distinctly so it is not
          // mistaken for a completed run.
          finalStatus = iterations === 0 ? "blocked" : "stopped";
        }
        break;
      }

      // This run's own guards said yes; the *install* may still say no. Read
      // here for `enforceInstanceBudget`'s reason one scope wider — this is the
      // moment the run is about to commit to spending and nothing has been
      // spawned yet — and ahead of the workflow check because it is the widest
      // ceiling: a run refused by it would be refused whatever workflow it
      // belongs to, and halting a whole instance over a limit that is not about
      // that instance would take down blocks that are not the problem.
      const installVerdict = installBudgetVerdict();
      if (installVerdict) {
        emit({
          runId: id,
          ts: Date.now(),
          kind: "budget",
          payload: {
            allowed: false,
            scope: "install",
            code: installVerdict.code,
            reason: installVerdict.reason,
            disposition: "stop",
            enforceable: true,
            meters: installVerdict.meters,
          },
        });
        stopReason = installVerdict.reason;
        finalStatus = iterations === 0 ? "blocked" : "stopped";
        break;
      }

      // This run's own guards said yes; the workflow it belongs to may still
      // say no. Evaluated here, off the snapshot that was just read, because
      // this is the one moment a member is about to commit to spending and
      // nothing has been spawned yet — the "between nodes" check, which for the
      // default single-cycle run is literally between two blocks. A tripped
      // instance guard halts *every* member through `stopInstance`, this run
      // included, so what comes back is an interrupt on the next line rather
      // than a verdict to act on here.
      //
      // Imported here rather than at the top of the file: `workflows.ts`
      // imports this module for `createRun` and `stopRun`, and a static import
      // back would make the pair a cycle. This call is already inside an async
      // function, past the point where both modules are fully evaluated.
      const { enforceInstanceBudget } = await import("./workflows");
      const instanceGuard = enforceInstanceBudget(id, snapshot);
      if (instanceGuard?.kind === "halted") {
        // One row, on the run whose check found it. The instance carries the
        // verdict for the workflow; this is what makes *this* run's log explain
        // why it stopped, rather than only naming the workflow that stopped it.
        emit({
          runId: id,
          ts: Date.now(),
          kind: "budget",
          payload: {
            allowed: false,
            scope: "workflow",
            code: instanceGuard.verdict.code,
            reason: instanceGuard.verdict.reason,
            disposition: "stop",
            meters: instanceGuard.verdict.meters,
          },
        });
      } else if (instanceGuard?.kind === "unenforceable" && !saidUnenforceable) {
        // Not acted on — see `INSTANCE_ENFORCEABLE_CODES` — but never silent: a
        // guard with nothing to read refuses nothing and looks exactly like a
        // guard that was never reached. Once per segment, not once per cycle.
        saidUnenforceable = true;
        log(
          id,
          `This run's workflow has a limit that cannot be enforced right now: ${instanceGuard.verdict.reason}`,
        );
      }

      // Re-check before committing to a cycle. The guard at the top of the loop
      // ran before an `await` that takes seconds on a large ~/.claude, and
      // `stopRun` promises "it will not start another work cycle" for a stop
      // landing in exactly that window — without this the operator is told
      // spending stopped and is then billed for a whole further cycle. It is
      // also what picks up the halt above: an instance guard that tripped has
      // already signalled this run through the one door a stop goes through.
      const preSpawn = interrupts.get(id);
      if (preSpawn) {
        applyInterrupt(preSpawn);
        break;
      }

      // Read before the increment below: what the next prompt needs to know is
      // how much this run had already been charged for *before* the cycle it is
      // about to open, which is what says whether opening with the task again
      // is a first attempt or a restart on top of existing work.
      const priorCycles = iterations;
      iterations += 1;

      // Drop the resume when the conversation this cycle would inherit is
      // already past what the operator is willing to pay for on every turn of
      // it. Done *here*, by clearing the loop's own session id, rather than by
      // teaching `nextPrompt` and `buildArgs` a second mode: every branch
      // downstream already asks "is there a session", and the cycle-1 path it
      // then takes — the task again, under `priorWorkNotice`, pointed at the
      // branch the work is on — is the handoff a picked-up run already gets.
      // Inventing a second way to say the same thing is how the two drift.
      //
      // The old session id is written off with it, and that is the intended
      // reading rather than a loss: `adoptSession` overwrites the column with
      // whatever this cycle opens, so a spawn that fails here leaves the run
      // reopening into the same restart it was about to make anyway.
      // Read into a local so the line below can name it: `startsFresh` takes
      // the null and answers false for it, but a message that quotes the
      // threshold has to have one to quote.
      const freshStartAt = settings.freshStartContextTokens;
      if (
        freshStartAt !== null &&
        startsFresh({
          sessionId,
          contextTokens: lastContextTokens,
          threshold: freshStartAt,
          justRetriggered,
          followUp,
        })
      ) {
        // On the run's own log, because nothing else would ever mention it. A
        // cycle that opened fresh looks, from every page in this app, exactly
        // like a cycle that resumed — same run, same branch, same counter — and
        // the one visible difference is a bill that moved for no stated reason.
        log(
          id,
          `Starting this work cycle fresh rather than resuming: the last one ended on about ${Math.round(lastContextTokens / 1000)}k tokens of context, past the ${Math.round(freshStartAt / 1000)}k this install restarts at. The task is sent again and the work so far is on disk; nothing of the previous conversation carries over.`,
        );
        adoptSession(null);
      }

      const prompt = nextPrompt({
        sessionId,
        followUp,
        justRetriggered,
        task: run.prompt,
        isolationPreamble:
          run.isolation === "worktree" ? settings.isolationPreamble : null,
        priorCycles,
        worktreeBranch:
          run.isolation === "worktree" ? run.worktree_branch : null,
        continuedFrom:
          run.continues_run && run.isolation === "worktree" && run.worktree_branch
            ? {
                runId: run.continues_run,
                branch: run.worktree_branch,
                base: run.worktree_base,
              }
            : null,
        continuedWork: settings.continuedWorkPrompt,
        continuation: settings.continuationPrompt,
        donePushback: settings.donePushbackPrompt,
        // Read off the same policy the loop's own exits read, so the promise
        // the opening prompt makes and the rule that ends the run cannot drift:
        // `continueAfterDone` is the flag at 6862 that sends a DONE agent back
        // in, and `maxIterations === 1` is the cap at 6883 that ends the run
        // before a second cycle could exist.
        endsOnDone: !policy.continueAfterDone && policy.maxIterations !== 1,
      });
      justRetriggered = false;

      // Cleared here rather than after the cycle returns, because this is the
      // point of no return for the message: a run that parks, crashes or is
      // killed from here on has already had it delivered, and replaying it on
      // the next pick-up would say the same thing twice into a conversation
      // that has already acted on it.
      if (followUp !== null) {
        followUp = null;
        db().prepare("UPDATE runs SET follow_up = NULL WHERE id = ?").run(id);
      }

      emit({
        runId: id,
        ts: Date.now(),
        kind: "iteration",
        payload: { n: iterations, prompt, resuming: sessionId },
      });

      // Taken here rather than immediately before the spawn so the row and this
      // frame agree on one instant. What sits between is `buildArgs` and one
      // containment check, and the direction of the error is the safe one: the
      // bound can only reach further into this cycle's own telemetry, never
      // back into the previous cycle, whose figures the UPDATE below has
      // already folded into `spent_usd`.
      const cycleStartedAt = Date.now();

      // Frozen here for the same reason: the ceiling this cycle is spawned
      // with is derived from it, and the two `+=` lines after the cycle
      // returns move it. Held so the branch that reports a cycle stopped at
      // its ceiling can say what that ceiling was rather than recomputing it
      // from a total that now includes the cycle itself.
      const spentGuardBeforeCycle = spentUSD + spentGuardEstUSD;

      // The same fact as the event above, on the row. The event only reaches a
      // page that is streaming this one run's log; everything that renders a
      // run as a *row* — the runs list, the run's own stat block — reads the
      // row, and until this was written it said `iterations = 0` for the whole
      // of the first cycle. Cleared in the post-cycle UPDATE below, so between
      // cycles it is null rather than naming a cycle that has already returned.
      //
      // `active_started_at` travels with it because a workflow instance's guard
      // reads this run's in-flight spend and has nowhere else to learn where the
      // cycle began — see the column's note on `RunRow`.
      db()
        .prepare(
          "UPDATE runs SET active_iteration = ?, active_started_at = ? WHERE id = ?",
        )
        .run(iterations, cycleStartedAt, id);

      // Resolved per cycle, for the reason the sandbox policy below is: a run
      // outlives the plugin list it started under, and each stored path is
      // re-proved contained at the moment it is used rather than trusted from
      // when it was switched on.
      const plugins = enabledPluginDirs();
      if (plugins.missing.length > 0) {
        // On the run's own log rather than left to be inferred. An agent that
        // stops receiving a plugin behaves exactly like one that never had it,
        // so nothing else in this app would ever mention it.
        log(
          id,
          `Enabled plugin${plugins.missing.length === 1 ? "" : "s"} not loaded for this cycle — no longer inside a workspace mount, or no longer a plugin directory: ${plugins.missing.join(", ")}`,
        );
      }

      // Same cycle, same reason, and deliberately *not* the run-scoped
      // `settings` a few lines up: the switch and the mount behind it are read
      // afresh here so that both reach a run already in flight, which is what
      // the plugin switch beside it does and what the settings page says both
      // of them do. The contrast with `liveSpendTelemetry` is the point — that
      // one is pinned for the run because changing it mid-run would make the
      // run's own spend appear to jump backwards, and nothing here has that
      // property.
      const vaultSkill = prepareVaultSkill();
      if (vaultSkill.kind === "unavailable") {
        log(
          id,
          `Vault skill not loaded for this cycle — ${vaultSkill.reason}. This cycle answers from its own knowledge instead.`,
        );
      }

      // Same cycle and the same argument, with one difference worth stating:
      // this one is safe to move under a run in flight in a way the file price
      // list next door is not. A hook is code the CLI runs, not text in the
      // cached prefix, so an operator switching it off because a run is
      // fighting it gets that at the next cycle and pays nothing for the
      // change.
      const readGuard = prepareReadGuard();
      if (readGuard.kind === "unavailable") {
        log(
          id,
          `Read guard not loaded for this cycle — ${readGuard.reason}. This cycle may re-read files it has already read.`,
        );
      }

      const args = buildArgs({
        prompt,
        model: run.model,
        permissionMode: budget.permissionMode ?? "acceptEdits",
        resumeSessionId: sessionId,
        pluginDirs: plugins.dirs,
        vaultSkill: vaultSkill.kind === "ready" ? vaultSkill : null,
        readGuardDir: readGuard.kind === "ready" ? readGuard.pluginDir : null,
        isolated: run.isolation === "worktree",
        // Written out as the guard's own expression rather than passed as one
        // number, because `buildArgs` is where the subtraction is tested and
        // because the two halves have to be read together: this is the figure
        // the pre-cycle check compared a few lines up, not `runs.spent_usd`.
        maxRunCostUSD: policy.maxRunCostUSD,
        spentGuardUSD: spentGuardBeforeCycle,
        // The run's own frozen copy, so every cycle — including one a restart
        // picks up hours later — opens as exactly the agent the operator started
        // it with, whatever has happened to the registry since. A copy rather
        // than an id is what makes that true, and it matters more now than it
        // did while the definition was merely being offered: an agent deleted
        // between cycle 3 and cycle 4 would leave cycle 4 selecting a name
        // nothing defines, which the CLI refuses at the spawn.
        agent: parseRunAgent(run.agent),
        // The row's own copy, on every cycle including a resumed one — the same
        // shape as `--plugin-dir` above and for a second reason on top of it.
        // `--resume` restores no `--append-system-prompt`, so a cycle that
        // omitted this would simply stop being told what a file costs; and
        // regenerating it here instead of reading it would change the cached
        // prefix mid-run, which costs more than the notice saves. Never
        // `fileCostNotice(...)` at this line.
        fileCostNotice: run.file_cost_notice,
        // Off the same `settings` read every prompt on this run comes from, so
        // it is fixed for the segment rather than per cycle. It changes only
        // what reaches the log — it is not a capability, nothing acts on it,
        // and the guards are unaffected either way.
        forwardSubAgentText: settings.forwardSubAgentText,
      });

      // A run can last hours, and the working directory was validated once when
      // it was created. Re-checking before every spawn means a folder that has
      // since been replaced by a symlink out of the mount cannot be handed to a
      // process that writes files.
      const stillContained = resolveWorkspaceFolder(
        workDir,
        describeFolder(workDir).mountId,
      );
      if (stillContained !== workDir) {
        throw new Error(`Working directory changed underneath the run: ${workDir}`);
      }

      // What this cycle may write, if anything confines it at all. Read per
      // cycle rather than per run for the reason the containment check above is:
      // a run outlives the policy it started under, and an operator who has
      // just switched one on gets it at the next cycle rather than at the next
      // restart. `workDir` is the local the check above re-proved, not the row,
      // because an isolated run's checkout is assigned after the row is read.
      const sandbox = sandboxSettings({ kind: "run", workDir, repoRoot: run.repo_root });
      const confinement = currentSandbox().state;
      if (sandbox.kind === "unconfined" && confinement !== "none") {
        // The one shape this can take on an install that asked for a sandbox: a
        // path the CLI would drop from a write set, so there is no per-run set
        // at all. Said on the run's own log rather than left to be inferred —
        // the install-wide policy still applies and the cycle still works, which
        // is exactly why nothing else here would ever mention it.
        log(
          id,
          `No per-run write set for this cycle: ${sandbox.reason}. The install's managed sandbox policy still applies; this run is not confined to its own checkout.`,
        );
      }
      args.push(...sandboxArgs(sandbox, confinement));

      // Captured before the spawn, because `adoptSession` may move `sessionId`
      // while the child is still running.
      const resumeTarget = sessionId;
      const usedResume = resumeTarget !== null;

      // Registered for exactly as long as a child exists. The closure reads
      // this function's own locals, which stay alive because it is suspended on
      // the await below — no database round trip, no second copy of progress.
      //
      // `spentUSD` and `spentTokens` are *not* among the things that move while
      // it is registered: both come from the CLI's terminal `result` event,
      // folded in below after `runIteration` returns, by which point the
      // `finally` has removed this entry. They are the completed cycles' total
      // and nothing else. The in-flight cycle is added from telemetry, which is
      // the only source that reports one run's spend before that run's cycle
      // ends — bounded by `cycleStartedAt` so the cycles that already reported
      // through `result` are not counted twice.
      if (policy.enforcement !== "between-cycles") {
        liveGuards.set(id, {
          policy,
          progress: () => {
            const inFlight = liveSpendTelemetry
              ? telemetrySpendSince(id, cycleStartedAt)
              : NO_TELEMETRY_SPEND;
            return {
              // The loop increments before it spawns, so the cycle in flight is
              // the one the pre-cycle guard has just authorised. Reporting it as
              // already used would make the first live tick kill it immediately.
              iterations: iterations - 1,
              // Reported spend stays what the CLI itself measured, so the run
              // page never shows an estimate as the run's cost.
              spentUSD,
              spentTokens,
              spentGuardUSD: spentUSD + spentGuardEstUSD + inFlight.costUSD,
              spentGuardTokens: spentTokens + spentEstTokens + inFlight.tokens,
              startedAt,
            };
          },
        });
        startLiveTicker();
      }

      // Unconditional, unlike the block above. This is the ceiling that replaced
      // `--autocompact`, and that flag did not ask about `enforcement`.
      // `pruningEnabled` is re-read on the tick rather than tested here, so an
      // operator switching the feature off reaches a cycle already in flight.
      contextWatches.set(id, { sessionId: () => sessionId, iteration: () => iterations });
      startLiveTicker();

      let res: IterationResult;
      try {
        res = await runIteration(
          id,
          workDir,
          args,
          liveSpendTelemetry,
          // Off the same `settings` read the prompts come from, so it is fixed
          // for this stretch of work rather than moving under a cycle already
          // in flight — `forwardSubAgentText`'s rule one argument over.
          cycleSilenceMs(settings.maxCycleSilenceMinutes),
          (sid) => {
            // A resume that comes back under a different id is recorded rather
            // than treated as a failure: which of the two Claude Code reports
            // for a `--resume` is its business, and this app has never observed
            // it against a real CLI. What is not acceptable is adopting it
            // silently — every later cycle resumes whatever landed here, and a
            // run that quietly changed conversation looks, from outside,
            // exactly like one that restarted.
            if (resumeTarget && sid !== resumeTarget && sessionId === resumeTarget) {
              log(
                id,
                `This work cycle asked to resume session ${resumeTarget}, and Claude Code reported session ${sid}. Later cycles will continue ${sid}.`,
              );
            }
            adoptSession(sid);
          },
          github.token,
        );
      } finally {
        liveGuards.delete(id);
        contextWatches.delete(id);
      }

      cyclesThisSegment += 1;
      lastExit = res.exitCode;

      // Settle the last boundary's fork here, where both facts are known: which
      // session this cycle was asked to resume, and whether it did any work.
      //
      // It used to be settled further down, past the exit-code branch, so a
      // cycle that ended by any route other than a clean exit left the row at
      // NULL for ever — the evidence was collected only from runs that finished
      // tidily, which is the population least likely to contain a bad fork. The
      // failure branch below takes over when the resume is the thing that
      // failed; this covers every other ending.
      const settling = pendingFork.get(id);
      if (settling && resumeTarget === settling.forkSessionId) {
        const worked = res.sawResult || res.finalText !== "";
        if (worked) {
          pendingFork.delete(id);
          if (settling.rowId !== null) markForkResumed(settling.rowId, true);
        }
        // Not `worked` falls through: that is the resume-failure shape, and the
        // branch below owns it, including the rollback.
      } else if (settling) {
        // The cycle resumed something else — `startsFresh` dropped the
        // conversation, or an operator intervened. The fork was never tried, so
        // it is neither a pass nor a failure and the row stays NULL.
        pendingFork.delete(id);
      }

      // Say so when the live spend guard was blind. Exporting is configured by
      // `telemetryEnv`, but nothing guarantees the records arrive — an ingest
      // that fails leaves `telemetrySpendSince` returning zero, and a guard
      // reading zero refuses nothing while looking exactly like a guard that
      // was simply never reached. Checked here because this is the first point
      // with something to compare against: the CLI's own figure for the cycle
      // the ticker was watching.
      if (liveSpendTelemetry && res.sawResult && res.costUSD > 0) {
        const reported = telemetrySpendSince(id, cycleStartedAt);
        if (reported.requests === 0) {
          log(
            id,
            `This work cycle cost $${res.costUSD.toFixed(2)} and reported no telemetry, so the live spending limit had nothing to read while it ran. It was enforced between cycles only.`,
          );
        }
      }

      spentUSD += res.costUSD;
      spentTokens += res.tokens;
      // Assigned rather than latched, unlike `incompleteIteration` below: what
      // the next cycle would inherit is what *this* cycle ended on, and a cycle
      // that reported no usage at all leaves the previous reading standing
      // rather than resetting it — `startsFresh` refuses on a zero either way,
      // and the last real reading is the better guess of the two.
      if (res.contextTokens > 0) lastContextTokens = res.contextTokens;
      // Latched, not assigned: a cycle that died before reporting its cost
      // leaves the run's total understated for the rest of the run, and a
      // later cycle that reports normally does not undo that.
      incompleteIteration ||= !res.sawResult;
      // No `sessionId = res.sessionId` here: the stream callback above already
      // adopted it, the moment it was reported rather than once the cycle
      // returned. Re-reading it from the result would be a second write path
      // saying the same thing later.

      // The cycle died before Claude Code reported what it cost, so the two
      // `+=` lines above added nothing. Recover an estimate from the transcripts;
      // it is held apart from `spent_usd` and reported as an estimate.
      //
      // Two figures, and which one goes where is the point: `costUSD` is what
      // the run reports and what `spent_usd_est` stores, `costGuardUSD` is what
      // the next pre-cycle check and the next `--max-budget-usd` remainder are
      // computed from. They differ only for an unpriced model, which is the
      // case where taking the first for both leaves the guard at zero.
      if (!res.sawResult) {
        const recovered = await reconcileKilledCycle(sessionId, cycleStartedAt);
        if (recovered) {
          spentEstUSD += recovered.costUSD;
          spentGuardEstUSD += recovered.costGuardUSD;
          spentEstTokens += recovered.tokens;
        }
      }

      db()
        .prepare(
          "UPDATE runs SET iterations = ?, spent_usd = ?, spent_tokens = ?," +
            " spent_usd_est = ?, spent_tokens_est = ?, session_id = ?," +
            " done_retriggers = ?, active_iteration = NULL," +
            " active_started_at = NULL WHERE id = ?",
        )
        .run(
          iterations,
          spentUSD,
          spentTokens,
          spentEstUSD,
          spentEstTokens,
          sessionId,
          doneRetriggers,
          id,
        );

      // Did the CLI summarise this run's conversation while the cycle ran?
      //
      // Read here rather than watched for, and after the row is written rather
      // than before it. The CLI compacts a `-p` session unprompted and says
      // nothing about it on the stream, but it writes a full `compact_boundary`
      // record to the transcript — so this is a reading of a completed
      // compaction, arriving a couple of minutes after the fact, and not a
      // warning that one is about to happen. Nothing here acts on it: no
      // threshold, no flag, no guard, no `sessionId` cleared. A `PreCompact`
      // hook is the only way to learn it in advance and nothing in this app
      // needs to, because nothing here is allowed to intervene.
      //
      // After the cycle has returned, which is what makes the file complete:
      // a turn only reaches a transcript when Claude Code flushes it, and by
      // this point the child has exited. Bounded by `cycleStartedAt` so a
      // resumed session's copied-forward boundaries are not re-reported at the
      // end of every later cycle — `reconcileKilledCycle`'s bound, for its
      // reason.
      //
      // Before the interrupt check below, so a cycle an operator stopped still
      // says what happened to its conversation. An interrupt landing during
      // this read is still caught: the check reads `interrupts` afterwards.
      try {
        const compactions = await readCompactions(sessionId, {
          from: cycleStartedAt,
          to: Date.now(),
        });
        if (compactions.length > 0) {
          // Off this cycle's own argv rather than a list of what this app
          // injects, so a cycle spawned without plugins reports no skills and a
          // future flag reports itself as unclassified.
          const injections = injectionFates(args);
          for (const boundary of compactions) {
            log(id, compactionNotice(boundary, injections), {
              compaction: {
                trigger: boundary.trigger,
                preTokens: boundary.preTokens,
                postTokens: boundary.postTokens,
                durationMs: boundary.durationMs,
                cliVersion: boundary.cliVersion,
              },
            });
          }
        }
      } catch (err) {
        // Said rather than swallowed, and it does not fail the cycle. A read
        // that returned nothing quietly would be indistinguishable from a
        // conversation that was never compacted, which is the exact failure
        // this whole reading exists to remove.
        log(
          id,
          `Could not read this run's transcript for compactions: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Before the exit-code test, because a killed child closes with a null
      // code that reads as -1. Judging that as a crash would file every stop —
      // operator or guard — as a red `failed` run.
      const postCycle = interrupts.get(id);
      if (postCycle?.kind === "prune") {
        // The one interrupt that does not end the run, so it is taken off the
        // map here rather than passed to `applyInterrupt` — which has no status
        // meaning "carry on" and would file this as a `stopped` run.
        //
        // Ordered ahead of every test below for the reason the general interrupt
        // check is: the child was killed, so it closed with a null code that
        // reads as -1 and reported no `result`. Judging that as a crash, or as a
        // refusal, would end a run that is working exactly as configured.
        interrupts.delete(id);
        log(id, postCycle.reason);

        // Refunded, bounded. A compaction never cost a work cycle, so a ceiling
        // crossing that consumed one would quietly change what `maxIterations`
        // buys; but an unbounded refund is a run with no terminus, which
        // `budgets-and-guards.md` forbids. Past the cap the crossing still
        // prunes and simply counts.
        if (earlyEnds < MAX_EARLY_ENDS_PER_RUN) {
          earlyEnds += 1;
          iterations -= 1;
          // Written straight back to the row, which the pause path above does
          // not need to do and this one does. The UPDATE a few lines up has
          // already stored the *un*-refunded count, and a paused run is picked
          // up later by a different path that writes its own; this one carries
          // on inside the same loop, so nothing else would correct the row until
          // the next cycle ends — and by then the counter has been re-incremented
          // to the same number, so it never corrects at all. The visible effect
          // is a "Work cycles" bar that advances the moment the ceiling fires,
          // while the run is still working on the cycle it was refunded for.
          db()
            .prepare("UPDATE runs SET iterations = ? WHERE id = ?")
            .run(iterations, id);
        }

        // Captured before the cut, because `adoptSession` reassigns `sessionId`
        // and the probe is a statement about the conversation that was standing
        // at this boundary — the same reason `pruneAtBoundary` passes its own
        // parameter rather than whatever the fork adopted.
        const boundarySessionId = sessionId;
        const boundaryContextTokens = lastContextTokens;
        const earlyEndOutcome = await pruneAtEarlyEnd(id, sessionId, adoptSession);
        lastContextTokens = contextAfterPrune(
          lastContextTokens,
          // `adoptSession` and not `prune` directly: under the fork engine this
          // writes a new transcript and the run has to move onto it, exactly as
          // at a natural boundary. Passing the closure is what lets it.
          earlyEndOutcome,
        );
        // The other half of the boundary bookkeeping, and it was missing here.
        // `settleBoundary` was called only from `pruneAtBoundary`, so on an
        // install where the context ceiling reaches every run before a natural
        // boundary does — which is this one, 50 early-end receipts against 2 —
        // `resume_probes` stayed empty for ever. That table is the control group
        // `boundaryInvalidation` needs before it will charge anything, so with
        // it empty every boundary cut was priced at $0 and the reported net
        // could not go negative. An empty control is not a neutral state: it is
        // the one that silently restores the assumption the control exists to
        // test.
        await settleBoundary(
          id,
          boundarySessionId,
          earlyEndOutcome !== null,
          boundaryContextTokens,
        );
        continue;
      }
      if (postCycle) {
        applyInterrupt(postCycle);
        // A cycle the live guard cut short is refunded to the counter: the
        // resume continues this same conversation rather than starting fresh
        // work, and charging it would mean `live-resume` with a single work
        // cycle could only park and then stop at `cycles` without ever
        // finishing. `MAX_PAUSES_PER_RUN` bounds the refund, so one cycle is at
        // most four billed invocations. Only here — `applyInterrupt`'s other
        // two call sites run *before* the increment above, and refunding there
        // would discount a cycle that completed.
        if (postCycle.pause) iterations -= 1;
        break;
      }

      // This run's own spending limit, reached inside the cycle rather than
      // between two of them. The ordering is load-bearing in both directions.
      //
      // *After* the interrupt check, because an operator stop or a guard kill
      // that landed while this cycle was finishing is a decision this app made
      // about the run, and the first interrupt wins everywhere else too.
      //
      // *Before* the refusal test, and that is the expensive one to get wrong.
      // The CLI latches its own summary of a non-success `result` into
      // `apiError`, so this cycle arrives at that test carrying a sentence
      // about a budget — and `isUsageLimit` matches "reached your … limit"
      // loosely on purpose, because the provider's own wall labels its windows
      // per model and per window. A ceiling this app handed over would then be
      // read as the subscription allowance running out, and under `live-resume`
      // the run would park and wait hours for an allowance to refill that has
      // nothing to do with why it stopped. `isUsageLimit` excludes `spend` and
      // `credit` by name for that reason; it cannot also exclude every wording
      // of a budget, and it should not have to when the CLI states the cause in
      // a field.
      //
      // Not a failure and not a retry: the cycle did the work it could afford,
      // reported its cost through `result` like any other, and stopping is the
      // whole point. `stopped` is the word the pre-cycle `run_cost` verdict
      // already ends a run with, and the cycle stays charged to `iterations`
      // because it happened.
      if (res.subtype === "error_max_budget_usd") {
        stopReason =
          policy.maxRunCostUSD === null
            ? "Claude Code stopped this work cycle at a spending ceiling of its own."
            : `This work cycle was given what was left of this run's $${policy.maxRunCostUSD.toFixed(
                2,
              )} spending limit after the $${spentGuardBeforeCycle.toFixed(
                2,
              )} already spent, and Claude Code stopped it there.`;
        // Into the log as well as onto the row. Every other way a run ends puts
        // a sentence in the stream — a refusal emits `error`, a tripped guard
        // emits `budget` — and a run that simply changed status with the reason
        // only on the row reads, in the pane the operator is watching, like a
        // cycle that stopped for no stated reason at all. Not a `budget` event:
        // that shape is an `evaluateBudget` verdict, and this rule was enforced
        // by the CLI rather than decided here.
        log(id, stopReason);
        finalStatus = "stopped";
        break;
      }

      // Before the exit-code test for the same reason the interrupt check is:
      // a refusal kills the cycle non-zero, and testing the code first files
      // the provider's decision as the agent crashing. It also has to come
      // before the DONE test below, because a refusal that exits 0 would
      // otherwise match nothing and re-spawn straight back into the wall.
      const refusal = res.apiError ?? refusalInStderr(res.stderrTail);

      // A transient error the CLI recovered from is not a refusal at all, and
      // this is the difference between the two halves of the same fault. When a
      // stream drops after some blocks have been yielded, Claude Code finalises
      // the partial response with an ordinary `end_turn` and carries the cycle
      // on: the `<synthetic>` turn saying `Connection closed mid-response` is
      // then a *warning about a completed cycle*, followed by a clean `result`
      // and exit 0. `apiError` latches on first sight and nothing downstream
      // asked whether the cycle went on to succeed, so a run whose work cycle
      // finished was still being ended by the marker it left behind.
      //
      // Both conditions are load-bearing. Success is read from the CLI's own
      // verdict — its `result` event, a success subtype and a zero exit — never
      // inferred from the text. And an allowance refusal is excluded by name,
      // because a wall that somehow exits 0 must still stop the run rather than
      // re-spawn into itself; that is the whole reason this test sits ahead of
      // the exit-code test.
      const recovered =
        refusal !== null &&
        res.sawResult &&
        !res.isError &&
        res.exitCode === 0 &&
        !isUsageLimit(refusal) &&
        isTransientApiError(refusal);
      if (recovered) {
        log(
          id,
          `Claude Code reported an API error and recovered from it within the work cycle: ${refusal}`,
        );
      }

      if (refusal && !recovered) {
        // A dropped connection is neither the wall nor the agent's doing, and
        // it clears in seconds — so it is retried here rather than parked or
        // reported as a failure. The wall is named first because an exhausted
        // allowance is not something backing off five seconds can fix.
        const kind = refusalKind(refusal);
        const limited = kind === "allowance";
        const plan = refusalDisposition({
          kind,
          pauseCount: run.pause_count ?? 0,
          transientRetries,
        });
        const retrying = plan.action === "retry";
        // Jittered, so twenty-five runs meeting one failure at one instant do
        // not re-spawn as one wave — see `transientBackoffMs`.
        const backoff = plan.action === "retry" ? transientBackoffMs(plan) : 0;

        emit({
          runId: id,
          ts: Date.now(),
          kind: "error",
          payload: {
            // The log line renders `message`, and this event had none — so the
            // one entry that says why a run died read `✗ undefined`, with the
            // actual sentence only on the row's stop reason.
            message:
              plan.action === "retry"
                ? `${refusal} — retrying in ${Math.round(backoff / 1000)}s (${
                    transientRetries + 1
                  } of ${maxRetriesFor(plan.kind)}).`
                : refusal,
            apiError: refusal,
            exitCode: res.exitCode,
            usageLimit: limited,
            waiting: plan.action === "park",
            retrying,
          },
        });

        if (retrying) {
          transientRetries += 1;
          // Refunded for the same reason a parked cycle is: the loop increments
          // before it spawns, so this cycle has already been charged for a turn
          // that never completed. Left charged, a run with `maxIterations: 1`
          // could only ever retry into its own cycle cap.
          iterations -= 1;
          // And this segment still has not completed a cycle, which is exactly
          // what `cyclesThisSegment` counts. Without the matching decrement a
          // retry that fails to resume the session is no longer the segment's
          // first cycle, so `looksLikeResumeFailure` stops recognising it and
          // the run reports "exited with code 1" instead of naming the session.
          cyclesThisSegment -= 1;
          await waitUnlessInterrupted(id, backoff);
          continue;
        }

        if (plan.action === "park") {
          // Not `snapshot.session.endsAt`. This snapshot predates the cycle, so
          // it is clean of *this* refusal — but a run that woke at an early
          // boundary and was refused again scans a tree that already holds the
          // previous refusal's zero-token record, and that record opens a block
          // of its own reading as a window five hours out.
          pausedUntil = refusalResumeAt({
            boundary: lastSpendingWindowEnd(snapshot),
            pauseCount: run.pause_count ?? 0,
            now: Date.now(),
          });
          stopReason =
            "Claude refused the work cycle: the subscription allowance is used up. " +
            "Waiting for it to refill.";
          finalStatus = "paused";
          // Refunded for the same reason a guard-interrupted cycle is, and with
          // more force: the provider refused before any work happened at all.
          iterations -= 1;
          break;
        }

        stopReason = refusalStopReason(plan.cause, refusal);
        finalStatus = "failed";
        break;
      }

      // Reached only when this cycle was not cut short by a transient failure,
      // which is what makes the count above "in a row": a run that meets one
      // blip an hour must never accumulate its way to a stop.
      transientRetries = 0;

      if (res.exitCode !== 0 || res.isError) {
        // A cycle resuming a session that a kill truncated mid-turn can be
        // rejected before it does any work — an assistant turn holding a
        // `tool_use` with no matching result is not a message list the API will
        // accept. One retry covers a transient failure. A second identical one
        // is the session itself, and the honest move is to stop and name the
        // command rather than quietly start a fresh session and lose the
        // conversation the resume existed to keep.
        //
        // `usedResume && cyclesThisSegment === 1` is exactly "this segment
        // opened by resuming a session an earlier one left behind": no cycle in
        // this segment has completed yet, so the id can only have come off the
        // row. It deliberately no longer also requires the earlier segment to
        // have ended in a *pause* — a truncated session is a truncated session
        // whether a guard parked the run or a crash ended it, and a run picked
        // up by hand has `pause_count === 0`, so that condition excluded the
        // one case an operator is watching.
        // "This cycle did no work at all", split out because two callers need
        // it and only one of them wants the segment-position term.
        const didNoWork = !res.sawResult && res.finalText === "";
        const looksLikeResumeFailure =
          usedResume && cyclesThisSegment === 1 && didNoWork;
        // A fork's resume failure is not the same shape. `cyclesThisSegment === 1`
        // means "this segment opened on a session an earlier one left behind",
        // which is a statement about how the *segment* started — and a fork is
        // adopted at a cycle boundary in the middle of a segment, so the counter
        // is already 2 or more by the time the fork's first resume is attempted.
        // Inheriting that term made the rollback below unreachable, and with it
        // the only writer of `fork_attempts.resumed = 0`: the column that is
        // milestone 2's kill condition could never hold the value that trips it.
        const forkWouldNotResume = usedResume && didNoWork;
        // A fork that will not resume, caught on the one cycle that can catch
        // it. Taken before the ordinary retry, because retrying the same
        // unresumable id would burn the single retry the run gets and then fail
        // for a reason that names the fork rather than the cause.
        //
        // The verdict goes on the row either way. This column is milestone 2's
        // first criterion — "given a forked session, when `claude --resume` runs,
        // then it exits 0" — and a 0 in it is that guardrail's kill condition,
        // reached by a resume the run actually needed.
        const fork = pendingFork.get(id);
        if (forkWouldNotResume && fork && fork.fallbackSessionId) {
          pendingFork.delete(id);
          if (fork.rowId !== null) markForkResumed(fork.rowId, false);
          iterations -= 1;
          cyclesThisSegment = 0;
          adoptSession(fork.fallbackSessionId);
          log(
            id,
            `The forked conversation would not resume, so this run is back on the ` +
              `one it had before the fork (${fork.fallbackSessionId}). The fork is ` +
              `still on disk and nothing was lost. Winnow's own guardrail counts ` +
              `this as a failure and it is recorded as one.`,
          );
          continue;
        }
        if (looksLikeResumeFailure && !resumeRetried) {
          resumeRetried = true;
          iterations -= 1;
          cyclesThisSegment = 0;
          // Back to the id this cycle was asked to resume. A cycle that failed
          // this test did no work at all, so anything the stream named — an
          // empty session the CLI opened before giving up — is worth less than
          // the conversation the retry exists to get back into.
          adoptSession(resumeTarget);
          log(
            id,
            "Resuming the previous session failed before it did any work. Trying once more.",
          );
          continue;
        }
        stopReason = looksLikeResumeFailure
          ? `Could not resume this run's Claude Code session (exit ${res.exitCode}). Its work is still on disk; pick it up by hand with: claude --resume ${resumeTarget}`
          : `Claude Code exited with code ${res.exitCode}.`;
        finalStatus = "failed";
        break;
      }

      // What this cycle's last turn said about the task, if anything. The
      // precedence between the two tokens lives in `cycleEnding` rather than
      // here, so the branch below and the test that pins it cannot disagree.
      const ending = cycleEnding(res.finalText);

      // Below every test above it, and that placement is the whole decision.
      // Everything above is a statement about the *machine* — a person stopping
      // the run, a ceiling the CLI enforced, the provider refusing, the child
      // dying — and this is the only rung that is a statement about the task.
      // Filing a provider wall or a dropped socket as the agent's judgement
      // would be a lie about who decided, and it would send an operator who came
      // to read what the agent could not do to a 429. A cycle that names the
      // sentinel and then exits non-zero is `failed` for the same reason: the
      // exit code is the CLI's own verdict that the cycle did not complete, and
      // the text may be a partial stream finalised after a truncation.
      if (ending === "needs-review") {
        // Cleared explicitly, and this is the trap. `reportedDone` is hydrated
        // from the row rather than being a fresh local, so a branch that breaks
        // out without touching it writes a stale 1 for a run picked up after an
        // earlier DONE — which then sends `donePushbackPrompt` into a run that
        // never said it was finished.
        reportedDone = false;
        needsReviewReason = clipReason(res.finalText);
        stopReason =
          "Agent reported that it could not complete the task. What it said is on this run's page.";
        // `error_max_budget_usd`'s rule: every other way a run ends puts a
        // sentence in the stream the operator is watching, and one that only
        // changed status reads there like a cycle that stopped for no reason.
        log(id, stopReason);
        finalStatus = "needs-review";
        break;
      }

      // Completion signal from the continuation protocol. Recorded even when it
      // is absent, because "the agent said the task was finished" is the only
      // thing that separates a `completed` run from one that simply ran out of
      // work cycles below, and the answer is gone by the time the run is picked
      // up again.
      reportedDone = ending === "done";
      if (reportedDone) {
        if (!policy.continueAfterDone) {
          stopReason =
            doneRetriggers > 0
              ? `Agent reported the task complete after ${doneRetriggers} further work ${
                  doneRetriggers === 1 ? "cycle" : "cycles"
                }.`
              : "Agent reported the task complete.";
          finalStatus = "completed";
          break;
        }
        // The operator asked for the budget to be spent rather than for the
        // agent's own judgement to end the run. Fall through to the cap check
        // below, so "keep going" still cannot mean "keep going forever".
        doneRetriggers += 1;
        justRetriggered = true;
        log(
          id,
          `Agent reported the task complete, but this run is set to carry on until a limit stops it (${doneRetriggers} so far).`,
        );
      }

      if (policy.maxIterations !== null && iterations >= policy.maxIterations) {
        stopReason = `Used all ${policy.maxIterations} work ${
          policy.maxIterations === 1 ? "cycle" : "cycles"
        } allowed for this run.`;
        finalStatus = "completed";
        break;
      }

      // The boundary prune, and its position in this loop is the whole of why
      // it is free.
      //
      // Every `break` above has been passed, so another cycle is going to run
      // and it is going to `--resume` this session — which rewrites the cached
      // prefix whatever we do here. That is the `2·D` term in
      // `contextPruning.ts`'s arithmetic being refunded: the edit costs nothing
      // it was not about to cost anyway, and every turn of the next cycle then
      // carries less. Moved above any of those breaks and it would prune a
      // transcript nothing resumes, paying a rewrite for a conversation that has
      // ended.
      //
      // Awaited rather than left floating. It is seconds of subprocess against a
      // cycle measured in minutes, and the next spawn must not read the file
      // while winnow is rewriting it.
      lastContextTokens = contextAfterPrune(
        lastContextTokens,
        await pruneAtBoundary(id, sessionId, lastContextTokens, adoptSession),
      );
    }
  } catch (err) {
    stopReason = err instanceof Error ? err.message : String(err);
    finalStatus = "failed";
    emit({
      runId: id,
      ts: Date.now(),
      kind: "error",
      payload: { message: stopReason },
    });
  } finally {
    procs.delete(id);
    interrupts.delete(id);
    liveGuards.delete(id);
    contextWatches.delete(id);
    forgetContextCheck(id);
    earlyEndDeclined.delete(id);
    ceilingMeasuredAt.delete(id);
    compositionMeasuredAt.delete(id);
    boundaryDeclines.delete(id);
    pendingFork.delete(id);
    // The exporter's credential dies with the run's loop, the way the chat's
    // dies with its turn — on a short grace, because the exporter batches on a
    // one-second timer and revoking on the instant would drop the tail of the
    // last cycle and understate what the run spent.
    revokeIngestTokens(id);

    // Spend is only ever read from the CLI's `result` event, so a cycle killed
    // before that event lands contributes $0 to `spent_usd`. Say what was
    // recovered instead of letting the total read as measured fact.
    if (spentEstUSD > 0) {
      stopReason = [
        stopReason,
        `A work cycle ended before Claude Code reported its cost; $${spentEstUSD.toFixed(2)} of this run's spend is reconciled from transcripts rather than measured.`,
      ]
        .filter(Boolean)
        .join(" ");
    } else if (incompleteIteration) {
      stopReason = [
        stopReason,
        "A work cycle ended before Claude Code reported its cost, so this run's spend is understated.",
      ]
        .filter(Boolean)
        .join(" ");
    }

    const carried: Partial<RunRow> = {
      stop_reason: stopReason,
      iterations,
      spent_usd: spentUSD,
      spent_tokens: spentTokens,
      spent_usd_est: spentEstUSD,
      spent_tokens_est: spentEstTokens,
      done_retriggers: doneRetriggers,
      reported_done: reportedDone ? 1 : 0,
      // Written on every ending, not only the one that sets it: the column
      // describes the ending this row records, so a run picked up and finished
      // some other way must not keep the reason its previous segment left.
      needs_review_reason: needsReviewReason,
      work_dir: workDir,
      session_id: sessionId,
      // No cycle is in flight once this function is unwinding, on any path —
      // including the one that threw before the post-cycle UPDATE could clear
      // it. A finished run still claiming an open cycle is the same lie as a
      // working run reading zero, in the other direction.
      active_iteration: null,
      active_started_at: null,
    };

    if (finalStatus === "paused") {
      // A parked run is not finished. `finished_at` and `exit_code` stay unset
      // so nothing reports a run that is about to spend more money as over, and
      // it keeps its folder, branch and session for the resume.
      setStatus(id, "paused", {
        ...carried,
        resume_at: pausedUntil,
        paused_at: Date.now(),
        pause_count: (run.pause_count ?? 0) + 1,
      });
      startSweeper();
    } else {
      setStatus(id, finalStatus, {
        ...carried,
        finished_at: Date.now(),
        exit_code: lastExit,
        resume_at: null,
      });
    }

    // The workflow-wide guard's other boundary, and the only one that can see
    // what this member *spent*. Every other call is before something spends,
    // which for the ordinary single-cycle block is one check against a total of
    // zero and then nothing — `evaluateBudget` refuses the next pass on
    // `iterations` and breaks out before the pre-cycle instance check is
    // reached, so a graph released together never compared its limit with a
    // figure that had moved. The status write above has just put this run's
    // spend on its row, which is what `instanceSpend` reads.
    //
    // Not awaited, for `emitHandoff`'s reason and one more: `releaseDependents`
    // and `promoteQueued` below are synchronous by requirement — the folder
    // claim is only atomic inside one event-loop turn — and an `await` here
    // would put a full transcript scan in front of both. Nothing escapes by
    // going first: a member promoted in the meantime meets the same guard at
    // its own pre-cycle check before any child is spawned.
    void import("./workflows")
      .then((m) => m.enforceInstanceBudgetAfterMember(id))
      .catch(() => {
        /* a workflow we cannot guard is not a reason to fail a finished run */
      });

    // Only once there is something to hand off, and only when the run is really
    // over. A run that never got past the budget guard, or died setting its
    // checkout up, has no branch to describe — and a parked one is not done
    // with its branch yet. Not awaited: the run is already in its terminal
    // state, and the card is an extra event on a stream that replays from
    // storage.
    if (
      finalStatus !== "paused" &&
      run.isolation === "worktree" &&
      run.worktree_path &&
      iterations > 0
    ) {
      void emitHandoff(id, run, workDir).catch(() => {
        /* a handoff we cannot describe is not worth failing a finished run */
      });
    }

    // This run has just settled, so anything told to start after it now knows
    // whether it may. Before the promotion, so a run released here takes its
    // turn in the same pass rather than waiting for the next event.
    if (finalStatus !== "paused") releaseDependents();

    // The folder is free as of the status write above, so whatever was waiting
    // on it can start. Must come after, or the promotion sees this run still
    // holding its own folder and parks the next one again.
    promoteQueued();
  }
}

/* ------------------------------------------------------------------ */
/* Interrupting a run in flight                                        */
/* ------------------------------------------------------------------ */

export type StopOutcome = "signalled" | "cancelled" | "not-active";

/**
 * Record why a run is stopping and signal its child, if it has one.
 *
 * The single kill path for both callers. `stopRun` and the live guard reach the
 * same code because the mechanics are identical — only the recorded reason and
 * whether the run may come back differ, and both of those travel in the
 * `Interrupt`.
 */
function interruptRun(id: string, it: Interrupt): "signalled" | "cancelled" {
  // First interrupt wins. An operator stop landing just after a guard kill must
  // not rewrite why the run ended, and re-signalling a dying child does nothing.
  if (!interrupts.has(id)) {
    interrupts.set(id, it);
    // Announced before the signal, so the log explains the kill even when the
    // child dies instantly and the loop's own checkpoint is the next thing to
    // run.
    if (it.kind === "guard") {
      emit({
        runId: id,
        ts: it.at,
        kind: "budget",
        payload: {
          allowed: false,
          live: true,
          code: it.code ?? null,
          reason: it.reason,
          disposition: it.pause ? "pause" : "stop",
          resumeAt: it.resumeAt ?? null,
        },
      });
    } else {
      log(id, it.reason);
    }
  }

  const child = procs.get(id);
  if (!child) return "cancelled";

  // SIGINT first: it is the signal a CLI is most likely to handle deliberately,
  // and one that handles it may still print its `result` event — the difference
  // between this cycle's spend being measured and being reconciled. An
  // unhandled SIGINT terminates by default, so trying it costs only the three
  // seconds before the ladder escalates.
  //
  // Each step tests whether the child is still registered — `finish` removes it
  // — and deliberately not `child.killed`, which only records that a signal was
  // *sent* and is already true, so including it meant SIGKILL was never reached.
  signalTree(child, "SIGINT");
  setTimeout(() => {
    if (procs.get(id) === child) signalTree(child, "SIGTERM");
  }, 3_000).unref?.();
  setTimeout(() => {
    if (procs.get(id) === child) signalTree(child, "SIGKILL");
  }, 8_000).unref?.();
  return "signalled";
}

/**
 * What a stop is recorded as when the caller says nothing: this run, this
 * button. Every branch below appends its own clause to it, which is why it is a
 * fragment with no full stop rather than a sentence.
 */
const OPERATOR_CAUSE = "Stopped by operator";

/**
 * Ask a run to stop.
 *
 * The distinction matters to the caller: between work cycles there is no child
 * to signal, but the run is still stopped — the loop checks for an interrupt
 * before starting the next one. Reporting that as a failure (which a bare
 * boolean did) makes a working Stop button look broken.
 *
 * `cause` is the attribution, and it is a **fragment**: each branch appends the
 * clause saying what the run was doing when the stop landed, so the sentence
 * says both who stopped it and how far it had got. It exists because stopping a
 * whole workflow instance goes through this same path — the task's "do not write
 * a second way to signal a child" — and a member of a halted instance has to be
 * tellable on sight from a run someone stopped on its own page. Callers pass
 * something like `Stopped with workflow “Nightly” by its budget guard`; the
 * detail behind a guard's verdict belongs on the instance, once, rather than
 * repeated across ten rows.
 */
export function stopRun(id: string, cause: string = OPERATOR_CAUSE): StopOutcome {
  const run = getRun(id);
  if (!run) return "not-active";

  // Nothing has spawned yet, so there is no loop to notice the flag. Both of
  // these are terminal transitions and both release: a run whose dependency the
  // operator has just stopped can never start, and finding that out now is the
  // difference between a chain that ends and one that waits for ever.
  if (run.status === "queued") {
    setStatus(id, "stopped", {
      finished_at: Date.now(),
      stop_reason: `${cause} before it started.`,
    });
    releaseDependents();
    promoteQueued();
    return "cancelled";
  }

  // A waiting run holds nothing, so this is only about the row and the runs
  // behind it. Recorded as `stopped` with no work cycles, which every edge
  // condition reads as "finished having done nothing" — so the chain behind it
  // ends with its own reason rather than starting on top of work that never
  // happened.
  if (run.status === "waiting") {
    setStatus(id, "stopped", {
      finished_at: Date.now(),
      stop_reason: `${cause} while it was waiting for another run.`,
    });
    releaseDependents();
    promoteQueued();
    return "cancelled";
  }

  // A parked run has no loop and no child either, and it is the one state where
  // a kill switch matters most — without this branch, Stop does nothing to the
  // runs most likely to be left unattended.
  if (run.status === "paused") {
    setStatus(id, "stopped", {
      finished_at: Date.now(),
      stop_reason: `${cause} while it was waiting for the next 5-hour window.`,
      resume_at: null,
    });
    releaseDependents();
    promoteQueued();
    return "cancelled";
  }

  if (run.status !== "running") return "not-active";

  return interruptRun(id, {
    kind: "operator",
    reason: `${cause}.`,
    pause: false,
    at: Date.now(),
  });
}

/* ------------------------------------------------------------------ */
/* Live guards and the paused-run sweeper                              */
/* ------------------------------------------------------------------ */

/**
 * The longest a live run may go without having its context read.
 *
 * The occupancy reading rides the live-guard tick, and that tick's period is
 * `liveGuardIntervalSeconds` — a setting about *money*, whose description on the
 * settings page is about re-reading usage mid-cycle and which an operator is
 * entitled to set to ten minutes on an install where nothing stops mid-cycle.
 * Doing so used to take the context indicator with it, silently: the panel is
 * the only answer this app has to "how full is this run" and it would then be
 * up to ten minutes behind with nothing on screen saying which setting had moved
 * it. Two minutes is the operator's stated tolerance for that panel, and it is
 * far above the cost of the read it bounds — one tail parse per live run.
 *
 * This is a **floor on the tick**, not a second timer. The budget half keeps the
 * operator's own cadence through `liveTickPlan`, because a budget scan is the
 * expensive half and speeding it up is not what this is for.
 */
const CONTEXT_READ_MAX_INTERVAL_MS = 120_000;

/** The shortest tick the live guard offers, and `startLiveTicker`'s own floor. */
const MIN_LIVE_TICK_SECONDS = 15;

/**
 * How often the ticker fires, and how often the budget half of it runs.
 *
 * Pure, and separated out because both ways of being wrong here are silent. A
 * `tickMs` that ignored the ceiling leaves the context panel as far behind as
 * the operator's setting, which is the bug this exists to fix and shows up as a
 * plausible-looking number with a stale age. A `guardMs` that collapsed onto
 * `tickMs` would run `buildSnapshot` — the expensive half, uncoalesced — five
 * times as often as the operator asked on an install with the interval set
 * high, which costs and reads as nothing at all.
 */
export function liveTickPlan(guardIntervalSeconds: number): {
  tickMs: number;
  guardMs: number;
} {
  const guardMs = Math.max(MIN_LIVE_TICK_SECONDS, guardIntervalSeconds) * 1000;
  return { tickMs: Math.min(guardMs, CONTEXT_READ_MAX_INTERVAL_MS), guardMs };
}

/**
 * Whether this tick is the one that also re-reads the budget.
 *
 * Half a tick of slack, and that is the whole subtlety: `setInterval` drifts and
 * a tick landing a few milliseconds early would be refused, pushing the budget
 * scan a **whole tick** past the cadence the operator set — 12 minutes on a
 * 10-minute setting, growing every time it happens. Rounding to the nearest tick
 * keeps the long-run average on the setting.
 */
export function guardScanDue(
  lastAt: number,
  now: number,
  plan: { tickMs: number; guardMs: number },
): boolean {
  return now - lastAt + plan.tickMs / 2 >= plan.guardMs;
}

/**
 * The budget half's own cadence, held across the ticks it sits out.
 *
 * Its own `globalThis` key rather than a field on `timers`: adding one to that
 * shape would leave a dev hot reload holding the pre-upgrade object, which `??=`
 * does not re-initialise — the trap `orchestrator.ts:373` records.
 */
const guardScan = ((globalThis as unknown as {
  __ufGuardScan?: { plan: { tickMs: number; guardMs: number }; at: number };
}).__ufGuardScan ??= { plan: { tickMs: 0, guardMs: 0 }, at: 0 });

function startLiveTicker(): void {
  if (timers.live) return;
  // Read once at start. A change to the setting takes effect the next time the
  // ticker stops and starts, which is at the end of the last live cycle.
  const plan = liveTickPlan(getSettings().liveGuardIntervalSeconds);
  // Zeroed rather than carried over, so the first tick of a freshly started
  // ticker always scans: the run it was started for has never been read.
  guardScan.plan = plan;
  guardScan.at = 0;
  timers.live = setInterval(() => void liveGuardTick(), plan.tickMs);
  timers.live.unref?.();
}

function stopLiveTicker(): void {
  if (!timers.live) return;
  clearInterval(timers.live);
  timers.live = null;
}

/**
 * Re-read the budget for every run with a child in flight.
 *
 * One timer and one snapshot for all of them: `scanUsage` already coalesces
 * concurrent callers, but `buildSnapshot` does not, and it is the expensive half
 * on a large history.
 *
 * Deliberately emits nothing per tick. `emit()` writes a `run_events` row every
 * call, and a row a minute for three days across several runs is tens of
 * thousands of rows plus a proportionally larger stream replay. Only an actual
 * interrupt is worth recording.
 */
async function liveGuardTick(): Promise<void> {
  // A scan slower than the interval must not stack ticks on top of each other.
  if (timers.ticking) return;
  timers.ticking = true;
  try {
    if (liveGuards.size === 0 && contextWatches.size === 0) {
      stopLiveTicker();
      return;
    }

    // Before the budget scan, and cheap enough to run first: it reads one file
    // per run and parses backwards from its end until it finds a usage frame. A
    // run that crosses the ceiling is interrupted here and then skipped by the
    // budget loop below on the `interrupts.has(id)` test every branch already
    // makes. It is also where the occupancy series is written, off that same
    // read — see the function's own note on why that half is not gated on
    // pruning being switched on.
    await checkContextCeilings();

    // The context read above runs on every tick; the budget scan below runs on
    // the operator's own interval, which the tick may now be faster than. See
    // `CONTEXT_READ_MAX_INTERVAL_MS` for why the two came apart.
    if (!guardScanDue(guardScan.at, Date.now(), guardScan.plan)) return;
    guardScan.at = Date.now();

    const pending = [...liveGuards].filter(([id]) => !interrupts.has(id));
    if (pending.length === 0) return;

    const snapshot = await currentSnapshot();
    const now = Date.now();

    for (const [id, guard] of pending) {
      // An operator stop may have landed while the scan was running.
      if (interrupts.has(id)) continue;

      const verdict = evaluateBudget(guard.policy, snapshot, guard.progress(), now);
      if (verdict.allowed) continue;
      if (!LIVE_ENFORCEABLE_CODES.includes(verdict.code)) continue;

      interruptRun(id, {
        kind: "guard",
        reason: verdict.reason,
        code: verdict.code,
        pause: verdict.disposition === "pause",
        resumeAt: verdict.disposition === "pause" ? verdict.resumeAt : undefined,
        at: now,
      });
    }
    noteLiveTick();
  } catch (err) {
    // A failed scan must not kill the ticker; the next tick retries. Counted
    // rather than swallowed, for `sweepPaused`'s reason: a live guard that
    // silently stops reading is a run spending past a limit somebody set.
    noteLiveTickFailure(err);
  } finally {
    timers.ticking = false;
  }
}

/**
 * Record how full every live run's context is, and end any cycle past the
 * ceiling so it can be pruned.
 *
 * Two jobs off one read, and the order between them is load-bearing: the sample
 * is stored **before** the ceiling comparison, because that comparison discards
 * every reading below the ceiling and those are every reading a graph of
 * occupancy is made of. Sampling after it would record only the runs that were
 * already over.
 *
 * This is what replaced `--autocompact`, and the shape of the replacement is the
 * part worth reading. The CLI compacted *in place*: it summarised the
 * conversation and the same cycle carried on. Nothing here can do that — a
 * transcript rewritten under a live session races the CLI's own appends, and the
 * CLI is sending its in-memory context to the API regardless, so an edit to the
 * file would not shrink what this turn costs anyway. What this app can do that
 * the CLI cannot is end the cycle, which puts the transcript back in nobody's
 * hands, and that is the whole mechanism.
 *
 * ## Why there is no size gate any more
 *
 * A `statSync` used to stand in front of this, skipping any transcript smaller
 * than the ceiling's worth of bytes on the argument that message content is a
 * subset of the file, so a file that small cannot hold a conversation past the
 * ceiling. That was sound while the measure was `contextTokens`, and it stopped
 * being sound the moment this started reading `apiContextTokens`: the prompt
 * carries ~55,000 tokens of system prompt, tool list and project instructions
 * that are in no transcript at all, so a file **under** the gate can be a cycle
 * over the ceiling. It held anyway because a transcript's envelopes outweigh
 * that — measured at 1.74× the message bytes on this install — but that is a
 * property of how tool-heavy a run happens to be, not a bound, and what it
 * hides is silent: a cycle that never gets ended and never gets pruned.
 *
 * What it bought is also smaller than it was. `contextTokens` JSON-parses every
 * line; `apiContextTokens` reads the file and parses backwards from the end,
 * stopping at the first `usage` frame — a read and a split for a file of a few
 * megabytes, once a minute per live run.
 *
 * ## Why the payback test measures this conversation
 *
 * Ending a cycle manufactures a boundary, so unlike the one at the end of a
 * cycle it pays the invalidation in full and only pays back over later turns.
 * That is `ceilingPayback`, and it needs to know how much a prune would remove
 * *here*. It used to be inferred instead from this run's last receipt, which
 * meant the first crossing on every run acted unconditionally — a $1.80 cold
 * rewrite decided by the absence of a reading rather than by one.
 *
 * So a dry run per measurement, which is affordable because
 * `CEILING_REMEASURE_GROWTH_TOKENS` paces it by the conversation's growth
 * rather than by the ticker. What it reads off that dry run is a **byte**
 * figure: winnow's own token count is anchored on the `usage` frames and does
 * not move when content is stripped, so it prints a 0% saving on a cut that
 * halves the file, and `treatRemovedTokens` records what converting the bytes
 * costs instead.
 *
 * Exported for `contextCeilingRace.test.ts` and for nothing else. Its only
 * caller is `liveGuardTick`, which is reachable only through a `setInterval` a
 * spawn starts, so the alternative to the export is a billed cycle.
 */
export async function checkContextCeilings(): Promise<void> {
  if (contextWatches.size === 0) return;

  // `pruningEnabled()` used to stand in front of this whole function, and moving
  // it down one level is the point of this pass. The reading below is the only
  // answer this app has to "how full is this run's context", and it was
  // reachable only where pruning happened to be switched on — so on every other
  // install the indicator was permanently blank, install-dependent and with
  // nothing anywhere saying why. The **watch** is registered unconditionally
  // beside every spawn, because the ceiling replaced a flag that rode every
  // cycle of every run; so the reading belongs with the watch and only the
  // acting-on-it belongs with the feature. It costs nothing extra where pruning
  // is on: one scan answers both, and the sample is taken before the ceiling
  // comparison rather than after, which would record only runs already over it.
  const settings = getSettings();
  const pruning = pruningEnabled(settings);
  // One walk of the projects tree for the whole tick rather than one per watched
  // run, which is the same hoist the `transcript` binding below performs within
  // a single run. Every run was walking the identical tree for its own basename:
  // 288 ms a tick at four concurrent runs on this operator's store and 1.7 s at
  // twenty-five, spent on the event loop these guards run on. Lazy, so a tick
  // that resolves nothing still walks nothing.
  const resolveSession = sessionTranscriptResolver();

  for (const [id, watch] of contextWatches) {
    if (interrupts.has(id)) continue;
    const sessionId = watch.sessionId();
    if (!sessionId) continue;

    let tokens: number;
    // Hoisted out of the try because the payback measurement below needs it
    // too, and resolving the session twice on the same tick would be a second
    // directory walk for an answer already in hand.
    let transcript: string | null = null;
    try {
      transcript = await resolveSession(sessionId);
      if (!transcript) continue;
      // Read off `usage` rather than estimated from bytes. The two diverge by
      // tens of thousands of tokens in both directions on this install — the
      // intake filter drops tool results on the wire while the transcript keeps
      // them, and the prompt carries a system prompt and tool list the
      // transcript never held. See `apiContextTokens`. Ending a cycle against a
      // conversation the API was never asked to carry is a prune that pays
      // `1.9·S` for nothing.
      tokens = sampleContext(id, watch.iteration(), transcript).tokens;
    } catch {
      // A transcript that cannot be read is not a run to end. The budget guards
      // below are unaffected and the next tick tries again.
      continue;
    }

    // Re-read after the await above, for the reason the budget loop re-reads
    // `interrupts` after its own scan: the cycle this just measured may have
    // ended while the transcript was being resolved, and everything below acts
    // on a cycle it believes is still running. Identity rather than `has`,
    // because the entry is re-set per cycle — a run whose *next* cycle started
    // inside this window is a different conversation than the one measured, and
    // ending it would charge that conversation for this one's size.
    //
    // The sample above is deliberately left standing: it is a true reading of a
    // transcript that existed, and the occupancy series is the half of this
    // function that is not gated on the run still working.
    if (contextWatches.get(id) !== watch || interrupts.has(id)) continue;

    if (!pruning) continue;

    // What that window is *made of*, on the same tick and behind the same gate.
    //
    // Above the ceiling comparison rather than below it, and that placement is
    // the point: the composition answers "what is this run's context growing
    // on", which is a question worth an answer at 60,000 tokens and not only at
    // the 200,000 where the app starts acting. Read below the `continue` it
    // would exist only for conversations already over the line, which is the
    // half of the climb an operator can no longer do anything cheap about.
    //
    // Behind `pruning`, though — `observePlan`'s rule, and not by analogy: this
    // spawns winnow against the operator's own conversation, and switching the
    // feature off is the request that it does not. The free reading above stays
    // ungated because it spawns nothing.
    //
    // Awaited rather than left floating. A rejected floating promise takes the
    // process down under Node's default handler, and the two guards below are
    // already written for a tick that can lose its cycle mid-await.
    const compositionAt = compositionMeasuredAt.get(id);
    if (
      compositionAt === undefined ||
      Math.abs(tokens - compositionAt) >= COMPOSITION_REMEASURE_GROWTH_TOKENS
    ) {
      // Marked before the await, not after. `contextComposition` is bounded at
      // `PRUNE_TIMEOUT_MS`, which is two minutes of ticks that would each see an
      // unmarked run and spawn their own winnow against the same transcript.
      compositionMeasuredAt.set(id, tokens);
      const composition = await contextComposition(transcript);
      // Re-checked after the await for the reason every await on this path is:
      // the cycle may have ended, and a reading filed against a run whose next
      // cycle has started would draw this conversation's shape on that one. The
      // reading is dropped rather than kept — unlike the sample above, which is
      // true of a transcript that existed whatever became of the run, a
      // composition is only meaningful beside the iteration it is stamped with.
      if (composition && contextWatches.get(id) === watch && !interrupts.has(id)) {
        recordComposition(id, watch.iteration(), composition);
      }
    }

    if (tokens < CYCLE_CONTEXT_CEILING_TOKENS) continue;

    // Asked about **this** conversation, now, rather than inferred from the last
    // cut this run made. `predictedPayback` returns null until a run has cut
    // once, and null resolved to "act" — so every run's first crossing
    // manufactured a boundary unconditionally, and a manufactured boundary is a
    // cold rewrite of the whole conversation. Measured on this install: 178k–183k
    // tokens at the one-hour class, about $1.80, spent to remove 2.3%–8.8% of a
    // conversation, needing 209–771 further turns to repay against cycles that
    // ran 36–67. The gate was not wrong afterwards; it never saw the first one.
    //
    // `plan` is read-only, is allowed while the session is live, and is the same
    // subprocess `observePlan` already spawns at every boundary — whose answer
    // went into `plan_observations` and was read by nothing.
    //
    // Re-measured on growth rather than on every tick. This function runs once a
    // minute and the plan spawns winnow over the whole transcript, so a run
    // parked above the ceiling would otherwise pay a subprocess a minute for an
    // answer that barely moves — see `CEILING_REMEASURE_GROWTH_TOKENS`.
    // `earlyEndDeclined` does not bound this: it suppresses the log line, not
    // the work.
    const measuredAt = ceilingMeasuredAt.get(id);
    if (
      measuredAt !== undefined &&
      tokens - measuredAt < CEILING_REMEASURE_GROWTH_TOKENS
    ) {
      continue;
    }
    ceilingMeasuredAt.set(id, tokens);
    // Asked of the engine the operator chose, not of `plan` regardless. The two
    // classify differently enough that reading one to decide the other's action
    // refused every crossing this install saw for two days — see `ceilingCut`.
    const cut = await ceilingCut(transcript, tokens, settings);
    // And again, because that one is a winnow subprocess bounded by
    // `PRUNE_TIMEOUT_MS` — two minutes in which a cycle has every chance to
    // finish. Nothing below this line awaits, so the test and the write are one
    // step: an interrupt written past a cycle's end is either a completed cycle
    // refunded and its `DONE` discarded, a healthy run filed `stopped` by
    // `interruptOutcome`, or — past `startRun`'s outer `finally` — an entry no
    // deleter ever reaches, which stops the run's next resume dead.
    if (contextWatches.get(id) !== watch || interrupts.has(id)) continue;

    const predicted = ceilingPayback(tokens, cut);
    if (predicted === null || predicted > CEILING_PAYBACK_HORIZON_TURNS) {
      // Null declines here, which is the opposite of what `predictedPayback`'s
      // null meant. That one was "no history", and `boundaryAction`'s aggregate
      // argument says an unknown of that kind should prune. This one is "no
      // measurement", and there is no argument for spending $1.80 on a cut
      // nothing has priced.
      //
      // Said on every measurement, not once per run. This is safe to repeat
      // *because* the measurement is paced by growth rather than by the ticker:
      // the line follows the conversation, and a run that stops growing stops
      // repeating itself. Latching it instead left a run climbing from 200k to
      // 300k silent for an hour while the gate re-decided behind it, which reads
      // exactly like a feature that has stopped working. `earlyEndDeclined` now
      // records only whether the decision has been *explained* yet.
      const explained = earlyEndDeclined.has(id);
      earlyEndDeclined.add(id);
      log(
        id,
        ceilingDeclineMessage({
          contextTokens: tokens,
          removedTokens: cut ? Math.round(cut.removedTokens) : 0,
          turnsNeeded: predicted,
          engine: cut?.engine ?? null,
          repeat: explained,
        }),
      );
      // Beside the line and not instead of it, the boundary gate's rule one
      // function above: `earlyEndDeclined` records only whether the operator has
      // been *told*, and the line itself expires with `run_events`, so a run held
      // above the ceiling for forty minutes and an install where pruning was
      // never switched on were the same empty section once the run had settled.
      // This is the gate that takes 55 of 58 cuts on this install, so its
      // declines are also the boundaries missing from the denominator
      // `PruneSavings.tsx` says the money above it is measured against — a card
      // that can only ever count the boundaries that cut.
      //
      // Three outcomes and not one, because the branch swallows three different
      // answers and only the last is a refusal: `ceilingCut` returning null is
      // "nobody could measure it" — winnow absent, or a subprocess that failed,
      // which it collapses and this cannot tell apart — and a measurement that
      // frees nothing is the arithmetic having nothing to weigh rather than
      // having weighed it. An install missing the engine must not read as one
      // whose arithmetic refused; that distinction is the whole point of the
      // table.
      //
      // Written on every measurement rather than once per run, which is safe for
      // the reason the line above it is: `CEILING_REMEASURE_GROWTH_TOKENS` paces
      // both, so the count follows the conversation and a run that stops growing
      // stops writing rows.
      recordPruneDecision(
        id,
        "early-end",
        cut?.engine ?? settings.contextPruningEngine,
        cut === null ? "unavailable" : predicted === null ? "nothing" : "declined",
        cut === null
          ? "no engine measurement was available for this crossing"
          : predicted === null
            ? "the measurement removed nothing"
            : null,
        predicted,
      );
      continue;
    }

    // Both readings are about to stop describing anything. The cut shrinks the
    // conversation, so the growth this was counting from is gone; and a later
    // decline on the smaller conversation is new information an operator should
    // be told about rather than have swallowed by a latch set before the cut.
    ceilingMeasuredAt.delete(id);
    earlyEndDeclined.delete(id);

    interruptRun(id, {
      kind: "prune",
      reason:
        `This work cycle's context reached ${fmtTokens(tokens)} tokens, so it was ` +
        `ended here to be pruned. The next cycle carries on from a smaller conversation.`,
      pause: false,
      at: Date.now(),
    });
  }
}

/**
 * What a further prune on this run would cost, in turns, or null for no history.
 *
 * Read from the run's last receipt: `tokens_after` is the suffix an edit would
 * invalidate and `tokens_removed` is what came out, which is exactly the `S` and
 * `D` of `paybackTurns`. Null on the first crossing, which is the case the
 * caller treats as "act, and find out".
 */
function predictedPayback(runId: string): number | null {
  try {
    // `tokens_before`, never `tokens_after`. See `paybackTurns`: S is the suffix
    // as it stood before the cut, and the after figure is short by exactly the
    // amount removed — which flatters the small cuts this test exists to refuse.
    const receipt = db()
      .prepare(
        `SELECT ts, tokens_before AS s, tokens_removed AS d FROM prune_receipts
          WHERE run_id = ? ORDER BY ts DESC LIMIT 1`,
      )
      .get(runId) as PaybackReading | undefined;
    // The other engine's record of the same two quantities. `S` is
    // `context_tokens_after` and **not** `suffix_bytes`, which is what this read
    // for and got wrong by a factor of two and a half: the suffix is the tail
    // standing after the cut line, 70–87k on the forks this install has taken,
    // where what a resume rewrites is the conversation, ~180k. Through the
    // suffix those cuts priced at 74–275 turns against a billed 209–771, so the
    // gate meant to refuse exactly them was reading a number less than half the
    // truth. See `ceilingPayback` for the arithmetic and the measurements.
    //
    // Both fields are converted to tokens here rather than passed as stored.
    // `paybackTurns` reads `S/D` as a ratio, so a reading that mixed the
    // column's tokens with the other column's bytes would be wrong by
    // `BYTES_PER_TOKEN` and typecheck perfectly.
    //
    // Reading receipts alone left a run under the fork engine with no prediction
    // at all — see `freshestPayback`.
    const forkRow = db()
      .prepare(
        `SELECT ts, context_tokens_after AS s, net_bytes AS d FROM fork_attempts
          WHERE run_id = ? AND net_bytes > 0 AND context_tokens_after > 0
          ORDER BY ts DESC LIMIT 1`,
      )
      .get(runId) as { ts: number; s: number; d: number } | undefined;
    const fork: PaybackReading | undefined = forkRow
      ? { ts: forkRow.ts, s: forkRow.s, d: forkRow.d / BYTES_PER_TOKEN }
      : undefined;
    return freshestPayback(receipt, fork);
  } catch {
    return null;
  }
}

/**
 * Runs that have already had the ceiling decision **explained** to them.
 *
 * It used to mean "already told, do not tell again", and that was the wrong
 * shape: a run climbing from 200k to 300k said nothing for an hour while the
 * gate kept re-deciding behind it, which is indistinguishable from a feature
 * that has stopped working. Every decline is reported now; this only chooses
 * between the full explanation and the short form that carries the numbers.
 * See `ceilingDeclineMessage`.
 *
 * Cleared when a cut actually happens, so the next decline — taken against a
 * conversation that has since been cut — explains itself again rather than
 * arriving as a follow-up to a line about the old one.
 *
 * A `Set` on `globalThis` for `__ufInterrupts`' reason, and cleared with the
 * run's other per-run state when its loop ends.
 */
const earlyEndDeclined = ((globalThis as unknown as {
  __ufEarlyEndDeclined?: Set<string>;
}).__ufEarlyEndDeclined ??= new Set<string>());

/**
 * The context a run was last measured at, so the ceiling does not re-measure it
 * every minute.
 *
 * The threshold and the argument for it live with the other tuning constants,
 * in `CEILING_REMEASURE_GROWTH_TOKENS`. What belongs here is the reason this is
 * a map rather than a flag: `earlyEndDeclined` does not bound the measurement,
 * because that latch suppresses the *log line* and not the work.
 *
 * Keyed by run, cleared when a cut happens and when the run's loop ends.
 */
const ceilingMeasuredAt = ((globalThis as unknown as {
  __ufCeilingMeasuredAt?: Map<string, number>;
}).__ufCeilingMeasuredAt ??= new Map<string, number>());

/**
 * The context a run's composition was last read at, on `ceilingMeasuredAt`'s
 * pattern and with its own threshold.
 *
 * A separate map rather than a second use of that one, because the two pace
 * different work at different prices: the ceiling re-measures to decide whether
 * to end a cycle, this re-measures to draw a band on a graph, and sharing a
 * mark would tie a picture's cadence to a policy constant that moves for
 * reasons of its own. See `COMPOSITION_REMEASURE_GROWTH_TOKENS`.
 *
 * A **new** key rather than a widened `__ufCeilingMeasuredAt`, on the rule a
 * dev hot reload enforces: `??=` only initialises when the key is absent, so a
 * pre-upgrade value at a key whose shape changed survives the reload and every
 * call on it throws.
 *
 * Compared in **both** directions, which is the one place this departs from
 * `ceilingMeasuredAt`'s arithmetic. That mark is one-sided because the ceiling
 * only cares about growth toward it; a prune that drops a conversation by 80k
 * leaves `tokens - measuredAt` negative for as long as it takes to grow back,
 * and read one-sided here that is the whole post-cut shape missed — the one
 * moment the composition is worth having. So the distance is absolute, and a
 * cut large enough to matter takes its own reading on the next tick.
 *
 * Keyed by run, cleared when the run's loop ends.
 */
const compositionMeasuredAt = ((globalThis as unknown as {
  __ufCompositionMeasuredAt?: Map<string, number>;
}).__ufCompositionMeasuredAt ??= new Map<string, number>());

/**
 * Consecutive boundaries this run's payback test has declined.
 *
 * Counted rather than latched, and that is the whole reason it exists.
 * `predictedPayback` reads the run's **last receipt**, so a decline writes no
 * new one and the next boundary re-reads the same figure: without a counter the
 * first refusal is permanent for the rest of the run, on one measurement, and an
 * operator sees pruning quietly stop.
 *
 * A latch would even be defensible on the arithmetic — `S` grows every cycle
 * while `D` does not, so a cut that failed to pay is likely to keep failing. But
 * `D` is whatever the newest cycle happened to produce, and one cycle that greps
 * a large tree or runs a long build can make it large again. That case is
 * invisible to a stale prediction, and this gate's standing instruction is that
 * every unknown resolves to *prune*.
 *
 * Cleared with the run's other per-run state when its loop ends.
 */
const boundaryDeclines = ((globalThis as unknown as {
  __ufBoundaryDeclines?: Map<string, number>;
}).__ufBoundaryDeclines ??= new Map<string, number>());

/**
 * For a run whose last boundary forked: the session to go back to, and the row
 * to write the verdict into.
 *
 * The fork engine writes a new transcript and the run switches onto it, but
 * nothing has proved that transcript resumes — winnow's 100-fork guardrail is
 * unrun, and one unresumable fork is its stated kill condition. So the switch is
 * provisional: if the next cycle cannot resume the fork, the run goes back to
 * the conversation it had and carries on.
 *
 * That is what makes turning the engine on survivable, and it is also the
 * measurement. `fork_attempts.resumed` is milestone 2's first criterion being
 * collected one production cycle at a time, from resumes the run actually
 * needed rather than from a harness.
 */
const pendingFork = ((globalThis as unknown as {
  __ufPendingFork?: Map<string, PendingFork>;
}).__ufPendingFork ??= new Map<string, PendingFork>());

/** A fork adopted at the last boundary, and the way back if it will not resume. */
interface PendingFork {
  /** The session to return to. */
  fallbackSessionId: string | null;
  /**
   * The fork's own session id.
   *
   * Checked before a success is recorded. Without it, any cycle that ended
   * cleanly counted as "the fork resumed" — including one that never touched
   * the fork, because `startsFresh` had dropped the conversation and opened a
   * new session in between. That would write a pass into the column milestone 2
   * reads as its acceptance criterion, on a resume that did not happen.
   */
  forkSessionId: string;
  rowId: number | null;
}


function startSweeper(): void {
  if (timers.sweep) return;
  timers.sweep = setInterval(() => void sweepPaused(), SWEEP_MS);
  timers.sweep.unref?.();
}

function stopSweeper(): void {
  if (!timers.sweep) return;
  clearInterval(timers.sweep);
  timers.sweep = null;
}

/* ------------------------------------------------------------------ */
/* Deciding a parked run's fate — pure, and tested                     */
/* ------------------------------------------------------------------ */

/**
 * Which parked runs this tick decides about.
 *
 * A null `resume_at` is due immediately, and that is not a corner case: the
 * column is a hint about when to look again rather than a promise, so its
 * absence means "on the next sweep" and never "not yet".
 *
 * Separated from the sweep below because it is what buys the scan: nothing due
 * means no `currentSnapshot()`, and a filter that read a null as "not yet"
 * would leave those runs parked for ever with the sweeper reporting nothing at
 * all — the same silence a working sweeper produces between windows.
 */
export function duePausedRuns<T extends { resume_at: number | null }>(
  runs: readonly T[],
  now: number,
): T[] {
  return runs.filter((r) => r.resume_at === null || now >= r.resume_at);
}

/**
 * How many parked runs one sweep may hand back to the queue.
 *
 * The other half of the herd, and the half jitter cannot reach: `resume_at`
 * decides which tick a run is due in, and a whole fleet parked before the
 * spread existed — or bunched by the `MIN_REFUSAL_WAIT_MS` floor, or simply
 * carrying a null — is due in one. Every one of them was flipped to `queued` in
 * a single pass and handed to one `promoteQueued()`, which starts everything
 * startable in one synchronous turn, so the sweep's own shape re-synchronised
 * what the backoff had spread.
 *
 * A cap here rather than anywhere else because `promoteQueued` must stay the
 * one owner of FIFO order, the folder claim and the concurrency cap. That last
 * one is `settings.maxConcurrentRuns`, **4** in `DEFAULTS` and nullable only as
 * an explicit opt-out — so a stock install is bounded twice over, here and
 * downstream, and this cap is the only bound left on an install that has taken
 * that opt-out deliberately. A run over the cap simply stays `paused`
 * with a `resume_at` already in the past, which is the state the next tick is
 * built to pick up: nothing is written, so nothing is rewritten every 60
 * seconds, which is `FOLDER_TAKEN_REASON`'s rule one branch over.
 *
 * Four, against a 60-second tick: twenty-five parked runs drain in about six
 * minutes, and the first wave finds out what the wall is actually doing before
 * the last one has spent a cycle finding out the same thing.
 */
export const MAX_RESUMES_PER_SWEEP = 4;

/** What the sweeper should do with one parked run. */
export type PausedRunPlan =
  /** Its guard cleared and nothing is in the folder: rejoin the queue. */
  | { action: "resume" }
  /** Its guard cleared, but a run started while it waited holds the folder. */
  | { action: "hold"; reason: string; heldBy: string }
  /** Still refused, by the one refusal that clears on its own. */
  | { action: "park"; resumeAt: number }
  /** Refused by something that can never clear: end it. */
  | { action: "end"; reason: string };

/**
 * Why a parked run whose window has cleared is still parked.
 *
 * A constant, and that is load-bearing rather than terse: the sweeper's UPDATE
 * is guarded on `stop_reason IS NOT ?`, so a sentence that varied with the run
 * in the folder, or with the clock, would rewrite the row and write a log line
 * every 60 seconds for every parked run. The holder's id travels in the log
 * payload instead, where it is recorded once. `run_events` has no retention.
 */
const FOLDER_TAKEN_REASON =
  "Its 5-hour window has cleared. Waiting for the folder, which a " +
  "run started while it waited now holds.";

/**
 * What to do with one parked run, given the verdict its own guard just
 * returned and whichever run is in its folder.
 *
 * Pure, and separated from the writes below for the same reason
 * `selectPromotable` and `releasableRuns` are: every way of being wrong here is
 * silent, lands on disk and throws nothing. Reading a `stop` as a `pause` parks
 * a run for ever that was out of wall clock; reading a `pause` as a `stop`
 * kills a fleet that only had to wait; and resuming into an occupied folder is
 * the two-agents-in-one-working-tree collision the folder claim exists to
 * prevent, arriving through the one door that is allowed to un-park a run.
 *
 * Occupancy is consulted only where the guard already said yes — a refusal is a
 * fact about this run's own budget, so nothing about who holds the folder may
 * change the answer to it.
 */
/**
 * Whether a verdict leaves a parked run free to go back in the queue.
 *
 * A refusal the run may not be *ended* on is not one the sweeper may act on
 * either — `RUN_ENFORCEABLE_CODES` is the one list, and the sweeper is the
 * second place that would otherwise turn a provider outage into a dead fleet:
 * it ends every parked run whose fraction guard has nothing to read, which is
 * the same wrong answer the pre-cycle guard used to give, arriving 60 seconds
 * later. Read as clear, so the run rejoins the queue and `startRun`'s own
 * pre-cycle check is what says the guard is unreadable — once, in that run's
 * log, rather than every sweep for as long as the outage lasts.
 *
 * Its two readers must agree: the decision below, and the occupancy read that
 * feeds it. A cleared verdict whose folder was never checked is the
 * two-agents-in-one-working-tree collision, arriving through the one door that
 * is allowed to un-park a run.
 */
export function pauseVerdictClears(verdict: BudgetVerdict): boolean {
  return verdict.allowed || !enforceableForRun(verdict);
}

export function planPausedRun(
  verdict: BudgetVerdict,
  heldBy: string | null,
): PausedRunPlan {
  if (pauseVerdictClears(verdict)) {
    // Stay `paused` rather than joining the queue: `paused` is what the restart
    // grace keys on, and `resume_at` is already in the past, so the next sweep
    // re-checks and flips the moment the folder is free.
    if (heldBy !== null) {
      return { action: "hold", reason: FOLDER_TAKEN_REASON, heldBy };
    }
    return { action: "resume" };
  }
  // Narrowed by the branch above: an allowed verdict has already returned.
  if (verdict.allowed) return { action: "resume" };

  if (verdict.disposition === "pause") return { action: "park", resumeAt: verdict.resumeAt };

  // A guard that never clears — the clock, this run's own spend, the weekly
  // window — has caught up with a parked run. End it rather than leave it
  // holding a folder indefinitely for a resume that can never happen.
  return { action: "end", reason: verdict.reason };
}

/**
 * Reconsider every parked run.
 *
 * `resume_at` decides *when to look*; `evaluateBudget` decides *whether to
 * run*. Trusting the stored timestamp would be wrong in both directions: the
 * weekly window in its default rolling mode has no reset instant at all, only a
 * total that decays, and even an anchored one moves with usage from surfaces
 * this app cannot see, with a change to the reserved headroom, and with the
 * operator's own terminal work opening a fresh 5-hour block. The guard that
 * parked a run is the guard that clears it.
 *
 * Exported for the same reason the decision above is extracted: without a way
 * in, the branch that re-queues through `promoteQueued` rather than through
 * `startRun` cannot be pinned at all.
 */
export async function sweepPaused(): Promise<void> {
  // Un-parking a run is starting one. A process that does not own the directory
  // stops its own timer rather than skipping a tick: the parked rows belong to
  // the owner, which runs a sweeper of its own, and nothing here will ever be
  // this process's to decide.
  if (!mayWriteDataDir()) {
    stopSweeper();
    return;
  }

  if (timers.sweeping) return;
  timers.sweeping = true;
  try {
    const paused = db()
      .prepare("SELECT * FROM runs WHERE status = 'paused' ORDER BY created_at")
      .all() as RunRow[];
    if (paused.length === 0) {
      stopSweeper();
      return;
    }

    const due = duePausedRuns(paused, Date.now());
    if (due.length === 0) return; // nothing to decide, so no scan

    const snapshot = await currentSnapshot();
    const now = Date.now();
    let freed = false;
    let resumeSlots = MAX_RESUMES_PER_SWEEP;

    for (const run of due) {
      const policy = normalizePolicy(JSON.parse(run.budget));
      const verdict = evaluateBudget(
        policy,
        snapshot,
        {
          iterations: run.iterations,
          spentUSD: run.spent_usd,
          spentTokens: run.spent_tokens,
          spentGuardUSD: run.spent_usd + run.spent_usd_est,
          spentGuardTokens: run.spent_tokens + run.spent_tokens_est,
          startedAt: run.started_at,
        },
        now,
      );

      // Only where the verdict clears the pause, for the reason
      // `planPausedRun` gives: occupancy cannot change a refusal that is going
      // to end the run, so asking would be a query per refused run per minute
      // for an answer nothing reads. `pauseVerdictClears` rather than
      // `verdict.allowed`, so the two stay one rule — a verdict this run may
      // not be ended on resumes it, and resuming without asking who is in the
      // folder is the collision the folder claim exists to prevent. `running`
      // alone, because a parked run yields its folder and a queued one is not
      // in it.
      const heldBy = pauseVerdictClears(verdict)
        ? occupantOf(workDirOf(run), run.id, ["running"])
        : null;
      const plan = planPausedRun(verdict, heldBy?.id ?? null);

      switch (plan.action) {
        case "hold": {
          // Idempotent so the reason is corrected once rather than rewritten,
          // and logged once rather than every 60 seconds.
          const noted = db()
            .prepare(
              "UPDATE runs SET stop_reason=? WHERE id=? AND status='paused' AND stop_reason IS NOT ?",
            )
            .run(plan.reason, run.id, plan.reason);
          if (noted.changes === 1) {
            log(run.id, plan.reason, { waitingFor: plan.heldBy });
          }
          break;
        }

        case "resume": {
          // Only so many per tick, for `MAX_RESUMES_PER_SWEEP`'s reason. The
          // rest keep their `paused` row and a `resume_at` already in the past,
          // so the next tick reconsiders them from a fresh snapshot — which is
          // what this loop is for, and cheaper than the alternative of a whole
          // fleet spawning in one event-loop turn.
          if (resumeSlots <= 0) break;
          // Re-queue rather than start directly: `promoteQueued` owns FIFO
          // order, folder reservation and the concurrency cap, and
          // re-implementing any of that here is how a folder claim gets broken.
          // Ordering by `created_at` means a resumed run keeps its place in
          // line. `AND status='paused'` is what lets a concurrent stop win.
          const flip = db()
            .prepare(
              "UPDATE runs SET status='queued', resume_at=NULL WHERE id=? AND status='paused'",
            )
            .run(run.id);
          if (flip.changes === 1) {
            resumeSlots -= 1;
            freed = true;
            emit({
              runId: run.id,
              ts: now,
              kind: "status",
              payload: {
                status: "queued",
                message: "The 5-hour window cleared; rejoining the queue.",
              },
            });
          }
          break;
        }

        case "park": {
          // Re-derived from the current snapshot, not carried over: the window
          // that will clear this run is not necessarily the one that closed it.
          db()
            .prepare(
              "UPDATE runs SET resume_at = ? WHERE id = ? AND status='paused'",
            )
            .run(plan.resumeAt, run.id);
          break;
        }

        case "end": {
          setStatus(run.id, "stopped", {
            finished_at: now,
            stop_reason: plan.reason,
            resume_at: null,
          });
          // A parked run that ends here is a settled dependency like any other.
          releaseDependents();
          freed = true;
          break;
        }
      }
    }

    if (freed) promoteQueued();
    noteSweep();
  } catch (err) {
    // A failed sweep must not kill the timer; the next one retries. It must not
    // be silent either: every tick failing looks exactly like a working sweeper
    // between windows, and the parked runs simply never resume. The counter is
    // what `/api/status` reports and the age below is what says the timer is
    // still alive at all.
    noteSweepFailure(err);
  } finally {
    timers.sweeping = false;
  }
}

export type ResumeOutcome = "requeued" | "not-paused" | "not-owner";

/**
 * Put a parked run back in the queue now, rather than at its next wake.
 *
 * Deliberately does not bypass the guard: the ordinary pre-cycle check runs as
 * usual, so asking early while the 5-hour window is still full simply parks it
 * again. A button that spends past a limit the operator set would be worse than
 * no button.
 */
export function resumeRun(id: string): ResumeOutcome {
  // Its own outcome rather than `not-paused`, which would be a false statement
  // about the row. Refused before the UPDATE, not left to `promoteQueued`: a
  // parked run flipped to `queued` by a process that cannot promote it is a run
  // reading "waiting its turn" with nothing that will ever take it.
  if (!mayWriteDataDir()) return "not-owner";

  const flip = db()
    .prepare(
      "UPDATE runs SET status='queued', resume_at=NULL WHERE id=? AND status='paused'",
    )
    .run(id);
  if (flip.changes !== 1) return "not-paused";

  emit({
    runId: id,
    ts: Date.now(),
    kind: "status",
    payload: { status: "queued", message: "Asked to try again now." },
  });
  promoteQueued();
  return "requeued";
}

export type ReopenOutcome = { ok: true } | { ok: false; reason: string };

/** Statuses a run can be picked up from. Terminal, and holding nothing. */
const REOPENABLE: readonly RunStatus[] = [
  "failed",
  "stopped",
  "completed",
  // Without it the gate below answers "this run is needs-review, so there is
  // nothing here to pick up", which is the opposite of what the state is for:
  // an operator who has read the reason and cleared the wall is exactly who this
  // ending was written to reach.
  "needs-review",
];

/**
 * What a reopened run says on its first cycle, or `""` for the continuation.
 *
 * Pure, and separated from `reopenRun` because every branch is billed and the
 * wrong one is silent. `donePushbackPrompt` opens by telling the agent it
 * reported the task complete and then forbids it from starting new work — which
 * is the right thing to say to a run that really did reply DONE, and a false
 * statement to a run that was cut off mid-implementation when it used up its
 * cycle cap. Both end as `completed`, so the status cannot decide this on its
 * own: `reported_done` records what the agent actually said, and a run that ran
 * out of cycles is picked up exactly like the `failed` and `stopped` runs it
 * resembles.
 *
 * Rows written before that column read as not-done, which is the cheaper error:
 * a continuation into a session that did say DONE buys one billed cycle that
 * says it again, where the pushback costs the work the operator reopened the
 * run to finish.
 */
export function reopenPrompt(o: {
  status: RunStatus;
  /** The agent's last cycle replied DONE. False for a cycle-capped run. */
  reportedDone: boolean;
  sessionId: string | null;
  /** The operator's own message, already trimmed. Wins over all three. */
  note: string;
  donePushback: string;
  /**
   * This run's last cycle was cut off by a restart rather than by the agent.
   *
   * `reconcileOnBoot` and `shutdownRuns` are the only writers of `failed` with
   * `restart_closed` set, so the pair names exactly the mid-cycle kill: the
   * queued and paused-too-long branches both write `stopped`, and
   * `markRestartClosed` only touches rows that were `running`.
   */
  restartKilled: boolean;
}): string {
  if (o.note) return o.note;
  // Above the pushback, and the order is the point: `reported_done` is whatever
  // the *previous* cycle left on the row, and a cycle killed mid-tool-call
  // never got to change it. A run whose last completed cycle said DONE and was
  // then reopened, worked and killed would otherwise be told it had reported
  // the task complete — by a branch reading a column two cycles stale.
  //
  // Without a session there is nothing to continue and `nextPrompt` reopens with
  // the task plus `priorWorkNotice`, which already says work happened here; a
  // note about a severed conversation would be describing one that is gone.
  if (o.restartKilled && o.sessionId) return RESTART_KILLED_NOTICE;
  // Below `restartKilled` and above the pushback, and only one half of that is
  // load-bearing. `restartKilled` is `status === "failed" && restart_closed`, so
  // the two above can never both be true — the order between them is written
  // this way for the next reader rather than for this code: if `reconcileOnBoot`
  // ever widens what it writes on a mid-cycle kill, a kill must still outrank a
  // stale ending. The order below it *is* load-bearing for the reason stated
  // there, which is that the pushback reads a column and this reads a status.
  //
  // Doing nothing here would already satisfy the cheap reading of this branch —
  // the pushback tests `completed`, which this row is not, so a `needs-review`
  // run picked up with no note would get the plain continuation. That is the
  // failure, not the fix: "Continue working on the task. If it is fully complete
  // and verified, reply with exactly DONE" is the same sentence
  // `RESTART_KILLED_NOTICE` was added to stop being sent, into a conversation
  // whose last turn was the agent saying it could not get past something. And
  // the ordinary reason to reopen such a run with no note is that the wall has
  // been cleared, which is one cheap step to check and one whole billed cycle
  // not to.
  if (o.status === "needs-review" && o.sessionId) {
    return NEEDS_REVIEW_PICKUP_NOTICE;
  }
  // Without a session there is nothing to push back against — `nextPrompt`
  // starts the original task over — so the substitution is dropped entirely.
  if (o.status === "completed" && o.reportedDone && o.sessionId) {
    return o.donePushback;
  }
  return "";
}

/**
 * What a run that reported it was stuck is told when somebody picks it back up.
 *
 * It deliberately does not quote the recorded reason back. This branch requires
 * a session, so the agent's own words are already the last thing in that
 * conversation, and re-sending them is spend for no information —
 * `DEFAULT_CONTINUATION_PROMPT`'s own stated rule.
 */
const NEEDS_REVIEW_PICKUP_NOTICE =
  "You ended your last work cycle by reporting that you could not get past " +
  "something, and somebody has now picked this run back up. Usually that means " +
  "they have cleared it. Before you do anything else, check whether what " +
  "stopped you is still there — the credential, the permission, the access, the " +
  "decision you were waiting on — and say what you find. If it has been " +
  "cleared, carry on with the task from where you stopped. If it has not, do " +
  "not spend a cycle working around it: say what is still missing and reply " +
  "with exactly NEEDS_REVIEW on its own line again.";

/**
 * What a resumed run is told when a restart, not the agent, ended its last cycle.
 *
 * The empty branch above used to catch this, so `nextPrompt` sent
 * `continuationPrompt` — "Continue working on the task. If it is fully complete
 * and verified, reply with exactly DONE" — into a conversation whose last event
 * was a child dying mid-tool-call. Twenty-four runs on this install took that
 * path, and the tree those kills leave is not hypothetical: one was cut down
 * immediately after `git checkout -- src/lib/chat.ts` with the only copy of its
 * fix in `/tmp`, another mid-mutation-test with a deliberately wrong variant of
 * a source file on disk, a third with a tracked file moved out to `/tmp` and
 * `tsconfig.json` rewritten by a dev server. Every one of them reconstructed the
 * tree in its next cycle *despite* being asked whether it was finished.
 *
 * It says what happened and what to check, and deliberately does not restate the
 * task — the conversation carrying it is intact, which is the whole reason this
 * branch requires a session.
 */
const RESTART_KILLED_NOTICE =
  "Your last work cycle did not finish. The server restarted while it was " +
  "running and cut it off part-way through a step, so whatever it was doing was " +
  "neither completed nor reported and its own account of it is lost. Before you " +
  "carry on, establish what it actually left behind rather than assuming: what " +
  "is uncommitted or staged, whether a file was moved aside or a config " +
  "rewritten, whether a stash was pushed, and whether the last edit landed " +
  "whole. Then continue the task from there.";

/**
 * Put a finished run back to work, continuing its Claude Code session, and
 * optionally say something to it.
 *
 * Distinct from `resumeRun`, which un-parks a run that was always going to
 * carry on by itself. This one reopens a row that had reached a terminal state:
 * a crash, a non-zero exit, a restart, an operator stop, a guard, or the agent
 * reporting the task done. Nothing about the run is rebuilt — it keeps its
 * folder, its checkout, its branch, its session id and its spend, so `startRun`
 * resumes the same conversation rather than starting a new one.
 *
 * It takes a budget because the usual reason a run needs picking up is that its
 * own limits ended it, and re-queueing it under the limits that stopped it just
 * reproduces the stop. The three carried-forward guards are checked here rather
 * than left to the pre-cycle check, which would refuse a few seconds later with
 * the run already flickering queued → stopped and no indication of what to
 * change. The terminus pair is checked here too, and for a different reason: it
 * is a fact about the budget rather than about this run, and this is the one
 * door every caller goes through — `reopenFleet` reaches this function without
 * passing the route where that refusal used to live alone.
 *
 * `completed` is included because the agent's judgement that a task is finished
 * is not the operator's. What it costs is one branch, and `reopenPrompt` owns
 * it: a run whose agent replied DONE carries `donePushbackPrompt` when the
 * operator wrote no note, because the continuation prompt asks for DONE if the
 * work is complete and would buy an immediate second one. A run that ended by
 * using up its cycle cap is `completed` too and said nothing of the kind, so it
 * is continued like the `failed` and `stopped` runs it resembles.
 *
 * `started_at` is cleared, and that is the one deliberate difference from a
 * pause. A parked run keeps its original start so wall clock stays a terminus
 * it cannot wait out; a finished run picked up by hand is a fresh attempt the
 * operator decided on, and charging it for the hours or days it spent dead
 * would refuse every run older than its own time limit.
 */
export function reopenRun(
  id: string,
  budget: unknown,
  followUp?: string,
): ReopenOutcome {
  // Picking a run up is starting one, so it goes through the same door
  // `createRun` does — reported here rather than thrown, because this function
  // already answers refusals as a sentence the run page renders.
  const notOwner = dataDirRefusal();
  if (notOwner) return { ok: false, reason: notOwner };

  const run = getRun(id);
  if (!run) return { ok: false, reason: "No such run." };

  // `blocked` splits two ways and both are pickable — they just rejoin at
  // different points. The two are told apart by `work_dir`, never by the reason
  // text, which is prose.
  //
  // A run blocked behind a dependency is picked up by going back to `waiting`,
  // not by joining the queue: it never ran, so there is no session to continue
  // and — more to the point — no workspace, and `admitWaiting` is what plans
  // one.
  const waitingAgain = run.status === "blocked" && run.work_dir === null;
  // A run its own guard refused before its first work cycle is the other kind,
  // and it is the case this function's budget argument exists for: raising the
  // limit is the fix, and refusing it left the operator retyping the prompt and
  // the budget into the new-run form. `ensureWorktree` runs before the guard, so
  // it already holds a workspace — and a checkout, whose branch was orphaned for
  // as long as there was no way back to this row. It therefore rejoins the queue
  // like any other terminal row rather than going back to `waiting`, where
  // `admitWaiting` would plan a second checkout slot on top of the first.
  const guardRefused = run.status === "blocked" && run.work_dir !== null;
  if (!waitingAgain && !guardRefused && !REOPENABLE.includes(run.status)) {
    return {
      ok: false,
      reason: `This run is ${run.status}, so there is nothing here to pick up.`,
    };
  }

  // A member of a halted workflow is not picked up one run at a time. A halt is
  // terminal for the whole instance by design — `stopInstance` has no resume —
  // and the guard that bounds a workflow's spending acts only on an instance
  // that is `started`, so a run restarted from here would work, and spend, under
  // a workflow the instance page reports as stopped with nothing able to stop it
  // again. Refused after the status gate rather than before it, so a member that
  // was never pickable in the first place still gets the answer about itself.
  const haltedWith = haltedWorkflowOf(id);
  if (haltedWith) {
    return {
      ok: false,
      reason: `This run was stopped with all of workflow “${haltedWith}”, and stopping a workflow run is final. Start that workflow again rather than picking one of its runs back up.`,
    };
  }

  // Its checkout may have been handed to a newer run while it was dead:
  // `allocateSlotPath` only avoids slots that an *active* run holds, and a
  // terminal row is not active. `ensureWorktree` would refuse the branch rather
  // than corrupt anything, but only after this run had been queued and had
  // taken its turn — saying so now is the difference between an explanation and
  // a second failure.
  if (run.worktree_path) {
    const holder = activeRuns().find(
      (r) => r.worktree_path === run.worktree_path,
    );
    if (holder) {
      return {
        ok: false,
        reason: `Its isolated checkout is in use by run ${holder.id.slice(0, 8)}. Its own work is still on branch ${run.worktree_branch}; wait for that run to finish.`,
      };
    }
  }

  const policy = normalizePolicy(budget);
  const spentUSD = run.spent_usd + run.spent_usd_est;
  const spentTokens = run.spent_tokens + run.spent_tokens_est;

  // The terminus pair, refused at this door rather than only at the route's.
  // `POST /api/runs/[id]/reopen` already answers it with the longer explanation
  // a form can show, and keeps doing so — but that route is one of the two ways
  // in, and the other is `reopenFleet`, which calls this function directly with
  // a budget composed by a sheet that has no time-limit field at all. Without
  // this, one press could queue twenty-five runs with no monotone terminus
  // between them. `evaluateBudget` does refuse the pair again as `no_terminus`,
  // but only once the row has flickered queued → blocked with nothing said
  // about what to change, which is the same few-seconds-later refusal the three
  // carried-forward checks below exist to pre-empt.
  if (policy.maxIterations === null && policy.maxDurationMinutes === null) {
    return {
      ok: false,
      reason:
        "This run would have no work-cycle limit and no time limit, so nothing " +
        "would ever end it. Give it one of the two.",
    };
  }
  if (policy.maxIterations !== null && run.iterations >= policy.maxIterations) {
    return {
      ok: false,
      reason: `This run has already used ${run.iterations} work ${
        run.iterations === 1 ? "cycle" : "cycles"
      }. Raise the cycle limit above that to carry on.`,
    };
  }
  if (policy.maxRunCostUSD !== null && spentUSD >= policy.maxRunCostUSD) {
    return {
      ok: false,
      reason: `This run has already spent $${spentUSD.toFixed(2)}. Raise the spending limit above that to carry on.`,
    };
  }
  if (policy.maxRunTokens !== null && spentTokens >= policy.maxRunTokens) {
    return {
      ok: false,
      reason: `This run has already used ${spentTokens.toLocaleString()} tokens. Raise the token limit above that to carry on.`,
    };
  }

  // The agent is carried the same way and more simply: the `agent` column is
  // not touched here at all, and there is no argument on this function and no
  // field on the reopen route that could reach it. Same reasoning as
  // `permissionMode` below — the operator answered that question when they
  // started the run, and picking it up again is not a second chance to answer
  // it. The definition is the run's own copy, so this is also the one path where
  // a run whose agent has since been deleted is still picked up *as* the agent
  // it ran as, rather than being refused or quietly losing it.

  // Carried from the stored blob rather than accepted from the caller: this
  // value reaches `--permission-mode` on a process that edits files, and
  // reopening a run is not a reason to open a second path to it.
  const stored = JSON.parse(run.budget) as Record<string, unknown>;
  const blob = JSON.stringify({ ...policy, permissionMode: stored.permissionMode });

  // Resolved to the literal text the next cycle will send, rather than to a
  // flag the loop re-interprets later: the choice depends on the status this
  // run is being picked up *from*, which the queued row no longer records.
  const note = String(followUp ?? "").trim();
  const firstPrompt = reopenPrompt({
    status: run.status,
    reportedDone: run.reported_done !== 0,
    sessionId: run.session_id,
    note,
    donePushback: getSettings().donePushbackPrompt,
    // Read here rather than after the UPDATE below, which clears the column in
    // the same statement that queues the run.
    restartKilled: run.status === "failed" && run.restart_closed !== 0,
  });

  const flip = db()
    .prepare(
      // `restart_closed=0`: this run is no longer sitting recoverable, so it
      // leaves the count the restart notice offers to pick up. Cleared here
      // rather than when it next ends, because what that count answers is "how
      // many runs is the restart still holding up", not "how many did it touch".
      //
      // `set_aside_at=NULL` for the mirror of that reason. Setting a run aside
      // says "not with the others", and this is the operator picking up this one
      // run, by name, on its own page — the decision being taken back rather
      // than worked around. Leaving it set would mean a run that had been picked
      // up and had run again was still excluded from the next bulk pick-up, on
      // the strength of something somebody decided about a previous ending.
      //
      // `needs_review_reason=NULL` beside `stop_reason`, and for its reason: the
      // column describes the ending the row records, and a reopened run may end
      // without re-entering the loop at all — stopped while queued, closed out
      // by a boot — after which a reason left behind would be describing an
      // ending two segments old.
      `UPDATE runs SET status=?, budget=?, max_iterations=?, follow_up=?, reopened_at=?,
         started_at=NULL, finished_at=NULL, exit_code=NULL, stop_reason=NULL,
         needs_review_reason=NULL,
         resume_at=NULL, restart_closed=0, set_aside_at=NULL WHERE id=? AND status=?`,
    )
    .run(
      waitingAgain ? "waiting" : "queued",
      blob,
      policy.maxIterations ?? 0,
      firstPrompt || null,
      // `origin` is deliberately untouched: it says which route *created* this
      // run, and rewriting it here would lose that while `created_at` went on
      // pointing at the original creation. A pick-up is its own act and gets its
      // own column, with the request that asked for it on the request log.
      Date.now(),
      id,
      run.status,
    );
  if (flip.changes !== 1) {
    return { ok: false, reason: "This run changed state before it could be picked up." };
  }

  emit({
    runId: id,
    ts: Date.now(),
    kind: "status",
    payload: waitingAgain
      ? {
          status: "waiting",
          message:
            "Picked up again. It never started, so it goes back to waiting on the runs ahead of it — it starts by itself if they have since succeeded, and says so again if they have not.",
        }
      : {
          status: "queued",
          message: !run.session_id
            ? note
              ? "Picked up again. It never reported a session to resume, so it starts from the original task with your note added to it."
              : "Picked up again. It never reported a session to resume, so it starts from the original task."
            : note
              ? "Picked up again — your note goes to the session it left off in."
              : "Picked up again — it continues the session it left off in.",
        },
  });

  // Whatever this run's own ending blocked is asked again too, transitively:
  // the reason those rows carry is a sentence about an ending that is now being
  // undone, and nothing else would ever revisit it.
  reviveBlockedDependents([id]);

  if (waitingAgain) {
    // Decides this row and everything just woken behind it, in one pass and on
    // what is true now — admitting what can start and re-blocking what cannot.
    releaseDependents();
  }

  // Outside any claim of its own: a queued row holds nothing, and
  // `promoteQueued` is what decides whether its folder is free.
  promoteQueued();
  return { ok: true };
}

/**
 * Signal every live agent, for a server that is shutting down.
 *
 * Only needed because agents are spawned `detached`: that takes them out of the
 * terminal's foreground process group, so Ctrl-C during `npm run dev` no longer
 * reaches them and would otherwise leave a real, billed agent running. Under
 * Docker the container cgroup handles it and this is redundant.
 *
 * The last step of `shutdownRuns` rather than the whole of it: the ladder in
 * `interruptRun` gets there first with `SIGINT`, and this is the sweep for
 * anything that outlived it.
 */
export function killAllAgents(sig: NodeJS.Signals = "SIGTERM"): number {
  let n = 0;
  for (const child of procs.values()) {
    signalTree(child, sig);
    n += 1;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Shutdown                                                            */
/* ------------------------------------------------------------------ */

/**
 * How long the shutdown waits for its children to die and its loops to settle.
 *
 * Chosen against `interruptRun`'s own ladder, which is what does the signalling
 * here: `SIGINT` at once, `SIGTERM` at 3s, `SIGKILL` at 8s. Ten seconds is the
 * first moment after that last step at which a child can be said not to be
 * coming back. It is a ceiling and not a wait — the loop below returns as soon
 * as nothing is left in flight, which is the ordinary case, since a CLI that
 * handles `SIGINT` exits in about a second.
 *
 * `docker-compose.yml` sets `stop_grace_period` above this. Docker's default is
 * 10s and would `SIGKILL` the server at the exact moment the last agent died,
 * which is the accounting this whole path exists to recover.
 */
export const SHUTDOWN_GRACE_MS = 10_000;

/** How often the wait below re-asks. Cheap: one map size and one COUNT. */
const SHUTDOWN_POLL_MS = 100;

/**
 * True while the process is going down, so nothing new is started.
 *
 * `globalThis` for the reason every other long-lived flag here is. Read by
 * `promoteQueued`, which is the one route to a spawn: without it a run settling
 * during the grace below would reach its `finally`, call `promoteQueued`, and
 * start a fresh billed agent on the way out of the door.
 */
const shutdown = ((globalThis as unknown as { __ufShutdown?: { active: boolean } })
  .__ufShutdown ??= { active: false });

export const isShuttingDown = (): boolean => shutdown.active;

/**
 * Rows whose cycle was in flight when everything stopped.
 *
 * `active_started_at` is what makes this answerable from outside `startRun`'s
 * frame, which is the whole reason that column exists — it is the cycle's own
 * lower bound, and a run between cycles has it null.
 */
function cyclesInFlight(): RunRow[] {
  return db()
    .prepare(
      "SELECT * FROM runs WHERE status = 'running' AND active_started_at IS NOT NULL",
    )
    .all() as RunRow[];
}

/**
 * Recover what the interrupted cycles spent, and stop claiming they are open.
 *
 * The mechanism is `reconcileKilledCycle`, which already existed and was
 * reachable from exactly one place: inside `startRun`'s loop, after
 * `runIteration` returns. A `process.exit(0)` on the next line after
 * `killAllAgents` meant no suspended frame ever resumed, so a routine
 * `docker compose up --build` discarded every in-flight cycle's measured spend
 * — invisible afterwards to `RunProgress.spentGuardUSD`, to `maxRunCostUSD` and
 * to the instance budget, so a run picked up later could overshoot its own cost
 * limit by a full cycle with nothing saying why.
 *
 * The loops are given their chance first and this is the mop-up, which is also
 * what keeps the two from double-counting: the loop's own post-cycle UPDATE
 * clears `active_started_at` in the same statement that writes the estimate, so
 * a row it has settled is not selected here, and the UPDATE below is guarded on
 * the same column for the interleaving where it settles in between.
 *
 * A cycle whose estimate cannot be recovered says so in the run's own log,
 * because a run whose spend is understated and a run that spent nothing are
 * indistinguishable on every page in this app.
 *
 * It writes the **displayed** half of what `reconcileKilledCycle` returns,
 * which is what `spent_usd_est` is and the only half that has a column. The
 * guard-rate half lives in `startRun`'s own frame and does not survive the
 * restart, so a run picked up afterwards carries a guard reading that is a
 * floor — the same understatement that existed before the split, now confined
 * to a run whose model is unpriced *and* whose cycle died in a restart.
 */
export async function reconcileInterruptedCycles(): Promise<number> {
  let recovered = 0;

  for (const run of cyclesInFlight()) {
    const est = await reconcileKilledCycle(run.session_id, run.active_started_at!);

    // Relative, and guarded on the column the loop clears: whichever of the two
    // writes lands second is a no-op rather than a second charge.
    const wrote = db()
      .prepare(
        "UPDATE runs SET spent_usd_est = spent_usd_est + ?," +
          " spent_tokens_est = spent_tokens_est + ?," +
          " active_iteration = NULL, active_started_at = NULL" +
          " WHERE id = ? AND active_started_at IS NOT NULL",
      )
      .run(est?.costUSD ?? 0, est?.tokens ?? 0, run.id);
    if (wrote.changes !== 1) continue;

    if (est) {
      recovered += 1;
      log(
        run.id,
        `The server shut down during work cycle ${run.active_iteration ?? "?"}. ` +
          `Claude Code never reported what it cost, so $${est.costUSD.toFixed(2)} ` +
          "is reconciled from this session's transcripts rather than measured.",
      );
    } else {
      log(
        run.id,
        `The server shut down during work cycle ${run.active_iteration ?? "?"} and ` +
          "no transcript records for it could be read, so whatever that cycle " +
          "spent is missing from this run's total.",
      );
    }
  }

  return recovered;
}

/**
 * Take the server down without throwing away what its agents were doing.
 *
 * The handler this replaces was synchronous end to end — `killAllAgents(sig)`,
 * `releaseDataDir()`, `process.exit(0)` — so twenty-five suspended `startRun`
 * frames never resumed and nothing after `await runIteration(...)` ever ran.
 * Three things were lost every time, and each already had a mechanism written
 * for it: the cycle's spend (`reconcileKilledCycle`), the two columns saying a
 * cycle is in flight, and any account of the ending better than "the server
 * restarted" discovered at the next boot.
 *
 * The order is the whole of it.
 *
 *  1. **Nothing new starts.** The flag is set before anything is signalled,
 *     because a run that settles during the wait reaches its `finally` and
 *     calls `promoteQueued`.
 *  2. **Every live run is interrupted rather than merely signalled**, through
 *     the same single kill path an operator's Stop uses. That buys the `SIGINT`
 *     first — a CLI that handles it may still print `result`, which is the
 *     difference between this cycle's cost being measured and being estimated —
 *     and it is what stops the loop spawning the *next* cycle when its child
 *     dies, which a bare kill would not have done now that the process lingers.
 *     It also gives the run an ending that names the shutdown, instead of
 *     `Claude Code exited with code -1`.
 *  3. **The loops are given their grace**, bounded, and return early the moment
 *     nothing is left in flight.
 *  4. **Whatever they did not finish is mopped up**, then anything still alive
 *     is killed outright.
 *
 * Deliberately does *not* touch `reconcileOnBoot`'s rule that a restart never
 * resumes anything. This is about accounting for the cycle and making the
 * recovery tractable; a run stopped here is picked up by a person, as before.
 *
 * And all of it is the *owner's* to do, which is asked here rather than by the
 * signal handler for the reason every other writer asks it at the write.
 */
export async function shutdownRuns(
  sig: NodeJS.Signals,
): Promise<{ signalled: number; closed: number; recovered: number }> {
  shutdown.active = true;

  // Ownership, read at the write. The `SELECT` below is install-wide by
  // design — see its own comment — so in a process that does not own this
  // directory the whole of what follows lands on somebody else's live runs:
  // a `shutdown` event and its outbound webhook, `restart_closed = 1`, and
  // `active_started_at` cleared on cycles whose agents are still working and
  // still billing. That last one is the serious half and it fails open —
  // `installBudget` and a workflow instance's budget both bound their spend
  // below by that column, so nulling it widens two ceilings at once, silently,
  // in the direction a guard may never move by accident. The second process is
  // not hypothetical: it is the dev server an agent starts against an inherited
  // `DATA_DIR`, and it is this server itself from the beat at which `heartbeat`
  // finds the lock in another name.
  //
  // Its own children are killed anyway — they are this process's whatever the
  // lock says — and outright, because the caller exits the moment this returns,
  // so there is no grace left in which a gentler signal could be noticed. The
  // three counts are what the shutdown *accounted for*, and it accounted for
  // nothing.
  if (!mayWriteDataDir()) {
    killAllAgents("SIGKILL");
    return { signalled: 0, closed: 0, recovered: 0 };
  }

  const live = [...procs.keys()];
  const pending = db()
    .prepare("SELECT id FROM runs WHERE status = 'running'")
    .all() as { id: string }[];

  // Every `running` row, not only the ones holding a child: a run in its
  // pre-cycle transcript scan has no process to signal and is very much about
  // to spawn one, and `interruptRun` is what its next checkpoint reads.
  const markRestartClosed = db().prepare(
    "UPDATE runs SET restart_closed = 1 WHERE id = ?",
  );
  for (const { id } of pending) {
    interruptRun(id, {
      kind: "shutdown",
      reason: `The server shut down (${sig}) while this run was working. Its work is on disk; pick it up to carry on.`,
      pause: false,
      at: Date.now(),
    });
    markRestartClosed.run(id);
  }

  // Waits for the children to go *and* for the loops behind them to write what
  // the cycle cost — that write is the whole point, and it happens a tick after
  // the child exits, not with it. Bounded by the runs that actually had a child
  // rather than by every row claiming a cycle: a row left over from a crash has
  // no loop coming for it, and waiting the full grace out for one would make
  // every shutdown as slow as the worst one. The mop-up below covers it.
  const signalled = new Set(live);
  const stillSettling = () =>
    procs.size > 0 || cyclesInFlight().some((r) => signalled.has(r.id));

  const until = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < until && stillSettling()) {
    await new Promise((r) => setTimeout(r, SHUTDOWN_POLL_MS));
  }

  const recovered = await reconcileInterruptedCycles();

  // Nothing may outlive this process: an agent detached from the terminal's
  // foreground group survives a Ctrl-C on its own, and under Docker a child
  // that ignored the ladder is one the container teardown would kill anyway.
  killAllAgents("SIGKILL");

  return { signalled: live.length, closed: pending.length, recovered };
}

/**
 * Runs a restart closed out and nobody has picked up yet.
 *
 * Two endings produce them and the operator's question covers both: a run the
 * shutdown handler stopped cleanly, and a run `reconcileOnBoot` failed because
 * the process never got that far. Read off the column rather than the reason
 * text for `reported_done`'s reason — a stop reason is prose, written to be
 * read by a person, and parsing it is how it silently stops matching.
 *
 * A run set aside is not one of them. It answers both halves of what this
 * function is for at once: the notice counts what is still outstanding, and a
 * run somebody has decided against is not outstanding, so counting it would
 * leave a banner nobody could ever clear — and `reopenRestartClosed` reads this
 * very list, so the filter is also what keeps the press from starting it.
 * Filtered rather than cleared at the door, so putting the run back restores
 * both.
 */
export function restartClosedRuns(): RunRow[] {
  return db()
    .prepare(
      "SELECT * FROM runs WHERE restart_closed = 1 AND set_aside_at IS NULL" +
        " ORDER BY created_at",
    )
    .all() as RunRow[];
}

export type SetAsideOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Hold one run back from the bulk pick-ups, or put it back among them.
 *
 * The two bulk controls act on a set — every `restart_closed` row, or every
 * terminal run the page is showing — so the only way to keep a run somebody had
 * deliberately stopped out of one was to not press the button. At twenty-five
 * runs that means a control the operator stops using, which is worse than the
 * one-page-at-a-time state it replaced. This is the per-run answer, and it is
 * deliberately the *only* thing it does: the run's status, its stop reason and
 * its `restart_closed` flag are untouched, so putting it back leaves the row
 * exactly as the ending wrote it.
 *
 * A live run is set aside *before* it is signalled, never after — `stopFleet`'s
 * ordering and its reason. Stopping first opens a window where the row is
 * terminal and unmarked, which is precisely the set a bulk pick-up sweeps, so
 * the press meant to hold a run back could hand it to one instead. Marking a
 * `running` row is safe in a way the reverse is not: nothing about it changes
 * the loop's behaviour, and the terminal `setStatus` the loop writes on its way
 * out patches named columns and leaves this one alone.
 *
 * Not a refusal on a running run, then, but the caller still has to do the
 * stopping: `stopRun` is a decision with its own confirmation and its own audit
 * line, and folding it in here would make one function that both marks and
 * kills depending on a status it read itself.
 */
/** The band a priority is clamped into, so one run cannot be unreachable. */
export const PRIORITY_MIN = -100;
export const PRIORITY_MAX = 100;

/**
 * Move a queued run up or down the queue without losing it.
 *
 * Clamped rather than free: an unbounded integer invites `Number.MAX_SAFE_INTEGER`
 * as a way of saying "definitely first", and the row after it is then
 * unreachable by any value a person would type. A hundred each way is more
 * ordering than an install with a concurrency cap of four can express.
 *
 * Only the ORDER changes. Nothing here starts, stops or skips a run, and a
 * priority on a run that is already running means nothing until it is queued
 * again — which is why this refuses nothing based on status: there is no state
 * in which recording an operator's preference is wrong, only states where it
 * has no effect yet.
 */
export function setRunPriority(
  id: string,
  priority: number,
): { ok: true; priority: number } | { ok: false; reason: string } {
  const run = getRun(id);
  if (!run) return { ok: false, reason: "No such run." };
  if (!Number.isFinite(priority)) {
    return { ok: false, reason: "A priority has to be a number." };
  }
  const clamped = Math.max(PRIORITY_MIN, Math.min(PRIORITY_MAX, Math.trunc(priority)));
  db().prepare("UPDATE runs SET priority = ? WHERE id = ?").run(clamped, id);
  log(
    id,
    `Priority set to ${clamped}. Higher runs are promoted first; runs of equal ` +
      `priority keep their arrival order.`,
  );
  return { ok: true, priority: clamped };
}

/**
 * What this run's own task has cost before.
 *
 * COMPLETED runs only, and never this run. A failed run's spend is real money
 * but it is not what the task costs to do - including them would drag the
 * median toward the price of giving up, and the guard would then admit the
 * expensive run it exists to catch.
 *
 * Keyed on `taskSignature`, which normalises whitespace and case, so an
 * operator who reflowed the prompt keeps their baseline. Bounded to the most
 * recent `BASELINE_WINDOW` because a task's cost moves as the repository does,
 * and a median over a year of history is a fact about last year.
 */
export const BASELINE_WINDOW = 20;

/**
 * Give every run written before the column a signature, once.
 *
 * Without this the relative guard is silent on an existing install until three
 * new runs of a task have completed - which is exactly the install that has
 * the history to speak from, and exactly the operator who would conclude the
 * feature does nothing. The hash is over columns the row already carries, so
 * this invents nothing; it only computes what would have been written had the
 * column existed.
 *
 * Bounded and idempotent: only rows where it is null, and a second boot finds
 * none. Runs at open rather than lazily so the cost is one startup rather than
 * a stall on whichever cycle happened to ask first.
 */
export function backfillTaskSignatures(limit = 5000): number {
  const rows = db()
    .prepare(
      "SELECT id, folder, prompt FROM runs WHERE task_signature IS NULL LIMIT ?",
    )
    .all(limit) as { id: string; folder: string; prompt: string }[];
  if (!rows.length) return 0;
  const write = db().prepare("UPDATE runs SET task_signature = ? WHERE id = ?");
  const all = db().transaction((batch: typeof rows) => {
    for (const r of batch) write.run(taskSignature(r.folder ?? "", r.prompt ?? ""), r.id);
  });
  all(rows);
  return rows.length;
}

export function costBaselineFor(run: RunRow): CostBaseline | null {
  const signature = taskSignature(run.folder, run.prompt);
  const rows = db()
    .prepare(
      "SELECT spent_usd FROM runs WHERE task_signature = ? AND id != ? " +
        "AND status IN ('completed','done') AND spent_usd > 0 " +
        "ORDER BY created_at DESC LIMIT ?",
    )
    .all(signature, run.id, BASELINE_WINDOW) as { spent_usd: number }[];
  return baselineFrom(rows.map((r) => r.spent_usd));
}

export function setRunAside(id: string, aside: boolean): SetAsideOutcome {
  const run = getRun(id);
  if (!run) return { ok: false, reason: "No such run." };

  db()
    .prepare("UPDATE runs SET set_aside_at = ? WHERE id = ?")
    .run(aside ? Date.now() : null, id);

  // On the run's own log rather than only the audit line, because what this
  // explains is a run that is sitting terminal while the fleet around it gets
  // picked up — and the page an operator asks that question on is this one.
  log(
    id,
    aside
      ? "Set aside. Picking up runs in bulk will skip this one until it is put back."
      : "Put back. Picking up runs in bulk includes this one again.",
  );

  return { ok: true };
}

/**
 * Pick every one of them up, under the guards each already carried.
 *
 * The budget is the run's own stored policy rather than something re-entered at
 * the door, which is the one place this departs from `reopenRun`'s usual
 * argument for taking one: that function asks for a budget because the usual
 * reason a run needs picking up is that its own limits ended it, and re-queuing
 * under those reproduces the stop. A run closed out by a restart was ended by
 * nothing of its own, so the limits it was started under are still the ones the
 * operator chose. `reopenRun` still checks the carried-forward guards at the
 * door, so one that really had used up its cycles is refused by name and
 * reported here rather than silently skipped.
 */
export function reopenRestartClosed(): {
  reopened: number;
  refused: { id: string; reason: string }[];
} {
  const refused: { id: string; reason: string }[] = [];
  let reopened = 0;

  for (const run of restartClosedRuns()) {
    const outcome = reopenRun(run.id, JSON.parse(run.budget) as unknown);
    if (outcome.ok) reopened += 1;
    else refused.push({ id: run.id, reason: outcome.reason });
  }

  return { reopened, refused };
}

/**
 * Whether a child process is alive for this run *right now*.
 *
 * Not the same as "this run is active": `procs` is emptied at the end of every
 * work cycle and refilled when the next one spawns, so this reads false while a
 * running run sits in its pre-cycle budget scan. Never use it to decide whether
 * a folder is occupied — `occupantOf` reads the row status for that reason.
 */
export function isRunning(id: string): boolean {
  return procs.has(id);
}

/* ------------------------------------------------------------------ */
/* Restart recovery                                                    */
/* ------------------------------------------------------------------ */

/**
 * Close out rows left mid-flight by a restart.
 *
 * Mandatory rather than tidy-up: a live row holds its folder, so without this
 * a single crash blocks that folder for good.
 *
 * It never signals a process. The database lives on a volume that outlives the
 * container, so a pid recorded before a restart names something else entirely
 * afterwards — plausibly this server. tini as the entrypoint already means the
 * agents died with the container; the only case that leaves a real orphan is a
 * host `npm run dev`, where pid reuse makes killing just as unsound. Naming the
 * resume command is the honest amount of help.
 *
 * Queued rows are stopped, not restarted. Promoting a prompt written days ago
 * into an unattended agent that accepts edits is the one thing a queue must
 * never do on its own.
 *
 * A recently *paused* row is the one exception, and a deliberate one. It is not
 * an unreviewed prompt: it is a run the operator started, in a mode they chose
 * precisely so that it would carry on across 5-hour windows, and the sweeper
 * re-evaluates its budget from scratch before anything spawns. The grace period
 * (`settings.resumeGraceHours`) is what keeps it from becoming the very thing
 * the rule above forbids — past it, a stale pause is closed out like any other
 * stale row.
 *
 * Runs waiting on other runs are closed out too, and this is the one place that
 * deliberately does **not** call `releaseDependents`. Two reasons, and either
 * would be enough. What such a run is waiting for is a row this same boot has
 * just marked failed or stopped, so releasing it would promote a days-old
 * prompt into an unattended agent that accepts edits — precisely the rule the
 * queued case above exists to enforce, arrived at from the other side. And a
 * waiting run left alone would be waiting on a dependency that is now terminal
 * and can never satisfy it, which is a row nothing would ever wake. Closed out
 * before the loop below, so no terminal transition it makes can find a waiting
 * row to release.
 */
export function reconcileOnBoot(): void {
  // No cycle is in flight at a boot, on any path: this process has just
  // started, and a non-null pair here names a cycle that died with the previous
  // one. The shutdown handler clears them for the runs it reached; this covers
  // the rest — a `SIGKILL`, an OOM, a host that lost power — where nothing ran
  // at all. Before the early return below, because a row can be left claiming
  // an open cycle without being one this pass would otherwise touch.
  db()
    .prepare(
      "UPDATE runs SET active_iteration = NULL, active_started_at = NULL" +
        " WHERE active_iteration IS NOT NULL OR active_started_at IS NOT NULL",
    )
    .run();

  const orphaned = db()
    .prepare("SELECT * FROM runs WHERE status = 'waiting'")
    .all() as RunRow[];

  const stale = activeRuns();
  if (stale.length === 0 && orphaned.length === 0) return;

  let closed = 0;
  let kept = 0;
  const graceMs = getSettings().resumeGraceHours * 3_600_000;

  for (const run of orphaned) {
    // Deliberately *not* flagged `restart_closed`, unlike every other row this
    // pass closes. That flag offers a one-press pick-up, and `reopenRun` puts a
    // `stopped` row back in the *queue* rather than back to `waiting` — so a run
    // that never started, whose dependency this same boot has just closed out,
    // would be started on work that never happened. Which is exactly what
    // `releasableRuns` and the paragraph above exist to prevent. Its reason says
    // to start it again if it is still wanted, and that stays a decision about
    // one run.
    setStatus(run.id, "stopped", {
      finished_at: Date.now(),
      stop_reason:
        "The server restarted while this run was waiting for another run to " +
        "finish, and that run was closed out by the same restart. Start it " +
        "again if it is still wanted.",
    });
    closed += 1;
  }

  for (const run of stale) {
    if (run.status === "paused") {
      const fresh = run.paused_at !== null && Date.now() - run.paused_at < graceMs;
      if (fresh) {
        kept += 1;
        continue;
      }
      setStatus(run.id, "stopped", {
        finished_at: Date.now(),
        stop_reason:
          "This run was waiting for the next 5-hour window when the server " +
          "restarted, and has been waiting too long to pick up on its own. " +
          "Start it again if it is still wanted.",
        resume_at: null,
        restart_closed: 1,
      });
      closed += 1;
      continue;
    }

    if (run.status === "queued") {
      setStatus(run.id, "stopped", {
        finished_at: Date.now(),
        stop_reason: "The server restarted before this run started. Start it again.",
        restart_closed: 1,
      });
      closed += 1;
      continue;
    }

    // Deliberately `failed` even for a run that was set to resume: the child is
    // gone with unknown state, and mapping that to `paused` would be guessing.
    const resume = run.session_id
      ? ` To pick up where it left off: claude --resume ${run.session_id}`
      : "";
    setStatus(run.id, "failed", {
      finished_at: Date.now(),
      stop_reason: `The server restarted while this run was in progress.${resume}`,
      restart_closed: 1,
    });
    closed += 1;
  }

  if (closed > 0) {
    console.warn(
      `[usagefoundry] Closed out ${closed} run(s) interrupted by a restart.`,
    );
  }
  if (kept > 0) {
    console.warn(
      `[usagefoundry] Kept ${kept} paused run(s); they resume when their 5-hour window clears.`,
    );
    startSweeper();
  }
  if (closed > 0 || kept > 0) {
    // Kept as a row as well as said out loud. Twenty-five runs terminated, each
    // needing an operator to pick it up by hand, was one `console.warn` into a
    // stream nobody is tailing — after which nothing in this app could answer
    // "why is everything failed" at all. `RunsPage` reads the newest of these.
    recordOpsEvent("warn", "boot.reconciled", { closed, kept });
  }
}
