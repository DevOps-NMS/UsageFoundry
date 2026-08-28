import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * Covers which directory a conflict resolution is given, and only that.
 *
 * Not a pure function, and it cannot be one: the fault it is here for is that
 * two runs were handed the same path, and a path is only shared once a real
 * store, a real repository and two real `git worktree add`s have said so. The
 * aux checkout was `<repoSlug>-resolve` — a constant per repository — while the
 * removal that precedes creating it is an unconditional `worktree remove
 * --force` plus `rmSync`. Two resolutions in one repository therefore destroyed
 * each other's working tree, each with a billed `claude` child editing files
 * inside it, and neither the guard on the way in (`assistRunning`, keyed on one
 * run) nor the assist budget (`maxConcurrentAssists`, which is two) said a word.
 * Nothing about it fails loudly: both children run to completion and write
 * `run_reviews` rows describing work that was overwritten.
 *
 * Its own file for `slotProbes.test.ts`'s reason: it needs a real git repository
 * inside a real mount, and `DATA_DIR` and `CLAUDE_HOME` set before anything is
 * required, which `land.test.ts` — pure functions, static imports — cannot give.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-resolve-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// `planUsage` looks for an OAuth token here, and a unit test must not send a
// request on the operator's own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
// Belt to the `maxConcurrentRuns: 0` below: a path that cannot be executed
// rather than a real, billed CLI, should promotion ever reach a spawn.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above, and
// these modules read `WORKSPACE_ROOTS` and `DATA_DIR` once at load.
const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to run against the real database",
);

const { createRun } = require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");
const { resolveCheckout } = require("./land") as typeof import("./land");

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** git for the fixture, with an identity of its own so a commit cannot refuse. */
function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** One repository with a branch per run, which is the state after two runs. */
function makeRepo(name: string, branches: readonly string[]): string {
  const repo = path.join(ws, name);
  fs.mkdirSync(repo, { recursive: true });
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  fixtureGit(repo, ["add", "-A"]);
  fixtureGit(repo, ["commit", "-q", "-m", "seed"]);
  for (const branch of branches) fixtureGit(repo, ["branch", branch, "main"]);
  return repo;
}

describe("the checkout a resolution is given", () => {
  // Nothing may be promoted: a started run would do its own git, asynchronously,
  // in the middle of the fixture.
  saveSettings({ maxConcurrentRuns: 0 });

  const repo = makeRepo("shared", ["uf/first", "uf/second"]);

  it("is not the same directory for two runs in one repository", async () => {
    // Neither run has a usable checkout of its own — nothing was promoted, so no
    // slot exists on disk — which is the ordinary state of a finished run whose
    // slot a later one took over, and the branch of `resolveCheckout` that used
    // the shared path.
    const first = createRun({
      folder: "shared",
      prompt: "resolve the first branch",
      budget: { maxIterations: 1 },
      origin: "form",
    });
    const second = createRun({
      folder: "shared",
      prompt: "resolve the second branch",
      budget: { maxIterations: 1 },
      origin: "form",
    });

    const one = await resolveCheckout(repo, first, "uf/first");
    const two = await resolveCheckout(repo, second, "uf/second");

    assert.notEqual(
      one.path,
      two.path,
      "two runs resolving in one repository were handed the same directory",
    );

    // The one that matters: the second call force-removes whatever stands at the
    // path it is about to use, so a shared path leaves the first resolution's
    // checkout gone — or, worse, standing on the second run's branch, which is
    // what its `after` handler would then read files from and commit.
    assert.ok(fs.existsSync(one.path), "the first resolution's checkout was deleted");
    assert.equal(
      fixtureGit(one.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      "uf/first",
      "the first resolution's checkout was taken over by the second run's branch",
    );
    assert.equal(fixtureGit(two.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "uf/second");

    // Both are throwaway checkouts in the store, so both are removed either way.
    assert.equal(one.temporary, true);
    assert.equal(two.temporary, true);
    for (const at of [one.path, two.path]) {
      assert.equal(path.dirname(at), path.join(ws, ".uf-worktrees"));
    }
  });
});
