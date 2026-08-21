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
import { lastScanReadFailures, scanUsage, type UsageEntry } from "./transcripts";
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
  noteLiveTick,
  noteLiveTickFailure,
  noteSweep,
  noteSweepFailure,
  opsLog,
  recordOpsEvent,
} from "./ops";
// The log's own extraction of what a tool call is about, so the parser retains
// the same line for a call whose result comes back an error. Client-safe and
// pure; the dependency runs the permitted way round.
import { clipToolInput, MAX_LOG_CHARS, toolArgs } from "./logLine";
// Same direction, same reason: the cycle deadline says how long it waited in
// the words the run page already uses for every other span.
import { fmtDuration } from "./format";
import type { RunDependencyDTO, SandboxStateDTO } from "./apiTypes";

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
  kind: "operator" | "guard" | "deadline" | "shutdown";
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
}

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
 */
function logLifecycle(e: PersistedRunEvent): void {
  const p = e.payload;
  const num = (k: string): number | null =>
    typeof p[k] === "number" ? (p[k] as number) : null;
  const str = (k: string): string | null =>
    typeof p[k] === "string" ? (p[k] as string).slice(0, 300) : null;

  switch (e.kind) {
    case "status":
      opsLog("info", "run.status", { run_id: e.runId, status: str("status") });
      return;
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
      opsLog("error", "run.error", { run_id: e.runId, message: str("message") });
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
  if (fs.existsSync(path.join(repoRoot, ".gitmodules"))) {
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
            continues_run, agent, origin, origin_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.origin,
        input.originRef ?? null,
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

  for (const run of runs) {
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

/** Ids are UUIDs; the whole app names a run by its first eight characters. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

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
/* Claude Code invocation                                              */
/* ------------------------------------------------------------------ */

interface IterationResult {
  exitCode: number;
  costUSD: number;
  tokens: number;
  sessionId: string | null;
  finalText: string;
  isError: boolean;
  /**
   * `tool_use` block id → the sub-agent that `Task` call handed work to.
   *
   * Parser state rather than a result, and it lives here because this is the
   * only thing that survives from one line of the stream to the next: the id
   * arrives on the call and the name is needed again when that sub-agent's own
   * words come back, which can be many lines later. Per cycle, because a
   * `tool_use` id is.
   */
  subagentNames: Map<string, string>;
  /**
   * `tool_use` block id → what that call was, for the result that answers it.
   *
   * Parser state for `subagentNames`' reason and with its lifetime: a
   * `tool_result` block names the id of the call and nothing else, so a failure
   * can only be reported as "Bash: git push …" by something that saw the call.
   * Bounded per entry rather than per cycle — the tool's name and one clipped
   * line, never the input itself, which for a `Write` is the whole file.
   */
  toolCalls: Map<string, ToolCall>;
  /**
   * Whether the CLI's terminal `result` event arrived. Cost and tokens come
   * only from that event, so when it is missing — operator stop, crash, OOM —
   * this iteration contributes $0 to the run's totals despite having burned
   * real tokens. The run reports that rather than presenting the understated
   * figure as fact.
   */
  sawResult: boolean;
  /**
   * `result.subtype` verbatim, and the only machine-readable statement the CLI
   * makes about *why* a cycle ended.
   *
   * Kept because one member of it has to be told apart from a crash:
   * `error_max_budget_usd` is the cycle reaching the ceiling `buildArgs` gave
   * it, which is this run's own spending limit arriving a cycle earlier than
   * the pre-cycle guard would have said it. Everything else about that cycle
   * looks like a failure — a non-zero exit, `isError` set, and the CLI's own
   * summary latched into `apiError` — so without the subtype the run is filed
   * as `Claude Code exited with code 1`, or worse, matched as an allowance
   * refusal and parked for hours waiting for money that will not arrive.
   *
   * Not narrowed to a union. The set is the CLI's and moves with the pin, so a
   * member this build has never heard of must arrive as itself rather than as
   * a parse failure.
   */
  subtype: string | null;
  /**
   * What the provider refused with, when it refused rather than the agent
   * failing. Claude Code reports API-level errors as an assistant message
   * whose `message.model` is the literal `<synthetic>` — the same marker
   * `transcripts.ts` keys on to keep an all-zero record out of the unpriced
   * warning — so this is the only signal separating "Claude would not do it"
   * from "the agent crashed". Without it every refusal reads as
   * `Claude Code exited with code 1`, which blames the agent for a decision
   * it did not make.
   */
  apiError: string | null;
  /**
   * Tail of the child's stderr. Forwarded to `run_events` line by line as it
   * arrives, and kept here too so a refusal that only ever reaches stderr is
   * still visible to the branch that has to classify it.
   */
  stderrTail: string;
}

/** Cap on `IterationResult.stderrTail`. An agent can log for hours. */
const STDERR_TAIL_LIMIT = 4_096;

/**
 * Cap on `runs.needs_review_reason`, applied at the write and nowhere else.
 *
 * At the write for `log()`'s reason with `MAX_LOG_CHARS`: a second bound at a
 * second place is a second number to keep in step. The size is what the wire can
 * carry rather than what a person will read — `RunDTO` is polled every three
 * seconds by the run page and is the row shape the runs list ships for *every*
 * row, so an unbounded model-authored blob multiplies by the length of the list.
 * Nothing is lost by clipping: the full text is the cycle's assistant output in
 * `run_events`, which the Report tab already renders.
 */
export const MAX_NEEDS_REVIEW_REASON = 2_000;

/** The agent's account of the wall, bounded so a clip cannot read as the whole. */
function clipReason(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_NEEDS_REVIEW_REASON
    ? trimmed
    : `${trimmed.slice(0, MAX_NEEDS_REVIEW_REASON - 1)}…`;
}

/**
 * What the cycle about to spawn actually says.
 *
 * Pure, and separated from the loop because every branch is a billing decision
 * whose failure mode is silent. Sending `continuation` — "if it is fully
 * complete, reply with exactly DONE" — into a session that has just reported
 * DONE produces an immediate second DONE and a billed cycle that did nothing,
 * which is precisely why the pushback and the follow-up exist.
 *
 * Keyed on the session, not on the cycle counter: a cycle the live guard cut
 * short is refunded, so `iterations === 1` can name a conversation that is
 * already part-way through the task. "There is a session to resume into" is
 * what a continuation actually means, and the two agree for any run that is
 * never interrupted.
 *
 * `followUp` is the operator's own message, carried by a run they picked up by
 * hand. With no session to resume it cannot stand alone — the run is starting
 * the original task over, and a note that only makes sense as a reply would
 * read as the whole job — so it is appended rather than substituted.
 *
 * A run that opens with the task again *after* having already worked is told so.
 * That combination is a restart, not a first attempt, and the difference is
 * invisible from inside the prompt: the conversation that held what the previous
 * attempt did is gone, while its work is still on disk.
 */
export function nextPrompt(o: {
  sessionId: string | null;
  followUp: string | null;
  /** The previous cycle said DONE and this run is set to carry on anyway. */
  justRetriggered: boolean;
  task: string;
  /** Prepended on the first cycle of an isolated run only. */
  isolationPreamble: string | null;
  /** Work cycles this run was charged for before the one about to spawn. */
  priorCycles: number;
  /** The run's own branch, for an isolated run: where that work is. */
  worktreeBranch: string | null;
  /** The run whose branch this one took over, when it took one over. */
  continuedFrom: { runId: string; branch: string; base: string | null } | null;
  /** `settings.continuedWorkPrompt`, the editable half of that notice. */
  continuedWork: string;
  continuation: string;
  donePushback: string;
  /**
   * Whether replying DONE can actually end this run.
   *
   * False for `maxIterations === 1`, where the cycle cap ends it either way and
   * the sentence would buy nothing but a changed `reported_done` — which is the
   * one input to `reopenPrompt`'s pushback branch, so a promise that changes
   * nothing about this run would change what a pick-up says to it. False for
   * `continueAfterDone`, where the run is set to carry on regardless and
   * `donePushbackPrompt` tells the agent so in as many words; a cycle-1 notice
   * saying the opposite is a contradiction the agent meets on every later cycle.
   */
  endsOnDone: boolean;
}): string {
  if (o.sessionId === null) {
    return [
      o.isolationPreamble,
      o.isolationPreamble ? SHARED_CHECKOUT_NOTICE : null,
      // Ahead of the prior-work notice, and both can apply: this one is about
      // the branch's whole history, that one about this run's own earlier
      // attempt at the task. Read in the other order the agent meets "carry on
      // from where you stopped" before it has been told the work is not its own.
      o.continuedFrom ? continuedWorkNotice(o.continuedFrom, o.continuedWork) : null,
      o.priorCycles > 0 ? priorWorkNotice(o.priorCycles, o.worktreeBranch) : null,
      o.task,
      o.followUp,
      // Last, so it is the most recent thing in the opening context and so it
      // reads as a statement about the task above rather than a preamble to it.
      o.endsOnDone ? COMPLETION_NOTICE : null,
      // After it, because the two are one contract and this is the branch of it:
      // an agent told how to finish and not how to stop has one ending.
      NEEDS_REVIEW_NOTICE,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
  }
  // Not appended: this branch is the operator's own words, which `docs/runs.md`
  // promises are sent verbatim as the next turn. A run whose operator wrote a
  // note already has the person this ending exists to reach, and the contract is
  // restated on the very next cycle by the branch below.
  if (o.followUp) return o.followUp;
  // On both, not on cycle 1 alone. `COMPLETION_NOTICE`'s own docblock names the
  // failure this avoids: an agent on cycle 5 that has been re-told about DONE
  // four times and about this once, on a turn that has scrolled out of reach,
  // has been told there is one ending.
  return `${o.justRetriggered ? o.donePushback : o.continuation}\n\n${NEEDS_REVIEW_NOTICE}`;
}

/**
 * What an agent is told when it is handed the original task on a run that has
 * already done work.
 *
 * Everything the previous attempt left behind is on disk and nowhere else — the
 * conversation is gone, so nothing else in the prompt refers to it — and an
 * agent given a bare task does the first thing that task says, which is the work
 * it is standing on top of. Pointing it at the branch is the whole point for an
 * isolated run: its predecessor's output is committed there, which is the one
 * place a fresh session can still read it.
 */
/**
 * What an agent is told when the commits under it are another run's.
 *
 * A different case from `priorWorkNotice`, and the difference is what the agent
 * has to do about it. There, the work is this run's own and the instruction is
 * "carry on from where you stopped". Here it is someone else's: there is no
 * conversation that was ever going to be resumed, the decisions behind those
 * commits were never in any context, and the branch may well contain choices
 * this agent would not have made. So it is pointed at the range rather than
 * told to infer it — `<base>...HEAD` is the chain's whole change, the same
 * range the run page's diff and any review are measured over, which is what
 * keeps the agent, the reviewer and the merge looking at one thing.
 *
 * The range is asked for as `--stat`, never as the diff itself, because what
 * an opening turn reads it then pays for on every turn after it: the
 * conversation is re-sent whole on each request, so an opening `git diff` is
 * not read once but held for the life of the run. Five commits of this repo's
 * own history is 176KB of diff against 1.2KB of stat — tens of thousands of
 * resident tokens to say what a stat says, about work the agent may never
 * touch. The stat names every file and how far it moved, which is what decides
 * where to look; opening one of them then costs one file, and the agent can.
 *
 * The facts are generated and the guidance is `settings.continuedWorkPrompt`,
 * for the reason `PeriodSeries.limitBasis` travels beside its fraction: the
 * sentence naming the branch must not be able to drift from the branch.
 */
function continuedWorkNotice(
  from: { runId: string; branch: string; base: string | null },
  guidance: string,
): string {
  const range = from.base ?? "the branch point";
  return (
    `This branch (${from.branch}) already carries the work of run ${shortId(from.runId)}, ` +
    `which you are continuing. That was a separate agent and a separate conversation: none of ` +
    `what it decided is in your context, and the only record of it is the branch itself. ` +
    `Before doing anything, read it:\n\n` +
    `    git log --oneline ${range}..HEAD\n` +
    `    git diff --stat ${range}...HEAD\n\n` +
    guidance.trim()
  );
}

function priorWorkNotice(cycles: number, branch: string | null): string {
  const spent = `${cycles} work ${cycles === 1 ? "cycle" : "cycles"}`;
  const where = branch
    ? `committed its work to this branch (${branch})`
    : `worked in this folder`;
  const look = branch
    ? "read the recent commits on this branch and the current state of the files"
    : "check the current state of the files";
  return (
    `A previous attempt at this task already ran ${spent} and ${where}. There is ` +
    `no conversation left to resume, so the task is repeated in full below. ` +
    `Before doing anything, ${look}, and carry on from where that attempt ` +
    `stopped rather than starting it again.`
  );
}

/**
 * The only cycle that is ever told how a run ends.
 *
 * Until this existed, `DEFAULT_CONTINUATION_PROMPT` was the sole string in the
 * app naming the `DONE` token, and `nextPrompt` returns it only on the
 * `sessionId !== null` branch — so cycle 1 was judged by `reportedDone`'s
 * matcher against a protocol it had never been given. Measured over 251 runs on
 * this install: of the runs whose budget allowed a second cycle, those whose
 * *task text* happened to carry the token ended in one cycle 53% of the time
 * and those without did so twice out of 120 — both of them a crash and an
 * operator stop rather than a completion. `reported_done` was 69% in both
 * groups. The second cycle was not finding more work; it was the first turn
 * permitted to say the job was over, and 92 of them cost $162 to say one word
 * into a re-sent conversation.
 *
 * Generated here rather than added to `Settings`, and that is the load-bearing
 * half. `getSettings()` is `{...DEFAULTS, ...stored}` and the settings page PUTs
 * the whole *effective* object on Save, so every `DEFAULT_*` prompt is
 * materialised into the stored blob the first time anybody presses it — after
 * which editing the constant reaches no install that has ever saved. The same
 * split `continuedWorkNotice` makes, for the same reason: the sentence that has
 * to stay true is generated, and only guidance is editable.
 *
 * Both sentences are load-bearing. The first restates
 * `DEFAULT_CONTINUATION_PROMPT` almost verbatim on purpose — cycle 1 and cycle 2
 * disagreeing about the bar is the bug — and names the token as the *only*
 * ending, because an agent that believes stopping its turn is enough is exactly
 * the agent that produced the 92. The second exists because an instruction an
 * agent cannot satisfy produces churn rather than silence: told only to reply
 * DONE when finished, a run that is genuinely unfinished invents work to explain
 * itself. `DEFAULT_DONE_PUSHBACK_PROMPT` carries the same escape clause for the
 * same reason.
 */
const COMPLETION_NOTICE =
  "This run continues until you reply with exactly DONE on its own line: that " +
  "line is what ends it, and nothing else does — stopping your turn without it " +
  "buys another work cycle on the same task. When the task above is fully " +
  "complete and verified, reply with exactly DONE on its own line and make no " +
  "further changes. If work remains, or something could not be verified, end " +
  "with what remains and why instead of DONE, and this run will carry on.";

/**
 * The other ending, and the one an agent has to be told it may ask for.
 *
 * `COMPLETION_NOTICE` above says stopping without DONE "buys another work cycle
 * on the same task", which is true and is exactly the wrong instruction for a
 * run that has met a wall: it spends the rest of its cycle cap restating the
 * problem, or replies DONE anyway and is filed green. Neither reaches a person.
 *
 * The bar is the load-bearing half of the wording, not the token. An ending the
 * agent controls is a cheap way out of a large or tedious task, so the sentence
 * has to make reporting it *more* work than carrying on: it names what counts as
 * a wall, refuses the shapes that are not one, and asks for the three facts an
 * operator needs before they can act. `DEFAULT_DONE_PUSHBACK_PROMPT` carries the
 * same kind of clause for the same reason — an instruction an agent cannot
 * satisfy produces churn rather than silence.
 *
 * Generated rather than stored, for `COMPLETION_NOTICE`'s reason: the settings
 * page PUTs the whole effective object on Save, so a sentence added to a
 * `DEFAULT_*` prompt reaches no install whose operator has ever pressed it.
 *
 * Deliberately **not** gated on `endsOnDone`. That flag withholds a promise that
 * would be false — under `maxIterations === 1` the cap ends the run whatever the
 * agent says — and neither of its cases reaches this token, which always ends the
 * run with the reason recorded. `maxIterations` defaults to 1, so gating would
 * withhold the new ending from precisely the runs where it matters most.
 *
 * Exported, where `COMPLETION_NOTICE` is not, for one reason: this one rides on
 * *every* prompt `nextPrompt` returns bar the operator's own note, so every
 * exact-equality assertion in that function's suite composes against it. The
 * alternative was degrading each of them to a substring match, which is the
 * weaker test.
 */
export const NEEDS_REVIEW_NOTICE =
  "If you reach something you cannot get past, reply with exactly NEEDS_REVIEW " +
  "on its own line and this run ends for a person to look at. Use it only after " +
  "you have actually tried and been stopped — a credential that is not there, a " +
  "permission you do not have, a decision that is not yours to make, a " +
  "repository or service you cannot reach — and in the same reply say what you " +
  "were doing, what you tried, and exactly what stopped you. Do not use it " +
  "because the task is large, unclear or tedious: work you have not attempted is " +
  "not a wall, and a run that ends this way with nothing to act on spends a " +
  "person's time instead of a work cycle.";

/** Which of the two endings a cycle's own final text reported, if either. */
export type CycleEnding = "needs-review" | "done";

/**
 * How a work cycle's last assistant turn ends the run, or null to carry on.
 *
 * Extracted because the **precedence** is a decision rather than an expression:
 * a turn carrying both tokens is an agent contradicting itself, and
 * `needs-review` wins. `completed` is `ok`-toned, green, and the one ending
 * nobody re-reads; `needs-review` is warn-toned, reopenable, and asks for a
 * person — so the recoverable reading is the safe one to err toward, and getting
 * it backwards files a run that said it was stuck as a run that said it was
 * finished. That throws nothing and typechecks.
 *
 * Both tokens must be alone on their line, and the spellings differ on purpose:
 * the sentinel is `NEEDS_REVIEW`, the stored status is `needs-review`, so a task
 * that quotes the *status* — which is what a task about this app would do —
 * cannot trip the matcher. Measured on this install, a task whose text merely
 * carried `DONE` ended its run in a single cycle 53% of the time against 2 of
 * 120 without it, so the collision is real and these two guards are what bound
 * it. Do not tidy the spellings into agreement.
 *
 * Sub-agent text cannot reach here at all: `handleStreamLine` routes any message
 * carrying `parent_tool_use_id` to its own event kind, so it never becomes a
 * cycle's `finalText`. That protection is inherited rather than restated.
 */
export function cycleEnding(finalText: string): CycleEnding | null {
  if (/^\s*NEEDS_REVIEW\s*$/m.test(finalText)) return "needs-review";
  if (/^\s*DONE\s*$/m.test(finalText)) return "done";
  return null;
}

/**
 * What an isolated run is not told by "you are working in a dedicated worktree".
 *
 * `refs/stash` is a **common** ref, not a per-worktree one, so every isolated
 * run on a repository pops from one shared stack — reproduced on git 2.50.1:
 * worktree A stashes, worktree B stashes, and A's `git stash pop` applies B's
 * entry and drops it. Across this install's 251 runs there are 123 `git stash
 * pop` calls and **not one** names a `stash@{n}`; eight runs left assistant text
 * saying in as many words that they had popped a sibling's work. The isolation
 * preamble actively invites the belief — it says the checkout is the agent's own
 * — and the failure is silent in the worst direction: a sibling's uncommitted
 * files arrive in this run's tree looking like its own edits.
 *
 * The clean-tree case is named because it is the one that surprises: `git stash
 * -u` with nothing to stash creates no entry at all, so the `pop` that pairs
 * with it in the agent's plan takes whatever a sibling pushed instead.
 *
 * Generated beside the preamble rather than added to it for
 * `COMPLETION_NOTICE`'s reason — the preamble is settings-backed and stale on
 * any install that has pressed Save. Sent only where the preamble is, which is
 * the first cycle of an isolated run: this is a fact about the machine that run
 * is standing on, and it is true for the whole run.
 *
 * `/tmp` gets one clause rather than a mechanism. It is shared by every
 * concurrent agent and 117 paths in this corpus were used by more than one run,
 * but not one confirmed clobber was found, so what is warranted is a sentence
 * and not a per-run `TMPDIR`.
 */
const SHARED_CHECKOUT_NOTICE =
  "Two things in this container are shared with the other agents working right " +
  "now, and your worktree does not isolate either. The git stash stack is one " +
  "of them: `refs/stash` is common to every worktree of this repository, so a " +
  "bare `git stash pop` can apply and destroy a sibling run's uncommitted work " +
  "— and `git stash -u` on an already-clean tree pushes nothing, so the pop you " +
  "paired with it takes theirs. Prefer commits over stashing; if you must " +
  "stash, push with `git stash push -m <unique-label>` and pop by that label's " +
  "own `stash@{n}`, never bare. `/tmp` is the other: put scratch files under a " +
  "directory named for your branch rather than at a name a sibling would pick.";

/**
 * The two commands an isolated run is *ordered* to use, granted to it.
 *
 * `acceptEdits` auto-approves file edits and read-only shell, and holds
 * mutating git for a human — `git add` and `git commit` both come back "This
 * command requires approval", and a `-p` child has nobody to give it. So the
 * isolation preamble tells the agent to commit as it goes, and the permission
 * mode the run form defaults to makes that impossible. Measured, not reasoned:
 * one run tried seven times, in five phrasings, and was refused every time,
 * finished as `completed`, and left its whole change sitting uncommitted in a
 * worktree that `landState` then read as a branch with nothing on it.
 *
 * Granted by name rather than by moving the run to `bypassPermissions`, which
 * would also hand it the network, `rm`, and everything else the run form warns
 * about. The narrow grant is exactly the promise the preamble already makes.
 *
 * Isolated runs only. A run working in the operator's own checkout is told
 * nothing about committing, and auto-approving commits into the tree someone
 * is working in is a decision nobody asked for.
 *
 * Prefix-matched, so `git commit -am …` is covered and `git -c user.name=…
 * commit` is not — the agent above tried that form too, once, before falling
 * back to the plain one. Not worth a second entry: `gitEnv` and the image's
 * system-wide identity are why it reached for `-c` at all.
 */
const ISOLATED_GIT_TOOLS = ["Bash(git add:*)", "Bash(git commit:*)"];

/**
 * The two search tools, named so that the CLI offers them at all.
 *
 * Not a permission. `Grep` and `Glob` read; nothing about naming them widens
 * what a child may do, and the mode over them is untouched. What the name buys
 * is the tools' *existence*: the pinned CLI drops both from the tool list
 * whenever `Bash` is present — telling the model to use `grep` and `find`
 * through the shell instead — unless something on the argv opts in by naming
 * one of them.
 *
 * Measured on this install rather than reasoned about, and in both directions.
 * Zero of 469 recorded `system:init` events have ever carried `Grep`, going
 * back five days before a sandbox existed here; every one of the five `Grep`
 * and `Glob` calls an agent ever attempted came back "No such tool available".
 * And in a throwaway container on the pin, adding these two to `--allowedTools`
 * puts both back in the list and changes nothing else in it.
 *
 * The fallback the CLI points at is exactly what a broken sandbox took away:
 * for fifteen hours every `Bash` call on this install died inside bubblewrap,
 * which left agents with `Read` and a directory they could not list. One of
 * them recovered a file list by parsing `.git/index` by hand. Two independent
 * defects, and this is the half that does not need a container restart to fix.
 *
 * On every spawn, unlike `ISOLATED_GIT_TOOLS`: a read is not a decision about
 * the tree the child is standing in, so there is nothing here for isolation or
 * a permission mode to gate.
 */
export const SEARCH_TOOLS = ["Grep", "Glob"];

/**
 * Name-matched process killers, withheld from every agent.
 *
 * This server is a Next.js process and Next renames it: inside the container
 * `ps` shows `next-server (v…)`, not `node server.js`. An agent verifying a
 * change starts its own dev server, and once that has booted it carries the
 * *same* title — `next dev` hands off to a child that renames itself the same
 * way, which is why an agent that tries `pkill -f "next dev"` and finds the
 * port still held broadens the pattern rather than narrowing it. The two
 * processes are then indistinguishable by name, and the one `pkill` reaches is
 * the one that was already running.
 *
 * Measured, not reasoned: a run issued `pkill -f "next-server|next dev"` to
 * clean up a dev server it had started on 3100. tini lost its child,
 * `restart: unless-stopped` brought the container back, and `reconcileOnBoot`
 * marked fourteen runs failed 690ms later — including the one that ran it.
 *
 * Withheld by name because a name is the only thing there is to withhold it by
 * for most of what it reaches. The uid split closed one half of that and left
 * the other open, and the halves are worth keeping apart. Where the server is
 * *actually* root — the shipped container, and nothing else — children drop to
 * `UF_AGENT_UID` (`src/lib/privsep.ts:23`–`33`) and `kill(2)` checks the
 * sender's uid, so the incident above cannot recur the way it happened: the
 * pattern still matches the server, and the signal is refused. `npm run dev` on
 * a laptop, the test suite, and a container an operator has pinned back to
 * `user: "1000:1000"` all run one uid and get the original behaviour, which
 * `privsep.ts:41`–`47` states in as many words.
 *
 * What no arrangement here closes is agent-to-agent. Every child of every kind
 * takes the same uid, so one run's `pkill -f` reaches a sibling's `claude`, the
 * dev server it started and the build it is halfway through — and that run's
 * only evidence is a tool call that failed for no reason it can see. Until an
 * agent's processes are separated from a sibling's by a uid per slot or a PID
 * namespace, this deny and the notice below it are the whole of what stands
 * between two runs. The container has neither a docker socket nor a docker CLI,
 * so name-matched killing also remains the only route from an agent to a
 * restart, and it does not look like one from the agent's side.
 *
 * `kill` itself stays permitted, deliberately. A pid is a handle on a process
 * the agent actually started; a pattern is a guess about every process on the
 * machine. Denying both would leave an agent unable to stop the dev server it
 * was told to start, which is a port held for the rest of the container's life.
 *
 * Deny beats `--permission-mode`, verified against the pinned CLI: a
 * `bypassPermissions` session is still refused these.
 */
const PROCESS_KILLERS = ["Bash(pkill:*)", "Bash(killall:*)"];

/**
 * What every agent is told about the process it is running inside.
 *
 * `PROCESS_KILLERS` stops two commands; this is what stops the agent routing
 * around them, which otherwise takes it one turn — `kill $(pgrep -f
 * next-server)` is not `pkill` and is exactly as fatal.
 *
 * A recipe rather than a prohibition, and the difference is the whole point. An
 * agent told only "do not kill things by name" and left holding a dev server
 * whose pid it no longer has does the safe thing, which is nothing: the server
 * survives the cycle and holds its port for the life of the container, and the
 * next cycle finds the port taken and starts another. That is the failure this
 * would have traded the first one for. So the pattern that is actually safe is
 * spelled out — match on the port, which names one process the agent chose,
 * never on the title, which names two — along with the child-process form,
 * since `next dev` forking a child it does not kill is what sent the run that
 * caused all this looking for `pkill` in the first place.
 *
 * On the system prompt rather than in the task, because the task is only sent
 * on the first cycle of a session and this is true of every cycle. It says
 * nothing about docker on purpose: there is no docker in this image, and
 * warning about an absent command is how an agent learns to look for it. For
 * the same reason it names no tool the image does not carry: the Dockerfile
 * installs `procps` and neither `psmisc` nor `iproute2`, so `fuser` and `ss`
 * are absent and suggesting either teaches an agent to reach for a command that
 * is not there.
 *
 * **This string is on every concurrent agent's argv, so any literal in it is a
 * pattern that matches all of them.** It used to carry `kill $(pgrep -f 3100)`
 * as the worked example, and `--append-system-prompt` put those four digits on
 * the command line of every sibling `claude` process — so the one command this
 * notice recommends by name matched the whole fleet. Measured twice: at
 * 2026-08-15 23:39:42 run `b81e7c70` escalated from a narrow `pgrep -f "next dev
 * -p 3100"` through an explicit pid to a bare `pgrep -f 3100`, and `9b98ddec`
 * — a Go run in another repository, with no port-3100 process and no tool call
 * of its own mentioning 3100 — died in the same second with "exited with code
 * 143". Five dependents blocked behind it. It happened again on 2026-08-16 at
 * 14:23:38, `02c3e132` taking down `8d6b1ffc`. No work was lost, because all
 * four runs resumed the same session, but three were truncated at their cycle
 * cap and every dependent needed picking up by hand.
 *
 * So the example is a variable now, and the mechanism is stated rather than the
 * conclusion — an agent told only "do not use a bare number" reaches for a
 * different literal, where one told *why* a literal is dangerous checks first.
 * `pgrep -af` is named because looking is the habit that generalises to the next
 * pattern nobody anticipated.
 */
const SELF_HOSTING_NOTICE =
  "You are running inside a long-lived server process that is also supervising " +
  "other agents. Ending it ends every run in flight, including your own, and " +
  "nothing you have not committed survives. `pkill` and `killall` are therefore " +
  "unavailable to you. To stop a background process you started, record its pid " +
  "(`cmd & pid=$!`) and use `kill \"$pid\"`; a dev server usually forks a child, " +
  "so `kill $(pgrep -P \"$pid\") \"$pid\"` or start it under `setsid` and use " +
  "`kill -- -$pid`. If you no longer have the pid, select on something unique to " +
  "the process you started — the port you chose, held in a variable: " +
  "`port=<the one you started>; kill $(pgrep -f \"$port\")`. Always read what a " +
  "pattern matches with `pgrep -af <pattern>` before killing anything: every " +
  "agent running beside you carries these very instructions on its command line, " +
  "so any literal string that appears here matches all of them as well as you. " +
  "And never match on `next-server`, `next dev` or `node`: this server's process " +
  "title is `next-server`, which is also the title your own dev server takes, so " +
  "a match on it cannot tell the two apart.";

/**
 * Why a run should hand self-contained work to a sub-agent.
 *
 * Appended to the same flag rather than sent as a second
 * `--append-system-prompt`, which the CLI would read as a replacement the way
 * it reads a second `--allowedTools`. One notice arriving instead of two is
 * silent, and the half that went missing would be the process-safety one.
 *
 * The numbers are here because they are the whole argument for spending tokens
 * on the instruction. Measured over 1,011 transcripts: a tool call inside a
 * sub-agent costs 6.5 cents against 13.9 in a run's own main thread, and almost
 * all of the gap is cache re-read — 2.7 cents against 8.3. The mechanism is
 * that nothing shrinks a main thread's context, so every file read there is
 * re-read at every later turn of the run: the same tool call costs 6.8 cents at
 * turn 20 and 15.4 at turn 150, while a sub-agent opens on a small context and
 * its whole conversation is discarded when it answers.
 *
 * The floor is in the text because delegation is not free in the other
 * direction. A sub-agent opens ~20k tokens of its own, and sessions under ten
 * turns measured *worse* per tool call than the 10-25 band — a run that
 * delegated every errand would spend more than one that delegated none.
 */
/**
 * The context size the CLI compacts a work cycle's conversation at.
 *
 * A module constant rather than a setting, and the precedent is
 * `--max-budget-usd`'s: a fact about how this app spawns agents, not an
 * operator preference. `metering.md`'s rule against numeric ceilings in
 * `DEFAULTS` points the same way — an operator has no way to pick this number,
 * because the thing it trades is invisible to them.
 *
 * 200k of the 1M the CLI accepts. The floor it will take is 100k, which is also
 * where its own thrash breaker becomes reachable, so this leaves that far off
 * while still sitting below the 100-turn mark where the re-read bill
 * concentrates. **The sign of the saving is not yet measured** — compaction
 * flips whatever the agent re-fetches afterwards from cache reads at 0.1x to
 * cache writes at 1.25-2x, and no session in the corpus this was chosen from
 * had ever compacted. See the verification issue before moving it.
 */
const AUTOCOMPACT_WINDOW_TOKENS = 200_000;

const DELEGATION_NOTICE =
  "Prefer to hand self-contained investigation to a sub-agent rather than " +
  "doing it on this thread: anything where you want the conclusion and not the " +
  "files it was read out of — finding where something is implemented, reading " +
  "across several modules to answer one question, checking whether a pattern " +
  "holds everywhere. Nothing shrinks this conversation once it has grown, so " +
  "every file you read here is read again on every later turn of this run, " +
  "while a sub-agent's context is discarded when it answers. Delegate work you " +
  "expect to take more than a handful of steps; below that a sub-agent's own " +
  "start-up costs more than the thread saves, so do short lookups yourself.";

export function buildArgs(opts: {
  prompt: string;
  model: string | null;
  permissionMode: PermissionMode;
  resumeSessionId: string | null;
  /** A run with its own checkout and branch, which is told to commit to it. */
  isolated: boolean;
  /**
   * This run's own spending limit, and what it has already spent against it.
   *
   * Together they become `--max-budget-usd`, which is the only thing that
   * bounds what *one work cycle* may spend. Everything else about
   * `maxRunCostUSD` is read between cycles, so a run at $34.99 of a $35 limit
   * used to be authorised for one more cycle of any size at all — the guard
   * bounded the number of cycles that may start past the threshold and nothing
   * bounded the amount the one crossing it spent. Concurrency multiplies that:
   * twenty-five runs whose settings page reads $875 had no upper bound this
   * app enforced.
   *
   * The arithmetic is here rather than at the call site because both ways of
   * getting it wrong are silent. `spentGuardUSD` is the *guard* figure — the
   * same `spentUSD + spentEstUSD` the pre-cycle check compares, never
   * `runs.spent_usd` alone, which is a floor of what the CLI itself measured
   * and excludes a killed cycle's reconciled estimate. Handing over a ceiling
   * derived from the floor would give the child more room than the guard
   * believes the run has left, which is the display-versus-guard split
   * inverted at the one door where it costs money.
   *
   * `Math.max(0, …)` cannot be reached today — the pre-cycle guard blocks at
   * `>=`, so the remainder is strictly positive by the time anything is
   * spawned — and it stays because a negative would be a *widening*: the CLI
   * would take it as no ceiling at all, or reject the argv, and both fail
   * towards spending.
   */
  maxRunCostUSD: number | null;
  spentGuardUSD: number;
  /**
   * The agent this run **is**, or null for an ordinary run.
   *
   * This used to be a list, offered to the run's own main thread as specialists
   * it might delegate to (`--agents` alone). It is now the session's own agent:
   * `sessionAgentArgs` emits the definition *and* selects it by name, so the
   * saved prompt is what this run opens with rather than a role it may hand a
   * subtask to.
   *
   * **It bounds nothing, and the two measurements that make that true are worth
   * having in front of anyone editing this function.** The permission mode, the
   * isolation grant and the deny list below are unchanged by it, and the
   * appended system prompt still arrives — verified on the pin, because the
   * failure if it did not would be silent and expensive in both directions: an
   * isolated run whose preamble stopped arriving finishes `completed` on a
   * branch with no commits, and a run that never saw `SELF_HOSTING_NOTICE` is
   * one that has not been told why `pkill` is denied or what to do instead.
   * `--agent` also survives `--resume`, which is what makes it true of every
   * cycle rather than only the first.
   */
  agent?: AgentDefinition | null;
  /**
   * Forward what a delegated turn says into this run's own stream.
   *
   * Gated by the CLI on `--print` and `--output-format=stream-json`, which the
   * first line below supplies unconditionally, so this flag is never carried
   * into a spawn that would ignore it. What it changes is the *shape* of the
   * stream rather than what the run may do — see `settings.forwardSubAgentText`
   * for why that is worth a switch, and `handleStreamLine` for the one property
   * that makes the new shape safe.
   */
  forwardSubAgentText?: boolean;
  /**
   * Claude Code plugin directories to load, already proved inside a mount.
   *
   * Passed per cycle rather than once, and that is the property to preserve:
   * `--plugin-dir` is **not** restored by `--resume`, so a version of this that
   * only sent it on the opening cycle would leave every later cycle of the same
   * run without the plugins — silently, since a session missing a hook behaves
   * exactly like one that never had it. `buildArgs` already rebuilds the argv
   * per cycle, so the correct shape is the default one; the test beside it
   * asserts the flag survives a `resumeSessionId`.
   *
   * Optional so that the many call sites in the tests need not thread it, and
   * absent means no plugins rather than a default set — this is the list that
   * decides what code twenty-five unattended agents load, and it is not
   * something to acquire by omission.
   */
  pluginDirs?: readonly string[];
}): string[] {
  const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (opts.forwardSubAgentText) args.push("--forward-subagent-text");
  // One encoder for every spawn site, because every way of getting the shape
  // wrong is silent when a member is merely offered and fails the spawn outright
  // when it is selected — see `agentsFlagValue` and `sessionAgentArgs`. This
  // sits above `--allowedTools` and `--append-system-prompt` rather than below
  // for no reason but reading order; the CLI takes the flags in any order.
  args.push(...sessionAgentArgs(opts.agent));
  // Additive: `--allowedTools` names what skips the prompt, and everything else
  // still follows the mode. It is not the allowlist `chat.ts` runs under, where
  // `manual` mode is what makes the same flag exhaustive.
  //
  // One flag rather than two, and the git grant stays in front of the search
  // one: a second `--allowedTools` is a variadic option the CLI would read as a
  // replacement rather than an addition, and the order is what the assertions
  // beside this read. `SEARCH_TOOLS` is last because it is the entry that is
  // always there.
  args.push(
    "--allowedTools",
    ...(opts.isolated ? ISOLATED_GIT_TOOLS : []),
    ...SEARCH_TOOLS,
  );
  // Unconditional, and deliberately not paired with the isolation flag above:
  // a run in the operator's own checkout is inside the same process as one in a
  // worktree, and the kill does not care which.
  args.push("--disallowedTools", ...PROCESS_KILLERS);
  // One flag carrying both notices, for the reason `--allowedTools` carries
  // both its lists: a second `--append-system-prompt` is a replacement, not an
  // addition, and losing one of the two would be silent.
  args.push(
    "--append-system-prompt",
    `${SELF_HOSTING_NOTICE}\n\n${DELEGATION_NOTICE}`,
  );
  // Above `--resume` only for reading order. What matters is that it is here at
  // all on a resumed cycle: see `pluginDirs`.
  args.push(...pluginDirArgs(opts.pluginDirs ?? []));
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  // A ceiling on the conversation the CLI carries forward. Not a guard: it
  // produces no `BudgetVerdict`, ends nothing, and sits in none of the check
  // orders `budget.ts` maintains — what it does is let the CLI compact a run's
  // own context instead of carrying every token to the end of the run.
  //
  // Auto-compaction is already on and already re-checked at every turn start;
  // its default window is sized for a million-token model, so across 1,011
  // transcripts it never once fired. That is what makes cache re-read 59% of
  // this workload: nothing ever resets a prefix, and 11% of sessions — the ones
  // past 100 turns — carry 58% of the re-read bill.
  //
  // Per cycle for the same reason `--plugin-dir` is: `--resume` does not
  // restore it, and a later cycle running under the default window behaves
  // exactly like one that was never given a ceiling.
  args.push("--autocompact", String(AUTOCOMPACT_WINDOW_TOKENS));
  // A hard stop inside the CLI, the same mechanism a chat turn and an
  // orchestrator block already carry — and the only one that can bound the
  // cycle that crosses the threshold rather than the one after it. Per
  // invocation, so a resumed session is bounded by what is left *now* rather
  // than by what the conversation has cost since it opened.
  if (opts.maxRunCostUSD !== null) {
    const remaining = Math.max(0, opts.maxRunCostUSD - opts.spentGuardUSD);
    args.push("--max-budget-usd", String(remaining));
  }
  return args;
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
    const cost = Number(ev.total_cost_usd ?? 0);
    if (Number.isFinite(cost)) acc.costUSD += cost;

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
): Promise<{ costUSD: number; tokens: number } | null> {
  if (!sessionId) return null;
  try {
    const { entries } = await scanUsage();
    const to = Date.now();
    let costUSD = 0;
    let tokens = 0;
    for (const e of entries as UsageEntry[]) {
      if (e.sessionId !== sessionId || e.ts < from || e.ts > to) continue;
      costUSD += e.costUSD;
      tokens += totalTokens(e.tokens);
    }
    return costUSD > 0 || tokens > 0 ? { costUSD, tokens } : null;
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
          spentGuardUSD: spentUSD + spentEstUSD,
          spentGuardTokens: spentTokens + spentEstTokens,
          startedAt,
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
      const spentGuardBeforeCycle = spentUSD + spentEstUSD;

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

      const args = buildArgs({
        prompt,
        model: run.model,
        permissionMode: budget.permissionMode ?? "acceptEdits",
        resumeSessionId: sessionId,
        pluginDirs: plugins.dirs,
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
              spentGuardUSD: spentUSD + spentEstUSD + inFlight.costUSD,
              spentGuardTokens: spentTokens + spentEstTokens + inFlight.tokens,
              startedAt,
            };
          },
        });
        startLiveTicker();
      }

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
      }

      cyclesThisSegment += 1;
      lastExit = res.exitCode;

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
      if (!res.sawResult) {
        const recovered = await reconcileKilledCycle(sessionId, cycleStartedAt);
        if (recovered) {
          spentEstUSD += recovered.costUSD;
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

      // Before the exit-code test, because a killed child closes with a null
      // code that reads as -1. Judging that as a crash would file every stop —
      // operator or guard — as a red `failed` run.
      const postCycle = interrupts.get(id);
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

        stopReason =
          plan.cause === "pauses-spent"
            ? // Named as attempts rather than as the wall, because those are
              // different facts and the operator's next move differs. The
              // allowance may well have refilled by now; what has run out is
              // how often one run may wait for it without anybody looking.
              `Claude refused the work cycle for want of allowance again, after this run had already waited out ${MAX_PAUSES_PER_RUN} windows. Out of waits rather than out of allowance: ${refusal}`
            : plan.cause === "retries-spent"
              ? // Reached only with the retries spent, so say that rather than
                // reporting the last attempt as if it were the only one.
                `Claude Code hit a transient API error on ${
                  MAX_TRANSIENT_RETRIES + 1
                } attempts in a row: ${refusal}`
              : plan.cause === "rate-limited"
                ? // A different sentence from the one above, because the
                  // operator's response is the opposite. An upstream that is
                  // down clears on its own and waiting is right; a rate limit
                  // at this concurrency is the account describing how much of
                  // it this app is using, and waiting changes nothing that
                  // lowering the cap would not change faster.
                  `Claude Code was rate limited on ${
                    MAX_RATE_LIMIT_RETRIES + 1
                  } attempts in a row, over ${Math.round(
                    RATE_LIMIT_BACKOFF_MS.reduce((a, b) => a + b, 0) / 60_000,
                  )} minutes or more of backing off. This is the account refusing this app's own request rate rather than being unreachable, so lower the concurrent-run limit rather than waiting: ${refusal}`
                : `Claude Code refused the request: ${refusal}`;
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
        const looksLikeResumeFailure =
          usedResume &&
          cyclesThisSegment === 1 &&
          !res.sawResult &&
          res.finalText === "";
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

function startLiveTicker(): void {
  if (timers.live) return;
  // Read once at start. A change to the setting takes effect the next time the
  // ticker stops and starts, which is at the end of the last live cycle.
  const seconds = Math.max(15, getSettings().liveGuardIntervalSeconds);
  timers.live = setInterval(() => void liveGuardTick(), seconds * 1000);
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
    if (liveGuards.size === 0) {
      stopLiveTicker();
      return;
    }
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
 * one owner of FIFO order, the folder claim and the concurrency cap — and
 * because `maxConcurrentRuns` ships as `null`, so on a stock install nothing
 * downstream bounds the wave at all. A run over the cap simply stays `paused`
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
 * change.
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
 */
export async function shutdownRuns(
  sig: NodeJS.Signals,
): Promise<{ signalled: number; closed: number; recovered: number }> {
  shutdown.active = true;

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
