import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  diffAsText,
  parseNameStatus,
  parseNumstat,
  selectForPatch,
  splitPatches,
  truncatePatch,
  type RunDiff,
} from "./diff";

/**
 * Covers the parsing and the budgeting, and only those.
 *
 * Every one of them fails silently and expensively. A mis-parsed record shifts
 * every following file by one, so a rename in the middle of a change renames
 * the file list from there on — and a reviewer then writes a confident report
 * about work that happened somewhere else. The budget is the no-silent-caps
 * rule made executable: a diff that quietly shows twelve of forty files reads
 * as a run that touched twelve.
 */

/* ------------------------------------------------------------------ */
/* Parsing git's NUL-separated records                                 */
/* ------------------------------------------------------------------ */

describe("parseNumstat", () => {
  it("reads plain, renamed and binary records in one stream", () => {
    // Captured from `git diff --numstat -z -M`: a rename spends three fields
    // (empty tail, old path, new path) where a plain change spends one.
    const raw =
      "1\t0\tadded.txt\0" +
      "1\t1\tf.txt\0" +
      "0\t0\t\0keep.txt\0kept.txt\0" +
      "-\t-\tlogo.png\0";

    assert.deepEqual(parseNumstat(raw), [
      { path: "added.txt", oldPath: null, added: 1, deleted: 0 },
      { path: "f.txt", oldPath: null, added: 1, deleted: 1 },
      { path: "kept.txt", oldPath: "keep.txt", added: 0, deleted: 0 },
      // `-` is binary, not zero: a binary file has no line counts at all, and
      // reporting it as +0 −0 would say it did not change.
      { path: "logo.png", oldPath: null, added: null, deleted: null },
    ]);
  });

  it("keeps a path containing a tab intact", () => {
    // The reason -z exists. Splitting the record on every tab would truncate
    // this to "odd" and quietly diff a file that does not exist.
    const parsed = parseNumstat("2\t3\todd\tname.txt\0");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].path, "odd\tname.txt");
  });

  it("stops rather than inventing a path when a rename record is cut short", () => {
    assert.deepEqual(parseNumstat("0\t0\t\0keep.txt\0"), []);
  });
});

describe("parseNameStatus", () => {
  it("keys renames by their new path", () => {
    const map = parseNameStatus("A\0added.txt\0M\0f.txt\0R100\0keep.txt\0kept.txt\0");
    assert.equal(map.get("added.txt"), "added");
    assert.equal(map.get("f.txt"), "modified");
    assert.equal(map.get("kept.txt"), "renamed");
    // The old path is not a changed file in its own right.
    assert.equal(map.get("keep.txt"), undefined);
  });
});

/* ------------------------------------------------------------------ */
/* Splitting one diff into per-file patches                            */
/* ------------------------------------------------------------------ */

describe("splitPatches", () => {
  const patch = [
    "diff --git a/one.txt b/one.txt",
    "index 111..222 100644",
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/two.txt b/two.txt",
    "index 333..444 100644",
    "--- a/two.txt",
    "+++ b/two.txt",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\n");

  it("splits on file headers, in emission order", () => {
    const chunks = splitPatches(patch);
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].startsWith("diff --git a/one.txt"));
    assert.ok(chunks[1].startsWith("diff --git a/two.txt"));
  });

  it("does not split on a header inside a hunk", () => {
    // A file that itself contains a diff. Every body line carries a prefix, so
    // the forged header arrives as "+diff --git …" and is not a seam. Splitting
    // here would file the rest of this file's hunk under a filename taken from
    // its own contents.
    const nested = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -0,0 +2 @@",
      "+diff --git a/evil.txt b/evil.txt",
      "+@@ -1 +1 @@",
    ].join("\n");
    assert.equal(splitPatches(nested).length, 1);
  });

  it("returns nothing for an empty diff", () => {
    assert.deepEqual(splitPatches(""), []);
  });
});

/* ------------------------------------------------------------------ */
/* Budgeting                                                           */
/* ------------------------------------------------------------------ */

describe("selectForPatch", () => {
  const file = (path: string, added: number, deleted = 0) => ({
    path,
    oldPath: null,
    added,
    deleted,
  });

  it("stops at the line budget and reports what it left out", () => {
    const { selected, omitted } = selectForPatch(
      [file("a", 40), file("b", 40), file("c", 40)],
      { maxFiles: 10, maxLines: 100, maxFileLines: 600 },
    );
    assert.deepEqual(
      selected.map((e) => e.path),
      ["a", "b"],
    );
    // Not dropped, not silently shortened — named, so the caller can say so.
    assert.deepEqual(
      omitted.map((e) => e.path),
      ["c"],
    );
  });

  it("charges a huge file only what its patch will actually cost", () => {
    // A 100k-line lockfile is truncated to maxFileLines before it is rendered,
    // so charging the budget its full size would push every later file out for
    // lines that are never shown.
    const { selected } = selectForPatch([file("lock", 100_000), file("src", 10)], {
      maxFiles: 10,
      maxLines: 100,
      maxFileLines: 50,
    });
    assert.deepEqual(
      selected.map((e) => e.path),
      ["lock", "src"],
    );
  });

  it("lets a binary file through without spending the budget", () => {
    const { selected, omitted } = selectForPatch(
      [{ path: "logo.png", oldPath: null, added: null, deleted: null }],
      { maxFiles: 10, maxLines: 0, maxFileLines: 600 },
    );
    assert.equal(selected.length, 1);
    assert.equal(omitted.length, 0);
  });
});

describe("truncatePatch", () => {
  it("says how much it dropped", () => {
    const cut = truncatePatch("a\nb\nc\nd", 2);
    assert.equal(cut.truncated, true);
    assert.match(cut.text, /2 more lines not shown/);
  });

  it("leaves a patch inside the limit exactly as it was", () => {
    const cut = truncatePatch("a\nb", 2);
    assert.deepEqual(cut, { text: "a\nb", truncated: false });
  });
});

/* ------------------------------------------------------------------ */
/* What the reviewer is shown                                          */
/* ------------------------------------------------------------------ */

describe("diffAsText", () => {
  const diff = (files: RunDiff["files"]): RunDiff => ({
    kind: "range",
    reason: null,
    base: "abc",
    branch: "uf/x-1",
    files,
    filesChanged: files.length,
    added: 0,
    deleted: 0,
    omittedPatches: 0,
    uncommitted: [],
    caveat: null,
  });

  const file = (path: string, patch: string | null) => ({
    path,
    oldPath: null,
    status: "modified" as const,
    added: 1,
    deleted: 0,
    binary: false,
    patch,
    patchTruncated: false,
  });

  it("names every file it could not include", () => {
    // The whole point. A reviewer handed a third of a change with no marker
    // writes a confident review of a change that did not happen.
    const out = diffAsText(diff([file("a", "+one"), file("b", "+two")]), 20);
    assert.equal(out.truncated, true);
    assert.equal(out.shown, 1);
    assert.match(out.text, /TRUNCATED: 1 of 2/);
    assert.match(out.text, /\bb\b/);
  });

  it("counts a file whose patch was already withheld as missing", () => {
    const out = diffAsText(diff([file("a", "+one"), file("big", null)]), 10_000);
    assert.equal(out.shown, 1);
    assert.equal(out.truncated, true);
    assert.match(out.text, /big/);
  });

  it("says nothing about truncation when everything fits", () => {
    const out = diffAsText(diff([file("a", "+one")]), 10_000);
    assert.equal(out.truncated, false);
    assert.doesNotMatch(out.text, /TRUNCATED/);
  });
});
