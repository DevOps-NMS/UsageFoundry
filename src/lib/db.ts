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

/**
 * Written once and used twice — by `migrate()` and by the rebuild below, which
 * exists because `template_id` was NOT NULL before a proposal could go without
 * a template. Two copies of a CREATE statement drift, and the copy that drifts
 * is the one only an upgraded install ever runs.
 */
const CHAT_PROPOSALS_TABLE = `
    CREATE TABLE IF NOT EXISTS chat_proposals (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      -- The template supplying every guard, or null for the untemplated guard
      -- set in settings. Not a foreign key: a template deleted between proposal
      -- and approval must fail the approval with a sentence, not vanish the row
      -- the operator is looking at.
      template_id TEXT,
      title       TEXT NOT NULL,
      task        TEXT NOT NULL,
      -- The prompt the task is appended to, when the chat wrote one for this
      -- run rather than taking the template's. Prompt text only: it is the half
      -- of a run a model may write, which is exactly what guards are not.
      prompt_override TEXT,
      -- Null means "whatever the template says". The empty string is a real
      -- answer here as it is on a template — the mount root.
      mount_id    TEXT,
      folder      TEXT,
      -- 'pending' | 'approved' | 'rejected' | 'failed'
      status      TEXT NOT NULL DEFAULT 'pending',
      run_id      TEXT,
      decided_at  INTEGER,
      error       TEXT
    );`;

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

    -- A saved task prompt and the guards it should run under.
    --
    -- Its own table rather than a key in the settings blob because this is a
    -- list with identity — rows are created, renamed and deleted individually,
    -- and one of them is picked by id. A template is *form input*, never a run:
    -- it holds no folder claim, consumes no concurrency slot, and nothing
    -- derived from activeRuns() can see it. There is deliberately no foreign
    -- key to runs either — a template outlives the run it was seeded from.
    --
    -- mount_id and folder are nullable together and mean "ask when this is
    -- used". Null is not the same as "": the empty string is a real answer, the
    -- mount root, which is why the folder column cannot use it as a sentinel.
    CREATE TABLE IF NOT EXISTS run_templates (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      mount_id        TEXT,
      folder          TEXT,
      isolate         INTEGER NOT NULL DEFAULT 1,
      -- Stored beside the budget rather than inside it, unlike runs.budget,
      -- because this is the one field on a template that decides what a spawned
      -- agent is allowed to do. A column is greppable; a key in a JSON blob is
      -- not. See the narrowing note in templates.ts.
      permission_mode TEXT NOT NULL,
      budget          TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    -- Branches waiting to be landed, one after another.
    --
    -- Landing several branches is several merges and each changes the base for
    -- the next, which is why they are a *queue* rather than a batch: exactly one
    -- is in flight, and every one of them is re-previewed against git
    -- immediately before its own merge rather than against whatever the page
    -- showed when the queue was made.
    --
    -- Its own table for the reason run_templates has one: this is a list with
    -- identity, whose rows are created, worked through and reported on
    -- individually. The position column is the operator's chosen order and is
    -- the only thing that decides what runs next — never created_at, which would
    -- silently reorder two branches queued in the same millisecond.
    CREATE TABLE IF NOT EXISTS merge_queue (
      id           TEXT PRIMARY KEY,
      batch_id     TEXT NOT NULL,
      run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      position     INTEGER NOT NULL,
      strategy     TEXT NOT NULL,
      -- Whether a conflict may be sent to Claude. Per batch, recorded per row:
      -- it authorises billed spend, and an authorisation belongs with the thing
      -- it authorises rather than in a setting that could change underneath it.
      auto_resolve INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL,
      -- What happened, in the operator's words rather than git's where the two
      -- differ. Always set for a row that is no longer queued.
      message      TEXT,
      created_at   INTEGER NOT NULL,
      started_at   INTEGER,
      finished_at  INTEGER,
      -- Cost of the conflict resolution this row paid for, if it needed one.
      -- Never added to the run's spend, for the same reason run_reviews.cost_usd
      -- is not: it did no work cycle.
      resolve_cost REAL NOT NULL DEFAULT 0
    );

    -- The orchestrator chat: a conversation that proposes runs.
    --
    -- Its own three tables rather than columns anywhere else, because a chat is
    -- a fourth thing this app spends money on and the split between what it
    -- costs and what a run costs has to survive being looked at. cost_usd here
    -- is the chat's own spend and is never added to runs.spent_usd — the same
    -- rule run_reviews.cost_usd follows, for the same reason: no work cycle
    -- happened.
    --
    -- session_id is Claude Code's, kept so the next message continues the same
    -- conversation via --resume rather than restating the thread. Recorded the
    -- moment the CLI reports it, for the reason runs.session_id is.
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id          TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      title       TEXT,
      session_id  TEXT,
      -- 'idle' | 'thinking' | 'failed'. A restart fails out 'thinking' rows for
      -- the reason reconcileReviewsOnBoot does: the child is gone with the
      -- process that started it.
      status      TEXT NOT NULL DEFAULT 'idle',
      cost_usd    REAL NOT NULL DEFAULT 0,
      tokens      INTEGER NOT NULL DEFAULT 0,
      error       TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id      TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      ts      INTEGER NOT NULL,
      -- 'user' | 'assistant' | 'system'. 'system' is this app speaking about
      -- the chat rather than the model speaking in it — a refusal, an approval
      -- outcome — so the two are never confused for each other on re-read.
      role    TEXT NOT NULL,
      text    TEXT NOT NULL
    );

    -- A run the chat wants to start, which no agent has started.
    --
    -- The approval gate is this table. A proposal holds no folder claim,
    -- consumes no concurrency slot and nothing derived from activeRuns() can
    -- see it — exactly like run_templates, and for the same reason: until an
    -- operator approves it, it is form input.
    --
    -- What it deliberately does *not* hold: guards, a permission mode, a model.
    -- Those come from the template it names, or from settings.chatDefaultGuards
    -- when it names none, and either way from something a person wrote. The
    -- chat picks what work to do; a person decides what an agent may do.
    -- Storing a budget here would make the chat the second route to
    -- --permission-mode that reopenRun refuses to become the third.
    ${CHAT_PROPOSALS_TABLE}

    CREATE INDEX IF NOT EXISTS idx_run_events_run
      ON run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat
      ON chat_messages(chat_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chat_proposals_chat
      ON chat_proposals(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_merge_queue_batch
      ON merge_queue(batch_id, position);
    -- The worker's own query: the next queued row, across every batch.
    CREATE INDEX IF NOT EXISTS idx_merge_queue_status
      ON merge_queue(status, position);
    CREATE INDEX IF NOT EXISTS idx_run_reviews_run
      ON run_reviews(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_created
      ON runs(created_at DESC);
    -- Every admission decision and every promotion pass reads the active rows.
    CREATE INDEX IF NOT EXISTS idx_runs_status
      ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_otlp_run
      ON otlp_requests(run_id, ts);
    -- Names identify a template to a person, so two that differ only in case
    -- are the same template as far as the picker is concerned. Enforced in the
    -- schema rather than checked before the insert: this process is a single
    -- writer, but a check-then-insert is still the wrong shape for a rule the
    -- database can state outright.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_templates_name
      ON run_templates(name COLLATE NOCASE);
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

  // What a conflict resolution produced. The merge commit is the only handle on
  // it: the checkout it was made in is removed as soon as the row is written,
  // and the row's text is the agent's account of the work rather than the work.
  // The paths are the files it was handed, kept so that what is shown afterwards
  // is the resolution rather than everything the merge brought across.
  addColumn(db, "run_reviews", "resolved_commit", "TEXT");
  addColumn(db, "run_reviews", "resolved_paths", "TEXT");

  // A proposal may now name no template at all, which the column above was
  // declared NOT NULL to forbid. SQLite cannot relax that with ALTER, so the
  // table is rebuilt — once, only where the old shape is still there.
  relaxProposalTemplate(db);

  // The prompt the chat wrote for one specific run. Added rather than rebuilt,
  // because a nullable column is the one change ALTER does support.
  addColumn(db, "chat_proposals", "prompt_override", "TEXT");

  // When the turn now in flight began, so the ten-minute bound on a chat turn
  // is enforceable by something outside the closure that spawned it. Not
  // `updated_at`, which looks like the same instant and is not: the chat's own
  // `save_template` tool appends a system message mid-turn, and every such
  // append would push the deadline out by however long the turn has already
  // run. Null whenever no turn is in flight.
  addColumn(db, "chat_sessions", "turn_started_at", "INTEGER");
}

/**
 * Drop the NOT NULL from `chat_proposals.template_id`, preserving the rows.
 *
 * The alternative — dropping the table and letting it be recreated — would take
 * the decided proposals with it, which are the record of what the operator
 * approved and what came of it. A rebuild costs fifteen lines and keeps that.
 *
 * The index is recreated at the end rather than before: renaming a table brings
 * its indexes along under their own names, so `CREATE INDEX` would collide with
 * the copy still attached to the old table until that table is dropped.
 */
function relaxProposalTemplate(db: Database.Database) {
  const column = (
    db.prepare("PRAGMA table_info(chat_proposals)").all() as {
      name: string;
      notnull: number;
    }[]
  ).find((c) => c.name === "template_id");
  if (!column || column.notnull === 0) return;

  db.exec(`
    ALTER TABLE chat_proposals RENAME TO chat_proposals_old;
    ${CHAT_PROPOSALS_TABLE}
    INSERT INTO chat_proposals
      (id, chat_id, created_at, template_id, title, task, mount_id, folder,
       status, run_id, decided_at, error)
    SELECT id, chat_id, created_at, template_id, title, task, mount_id, folder,
           status, run_id, decided_at, error
      FROM chat_proposals_old;
    DROP TABLE chat_proposals_old;
    CREATE INDEX IF NOT EXISTS idx_chat_proposals_chat
      ON chat_proposals(chat_id, created_at);
  `);
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
