import fs from "node:fs";
import Database from "better-sqlite3";
import { DATA_DIR, DB_PATH } from "./config";

/**
 * SQLite persistence. Single-writer, single-process — matching the fact that
 * this ships as one container serving one operator.
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

    CREATE INDEX IF NOT EXISTS idx_run_events_run
      ON run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_runs_created
      ON runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_otlp_run
      ON otlp_requests(run_id, ts);
  `);
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
