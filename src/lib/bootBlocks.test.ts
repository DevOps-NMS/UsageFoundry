import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers one thing: which unsettled blocks a restart closes out.
 *
 * `reconcileOnBoot` keeps a run that is `paused` inside `resumeGraceHours`,
 * because it is a run the operator started in a mode chosen precisely so it
 * would carry on across a restart. `reconcileBlocksOnBoot` then used to write
 * *every* `waiting` block `blocked`, so the tail of that run's own workflow was
 * destroyed by the same boot that went out of its way to preserve its head —
 * and the sentence recorded on the row said the block in front of it "was
 * closed out by the same restart", which was a statement about a run that was
 * still parked and about to resume.
 *
 * The `looping` sweep in the same function asked no such question for longer,
 * and the parked run there is the loop's own current pass: the row went
 * `failed`, `advanceLoops` selects `looping` so no further pass was ever
 * created, and `loopVerdict`'s `failed` arm then wrote every successor
 * `blocked` while that pass was still committing to the branch they were
 * waiting for.
 *
 * It earns a place in this suite on this suite's terms. `bootBlockPlan` is the
 * decision and is unit-tested beside the other pure ones in `workflows.test.ts`;
 * what is left over is a *join* across three tables and an ordering between two
 * reconcilers, which is not something there is an argument to hand a function.
 * Every way of getting it wrong typechecks, throws nothing and renders as an
 * ordinary blocked block — the only evidence is a merge that never lands weeks
 * of work, months after the restart that decided it.
 *
 * Its own file, and `DATA_DIR` set before the first import, for the reason
 * `haltedMembers.test.ts` and `chatTurn.test.ts` are: `config.ts` reads that
 * variable at module load and `orchestrator.ts` pulls it in statically, so a
 * file that imported either at the top would already be bound to the
 * repository's own `.data` directory — which on a developer's machine is the
 * real one. Its own file rather than a case in `haltedMembers.test.ts` for a
 * second reason as well: both reconcilers here act on *every* row in the
 * database, so they would close out that file's fixtures under it.
 */

let root: string;
let orch: typeof import("./orchestrator");
let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-boot-blocks-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
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
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Both reconcilers read the whole database, so a fixture left behind is a row
 * the next case's boot would decide as well.
 */
beforeEach(() => {
  for (const table of [
    "workflow_instance_blocks",
    "workflow_instance_runs",
    "workflow_instances",
    "workflows",
    "run_deps",
    "runs",
  ]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
});

const HOUR = 3_600_000;

/**
 * The graph from the issue: one run block, and one merge block behind it that
 * `deferredNodes` leaves out of the creating pass — so `startWorkflow` writes it
 * a `waiting` ledger row and nothing else.
 */
const GRAPH = JSON.stringify({
  nodes: [
    { id: "A", name: "Build it", kind: "run" },
    { id: "B", name: "Land it", kind: "merge" },
  ],
  edges: [{ from: "A", to: "B", edge: "on-success", continueBranch: false }],
});

/**
 * The same graph with a loop at its head: `maxPasses` a number rather than
 * absent, because `advanceLoop` reads that field with `typeof` and a loop
 * without it ends on the next advance for a reason that has nothing to do with
 * the boot.
 */
const LOOP_GRAPH = JSON.stringify({
  nodes: [
    {
      id: "L",
      name: "Keep at it",
      kind: "loop",
      maxPasses: 5,
      maxLoopCostUSD: null,
    },
    { id: "B", name: "Land it", kind: "merge" },
  ],
  edges: [{ from: "L", to: "B", edge: "on-success", continueBranch: true }],
});

/**
 * One instance mid-flight when the process died: its head a real run row, its
 * tail a `waiting` block.
 *
 * Inserted rather than built through `startWorkflow`, which would want a mount,
 * a git probe and a real spawn. What is under test is the join these columns
 * make — a run's status against the instance its block belongs to.
 */
function scene(
  name: string,
  run: { status: string; pausedAt?: number | null },
  instanceStatus = "started",
): { instanceId: string; runId: string } {
  const now = Date.now();
  const instanceId = `inst-${name}`;
  const runId = `run-${name}`;
  const db = dbMod.db();

  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${name}`, name, GRAPH, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(instanceId, `wf-${name}`, name, GRAPH, now, instanceStatus);
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                       created_at, started_at, paused_at, work_dir)
     VALUES (?, ?, ?, ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, 0, ?, ?, ?, NULL)`,
  ).run(
    runId,
    path.join(root, "workspace"),
    "build it",
    run.status,
    now,
    now,
    run.pausedAt ?? null,
  );
  db.prepare(
    "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
      " VALUES (?, 'A', 'Build it', 0, ?)",
  ).run(instanceId, runId);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, 'B', 'Land it', 1, 'merge', 'waiting')",
  ).run(instanceId);

  return { instanceId, runId };
}

/**
 * The same instance one block kind over: a loop mid-pass, and a merge block
 * behind it that only the loop's own verdict can release.
 *
 * The pass is an ordinary member with `emitted_by` set to the loop, which is
 * what `bootBlockPlan` sees and what `loopPasses` reads — so the run this boot
 * keeps and the pass the block is on are the same row, as they are in
 * `createPass`.
 */
function loopScene(
  name: string,
  run: { status: string; pausedAt?: number | null },
  instanceStatus = "started",
): { instanceId: string; runId: string } {
  const now = Date.now();
  const instanceId = `inst-${name}`;
  const runId = `run-${name}`;
  const db = dbMod.db();

  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${name}`, name, LOOP_GRAPH, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(instanceId, `wf-${name}`, name, LOOP_GRAPH, now, instanceStatus);
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                       created_at, started_at, paused_at, work_dir)
     VALUES (?, ?, ?, ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, 0, ?, ?, ?, NULL)`,
  ).run(
    runId,
    path.join(root, "workspace"),
    "keep at it",
    run.status,
    now,
    now,
    run.pausedAt ?? null,
  );
  db.prepare(
    "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id, emitted_by)" +
      " VALUES (?, 'L#pass-1', 'Keep at it — pass 1', 0, ?, 'L')",
  ).run(instanceId, runId);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status, started_at)" +
      " VALUES (?, 'L', 'Keep at it', 0, 'loop', 'looping', ?)",
  ).run(instanceId, now);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, 'B', 'Land it', 1, 'merge', 'waiting')",
  ).run(instanceId);

  return { instanceId, runId };
}

function blockOf(
  instanceId: string,
  nodeId = "B",
): {
  status: string;
  error: string | null;
  finishedAt: number | null;
} {
  const block = workflows.blocksOf(instanceId).find((b) => b.nodeId === nodeId);
  assert.ok(block, "the fixture's block row has gone");
  return {
    status: block.status,
    error: block.error,
    finishedAt: block.finishedAt,
  };
}

/** The boot, in `src/instrumentation.ts`'s order. */
function boot(): void {
  orch.reconcileOnBoot();
  workflows.reconcileBlocksOnBoot();
}

describe("a waiting block whose workflow kept a run across the restart", () => {
  it("is left waiting rather than written off", () => {
    const { instanceId, runId } = scene("Nightly build", {
      status: "paused",
      pausedAt: Date.now() - HOUR,
    });

    boot();

    // The exception `reconcileOnBoot` makes, unchanged: the head survives.
    assert.equal(orch.getRun(runId)!.status, "paused");
    // And now the tail survives with it.
    const block = blockOf(instanceId);
    assert.equal(block.status, "waiting");
    assert.equal(block.error, null, "nothing may be recorded against a block still to come");
    assert.equal(block.finishedAt, null);
  });

  it("is decided by the next advance pass, on what is true then", () => {
    const { instanceId, runId } = scene("Release train", {
      status: "paused",
      pausedAt: Date.now() - HOUR,
    });

    boot();
    // While the run is parked there is still nothing to decide: a live
    // predecessor is `pending`, not a verdict.
    workflows.advanceInstances();
    assert.equal(blockOf(instanceId).status, "waiting");

    // The run resumes and this time ends without doing a cycle, which is the
    // one thing that settles the block rather than releasing it.
    dbMod
      .db()
      .prepare("UPDATE runs SET status='stopped', finished_at=? WHERE id=?")
      .run(Date.now(), runId);
    workflows.advanceInstances();

    const block = blockOf(instanceId);
    assert.equal(block.status, "blocked");
    assert.match(
      block.error ?? "",
      /Build it/,
      "the reason must name the run in front of it, as the cascade always does",
    );
    assert.doesNotMatch(
      block.error ?? "",
      /restart/i,
      "the restart decided nothing here and must not be what the row says",
    );
  });
});

describe("a waiting block with nothing left of its workflow", () => {
  it("is closed out when the boot failed the run in front of it", () => {
    const { instanceId, runId } = scene("Broken build", { status: "running" });

    boot();

    assert.equal(orch.getRun(runId)!.status, "failed");
    const block = blockOf(instanceId);
    assert.equal(block.status, "blocked");
    assert.ok(block.finishedAt, "a block that is closed out keeps the instant it ended");
    assert.match(block.error ?? "", /closed out by the same restart/);
  });

  it("is closed out when the pause was too stale to keep", () => {
    const { instanceId, runId } = scene("Stale pause", {
      status: "paused",
      // Past `resumeGraceHours`, which defaults to 24.
      pausedAt: Date.now() - 48 * HOUR,
    });

    boot();

    assert.equal(orch.getRun(runId)!.status, "stopped");
    const block = blockOf(instanceId);
    assert.equal(block.status, "blocked");
    assert.match(block.error ?? "", /closed out by the same restart/);
  });

  it("is closed out when the restart caught a halt half way through", () => {
    // The one instance whose blocks must come down however live its members
    // are: `stopInstance` had already decided this workflow was over.
    const { instanceId, runId } = scene(
      "Halted graph",
      { status: "paused", pausedAt: Date.now() - HOUR },
      "stopping",
    );

    boot();

    assert.equal(orch.getRun(runId)!.status, "paused");
    const block = blockOf(instanceId);
    assert.equal(block.status, "blocked");
    assert.match(block.error ?? "", /no longer running/);
  });
});

describe("a looping block whose workflow kept its pass across the restart", () => {
  it("is left looping rather than failed", () => {
    const { instanceId, runId } = loopScene("Docs sweep", {
      status: "paused",
      pausedAt: Date.now() - HOUR,
    });

    boot();

    assert.equal(orch.getRun(runId)!.status, "paused");
    const loop = blockOf(instanceId, "L");
    assert.equal(
      loop.status,
      "looping",
      "the pass this block is on is the run the same boot decided to keep",
    );
    assert.equal(
      loop.error,
      null,
      "nothing may be recorded against a loop that is still repeating",
    );
    assert.equal(loop.finishedAt, null);
  });

  it("holds the blocks behind it rather than writing them off", () => {
    const { instanceId } = loopScene("Release notes", {
      status: "paused",
      pausedAt: Date.now() - HOUR,
    });

    boot();
    // The verdict a live loop gives its successors is `pending`; a failed one
    // gives them "could not repeat its task", which is what a restart used to
    // decide here while the pass was still committing to their branch.
    workflows.advanceInstances();

    assert.equal(blockOf(instanceId, "L").status, "looping");
    const behind = blockOf(instanceId);
    assert.equal(behind.status, "waiting");
    assert.equal(behind.error, null);
  });
});

describe("a looping block with nothing left of its workflow", () => {
  it("is closed out when the boot failed the pass it was on", () => {
    const { instanceId, runId } = loopScene("Abandoned sweep", {
      status: "running",
    });

    boot();

    assert.equal(orch.getRun(runId)!.status, "failed");
    const loop = blockOf(instanceId, "L");
    assert.equal(loop.status, "failed");
    assert.ok(loop.finishedAt, "a block that is closed out keeps the instant it ended");
    assert.match(loop.error ?? "", /was repeating its task/);
    assert.match(loop.error ?? "", /closed out by the same restart/);
  });

  it("is closed out when the restart caught a halt half way through", () => {
    // A live pass does not spare a loop whose workflow was already coming
    // down: `stopInstance` had decided this graph was over before the boot.
    const { instanceId, runId } = loopScene(
      "Halted sweep",
      { status: "paused", pausedAt: Date.now() - HOUR },
      "stopping",
    );

    boot();

    assert.equal(orch.getRun(runId)!.status, "paused");
    const loop = blockOf(instanceId, "L");
    assert.equal(loop.status, "failed");
    assert.match(loop.error ?? "", /closed out by the same restart/);
  });
});
