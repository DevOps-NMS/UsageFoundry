import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  CLAUDE_BIN,
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
/* Run creation                                                        */
/* ------------------------------------------------------------------ */

export interface CreateRunInput {
  folder: string;
  /** Which workspace mount `folder` is relative to. */
  mountId?: string | null;
  prompt: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  budget: unknown;
}

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

  db()
    .prepare(
      `INSERT INTO runs
         (id, folder, prompt, model, status, budget, max_iterations, iterations, created_at, spent_usd, spent_tokens)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, 0, 0)`,
    )
    .run(
      id,
      folder,
      prompt,
      input.model ?? settings.defaultModel,
      budgetBlob,
      policy.maxIterations,
      now,
    );

  emit({
    runId: id,
    ts: now,
    kind: "status",
    payload: { status: "queued", folder, prompt },
  });

  return getRun(id)!;
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

    // `close` is the preferred signal because it guarantees stdout has been
    // fully drained. It is not guaranteed to arrive: it waits for every handle
    // on the pipe to close, and a tool subprocess that outlives the agent
    // still holds one. A killed agent can therefore be gone while `close`
    // never fires — which left the run stuck in "running" with no timeout
    // anywhere to rescue it. `exit` is the authoritative "the process is
    // dead", so it settles the iteration after a short grace period for
    // buffered output. In the normal case `close` arrives first and this
    // timer never gets the chance to fire.
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      procs.delete(runId);
      if (stdoutBuf.trim()) handleStreamLine(runId, stdoutBuf.trim(), result);
      result.exitCode = code ?? -1;
      resolve(result);
    };

    child.on("close", (code) => finish(code));
    child.on("exit", (code) => {
      setTimeout(() => finish(code), 2_000).unref?.();
    });
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
  return buildSnapshot(filtered, limitConfig(settings), Date.now());
}

export async function startRun(id: string): Promise<void> {
  const run = getRun(id);
  if (!run) throw new Error(`No such run: ${id}`);
  if (run.status === "running") return;

  const budget = JSON.parse(run.budget) as BudgetPolicy & {
    permissionMode: PermissionMode;
  };
  const policy = normalizePolicy(budget);
  const settings = getSettings();
  const startedAt = Date.now();

  cancelled.delete(id);
  setStatus(id, "running", { started_at: startedAt });

  let spentUSD = 0;
  let spentTokens = 0;
  let iterations = 0;
  let sessionId: string | null = null;
  let stopReason = "";
  let finalStatus: RunStatus = "completed";
  let lastExit = 0;
  let incompleteIteration = false;

  try {
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

      iterations += 1;
      const prompt =
        iterations === 1 ? run.prompt : settings.continuationPrompt;

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

      const res = await runIteration(id, run.folder, args);
      lastExit = res.exitCode;
      spentUSD += res.costUSD;
      spentTokens += res.tokens;
      incompleteIteration = !res.sawResult;
      if (res.sessionId) sessionId = res.sessionId;

      db()
        .prepare(
          "UPDATE runs SET iterations = ?, spent_usd = ?, spent_tokens = ? WHERE id = ?",
        )
        .run(iterations, spentUSD, spentTokens, id);

      // An operator stop kills the child, which arrives here as a non-zero
      // exit. Checking the cancel flag first keeps a deliberate stop from
      // being filed as a failure; the loop-top check only catches a stop that
      // lands between iterations.
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
    });
  }
}

export function stopRun(id: string): boolean {
  cancelled.add(id);
  const child = procs.get(id);
  if (!child) return false;
  child.kill("SIGTERM");
  // Escalate if the process ignores the polite request.
  //
  // Liveness is `procs.get(id) === child`, not `child.killed`. Node sets
  // `killed` the moment a signal is *sent*, not when the process dies, so
  // testing it here would make this escalation dead code and leave a child
  // that ignores SIGTERM running forever — and because `runIteration` only
  // resolves from the `close` handler, the run would hang in "running" with
  // no timeout anywhere to rescue it. `procs.delete` happens in `close`, the
  // very event that never fires for such a child.
  setTimeout(() => {
    if (procs.get(id) === child) child.kill("SIGKILL");
  }, 5_000).unref?.();
  return true;
}

export function isRunning(id: string): boolean {
  return procs.has(id);
}
