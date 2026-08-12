import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { CLAUDE_BIN } from "./config";
import { db } from "./db";
import { git } from "./git";
import { diffAsText, runDiff, type RunDiff } from "./diff";
import { getSettings } from "./settings";
import {
  currentSnapshot,
  emitRunEvent,
  getRun,
  signalTree,
  workDirOf,
  type RunRow,
} from "./orchestrator";

/**
 * One-shot Claude invocations about a run, outside its work cycles.
 *
 * Two of them today: reviewing what a run changed, and resolving a merge
 * conflict between its branch and the branch it lands into. They share this
 * module because they are the same thing operationally — one child, one JSON
 * result, one row — and because they are the same thing in the accounts.
 *
 * **This is the third kind of child process this app spawns**, after the agent
 * and git, and it is deliberate rather than incidental:
 *
 *   - Neither is ever automatic. Both cost money, and spend nobody asked for is
 *     spend nobody authorised — so nothing in the run loop reaches this module.
 *   - Each gets the narrowest permission mode that can do its job: a review
 *     runs `--permission-mode plan` and cannot write at all; a resolution runs
 *     `acceptEdits` **inside an isolated checkout**, never in the operator's,
 *     and is not allowed to run git — the app commits, after it has checked.
 *   - Cost never reaches `runs.spent_usd`. That column is a floor of what
 *     Claude Code measured for **work cycles**; folding these into it would make
 *     the run read as more expensive than the work was. It lands in
 *     `run_reviews.cost_usd` and is displayed separately, the same
 *     display-vs-accounting split the codebase already makes for
 *     `costUSD`/`costGuardUSD` and `spent_usd`/`spent_usd_est`.
 *   - Neither carries telemetry. `otlp_requests.run_id` is compared against the
 *     run's own spend, and these requests would corrupt that comparison.
 */

/** What a `run_reviews` row is. */
export type AssistKind = "review" | "resolve";

/** Diff bytes sent to the reviewer. Bounded by argv, not by context. */
const REVIEW_DIFF_BYTES = 60_000;
/** A single argv entry is capped at 128 KB on Linux; stay well clear of it. */
const REVIEW_TIMEOUT_MS = 10 * 60_000;

export interface ReviewRow {
  id: string;
  run_id: string;
  kind: AssistKind;
  created_at: number;
  finished_at: number | null;
  status: "running" | "completed" | "failed";
  model: string | null;
  cost_usd: number;
  tokens: number;
  text: string | null;
  error: string | null;
  diff_files: number;
  diff_shown: number;
  truncated: number;
  /** The merge commit a conflict resolution made. Null for a review. */
  resolved_commit: string | null;
  /** The files it was handed, as a JSON array. Null for a review. */
  resolved_paths: string | null;
}

/**
 * The paths a resolution was given, or none.
 *
 * A column written by this app in one place, so a value that does not parse
 * means the row is not what it claims and the honest answer is nothing rather
 * than a partial list.
 */
export function reviewPaths(row: ReviewRow): string[] {
  if (!row.resolved_paths) return [];
  try {
    const parsed: unknown = JSON.parse(row.resolved_paths);
    return Array.isArray(parsed) && parsed.every((p) => typeof p === "string")
      ? (parsed as string[])
      : [];
  } catch {
    return [];
  }
}

export function listReviews(runId: string, kind?: AssistKind): ReviewRow[] {
  return kind
    ? (db()
        .prepare(
          "SELECT * FROM run_reviews WHERE run_id = ? AND kind = ? ORDER BY created_at DESC",
        )
        .all(runId, kind) as ReviewRow[])
    : (db()
        .prepare("SELECT * FROM run_reviews WHERE run_id = ? ORDER BY created_at DESC")
        .all(runId) as ReviewRow[]);
}

/** The most recent one of a kind, which is what a card shows. */
export function latestAssist(runId: string, kind: AssistKind): ReviewRow | null {
  return listReviews(runId, kind)[0] ?? null;
}

/**
 * One by id, for a caller waiting on the invocation it started itself.
 *
 * `latestAssist` is the wrong tool for that: it answers "the newest one for
 * this run", which is a different row the moment anything else starts one.
 */
export function getAssist(id: string): ReviewRow | null {
  return (
    (db().prepare("SELECT * FROM run_reviews WHERE id = ?").get(id) as
      | ReviewRow
      | undefined) ?? null
  );
}

export function assistRunning(runId: string, kind: AssistKind): boolean {
  const row = db()
    .prepare(
      "SELECT COUNT(*) AS n FROM run_reviews WHERE run_id = ? AND kind = ? AND status = 'running'",
    )
    .get(runId, kind) as { n: number };
  return row.n > 0;
}

/**
 * Fail out review rows a restart left mid-flight.
 *
 * Same reasoning as `reconcileOnBoot` for runs: the child is gone with the
 * process that started it, and a row left saying `running` would spin a
 * progress indicator on the run page for ever. Called from
 * `instrumentation.ts` rather than from `reconcileOnBoot` itself, so that
 * `orchestrator.ts` does not have to import this module and close a cycle.
 */
export function reconcileReviewsOnBoot(): void {
  db()
    .prepare(
      "UPDATE run_reviews SET status='failed', finished_at=?," +
        " error='The server restarted while this review was running.'" +
        " WHERE status='running'",
    )
    .run(Date.now());
}

export type ReviewOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: string };

/**
 * Start a review, and return as soon as it is on its way.
 *
 * The child outlives the request: a review takes minutes, and holding an HTTP
 * connection open for it would fail behind any proxy. The row is the handle —
 * the page polls it, exactly as it polls the run.
 */
export async function startReview(runId: string): Promise<ReviewOutcome> {
  const run = getRun(runId);
  if (!run) return { ok: false, reason: "No such run." };
  if (assistRunning(runId, "review")) {
    return { ok: false, reason: "A review of this run is already running." };
  }

  const diff = await runDiff(runId);
  if (diff.kind === "none" || diff.files.length === 0) {
    return {
      ok: false,
      reason:
        diff.reason ??
        "There is no committed change to review, so a review would have nothing to read.",
    };
  }

  const refusal = await windowRefusal();
  if (refusal) return { ok: false, reason: refusal };

  const cwd = await reviewCwd(run);
  if (!cwd) {
    return {
      ok: false,
      reason: "This run's checkout and folder are both gone, so there is nowhere to run a review.",
    };
  }

  const { text, shown, truncated } = diffAsText(diff, REVIEW_DIFF_BYTES);

  return startAssist({
    run,
    kind: "review",
    cwd,
    // The one guarantee that a review cannot change the repository. Chosen over
    // an explicit `--disallowed-tools` list because a named mode survives a CLI
    // upgrade: a deny list has to grow an entry for every new write tool, and it
    // fails *open* when it does not.
    permissionMode: "plan",
    prompt: buildPrompt(run, diff, text),
    counts: { files: diff.files.length, shown, truncated },
  });
}

export interface AssistRequest {
  run: RunRow;
  kind: AssistKind;
  cwd: string;
  permissionMode: "plan" | "acceptEdits";
  prompt: string;
  counts?: { files: number; shown: number; truncated: boolean };
  /** The files this invocation is about, recorded on the row. Resolutions only. */
  paths?: string[];
  /**
   * Runs after the child exits and before the row is written, so a caller can
   * check what the agent actually did and downgrade a "completed" spawn to a
   * failure. A conflict resolution uses it to verify that no marker survived
   * and to commit the merge itself.
   */
  after?: (r: AssistResult) => Promise<Partial<AssistResult> | void>;
}

/**
 * Spawn one, record it, and return as soon as it is on its way.
 *
 * The child outlives the request: these take minutes, and holding an HTTP
 * connection open for one would fail behind any proxy. The row is the handle —
 * the page polls it, exactly as it polls the run.
 */
export function startAssist(req: AssistRequest): ReviewOutcome {
  const id = randomUUID();
  const now = Date.now();
  const counts = req.counts ?? { files: 0, shown: 0, truncated: false };

  db()
    .prepare(
      `INSERT INTO run_reviews
         (id, run_id, kind, created_at, status, model, diff_files, diff_shown,
          truncated, resolved_paths)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      req.run.id,
      req.kind,
      now,
      req.run.model,
      counts.files,
      counts.shown,
      counts.truncated ? 1 : 0,
      req.paths ? JSON.stringify(req.paths) : null,
    );

  emitRunEvent({
    runId: req.run.id,
    ts: now,
    kind: "review",
    payload: {
      reviewId: id,
      assist: req.kind,
      status: "running",
      files: counts.files,
      shown: counts.shown,
      truncated: counts.truncated,
    },
  });

  // Not awaited: it runs for minutes and the row is what reports on it.
  void spawnAssist(id, req).catch((err) => {
    finish(id, req.run.id, req.kind, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { ok: true, id };
}

/** Shared refusal: the operator's own window ceiling is already spent. */
export async function assistRefusal(): Promise<string | null> {
  return windowRefusal();
}

/**
 * Refuse a review when the operator's own ceiling is already spent.
 *
 * A review is not a work cycle and has no `BudgetPolicy` to read, so it is not
 * put through `evaluateBudget` — there is no per-run fraction to compare
 * against and inventing one would be a threshold the operator never set. What
 * it does check is the one thing that needs no configuration to mean something:
 * a window that is already at or over the ceiling *they* configured. With no
 * ceiling set there is nothing to compare and the review proceeds, which is the
 * same posture the meters take.
 *
 * `guardFraction`, not `fraction`: an unpriced model contributes $0 to the
 * displayed figure, and a guard that reads the display stops existing the week
 * a new model ships.
 */
async function windowRefusal(): Promise<string | null> {
  try {
    const snapshot = await currentSnapshot();
    const full = (f: number | null) => f !== null && f >= 1;
    const spent = full(snapshot.session.guardFraction)
      ? "5-hour"
      : full(snapshot.weekly.guardFraction)
        ? "weekly"
        : null;
    return spent
      ? `Your ${spent} window is already at the ceiling you set. A review spends ` +
          "against the same window, so it would push you further past it."
      : null;
  } catch {
    // An unreadable transcript directory is the dashboard's problem, not a
    // reason to refuse an action the operator explicitly asked for.
    return null;
  }
}

/**
 * The checkout the reviewer reads from.
 *
 * The run's own, but only while it still holds this run's branch: slots are
 * reused, so the directory a finished run worked in can be a later run's
 * checkout of an unrelated branch. Reading that one for context while reviewing
 * *this* diff is worse than reading the repository, because everything it says
 * looks like it is about the change.
 */
async function reviewCwd(run: RunRow): Promise<string | null> {
  const work = workDirOf(run);
  if (fs.existsSync(work)) {
    const head = await git(work, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!run.worktree_branch || head.stdout === run.worktree_branch) return work;
  }
  if (run.repo_root && fs.existsSync(run.repo_root)) return run.repo_root;
  return fs.existsSync(run.folder) ? run.folder : null;
}

/**
 * What the reviewer is told.
 *
 * The diff, the task the run was given, and how the run ended — not the event
 * log. The log is the process rather than the outcome, it is the largest thing
 * on the page by an order of magnitude, and a reviewer that reads how the agent
 * got there tends to review the journey. The task is the part the diff cannot
 * supply: without it there is no way to notice that the agent built something
 * else entirely.
 */
function buildPrompt(run: RunRow, diff: RunDiff, diffText: string): string {
  const ending = run.stop_reason
    ? `\nHow the run ended: ${run.stop_reason}\n`
    : "";
  const leftovers =
    diff.uncommitted.length > 0
      ? `\nUncommitted files left in the checkout (NOT part of the diff below, and not on the branch):\n${diff.uncommitted
          .slice(0, 40)
          .join("\n")}\n`
      : "";

  return [
    "You are reviewing the work an unattended Claude Code run committed to a git branch.",
    "Do not edit any files and do not run commands that change anything. You may read",
    "files in this checkout for context.",
    "",
    "The task the run was given:",
    "<task>",
    run.prompt,
    "</task>",
    ending,
    `Branch: ${diff.branch ?? "(unknown)"} — ${diff.filesChanged} file(s) changed, +${diff.added} −${diff.deleted}.`,
    leftovers,
    "The diff:",
    "<diff>",
    diffText,
    "</diff>",
    "",
    "Write the review in markdown, under exactly these three headings and nothing else:",
    "",
    "## Summary",
    "Two to four sentences. Say whether it actually addresses the task above.",
    "",
    "## Look at this first",
    "The two or three places a human should read before trusting this, most",
    "important first, each naming a file and why.",
    "",
    "## Risks",
    "Anything wrong, unfinished, unsafe, or untested. Be specific and name files.",
    "If nothing stands out, say so in one line rather than inventing something.",
  ].join("\n");
}

/** Spawn one, and record what it cost whatever happened. */
function spawnAssist(id: string, req: AssistRequest): Promise<void> {
  const { run, kind, cwd, prompt, permissionMode } = req;

  return new Promise((resolve) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      permissionMode,
    ];
    if (run.model) args.push("--model", run.model);

    // No shell, as everywhere else here: the prompt carries a diff, which is
    // arbitrary repository content full of quotes and backticks.
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: reviewEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: getSettings().killProcessGroup && process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c.slice(0, 4_096)));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalTree(child, "SIGTERM");
      setTimeout(() => signalTree(child, "SIGKILL"), 5_000).unref?.();
    }, REVIEW_TIMEOUT_MS);
    timer.unref?.();

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    /** `after` runs on every outcome, so a caller can always clean up. */
    const land = async (result: AssistResult) => {
      let final = result;
      if (req.after) {
        try {
          const patch = await req.after(result);
          if (patch) final = { ...final, ...patch };
        } catch (err) {
          final = {
            ...final,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      finish(id, run.id, kind, final);
      done();
    };

    child.on("error", (err) => {
      void land({
        status: "failed",
        error: `Could not launch ${CLAUDE_BIN}: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (timedOut) {
        void land({
          status: "failed",
          error: `It did not finish within ${REVIEW_TIMEOUT_MS / 60_000} minutes and was stopped.`,
        });
        return;
      }
      void land(parseReviewOutput(stdout, stderr, code));
    });
  });
}

/**
 * Environment for the reviewer.
 *
 * Same three exclusions the agent gets — this app's own configuration, any
 * inherited telemetry routing, and `DATA_DIR` — for the same reasons, the last
 * of them written out in full over `childEnv` in `orchestrator.ts`. A reviewer
 * runs `--permission-mode plan` and so cannot start a server itself, but the
 * exclusion is not conditional on that: what it withholds is the address of
 * this app's database, and there is no reading of a diff that needs it.
 * Telemetry is *not* turned back on for a review even when `telemetryForRuns`
 * is set: those records are keyed by run id and compared against the run's own
 * spend, and a review's requests appearing in that comparison would make an
 * accurate run look unaccounted-for.
 */
function reviewEnv(): NodeJS.ProcessEnv {
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
  return env;
}

export interface AssistResult {
  status: "completed" | "failed";
  text?: string;
  error?: string;
  costUSD?: number;
  tokens?: number;
  /** Set by `after` on a conflict resolution: the merge commit it made. */
  resolvedCommit?: string;
}

/**
 * Read the CLI's `--output-format json` object.
 *
 * Same field names the `stream-json` `result` event carries, from the same
 * pinned CLI build — `total_cost_usd` is the authoritative per-invocation cost
 * and is never re-derived from token counts, exactly as in the run loop.
 */
export function parseReviewOutput(
  stdout: string,
  stderr: string,
  code: number | null,
): AssistResult {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return {
      status: "failed",
      error:
        stderr.trim().split("\n").slice(-3).join(" ") ||
        `The review produced no readable output (exit ${code ?? "?"}).`,
    };
  }

  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;
  const tokens =
    n(usage.input_tokens) +
    n(usage.output_tokens) +
    n(usage.cache_creation_input_tokens) +
    n(usage.cache_read_input_tokens);
  const costUSD = n(parsed.total_cost_usd);
  const text = typeof parsed.result === "string" ? parsed.result : "";

  // Cost is recorded even for a refused or errored review: it was billed
  // whether or not it produced anything readable.
  if (parsed.is_error === true || (parsed.subtype && parsed.subtype !== "success")) {
    return {
      status: "failed",
      error: text || `The review failed (${String(parsed.subtype ?? "unknown")}).`,
      costUSD,
      tokens,
    };
  }
  if (!text) {
    return { status: "failed", error: "The review returned no text.", costUSD, tokens };
  }
  return { status: "completed", text, costUSD, tokens };
}

function finish(
  id: string,
  runId: string,
  kind: AssistKind,
  r: AssistResult,
): void {
  const now = Date.now();
  db()
    .prepare(
      "UPDATE run_reviews SET status=?, finished_at=?, text=?, error=?," +
        " cost_usd=?, tokens=?, resolved_commit=? WHERE id=?",
    )
    .run(
      r.status,
      now,
      r.text ?? null,
      r.error ?? null,
      r.costUSD ?? 0,
      r.tokens ?? 0,
      r.resolvedCommit ?? null,
      id,
    );

  emitRunEvent({
    runId,
    ts: now,
    kind: "review",
    payload: {
      reviewId: id,
      assist: kind,
      status: r.status,
      costUSD: r.costUSD ?? 0,
      ...(r.error ? { error: r.error } : {}),
    },
  });
}
