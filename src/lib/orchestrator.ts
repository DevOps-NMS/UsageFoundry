import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  CLAUDE_BIN,
  GIT_BIN,
  OTLP_SELF_URL,
  WORKSPACE_MOUNTS,
  mountById,
  type WorkspaceMount,
} from "./config";
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
  /** Commit the worktree branched from, for the handoff diff range. */
  worktree_base: string | null;
  /** Paused runs: when to look again. A hint, not a promise — see sweepPaused. */
  resume_at: number | null;
  paused_at: number | null;
  pause_count: number;
  done_retriggers: number;
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
    | "error";
  payload: Record<string, unknown>;
}

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
 * `iterations` / `spentUSD` are current and the ticker needs no database read
 * and no second copy of the run's progress.
 */
interface LiveGuard {
  policy: BudgetPolicy;
  progress: () => RunProgress;
}

const liveGuards = ((globalThis as unknown as {
  __ufLiveGuards?: Map<string, LiveGuard>;
}).__ufLiveGuards ??= new Map<string, LiveGuard>());

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
  db()
    .prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
    )
    .run(e.runId, e.ts, e.kind, JSON.stringify(e.payload));
  bus.emit(e.runId, e);
  bus.emit("*", e);
}

function log(runId: string, message: string, extra: Record<string, unknown> = {}) {
  emit({ runId, ts: Date.now(), kind: "log", payload: { message, ...extra } });
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
): { events: Array<RunEvent & { id: number }>; dropped: number } {
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

export function subscribe(runId: string, fn: (e: RunEvent) => void): () => void {
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
 * An allowance refusal that only ever reached stderr.
 *
 * Deliberately narrower than the `<synthetic>` path: stderr carries build
 * noise, deprecation warnings and whatever the agent's own tooling printed, so
 * only a line that classifies as an allowance refusal is promoted to one.
 * Anything else stays an ordinary log line and the exit code decides, exactly
 * as it does today.
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
 * When a run refused for want of allowance should try again.
 *
 * `boundary` is the end of the window the refusal belongs to, as far as this
 * app can tell, or null when it cannot tell. Two things make it unreliable,
 * and both are why this is a backoff rather than a single computed instant:
 *
 * A derived boundary is early. `buildSessionBlocks` floors a block's start to
 * the hour, so a window opened at 14:47 is reported as ending at 19:00 rather
 * than 19:47 — up to an hour before the provider actually resets. Only an
 * operator-supplied `sessionResetOverrideAt` is exact.
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

/**
 * The second and last place this module spawns a process.
 *
 * Like the agent spawn below it, arguments go as an array and never through a
 * shell. The environment is scrubbed of this app's secrets because git runs
 * repository-controlled code: `core.fsmonitor` is a command git executes, and
 * `worktree add` fires the repo's `post-checkout` hook. `core.fsmonitor` is
 * cleared on every call for the same reason, and terminal prompting is disabled
 * because these children have no stdin — a credential prompt would hang until
 * the run's time limit.
 *
 * Synchronous on purpose: the admission decision in `createRun` has to stay
 * free of `await`, and these calls are single-digit milliseconds.
 */
interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of Object.keys(env)) {
    if (k.startsWith("ANTHROPIC_") || k.startsWith("UF_")) delete env[k];
  }
  return env;
}

/**
 * `core.fsmonitor` is a command git runs, so it is cleared on every call.
 *
 * `safe.directory` is waived for the same reason the image waives it: a
 * bind-mounted repository carries the host's uid, which need not be this
 * process's, and git's refusal is indistinguishable from "not a repository" by
 * the time `probeIsolation` sees it. The check it disables guards against
 * repositories reached by surprise on a shared host; every path that gets here
 * has already been proved to sit inside a configured mount by `resolveInMount`.
 */
const gitArgs = (args: string[]) => [
  "-c",
  "core.fsmonitor=",
  "-c",
  "safe.directory=*",
  ...args,
];

function gitSync(cwd: string, args: string[]): GitResult {
  const res = spawnSync(GIT_BIN, gitArgs(args), {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  });

  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

/**
 * Async twin of `gitSync`, for everything outside the admission decision.
 *
 * `worktree add` is a full checkout — minutes on a large repository — and the
 * synchronous form would hold the event loop for all of it, stalling every
 * other run's event stream and every poll in every open tab. Only `createRun`
 * needs the sync version, and only because its atomicity depends on running
 * without a yield point.
 */
function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn(GIT_BIN, gitArgs(args), {
      cwd,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();

    const finish = (ok: boolean) => {
      clearTimeout(timer);
      resolve({ ok, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

export interface IsolationPlan {
  mode: "worktree" | "none";
  /** Why isolation was not used. Surfaced so a silent downgrade is impossible. */
  reason?: string;
  repoRoot?: string;
  base?: string;
  worktreePath?: string;
  branch?: string;
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

  return { mode: "worktree", repoRoot, base: head.stdout };
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
 */
async function ensureWorktree(run: RunRow): Promise<string> {
  const repoRoot = run.repo_root!;
  const slotPath = run.worktree_path!;
  const branch = run.worktree_branch!;
  const base = run.worktree_base ?? "HEAD";

  const store = worktreeStore(repoRoot);
  if (!store) throw new Error("Workspace mount for this repository is gone.");

  // Validate the store *before* git writes into it. A symlinked .uf-worktrees
  // would put a full checkout wherever it points, and checking afterwards is
  // checking too late.
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

  // Drop registrations for checkouts that were deleted from disk, so a stale
  // entry does not make `worktree add` refuse a path that is actually free.
  await git(repoRoot, ["worktree", "prune"]);

  const registered = (await git(repoRoot, ["worktree", "list", "--porcelain"]))
    .stdout.split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));

  if (registered.includes(slotPath)) {
    const head = await git(slotPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    // Already this run's own checkout, on its own branch, holding its commits —
    // it is coming back from a pause. Adopt it exactly as it stands: `checkout
    // -b` would fail on an existing branch, the dirty check below would reject
    // work in progress the agent legitimately left, and re-seeding would
    // overwrite files it has since edited.
    if (head.ok && head.stdout === branch) {
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
    const co = await git(slotPath, ["checkout", "-b", branch, base]);
    if (!co.ok) throw new Error(`Could not start branch ${branch}: ${co.stderr}`);
  } else if (run.iterations > 0) {
    // A resuming run whose checkout has been removed from under it. Creating a
    // fresh one would silently orphan every commit it already made, so name the
    // branch and stop — the work is still in the repository.
    throw new Error(
      `The isolated checkout for this run is gone, but its work is still on branch ${branch}. ` +
        `Inspect it with: git log ${branch}`,
    );
  } else {
    // No timeout worth enforcing: this is a full checkout, and a big repository
    // legitimately takes minutes.
    const add = await git(
      repoRoot,
      ["worktree", "add", "-b", branch, slotPath, base],
      30 * 60_000,
    );
    if (!add.ok) throw new Error(`Could not create a checkout: ${add.stderr}`);
  }

  const copied = seedWorktree(repoRoot, slotPath);
  log(
    run.id,
    `Working in an isolated checkout on branch ${branch}` +
      (copied.length ? ` (copied ${copied.join(", ")})` : ""),
    { worktree: slotPath, branch },
  );

  return slotPath;
}

/** Match a filename against the settings glob list; later patterns win. */
function matchesCopyGlobs(name: string, globs: string[]): boolean {
  let hit = false;
  for (const raw of globs) {
    const negate = raw.startsWith("!");
    const pattern = negate ? raw.slice(1) : raw;
    const re = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );
    if (re.test(name)) hit = !negate;
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
  const leftover = (await git(workDir, ["status", "--porcelain"])).stdout;

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
      uncommitted: leftover ? leftover.split("\n") : [],
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
}

/**
 * Runs holding, or waiting to hold, a place on disk.
 *
 * `paused` belongs here: a parked run resumes into the same worktree, on the
 * same branch, carrying its own commits, so it keeps its claim for as long as
 * it waits. Letting a second agent into that directory in the meantime is
 * exactly the collision the claim exists to prevent — even though the parked
 * run has no process and is spending nothing.
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
 */
function occupantOf(dir: string, exclude?: string): RunRow | null {
  const key = conflictKey(dir);
  for (const run of activeRuns()) {
    if (run.id === exclude) continue;
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
 * Admit a run, or park it behind whatever is already in its folder.
 *
 * Everything from here to the INSERT is synchronous — `resolveWorkspaceFolder`,
 * `probeIsolation`, and the occupancy scan are all sync syscalls or sync SQLite
 * — and that is what makes the check-then-insert atomic: one Node event-loop
 * turn runs to completion, so no second request can interleave between deciding
 * a folder is free and recording that this run took it. **Introducing a single
 * `await` in this path silently reintroduces two agents in one directory.** The
 * transaction wrapper does not provide that guarantee (better-sqlite3 is
 * synchronous either way); it is there so the property survives a refactor that
 * adds a second statement.
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

  // An isolated run gets its own subtree, so it contends with nothing but a run
  // started on the workspace root — which does contain the checkout store, and
  // correctly blocks.
  let plan: IsolationPlan = { mode: "none" };
  if (input.isolate !== false) {
    plan = probeIsolation(folder);
    if (plan.mode === "worktree" && plan.repoRoot) {
      const slotPath = allocateSlotPath(plan.repoRoot);
      if (!slotPath) {
        plan = { mode: "none", reason: slotExhaustionReason(plan.repoRoot) };
      } else {
        plan.worktreePath = slotPath;
        // Per run, not per slot: a slot is reused by later runs, and a reused
        // branch name would move the ref off the previous run's commits.
        plan.branch = `uf/${path.basename(slotPath)}-${id.slice(0, 8)}`;
      }
    }
  } else {
    plan = { mode: "none", reason: "Isolation was turned off for this run." };
  }

  const workDir =
    plan.mode === "worktree" && plan.worktreePath ? plan.worktreePath : folder;

  const run = db().transaction((): RunRow => {
    const busy = occupantOf(workDir);

    db()
      .prepare(
        `INSERT INTO runs
           (id, folder, prompt, model, status, budget, max_iterations, iterations, created_at, spent_usd, spent_tokens,
            work_dir, isolation, repo_root, worktree_path, worktree_branch, worktree_base)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        folder,
        prompt,
        input.model ?? settings.defaultModel,
        budgetBlob,
        // 0 is the stored sentinel for "no cap" — see the schema comment in
        // db.ts. The blob above is the source of truth; this column exists so
        // the list view does not have to parse it.
        policy.maxIterations ?? 0,
        now,
        workDir,
        plan.mode,
        plan.repoRoot ?? null,
        plan.worktreePath ?? null,
        plan.branch ?? null,
        plan.base ?? null,
      );

    emit({
      runId: id,
      ts: now,
      kind: "status",
      payload: {
        status: "queued",
        folder,
        prompt,
        isolation: plan.mode,
        ...(plan.reason ? { isolationReason: plan.reason } : {}),
        ...(busy ? { waitingFor: busy.id } : {}),
      },
    });

    if (plan.reason) log(id, plan.reason);
    if (busy) {
      log(
        id,
        `Waiting: ${describeFolder(workDirOf(busy)).relPath || "the workspace root"} is in use by an earlier run.`,
        { waitingFor: busy.id },
      );
    }

    return getRun(id)!;
  })();

  // Outside the transaction: promotion spawns, and a spawn inside a SQLite
  // transaction would hold the write lock for the life of the child.
  promoteQueued();
  return getRun(run.id)!;
}

/**
 * Start every queued run whose folder is free, oldest first.
 *
 * Strictly FIFO, and a run that cannot start still reserves its folder against
 * everything younger. Without that reservation a run on the workspace root —
 * which overlaps every folder under it — would be jumped by every small run
 * submitted after it and never start at all.
 */
export function promoteQueued(): void {
  const runs = activeRuns();
  const running = runs.filter((r) => r.status === "running");
  // Paused runs reserve their folder but are not counted as live below. The
  // asymmetry is deliberate and is the same one `queued` already has: the claim
  // is about what is on disk, the cap is about what is spending money. Counting
  // a parked run against a cap of 1 would starve every other run for hours.
  const holding = runs.filter(
    (r) => r.status === "running" || r.status === "paused",
  );
  const reserved: ConflictKey[] = holding.map((r) => conflictKey(workDirOf(r)));

  // The cap is enforced here rather than at admission, because here is the only
  // place a run actually starts costing anything. Over the cap a run waits its
  // turn instead of being refused — the queue already exists for exactly that.
  const cap = getSettings().maxConcurrentRuns;
  let live = running.length;

  for (const run of runs) {
    if (run.status !== "queued") continue;
    if (cap !== null && live >= cap) return;

    const key = conflictKey(workDirOf(run));
    // A run that cannot start still reserves its folder against everything
    // younger. Without that, a run on the whole workspace — which overlaps
    // every folder in it — is overtaken forever by smaller runs behind it.
    reserved.push(key);
    if (reserved.some((r) => r !== key && overlaps(key, r))) continue;

    live += 1;
    void startRun(run.id).catch(() => {
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

function buildArgs(opts: {
  prompt: string;
  model: string | null;
  permissionMode: PermissionMode;
  resumeSessionId: string | null;
}): string[] {
  const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
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
      key === "CLAUDE_CODE_ENABLE_TELEMETRY"
    ) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

/**
 * Telemetry variables for a run, or nothing when the setting is off.
 *
 * `childEnv` strips inherited `OTEL_*`, so these are the only ones that reach
 * the agent — telemetry routing is decided here or not at all. The base URL
 * carries no signal suffix because the CLI appends `/v1/logs` itself.
 *
 * When `UF_AUTH_TOKEN` is set the exporter authenticates like any other
 * client, which is why `middleware.ts` needs no exemption for the ingest path.
 */
function telemetryEnv(runId: string): Record<string, string> {
  if (!getSettings().telemetryForRuns) return {};

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
 * Signal the agent and everything it started.
 *
 * Falls back to signalling the process alone when the group is unavailable —
 * `detached` turned off, Windows, or a group that has already gone (ESRCH).
 */
function signalTree(child: AgentProcess, sig: NodeJS.Signals): void {
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

function runIteration(
  runId: string,
  cwd: string,
  args: string[],
): Promise<IterationResult> {
  return new Promise((resolve) => {
    // No shell: arguments are passed as an array, so a prompt containing
    // quotes, backticks, or semicolons is inert rather than interpreted.
    const child: AgentProcess = spawn(CLAUDE_BIN, args, {
      cwd,
      env: childEnv(telemetryEnv(runId)),
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
        if (line) handleStreamLine(runId, line, result);
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
      if (stdoutBuf.trim()) handleStreamLine(runId, stdoutBuf.trim(), result);
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

/** Interpret one line of Claude Code's `stream-json` output. */
function handleStreamLine(runId: string, line: string, acc: IterationResult) {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    log(runId, line, { stream: "stdout" });
    return;
  }

  const type = String(ev.type ?? "");

  if (typeof ev.session_id === "string") acc.sessionId = ev.session_id;

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

async function currentSnapshot() {
  const { entries } = await scanUsage();
  const settings = getSettings();
  const filtered = settings.includeSidechains
    ? entries
    : entries.filter((e) => !e.isSidechain);
  return buildSnapshot(
    filtered,
    limitConfig(settings),
    Date.now(),
    settings.sessionResetOverrideAt,
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
  // selected purely by `iterations > 0` and a non-null session id.
  let spentUSD = run.spent_usd;
  let spentTokens = run.spent_tokens;
  let spentEstUSD = run.spent_usd_est;
  let spentEstTokens = run.spent_tokens_est;
  let iterations = run.iterations;
  let doneRetriggers = run.done_retriggers;
  let sessionId: string | null = run.session_id;
  let stopReason = "";
  let finalStatus: RunStatus = "completed";
  let lastExit = 0;
  let workDir = workDirOf(run);
  let incompleteIteration = false;
  /** Set when the run is stepping aside rather than ending. */
  let pausedUntil: number | null = null;
  /** The next prompt should be the DONE pushback rather than the continuation. */
  let justRetriggered = false;
  const resumedFromPause = iterations > 0;
  let cyclesThisSegment = 0;
  let resumeRetried = false;

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

      // Re-check before committing to a cycle. The guard at the top of the loop
      // ran before an `await` that takes seconds on a large ~/.claude, and
      // `stopRun` promises "it will not start another work cycle" for a stop
      // landing in exactly that window — without this the operator is told
      // spending stopped and is then billed for a whole further cycle.
      const preSpawn = interrupts.get(id);
      if (preSpawn) {
        applyInterrupt(preSpawn);
        break;
      }

      iterations += 1;
      const prompt =
        iterations === 1
          ? run.isolation === "worktree"
            ? `${settings.isolationPreamble}\n\n${run.prompt}`
            : run.prompt
          : justRetriggered
            ? settings.donePushbackPrompt
            : settings.continuationPrompt;
      justRetriggered = false;

      emit({
        runId: id,
        ts: Date.now(),
        kind: "iteration",
        payload: { n: iterations, prompt, resuming: sessionId },
      });

      const args = buildArgs({
        prompt,
        model: run.model,
        permissionMode: budget.permissionMode ?? "acceptEdits",
        resumeSessionId: sessionId,
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

      const cycleStartedAt = Date.now();
      const usedResume = sessionId !== null;

      // Registered for exactly as long as a child exists. The closure reads
      // this function's own locals, which stay alive because it is suspended on
      // the await below — no database round trip, no second copy of progress.
      if (policy.enforcement !== "between-cycles") {
        liveGuards.set(id, {
          policy,
          progress: () => ({
            // The loop increments before it spawns, so the cycle in flight is
            // the one the pre-cycle guard has just authorised. Reporting it as
            // already used would make the first live tick kill it immediately.
            iterations: iterations - 1,
            spentUSD,
            spentTokens,
            spentGuardUSD: spentUSD + spentEstUSD,
            spentGuardTokens: spentTokens + spentEstTokens,
            startedAt,
          }),
        });
        startLiveTicker();
      }

      let res: IterationResult;
      try {
        res = await runIteration(id, workDir, args);
      } finally {
        liveGuards.delete(id);
      }

      cyclesThisSegment += 1;
      lastExit = res.exitCode;
      spentUSD += res.costUSD;
      spentTokens += res.tokens;
      // Latched, not assigned: a cycle that died before reporting its cost
      // leaves the run's total understated for the rest of the run, and a
      // later cycle that reports normally does not undo that.
      incompleteIteration ||= !res.sawResult;
      if (res.sessionId) sessionId = res.sessionId;

      // The cycle died before Claude Code reported what it cost, so the two
      // lines above added nothing. Recover an estimate from the transcripts;
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
            " done_retriggers = ? WHERE id = ?",
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
        break;
      }

      // Before the exit-code test for the same reason the interrupt check is:
      // a refusal kills the cycle non-zero, and testing the code first files
      // the provider's decision as the agent crashing. It also has to come
      // before the DONE test below, because a refusal that exits 0 would
      // otherwise match nothing and re-spawn straight back into the wall.
      const refusal = res.apiError ?? refusalInStderr(res.stderrTail);
      if (refusal) {
        const limited = isUsageLimit(refusal);
        const canWait =
          limited &&
          policy.enforcement === "live-resume" &&
          (run.pause_count ?? 0) < MAX_PAUSES_PER_RUN;

        emit({
          runId: id,
          ts: Date.now(),
          kind: "error",
          payload: {
            apiError: refusal,
            exitCode: res.exitCode,
            usageLimit: limited,
            waiting: canWait,
          },
        });

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
          break;
        }

        stopReason = limited
          ? `Claude refused the work cycle: ${refusal}`
          : `Claude Code refused the request: ${refusal}`;
        finalStatus = "failed";
        break;
      }

      if (res.exitCode !== 0 || res.isError) {
        // A cycle resuming a session that a kill truncated mid-turn can be
        // rejected before it does any work — an assistant turn holding a
        // `tool_use` with no matching result is not a message list the API will
        // accept. One retry covers a transient failure. A second identical one
        // is the session itself, and the honest move is to stop and name the
        // command rather than quietly start a fresh session and lose the
        // conversation the resume existed to keep.
        const looksLikeResumeFailure =
          usedResume &&
          resumedFromPause &&
          cyclesThisSegment === 1 &&
          !res.sawResult &&
          res.finalText === "";
        if (looksLikeResumeFailure && !resumeRetried) {
          resumeRetried = true;
          iterations -= 1;
          cyclesThisSegment = 0;
          log(
            id,
            "Resuming the previous session failed before it did any work. Trying once more.",
          );
          continue;
        }
        stopReason = looksLikeResumeFailure
          ? `Could not resume this run's Claude Code session (exit ${res.exitCode}). Its work is still on disk; pick it up by hand with: claude --resume ${sessionId}`
          : `Claude Code exited with code ${res.exitCode}.`;
        finalStatus = "failed";
        break;
      }

      // Completion signal from the continuation protocol.
      if (/^\s*DONE\s*$/m.test(res.finalText)) {
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
      work_dir: workDir,
      session_id: sessionId,
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
 * Ask a run to stop.
 *
 * The distinction matters to the caller: between work cycles there is no child
 * to signal, but the run is still stopped — the loop checks for an interrupt
 * before starting the next one. Reporting that as a failure (which a bare
 * boolean did) makes a working Stop button look broken.
 */
export function stopRun(id: string): StopOutcome {
  const run = getRun(id);
  if (!run) return "not-active";

  // Nothing has spawned yet, so there is no loop to notice the flag.
  if (run.status === "queued") {
    setStatus(id, "stopped", {
      finished_at: Date.now(),
      stop_reason: "Stopped by operator before it started.",
    });
    promoteQueued();
    return "cancelled";
  }

  // A parked run has no loop and no child either, and it is the one state where
  // a kill switch matters most — without this branch, Stop does nothing to the
  // runs most likely to be left unattended.
  if (run.status === "paused") {
    setStatus(id, "stopped", {
      finished_at: Date.now(),
      stop_reason:
        "Stopped by operator while it was waiting for the next 5-hour window.",
      resume_at: null,
    });
    promoteQueued();
    return "cancelled";
  }

  if (run.status !== "running") return "not-active";

  return interruptRun(id, {
    kind: "operator",
    reason: "Stopped by operator.",
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
 */
export function reconcileOnBoot(): void {
  const stale = activeRuns();
  if (stale.length === 0) return;

  let closed = 0;
  let kept = 0;
  const graceMs = getSettings().resumeGraceHours * 3_600_000;

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
