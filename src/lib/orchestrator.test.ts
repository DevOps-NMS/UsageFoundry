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
const {
  conflictKey,
  overlaps,
  isUsageLimit,
  nextPrompt,
  refusalResumeAt,
  selectPromotable,
  MAX_PAUSES_PER_RUN,
} = require("./orchestrator") as typeof import("./orchestrator");

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
 * Covers which queued runs are allowed to start. Pure, and it earns a test on
 * the same grounds as the predicate above: one wrong status in the reservation
 * set is either two agents in one working tree, or a run queued behind
 * something that will never move.
 *
 * Array order is the contract — `activeRuns()` sorts by `created_at`, and these
 * fixtures stand in for that.
 */
describe("promotion", () => {
  type Row = import("./orchestrator").RunRow;
  let seq = 0;
  // Only three fields are read. A complete row would be thirty nulls per case
  // and would need editing every time a column is added.
  const row = (status: Row["status"], dir: string): Row =>
    ({ id: `r${++seq}`, status, folder: dir, work_dir: dir }) as Row;

  it("starts a queued run in a folder only a parked run holds", () => {
    const parked = row("paused", `${ws}/RepoOne`);
    const waiting = row("queued", `${ws}/RepoOne`);
    assert.deepEqual(selectPromotable([parked, waiting], null), [waiting.id]);
  });

  it("holds it behind a running one", () => {
    const live = row("running", `${ws}/RepoOne`);
    const waiting = row("queued", `${ws}/RepoOne/sub`);
    assert.deepEqual(selectPromotable([live, waiting], null), []);
  });

  it("does not spend a concurrency slot on a parked run", () => {
    const parked = row("paused", `${ws}/Other`);
    const waiting = row("queued", `${ws}/RepoOne`);
    assert.deepEqual(selectPromotable([parked, waiting], 1), [waiting.id]);
  });

  it("does spend one on a running run", () => {
    const live = row("running", `${ws}/Other`);
    const waiting = row("queued", `${ws}/RepoOne`);
    assert.deepEqual(selectPromotable([live, waiting], 1), []);
  });

  it("does not let a younger run overtake one waiting on the workspace root", () => {
    // The root overlaps everything beneath it, so without the queued run's own
    // reservation it is jumped forever by the smaller runs behind it.
    const live = row("running", `${ws}/RepoOne`);
    const root = row("queued", ws);
    const small = row("queued", `${ws}/Other`);
    assert.deepEqual(selectPromotable([live, root, small], null), []);
  });

  it("starts isolated runs on one repo side by side", () => {
    const first = row("running", `${ws}/.uf-worktrees/repoone-1`);
    const second = row("queued", `${ws}/.uf-worktrees/repoone-2`);
    assert.deepEqual(selectPromotable([first, second], null), [second.id]);
  });
});

/**
 * Covers which prompt a cycle spawns with. Pure, and it earns a test because
 * every wrong branch is billed: the continuation prompt asks for DONE if the
 * work is finished, so sending it into a session that has just said DONE buys
 * an immediate second DONE, and sending the original task into a session that
 * is part-way through it repeats work already done.
 */
describe("prompt for the next work cycle", () => {
  const base = {
    sessionId: "sess-1" as string | null,
    followUp: null as string | null,
    justRetriggered: false,
    task: "TASK",
    isolationPreamble: null as string | null,
    continuation: "CONTINUE",
    donePushback: "PUSHBACK",
  };

  it("opens with the task when there is no session to resume", () => {
    assert.equal(nextPrompt({ ...base, sessionId: null }), "TASK");
  });

  it("prepends the isolation preamble only on that opening turn", () => {
    assert.equal(
      nextPrompt({ ...base, sessionId: null, isolationPreamble: "PRE" }),
      "PRE\n\nTASK",
    );
    // Mid-conversation the agent is already in its worktree and has been told.
    assert.equal(
      nextPrompt({ ...base, isolationPreamble: "PRE" }),
      "CONTINUE",
    );
  });

  it("continues an existing session rather than restating the task", () => {
    assert.equal(nextPrompt(base), "CONTINUE");
  });

  it("pushes back instead of continuing after a DONE", () => {
    // The continuation prompt asks for DONE when the work is complete, so
    // replying to a DONE with it is a billed cycle that only says DONE again.
    assert.equal(nextPrompt({ ...base, justRetriggered: true }), "PUSHBACK");
  });

  it("sends the operator's note as the whole turn", () => {
    assert.equal(nextPrompt({ ...base, followUp: "NOTE" }), "NOTE");
  });

  it("appends the note instead when the task has to start over", () => {
    // Without a session there is no conversation for a reply to land in, and a
    // note that only makes sense as one would read as the entire job.
    assert.equal(
      nextPrompt({ ...base, sessionId: null, followUp: "NOTE" }),
      "TASK\n\nNOTE",
    );
    assert.equal(
      nextPrompt({
        ...base,
        sessionId: null,
        isolationPreamble: "PRE",
        followUp: "NOTE",
      }),
      "PRE\n\nTASK\n\nNOTE",
    );
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
