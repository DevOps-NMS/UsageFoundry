import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sandboxMountPointDirs } from "./sandboxMountPoints";

/**
 * Covers which trees get placeholders, and nothing else in that module.
 *
 * It earns a test because both ways of being wrong are silent and point in
 * opposite directions. Return too few directories and the bwrap failures this
 * exists to remove carry on with the fix reporting success — the case that
 * matters is the *ancestor*, since the single most frequent failing path on
 * this install was `/workspace/.claude/settings.local.json` for a run whose
 * working directory was two levels below it. Return too many and this app
 * writes empty files into trees nobody pointed it at, which is why the ancestor
 * half is guarded on `.claude` already being there and the working directory is
 * the only one that may have one made.
 */

describe("sandboxMountPointDirs", () => {
  it("takes the working directory whether or not it has a .claude", () => {
    assert.deepEqual(sandboxMountPointDirs("/workspace/repo", () => false), [
      "/workspace/repo",
    ]);
  });

  it("takes an ancestor that already has one, and skips one that does not", () => {
    const dirs = sandboxMountPointDirs(
      "/workspace/.uf-worktrees/repo-1",
      (dir) => dir === "/workspace",
    );

    assert.deepEqual(dirs, ["/workspace/.uf-worktrees/repo-1", "/workspace"]);
  });

  it("walks to the root and stops there rather than looping on it", () => {
    const dirs = sandboxMountPointDirs("/a/b/c", () => true);

    assert.deepEqual(dirs, ["/a/b/c", "/a/b", "/a", "/"]);
  });

  it("never invents an ancestor for a working directory at the root", () => {
    assert.deepEqual(sandboxMountPointDirs("/", () => true), ["/", "/"]);
  });
});
