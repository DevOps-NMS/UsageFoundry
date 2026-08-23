import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

/**
 * The file price list, and the two ways it can be worse than not shipping it.
 *
 * Both are silent, which is the bar `docs/agent/testing.md` sets, and neither
 * shows up in a typecheck, a smoke test or the run's own log.
 *
 * **Drift is the expensive one.** This text joins `--append-system-prompt`,
 * which is part of the cached prefix, so a version of it that produced different
 * bytes for the same inputs would cold-start every token behind it on the next
 * cycle of the same run. The run still works. It just costs several dollars a
 * cycle more than it did, for a notice worth a few cents.
 * `runs.file_cost_notice` is what freezes it across cycles; what is asserted
 * here is the other half — that the generator itself carries no order-dependence
 * and no clock, so freezing a *deterministic* function is what that column is
 * actually doing.
 *
 * **Bloat is the quiet one.** Every character here is re-read on every turn of
 * every cycle, so a repository with very long paths has to cost the run a
 * shorter list rather than a bigger prompt — and a notice that grew past its
 * budget would look exactly like one that did not.
 *
 * The rest of the file pins the degradations, because the alternative to a price
 * list is not a broken run: it is the run this app spawned last week. Every
 * failure has to land there rather than on a half-built list, or on a throw at
 * the one door every run in this app comes through.
 */

// A database of its own, set before the module is loaded. `DATA_DIR` falls back
// to `./.data` under the process's cwd, so a test that reached `db()` without
// this would write a SQLite file into whatever directory the suite was run from.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-filecost-")));
process.env.DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// `require`, not `import`, for the reason `orchestrator.test.ts` gives: imports
// are hoisted above the environment setup, and `config.ts` reads `DATA_DIR` once
// at load.
const {
  BYTES_PER_TOKEN,
  estimateTokens,
  fileCostNotice,
  MAX_LISTED_FILES,
  MAX_NOTICE_CHARS,
  MIN_LISTED_TOKENS,
  priceFiles,
  readCountsFor,
  renderFileCostNotice,
} = require("./fileCostNotice") as typeof import("./fileCostNotice");

type RepoFile = import("./fileCostNotice").RepoFile;

const bytesFor = (tokens: number) => Math.round(tokens * BYTES_PER_TOKEN);

const files: RepoFile[] = [
  { path: "src/lib/orchestrator.ts", bytes: bytesFor(116_000) },
  { path: "src/lib/workflows.ts", bytes: bytesFor(68_000) },
  { path: "docs/verification.md", bytes: bytesFor(57_000) },
  { path: "package-lock.json", bytes: bytesFor(90_000) },
  { path: "src/lib/small.ts", bytes: bytesFor(400) },
];

test("prices a file from its size, coarsely enough to read as a price", () => {
  // The rounding is the point, not the ratio. A figure carrying more precision
  // than a bytes-per-token estimate has would be read as a measurement of the
  // file, and an agent that treats it as one disbelieves the whole notice the
  // first time it counts.
  assert.equal(estimateTokens(bytesFor(116_412)) % 1_000, 0);
  assert.equal(estimateTokens(bytesFor(116_412)), 116_000);
  // Nothing pathological may become a price: an empty file, a failed stat and a
  // size that overflowed all have to come out as "not worth a line".
  for (const bytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(estimateTokens(bytes), 0);
  }
});

test("the same inputs produce the same bytes, whatever order they arrive in", () => {
  // The invariant the cached prefix rests on. The walk takes its order from
  // `readdirSync`, which is the filesystem's order and not a promise, so a
  // ranking that fell back on input order would produce two different notices
  // for one repository — and a run that got both would pay full price for a
  // 190,000-token context on its second cycle.
  const reads = new Map([["src/lib/orchestrator.ts", 496]]);
  const first = renderFileCostNotice(priceFiles(files, reads));
  const second = renderFileCostNotice(priceFiles([...files].reverse(), reads));
  assert.ok(first.length > 0, "these inputs must produce a notice at all");
  assert.equal(first, second);

  // Ties included: two files of the same size with the same history must not
  // swap places between two calls.
  const tied: RepoFile[] = [
    { path: "b.md", bytes: bytesFor(20_000) },
    { path: "a.md", bytes: bytesFor(20_000) },
  ];
  assert.equal(
    renderFileCostNotice(priceFiles(tied, new Map())),
    renderFileCostNotice(priceFiles([...tied].reverse(), new Map())),
  );
});

test("spends its lines on what the fleet actually reads, not on size alone", () => {
  // The one input no other tool has, and the reason this list is worth
  // generating rather than left to the model to guess at. Ranked on size alone
  // the lockfile and the generated data crowd out the module every run opens,
  // and a line spent on a file nobody reads is a line re-read on every turn.
  const crowd: RepoFile[] = Array.from({ length: MAX_LISTED_FILES + 6 }, (_, i) => ({
    path: `generated/data-${i}.json`,
    bytes: bytesFor(30_000),
  }));
  const opened = { path: "src/lib/orchestrator.ts", bytes: bytesFor(12_000) };
  const ranked = priceFiles([...crowd, opened], new Map([[opened.path, 496]]));
  assert.equal(ranked.length, MAX_LISTED_FILES);
  assert.ok(
    ranked.some((file) => file.path === opened.path),
    "a file this fleet opens constantly must survive the cap over bigger files it never opens",
  );

  // With no history at all — a repository this app has never run in — it has to
  // degrade to the price, which is then the only thing left to know.
  const cold = priceFiles(files, new Map()).map((file) => file.path);
  assert.deepEqual(cold.slice(0, 2), ["src/lib/orchestrator.ts", "package-lock.json"]);
});

test("names nothing smaller than the floor it tells the agent about", () => {
  // A file's absence has to be information. If the notice states a floor and
  // then lists something under it, the agent cannot read "not listed" as
  // "cheap", which is half of what the list buys.
  const priced = priceFiles(files, new Map());
  assert.equal(
    priced.some((file) => file.path === "src/lib/small.ts"),
    false,
  );
  for (const file of priced) assert.ok(file.tokens >= MIN_LISTED_TOKENS);
  assert.match(
    renderFileCostNotice(priced),
    new RegExp(`${MIN_LISTED_TOKENS / 1_000}k`),
    "the floor the list was built to must be the floor the list claims",
  );
});

test("stays inside its budget however long the paths are", () => {
  // The failure this exists for: a monorepo of deeply nested packages turning a
  // 400-token hint into a 3,000-token one, silently, on every turn of every
  // cycle of every run. Truncation drops whole lines from the cheap end rather
  // than clipping the last one, so what survives is always the part worth having
  // and never half a filename.
  const long: RepoFile[] = Array.from({ length: 200 }, (_, i) => ({
    path: `packages/${"nested/".repeat(12)}module-${i}/src/index.ts`,
    bytes: bytesFor(50_000 - i),
  }));
  const notice = renderFileCostNotice(priceFiles(long, new Map()));
  assert.ok(
    notice.length <= MAX_NOTICE_CHARS,
    `notice is ${notice.length} characters, over the ${MAX_NOTICE_CHARS} budget`,
  );
  const lines = notice.split("\n").filter((line) => line.startsWith("  "));
  assert.ok(lines.length > 0, "a budget met by listing nothing is not a price list");
  for (const line of lines) assert.match(line, /— \d+k$/, "a line was clipped mid-figure");

  // And the ordinary case is capped by count before it is capped by characters,
  // so a repository of a thousand large files still gets a readable list.
  const many: RepoFile[] = Array.from({ length: 1_000 }, (_, i) => ({
    path: `src/mod-${i}.ts`,
    bytes: bytesFor(20_000 + i),
  }));
  assert.equal(priceFiles(many, new Map()).length, MAX_LISTED_FILES);
});

test("is empty rather than half-built when there is nothing worth saying", () => {
  // A preamble with no list under it is a puzzle handed to the agent, and worse
  // than that at the argv: `buildArgs` drops an empty notice from the joined
  // prompt entirely, so empty is what keeps a run's command line byte-identical
  // to the one this app emitted before the feature existed.
  assert.equal(renderFileCostNotice([]), "");
  assert.equal(renderFileCostNotice(priceFiles([], new Map())), "");
  assert.equal(
    renderFileCostNotice(priceFiles([{ path: "tiny.ts", bytes: 40 }], new Map())),
    "",
  );
});

test("degrades to empty rather than throwing when the folder is unreadable", () => {
  // `fileCostNotice` is called from inside `createRun`, the one door every run
  // in this app comes through. A price hint that could refuse a run would be
  // this feature costing infinitely more than it saves, so every reading of a
  // broken folder has to be the same one: no notice, and a run spawned exactly
  // as it would have been.
  assert.equal(fileCostNotice(path.join(tmp, "no-such-folder-ever")), "");
  assert.equal(fileCostNotice(""), "");

  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });

  // An empty repository, and one whose only large file is inside a directory the
  // walk refuses to descend into. Both are "nothing worth pricing" rather than
  // "the walk failed", and both have to reach the argv the same way.
  assert.equal(fileCostNotice(repo), "");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "pack"), "x".repeat(bytesFor(80_000)));
  assert.equal(fileCostNotice(repo), "");

  // A path it cannot stat sits beside a file it can: the list comes back short,
  // never absent, because half a price list is worth more than none.
  fs.writeFileSync(path.join(repo, "big.md"), "x".repeat(bytesFor(40_000)));
  fs.symlinkSync(path.join(repo, "gone.md"), path.join(repo, "dangling.md"));
  const notice = fileCostNotice(repo);
  assert.match(notice, /big\.md — 40k/);
  assert.doesNotMatch(notice, /dangling/);
});

test("asks the event log a question it can answer", () => {
  // The read history is the half of the ranking that is SQL rather than
  // arithmetic, and a malformed query fails the way everything else here fails:
  // `fileCostNotice` catches it, the notice degrades to a size ranking, and
  // nothing anywhere says the fleet's own reading history stopped being
  // consulted. Running it against a migrated schema is what makes that a failed
  // test instead.
  assert.deepEqual([...readCountsFor("/workspace/nothing-ran-here")], []);
});

test("offers no literal as a thing to run", () => {
  /*
   * `SELF_HOSTING_NOTICE` records what happens when a literal on the appended
   * prompt is offered as a pattern: a port number in a worked `pgrep -f` example
   * matched every sibling agent, twice, because that string is on every
   * sibling's command line. The paths here are the same kind of shared literal —
   * every run on this repository carries them — so what makes them safe is that
   * nothing here reads as a command. This is what keeps it that way when
   * somebody later adds a helpful example.
   */
  const notice = renderFileCostNotice(priceFiles(files, new Map()));
  assert.doesNotMatch(notice, /\bp?kill(all)?\b|\bpgrep\b|\bps -|\$\(/);
  // Repo-relative, so nothing in the list is also a path on a sibling's
  // `--add-dir`, a mount root or a worktree.
  for (const line of notice.split("\n").filter((line) => line.startsWith("  "))) {
    assert.doesNotMatch(line, /^ {2}\//, "an absolute path names a mount, not a file");
  }
});
