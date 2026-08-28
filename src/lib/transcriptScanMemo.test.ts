import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The memoised scan result must be indistinguishable from rebuilding it.
 *
 * `runScan` skips its cross-file dedupe and its sort when every transcript's
 * byte size and the walk's file list are what they were last time, which is 55%
 * of the self time of a warm scan on a real corpus. The failure mode of getting
 * that wrong is the silent kind this suite exists for: the dashboard and every
 * budget guard would go on reporting a figure that stopped moving, and nothing
 * would throw or fail to typecheck.
 *
 * So each case below changes the tree in one specific way and asserts the scan
 * saw it. The bound is left at its default — eviction disables the memo, and
 * `transcriptCache.test.ts` is where that interaction is already pinned.
 */

let root: string;
let projects: string;
let transcripts: typeof import("./transcripts");

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function record(session: string, turn: number, ts: number, output = 340): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${session}-${turn}`,
    requestId: `req_${session}_${turn}`,
    timestamp: new Date(ts).toISOString(),
    sessionId: session,
    cwd: `/workspace/${session}`,
    message: {
      id: `msg_${session}_${turn}`,
      model: "claude-opus-4-5-20251101",
      usage: {
        input_tokens: 12,
        output_tokens: output,
        cache_read_input_tokens: 4821,
        cache_creation_input_tokens: 1200,
      },
    },
  });
}

function toolLine(session: string, id: string, chars: number | null): string {
  return chars === null
    ? JSON.stringify({
        type: "assistant",
        uuid: `tu-${id}`,
        timestamp: new Date(NOW).toISOString(),
        sessionId: session,
        message: {
          id: `msg_tool_${id}`,
          role: "assistant",
          content: [{ type: "tool_use", id, name: "Read", input: { file_path: "/x" } }],
        },
      })
    : JSON.stringify({
        type: "user",
        uuid: `tr-${id}`,
        timestamp: new Date(NOW + 1000).toISOString(),
        sessionId: session,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: id, content: "y".repeat(chars) },
          ],
        },
      });
}

function writeSession(session: string, lines: string[]): string {
  const dir = path.join(projects, session);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function appendLines(file: string, lines: string[]): void {
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-scan-memo-"));
  projects = path.join(root, "claude", "projects");
  fs.mkdirSync(projects, { recursive: true });
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.DATA_DIR = path.join(root, "data");

  const config = await import("./config");
  assert.equal(
    config.CLAUDE_HOME,
    process.env.CLAUDE_HOME,
    "config was already loaded by another test file in this process — refusing " +
      "to scan the real transcript tree",
  );

  transcripts = await import("./transcripts");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the memoised scan answers what a rebuilt one would", () => {
  it("returns the same records when nothing changed, on a fresh instant", async () => {
    writeSession("alpha", [record("alpha", 0, NOW), record("alpha", 1, NOW + 60_000)]);

    const first = await transcripts.scanUsage();
    const second = await transcripts.scanUsage();

    assert.deepEqual(second.entries, first.entries);
    assert.deepEqual(second.toolCalls, first.toolCalls);
    assert.equal(second.fileCount, first.fileCount);
    assert.deepEqual(second.unpricedModels, first.unpricedModels);
    // The records are current as of now — an unchanged tree is what proves it —
    // so the one field that would be a lie if it were shared is not shared.
    assert.ok(second.scannedAt >= first.scannedAt);
  });

  it("sees a turn appended to a file it has already read", async () => {
    const file = path.join(projects, "alpha", "alpha.jsonl");
    const before = await transcripts.scanUsage();

    appendLines(file, [record("alpha", 2, NOW + 120_000)]);
    const after = await transcripts.scanUsage();

    assert.equal(after.entries.length, before.entries.length + 1);
    assert.ok(after.entries.some((e) => e.key.includes("msg_alpha_2")));
  });

  it("sees a whole new transcript appear", async () => {
    const before = await transcripts.scanUsage();

    writeSession("beta", [record("beta", 0, NOW + 180_000)]);
    const after = await transcripts.scanUsage();

    assert.equal(after.fileCount, before.fileCount + 1);
    assert.equal(after.entries.length, before.entries.length + 1);
  });

  it("sees a transcript removed", async () => {
    const before = await transcripts.scanUsage();

    fs.rmSync(path.join(projects, "beta"), { recursive: true, force: true });
    const after = await transcripts.scanUsage();

    assert.equal(after.fileCount, before.fileCount - 1);
    assert.equal(after.entries.length, before.entries.length - 1);
  });

  it("sees a tool result that arrives for a call parsed on an earlier pass", async () => {
    // A result line rewrites `resultChars` on a call already in the array, so
    // neither `entries.length` nor `toolCalls.length` moves — which is why the
    // memo is keyed on byte size rather than either count. This case is what
    // makes the reading visible; it does not on its own prove the key, because
    // the memo holds the very objects `readAppended` mutates and one file
    // therefore aliases through. What the byte size buys over a count is the
    // *dedupe* across files, where a changed `resultChars` picks a different
    // copy — see `runScan`'s tool-call tie-break.
    const file = writeSession("gamma", [toolLine("gamma", "toolu_1", null)]);
    const before = await transcripts.scanUsage();
    const callBefore = before.toolCalls.find((c) => c.id === "toolu_1");
    assert.ok(callBefore, "the call should have been parsed");
    assert.equal(callBefore.resultChars, null);

    appendLines(file, [toolLine("gamma", "toolu_1", 512)]);
    const after = await transcripts.scanUsage();

    assert.equal(after.toolCalls.length, before.toolCalls.length);
    assert.equal(after.entries.length, before.entries.length);
    assert.equal(
      after.toolCalls.find((c) => c.id === "toolu_1")?.resultChars,
      512,
    );
  });

  it("rebuilds after the retention sweep has forgotten a file", async () => {
    const file = path.join(projects, "alpha", "alpha.jsonl");
    const before = await transcripts.scanUsage();
    assert.ok(before.entries.length > 0);

    transcripts.forgetTranscriptFiles([file]);
    const after = await transcripts.scanUsage();

    // Re-read from byte 0 to the same byte size, which would read as an
    // unchanged tree if the sweep had not dropped the memo with the offsets.
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.toolCalls, before.toolCalls);
  });
});
