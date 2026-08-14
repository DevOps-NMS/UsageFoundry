import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./workflows";

/**
 * Covers two things about one join, and the second is the first turned around.
 *
 * A halted workflow's members stay halted; and a member picked up again asks
 * afresh about everything it blocked — including the half of a graph that is not
 * runs at all. Both are decided by joining `runs` (or
 * `workflow_instance_blocks`) to `workflow_instances` through
 * `workflow_instance_runs`, and every way of getting either wrong typechecks,
 * throws nothing, and looks identical on the page.
 *
 * ## The halt
 *
 * `stopInstance` writes `blocked` onto every member that was still `waiting`,
 * and such a row has `work_dir` null and `iterations` 0 — which is bit for bit
 * the candidate set `reviveBlockedDependents` selects and the shape `reopenRun`
 * accepts through its `waitingAgain` branch. Neither looked at the workflow, so
 * pressing Try again on a halted member, or reopening the stopped run in front
 * of it, put agents back to work under an instance whose page says "Stopped" —
 * with the instance budget guard unable to stop them again, since it acts only
 * on an instance that is `started`.
 *
 * It earns a place in this suite on this suite's terms: every way of getting it
 * wrong typechecks, throws nothing, and looks identical on the page — the only
 * evidence is a billed agent nobody asked for. And it is a test about a join
 * across three tables, so unlike the pure decisions beside it there is no
 * argument to hand a function; the database is the subject.
 *
 * ## The pick-up
 *
 * A node deferred behind an orchestrator or a merge block is not a run: it holds
 * a row in `workflow_instance_blocks` until `advanceInstance` turns it into one,
 * and `planInstanceStep` skips any such row that does not say `waiting`. So a
 * predecessor that ended in a way its edge could not accept wrote that row
 * `blocked` and nothing ever put it back — reopening the predecessor woke the
 * *runs* behind it and left the ledger alone, so the instance ran to the end of
 * its graph with the tail missing and the row still naming an ending the
 * operator had since undone. The database is the subject here for the same
 * reason: the gate is a stored status, so the pure `planInstanceStep` cases
 * beside it cannot see this at all.
 *
 * Its own file, and `DATA_DIR` set before the first import, for the reason
 * `chatOrder.test.ts` and `chatTurn.test.ts` are: `config.ts` reads that
 * variable at module load and `orchestrator.ts` pulls it in statically, so a
 * file that imported either at the top would already be bound to the
 * repository's own `.data` directory — which on a developer's machine is the
 * real one. `node --test` gives each file its own process; the assertion in
 * `before` is what makes a change to that fail loudly.
 */

let root: string;
let orch: typeof import("./orchestrator");
let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-halted-members-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  // Cleared, not just overridden: `WORKSPACE_ROOTS` wins over `WORKSPACE_ROOT`
  // whenever it is set, and it is set in this repository's own `.env` — so a
  // node that reaches `createRun` would otherwise resolve against the
  // developer's real mounts instead of the temp one this file made.
  process.env.WORKSPACE_ROOTS = "";
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

/** A budget a reopen would pass, so nothing else can be what refused it. */
const BUDGET = { maxIterations: 5, maxDurationMinutes: 60 };

let seq = 0;

/**
 * Three runs chained A → B → C, exactly as `startWorkflow` leaves a three-block
 * graph: the head admitted, the two behind it `waiting` and holding nothing.
 *
 * Inserted rather than built through `createRun`, because what is under test is
 * a join and `createRun` would drag in a mount, a git probe and — through
 * `promoteQueued` — a real spawn. The columns that matter here are the three the
 * candidate query reads: `status`, `work_dir` and `iterations`.
 */
function chain(prefix: string): [string, string, string] {
  const ids: [string, string, string] = [
    `${prefix}-a`,
    `${prefix}-b`,
    `${prefix}-c`,
  ];
  const now = Date.now() + seq++;
  const insert = dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, work_dir)
       VALUES (?, ?, ?, ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, 0, ?, NULL)`,
    );
  const link = dbMod
    .db()
    .prepare(
      "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
        " VALUES (?, ?, 'on-success', 0, ?)",
    );

  insert.run(ids[0], path.join(root, "workspace"), "build it", "queued", now);
  insert.run(ids[1], path.join(root, "workspace"), "review it", "waiting", now + 1);
  insert.run(ids[2], path.join(root, "workspace"), "land it", "waiting", now + 2);
  link.run(ids[1], ids[0], now);
  link.run(ids[2], ids[1], now);
  return ids;
}

/** One press of Run: the instance row and its members, as `startWorkflow` writes them. */
function instance(name: string, runIds: readonly string[]): string {
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
       VALUES (?, ?, ?, '{"nodes":[],"edges":[]}', ?, 'started')`,
    )
    .run(id, `wf-${name}`, name, now);
  const member = dbMod
    .db()
    .prepare(
      "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
        " VALUES (?, ?, ?, ?, ?)",
    );
  runIds.forEach((runId, i) => member.run(id, `node-${i}`, `Block ${i}`, i, runId));
  return id;
}

function statusOf(id: string): string {
  return orch.getRun(id)!.status;
}

describe("a member of a halted workflow", () => {
  it("is refused by name when the run page asks to pick it up", () => {
    const [a, b, c] = chain("halt-reopen");
    const inst = instance("Nightly sweep", [a, b, c]);

    const halt = workflows.stopInstance(inst, { kind: "operator" });
    assert.equal(halt.ok, true);
    if (!halt.ok) return;
    assert.deepEqual(
      halt.report.blocked,
      [b, c],
      "the halt must be the one that wrote `blocked` on the waiting members",
    );
    assert.equal(statusOf(b), "blocked");

    // The reproduction: B's page offers Try again, because `blockedBeforeStart`
    // is true for exactly this row.
    const refused = orch.reopenRun(b, BUDGET);
    assert.equal(refused.ok, false, "a halted member must not be picked up");
    if (refused.ok) return;
    assert.match(refused.reason, /Nightly sweep/, "the refusal must name the workflow");

    // And the head, which is `stopped` and so `REOPENABLE` — the other half of
    // the reproduction, and the one that wakes the chain transitively.
    const head = orch.reopenRun(a, BUDGET);
    assert.equal(head.ok, false);
    if (head.ok) return;
    assert.match(head.reason, /Nightly sweep/);

    // Nothing moved, and the halt's own record is intact: the revive clears
    // both of these, so a sentence saying the workflow was stopped would be gone
    // from the row the operator is reading.
    for (const id of [b, c]) {
      const row = orch.getRun(id)!;
      assert.equal(row.status, "blocked");
      assert.match(row.stop_reason ?? "", /stopped by the operator/i);
      assert.ok(row.finished_at, "a halted member keeps the instant it ended");
    }
    assert.equal(statusOf(a), "stopped");
  });

  it("is not woken by reopening the run in front of it", () => {
    const [a, b, c] = chain("halt-revive");
    const inst = instance("Release train", [a, b, c]);
    assert.equal(workflows.stopInstance(inst, { kind: "operator" }).ok, true);

    const woken = orch.reviveBlockedDependents([a]);

    assert.equal(woken, 0, "no member of a halted workflow may go back to waiting");
    for (const id of [b, c]) {
      const row = orch.getRun(id)!;
      assert.equal(row.status, "blocked");
      assert.match(row.stop_reason ?? "", /Release train/);
      assert.ok(row.finished_at);
    }
  });
});

describe("a run no halt covers", () => {
  it("still wakes the whole chain behind it", () => {
    const [a, b, c] = chain("plain");
    // What the cascade leaves: the head ended having done nothing, so both runs
    // behind it are blocked with a sentence naming the one in front.
    dbMod
      .db()
      .prepare("UPDATE runs SET status='stopped', finished_at=? WHERE id=?")
      .run(Date.now(), a);
    orch.releaseDependents();
    assert.equal(statusOf(b), "blocked");
    assert.equal(statusOf(c), "blocked");

    // The transitive wake `revivableDependents` was added for, unchanged.
    assert.equal(orch.reviveBlockedDependents([a]), 2);
    for (const id of [b, c]) {
      const row = orch.getRun(id)!;
      assert.equal(row.status, "waiting");
      assert.equal(row.stop_reason, null);
      assert.equal(row.finished_at, null);
    }
  });

  it("is still picked up when its instance is running", () => {
    const [a, b, c] = chain("live-instance");
    instance("Live graph", [a, b, c]);
    dbMod
      .db()
      .prepare("UPDATE runs SET status='stopped', finished_at=? WHERE id=?")
      .run(Date.now(), a);
    orch.releaseDependents();
    assert.equal(statusOf(b), "blocked");

    // The case the membership condition must not catch: a member whose own
    // dependency stopped at its budget, in an instance still `started`. Nothing
    // has been halted, so this is the chain the revive exists to rescue.
    assert.equal(orch.reviveBlockedDependents([a]), 2);
    assert.equal(statusOf(b), "waiting");
    assert.equal(statusOf(c), "waiting");
  });

  it("accepts a reopen of a blocked member of a running instance", () => {
    const [a, b] = chain("live-reopen");
    instance("Second graph", [a, b]);
    dbMod
      .db()
      .prepare("UPDATE runs SET status='stopped', finished_at=? WHERE id=?")
      .run(Date.now(), a);
    orch.releaseDependents();
    assert.equal(statusOf(b), "blocked");

    // Accepted, and then re-blocked by the release pass in the same call,
    // because the run in front of it is still terminal having done nothing.
    // What is asserted is the answer, which is what the route turns into a 400.
    assert.equal(orch.reopenRun(b, BUDGET).ok, true);
  });
});

/* ------------------------------------------------------------------ */
/* The half of a graph that is not runs yet                            */
/* ------------------------------------------------------------------ */

/** Whatever these tests do not set, in the shape `planInstanceStep` reads. */
function node(id: string, kind: WorkflowNode["kind"]): WorkflowNode {
  return {
    id,
    name: id,
    kind,
    templateId: null,
    // The one mount a bare `WORKSPACE_ROOT` degrades to, named from its
    // basename — so a node that reaches `createRun` resolves to the temp
    // workspace this file made and to nothing on the real disk.
    mountId: "workspace",
    folder: "",
    task: `do ${id}`,
    promptOverride: null,
    agentId: null,
    fanOut: kind === "orchestrator" ? 2 : null,
    mergeStrategy: null,
    mergeAutoResolve: false,
  };
}

function edge(from: string, to: string): WorkflowEdge {
  return { from, to, edge: "on-success", continueBranch: false };
}

/** One run row in whatever state its node needs it to be in. */
function member(id: string, status: string, iterations = 1): string {
  const now = Date.now() + seq++;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, work_dir)
       VALUES (?, ?, ?, ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      path.join(root, "workspace"),
      `work on ${id}`,
      status,
      iterations,
      now,
      status === "queued" || status === "running" ? null : now,
    );
  return id;
}

/**
 * One press of Run on a graph that defers: a member row for every node that
 * became a run, and a ledger row for every node that did not.
 *
 * Inserted rather than driven through `startWorkflow` for `chain`'s reason — the
 * subject is a stored status and a join, and the real thing would want a git
 * probe, a template registry and a spawn to reach the same two rows.
 */
function deferredInstance(
  name: string,
  graph: WorkflowGraph,
  members: ReadonlyArray<{ nodeId: string; runId: string }>,
  blocks: ReadonlyArray<{ nodeId: string; status: string }>,
): string {
  const id = `inst-${name.replace(/\s+/g, "-")}`;
  const now = Date.now();
  dbMod
    .db()
    .prepare(
      "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(`wf-${id}`, name, JSON.stringify(graph), now, now);
  dbMod
    .db()
    .prepare(
      `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
       VALUES (?, ?, ?, ?, ?, 'started')`,
    )
    .run(id, `wf-${id}`, name, JSON.stringify(graph), now);

  const order = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const addMember = dbMod
    .db()
    .prepare(
      "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
        " VALUES (?, ?, ?, ?, ?)",
    );
  for (const m of members) {
    addMember.run(id, m.nodeId, m.nodeId, order.get(m.nodeId) ?? 0, m.runId);
  }

  const addBlock = dbMod
    .db()
    .prepare(
      "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
    );
  for (const b of blocks) {
    const kind = graph.nodes.find((n) => n.id === b.nodeId)!.kind;
    addBlock.run(id, b.nodeId, b.nodeId, order.get(b.nodeId) ?? 0, kind, b.status);
  }
  return id;
}

function blockOf(instanceId: string, nodeId: string) {
  return workflows.blocksOf(instanceId).find((b) => b.nodeId === nodeId);
}

function memberRunOf(instanceId: string, nodeId: string): string | null {
  const row = dbMod
    .db()
    .prepare(
      "SELECT run_id AS runId FROM workflow_instance_runs WHERE instance_id=? AND node_id=?",
    )
    .get(instanceId, nodeId) as { runId: string } | undefined;
  return row?.runId ?? null;
}

/**
 * One turn of the event loop.
 *
 * `reviveBlockedDependents` reaches the ledger through `import("./workflows")`,
 * which is how anything in `orchestrator.ts` reaches that module — it imports
 * this one, so the static edge only goes the other way. The module is already
 * loaded by the time any test runs, so this resolves from the cache and one
 * macrotask is after every microtask that could be behind it.
 */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("a node deferred behind a block", () => {
  before(() => {
    fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
    // A run holding the mount root, so `promoteQueued` — which `reopenRun` and
    // `createRun` both call — finds every folder reserved and starts nothing.
    // The missing `CLAUDE_BIN` is the backstop; this is what makes "no test in
    // here reaches a spawn" a property of the fixture rather than of a spawn
    // that happens to fail.
    member("folder-held", "running", 0);
  });

  it("is asked again when the run in front of it is picked up", async () => {
    // The graph from the issue: A defers B and C, B became a run, C is still a
    // ledger row waiting on it.
    const graph: WorkflowGraph = {
      nodes: [node("A", "orchestrator"), node("B", "run"), node("C", "run")],
      edges: [edge("A", "B"), edge("B", "C")],
    };
    const b = member("tail-b", "failed");
    const inst = deferredInstance(
      "Deferred tail",
      graph,
      [{ nodeId: "B", runId: b }],
      [
        { nodeId: "A", status: "emitted" },
        { nodeId: "C", status: "waiting" },
      ],
    );

    // Written off by the app's own writer, exactly as it happens in flight.
    workflows.advanceInstances();
    const off = blockOf(inst, "C")!;
    assert.equal(off.status, "blocked");
    assert.match(off.error ?? "", /“B”, which ended failed/);

    assert.equal(orch.reopenRun(b, BUDGET).ok, true);
    await settled();

    const asked = blockOf(inst, "C")!;
    assert.equal(
      asked.status,
      "waiting",
      "the only status `planInstanceStep` will look at again",
    );
    assert.equal(asked.error, null, "the sentence about the undone ending goes");
    assert.equal(asked.finishedAt, null);

    // And the question is reopened rather than answered: the node becomes a run
    // only once the run in front of it has actually succeeded.
    dbMod
      .db()
      .prepare("UPDATE runs SET status='completed', iterations=1 WHERE id=?")
      .run(b);
    workflows.advanceInstances();

    assert.equal(
      blockOf(inst, "C"),
      undefined,
      "the ledger row goes when the node becomes a run",
    );
    const created = memberRunOf(inst, "C");
    assert.ok(created, "C is a member run of the instance now");
    assert.equal(orch.getRun(created)!.status, "queued");
  });

  it("is blocked again by the ending that still stands", async () => {
    // Two predecessors, both terminal. Reopening one must not start the node —
    // it must re-block it with a sentence about the other.
    const graph: WorkflowGraph = {
      nodes: [
        node("A", "orchestrator"),
        node("B", "run"),
        node("D", "run"),
        node("C", "run"),
      ],
      edges: [edge("A", "B"), edge("A", "D"), edge("B", "C"), edge("D", "C")],
    };
    const b = member("fan-b", "failed");
    member("fan-d", "failed");
    const inst = deferredInstance(
      "Fan in",
      graph,
      [
        { nodeId: "B", runId: b },
        { nodeId: "D", runId: "fan-d" },
      ],
      [
        { nodeId: "A", status: "emitted" },
        { nodeId: "C", status: "waiting" },
      ],
    );

    workflows.advanceInstances();
    assert.match(blockOf(inst, "C")!.error ?? "", /“B”/);

    assert.equal(orch.reopenRun(b, BUDGET).ok, true);
    await settled();
    assert.equal(blockOf(inst, "C")!.status, "waiting");

    workflows.advanceInstances();
    const again = blockOf(inst, "C")!;
    assert.equal(again.status, "blocked");
    assert.match(again.error ?? "", /“D”, which ended failed/);
    assert.doesNotMatch(
      again.error ?? "",
      /“B”/,
      "the reason must name the ending that still stands, not the undone one",
    );
  });

  it("stays blocked when its workflow was halted", () => {
    const graph: WorkflowGraph = {
      nodes: [node("A", "orchestrator"), node("B", "run"), node("C", "run")],
      edges: [edge("A", "B"), edge("B", "C")],
    };
    const b = member("halted-b", "queued", 0);
    const inst = deferredInstance(
      "Halted tail",
      graph,
      [{ nodeId: "B", runId: b }],
      [
        { nodeId: "A", status: "emitted" },
        { nodeId: "C", status: "waiting" },
      ],
    );
    assert.equal(workflows.stopInstance(inst, { kind: "operator" }).ok, true);

    const halted = blockOf(inst, "C")!;
    assert.equal(halted.status, "blocked");
    assert.match(halted.error ?? "", /Halted tail/);

    // The bound. `reopenRun` already refuses a halted member by name, so the
    // revive is called directly here: it is the door that would otherwise be a
    // second way back into a stopped workflow, and it must refuse on the
    // instance rather than on whoever happened to call it.
    assert.equal(
      workflows.reviveBlockedBlocks([b]),
      0,
      "no block of a halted workflow may be reopened",
    );
    const still = blockOf(inst, "C")!;
    assert.equal(still.status, "blocked");
    assert.match(
      still.error ?? "",
      /Halted tail/,
      "the halt's own record must survive",
    );
  });

  it("is not something a run outside any workflow can reach", () => {
    const [a] = chain("no-workflow");
    assert.equal(workflows.reviveBlockedBlocks([a]), 0);
  });
});
