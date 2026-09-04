import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * The context occupancy series — every one of whose failures is a graph that
 * draws, looks plausible, and is wrong.
 *
 * The reading itself is `apiContextTokens`, which `contextPruning.test.ts`
 * already pins. What is pinned here is everything built on top of it, and each
 * of the four has the same shape: nothing throws, nothing fails to typecheck,
 * and the only symptom is a line on a chart nobody can check against anything.
 *
 *  - **A sample below the ceiling is recorded.** The reading was already being
 *    taken on every live-guard tick and thrown away by `tokens < CEILING`, which
 *    discards every value a graph is made of. A regression that put the store
 *    back after that comparison would record only runs that were already over
 *    the ceiling — a series that exists, is never empty, and describes the
 *    minority of runs nobody needs a meter for.
 *  - **An unchanged frame writes nothing.** The ticker is time-based and one
 *    tool call routinely outlasts several ticks, so a row per tick makes the
 *    series mostly flat duplicates. That does not read as a bug; it reads as a
 *    run whose context was not growing, which is the opposite of what a meter
 *    exists to show.
 *  - **A sub-agent's turns are not this conversation's turns.** The exclusions
 *    are the ceiling's own and were carried over deliberately; dropping either
 *    inflates the turn axis on exactly the tool-heavy runs whose growth rate
 *    somebody is trying to read.
 *  - **A tick that writes nothing still records that it looked.** This is the
 *    same fact as the one above, read from the other end, and getting it wrong
 *    is the failure an operator actually reported: a run inside one sub-agent
 *    wrote no row for 22 minutes — every frame in that stretch was `isSidechain`
 *    and this measure excludes them — and the panel, which had only the newest
 *    row's timestamp to go on, said "read 22m ago" over a figure that was
 *    current the whole time. A dead poll and a conversation that is waiting look
 *    identical from one timestamp and call for opposite responses.
 *  - **Pruning being off does not switch the series off.** This is the trap the
 *    change was written against: sampling inside a function that returns early
 *    on `pruningEnabled()` leaves the indicator permanently blank on every
 *    install that has the feature switched off, install-dependent and silent.
 *    `sampleContext` therefore carries no gate at all — the gate lives one level
 *    up, in the orchestrator, over the *acting* half — and this file is where
 *    that decision is pinned rather than left to a comment.
 */

let root: string;
let transcripts: string;
let dbMod: typeof import("./db");
let pruningMod: typeof import("./contextPruning");
let settings: typeof import("./settings");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-ctx-samples-"));
  transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts, { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
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
  settings = await import("./settings");
});

after(() => {
  (globalThis as { __ufDb?: Database.Database }).__ufDb?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM context_samples").run();
  dbMod.db().prepare("DELETE FROM prune_receipts").run();
  // The other cut table, and it has to be swept for the same reason the first
  // does: a fork left behind by one case draws a mark on the next one's series.
  dbMod.db().prepare("DELETE FROM fork_attempts").run();
  // In memory rather than in a row, so it survives the two deletes above and
  // would otherwise carry one case's reading into the next.
  pruningMod.forgetContextCheck("r1");
  pruningMod.forgetContextCheck("r2");
});

/** One assistant record, as the CLI writes it. */
function turn(
  id: string,
  prompt: { input?: number; create?: number; read?: number; output?: number },
  extra: Record<string, unknown> = {},
): unknown {
  return {
    type: "assistant",
    message: {
      id,
      role: "assistant",
      model: "claude-opus-5",
      content: "hi",
      usage: {
        input_tokens: prompt.input ?? 0,
        cache_creation_input_tokens: prompt.create ?? 0,
        cache_read_input_tokens: prompt.read ?? 0,
        output_tokens: prompt.output ?? 0,
      },
    },
    ...extra,
  };
}

function transcript(name: string, lines: readonly unknown[]): string {
  const file = path.join(transcripts, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
}

function rows(runId = "r1"): Array<Record<string, unknown>> {
  return dbMod
    .db()
    .prepare("SELECT * FROM context_samples WHERE run_id = ? ORDER BY id")
    .all(runId) as Array<Record<string, unknown>>;
}

describe("sampleContext", () => {
  it("records a reading far below the ceiling, which is every reading a graph needs", () => {
    // 12,015 against a 200,000 ceiling. Before this, the tick computed exactly
    // this number and dropped it on the floor.
    const file = transcript("small.jsonl", [turn("m1", { input: 15, read: 12_000 })]);

    const reading = pruningMod.sampleContext("r1", 1, file);

    assert.equal(reading.tokens, 12_015);
    assert.ok(reading.tokens < pruningMod.CYCLE_CONTEXT_CEILING_TOKENS);
    const stored = rows();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].tokens, 12_015);
    assert.equal(stored[0].iteration, 1);
    assert.equal(stored[0].run_id, "r1");
    // The basis is on the row rather than implied. `prune_receipts` counts the
    // transcript's own turns and this counts what the API was billed for; the
    // two are tens of thousands of tokens apart in either direction, and a
    // series that did not say which it held could not be read against either.
    assert.equal(stored[0].basis, "api");
    assert.equal(stored[0].frame_id, "m1");
  });

  it("is still recorded with pruning switched off — the gate is over acting, not reading", () => {
    // The whole reason `pruningEnabled()` was moved out of the sampling path. An
    // operator with pruning off still has a context that fills up, and a meter
    // that is blank on their install and populated on somebody else's is the
    // worst of the three possible behaviours: it looks like the run is idle.
    settings.saveSettings({ contextPruning: false });
    assert.equal(pruningMod.pruningEnabled(), false, "the feature must really be off here");

    const file = transcript("pruning-off.jsonl", [turn("m1", { input: 20, read: 9_000 })]);
    pruningMod.sampleContext("r1", 2, file);

    assert.equal(rows().length, 1);
    assert.equal(rows()[0].tokens, 9_020);
  });

  it("writes nothing when the tick re-reads the same usage frame", () => {
    // A single tool call outlasts several ticks, so this is the ordinary case
    // rather than a race. Written per tick, the series would be mostly flat
    // duplicates and its slope — the one thing a context meter is read for —
    // would be wrong by however long the tool calls happened to be.
    const file = transcript("dupe.jsonl", [turn("m1", { input: 10, read: 5_000 })]);

    const first = pruningMod.sampleContext("r1", 1, file);
    const second = pruningMod.sampleContext("r1", 1, file);
    const third = pruningMod.sampleContext("r1", 1, file);

    assert.equal(rows().length, 1, "one frame, one row, however many ticks read it");
    // The reading itself is still returned every time — the ceiling upstream
    // reads it on every tick and must not be handed a zero.
    assert.equal(first.tokens, 5_010);
    assert.equal(second.tokens, 5_010);
    assert.equal(third.tokens, 5_010);
  });

  it("records that it looked even on the ticks that write no row", () => {
    // The 22-minute case: the same frame, read over and over. Without this the
    // only timestamp the panel has is the row's, and a run whose main thread is
    // inside one sub-agent is indistinguishable from a poll that has died.
    const file = transcript("looked.jsonl", [turn("m1", { input: 10, read: 5_000 })]);

    pruningMod.sampleContext("r1", 1, file);
    const afterFirst = pruningMod.lastContextCheck("r1");
    assert.ok(afterFirst, "the first read is recorded");
    assert.equal(afterFirst.basis, "api");

    const before = rows()[0].ts as number;
    pruningMod.sampleContext("r1", 1, file);
    assert.equal(rows().length, 1, "still one row — the frame did not move");
    const afterSecond = pruningMod.lastContextCheck("r1");
    assert.ok(afterSecond);
    assert.ok(
      afterSecond.ts >= before,
      "but the read is no older than the row it declined to write",
    );
  });

  it("records the look that failed as a failure, not as freshness", () => {
    // `unreadable` and "unchanged" are opposite statements. A read that found
    // nothing reported as a fresh reading is the one wording that leaves the
    // panel worse than absent.
    pruningMod.sampleContext("r1", 1, path.join(transcripts, "missing.jsonl"));

    const check = pruningMod.lastContextCheck("r1");
    assert.ok(check);
    assert.equal(check.basis, "unreadable");
    assert.equal(rows().length, 0, "and still nothing is written to the series");
  });

  it("keeps one run's reads out of another's", () => {
    const file = transcript("mine.jsonl", [turn("m1", { input: 10, read: 5_000 })]);
    pruningMod.sampleContext("r1", 1, file);

    assert.ok(pruningMod.lastContextCheck("r1"));
    assert.equal(pruningMod.lastContextCheck("r2"), null);
  });

  it("appends when the frame moves, and counts the turns between the two", () => {
    const file = transcript("grow.jsonl", [turn("m1", { input: 10, read: 5_000 })]);
    pruningMod.sampleContext("r1", 1, file);

    // Two further turns land before the next tick.
    fs.appendFileSync(
      file,
      "\n" +
        [turn("m2", { input: 10, read: 30_000 }), turn("m3", { input: 10, read: 60_000 })]
          .map((l) => JSON.stringify(l))
          .join("\n"),
    );
    pruningMod.sampleContext("r1", 1, file);

    const stored = rows();
    assert.equal(stored.length, 2);
    assert.equal(stored[1].tokens, 60_010);
    assert.equal(stored[1].frame_id, "m3");
    assert.equal(stored[0].turn_index, 1);
    assert.equal(stored[1].turn_index, 3, "two turns happened between the two samples");
    assert.equal(stored[1].turns_exact, 1);
  });

  it("does not let a sub-agent's turns or a <synthetic> refusal advance the count", () => {
    // Both exclusions are the ceiling's own and neither may be relaxed. A
    // sidechain is a different conversation, and a `<synthetic>` frame is the
    // CLI's record of an API-level refusal carrying an all-zero usage block. A
    // turn axis that counted either would climb on runs that delegate hardest —
    // which is the population whose growth rate is most worth reading.
    const file = transcript("excluded.jsonl", [
      turn("m1", { input: 10, read: 1_000 }),
      turn("s1", { input: 10, read: 400_000 }, { isSidechain: true }),
      turn("s2", { input: 10, read: 400_000 }, { isSidechain: true }),
      {
        type: "assistant",
        message: {
          id: "y1",
          role: "assistant",
          model: "<synthetic>",
          content: "",
          usage: { input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      turn("m2", { input: 10, read: 2_000 }),
    ]);

    pruningMod.sampleContext("r1", 1, file);

    const stored = rows();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].turn_index, 2, "two main-thread turns, not five");
    assert.equal(stored[0].tokens, 2_010, "and the reading is the main thread's, not the sidechain's");
  });

  it("counts an assistant turn once when the CLI wrote it as several records", () => {
    // A turn that both spoke and called a tool is written as more than one line
    // sharing one `message.id`. Counting lines would report a tool-heavy run as
    // having taken several times the turns it did, which is the same number
    // being wrong in the same invisible way as the exclusions above.
    const file = transcript("split-turn.jsonl", [
      turn("m1", { input: 10, read: 1_000 }),
      turn("m2", { input: 10, read: 2_000 }),
      turn("m2", { input: 10, read: 2_000 }),
      turn("m2", { input: 10, read: 2_000 }),
    ]);

    pruningMod.sampleContext("r1", 1, file);

    assert.equal(rows()[0].turn_index, 2);
  });

  it("says so on the row when the reading is the byte-estimate fallback", () => {
    // `apiContextTokens` falls back to `contextTokens` rather than to zero for a
    // conversation with no usable usage frame, and that is deliberate. What must
    // not happen is the two arriving in one series under one name: they are
    // different quantities, so a basis change drawn as a value change is a step
    // in the graph that never happened.
    const file = transcript("nousage.jsonl", [
      { type: "assistant", message: { id: "m1", role: "assistant", content: "x".repeat(40_000) } },
    ]);

    const reading = pruningMod.sampleContext("r1", 1, file);

    assert.equal(reading.basis, "transcript");
    const stored = rows();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].basis, "transcript");
    assert.equal(stored[0].frame_id, null);
    assert.equal(stored[0].tokens, pruningMod.contextTokens(file));
  });

  it("records nothing at all for a transcript it cannot read", () => {
    // A zero would draw a cliff to the floor and then a cliff back, which reads
    // as a compaction that never happened. A gap reads as a gap.
    const reading = pruningMod.sampleContext("r1", 1, path.join(transcripts, "gone.jsonl"));

    assert.equal(reading.basis, "unreadable");
    assert.equal(reading.tokens, 0);
    assert.equal(rows().length, 0);
  });

  it("caps one run's series and drops the oldest, never the newest", () => {
    // Written on the run loop's path for every live run, with nothing about a
    // run bounding how many turns it takes. The newest survive because the
    // reason to open this series is a run that is live now.
    const insert = dbMod.db().prepare(
      `INSERT INTO context_samples
         (ts, run_id, iteration, tokens, basis, frame_id, turn_index, turns_exact)
       VALUES (?, 'r1', 1, ?, 'api', ?, ?, 1)`,
    );
    const fill = dbMod.db().transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(1_000 + i, i, `old-${i}`, i);
    });
    fill(pruningMod.CONTEXT_SAMPLES_PER_RUN + 50);
    // Another run's rows must survive a trim aimed at this one.
    insert.run(9, 1, "other-run-frame", 1);
    dbMod
      .db()
      .prepare("UPDATE context_samples SET run_id='r2' WHERE frame_id='other-run-frame'")
      .run();

    const file = transcript("capped.jsonl", [turn("newest", { input: 10, read: 7_000 })]);
    pruningMod.sampleContext("r1", 1, file);

    const stored = rows();
    assert.equal(stored.length, pruningMod.CONTEXT_SAMPLES_PER_RUN);
    assert.equal(stored[stored.length - 1].frame_id, "newest");
    assert.equal(stored[0].frame_id, "old-51", "the oldest went, in order");
    assert.equal(rows("r2").length, 1, "a cap on one run may not reach another's rows");
  });
});

describe("nextTurnIndex", () => {
  it("takes a whole-file count as the conversation's own length", () => {
    // Nothing to stop at and the scan reached the start of the file, so there is
    // nothing before what it counted. This is also what a `--resume` into a
    // fresh transcript looks like from here, and treating it as an advance would
    // add the new file's turns on top of the old file's.
    assert.deepEqual(
      pruningMod.nextTurnIndex(null, { turnsAdvanced: 7, sinceFound: false, wholeFile: true }),
      { turnIndex: 7, exact: true },
    );
    assert.deepEqual(
      pruningMod.nextTurnIndex(
        { turnIndex: 400, exact: true },
        { turnsAdvanced: 3, sinceFound: false, wholeFile: true },
      ),
      { turnIndex: 3, exact: true },
    );
  });

  it("adds a measured advance and keeps whatever the index already was", () => {
    assert.deepEqual(
      pruningMod.nextTurnIndex(
        { turnIndex: 12, exact: true },
        { turnsAdvanced: 2, sinceFound: true, wholeFile: false },
      ),
      { turnIndex: 14, exact: true },
    );
  });

  it("makes a floor of an advance the scan ran out of window for, and keeps it one", () => {
    // The tail scan is bounded at a megabyte, so the frame it was told to stop
    // at may be real and simply further back. The count is then a lower bound,
    // and a lower bound added to anything stays one — a series that quietly
    // promoted itself back to exact would put a number on an axis it does not
    // have. `turnsExact` is what a renderer reads to decline to draw it.
    assert.deepEqual(
      pruningMod.nextTurnIndex(
        { turnIndex: 12, exact: true },
        { turnsAdvanced: 5, sinceFound: false, wholeFile: false },
      ),
      { turnIndex: 17, exact: false },
    );
    assert.deepEqual(
      pruningMod.nextTurnIndex(
        { turnIndex: 17, exact: false },
        { turnsAdvanced: 1, sinceFound: true, wholeFile: false },
      ),
      { turnIndex: 18, exact: false },
    );
  });

  it("is a floor on a first sample that could not see the start of the file", () => {
    assert.deepEqual(
      pruningMod.nextTurnIndex(null, { turnsAdvanced: 9, sinceFound: false, wholeFile: false }),
      { turnIndex: 9, exact: false },
    );
  });
});

describe("contextOccupancy", () => {
  it("ships the ceiling in force rather than leaving it to be assumed", () => {
    // The constant has already moved twice — 167,000, then 300,000, then
    // 200,000. A consumer computing a percentage against a hardcoded 200k would
    // go on drawing the old number after the next move, and be exactly as
    // plausible as before.
    const file = transcript("ceiling.jsonl", [turn("m1", { input: 10, read: 100_000 })]);
    pruningMod.sampleContext("r1", 1, file);

    const view = pruningMod.contextOccupancy("r1")!;
    assert.equal(view.ceilingTokens, pruningMod.CYCLE_CONTEXT_CEILING_TOKENS);
    assert.equal(view.samples.length, 1);
    assert.equal(view.sampleCount, 1);
  });

  it("returns the prune marks beside the series so a fall in context has a cause", () => {
    // Context dropping by tens of thousands of tokens between two samples is an
    // unexplained cliff unless what caused it is on the same axis. Read from
    // `prune_receipts` rather than recomputed — that table is the record.
    const file = transcript("marks.jsonl", [turn("m1", { input: 10, read: 90_000 })]);
    pruningMod.sampleContext("r1", 1, file);
    pruningMod.recordPrune(
      "r1",
      "boundary",
      {
        tier: "standard",
        tokensBefore: 100_000,
        tokensAfter: 60_000,
        tokensRemoved: 40_000,
        apiTokensBefore: 150_000,
        elapsedMs: 10,
      },
      "claude-opus-5",
    );

    const view = pruningMod.contextOccupancy("r1")!;
    assert.equal(view.prunes.length, 1);
    assert.equal(view.prunes[0].trigger, "boundary");
    assert.equal(view.prunes[0].tokensRemoved, 40_000);
    assert.equal(view.pruneCount, 1);
  });

  it("says how much it is holding back rather than returning a prefix silently", () => {
    // A run can be hours long and this rides a three-second poll, so the array
    // is the newest tail. What makes that honest rather than a lie is
    // `sampleCount`: a reader can see the array is the end of something longer
    // instead of reading it as the whole run.
    const insert = dbMod.db().prepare(
      `INSERT INTO context_samples
         (ts, run_id, iteration, tokens, basis, frame_id, turn_index, turns_exact)
       VALUES (?, 'r1', 1, ?, 'api', ?, ?, 1)`,
    );
    const n = pruningMod.CONTEXT_SERIES_MAX_POINTS + 25;
    dbMod.db().transaction(() => {
      for (let i = 0; i < n; i++) insert.run(1_000 + i, i, `f-${i}`, i);
    })();

    const view = pruningMod.contextOccupancy("r1")!;
    assert.equal(view.samples.length, pruningMod.CONTEXT_SERIES_MAX_POINTS);
    assert.equal(view.sampleCount, n);
    // Oldest first, and the tail is the *newest* rows: a graph is drawn forward
    // and a live run's recent shape is what somebody opened the page for.
    assert.equal(view.samples[view.samples.length - 1].turnIndex, n - 1);
    assert.equal(view.samples[0].turnIndex, 25);
  });

  it("carries the last read beside the series, not in place of it", () => {
    const file = transcript("occ-check.jsonl", [turn("m1", { input: 10, read: 5_000 })]);
    pruningMod.sampleContext("r1", 1, file);
    // A second tick on the same frame: the series does not move and the read
    // does. Both halves have to reach the DTO or the page cannot tell them
    // apart, which is the whole point of the field.
    pruningMod.sampleContext("r1", 1, file);

    const dto = pruningMod.contextOccupancy("r1");
    assert.ok(dto);
    assert.equal(dto.samples.length, 1);
    assert.ok(dto.lastCheck, "the tick that read it is on the wire");
    assert.equal(dto.lastCheck.basis, "api");
    assert.ok(dto.lastCheck.ts >= dto.samples[0].ts);
  });

  it("reports no read at all where this process has taken none", () => {
    // A server restarted mid-run inherits the rows and none of the reads.
    // Borrowing the previous process's would be freshness it cannot vouch for.
    dbMod
      .db()
      .prepare(
        `INSERT INTO context_samples
           (ts, run_id, iteration, tokens, basis, frame_id, turn_index, turns_exact)
         VALUES (?, 'r1', 1, 5000, 'api', 'inherited', 1, 1)`,
      )
      .run(Date.now());

    const dto = pruningMod.contextOccupancy("r1");
    assert.ok(dto);
    assert.equal(dto.lastCheck, null);
  });

  it("marks a cut the fork engine made, which files no receipt to be found", () => {
    // The fork engine writes a `fork_attempts` row and never calls
    // `recordPrune`, so a panel reading receipts alone drew a series with no
    // mark on it and reported zero prunes — while the pruning section on the
    // same page, out of the same response, priced the cut it could see. A
    // series with no marks does not read as a gap; it reads as a conversation
    // that grew and was never cut, which is the opposite of what happened.
    const file = transcript("fork-marks.jsonl", [turn("m1", { input: 10, read: 90_000 })]);
    pruningMod.sampleContext("r1", 1, file);
    insertFork({ ts: Date.now(), netBytes: 36_000, trigger: "boundary" });

    const view = pruningMod.contextOccupancy("r1")!;
    assert.equal(view.prunes.length, 1);
    assert.equal(view.prunes[0].trigger, "boundary");
    // 36,000 net bytes over `BYTES_PER_TOKEN`, which is 3.6 — the one basis a
    // fork is ever converted on, and the one `forkCutFromRow` prices it on. The
    // bytes reaching the wire as if they were a receipt's `tokens_removed`
    // would overstate the mark 3.6-fold and nothing downstream could tell.
    assert.equal(view.prunes[0].tokensRemoved, 10_000);
    assert.equal(view.pruneCount, 1);
  });

  it("counts both engines' cuts and puts them on one axis in order", async () => {
    // The count is the same number the pruning section beside it prints, which
    // goes through `pricedCuts` and has known about both tables since the
    // dashboard was fixed. Two readers of one run disagreeing about whether it
    // ever pruned is the defect; agreeing is the fix.
    const file = transcript("both-engines.jsonl", [turn("m1", { input: 10, read: 90_000 })]);
    pruningMod.sampleContext("r1", 1, file);
    insertFork({ ts: Date.now() - 60_000, netBytes: 18_000, trigger: "early-end" });
    pruningMod.recordPrune(
      "r1",
      "boundary",
      {
        tier: "standard",
        tokensBefore: 100_000,
        tokensAfter: 60_000,
        tokensRemoved: 40_000,
        apiTokensBefore: 150_000,
        elapsedMs: 10,
      },
      "claude-opus-5",
    );

    const view = pruningMod.contextOccupancy("r1")!;
    assert.equal(view.pruneCount, 2);
    // Against the other reader rather than against a literal: the two are
    // assembled into one response by one handler, and the assertion worth
    // making is that they cannot disagree — not that each happens to say 2.
    assert.equal(
      view.pruneCount,
      (await pruningMod.pruneSavings({ runId: "r1" })).prunes,
    );
    // Oldest first, merged on `ts` rather than one table's rows after the
    // other's: the marks are drawn on the samples' own axis, and one out of
    // order points at a fall in the series it did not cause.
    assert.deepEqual(
      view.prunes.map((p) => p.trigger),
      ["early-end", "boundary"],
    );
  });

  it("is undefined for a run with neither samples nor prunes", () => {
    // So the route can drop the key rather than add an empty series to every
    // poll of every run that predates this.
    assert.equal(pruningMod.contextOccupancy("never-ran"), undefined);
  });

  it("does not turn a refused fork into a reading of a run that never pruned", () => {
    // `written = 0` is a fork that was planned and declined — no transcript
    // changed and no context fell. Counting one would put a mark on a series at
    // a moment nothing happened, and would turn "this run did not prune" into a
    // zero-filled reading, which the panel and the pruning section beside it
    // both draw as a different sentence.
    insertFork({ ts: Date.now(), netBytes: 36_000, trigger: "early-end", written: 0 });

    assert.equal(pruningMod.contextOccupancy("r1"), undefined);
  });
});

/** One `fork_attempts` row, in the shape the fork engine writes. */
function insertFork(row: {
  ts: number;
  netBytes: number;
  trigger: string | null;
  written?: number;
}): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO fork_attempts
         (ts, run_id, new_session_id, written, removed_bytes, net_bytes,
          suffix_bytes, trigger, context_tokens_after)
       VALUES (?, 'r1', 's-forked', ?, ?, ?, 300000, ?, 286894)`,
    )
    .run(
      row.ts,
      row.written ?? 1,
      // Gross against net: the pointers winnow puts back are really there, and
      // the mark is the net, so these have to differ or the test cannot tell
      // which column was read.
      Math.round(row.netBytes * 1.2),
      row.netBytes,
      row.trigger,
    );
}
