import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
// Type-only, so it is erased rather than hoisted above the environment set up
// in `before` — the reason every other import in this file is dynamic.
import type { CeilingCut } from "./contextPruning";
import type { Interrupt } from "./orchestrator";

/**
 * The ceiling tick's two silences: a cycle ended while it was deciding, and a
 * crossing it decided *not* to act on.
 *
 * Both are absences, which is why they share a file: what is pinned in each case
 * is that something is missing that should be — an interrupt that must not be
 * written, and a row that must.
 *
 * `checkContextCeilings` reads `interrupts` at the top of its loop and then
 * awaits twice — a transcript resolution, and `ceilingCut`, which is a winnow
 * subprocess bounded by `PRUNE_TIMEOUT_MS` at two minutes. Everything it does
 * after those awaits is about a cycle it believes is still running, and the
 * window is wide enough that a cycle ending inside it is ordinary rather than a
 * race anyone has to arrange.
 *
 * All three ways it goes wrong are silent, and which one happens depends only
 * on where `startRun` had got to: the post-cycle checkpoint refunds a work cycle
 * that actually completed and skips the `DONE`, refusal and exit-code tests, so
 * a finished run silently buys another billed cycle; past that checkpoint the
 * entry survives to the next pass, where `interruptOutcome` — which has no
 * `prune` case, deliberately — files a healthy run as `stopped`; and past
 * `startRun`'s outer `finally` the entry is left in a process-lifetime map that
 * only two lines ever delete, so the next Resume of that run settles `stopped`
 * having spawned nothing.
 *
 * So what is pinned is the absence of a write, which is why the control below is
 * half the test: a case that never reached the interrupt site at all would pass
 * the first assertion for the wrong reason and go on passing it for ever.
 *
 * It is its own file for `cycleDeadline.test.ts`'s reason — `DATA_DIR` and
 * `CLAUDE_HOME` are read into `config.ts` at load, and this needs a projects
 * tree of its own for `resolveSessionTranscript` to walk — and one of its own:
 * it replaces `ceilingCut` on the module `orchestrator.ts` calls it through,
 * which is `shutdown.test.ts`'s device and not something to leave standing in a
 * file other cases share.
 */

/** Over `CYCLE_CONTEXT_CEILING_TOKENS`, which is 200,000. */
const OVER_CEILING = 210_000;

/**
 * A cut big enough that `ceilingPayback` cannot refuse it.
 *
 * The gate under test is the interrupt map, not the payback arithmetic — that is
 * `contextPruning.test.ts`'s — so this is deliberately far past the horizon in
 * the *acting* direction. A measurement that declined would leave the interrupt
 * site unreached and both cases below vacuously green.
 */
const HUGE_CUT: CeilingCut = {
  engine: "legacy",
  removedTokens: OVER_CEILING,
};

/**
 * A cut small enough that `ceilingPayback` must refuse it.
 *
 * The mirror of `HUGE_CUT` and for the same reason: the decline cases below are
 * about what gets *written down* when the gate refuses, so a measurement the
 * gate would admit leaves them asserting nothing. 10k out of a 210k conversation
 * prices at 400 turns against a horizon of 20, far enough past it that a change
 * to the constant cannot quietly make these cases stop testing a decline.
 */
const TINY_CUT: CeilingCut = {
  engine: "legacy",
  removedTokens: 10_000,
};

/** Every decision row this install has written for one run, oldest first. */
function decisions(runId: string): Array<{
  trigger: string;
  engine: string;
  outcome: string;
  detail: string | null;
  predicted_turns: number | null;
}> {
  return dbMod
    .db()
    .prepare(
      `SELECT trigger, engine, outcome, detail, predicted_turns
         FROM prune_decisions WHERE run_id = ? ORDER BY id`,
    )
    .all(runId) as Array<{
    trigger: string;
    engine: string;
    outcome: string;
    detail: string | null;
    predicted_turns: number | null;
  }>;
}

/**
 * Push a run's context up by `by` tokens, so the growth gate admits a second
 * measurement.
 *
 * `CEILING_REMEASURE_GROWTH_TOKENS` paces the tick at 25,000, and a second tick
 * on an unchanged transcript is skipped before it reaches either await — so a
 * case about the *cadence* of the rows has to move the conversation, not just
 * call the tick twice.
 */
function grow(runId: string, by: number): void {
  const seqNo = Number(runId.split("-")[1]);
  const session = `00000000-0000-4000-8000-00000000000${seqNo}`;
  const project = path.join(root, "claude", "projects", `proj-${seqNo}`);
  fs.appendFileSync(
    path.join(project, `${session}.jsonl`),
    "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          id: `m${seqNo}-grown`,
          role: "assistant",
          model: "claude-opus-5",
          content: "hi",
          usage: {
            input_tokens: 1_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: OVER_CEILING - 1_000 + by,
            output_tokens: 5,
          },
        },
      }),
  );
}

let root: string;
let orchestrator: typeof import("./orchestrator");
let pruningMod: typeof import("./contextPruning");
let dbMod: typeof import("./db");
let realCeilingCut: typeof import("./contextPruning").ceilingCut;
let realPruningEnabled: typeof import("./contextPruning").pruningEnabled;
let seq = 0;

/** The maps `startRun` writes, read from the singletons the tick reads. */
function interrupts(): Map<string, Interrupt> {
  return (globalThis as unknown as { __ufInterrupts: Map<string, Interrupt> })
    .__ufInterrupts;
}

function contextWatches(): Map<
  string,
  { sessionId: () => string | null; iteration: () => number }
> {
  return (
    globalThis as unknown as {
      __ufContextWatches2: Map<
        string,
        { sessionId: () => string | null; iteration: () => number }
      >;
    }
  ).__ufContextWatches2;
}

/**
 * One run, its session and its transcript, as a cycle in flight leaves them.
 *
 * A fresh id per case because `ceilingMeasuredAt` paces re-measurement by growth
 * and is keyed by run: a second case on the same id would be skipped before it
 * reached either await, and would pass without testing anything.
 */
function liveCycle(): string {
  const id = `ceiling-${++seq}`;
  const session = `00000000-0000-4000-8000-00000000000${seq}`;
  const project = path.join(root, "claude", "projects", `proj-${seq}`);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, `${session}.jsonl`),
    JSON.stringify({
      type: "assistant",
      message: {
        id: `m${seq}`,
        role: "assistant",
        model: "claude-opus-5",
        content: "hi",
        usage: {
          input_tokens: 1_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: OVER_CEILING - 1_000,
          output_tokens: 5,
        },
      },
    }),
  );

  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                         iterations, created_at)
       VALUES (?, ?, 'work', 'running', '{"maxIterations":4}', 4, 1, ?)`,
    )
    .run(id, path.join(root, "workspace"), Date.now() + seq);

  contextWatches().set(id, { sessionId: () => session, iteration: () => 1 });
  return id;
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-ceiling-race-")));
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });

  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // Pinned rather than left to fall back to CLAUDE_HOME, `cycleDeadline.test.ts`'s
  // rule: an ambient one puts a real OAuth token within reach of anything here
  // that reads plan usage.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  delete process.env.WORKSPACE_ROOTS;
  // A path that does not exist, so a regression that reached a spawn is a failed
  // test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  dbMod = await import("./db");
  pruningMod = await import("./contextPruning");
  orchestrator = await import("./orchestrator");

  realCeilingCut = pruningMod.ceilingCut;
  realPruningEnabled = pruningMod.pruningEnabled;
  // The acting half is gated on the feature, and both cases are about acting.
  // Stubbed rather than switched on through `saveSettings`, because
  // `pruningEnabled` is also `winnowAvailable`, which stats a hard-coded
  // `/opt/winnow` — a property of the container rather than of the code under
  // test, and one that would make this file pass or fail on where it ran.
  patch("pruningEnabled", () => true);
});

after(() => {
  patch("ceilingCut", realCeilingCut);
  patch("pruningEnabled", realPruningEnabled);
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Stand in for one of `contextPruning`'s exports.
 *
 * Replaced on the module object rather than injected, `shutdown.test.ts`'s
 * device for `child_process`: the call site is the subject, `orchestrator.ts`
 * reaches these through its own import, and a seam it does not have would pin
 * the test's wiring instead of the tick's.
 */
function patch<K extends "ceilingCut" | "pruningEnabled">(
  name: K,
  fn: (typeof import("./contextPruning"))[K],
): void {
  (pruningMod as unknown as Record<K, unknown>)[name] = fn;
}

describe("the context ceiling against a cycle that ends while it is deciding", () => {
  it("writes no interrupt for a run that left contextWatches during the measurement", async () => {
    const id = liveCycle();
    let planned = false;

    // Exactly the ordering the two-minute window makes ordinary: the child
    // exits and `startRun`'s inner `finally` clears the watch while winnow is
    // still parsing the transcript this tick handed it.
    patch("ceilingCut", async () => {
      planned = true;
      contextWatches().delete(id);
      return HUGE_CUT;
    });

    await orchestrator.checkContextCeilings();

    assert.ok(planned, "the tick never got as far as measuring a cut, so this proves nothing");
    assert.equal(
      interrupts().get(id),
      undefined,
      "a prune written after the cycle ended refunds a work cycle that completed, " +
        "or files a healthy run stopped, or leaks an entry no deleter reaches",
    );
  });

  it("still ends a cycle that is genuinely over the ceiling", async () => {
    const id = liveCycle();

    patch("ceilingCut", async () => HUGE_CUT);

    await orchestrator.checkContextCeilings();

    const recorded = interrupts().get(id);
    assert.ok(recorded, "the ceiling stopped acting at all, which is the feature switched off");
    assert.equal(recorded.kind, "prune");
    assert.equal(recorded.pause, false, "a prune carries on rather than parking the run");
    assert.match(recorded.reason, /ended here to be pruned/);
  });
});

describe("the context ceiling's declines", () => {
  it("writes down a refusal, with the figure it was refused on", async () => {
    const id = liveCycle();
    patch("ceilingCut", async () => TINY_CUT);

    await orchestrator.checkContextCeilings();

    assert.equal(
      interrupts().get(id),
      undefined,
      "the gate acted on a cut it should have refused, so this proves nothing",
    );
    const [row, ...rest] = decisions(id);
    assert.ok(
      row,
      "the gate that takes 55 of 58 cuts on this install left no row: a run held " +
        "above the ceiling and an install with pruning switched off then read " +
        "identically once the run had settled",
    );
    assert.equal(rest.length, 0, "one admitted measurement is one row");
    assert.equal(row.outcome, "declined");
    assert.equal(row.trigger, "early-end");
    assert.equal(row.engine, "legacy", "the engine that measured, not the one configured");
    // The figure the decline was actually taken on, recomputed rather than
    // written out: a literal here would go on passing after a change to
    // `ceilingPayback` that made the row disagree with the decision above it.
    assert.equal(row.predicted_turns, pruningMod.ceilingPayback(OVER_CEILING, TINY_CUT));
  });

  it("does not file an install with no engine as an install whose arithmetic refused", async () => {
    const id = liveCycle();
    // What `ceilingCut` returns when winnow is absent and when its subprocess
    // failed — it collapses both, so "unavailable" is as far as this can honestly
    // go. What it must not be is "declined": an operator reading that goes
    // looking for a horizon to move, on an install that never measured anything.
    patch("ceilingCut", async () => null);

    await orchestrator.checkContextCeilings();

    const [row] = decisions(id);
    assert.ok(row, "a crossing nobody could measure left no trace at all");
    assert.equal(row.outcome, "unavailable");
    assert.equal(
      row.predicted_turns,
      null,
      "there was no measurement, so there is no figure to carry",
    );
    assert.ok(row.detail, "an outcome an operator cannot act on needs the reason beside it");
  });

  it("writes one row per measurement the growth gate admits, not one per run", async () => {
    const id = liveCycle();
    patch("ceilingCut", async () => TINY_CUT);

    await orchestrator.checkContextCeilings();
    // Unchanged conversation: the growth gate skips this one before either
    // await, so it must add nothing.
    await orchestrator.checkContextCeilings();
    assert.equal(decisions(id).length, 1, "a tick that measured nothing wrote a row anyway");

    grow(id, 30_000);
    await orchestrator.checkContextCeilings();

    assert.equal(
      decisions(id).length,
      2,
      "the second decline was swallowed by `earlyEndDeclined`, which latches the " +
        "operator-facing line and must not latch the record — a run climbing from " +
        "200k to 300k is re-decided the whole way up",
    );
  });
});
