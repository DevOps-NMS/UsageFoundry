import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { RunRow } from "./orchestrator";

/**
 * Covers how many git subprocesses one admission spends choosing a checkout
 * slot, and only that.
 *
 * It is not a pure function and it is deliberately not a timing assertion. What
 * it pins is a *count*, because the fault it is here for has no other symptom:
 * `createRun` runs from entry to INSERT with no `await` — on purpose, since that
 * is what makes its folder claim atomic — so every subprocess it spawns is a
 * hold on the one event loop that drains every agent's stdout, feeds every SSE
 * stream and beats the server lock's heartbeat. Nothing bounded that walk.
 * Dirty checkout slots are left behind by design, they are never `taken`, and so
 * every admission re-ran `git status --porcelain` over every one of them, for
 * ever. The app stayed correct throughout; it simply stopped answering, for
 * longer the older the repository was, and the only way to see it is to count.
 *
 * Its own file because it needs three things `orchestrator.test.ts` cannot give
 * it: a real git repository inside the mount (that file's mounts are fixed at a
 * layout its collision cases depend on), a `spawnSync` wrapped module-wide,
 * which would otherwise count every other case in that file, and a cold slot
 * memo, since the whole question is what a *first* admission on a repository
 * costs. `DATA_DIR` and `CLAUDE_HOME` are set before anything is required, for
 * `config.ts`'s reason.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-slots-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to the ambient one: `planUsage` looks for
// an OAuth token in this directory, and a unit test must not send a request on
// the operator's own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
// Belt to the `maxConcurrentRuns: 0` below: if promotion ever reached a spawn,
// this is a path that cannot be executed rather than a real, billed CLI.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above, and
// these modules read `WORKSPACE_ROOTS` and `DATA_DIR` once at load.
const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to run against the real database",
);

const { createRun, worktreeSlug, MAX_SLOT_PROBES_PER_ADMISSION } =
  require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");

/**
 * Count the git subprocesses an admission spawns, without stubbing any of them.
 *
 * `git.ts` calls `spawnSync` through the module object under the test build's
 * CommonJS emit, so wrapping it here is what every synchronous git call goes
 * through. A wrapper rather than a replacement on purpose: the answers have to
 * be git's real ones, or the walk being measured would take a different path
 * through the very branches this is about.
 */
const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawnSync =
  childProcess.spawnSync as typeof import("node:child_process").spawnSync;
let syncSpawns = 0;
childProcess.spawnSync = ((...args: unknown[]) => {
  syncSpawns += 1;
  return (realSpawnSync as (...a: unknown[]) => unknown)(...args);
}) as typeof realSpawnSync;

after(() => {
  childProcess.spawnSync = realSpawnSync;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** git for the fixture, with an identity of its own so a commit cannot refuse. */
function fixtureGit(cwd: string, args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd, stdio: "ignore" },
  );
}

/**
 * A repository with `dirty` unusable checkout slots already in its store.
 *
 * Real worktrees holding a real untracked file, rather than empty directories:
 * an empty directory is unreadable to git and so counts as dirty for the *other*
 * reason, which would exercise a different branch from the one that accumulates
 * in production.
 */
function makeRepo(name: string, dirty: number): void {
  const repo = path.join(ws, name);
  fs.mkdirSync(repo, { recursive: true });
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  fixtureGit(repo, ["add", "-A"]);
  fixtureGit(repo, ["commit", "-q", "-m", "seed"]);

  const store = path.join(ws, ".uf-worktrees");
  fs.mkdirSync(store, { recursive: true });
  for (let slot = 1; slot <= dirty; slot++) {
    const at = path.join(store, `${worktreeSlug(name)}-${slot}`);
    fixtureGit(repo, ["worktree", "add", "--detach", "-q", at, "HEAD"]);
    fs.writeFileSync(path.join(at, "left-behind.txt"), "uncommitted\n");
  }
}

/**
 * What `probeIsolation` costs, which this change does not touch: `rev-parse
 * --show-toplevel`, `--is-bare-repository`, `HEAD` and `--abbrev-ref HEAD`.
 */
const PROBE_ISOLATION_SPAWNS = 4;

/**
 * The whole stated bound for one admission.
 *
 * Per checkout inspected: one `git status --porcelain`, and — only when that
 * comes back clean — one `rev-parse --git-common-dir` on it. Plus one more for
 * the repository's own git directory, asked once however many slots are looked
 * at.
 */
const BOUND = PROBE_ISOLATION_SPAWNS + 2 * MAX_SLOT_PROBES_PER_ADMISSION + 1;

/** Admit one isolated run on `folder` and report what it cost in subprocesses. */
function admit(folder: string): { spawns: number; run: RunRow } {
  syncSpawns = 0;
  const run = createRun({
    folder,
    prompt: "measure the admission path",
    budget: { maxIterations: 1 },
    origin: "form",
  });
  return { spawns: syncSpawns, run };
}

const DIRTY_MANY = 16;

describe("admission slot allocation", () => {
  // Nothing may be promoted: a started run would do its own git, asynchronously,
  // in the middle of the next measurement.
  saveSettings({ maxConcurrentRuns: 0 });

  makeRepo("few", 4);
  makeRepo("many", DIRTY_MANY);
  makeRepo("warm", DIRTY_MANY);

  it("costs the same whatever a repository has accumulated", () => {
    // Both are being admitted against for the first time, so neither is answered
    // from what an earlier admission learned. The unbounded walk spent one
    // `git status` per dirty slot, so it cost 8 here and 20 there.
    const a = admit("few");
    const b = admit("many");

    assert.equal(
      a.spawns,
      b.spawns,
      `admission cost tracks the dirty-slot count: ${a.spawns} with 4 dirty slots, ${b.spawns} with ${DIRTY_MANY}`,
    );
    assert.ok(
      b.spawns <= BOUND,
      `admission spawned ${b.spawns} git subprocesses, over the stated bound of ${BOUND}`,
    );
  });

  it("still gives the run a checkout of its own", () => {
    // The control, and the one that matters most: a walk that bounded itself by
    // giving up would pass every assertion above and quietly serialise every run
    // on a repository with a few slots left dirty.
    const { run } = admit("many");
    assert.equal(run.isolation, "worktree");
    assert.ok(run.worktree_path, "an isolated run records the slot it took");
  });

  it("stops asking about slots an earlier admission settled", () => {
    // The memo is what makes the bound affordable rather than merely true. Each
    // admission spends its budget on slots nothing has looked at yet, so a store
    // whose low numbers are all dirty is walked past for nothing once every one
    // of them has been settled once.
    const rounds = Math.ceil(DIRTY_MANY / MAX_SLOT_PROBES_PER_ADMISSION);
    for (let i = 0; i < rounds; i++) {
      assert.ok(admit("warm").spawns <= BOUND);
    }

    const { spawns, run } = admit("warm");
    assert.equal(
      spawns,
      PROBE_ISOLATION_SPAWNS,
      "every slot should now be answered from the memo or from a stat",
    );
    assert.equal(run.isolation, "worktree");
  });
});
