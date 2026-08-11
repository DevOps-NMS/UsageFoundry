import fs from "node:fs";
import Database from "better-sqlite3";
import { DATA_DIR, DB_PATH } from "./config";

/**
 * SQLite persistence. Single-writer, single-process — matching the fact that
 * this ships as one container serving one operator.
 *
 * The single-process part is now load-bearing rather than incidental: the
 * folder claim that keeps two agents out of one directory is a synchronous
 * check-then-insert in `createRun`, which is only atomic because one Node
 * event-loop turn runs to completion. Running two app processes against this
 * file would silently allow the collision the claim exists to prevent.
 */

const globalDb = globalThis as unknown as { __ufDb?: Database.Database };

function open(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  // WAL keeps the dashboard's frequent reads from blocking on run writes.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id             TEXT PRIMARY KEY,
      folder         TEXT NOT NULL,
      prompt         TEXT NOT NULL,
      model          TEXT,
      status         TEXT NOT NULL,
      budget         TEXT NOT NULL,
      baseline       TEXT,
      -- 0 means "no cap". SQLite cannot drop NOT NULL without rebuilding the
      -- table and there is no migration framework here, so the sentinel is the
      -- cheaper of the two evils. 0 was previously unreachable — normalizePolicy
      -- floored at 1 — and this column is only a denormalised copy for the list
      -- view; the budget blob stays the source of truth. Every reader goes
      -- through fmtCycles() in format.ts rather than open-coding the check.
      max_iterations INTEGER NOT NULL DEFAULT 1,
      iterations     INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      started_at     INTEGER,
      finished_at    INTEGER,
      stop_reason    TEXT,
      exit_code      INTEGER,
      spent_usd      REAL NOT NULL DEFAULT 0,
      spent_tokens   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ts      INTEGER NOT NULL,
      kind    TEXT NOT NULL,
      payload TEXT NOT NULL
    );

    -- First-party per-request telemetry, pushed by Claude Code over OTLP.
    --
    -- A third source, kept apart from the other two exactly as they are kept
    -- apart from each other: it never feeds buildSnapshot() or evaluateBudget()
    -- and is never summed with transcript-derived figures. request_id is the
    -- Anthropic request id and the natural primary key — OTLP delivery is
    -- at-least-once, so a retried batch must land as a no-op rather than
    -- double-count.
    --
    -- Note what is absent: the payload also carries user.email,
    -- user.account_uuid and organization.id. None of it is stored. This table
    -- holds cost and token facts about runs, not an identity record.
    CREATE TABLE IF NOT EXISTS otlp_requests (
      request_id            TEXT PRIMARY KEY,
      ts                    INTEGER NOT NULL,
      run_id                TEXT,
      session_id            TEXT,
      model                 TEXT,
      cost_usd              REAL NOT NULL DEFAULT 0,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms           INTEGER,
      query_source          TEXT,
      speed                 TEXT,
      effort                TEXT
    );

    -- On-demand AI reviews of what a run changed.
    --
    -- Its own table rather than a column on runs, for the same reason
    -- spent_usd_est is its own column: runs.spent_usd is a floor of what
    -- Claude Code measured *for work cycles*, and folding a review's cost
    -- into it would make the run read as more expensive than the work was.
    -- Rows accumulate — a second review of the same run does not replace the
    -- first, because the interesting comparison is usually between them.
    CREATE TABLE IF NOT EXISTS run_reviews (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      finished_at INTEGER,
      status      TEXT NOT NULL,
      model       TEXT,
      cost_usd    REAL NOT NULL DEFAULT 0,
      tokens      INTEGER NOT NULL DEFAULT 0,
      text        TEXT,
      error       TEXT,
      -- What the model was actually shown, so a review of a truncated diff is
      -- never mistaken for a review of the whole change.
      diff_files  INTEGER NOT NULL DEFAULT 0,
      diff_shown  INTEGER NOT NULL DEFAULT 0,
      truncated   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_run_events_run
      ON run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_run_reviews_run
      ON run_reviews(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_created
      ON runs(created_at DESC);
    -- Every admission decision and every promotion pass reads the active rows.
    CREATE INDEX IF NOT EXISTS idx_runs_status
      ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_otlp_run
      ON otlp_requests(run_id, ts);
  `);

  // `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
  // exists, and `ALTER TABLE ADD COLUMN` throws "duplicate column name" on the
  // second boot. With no version table, checking the live schema is the only
  // idempotent option.
  addColumn(db, "runs", "session_id", "TEXT");
  addColumn(db, "runs", "work_dir", "TEXT");
  addColumn(db, "runs", "isolation", "TEXT");
  addColumn(db, "runs", "repo_root", "TEXT");
  addColumn(db, "runs", "worktree_path", "TEXT");
  addColumn(db, "runs", "worktree_branch", "TEXT");
  addColumn(db, "runs", "worktree_base", "TEXT");

  // Pause/resume state. `resume_at` is an advisory wake hint only — the sweeper
  // re-evaluates the budget on waking rather than trusting it, because the
  // verdict depends on things that move while a run is parked.
  addColumn(db, "runs", "resume_at", "INTEGER");
  addColumn(db, "runs", "paused_at", "INTEGER");
  addColumn(db, "runs", "pause_count", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "runs", "done_retriggers", "INTEGER NOT NULL DEFAULT 0");

  // What the next work cycle says, when an operator has picked a finished run
  // up by hand. Consumed rather than kept: the loop clears it the moment it
  // hands it to a spawn, so a run that parks or is picked up again later does
  // not deliver the same message twice.
  addColumn(db, "runs", "follow_up", "TEXT");

  // Spend reconciled from transcripts for work cycles that were killed before
  // Claude Code reported their cost. Held apart from spent_usd rather than
  // added to it: spent_usd stays a floor of what the CLI itself measured, and
  // the sum of the two is the best available total. Only the unaccounted
  // portion lands here, so adding them never double-counts.
  addColumn(db, "runs", "spent_usd_est", "REAL NOT NULL DEFAULT 0");
  addColumn(db, "runs", "spent_tokens_est", "INTEGER NOT NULL DEFAULT 0");

  // Where an isolated run's work belongs, and whether it got there.
  // `worktree_base` is a commit; it says where the branch started, not which
  // branch it should be merged into. Rows written before this column existed
  // have null and the landing path infers a target rather than assuming one —
  // see `targetOf` in land.ts.
  addColumn(db, "runs", "worktree_base_branch", "TEXT");
  addColumn(db, "runs", "landed_at", "INTEGER");
  addColumn(db, "runs", "landed_into", "TEXT");
  addColumn(db, "runs", "landed_strategy", "TEXT");
  // The branch tip at the moment it was landed. A squash does not make the
  // branch's commits ancestors of the target, so git can never call it merged
  // and would refuse to delete it for ever. This records exactly which commits
  // were taken, so "the branch still points at what we squashed" is a fact
  // rather than a guess.
  addColumn(db, "runs", "landed_tip", "TEXT");

  // What a `run_reviews` row is: a read-only review, or a conflict resolution.
  // One table because the lifecycle is identical — spawn, poll, record cost,
  // fail out on restart — and because both are the same accounting fact:
  // money spent on a run *outside* its work cycles.
  addColumn(db, "run_reviews", "kind", "TEXT NOT NULL DEFAULT 'review'");
}

function addColumn(
  db: Database.Database,
  table: string,
  col: string,
  decl: string,
) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}

export function db(): Database.Database {
  return globalDb.__ufDb ?? (globalDb.__ufDb = open());
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function getSetting(key: string): string | null {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function getJSON<T>(key: string, fallback: T): T {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJSON(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}
