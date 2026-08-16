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
 *   - **Exactly one merge is in flight per repository.** Not a batch, a queue.
 *     A worker is a single sequential loop and there is one of them per
 *     repository — never two, which is the invariant the whole module rests on
 *     and the one thing a reader of `startWorker` has to keep true.
 *   - **Every item is re-previewed against git immediately before its own
 *     merge.** Each landing changes the base for the next, so an answer worked
 *     out when the queue was made is worthless by the second item. Nothing here
 *     trusts what the page showed; `landRun` re-derives the whole `LandState`
 *     and refuses on its own reading. That sentence is true of two branches in
 *     one repository and false of two branches in different ones, which is why
 *     the repository is the unit of serialisation rather than the process:
 *     draining every repository through one loop meant a twelve-minute conflict
 *     resolution in one of them held every clean branch in all the others.
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

/**
 * How often the worker looks. The row is written by a child process, not by us.
 *
 * There is deliberately no deadline beside it. A resolution is a step in
 * merging a branch and the only thing that can honestly end one is the
 * resolution itself: giving up at twelve minutes failed the item, and the row
 * then said the branch could not be merged when what had actually happened was
 * that this loop stopped watching — while the child carried on spending, and
 * `after` committed or rolled back a merge nothing was waiting for any more.
 * The escapes are unchanged and each is somebody's decision rather than a
 * clock's: the resolution settles either way, `cancelBatch` takes the rest of
 * the queue, and the process ending ends the child with it.
 */
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
 * One, and the number is only defensible because the ones it drops are now
 * *reachable*. It was three, and three was chosen when a finished batch that
 * left this answer left the app entirely: the page had shown exactly one — the
 * newest — so queueing a second repository's branches took the first
 * repository's report of what landed with it, and a short tail was the cheapest
 * way to stop that. The tail was never the point, though; it only moved the
 * cliff. A batch is as many rows as branches were selected, so three of them is
 * routinely thirty rows of finished work standing permanently above the branch
 * table (measured on a live install: 1 + 10 + 21), and the fourth batch back
 * was still gone for good.
 *
 * `selectHistoryBatches` is the other half and is what makes one enough: every
 * finished batch this drops is behind a disclosure on the same card rather than
 * discarded. The panel opens on what is happening now — every outstanding batch,
 * whatever else is queued, plus the last thing that finished — and the log of
 * how each earlier press of Land went is one press away.
 */
const FINISHED_TAIL = 1;

/**
 * How far back the history disclosure reads.
 *
 * `merge_queue` gains a row per branch ever queued and nothing prunes it, so the
 * *rows* have to be bounded somewhere or opening this reads the whole table.
 * The summaries do not: they are one `GROUP BY` that carries no row payload,
 * which is what lets the card state how many earlier batches exist even when it
 * has only read twenty of them. Twenty is a working month rather than a working
 * session — this is the log, so it should reach past the tail the panel drops.
 */
const MAX_HISTORY_BATCHES = 20;

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
  const ordered = orderBatches(batches);
  const tail = tailIds(ordered, finishedTail);
  return ordered.filter((b) => b.unfinished || tail.has(b.batchId));
}

/**
 * The finished batches `selectQueueBatches` leaves out, newest first.
 *
 * The two are one decision read from both ends, which is why they share
 * `orderBatches` and `tailIds` rather than each deciding for itself what the
 * tail is: a batch that fell out of one and did not appear in the other would
 * be a press of Land with no record anywhere in the app, and the operator's
 * only sign of it would be a merge commit in a directory they own.
 *
 * An **unfinished** batch is never here, however old it is. It is on the panel
 * by `selectQueueBatches`' rule, and the disclosure below it is closed by
 * default — a batch still merging into somebody's checkout must not be
 * something they have to open a history to find.
 *
 * Newest first, which is the one place this app orders batches that way and it
 * is deliberate: the panel above is drain order, because what is at the top is
 * what lands next, and nothing here is going to drain. Reading a log oldest
 * first means scrolling past a month to reach yesterday.
 */
export function selectHistoryBatches(
  batches: readonly BatchSummary[],
  finishedTail: number,
): BatchSummary[] {
  const ordered = orderBatches(batches);
  const tail = tailIds(ordered, finishedTail);
  return ordered
    .filter((b) => !b.unfinished && !tail.has(b.batchId))
    .reverse();
}

/** Oldest first, `batch_id` breaking a shared instant. */
function orderBatches(batches: readonly BatchSummary[]): BatchSummary[] {
  return [...batches].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0),
  );
}

/** The ids of the newest `n` finished batches, given an ordered list. */
function tailIds(ordered: BatchSummary[], n: number): Set<string> {
  const finished = ordered.filter((b) => !b.unfinished);
  return new Set(
    finished.slice(Math.max(0, finished.length - Math.max(0, n))).map((b) => b.batchId),
  );
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
 * One summary per batch: when it was queued, and whether the worker still owes
 * it an answer.
 *
 * The one scan both readers below share. It carries no row payload, which is
 * what lets the card state how many earlier batches exist without reading any
 * of them. The status test is built from `ACTIVE` rather than spelled out, so
 * "unfinished" means here what `isQueueActive` means everywhere else.
 */
function batchSummaries(): BatchSummary[] {
  const marks = ACTIVE.map(() => "?").join(",");
  return (
    db()
      .prepare(
        `SELECT batch_id AS batchId, MIN(created_at) AS createdAt,
                MAX(CASE WHEN status IN (${marks}) THEN 1 ELSE 0 END) AS unfinished
           FROM merge_queue GROUP BY batch_id`,
      )
      .all(...ACTIVE) as { batchId: string; createdAt: number; unfinished: number }[]
  ).map((s) => ({ ...s, unfinished: s.unfinished === 1 }));
}

/**
 * The rows of the given batches, keeping the order they were handed in.
 *
 * The batch order is the caller's — drain order for the panel, newest first for
 * the history — and `position` is the operator's own order *within* a batch,
 * which is the one thing neither caller may reorder.
 */
function rowsFor(chosen: BatchSummary[]): QueueBatch[] {
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

/**
 * What the panel shows: every outstanding batch, and the last one that finished.
 *
 * The summaries are read first and the rows only for the batches that survive
 * `selectQueueBatches`, so nothing here reads a table that grows by one row per
 * branch ever landed.
 */
export function queueView(): QueueBatch[] {
  return rowsFor(selectQueueBatches(batchSummaries(), FINISHED_TAIL));
}

/** The earlier presses of Land, and how many of them there are. */
export interface QueueHistory {
  /** Newest first, and empty unless the rows were asked for. */
  batches: QueueBatch[];
  /** How many earlier batches exist, whether or not their rows were read. */
  total: number;
}

/**
 * The finished batches the panel is not showing.
 *
 * `withRows` is the whole reason this is one function rather than two: the count
 * is what the closed disclosure needs and it costs one `GROUP BY`, where the
 * rows are what the open one needs and cost a read bounded by
 * `MAX_HISTORY_BATCHES`. The card polls every three seconds while the queue is
 * working, so the closed case has to stay the cheap one.
 *
 * `total` counts every earlier batch and not only the ones read, because a
 * history that silently stopped at twenty would read exactly like an install
 * that had only ever pressed Land twenty times.
 */
export function queueHistory(withRows: boolean): QueueHistory {
  const older = selectHistoryBatches(batchSummaries(), FINISHED_TAIL);
  return {
    batches: withRows ? rowsFor(older.slice(0, MAX_HISTORY_BATCHES)) : [],
    total: older.length,
  };
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

  startWorker();
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

/**
 * Repositories a worker is draining right now, and what this drain has learned.
 *
 * `globalThis` for the reason every other long-lived map here uses it.
 *
 * **The set is the mutual exclusion.** A repository is added before any `await`
 * and removed in a `finally`, so between reading the list of repositories with
 * work and claiming them there is no suspension point and no way for two calls
 * to `startWorker` to both take one. That is the whole of what stops two merges
 * going into one working tree from this side; `landing` in `land.ts` is the
 * other half and is unchanged, because it also has to hold against the manual
 * land route, which does not go through this queue at all.
 */
const workers = ((
  globalThis as unknown as {
    __ufMergeWorkers?: { active: Set<string>; resolutionsRefused: string | null };
  }
).__ufMergeWorkers ??= { active: new Set<string>(), resolutionsRefused: null });

export const isWorking = () => workers.active.size > 0;

/**
 * How many repositories may be drained at once.
 *
 * Not unbounded, and the bound is about money rather than about correctness:
 * every worker can be holding a conflict-resolution child for up to
 * `RESOLVE_TIMEOUT_MS`, and those are billed. What this change is for is head-of-line
 * blocking — a clean branch in one repository waiting out a conflict in another
 * — not parallel spend, so a repository over the cap waits for a slot rather
 * than for the whole queue. Nothing is dropped; the drain that frees a slot
 * calls `startWorker` again.
 */
const MAX_MERGE_WORKERS = 4;

/**
 * The repository each queued row belongs to, as SQL.
 *
 * `repo_root ?? folder` is the key the worker has always used for "which
 * repository is this branch in", and it is the key `halted` was already keyed
 * on — the module modelled the repository as the unit that shares state well
 * before the worker did. The join is a LEFT one so a row whose run has been
 * deleted still groups (under `''`) and still reaches a worker that can fail
 * it; an INNER join would leave it `queued` for ever with nothing to move it.
 */
const REPO_KEY = "COALESCE(r.repo_root, r.folder, '')";

/**
 * Repositories with queued work, the oldest-queued first.
 *
 * The order matters only when `MAX_MERGE_WORKERS` is reached: it decides which
 * repository waits, and the operator's own oldest press of Land should not be
 * the one that does.
 */
export function queuedRepos(): string[] {
  return (
    db()
      .prepare(
        `SELECT ${REPO_KEY} AS repo FROM merge_queue q
           LEFT JOIN runs r ON r.id = q.run_id
          WHERE q.status='queued'
          GROUP BY repo ORDER BY MIN(q.created_at), MIN(q.batch_id)`,
      )
      .all() as { repo: string }[]
  ).map((r) => r.repo);
}

/**
 * The next branch to land in one repository, across every batch.
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
 * The repository term is what makes several workers possible and it changes
 * none of the above: within one repository this is the sequence it always was.
 *
 * Exported for the test that pins this sequence. The decision is the SQL, so
 * anything short of running the query would be a second copy of it, and the
 * copy is the one that would stay right.
 */
export function nextQueuedIn(repo: string): QueueRow | null {
  return (
    (db()
      .prepare(
        `SELECT q.* FROM merge_queue q LEFT JOIN runs r ON r.id = q.run_id
          WHERE q.status='queued' AND ${REPO_KEY} = ?
          ORDER BY q.created_at, q.batch_id, q.position LIMIT 1`,
      )
      .get(repo) as QueueRow | undefined) ?? null
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
 * Give every repository with queued work a worker, up to the cap.
 *
 * Synchronous from the read to the claim — no `await` between `queuedRepos()`
 * and the `active.add` — which is the property `createRun`'s folder claim
 * already documents and the reason two calls to this cannot both start a worker
 * on one repository. Everything after the claim is a detached loop, not awaited
 * by the caller: a queue with a conflict in it runs for as long as reconciling
 * that conflict takes, and the rows are what report on it — the page polls
 * them, exactly as it polls a run.
 */
export function startWorker(): void {
  // `enqueue` already refuses, so nothing this process queued can be here — but
  // the table is shared, and draining a row another server queued is this
  // process merging into a checkout it was never told about. Asked here rather
  // than per repository because the answer is about this process, not about
  // which queue it would drain.
  if (!mayWriteDataDir()) return;
  for (const repo of queuedRepos()) {
    if (workers.active.size >= MAX_MERGE_WORKERS) break;
    if (workers.active.has(repo)) continue;
    workers.active.add(repo);
    void drainRepo(repo);
  }
}

/**
 * Work one repository's queue until it is empty, one branch at a time.
 *
 * The caller has already claimed `repo`; this releases it, and only this.
 *
 * `halt` is a single value rather than the map the one-loop version kept,
 * because a worker now covers exactly one repository — the same decision, with
 * the key moved into the loop's identity. A dirty checkout or a HEAD on the
 * wrong branch still refuses every remaining branch *in that repository* and
 * says so once, and still says nothing about any other.
 *
 * **A row is answered even when this app is the thing that broke**, which is
 * the one status transition nothing else in the process can make. `setStatus`
 * is reachable only from here; `cancelBatch` and `cancelQueuedFor` touch
 * `queued` rows alone; and `reconcileMergeQueueOnBoot` needs a restart. So a
 * throw escaping this loop left the row it was on stuck at `landing` or
 * `resolving` for the life of the container — with `enqueue` then refusing that
 * run by name for ever, since `queuedRunIds` counts it as still in the queue,
 * and the panel pinning its batch as unfinished under a spinner. The operator
 * lands the branch by hand, it works, and the queue goes on saying `landing`.
 * That was reachable: `git()` documents that it never rejects and now holds to
 * it, but `landState`, `landRun` and `resolveConflicts` reach a database and a
 * spawn on every item, and none of them is total.
 *
 * The row is **failed rather than retried**, and the message says the merge may
 * have gone through: the throw can land after `landRun` has already committed
 * into the operator's checkout, and this is the same sentence the boot
 * reconciler gives a row it caught mid-merge, for the same reason — nothing
 * here saw the write finish, and inventing an answer is worse than naming the
 * uncertainty. It halts the repository for `planItem`'s reason: a fault in this
 * app will meet the branch behind this one identically, and each rediscovery is
 * another merge attempted into a directory a person owns.
 */
async function drainRepo(repo: string): Promise<void> {
  /** Why this repository was given up on, if it was. */
  let halt: string | null = null;

  try {
    for (let row = nextQueuedIn(repo); row; row = nextQueuedIn(repo)) {
      const run = getRun(row.run_id);
      if (!run) {
        setStatus(row.id, "failed", { message: "That run no longer exists." });
        continue;
      }

      if (halt) {
        setStatus(row.id, "skipped", { message: `Not attempted — ${halt}` });
        continue;
      }

      try {
        setStatus(row.id, "landing");
        const outcome = await processOne(row, {
          autoResolve: row.auto_resolve === 1,
          // Shared across the workers in flight rather than held per
          // repository: what it records is that the *operator's own usage
          // window* is spent, which is a fact about the account and not about a
          // repository. Each rediscovery costs a full transcript scan, so
          // learning it once is the whole point of the flag.
          resolutionsRefused: workers.resolutionsRefused,
        });

        if (outcome.halt) halt = outcome.message;
        if (outcome.refusedResolutions) workers.resolutionsRefused = outcome.refusedResolutions;
        setStatus(row.id, outcome.status, {
          // The prefix is added here and nowhere else. `processOne` returns the
          // bare reason because the same string is also what every row behind
          // this one is told, and prefixing it twice reads as a stutter.
          message: outcome.halt ? `Not attempted — ${outcome.message}` : outcome.message,
          resolveCost: outcome.resolveCost,
        });
      } catch (err) {
        halt = `this server hit an error landing ${run.worktree_branch ?? row.run_id.slice(0, 8)}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        setStatus(row.id, "failed", {
          message: `This server hit an error while landing it, so it is not known whether the merge went through: ${
            err instanceof Error ? err.message : String(err)
          }. Check the branch before queueing it again.`,
        });
      }
    }
  } finally {
    workers.active.delete(repo);
    // The last worker out ends the drain, and a drain that has ended has
    // learned nothing the next one should inherit — a window refused an hour
    // ago may have rolled over since. This is what the flag meant when there
    // was one loop, kept by making it end with the loops rather than with one.
    if (workers.active.size === 0) workers.resolutionsRefused = null;
  }

  // A repository queued while this loop was draining its last item, or one held
  // back by the cap, would otherwise wait for the next enqueue. Cheap, and the
  // alternative is a queue that stalls for no visible reason.
  //
  // Deliberately still *after* the `finally`, so a throw skips it. What can
  // still throw past the row-level catch above is `nextQueuedIn` or the catch's
  // own `setStatus` — both of them the database itself, and both of them still
  // true a microsecond later against a row this drain has not moved. Re-arming
  // there is an unbounded loop on one row rather than a recovery, and it would
  // be a synchronous one: `drainRepo` throwing before its first `await` runs
  // this line inside the `startWorker` that called it.
  startWorker();
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
    await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
  }
}
