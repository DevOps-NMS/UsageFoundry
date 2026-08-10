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

    CREATE INDEX IF NOT EXISTS idx_run_events_run
      ON run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_runs_created
      ON runs(created_at DESC);
    -- Every admission decision and every promotion pass reads the active rows.
    CREATE INDEX IF NOT EXISTS idx_runs_status
      ON runs(status);
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
