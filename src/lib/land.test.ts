import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  conflictRegions,
  hasConflictMarkers,
  landRefusal,
  parseMergeTree,
  unresolvedFiles,
  type CheckoutState,
  type ConflictFile,
} from "./land";

/**
 * Covers the merge preview parser and the refusal decision, and only those.
 *
 * They are the two places where being wrong writes into a directory a person
 * owns. `parseMergeTree` reading a failure as "no conflicts" would offer a
 * merge that cannot work; `landRefusal` missing a branch would merge into a
 * dirty tree, or onto the wrong branch, and neither is something this app can
 * undo afterwards. `conflictRegions` earns its place for the reason
 * `hasConflictMarkers` does: it decides what counts as a conflict marker in
 * arbitrary file content, and a parser that fires on a markdown heading
 * underline renders half a document as a conflict.
 */

/* ------------------------------------------------------------------ */
/* Reading `git merge-tree --write-tree -z`                            */
/* ------------------------------------------------------------------ */

/** Records are NUL-separated, and the two sections are split by an empty one. */
const z = (...fields: string[]) => fields.join("\0");

describe("parseMergeTree", () => {
  it("reads exit 0 as a clean merge", () => {
    assert.deepEqual(parseMergeTree("<tree-oid>", "", 0), { outcome: "clean" });
  });

  it("lists each conflicting path once, with git's own account of it", () => {
    // Captured from git 2.50. The same path appears once per stage — base,
    // ours, theirs — and reporting "3 files conflict" for one file is a
    // sentence the operator would act on wrongly. `Auto-merging` is an
    // informational record like any other and is not a conflict.
    const stdout = z(
      "5452f5aaf2e2cb93837db0fc00ec78e4ca86d851",
      "100644 de98044 1\td.txt",
      "100644 343809c 2\td.txt",
      "100644 de98044 1\tf.txt",
      "100644 343809c 2\tf.txt",
      "100644 3b6f40a 3\tf.txt",
      "",
      "1",
      "d.txt",
      "CONFLICT (modify/delete)",
      "CONFLICT (modify/delete): d.txt deleted in feature and modified in main.\n",
      "1",
      "f.txt",
      "Auto-merging",
      "Auto-merging f.txt\n",
      "1",
      "f.txt",
      "CONFLICT (contents)",
      "CONFLICT (content): Merge conflict in f.txt\n",
      "",
    );

    const preview = parseMergeTree(stdout, "", 1);
    assert.equal(preview.outcome, "conflict");
    const files = preview.outcome === "conflict" ? preview.files : [];
    assert.deepEqual(
      files.map((f) => [f.path, f.type]),
      [
        ["d.txt", "modify/delete"],
        ["f.txt", "contents"],
      ],
    );
    // What survives is what the type and the path do not already say. For a
    // plain content clash that is nothing, and the regions below it are the
    // information.
    assert.match(files[0].message ?? "", /^d\.txt deleted in feature/);
    assert.equal(files[1].message, null);
    // Nothing has read the merged tree at this point, and "no regions" would
    // otherwise read as "this file has no clashes in it".
    assert.equal(files[0].regionsRead, false);
  });

  it("still lists the conflicting files when the messages make no sense", () => {
    // The stage records are the authoritative statement of what conflicts. The
    // informational section is another git version's format away from being
    // unreadable, and losing an annotation must not lose a file.
    const stdout = z(
      "5452f5aaf2e2cb93837db0fc00ec78e4ca86d851",
      "100644 de98044 1\tf.txt",
      "",
      "not-a-count",
      "garbage",
    );

    const preview = parseMergeTree(stdout, "", 1);
    assert.deepEqual(
      preview.outcome === "conflict" ? preview.files.map((f) => f.path) : [],
      ["f.txt"],
    );
  });

  it("does not read a git that is too old as a clean merge", () => {
    // `--write-tree` arrived in git 2.38, and the host's git is whatever the
    // host has. Treating "unknown option" as exit-code-not-1 and therefore fine
    // would offer a merge nothing had actually checked.
    const preview = parseMergeTree("", "error: unknown option `write-tree'", 129);
    assert.equal(preview.outcome, "unknown");
    assert.match(
      preview.outcome === "unknown" ? preview.reason : "",
      /too old/,
    );
  });

  it("reports any other failure rather than swallowing it", () => {
    const preview = parseMergeTree("", "fatal: not a valid object name", 128);
    assert.equal(preview.outcome, "unknown");
  });
});

/* ------------------------------------------------------------------ */
/* Deciding whether to write into the operator's checkout              */
/* ------------------------------------------------------------------ */

describe("landRefusal", () => {
  const clean: CheckoutState = {
    path: "/workspace/repo",
    headBranch: "main",
    dirty: false,
    readable: true,
  };

  const landable = {
    runStatus: "completed" as const,
    branchExists: true,
    target: "main",
    merged: false,
    landedUnchanged: false,
    ahead: 3,
    preview: { outcome: "clean" as const },
    checkout: clean,
  };

  it("allows the case everything is in order", () => {
    assert.equal(landRefusal(landable), null);
  });

  it("refuses while the run can still commit", () => {
    for (const runStatus of ["running", "queued", "paused"] as const) {
      assert.match(
        landRefusal({ ...landable, runStatus }) ?? "",
        /still active/,
        `${runStatus} should not be landable`,
      );
    }
  });

  it("refuses a dirty checkout", () => {
    assert.match(
      landRefusal({ ...landable, checkout: { ...clean, dirty: true } }) ?? "",
      /uncommitted changes/,
    );
  });

  it("treats an unreadable status as dirty", () => {
    // A `git status` that failed on a stray index.lock returns empty stdout,
    // which reads as clean. Merging then is exactly when it is least safe.
    const refusal = landRefusal({
      ...landable,
      checkout: { ...clean, dirty: true, readable: false },
    });
    assert.match(refusal ?? "", /Could not read/);
  });

  it("refuses when the operator is standing on a different branch", () => {
    const refusal = landRefusal({
      ...landable,
      checkout: { ...clean, headBranch: "feature/other" },
    });
    assert.match(refusal ?? "", /feature\/other/);
    assert.match(refusal ?? "", /main/);
  });

  it("refuses a detached HEAD", () => {
    assert.match(
      landRefusal({ ...landable, checkout: { ...clean, headBranch: null } }) ?? "",
      /detached HEAD/,
    );
  });

  it("refuses a conflicting merge, before anything is written", () => {
    const conflicting = (path: string): ConflictFile => ({
      path,
      type: "contents",
      message: null,
      regions: [],
      regionsOmitted: 0,
      regionsRead: true,
    });
    assert.match(
      landRefusal({
        ...landable,
        preview: {
          outcome: "conflict",
          files: [conflicting("a.ts"), conflicting("b.ts")],
        },
      }) ?? "",
      /conflicts in 2 file/,
    );
  });

  it("passes an undetermined preview's own reason through", () => {
    const refusal = landRefusal({
      ...landable,
      preview: { outcome: "unknown", reason: "git is too old." },
    });
    assert.equal(refusal, "git is too old.");
  });

  it("refuses a branch that is already in its target", () => {
    assert.match(landRefusal({ ...landable, merged: true, ahead: 0 }) ?? "", /Already in main/);
  });

  it("refuses a branch this tool already squashed in", () => {
    // A squash leaves no ancestry, so `merged` is false and every other check
    // passes. Landing again would replay a change that is already in the
    // target — the one refusal git itself cannot supply.
    assert.match(
      landRefusal({ ...landable, landedUnchanged: true }) ?? "",
      /Already squashed into main/,
    );
  });

  it("refuses a branch with no commits of its own", () => {
    assert.match(landRefusal({ ...landable, ahead: 0 }) ?? "", /no commits/);
  });

  it("refuses when no target was ever recorded", () => {
    assert.match(landRefusal({ ...landable, target: null }) ?? "", /no recorded branch/);
  });

  it("refuses a branch that is gone", () => {
    assert.match(landRefusal({ ...landable, branchExists: false }) ?? "", /no longer exists/);
  });
});

/* ------------------------------------------------------------------ */
/* Checking what an agent actually resolved                            */
/* ------------------------------------------------------------------ */

describe("conflict markers", () => {
  it("finds a real conflict", () => {
    const text = [
      "const a = 1;",
      "<<<<<<< HEAD",
      "const b = 2;",
      "=======",
      "const b = 3;",
      ">>>>>>> main",
    ].join("\n");
    assert.equal(hasConflictMarkers(text), true);
  });

  it("does not read a markdown heading underline as one", () => {
    // `=======` under a heading is ordinary markdown. Treating it as evidence
    // would reject a file the agent resolved perfectly, and the operator would
    // be told to fix something that is already right.
    assert.equal(hasConflictMarkers("Heading\n=======\n\nbody\n"), false);
  });

  it("does not fire on the markers appearing mid-line", () => {
    assert.equal(hasConflictMarkers('const s = "<<<<<<< not a marker";'), false);
  });

  it("keeps a region from its opening marker to its closing one", () => {
    const text = [
      "before",
      "<<<<<<< uf/x",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> main",
      "after",
    ].join("\n");

    const { regions, omitted } = conflictRegions(text);
    assert.equal(omitted, 0);
    assert.equal(regions.length, 1);
    assert.equal(
      regions[0].text,
      "<<<<<<< uf/x\nours\n=======\ntheirs\n>>>>>>> main",
    );
    assert.equal(regions[0].truncated, false);
  });

  it("does not start a region on a markdown heading underline", () => {
    assert.deepEqual(conflictRegions("Heading\n=======\n\nbody\n"), {
      regions: [],
      omitted: 0,
    });
  });

  it("flags a region whose closing marker never arrives", () => {
    // What a file cut short by the read budget looks like. Showing it as a
    // complete clash would be a quiet lie about where it ends.
    const { regions } = conflictRegions("<<<<<<< uf/x\nours\n=======\ntheirs");
    assert.equal(regions.length, 1);
    assert.equal(regions[0].truncated, true);
  });

  it("counts the regions it does not show", () => {
    const one = "<<<<<<< uf/x\nours\n=======\ntheirs\n>>>>>>> main";
    const { regions, omitted } = conflictRegions(
      [one, one, one].join("\ncontext\n"),
      { maxRegions: 2, maxLines: 80 },
    );
    assert.equal(regions.length, 2);
    assert.equal(omitted, 1);
  });

  it("treats an unreadable file as unresolved", () => {
    // The commit happens only if this list is empty, so "could not check" has
    // to mean "do not commit" — the same direction every other unreadable
    // state in this file resolves to.
    assert.deepEqual(
      unresolvedFiles([
        { path: "ok.ts", text: "resolved" },
        { path: "gone.ts", text: null },
        { path: "bad.ts", text: "<<<<<<< HEAD\nx" },
      ]),
      ["gone.ts", "bad.ts"],
    );
  });
});
