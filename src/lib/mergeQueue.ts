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
import { dataDirRefusal, mayWriteDataDir } from "./serverLock";
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

/**
 * Whether the worker still owes this row an answer.
 *
 * Exported so a caller waiting on a batch — a workflow's merge block — asks this
 * rather than keeping its own list of which statuses are terminal. A second copy
 * of that list is a caller that stops waiting one status too early, or never.
 */
export const isQueueActive = (status: QueueStatus): boolean =>
  ACTIVE.includes(status);

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
/* Which batches the page covers — pure, and tested                    */
/* ------------------------------------------------------------------ */

/** One batch as the selection sees it: when it was queued, and whether it is done with. */
export interface BatchSummary {
  batchId: string;
  createdAt: number;
  /** At least one row the worker still owes an answer for. */
  unfinished: boolean;
}

/**
 * How many finished batches stay on the page once nothing in them is outstanding.
 *
 * The page used to show exactly one — the newest — which is both too few and the
 * wrong one: queue a second repository's branches and the first repository's
 * report of what landed went with it. Three is a working session's worth of
 * "how did each of those go" without turning the panel into a log of every merge
 * this install has ever made.
 */
const FINISHED_TAIL = 3;

/**
 * Which batches the queue view covers, oldest first.
 *
 * **Every unfinished batch, whatever else is queued.** The worker drains the
 * whole table rather than one batch, so a batch that scrolled off the page kept
 * merging into the operator's own checkout with nothing on screen naming it —
 * and `cancelBatch` is scoped by `batch_id`, so a batch the page cannot name is
 * a batch the operator cannot stop. That is the whole of this function's reason
 * to exist, and it is why the cap below applies to *finished* batches only:
 * bounding the outstanding ones would reintroduce exactly that.
 *
 * A batch is kept **whole** rather than trimmed to its unfinished rows, because
 * what the panel reports is progress — "2 landed · 3 waiting" is a sentence
 * about a batch, and dropping the landed rows would make a batch half-way
 * through look like one that had not started.
 *
 * Oldest first, `batch_id` breaking a tie, which is `nextQueued`'s own ordering:
 * two batches can share a millisecond, a workflow instance releasing its merge
 * blocks in one synchronous pass being the reachable case. Nothing about that
 * tie is the operator's order, but a list that reshuffles between two polls of
 * the same unchanged queue is nobody's.
 *
 * Pure and total, separated from the SQL for `planItem`'s reason: both ways of
 * being wrong are silent. A batch left out is a set of merges in flight with no
 * way to see or stop them; too many kept is a panel that grows without bound.
 */
export function selectQueueBatches(
  batches: readonly BatchSummary[],
  finishedTail: number,
): BatchSummary[] {
  const ordered = [...batches].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0),
  );
  const finished = ordered.filter((b) => !b.unfinished);
  const tail = new Set(
    finished
      .slice(Math.max(0, finished.length - Math.max(0, finishedTail)))
      .map((b) => b.batchId),
  );
  return ordered.filter((b) => b.unfinished || tail.has(b.batchId));
}

/* ------------------------------------------------------------------ */
/* Reading and writing the queue                                       */
/* ------------------------------------------------------------------ */

export function batchRows(batchId: string): QueueRow[] {
  return db()
    .prepare("SELECT * FROM merge_queue WHERE batch_id = ? ORDER BY position")
    .all(batchId) as QueueRow[];
}

/** A batch and its rows, in the operator's own order within it. */
export interface QueueBatch {
  batchId: string;
  createdAt: number;
  rows: QueueRow[];
}

/**
 * What the page shows: every outstanding batch, and a short tail of finished ones.
 *
 * The summaries are read first and the rows only for the batches that survive
 * `selectQueueBatches`, so nothing here reads a table that grows by one row per
 * branch ever landed. The status test is built from `ACTIVE` rather than spelled
 * out, so "unfinished" means here what `isQueueActive` means everywhere else.
 */
export function queueView(): QueueBatch[] {
  const marks = ACTIVE.map(() => "?").join(",");
  const summaries = (
    db()
      .prepare(
        `SELECT batch_id AS batchId, MIN(created_at) AS createdAt,
                MAX(CASE WHEN status IN (${marks}) THEN 1 ELSE 0 END) AS unfinished
           FROM merge_queue GROUP BY batch_id`,
      )
      .all(...ACTIVE) as { batchId: string; createdAt: number; unfinished: number }[]
  ).map((s) => ({ ...s, unfinished: s.unfinished === 1 }));

  const chosen = selectQueueBatches(summaries, FINISHED_TAIL);
  if (chosen.length === 0) return [];

  const rows = db()
    .prepare(
      `SELECT * FROM merge_queue WHERE batch_id IN (${chosen.map(() => "?").join(",")})
        ORDER BY position`,
    )
    .all(...chosen.map((b) => b.batchId)) as QueueRow[];

  const byBatch = new Map(chosen.map((b) => [b.batchId, [] as QueueRow[]]));
  for (const row of rows) byBatch.get(row.batch_id)?.push(row);
  return chosen.map((b) => ({
    batchId: b.batchId,
    createdAt: b.createdAt,
    rows: byBatch.get(b.batchId) ?? [],
  }));
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
 * sorts. That index is per batch and restarts at 0, so it says nothing about
 * one batch against another — what orders those is `created_at`, which is why
 * every row of a batch carries the one timestamp. `nextQueued` is where the two
 * are read together. Validation is structural only — that a run has a branch at all, and
 * that it is not already queued. Whether it *can* be landed is deliberately not
 * decided here: the queue exists precisely because that answer changes as the
 * branches ahead of it land, and pre-judging it would refuse branches that
 * would have been fine by their turn.
 */
export function enqueue(
  runIds: string[],
  opts: { strategy: LandStrategy; autoResolve: boolean },
): EnqueueOutcome {
  // A merge writes into a directory the operator also works in, and one worker
  // per process is the whole of what keeps the queue sequential — two processes
  // draining one table is two merges in one checkout. Refused at the door,
  // where the answer is a sentence the page already renders.
  const notOwner = dataDirRefusal();
  if (notOwner) return { ok: false, reason: notOwner };

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
 * Cancel the queued merges belonging to these runs, whichever batch they are in.
 *
 * The same rule `cancelBatch` follows and for the same reason: the row *in
 * flight* is left alone, because a merge is a multi-step write into the
 * operator's own checkout and a resolution is a child process holding one, and
 * interrupting either part-way is worse than the second it takes to finish.
 * What differs is the selection — a workflow instance being halted knows its
 * runs, not which batch someone queued their branches in, and a batch may hold
 * branches from other work that has nothing to do with the halt.
 *
 * An empty list is answered with 0 rather than built into `IN ()`, which SQLite
 * refuses outright.
 */
export function cancelQueuedFor(
  runIds: readonly string[],
  message: string,
): number {
  if (runIds.length === 0) return 0;
  const res = db()
    .prepare(
      "UPDATE merge_queue SET status='cancelled', message=?, finished_at=?" +
        ` WHERE status = 'queued' AND run_id IN (${runIds.map(() => "?").join(",")})`,
    )
    .run(message, Date.now(), ...runIds);
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

/**
 * The next branch to land, across every batch.
 *
 * `position` is the operator's order *within* one batch and restarts at 0 for
 * the next one, so ordering by it first interleaved a batch queued while the
 * worker was still draining an earlier one: A0, B0, A1, B1, A2, with B's first
 * branch merging into the operator's checkout between two of A's. What decided
 * the order across batches was then the accident of how many rows the earlier
 * one had. `created_at` first drains each batch whole and keeps the operator's
 * order inside it, which is what this queue has always claimed to do.
 *
 * `batch_id` breaks the tie between two batches sharing a millisecond, which is
 * reachable rather than theoretical: a workflow instance releases its merge
 * blocks in one synchronous pass, so two of them call `enqueue` on the same
 * `Date.now()`. Which of those two goes first is arbitrary — nothing can make
 * it the operator's order, because they were queued at the same instant — but
 * that they do not interleave is not.
 *
 * Exported for the test that pins this sequence. The decision is the SQL, so
 * anything short of running the query would be a second copy of it, and the
 * copy is the one that would stay right.
 */
export function nextQueued(): QueueRow | null {
  return (
    (db()
      .prepare(
        "SELECT * FROM merge_queue WHERE status='queued'" +
          " ORDER BY created_at, batch_id, position LIMIT 1",
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
  // `enqueue` already refuses, so nothing this process queued can be here — but
  // the table is shared, and draining a row another server queued is this
  // process merging into a checkout it was never told about.
  if (!mayWriteDataDir()) return;
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
