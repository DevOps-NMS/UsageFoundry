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

    -- A named specialised agent: a role the delegating model may hand a
    -- subtask to.
    --
    -- The fourth table here that holds *form input, never a run*, after
    -- run_templates, chat_proposals and workflows: no folder claim, no
    -- concurrency slot, invisible to activeRuns(), and deleting one cannot
    -- reach a child that has already been spawned, because every spawn writes
    -- the whole definition onto its own argv rather than a reference to this
    -- row.
    --
    -- No tools column, no permission_mode column and no budget. What an agent
    -- may do comes from the guard set on the run it is delegated inside; the
    -- reasoning is in agents.ts beside the refusal that enforces it, and the
    -- absence of a column is the strongest form of it — there is nothing on
    -- the wire that could carry one.
    --
    -- model is nullable and means "inherit the session's". It is the one field
    -- run_templates deliberately refuses to hold, and it is not the same field:
    -- a template's model would be a second place to set the *run's* model,
    -- where this is the model one delegated turn runs on, which nothing else
    -- here can express.
    CREATE TABLE IF NOT EXISTS agents (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      -- What the delegating model reads to choose this agent. Required by the
      -- CLI, which drops a member without one and says nothing.
      description TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      model       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
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

    -- "Start this run only after those runs have settled."
    --
    -- A join table rather than a depends_on column on runs, because fan-in is
    -- the point: "after both of these" is a list with identity, and a column
    -- would either hold one id or a JSON array nothing can index or join.
    --
    -- The edge column is the condition, per edge rather than per run: one can
    -- reasonably want "only if that one worked" from one dependency and "once
    -- that one is out of the way" from another. Both ends cascade-delete with
    -- the runs they name, so a link never outlives either of them — which is
    -- also why the dependency is a real foreign key where chat_proposals'
    -- template_id deliberately is not: a proposal that names a deleted template
    -- must fail with a sentence, whereas a dependency on a run that is not
    -- there is a graph that can never be satisfied.
    CREATE TABLE IF NOT EXISTS run_deps (
      run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      depends_on TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      -- 'on-success' | 'on-finish'
      edge       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, depends_on)
    );

    -- A saved, re-runnable graph of run blocks.
    --
    -- The third table here that holds *form input, never a run*, after
    -- run_templates and chat_proposals: it takes no folder claim, consumes no
    -- concurrency slot, and nothing derived from activeRuns() can see it.
    --
    -- The graph is one JSON column rather than a nodes table and an edges
    -- table, which is the opposite of the choice run_deps makes — and the
    -- difference is what reads it. run_deps is queried at run time from the
    -- dependency end ("this run just finished; who was waiting on it?"), so it
    -- has to be indexable. A workflow is read and written whole by one form and
    -- joined against nothing; splitting it into two tables would buy an index
    -- nobody queries and cost a multi-statement rewrite on every save.
    --
    -- No guards, no permission mode, no model: a node names a template for
    -- those, or names none and takes settings.chatDefaultGuards. The reasoning
    -- is chat_proposals' above, and the rule is the same — the graph picks what
    -- work to do, something a person wrote picks what an agent may do.
    CREATE TABLE IF NOT EXISTS workflows (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      graph      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- One press of Run.
    --
    -- workflow_name and graph are copies taken at that moment, not a join: the
    -- workflow is editable and its blocks are replaced wholesale on every save,
    -- so a record that read through to the live row would describe an instance
    -- that never happened. Same reasoning run_reviews.diff_shown follows in
    -- recording what the model was actually shown.
    --
    -- Cascade-deleted with the workflow, and that takes nothing but this
    -- record: the runs carry their own prompt, guards and history, exactly as
    -- runs started from a template do.
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id            TEXT PRIMARY KEY,
      workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      workflow_name TEXT NOT NULL,
      graph         TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      -- 'started' | 'failed' | 'stopping'. 'failed' is a graph that could not
      -- be created in full, whose partial runs were stopped again — see
      -- startWorkflow. 'stopping' is the halt's closed door: written before any
      -- member is touched, so nothing can join the instance behind it, and it
      -- is what makes a second stop a no-op rather than a second kill ladder.
      --
      -- There is deliberately no 'stopped' value. Whether the halt has finished
      -- is a fact about the member runs — a signalled child takes seconds to
      -- die — so it is derived from their statuses at read time rather than
      -- written by a second pass that nothing would run after a restart.
      status        TEXT NOT NULL DEFAULT 'started',
      error         TEXT
    );

    -- Which run each block became.
    --
    -- run_id is a plain column rather than a foreign key, the same shape
    -- chat_proposals.run_id has: this is a historical record, and a run that is
    -- no longer there should read as "the run has gone" rather than take the
    -- block out of the instance it belonged to. node_name is copied for the
    -- reason the graph is — the workflow's own block may since have been
    -- renamed or removed. position is the topological order the runs were
    -- created in, which is the order the instance is read in.
    CREATE TABLE IF NOT EXISTS workflow_instance_runs (
      instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
      node_id     TEXT NOT NULL,
      node_name   TEXT NOT NULL,
      position    INTEGER NOT NULL,
      run_id      TEXT NOT NULL,
      PRIMARY KEY (instance_id, node_id)
    );

    -- Every block of an instance that is *not* a run.
    --
    -- Two kinds, and they are here together because what the scheduler needs of
    -- both is identical — a status it can read, and a sentence when the answer
    -- is "this will never happen":
    --
    --   'orchestrator' is a short agent turn that decides, when the workflow
    --   reaches it, which runs to create next. It is not a run and must never
    --   become one: it claims no folder, takes no checkout slot, consumes no
    --   concurrency slot, and activeRuns() cannot see it. cost_usd is its own
    --   spend, the same relation run_reviews.cost_usd and chat_sessions.cost_usd
    --   have to runs.spent_usd — never added to that column and never to a
    --   dashboard meter. It *is* added to the instance's own total, because that
    --   is money this press of Run spent; see instanceSpend.
    --
    --   'run' is a block that was never created, because an orchestrator block
    --   in front of it emitted nothing or could not decide. There is no run row
    --   to carry the reason, and a block that silently vanishes from the
    --   instance is the "waiting for ever" failure wearing different clothes —
    --   so the reason is recorded here instead, and the page shows it.
    --
    -- emitted_specs is what the turn's emit_runs tool accepted, held between the
    -- tool call and the moment the turn ends: the runs are created when the
    -- block settles, in one synchronous pass, for the reason startWorkflow
    -- creates a graph in one — createRun's folder claim is only atomic inside
    -- one event-loop turn.
    CREATE TABLE IF NOT EXISTS workflow_instance_blocks (
      instance_id   TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
      node_id       TEXT NOT NULL,
      node_name     TEXT NOT NULL,
      position      INTEGER NOT NULL,
      -- 'orchestrator' | 'run'. See above.
      kind          TEXT NOT NULL,
      -- 'waiting' | 'thinking' | 'emitted' | 'failed' | 'blocked'.
      status        TEXT NOT NULL DEFAULT 'waiting',
      started_at    INTEGER,
      finished_at   INTEGER,
      cost_usd      REAL NOT NULL DEFAULT 0,
      tokens        INTEGER NOT NULL DEFAULT 0,
      session_id    TEXT,
      emitted_specs TEXT,
      error         TEXT,
      PRIMARY KEY (instance_id, node_id)
    );

    -- When a saved workflow starts itself.
    --
    -- The one row in this database that starts a billed agent with nobody
    -- present at all: every other route into createRun has a person pressing
    -- something. What bounds it is written down in CLAUDE.md; what this table
    -- has to carry is the evidence, because an operator who cannot see what a
    -- schedule last did will not leave it switched on.
    --
    -- workflow_id is UNIQUE: one schedule per workflow, which is what lets the
    -- page state a single next fire time as an absolute instant. Two schedules
    -- on one graph would fire into each other's startWorkflow refusal for ever
    -- and there is no reading of that page that says so at a glance.
    --
    -- cursor_at is the last *occurrence* this schedule has decided about —
    -- started, skipped, or recorded as missed — and is not the same fact as
    -- last_fire_at, which is what the page shows. A boot advances the cursor
    -- to the moment of the boot without firing anything, which is what makes
    -- "a missed window is not made up" true rather than merely intended.
    --
    -- streak/streak_since collapse consecutive identical outcomes into one
    -- state. An hourly schedule firing into an instance that never finishes
    -- would otherwise be fifty rows saying the same thing, which is a log
    -- nobody reads rather than a fact anybody acts on. The streak keys on
    -- last_code and not on last_reason: the sentence carries a count that
    -- moves, and a streak that broke every time the count changed would not
    -- collapse the one case it exists for.
    CREATE TABLE IF NOT EXISTS workflow_schedules (
      id               TEXT PRIMARY KEY,
      workflow_id      TEXT NOT NULL UNIQUE REFERENCES workflows(id) ON DELETE CASCADE,
      -- The recurrence, as JSON. See ScheduleSpec in schedules.ts.
      spec             TEXT NOT NULL,
      -- The IANA zone the wall-clock times in spec are read in. Stored rather
      -- than assumed: the container runs in UTC and the operator does not, and a
      -- schedule stored in the server's zone fires an hour out twice a year.
      time_zone        TEXT NOT NULL,
      paused           INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      cursor_at        INTEGER,
      -- 'started' | 'overlap' | 'unbudgeted' | 'refused' | 'missed'.
      last_code        TEXT,
      last_reason      TEXT,
      last_at          INTEGER,
      last_fire_at     INTEGER,
      -- Plain column rather than a foreign key, the shape
      -- workflow_instance_runs.run_id already has: a record of what this
      -- schedule started, which must keep reading true after the row has gone.
      last_instance_id TEXT,
      streak           INTEGER NOT NULL DEFAULT 0,
      streak_since     INTEGER
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
    -- The worker's own query: the next queued row, across every batch. The
    -- columns are nextQueued's ORDER BY in its order — one batch at a time,
    -- oldest first, in the operator's order within it. Its predecessor sorted
    -- on (status, position), which is the interleaving that ordering caused;
    -- renamed rather than redefined, because CREATE INDEX IF NOT EXISTS leaves
    -- an existing index of the same name exactly as it was.
    CREATE INDEX IF NOT EXISTS idx_merge_queue_next
      ON merge_queue(status, created_at, batch_id, position);
    DROP INDEX IF EXISTS idx_merge_queue_status;
    CREATE INDEX IF NOT EXISTS idx_run_reviews_run
      ON run_reviews(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_created
      ON runs(created_at DESC);
    -- Every admission decision and every promotion pass reads the active rows.
    CREATE INDEX IF NOT EXISTS idx_runs_status
      ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_otlp_run
      ON otlp_requests(run_id, ts);
    -- The wake-up query reads the graph from the *dependency* end: a run has
    -- just finished, and what matters is who was waiting on it. The primary key
    -- already covers the other direction.
    CREATE INDEX IF NOT EXISTS idx_run_deps_depends_on
      ON run_deps(depends_on);
    -- Names identify a template to a person, so two that differ only in case
    -- are the same template as far as the picker is concerned. Enforced in the
    -- schema rather than checked before the insert: this process is a single
    -- writer, but a check-then-insert is still the wrong shape for a rule the
    -- database can state outright.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_templates_name
      ON run_templates(name COLLATE NOCASE);
    -- Same rule as a template's name, and one the CLI makes sharper: the name
    -- is the key of the object the --agents flag takes, so two rows differing
    -- only in case would be two members of one JSON object that a person reads
    -- as one agent — and the delegating model picks between them by
    -- description.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name
      ON agents(name COLLATE NOCASE);
    -- Same rule as a template's name, for the same reason: a workflow is picked
    -- out of a list by a person, so two that differ only in case are one
    -- workflow as far as that list is concerned.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_name
      ON workflows(name COLLATE NOCASE);
    -- The detail page's own query: this workflow's instances, newest first.
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_workflow
      ON workflow_instances(workflow_id, created_at DESC);
    -- Read from the run end by the "is anything from this workflow still
    -- going?" check, which both Run and Delete ask before they do anything.
    CREATE INDEX IF NOT EXISTS idx_workflow_instance_runs_run
      ON workflow_instance_runs(run_id);
    -- The scheduler's own query: which instances still have a block that has
    -- not settled. Asked after every terminal run transition, so it must not be
    -- a scan of every instance ever started.
    CREATE INDEX IF NOT EXISTS idx_workflow_instance_blocks_status
      ON workflow_instance_blocks(status, instance_id);
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

  // Whether the agent's last work cycle actually replied DONE. `completed` is
  // written for two different endings — that reply, and the cycle cap being
  // reached — and only the first of them may be answered with the DONE
  // pushback, which opens by telling the agent it reported the task complete.
  // The stop reason distinguishes them in prose, which is not something to
  // parse. Rows written before this column read as false: sending a
  // continuation into a session that did say DONE costs one billed cycle that
  // says it again, where the pushback tells a run that was cut off mid-task not
  // to start new work.
  addColumn(db, "runs", "reported_done", "INTEGER NOT NULL DEFAULT 0");

  // What the next work cycle says, when an operator has picked a finished run
  // up by hand. Consumed rather than kept: the loop clears it the moment it
  // hands it to a spawn, so a run that parks or is picked up again later does
  // not deliver the same message twice.
  addColumn(db, "runs", "follow_up", "TEXT");

  // The work cycle that is open right now, stamped at the spawn and cleared the
  // moment it returns. `iterations` counts cycles that *finished*, so for the
  // whole of cycle 1 — routinely tens of minutes — a working run read `0/N`,
  // which is bit-for-bit what a run that never started reads. Its own column
  // rather than an early write to `iterations`: the guard and every "cycles
  // used" reading must keep meaning completed cycles.
  addColumn(db, "runs", "active_iteration", "INTEGER");

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

  // The specialised agent this run's main thread may hand a subtask to, frozen
  // as the whole definition rather than as a reference to an `agents` row.
  //
  // A reference is what this looks like it wants and it is wrong twice over. A
  // run spawns a child per work cycle, so an agent deleted between cycle 3 and
  // cycle 4 would leave cycle 4 with no specialist and nothing saying so — the
  // one failure shape the whole of agents.ts exists to end, arriving from inside
  // this app rather than from the CLI. And a run picked up by hand days later
  // would lose it the same way. So it is a copy, the treatment runs.budget
  // already gives permissionMode and the reason deleting a template cannot reach
  // a run started from one.
  //
  // Null is the ordinary run. It is display as well as spawn input, and the
  // display is honest about what the flag does: --agents *offers* a role to the
  // delegating model, which is what a sub-agent is — it is not --agent, which
  // would replace the session's own main agent and which nothing here wires.
  addColumn(db, "runs", "agent", "TEXT");

  // The agent a template names, by id — and this one *is* a reference, which is
  // the opposite of the column above for a reason. A template is form input
  // applied again and again, so an operator who fixes their reviewer's prompt
  // expects the next run from that template to use the fixed one; a run is a
  // record of work that happened, so it keeps what it was actually given.
  // A template naming an agent that has since gone is refused at both doors by
  // name — see `agentRefusal` — rather than falling back to none.
  addColumn(db, "run_templates", "agent_id", "TEXT");

  // The run whose branch this one carries on, so a second agent extends the
  // first one's commits instead of branching from the target again.
  //
  // Written at *admission*, unlike every other isolation column, and that
  // asymmetry is the point. The others are claims on disk — a checkout slot, a
  // branch name — and a waiting run must hold none of them. This one is an id
  // and a sentence of intent: it costs nothing, it is the operator's own
  // answer, and the landing rules need it before the branch exists in order to
  // know that a chain is coming. `worktree_branch` is still null until the run
  // is released, which is when the predecessor's branch is finally known.
  addColumn(db, "runs", "continues_run", "TEXT");

  // The same fact as the operator stated it: "and take that one's branch".
  //
  // On the edge rather than on the run because only an edge can say *which*
  // dependency hands the branch over — a fan-in has several, and a column on
  // `runs` naming an id that is not among them is a state nothing checks.
  // `runs.continues_run` above is the resolved decision the rest of the app
  // reads, exactly as `isolation` is the decision and `isolate` was the
  // request.
  addColumn(db, "run_deps", "continue_branch", "INTEGER NOT NULL DEFAULT 0");

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

  // What this proposal is a proposal *of*. 'run' is the original and the
  // default, and it has to be: every row written before a workflow could be
  // proposed says nothing here, and the other reading would turn a queued run
  // into a graph nobody wrote. 'workflow' is the second, and approving one
  // saves a workflow rather than starting anything — see `planWorkflowProposal`.
  addColumn(db, "chat_proposals", "kind", "TEXT NOT NULL DEFAULT 'run'");

  // The chat's own label for a proposal, and the labels it says this one starts
  // after. Both null on a proposal that neither names itself nor waits for
  // anything, which is every proposal made before dependencies existed.
  //
  // The label is the chat's, not this app's: the model writes several proposals
  // in one turn and has to be able to point one at another before either has an
  // id. It is resolved to a *run* id at approval, against the proposals of this
  // chat, and a label that resolves to nothing fails that one proposal with a
  // sentence rather than starting it with no dependency at all — which is the
  // silent failure `releasableRuns` exists to have none of.
  addColumn(db, "chat_proposals", "spec_id", "TEXT");
  addColumn(db, "chat_proposals", "depends_on", "TEXT");

  // The graph a workflow proposal carries, normalized by the same
  // `normalizeWorkflowInput` the save route runs, and the workflow approving it
  // created. Null on a run proposal, exactly as `run_id` is null on a workflow
  // one — the two kinds settle onto different rows and neither should be read
  // off the other's column.
  addColumn(db, "chat_proposals", "graph", "TEXT");
  addColumn(db, "chat_proposals", "workflow_id", "TEXT");

  // The saved agent a proposed run may hand a subtask to, by id — and an **id**
  // rather than the frozen copy `runs.agent` holds, for `run_templates`'
  // reason: a proposal is form input that a person reads and decides on, so it
  // should still name the agent as it stands at the click rather than as it
  // stood when the model wrote the card. The copy is taken where it always is,
  // by `createRun`, at the moment the run exists.
  //
  // Not a foreign key, exactly as `template_id` above is not: an agent deleted
  // between the proposal and the approval must fail the approval with a
  // sentence naming it, not silently take the row the operator is looking at
  // with it — and never fall back to no specialist, which is bit-for-bit the
  // run the whole registry exists to stop.
  //
  // It carries no capability. An agent holds no tool list and no permission
  // mode, so this is not a route to `--permission-mode` reached by a model;
  // every guard on a proposed run still comes from `template_id` above or from
  // the untemplated guard set in settings.
  addColumn(db, "chat_proposals", "agent_id", "TEXT");

  // The order a chat's messages were written in, because `ts` does not decide
  // it: `finishTurn` appends the reply, an error and a denial note inside one
  // synchronous block, so they routinely share a millisecond, and the primary
  // key they were then ordered by is a random UUID — a coin toss rather than a
  // tiebreak, which rendered a footnote above the message it annotates and so
  // reversed what the operator was being told. Recorded rather than taken from
  // `rowid`, which SQLite is free to renumber on a VACUUM or a table rebuild.
  //
  // The backfill is the *existing* rows' order: `rowid` on a table nothing has
  // rebuilt is the order they were inserted, so a deployed thread keeps the
  // order it was written in. It runs on every boot rather than only on the one
  // that adds the column — it is a scan of a small table, and it repairs a null
  // rather than leaving a message to sort to the top of a thread. `seq` must be
  // set by every insert; `appendMessage` is the only one there is.
  addColumn(db, "chat_messages", "seq", "INTEGER");
  db.exec("UPDATE chat_messages SET seq = rowid WHERE seq IS NULL");

  // When the turn now in flight began, so the ten-minute bound on a chat turn
  // is enforceable by something outside the closure that spawned it. Not
  // `updated_at`, which looks like the same instant and is not: the chat's own
  // `save_template` tool appends a system message mid-turn, and every such
  // append would push the deadline out by however long the turn has already
  // run. Null whenever no turn is in flight.
  addColumn(db, "chat_sessions", "turn_started_at", "INTEGER");

  // That this instance was halted, by what, and when.
  //
  // `stopped_at` is the moment the door was closed rather than the moment the
  // last child died: a halt marks the row `stopping` and then walks the
  // members, and what the operator needs to know is when nothing further could
  // join. `stop_cause` is 'operator' or 'guard' and is what makes the three
  // ways a member run can end tellable apart on sight — the third is a run
  // stopped on its own page, which no instance records at all. `stop_reason`
  // carries a guard's verdict in full, here rather than copied onto every
  // member row, because it is one fact about one instance.
  addColumn(db, "workflow_instances", "stopped_at", "INTEGER");
  addColumn(db, "workflow_instances", "stop_cause", "TEXT");
  addColumn(db, "workflow_instances", "stop_reason", "TEXT");

  // Limits on a whole press of Run rather than on one block, as JSON — the
  // shape `runs.budget` already uses. Null on a row written before this
  // existed, which `normalizeInstanceBudget` reads as every limit off, the same
  // thing a saved workflow that sets none stores.
  //
  // Held in **two** places on purpose. `workflows.instance_budget` is the saved
  // configuration a person edits; `workflow_instances.instance_budget` is the
  // copy the instance was started under, taken once at instantiation. That is
  // the rule the graph blob beside it already follows, and it is what makes
  // editing a workflow unable to reach an instance that is already running —
  // including the guard the running instance is being measured against. There
  // is deliberately no route that writes the instance's copy.
  addColumn(db, "workflows", "instance_budget", "TEXT");
  addColumn(db, "workflow_instances", "instance_budget", "TEXT");

  // When the cycle named by `active_iteration` was spawned.
  //
  // The other half of the fact that column already carries, and it exists for
  // one reason: `telemetrySpendSince(runId, since)` needs a lower bound that
  // excludes the cycles already folded into `spent_usd`, and until now the only
  // thing holding one was a local variable inside `startRun`'s frame — reachable
  // by that run's own live guard and by nothing else. A workflow instance's
  // guard has to read the same figure for a *different* run, so the bound moves
  // onto the row. Stamped and cleared in exactly the three places
  // `active_iteration` is, and read only for a `running` row, since nothing
  // clears either when the container dies mid-cycle.
  addColumn(db, "runs", "active_started_at", "INTEGER");

  // The orchestrator block that started this run, or null for a block a person
  // wrote into the graph. A plain column rather than a foreign key, the shape
  // the run_id beside it already has: this is a record of where a run came
  // from, and it must keep reading true after the block's row has gone.
  addColumn(db, "workflow_instance_runs", "emitted_by", "TEXT");

  // The merge batch a merge block queued, or null for every other kind.
  //
  // The block's own row records that it merged and whether that worked; this
  // records *which branches*, by pointing at the rows the queue already writes
  // per branch. Kept rather than copied into the block, because those rows carry
  // git's own answer for each one and a second copy would be a second thing to
  // keep in step. A plain column for `emitted_by`'s reason: it must keep reading
  // true after the batch has been pruned.
  addColumn(db, "workflow_instance_blocks", "merge_batch_id", "TEXT");

  // What an orchestrator turn said, and what this app refused it — the two
  // halves of "why did this block start nothing", neither of which was recorded
  // anywhere.
  //
  // The turn's own system prompt asks it to reply with what it emitted and what
  // it deliberately left out, and that reply was read off stdout and dropped on
  // the floor: a block that spent money and started no runs left a row saying
  // `emitted`, zero runs, no error and no sentence, which is bit-for-bit what a
  // block that decided there was nothing to do leaves. `reply` is the model's
  // own voice, verbatim; `notes` is this app's — an emit_runs call it refused,
  // a tool call the CLI declined, an instance guard it could not read. Kept
  // apart on purpose, and apart from `error`, which means the turn *failed*:
  // "it said there was nothing worth doing" and "it tried and we said no" are
  // different answers to the operator's question and only one of them is about
  // the model.
  addColumn(db, "workflow_instance_blocks", "reply", "TEXT");
  addColumn(db, "workflow_instance_blocks", "notes", "TEXT");

  // Things that happened to the *server* rather than to a run.
  //
  // `run_events` is per run and cascades with it, so the one moment there is
  // nothing to attach to is the moment worth recording: a restart that closed
  // out every run it found. That was one `console.warn` into a stream nobody
  // tails — twenty-five runs terminated, each needing a manual reopen, reported
  // once and then unanswerable. This is where it is kept so a page can say it.
  //
  // `detail` is JSON and holds counts, never prose about a folder or a prompt:
  // the status endpoint is read by a monitor, and rows here are what it reads.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_events (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      level  TEXT NOT NULL,
      event  TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ops_events_event ON ops_events(event, ts);
  `);
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
