import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * Which gate created each run, driven through the gates rather than asserted
 * about them.
 *
 * The point of the column is that it is *recorded* rather than deduced, so the
 * only test that says anything is one that goes through the real creation
 * paths: a `createRun({origin: "chat"})` written here would pin this file's own
 * argument and nothing about `approveProposal`. Every one of the five is
 * silent when it is wrong — the run starts, works and lands exactly as before,
 * and the only symptom is a row that says a person filled in a form when a
 * model decided it, months later, when somebody is trying to scope what a
 * stolen token did.
 *
 * Three of the five start an agent with nobody at the keyboard, which is the
 * whole reason the distinction is worth a column: `workflow` and `schedule` are
 * the same graph and the same `startWorkflow`, differing only in whether a
 * person pressed anything, and `orchestrator-block` is the one origin no person
 * chose run by run.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `bootBlocks.test.ts`'s reason: `config.ts` is read at module load, so a file
 * that imported `orchestrator.ts` at the top would already be bound to the
 * repository's own `.data` — which on a developer's machine is the real one.
 */

let root: string;
let workspace: string;
let orch: typeof import("./orchestrator");
let workflows: typeof import("./workflows");
let chat: typeof import("./chat");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-run-origin-"));
  workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "project"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  // Wins over WORKSPACE_ROOT, and any container this ships in has it set.
  process.env.WORKSPACE_ROOTS = `Scratch=${workspace}`;
  // Nothing here should reach a spawn. A `claude` that does not exist is what
  // makes a regression that gets that far a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  orch = await import("./orchestrator");
  workflows = await import("./workflows");
  chat = await import("./chat");
  dbMod = await import("./db");

  // The snapshot every creation path reads asks the provider for its own
  // utilisation, and there is no network here — see the same line in
  // `src/app/api/status/route.test.ts`.
  const { saveSettings } = await import("./settings");
  saveSettings({ planUsageFromApi: false });
});

after(async () => {
  // Every case here creates a real run, and `createRun` ends in
  // `promoteQueued`, which starts one in the background — a transcript scan and
  // a spawn of a `claude` that does not exist. Given a tick to fall over on its
  // own, and the handle left **open**: closing it out from under that work
  // turns a run that was always going to fail into an unhandled rejection about
  // a closed database, which is a failure about this file rather than the code.
  await new Promise((resolve) => setTimeout(resolve, 50));
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A folder claim is a folder claim: two of these cases point at the same
 * directory, and a run left `queued` from the previous case would hold it.
 */
beforeEach(() => {
  for (const table of [
    "workflow_instance_blocks",
    "workflow_instance_runs",
    "workflow_instances",
    "workflows",
    "chat_proposals",
    "chat_messages",
    "chat_sessions",
    "run_deps",
    "runs",
  ]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
});

/** The two audit columns, straight off the row rather than through a DTO. */
function originOf(runId: string): { origin: string | null; ref: string | null } {
  const row = dbMod
    .db()
    .prepare("SELECT origin, origin_ref AS ref FROM runs WHERE id = ?")
    .get(runId) as { origin: string | null; ref: string | null };
  return row;
}

function runBlockGraph(kind: "run" | "orchestrator") {
  return {
    nodes: [
      {
        id: "A",
        name: "Do it",
        kind,
        templateId: null,
        mountId: "scratch",
        folder: "project",
        task: "do the thing",
        promptOverride: null,
        agentId: null,
        fanOut: kind === "orchestrator" ? 2 : null,
        mergeStrategy: null,
        mergeAutoResolve: false,
        maxPasses: null,
        maxLoopCostUSD: null,
      },
    ],
    edges: [],
  };
}

describe("every creation path records the gate it came through", () => {
  it("the run form", async () => {
    const { POST } = await import("../app/api/runs/route");
    const res = await POST(
      new Request("http://localhost/api/runs", {
        method: "POST",
        body: JSON.stringify({
          folder: "project",
          mountId: "scratch",
          prompt: "do the thing",
          budget: { maxIterations: 1 },
        }),
      }),
    );
    const body = (await res.json()) as { run?: { id: string }; error?: string };
    assert.ok(body.run, `the form's own route refused the run: ${body.error}`);

    assert.deepEqual(originOf(body.run.id), { origin: "form", ref: null });
  });

  it("an approved chat proposal, naming the proposal that authorised it", () => {
    const session = chat.createChat();
    const proposal = chat.createProposal(session.id, {
      templateId: null,
      title: "Fix a bug",
      task: "do the thing",
      promptOverride: null,
      mountId: "scratch",
      folder: "project",
    });

    const outcome = chat.approveProposal(proposal.id);
    assert.ok(outcome.ok, `approval refused: ${!outcome.ok && outcome.reason}`);

    assert.deepEqual(originOf(outcome.runId), {
      origin: "chat",
      // The proposal, not the chat: a thread holds many, and only one of them
      // authorised this run.
      ref: proposal.id,
    });
  });

  it("a press of Run on a workflow, naming the instance", async () => {
    const workflow = workflows.createWorkflow({
      name: "By hand",
      graph: runBlockGraph("run"),
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
    });
    const outcome = workflows.startWorkflow(
      workflow.id,
      await orch.currentSnapshot(),
    );
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);

    const member = dbMod
      .db()
      .prepare("SELECT run_id AS id FROM workflow_instance_runs WHERE instance_id = ?")
      .get(outcome.instance.id) as { id: string };
    assert.deepEqual(originOf(member.id), {
      origin: "workflow",
      ref: outcome.instance.id,
    });
  });

  it("a schedule firing, naming the schedule rather than the instance", async () => {
    const workflow = workflows.createWorkflow({
      name: "On a timer",
      graph: runBlockGraph("run"),
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
    });
    const outcome = workflows.startWorkflow(
      workflow.id,
      await orch.currentSnapshot(),
      { kind: "schedule", scheduleId: "sched-1" },
    );
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);

    const member = dbMod
      .db()
      .prepare("SELECT run_id AS id FROM workflow_instance_runs WHERE instance_id = ?")
      .get(outcome.instance.id) as { id: string };
    // The same graph and the same `startWorkflow` as the case above; the only
    // difference is that nobody was present, which is the one an audit is for.
    assert.deepEqual(originOf(member.id), {
      origin: "schedule",
      ref: "sched-1",
    });
  });

  it("an orchestrator block's own decision, even inside a scheduled instance", async () => {
    const workflow = workflows.createWorkflow({
      name: "It decides",
      graph: runBlockGraph("orchestrator"),
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
    });
    const outcome = workflows.startWorkflow(
      workflow.id,
      await orch.currentSnapshot(),
      { kind: "schedule", scheduleId: "sched-2" },
    );
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);

    // What `startBlockTurn` does before it spawns. The turn itself needs a real
    // child; what is under test is what the emission writes.
    dbMod
      .db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='thinking' WHERE instance_id=? AND node_id=?",
      )
      .run(outcome.instance.id, "A");

    const emission = workflows.emitBlockRuns(outcome.instance.id, "A", [
      { id: "s1", title: "Emitted", task: "do the emitted thing", folder: "project" },
    ]);
    assert.ok(emission.ok, `emission refused: ${!emission.ok && emission.reason}`);


    // The specs are only *recorded* by the emission; the runs are created when
    // the turn settles, which on a real block is a child process exiting.
    workflows.settleBlock(outcome.instance.id, "A", { status: "idle", text: "done" });
    const emitted = dbMod
      .db()
      .prepare(
        "SELECT run_id AS id FROM workflow_instance_runs WHERE instance_id = ? AND emitted_by = 'A'",
      )
      .get(outcome.instance.id) as { id: string };
    // Not the instance's `schedule`: what authorised *this* run is a model's
    // decision taken moments ago, which no person chose run by run.
    assert.deepEqual(originOf(emitted.id), {
      origin: "orchestrator-block",
      ref: "A",
    });
  });
});

describe("picking a run up again", () => {
  it("is recorded without rewriting where the run came from", async () => {
    const run = orch.createRun({
      folder: "project",
      mountId: "scratch",
      prompt: "do the thing",
      budget: { maxIterations: 1 },
      origin: "chat",
      originRef: "proposal-7",
    });
    dbMod
      .db()
      .prepare("UPDATE runs SET status='stopped', finished_at=? WHERE id=?")
      .run(Date.now(), run.id);

    const outcome = orch.reopenRun(run.id, { maxIterations: 3 });
    assert.ok(outcome.ok, `reopen refused: ${!outcome.ok && outcome.reason}`);

    const row = dbMod
      .db()
      .prepare("SELECT origin, origin_ref AS ref, reopened_at AS reopenedAt FROM runs WHERE id=?")
      .get(run.id) as { origin: string; ref: string; reopenedAt: number | null };

    // A reopen creates nothing. Writing "reopen" here would lose the one fact
    // the column exists for while `created_at` went on pointing at the original
    // creation — so it lands on its own column, and on the request log.
    assert.equal(row.origin, "chat");
    assert.equal(row.ref, "proposal-7");
    assert.ok(
      row.reopenedAt !== null && Date.now() - row.reopenedAt < 60_000,
      "a run picked up again has to say when",
    );
  });
});
