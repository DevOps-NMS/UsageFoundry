import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commitRefusal,
  conflictRegions,
  hasConflictMarkers,
  landRefusal,
  parseMergeTree,
  parseStatusZ,
  purgeRefusal,
  selectBranchCandidates,
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
 *
 * `commitRefusal` and `purgeRefusal` clear the same bar from the other end.
 * One decides whether to make a commit in a checkout — where the expensive
 * mistake is committing a slot's contents onto the branch of whichever run took
 * that slot over next — and the other decides whether to destroy a branch
 * nothing has landed, which is the only action here git cannot undo.
 * `parseStatusZ` is what both of them count, and it is a parser over arbitrary
 * filenames whose first character is significant.
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
    runId: "run-a",
    runStatus: "completed" as const,
    branchExists: true,
    target: "main",
    merged: false,
    landedUnchanged: false,
    ahead: 3,
    pendingCount: 0,
    preview: { outcome: "clean" as const },
    checkout: clean,
    // One entry is the ordinary run, whose branch is its own.
    chain: [{ runId: "run-a", status: "completed" as const, iterations: 1 }],
  };

  it("allows the case everything is in order", () => {
    assert.equal(landRefusal(landable), null);
  });

  it("still offers the branch of a run that asked for review", () => {
    // It looks like an omission and is not. A `needs-review` run cannot commit
    // again unless somebody reopens it — exactly like `completed`, `stopped` and
    // `failed`, all three of which are landable — and an operator who has read
    // the reason may well decide the partial work is worth having. Refusing here
    // would leave them with a branch and no route to it.
    assert.equal(landRefusal({ ...landable, runStatus: "needs-review" }), null);
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

  it("names the uncommitted work when that is why the branch is empty", () => {
    // The failure this exists for: an agent that wrote everything and could not
    // commit any of it. "No commits of its own" alone reads as a run that did
    // nothing, and sends the operator looking for work that is sitting in the
    // checkout.
    const refusal = landRefusal({ ...landable, ahead: 0, pendingCount: 7 });
    assert.match(refusal ?? "", /7 path/);
    assert.match(refusal ?? "", /Commit them first/);
  });

  it("refuses when no target was ever recorded", () => {
    assert.match(landRefusal({ ...landable, target: null }) ?? "", /no recorded branch/);
  });

  it("refuses a branch that is gone", () => {
    assert.match(landRefusal({ ...landable, branchExists: false }) ?? "", /no longer exists/);
  });
});

/* ------------------------------------------------------------------ */
/* One branch several runs share                                       */
/* ------------------------------------------------------------------ */

/**
 * Runs that continue one another's work all commit to one ref, so "this run's
 * branch" stops being a phrase that picks out a branch. Every one of them would
 * otherwise offer to land it: the operator merges the first, the second still
 * reads unmerged because the branch has moved on, and the merge queue takes the
 * same branch once per link. The rule is the last link and nothing before it,
 * and each refusal has to name the run that does own it — a greyed-out button
 * on a page whose whole point is getting work merged is a dead end.
 */
describe("landRefusal for a branch a chain shares", () => {
  const member = (
    runId: string,
    status: import("./land").ChainMember["status"],
    iterations = 1,
  ) => ({ runId, status, iterations });

  const clean: CheckoutState = {
    path: "/workspace/repo",
    headBranch: "main",
    dirty: false,
    readable: true,
  };

  /** Everything else in order, so only the chain can be the reason. */
  const base = {
    runStatus: "completed" as const,
    branchExists: true,
    target: "main",
    merged: false,
    landedUnchanged: false,
    ahead: 3,
    pendingCount: 0,
    preview: { outcome: "clean" as const },
    checkout: clean,
  };

  it("lands from the last link and refuses the ones before it by name", () => {
    const chain = [member("aaaaaaaa", "completed"), member("bbbbbbbb", "completed")];
    assert.equal(landRefusal({ ...base, runId: "bbbbbbbb", chain }), null);

    const refusal = landRefusal({ ...base, runId: "aaaaaaaa", chain }) ?? "";
    assert.match(refusal, /bbbbbbbb/);
    // Naming the owner is the point; "you cannot" with no address is not.
    assert.match(refusal, /lands it/);
  });

  it("refuses every link but the last of a longer chain", () => {
    const chain = [
      member("aaaaaaaa", "completed"),
      member("bbbbbbbb", "completed"),
      member("cccccccc", "completed"),
    ];
    for (const runId of ["aaaaaaaa", "bbbbbbbb"]) {
      assert.match(landRefusal({ ...base, runId, chain }) ?? "", /cccccccc/);
    }
    assert.equal(landRefusal({ ...base, runId: "cccccccc", chain }), null);
  });

  it("holds the whole branch while a link further along has not settled", () => {
    // `waiting` is the one that matters and the one every other rule here
    // misses: it holds no folder and no checkout, so nothing else in this app
    // treats it as occupying anything — but it is a declared future commit on
    // this exact ref, and landing before it runs would take half the chain.
    for (const status of ["waiting", "queued", "running", "paused"] as const) {
      const chain = [member("aaaaaaaa", "completed"), member("bbbbbbbb", status, 0)];
      const refusal = landRefusal({ ...base, runId: "aaaaaaaa", chain }) ?? "";
      assert.match(refusal, /bbbbbbbb/, `${status} should hold the branch`);
    }
  });

  it("refuses the owner while an earlier link has been picked up again", () => {
    // Reopening the first run puts it back on the same branch behind the run
    // that now owns it. Every other check here reads this run's own status,
    // which is `completed` and says nothing about the one about to commit.
    const chain = [member("aaaaaaaa", "queued"), member("bbbbbbbb", "completed")];
    const refusal = landRefusal({ ...base, runId: "bbbbbbbb", chain }) ?? "";
    assert.match(refusal, /aaaaaaaa/);
    assert.match(refusal, /still commit/);
  });

  it("hands the branch back when the link behind it never ran a cycle", () => {
    // A dependent blocked because its dependency failed is recorded on this
    // branch and put nothing on it. Letting it own the branch would leave the
    // run that did the work unlandable for ever, with a sentence pointing at a
    // run that is finished and empty.
    for (const status of ["blocked", "stopped", "failed", "needs-review"] as const) {
      const chain = [member("aaaaaaaa", "completed"), member("bbbbbbbb", status, 0)];
      assert.equal(
        landRefusal({ ...base, runId: "aaaaaaaa", chain }),
        null,
        `a ${status} link with no cycle should not own the branch`,
      );
    }
  });

  it("keeps a failed link that did commit as the owner", () => {
    // The other half of the same rule: this one crashed, but it crashed with
    // commits on the branch, so it is where the branch ends and picking it up
    // again is the way on rather than landing from behind it.
    const chain = [member("aaaaaaaa", "completed"), member("bbbbbbbb", "failed", 2)];
    assert.match(landRefusal({ ...base, runId: "aaaaaaaa", chain }) ?? "", /bbbbbbbb/);
    assert.equal(landRefusal({ ...base, runId: "bbbbbbbb", chain }), null);
  });

  it("keeps a link that asked for review as the owner once it has committed", () => {
    // Same rule again, and the ending that most often has work worth keeping:
    // it got some of the way and then met a wall. The branch ends there, so it
    // is what the operator lands or picks up — not something to land from
    // behind.
    const chain = [
      member("aaaaaaaa", "completed"),
      member("bbbbbbbb", "needs-review", 2),
    ];
    assert.match(landRefusal({ ...base, runId: "aaaaaaaa", chain }) ?? "", /bbbbbbbb/);
    assert.equal(landRefusal({ ...base, runId: "bbbbbbbb", chain }), null);
  });

  it("says nothing new about a chain that is already landed", () => {
    // `merged` is tested after the chain rules deliberately: a non-owner of a
    // landed branch is still being told the useful thing, which is which run to
    // look at, rather than that there is nothing to do.
    const chain = [member("aaaaaaaa", "completed"), member("bbbbbbbb", "completed")];
    assert.match(
      landRefusal({ ...base, runId: "bbbbbbbb", chain, merged: true }) ?? "",
      /Already in main/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Reading `git status --porcelain -z`                                 */
/* ------------------------------------------------------------------ */

describe("parseStatusZ", () => {
  it("keeps the leading space that means unstaged", () => {
    // ` M` and `M ` are different facts about the same file, and the space is
    // the whole difference — which is why `git()` is told not to trim this.
    const [unstaged, staged] = parseStatusZ(z(" M src/a.ts", "M  src/b.ts", ""));
    assert.deepEqual(
      [unstaged, staged].map((f) => [f.code, f.path]),
      [
        [" M", "src/a.ts"],
        ["M ", "src/b.ts"],
      ],
    );
  });

  it("pairs a rename with its source instead of listing it as a change", () => {
    // With -z git drops the arrow and reverses the order, so the *current* path
    // is in the record and the original follows as its own field. Left in the
    // stream that field becomes a file whose first two characters are read as
    // status letters.
    const files = parseStatusZ(z("R  new.ts", "old.ts", "?? untracked.ts", ""));
    assert.deepEqual(
      files.map((f) => [f.code, f.path, f.origPath]),
      [
        ["R ", "new.ts", "old.ts"],
        ["??", "untracked.ts", null],
      ],
    );
  });

  it("keeps a path containing a space", () => {
    const [file] = parseStatusZ(z("?? docs/some file.md", ""));
    assert.equal(file.path, "docs/some file.md");
  });

  it("stops rather than pairing a rename with a field that is not there", () => {
    // A killed git leaves a record cut short. Pairing it with whatever follows
    // would report a rename from a file that was never involved.
    assert.deepEqual(parseStatusZ(z(" M a.ts", "R  new.ts")), [
      { path: "a.ts", origPath: null, code: " M" },
    ]);
  });

  it("reads an empty status as nothing pending", () => {
    assert.deepEqual(parseStatusZ(""), []);
  });
});

/* ------------------------------------------------------------------ */
/* Deciding whether to commit into a run's own checkout                */
/* ------------------------------------------------------------------ */

describe("commitRefusal", () => {
  const committable = {
    runStatus: "completed" as const,
    isolated: true,
    branch: "uf/repo-1234abcd",
    checkedOutBranch: "uf/repo-1234abcd",
    readable: true,
    pendingCount: 4,
    message: "Add the parser",
  };

  it("allows the case everything is in order", () => {
    assert.equal(commitRefusal(committable), null);
  });

  it("refuses to commit in the operator's own checkout", () => {
    assert.match(commitRefusal({ ...committable, isolated: false }) ?? "", /yours to do/);
  });

  it("refuses while the run can still write", () => {
    for (const runStatus of ["running", "queued", "paused"] as const) {
      assert.match(
        commitRefusal({ ...committable, runStatus }) ?? "",
        /still active/,
        `${runStatus} should not be committable`,
      );
    }
  });

  it("refuses when a later run has taken the slot over", () => {
    // The expensive one. A slot is reused, so what is uncommitted in it after
    // that belongs to somebody else — committing it here would put one run's
    // work on another run's branch, as a commit nobody made.
    const refusal = commitRefusal({
      ...committable,
      checkedOutBranch: "uf/repo-99887766",
    });
    assert.match(refusal ?? "", /uf\/repo-99887766/);
    assert.match(refusal ?? "", /another run/);
  });

  it("refuses when the checkout is gone", () => {
    assert.match(
      commitRefusal({ ...committable, checkedOutBranch: null }) ?? "",
      /checkout this run worked in is gone/,
    );
  });

  it("refuses an unreadable status rather than committing blind", () => {
    assert.match(commitRefusal({ ...committable, readable: false }) ?? "", /Could not read/);
  });

  it("refuses when there is nothing to commit", () => {
    assert.match(
      commitRefusal({ ...committable, pendingCount: 0 }) ?? "",
      /nothing uncommitted/,
    );
  });

  it("refuses a message that was given and then emptied", () => {
    // Absent means "use the task". Blank means the operator cleared it, and a
    // subject they did not write is not a repair for that.
    assert.match(commitRefusal({ ...committable, message: "   " }) ?? "", /required/);
  });

  it("refuses a message that is a file rather than a subject", () => {
    assert.match(
      commitRefusal({ ...committable, message: "x".repeat(1_001) }) ?? "",
      /1001 characters/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Deciding whether to destroy a branch                                */
/* ------------------------------------------------------------------ */

describe("purgeRefusal", () => {
  const purgeable = {
    runId: "aaaaaaaa",
    runStatus: "failed" as const,
    branch: "uf/repo-1234abcd",
    branchExists: true,
    confirmBranch: "uf/repo-1234abcd",
    chain: [{ runId: "aaaaaaaa", status: "failed" as const, iterations: 1 }],
  };

  it("allows an unmerged branch, which is the whole point of it", () => {
    // `deleteBranch` refuses this case by design. Purge is the other door, and
    // if it refused the same things it would not exist.
    assert.equal(purgeRefusal(purgeable), null);
  });

  it("refuses unless the branch is named back", () => {
    // Not authentication — the row still decides what gets deleted. It is what
    // stops a request aimed at one branch from landing on another.
    for (const confirmBranch of ["", "uf/repo-99887766", "UF/REPO-1234ABCD"]) {
      assert.match(
        purgeRefusal({ ...purgeable, confirmBranch }) ?? "",
        /has to name it/,
        `${confirmBranch || "(empty)"} should not confirm`,
      );
    }
  });

  it("refuses while the run is still working on it", () => {
    for (const runStatus of ["running", "queued", "paused"] as const) {
      assert.match(
        purgeRefusal({ ...purgeable, runStatus }) ?? "",
        /still active/,
        `${runStatus} should not be purgeable`,
      );
    }
  });

  it("says so when the branch is already gone", () => {
    assert.match(
      purgeRefusal({ ...purgeable, branchExists: false }) ?? "",
      /already gone/,
    );
  });

  it("refuses while a run behind it is set to carry the branch on", () => {
    // "Not an active run" stopped meaning "nobody is using this branch" the day
    // a second run could be told to continue it. This run is finished and its
    // own status says nothing about the one that has not started yet — which
    // would then fail on a missing branch with nothing recording who took it.
    for (const status of ["waiting", "queued", "running", "paused"] as const) {
      const refusal =
        purgeRefusal({
          ...purgeable,
          chain: [
            { runId: "aaaaaaaa", status: "failed", iterations: 1 },
            { runId: "bbbbbbbb", status, iterations: 0 },
          ],
        }) ?? "";
      assert.match(refusal, /bbbbbbbb/, `${status} should hold the branch`);
    }
  });

  it("still purges once every run on the branch has settled", () => {
    assert.equal(
      purgeRefusal({
        ...purgeable,
        chain: [
          { runId: "aaaaaaaa", status: "failed", iterations: 1 },
          { runId: "bbbbbbbb", status: "blocked", iterations: 0 },
        ],
      }),
      null,
    );
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

/* ------------------------------------------------------------------ */
/* Which branches a request examines                                   */
/* ------------------------------------------------------------------ */

describe("selectBranchCandidates", () => {
  /**
   * The selection is where a branch stops being reachable, and it fails in
   * silence: a branch dropped here is committed work with no route in the UI
   * that reaches it, and the count that ought to say so used to be computed
   * from the same truncated list — so the page could not report what nothing
   * had looked at.
   *
   * Runs are handed in newest-first, as the query that feeds it orders them.
   */
  const run = (
    id: string,
    repoRoot: string,
    branch: string,
    status: import("./land").BranchCandidate["status"] = "completed",
    iterations = 1,
  ) => ({ id, status, iterations, repoRoot, branch });

  /** N branches in one repository, newest first. */
  const many = (repoRoot: string, n: number, from = 0) =>
    Array.from({ length: n }, (_, i) =>
      run(`r${repoRoot}-${from + i}`, repoRoot, `uf/b${from + i}`),
    );

  it("counts every branch, not only the ones it can afford to examine", () => {
    // 450 branches, a page of 60. The other 390 are counted rather than
    // forgotten, and the number is what makes this the defect rather than the
    // cap: the candidates used to come off the newest 400 *runs*, so branches
    // beyond that window were dropped before `notShown` was computed and the
    // page could not say they existed — nothing had looked.
    const sel = selectBranchCandidates(many("/w/a", 450));
    assert.equal(sel.total, 450);
    assert.equal(sel.examined.length, 60);
    assert.equal(sel.notShown, 390);
  });

  it("reaches a branch past the cap through the offset", () => {
    const runs = many("/w/a", 150);
    const page3 = selectBranchCandidates(runs, { offset: 120 });
    assert.equal(page3.examined.length, 30);
    assert.equal(page3.offset, 120);
    assert.equal(page3.examined[0].branch, "uf/b120");
    assert.equal(page3.examined.at(-1)?.branch, "uf/b149");

    // Every branch is on exactly one page, and every page is examinable.
    const seen = new Set<string>();
    for (let offset = 0; offset < 150; offset += 60) {
      for (const r of selectBranchCandidates(runs, { offset }).examined) {
        assert.equal(seen.has(r.branch), false, `${r.branch} listed twice`);
        seen.add(r.branch);
      }
    }
    assert.equal(seen.size, 150);
  });

  it("gives one repository its own page instead of a share of a global 60", () => {
    // The failure at fleet scale: fourteen busy repositories push the
    // fifteenth's branches off a global newest-60 before anyone looks at them.
    const runs = [...many("/w/busy", 100), ...many("/w/quiet", 3, 900)];
    const unfiltered = selectBranchCandidates(runs);
    assert.equal(
      unfiltered.examined.some((r) => r.repoRoot === "/w/quiet"),
      false,
    );

    const quiet = selectBranchCandidates(runs, { repo: "/w/quiet" });
    assert.equal(quiet.total, 3);
    assert.equal(quiet.notShown, 0);
    assert.deepEqual(
      quiet.examined.map((r) => r.branch),
      ["uf/b900", "uf/b901", "uf/b902"],
    );
  });

  it("counts every repository for the picker, whatever the filter is", () => {
    // A filter that hides the repositories you would use to change it is a
    // filter you cannot get out of.
    const runs = [...many("/w/a", 4), ...many("/w/b", 2, 50)];
    const filtered = selectBranchCandidates(runs, { repo: "/w/a" });
    assert.deepEqual(
      [...filtered.repos].sort((x, y) => x.repoRoot.localeCompare(y.repoRoot)),
      [
        { repoRoot: "/w/a", branches: 4 },
        { repoRoot: "/w/b", branches: 2 },
      ],
    );
  });

  it("counts a chain as one branch and pages by branches, not runs", () => {
    // `oneRunPerBranch` runs before the slice: three links sharing a ref must
    // not consume three rows of somebody's page, and the row kept is the
    // chain's owner so the page and the Land button agree.
    const runs = [
      run("c3", "/w/a", "uf/chain"),
      run("c2", "/w/a", "uf/chain"),
      run("c1", "/w/a", "uf/chain"),
      run("solo", "/w/a", "uf/solo"),
    ];
    const sel = selectBranchCandidates(runs);
    assert.equal(sel.total, 2);
    assert.deepEqual(
      sel.examined.map((r) => r.branch),
      ["uf/chain", "uf/solo"],
    );
    // Oldest-first is the chain order, so the last link owns it.
    assert.equal(sel.examined[0].id, "c3");
    assert.deepEqual(sel.repos, [{ repoRoot: "/w/a", branches: 2 }]);
  });

  it("keeps the per-request git cost bounded whatever is asked for", () => {
    // The cap is what makes this page affordable; the filter and the offset
    // move which branches are paid for and must never raise how many.
    const runs = many("/w/a", 500);
    assert.equal(selectBranchCandidates(runs, { limit: 5000 }).examined.length, 60);
    assert.equal(selectBranchCandidates(runs, { limit: 10 }).examined.length, 10);
    assert.equal(selectBranchCandidates(runs, { limit: 0 }).examined.length, 60);
    assert.equal(selectBranchCandidates(runs, { limit: -3 }).examined.length, 60);
  });

  it("clamps an offset past the end rather than answering an empty page", () => {
    // What pressing Next on a page that shrank under you produces. An honest
    // total with the last page on screen beats a blank table.
    const sel = selectBranchCandidates(many("/w/a", 10), { offset: 400 });
    assert.equal(sel.total, 10);
    assert.equal(sel.offset, 9);
    assert.equal(sel.examined.length, 1);
    assert.equal(sel.notShown, 9);
  });

  it("tells two repositories with the same branch name apart", () => {
    const runs = [run("a", "/w/a", "uf/x"), run("b", "/w/b", "uf/x")];
    const sel = selectBranchCandidates(runs);
    assert.equal(sel.total, 2);
    assert.equal(selectBranchCandidates(runs, { repo: "/w/b" }).examined[0].id, "b");
  });
});
