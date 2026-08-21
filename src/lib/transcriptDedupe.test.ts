import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Covers one thing: which of the records sharing a dedupe key a scan keeps.
 *
 * It is not a pure function, and it earns a place here the way the rest of the
 * non-pure files do — a silent, expensive failure nothing else notices. The
 * dedupe was written for one duplicate shape, a resumed session copying earlier
 * turns forward, where every copy is identical and first-seen is as good as any
 * other rule. Claude Code also writes one line per content block *within* a
 * single turn, repeating the whole usage object on each, and those copies are
 * not identical: every line before the last carries a streaming placeholder in
 * the output field alone. A turn that emitted 40,199 output tokens is written
 * three times, twice as `output_tokens: 4`. First-seen therefore charged the
 * placeholder and threw the real figure away.
 *
 * Nothing about that shows up in a type, a build or any other test. Output is
 * priced at five times input, so what it produces is a window, a `spent_usd_est`
 * and a weekly and session guard reading low — under-reporting, which is the
 * direction a budget guard fails *open* in. It is also getting worse rather than
 * settling: measured across ~/.claude at the time of the fix it cost 16% of
 * corpus output on CLI 2.1.226 and 75% on 2.1.238.
 *
 * Both halves are pinned, because the fix is a rule about which copy wins and
 * either half of it is cheap to get wrong: a scan that summed the copies instead
 * would double every resumed session, which is the failure the dedupe existed to
 * prevent in the first place.
 *
 * It lives in its own file because `CLAUDE_HOME` is read into `config.ts` at
 * module load, which a file that statically imports `./transcripts` cannot
 * arrange, and it is not a case in `transcriptCache.test.ts` because that file's
 * cases run in order against one shared cache and a tree written here would move
 * the eviction sequence they read. `node --test` gives each file its own
 * process; the assertion in `before` is what makes a change to that fail loudly
 * rather than scanning the operator's own transcripts.
 */

let transcripts: typeof import("./transcripts");
let root: string;
let projects: string;

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

/** What the last line of the turn reports, and so what the scan must charge. */
const REAL_OUTPUT = 40_199;
/** What Claude Code writes on every line before it. */
const PLACEHOLDER_OUTPUT = 4;

/**
 * One assistant record in Claude Code's own shape, carrying the fields
 * `parseLine` reads: a dedupe pair, a timestamp, a priced model and a usage
 * block. `output` is the only field that moves between the lines of one turn.
 */
function record(session: string, turn: number, output: number): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${session}-${turn}-${output}`,
    requestId: `req_${session}_${turn}`,
    timestamp: new Date(NOW - turn * 60_000).toISOString(),
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

function write(session: string, lines: string[]): void {
  const dir = path.join(projects, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), `${lines.join("\n")}\n`);
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-transcript-dedupe-"));
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

describe("records sharing a dedupe key resolve to the finished one", () => {
  it("charges the last line of a turn, not the streaming placeholder", async () => {
    // The shape Claude Code writes: thinking, then a tool call, then the same
    // message again once the turn has settled. All three share one
    // `message.id` + `requestId`, and only the last knows what it cost.
    write("session-streamed", [
      record("session-streamed", 0, PLACEHOLDER_OUTPUT),
      record("session-streamed", 0, PLACEHOLDER_OUTPUT),
      record("session-streamed", 0, REAL_OUTPUT),
    ]);

    const scan = await transcripts.scanUsage();

    assert.equal(scan.entries.length, 1, "the three lines are one billed turn");
    assert.equal(
      scan.entries[0].tokens.output,
      REAL_OUTPUT,
      "the scan kept a placeholder line and threw the turn's real output away",
    );
    // Cost is what the guard acts on, and it is where the shortfall is worth
    // five times as much as it is in the token count.
    assert.ok(
      scan.entries[0].costUSD > 0.9,
      `40k output tokens of Opus priced at $${scan.entries[0].costUSD}`,
    );
  });

  it("still collapses a resumed session's copies to one turn", async () => {
    fs.rmSync(path.join(projects, "session-streamed"), { recursive: true, force: true });

    // The duplicate shape the dedupe was written for: a resume copies the
    // earlier turn forward verbatim, into a second file under a second project.
    const copy = record("session-resumed", 0, REAL_OUTPUT);
    write("session-resumed", [copy]);
    write("session-resumed-again", [copy]);

    const scan = await transcripts.scanUsage();

    assert.equal(
      scan.entries.length,
      1,
      "an identical copy of a turn was billed twice",
    );
    assert.equal(scan.entries[0].tokens.output, REAL_OUTPUT);
  });
});
