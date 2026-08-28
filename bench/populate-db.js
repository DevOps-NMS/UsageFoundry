#!/usr/bin/env node
/**
 * Build a synthetic UsageFoundry database with realistic row counts, using the
 * app's own migrate() for the schema.
 *
 * Run with:
 *   DATA_DIR="$TMPDIR/ufbench" node bench/populate-db.js
 *
 * Deterministic (seeded PRNG) so two runs produce the same file.
 */

const path = require("node:path");
const REPO = path.join(__dirname, "..");

if (!process.env.DATA_DIR) {
  console.error("Refusing to run without DATA_DIR set — this would touch the real database.");
  process.exit(1);
}
if (path.resolve(process.env.DATA_DIR) === path.resolve(REPO, ".data")) {
  console.error("DATA_DIR points at the repo's real .data directory. Refusing.");
  process.exit(1);
}

const { db } = require(path.join(REPO, ".test-build/lib/db.js"));
const d = db();

// ---------------------------------------------------------------- seeded PRNG
let seed = 0x9e3779b9;
function rnd() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x100000000;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const text = (n) => "x".repeat(n);

// --------------------------------------------------------------------- shapes
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0); // 2026-08-28, matches the tree's date
const SIX_MONTHS = 183 * 24 * 3600 * 1000;
const START = NOW - SIX_MONTHS;

const N_RUNS = 5000;
const EVENTS_PER_RUN = 50; // -> 250,000
const N_REQUEST_LOG = 50000;
const N_OTLP = 40000;
const N_CONTEXT_SAMPLES = 20000;
const N_PRUNE_RECEIPTS = 3000;
const N_OPS_EVENTS = 5000;
const N_WORKFLOWS = 12;
const N_INSTANCES = 200;
const N_MERGE_BATCHES = 80;

// Realistic status mix: a six-month history is overwhelmingly settled rows, and
// only a handful are live at any instant. Getting this right matters because
// idx_runs_status' selectivity is what the guard/admission queries live on.
const STATUS_MIX = [
  ["completed", 3200],
  ["failed", 700],
  ["stopped", 550],
  ["needs-review", 380],
  ["blocked", 120],
  ["queued", 25],
  ["waiting", 15],
  ["running", 8],
  ["paused", 2],
];
const TERMINAL = new Set(["completed", "failed", "stopped", "needs-review", "blocked"]);

const ORIGINS = ["form", "form", "form", "chat", "workflow", "orchestrator-block", "schedule"];
const MODELS = ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5", null];
const MOUNTS = ["/workspace/app", "/workspace/api", "/workspace/infra", "/workspace/docs"];
const EVENT_KINDS = [
  "run.started", "run.iteration_started", "run.stdout", "run.stdout", "run.stdout",
  "run.tool_use", "run.tool_use", "run.cost", "run.iteration_finished",
  "run.guard_tripped", "run.finished", "run.warn", "run.context_sample",
];
const PATHS = [
  "/api/runs", "/api/runs", "/api/runs", "/api/status", "/api/settings",
  "/api/usage", "/api/runs/abc/events", "/api/runs/abc", "/api/workflows",
  "/api/chat", "/api/plugins", "/api/health",
];

function budgetBlob() {
  return JSON.stringify({
    maxIterations: int(1, 20),
    maxUsd: pick([0, 5, 10, 25, 50]),
    maxTokens: pick([0, 1000000, 5000000]),
    maxMinutes: pick([0, 30, 120]),
    stopOnFiveHourPct: pick([0, 80, 90]),
    stopOnWeeklyPct: pick([0, 85]),
    installCeilingUsd: pick([0, 100]),
    contextCeilingPct: pick([0, 70, 85]),
    notes: text(int(40, 200)),
  });
}
function agentBlob() {
  return JSON.stringify({
    name: pick(["reviewer", "implementer", "docs-writer", "triage"]),
    description: text(int(30, 90)),
    prompt: text(int(400, 2500)),
    model: pick(MODELS),
  });
}
function baselineBlob() {
  return JSON.stringify({ head: text(40), dirty: rnd() < 0.2, files: int(0, 40) });
}
function graphBlob() {
  return JSON.stringify({
    nodes: Array.from({ length: int(3, 9) }, (_, i) => ({
      id: `n${i}`, name: `Block ${i}`, kind: pick(["run", "orchestrator", "loop"]),
      prompt: text(int(200, 900)),
    })),
    edges: Array.from({ length: int(2, 8) }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
  });
}

// ---------------------------------------------------------------------- write
d.pragma("foreign_keys = ON");
console.time("populate");

const runIds = [];
const runById = new Map();

d.transaction(() => {
  const ins = d.prepare(`
    INSERT INTO runs (
      id, folder, prompt, model, status, budget, baseline,
      max_iterations, iterations, created_at, started_at, finished_at,
      stop_reason, exit_code, spent_usd, spent_tokens, session_id,
      work_dir, isolation, repo_root, worktree_path, worktree_branch,
      worktree_base, resume_at, paused_at, pause_count, done_retriggers,
      reported_done, follow_up, active_iteration, spent_usd_est,
      spent_tokens_est, worktree_base_branch, landed_at, landed_into,
      landed_strategy, landed_tip, agent, file_cost_notice, continues_run,
      active_started_at, restart_closed, set_aside_at, origin, origin_ref,
      reopened_at, needs_review_reason
    ) VALUES (
      @id, @folder, @prompt, @model, @status, @budget, @baseline,
      @max_iterations, @iterations, @created_at, @started_at, @finished_at,
      @stop_reason, @exit_code, @spent_usd, @spent_tokens, @session_id,
      @work_dir, @isolation, @repo_root, @worktree_path, @worktree_branch,
      @worktree_base, @resume_at, @paused_at, @pause_count, @done_retriggers,
      @reported_done, @follow_up, @active_iteration, @spent_usd_est,
      @spent_tokens_est, @worktree_base_branch, @landed_at, @landed_into,
      @landed_strategy, @landed_tip, @agent, @file_cost_notice, @continues_run,
      @active_started_at, @restart_closed, @set_aside_at, @origin, @origin_ref,
      @reopened_at, @needs_review_reason
    )`);

  const statuses = [];
  for (const [s, n] of STATUS_MIX) for (let i = 0; i < n; i++) statuses.push(s);
  // Shuffle so status is not correlated with created_at order.
  for (let i = statuses.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [statuses[i], statuses[j]] = [statuses[j], statuses[i]];
  }

  // created_at climbs through the six months, but in bursts: a fleet admits
  // several runs inside one millisecond, which is exactly what the
  // (created_at DESC, id DESC) tiebreak exists for.
  let t = START;
  for (let i = 0; i < N_RUNS; i++) {
    if (i % 25 === 0) t += int(1000, SIX_MONTHS / (N_RUNS / 25) * 2);
    const status = statuses[i];
    const created = t;
    const isTerminal = TERMINAL.has(status);
    const started = status === "waiting" || status === "queued" ? null : created + int(50, 5000);
    const finished = isTerminal ? created + int(30_000, 6 * 3600_000) : null;
    const iterations = status === "waiting" || status === "queued" ? 0 : int(1, 18);
    const id = `run_${String(i).padStart(6, "0")}_${text(6)}`;
    const isolated = rnd() < 0.7;
    const folder = `${pick(MOUNTS)}/${pick(["src", "pkg", "svc"])}/${pick(["auth", "billing", "api", "web", "jobs"])}`;
    const row = {
      id,
      folder,
      // Realistic prompt sizes: the route clips these, and the clip only
      // matters if the stored column is genuinely long.
      prompt: `Task ${i}: ` + text(int(300, 4000)),
      model: pick(MODELS),
      status,
      budget: budgetBlob(),
      baseline: rnd() < 0.8 ? baselineBlob() : null,
      max_iterations: pick([1, 1, 3, 5, 10, 20, 0]),
      iterations,
      created_at: created,
      started_at: started,
      finished_at: finished,
      stop_reason: isTerminal ? pick(["done", "max-iterations", "budget-usd", "cancelled", "error", null]) : null,
      exit_code: isTerminal ? pick([0, 0, 0, 1, 2, null]) : null,
      spent_usd: Number((rnd() * 12).toFixed(4)),
      spent_tokens: int(0, 4_000_000),
      session_id: rnd() < 0.9 ? `sess_${text(30)}` : null,
      work_dir: isolated ? `/workspace/.uf-worktrees/wt-${i}` : folder,
      isolation: isolated ? "worktree" : "none",
      repo_root: rnd() < 0.9 ? pick(MOUNTS) : null,
      worktree_path: isolated ? `/workspace/.uf-worktrees/wt-${i}` : null,
      worktree_branch: isolated ? `uf/run-${i}` : null,
      worktree_base: isolated ? text(40) : null,
      resume_at: status === "paused" ? created + 5 * 3600_000 : null,
      paused_at: status === "paused" ? created + int(1000, 100000) : null,
      pause_count: int(0, 3),
      done_retriggers: int(0, 2),
      reported_done: status === "completed" && rnd() < 0.8 ? 1 : 0,
      follow_up: rnd() < 0.1 ? text(int(50, 400)) : null,
      active_iteration: status === "running" ? iterations : null,
      spent_usd_est: Number((rnd() * 12).toFixed(4)),
      spent_tokens_est: int(0, 4_000_000),
      worktree_base_branch: isolated ? "main" : null,
      landed_at: isolated && rnd() < 0.25 ? (finished ?? created) + int(1000, 86400_000) : null,
      landed_into: isolated && rnd() < 0.25 ? "main" : null,
      landed_strategy: isolated && rnd() < 0.25 ? pick(["merge", "squash", "rebase"]) : null,
      landed_tip: isolated && rnd() < 0.25 ? text(40) : null,
      agent: rnd() < 0.4 ? agentBlob() : null,
      file_cost_notice: rnd() < 0.15 ? JSON.stringify({ files: int(1, 20), usd: rnd() }) : null,
      continues_run: null,
      active_started_at: status === "running" ? created + 1000 : null,
      restart_closed: 0,
      set_aside_at: status === "needs-review" && rnd() < 0.3 ? created + 10000 : null,
      origin: pick(ORIGINS),
      origin_ref: rnd() < 0.4 ? `ref_${text(20)}` : null,
      reopened_at: rnd() < 0.05 ? created + int(1000, 86400_000) : null,
      // MAX_NEEDS_REVIEW_REASON-sized text, on the rows that actually carry it.
      needs_review_reason: status === "needs-review" ? text(int(200, 2000)) : null,
    };
    ins.run(row);
    runIds.push(id);
    runById.set(id, row);
  }
})();
console.log("runs:", runIds.length);

// ------------------------------------------------------------------ run_events
d.transaction(() => {
  const ins = d.prepare(
    "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
  );
  for (const id of runIds) {
    const base = runById.get(id).created_at;
    for (let e = 0; e < EVENTS_PER_RUN; e++) {
      ins.run(
        id,
        base + e * int(500, 60_000),
        pick(EVENT_KINDS),
        JSON.stringify({ i: e, line: text(int(80, 1200)), usd: rnd(), tokens: int(0, 90000) }),
      );
    }
  }
})();
console.log("run_events:", d.prepare("SELECT COUNT(*) n FROM run_events").get().n);

// ----------------------------------------------------------------- request_log
d.transaction(() => {
  const ins = d.prepare(
    "INSERT INTO request_log (ts, method, path, status, subject, actor, address, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < N_REQUEST_LOG; i++) {
    ins.run(
      START + Math.floor((i / N_REQUEST_LOG) * SIX_MONTHS) + int(0, 500),
      pick(["GET", "GET", "GET", "POST", "POST", "DELETE", "PATCH"]),
      pick(PATHS),
      pick([200, 200, 200, 200, 201, 204, 400, 401, 404, 429, 500]),
      rnd() < 0.5 ? `run_${String(int(0, N_RUNS - 1)).padStart(6, "0")}` : null,
      pick(["operator", "operator", "agent", "mcp", "schedule"]),
      pick(["127.0.0.1", "172.18.0.1", "::1", null]),
      int(0, 4000),
    );
  }
})();
console.log("request_log:", d.prepare("SELECT COUNT(*) n FROM request_log").get().n);

// -------------------------------------------------------------------- run_deps
// ~1 in 4 runs waits on something; fan-in of 1-3.
d.transaction(() => {
  const ins = d.prepare(
    "INSERT OR IGNORE INTO run_deps (run_id, depends_on, edge, created_at, continue_branch) VALUES (?, ?, ?, ?, ?)",
  );
  for (let i = 200; i < N_RUNS; i++) {
    if (rnd() > 0.25) continue;
    const fanIn = int(1, 3);
    for (let k = 0; k < fanIn; k++) {
      const dep = runIds[int(Math.max(0, i - 60), i - 1)];
      if (dep === runIds[i]) continue;
      ins.run(
        runIds[i],
        dep,
        pick(["on-success", "on-finish"]),
        runById.get(runIds[i]).created_at - int(0, 1000),
        rnd() < 0.3 ? 1 : 0,
      );
    }
  }
})();
console.log("run_deps:", d.prepare("SELECT COUNT(*) n FROM run_deps").get().n);

// ----------------------------------------------------------------- run_reviews
d.transaction(() => {
  const ins = d.prepare(`
    INSERT INTO run_reviews (id, run_id, created_at, finished_at, status, model,
      cost_usd, tokens, text, error, diff_files, diff_shown, truncated, kind,
      resolved_commit, resolved_paths)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (let i = 0; i < N_RUNS; i++) {
    if (rnd() > 0.14) continue;
    const copies = rnd() < 0.25 ? 2 : 1; // a second review does not replace the first
    for (let c = 0; c < copies; c++) {
      const created = runById.get(runIds[i]).created_at + int(1000, 86400_000);
      ins.run(
        `rev_${n}_${text(8)}`, runIds[i], created, created + int(5000, 300000),
        pick(["done", "done", "done", "failed", "running"]), pick(MODELS),
        Number((rnd() * 0.9).toFixed(4)), int(1000, 300000),
        rnd() < 0.85 ? text(int(500, 6000)) : null,
        rnd() < 0.1 ? "spawn failed" : null,
        int(0, 60), int(0, 60), rnd() < 0.2 ? 1 : 0,
        pick(["review", "review", "resolve"]),
        rnd() < 0.3 ? text(40) : null,
        rnd() < 0.3 ? JSON.stringify(["a.ts", "b.ts"]) : null,
      );
      n++;
    }
  }
})();
console.log("run_reviews:", d.prepare("SELECT COUNT(*) n FROM run_reviews").get().n);

// ----------------------------------------------------------------- merge_queue
d.transaction(() => {
  const ins = d.prepare(`
    INSERT INTO merge_queue (id, batch_id, run_id, position, strategy,
      auto_resolve, status, message, created_at, started_at, finished_at, resolve_cost)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (let b = 0; b < N_MERGE_BATCHES; b++) {
    const size = int(2, 8);
    const batchCreated = START + Math.floor(rnd() * SIX_MONTHS);
    for (let p = 0; p < size; p++) {
      const status = b < N_MERGE_BATCHES - 2
        ? pick(["landed", "landed", "landed", "conflict", "failed", "skipped"])
        : pick(["queued", "queued", "running"]);
      ins.run(
        `mq_${n}_${text(6)}`, `batch_${b}`, runIds[int(0, N_RUNS - 1)], p,
        pick(["merge", "squash", "rebase"]), rnd() < 0.4 ? 1 : 0, status,
        status === "queued" ? null : text(int(20, 200)),
        batchCreated + p, status === "queued" ? null : batchCreated + 1000,
        ["landed", "failed", "skipped"].includes(status) ? batchCreated + 60000 : null,
        Number((rnd() * 0.4).toFixed(4)),
      );
      n++;
    }
  }
})();
console.log("merge_queue:", d.prepare("SELECT COUNT(*) n FROM merge_queue").get().n);

// -------------------------------------------------------------- workflow_* set
d.transaction(() => {
  const insW = d.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?,?,?,?,?)",
  );
  for (let i = 0; i < N_WORKFLOWS; i++) {
    insW.run(`wf_${i}`, `Workflow ${i}`, graphBlob(), START + i * 1000, START + i * 2000);
  }

  const insI = d.prepare(`
    INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph,
      created_at, status, error, stopped_at, stop_cause, stop_reason,
      instance_budget, origin, origin_ref)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insIR = d.prepare(
    "INSERT OR IGNORE INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id, emitted_by) VALUES (?,?,?,?,?,?)",
  );
  const insIB = d.prepare(`
    INSERT OR IGNORE INTO workflow_instance_blocks (instance_id, node_id, node_name,
      position, kind, status, started_at, finished_at, cost_usd, tokens,
      session_id, emitted_specs, error, merge_batch_id, reply, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let runCursor = 0;
  for (let i = 0; i < N_INSTANCES; i++) {
    const created = START + Math.floor((i / N_INSTANCES) * SIX_MONTHS);
    const status = i >= N_INSTANCES - 3 ? pick(["started", "stopping"]) : pick(["started", "started", "failed"]);
    insI.run(
      `wfi_${i}`, `wf_${i % N_WORKFLOWS}`, `Workflow ${i % N_WORKFLOWS}`, graphBlob(),
      created, status, status === "failed" ? text(120) : null,
      status === "failed" ? created + 5000 : null,
      status === "failed" ? "budget" : null,
      status === "failed" ? text(80) : null,
      rnd() < 0.5 ? JSON.stringify({ maxUsd: 20 }) : null,
      pick(["form", "schedule"]), rnd() < 0.4 ? `sched_${i % 5}` : null,
    );
    // ~4-6 member runs per instance -> ~1,000 rows
    const members = int(3, 7);
    for (let m = 0; m < members; m++) {
      insIR.run(`wfi_${i}`, `n${m}`, `Block ${m}`, m, runIds[runCursor % N_RUNS], rnd() < 0.3 ? `n${Math.max(0, m - 1)}` : null);
      runCursor += 3;
    }
    // ~1-2 non-run blocks per instance
    const blocks = int(1, 2);
    for (let b = 0; b < blocks; b++) {
      const bstatus = i >= N_INSTANCES - 5
        ? pick(["waiting", "thinking", "looping"])
        : pick(["emitted", "emitted", "failed", "blocked"]);
      insIB.run(
        `wfi_${i}`, `b${b}`, `Orch ${b}`, 90 + b,
        pick(["orchestrator", "loop", "run"]), bstatus,
        created + 100, ["emitted", "failed", "blocked"].includes(bstatus) ? created + 30000 : null,
        Number((rnd() * 0.5).toFixed(4)), int(0, 200000),
        rnd() < 0.7 ? `sess_${text(20)}` : null,
        rnd() < 0.5 ? JSON.stringify([{ name: "child", task: text(200) }]) : null,
        bstatus === "failed" ? text(120) : null,
        rnd() < 0.2 ? `batch_${int(0, N_MERGE_BATCHES - 1)}` : null,
        rnd() < 0.4 ? text(300) : null, rnd() < 0.2 ? text(200) : null,
      );
    }
  }
})();
for (const t of ["workflows", "workflow_instances", "workflow_instance_runs", "workflow_instance_blocks"]) {
  console.log(`${t}:`, d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
}

// -------------------------------------------------------------- otlp_requests
d.transaction(() => {
  const ins = d.prepare(`
    INSERT OR IGNORE INTO otlp_requests (request_id, ts, run_id, session_id, model,
      cost_usd, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, duration_ms, query_source, speed, effort)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < N_OTLP; i++) {
    const runId = rnd() < 0.85 ? runIds[int(0, N_RUNS - 1)] : null;
    ins.run(
      `req_${i}_${text(10)}`,
      START + Math.floor((i / N_OTLP) * SIX_MONTHS),
      runId, runId ? runById.get(runId).session_id : null, pick(MODELS),
      Number((rnd() * 0.4).toFixed(6)),
      int(100, 40000), int(50, 8000), int(0, 900000), int(0, 60000),
      int(200, 90000), pick(["user", "assistant", "tool", null]),
      pick(["standard", "fast", null]), pick(["low", "medium", "high", null]),
    );
  }
})();
console.log("otlp_requests:", d.prepare("SELECT COUNT(*) n FROM otlp_requests").get().n);

// -------------------------------------------------- context_samples / receipts
d.transaction(() => {
  const insC = d.prepare(`
    INSERT INTO context_samples (ts, run_id, iteration, tokens, basis, frame_id, turn_index, turns_exact)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < N_CONTEXT_SAMPLES; i++) {
    const runId = runIds[int(0, N_RUNS - 1)];
    insC.run(
      runById.get(runId).created_at + int(0, 3600_000), runId, int(1, 18),
      int(20000, 900000), pick(["transcript", "usage", "estimate"]),
      rnd() < 0.7 ? `frame_${text(12)}` : null, int(0, 400), rnd() < 0.8 ? 1 : 0,
    );
  }
  const insP = d.prepare(`
    INSERT INTO prune_receipts (ts, run_id, trigger, tier, tokens_before, tokens_after, tokens_removed, model)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < N_PRUNE_RECEIPTS; i++) {
    const runId = runIds[int(0, N_RUNS - 1)];
    const before = int(200000, 900000);
    const after = Math.floor(before * (0.3 + rnd() * 0.5));
    insP.run(
      runById.get(runId).created_at + int(0, 3600_000), runId,
      pick(["boundary", "ceiling", "manual"]), pick(["aggressive", "standard"]),
      before, after, before - after, pick(MODELS),
    );
  }
  const insO = d.prepare("INSERT INTO ops_events (ts, level, event, detail) VALUES (?,?,?,?)");
  for (let i = 0; i < N_OPS_EVENTS; i++) {
    insO.run(
      START + Math.floor((i / N_OPS_EVENTS) * SIX_MONTHS),
      pick(["info", "info", "warn", "error"]),
      pick(["run.admitted", "run.guard_tripped", "schedule.fired", "retention.sweep", "webhook.failed", "lock.taken"]),
      JSON.stringify({ msg: text(int(40, 300)) }),
    );
  }
})();
for (const t of ["context_samples", "prune_receipts", "ops_events"]) {
  console.log(`${t}:`, d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
}

// ------------------------------------- fork_attempts / resume_probes / plans
// fork_attempts matters more than its row count suggests: pruneSavingsByRun
// asks it once per run in a page, so an empty table hides that cost.
d.transaction(() => {
  const insF = d.prepare(`
    INSERT INTO fork_attempts (ts, run_id, source_session_id, new_session_id, written,
      refused_by, reason, removed_bytes, net_bytes, suffix_bytes, break_even_turns,
      cold_age_seconds, min_cold_age, resumed, trigger, context_tokens_after)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 2500; i++) {
    const runId = runIds[int(0, N_RUNS - 1)];
    const written = rnd() < 0.55 ? 1 : 0;
    const removed = int(80000, 900000);
    insF.run(
      runById.get(runId).created_at + int(0, 3600_000), runId,
      runById.get(runId).session_id, written ? `sess_${text(30)}` : null, written,
      written ? null : pick(["cold-age", "compacted", "G4", "parse", "G5"]),
      written ? null : text(60),
      removed, Math.floor(removed * 0.9), int(200000, 400000),
      Number((rnd() * 40).toFixed(2)), Number((rnd() * 7200).toFixed(1)),
      int(60, 900), written ? (rnd() < 0.9 ? 1 : 0) : null,
      pick(["boundary", "early-end", "early-end", null]),
      written ? int(100000, 400000) : null,
    );
  }
  const insR = d.prepare(
    "INSERT INTO resume_probes (ts, run_id, session_id, pruned, tokens_before) VALUES (?,?,?,?,?)",
  );
  for (let i = 0; i < 8000; i++) {
    const runId = runIds[int(0, N_RUNS - 1)];
    insR.run(runById.get(runId).created_at + int(0, 3600_000), runId,
      runById.get(runId).session_id, rnd() < 0.4 ? 1 : 0, int(50000, 900000));
  }
  const insP = d.prepare(`
    INSERT INTO plan_observations (ts, run_id, session_id, tier, tool_calls, stripped,
      removed_bytes, pointer_overhead, net_bytes, suffix_bytes, break_even_turns, pruned)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 6000; i++) {
    const runId = runIds[int(0, N_RUNS - 1)];
    const removed = int(50000, 800000);
    insP.run(runById.get(runId).created_at + int(0, 3600_000), runId,
      runById.get(runId).session_id, pick(["standard", "aggressive"]),
      int(1, 400), int(0, 300), removed, int(1000, 40000),
      Math.floor(removed * 0.9), int(100000, 400000),
      Number((rnd() * 40).toFixed(2)), rnd() < 0.5 ? 1 : 0);
  }
})();

// ------------------------------------------------------ chat / webhook / auth
d.transaction(() => {
  const insS = d.prepare(`
    INSERT INTO chat_sessions (id, created_at, updated_at, title, session_id, status,
      cost_usd, tokens, error, turn_started_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insM = d.prepare(
    "INSERT INTO chat_messages (id, chat_id, ts, role, text, seq) VALUES (?,?,?,?,?,?)",
  );
  const insT = d.prepare(
    "INSERT INTO chat_turn_spend (chat_id, ts, cost_usd) VALUES (?,?,?)",
  );
  for (let i = 0; i < 300; i++) {
    const created = START + Math.floor((i / 300) * SIX_MONTHS);
    insS.run(`chat_${i}`, created, created + int(1000, 3600_000),
      `Chat ${i}: ${text(40)}`, `sess_${text(28)}`,
      i >= 298 ? "thinking" : pick(["idle", "idle", "failed"]),
      Number((rnd() * 6).toFixed(4)), int(1000, 900000),
      rnd() < 0.1 ? text(80) : null, i >= 298 ? created + 500 : null);
    const msgs = int(4, 40);
    for (let m = 0; m < msgs; m++) {
      insM.run(`msg_${i}_${m}`, `chat_${i}`, created + m * 60000,
        pick(["user", "assistant", "assistant", "system"]), text(int(100, 3000)), m);
    }
    for (let k = 0; k < int(1, 8); k++) {
      insT.run(`chat_${i}`, created + k * 90000, Number((rnd() * 0.6).toFixed(4)));
    }
  }
  const insW = d.prepare(
    "INSERT INTO webhook_deliveries (ts, run_id, event, http_status, ok, error) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < 4000; i++) {
    const ok = rnd() < 0.9 ? 1 : 0;
    insW.run(START + Math.floor((i / 4000) * SIX_MONTHS), runIds[int(0, N_RUNS - 1)],
      pick(["run.finished", "run.failed", "run.needs-review"]),
      ok ? 204 : pick([0, 429, 500]), ok, ok ? null : text(60));
  }
  const insA = d.prepare(
    "INSERT INTO auth_sessions (id, created_at, expires_at, revoked_at) VALUES (?,?,?,?)",
  );
  for (let i = 0; i < 400; i++) {
    const created = START + Math.floor((i / 400) * SIX_MONTHS);
    insA.run(`auth_${i}`, created, created + 30 * 86400_000,
      rnd() < 0.2 ? created + 86400_000 : null);
  }
})();
for (const t of ["fork_attempts", "resume_probes", "plan_observations", "chat_sessions", "chat_messages", "chat_turn_spend", "webhook_deliveries", "auth_sessions"]) {
  console.log(`${t}:`, d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
}

// NO ANALYZE by default, because `ANALYZE` appears nowhere in src/ — a real
// install has no sqlite_stat1 and the planner is working blind. Set UF_ANALYZE=1
// to build the other fixture; the two disagree about four query plans.
if (process.env.UF_ANALYZE === "1") {
  d.exec("ANALYZE");
  console.log("ANALYZE run (NOT production-accurate)");
}
console.timeEnd("populate");
console.log(
  "db size (bytes):",
  require("node:fs").statSync(path.join(process.env.DATA_DIR, "usagefoundry.db")).size,
);
