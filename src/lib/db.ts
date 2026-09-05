import fs from "node:fs";
import Database from "better-sqlite3";
import { DATA_DIR, DB_PATH } from "./config";
import { heldByAnotherProcess } from "./serverLock";

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

/**
 * What this build's `migrate()` produces, written to `PRAGMA user_version`.
 *
 * Not a migration framework and deliberately not one — the ~50 `addColumn`
 * calls stay idempotent by reading the live schema, which is the correct check
 * for an additive change and which a version number could not replace without
 * one number per column. What this records is the two states reading the schema
 * cannot tell you: that a *rebuild* has completed, and that the file was last
 * written by a build newer than this one. Bump it whenever a migration is
 * something other than an added column or an `IF NOT EXISTS`.
 *
 * 1 is the first version. Everything shipped before it reads 0, which is also
 * what a brand-new file reads — the two are indistinguishable and it does not
 * matter, since `migrate()` is idempotent either way.
 */
export const SCHEMA_VERSION = 1;

export type SchemaVerdict = "unversioned" | "current" | "upgrade" | "downgrade";

/**
 * What the file's own version says about the build that is opening it.
 *
 * Pure, because the interesting case cannot be produced by running this build:
 * a `downgrade` is a rollback to an older image after a failed deploy, and what
 * it costs is that `migrate()` is about to run against a schema it does not
 * know. It is reported rather than refused — an older build's migrate is
 * additive and its rebuild guard is a live-schema read, so it leaves a newer
 * file alone — but a state nothing can name is a state nobody debugs.
 */
export function schemaVerdict(file: number, code: number): SchemaVerdict {
  if (file === 0) return "unversioned";
  if (file === code) return "current";
  return file < code ? "upgrade" : "downgrade";
}

/**
 * May this process write the schema?
 *
 * `open()` runs on the first `db()` call in *any* process, which is how a
 * second server — an agent's `next dev` against its own worktree, pointed at
 * the live database by an inherited `DATA_DIR` — was entitled to rebuild a
 * table under the server that owns it. `serverLock.ts` already answers who owns
 * the directory; this is the same claim gating the one write that is not
 * additive.
 *
 * The empty-file exception is what keeps that from being a new failure. A
 * process that owns nothing and finds no schema has nothing to destroy, and
 * refusing there would leave it with a database that has no tables and every
 * query throwing until a restart. The hazard is a rebuild against *existing
 * data*, and an empty file has none.
 */
function shouldMigrate(db: Database.Database): boolean {
  if (!heldByAnotherProcess()) return true;
  if (!tableExists(db, "settings")) return true;
  console.warn(
    `[usagefoundry] Another server process holds ${DATA_DIR}. Leaving the ` +
      "schema exactly as it is — migrations belong to the process that owns " +
      "this directory.",
  );
  return false;
}

function open(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  // WAL keeps the dashboard's frequent reads from blocking on run writes.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (shouldMigrate(db)) migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  const found = Number(db.pragma("user_version", { simple: true }));
  if (schemaVerdict(found, SCHEMA_VERSION) === "downgrade") {
    console.error(
      `[usagefoundry] This database was written by a newer build (schema ` +
        `${found}; this build knows ${SCHEMA_VERSION}). Migrating anyway — ` +
        `every step below is additive or guarded by the live schema — but a ` +
        `rollback has no defined behaviour here and anything the newer build ` +
        `added is invisible to this one.`,
    );
  }

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

    -- A named agent: the role a run itself takes, carried onto a spawn as an
    -- --agents definition and an --agent selection.
    --
    -- The fourth table here that holds *form input, never a run*, after
    -- run_templates, chat_proposals and workflows: no folder claim, no
    -- concurrency slot, invisible to activeRuns(), and deleting one cannot
    -- reach a child that has already been spawned, because every spawn writes
    -- the whole definition onto its own argv rather than a reference to this
    -- row.
    --
    -- No tools column, no permission_mode column and no budget. What a run may
    -- do comes from its own guard set and never from the role it takes — which
    -- matters more since --agent, because the run *is* this record; the
    -- reasoning is in agents.ts beside the refusal that enforces it, and the
    -- absence of a column is the strongest form of it — there is nothing on
    -- the wire that could carry one.
    --
    -- model is nullable and means "keep whatever model the run already had".
    -- run_templates now holds one too — see the addColumn note below and the
    -- paragraph in templates.ts that replaced the refusal — so this is no
    -- longer the only saved record that names one. What keeps *this* one from
    -- being a place that overrides a choice somebody made is measured rather
    -- than structural: an explicit --model outranks it on the pin, so it fills
    -- a gap the run left, whether the run left it or its template did.
    CREATE TABLE IF NOT EXISTS agents (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      -- What a person reads on a picker when they choose this agent. Required
      -- by the CLI, which will not register a member without one — so --agent
      -- cannot select it and the spawn fails.
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
    -- work to do, something a person wrote picks what an agent may do. The
    -- model reads as one of those now rather than as an absence with nowhere to
    -- come from: run_templates holds one, planNode takes it with the prompt and
    -- the guards, and a node still names a template rather than carrying its
    -- own.
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
    -- Three kinds, and they are here together because what the scheduler needs
    -- of all of them is identical — a status it can read, and a sentence when
    -- the answer is "this will never happen":
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
    --   'loop' repeats one task, creating a fresh run per pass — each carrying
    --   on the previous pass's branch, so the run graph stays a DAG and no edge
    --   ever points backwards. It spawns nothing of its own, so its cost_usd
    --   stays 0 and every pass's spend is on that pass's own run row. Its
    --   passes are workflow_instance_runs rows with emitted_by set to it, the
    --   same column an orchestrator block's runs use, which is what makes the
    --   instance budget guard, the halt and the second-press refusal cover a
    --   pass with no new code.
    --
    --   'run' is a block that was never created, because the block in front of
    --   it emitted nothing, took no passes, or could not decide. There is no run
    --   row to carry the reason, and a block that silently vanishes from the
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
      -- 'orchestrator' | 'loop' | 'run'. See above.
      kind          TEXT NOT NULL,
      -- 'waiting' | 'thinking' | 'looping' | 'emitted' | 'failed' | 'blocked'.
      -- 'looping' is a loop with passes in flight or another one to decide on;
      -- it is live wherever 'thinking' is, and deliberately not a settled
      -- status — a block behind it must not be released while the loop can
      -- still commit to the branch.
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

    -- Browser sign-ins. One row per issued uf_session cookie, so a session has
    -- a server-side referent at all: the cookie used to *be* UF_AUTH_TOKEN, so
    -- there was nothing to count, nothing to revoke, and no answer to "how many
    -- sessions exist" short of changing the environment and restarting.
    --
    -- The id is the random handle inside the cookie, never the signature and
    -- never the token. expires_at is the same instant the cookie carries in its
    -- signed payload, kept here so a revocation sweep can drop rows that can no
    -- longer be presented.
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id          TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      revoked_at  INTEGER
    );

    -- Failed sign-ins, per source and one row for the whole install. Durable
    -- rather than in memory for two reasons: a burst has to still be visible
    -- after the fact — nothing anywhere recorded that anyone had ever guessed
    -- at the token — and a lockout that a container restart clears is a lockout
    -- an attacker can clear by restarting the container.
    --
    -- The source column is the client address as reported to us, or '*' for
    -- the install-wide bucket. See loginLimiter.ts for why the second one has
    -- to exist at all.
    CREATE TABLE IF NOT EXISTS login_attempts (
      source       TEXT PRIMARY KEY,
      failures     INTEGER NOT NULL,
      first_at     INTEGER NOT NULL,
      last_at      INTEGER NOT NULL,
      locked_until INTEGER
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

    -- A question the chat put to the operator, and what came back.
    --
    -- The second approval-shaped table on this path and it holds what
    -- chat_proposals holds: nothing. No guard, no permission mode, no folder
    -- claim, no concurrency slot, and nothing derived from activeRuns() can see
    -- it. A question is a sentence and an answer is a sentence, so there is
    -- deliberately no column here a model could route a budget through.
    --
    -- It is a table at all because a turn cannot wait. CHAT_TIMEOUT_MS kills an
    -- overrunning child and throws its answer away, so a tool that blocked
    -- until the operator clicked would burn ten minutes and lose the turn that
    -- asked. Asking therefore *ends* the turn, and the answer arrives as the
    -- next turn's user message against the same resumed session.
    CREATE TABLE IF NOT EXISTS chat_questions (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      -- What was asked, in the model's own words. Stored rather than left to be
      -- read out of the thread because the answer quotes it back: the turn that
      -- reads the answer is a fresh child, and "the second one" is not an
      -- answer to anything it can see.
      question    TEXT NOT NULL,
      -- JSON string[]: the concrete answers offered, or '[]' for a question
      -- with none. A JSON column rather than a fourth table for
      -- chat_proposals.depends_on's reason — it is written and read whole, by
      -- one module, and is never joined against.
      choices     TEXT NOT NULL DEFAULT '[]',
      -- Whether the operator may type instead of picking one of the choices.
      -- Separate from the choices being empty, because "pick one of these
      -- three" and "pick one of these three or say something else" are
      -- different questions, and a UI that inferred the second from a non-empty
      -- list would silently widen every question the model meant to close.
      allow_text  INTEGER NOT NULL DEFAULT 1,
      -- 'pending' | 'answered' | 'superseded'. The third is the operator
      -- answering by saying something else: the question was overtaken, and a
      -- card left clickable would send an answer into a conversation that has
      -- already moved past it. Kept rather than deleted, so the thread reads as
      -- what happened.
      status      TEXT NOT NULL DEFAULT 'pending',
      -- What the operator said, exactly as they said it. Null until answered,
      -- and null for ever on a superseded one.
      answer      TEXT,
      answered_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_run_events_run
      ON run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat
      ON chat_messages(chat_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chat_proposals_chat
      ON chat_proposals(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_questions_chat
      ON chat_questions(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_merge_queue_batch
      ON merge_queue(batch_id, position);
    -- The worker's own query: the next queued row, across every batch. The
    -- columns are nextQueuedIn's ORDER BY in its order — one batch at a time,
    -- oldest first, in the operator's order within it. Its predecessor sorted
    -- on (status, position), which is the interleaving that ordering caused;
    -- renamed rather than redefined, because CREATE INDEX IF NOT EXISTS leaves
    -- an existing index of the same name exactly as it was. The repository the
    -- query now also filters on is not a column here: it lives on the runs
    -- table and is reached by a join, and this index still supplies the order.
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
    -- is the key of the object --agents takes *and* the word --agent is handed
    -- to select one, so two rows differing only in case would be two members of
    -- one JSON object that a person reads as one agent — and which of them a
    -- run was started as would be whichever the CLI resolved.
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
  // second boot. Checking the live schema is the idempotent option, and it
  // stays the right one for these: `PRAGMA user_version` records that a
  // *rebuild* completed (see `SCHEMA_VERSION`), which is the state a schema
  // read cannot answer, but keying fifty additive columns on one number would
  // mean fifty numbers or an ordering nobody can change.
  // WHAT THE QUEUE IS ALLOWED TO CONSIDER BESIDES AGE.
  //
  // Every selection over `runs` in the orchestrator ordered by `created_at`
  // alone, so the `queuePosition` the UI showed was a report of a position
  // nothing could change: an operator who needed one run before another could
  // only cancel and recreate it, which loses the run's history and its spend.
  //
  // Higher runs first, and `created_at` still breaks every tie — so an install
  // that never touches this column queues exactly as it did before. Default 0
  // rather than NULL for the same reason: a NULL would make the ordering
  // depend on SQLite's collation of nulls, and every existing row would have
  // to be backfilled before the queue behaved predictably.
  addColumn(db, "runs", "priority", "INTEGER NOT NULL DEFAULT 0");
  // WHAT MAKES TWO RUNS THE SAME TASK, for the relative cost guard.
  //
  // A hash of folder + normalised prompt, written once at creation. Stored
  // rather than computed on read because the guard runs before every work
  // cycle and a LIKE over `prompt` would be a table scan on the hot path; and
  // hashed rather than raw because `runs.prompt` for a private repository is a
  // complete product brief, and this value ends up in an index.
  addColumn(db, "runs", "task_signature", "TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS runs_task_signature ON runs(task_signature, status)",
  );
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

  // The agent this run was started **as**, frozen as the whole definition
  // rather than as a reference to an `agents` row.
  //
  // A reference is what this looks like it wants and it is wrong twice over,
  // more so since --agent. A run spawns a child per work cycle, so an agent
  // deleted between cycle 3 and cycle 4 would leave cycle 4 selecting a name
  // nothing on its argv defines — which the CLI refuses at the spawn, so the run
  // stops being what it was started as and then stops running at all. And a run
  // picked up by hand days later would lose it the same way. So it is a copy,
  // the treatment runs.budget already gives permissionMode and the reason
  // deleting a template cannot reach a run started from one.
  //
  // Null is the ordinary run. It is display as well as spawn input, and the
  // display is honest about what the flag does: sessionAgentArgs emits both
  // --agents (the definition) and --agent (the selection), so the saved prompt
  // is this run's own system prompt and not a role inside it.
  addColumn(db, "runs", "agent", "TEXT");

  // What this run's largest files cost to read, generated once and never again.
  //
  // A frozen copy for `runs.agent`'s reason turned up one notch. That column is
  // frozen so a run's later cycles open as the agent it was started as; this one
  // is frozen because **the appended system prompt is part of the cached
  // prefix**, so text that differed between cycle 1 and cycle 2 would leave
  // every token behind it cold on cycle 2. On the context sizes this app runs at
  // that costs far more than the notice can ever save, and nothing about the run
  // would look wrong while it happened — the failure is a bill, not an error.
  // Both of its inputs move under a recomputation: the read counts change as the
  // fleet works, and the file sizes change as this very run edits them.
  //
  // Null is the whole of the backward-compatible case and there is no backfill.
  // A run created before this column reads null, `buildArgs` drops an empty
  // notice from the joined prompt, and its argv is byte-identical to what it was
  // spawned with — which is what a run mid-flight across a deploy needs, for
  // exactly the prefix reason above. See `fileCostNotice.ts` for what the text
  // is and why it is worth its tokens.
  addColumn(db, "runs", "file_cost_notice", "TEXT");

  // The agent a template names, by id — and this one *is* a reference, which is
  // the opposite of the column above for a reason. A template is form input
  // applied again and again, so an operator who fixes their reviewer's prompt
  // expects the next run from that template to use the fixed one; a run is a
  // record of work that happened, so it keeps what it was actually given.
  // A template naming an agent that has since gone is refused at both doors by
  // name — see `agentRefusal` — rather than falling back to none.
  addColumn(db, "run_templates", "agent_id", "TEXT");

  // The model a run from this template is started on. Null means the template
  // names none, which is every row that existed before this column and is the
  // right answer for all of them — there is no backfill, because a template
  // that named nothing is not a template that named today's default.
  //
  // This is the column `templates.ts` argued against holding for as long as the
  // run form did not offer a model; the paragraph there records why the refusal
  // stood and what changed. What keeps it from being a route to anything a
  // template may not reach is that a model moves cost and never capability: it
  // reaches `--model` and nothing else, every cost guard already covers it
  // because the run's spend lands on its own `result` event whatever model
  // produced it, and the two routes to `--permission-mode` are still two.
  addColumn(db, "run_templates", "model", "TEXT");

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

  // The saved agent a proposed run is started as, by id — and an **id**
  // rather than the frozen copy `runs.agent` holds, for `run_templates`'
  // reason: a proposal is form input that a person reads and decides on, so it
  // should still name the agent as it stands at the click rather than as it
  // stood when the model wrote the card. The copy is taken where it always is,
  // by `createRun`, at the moment the run exists.
  //
  // Not a foreign key, exactly as `template_id` above is not: an agent deleted
  // between the proposal and the approval must fail the approval with a
  // sentence naming it, not silently take the row the operator is looking at
  // with it — and never fall back to no agent, which is bit-for-bit the run the
  // whole registry exists to stop.
  //
  // It carries no capability. An agent holds no tool list and no permission
  // mode, so this is not a route to `--permission-mode` reached by a model;
  // every guard on a proposed run still comes from `template_id` above or from
  // the untemplated guard set in settings.
  addColumn(db, "chat_proposals", "agent_id", "TEXT");

  // The model a proposed run is started on, as the chat named it, or null for
  // "whatever the template or the operator's default says".
  //
  // **This is not the rule below lapsing.** A model is not a guard, and the
  // argument is `agents.ts`': it moves cost rather than capability, and every
  // cost guard already covers it, since the run's spend lands on its own
  // `result` event and in its telemetry whatever model produced it. So a model
  // the chat names changes what the run costs and nothing about what it may do:
  // the budget, the work-cycle limit, the permission mode and the isolation
  // choice still come from `template_id` or from `settings.chatDefaultGuards`,
  // and there is still no field on `propose_run` and no argument anywhere that
  // reaches one. That is also why the run page refuses to draw a model inside
  // the guard group — a value under the shield claims to bound something.
  //
  // Free-form, exactly as `run_templates.model` and `agents.model` are: an
  // alias, a full id, or `inherit`. Narrowing it to a list this build knows
  // would refuse the model that ships next month, and getting it wrong is a
  // spawn that fails loudly rather than a run that quietly runs wider.
  //
  // Precedence is stated once and applied once, in `planProposal`: this, then
  // the template's, then `settings.defaultModel` at `createRun`.
  //
  // Deliberately not in PROPOSAL_BASE_COLUMNS, for the reason `guards_json`
  // below states — `relaxProposalTemplate` runs before every `addColumn` here.
  addColumn(db, "chat_proposals", "model", "TEXT");

  // The untemplated guard set as it stood when the proposal was written, as
  // JSON, and null on a templated one — whose guards are a *handle* the
  // operator can go and read, so that one is read live at the click and stays
  // that way. An untemplated card spells the values out instead, and a card
  // that spells values out is a promise: the set is frozen here so that editing
  // `chatDefaultGuards` between the render and the click cannot start a run
  // under rules no card ever stated.
  //
  // It carries nothing a model wrote. `createProposal` fills it from
  // `chatGuards()` server-side; there is no field on `propose_run` and no
  // argument anywhere that can reach it, which is `prompt_override`'s rule above
  // — prompt text is the half of a run a model may write, and this is exactly
  // what guards are not.
  //
  // Deliberately not in PROPOSAL_BASE_COLUMNS, and it must not be added there:
  // `relaxProposalTemplate` runs before every `addColumn` on this table, so a
  // file still carrying the NOT NULL that rebuild exists to drop has never had
  // this column at all, and naming a column the old table does not have would
  // fail the copy for every install that has one to make.
  addColumn(db, "chat_proposals", "guards_json", "TEXT");

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

  // Which turn the row is in, so a settle can say which turn it belongs to.
  //
  // `finishTurn` latched on `status='thinking'` alone, and that is not an
  // identity: `endTurn` settles the row to `failed` and returns without waiting
  // for the child it signalled, `claimTurn` admits any status that is not
  // `thinking`, so a message sent inside the eight seconds of the signal ladder
  // puts the row back to `thinking` — and the *previous* turn's child then walks
  // through the latch and settles the new turn's row with its text, its cost and
  // its session id. The live turn is then unwatched (the sweeper reads
  // `thinking` rows), its own answer is discarded against an `idle` row, and the
  // one-billed-child guard is open because that guard reads the row.
  //
  // A counter rather than `turn_started_at`, which is otherwise written and
  // cleared in exactly the right places: it is `Date.now()`, and two turns
  // claimed inside one millisecond would share it. That is not hypothetical
  // here — a Stop and a re-send are both synchronous once `assistRefusal()`
  // has answered — and the failure it would reintroduce is the silent one this
  // column exists to close. Monotone per chat, so no value is ever reused.
  //
  // `NOT NULL DEFAULT 0` so every existing row already has a turn number, and
  // the rows that were `thinking` when it was added are failed out by
  // `reconcileChatsOnBoot` on the same boot: their children died with the
  // process that spawned them and no settle is coming for them.
  addColumn(db, "chat_sessions", "turn_seq", "INTEGER NOT NULL DEFAULT 0");

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

  // The orchestrator block that started this run, or the loop block whose pass
  // it is — null for a block a person wrote into the graph. A plain column
  // rather than a foreign key, the shape the run_id beside it already has: this
  // is a record of where a run came from, and it must keep reading true after
  // the block's row has gone.
  //
  // A loop's passes carry no pass number of their own: they are ordered by
  // `position`, which only ever increases, so pass N is the Nth row. Derived
  // rather than stored, the same choice `workflow_instances.status` makes for
  // 'stopped' — and it means nothing has to parse a number back out of a
  // node_id, which is the mistake `splitPatches` exists to avoid.
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

  // Whether this run was closed out because the server went down under it,
  // rather than for any reason of its own.
  //
  // A flag rather than a reading of `stop_reason`, which is prose: it is
  // user-visible copy and the one thing in this codebase that must never
  // become a parse — `reported_done` exists as its own column for exactly that
  // reason one table over. And it has to be a *fact about the ending* rather
  // than a status, because a restart now produces two of them: a run the
  // shutdown handler stopped cleanly, and a run `reconcileOnBoot` failed
  // because the process never got that far.
  //
  // What reads it is the one thing an operator could not do before — see that
  // twenty-five runs are sitting recoverable, and pick them all up, without
  // opening twenty-five pages. `reopenRun` clears it, so the count is what is
  // still outstanding rather than a history of every restart this install has
  // ever had.
  addColumn(db, "runs", "restart_closed", "INTEGER NOT NULL DEFAULT 0");

  // When an operator set this run aside — "leave this one alone".
  //
  // Both bulk pick-ups act on a *set*: the restart notice on every
  // `restart_closed` row, and the fleet's on every terminal run the page is
  // displaying. So a run somebody had deliberately stopped was swept back into
  // work by a press aimed at the twenty-four beside it, and there was nothing
  // an operator could say to stop that short of never using either button.
  //
  // A fact about the operator's intent, and deliberately not about the ending:
  // it leaves `status`, `stop_reason` and `restart_closed` exactly as they were,
  // so putting the run back restores the row it already had rather than a state
  // it was never in. Which is also why the two bulk readers *filter* on it
  // rather than clearing anything — a run set aside and then put back is in the
  // restart notice again, because the restart is still holding it up.
  //
  // Nullable rather than a flag, for `reopened_at`'s reason: when somebody
  // decided this is the only thing separating a run held back on purpose from
  // one nobody has looked at yet. `reopenRun` clears it, because picking a run
  // up by hand is that decision being taken back.
  addColumn(db, "runs", "set_aside_at", "INTEGER");

  // Which gate this run came through, and the record that authorised it.
  //
  // Runs arrive from five routes and three of them start an agent with nobody
  // at the keyboard, so "who started this" had no answer at all: provenance was
  // a deduction across chat_proposals, workflow_instance_runs and
  // workflow_instance_runs.emitted_by, absence in all three was ambiguous
  // between the run form and a run picked up by hand, and none of it survived
  // deleting the chat or workflow it came from.
  //
  // Written once, by `createRun`, and never rewritten — `origin` answers "which
  // route created this", so a query grouped by it over a time range has to keep
  // meaning that. Picking a finished run up again is a different act and gets
  // `reopened_at` below rather than overwriting this.
  //
  // Plain columns, `emitted_by`'s rule: a proposal id or an instance id here is
  // a record of where a run came from and must keep reading true after that row
  // has gone, so neither is a foreign key and neither cascades.
  addColumn(db, "runs", "origin", "TEXT");
  addColumn(db, "runs", "origin_ref", "TEXT");
  // When a person last put this terminal run back in the queue. The other half
  // of the question `origin` answers: a run created by the form at 09:00 and
  // reopened at 02:00 is two authorisations, and overwriting the first with the
  // second would lose the one the column exists for.
  addColumn(db, "runs", "reopened_at", "INTEGER");

  // What the agent said when it reported it could not finish — the whole content
  // of the `needs-review` ending, and the reason an operator was asked to look.
  //
  // `runs.status` carries no CHECK constraint, so the new status itself is
  // additive at the schema level and this column is the only statement the
  // migration needs: `addColumn` reads the live schema, is not keyed on
  // `SCHEMA_VERSION` and destroys nothing, so it needs no transaction and no
  // version bump — that constant records that a *rebuild* completed, and this is
  // not one.
  addColumn(db, "runs", "needs_review_reason", "TEXT");

  // The same pair for an instance, so a node created *later* — a deferred one,
  // behind an orchestrator block's decision — records the trigger the press of
  // Run had rather than guessing. A scheduled instance's late nodes are still
  // the schedule's.
  addColumn(db, "workflow_instances", "origin", "TEXT");
  addColumn(db, "workflow_instances", "origin_ref", "TEXT");

  // Mutating HTTP requests: what was asked, of what, by whom, from where.
  //
  // Nothing recorded an authenticated request anywhere, so a burst of runs
  // created with a stolen token was indistinguishable from a busy afternoon and
  // a compromise could not be scoped after the fact.
  //
  // What it deliberately does *not* hold: request bodies, query strings,
  // cookies, tokens, prompts. A body here would carry the prompt of every run
  // and the password of every login, and a query string is where a credential
  // ends up when somebody puts one there by mistake. `actor` names *how* a
  // caller authenticated and never with what.
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status      INTEGER NOT NULL,
      -- The id the request named, or the one it created. Null where a route
      -- affects no single row.
      subject     TEXT,
      -- 'session' | 'bearer' | 'capability' | 'open' — how, never with what.
      actor       TEXT NOT NULL,
      address     TEXT,
      duration_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts);
  `);

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

  // What one chat turn cost, and when.
  //
  // `chat_sessions.cost_usd` beside it is a running total over the whole life
  // of a thread, and it was the only chat figure recorded anywhere — so the
  // install-wide ceiling, which is a reading over a rolling 24 hours, summed
  // that column bounded on `updated_at` and charged a fortnight of
  // conversation to the window the moment one four-cent message was sent into
  // an old thread. Over-counting is the safe direction for a ceiling (see
  // `installSpend`), but that is over-counting with no upper bound at all:
  // a limit on the install's whole history wearing a 24-hour label, closing
  // every door in the app and ending the runs already in flight at their next
  // pre-cycle guard.
  //
  // The running total stays exactly what it is. The chat page displays it, and
  // a column that quietly began meaning something narrower would be the worse
  // repair. This is written beside it inside the same `finishTurn` latch, so a
  // late settle that moves no total writes no row here either.
  //
  // A thread that predates this table has no rows in it, and reading that as
  // "$0 spent" would *widen* the ceiling on the boot that upgrades — the one
  // direction a ceiling must never move by accident. So every thread with a
  // total is backfilled as a single turn at its `updated_at`, which is
  // bit-for-bit what the old query counted, and ages out of the window within a
  // day on its own. The probe and the CREATE are one transaction because they
  // are one decision: a crash between them would leave the table present, the
  // backfill skipped for ever, and the reading short by everything this install
  // had spent on chat before the upgrade.
  const chatTurnSpendExisted = tableExists(db, "chat_turn_spend");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_turn_spend (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        -- When the turn settled, which is the instant the window bound is
        -- applied to. Not the chat's updated_at, which moves again every time
        -- anything at all is appended to the thread.
        ts       INTEGER NOT NULL,
        cost_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_turn_spend_ts ON chat_turn_spend(ts);
    `);
    if (!chatTurnSpendExisted) {
      db.prepare(
        `INSERT INTO chat_turn_spend (chat_id, ts, cost_usd)
         SELECT id, updated_at, cost_usd FROM chat_sessions WHERE cost_usd > 0`,
      ).run();
    }
  })();

  // One row per outbound notification attempt — see `notify.ts`.
  //
  // The table is what makes the webhook safe to depend on rather than a thing
  // that appears to work. Delivery is fire-and-forget by construction (an
  // `await` on that path would put a run ending behind a receiver's DNS
  // lookup), so a receiver that has been answering 404 for a week produces
  // exactly the same silence as a fleet with nothing wrong — and an operator who
  // stopped watching the runs page because the notifications were arriving is
  // precisely the person that silence misleads. `webhookHealth` derives the
  // consecutive-failure count `/api/status` reports from these rows, from the
  // table rather than from a counter in memory, because "dead since Tuesday" has
  // to survive a restart.
  //
  // `http_status` is 0 when the request never got one at all: DNS, a refused
  // connection, the five-second timeout. `error` is truncated and never a stack.
  // Bounded on every insert in `recordDelivery`, `request_log`'s pattern.
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      -- The run the notification was about. A plain column and not a foreign
      -- key: nothing deletes a runs row (see retention.ts), so a cascade would
      -- describe a deletion that does not happen, and this table outliving a run
      -- it names is the harmless direction.
      run_id      TEXT NOT NULL,
      event       TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      ok          INTEGER NOT NULL,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ok ON webhook_deliveries(ok, id);
  `);

  // What a context prune took out, per prune.
  //
  // Its own table rather than a `run_events` row, and the reason is retention:
  // events expire on their own horizon (`retention.ts`), and the KPI these rows
  // answer is a weekly one. A figure that silently stopped covering the whole
  // week because the evidence behind its first days had been swept is worse than
  // no figure — it would read as pruning having got less effective.
  //
  // **Tokens, never bytes.** Measured on this install, winnow frees 3.4× more
  // file than it removes from what is actually sent, because most of what it
  // takes out is the `toolUseResult` envelope the CLI writes and never
  // transmits. `contextPruning.ts` computes both readings from `message` content
  // alone and only those land here.
  //
  // `tokens_after` is stored rather than derived from the other two because it
  // is what the next cycle actually carries, and a later change to how removal
  // is counted must not silently move a figure already written. It is *not* what
  // the payback test reads — that one wants `tokens_before`, the suffix as it
  // stood before the cut (contextPruning.ts's `paybackTurns`).
  //
  // `model` so a receipt can be priced at the rate that actually applied, on
  // `byAgent.counterfactualUSD`'s rule: a rate looked up at read time prices
  // last week's prune at this week's list.
  db.exec(`
    CREATE TABLE IF NOT EXISTS prune_receipts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ts             INTEGER NOT NULL,
      -- A plain column, on webhook_deliveries.run_id's reasoning: nothing
      -- deletes a runs row, so a cascade would describe a deletion that never
      -- happens.
      run_id         TEXT NOT NULL,
      -- 'boundary' or 'early-end'. Load-bearing rather than descriptive: only
      -- the second one pays an invalidation, because the first rides a rewrite
      -- that was going to happen anyway.
      trigger        TEXT NOT NULL,
      tier           TEXT NOT NULL,
      tokens_before  INTEGER NOT NULL,
      tokens_after   INTEGER NOT NULL,
      tokens_removed INTEGER NOT NULL,
      model          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prune_receipts_ts ON prune_receipts(ts);
    CREATE INDEX IF NOT EXISTS idx_prune_receipts_run ON prune_receipts(run_id, ts);
  `);

  // How full a live run's context was, sampled over the run's life.
  //
  // A run in flight had no readable answer to that at all: the reading was
  // already being taken once a live-guard tick per run and then thrown away by
  // the ceiling comparison, which discards every value *below* the ceiling —
  // which is every value an occupancy graph is made of.
  //
  // **`tokens` is the API-visible currency (`apiContextTokens`), the same basis
  // the ceiling acts on** — never `contextTokens`, which `prune_receipts` uses.
  // The two are tens of thousands of tokens apart **in either direction** on
  // this install and the codebase treats mixing them in one arithmetic as a
  // bug, so the basis is named on the row rather than left to the reader:
  // `basis` is 'api' when a `usage` frame produced the number and 'transcript'
  // when `apiContextTokens` fell back to the byte estimate because the
  // conversation holds no usable frame yet. A series that silently mixed the
  // two would draw a cliff where only the measure changed.
  //
  // `frame_id` is the assistant `message.id` the reading came from, and it is
  // what makes the series a series rather than a flat duplicate: the tick is
  // time-based and one tool call can outlast several of them, so consecutive
  // reads routinely return the identical frame. A row is written only when the
  // underlying frame moves. Null when the frame carried no id, or under the
  // 'transcript' basis where there is no frame at all — those dedupe on
  // (basis, tokens) instead, which is the same statement one measure down.
  //
  // `turn_index` counts main-thread assistant turns, sidechain and `<synthetic>`
  // frames excluded exactly as `apiContextTokens` excludes them: a sub-agent's
  // turns are not this conversation's context. `turns_exact` is 0 when the
  // count is a **floor** — the tail scan is bounded at a megabyte, so a run
  // whose first sample lands on a transcript larger than that cannot know how
  // many turns preceded it. Once a floor, always a floor, since every later
  // advance is added to it. Carried rather than folded into the number, on
  // `metering.md`'s rule that an unknown must not render as a fact.
  //
  // Bounded twice: `CONTEXT_SAMPLES_PER_RUN` caps what one run may hold, oldest
  // first, and `sweepRunEvents` drops a settled run's samples on the same
  // horizon as the log they sit beside on the same page. Unlike `prune_receipts`
  // — a weekly KPI whose evidence must outlive the run — these are read only
  // while somebody is looking at that run, so they expire with its log rather
  // than outliving it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_samples (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      -- A plain column, on webhook_deliveries.run_id's reasoning: nothing
      -- deletes a runs row, so a cascade would describe a deletion that never
      -- happens.
      run_id      TEXT NOT NULL,
      -- The work cycle in flight when the reading was taken, 1-based. The
      -- loop's own counter rather than the runs row, which is written after a
      -- cycle ends and so lags a live sample by one.
      iteration   INTEGER NOT NULL,
      tokens      INTEGER NOT NULL,
      basis       TEXT NOT NULL,
      frame_id    TEXT,
      turn_index  INTEGER NOT NULL,
      turns_exact INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_samples_run ON context_samples(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_context_samples_ts ON context_samples(ts);
  `);

  // What the window was made of when a reading was taken — `winnow context`,
  // at depth 1, one row per provenance per reading.
  //
  // A **second measure of the same window**, and the two anchor differently:
  // `context_samples.tokens` is read off the last main-thread `usage` frame
  // with sidechains excluded, where winnow anchors on the last priced request
  // in the file whatever wrote it. A sub-agent's own frames live in that same
  // file, so the two figures come apart for exactly as long as a sub-agent
  // runs — which on this install has been measured at 22 minutes. `window`
  // therefore stores winnow's own total rather than the sample's, so a
  // composition can be drawn against the total it actually apportions and a
  // divergence is visible instead of being averaged away. Nothing subtracts
  // one from the other.
  //
  // `label` and `kind` are winnow's own strings, stored rather than mapped to
  // an enum here: the tool owns that vocabulary, and a label this app did not
  // anticipate must render as itself rather than be binned as 'other' — the
  // same rule `PRUNE_TRIGGER` follows on the component side. `kind` is one of
  // exact / derived / estimated / residual and says how the figure was
  // reached, which is the one thing a stacked band cannot show.
  //
  // Bounded exactly as `context_samples` is: `CONTEXT_COMPOSITIONS_PER_RUN`
  // caps a run oldest-first, and the same `sweepRunEvents` horizon drops a
  // settled run's rows. The cap counts *readings* rather than rows, since one
  // reading writes a row per provenance and a cap on rows would truncate a
  // reading down the middle — a stacked area whose bands stop at different
  // moments is a picture of a conversation that never happened.
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_compositions (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      -- Plain, on context_samples' reasoning: nothing deletes a runs row.
      run_id   TEXT NOT NULL,
      -- Which reading this row belongs to. One winnow context call writes
      -- several rows sharing this, and it is what lets the cap and every read
      -- treat a reading as the unit rather than the row.
      reading  INTEGER NOT NULL,
      -- The work cycle in flight, on context_samples.iteration's reasoning.
      iteration INTEGER NOT NULL,
      -- Winnow's own exact window on the request it anchored to. Not the
      -- sample's figure; see above.
      window   INTEGER NOT NULL,
      label    TEXT NOT NULL,
      tokens   INTEGER NOT NULL,
      kind     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_compositions_run
      ON context_compositions(run_id, reading);
    CREATE INDEX IF NOT EXISTS idx_context_compositions_ts
      ON context_compositions(ts);
  `);

  // What one band is made of, for the newest reading of a run and no other.
  //
  // Its own table rather than more rows in the one above, and the separation is
  // the bound rather than tidiness. The series is capped in *readings* because
  // one reading is a handful of rows; putting the tree in it would make a
  // reading a hundred rows or a thousand, and every figure derived from that
  // table — the per-run cap's MAX(reading), the sweep's own row count, the
  // three-second poll's scan — would go on meaning what it meant before while
  // measuring something else.
  //
  // Replaced whole on every reading (recordComposition deletes the run's rows
  // and rewrites them in the same transaction), which is what bounds this by
  // *runs* rather than by readings × paths. Nothing caps how many distinct files
  // a run may touch, so a tree per reading is the one dimension with no ceiling
  // anywhere on this path. The trade is stated rather than hidden: this answers
  // what is in the window now and cannot answer what was in an earlier reading.
  //
  // Two levels, matching COMPOSITION_DEPTH's 3: `parent` is empty on a node
  // hanging straight off a provenance and carries the second level's own label
  // on the artefact below it. A label rather than a row id because the rows are
  // rewritten wholesale and an id would be a reference into a set that no longer
  // exists by the time anything read it.
  //
  // `repeat_count` is winnow's ×N, lifted off the label rather than left in it
  // — see `splitRepeat`. NULL where winnow attached none, which is every node
  // above the artefact level and every artefact seen once. NULL is "winnow said
  // nothing here"; a 1 in its place would be this app asserting a count winnow
  // never printed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_composition_children (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      -- Plain, on context_compositions' reasoning.
      run_id     TEXT NOT NULL,
      -- The reading these belong to, so a read can refuse a tree that describes
      -- a stack it did not return rather than hang it on the wrong one.
      reading    INTEGER NOT NULL,
      -- The top-level band, which is context_compositions.label for this run
      -- and reading. Not a foreign key: the two are written together and the
      -- tree is deleted on its own schedule.
      provenance TEXT NOT NULL,
      -- The second level's label, or '' when this row is the second level.
      parent     TEXT NOT NULL,
      label      TEXT NOT NULL,
      tokens     INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      repeat_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_context_composition_children_run
      ON context_composition_children(run_id, reading);
    CREATE INDEX IF NOT EXISTS idx_context_composition_children_ts
      ON context_composition_children(ts);
  `);

  // Every cycle boundary, pruned or not — and the `not` is the point.
  //
  // A prune receipt records what was cut. It cannot record what a resume would
  // have cost had nothing been cut, because the cut breaks the cache itself: the
  // turn after a pruned resume is cold whether or not the boundary would have
  // been. The counterfactual only exists on a boundary where no prune ran, so
  // those have to be written down at the time. Nothing about them is derivable
  // afterwards — a boundary that pruned nothing leaves no trace in either the
  // transcript or `prune_receipts`.
  //
  // `session_id` is stored rather than joined from `runs`, unlike the receipt
  // table: a run that adopts a new session mid-flight (`adoptSession`) would
  // otherwise have its earlier probes matched against a transcript that never
  // carried them, and this row's whole value is that it points at one specific
  // resume.
  db.exec(`
    CREATE TABLE IF NOT EXISTS resume_probes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      run_id        TEXT NOT NULL,
      session_id    TEXT,
      -- 1 when a prune ran at this boundary, 0 when one did not. Only the 0 rows
      -- are the control; the 1 rows are kept so the mix is legible and so a
      -- period with no controls at all is visibly that rather than empty.
      pruned        INTEGER NOT NULL,
      -- The context as it stood at the boundary, in the API-visible currency
      -- (apiContextTokens), which is what the loop has in hand there. Not the
      -- same basis as prune_receipts.tokens_before, which is the transcript's
      -- own turns through contextTokens — the two are tens of thousands of
      -- tokens apart in either direction. Recorded for context on a probe, and
      -- deliberately not used in any arithmetic that also touches a receipt.
      tokens_before INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_resume_probes_ts ON resume_probes(ts);
    CREATE INDEX IF NOT EXISTS idx_resume_probes_clean ON resume_probes(pruned, ts);
  `);

  // What winnow's *newer* rule engine would have removed at each boundary, from
  // `winnow plan --json`. Nothing acts on these rows.
  //
  // The pruner this app runs is `winnow treat`, the inherited one: about twenty
  // strategies that never import winnow.rules. `plan` runs SPEC section 4's six
  // rules instead, and the two agree almost nowhere in detail. Which is better
  // is an open question that running the old one cannot answer, and the blind
  // label that bears on it scored the new rules rather than these.
  //
  // So the new engine is asked at every boundary and its answer written down
  // beside what the old one did. `pruned` is what actually happened, which is
  // what makes a row a comparison rather than a note.
  //
  // Sizes are bytes, not tokens, because that is what plan reports and SPEC
  // section 6 measures: len() of the content string. Dividing by four here
  // would put an estimate in a column whose whole value is being exact.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_observations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ts               INTEGER NOT NULL,
      run_id           TEXT NOT NULL,
      session_id       TEXT,
      tier             TEXT NOT NULL,
      tool_calls       INTEGER NOT NULL,
      stripped         INTEGER NOT NULL,
      removed_bytes    INTEGER NOT NULL,
      pointer_overhead INTEGER NOT NULL,
      net_bytes        INTEGER NOT NULL,
      suffix_bytes     INTEGER NOT NULL,
      -- Null when nothing fired: there is no cut, so there is no break-even. A
      -- 0 here would read as 'pays immediately', which is the opposite.
      break_even_turns REAL,
      -- Whether the inherited pruner actually ran at this boundary, so a row
      -- can be read as 'what the other engine would have done instead' or 'what
      -- both engines declined'.
      pruned           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plan_observations_ts ON plan_observations(ts);
    CREATE INDEX IF NOT EXISTS idx_plan_observations_run ON plan_observations(run_id, ts);
  `);

  // Every attempt by the fork engine, refusals included.
  //
  // `resumed` is the column this table exists for. Winnow's milestone 2 asks
  // that a forked session resume — 100 forks, 0 failures — and that guardrail
  // has never been run. Switching this engine on collects it a production cycle
  // at a time, because the orchestrator's next `--resume` IS the test: if it
  // fails, the run rolls back to the original session and 0 goes in this column.
  // A 0 here is winnow's own kill condition, arriving from a real resume the
  // run actually needed rather than from a harness.
  //
  // Refusals are rows too. The expected outcome at a cycle boundary is
  // `cold-age`, and an operator who switched the engine on and saw nothing
  // happen has to be able to read why rather than find the table empty.
  //
  // `min_cold_age` is stored per row rather than read from settings later,
  // because it is the one number that decides whether a fork was economically
  // defensible and settings move.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fork_attempts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                INTEGER NOT NULL,
      run_id            TEXT NOT NULL,
      source_session_id TEXT,
      -- Null when nothing was written, which is every refusal.
      new_session_id    TEXT,
      written           INTEGER NOT NULL,
      -- The guard that stood: 'cold-age', 'compacted', 'G4', 'parse', or a G5
      -- pairing failure. Null when the fork was written, or when winnow broke
      -- rather than refused -- those carry a reason and no guard.
      refused_by        TEXT,
      reason            TEXT,
      removed_bytes     INTEGER NOT NULL,
      net_bytes         INTEGER NOT NULL,
      -- S in the break-even formula T* = 19*(S/D) - 20: the suffix standing
      -- after the cut line, from the fork's own plan. Stored because the netting
      -- needs it and it cannot be recovered later -- it is a property of where
      -- the cut fell, not of the file. Without it tokens_before has to be
      -- guessed, and that guess feeds the counterfactual read which decides
      -- whether a fork over a warm cache shows a loss.
      suffix_bytes      INTEGER NOT NULL DEFAULT 0,
      break_even_turns  REAL,
      cold_age_seconds  REAL,
      min_cold_age      INTEGER,
      -- Null until a cycle has tried to resume the fork: 1 it did, 0 it could
      -- not and the run rolled back.
      resumed           INTEGER,
      -- Which of the two moments this fork was taken at: 'boundary' for the
      -- natural handover between work cycles, 'early-end' for the one this app
      -- manufactures by cutting a cycle short at the context ceiling. The same
      -- column prune_receipts carries, and for the same reason -- it decides how
      -- the netting prices the cut. Without it every fork was read as a
      -- boundary, so a fork at an early end was priced free while the identical
      -- operation under the legacy engine was charged its whole rewrite.
      -- Null on rows written before the column existed; see forkCutFromRow.
      trigger           TEXT,
      -- The forked conversation, measured the way prune_receipts.tokens_after is
      -- measured -- contextTokens over the written transcript. It is what the
      -- next resume has to write, and the early-end branch of netReceipt prices
      -- exactly that until a real turn lands to be read instead.
      --
      -- Not derivable from the columns beside it: suffix_bytes is S, the tail
      -- standing after the cut line, which on this install runs 70-90k against
      -- conversations of 180k. Estimating the rewrite from S understated it by
      -- about a third.
      context_tokens_after INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fork_attempts_ts ON fork_attempts(ts);
    CREATE INDEX IF NOT EXISTS idx_fork_attempts_run ON fork_attempts(run_id, ts);
  `);

  // Every cycle boundary's outcome, including the ones that removed nothing.
  //
  // **A count of events and never a cost source.** Nothing in the netting reads
  // this table, and an `outcome = 'cut'` row is not a receipt -- the receipt is
  // in prune_receipts or fork_attempts and is the only thing money is derived
  // from. The two must not be joined to make a figure.
  //
  // A table of its own rather than a column on prune_receipts, which is read by
  // pricedCuts, contextOccupancy and countFor: a non-cut row landing in there
  // would corrupt all three, and it would do it silently -- every one of them
  // would still return a number.
  //
  // It exists because five outcomes at a boundary -- a cut, a payback decline,
  // nothing worth removing, a fork refusal, a missing tool -- were one absent
  // section on two screens, and an absent section reads as "the feature never
  // ran". Four of the five left no durable trace anywhere at all.
  db.exec(`
    CREATE TABLE IF NOT EXISTS prune_decisions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      run_id          TEXT NOT NULL,
      -- 'boundary' or 'early-end', the same pair prune_receipts carries.
      trigger         TEXT NOT NULL,
      -- Which engine was configured when this boundary was decided. Stored per
      -- row rather than read back off settings later, on min_cold_age's
      -- grounds: it is the fact that explains the outcome, and settings move.
      engine          TEXT NOT NULL,
      -- 'cut', 'nothing', 'declined', 'refused', 'unavailable' or 'failed'.
      outcome         TEXT NOT NULL,
      -- The server's own reason, so the page and the run log cannot word the
      -- same failure two different ways.
      detail          TEXT,
      -- What the payback gate read, for 'declined'. Null on every other row.
      predicted_turns REAL
    );
    CREATE INDEX IF NOT EXISTS idx_prune_decisions_ts ON prune_decisions(ts);
    CREATE INDEX IF NOT EXISTS idx_prune_decisions_run ON prune_decisions(run_id, ts);
  `);

  // `suffix_bytes` arrived one commit after the table did, and it arrived inside
  // the CREATE above — which is a no-op against an install that already has the
  // table, so the column never appeared on any database created in between.
  // Both the INSERT and the SELECT name it, and `recordForkAttempt` swallows its
  // own failures, so the symptom is silence: the engine's first fork writes no
  // row, `markForkResumed` has no id to update and `pendingForkFor` finds
  // nothing to recover a restarted run with.
  addColumn(db, "fork_attempts", "suffix_bytes", "INTEGER NOT NULL DEFAULT 0");
  // Same story, same fix, and the reason the two are worth naming separately:
  // the CREATE above is a no-op on every install that already has the table, so
  // a column added to it reaches new databases only.
  addColumn(db, "fork_attempts", "trigger", "TEXT");
  addColumn(db, "fork_attempts", "context_tokens_after", "INTEGER");

  // What Dreaming has written into the operator's vault, and when.
  //
  // **This table is the retraction mechanism, and it is why the feature can
  // ship at all.** The vault is not a git repository: no history, no author
  // field, no diff of what last night added, and nothing in a note marks it as
  // machine-written. So "which files did this app write" is not a question the
  // destination can answer, and without a row here the only retraction is a
  // person noticing a wrong note months later. It is not version control. It is
  // the list a person deletes *from*.
  //
  // `signature` is the primary key rather than an id, and that is the
  // deduplication mechanism rather than a normalisation choice: the write
  // policy is "has this app already written this signature", which is a lookup
  // on this column. An id with a unique index beside it would be the same
  // statement with a second way to get it wrong.
  //
  // `days_seen` and `instances` are the readings *at the moment of writing*,
  // frozen deliberately — `run_templates`' rule. The note in the vault says
  // "seen on 3 days"; re-deriving that later would leave the row disagreeing
  // with the file it points at.
  //
  // `note_path` is vault-relative and nullable: a night can select a signature,
  // spawn a run, and have the run write nothing. A row with a null path and a
  // non-null `written_at` is exactly that, and is the difference between "this
  // was never attempted" and "this was attempted and produced no file" — which
  // the pane must not conflate.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dreaming_notes (
      signature   TEXT PRIMARY KEY,
      -- The machine's own words, clipped. Shown beside the note so an operator
      -- can see what it was about without opening the vault.
      sample      TEXT NOT NULL,
      written_at  INTEGER NOT NULL,
      -- The night that wrote it, as YYYY-MM-DD in the operator's zone.
      night       TEXT NOT NULL,
      -- The run that did the writing, so the pane can link to its log. A plain
      -- column on webhook_deliveries.run_id's reasoning: nothing deletes a runs
      -- row, so a cascade would describe a deletion that never happens.
      run_id      TEXT,
      -- Vault-relative. Null when the run wrote nothing for this signature.
      note_path   TEXT,
      days_seen   INTEGER NOT NULL,
      instances   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dreaming_notes_night ON dreaming_notes(night);
  `);

  // One row per night Dreaming decided anything, whether or not it wrote.
  //
  // A night that selected nothing is the *success* case for a write-on-
  // recurrence policy — six of the 23 measured days had no signature reach a
  // second day — and it must not render as a failure or as an empty page. That
  // is the whole reason this table exists separately from the one above: the
  // notes table cannot record a night that produced no notes, and "ran and
  // wrote nothing" and "never ran" are two of the three kinds of nothing the
  // pane is required to keep apart.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dreaming_nights (
      night       TEXT PRIMARY KEY,
      started_at  INTEGER NOT NULL,
      -- 'selected' when signatures qualified and a run was created, 'quiet'
      -- when none did, 'refused' when something declined to start it, 'failed'
      -- when the run itself did not finish. Never a success mark on a row: the
      -- run's own status is the authority, exactly as it is for a review.
      outcome     TEXT NOT NULL,
      -- Why, for 'refused' and 'failed'. A full sentence, never a code.
      reason      TEXT,
      run_id      TEXT,
      selected    INTEGER NOT NULL
    );
  `);

  // Dreaming's cursor was a `YYYY-MM-DD` day key and is now an instant under a
  // different key, because a day key closed the whole day a boot landed in and
  // so stopped the nightly pass firing at all on any day the server restarted.
  // Nothing reads the old key; it is deleted rather than left behind so the
  // next reader greping for it finds the live one and not a fossil.
  db.prepare("DELETE FROM settings WHERE key = 'dreaming.cursor'").run();

  // Anything still wearing the rebuild suffix after the one rebuild above has
  // run. Last, so a leftover this boot has just completed is not reported as
  // one it left behind.
  reportOrphanTables(db);

  // Give the planner something to plan with. Without `sqlite_stat1` SQLite
  // guesses selectivity from the schema alone, and on the runs table it guesses
  // wrong in a specific way: told to find `status = ?` ordered by `created_at
  // DESC`, it believes the status is selective, seeks `idx_runs_status`, and
  // then sorts every matching row into a temp B-tree — rather than walking
  // `idx_runs_created`, which is already in the order asked for, and stopping at
  // LIMIT+OFFSET. The indices to do it right are all present; only the estimate
  // was missing.
  //
  // Measured through `listRunsPage` against 5,000 runs / 250,000 events:
  //
  //   status filter, first page      9.48 ms -> 0.44 ms
  //   history page (settledBefore)  15.01 ms -> 4.19 ms
  //
  // and the unfiltered first page — the only one of these on the four-second
  // poll — is unmoved at 0.41 ms, as is the `LIKE` search, which nothing can
  // index. So this buys the filtered pages and risks nothing on the hot one.
  //
  // Unconditional rather than gated on the stats being absent: they are an
  // estimate of a table that grows, and a boot is both the moment they are
  // cheapest to take and the only recurring event this process is guaranteed.
  // 27 ms on the fixture above, against a `migrate()` that has just executed
  // every CREATE in this file.
  db.exec("ANALYZE");

  // Stamped only once everything above has returned, which is what makes it
  // mean "a build of this version finished migrating this file" rather than
  // "one started".
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * The columns a proposal had before any of this — the ones a table left behind
 * by an interrupted rebuild is guaranteed to hold, and therefore the only ones
 * either the rebuild or the recovery may name. Everything added since
 * (`prompt_override`, `kind`, `spec_id`, …) arrives through `addColumn` and is
 * null on a row this moves.
 */
const PROPOSAL_BASE_COLUMNS = [
  "id",
  "chat_id",
  "created_at",
  "template_id",
  "title",
  "task",
  "mount_id",
  "folder",
  "status",
  "run_id",
  "decided_at",
  "error",
] as const;

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/**
 * Rows stranded in `chat_proposals_old` by a rebuild that was interrupted
 * before this function was transactional.
 *
 * The interruption that matters is the one after the `RENAME`. `migrate`'s own
 * `CREATE TABLE IF NOT EXISTS` then recreates `chat_proposals` empty on the
 * next boot, `relaxProposalTemplate` reads the new schema, sees the NOT NULL
 * already gone and returns — so the guard that makes the migration idempotent
 * is also what makes the loss permanent. Every decided proposal, which is the
 * record of what the operator approved and which run it became, is still on
 * disk and is unreachable by every query in `chat.ts`.
 *
 * Completed rather than reported, because completing it is unambiguous: the
 * rows are the same rows, `INSERT OR IGNORE` cannot overwrite anything the app
 * has written since, and the alternative is a database that boots into an empty
 * table for ever. A leftover whose shape this build does not recognise is the
 * one case that cannot be completed, and that one is said out loud and left
 * alone — see below.
 */
function recoverStrandedProposals(db: Database.Database) {
  if (!tableExists(db, "chat_proposals_old")) return;

  const cols = new Set(
    (
      db.prepare("PRAGMA table_info(chat_proposals_old)").all() as {
        name: string;
      }[]
    ).map((c) => c.name),
  );
  const missing = PROPOSAL_BASE_COLUMNS.filter((c) => !cols.has(c));
  if (missing.length > 0) {
    // Loud, and not fatal. A table this build cannot read is not one it can
    // safely drop either, and refusing to boot over it would strand the whole
    // install rather than one table — where leaving it in place costs nothing
    // but the disk it is already using.
    console.error(
      `[usagefoundry] chat_proposals_old is present and does not have the ` +
        `columns this build knows (missing: ${missing.join(", ")}). It has ` +
        `been left alone; nothing in the app reads it. This is the residue of ` +
        `an interrupted migration and needs a hand.`,
    );
    return;
  }

  const list = PROPOSAL_BASE_COLUMNS.join(", ");
  const moved = db.transaction(() => {
    // OR IGNORE rather than a plain INSERT: a boot interrupted between the
    // INSERT and the DROP leaves both tables populated, and re-running must be
    // a no-op rather than a primary-key failure that stops every later boot.
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO chat_proposals (${list})
         SELECT ${list} FROM chat_proposals_old`,
      )
      .run();
    db.exec("DROP TABLE chat_proposals_old");
    // A rename carries the table's indexes with it under their own names, so
    // `migrate`'s own `CREATE INDEX IF NOT EXISTS` earlier in this same boot
    // found the name taken by the *old* table and did nothing — and the DROP
    // above has just taken it away. Recreated here rather than left to the next
    // boot, which is the shape the rebuild itself uses and for the same reason.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_chat_proposals_chat
         ON chat_proposals(chat_id, created_at)`,
    );
    return res.changes;
  })();

  console.warn(
    `[usagefoundry] Recovered ${moved} chat proposal(s) stranded in ` +
      `chat_proposals_old by an interrupted migration.`,
  );
}

/**
 * Drop the NOT NULL from `chat_proposals.template_id`, preserving the rows.
 *
 * The alternative — dropping the table and letting it be recreated — would take
 * the decided proposals with it, which are the record of what the operator
 * approved and what came of it. A rebuild costs fifteen lines and keeps that.
 *
 * **One transaction, and that is the whole of issue #94.** `db.exec` maps to
 * `sqlite3_exec`, which runs each statement in autocommit: the four statements
 * used to commit independently, so a crash, an OOM kill or a `docker compose
 * down` between the first and the last left the rows in an orphan table that no
 * query in this app reads, permanently — see `recoverStrandedProposals` for why
 * the next boot could not notice. DDL is transactional in SQLite, so the
 * statements below either all land or none of them do. The steps stay separate
 * `exec` calls rather than one blob because a transaction is only worth having
 * if a failure part-way through is a real state, and this is the shape that
 * lets the test put one there.
 *
 * The index is recreated at the end rather than before: renaming a table brings
 * its indexes along under their own names, so `CREATE INDEX` would collide with
 * the copy still attached to the old table until that table is dropped.
 */
export function relaxProposalTemplate(db: Database.Database) {
  recoverStrandedProposals(db);

  const column = (
    db.prepare("PRAGMA table_info(chat_proposals)").all() as {
      name: string;
      notnull: number;
    }[]
  ).find((c) => c.name === "template_id");
  if (!column || column.notnull === 0) return;

  const list = PROPOSAL_BASE_COLUMNS.join(", ");
  const steps = [
    "ALTER TABLE chat_proposals RENAME TO chat_proposals_old",
    CHAT_PROPOSALS_TABLE,
    `INSERT INTO chat_proposals (${list}) SELECT ${list} FROM chat_proposals_old`,
    "DROP TABLE chat_proposals_old",
    `CREATE INDEX IF NOT EXISTS idx_chat_proposals_chat
       ON chat_proposals(chat_id, created_at)`,
  ];

  db.transaction(() => {
    for (const sql of steps) db.exec(sql);
  })();
}

/**
 * Every `*_old` table this build did not just create, named on stdout.
 *
 * `recoverStrandedProposals` completes the one interrupted rebuild this app has
 * ever shipped. Anything else wearing that suffix is either a future migration
 * that was interrupted or a table somebody made by hand, and neither is
 * something to drop — so this reports and boots. Reporting rather than refusing
 * for the reason `configCheck.ts` gives about a mount: a state worth a person's
 * attention is not the same as a state worth taking the install away over.
 */
function reportOrphanTables(db: Database.Database) {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_old' ESCAPE '\\'",
    )
    .all() as { name: string }[];
  for (const row of rows) {
    console.error(
      `[usagefoundry] ${row.name} is present and nothing in this app reads it. ` +
        `It is the residue of an interrupted migration — the rows in it are not ` +
        `visible anywhere in the UI.`,
    );
  }
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
