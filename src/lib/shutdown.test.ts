import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * What a `docker compose restart` does to the work cycles it interrupts.
 *
 * The handler was synchronous end to end — `killAllAgents(sig)`,
 * `releaseDataDir()`, `process.exit(0)` — so not one suspended `startRun` frame
 * ever resumed and nothing after `await runIteration(...)` ran. Three things
 * went with it every time, and each already had a mechanism written for it:
 * `reconcileKilledCycle` recovered the cycle's spend and was reachable only
 * from inside that loop, `active_iteration`/`active_started_at` were cleared in
 * the same place, and the run's own account of why it ended was left for the
 * next boot to guess at. On twenty-five runs that is twenty-five cycles of real
 * billed tokens missing from `spent_usd_est` — invisible afterwards to
 * `RunProgress.spentGuardUSD`, to `maxRunCostUSD` and to the instance budget,
 * so a run picked up later can overshoot its own cost limit by a whole cycle.
 *
 * What this pins is that the shutdown path **awaits** the accounting, which no
 * test of `reconcileKilledCycle` itself could say: the function was always
 * correct and always unreachable. So it drives a real run to `running` against
 * a stubbed child, calls the real `shutdownRuns`, and reads the row.
 *
 * Its own file with the environment set before anything is required, for the
 * reason every database-backed test here needs it: `config.ts` fixes `DATA_DIR`
 * and `CLAUDE_HOME` at module load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-shutdown-")));
const projects = path.join(tmp, "claude", "projects", "workspace-project");
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const {
  createRun,
  getRun,
  reconcileInterruptedCycles,
  reconcileOnBoot,
  runEvents,
  shutdownRuns,
} =
  require("./orchestrator") as typeof import("./orchestrator");
const { db } = require("./db") as typeof import("./db");

const SESSION = "11111111-2222-3333-4444-555555555555";

/**
 * The transcript the killed cycle leaves behind.
 *
 * This is what `reconcileKilledCycle` reads, through the same pipeline the
 * dashboard uses — same dedupe key, same price table. Written *after* the cycle
 * has been stamped on the row, because the estimate is bounded by session id
 * **and** by the cycle's own start instant: a resumed session copies earlier
 * turns forward carrying their original timestamps, so a record written before
 * the spawn is one this deliberately does not count.
 */
function appendTranscript(messageId: string, requestId: string): void {
  const record = {
    type: "assistant",
    cwd: path.join(tmp, "workspace", "project"),
    sessionId: SESSION,
    requestId,
    timestamp: new Date().toISOString(),
    message: {
      id: messageId,
      model: "claude-sonnet-4-5-20250929",
      usage: {
        input_tokens: 40_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 100_000,
      },
    },
  };
  fs.appendFileSync(
    path.join(projects, "session.jsonl"),
    `${JSON.stringify(record)}\n`,
  );
}

/**
 * A child that stays alive until it is signalled.
 *
 * The point of the fixture: `runIteration` must still be suspended when
 * `shutdownRuns` is called, which is the state the whole defect lives in. It
 * names a session on stdout because that is how `adoptSession` learns it — and
 * the session id is what bounds the estimate — and it never emits `result`,
 * which is what makes this a killed cycle rather than a finished one.
 */
const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;
let spawned = 0;

childProcess.spawn = () => {
  spawned += 1;
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` skips `process.kill(-pid)` — which would either
    // throw ESRCH or, far worse in a test runner, signal a real process group.
    pid: undefined as number | undefined,
    kill(sig: string) {
      setImmediate(() => {
        stdout.end();
        child.emit("exit", null, sig);
        child.emit("close", null, sig);
      });
      return true;
    },
  });
  stdout.write(`${JSON.stringify({ type: "system", session_id: SESSION })}\n`);
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Let the run loop reach the point where it is suspended on its child. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

describe("shutting down with a work cycle in flight", () => {
  it("reconciles the killed cycle before it exits, and clears the columns", async () => {
    const run = createRun({
      folder: "project",
      mountId: null,
      prompt: "do the thing",
      // Two, so a loop that carried on rather than stopping would spawn again —
      // which is the other half of what the flag in `shutdownRuns` prevents.
      budget: { maxIterations: 2 },
    });

    await waitFor(
      () => getRun(run.id)?.active_started_at !== null,
      "the first work cycle to be stamped on the row",
    );
    appendTranscript("msg_shutdown_1", "req_shutdown_1");

    const before = getRun(run.id)!;
    assert.equal(before.status, "running");
    assert.equal(before.active_iteration, 1);
    assert.equal(before.session_id, SESSION, "the stream's session id must be on the row");
    assert.equal(before.spent_usd_est, 0, "nothing is reconciled while the cycle runs");

    const outcome = await shutdownRuns("SIGTERM");
    assert.equal(outcome.closed, 1, "the run must have been stopped by the shutdown");

    const settled = getRun(run.id)!;

    // The whole issue. Before this change the process exited here and every one
    // of these was left as it was.
    assert.ok(
      settled.spent_usd_est > 0,
      `the killed cycle's spend must be recovered, got ${settled.spent_usd_est}`,
    );
    assert.ok(settled.spent_tokens_est > 0);
    assert.equal(settled.active_iteration, null, "no cycle is in flight after a shutdown");
    assert.equal(settled.active_started_at, null);

    // And the run says what happened to it, rather than being left `running`
    // for the next boot to call a restart — or, worse, settled by the exit-code
    // test as `Claude Code exited with code -1`.
    assert.equal(settled.status, "stopped");
    assert.match(settled.stop_reason ?? "", /server shut down/);
    assert.equal(
      settled.restart_closed,
      1,
      "it has to be findable as one the restart closed out",
    );

    // One child, not two: the second work cycle its budget allowed must not
    // have been spawned on the way out of the door.
    assert.equal(spawned, 1);

    // And the row says the figure is an estimate. A recovered total presented
    // as measured spend is the one thing worse than a missing one, which is why
    // it lives in its own column and its own sentence.
    assert.match(settled.stop_reason ?? "", /reconciled from transcripts/);
  });

  it("mops up a cycle whose loop never got to finish", async () => {
    // The grace is a ceiling, not a promise: a loop still inside
    // `reconcileKilledCycle`'s own transcript scan when it expires leaves the
    // row exactly as the old synchronous exit did. `reconcileInterruptedCycles`
    // is the belt, and this is the row it is for — one claiming an open cycle
    // with nothing coming to settle it.
    const startedAt = Date.now();
    appendTranscript("msg_orphan", "req_orphan");

    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, model, status, budget, max_iterations," +
          " iterations, created_at, spent_usd, spent_tokens, session_id," +
          " active_iteration, active_started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "orphaned-cycle",
        path.join(tmp, "workspace", "project"),
        "task",
        null,
        "running",
        "{}",
        1,
        0,
        startedAt,
        0,
        0,
        SESSION,
        2,
        startedAt,
      );

    const recovered = await reconcileInterruptedCycles();
    assert.equal(recovered, 1);

    const row = getRun("orphaned-cycle")!;
    assert.ok(row.spent_usd_est > 0);
    assert.equal(row.active_iteration, null);
    assert.equal(row.active_started_at, null);

    // Said in the run's own log, because a run whose spend is understated and a
    // run that spent nothing look identical everywhere else in this app.
    const said = runEvents("orphaned-cycle").events.map((e) =>
      JSON.stringify(e.payload),
    );
    assert.ok(
      said.some((t) => /reconciled from this session's transcripts/.test(t)),
      "the recovery has to be visible in the run's log",
    );

    // Idempotent by construction: the guarded UPDATE means a second pass — or
    // the loop's own write landing late — cannot charge the cycle twice.
    const before = row.spent_usd_est;
    assert.equal(await reconcileInterruptedCycles(), 0);
    assert.equal(getRun("orphaned-cycle")!.spent_usd_est, before);
  });

  it("leaves no run claiming an open cycle after a boot reconcile", () => {
    // The other half of the same criterion, for the endings the shutdown handler
    // never reaches — a SIGKILL, an OOM, a host that lost power. Nothing else
    // clears these columns, and `instanceSpend` reads `active_started_at` for a
    // `running` member.
    db()
      .prepare(
        "UPDATE runs SET status='running', active_iteration=3, active_started_at=? WHERE id=?",
      )
      .run(Date.now() - 60_000, "no-such-run");
    const crashed = db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, model, status, budget, max_iterations," +
          " iterations, created_at, spent_usd, spent_tokens, active_iteration," +
          " active_started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "crashed-mid-cycle",
        path.join(tmp, "workspace", "project"),
        "task",
        null,
        "running",
        "{}",
        1,
        0,
        Date.now(),
        0,
        0,
        3,
        Date.now() - 60_000,
      );
    assert.equal(crashed.changes, 1);

    reconcileOnBoot();

    const row = getRun("crashed-mid-cycle")!;
    assert.equal(row.active_iteration, null);
    assert.equal(row.active_started_at, null);
    assert.equal(row.status, "failed");
    assert.equal(row.restart_closed, 1);
  });
});
