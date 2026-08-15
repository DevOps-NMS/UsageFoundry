import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
// Erased at compile time, so it cannot load the module before the environment
// below is set — which is the whole reason every other import here is dynamic.
import type { Interrupt } from "./orchestrator";

/**
 * Covers one thing: that a work cycle whose child stops producing output is
 * ended by this process rather than held until the container is restarted.
 *
 * It earns its place on the same grounds as `chat.ts`'s `settleOnExit` case,
 * and for a stronger version of that reason: the fault *is* the child.
 * `runIteration` registers `exit` and `close` and settles on nothing else, so a
 * `claude` wedged on a socket read leaves its promise pending for the life of
 * the process — every run row, folder claim, checkout slot and concurrency slot
 * it holds with it. A stubbed emitter standing in for the child would pin the
 * wiring to whatever it was written against rather than to what a real process
 * does, so what this drives is a real child that prints nothing and does not
 * exit, and what it asserts is that the promise settles at all.
 *
 * The bound is the test's own `timeout`. Without one the only failure available
 * here is "this test never returns", which is not a failure anything reports.
 *
 * It is its own file for `chatTurn.test.ts`'s reason and one of its own.
 * `DATA_DIR` and `CLAUDE_HOME` are read into `config.ts` at load, so they have
 * to be set before anything requires it — and this is the one file in the suite
 * that points `CLAUDE_BIN` at a binary that exists. That is deliberate, and it
 * is why this cannot be a case in `orchestrator.test.ts`, which pins that
 * variable at a path that does not exist precisely so a regression reaching a
 * spawn is a failed test rather than a billed one. The binary here is
 * `process.execPath` — this same Node, running an inline script — so nothing in
 * this file can reach Anthropic or spend anything.
 *
 * The two pure halves of the same decision — `cycleSilenceMs`, which narrows
 * the configured value, and `interruptOutcome`, which decides what the run ends
 * as — are cases in `orchestrator.test.ts` beside every other pure function,
 * because only the harness is what separates these files.
 */

/** Long enough to be the deadline's decision, short enough to watch. */
const SILENCE_MS = 1_000;

/**
 * A child that prints nothing and stays alive, with its own way out.
 *
 * The self-exit is a backstop rather than part of the subject: it is far longer
 * than the deadline and than the kill ladder, so a cycle that reaches it has
 * failed the test — the assertion on `exitCode` is what says which of the two
 * ended it — and it is what stops a failing run from leaking a detached process
 * into whatever is running these tests.
 */
const HANGS = ["-e", "setTimeout(() => process.exit(9), 30000)"];

/**
 * A child that keeps printing over a span longer than the deadline, then exits
 * cleanly.
 *
 * The control, and the reason it is half the test: the deadline measures
 * *silence*, so a cycle that is still reporting has to survive one however long
 * it runs. A wall-clock deadline would satisfy every assertion in the first
 * case and kill this one.
 */
const CHATTY = [
  "-e",
  'const t = setInterval(() => process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n"), 100);' +
    "setTimeout(() => { clearInterval(t); process.exit(0); }, 2500);",
];

let orchestrator: typeof import("./orchestrator");
let db: typeof import("./db");
let root: string;
let workspace: string;
let seq = 0;

/** A row for the events to hang off — `run_events.run_id` has a foreign key. */
function insertRun(): string {
  const id = `deadline-${++seq}`;
  db.db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                         iterations, created_at)
       VALUES (?, ?, 'hang', 'running', '{"maxIterations":1}', 1, 0, ?)`,
    )
    .run(id, workspace, Date.now() + seq);
  return id;
}

/**
 * What the cycle recorded about why it is stopping.
 *
 * Read off the singleton because the interrupt is normally consumed by
 * `startRun`'s own post-cycle checkpoint, and this drives one cycle rather than
 * a whole run. It is the same map that checkpoint reads.
 */
function recordedInterrupt(id: string): Interrupt | undefined {
  return (globalThis as unknown as { __ufInterrupts?: Map<string, Interrupt> })
    .__ufInterrupts?.get(id);
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-cycle-deadline-")));
  workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // Pinned rather than left to fall back to CLAUDE_HOME, `orchestrator.test.ts`'s
  // rule: an ambient one puts a real OAuth token within reach of anything here
  // that reads plan usage.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  delete process.env.WORKSPACE_ROOTS;
  process.env.CLAUDE_BIN = process.execPath;

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  db = await import("./db");
  orchestrator = await import("./orchestrator");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

describe("a work cycle that stops producing output", () => {
  it("is ended by this process, and says so", { timeout: 20_000 }, async () => {
    const id = insertRun();

    const res = await orchestrator.runIteration(
      id,
      workspace,
      HANGS,
      false,
      SILENCE_MS,
      () => {},
    );

    // The child was signalled rather than left to find its own way out. 9 is
    // what the stub exits with when nothing touches it; a signalled process
    // reports no code at all, which `runIteration` records as -1.
    assert.notEqual(
      res.exitCode,
      9,
      "the cycle outlived its deadline and ended only because the stub gave up",
    );
    assert.equal(res.exitCode, -1, "a signalled child reports no exit code");

    const signal = recordedInterrupt(id);
    assert.ok(signal, "nothing was recorded, so the run loop cannot say why it ended");
    assert.equal(
      signal.kind,
      "deadline",
      "a deadline filed as an operator stop or a guard verdict reads as a run " +
        "somebody decided to end, which is the sentence that stops anyone looking",
    );
    assert.equal(signal.pause, false, "a hung cycle has nothing to wait for");
    assert.match(signal.reason, /No output from Claude Code/);

    // What the operator reads: `interruptRun` announces before it signals, so
    // the reason is in the log even when the child dies instantly.
    const said = orchestrator
      .runEvents(id)
      .events.filter((e) => e.kind === "log")
      .map((e) => String(e.payload.message ?? ""));
    assert.ok(
      said.some((m) => /No output from Claude Code/.test(m)),
      "the deadline must be in the run's own log, not only on the row",
    );

    // And the ending it produces, which is what the runs list shows.
    assert.equal(orchestrator.interruptOutcome(signal).status, "failed");
  });

  it("leaves a cycle that is still printing alone", { timeout: 20_000 }, async () => {
    const id = insertRun();

    const res = await orchestrator.runIteration(
      id,
      workspace,
      CHATTY,
      false,
      SILENCE_MS,
      () => {},
    );

    assert.equal(
      res.exitCode,
      0,
      "a cycle reporting every 100ms was killed at a 1s deadline, so the clock " +
        "is wall time rather than silence",
    );
    assert.equal(
      recordedInterrupt(id),
      undefined,
      "a working cycle must record no interrupt at all",
    );
  });
});
