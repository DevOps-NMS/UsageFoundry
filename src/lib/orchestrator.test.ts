import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * Covers the folder-collision predicate, and only that.
 *
 * It earns a test where the rest of this codebase does not: it is pure, and
 * every way it can be wrong ends with two agents writing the same working tree.
 * The mounts have to be configured before the module is loaded, because
 * `WORKSPACE_MOUNTS` is fixed at import time.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-conflict-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(path.join(ws, "RepoOne", "sub"), { recursive: true });
fs.mkdirSync(path.join(ws, "Other"), { recursive: true });
fs.mkdirSync(path.join(ws, ".uf-worktrees", "repoone-1"), { recursive: true });
fs.mkdirSync(path.join(ws, "nested", "Deep"), { recursive: true });

// A second mount reaching the same tree. Compose aliases via bind mount, which
// realpath does not collapse; a symlink is the closest local stand-in, and the
// inode check that catches the bind mount catches this too.
const alias = path.join(tmp, "alias");
fs.symlinkSync(ws, alias);

// A mount *inside* another mount, plus a third mount aliasing that nested one.
// This is the case where an alias has to inherit a path prefix rather than
// starting from its own root.
const nestedAlias = path.join(tmp, "nested-alias");
fs.symlinkSync(path.join(ws, "nested"), nestedAlias);

process.env.WORKSPACE_ROOTS = `Main=${ws}|Alias=${alias}|Nested=${ws}/nested|NestedAlias=${nestedAlias}`;
process.env.DATA_DIR = path.join(tmp, "data");

// `require`, not `import`: imports are hoisted above the environment setup
// above, and the module reads WORKSPACE_ROOTS once at load.
const { conflictKey, overlaps, isUsageLimit, refusalResumeAt, MAX_PAUSES_PER_RUN } =
  require("./orchestrator") as typeof import("./orchestrator");

const clash = (a: string, b: string) => overlaps(conflictKey(a), conflictKey(b));

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("folder collision", () => {
  it("treats a folder as its own occupant", () => {
    assert.equal(clash(`${ws}/RepoOne`, `${ws}/RepoOne`), true);
  });

  it("treats siblings as independent", () => {
    assert.equal(clash(`${ws}/RepoOne`, `${ws}/Other`), false);
  });

  it("catches a parent and a child in both directions", () => {
    // The picker offers the mount root, so this is a normal selection, not an
    // edge case.
    assert.equal(clash(ws, `${ws}/RepoOne`), true);
    assert.equal(clash(`${ws}/RepoOne/sub`, `${ws}/RepoOne`), true);
  });

  it("sees through two mounts onto one directory", () => {
    assert.equal(clash(`${ws}/RepoOne`, `${alias}/RepoOne`), true);
    assert.equal(clash(`${ws}/RepoOne`, `${alias}/Other`), false);
  });

  it("treats a case variant as the same folder", () => {
    // macOS is case-insensitive by default, so these are one directory.
    assert.equal(clash(`${ws}/RepoOne`, `${ws}/repoone`), true);
  });

  it("keeps isolated checkouts clear of the repo and of each other", () => {
    assert.equal(clash(`${ws}/RepoOne`, `${ws}/.uf-worktrees/repoone-1`), false);
    assert.equal(
      clash(`${ws}/.uf-worktrees/repoone-1`, `${ws}/.uf-worktrees/repoone-2`),
      false,
    );
  });

  it("still blocks checkouts against a run on the whole workspace", () => {
    assert.equal(clash(ws, `${ws}/.uf-worktrees/repoone-1`), true);
  });

  it("keeps a nested mount's prefix when a third mount aliases it", () => {
    // The alias inherits the parent's tree identity, so it has to inherit the
    // parent-relative prefix too. Dropping it makes `/nested-alias/Deep` and
    // `/ws/nested/Deep` — one directory — compare as different folders, and two
    // agents are admitted into the same working tree.
    assert.equal(clash(`${nestedAlias}/Deep`, `${ws}/nested/Deep`), true);
    assert.equal(clash(`${nestedAlias}/Deep`, `${ws}/RepoOne`), false);
    // And the parent mount still contains the aliased nested path.
    assert.equal(clash(ws, `${nestedAlias}/Deep`), true);
  });
});

/**
 * Covers how a provider refusal is classified and when a refused run tries
 * again. Both are pure, and both are the difference between a run that waits
 * out a full window and one that either dies at the wall or re-spawns into it.
 */

describe("usage-limit classification", () => {
  it("matches the wording the CLI renders", () => {
    assert.equal(isUsageLimit("You've hit your session limit"), true);
    assert.equal(isUsageLimit("You've hit your weekly limit · resets 3:45pm"), true);
    assert.equal(isUsageLimit("You've reached your Opus limit."), true);
    // Matched loosely rather than enumerated: the label is per model as well as
    // per window, so a list written today goes stale the next time one ships.
    assert.equal(isUsageLimit("You've hit your Fable 5 limit."), true);
  });

  it("leaves money limits to end the run", () => {
    // A spend cap or a credit balance does not refill on a schedule, so waiting
    // for one holds a folder for hours to reach the same answer.
    assert.equal(isUsageLimit("You've hit your usage credit limit"), false);
    assert.equal(isUsageLimit("You've hit your monthly spend limit."), false);
    assert.equal(isUsageLimit("You're out of usage credits."), false);
    assert.equal(isUsageLimit("Your org is out of usage credits"), false);
  });

  it("matches the wording in the CLI's own error taxonomy", () => {
    assert.equal(isUsageLimit("usage limit reached"), true);
    // The pipe-epoch form every community wrapper keys on is absent from the
    // shipped binary, but costs nothing to keep matching if it ever returns.
    assert.equal(isUsageLimit("Claude AI usage limit reached|1786400000"), true);
  });

  it("leaves other refusals to fail as themselves", () => {
    // A real record from this machine. It must report truthfully, not wait five
    // hours for an allowance that was never the problem.
    assert.equal(isUsageLimit("Not logged in · Please run /login"), false);
    assert.equal(isUsageLimit(""), false);
  });

  it("does not treat a transient failure as an exhausted allowance", () => {
    // Waiting hours for one of these turns a retryable blip into a stalled run.
    assert.equal(isUsageLimit("429 Too Many Requests"), false);
    assert.equal(isUsageLimit("API is overloaded, please retry"), false);
    assert.equal(isUsageLimit("rate limited"), false);
  });
});

describe("refusal wake-up time", () => {
  const now = 1_700_000_000_000;
  const min = 5 * 60_000;
  const hour = 3_600_000;

  it("waits for the window when one is still open, plus the settling margin", () => {
    const at = refusalResumeAt({ boundary: now + 2 * hour, pauseCount: 0, now });
    assert.equal(at > now + 2 * hour, true);
    assert.equal(at <= now + 2 * hour + 2 * 60_000, true);
  });

  it("backs off when the boundary it can see has already passed", () => {
    // The derived boundary is floored to the hour, so it can be up to an hour
    // early. Trusting it here would re-spawn straight back into the wall.
    const first = refusalResumeAt({ boundary: now - hour, pauseCount: 0, now });
    const second = refusalResumeAt({ boundary: now - hour, pauseCount: 1, now });
    const third = refusalResumeAt({ boundary: now - hour, pauseCount: 2, now });
    assert.equal(first > now + min, true);
    assert.equal(second > first, true);
    assert.equal(third > second, true);
    // Three waits have to cover the floor-to-hour error, or the feature never
    // reaches the reset it is waiting for.
    assert.equal(third - now >= hour, true);
  });

  it("backs off identically when it can see no window at all", () => {
    assert.equal(
      refusalResumeAt({ boundary: null, pauseCount: 0, now }),
      refusalResumeAt({ boundary: now - hour, pauseCount: 0, now }),
    );
  });

  it("never re-spawns immediately, whatever the arithmetic says", () => {
    // A boundary one second out would otherwise mean a spawn per second.
    assert.equal(
      refusalResumeAt({ boundary: now + 1_000, pauseCount: 0, now }) >= now + min,
      true,
    );
  });

  it("never holds a folder for longer than a window plus slack", () => {
    const at = refusalResumeAt({ boundary: now + 40 * hour, pauseCount: 0, now });
    assert.equal(at <= now + 6 * hour, true);
  });

  it("stops backing off once the cap is reached", () => {
    // Past the cap the run fails instead of parking, so the backoff table only
    // ever needs entries up to it.
    assert.equal(MAX_PAUSES_PER_RUN >= 1, true);
    const atCap = refusalResumeAt({
      boundary: null,
      pauseCount: MAX_PAUSES_PER_RUN,
      now,
    });
    assert.equal(Number.isFinite(atCap), true);
    assert.equal(atCap <= now + 6 * hour, true);
  });
});
