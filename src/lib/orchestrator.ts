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
  type BudgetVerdict,
  evaluateBudget,
  normalizePolicy,
} from "./budget";
import { scanUsage } from "./transcripts";
import { buildSnapshot } from "./windows";

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
 */

export type RunStatus =
  | "queued"
  | "running"
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

const cancelled = ((globalThis as unknown as { __ufCancelled?: Set<string> })
  .__ufCancelled ??= new Set<string>());

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

export function runEvents(runId: string, afterId = 0): Array<RunEvent & { id: number }> {
  const rows = db()
    .prepare(
      "SELECT id, run_id, ts, kind, payload FROM run_events WHERE run_id = ? AND id > ? ORDER BY id",
    )
    .all(runId, afterId) as Array<{
    id: number;
    run_id: string;
    ts: number;
    kind: RunEvent["kind"];
    payload: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    ts: r.ts,
    kind: r.kind,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));
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

/** `core.fsmonitor` is a command git runs, so it is cleared on every call. */
const gitArgs = (args: string[]) => ["-c", "core.fsmonitor=", ...args];

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
    return { mode: "none", reason: "Not a git repository — runs here are serialised." };
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
    const status = await git(slotPath, ["status", "--porcelain"]);
    if (!status.ok || status.stdout !== "") {
      throw new Error(
        `Checkout ${path.basename(slotPath)} still has uncommitted work. Commit or remove it first.`,
      );
    }
    const co = await git(slotPath, ["checkout", "-b", branch, base]);
    if (!co.ok) throw new Error(`Could not start branch ${branch}: ${co.stderr}`);
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

/** Runs holding, or waiting to hold, a place on disk. */
export function activeRuns(): RunRow[] {
  return db()
    .prepare(
      "SELECT * FROM runs WHERE status IN ('queued','running') ORDER BY created_at",
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
        policy.maxIterations,
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
  const reserved: ConflictKey[] = running.map((r) => conflictKey(workDirOf(r)));

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
}

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
      if (text) log(runId, text, { stream: "stderr" });
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
    const message = ev.message as { content?: unknown[] } | undefined;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b.type === "text" && typeof b.text === "string") {
        acc.finalText = b.text;
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

export async function startRun(id: string): Promise<void> {
  const run = getRun(id);
  if (!run) throw new Error(`No such run: ${id}`);

  // Claim the run itself before anything else can. The conditional UPDATE is
  // the whole guard: two callers racing to promote the same queued run both
  // reach here, and exactly one sees a row change.
  const claim = db()
    .prepare(
      "UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
    )
    .run(Date.now(), id);
  if (claim.changes !== 1) return;

  const startedAt = Date.now();
  emit({
    runId: id,
    ts: startedAt,
    kind: "status",
    payload: { status: "running", started_at: startedAt },
  });

  let spentUSD = 0;
  let spentTokens = 0;
  let iterations = 0;
  let sessionId: string | null = null;
  let stopReason = "";
  let finalStatus: RunStatus = "completed";
  let lastExit = 0;
  let workDir = workDirOf(run);
  let incompleteIteration = false;

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
      if (cancelled.has(id)) {
        stopReason = "Stopped by operator.";
        finalStatus = "stopped";
        break;
      }

      const snapshot = await currentSnapshot();
      const verdict: BudgetVerdict = evaluateBudget(
        policy,
        snapshot,
        { iterations, spentUSD, spentTokens, startedAt },
        Date.now(),
      );

      emit({
        runId: id,
        ts: Date.now(),
        kind: "budget",
        payload: {
          allowed: verdict.allowed,
          reason: verdict.reason ?? null,
          code: verdict.code ?? null,
          meters: verdict.meters,
          weeklyFraction: snapshot.weekly.fraction,
          sessionFraction: snapshot.session.fraction,
        },
      });

      if (!verdict.allowed) {
        stopReason = verdict.reason ?? "Budget guard stopped the run.";
        // Hitting a guard before any work happened is a different outcome from
        // running out mid-task; surface it distinctly so it is not mistaken
        // for a completed run.
        finalStatus = iterations === 0 ? "blocked" : "stopped";
        break;
      }

      // Re-check before committing to a cycle. The guard at the top of the loop
      // ran before an `await` that takes seconds on a large ~/.claude, and
      // `stopRun` promises "it will not start another work cycle" for a stop
      // landing in exactly that window — without this the operator is told
      // spending stopped and is then billed for a whole further cycle.
      if (cancelled.has(id)) {
        stopReason = "Stopped by operator.";
        finalStatus = "stopped";
        break;
      }

      iterations += 1;
      const prompt =
        iterations === 1
          ? run.isolation === "worktree"
            ? `${settings.isolationPreamble}\n\n${run.prompt}`
            : run.prompt
          : settings.continuationPrompt;

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

      const res = await runIteration(id, workDir, args);
      lastExit = res.exitCode;
      spentUSD += res.costUSD;
      spentTokens += res.tokens;
      incompleteIteration = !res.sawResult;
      if (res.sessionId) sessionId = res.sessionId;

      db()
        .prepare(
          "UPDATE runs SET iterations = ?, spent_usd = ?, spent_tokens = ?, session_id = ? WHERE id = ?",
        )
        .run(iterations, spentUSD, spentTokens, sessionId, id);

      // Before the exit-code test, because a SIGTERM'd child closes with a null
      // code that reads as -1. Judging that as a crash would file every stop the
      // operator asks for while a cycle is in flight as a red `failed` run.
      if (cancelled.has(id)) {
        stopReason = "Stopped by operator.";
        finalStatus = "stopped";
        break;
      }

      if (res.exitCode !== 0 || res.isError) {
        stopReason = `Claude Code exited with code ${res.exitCode}.`;
        finalStatus = "failed";
        break;
      }

      // Completion signal from the continuation protocol.
      if (/^\s*DONE\s*$/m.test(res.finalText)) {
        stopReason = "Agent reported the task complete.";
        finalStatus = "completed";
        break;
      }

      if (iterations >= policy.maxIterations) {
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
    cancelled.delete(id);
    // Spend is only ever read from the CLI's `result` event, so an iteration
    // killed before that event lands contributes $0. Say so rather than let
    // the total read as measured fact. The dashboard's transcript-derived
    // figures are unaffected and remain the more complete number.
    if (incompleteIteration) {
      stopReason = [
        stopReason,
        "The final work cycle ended before Claude Code reported its cost, so this run's spend is understated.",
      ]
        .filter(Boolean)
        .join(" ");
    }
    setStatus(id, finalStatus, {
      finished_at: Date.now(),
      stop_reason: stopReason,
      exit_code: lastExit,
      iterations,
      spent_usd: spentUSD,
      spent_tokens: spentTokens,
      work_dir: workDir,
      session_id: sessionId,
    });

    // Only once there is something to hand off. A run that never got past the
    // budget guard, or died setting its checkout up, has no branch to describe.
    // Not awaited: the run is already in its terminal state, and the card is an
    // extra event on a stream that replays from storage.
    if (run.isolation === "worktree" && run.worktree_path && iterations > 0) {
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

export type StopOutcome = "signalled" | "cancelled" | "not-active";

/**
 * Ask a run to stop.
 *
 * The distinction matters to the caller: between work cycles there is no child
 * to signal, but the run is still stopped — the loop checks `cancelled` before
 * starting the next one. Reporting that as a failure (which a bare boolean did)
 * makes a working Stop button look broken.
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

  if (run.status !== "running") return "not-active";

  cancelled.add(id);
  const child = procs.get(id);
  if (!child) return "cancelled";

  child.kill("SIGTERM");
  // Escalate if the process ignores the polite request. The test is whether the
  // child is still registered — `close` removes it — and deliberately not
  // `child.killed`, which only records that a signal was *sent* and is already
  // true from the line above, so including it meant SIGKILL was never reached.
  setTimeout(() => {
    if (procs.get(id) === child) child.kill("SIGKILL");
  }, 5_000).unref?.();
  return "signalled";
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
 */
export function reconcileOnBoot(): void {
  const stale = activeRuns();
  if (stale.length === 0) return;

  for (const run of stale) {
    if (run.status === "queued") {
      setStatus(run.id, "stopped", {
        finished_at: Date.now(),
        stop_reason: "The server restarted before this run started. Start it again.",
      });
      continue;
    }

    const resume = run.session_id
      ? ` To pick up where it left off: claude --resume ${run.session_id}`
      : "";
    setStatus(run.id, "failed", {
      finished_at: Date.now(),
      stop_reason: `The server restarted while this run was in progress.${resume}`,
    });
  }

  console.warn(
    `[usagefoundry] Closed out ${stale.length} run(s) interrupted by a restart.`,
  );
}
