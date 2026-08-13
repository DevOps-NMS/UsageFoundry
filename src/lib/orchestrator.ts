import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  CLAUDE_BIN,
  GITHUB_TOKEN,
  OTLP_SELF_URL,
  WORKSPACE_MOUNTS,
  mountById,
  type WorkspaceMount,
} from "./config";
import { git, gitSync } from "./git";
import { db } from "./db";
import { getSettings, limitConfig, type PermissionMode } from "./settings";
import {
  type BudgetPolicy,
  type BudgetStopCode,
  type BudgetVerdict,
  type RunProgress,
  LIVE_ENFORCEABLE_CODES,
  RESUME_MARGIN_MS,
  evaluateBudget,
  normalizePolicy,
} from "./budget";
import { scanUsage, type UsageEntry } from "./transcripts";
import { totalTokens } from "./pricing";
import { buildSnapshot, type UsageSnapshot } from "./windows";
import { planUsage } from "./planUsage";
import { telemetrySpendSince, type TelemetrySpend } from "./otlp";
import type { RunDependencyDTO } from "./apiTypes";

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
}

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
    | "assistant"
    | "tool"
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
 */
interface Interrupt {
  kind: "operator" | "guard";
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
}

function log(runId: string, message: string, extra: Record<string, unknown> = {}) {
  emit({ runId, ts: Date.now(), kind: "log", payload: { message, ...extra } });
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
 * How many transient failures **in a row** one run may retry.
 *
 * Counted consecutively and reset by any cycle that gets through, so a long
 * run that meets one blip an hour is never terminated by the total, while an
 * upstream that is actually down ends the run inside ~85 seconds and says so.
 * Held in `startRun`'s own frame rather than on the row, like `resumeRetried`
 * and unlike `pause_count`: a restart hours later is not "in a row".
 */
export const MAX_TRANSIENT_RETRIES = TRANSIENT_BACKOFF_MS.length;

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
 */
export function refusalResumeAt(o: {
  boundary: number | null;
  pauseCount: number;
  now: number;
}): number {
  const backoff =
    REFUSAL_BACKOFF_MS[Math.min(o.pauseCount, REFUSAL_BACKOFF_MS.length - 1)];
  const target =
    o.boundary !== null && o.boundary > o.now
      ? o.boundary + RESUME_MARGIN_MS
      : o.now + backoff;
  return Math.min(
    Math.max(target, o.now + MIN_REFUSAL_WAIT_MS),
    o.now + MAX_REFUSAL_WAIT_MS,
  );
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
 * A continuation that cannot be honoured **throws**. Everything else here
 * degrades to `mode: "none"` with a reason, which is right for a run that
 * merely asked for a checkout: it still does the work the operator asked for,
 * in the folder, serialised. A continuation degraded that way would silently do
 * something else entirely — start from the target branch with the predecessor's
 * commits nowhere in sight, which is the exact failure this mode exists to
 * prevent. So it is a sentence and a refusal, never a downgrade.
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
      return { mode: "none", reason: slotExhaustionReason(o.probe.repoRoot) };
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
    // Not `slotExhaustionReason`, which ends "so this run works in the folder
    // directly and waits its turn" — the sentence for a downgrade, and this is
    // not one. Working in the folder would put the run on the target branch.
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

/** Path-safe, collision-free name for a directory. Separators become dashes. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
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

/** Where a repo's isolated checkouts live: a hidden sibling inside the mount. */
function worktreeStore(repoRoot: string): string | null {
  const { mountId } = describeFolder(repoRoot);
  const mount = mountId ? mountById(mountId) : null;
  if (!mount) return null;
  // Dotfile-prefixed so `/api/folders` never offers a checkout as a run target,
  // and outside the repo so it cannot show up in `git status` or be swept into
  // a commit as a gitlink.
  return path.join(realMountPath(mount), ".uf-worktrees");
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
  if (!storeStat) fs.mkdirSync(store, { recursive: true });

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
  const slug = slugify(describeFolder(repoRoot).relPath || path.basename(repoRoot));
  return path.join(store, `${slug}-${slugify(suffix)}`);
}

/** True when a checkout exists and has work in it that must not be clobbered. */
function slotIsDirty(slotPath: string): boolean {
  if (!fs.existsSync(slotPath)) return false;
  const st = gitSync(slotPath, ["status", "--porcelain"]);
  // Unreadable counts as dirty: refusing to reuse is the recoverable mistake.
  return !st.ok || st.stdout !== "";
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
    if (!add.ok) throw new Error(`Could not create a checkout: ${add.stderr}`);
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
    if (!add.ok) throw new Error(`Could not create a checkout: ${add.stderr}`);
  }

  const copied = seedWorktree(repoRoot, slotPath);
  log(
    run.id,
    (continuing
      ? `Working in an isolated checkout, carrying on run ${shortId(run.continues_run!)}'s branch ${branch}`
      : `Working in an isolated checkout on branch ${branch}`) +
      (copied.length ? ` (copied ${copied.join(", ")})` : ""),
    { worktree: slotPath, branch, ...(continuing ? { continuesRun: run.continues_run } : {}) },
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

/** Match a filename against the settings glob list; later patterns win. */
export function matchesCopyGlobs(name: string, globs: string[]): boolean {
  let hit = false;
  for (const raw of globs) {
    const negate = raw.startsWith("!");
    const pattern = negate ? raw.slice(1) : raw;
    // `?` is a glob wildcard and has to be *translated*, not merely escaped:
    // left alone it reached the regex meaning "the previous token is optional",
    // so `.env?` matched `.env` and rejected `.envx` — the opposite of both.
    // Both wildcards are decided in the same pass that escapes everything else,
    // because a second sweep rewriting `\?` would also catch a literal
    // backslash standing in front of one.
    const source = pattern.replace(/[.+^${}()|[\]\\?*]/g, (c) =>
      c === "*" ? ".*" : c === "?" ? "." : `\\${c}`,
    );
    if (new RegExp(`^${source}$`).test(name)) hit = !negate;
  }
  return hit;
}

/**
 * Copy the gitignored files an agent needs to run anything at all.
 *
 * Top level only, and only files. A checkout carries committed work, so the
 * environment file that every command depends on is exactly what is missing;
 * dependency trees and build output are left for the agent to regenerate.
 */
function seedWorktree(repoRoot: string, slotPath: string): string[] {
  const globs = getSettings().isolationCopyGlobs;
  const copied: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return copied;
  }

  for (const e of entries) {
    if (!e.isFile() || !matchesCopyGlobs(e.name, globs)) continue;
    const target = path.join(slotPath, e.name);
    if (fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(path.join(repoRoot, e.name), target);
      copied.push(e.name);
    } catch {
      /* a file we cannot read is not worth failing the run over */
    }
  }
  return copied;
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
  budget: unknown;
  /**
   * Runs that must settle before this one starts, each with the condition it
   * must settle under. Absent or empty means it starts as soon as its folder is
   * free, which is every run that existed before this option did.
   */
  dependsOn?: RunDependencyInput[];
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

/** Lowest checkout slot for this repo that no live run already holds. */
function allocateSlotPath(repoRoot: string): string | null {
  const store = worktreeStore(repoRoot);
  if (!store) return null;

  // Named from the repository's path within its mount, not its basename. The
  // folder listing is built for `org/repo` layouts, so two repos called `api`
  // in one workspace is ordinary — and since the store is shared per mount and
  // allocation is deterministic, a basename collision would hand them the same
  // directory and break isolation for the second one permanently.
  const slug = slugify(describeFolder(repoRoot).relPath || path.basename(repoRoot));
  const taken = new Set(
    activeRuns()
      .map((r) => r.worktree_path)
      .filter((p): p is string => !!p),
  );

  for (let slot = 1; slot <= 64; slot++) {
    const candidate = path.join(store, `${slug}-${slot}`);
    // Skip a slot left dirty by an earlier run: reusing it would either destroy
    // that work or fail at setup. Taking the next number keeps the new run
    // moving and leaves the old one recoverable.
    if (!taken.has(candidate) && !slotIsDirty(candidate)) return candidate;
  }
  return null;
}

/** Directory the operator has to deal with when checkouts stop being reusable. */
function slotExhaustionReason(repoRoot: string): string {
  const store = worktreeStore(repoRoot);
  return (
    "Every isolated checkout for this repository still holds uncommitted work, " +
    `so this run works in the folder directly and waits its turn. Commit or delete what is left in ${store ?? ".uf-worktrees"} to get parallel runs back.`
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

  const plan = resolveIsolation({
    runId: id,
    isolate,
    probe,
    continueFrom: continueFrom ? continuedBranchOf(continueFrom) : null,
    inheritedSlot,
    // Not allocated for a continuation that already has its slot: allocation is
    // a claim, and claiming a second checkout it will not use would take one
    // out of circulation for every other run on the repository.
    freeSlot: repoRoot && !inheritedSlot ? allocateSlotPath(repoRoot) : null,
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
      const rival = db()
        .prepare(
          `SELECT id, status FROM runs
            WHERE continues_run = ?
              AND (iterations > 0 OR status NOT IN ('completed','stopped','failed','blocked'))
            LIMIT 1`,
        )
        .get(runId) as { id: string; status: RunStatus } | undefined;
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
  const folder = resolveWorkspaceFolder(input.folder, input.mountId);
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) throw new Error("Prompt is required");

  const policy = normalizePolicy(input.budget);
  const settings = getSettings();
  const id = randomUUID();
  const now = Date.now();

  const budgetBlob = JSON.stringify({
    ...policy,
    permissionMode: input.permissionMode ?? settings.defaultPermissionMode,
  });

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
            continues_run)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
): string[] {
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
  const cap = getSettings().maxConcurrentRuns;
  for (const id of selectPromotable(activeRuns(), cap)) {
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

  const { release, block } = releasableRuns(states, links);
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
  if (candidates.length === 0) return 0;

  const links = db()
    .prepare("SELECT run_id AS runId, depends_on AS dependsOn, edge FROM run_deps")
    .all() as DependencyLink[];

  const woken = revivableDependents(roots, candidates, links);
  let n = 0;
  for (const id of woken) {
    const done = db()
      .prepare(
        "UPDATE runs SET status='waiting', finished_at=NULL, stop_reason=NULL" +
          " WHERE id=? AND status='blocked'",
      )
      .run(id);
    if (done.changes !== 1) continue;
    n += 1;
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
  return n;
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
   * Whether the CLI's terminal `result` event arrived. Cost and tokens come
   * only from that event, so when it is missing — operator stop, crash, OOM —
   * this iteration contributes $0 to the run's totals despite having burned
   * real tokens. The run reports that rather than presenting the understated
   * figure as fact.
   */
  sawResult: boolean;
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
}): string {
  if (o.sessionId === null) {
    return [
      o.isolationPreamble,
      // Ahead of the prior-work notice, and both can apply: this one is about
      // the branch's whole history, that one about this run's own earlier
      // attempt at the task. Read in the other order the agent meets "carry on
      // from where you stopped" before it has been told the work is not its own.
      o.continuedFrom ? continuedWorkNotice(o.continuedFrom, o.continuedWork) : null,
      o.priorCycles > 0 ? priorWorkNotice(o.priorCycles, o.worktreeBranch) : null,
      o.task,
      o.followUp,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
  }
  if (o.followUp) return o.followUp;
  return o.justRetriggered ? o.donePushback : o.continuation;
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
 * told to infer it — `git diff <base>...HEAD` is the chain's whole change, the
 * same range the run page's diff and any review are measured over, which is
 * what keeps the agent, the reviewer and the merge looking at one thing.
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
    `    git diff ${range}...HEAD\n\n` +
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
 * Withheld by name because there is no ownership boundary to withhold it by:
 * compose runs a single uid, so an agent and the server supervising it can
 * signal each other freely, and the container has neither a docker socket nor
 * a docker CLI — this is the only route from an agent to a restart, and it does
 * not look like one from the agent's side.
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
 * warning about an absent command is how an agent learns to look for it.
 */
const SELF_HOSTING_NOTICE =
  "You are running inside a long-lived server process that is also supervising " +
  "other agents. Ending it ends every run in flight, including your own, and " +
  "nothing you have not committed survives. `pkill` and `killall` are therefore " +
  "unavailable to you. To stop a background process you started, record its pid " +
  "(`cmd & pid=$!`) and use `kill \"$pid\"`; a dev server usually forks a child, " +
  "so `kill $(pgrep -P \"$pid\") \"$pid\"` or start it under `setsid` and use " +
  "`kill -- -$pid`. If you no longer have the pid, select on something unique to " +
  "the process you started — the port you chose, e.g. `kill $(pgrep -f 3100)` — " +
  "and never on `next-server`, `next dev` or `node`: this server's process title " +
  "is `next-server`, which is also the title your own dev server takes, so a " +
  "match on it cannot tell the two apart.";

export function buildArgs(opts: {
  prompt: string;
  model: string | null;
  permissionMode: PermissionMode;
  resumeSessionId: string | null;
  /** A run with its own checkout and branch, which is told to commit to it. */
  isolated: boolean;
}): string[] {
  const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  // Additive: `--allowedTools` names what skips the prompt, and everything else
  // still follows the mode. It is not the allowlist `chat.ts` runs under, where
  // `manual` mode is what makes the same flag exhaustive.
  if (opts.isolated) args.push("--allowedTools", ...ISOLATED_GIT_TOOLS);
  // Unconditional, and deliberately not paired with the isolation flag above:
  // a run in the operator's own checkout is inside the same process as one in a
  // worktree, and the kill does not care which.
  args.push("--disallowedTools", ...PROCESS_KILLERS);
  args.push("--append-system-prompt", SELF_HOSTING_NOTICE);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  return args;
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
      key === "DATA_DIR"
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
 * When `UF_AUTH_TOKEN` is set the exporter authenticates like any other
 * client, which is why `middleware.ts` needs no exemption for the ingest path.
 */
function telemetryEnv(runId: string, required = false): Record<string, string> {
  if (!required && !getSettings().telemetryForRuns) return {};

  const headers: Record<string, string> = process.env.UF_AUTH_TOKEN
    ? {
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${process.env.UF_AUTH_TOKEN}`,
      }
    : {};

  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_SELF_URL,
    // Well under the default 5s, so a killed iteration loses less of its
    // final batch. It cannot be eliminated: a SIGKILL flushes nothing.
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
    // Stamped onto every record so a request can be attributed to this run.
    // Interactive sessions carry no such attribute and stay unattributed.
    OTEL_RESOURCE_ATTRIBUTES: `uf.run_id=${runId}`,
    ...headers,
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
 * nothing to authenticate. Same for `gitEnv()` in `git.ts`, whose children run
 * repository-controlled hooks.
 *
 * `token` is a parameter so the function is pure and testable; production
 * always uses the process-level value.
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
 */
function runIteration(
  runId: string,
  cwd: string,
  args: string[],
  telemetryRequired: boolean,
  onSession: (sessionId: string) => void,
): Promise<IterationResult> {
  return new Promise((resolve) => {
    // No shell: arguments are passed as an array, so a prompt containing
    // quotes, backticks, or semicolons is inert rather than interpreted.
    const child: AgentProcess = spawn(CLAUDE_BIN, args, {
      cwd,
      env: childEnv({ ...telemetryEnv(runId, telemetryRequired), ...githubEnv() }),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a kill reaches the builds, test runners and
      // servers the agent started. Those are what actually hold the working
      // tree; a signal aimed at the CLI alone leaves them running and writing
      // into a directory this run is about to resume into or hand off. Windows
      // has no process groups to signal, and `process.kill(-pid)` throws there.
      detached: getSettings().killProcessGroup && process.platform !== "win32",
    });

    procs.set(runId, child);

    const result: IterationResult = {
      exitCode: -1,
      costUSD: 0,
      tokens: 0,
      sessionId: null,
      finalText: "",
      isError: false,
      sawResult: false,
      apiError: null,
      stderrTail: "",
    };

    let stdoutBuf = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
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
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
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
      | { content?: unknown[]; model?: unknown }
      | undefined;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    // Claude Code writes provider refusals — not logged in, credit exhausted,
    // usage limit reached — as an assistant turn attributed to `<synthetic>`
    // rather than to a model. Recorded on first sight only: `finalText` is
    // last-write-wins by design, so any later text would otherwise erase the
    // one message that says why the cycle ended.
    const synthetic = message?.model === "<synthetic>";
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b.type === "text" && typeof b.text === "string") {
        acc.finalText = b.text;
        if (synthetic && acc.apiError === null) acc.apiError = b.text;
        emit({
          runId,
          ts: Date.now(),
          kind: "assistant",
          payload: { text: b.text },
        });
      } else if (b.type === "tool_use") {
        emit({
          runId,
          ts: Date.now(),
          kind: "tool",
          payload: { name: b.name, input: b.input },
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
    emit({
      runId,
      ts: Date.now(),
      kind: "log",
      payload: { message: `system:${ev.subtype ?? ""}`, raw: ev },
    });
  }
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

/**
 * A fresh read of the transcripts, as the guard sees it.
 *
 * Exported because a review spawn is billed against the same 5-hour window a
 * work cycle is, and refusing one while that window is already over its ceiling
 * has to use the same numbers the loop does — not a second, subtly different
 * reading of them.
 */
export async function currentSnapshot() {
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
    stopReason = it.reason;
    finalStatus = it.pause ? "paused" : "stopped";
    pausedUntil = it.pause ? (it.resumeAt ?? null) : null;
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

    for (;;) {
      const preScan = interrupts.get(id);
      if (preScan) {
        applyInterrupt(preScan);
        break;
      }

      const snapshot = await currentSnapshot();
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
          meters: verdict.meters,
          weeklyFraction: snapshot.weekly.fraction,
          sessionFraction: snapshot.session.fraction,
        },
      });

      if (!verdict.allowed) {
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

      const args = buildArgs({
        prompt,
        model: run.model,
        permissionMode: budget.permissionMode ?? "acceptEdits",
        resumeSessionId: sessionId,
        isolated: run.isolation === "worktree",
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
        res = await runIteration(id, workDir, args, liveSpendTelemetry, (sid) => {
          // A resume that comes back under a different id is recorded rather
          // than treated as a failure: which of the two Claude Code reports for
          // a `--resume` is its business, and this app has never observed it
          // against a real CLI. What is not acceptable is adopting it silently
          // — every later cycle resumes whatever landed here, and a run that
          // quietly changed conversation looks, from outside, exactly like one
          // that restarted.
          if (resumeTarget && sid !== resumeTarget && sessionId === resumeTarget) {
            log(
              id,
              `This work cycle asked to resume session ${resumeTarget}, and Claude Code reported session ${sid}. Later cycles will continue ${sid}.`,
            );
          }
          adoptSession(sid);
        });
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
        const limited = isUsageLimit(refusal);
        const canWait =
          limited &&
          policy.enforcement === "live-resume" &&
          (run.pause_count ?? 0) < MAX_PAUSES_PER_RUN;
        // A dropped connection is neither the wall nor the agent's doing, and
        // it clears in seconds — so it is retried here rather than parked or
        // reported as a failure. Tested after `limited` because an exhausted
        // allowance is not something backing off five seconds can fix.
        const retryable = !limited && isTransientApiError(refusal);
        const retrying = retryable && transientRetries < MAX_TRANSIENT_RETRIES;
        const backoff = TRANSIENT_BACKOFF_MS[transientRetries];

        emit({
          runId: id,
          ts: Date.now(),
          kind: "error",
          payload: {
            // The log line renders `message`, and this event had none — so the
            // one entry that says why a run died read `✗ undefined`, with the
            // actual sentence only on the row's stop reason.
            message: retrying
              ? `${refusal} — retrying in ${Math.round(backoff / 1000)}s (${
                  transientRetries + 1
                } of ${MAX_TRANSIENT_RETRIES}).`
              : refusal,
            apiError: refusal,
            exitCode: res.exitCode,
            usageLimit: limited,
            waiting: canWait,
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

        if (canWait) {
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

        stopReason = limited
          ? `Claude refused the work cycle: ${refusal}`
          : retryable
            ? // Reached only with the retries spent, so say that rather than
              // reporting the last attempt as if it were the only one.
              `Claude Code hit a transient API error on ${
                MAX_TRANSIENT_RETRIES + 1
              } attempts in a row: ${refusal}`
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

      // Completion signal from the continuation protocol. Recorded even when it
      // is absent, because "the agent said the task was finished" is the only
      // thing that separates a `completed` run from one that simply ran out of
      // work cycles below, and the answer is gone by the time the run is picked
      // up again.
      reportedDone = /^\s*DONE\s*$/m.test(res.finalText);
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
  } catch {
    /* a failed scan must not kill the ticker; the next tick retries */
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
 */
async function sweepPaused(): Promise<void> {
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

    const due = paused.filter(
      (r) => r.resume_at === null || Date.now() >= r.resume_at,
    );
    if (due.length === 0) return; // nothing to decide, so no scan

    const snapshot = await currentSnapshot();
    const now = Date.now();
    let freed = false;

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

      if (verdict.allowed) {
        // Its window cleared, but a run admitted while it waited is in the
        // folder now. Stay `paused` rather than joining the queue: `paused` is
        // what the restart grace keys on, and `resume_at` is already in the
        // past, so the next sweep re-checks and flips the moment it is free.
        const holder = occupantOf(workDirOf(run), run.id, ["running"]);
        if (holder) {
          const waiting =
            "Its 5-hour window has cleared. Waiting for the folder, which a " +
            "run started while it waited now holds.";
          // Idempotent so the reason is corrected once rather than rewritten,
          // and logged once rather than every 60 seconds.
          const noted = db()
            .prepare(
              "UPDATE runs SET stop_reason=? WHERE id=? AND status='paused' AND stop_reason IS NOT ?",
            )
            .run(waiting, run.id, waiting);
          if (noted.changes === 1) log(run.id, waiting, { waitingFor: holder.id });
          continue;
        }

        // Re-queue rather than start directly: `promoteQueued` owns FIFO order,
        // folder reservation and the concurrency cap, and re-implementing any
        // of that here is how a folder claim gets broken. Ordering by
        // `created_at` means a resumed run keeps its original place in line.
        const flip = db()
          .prepare(
            "UPDATE runs SET status='queued', resume_at=NULL WHERE id=? AND status='paused'",
          )
          .run(run.id);
        if (flip.changes === 1) {
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
        continue;
      }

      if (verdict.disposition === "pause") {
        // Re-derived from the current snapshot, not carried over: the window
        // that will clear this run is not necessarily the one that closed it.
        db()
          .prepare(
            "UPDATE runs SET resume_at = ? WHERE id = ? AND status='paused'",
          )
          .run(verdict.resumeAt, run.id);
        continue;
      }

      // A guard that never clears — the clock, this run's own spend, the weekly
      // window — has caught up with a parked run. End it rather than leave it
      // holding a folder indefinitely for a resume that can never happen.
      setStatus(run.id, "stopped", {
        finished_at: now,
        stop_reason: verdict.reason,
        resume_at: null,
      });
      // A parked run that ends here is a settled dependency like any other.
      releaseDependents();
      freed = true;
    }

    if (freed) promoteQueued();
  } catch {
    /* a failed sweep must not kill the timer; the next one retries */
  } finally {
    timers.sweeping = false;
  }
}

export type ResumeOutcome = "requeued" | "not-paused";

/**
 * Put a parked run back in the queue now, rather than at its next wake.
 *
 * Deliberately does not bypass the guard: the ordinary pre-cycle check runs as
 * usual, so asking early while the 5-hour window is still full simply parks it
 * again. A button that spends past a limit the operator set would be worse than
 * no button.
 */
export function resumeRun(id: string): ResumeOutcome {
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
const REOPENABLE: readonly RunStatus[] = ["failed", "stopped", "completed"];

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
  /** The operator's own message, already trimmed. Wins over both. */
  note: string;
  donePushback: string;
}): string {
  if (o.note) return o.note;
  // Without a session there is nothing to push back against — `nextPrompt`
  // starts the original task over — so the substitution is dropped entirely.
  if (o.status === "completed" && o.reportedDone && o.sessionId) {
    return o.donePushback;
  }
  return "";
}

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
  const run = getRun(id);
  if (!run) return { ok: false, reason: "No such run." };

  // A run blocked behind a dependency is picked up by going back to `waiting`,
  // not by joining the queue: it never ran, so there is no session to continue
  // and — more to the point — no workspace, and `admitWaiting` is what plans
  // one. The two kinds of `blocked` are told apart by `work_dir`, never by the
  // reason text: this kind never reached a checkout, where a run refused by its
  // own guard before its first cycle already holds one.
  const waitingAgain = run.status === "blocked" && run.work_dir === null;
  if (!waitingAgain && !REOPENABLE.includes(run.status)) {
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
  });

  const flip = db()
    .prepare(
      `UPDATE runs SET status=?, budget=?, max_iterations=?, follow_up=?,
         started_at=NULL, finished_at=NULL, exit_code=NULL, stop_reason=NULL,
         resume_at=NULL WHERE id=? AND status=?`,
    )
    .run(
      waitingAgain ? "waiting" : "queued",
      blob,
      policy.maxIterations ?? 0,
      firstPrompt || null,
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
 */
export function killAllAgents(sig: NodeJS.Signals = "SIGTERM"): number {
  let n = 0;
  for (const child of procs.values()) {
    signalTree(child, sig);
    n += 1;
  }
  return n;
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
  const orphaned = db()
    .prepare("SELECT * FROM runs WHERE status = 'waiting'")
    .all() as RunRow[];

  const stale = activeRuns();
  if (stale.length === 0 && orphaned.length === 0) return;

  let closed = 0;
  let kept = 0;
  const graceMs = getSettings().resumeGraceHours * 3_600_000;

  for (const run of orphaned) {
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
      });
      closed += 1;
      continue;
    }

    if (run.status === "queued") {
      setStatus(run.id, "stopped", {
        finished_at: Date.now(),
        stop_reason: "The server restarted before this run started. Start it again.",
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
}
