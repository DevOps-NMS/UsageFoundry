import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers *when* the workflow-wide budget is evaluated, which no pure test can.
 *
 * `evaluateInstanceBudget` is unit-tested beside `evaluateBudget` and answers
 * correctly about any figure it is handed. What was wrong was that it was never
 * handed a figure that had moved: every call site was "before something
 * spends", and for the ordinary block — `maxIterations: 1`, which is what
 * `normalizePolicy` answers when a template says nothing — that is one check,
 * against a total of zero, before the block's only cycle. The pass that would
 * have seen that cycle's cost is refused by `evaluateBudget` on `iterations`
 * and `break`s out *ahead* of the instance check. So a graph of single-cycle
 * blocks released together compared its limit with zero N times and never
 * again, and `maxInstanceCostUSD` could not fire at all.
 *
 * The database is the subject for `haltedMembers.test.ts`'s reason: the guard's
 * input is a SUM across three tables and its output is a status column, so
 * every way of getting this wrong typechecks, throws nothing, and looks exactly
 * like a workflow that came in under its limit. The only evidence is the bill.
 *
 * Its own file, and `DATA_DIR`/`CLAUDE_HOME` set before the first import, for
 * the reason `haltedMembers.test.ts` says: `config.ts` reads both at module
 * load and `workflows.ts` pulls it in statically, so a file that imported
 * either at the top would already be bound to the repository's own `.data`
 * directory — which on a developer's machine is the real one. `CLAUDE_HOME`
 * matters here in particular, because the check reads a real snapshot and a
 * transcript scan of somebody's actual `~/.claude` is not a fixture.
 */

let root: string;
let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-instance-budget-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  fs.mkdirSync(path.join(root, "claude"), { recursive: true });

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

/**
 * One press of Run: an instance carrying a budget, and its member runs.
 *
 * Inserted rather than built through `startWorkflow`, because what is under
 * test is when a SUM is compared against a limit — going through the real
 * creation path would drag in a mount, a git probe and, through
 * `promoteQueued`, a spawn.
 */
function instance(
  name: string,
  budget: Record<string, number>,
  members: Array<{ status: string; spent: number; est?: number }>,
): { instanceId: string; runIds: string[] } {
  const n = seq++;
  const instanceId = `inst-${n}`;
  const now = Date.now() + n;

  dbMod
    .db()
    .prepare(
      "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
    )
    .run(`wf-${n}`, name, now, now);
  dbMod
    .db()
    .prepare(
      `INSERT INTO workflow_instances
         (id, workflow_id, workflow_name, graph, created_at, status, instance_budget)
       VALUES (?, ?, ?, '{"nodes":[],"edges":[]}', ?, 'started', ?)`,
    )
    .run(instanceId, `wf-${n}`, name, now, JSON.stringify(budget));

  const insertRun = dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, work_dir, spent_usd, spent_usd_est)
       VALUES (?, ?, 'work', ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, 1, ?, NULL, ?, ?)`,
    );
  const insertMember = dbMod
    .db()
    .prepare(
      "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
        " VALUES (?, ?, ?, ?, ?)",
    );

  const runIds = members.map((m, i) => {
    const runId = `run-${n}-${i}`;
    insertRun.run(
      runId,
      path.join(root, "workspace"),
      m.status,
      now + i,
      m.spent,
      m.est ?? 0,
    );
    insertMember.run(instanceId, `node-${i}`, `Block ${i}`, i, runId);
    return runId;
  });

  return { instanceId, runIds };
}

function row(instanceId: string): { status: string; cause: string | null; reason: string | null } {
  return dbMod
    .db()
    .prepare(
      "SELECT status, stop_cause AS cause, stop_reason AS reason FROM workflow_instances WHERE id = ?",
    )
    .get(instanceId) as { status: string; cause: string | null; reason: string | null };
}

describe("the workflow-wide budget, once a member has spent", () => {
  it("halts the workflow when the members' combined spend passes the limit", async () => {
    // Three single-cycle blocks under a $50 workflow limit. Two have finished
    // at $30 each, so the instance is at $60 — and the third has not started.
    const { instanceId, runIds } = instance("Nightly sweep", { maxInstanceCostUSD: 50 }, [
      { status: "completed", spent: 30 },
      { status: "completed", spent: 30 },
      { status: "queued", spent: 0 },
    ]);

    assert.equal(row(instanceId).status, "started");

    const outcome = await workflows.enforceInstanceBudgetAfterMember(runIds[1]);
    assert.equal(outcome?.kind, "halted", "a member finishing over the limit halts it");
    assert.equal(outcome?.verdict.code, "instance_cost");

    const after = row(instanceId);
    assert.equal(after.status, "stopping", "the halt goes through stopInstance");
    assert.equal(after.cause, "guard", "and records that a guard was what did it");
    assert.match(after.reason ?? "", /\$60\.00/, "the reason names what was spent");
    assert.match(after.reason ?? "", /\$50\.00/, "and the limit it reached");

    // The member that had not started is taken down with the rest, which is
    // the whole point of routing through `stopInstance` rather than deciding
    // membership again here.
    const third = dbMod
      .db()
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(runIds[2]) as { status: string };
    assert.equal(third.status, "stopped");
  });

  it("leaves a workflow under its limit alone", async () => {
    const { instanceId, runIds } = instance("Under", { maxInstanceCostUSD: 50 }, [
      { status: "completed", spent: 10 },
      { status: "running", spent: 5 },
    ]);

    const outcome = await workflows.enforceInstanceBudgetAfterMember(runIds[0]);
    assert.equal(outcome, null);
    assert.equal(row(instanceId).status, "started");
  });

  /**
   * The reproduction, in one test: the check that already existed sees zero for
   * every member of a graph released together, and only the post-spend check
   * has anything to compare.
   */
  it("is the only boundary a graph of single-cycle blocks ever reaches", async () => {
    const { instanceId, runIds } = instance("Fan out", { maxInstanceCostUSD: 50 }, [
      { status: "queued", spent: 0 },
      { status: "queued", spent: 0 },
    ]);

    // Every member's pre-cycle check, at the instant `promoteQueued` starts
    // them all: nothing has been spent, so all of them pass. This is exactly
    // what the guard used to see, N times, and then never again.
    const snapshot = await (await import("./orchestrator")).currentSnapshot();
    for (const runId of runIds) {
      assert.equal(
        workflows.enforceInstanceBudget(runId, snapshot),
        null,
        "a member about to start its only cycle sees an instance that has spent nothing",
      );
    }
    assert.equal(row(instanceId).status, "started");

    // The first block's cycle lands. Under the old shape there was no call
    // site that read this figure, so the limit stayed uncompared for ever.
    dbMod
      .db()
      .prepare("UPDATE runs SET status='completed', spent_usd=55 WHERE id=?")
      .run(runIds[0]);

    const outcome = await workflows.enforceInstanceBudgetAfterMember(runIds[0]);
    assert.equal(outcome?.kind, "halted");
    assert.equal(row(instanceId).status, "stopping");
  });

  it("counts a killed cycle's estimate, which never reaches spent_usd", async () => {
    // The guard's figure is `spent_usd + spent_usd_est`, so a workflow whose
    // blocks were all killed mid-cycle must not read as having spent nothing.
    // `instanceSpend` decides that, and this is what says the post-spend check
    // reads it rather than the measured floor.
    const { instanceId, runIds } = instance("Killed", { maxInstanceCostUSD: 20 }, [
      { status: "stopped", spent: 0, est: 25 },
      { status: "queued", spent: 0 },
    ]);

    const outcome = await workflows.enforceInstanceBudgetAfterMember(runIds[0]);
    assert.equal(outcome?.kind, "halted");
    assert.equal(outcome?.verdict.code, "instance_cost");
    assert.equal(row(instanceId).status, "stopping");
    // The measured floor alone is $0, which would have allowed it for ever.
    assert.match(row(instanceId).reason ?? "", /\$25\.00/);
  });

  it("says nothing about a run that is not a member, or an instance with no budget", async () => {
    // One indexed lookup and out, which is what makes this affordable in
    // `startRun`'s `finally` for every run in an install with no workflows.
    const { runIds } = instance("No budget", {}, [{ status: "completed", spent: 999 }]);
    assert.equal(await workflows.enforceInstanceBudgetAfterMember(runIds[0]), null);
    assert.equal(await workflows.enforceInstanceBudgetAfterMember("no-such-run"), null);
  });

  it("does not halt an instance that is already stopping", async () => {
    // `guardInstance` tests `started` and this asks again before paying for a
    // snapshot: a second halt would run a second kill ladder over children that
    // are already dying.
    const { instanceId, runIds } = instance("Already stopping", { maxInstanceCostUSD: 1 }, [
      { status: "completed", spent: 99 },
    ]);
    dbMod
      .db()
      .prepare("UPDATE workflow_instances SET status='stopping' WHERE id=?")
      .run(instanceId);

    assert.equal(await workflows.enforceInstanceBudgetAfterMember(runIds[0]), null);
    assert.equal(row(instanceId).cause, null, "nothing was recorded over the halt");
  });
});
