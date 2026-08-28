import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { DB_PATH, PROJECTS_DIR } from "./config";
import { db, getJSON, setJSON } from "./db";
import { git } from "./git";
import {
  activeRuns,
  describeFolder,
  emitRunEvent,
  resolveWorkspaceFolder,
  TERMINAL_STATUSES,
  worktreeStores,
} from "./orchestrator";
import { getSettings } from "./settings";
import { forgetTranscriptFiles } from "./transcripts";

/**
 * What this app throws away, and what it promises to keep.
 *
 * Three stores grow with the work rather than with the configuration —
 * `run_events` in the named volume, `.uf-worktrees` on the workspace bind
 * mount, `~/.claude/projects` in the operator's own home — on three different
 * media, at three different rates. They are one module rather than three caps
 * because they share one question: what is safe to discard, and what does this
 * app promise about history it has already shown somebody.
 *
 * The answer is one sentence. **A run's row is permanent; everything behind it
 * is evidence, and evidence has a horizon.** Nothing here deletes a `runs` row,
 * a review, a workflow record or a setting, so every figure this app has put on
 * the dashboard, the runs list or a run's own state card keeps reading true —
 * the spend, the cycle count, the stop reason, the branch, the landing record.
 * What goes is the working material those figures were derived from: the event
 * log's payloads, the checkout on disk, the session transcript.
 *
 * Four properties are shared by every sweep here and none is optional.
 *
 *  - **Nothing in flight is touched.** A run that has not settled keeps its
 *    whole log; a checkout an active run holds is skipped by name; a transcript
 *    whose session belongs to a live run is not a candidate. Each sweep asks the
 *    *database* what is live rather than inferring it from a file's age.
 *  - **The decision is pure, the syscall is not.** What goes is decided by
 *    functions that are unit-tested against fixtures, for `releasableRuns`'
 *    reason: every way of being wrong here is silent, lands on somebody's disk,
 *    and throws nothing.
 *  - **A removal is recorded where the operator would look for it** — in the
 *    run's own log where there is a run, and in `retention.lastSweep`, which the
 *    Settings page shows beside the sizes.
 *  - **No sweep destroys the only copy of anything.** It removes no branch and
 *    no commit, it never touches the operator's own checkout, and what it does
 *    remove is evidence for a figure that is already recorded elsewhere.
 *
 * Every horizon is `null`-able and `null` means keep for ever, the reading
 * every switchable rule in this app takes.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How often the sweep runs. Retention is a horizon, not a deadline. */
const SWEEP_MS = 6 * 60 * 60 * 1000;

/**
 * Where the last sweep's counts live.
 *
 * A settings key rather than a table: it is one row that is overwritten, read
 * by one card, and a table for it would be a fifth store with no retention of
 * its own — which is the joke this module exists to stop being funny.
 */
const LAST_SWEEP_KEY = "retention.lastSweep";

export interface RetentionSweep {
  at: number;
  /** Rows removed from `run_events`. */
  events: number;
  /** Rows removed from `otlp_requests`. */
  telemetry: number;
  /**
   * Rows removed from `context_samples`.
   *
   * Absent on a blob written before this field existed, which is why the one
   * reader renders it conditionally rather than as a `0` — a sweep that
   * predates the column did not remove none of these, it did not know about
   * them, and `metering.md`'s rule is that the two must not read the same.
   */
  samples?: number;
  /**
   * Rows removed from `prune_decisions`.
   *
   * Absent on a sweep recorded before this table was swept at all, on
   * `samples`' reasoning — the reader renders it conditionally rather than as
   * a `0`, because a sweep that predates the column did not remove none of
   * these, it did not know about them.
   */
  decisions?: number;
  /** Isolated checkouts removed from the mounts' stores. */
  checkouts: number;
  /** Session transcripts removed from `~/.claude/projects`. */
  transcripts: number;
  /** Bytes those transcripts held. The one store whose figure is exact. */
  transcriptBytes: number;
}

export function lastSweep(): RetentionSweep | null {
  return getJSON<RetentionSweep | null>(LAST_SWEEP_KEY, null);
}

/**
 * The instant a horizon of `days` puts the boundary at, or null for "keep all".
 *
 * Its own function because all three sweeps read a horizon the same way and the
 * `null` reading is the one that must not drift: a blank field disables a rule
 * here exactly as it disables a budget guard, and a zero that fell through as a
 * cutoff of `now` would delete everything the first time somebody typed one.
 */
export function retentionCutoff(days: number | null, now: number): number | null {
  if (days === null || !Number.isFinite(days) || days <= 0) return null;
  return now - days * DAY_MS;
}

/* ------------------------------------------------------------------ */
/* run_events, and the telemetry rows beside them                      */
/* ------------------------------------------------------------------ */

/**
 * Drop the event payloads of settled runs past the horizon.
 *
 * Two tables, one horizon, because they are the same fact about the same run
 * seen from two sides: `run_events` is what this app recorded about a cycle and
 * `otlp_requests` is what the CLI reported about the requests inside it. Both
 * are bounded by the run having *settled*, so a log the run page is streaming
 * cannot lose lines under the reader and `telemetrySpendSince` — which reads a
 * live run's current cycle — can never be asked about a row that has gone.
 *
 * A telemetry row with no `run_id` is something else pointed at the ingest
 * route; it ages out on the horizon alone, since there is no run whose being
 * finished could protect it.
 *
 * No `VACUUM`. SQLite reuses the freed pages, so this bounds the database's
 * growth to a steady state; returning the space to the filesystem rewrites the
 * whole file and blocks the single writer while it does, which is not something
 * to do to a process that is also carrying live budget guards. The file's size
 * is reported instead, and `README.md` gives the command.
 */
export function sweepRunEvents(now = Date.now()): {
  events: number;
  telemetry: number;
  samples: number;
  decisions: number;
} {
  const cutoff = retentionCutoff(getSettings().eventRetentionDays, now);
  if (cutoff === null) return { events: 0, telemetry: 0, samples: 0, decisions: 0 };

  const settled = TERMINAL_STATUSES.map(() => "?").join(",");
  const events = db()
    .prepare(
      `DELETE FROM run_events
        WHERE ts < ?
          AND run_id IN (SELECT id FROM runs WHERE status IN (${settled}))`,
    )
    .run(cutoff, ...TERMINAL_STATUSES).changes;

  const telemetry = db()
    .prepare(
      `DELETE FROM otlp_requests
        WHERE ts < ?
          AND (run_id IS NULL
               OR run_id IN (SELECT id FROM runs WHERE status IN (${settled})))`,
    )
    .run(cutoff, ...TERMINAL_STATUSES).changes;

  // The context occupancy series, on the same horizon and behind the same
  // `settled` test, because it is the same kind of thing: evidence for a picture
  // drawn on the run's own page, beside the log it explains. Deliberately not
  // `prune_receipts`' treatment — those answer a weekly KPI and must outlive the
  // run, where a sample is read only while somebody is looking at that run, so a
  // series that outlived its own log would be a graph with nothing to read it
  // against. `context_samples` is capped per run on insert as well; this is what
  // bounds the table across runs.
  const samples = db()
    .prepare(
      `DELETE FROM context_samples
        WHERE ts < ?
          AND run_id IN (SELECT id FROM runs WHERE status IN (${settled}))`,
    )
    .run(cutoff, ...TERMINAL_STATUSES).changes;

  // Boundary decisions go on exactly the samples clause, and for exactly its
  // reason: this is evidence for a sentence on the run's own page, beside the
  // log it explains, and it must not outlive that log. Deliberately not
  // `prune_receipts`' treatment — a receipt answers a weekly KPI and has to
  // outlive its run; a decision is read only while somebody is reading the run.
  const decisions = db()
    .prepare(
      `DELETE FROM prune_decisions
        WHERE ts < ?
          AND run_id IN (SELECT id FROM runs WHERE status IN (${settled}))`,
    )
    .run(cutoff, ...TERMINAL_STATUSES).changes;

  return { events, telemetry, samples, decisions };
}

/* ------------------------------------------------------------------ */
/* Isolated checkouts — the decision, which is pure                    */
/* ------------------------------------------------------------------ */

/**
 * One checkout in a mount's store, as everything that decides about it sees it.
 *
 * Assembled from the database first and git second, in that order deliberately:
 * the two cheap facts — is anything live in it, and is it even old enough —
 * settle most candidates without a process, and the two that cost a git call
 * are only asked about what survives.
 */
export interface CheckoutCandidate {
  /** The checkout directory, exactly as `runs.worktree_path` records it. */
  slotPath: string;
  /** The newest run recorded in this slot. */
  runId: string;
  /** That run's status. */
  status: string;
  /** When it finished, or null if it never did. */
  finishedAt: number | null;
  /** An active run — `running`, `queued` or `paused` — holds this slot now. */
  heldByActiveRun: boolean;
  /** `git status --porcelain` was readable and empty. `slotIsDirty`'s rule. */
  clean: boolean;
  /**
   * The branch it holds carries nothing that is not already in its target:
   * landed, merged, or never committed to at all.
   */
  branchSettled: boolean;
  /** A run that has not started yet is set to carry that branch on. */
  chained: boolean;
}

export type CheckoutVerdict =
  | { action: "remove" }
  | { action: "keep"; reason: string };

/**
 * Whether one checkout may be reclaimed, and the sentence for why not.
 *
 * Pure and separated from the `worktree remove` below for `selectPromotable`'s
 * reason: both ways of being wrong land on somebody's disk and neither throws.
 * Removing one too eagerly destroys an agent's uncommitted work in a directory
 * the operator never looks at; removing none leaves `64 × repositories` full
 * checkouts on the volume that holds their real source, and the first symptom
 * of that is their own `git checkout` failing to write.
 *
 * The order is cheapest-first and the last two are the ones that cost a git
 * call. Every clause is a *keep*, so a candidate this function has not been
 * told enough about is never removed.
 */
export function planCheckoutReclaim(
  c: CheckoutCandidate,
  now: number,
  cutoff: number | null,
): CheckoutVerdict {
  if (cutoff === null) return { action: "keep", reason: "retention is off" };

  // Two separate readings of "a live run is in there", because they can
  // disagree: the newest row recorded in a slot need not be the run holding it,
  // since a run released from `waiting` days later takes whatever slot is free.
  if (c.heldByActiveRun) {
    return { action: "keep", reason: "an active run holds this checkout" };
  }
  if (!(TERMINAL_STATUSES as readonly string[]).includes(c.status)) {
    return { action: "keep", reason: `run ${c.runId.slice(0, 8)} is ${c.status}` };
  }

  // A terminal row with no finish time is a run something closed out without
  // stamping one. There is no age to measure, so there is no horizon to be past.
  if (c.finishedAt === null) {
    return { action: "keep", reason: "no finish time recorded" };
  }
  if (c.finishedAt > cutoff) {
    const days = Math.max(1, Math.round((now - c.finishedAt) / DAY_MS));
    return { action: "keep", reason: `finished ${days} day(s) ago` };
  }

  // `slotIsDirty`'s rule, and the one this sweep must never weaken: unreadable
  // counts as dirty, because refusing to reclaim is the recoverable mistake and
  // `git status` cannot see the gitignored files that are most of the bytes.
  if (!c.clean) {
    return { action: "keep", reason: "uncommitted work in the checkout" };
  }

  // A run that has not started yet is going to want this branch. Removing the
  // checkout would not take the branch — `worktree remove` leaves the ref
  // alone, and `ensureWorktree` would attach it to a fresh slot — but it would
  // throw away the one thing the reuse is for, on behalf of a run that is
  // already scheduled to want it.
  if (c.chained) {
    return { action: "keep", reason: "a run is set to carry its branch on" };
  }

  // The only clause about work rather than about state, and the reason this is
  // a *reclaim* rather than a delete: everything in a settled branch's checkout
  // is either committed to a branch that is going nowhere, or already in the
  // target. Nothing here removes either.
  if (!c.branchSettled) {
    return { action: "keep", reason: "its branch has commits that are not in its target" };
  }

  return { action: "remove" };
}

/** Which of these checkouts may go. The list a sweep acts on. */
export function reclaimableCheckouts(
  candidates: readonly CheckoutCandidate[],
  now: number,
  cutoff: number | null,
): string[] {
  return candidates
    .filter((c) => planCheckoutReclaim(c, now, cutoff).action === "remove")
    .map((c) => c.slotPath);
}

/* ------------------------------------------------------------------ */
/* Isolated checkouts — the sweep, which is not                        */
/* ------------------------------------------------------------------ */

/** Checkouts examined per sweep. Each costs two git processes at most. */
const MAX_RECLAIM_PROBES = 40;

/** Re-prove a stored repository path inside its mount, as the run loop does. */
function repoPathFor(dir: string): string | null {
  try {
    const resolved = resolveWorkspaceFolder(dir, describeFolder(dir).mountId);
    return resolved === dir ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Reclaim the checkouts of settled runs whose branches have nowhere left to go.
 *
 * `worktree remove` without `--force`, which is deliberate twice over: it is
 * git's own second opinion on the cleanliness this already checked, and it
 * removes the *directory* — including the gitignored `node_modules` that made
 * the store worth sweeping — while leaving the branch and every commit on it
 * exactly where they were. Nothing here can destroy work that is not already
 * in the target.
 *
 * Bounded per sweep rather than exhaustive: this runs on the same event loop as
 * the live guard's ticker, and a store that is over its horizon by a hundred
 * checkouts is over it by sixty after one pass and by nothing after two.
 */
export async function sweepCheckouts(now = Date.now()): Promise<{
  removed: number;
  bytesUnknown: boolean;
}> {
  const cutoff = retentionCutoff(getSettings().checkoutRetentionDays, now);
  if (cutoff === null) return { removed: 0, bytesUnknown: false };

  const held = new Set(
    activeRuns()
      .map((r) => r.worktree_path)
      .filter((p): p is string => !!p),
  );

  // Every branch a run that has not started yet is set to carry on. One query
  // rather than one per candidate: the answer is a small set and the question
  // is asked of every slot.
  const chained = new Set(
    (
      db()
        .prepare(
          `SELECT DISTINCT continues_run AS id FROM runs
            WHERE continues_run IS NOT NULL
              AND status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})`,
        )
        .all(...TERMINAL_STATUSES) as Array<{ id: string }>
    ).map((r) => r.id),
  );

  // The newest run per slot, which is the one whose state describes it. Ordered
  // newest-first so the first row seen for a path is the one kept.
  const rows = db()
    .prepare(
      `SELECT id, status, finished_at, worktree_path, worktree_branch,
              worktree_base, worktree_base_branch, repo_root, landed_at, landed_tip
         FROM runs
        WHERE isolation = 'worktree' AND worktree_path IS NOT NULL
          AND repo_root IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 500`,
    )
    .all() as Array<{
    id: string;
    status: string;
    finished_at: number | null;
    worktree_path: string;
    worktree_branch: string | null;
    worktree_base: string | null;
    worktree_base_branch: string | null;
    repo_root: string;
    landed_at: number | null;
    landed_tip: string | null;
  }>;

  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!newest.has(row.worktree_path)) newest.set(row.worktree_path, row);
  }

  let removed = 0;
  let probes = 0;
  const pruned = new Set<string>();

  for (const row of newest.values()) {
    // The cheap half of the decision, asked before any git process: a candidate
    // rejected here costs nothing at all.
    const cheap = planCheckoutReclaim(
      {
        slotPath: row.worktree_path,
        runId: row.id,
        status: row.status,
        finishedAt: row.finished_at,
        heldByActiveRun: held.has(row.worktree_path),
        // Assumed for the cheap pass, then measured below. Assuming the
        // *permissive* value here is safe only because the same function is
        // asked again with every field's real value before anything is removed.
        clean: true,
        branchSettled: true,
        chained: chained.has(row.id),
      },
      now,
      cutoff,
    );
    if (cheap.action !== "remove") continue;
    if (!fs.existsSync(row.worktree_path)) continue;
    if (probes >= MAX_RECLAIM_PROBES) break;
    probes++;

    const repoRoot = repoPathFor(row.repo_root);
    if (!repoRoot) continue;

    // `slotIsDirty`'s rule with git run asynchronously: this pass touches up to
    // `MAX_RECLAIM_PROBES` checkouts and the event loop it shares is the one
    // carrying every live guard's ticker.
    const status = await git(row.worktree_path, ["status", "--porcelain"]);
    const clean = status.ok && status.stdout === "";

    const branchSettled = clean ? await branchIsSettled(repoRoot, row) : false;

    // Occupancy is re-read here rather than reused from the set above, and that
    // is the whole reason the second call passes real values for every field
    // instead of only the two git supplies. The set was read before the first
    // `await`, and this loop spends seconds in git across its candidates —
    // `createRun` claims a slot synchronously in one of those gaps, taking a
    // checkout `allocateSlotPath` found clean, which is exactly the profile of
    // a candidate here. Removing one under a run that has just claimed it costs
    // that run its working tree.
    const heldNow = activeRuns().some(
      (r) => r.worktree_path === row.worktree_path,
    );

    const verdict = planCheckoutReclaim(
      {
        slotPath: row.worktree_path,
        runId: row.id,
        status: row.status,
        finishedAt: row.finished_at,
        heldByActiveRun: heldNow,
        clean,
        branchSettled,
        chained: chained.has(row.id),
      },
      now,
      cutoff,
    );
    if (verdict.action !== "remove") continue;

    const gone = await git(repoRoot, ["worktree", "remove", row.worktree_path]);
    if (!gone.ok) continue;
    pruned.add(repoRoot);
    removed++;

    // Recorded on the run whose checkout it was, which is where an operator
    // looking for it would look. The branch is deliberately absent from the
    // payload's `deleted` shape: nothing was deleted, and a `land` row that
    // read as one would say this app destroyed a branch it did not touch.
    emitRunEvent({
      runId: row.id,
      ts: now,
      kind: "land",
      payload: {
        branch: row.worktree_branch,
        reclaimed: true,
        worktreeRemoved: row.worktree_path,
      },
    });
  }

  // One prune per repository that lost a checkout, so a stale registration
  // cannot make the next `worktree add` refuse a path that is now free.
  for (const repoRoot of pruned) await git(repoRoot, ["worktree", "prune"]);

  return { removed, bytesUnknown: probes >= MAX_RECLAIM_PROBES };
}

/**
 * Whether a branch carries anything its target does not already have.
 *
 * Two readings, because git can only see one of them. A squash rewrites the
 * commits, so an ancestry test can never call such a branch merged — the tip
 * recorded at land time is what stands in for it, and it stops being true the
 * moment the branch gains a commit, which is exactly when reclaiming its
 * checkout would start throwing away something.
 */
async function branchIsSettled(
  repoRoot: string,
  row: {
    worktree_branch: string | null;
    worktree_base: string | null;
    worktree_base_branch: string | null;
    landed_at: number | null;
    landed_tip: string | null;
  },
): Promise<boolean> {
  const branch = row.worktree_branch;
  if (!branch) return true; // no branch of its own: nothing to lose

  if (row.landed_at !== null && row.landed_tip) {
    const tip = await git(repoRoot, ["rev-parse", `refs/heads/${branch}`]);
    if (tip.ok && tip.stdout === row.landed_tip) return true;
  }

  const target = row.worktree_base_branch ?? row.worktree_base;
  if (!target) return false; // no range to measure: never assume it landed

  const ahead = await git(repoRoot, [
    "rev-list",
    "--count",
    `${target}..${branch}`,
  ]);
  return ahead.ok && Number(ahead.stdout) === 0;
}

/* ------------------------------------------------------------------ */
/* Session transcripts — the decision, which is pure                   */
/* ------------------------------------------------------------------ */

export interface TranscriptFile {
  path: string;
  /**
   * The session this transcript is of.
   *
   * The file's own basename, which is how the pinned CLI names one — verified
   * against the shipped layout rather than read from a specification. If that
   * ever stops being true the sweep does not become unsafe: the mtime horizon
   * is what actually protects a session in use, and a session id that matches
   * nothing simply protects nothing extra.
   */
  sessionId: string;
  mtimeMs: number;
  bytes: number;
}

/**
 * Which transcripts are past the horizon and belong to nothing that may resume.
 *
 * Pure, for the reason the checkout decision is: it removes files from the
 * operator's own home directory, and both ways of being wrong throw nothing. A
 * file taken too early is a session `--resume` can no longer continue; none
 * taken at all is the store that fills the disk holding `.credentials.json`.
 *
 * `keepSessions` is what makes this a database question rather than a file-age
 * one. It carries every session a live run may still spawn into and every chat
 * thread, which an operator can send another message to at any time — so the
 * age of a file is never on its own a reason to remove it.
 */
export function expiredTranscripts(
  files: readonly TranscriptFile[],
  o: {
    now: number;
    cutoff: number | null;
    keepSessions: ReadonlySet<string>;
  },
): TranscriptFile[] {
  const { cutoff } = o;
  if (cutoff === null) return [];
  return files.filter(
    (f) => f.mtimeMs < cutoff && !o.keepSessions.has(f.sessionId),
  );
}

/* ------------------------------------------------------------------ */
/* Session transcripts — the sweep, which is not                       */
/* ------------------------------------------------------------------ */

/** Files visited per transcript walk. The tree is one file per session. */
const MAX_TRANSCRIPT_FILES = 20_000;

/** Every `.jsonl` under the projects directory, with what decides about it. */
async function listTranscripts(root: string): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_TRANSCRIPT_FILES) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable — treated as empty, as `scanUsage` does
    }
    for (const entry of entries) {
      if (out.length >= MAX_TRANSCRIPT_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stat = await fsp.lstat(full);
        out.push({
          path: full,
          sessionId: entry.name.slice(0, -".jsonl".length),
          mtimeMs: stat.mtimeMs,
          bytes: stat.size,
        });
      } catch {
        /* removed between the readdir and the stat */
      }
    }
  };

  await walk(root);
  return out;
}

/** Every session id something in this app may still resume into. */
function resumableSessions(): Set<string> {
  const keep = new Set<string>();
  const add = (rows: Array<{ session_id: string | null }>) => {
    for (const row of rows) if (row.session_id) keep.add(row.session_id);
  };

  add(
    db()
      .prepare(
        `SELECT session_id FROM runs
          WHERE session_id IS NOT NULL
            AND status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})`,
      )
      .all(...TERMINAL_STATUSES) as Array<{ session_id: string | null }>,
  );

  // Every chat, whatever its status and however old. A thread is resumed by the
  // operator typing into it, which they may do at any time — there is no
  // terminal state to key on, and the set is one row per conversation.
  add(
    db()
      .prepare("SELECT session_id FROM chat_sessions WHERE session_id IS NOT NULL")
      .all() as Array<{ session_id: string | null }>,
  );

  // A fork's source, for as long as the fork itself is being kept.
  //
  // `winnow fork` writes a new transcript whose stripped tool results are
  // replaced by pointers, each carrying a `winnow recover <session> <id>`
  // command that reads the original bytes back out of the **source** file. The
  // source is never referenced by any run row once the run has adopted the
  // fork, so it ages out on its own — and the day it does, every pointer in the
  // live conversation silently stops being recoverable. Reversibility is the
  // whole argument for replacing a result with a pointer rather than deleting
  // it; a swept source turns a reversible loss into an irreversible one, with
  // nothing anywhere saying so.
  //
  // One hop, not transitive closure: a fork of a fork would need its own edge,
  // and nothing writes one today. Bounded deliberately rather than looped,
  // because an unbounded walk over a table an operator can grow is a way to
  // make a sweep hang.
  try {
    const forks = db()
      .prepare(
        `SELECT source_session_id, new_session_id FROM fork_attempts
          WHERE written = 1 AND source_session_id IS NOT NULL`,
      )
      .all() as Array<{ source_session_id: string; new_session_id: string | null }>;
    for (const f of forks) {
      if (f.new_session_id && keep.has(f.new_session_id)) {
        keep.add(f.source_session_id);
      }
    }
  } catch {
    // An install that has never forked has no such table on an older schema.
    // Keeping fewer files is the sweep's ordinary job; failing it is not.
  }

  return keep;
}

/**
 * Prune transcripts past the horizon, and clear the sessions they were.
 *
 * The clearing is the half that is easy to leave out and expensive to. A
 * terminal run keeps `session_id` for ever and `reopenRun` resumes into it, so
 * a pruned file would make the first cycle of a pick-up fail on a missing
 * session — where a **null** session id is already this app's documented
 * restart, with `nextPrompt` writing the task and `priorWorkNotice` naming the
 * branch the earlier attempt's commits are on. Clearing turns a silent failure
 * into the path that already exists.
 *
 * The cache is told about exactly the files that went, rather than invalidated:
 * `runScan` re-derives the file list every pass, so a removed file's parsed
 * entries would otherwise be held for the life of the process and the dashboard
 * would keep showing spend from transcripts that are gone.
 */
export async function sweepTranscripts(now = Date.now()): Promise<{
  removed: number;
  bytes: number;
}> {
  const cutoff = retentionCutoff(getSettings().transcriptRetentionDays, now);
  if (cutoff === null) return { removed: 0, bytes: 0 };

  const expired = expiredTranscripts(await listTranscripts(PROJECTS_DIR), {
    now,
    cutoff,
    keepSessions: resumableSessions(),
  });
  if (expired.length === 0) return { removed: 0, bytes: 0 };

  const gone: string[] = [];
  const sessions: string[] = [];
  let bytes = 0;
  for (const file of expired) {
    try {
      await fsp.unlink(file.path);
    } catch {
      continue; // read-only mount, or already removed — neither is ours to fix
    }
    gone.push(file.path);
    sessions.push(file.sessionId);
    bytes += file.bytes;
  }

  const clear = db().prepare(
    `UPDATE runs SET session_id = NULL
      WHERE session_id = ?
        AND status IN (${TERMINAL_STATUSES.map(() => "?").join(",")})`,
  );
  for (const sessionId of sessions) clear.run(sessionId, ...TERMINAL_STATUSES);

  forgetTranscriptFiles(gone);
  return { removed: gone.length, bytes };
}

/* ------------------------------------------------------------------ */
/* What each store currently holds                                     */
/* ------------------------------------------------------------------ */

export interface StorageReport {
  database: {
    path: string;
    /** The database file itself. */
    bytes: number;
    /** The write-ahead log and its index, which are the same store. */
    walBytes: number;
    runEvents: number;
    telemetryRows: number;
  };
  /** One entry per mount's `.uf-worktrees`, deduplicated by real path. */
  checkouts: Array<{
    mountId: string;
    label: string;
    path: string;
    /** Top-level directories in the store. */
    count: number;
    bytes: number;
    /** The walk hit its budget, so `bytes` is a floor rather than a total. */
    partial: boolean;
  }>;
  transcripts: {
    path: string;
    files: number;
    bytes: number;
    /** The walk hit its budget: one file per session, so this is not expected. */
    partial: boolean;
  };
  lastSweep: RetentionSweep | null;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Directory entries one walk may visit.
 *
 * A checkout with its dependencies installed is tens of thousands of files and
 * this route can be asked about several stores, so the walk is bounded and says
 * when it stopped. An unbounded one would be a page load that stats a million
 * paths — and "the figure took a minute" is how an operator learns not to open
 * the card that exists to warn them.
 */
const MAX_WALK_ENTRIES = 120_000;

/**
 * `lstat` calls in flight during one walk.
 *
 * Awaiting them one at a time is what this card actually cost: replaying the
 * walk over a real checkout store — 88,325 entries, 2.62 GB — took 5,981 ms
 * serially, which was essentially the whole of `GET /api/storage`, against
 * 1,750 ms with 64 of them outstanding. A stat is a syscall that spends its
 * life waiting on a disk, so a serial walk leaves the pool that services it
 * idle for the whole of that difference.
 *
 * Bounded rather than fanned out whole, `SCAN_CONCURRENCY`'s reason with a
 * different ceiling. What that number protects is `nofile`: `readAppended`
 * holds an open descriptor and a buffer the size of the file's unread
 * remainder for the duration of its read, so an unbounded fan-out holds every
 * one of both at once. An `lstat` holds neither — it is one libuv request that
 * ends when the syscall does — so what an unbounded fan-out costs here is depth
 * instead: 88,325 requests and their promises resident at once, on the event
 * loop that is also carrying every live guard's ticker. 64 keeps the pool
 * saturated without the queue becoming a store of its own.
 */
const TREE_STAT_CONCURRENCY = 64;

/**
 * Bytes under a directory, bounded, following no symlink.
 *
 * Exported for `runRetentionSweep`'s reason — so a test can drive it — and it
 * earns one despite reaching the filesystem rather than being pure: what it can
 * now get wrong is a total that is quietly *short*, because the stats it sums
 * are outstanding when the walk that issued them returns. A store that reads as
 * 1.4 GB when it holds 2.6 is the figure an operator sets a horizon against,
 * and nothing about it looks wrong.
 */
export async function treeSize(
  root: string,
  budget: { left: number },
): Promise<{ bytes: number; partial: boolean }> {
  let bytes = 0;
  let partial = false;

  // Drained in whole batches rather than through a worker pool, which is where
  // this differs from `mapWithLimit`: that one exists because transcript sizes
  // vary by three orders of magnitude, so a batch runs at the speed of its
  // slowest member. Every unit of work here is one `lstat`, and a batch's
  // slowest member is its typical one.
  let pending: Array<Promise<void>> = [];
  const drain = async (): Promise<void> => {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  };

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable — reported as nothing rather than as a throw
    }
    for (const entry of entries) {
      if (budget.left <= 0) {
        partial = true;
        return;
      }
      budget.left--;
      const full = path.join(dir, entry.name);
      // `lstat`, and directories are recursed only when they are real ones: a
      // symlink out of the store must contribute neither its bytes nor a walk.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // Rejection is handled here rather than at the await, because one of
      // these sits unawaited until its batch fills: an unhandled rejection on a
      // file that vanished between the readdir and the stat would take the
      // process down, where the serial version simply counted it as nothing.
      pending.push(
        fsp.lstat(full).then(
          (stat) => {
            bytes += stat.size;
          },
          () => {
            /* removed between the readdir and the stat */
          },
        ),
      );
      if (pending.length >= TREE_STAT_CONCURRENCY) await drain();
    }
  };

  await walk(root);
  // The tail, and the batch a spent budget abandoned mid-directory: both are
  // already in flight, and a total that returned without them would be short by
  // however many the last drain did not reach.
  await drain();
  return { bytes, partial };
}

/** What each mount's checkout store holds. */
async function checkoutSizes(): Promise<StorageReport["checkouts"]> {
  const out: StorageReport["checkouts"] = [];
  for (const store of worktreeStores()) {
    let count = 0;
    try {
      count = (await fsp.readdir(store.path, { withFileTypes: true })).filter(
        (e) => e.isDirectory(),
      ).length;
    } catch {
      // No store yet is a real answer — this mount has had no isolated run —
      // and it reads as zero rather than as a missing figure for that reason.
      out.push({ ...store, count: 0, bytes: 0, partial: false });
      continue;
    }
    const { bytes, partial } = await treeSize(store.path, {
      left: MAX_WALK_ENTRIES,
    });
    out.push({ ...store, count, bytes, partial });
  }
  return out;
}

/**
 * How long a measured store size is reused, and why it is measured at all.
 *
 * Five minutes, `STORE_TTL_MS` in `status.ts` for its reasons: the answer moves
 * slowly — a store grows when a run installs a dependency tree and shrinks only
 * when a sweep fires, six hours apart — and the measurement is by three orders
 * of magnitude the costliest thing on this route. The two `COUNT(*)`s beside it
 * are 0.05 ms and 0.01 ms; the walk was 5,981 ms, and two operators opening the
 * Settings page together each paid it in full rather than sharing one.
 *
 * **Nothing that deletes reads this.** The cache is on the *card's* reading and
 * deliberately not on `treeSize`, which is the shape that keeps a size five
 * minutes old out of a removal: `sweepCheckouts` decides from the database and
 * from git, `sweepTranscripts` from its own walk of `~/.claude/projects`, and
 * neither asks for a size at all. A figure this old is something an operator
 * reads; it is not something to delete against, and the only way it could
 * become one is if a future sweep reached for `measuredStores` instead.
 */
const STORE_TTL_MS = 5 * 60_000;

interface MeasuredStores {
  checkouts: StorageReport["checkouts"];
  transcripts: StorageReport["transcripts"];
  measuredAt: number;
}

/**
 * `globalThis`-pinned for the sweeper's timer's reason: module state that is not
 * pinned silently resets on every request in dev, which is where a walk that
 * has just been made shareable would go back to being run once per reader.
 */
const storeSizes = ((globalThis as unknown as {
  __ufStorageSizes?: {
    value: MeasuredStores | null;
    inFlight: Promise<MeasuredStores> | null;
  };
}).__ufStorageSizes ??= { value: null, inFlight: null });

async function measureStores(now: number): Promise<MeasuredStores> {
  // Sequential rather than concurrent: both walks are bounded at
  // `TREE_STAT_CONCURRENCY` stats each, and running them together would put
  // twice that on the loop the live guards' tickers share for no better figure.
  const checkouts = await checkoutSizes();
  const transcripts = await transcriptSize();
  return { checkouts, transcripts, measuredAt: now };
}

/** The measured half of the report, at most one walk at a time. */
function measuredStores(now: number): Promise<MeasuredStores> {
  const cached = storeSizes.value;
  if (cached && now - cached.measuredAt < STORE_TTL_MS) {
    return Promise.resolve(cached);
  }
  // Single-flight: a second reader arriving during the walk joins it rather
  // than starting one, which is the half of this that a TTL alone does not
  // give — the measurement takes seconds, so concurrent readers are the normal
  // case rather than a race.
  storeSizes.inFlight ??= measureStores(now)
    .then((value) => {
      storeSizes.value = value;
      return value;
    })
    .finally(() => {
      storeSizes.inFlight = null;
    });
  return storeSizes.inFlight;
}

/**
 * What is on disk right now, for the one card that says so.
 *
 * Measured rather than derived from the retention settings: a horizon says what
 * *will* be discarded, and an operator deciding whether to change it is asking
 * what is there now.
 *
 * The two figures the database can answer are read fresh on every call and only
 * the walks are cached, so the row counts and the sweep's own record move the
 * moment a sweep does — which is the half of this card an operator watches
 * after changing a horizon.
 */
export async function storageReport(now = Date.now()): Promise<StorageReport> {
  const measured = await measuredStores(now);
  const count = (sql: string) =>
    (db().prepare(sql).get() as { n: number }).n;

  return {
    database: {
      path: DB_PATH,
      bytes: sizeOf(DB_PATH),
      walBytes: sizeOf(`${DB_PATH}-wal`) + sizeOf(`${DB_PATH}-shm`),
      runEvents: count("SELECT COUNT(*) AS n FROM run_events"),
      telemetryRows: count("SELECT COUNT(*) AS n FROM otlp_requests"),
    },
    checkouts: measured.checkouts,
    transcripts: measured.transcripts,
    lastSweep: lastSweep(),
  };
}

/** What `~/.claude/projects` holds, from the same walk the sweep uses. */
async function transcriptSize(): Promise<StorageReport["transcripts"]> {
  const files = await listTranscripts(PROJECTS_DIR);
  return {
    path: PROJECTS_DIR,
    files: files.length,
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    partial: files.length >= MAX_TRANSCRIPT_FILES,
  };
}

/* ------------------------------------------------------------------ */
/* The sweep, and its one timer                                        */
/* ------------------------------------------------------------------ */

/**
 * One timer per process, `globalThis`-pinned, the shape `sweepPaused` and the
 * schedule timer already have and for their reason: module state that is not
 * pinned silently resets on every request in dev, and two of these would be two
 * sweeps deciding about one checkout.
 */
const timer = ((globalThis as unknown as {
  __ufRetention?: { handle: NodeJS.Timeout | null; running: boolean };
}).__ufRetention ??= { handle: null, running: false });

/**
 * Run every retention sweep once and record what it did.
 *
 * Exported so a test can drive it, and because the boot hook runs it once
 * rather than waiting six hours for the first tick — an install that has just
 * been upgraded into a retention policy is the one most likely to be over it.
 */
export async function runRetentionSweep(
  now = Date.now(),
): Promise<RetentionSweep> {
  const events = sweepRunEvents(now);
  const checkouts = await sweepCheckouts(now);
  const transcripts = await sweepTranscripts(now);
  const result: RetentionSweep = {
    at: now,
    ...events,
    checkouts: checkouts.removed,
    transcripts: transcripts.removed,
    transcriptBytes: transcripts.bytes,
  };
  setJSON(LAST_SWEEP_KEY, result);
  return result;
}

export function startRetentionSweeper(): void {
  if (timer.handle) return;
  timer.handle = setInterval(() => void tick(), SWEEP_MS);
  timer.handle.unref?.();
  void tick();
}

export function stopRetentionSweeper(): void {
  if (!timer.handle) return;
  clearInterval(timer.handle);
  timer.handle = null;
}

async function tick(): Promise<void> {
  if (timer.running) return;
  timer.running = true;
  try {
    await runRetentionSweep();
  } catch (err) {
    // A failed sweep must not kill the timer: the next one retries, and the
    // store it could not read is still bounded by the one after that.
    console.warn(
      `[usagefoundry] retention sweep failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    timer.running = false;
  }
}
