import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gutterDigits, patchRows } from "./patch";

/**
 * The diff's gutter is a number an operator opens a file at, and every way of
 * deriving it wrongly is silent: a deletion that also advances the new side, a
 * second hunk numbered on from the first rather than from its own header, or a
 * `--- a/file` header read as a deleted line. None of them throw, none of them
 * look wrong, and all of them name lines that hold something else.
 */

/** Rows that carry a number, as `[old, new, text]`, which is all this decides. */
function numbered(patch: string) {
  return patchRows(patch)
    .filter((r) => r.oldLine !== null || r.newLine !== null)
    .map((r) => [r.oldLine, r.newLine, r.text]);
}

test("a deletion advances only the old side and an addition only the new", () => {
  const patch = [
    "@@ -10,4 +10,4 @@ function go() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    " const c = 4;",
    "",
  ].join("\n");

  assert.deepEqual(numbered(patch), [
    [10, 10, " const a = 1;"],
    [11, null, "-const b = 2;"],
    [null, 11, "+const b = 3;"],
    [12, 12, " const c = 4;"],
  ]);
});

test("a second hunk restarts from its own header, not from the first", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    " one",
    "-two",
    "+TWO",
    "@@ -80,2 +80,2 @@",
    " eighty",
    "+eighty-one",
    "",
  ].join("\n");

  assert.deepEqual(numbered(patch), [
    [1, 1, " one"],
    [2, null, "-two"],
    [null, 2, "+TWO"],
    [80, 80, " eighty"],
    [null, 81, "+eighty-one"],
  ]);
});

test("the file header is meta, and a deleted line that looks like one is not", () => {
  const patch = [
    "diff --git a/README.md b/README.md",
    "index 1111111..2222222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -3,3 +3,3 @@",
    "---- a/old.txt",
    "+++ b/new.txt",
    " tail",
    "",
  ].join("\n");

  const rows = patchRows(patch);
  assert.deepEqual(
    rows.slice(0, 4).map((r) => r.kind),
    ["meta", "meta", "meta", "meta"],
  );
  assert.equal(rows[4].kind, "hunk");
  // Inside the hunk the prefixes mean what a hunk says they mean, whatever the
  // rest of the line spells.
  assert.deepEqual(
    rows.slice(5).map((r) => [r.kind, r.oldLine, r.newLine]),
    [
      ["del", 3, null],
      ["add", null, 3],
      ["context", 4, 4],
    ],
  );
});

test("a second file's header closes the hunk before it", () => {
  const patch = [
    "@@ -1,1 +1,1 @@",
    "-a",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -5,1 +5,1 @@",
    "+b",
    "",
  ].join("\n");

  assert.deepEqual(
    patchRows(patch).map((r) => [r.kind, r.oldLine, r.newLine]),
    [
      ["hunk", null, null],
      ["del", 1, null],
      ["meta", null, null],
      ["meta", null, null],
      ["meta", null, null],
      ["hunk", null, null],
      ["add", null, 5],
    ],
  );
});

test("no-newline markers belong to neither side", () => {
  const patch = ["@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+a", ""].join(
    "\n",
  );

  assert.deepEqual(
    patchRows(patch).map((r) => [r.kind, r.oldLine, r.newLine]),
    [
      ["hunk", null, null],
      ["del", 1, null],
      ["note", null, null],
      ["add", null, 1],
    ],
  );
});

test("the trailing newline is not a context line", () => {
  // Counted, it would advance both sides and put every later file out by one.
  const rows = patchRows("@@ -1,1 +1,1 @@\n one\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].oldLine, 1);
});

test("the gutter is sized by the widest number, and is nothing without one", () => {
  assert.equal(gutterDigits(patchRows("@@ -998,2 +1200,2 @@\n a\n b\n")), 4);
  assert.equal(gutterDigits(patchRows("diff --git a/x b/x\nBinary files differ\n")), 0);
});
