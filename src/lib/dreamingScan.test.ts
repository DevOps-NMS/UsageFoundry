import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * The scan's deduplication, which is the one thing in this module a pure test
 * cannot reach and the one thing a real corpus proved wrong.
 *
 * **A resumed session copies its earlier records into the new transcript**, so
 * the same failure is written twice in two different files. A per-file pass
 * cannot see it, and the first note Dreaming ever wrote caught it: the agent
 * re-derived the counts from the corpus rather than trusting the ones it was
 * handed, and reported 2,428 error results where the readout had said 2,553.
 * Measured against the real corpus afterwards: 2,567 blocks carrying 2,435
 * distinct `tool_use_id`s — 132 surplus, 5.1%.
 *
 * It is a *counting* bug and not a policy one, which is why the day assertion
 * below matters as much as the instance assertion: no copied-forward record was
 * ever found on a different day from its original, so deduplication must not
 * change which signatures span two days and therefore must not change what gets
 * written. A future "fix" that deduplicated on the signature instead of on the
 * record would silently collapse a genuine recurrence into one sighting and
 * stop writing notes at all.
 *
 * `CLAUDE_HOME` is named before the first import, for `runOrigin.test.ts`'s
 * reason: `config.ts` is read at module load, so a file that imported the scan
 * at the top would already be bound to the operator's real transcripts.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "uf-dreaming-scan-"));
const PROJECTS = path.join(HOME, "projects");
fs.mkdirSync(PROJECTS, { recursive: true });
process.env.CLAUDE_HOME = HOME;

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

type Scan = typeof import("./dreaming");
let mod: Scan;

before(async () => {
  mod = await import("./dreaming");
});

beforeEach(() => {
  for (const entry of fs.readdirSync(PROJECTS)) {
    fs.rmSync(path.join(PROJECTS, entry), { recursive: true, force: true });
  }
  // The memo is keyed on path plus size and mtime, and a fixture rewritten
  // inside one millisecond can otherwise reuse the previous parse.
  mod.forgetDreamingFiles(
    fs.existsSync(PROJECTS)
      ? fs.readdirSync(PROJECTS).map((f) => path.join(PROJECTS, f))
      : [],
  );
});

/** One `is_error` tool result, as the CLI writes it. */
function record(opts: { at: string; toolUseId: string; body: string; uuid?: string }) {
  return JSON.stringify({
    timestamp: opts.at,
    uuid: opts.uuid ?? `u-${opts.toolUseId}`,
    sessionId: "sess-1",
    message: {
      content: [
        { type: "tool_result", tool_use_id: opts.toolUseId, is_error: true, content: opts.body },
      ],
    },
  });
}

function write(name: string, lines: string[]) {
  const file = path.join(PROJECTS, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  mod.forgetDreamingFiles([file]);
}

describe("scanDreaming deduplication", () => {
  it("counts a record copied into a resumed session once", async () => {
    const line = record({
      at: "2026-08-10T09:00:00Z",
      toolUseId: "toolu_1",
      body: "bwrap: Can't create file at /a/b/settings.json: Permission denied",
    });
    // The original, and the copy a resume wrote into a second transcript.
    write("original.jsonl", [line]);
    write("resumed.jsonl", [line]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.totalInstances, 1, "the copy must not be counted again");
    assert.equal(out.duplicates, 1, "and the drop must be reported rather than absorbed");
  });

  it("keeps two genuinely separate failures that share a message", async () => {
    // Same text, different calls — two real failures, and collapsing them would
    // understate a recurring problem rather than overstate it.
    write("a.jsonl", [
      record({ at: "2026-08-10T09:00:00Z", toolUseId: "toolu_1", body: "pdftoppm is not installed" }),
      record({ at: "2026-08-10T10:00:00Z", toolUseId: "toolu_2", body: "pdftoppm is not installed" }),
    ]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.totalInstances, 2);
    assert.equal(out.duplicates, 0);
  });

  it("does not change which signatures span two days", async () => {
    // The assertion that keeps this a counting fix. A dedup keyed on the
    // signature rather than the record would leave this at one day and the
    // write policy would stop firing, silently.
    const body = "Exit code 128 error: .bash_profile: can only add regular files";
    write("day1.jsonl", [
      record({ at: "2026-08-10T09:00:00Z", toolUseId: "toolu_1", body }),
      // A copy of day one's record, carried forward — same id, same day.
      record({ at: "2026-08-10T09:00:00Z", toolUseId: "toolu_1", body }),
    ]);
    write("day2.jsonl", [record({ at: "2026-08-12T09:00:00Z", toolUseId: "toolu_9", body })]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.recurring.length, 1, "still one recurring signature");
    assert.deepEqual(out.recurring[0].days, ["2026-08-10", "2026-08-12"]);
    assert.equal(out.recurring[0].instances, 2, "two real failures, not three");
  });

  it("counts a record with no identifiers rather than dropping it", async () => {
    // The direction that over-counts: without an id there is nothing to prove
    // two records are the same, and losing a real failure is the worse error.
    const bare = (at: string) =>
      JSON.stringify({
        timestamp: at,
        sessionId: "s",
        message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] },
      });
    write("bare.jsonl", [bare("2026-08-10T09:00:00Z"), bare("2026-08-10T10:00:00Z")]);

    const out = await mod.scanDreaming({ timeZone: "UTC" });
    assert.equal(out.totalInstances, 2);
  });

  it("holds the window against the reported days rather than the files read", async () => {
    write("old.jsonl", [
      record({ at: "2020-01-01T09:00:00Z", toolUseId: "toolu_old", body: "ancient" }),
    ]);
    write("new.jsonl", [
      record({ at: new Date().toISOString(), toolUseId: "toolu_new", body: "recent" }),
    ]);

    const out = await mod.scanDreaming({ timeZone: "UTC", sinceDays: 30 });
    assert.equal(out.totalInstances, 1, "the ancient one is outside the window");
    // Still walked and still stat'd: the memo is keyed on the file, and a
    // window that moved would otherwise re-read the corpus every midnight.
    assert.equal(out.filesWalked, 2);
  });
});
