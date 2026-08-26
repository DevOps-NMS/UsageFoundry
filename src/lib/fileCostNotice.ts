import fs from "node:fs";
import path from "node:path";

import { db } from "./db";

/**
 * What a `Read` of this repository's largest files costs, told to the agent
 * *before* it reads one.
 *
 * ## Why this is worth spending tokens on
 *
 * Measured over this machine's own transcripts — 1,209 files, 49,885 deduped
 * turns, $6,626 over 12.4 days, priced through `pricing.ts` — the bill splits
 * **60.7% cache read, 26.3% cache write, 12.9% output and 0.1% input**. Six
 * sevenths of what this fleet spends is carrying context rather than generating
 * anything, and `DELEGATION_NOTICE` next door states the mechanism: nothing
 * shrinks a main thread, so a file read on turn 12 is paid for again on every
 * turn after it. The share of that re-read bill attributable to `Read`
 * specifically — about two fifths, from the replay this feature was proposed on
 * — is *not* re-measured here, so treat the size of the win as an estimate and
 * the direction as measured.
 *
 * The individual numbers are the argument. `src/lib/orchestrator.ts` in this
 * repository is about 116,000 tokens and this fleet read it 496 times across 78
 * runs; `src/lib/workflows.ts` is 68,000 over 185 reads; `docs/verification.md`
 * 57,000 over 75. One avoided full read of the first is worth about $3.19 — the
 * read itself, the roughly 35 later turns that re-read it at the cache rate, and
 * the 1h cache write behind it. This notice costs about 400 tokens on every turn
 * of every cycle, which is roughly $7 across a corpus that size. Avoiding one
 * read in ten pays for it about twenty times over.
 *
 * An agent cannot price a file it has not opened, and nothing in the CLI tells
 * it. This app can: it has the repository on disk and it has `run_events`, which
 * records every tool call this fleet has ever made with its input. So the price
 * list is something only the supervisor can write, which is why it is written
 * here rather than left to a habit the model is asked to acquire.
 *
 * ## Why it is frozen on the run's row, and why that is not an optimisation
 *
 * **The appended system prompt is part of the cached prefix.** If this text
 * differed between cycle 1 and cycle 2 of the same run, every token behind it
 * would be cold on cycle 2 — and on a 190,000-token context that is far more
 * than the notice could ever save. This feature is a net *loss* the moment the
 * text drifts within a run.
 *
 * Two things make it drift if it is recomputed per cycle, and both are certain
 * rather than hypothetical: the read counts below move as the fleet works, and
 * the file sizes move as this very run edits files. So it is generated **once**,
 * when the run is created, and stored on `runs.file_cost_notice` — the treatment
 * `runs.agent` gets and for a related reason, that a run's later cycles must be
 * given exactly what its first cycle was given. Every cycle then puts the
 * *stored* text on the argv.
 *
 * Do not "improve" this into a per-cycle recomputation. A fresher list is worth
 * a few cents; a cold prefix costs dollars per cycle, and nothing about the run
 * would look wrong while it happened.
 *
 * ## What it deliberately does not do
 *
 * It names no command. `SELF_HOSTING_NOTICE` records what happens when a literal
 * on the appended prompt is *offered as a pattern*: a port number in a worked
 * `pgrep -f` example matched every sibling agent, because that string is on
 * every sibling's command line. The paths here are the same kind of shared
 * literal — every run on this repository carries them — so the property that
 * makes them safe is that nothing here suggests selecting a process with one.
 * They are repo-relative, they sit in a price list, and no verb near them is
 * `kill`. The case named "offers no literal as a thing to run" in
 * `fileCostNotice.test.ts` pins that, and `SELF_HOSTING_NOTICE`'s own sentence
 * about literals is scoped to the whole appended prompt, so it already covers
 * this half.
 */

/**
 * Bytes per token, for turning a `stat` into a price.
 *
 * Calibrated rather than assumed, against three files whose real token counts
 * were counted in this repository's own transcript replay:
 * `src/lib/orchestrator.ts` 424,940 bytes / 116,000 tokens, `workflows.ts`
 * 246,897 / 68,306, `docs/verification.md` 204,746 / 56,614 — 3.66, 3.61 and
 * 3.62. TypeScript and English prose land in the same place here, which is why
 * one number does for both.
 *
 * It is an estimate offered as an estimate. The notice rounds to thousands and
 * says "about", because a figure carrying more precision than this ratio has
 * would be read as a measurement of the file rather than as a price.
 */
export const BYTES_PER_TOKEN = 3.6;

/**
 * The size below which a file is not worth a line.
 *
 * A full `Read` of a 10,000-token file costs a few cents carried forward; below
 * that the advice would be noise, and every line spent on a small file is a line
 * re-read on every turn. The notice states the floor so that a file's *absence*
 * is information rather than an omission.
 */
export const MIN_LISTED_TOKENS = 10_000;

/** How many files the list may name. */
export const MAX_LISTED_FILES = 24;

/**
 * The hard ceiling on the rendered notice, in characters.
 *
 * ~2,400 characters is ~670 tokens at the ratio above, and the list is expected
 * to come in well under it. It exists because this text rides every turn of
 * every cycle: a repository with very long paths must cost the run a shorter
 * list, never a bigger prompt. Truncation drops whole lines from the cheap end,
 * so what survives is always the part worth having.
 */
export const MAX_NOTICE_CHARS = 2_400;

/**
 * How far back the read history is asked about.
 *
 * A freshness bound before it is a performance one: what this fleet opened three
 * months ago is not what it opens now, and a stale count would rank a file the
 * repository has since stopped caring about. It also keeps the scan off the hot
 * path in `createRun` — `run_events` has no index on `kind`, and an install that
 * never prunes would otherwise make run creation slower every week.
 */
export const READ_HISTORY_DAYS = 30;

/**
 * Directories the walk never descends into.
 *
 * Not a gitignore reader: this is a price list, and a dependency tree or a build
 * output is not something an agent should be *invited* to read whole by seeing
 * it priced. `.git` is the one that matters for cost — it is usually the largest
 * thing under the folder and none of it is a file anybody reads.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  "out",
]);

/**
 * Extensions a `Read` does not return text for, so a size is not a price.
 *
 * Short on purpose. Anything not here is treated as text, which is the safe
 * direction: over-listing costs a line, while omitting a large text file loses
 * exactly the read this notice exists to price.
 */
const SKIP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp4",
  ".map",
]);

/**
 * The most directory entries the walk will look at.
 *
 * `createRun` runs from entry to INSERT with no `await`, so this walk is
 * synchronous and holds the event loop for as long as it takes. A repository is
 * a few hundred files once the skip list has done its work; a mount pointed at
 * something enormous must cost a truncated list rather than a stalled server.
 */
const MAX_WALK_ENTRIES = 20_000;

/** A file the walk found, with its size on disk. */
export interface RepoFile {
  /** Path relative to the folder that was walked, with `/` separators. */
  path: string;
  bytes: number;
}

/** A file the notice may name, with what a full `Read` of it costs. */
export interface PricedFile {
  path: string;
  /** Estimated tokens, rounded to the nearest thousand. */
  tokens: number;
}

/** Estimated tokens for a file of `bytes`, rounded to the nearest thousand. */
export function estimateTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / BYTES_PER_TOKEN / 1_000) * 1_000;
}

/**
 * Which files earn a line, and in what order.
 *
 * Ranked on **expected cost** — the price of a read times how often this fleet
 * has actually made one — rather than on size alone, because size alone lists
 * the wrong files. A lockfile is enormous and nobody opens it; `docs/*.md` is
 * opened constantly and a size ranking buries it under generated data. The read
 * history is the one input no other tool has, and this is what it is for.
 *
 * `reads + 1` rather than `reads` so that a large file with no history still
 * ranks by its price: the +1 is the read this run may be about to make. A
 * repository this app has never run in therefore degrades to a pure size
 * ranking, which is the correct answer when there is nothing else to know.
 *
 * The rendering order is size, not expected cost. What the agent is reading is a
 * price list, and a price list that is not sorted by price reads as arbitrary.
 */
export function priceFiles(
  files: readonly RepoFile[],
  reads: ReadonlyMap<string, number>,
): PricedFile[] {
  const priced = files
    .map((file) => ({ path: file.path, tokens: estimateTokens(file.bytes) }))
    .filter((file) => file.tokens >= MIN_LISTED_TOKENS);

  const expected = (file: PricedFile) => file.tokens * ((reads.get(file.path) ?? 0) + 1);

  // `sort` twice over copies rather than in place: `files` is the caller's array
  // and reordering it would make a second call on the same input a different
  // question from the first, which is exactly the drift this must not have.
  const byExpectedCost = [...priced].sort(
    (a, b) => expected(b) - expected(a) || a.path.localeCompare(b.path),
  );
  return byExpectedCost
    .slice(0, MAX_LISTED_FILES)
    .sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
}

/**
 * The notice itself, or `""` when there is nothing worth saying.
 *
 * Empty rather than a preamble with no list under it: a run told "the largest
 * files are:" and then given nothing has been handed a puzzle, and an empty
 * string is what `buildArgs` drops from the joined prompt entirely, leaving the
 * argv byte-identical to an install that never had this feature.
 *
 * The wording spends its tokens on the *mechanism* rather than on the
 * instruction, for `SELF_HOSTING_NOTICE`'s reason: an agent told only "avoid big
 * reads" trades this cost for a worse one — ten partial reads of the same file,
 * or a guess where it should have looked. Saying that a read is paid for again
 * on every later turn is what makes the cheaper tool the obvious one.
 */
export function renderFileCostNotice(files: readonly PricedFile[]): string {
  if (files.length === 0) return "";

  // One clause for the mechanism rather than two sentences, because
  // `DELEGATION_NOTICE` states the same thing immediately above this in the
  // joined `--append-system-prompt` — and it is stated here at all, rather than
  // leaned on there, because a cross-reference would break silently if that
  // join order ever changed. What may not go is the *claim*: an agent told only
  // that a file is large avoids it, where one told the read is paid for again
  // on every later turn reaches for Grep instead.
  const head =
    "Before you read a file whole, know what it costs: a read here is re-read " +
    "on every later turn of the cycle, so a large file is a tax on the rest of " +
    "it rather than a one-off charge. These are the largest files in this " +
    "repository and roughly what a full read of each adds, in tokens. Figures " +
    "are estimates from file size, taken when this run was created, and go " +
    "stale as the work changes them. Files smaller than " +
    `${MIN_LISTED_TOKENS / 1_000}k are not listed.`;

  const tail =
    "For a definition, a symbol or one region of a listed file, prefer Grep or " +
    "Glob, or Read with offset and limit, and read it whole only when you " +
    "actually mean to spend that.";

  const lines: string[] = [];
  let used = head.length + tail.length + 4;
  for (const file of files) {
    const line = `  ${file.path} — ${file.tokens / 1_000}k`;
    if (used + line.length + 1 > MAX_NOTICE_CHARS) break;
    used += line.length + 1;
    lines.push(line);
  }
  if (lines.length === 0) return "";

  return `${head}\n${lines.join("\n")}\n${tail}`;
}

/**
 * How long a folder's read counts stand before they are asked for again.
 *
 * The query underneath is a full scan of `run_events` — 38ms against 131,572
 * rows here, measured in process rather than through `docker exec` — and its
 * caller sits inside `createRun`'s no-`await` window, which is the whole server
 * for as long as it runs. One run pays that once; a workflow instantiating
 * twenty nodes is one synchronous pass through `createRun` and would pay it
 * twenty times, blocking the event loop for the sum.
 *
 * Staleness costs nothing here, which is what makes a cache the right answer
 * rather than an index: this ranks a price list over thirty days of history, so
 * a minute-old ranking and a fresh one differ only in files nobody has read
 * since. An index would move the cost onto every `run_events` insert instead,
 * and that table is written on every tool call of every cycle — far the busier
 * side of the trade.
 */
const READ_COUNTS_TTL_MS = 60_000;

const readCounts = ((globalThis as unknown as {
  __ufReadCounts?: { byFolder: Map<string, { at: number; value: Map<string, number> }> };
}).__ufReadCounts ??= { byFolder: new Map() });

/**
 * How often this fleet has read each file of `folder`, over the last
 * `READ_HISTORY_DAYS`.
 *
 * Keyed on `runs.folder` rather than on `repo_root`, and that is the difference
 * between a working query and an empty one: most runs work in a worktree, so
 * their recorded paths are under `runs.work_dir` and share no prefix with the
 * repository root at all. `folder` is the one column that is the same for every
 * run the operator pointed at this directory, however each of them was isolated.
 * The stored path is then made relative to whichever of the two the event's own
 * run had, which is what lines a worktree's read up with a file on disk here.
 */
export function readCountsFor(folder: string, now = Date.now()): Map<string, number> {
  const cached = readCounts.byFolder.get(folder);
  if (cached && now - cached.at < READ_COUNTS_TTL_MS) return cached.value;

  const rows = db()
    .prepare(
      `SELECT rel, COUNT(*) AS n FROM (
         SELECT CASE
           WHEN instr(json_extract(e.payload, '$.input.file_path'),
                      COALESCE(r.work_dir, r.folder) || '/') = 1
             THEN substr(json_extract(e.payload, '$.input.file_path'),
                         length(COALESCE(r.work_dir, r.folder)) + 2)
           WHEN instr(json_extract(e.payload, '$.input.file_path'), r.folder || '/') = 1
             THEN substr(json_extract(e.payload, '$.input.file_path'),
                         length(r.folder) + 2)
           ELSE NULL
         END AS rel
         FROM run_events e
         JOIN runs r ON r.id = e.run_id
         WHERE e.kind = 'tool'
           AND e.ts >= ?
           AND r.folder = ?
           AND json_extract(e.payload, '$.name') = 'Read'
       )
       WHERE rel IS NOT NULL
       GROUP BY rel`,
    )
    .all(now - READ_HISTORY_DAYS * 24 * 60 * 60 * 1000, folder) as {
    rel: string;
    n: number;
  }[];

  const counts = new Map(rows.map((row) => [row.rel, row.n]));
  readCounts.byFolder.set(folder, { at: now, value: counts });
  return counts;
}

/**
 * Walk `root` for files worth pricing.
 *
 * Synchronous because its one caller is inside `createRun`'s no-`await` window,
 * and bounded by `MAX_WALK_ENTRIES` because that window is also the whole
 * server. A directory that cannot be read is skipped rather than thrown from:
 * this is a price list, and half a list is a better answer than a run that
 * refuses to be created because one folder is 0700.
 */
function walkRepo(root: string): RepoFile[] {
  const files: RepoFile[] = [];
  const queue: string[] = [root];
  let seen = 0;

  while (queue.length > 0 && seen < MAX_WALK_ENTRIES) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
        continue;
      }
      // Symlinks are skipped rather than followed: a link out of the mount is
      // not a file of this repository, and following one is how a bounded walk
      // stops being bounded.
      if (!entry.isFile()) continue;
      if (SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = fs.statSync(full);
        if (estimateTokens(stat.size) >= MIN_LISTED_TOKENS) {
          files.push({ path: path.relative(root, full), bytes: stat.size });
        }
      } catch {
        continue;
      }
    }
  }

  return files;
}

/**
 * The frozen notice for a run about to be created in `folder`, or `""`.
 *
 * Every failure here degrades to `""`, and that is the contract rather than
 * laziness: this is a cost hint, `createRun` is the one door every run in this
 * app comes through, and a run that cannot be created because a price list could
 * not be built would be this feature costing infinitely more than it saves. An
 * unreadable folder, a database without the events table, a mount that has gone
 * — all of them mean the same thing, which is that this run is spawned exactly
 * as it would have been before this file existed.
 */
export function fileCostNotice(folder: string): string {
  try {
    const files = walkRepo(folder);
    if (files.length === 0) return "";
    let reads: Map<string, number>;
    try {
      reads = readCountsFor(folder);
    } catch {
      // A missing or unreadable history is not a reason to withhold the list:
      // `priceFiles` degrades to a pure size ranking, which is what a repository
      // this app has never run in gets anyway.
      reads = new Map();
    }
    return renderFileCostNotice(priceFiles(files, reads));
  } catch {
    return "";
  }
}
