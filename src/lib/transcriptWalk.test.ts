import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { WALK_CONCURRENCY, listTranscriptFiles } from "./transcripts";

/**
 * Covers one thing: the directory walk that every transcript reading starts
 * from — that it overlaps its levels, that it still answers with exactly the
 * list the serial walk answered with, and in exactly that order.
 *
 * It earns a place here on `transcriptScan.test.ts`'s grounds. The walk was
 * serial because it recursed inside its own dirent loop, which measured 105-121
 * ms against this install's tree while everything it feeds — 1,174 `fs.stat`,
 * the cross-file dedupe, the sort — came to 20 ms; it is the bulk of
 * `GET /api/usage`, of a warm `/api/status`, and of every pre-cycle budget
 * guard. Making it level-parallel is a one-line change with two silent failure
 * modes behind it, and neither throws or fails to typecheck.
 *
 * The first is the order. `runScan` resolves a shared dedupe key by keeping the
 * record with the most output, so file order decides which record survives a
 * tie, and `Array.prototype.sort` is stable, so it also decides where two turns
 * sharing a millisecond land. The obvious implementation of "run each level
 * concurrently" emits every root-level transcript before any nested one, which
 * is a different list in the same order-insensitive-looking wrapper — dollar
 * figures that are all still plausible. So the walk is compared against a
 * depth-first reference here rather than against a written-down list, and one
 * case pins the single fact that separates the two shapes.
 *
 * The second is the fan-out. A `readdir` holds a directory handle, so the walk
 * has a descriptor bound of its own, and it can overlap a scan's:
 * `readCompactions` walks once per work cycle while `runScan` is reading files.
 * Both directions are asserted, because a limit is not the same thing as
 * reading one directory at a time and serialising would satisfy the bound while
 * being the thing this change exists to remove.
 *
 * `fsPromises.readdir` is replaced module-wide to count the overlap and to
 * refuse one directory, which is `transcriptScan.test.ts`'s device for counting
 * descriptors. It also hands the dirents back sorted, so the tree below has one
 * order rather than the filesystem's: what is under test is that the walk
 * *preserves* the order it is given, not what that order is.
 */

/** Files written under the fixture root, relative, in creation order. */
const TRANSCRIPTS = [
  "a.jsonl",
  "b-dir/b1.jsonl",
  "b-dir/b2.jsonl",
  "b-dir/b-sub/b1a.jsonl",
  "c.jsonl",
  "d-dir/d1.jsonl",
  "d-dir/d-sub/d-deeper/deep.jsonl",
  "e.jsonl",
  // A *directory* whose name ends in `.jsonl`. The walk must descend into it
  // rather than list it, which `isDirectory()` is tested before `isFile()` for.
  "looks-like.jsonl/inner.jsonl",
];

/** Written and not expected back: the walk lists `.jsonl` files only. */
const NOT_TRANSCRIPTS = ["notes.txt", "b-dir/notes.md", "d-dir/d1.jsonl.bak"];

/**
 * Subdirectories of `wide/`, one transcript each.
 *
 * Comfortably more than `WALK_CONCURRENCY`, so the bound below is a bound on
 * something rather than on a level that was never wide enough to reach it.
 */
const WIDE = 20;

let root: string;

/** Directories inside `fsPromises.readdir` at once, and the peak of that. */
let readingNow = 0;
let peakReading = 0;
/** A directory `readdir` should refuse, standing in for a permission failure. */
let refuseReaddirOf: string | null = null;
const realReaddir = fsPromises.readdir;

function write(rel: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "");
}

/**
 * The walk as it was before it ran its levels concurrently: recurse in dirent
 * order, emitting a subtree where its directory sat.
 *
 * Kept as the expectation rather than a written-down list of paths, because it
 * is the property that has to hold — the parallel walk answers with what the
 * serial one answered with — and a list would have to be re-derived by hand
 * every time the fixture gained a file.
 */
function serialWalk(dir: string): string[] {
  const out: string[] = [];
  const dirents = [...fs.readdirSync(dir, { withFileTypes: true })].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...serialWalk(full));
    else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-transcript-walk-"));
  for (const rel of TRANSCRIPTS) write(rel);
  for (const rel of NOT_TRANSCRIPTS) write(rel);
  for (let i = 0; i < WIDE; i++) write(`wide/w${String(i).padStart(2, "0")}/w.jsonl`);
  // An empty directory: it contributes nothing and must not fail the level it
  // is read on.
  fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true });

  (fsPromises as unknown as { readdir: unknown }).readdir = async (
    ...args: unknown[]
  ) => {
    if (refuseReaddirOf !== null && args[0] === refuseReaddirOf) {
      throw Object.assign(
        new Error(`EACCES: permission denied, scandir '${String(args[0])}'`),
        { code: "EACCES" },
      );
    }
    readingNow += 1;
    if (readingNow > peakReading) peakReading = readingNow;
    try {
      const dirents = await (
        realReaddir as unknown as (...a: unknown[]) => Promise<fs.Dirent[]>
      )(...args);
      return [...dirents].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } finally {
      readingNow -= 1;
    }
  };
});

after(() => {
  (fsPromises as unknown as { readdir: unknown }).readdir = realReaddir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the transcript walk", () => {
  it("lists every transcript under the tree and nothing else", async () => {
    const { files, failures } = await listTranscriptFiles(root);

    assert.deepEqual(failures, []);
    assert.deepEqual(
      [...files].sort(),
      [...TRANSCRIPTS.map((rel) => path.join(root, rel))]
        .concat(
          Array.from({ length: WIDE }, (_, i) =>
            path.join(root, `wide/w${String(i).padStart(2, "0")}/w.jsonl`),
          ),
        )
        .sort(),
    );
  });

  it("answers in the order the depth-first walk answered in", async () => {
    const { files } = await listTranscriptFiles(root);

    assert.deepEqual(
      files,
      serialWalk(root),
      "the file list decides which of two records sharing a dedupe key survives " +
        "and where two turns sharing a millisecond sort — a reordering moves " +
        "money silently",
    );

    // The one fact that separates a depth-first list from a level-order one,
    // pinned on its own: `c.jsonl` sits in the root and `b-sub/b1a.jsonl` three
    // levels down, so a walk that emitted each level as it finished would put
    // every root transcript first and this pair the other way round.
    assert.ok(
      files.indexOf(path.join(root, "b-dir/b-sub/b1a.jsonl")) <
        files.indexOf(path.join(root, "c.jsonl")),
      "the walk emitted its levels in the order they completed rather than " +
        "reassembling them depth-first",
    );
  });

  it("reads several directories at once, and no more than the limit", async () => {
    peakReading = 0;
    await listTranscriptFiles(root);

    assert.ok(
      peakReading > 1,
      "the walk read one directory at a time — each level waits for the last, " +
        "which is the cost that dominates every usage reading",
    );
    assert.ok(
      peakReading <= WALK_CONCURRENCY,
      `${peakReading} directories were open at once against a limit of ` +
        `${WALK_CONCURRENCY} — a walk overlapping a scan must stay well inside ` +
        `the descriptor limit, past which reads fail and the scan silently ` +
        `understates every window`,
    );
    assert.equal(readingNow, 0, "a readdir was left in flight");
  });

  it("reports an unreadable directory rather than answering short", async () => {
    refuseReaddirOf = path.join(root, "b-dir");
    try {
      const { files, failures } = await listTranscriptFiles(root);

      assert.equal(failures.length, 1, "the failed readdir was swallowed");
      assert.equal(failures[0].path, path.join(root, "b-dir"));
      assert.match(failures[0].message, /EACCES/);

      // And the list really is short, which is the whole reason the failure has
      // to travel beside it: `runScan` skips its cache pruning on any walk
      // failure precisely because a directory that could not be read is not an
      // empty one.
      assert.ok(!files.some((f) => f.startsWith(path.join(root, "b-dir"))));
      assert.ok(files.includes(path.join(root, "c.jsonl")));
    } finally {
      refuseReaddirOf = null;
    }
  });

  it("treats a missing root as an empty tree, not a failure", async () => {
    // The ordinary state of a fresh install, and the one `readdir` error that
    // says nothing about how much history was hidden.
    const { files, failures } = await listTranscriptFiles(path.join(root, "gone"));

    assert.deepEqual(files, []);
    assert.deepEqual(failures, []);
  });
});
