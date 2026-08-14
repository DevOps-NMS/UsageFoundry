import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clipToolInput,
  describeEvent,
  MAX_TOOL_FIELD_CHARS,
  MAX_TOOL_INPUT_CHARS,
} from "./logLine";

/**
 * Covers the pure half of the retention design — what a store is allowed to
 * grow by, and what is allowed to be discarded from it.
 *
 * Every function here decides something that lands on disk and throws nothing,
 * which is `releasableRuns`' grounds for a test. This file holds the ones that
 * need no database and no filesystem; `retentionSweep.test.ts` beside it drives
 * the SQL, which is its own decision and its own file.
 */

describe("clipToolInput", () => {
  it("stores a small input exactly as it arrived", () => {
    const input = { command: "npm test", description: "run the suite" };
    const clipped = clipToolInput(input);

    assert.equal(clipped.input, input, "an input inside the cap is not copied");
    assert.equal(clipped.truncatedFrom, undefined);
  });

  it("cuts a whole-file Write and says how big it was", () => {
    // The event this exists for: `b.input` for a Write is the file, and the log
    // has only ever rendered one clipped line of it — so the whole of the
    // difference between what was stored and what was shown was storage.
    const content = "x".repeat(200_000);
    const raw = { file_path: "/workspace/repo/big.ts", content };
    const clipped = clipToolInput(raw);

    const stored = JSON.stringify(clipped.input);
    assert.ok(
      stored.length <= MAX_TOOL_INPUT_CHARS,
      `stored ${stored.length} chars, cap is ${MAX_TOOL_INPUT_CHARS}`,
    );
    assert.ok(
      (clipped.truncatedFrom ?? 0) > 200_000,
      "the original length is what makes a shortened input readable as one",
    );
  });

  it("keeps the field that names the call, whatever else it drops", () => {
    // `toolArgs` reads the headline fields in order and renders the first one
    // it finds. A cut that spent the budget on `content` first would leave the
    // log saying a tool ran and nothing about which command it was.
    const clipped = clipToolInput({
      content: "y".repeat(100_000),
      command: "git push origin HEAD",
    });

    const stored = clipped.input as Record<string, unknown>;
    assert.equal(stored.command, "git push origin HEAD");
    assert.equal(
      describeEvent({
        id: 1,
        runId: "r",
        ts: 0,
        kind: "tool",
        payload: { name: "Bash", input: stored, truncatedFrom: clipped.truncatedFrom },
      })?.text,
      "git push origin HEAD · input shortened for storage",
    );
  });

  it("cuts each string value rather than dropping the key", () => {
    const clipped = clipToolInput({
      old_string: "a".repeat(50_000),
      new_string: "b".repeat(50_000),
    });
    const stored = clipped.input as Record<string, string>;

    assert.equal(stored.old_string.length, MAX_TOOL_FIELD_CHARS + 1, "cut plus the ellipsis");
    assert.ok(stored.old_string.endsWith("…"));
    assert.ok(stored.new_string.startsWith("b"));
  });

  it("records the call rather than throwing on an input that will not serialise", () => {
    // Unreachable from the stream, which arrives through `JSON.parse` — but
    // this runs on every tool call of every cycle, and `emit` is on the path of
    // every status transition, so a throw here would take the run's whole log
    // with it and then the run. The true statement about such an input is that
    // the call happened and its arguments were not recorded.
    const cyclic: Record<string, unknown> = { command: "ls" };
    cyclic.self = cyclic;

    assert.deepEqual(clipToolInput(cyclic), { input: null });
  });
});
