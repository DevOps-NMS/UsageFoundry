import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { UsageEntry } from "./transcripts";
import type { LimitConfig, UsageSnapshot } from "./windows";

/**
 * Covers one thing: that the parsed-transcript cache stops growing, and that
 * stopping it costs no accuracy.
 *
 * It is not a pure function, and it earns a place here the way the rest of the
 * non-pure files do — a silent, expensive failure nothing else notices. The
 * cache held every turn it had ever parsed for the life of the process, so the
 * heap grew with cumulative history until V8 aborted, `restart: unless-stopped`
 * brought the container back, and `reconcileOnBoot` failed every run in flight.
 * Nothing about that shows up in a type, a build or any other test: the app is
 * correct at every moment right up to the abort.
 *
 * The half that would be cheap to get wrong is the re-derivation. Bounding
 * retention by keeping each file's byte offset and discarding its records would
 * look like a fix, cost nothing to run, and silently understate every window —
 * which is the direction that lets a budget guard admit a run it should have
 * refused. So two scans' totals are compared against each other through
 * `buildSnapshot`, the second one reading a cache that has already dropped most
 * of what the first one parsed.
 *
 * The cases run in order against one shared cache, deliberately. Retention is a
 * property of a sequence rather than of a call, and the deleted-file case has to
 * happen while the tree is still under the bound: past it, eviction decides what
 * is resident and would answer for the prune whether the prune ran or not.
 *
 * It lives in its own file because `CLAUDE_HOME` and the bound are read into
 * `config.ts` at module load, which a file that statically imports
 * `./transcripts` cannot arrange. `node --test` gives each file its own process;
 * the assertion in `before` is what makes a change to that fail loudly rather
 * than scanning the operator's own transcripts.
 */

/** Small enough to cross with a test-sized tree, large enough to evict from. */
const BOUND = 40;
const FILES = 12;
const TURNS_PER_FILE = 10;

let transcripts: typeof import("./transcripts");
let windows: typeof import("./windows");
let root: string;
let projects: string;

const NO_LIMITS: LimitConfig = {
  sessionCostLimit: null,
  weeklyCostLimit: null,
  sessionTokenLimit: null,
  weeklyTokenLimit: null,
  weeklyAnchor: null,
};

/** Fixed instants: a snapshot compared across two scans must not move under it. */
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const HOUR = 3_600_000;

/**
 * One assistant record in Claude Code's own shape, carrying the fields
 * `parseLine` reads: a dedupe pair, a timestamp, a priced model and a usage
 * block.
 */
function record(session: string, turn: number, ts: number): string {
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
        output_tokens: 340,
        cache_read_input_tokens: 4821,
        cache_creation_input_tokens: 1200,
      },
    },
  });
}

function writeSession(session: string, turns: number, firstTs: number): string {
  const dir = path.join(projects, session);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let t = 0; t < turns; t++) lines.push(record(session, t, firstTs + t * 60_000));
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return dir;
}

/**
 * A tree spread across the last two days, oldest session first.
 *
 * Spread on purpose: eviction is oldest-first, so a tree written at one instant
 * would not distinguish "dropped the coldest files" from "dropped whatever the
 * Map happened to iterate first" — and the turns have to straddle a 5-hour
 * boundary for the snapshot comparison to be about two different windows.
 */
function writeTree(): void {
  for (let f = 0; f < FILES; f++) {
    // Four hours apart, so session 0 is ~44 hours back and the last two sit
    // inside the 5-hour block that is still open at NOW.
    writeSession(`session-${f}`, TURNS_PER_FILE, NOW - (FILES - 1 - f) * 4 * HOUR - 30 * 60_000);
  }
}

function snapshotOf(entries: UsageEntry[]): UsageSnapshot {
  return windows.buildSnapshot(entries, NO_LIMITS, NOW);
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-transcript-cache-"));
  projects = path.join(root, "claude", "projects");
  fs.mkdirSync(projects, { recursive: true });
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.DATA_DIR = path.join(root, "data");
  process.env.UF_TRANSCRIPT_CACHE_MAX_ENTRIES = String(BOUND);

  const config = await import("./config");
  assert.equal(
    config.CLAUDE_HOME,
    process.env.CLAUDE_HOME,
    "config was already loaded by another test file in this process — refusing " +
      "to scan the real transcript tree",
  );
  assert.equal(config.TRANSCRIPT_CACHE_MAX_ENTRIES, BOUND);

  transcripts = await import("./transcripts");
  windows = await import("./windows");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the transcript cache is bounded", () => {
  it("drops a transcript that is no longer on disk", async () => {
    const dir = writeSession("session-transient", TURNS_PER_FILE, NOW - HOUR);

    const withFile = await transcripts.scanUsage();
    assert.equal(withFile.entries.length, TURNS_PER_FILE);
    assert.deepEqual(transcripts.transcriptCacheStats().files, 1);
    assert.deepEqual(transcripts.transcriptCacheStats().entries, TURNS_PER_FILE);

    fs.rmSync(dir, { recursive: true, force: true });
    const without = await transcripts.scanUsage();

    assert.equal(without.entries.length, 0);
    // A deleted transcript is never visited again, so its records are retention
    // with nothing behind it — invisible in every scan result and permanent.
    assert.equal(
      transcripts.transcriptCacheStats().entries,
      0,
      "a deleted transcript's turns are still cached",
    );
    assert.equal(transcripts.transcriptCacheStats().files, 0);
  });

  it("holds no more parsed turns than the bound, however much is on disk", async () => {
    writeTree();
    const scan = await transcripts.scanUsage();

    assert.equal(
      scan.entries.length,
      FILES * TURNS_PER_FILE,
      "the scan itself must still answer with everything it read",
    );

    const stats = transcripts.transcriptCacheStats();
    assert.equal(stats.maxEntries, BOUND);
    assert.ok(
      stats.entries <= BOUND,
      `cache holds ${stats.entries} turns against a bound of ${BOUND} — ` +
        `retention is still a function of cumulative history`,
    );
    assert.ok(
      stats.evictions > 0,
      "nothing was evicted, so the bound was never actually reached",
    );
  });

  it("re-derives what it evicted, so a second scan reads the same windows", async () => {
    const first = await transcripts.scanUsage();
    const before = snapshotOf(first.entries);
    assert.ok(
      transcripts.transcriptCacheStats().entries < first.entries.length,
      "the cache is still holding the whole scan, so this proves nothing",
    );

    // Every file dropped above has to be re-read from byte 0 and re-parsed for
    // this to come back with the same turns in it.
    const second = await transcripts.scanUsage();
    const after = snapshotOf(second.entries);

    assert.deepEqual(
      second.entries.map((e) => e.key).sort(),
      first.entries.map((e) => e.key).sort(),
    );

    // The two windows a guard reads. Costs and counts rather than fractions: no
    // ceiling is configured here, so a fraction is null on both sides and would
    // compare equal however wrong the totals underneath it were.
    assert.equal(after.session.costUSD, before.session.costUSD);
    assert.equal(after.session.agg.costGuardUSD, before.session.agg.costGuardUSD);
    assert.equal(after.session.agg.entryCount, before.session.agg.entryCount);
    assert.equal(after.session.tokens, before.session.tokens);
    assert.equal(after.weekly.costUSD, before.weekly.costUSD);
    assert.equal(after.weekly.agg.costGuardUSD, before.weekly.agg.costGuardUSD);
    assert.equal(after.weekly.agg.entryCount, before.weekly.agg.entryCount);
    assert.equal(after.weekly.tokens, before.weekly.tokens);

    assert.ok(
      after.weekly.costUSD > after.session.costUSD && after.session.costUSD > 0,
      "the fixture no longer straddles the 5-hour boundary, so the two windows " +
        "carry one total between them and the comparison above is one assertion",
    );
    assert.ok(transcripts.transcriptCacheStats().entries <= BOUND);
  });
});
