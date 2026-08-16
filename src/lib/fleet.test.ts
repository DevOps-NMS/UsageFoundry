import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * The two halves of the install-wide control, and both are database subjects.
 *
 * **The stop** has to take down every live run in one pass, whatever status each
 * is in, and it has to block the ones that have not started *before* it signals
 * anything — because stopping a run releases its dependents, and a dependent
 * released a moment before the walk reached it would be admitted, promoted and
 * spawned. A run starting *because* the fleet was stopped is the failure this
 * ordering exists to have none of, and nothing about it throws: the operator
 * gets a page saying everything stopped and an agent working underneath it.
 *
 * **The hold** is read by four separate call sites — `promoteQueued`,
 * `releaseDependents`, `tickSchedules` and `emitBlockRuns` — and a fix that
 * misses one is silent in exactly the same way: work starts while a banner says
 * new work is held. So there is a case per site, each driving the real entry
 * point rather than the pure decision underneath it, and each proving the
 * *difference* the flag makes by running the same call with it clear.
 *
 * Its own file, and `DATA_DIR` set before the first import, for the reason
 * `haltedMembers.test.ts` gives: `config.ts` reads that variable at module load
 * and `orchestrator.ts` pulls it in statically, so a file importing either at
 * the top would already be bound to the repository's own `.data` — which on a
 * developer's machine is the real one.
 */

let root: string;
let workspace: string;
let orch: typeof import("./orchestrator");
let workflows: typeof import("./workflows");
let schedules: typeof import("./schedules");
let settings: typeof import("./settings");
let fleet: typeof import("./fleet");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-fleet-"));
  workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  // Cleared, not overridden: `WORKSPACE_ROOTS` wins whenever it is set and this
  // repository's own `.env` sets it, so a run that reached `createRun` would
  // resolve against the developer's real mounts.
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
  schedules = await import("./schedules");
  settings = await import("./settings");
  fleet = await import("./fleet");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;

/**
 * One run row, inserted rather than created.
 *
 * `createRun` would drag in a mount, a git probe and — through `promoteQueued` —
 * a real spawn, and what is under test here is which rows a walk selects.
 * Each run gets its own folder so no two of them conflict, which keeps the
 * queue's own promotion out of the assertions.
 */
function run(
  id: string,
  status: string,
  extra: { folder?: string; iterations?: number } = {},
): string {
  const folder = extra.folder ?? path.join(workspace, id);
  fs.mkdirSync(folder, { recursive: true });
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                         iterations, created_at, work_dir)
       VALUES (?, ?, 'do it', ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}',
               1, ?, ?, ?)`,
    )
    .run(id, folder, status, extra.iterations ?? 0, Date.now() + seq++, folder);
  return id;
}

function statusOf(id: string): string {
  return orch.getRun(id)!.status;
}

/** A workflow row with no instance budget — which is what a schedule refuses. */
function workflow(id: string, name: string): string {
  const now = Date.now();
  dbMod
    .db()
    .prepare(
      `INSERT INTO workflows (id, name, graph, created_at, updated_at)
       VALUES (?, ?, '{"nodes":[],"edges":[]}', ?, ?)`,
    )
    .run(id, name, now, now);
  return id;
}

describe("stopFleet", () => {
  it("takes down every live status in one pass and leaves finished runs alone", () => {
    const running = run("stop-running", "running");
    const queued = run("stop-queued", "queued");
    const paused = run("stop-paused", "paused");
    const waiting = run("stop-waiting", "waiting");
    // The silent half: a `completed` row rewritten as stopped destroys the
    // record of work that landed, and nothing afterwards says it happened.
    const completed = run("stop-completed", "completed", { iterations: 3 });
    const blocked = run("stop-blocked", "blocked");

    const report = fleet.stopFleet();

    assert.deepEqual(report.blocked, [waiting]);
    // Every one of the three live statuses answers `cancelled` here because no
    // child is registered in this process; what matters is that each was
    // reached, and that none of them was skipped for being the wrong status.
    for (const id of [running, queued, paused]) {
      assert.ok(
        report.cancelled.includes(id) || report.signalled.includes(id),
        `${statusOf(id)} run was not reached`,
      );
    }
    assert.equal(statusOf(queued), "stopped");
    assert.equal(statusOf(paused), "stopped");
    assert.equal(statusOf(waiting), "blocked");
    assert.match(orch.getRun(waiting)!.stop_reason ?? "", /every run in flight/);

    // Untouched, and still saying what they said.
    assert.equal(statusOf(completed), "completed");
    assert.equal(orch.getRun(completed)!.iterations, 3);
    assert.equal(statusOf(blocked), "blocked");
    for (const id of [completed, blocked]) {
      assert.equal(report.cancelled.includes(id), false);
      assert.equal(report.blocked.includes(id), false);
    }
  });

  it("blocks a waiting run before stopping the run it waits on", () => {
    // The ordering rule. `stopRun` on a queued row releases its dependents and
    // promotes, so a dependent still `waiting` when its dependency was stopped
    // would be admitted — a run starting because the fleet was stopped.
    const head = run("order-head", "queued");
    const tail = run("order-tail", "waiting");
    dbMod
      .db()
      .prepare(
        "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
          " VALUES (?, ?, 'on-finish', 0, ?)",
      )
      .run(tail, head, Date.now());

    const report = fleet.stopFleet();

    assert.equal(
      statusOf(tail),
      "blocked",
      "the dependent must be closed out by the stop, not released by it",
    );
    assert.deepEqual(report.blocked, [tail]);
    assert.match(orch.getRun(tail)!.stop_reason ?? "", /every run in flight/);
    assert.equal(statusOf(head), "stopped");
  });

  it("halts a workflow instance through its own door, with its own cause", () => {
    const member = run("wf-member", "queued");
    const now = Date.now();
    workflow("wf-fleet", "Nightly sweep");
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
         VALUES ('inst-fleet', 'wf-fleet', 'Nightly sweep', '{"nodes":[],"edges":[]}', ?, 'started')`,
      )
      .run(now);
    dbMod
      .db()
      .prepare(
        "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
          " VALUES ('inst-fleet', 'n0', 'Block 0', 0, ?)",
      )
      .run(member);

    const report = fleet.stopFleet();

    assert.equal(report.instances.length, 1);
    assert.equal(report.instances[0].acted, true);
    const instance = dbMod
      .db()
      .prepare("SELECT status, stop_cause FROM workflow_instances WHERE id='inst-fleet'")
      .get() as { status: string; stop_cause: string };
    assert.equal(instance.status, "stopping");
    // A third cause, not `operator`: afterwards it is the only thing telling a
    // workflow somebody stopped from one that went down with everything else.
    assert.equal(instance.stop_cause, "fleet");
    assert.equal(statusOf(member), "stopped");
    assert.match(orch.getRun(member)!.stop_reason ?? "", /Nightly sweep/);
    // Halted by its instance, so the standalone pass must not claim it too.
    assert.equal(report.cancelled.includes(member), false);
  });
});

describe("the hold on new work", () => {
  after(() => settings.setNewWorkPaused(false));

  it("stops promoteQueued starting anything", () => {
    const id = run("hold-promote", "queued");

    settings.setNewWorkPaused(true);
    orch.promoteQueued();
    assert.equal(statusOf(id), "queued", "a held queue must not start a run");

    settings.setNewWorkPaused(false);
    orch.promoteQueued();
    // `startRun` claims the row with a guarded UPDATE before its first `await`,
    // so promotion is observable synchronously. The interrupt below is what
    // keeps the continuation from reaching a spawn.
    assert.equal(statusOf(id), "running", "clearing the hold must promote it");
    orch.stopRun(id);
  });

  it("stops releaseDependents admitting a waiting run", () => {
    const head = run("hold-head", "completed", { iterations: 1 });
    const tail = run("hold-tail", "waiting");
    dbMod
      .db()
      .prepare(
        "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
          " VALUES (?, ?, 'on-success', 0, ?)",
      )
      .run(tail, head, Date.now());

    settings.setNewWorkPaused(true);
    orch.releaseDependents();
    assert.equal(
      statusOf(tail),
      "waiting",
      "a run whose dependency has succeeded must still wait while the fleet is held",
    );

    settings.setNewWorkPaused(false);
    orch.releaseDependents();
    assert.equal(statusOf(tail), "queued", "clearing the hold must admit it");
    orch.stopRun(tail);
  });

  it("still ends a chain that can never start, held or not", () => {
    // The half the hold must *not* suppress: `blocked` costs nothing and is the
    // true thing to say, and holding it back would leave a dead chain that can
    // only be ended by somebody remembering to clear the pause.
    const head = run("hold-dead-head", "failed");
    const tail = run("hold-dead-tail", "waiting");
    dbMod
      .db()
      .prepare(
        "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
          " VALUES (?, ?, 'on-success', 0, ?)",
      )
      .run(tail, head, Date.now());

    settings.setNewWorkPaused(true);
    orch.releaseDependents();
    assert.equal(statusOf(tail), "blocked");
  });

  it("stops emitBlockRuns starting runs nobody is watching", () => {
    const now = Date.now();
    workflow("wf-emit", "Fan out");
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
         VALUES ('inst-emit', 'wf-emit', 'Fan out', ?, ?, 'started')`,
      )
      .run(
        JSON.stringify({
          nodes: [
            {
              id: "n0",
              name: "Decide",
              kind: "orchestrator",
              fanOut: 3,
              mountId: null,
              folder: "",
              task: "decide",
            },
          ],
          edges: [],
        }),
        now,
      );
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)
         VALUES ('inst-emit', 'n0', 'Decide', 0, 'orchestrator', 'thinking')`,
      )
      .run();

    settings.setNewWorkPaused(true);
    const held = workflows.emitBlockRuns("inst-emit", "n0", "not even a list");
    assert.equal(held.ok, false);
    if (held.ok) return;
    assert.match(held.reason, /held/i, "the turn has to be told why it was refused");

    // Clear the hold and the *same* call is refused for a different reason —
    // which is what says the hold was the thing that refused it, rather than the
    // malformed payload that refuses it either way.
    settings.setNewWorkPaused(false);
    const open = workflows.emitBlockRuns("inst-emit", "n0", "not even a list");
    assert.equal(open.ok, false);
    if (open.ok) return;
    assert.match(open.reason, /list of run specs/);
  });

  it("stops tickSchedules firing", async () => {
    workflow("wf-sched", "Hourly");
    // An occurrence one minute ago, inside `FIRE_GRACE_MS`, so an unheld tick
    // has a window to act on.
    const now = Date.now();
    schedules.putSchedule(
      "wf-sched",
      { kind: "everyHours", hours: 1, anchorAt: now - 60 * 60 * 1000 - 60_000 },
      "UTC",
      now - 60 * 60 * 1000 - 60_000,
    );

    settings.setNewWorkPaused(true);
    await schedules.tickSchedules();
    const held = dbMod
      .db()
      .prepare("SELECT last_code FROM workflow_schedules WHERE workflow_id='wf-sched'")
      .get() as { last_code: string | null };
    assert.equal(held.last_code, null, "a held tick must decide nothing at all");

    // Unheld, the same tick reaches the door and is refused there instead — this
    // workflow sets no instance budget, which `scheduleRefusal` will not allow a
    // schedule to press Run under. Nothing is started either way; what the two
    // answers separate is a tick that never looked from one that did.
    settings.setNewWorkPaused(false);
    await schedules.tickSchedules();
    const open = dbMod
      .db()
      .prepare("SELECT last_code FROM workflow_schedules WHERE workflow_id='wf-sched'")
      .get() as { last_code: string | null };
    assert.equal(open.last_code, "unbudgeted");
  });

  it("survives a restart, because it is a row and not a variable", () => {
    // The usual reason it gets set is the restart it has to survive. It is
    // deliberately not a key of `Settings`, so an unrelated Save cannot clear it.
    settings.setNewWorkPaused(true);
    assert.equal(settings.newWorkPaused(), true);
    settings.saveSettings({ maxConcurrentRuns: 4 });
    assert.equal(
      settings.newWorkPaused(),
      true,
      "an unrelated settings save must not clear the hold",
    );
  });
});

/**
 * The per-run answer to a control that acts on a set.
 *
 * Both bulk pick-ups take a whole set — every `restart_closed` row, or every
 * terminal run the page is displaying — so a run somebody had deliberately
 * stopped was started again by a press aimed at the twenty-four beside it, and
 * nothing anywhere said it had been. That failure is silent in the worst way
 * available: an agent that edits files starts working in a folder the operator
 * had finished with, under limits nobody re-read.
 *
 * Three cases, because there are three doors and each is a different mechanism.
 * The fleet's own reads the column off the row at the moment of the write, so a
 * stale list cannot get past it. The restart notice reads a query, so what it
 * needs proving is the filter — in both directions, since putting a run back
 * has to restore the banner it left. And `reopenRun` deliberately does *not*
 * read the column at all: picking one run up by name is the decision being
 * taken back, so the mark has to be gone afterwards rather than quietly
 * excluding a run that has since worked again.
 */
describe("a run set aside", () => {
  // Suppresses `promoteQueued`, so a reopened row stays `queued` and nothing
  // reaches a spawn. What is under test is which rows each door selects.
  before(() => settings.setNewWorkPaused(true));
  after(() => settings.setNewWorkPaused(false));

  it("is refused by name when the fleet's pick-up names it anyway", () => {
    const kept = run("aside-kept", "stopped");
    const aside = run("aside-refused", "stopped");
    assert.equal(orch.setRunAside(aside, true).ok, true);

    const report = fleet.reopenFleet([kept, aside], { maxIterations: 3 });

    assert.deepEqual(report.reopened, [kept]);
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0].id, aside);
    assert.match(report.refused[0].reason, /set aside/i);
    // The whole point of the mark: it changes what a list acts on and nothing
    // about the run, so the row still says exactly how it ended.
    assert.equal(statusOf(aside), "stopped");
    assert.equal(statusOf(kept), "queued");
  });

  it("leaves the restart notice, and rejoins it when it is put back", () => {
    const id = run("aside-restart", "failed");
    dbMod.db().prepare("UPDATE runs SET restart_closed = 1 WHERE id = ?").run(id);
    const listed = () => orch.restartClosedRuns().some((r) => r.id === id);
    assert.equal(listed(), true);

    orch.setRunAside(id, true);
    assert.equal(listed(), false, "a run set aside is no longer outstanding");
    assert.equal(
      orch.reopenRestartClosed().reopened,
      0,
      "and the press that reads that list must start nothing",
    );
    assert.equal(statusOf(id), "failed");

    // Filtered rather than cleared at the door: the restart is still holding
    // this run up, so putting it back has to restore the count as well.
    orch.setRunAside(id, false);
    assert.equal(listed(), true);
    assert.equal(orch.getRun(id)!.restart_closed, 1);
  });

  it("is cleared by picking that one run up", () => {
    const id = run("aside-cleared", "stopped");
    orch.setRunAside(id, true);

    assert.equal(orch.reopenRun(id, { maxIterations: 3 }).ok, true);

    assert.equal(
      orch.getRun(id)!.set_aside_at,
      null,
      "a run picked up by hand is not still held back from the next bulk press",
    );
  });
});
