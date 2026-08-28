import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { git as gitCall } from "./git";
import { conflictedFiles, unresolvedFiles } from "./land";

/**
 * That the conflicted path list is made of paths that exist on disk.
 *
 * `conflictedFiles` read `git diff --name-only --diff-filter=U` without `-z`,
 * and git's default format C-quotes any path holding a non-ASCII byte — a file
 * named `café.txt` came back as the 17-character string `"caf\303\251.txt"`.
 * Every consumer treats what it returns as a real path: it is interpolated into
 * `resolvePrompt`, stored in `run_reviews.resolved_paths` for
 * `resolutionChange`'s `:(top,literal)` pathspec, `path.join`ed onto the
 * checkout and read to check for markers, and passed to `git add`. So a branch
 * conflicting on such a file could never be resolved: the read failed,
 * `unresolvedFiles` counts an unreadable file as unresolved, and the whole
 * merge — including the files the agent got right — was rolled back with
 * "conflict markers are still in ...". The operator paid for that resolution.
 *
 * It earns a real repository for `slotProbes.test.ts`' reason: the fault is in
 * what git prints, so a fixture that stated git's output would be stating the
 * very thing in question, and a parser test alone would still pass with the
 * `-z` left off the argv. Nothing here spawns `claude` or opens the database —
 * `conflictedFiles` is one git child and `unresolvedFiles` is pure.
 *
 * The second case walks the rest of the chain by hand, because the step that
 * proves the fix is the one the parser cannot: reading the path off disk and
 * staging it through the same `:(top,literal)` pathspec the `after` handler
 * uses. It also pins the empty record after the final NUL being dropped —
 * `:(top,literal)` with an empty path is not "nothing", it matches the entire
 * tree, so a resolution would stage every unrelated change in the checkout.
 */

/** A path git quotes: `é` is two non-ASCII bytes in UTF-8. */
const ODD = "café.txt";
/** A plain one beside it, so the multi-path split is exercised too. */
const PLAIN = "a.txt";

let root: string;
let repo: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-conflicted-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);

  git(repo, "init", "-q", "-b", "main");
  for (const name of [ODD, PLAIN]) fs.writeFileSync(path.join(repo, name), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  git(repo, "checkout", "-q", "-b", "uf/side");
  for (const name of [ODD, PLAIN]) fs.writeFileSync(path.join(repo, name), "theirs\n");
  git(repo, "commit", "-qa", "-m", "side");

  git(repo, "checkout", "-q", "main");
  for (const name of [ODD, PLAIN]) fs.writeFileSync(path.join(repo, name), "ours\n");
  git(repo, "commit", "-qa", "-m", "main");

  // Expected to fail: that is the state under test.
  try {
    git(repo, "merge", "--no-edit", "uf/side");
    assert.fail("the fixture merge was meant to conflict");
  } catch {
    /* conflicted, as intended */
  }
  assert.notEqual(git(repo, "ls-files", "-u"), "", "the fixture left nothing unmerged");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Reading `git diff --name-only --diff-filter=U -z`                   */
/* ------------------------------------------------------------------ */

describe("conflictedFiles", () => {
  it("returns the on-disk path of a file git would quote", async () => {
    const files = await conflictedFiles(repo);

    assert.deepEqual(files, [PLAIN, ODD]);
    // Said the other way round, because this is the string the operator was
    // shown and the agent was asked to fix.
    assert.ok(
      !files.some((f) => f.startsWith('"')),
      `a quoted path reached a caller: ${JSON.stringify(files)}`,
    );
    for (const f of files) {
      assert.ok(fs.existsSync(path.join(repo, f)), `${f} does not exist in the checkout`);
    }
  });

  it("lets a resolution of that file be read and staged", async () => {
    const conflicted = await conflictedFiles(repo);
    // What the resolution agent does, done here without one — and deliberately
    // to the files that exist in the checkout rather than to whatever
    // `conflictedFiles` returned. The agent works from the tree it can see, so
    // the marked-up file it fixes is `café.txt` whatever this app called it.
    for (const name of [ODD, PLAIN]) fs.writeFileSync(path.join(repo, name), "resolved\n");

    // The `after` handler's own two steps, in its own order.
    const left = unresolvedFiles(
      conflicted.map((p) => ({ path: p, text: readIfPossible(path.join(repo, p)) })),
    );
    assert.deepEqual(left, [], "a resolved file was reported as still conflicted");

    const staged = await gitCall(repo, [
      "add",
      "--",
      ...conflicted.map((p) => `:(top,literal)${p}`),
    ]);
    assert.equal(staged.ok, true, `git add refused the pathspec: ${staged.stderr}`);

    const unmerged = await gitCall(repo, ["ls-files", "-u"]);
    assert.equal(unmerged.ok, true);
    assert.equal(unmerged.stdout, "", "the resolution left an unmerged entry behind");
  });
});

/** `land.ts`'s own read, which is what turns a wrong path into a rollback. */
function readIfPossible(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
