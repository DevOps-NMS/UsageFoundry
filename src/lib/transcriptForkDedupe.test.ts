import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Which copy of a tool call wins when the same conversation is on disk twice.
 *
 * `winnow fork` writes a second transcript whose tool results are deliberately
 * replaced by short pointers, and never deletes the first. Both files then carry
 * the same `tool_use` ids, so the composition reading has to pick one — and the
 * rule it used, most characters wins, always picked the original's full result.
 * The fork was reported as having removed nothing, permanently, on the one
 * screen an operator would look at to decide whether forking was worth it.
 * Measured on a real fork: 92,498 characters against the fork's own 69,773.
 *
 * The rule is now recency: a transcript still being appended to is the
 * conversation the run is carrying. Both directions are pinned here, because
 * the failure is invisible either way — the number is plausible whichever copy
 * wins, and nothing throws.
 *
 * Its own file, and `CLAUDE_HOME` is set before `transcripts` is imported:
 * `config.ts` reads that variable at module load, so a test that imported the
 * module first would scan the operator's real transcripts.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uf-fork-dedupe-"));
const PROJECT = path.join(TMP, "projects", "-proj");

// The same call, answered at length in one transcript and by a pointer in the
// other. 220 characters against 42 — the shape of a real strip, in miniature.
const FULL_RESULT = "x".repeat(220);
const POINTER =
  "[winnow: Bash result removed, rule B2, 220 bytes, sha256 9f2c…a1]";

type Rec = Record<string, unknown>;

function call(ts: string, id: string): Rec {
  return {
    type: "assistant",
    sessionId: "s",
    timestamp: ts,
    requestId: `req-${id}`,
    message: {
      id: `msg-${id}`,
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

function result(ts: string, id: string, body: string): Rec {
  return {
    type: "user",
    sessionId: "s",
    timestamp: ts,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: body }],
    },
  };
}

/** A turn with fresh ids, which is what makes one file newer than the other. */
function laterTurn(ts: string, n: number): Rec {
  return {
    type: "assistant",
    sessionId: "s",
    timestamp: ts,
    requestId: `req-later-${n}`,
    message: {
      id: `msg-later-${n}`,
      role: "assistant",
      model: "claude-opus-5",
      content: "carrying on",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

function write(name: string, records: readonly Rec[]): void {
  fs.writeFileSync(
    path.join(PROJECT, name),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

/** Total characters of tool output the composition reading believes are held. */
async function totalResultChars(): Promise<number> {
  const { scanUsage } = await import("./transcripts.js");
  const scan = await scanUsage();
  return scan.toolCalls.reduce((sum, c) => sum + (c.resultChars ?? 0), 0);
}

before(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  process.env.CLAUDE_HOME = TMP;
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("the same conversation on disk twice", () => {
  it("reports the fork's pointer once the fork is the one being written to", async () => {
    // The original stops at 10:02. The fork copies it verbatim — same ids, same
    // timestamps, shorter result — and then the run carries on inside it.
    write("original.jsonl", [
      call("2026-08-26T10:00:00.000Z", "t1"),
      result("2026-08-26T10:01:00.000Z", "t1", FULL_RESULT),
      laterTurn("2026-08-26T10:02:00.000Z", 1),
    ]);
    write("fork.jsonl", [
      call("2026-08-26T10:00:00.000Z", "t1"),
      result("2026-08-26T10:01:00.000Z", "t1", POINTER),
      laterTurn("2026-08-26T10:02:00.000Z", 1),
      laterTurn("2026-08-26T11:00:00.000Z", 2),
    ]);

    assert.equal(
      await totalResultChars(),
      POINTER.length,
      "the live conversation holds a pointer, so that is what the composition is",
    );
  });

  it("reports the original once a rollback puts the run back in it", async () => {
    // The fork was written and would not resume, so the run went back. Nothing
    // is deleted; the original is simply the one that keeps growing.
    write("original.jsonl", [
      call("2026-08-26T10:00:00.000Z", "t1"),
      result("2026-08-26T10:01:00.000Z", "t1", FULL_RESULT),
      laterTurn("2026-08-26T12:00:00.000Z", 3),
    ]);
    write("fork.jsonl", [
      call("2026-08-26T10:00:00.000Z", "t1"),
      result("2026-08-26T10:01:00.000Z", "t1", POINTER),
    ]);

    assert.equal(
      await totalResultChars(),
      FULL_RESULT.length,
      "a fork nothing resumed is not the conversation, however short its results",
    );
  });

  it("keeps the complete record when two copies are equally recent", async () => {
    // The pre-existing rule, and the case it was written for: a streaming write
    // leaves a copy with no result yet. Nothing here is a fork, both files end
    // at the same moment, and the answer must still be the finished record
    // rather than the placeholder.
    write("original.jsonl", [
      call("2026-08-26T10:00:00.000Z", "t1"),
      result("2026-08-26T10:01:00.000Z", "t1", FULL_RESULT),
    ]);
    write("fork.jsonl", [call("2026-08-26T10:00:00.000Z", "t1")]);

    assert.equal(await totalResultChars(), FULL_RESULT.length);
  });
});
