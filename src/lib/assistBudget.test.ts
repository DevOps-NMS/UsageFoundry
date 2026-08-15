import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * Covers the process budget on every `claude` child that is not a work cycle.
 *
 * `maxConcurrentRuns` bounded one of the four kinds of child this app spawns.
 * The other three — a review, a merge-conflict resolution, an orchestrator chat
 * turn and a workflow block's deciding turn — consulted nothing, so a fleet
 * under a cap of 25 could carry an orchestrator turn per `thinking` block and a
 * turn per open chat on top of it, each a full Node process. Nothing in the app
 * or in `docker-compose.yml` bounded that, and the failure is the host running
 * out of memory rather than anything this app reports.
 *
 * It earns a place in this suite on the same grounds as the rest of it: every
 * way of getting it wrong is silent. A count that misses a table restores the
 * unbounded fleet and nothing anywhere says so; a count that includes a **merge**
 * block — which takes the identical `thinking` status from the identical
 * `claimBlock` and spawns no child at all — refuses an operator's chat turn to
 * make room for a process that does not exist. Neither throws, neither shows up
 * in a type, and both look exactly like the app working.
 *
 * It opens a database rather than testing the rule alone because that is where
 * the defect was: `assistBudgetRefusal` is pure and could be got right over a
 * count that reads one table. So the rows are real, and the three that must be
 * counted are written into the three different tables that record them.
 *
 * Its own file, and `DATA_DIR`/`CLAUDE_HOME` named before the first import, for
 * `chatTurn.test.ts`'s reason — `config.ts` fixes both at module load, and the
 * assertion in `before` is what keeps a change to that from running against the
 * operator's own database.
 */

let review: typeof import("./review");
let settings: typeof import("./settings");
let database: typeof import("./db");
let root: string;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-assist-budget-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  // Nothing here should reach a spawn; a `claude` that does not exist makes a
  // regression that gets that far a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  database = await import("./db");
  settings = await import("./settings");
  review = await import("./review");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */
/* Fixtures — one row per kind, in the table that kind actually uses.   */
/* ------------------------------------------------------------------ */

let seq = 0;
const id = (prefix: string) => `${prefix}-${(seq += 1)}`;

/** A `run_reviews` row: a review, or a merge-conflict resolution. */
function assistRow(status: "running" | "completed"): void {
  const runId = id("run");
  const now = Date.now();
  database
    .db()
    .prepare(
      "INSERT INTO runs (id, folder, prompt, status, budget, created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(runId, path.join(root, "workspace", runId), "task", "completed", "{}", now);
  database
    .db()
    .prepare(
      "INSERT INTO run_reviews (id, run_id, kind, created_at, status) VALUES (?,?,?,?,?)",
    )
    .run(id("review"), runId, "review", now, status);
}

/** A `chat_sessions` row: one orchestrator-chat turn. */
function chatRow(status: "idle" | "thinking"): void {
  const now = Date.now();
  database
    .db()
    .prepare(
      "INSERT INTO chat_sessions (id, created_at, updated_at, status) VALUES (?,?,?,?)",
    )
    .run(id("chat"), now, now, status);
}

/** A `workflow_instance_blocks` row: one block of one instance. */
function blockRow(kind: "orchestrator" | "merge", status: "waiting" | "thinking"): void {
  const now = Date.now();
  const workflowId = id("wf");
  const instanceId = id("inst");
  const db = database.db();
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?,?,?,?,?)",
    // `workflows.name` is unique, so the id doubles as the name here.
  ).run(workflowId, workflowId, "{}", now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?,?,?,?,?,'started')`,
  ).run(instanceId, workflowId, "graph", "{}", now);
  db.prepare(
    `INSERT INTO workflow_instance_blocks
       (instance_id, node_id, node_name, position, kind, status)
     VALUES (?,?,?,?,?,?)`,
  ).run(instanceId, id("node"), "block", 0, kind, status);
}

function clear(): void {
  const db = database.db();
  for (const table of ["run_reviews", "runs", "chat_sessions", "workflows"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(() => clear());

/* ------------------------------------------------------------------ */

describe("assistBudgetRefusal — the rule", () => {
  it("does not refuse under a cap, and does at it", () => {
    assert.equal(review.assistBudgetRefusal(1, 2), null);
    assert.notEqual(
      review.assistBudgetRefusal(2, 2),
      null,
      "the cap is how many may run, so the run that would make it N+1 is refused",
    );
    assert.notEqual(review.assistBudgetRefusal(3, 2), null);
  });

  it("treats a null cap as the explicit opt-out it is", () => {
    assert.equal(review.assistBudgetRefusal(99, null), null);
  });

  it("names what shares the budget, so the sentence is actionable", () => {
    const reason = review.assistBudgetRefusal(2, 2) ?? "";
    assert.match(reason, /review/i);
    assert.match(reason, /chat turn/i);
    assert.match(reason, /Settings/);
  });
});

describe("liveAssistChildren — every kind of child, and only the ones that exist", () => {
  it("counts a review, a chat turn and a block's deciding turn alike", () => {
    assert.equal(review.liveAssistChildren(), 0);

    assistRow("running");
    assert.equal(review.liveAssistChildren(), 1, "a running review is a child");

    chatRow("thinking");
    assert.equal(review.liveAssistChildren(), 2, "a thinking chat is a child");

    blockRow("orchestrator", "thinking");
    assert.equal(review.liveAssistChildren(), 3, "a deciding block is a child");
  });

  it("counts nothing that is not spending right now", () => {
    assistRow("completed");
    chatRow("idle");
    blockRow("orchestrator", "waiting");
    // The one that costs an operator a refusal for nothing: a merge block takes
    // the same `thinking` status from the same claim and spawns no child at all.
    blockRow("merge", "thinking");

    assert.equal(review.liveAssistChildren(), 0);
  });
});

describe("assistRefusal — a non-work-cycle child is refused once the budget is full", () => {
  it("refuses a review because two chat turns are already running", async () => {
    settings.saveSettings({ maxConcurrentAssists: 2 });
    chatRow("thinking");
    chatRow("thinking");

    // The whole finding in one assertion: not one of these is a work cycle, and
    // before this budget existed the answer here was `null` and a third Node
    // process was spawned.
    const refusal = await review.assistRefusal();
    assert.notEqual(refusal, null, "a third child must be refused, not spawned");
    assert.match(refusal ?? "", /2 Claude processes outside a work cycle/);

    assert.equal(review.assistBudgetFull(), true);
  });

  it("lets one through as soon as a slot frees", async () => {
    settings.saveSettings({ maxConcurrentAssists: 2 });
    chatRow("thinking");

    assert.equal(review.assistBudgetFull(), false);
    assert.equal(
      await review.assistRefusal(),
      null,
      "with a slot left and no window ceiling set there is nothing to refuse",
    );
  });

  it("stops bounding anything when the operator opts out", async () => {
    settings.saveSettings({ maxConcurrentAssists: null });
    for (let i = 0; i < 5; i += 1) chatRow("thinking");

    assert.equal(review.assistBudgetFull(), false);
    assert.equal(await review.assistRefusal(), null);
  });
});
