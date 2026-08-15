import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Covers one thing: that a scan reads a bounded number of transcripts at once,
 * and says so when it could not read one.
 *
 * It is not a pure function, and it earns a place here the way the rest of the
 * non-pure files do — two silent failures with no other way out. `runScan` fanned
 * every file out through one `Promise.all`, and `readAppended` holds a descriptor
 * and a buffer sized to the file's whole unread remainder until its read
 * finishes, so peak memory was the size of the tree and peak descriptors its file
 * count. Every restart pays that: the cache is process-local, so the first scan
 * after one reads every file from byte 0. Past a container's `nofile` limit the
 * excess opens simply failed — and `.catch(() => null)` made a file that could
 * not be opened indistinguishable from a file with nothing new in it, so the scan
 * answered with a short entry list and the budget guard measured against a total
 * that was too low. Under-reporting is the direction a guard fails *open* in.
 *
 * Peak descriptors rather than peak RSS is what this pins. They are the same
 * bound — one buffer per open handle — and the descriptor count is a number this
 * process can observe exactly, where sampling RSS across a scan measures the
 * garbage collector as much as the code. `fs.open` is replaced module-wide to
 * count them, which is `chat.test.ts`'s device for counting spawned children.
 *
 * It lives in its own file because `CLAUDE_HOME` is read into `config.ts` at
 * module load, which a file that statically imports `./transcripts` cannot
 * arrange, and because the patch above is module-wide — `node --test` gives each
 * file its own process. The assertion in `before` is what makes a change to that
 * fail loudly rather than scanning the operator's own transcripts.
 */

/** Comfortably more than the concurrency limit, cheap to write. */
const SESSIONS = 40;
const TURNS_PER_SESSION = 3;

let transcripts: typeof import("./transcripts");
let root: string;
let projects: string;

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

/** Descriptors this process holds open through `fs.open` at once. */
let openNow = 0;
let peakOpen = 0;
/** A path `fs.open` should refuse, standing in for a permission or fd failure. */
let refuseOpenOf: string | null = null;
const realOpen = fsPromises.open;

function record(session: string, turn: number): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${session}-${turn}`,
    requestId: `req_${session}_${turn}`,
    timestamp: new Date(NOW - turn * 60_000).toISOString(),
    sessionId: session,
    cwd: `/workspace/${session}`,
    message: {
      id: `msg_${session}_${turn}`,
      model: "claude-opus-4-5-20251101",
      usage: { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 4821 },
    },
  });
}

function writeSession(session: string, turns = TURNS_PER_SESSION): string {
  const dir = path.join(projects, session);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let t = 0; t < turns; t++) lines.push(record(session, t));
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-transcript-scan-"));
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

  for (let s = 0; s < SESSIONS; s++) writeSession(`session-${s}`);

  // Wrapped rather than spied on: the count has to fall when the handle is
  // closed, and only the handle knows when that happened. Everything else is
  // delegated, so what the scan reads is the real file.
  (fsPromises as unknown as { open: unknown }).open = async (
    ...args: unknown[]
  ) => {
    if (refuseOpenOf !== null && args[0] === refuseOpenOf) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${args[0]}'`), {
        code: "EACCES",
      });
    }
    const handle = await (
      realOpen as unknown as (...a: unknown[]) => Promise<
        Awaited<ReturnType<typeof realOpen>>
      >
    )(...args);
    openNow += 1;
    if (openNow > peakOpen) peakOpen = openNow;
    return {
      read: (...a: unknown[]) =>
        (handle.read as unknown as (...x: unknown[]) => unknown)(...a),
      close: async () => {
        openNow -= 1;
        return handle.close();
      },
    };
  };

  transcripts = await import("./transcripts");
});

after(() => {
  (fsPromises as unknown as { open: unknown }).open = realOpen;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a transcript scan is bounded", () => {
  it("opens no more files at once than the concurrency limit", async () => {
    const scan = await transcripts.scanUsage();

    assert.equal(scan.fileCount, SESSIONS);
    assert.equal(
      scan.entries.length,
      SESSIONS * TURNS_PER_SESSION,
      "a bounded fan-out must still read every file",
    );

    assert.ok(
      peakOpen <= transcripts.SCAN_CONCURRENCY,
      `${peakOpen} transcripts were open at once against a limit of ` +
        `${transcripts.SCAN_CONCURRENCY} — peak memory and peak descriptors are ` +
        `still a function of how many files are on disk`,
    );
    // The other direction: a limit is not the same thing as reading one file at
    // a time, and serialising the scan would satisfy the bound above while
    // making every restart slower than the thing it was meant to fix.
    assert.ok(peakOpen > 1, "the scan read one file at a time");
    assert.equal(openNow, 0, "a handle was left open");
    assert.deepEqual(scan.readFailures, []);
  });

  it("reports a file it could not read rather than answering short", async () => {
    // A new session, so the scan has to open it: every file above is cached at
    // its full offset now and would not be opened again, which is exactly the
    // "nothing new in it" case this has to be told apart from.
    const refused = writeSession("session-refused");
    refuseOpenOf = refused;

    const scan = await transcripts.scanUsage();

    assert.equal(scan.readFailures.length, 1, "the failed read was swallowed");
    assert.equal(scan.readFailures[0].path, refused);
    assert.match(scan.readFailures[0].message, /EACCES/);
    assert.deepEqual(
      transcripts.lastScanReadFailures(),
      scan.readFailures,
      "the reading the budget guard is offered disagrees with the scan's own",
    );

    // And the entry list really is short, which is the whole reason the failure
    // has to travel with it.
    assert.equal(scan.entries.length, SESSIONS * TURNS_PER_SESSION);

    refuseOpenOf = null;
    const clean = await transcripts.scanUsage();
    assert.deepEqual(clean.readFailures, []);
    assert.equal(clean.entries.length, (SESSIONS + 1) * TURNS_PER_SESSION);
  });
});
