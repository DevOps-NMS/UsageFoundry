import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * Reading a completed compaction out of a transcript.
 *
 * It earns a test on `expiredTranscripts`' grounds: a pure parser over a format
 * this app does not own, where every way of being wrong is silent. `parseLine`'s
 * defensive reads are the reason — every field defaults to zero or the empty
 * string so that a half-flushed record cannot throw inside a scan, and the price
 * of that is a **renamed field reading as a real figure**. A CLI that moved
 * `preTokens` would produce the line "180,694 tokens summarised down to 0", or
 * "0 down to 0", on a run log an operator has no way to check against anything.
 *
 * `docs/verification.md` records exactly that as unverified: these names hold on
 * CLI 2.1.226, where this install produced 21 such records, and nothing here has
 * seen another version write one. The fixture below is one of those 21, copied
 * verbatim, so the test is a pin on the observed format rather than on this
 * file's idea of it.
 *
 * The second silent failure is the bound. A resumed session copies earlier
 * records forward into the new transcript carrying their original timestamps, so
 * a reader bounded by session id alone re-reports every earlier compaction at
 * the end of every later cycle — eleven cycles, one real compaction, and a run
 * log claiming eleven.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-compaction-")));
const projects = path.join(tmp, "claude", "projects");
fs.mkdirSync(path.join(projects, "-workspace-thing"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");

// `require`, not `import`: imports hoist above the environment above, and
// `config.ts` fixes PROJECTS_DIR at load.
const { parseCompactionBoundary, readCompactions } =
  require("./transcripts") as typeof import("./transcripts");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * One of the 21 records this install has written, copied verbatim from
 * `~/.claude/projects` on 2026-08-22 and trimmed only of the uuid lists, which
 * nothing reads. Written as a JSON string rather than an object so that a field
 * rename in the parser cannot be "fixed" here by renaming it in both places.
 */
const REAL_RECORD = JSON.stringify({
  parentUuid: null,
  logicalParentUuid: "8718964e-63a8-4763-a4c0-cd3292237690",
  isSidechain: false,
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
  isMeta: false,
  timestamp: "2026-08-22T01:18:08.983Z",
  uuid: "ad182765-0ca0-41a4-9d2a-28ce69a2354c",
  level: "info",
  compactMetadata: {
    trigger: "auto",
    preTokens: 180694,
    durationMs: 140432,
    preservedSegment: { headUuid: "a719aaa8", anchorUuid: "3fde1410", tailUuid: "8718964e" },
    preservedMessages: { anchorUuid: "3fde1410", uuids: [], allUuids: [] },
    postTokens: 17456,
    cumulativeDroppedTokens: 163238,
  },
  userType: "external",
  entrypoint: "sdk-cli",
  cwd: "/workspace/.uf-worktrees/usagefoundry-721638d11c0b-1",
  sessionId: "96ba3c02-1313-493c-b484-45f2f519ed3b",
  version: "2.1.226",
  gitBranch: "uf/usagefoundry-721638d11c0b-1-5426274f",
  slug: "zany-hatching-whale",
});

describe("parseCompactionBoundary", () => {
  it("reads every field off a record this install actually wrote", () => {
    assert.deepEqual(parseCompactionBoundary(REAL_RECORD), {
      sessionId: "96ba3c02-1313-493c-b484-45f2f519ed3b",
      ts: Date.parse("2026-08-22T01:18:08.983Z"),
      trigger: "auto",
      preTokens: 180694,
      postTokens: 17456,
      durationMs: 140432,
      cliVersion: "2.1.226",
    });
  });

  it("ignores the assistant turns and system records around it", () => {
    assert.equal(parseCompactionBoundary(""), null);
    assert.equal(parseCompactionBoundary("not json at all"), null);
    assert.equal(
      parseCompactionBoundary('{"type":"assistant","message":{"usage":{}}}'),
      null,
    );
    assert.equal(
      parseCompactionBoundary('{"type":"system","subtype":"hook_success"}'),
      null,
    );
  });

  /**
   * The substring pre-filter must not become the test. A tool call whose text
   * mentions the record type is the shape that actually occurs — this repository
   * has transcripts full of them, written by the sessions that measured this
   * feature — and treating one as a boundary would report a compaction that
   * never happened.
   */
  it("does not take a turn that merely mentions the record for one", () => {
    const mention = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-22T01:18:08.983Z",
      message: { content: [{ type: "text", text: 'grep "compact_boundary" .' }] },
    });
    assert.equal(parseCompactionBoundary(mention), null);
  });

  it("survives a record with no metadata rather than throwing inside a scan", () => {
    const bare = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      timestamp: "2026-08-22T01:18:08.983Z",
      sessionId: "s",
    });
    const parsed = parseCompactionBoundary(bare);
    assert.equal(parsed?.preTokens, 0);
    assert.equal(parsed?.trigger, "");
    assert.equal(parsed?.cliVersion, "");
  });

  it("drops a record with no readable timestamp, which cannot be bounded", () => {
    const undated = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      sessionId: "s",
      compactMetadata: { trigger: "auto" },
    });
    assert.equal(parseCompactionBoundary(undated), null);
  });
});

describe("readCompactions", () => {
  const at = (iso: string, sessionId: string) =>
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      timestamp: iso,
      sessionId,
      version: "2.1.226",
      compactMetadata: { trigger: "auto", preTokens: 100, postTokens: 10, durationMs: 5 },
    });

  const write = (sessionId: string, lines: string[]) =>
    fs.writeFileSync(
      path.join(projects, "-workspace-thing", `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

  it("answers nothing for a run that has not opened a conversation", async () => {
    assert.deepEqual(await readCompactions(null, { from: 0, to: Date.now() }), []);
  });

  it("answers nothing when the session's transcript is not on disk", async () => {
    assert.deepEqual(
      await readCompactions("no-such-session", { from: 0, to: Date.now() }),
      [],
    );
  });

  /**
   * The bound that matters. Both records name this session and sit in its one
   * file, exactly as a resumed session writes them; only the second happened
   * inside the cycle asking.
   */
  it("excludes an earlier cycle's boundary copied forward into the same file", async () => {
    write("sess-a", [
      at("2026-08-22T01:00:00.000Z", "sess-a"),
      at("2026-08-22T02:00:00.000Z", "sess-a"),
      // Another session's record, which a resume also copies across.
      at("2026-08-22T02:30:00.000Z", "sess-b"),
    ]);

    const found = await readCompactions("sess-a", {
      from: Date.parse("2026-08-22T01:30:00.000Z"),
      to: Date.parse("2026-08-22T02:15:00.000Z"),
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].ts, Date.parse("2026-08-22T02:00:00.000Z"));
  });

  it("returns several from one cycle in the order they happened", async () => {
    write("sess-c", [
      at("2026-08-22T03:00:00.000Z", "sess-c"),
      at("2026-08-22T01:00:00.000Z", "sess-c"),
      at("2026-08-22T02:00:00.000Z", "sess-c"),
    ]);
    const found = await readCompactions("sess-c", { from: 0, to: Date.now() });
    assert.deepEqual(
      found.map((f) => f.ts),
      [
        Date.parse("2026-08-22T01:00:00.000Z"),
        Date.parse("2026-08-22T02:00:00.000Z"),
        Date.parse("2026-08-22T03:00:00.000Z"),
      ],
    );
  });
});
