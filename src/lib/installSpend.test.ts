import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers what the install-wide ceiling is *measured from*, which the pure
 * verdict beside it cannot.
 *
 * `evaluateInstallBudget` answers correctly about any pair of figures it is
 * handed. What is easy to get wrong — and silent, because the result is a
 * plausible dollar amount either way — is the reading: a SUM across three
 * tables, each bounded on a different column, with a fourth contribution
 * arriving through `telemetrySpendSince` for cycles that have reported nothing.
 * A window bound applied to the wrong column, or a table left out, produces a
 * ceiling that is quietly larger than the one the operator typed.
 *
 * Its own file, and `DATA_DIR`/`CLAUDE_HOME` set before the first import, for
 * `haltedMembers.test.ts`' reason: `config.ts` reads both at module load. It is
 * separate from `instanceBudget.test.ts` for a further reason of its own — this
 * reading covers *every* run row in the database, so that file's fixtures would
 * be inside its window and it would be inside theirs.
 */

let root: string;
let installBudget: typeof import("./installBudget");
let settings: typeof import("./settings");
let dbMod: typeof import("./db");

const HOUR = 3_600_000;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-install-spend-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  // The mount has to exist on disk before `config.ts` is loaded: the one door
  // case below goes through `createRun`, which resolves and contains the folder
  // before anything else it does.
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(root, "claude"), { recursive: true });

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  installBudget = await import("./installBudget");
  settings = await import("./settings");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

function addRun(o: {
  id: string;
  status: string;
  spent: number;
  est?: number;
  finishedAt: number | null;
  activeStartedAt?: number | null;
}): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, spent_usd, spent_usd_est, active_started_at)
       VALUES (?, ?, 'work', ?, '{"maxIterations":1}', 1, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      path.join(root, "workspace"),
      o.status,
      NOW - 48 * HOUR,
      o.finishedAt,
      o.spent,
      o.est ?? 0,
      o.activeStartedAt ?? null,
    );
}

function clearAll(): void {
  for (const table of [
    "otlp_requests",
    "runs",
    "workflow_instance_blocks",
    "workflow_instances",
    "workflows",
    "chat_sessions",
  ]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
}

describe("what the install-wide ceiling is measured from", () => {
  it("counts runs, workflow blocks and chat turns, and only inside the window", () => {
    clearAll();

    // Inside: finished an hour ago, and still going.
    addRun({ id: "recent", status: "completed", spent: 10, finishedAt: NOW - HOUR });
    addRun({ id: "live", status: "running", spent: 4, finishedAt: null });
    // Outside: finished 30 hours ago. A ceiling that counted this would be a
    // ceiling on all of history wearing a 24-hour label.
    addRun({ id: "old", status: "completed", spent: 500, finishedAt: NOW - 30 * HOUR });

    // A deciding block's turn, and a chat turn — both money this app spent that
    // no run row records, and the chat is the one spender that passes through
    // no `evaluateBudget` at all.
    dbMod
      .db()
      .prepare(
        "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES ('w1', 'wf', '{}', ?, ?)",
      )
      .run(NOW - 2 * HOUR, NOW - 2 * HOUR);
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
         VALUES ('i1', 'w1', 'wf', '{}', ?, 'started')`,
      )
      .run(NOW - 2 * HOUR);
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instance_blocks
           (instance_id, node_id, node_name, position, kind, status, finished_at, cost_usd)
         VALUES ('i1', 'n1', 'Decide', 0, 'orchestrator', 'emitted', ?, 3)`,
      )
      .run(NOW - HOUR);
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instance_blocks
           (instance_id, node_id, node_name, position, kind, status, finished_at, cost_usd)
         VALUES ('i1', 'n2', 'Older', 1, 'orchestrator', 'emitted', ?, 700)`,
      )
      .run(NOW - 30 * HOUR);
    dbMod
      .db()
      .prepare(
        "INSERT INTO chat_sessions (id, created_at, updated_at, cost_usd) VALUES ('c1', ?, ?, 2)",
      )
      .run(NOW - 3 * HOUR, NOW - HOUR);
    dbMod
      .db()
      .prepare(
        "INSERT INTO chat_sessions (id, created_at, updated_at, cost_usd) VALUES ('c2', ?, ?, 900)",
      )
      .run(NOW - 50 * HOUR, NOW - 40 * HOUR);

    const spend = installBudget.installSpend(NOW);
    assert.equal(spend.spentUSD, 10 + 4 + 3 + 2, "one run row, one block, one chat");
    assert.equal(spend.spentGuardUSD, spend.spentUSD, "nothing killed, nothing in flight");
  });

  it("splits the measured floor from what the guard acts on", () => {
    clearAll();

    // A killed cycle's estimate never reaches `spent_usd`, and a cycle in
    // flight has reported nothing at all. An install guarding on the measured
    // figure alone would read far under its own total for exactly as long as
    // agents are working, which is when the ceiling matters.
    addRun({
      id: "killed",
      status: "stopped",
      spent: 5,
      est: 20,
      finishedAt: NOW - HOUR,
    });
    addRun({
      id: "inflight",
      status: "running",
      spent: 0,
      finishedAt: null,
      activeStartedAt: NOW - 10 * 60_000,
    });
    dbMod
      .db()
      .prepare(
        `INSERT INTO otlp_requests (request_id, ts, run_id, model, cost_usd,
                                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
         VALUES ('r1', ?, 'inflight', 'claude-opus-5', 7, 0, 0, 0, 0)`,
      )
      .run(NOW - 5 * 60_000);

    const spend = installBudget.installSpend(NOW);
    assert.equal(spend.spentUSD, 5, "the floor is what a CLI itself reported");
    assert.equal(spend.spentGuardUSD, 5 + 20 + 7, "the guard sees the estimate and the live cycle");
  });

  it("ignores telemetry attributed to a run that is not running", () => {
    clearAll();
    // Nothing clears `active_started_at` when the container dies mid-cycle, so
    // a terminal row can still name a cycle that ended hours ago —
    // `instanceSpend` bounds it the same way and `fmtCycleInFlight` refuses the
    // column for the same reason.
    addRun({
      id: "dead",
      status: "failed",
      spent: 1,
      finishedAt: NOW - HOUR,
      activeStartedAt: NOW - 2 * HOUR,
    });
    dbMod
      .db()
      .prepare(
        `INSERT INTO otlp_requests (request_id, ts, run_id, model, cost_usd,
                                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
         VALUES ('r2', ?, 'dead', 'claude-opus-5', 99, 0, 0, 0, 0)`,
      )
      .run(NOW - 90 * 60_000);

    assert.equal(installBudget.installSpend(NOW).spentGuardUSD, 1);
  });

  it("refuses only once the ceiling is configured and reached", () => {
    clearAll();
    addRun({ id: "big", status: "completed", spent: 60, finishedAt: NOW - HOUR });

    // Off is the shipped default, and off means no refusal however much has
    // been spent — this app has never had a limit it invented for the operator.
    settings.saveSettings({ installDailyCostLimitUSD: null });
    assert.equal(installBudget.installBudgetRefusal(NOW), null);
    assert.equal(installBudget.installSpendReport(NOW).limitUSD, null);

    settings.saveSettings({ installDailyCostLimitUSD: 100 });
    assert.equal(installBudget.installBudgetRefusal(NOW), null);

    settings.saveSettings({ installDailyCostLimitUSD: 50 });
    const refusal = installBudget.installBudgetRefusal(NOW);
    assert.match(refusal ?? "", /\$60\.00/);
    assert.match(refusal ?? "", /\$50\.00 limit set in Settings/);

    const report = installBudget.installSpendReport(NOW);
    assert.equal(report.limitUSD, 50);
    assert.equal(report.spentUSD, 60);
    assert.equal(report.windowHours, 24);

    settings.saveSettings({ installDailyCostLimitUSD: null });
  });

  it("refuses a new run at the one door every run in this app comes through", async () => {
    clearAll();
    addRun({ id: "spent", status: "completed", spent: 80, finishedAt: NOW - HOUR });
    settings.saveSettings({ installDailyCostLimitUSD: 50 });

    // `createRun` rather than the route, because the chat's approval batch, a
    // workflow's pass and an orchestrator block's emission all arrive here too
    // — a check in the HTTP handler would cover one of the four.
    const orch = await import("./orchestrator");
    assert.throws(
      () =>
        orch.createRun({
          folder: "",
          mountId: null,
          prompt: "do something expensive",
          budget: { maxIterations: 1 },
          origin: "form",
        }),
      /limit set in Settings/,
      "refused rather than queued: a queued run is a promise to spend",
    );

    settings.saveSettings({ installDailyCostLimitUSD: null });
  });
});
