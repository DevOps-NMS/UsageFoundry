import { randomUUID } from "node:crypto";
import { db } from "./db";
import {
  landRun,
  landState,
  resolveConflicts,
  type LandState,
  type LandStrategy,
} from "./land";
import { getAssist } from "./review";
import { getRun, type RunRow } from "./orchestrator";

/**
 * Landing several branches, one after another.
 *
 * This reverses a decision the rest of the codebase states outright — "several
 * branches is several merges, and each one changes the base for the next, so it
 * is one button per run" — and it only gets to do that by keeping what that
 * decision protected:
 *
 *   - **Exactly one merge is in flight.** Not a batch, a queue. The worker is a
 *     single sequential loop and there is one of it per process.
 *   - **Every item is re-previewed against git immediately before its own
 *     merge.** Each landing changes the base for the next, so an answer worked
 *     out when the queue was made is worthless by the second item. Nothing here
 *     trusts what the page showed; `landRun` re-derives the whole `LandState`
 *     and refuses on its own reading.
 *   - **A conflict still costs the operator's checkout nothing.** It is resolved
 *     on the run's branch in an isolated checkout, exactly as the single-run
 *     path does it, and a failed merge is aborted and rolled back before the
 *     queue moves on.
 *   - **A problem with the checkout itself stops that repository.** A dirty tree
 *     or a HEAD on the wrong branch will refuse every remaining branch in the
 *     same repository for the same reason, and reporting that ten times is
 *     noise. The rest are marked skipped, once, with the reason.
 *
 * **It spends money, and that is the whole reason `auto_resolve` is a per-batch
 * flag on every row rather than a setting.** `review.ts` says nothing automatic
 * may reach it, because spend nobody asked for is spend nobody authorised —
 * queueing with the box ticked *is* that authorisation, and it is recorded next
 * to the work it authorised rather than read from configuration that could have
 * changed since.
 */

export type QueueStatus =
  | "queued"
  | "landing"
  | "resolving"
  | "landed"
  | "failed"
  /** Not attempted: the queue gave up on this repository, or it was cancelled. */
  | "skipped"
  | "cancelled";

export interface QueueRow {
  id: string;
  batch_id: string;
  run_id: string;
  position: number;
  strategy: string;
  auto_resolve: number;
  status: QueueStatus;
  message: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  resolve_cost: number;
}

/** Statuses that mean this row still expects the worker to touch it. */
const ACTIVE: QueueStatus[] = ["queued", "landing", "resolving"];

/** How long the worker waits for one conflict resolution to settle. */
const RESOLVE_TIMEOUT_MS = 12 * 60_000;
/** How often it looks. The row is written by a child process, not by us. */
const RESOLVE_POLL_MS = 2_000;

/* ------------------------------------------------------------------ */
/* Deciding what to do with one item — pure, and tested                */
/* ------------------------------------------------------------------ */

export type ItemPlan =
  /** Land it now. */
  | { action: "land" }
  /** It conflicts, and a resolution is authorised and possible. */
  | { action: "resolve" }
  /** This branch cannot be landed; the ones behind it still can. */
  | { action: "fail"; reason: string }
  /** Nothing in this repository can be landed until a person intervenes. */
  | { action: "halt"; reason: string };

/**
 * What the worker should do with one queued branch.
 *
 * Separated from everything that touches git or spawns a child for the same
 * reason `landRefusal` is: this decides whether to write into a directory a
 * person owns, and whether to spend their money doing it.
 *
 * The checkout is tested **before** the conflict, which is the one place this
 * deliberately disagrees with `landRefusal`'s ordering. That function answers
 * "why can this not be landed", where naming the conflict first is right — it
 * is the fact about *this branch*. This one answers "what should happen next",
 * and paying a model to reconcile a branch into a checkout that is going to
 * refuse the merge anyway is money spent on nothing.
 */
export function planItem(
  state: LandState | null,
  opts: { autoResolve: boolean; resolutionsRefused: string | null },
): ItemPlan {
  if (!state) return { action: "fail", reason: "This run has no branch to land." };
  if (state.blocked === null) return { action: "land" };

  // Anything wrong with the checkout refuses every branch in this repository
  // identically, so it stops the repository rather than this row.
  if (state.branchExists && state.target && !isRunActive(state.runStatus)) {
    const checkout = state.checkout;
    if (!checkout) {
      return { action: "halt", reason: "Its folder is no longer inside a workspace mount." };
    }
    if (!checkout.readable) {
      return { action: "halt", reason: "Could not read the checkout's status." };
    }
    if (checkout.dirty) {
      return {
        action: "halt",
        reason: "The checkout has uncommitted changes — commit or stash them first.",
      };
    }
    if (checkout.headBranch !== state.target) {
      return {
        action: "halt",
        reason: `The checkout is on ${checkout.headBranch ?? "a detached HEAD"} rather than ${state.target}.`,
      };
    }
  }

  if (state.preview.outcome === "conflict") {
    if (!opts.autoResolve) return { action: "fail", reason: state.blocked };
    if (opts.resolutionsRefused) {
      return {
        action: "fail",
        reason: `It conflicts, and no resolution was attempted: ${opts.resolutionsRefused}`,
      };
    }
    return { action: "resolve" };
  }

  return { action: "fail", reason: state.blocked };
}

const isRunActive = (status: RunRow["status"]) =>
  status === "running" || status === "queued" || status === "paused";

/* ------------------------------------------------------------------ */
/* Reading and writing the queue                                       */
/* ------------------------------------------------------------------ */

export function batchRows(batchId: string): QueueRow[] {
  return db()
    .prepare("SELECT * FROM merge_queue WHERE batch_id = ? ORDER BY position")
    .all(batchId) as QueueRow[];
}

/** The most recent batch, which is the one the page shows. */
export function latestBatch(): QueueRow[] {
  const row = db()
    .prepare("SELECT batch_id FROM merge_queue ORDER BY created_at DESC LIMIT 1")
    .get() as { batch_id: string } | undefined;
  return row ? batchRows(row.batch_id) : [];
}

/** Run ids with a row the worker still expects to touch. */
export function queuedRunIds(): Set<string> {
  const rows = db()
    .prepare(
      `SELECT run_id FROM merge_queue WHERE status IN (${ACTIVE.map(() => "?").join(",")})`,
    )
    .all(...ACTIVE) as { run_id: string }[];
  return new Set(rows.map((r) => r.run_id));
}

export type EnqueueOutcome =
  | { ok: true; batchId: string; queued: number }
  | { ok: false; reason: string };

/**
 * Put branches in the queue, in the order they were given.
 *
 * The order is the operator's and is recorded as `position`; nothing here
 * sorts. Validation is structural only — that a run has a branch at all, and
 * that it is not already queued. Whether it *can* be landed is deliberately not
 * decided here: the queue exists precisely because that answer changes as the
 * branches ahead of it land, and pre-judging it would refuse branches that
 * would have been fine by their turn.
 */
export function enqueue(
  runIds: string[],
  opts: { strategy: LandStrategy; autoResolve: boolean },
): EnqueueOutcome {
  const already = queuedRunIds();
  const seen = new Set<string>();
  const items: RunRow[] = [];

  for (const id of runIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    const run = getRun(id);
    if (!run) return { ok: false, reason: `No run ${id.slice(0, 8)}.` };
    if (run.isolation !== "worktree" || !run.worktree_branch || !run.repo_root) {
      return { ok: false, reason: `Run ${id.slice(0, 8)} has no branch to land.` };
    }
    if (already.has(id)) {
      return {
        ok: false,
        reason: `${run.worktree_branch} is already in the queue.`,
      };
    }
    items.push(run);
  }

  if (items.length === 0) return { ok: false, reason: "Nothing was selected." };

  const batchId = randomUUID();
  const now = Date.now();
  const insert = db().prepare(
    `INSERT INTO merge_queue
       (id, batch_id, run_id, position, strategy, auto_resolve, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
  );
  items.forEach((run, i) => {
    insert.run(
      randomUUID(),
      batchId,
      run.id,
      i,
      opts.strategy,
      opts.autoResolve ? 1 : 0,
      now,
    );
  });

  void startWorker();
  return { ok: true, batchId, queued: items.length };
}

/**
 * Stop a batch that has not finished.
 *
 * The row in flight is left alone. A merge is a multi-step write into a
 * directory a person works in and a resolution is a child process holding a
 * checkout; interrupting either part-way is worse than the second or two it
 * takes to finish, and both already clean up after themselves.
 */
export function cancelBatch(batchId: string): number {
  const res = db()
    .prepare(
      "UPDATE merge_queue SET status='cancelled', message=?, finished_at=?" +
        " WHERE batch_id = ? AND status = 'queued'",
    )
    .run("Cancelled before it started.", Date.now(), batchId);
  return res.changes;
}

/**
 * Close out rows a restart left behind.
 *
 * Queued rows are **cancelled rather than resumed**, which is the same rule
 * `reconcileOnBoot` applies to queued runs and for a stronger reason: this one
 * writes into the operator's own checkout. A server coming back up and quietly
 * merging four branches into the tree someone is working in is the one thing a
 * queue must never do by itself.
 *
 * A row that was mid-merge is marked failed without a guess about what
 * happened. The merge either completed or was rolled back, and `landState` will
 * say which from git the next time anyone asks — inventing an answer here would
 * be a claim about a write this process did not see finish.
 */
export function reconcileMergeQueueOnBoot(): void {
  const now = Date.now();
  db()
    .prepare(
      "UPDATE merge_queue SET status='failed', message=?, finished_at=?" +
        " WHERE status IN ('landing','resolving')",
    )
    .run(
      "The server restarted while this was landing. Check the branch before queueing it again.",
      now,
    );
  db()
    .prepare(
      "UPDATE merge_queue SET status='cancelled', message=?, finished_at=?" +
        " WHERE status = 'queued'",
    )
    .run("The server restarted. Queued merges are never resumed on their own.", now);
}

/* ------------------------------------------------------------------ */
/* The worker                                                          */
/* ------------------------------------------------------------------ */

/** `globalThis` for the reason every other long-lived map here uses it. */
const worker = ((globalThis as unknown as { __ufMergeWorker?: { running: boolean } })
  .__ufMergeWorker ??= { running: false });

export const isWorking = () => worker.running;

function nextQueued(): QueueRow | null {
  return (
    (db()
      .prepare(
        "SELECT * FROM merge_queue WHERE status='queued' ORDER BY position, created_at LIMIT 1",
      )
      .get() as QueueRow | undefined) ?? null
  );
}

function setStatus(
  id: string,
  status: QueueStatus,
  fields: { message?: string | null; resolveCost?: number } = {},
): void {
  const done = status !== "landing" && status !== "resolving";
  db()
    .prepare(
      "UPDATE merge_queue SET status=?, message=COALESCE(?, message)," +
        " started_at=COALESCE(started_at, ?), finished_at=?, resolve_cost=COALESCE(?, resolve_cost)" +
        " WHERE id=?",
    )
    .run(
      status,
      fields.message ?? null,
      Date.now(),
      done ? Date.now() : null,
      fields.resolveCost ?? null,
      id,
    );
}

/**
 * Work the queue until it is empty, one branch at a time.
 *
 * Not awaited by the caller: a queue with a conflict in it runs for minutes,
 * and the rows are what report on it — the page polls them, exactly as it polls
 * a run.
 */
export async function startWorker(): Promise<void> {
  if (worker.running) return;
  worker.running = true;

  /** Repositories the queue has given up on, and why. */
  const halted = new Map<string, string>();
  /** Set once a resolution is refused for a reason the next one will hit too. */
  let resolutionsRefused: string | null = null;

  try {
    for (let row = nextQueued(); row; row = nextQueued()) {
      const run = getRun(row.run_id);
      if (!run) {
        setStatus(row.id, "failed", { message: "That run no longer exists." });
        continue;
      }

      const repo = run.repo_root ?? run.folder;
      const halt = halted.get(repo);
      if (halt) {
        setStatus(row.id, "skipped", { message: `Not attempted — ${halt}` });
        continue;
      }

      setStatus(row.id, "landing");
      const outcome = await processOne(row, {
        autoResolve: row.auto_resolve === 1,
        resolutionsRefused,
      });

      if (outcome.halt) halted.set(repo, outcome.message);
      if (outcome.refusedResolutions) resolutionsRefused = outcome.refusedResolutions;
      setStatus(row.id, outcome.status, {
        // The prefix is added here and nowhere else. `processOne` returns the
        // bare reason because the same string is also what every row behind
        // this one is told, and prefixing it twice reads as a stutter.
        message: outcome.halt ? `Not attempted — ${outcome.message}` : outcome.message,
        resolveCost: outcome.resolveCost,
      });
    }
  } finally {
    worker.running = false;
  }

  // A row queued while the loop was draining its last item would otherwise wait
  // for the next enqueue. Cheap to check, and the alternative is a queue that
  // stalls for no visible reason.
  if (nextQueued()) void startWorker();
}

interface ItemOutcome {
  status: QueueStatus;
  message: string;
  halt?: boolean;
  refusedResolutions?: string;
  resolveCost?: number;
}

/** One branch: decide, resolve if that was authorised, then land. */
async function processOne(
  row: QueueRow,
  opts: { autoResolve: boolean; resolutionsRefused: string | null },
): Promise<ItemOutcome> {
  const plan = planItem(await landState(row.run_id), opts);

  if (plan.action === "halt") return { status: "skipped", message: plan.reason, halt: true };
  if (plan.action === "fail") return { status: "failed", message: plan.reason };

  let resolveCost = 0;
  if (plan.action === "resolve") {
    setStatus(row.id, "resolving");
    const resolved = await resolveWithClaude(row.run_id);
    resolveCost = resolved.costUSD;

    if (!resolved.ok) {
      return {
        status: "failed",
        message: resolved.reason,
        resolveCost,
        // A window already at its ceiling refuses every later resolution
        // identically, and each attempt costs a full transcript scan to find
        // that out again.
        ...(resolved.refusesEveryResolution
          ? { refusedResolutions: resolved.reason }
          : {}),
      };
    }
  }

  const landed = await landRun(row.run_id, row.strategy as LandStrategy);
  if (landed.ok) {
    return {
      status: "landed",
      message:
        resolveCost > 0 ? `${landed.message} Conflicts were resolved first.` : landed.message,
      resolveCost,
    };
  }
  return { status: "failed", message: landed.reason, resolveCost };
}

interface ResolveOutcome {
  ok: boolean;
  reason: string;
  costUSD: number;
  /** True when the refusal will apply just as much to every later item. */
  refusesEveryResolution?: boolean;
}

/**
 * Ask Claude to reconcile this branch, and wait for it.
 *
 * `resolveConflicts` returns as soon as the child is on its way, so the wait is
 * on the `run_reviews` row it created — the same row the run page polls. Cost is
 * read off it whatever the outcome, because it was billed either way.
 */
async function resolveWithClaude(runId: string): Promise<ResolveOutcome> {
  const started = await resolveConflicts(runId);
  if (!started.ok) {
    return {
      ok: false,
      reason: started.reason,
      costUSD: 0,
      // The one refusal that is about the operator's window rather than about
      // this branch. Worded by `assistRefusal`, matched on the part of it that
      // is not a branch name.
      refusesEveryResolution: /already at the ceiling/.test(started.reason),
    };
  }
  // A preview that had gone stale: the branches agreed after all and no child
  // was spawned. Nothing to wait for and nothing was billed.
  if (!started.assistId) return { ok: true, reason: started.message, costUSD: 0 };

  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  for (;;) {
    const assist = getAssist(started.assistId);
    if (!assist) {
      return { ok: false, reason: "Its resolution disappeared before it finished.", costUSD: 0 };
    }
    if (assist.status !== "running") {
      return assist.status === "completed"
        ? { ok: true, reason: assist.text ?? "", costUSD: assist.cost_usd }
        : {
            ok: false,
            reason: assist.error ?? "The conflict resolution failed.",
            costUSD: assist.cost_usd,
          };
    }
    if (Date.now() > deadline) {
      return {
        ok: false,
        reason: "Its conflict resolution did not finish in time.",
        costUSD: assist.cost_usd,
      };
    }
    await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
  }
}
