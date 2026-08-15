import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { CLAUDE_BIN } from "./config";
import { db } from "./db";
import { git } from "./git";
import { childCredentials } from "./privsep";
import { diffAsText, runDiff, type RunDiff } from "./diff";
import { agentsArgs, type AgentDefinition } from "./agents";
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

  // The whole door, not just the window: this call has taken no slot yet, and
  // the row `startAssist` is about to write is what fills one.
  const refusal = await assistRefusal();
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
   * Specialised agents this invocation may delegate to.
   *
   * **The one caller left on the plural flag, and deliberately not moved to the
   * singular one.** A run and an orchestrator block now *are* the agent they
   * name (`sessionAgentArgs`); this stays an offer, because a review is not a
   * run and has no operator-chosen role to take. What it is is fixed by this
   * module — `--permission-mode plan` so nothing it does can write, its own
   * prompt, and a cost that lands in `run_reviews` rather than `runs.spent_usd`
   * — and selecting somebody's saved agent here would replace exactly that.
   *
   * Nothing supplies this today: no caller of `startAssist` passes one, so a
   * review has never been given an agent at all. It is left as a parameter
   * rather than deleted because the question of whether a reviewer should be
   * choosable is a real one and this is where it would be answered; what it must
   * not do is gain a *selected* agent by default, which is why the singular
   * encoder is not reached from here.
   */
  agents?: AgentDefinition[];
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

/**
 * How many `claude` children that are not work cycles are alive right now.
 *
 * Three tables because there are three modules that spawn one, and each already
 * records its child's whole life in a row that a boot reconciler closes out:
 * `run_reviews` (a review and a conflict resolution), `chat_sessions` (a chat
 * turn) and `workflow_instance_blocks` (a block's deciding turn). Counting rows
 * rather than holding a number in this module is what makes the answer survive
 * the module boundaries — `chat.ts` and `workflows.ts` both import *this* file,
 * so neither can be imported back — and it is the same way every other
 * occupancy question here is answered, from `activeRuns()` down.
 *
 * `kind='orchestrator'` is load-bearing on the last one: a **merge** block takes
 * the identical `thinking` status from the identical `claimBlock`, and it spawns
 * no child at all. Counting it would refuse a chat turn to make room for a
 * process that does not exist.
 */
export function liveAssistChildren(): number {
  const row = db()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM run_reviews WHERE status='running')
            + (SELECT COUNT(*) FROM chat_sessions WHERE status='thinking')
            + (SELECT COUNT(*) FROM workflow_instance_blocks
                WHERE status='thinking' AND kind='orchestrator') AS n`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * The process-budget verdict, given a live count and a cap.
 *
 * Pure and separated from the query for `selectPromotable`'s reason: what it
 * decides is whether a billed child is spawned, and both ways of getting it
 * wrong are silent — an off-by-one refuses an operator's review for no visible
 * reason, and a `>` where `>=` belongs quietly restores the unbounded fleet this
 * exists to end. A null cap is the explicit opt-out and is not a shortage.
 *
 * The wording deliberately avoids "already at the ceiling", which is what
 * `mergeQueue`'s `refusesEveryResolution` matches on to skip the rest of a
 * repository's queue in one go. A spent window will refuse every later item
 * identically; a full budget is a slot somebody else is holding for a few
 * minutes, so the item behind it deserves its own turn to ask.
 */
export function assistBudgetRefusal(live: number, cap: number | null): string | null {
  if (cap === null || live < cap) return null;
  return (
    `${live} Claude ${live === 1 ? "process" : "processes"} outside a work cycle ` +
    `${live === 1 ? "is" : "are"} already running, which is the limit this ` +
    "container is set to carry. A review, a conflict resolution, a chat turn " +
    "and a workflow's deciding block share that budget — wait for one to " +
    "finish, or raise “Other Claude processes at the same time” in Settings."
  );
}

/** True when nothing more may be spawned outside a work cycle right now. */
export function assistBudgetFull(): boolean {
  return assistBudgetRefusal(liveAssistChildren(), getSettings().maxConcurrentAssists) !== null;
}

/**
 * The door for a caller that is about to **take** a slot outside a work cycle:
 * the process budget is full, or the operator's own window ceiling is spent.
 *
 * The budget goes first because it is a `COUNT` and `windowRefusal` is a full
 * transcript scan — and because the merge queue calls this once per item, so a
 * shortage that will refuse all of them must not cost a scan each time.
 *
 * Not for a caller that already holds its slot; that one wants `windowRefusal`
 * and the note above it says why.
 *
 * It is a check and not a claim: every caller here has an `await` between this
 * answer and the row that fills the slot, so two requests arriving in the same
 * tick can both pass a budget with one left. That is deliberate rather than
 * overlooked — this bounds host memory, not a folder, and the overshoot is the
 * number of requests in flight, where making it exact would mean a reservation
 * row and a way to release one that a crash could not strand. A block's turn is
 * exact anyway, because `advanceInstance` claims synchronously.
 */
export async function assistRefusal(): Promise<string | null> {
  const budget = assistBudgetRefusal(
    liveAssistChildren(),
    getSettings().maxConcurrentAssists,
  );
  if (budget) return budget;
  return windowRefusal();
}

/**
 * Refuse when the operator's own ceiling is already spent — and *only* that.
 *
 * Exported for the one caller that has taken its slot before it asks: a block's
 * deciding turn is claimed by `advanceInstance`, which is where the process
 * budget gates it, so its own row is already `thinking` and already counted by
 * the time `startBlockTurn` runs. Putting it through `assistRefusal` there would
 * have it refuse itself the moment the budget was exactly full — and, worse,
 * fail the block for it. Everything that has yet to take a slot wants
 * `assistRefusal`.
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
export async function windowRefusal(): Promise<string | null> {
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

/** How long `close` is given to deliver the last of stdout after the exit. */
const EXIT_DRAIN_MS = 2_000;

/**
 * Settle an assist on the child's `exit`, giving `close` a grace period first.
 *
 * `close` is the better signal — it means stdout has been fully drained — but
 * it fires only once every inherited pipe has shut, and the CLI's own children
 * hold those. A `claude` that leaves a grandchild behind has *exited* and will
 * never *close*, so an assist wired to `close` alone is stranded: `land` never
 * runs, the `run_reviews` row stays `running`, `assistRunning` then refuses
 * every further review or resolution for that run, and a resolution's throwaway
 * `<slug>-resolve` checkout is left registered mid-merge because `after` never
 * runs. With `killProcessGroup` on, the ten-minute timeout eventually reaps the
 * group and the completed, billed answer is recorded as a timeout — and for a
 * resolution, rolled back. With it off there is no group to kill and nothing
 * else reaps the grandchild, so the row is `running` until the server restarts.
 *
 * `runIteration` and `chat.ts`'s `settleOnExit` settle the identical hazard the
 * identical way: `exit` is the guarantee, `close` is the fast path, and the
 * grace period exists only so a normal exit flushes its last chunk through
 * `close` before anything is parsed. This is a copy of chat.ts's rather than an
 * import of it because `chat.ts` imports *this* module (`assistRefusal`), so
 * reaching back for it would put a cycle across a layer boundary for four
 * lines — the same reason `runIteration` carries its own.
 *
 * Exported for the same reason chat.ts's is: the shape it exists for — a child
 * that exits while a grandchild holds its stdout — is only reachable from a
 * test through this seam, since `spawnAssist` needs a database, a run row and
 * a real `claude`.
 */
export function settleOnExit(
  child: ChildProcess,
  settle: (code: number | null) => void,
): void {
  let done = false;
  const once = (code: number | null) => {
    if (done) return;
    done = true;
    settle(code);
  };

  child.on("exit", (code) => {
    setTimeout(() => once(code), EXIT_DRAIN_MS).unref?.();
  });
  child.on("close", (code) => once(code));
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
    // One encoder for all four spawn sites — every way of getting this shape
    // wrong is silent, so there is one place that knows it.
    args.push(...agentsArgs(req.agents ?? []));

    // No shell, as everywhere else here: the prompt carries a diff, which is
    // arbitrary repository content full of quotes and backticks.
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: reviewEnv(),
      // Dropped like every other child. A reviewer cannot write, but it reads a
      // diff out of a repository and is no more trusted than the run it reviews.
      ...childCredentials(),
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
      clearTimeout(timer);
      resolve();
    };

    /**
     * `after` runs on every outcome, so a caller can always clean up.
     *
     * The latch is on `land` rather than on `done` because `land` is what
     * writes the row and runs `after`: a resolution that committed a merge and
     * then discarded its checkout must not do either twice. It is set before
     * the first `await` for the same reason — `settleOnExit` can be followed by
     * a late `close`, and `child.on("error")` can arrive alongside either,
     * while `after` is still running.
     */
    const land = async (result: AssistResult) => {
      if (settled) return;
      settled = true;
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

    settleOnExit(child, (code) => {
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

  wakeDeferredBlocks();
}

/**
 * Advance every workflow, because this row just gave a slot back.
 *
 * A block's deciding turn is deferred rather than refused when
 * `assistBudgetFull()`, so it is left `waiting` for the next advance — and
 * `settleBlock`'s own advance only covers a slot that a *block* freed. Without
 * this, a review holding the last slot would strand that block until something
 * else in the app happened to finish, which is the "row that sits waiting for
 * ever" the whole dependency design has none of.
 *
 * Imported dynamically for `releaseDependents`' reason: `workflows.ts` imports
 * this module, so reaching back for it statically would close a cycle. Not
 * awaited — the advance is its own synchronous pass in a later turn.
 */
function wakeDeferredBlocks(): void {
  void import("./workflows")
    .then((m) => m.advanceInstances())
    .catch(() => {
      /* a workflow that cannot be advanced is not a reason to fail an assist */
    });
}
