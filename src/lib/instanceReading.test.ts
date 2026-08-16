import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * What `instanceStatus` is handed, which is a count over two tables.
 *
 * The decision itself is pure and tested beside `haltPlan`; this is the half of
 * it that no pure function can reach — a graph is half runs and half a ledger of
 * blocks that are not runs yet, and "is anything still live" has to be asked of
 * both. Counting only the runs is the failure this exists to have none of, and
 * it is the quiet one: a node deferred behind an orchestrator block holds a
 * `waiting` row in `workflow_instance_blocks` and nothing else, so an instance
 * whose runs have all settled reads as *finished* while a block is still to
 * wake — and when it does wake, hours later, it starts a billed agent under a
 * page that already told the operator this press of Run was over.
 *
 * The mirror of it is the same shape one status along: a member written off
 * because the block in front of it satisfied nothing is what separates a graph
 * that reached its end from one missing its tail, and it too can be either a run
 * or a ledger row. Reported as `finished`, a workflow that did half its work
 * reads exactly like one that did all of it.
 *
 * Its own file, and `DATA_DIR` set before the first import, for the reason
 * `haltedMembers.test.ts` is: `config.ts` reads that variable at module load, so
 * a file that imported anything at the top would already be bound to the
 * repository's own `.data` directory — which on a developer's machine is the
 * real one.
 */

let root: string;
let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-instance-reading-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  workflows = await import("./workflows");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;

/** A member run in whatever status the case is about. */
function member(instanceId: string, status: string): void {
  const id = `run-${seq}`;
  const position = seq++;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                         iterations, created_at)
       VALUES (?, ?, 'do it', ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}',
               1, 0, ?)`,
    )
    .run(id, path.join(root, "workspace"), status, Date.now() + position);
  dbMod
    .db()
    .prepare(
      "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
        " VALUES (?, ?, ?, ?, ?)",
    )
    .run(instanceId, `node-${position}`, `Block ${position}`, position, id);
}

/** A node that is not a run: deferred behind a deciding block, or written off. */
function ledgerBlock(instanceId: string, status: string): void {
  const position = seq++;
  dbMod
    .db()
    .prepare(
      "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name," +
        " position, kind, status) VALUES (?, ?, ?, ?, 'run', ?)",
    )
    .run(instanceId, `block-${position}`, `Block ${position}`, position, status);
}

/** One press of Run, as `startWorkflow` leaves the row. */
function instance(name: string, stored = "started"): string {
  const id = `inst-${name}`;
  const now = Date.now();
  dbMod
    .db()
    .prepare(
      "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
    )
    .run(`wf-${name}`, name, now, now);
  dbMod
    .db()
    .prepare(
      `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
       VALUES (?, ?, ?, '{"nodes":[],"edges":[]}', ?, ?)`,
    )
    .run(id, `wf-${name}`, name, now, stored);
  return id;
}

function read(id: string) {
  const inst = workflows.getInstance(id);
  assert.ok(inst, "the instance must be readable");
  return inst;
}

describe("what an instance reads as, counted over both halves of a graph", () => {
  it("is finished once every member has settled", () => {
    const id = instance("finished");
    member(id, "completed");
    member(id, "completed");
    const inst = read(id);
    assert.equal(inst.status, "finished");
    assert.equal(inst.liveRunCount, 0);
    assert.equal(inst.blockedCount, 0);
  });

  it("is started while any member run is still going", () => {
    const id = instance("working");
    member(id, "completed");
    member(id, "running");
    assert.equal(read(id).status, "started");
  });

  it("is started while a node deferred behind a block is still to wake", () => {
    // The case a runs-only count gets wrong. Every run has settled and the graph
    // is not over: this row becomes a run the moment the block in front of it
    // decides, and reporting it finished is this app saying a press of Run
    // ended while it is still about to start an agent.
    const id = instance("deferred");
    member(id, "completed");
    ledgerBlock(id, "waiting");
    const inst = read(id);
    assert.equal(inst.status, "started");
    assert.equal(inst.liveRunCount, 1);
  });

  it("is blocked when a member run was written off", () => {
    const id = instance("blocked-run");
    member(id, "failed");
    member(id, "blocked");
    const inst = read(id);
    assert.equal(inst.status, "blocked");
    assert.equal(inst.blockedCount, 1);
  });

  it("is blocked when the node written off never became a run", () => {
    // The same fact in the other table: a block behind a deciding block that
    // started nothing. Counted only in `runs`, this graph loses its tail and
    // still reports that it reached its end.
    const id = instance("blocked-ledger");
    member(id, "completed");
    ledgerBlock(id, "blocked");
    const inst = read(id);
    assert.equal(inst.status, "blocked");
    assert.equal(inst.blockedCount, 1);
  });

  it("keeps a halt above both counts", () => {
    // `stopping` until the last signalled child dies, and `stopped` after —
    // never `blocked`, however many members the halt itself wrote off.
    const id = instance("halted", "stopping");
    member(id, "running");
    member(id, "blocked");
    assert.equal(read(id).status, "stopping");

    dbMod
      .db()
      .prepare("UPDATE runs SET status='stopped' WHERE status='running'")
      .run();
    assert.equal(read(id).status, "stopped");
  });
});
