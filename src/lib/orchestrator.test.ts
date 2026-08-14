import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { BudgetPolicy } from "./budget";

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
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// The reopen case below is the one test here that reaches the database, and
// `reopenRun` ends in `promoteQueued`. Its fixture keeps the folder occupied so
// nothing is promotable, and this is the second lock on the same door: a
// `claude` that does not exist makes a regression that gets as far as a spawn a
// failed test rather than a billed one.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment setup
// above, and the module reads WORKSPACE_ROOTS once at load.
const {
  buildArgs,
  conflictKey,
  dependencyCycle,
  overlaps,
  releasableRuns,
  resolveIsolation,
  revivableDependents,
  getRun,
  githubEnv,
  isTransientApiError,
  isUsageLimit,
  matchesCopyGlobs,
  needsLiveSpendTelemetry,
  nextPrompt,
  permissionDenials,
  refusalResumeAt,
  reopenPrompt,
  reopenRun,
  selectPromotable,
  MAX_PAUSES_PER_RUN,
  MAX_TRANSIENT_RETRIES,
} = require("./orchestrator") as typeof import("./orchestrator");

const { normalizePolicy } = require("./budget") as typeof import("./budget");
const { db } = require("./db") as typeof import("./db");

const clash = (a: string, b: string) => overlaps(conflictKey(a), conflictKey(b));

after(() => {
  (globalThis as { __ufDb?: { close(): void } }).__ufDb?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

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

  it("cannot see a run that is waiting for another run", () => {
    // The point of the status: a chain admitted up front must not reserve a
    // folder against every unrelated run submitted behind it.
    const chained = row("waiting", `${ws}/RepoOne`);
    const unrelated = row("queued", `${ws}/RepoOne`);
    assert.deepEqual(selectPromotable([chained, unrelated], null), [unrelated.id]);
    // And it spends no concurrency slot either.
    assert.deepEqual(selectPromotable([chained, unrelated], 1), [unrelated.id]);
  });
});

/**
 * Covers which waiting runs may join the queue, and which can never start.
 *
 * Pure, and it earns a test on the same grounds as the two above: both failure
 * modes are silent. A run released too early starts on top of work that has not
 * happened; a run neither released nor terminated sits `waiting` for ever,
 * holding a prompt the operator believes is queued and pointing at a run that
 * finished days ago.
 */
describe("dependencies", () => {
  type State = import("./orchestrator").DependencyState;
  type Link = import("./orchestrator").DependencyLink;

  const waiting = (id: string): State => ({ id, status: "waiting", iterations: 0 });
  /** A dependency that did work and ended well. */
  const done = (id: string): State => ({ id, status: "completed", iterations: 1 });
  const link = (
    runId: string,
    dependsOn: string,
    edge: Link["edge"] = "on-success",
  ): Link => ({ runId, dependsOn, edge });

  it("releases a run whose only dependency completed", () => {
    const decision = releasableRuns([done("a"), waiting("b")], [link("b", "a")]);
    assert.deepEqual(decision, { release: ["b"], block: [] });
  });

  it("holds it while the dependency is still going", () => {
    for (const status of ["queued", "running", "paused"] as const) {
      const decision = releasableRuns(
        [{ id: "a", status, iterations: 0 }, waiting("b")],
        [link("b", "a")],
      );
      assert.deepEqual(decision, { release: [], block: [] });
    }
  });

  it("releases a chain one link at a time", () => {
    // a done, b waiting on a, c waiting on b. Only b may go: c's dependency has
    // not started, let alone finished.
    const decision = releasableRuns(
      [done("a"), waiting("b"), waiting("c")],
      [link("b", "a"), link("c", "b")],
    );
    assert.deepEqual(decision, { release: ["b"], block: [] });
  });

  it("waits for both halves of a fan-in", () => {
    const links = [link("c", "a"), link("c", "b")];
    assert.deepEqual(
      releasableRuns([done("a"), { id: "b", status: "running", iterations: 0 }, waiting("c")], links),
      { release: [], block: [] },
    );
    assert.deepEqual(releasableRuns([done("a"), done("b"), waiting("c")], links), {
      release: ["c"],
      block: [],
    });
  });

  it("releases every branch of a fan-out at once", () => {
    const decision = releasableRuns(
      [done("a"), waiting("b"), waiting("c")],
      [link("b", "a"), link("c", "a")],
    );
    assert.deepEqual(decision, { release: ["b", "c"], block: [] });
  });

  it("terminates the whole chain when a dependency fails under on-success", () => {
    const decision = releasableRuns(
      [{ id: "a", status: "failed", iterations: 2 }, waiting("b"), waiting("c")],
      [link("b", "a"), link("c", "b")],
    );
    assert.deepEqual(decision.release, []);
    assert.deepEqual(
      decision.block.map((b) => b.id),
      ["b", "c"],
    );
    // Each names the run that stopped it — the one in front of it, not the one
    // at the head of the chain, which it never heard of.
    assert.match(decision.block[0].reason, /run a\b/);
    assert.match(decision.block[1].reason, /run b\b/);
  });

  it("starts on a failed dependency under on-finish, but not on one that never ran", () => {
    const links = [link("b", "a", "on-finish")];
    assert.deepEqual(
      releasableRuns([{ id: "a", status: "failed", iterations: 2 }, waiting("b")], links),
      { release: ["b"], block: [] },
    );
    // Refused before its first cycle, stopped before it started, closed out by
    // a restart: all terminal, all having done nothing. Treating those as
    // "finished" would start the next run in the chain on the strength of a run
    // that never opened a file — and would leave nothing to end the chain.
    for (const status of ["blocked", "stopped", "failed"] as const) {
      const decision = releasableRuns(
        [{ id: "a", status, iterations: 0 }, waiting("b")],
        links,
      );
      assert.deepEqual(decision.release, []);
      assert.equal(decision.block.length, 1);
      assert.match(decision.block[0].reason, /without running a work cycle/);
    }
  });

  it("treats a run that used up its cycle cap as a success", () => {
    // `completed` covers both the DONE reply and the cycle cap, and the cap
    // defaults to 1 — so requiring the reply would mean a dependent almost
    // never starts.
    const decision = releasableRuns(
      [{ id: "a", status: "completed", iterations: 1 }, waiting("b")],
      [link("b", "a")],
    );
    assert.deepEqual(decision, { release: ["b"], block: [] });
  });

  it("blocks on a dependency that is no longer there", () => {
    const decision = releasableRuns([waiting("b")], [link("b", "gone")]);
    assert.deepEqual(decision.release, []);
    assert.match(decision.block[0].reason, /no longer there/);
  });

  it("finds a loop, and leaves a graph without one alone", () => {
    assert.equal(dependencyCycle([link("b", "a"), link("c", "b")]), null);
    assert.deepEqual(dependencyCycle([link("a", "a")]), ["a", "a"]);
    assert.deepEqual(
      dependencyCycle([link("a", "b"), link("b", "c"), link("c", "a")]),
      ["a", "b", "c", "a"],
    );
    // A loop off to the side of an acyclic branch is still a loop.
    assert.ok(dependencyCycle([link("x", "y"), link("a", "b"), link("b", "a")]));
  });

  it("leaves a loop waiting rather than looping itself", () => {
    // Which is exactly why admission refuses one: nothing downstream of this
    // pair will ever be released or terminated either.
    const decision = releasableRuns(
      [waiting("a"), waiting("b")],
      [link("a", "b"), link("b", "a")],
    );
    assert.deepEqual(decision, { release: [], block: [] });
  });

  /**
   * The other half of the same decision: which blocked runs a reopen wakes.
   *
   * `releasableRuns` writes its verdict once and `releasePass` never looks at a
   * `blocked` row again, so without this a chain dies permanently the first time
   * any link overruns its budget — which is a $35 limit on a four-block workflow,
   * i.e. routinely. Both ways of being wrong are silent: waking too little leaves
   * the tail of the chain stuck with a reason describing an ending that has since
   * been undone, and waking a run that already holds a checkout sends it back
   * through `admitWaiting` to be given a second one.
   */
  const sorted = (ids: string[]) => [...ids].sort();

  it("wakes the whole chain behind a reopened run, not just the next link", () => {
    // b was blocked by a; c was blocked by b in the same cascade. Reopening a
    // has to reach both, or every chain longer than two stays broken.
    assert.deepEqual(
      sorted(revivableDependents(["a"], ["b", "c"], [link("b", "a"), link("c", "b")])),
      ["b", "c"],
    );
  });

  it("wakes nothing that is not blocked", () => {
    // c is running, or completed, or anything else: only the ids the caller
    // offers as candidates are eligible, and the walk stops rather than
    // continuing through them.
    assert.deepEqual(
      revivableDependents(["a"], ["b"], [link("b", "a"), link("c", "b")]),
      ["b"],
    );
  });

  it("leaves a run that depends on something else entirely alone", () => {
    assert.deepEqual(revivableDependents(["a"], ["c"], [link("c", "x")]), []);
  });

  it("never wakes the run being reopened", () => {
    // It is mid-reopen and about to be queued; putting it back to `waiting`
    // would strand it behind its own edge.
    assert.deepEqual(revivableDependents(["a"], ["a", "b"], [link("b", "a")]), ["b"]);
  });

  it("terminates on a cycle among blocked rows", () => {
    // Admission refuses a loop, so this should be unreachable — but this walk
    // runs against whatever is in the table, and a hang here is a wedged reopen.
    assert.deepEqual(
      sorted(revivableDependents(["a"], ["b", "c"], [link("b", "a"), link("c", "b"), link("b", "c")])),
      ["b", "c"],
    );
  });

  it("wakes nothing when there is nothing blocked", () => {
    assert.deepEqual(revivableDependents(["a"], [], [link("b", "a")]), []);
  });
});

/**
 * Covers where a run works, on what branch, and measured from where.
 *
 * Three modes now, and the third is the reason this is a function rather than a
 * paragraph inside `planWorkspace`. Every way it can be wrong is silent and
 * lands on disk: a continuation resolved to a fresh branch starts the second
 * agent from the target with the first one's commits nowhere in sight, and a
 * continuation resolved to the predecessor's *tip* instead of the chain's base
 * makes `diff.ts`, `review.ts`, `emitHandoff` and the merge itself cover only
 * the last link — the earlier agents' work invisible in the review and missing
 * from the patch. Neither throws and both typecheck.
 */
describe("isolation for the three modes", () => {
  const probe = {
    mode: "worktree" as const,
    repoRoot: "/ws/repo",
    base: "head-now",
    baseBranch: "main",
  };

  /** The predecessor as it stands after its own run: branch, base, slot. */
  const predecessor = {
    runId: "bbbbbbbb",
    isolation: "worktree" as const,
    repoRoot: "/ws/repo",
    branch: "uf/repo-1-bbbbbbbb",
    base: "chain-base",
    baseBranch: "main",
    worktreePath: "/ws/.uf-worktrees/repo-1",
  };

  const args = {
    runId: "aaaaaaaa-0000-0000-0000-000000000000",
    isolate: true,
    probe,
    continueFrom: null as typeof predecessor | null,
    inheritedSlot: null as string | null,
    freeSlot: "/ws/.uf-worktrees/repo-2" as string | null,
  };

  it("cuts a fresh branch from the folder's HEAD when nothing is continued", () => {
    const plan = resolveIsolation(args);
    assert.equal(plan.mode, "worktree");
    assert.equal(plan.worktreePath, "/ws/.uf-worktrees/repo-2");
    assert.equal(plan.base, "head-now");
    assert.equal(plan.baseBranch, "main");
    // Named from the run's own id, which is what makes it a branch no other run
    // can ever mint and so a claim nothing has to reserve.
    assert.equal(plan.branch, "uf/repo-2-aaaaaaaa");
  });

  it("works in the folder when isolation is off, and says so", () => {
    const plan = resolveIsolation({ ...args, isolate: false });
    assert.equal(plan.mode, "none");
    assert.match(plan.reason ?? "", /turned off/);
  });

  it("takes the predecessor's branch and the chain's base, not its tip", () => {
    // The whole point. `worktree_base` is what every diff, every review and the
    // merge measure from, so anchoring on the predecessor's tip would show and
    // land only this link and drop every commit made before it.
    const plan = resolveIsolation({
      ...args,
      continueFrom: predecessor,
      inheritedSlot: predecessor.worktreePath,
      freeSlot: null,
    });
    assert.equal(plan.mode, "worktree");
    assert.equal(plan.branch, "uf/repo-1-bbbbbbbb");
    assert.equal(plan.base, "chain-base");
    // The land target is the chain's, never re-read off the folder's HEAD.
    assert.equal(plan.baseBranch, "main");
    assert.equal(plan.worktreePath, "/ws/.uf-worktrees/repo-1");
  });

  it("falls back to a fresh checkout when the predecessor's has been taken", () => {
    // What is claimed is the branch, not the slot — so a slot handed to an
    // unrelated run mid-chain costs a fresh checkout and nothing else.
    const plan = resolveIsolation({
      ...args,
      continueFrom: predecessor,
      inheritedSlot: null,
    });
    assert.equal(plan.worktreePath, "/ws/.uf-worktrees/repo-2");
    assert.equal(plan.branch, "uf/repo-1-bbbbbbbb");
    assert.equal(plan.base, "chain-base");
  });

  it("refuses rather than downgrading a continuation it cannot honour", () => {
    // The one asymmetry that matters. A run that merely asked for a checkout
    // still does the work it was given when it cannot have one, in the folder,
    // serialised — every case below returns `mode: "none"` with a reason. A
    // continuation degraded the same way would commit to a branch nobody asked
    // for, which is exactly what this mode exists to prevent, so each of these
    // is a sentence naming what is missing.
    const cases: Array<[string, Parameters<typeof resolveIsolation>[0], RegExp]> = [
      [
        "the predecessor never had a branch",
        { ...args, continueFrom: { ...predecessor, isolation: "none", branch: null } },
        /no branch of its own/,
      ],
      [
        "the predecessor never recorded where its branch started",
        { ...args, continueFrom: { ...predecessor, base: null } },
        /never recorded where the branch started/,
      ],
      [
        "this folder cannot have a checkout",
        {
          ...args,
          probe: { mode: "none", reason: "Repository uses submodules." },
          continueFrom: predecessor,
        },
        /Repository uses submodules/,
      ],
      [
        "the branch belongs to another repository",
        { ...args, continueFrom: { ...predecessor, repoRoot: "/ws/other" } },
        /cannot be carried between repositories/,
      ],
      [
        "no checkout is left to put it in",
        { ...args, continueFrom: predecessor, inheritedSlot: null, freeSlot: null },
        /uncommitted work/,
      ],
      [
        "isolation was turned off for the run doing the continuing",
        { ...args, isolate: false, continueFrom: predecessor },
        /without a checkout of its own/,
      ],
    ];

    for (const [what, input, expected] of cases) {
      assert.throws(() => resolveIsolation(input), expected, what);
    }
  });

  it("still downgrades an ordinary run that cannot be isolated", () => {
    // The other side of that asymmetry, unchanged: these are reasons, not
    // refusals, and the run works in the folder.
    const notARepo = { mode: "none" as const, reason: "Not a git repository." };
    assert.deepEqual(resolveIsolation({ ...args, probe: notARepo }), notARepo);

    const exhausted = resolveIsolation({ ...args, freeSlot: null });
    assert.equal(exhausted.mode, "none");
    assert.match(exhausted.reason ?? "", /uncommitted work/);
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
    priorCycles: 0,
    worktreeBranch: null as string | null,
    continuedFrom: null as {
      runId: string;
      branch: string;
      base: string | null;
    } | null,
    continuedWork: "READ-FIRST",
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

  it("says so when the task is being reopened on top of earlier work", () => {
    // The one case the run page reports as a restart. There is no conversation
    // to carry what the previous attempt did, and a bare task tells the agent
    // to do the work it is standing on — so the prompt has to name the state on
    // disk itself.
    const restarted = nextPrompt({ ...base, sessionId: null, priorCycles: 3 });
    assert.match(restarted, /^A previous attempt at this task already ran 3 work cycles/);
    assert.match(restarted, /\n\nTASK$/);

    // An isolated run's earlier work is committed, and the branch is the only
    // place a fresh session can still read it.
    const isolated = nextPrompt({
      ...base,
      sessionId: null,
      isolationPreamble: "PRE",
      priorCycles: 1,
      worktreeBranch: "uf/thing",
    });
    assert.match(isolated, /^PRE\n\nA previous attempt at this task already ran 1 work cycle and committed its work to this branch \(uf\/thing\)/);
    assert.match(isolated, /\n\nTASK$/);
  });

  it("stays silent about earlier work when there is none, or a session holds it", () => {
    // A first cycle is not a restart …
    assert.equal(nextPrompt({ ...base, sessionId: null, priorCycles: 0 }), "TASK");
    // … and a run that can resume already has the whole conversation.
    assert.equal(
      nextPrompt({ ...base, priorCycles: 3, worktreeBranch: "uf/thing" }),
      "CONTINUE",
    );
  });

  it("tells a run picking up another's branch whose work it is standing on", () => {
    // A different case from the restart above, and the difference decides what
    // the agent does: there the work is its own and "carry on from where you
    // stopped" is the instruction, here it is a separate agent's and the branch
    // is the only record of it. Handed the bare task instead, it does the first
    // thing the task says — which is work that is already committed under it.
    const continued = nextPrompt({
      ...base,
      sessionId: null,
      isolationPreamble: "PRE",
      continuedFrom: { runId: "bbbbbbbb", branch: "uf/thing", base: "abc123" },
    });
    assert.match(continued, /^PRE\n\n/);
    assert.match(continued, /uf\/thing/);
    assert.match(continued, /run bbbbbbbb/);
    // The range is the chain's base, which is the same range the run page's
    // diff and any review are measured over — so the agent, the reviewer and
    // the merge are all looking at one thing.
    assert.match(continued, /git log --oneline abc123\.\.HEAD/);
    assert.match(continued, /git diff abc123\.\.\.HEAD/);
    // The editable half is the guidance, and it comes last.
    assert.match(continued, /READ-FIRST\n\nTASK$/);
  });

  it("keeps both notices, branch history before this run's own restart", () => {
    // Both are true of a continuing run that has already been charged for a
    // cycle, and the order is what makes them readable: read the other way the
    // agent meets "carry on from where you stopped" before it has been told the
    // work under it is not its own.
    const both = nextPrompt({
      ...base,
      sessionId: null,
      priorCycles: 2,
      worktreeBranch: "uf/thing",
      continuedFrom: { runId: "bbbbbbbb", branch: "uf/thing", base: "abc123" },
    });
    assert.ok(
      both.indexOf("run bbbbbbbb") <
        both.indexOf("A previous attempt at this task already ran 2 work cycles"),
    );
  });

  it("says nothing about a continued branch once the session exists", () => {
    // The agent read it on the opening turn and the conversation still holds
    // what it found. Restating it is spend for no information, which is the
    // same reason the continuation prompt restates nothing.
    assert.equal(
      nextPrompt({
        ...base,
        continuedFrom: { runId: "bbbbbbbb", branch: "uf/thing", base: "abc123" },
      }),
      "CONTINUE",
    );
  });
});

/**
 * Covers which prompt a reopened run opens with. Pure, billed, and silent when
 * wrong in the direction that matters: `donePushbackPrompt` states that the
 * agent reported the task complete and then forbids new work, so sending it to
 * a run that was cut off by its cycle cap spends a cycle telling it not to
 * finish the job the operator reopened it for. `completed` is written for both
 * endings, which is why the status alone cannot decide this.
 */
describe("prompt for a reopened run", () => {
  const base = {
    status: "completed" as const,
    reportedDone: true,
    sessionId: "sess-1" as string | null,
    note: "",
    donePushback: "PUSHBACK",
  };

  it("pushes back only on a run whose agent really said DONE", () => {
    assert.equal(reopenPrompt(base), "PUSHBACK");
  });

  it("continues a run that only used up its work cycles", () => {
    // The `completed` row `startRun` writes when `iterations >= maxIterations`:
    // same status, same session, and nothing said about the task being done.
    assert.equal(reopenPrompt({ ...base, reportedDone: false }), "");
    assert.notEqual(
      reopenPrompt({ ...base, reportedDone: false }),
      reopenPrompt(base),
    );
  });

  it("continues a run that was interrupted mid-task", () => {
    assert.equal(reopenPrompt({ ...base, status: "failed", reportedDone: false }), "");
    assert.equal(reopenPrompt({ ...base, status: "stopped", reportedDone: false }), "");
    // A DONE latched from an earlier segment does not survive the interruption
    // that ended this one: those runs stopped part-way and are continued.
    assert.equal(reopenPrompt({ ...base, status: "stopped" }), "");
  });

  it("sends the operator's note whatever the run did", () => {
    assert.equal(reopenPrompt({ ...base, note: "NOTE" }), "NOTE");
    assert.equal(
      reopenPrompt({ ...base, reportedDone: false, note: "NOTE" }),
      "NOTE",
    );
    assert.equal(
      reopenPrompt({ ...base, sessionId: null, note: "NOTE" }),
      "NOTE",
    );
  });

  it("drops the pushback when there is no session to push back into", () => {
    // The run restarts from its original task, and `nextPrompt` appends a note
    // to it rather than sending one alone.
    assert.equal(reopenPrompt({ ...base, sessionId: null }), "");
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

/**
 * Covers which refusals are retried in place. It earns a test on the same
 * grounds as `isUsageLimit`, and the two failure modes point opposite ways: a
 * shape that stops being recognised ends a run — with a live session, a held
 * folder and an agent part-way through — for a fault that fixes itself, while
 * one recognised too broadly re-spawns three times into a wall that will refuse
 * every one of them.
 *
 * The five stream sentences are quoted from the shipped CLI, not invented.
 */
describe("transient API failure classification", () => {
  it("matches the CLI's own stream-truncation messages", () => {
    // The one from the issue, plus its four siblings in the same table.
    for (const text of [
      "API Error: Connection closed mid-response. The response above may be incomplete.",
      "API Error: Server error mid-response. The response above may be incomplete.",
      "API Error: Response stalled mid-stream. The response above may be incomplete.",
      "API Error: Response stalled while thinking, before producing a response. Try again.",
      "API Error: Connection closed while thinking, before producing a response. Try again.",
    ]) {
      assert.equal(isTransientApiError(text), true, text);
    }
  });

  it("matches the statuses and error types the provider documents as retryable", () => {
    assert.equal(isTransientApiError("API Error: 529 overloaded_error"), true);
    assert.equal(isTransientApiError("API Error: 500 Internal Server Error"), true);
    assert.equal(isTransientApiError("API Error: 503 Service Unavailable"), true);
    assert.equal(
      isTransientApiError('{"type":"error","error":{"type":"rate_limit_error"}}'),
      true,
    );
  });

  it("matches a connection that never reached a status", () => {
    assert.equal(isTransientApiError("Connection error."), true);
    assert.equal(isTransientApiError("Unable to connect to API"), true);
    assert.equal(isTransientApiError("read ECONNRESET"), true);
    assert.equal(isTransientApiError("TypeError: fetch failed"), true);
  });

  it("leaves permanent failures to end the run", () => {
    // Retrying any of these buys three more of the same answer.
    assert.equal(isTransientApiError("API Error: 401 Invalid API key · Please run /login"), false);
    assert.equal(isTransientApiError("Not logged in · Please run /login"), false);
    assert.equal(
      isTransientApiError("API Error: 400 duplicate tool_use ID in conversation history."),
      false,
    );
    assert.equal(isTransientApiError("Your credit balance is too low"), false);
    assert.equal(isTransientApiError(""), false);
  });

  it("does not read a bare number in ordinary text as a status", () => {
    // `apiError` can carry whatever the CLI summarised the cycle with.
    assert.equal(isTransientApiError("Wrote 500 lines to server.ts"), false);
    assert.equal(isTransientApiError("429 tests passed"), false);
  });

  it("is the second question asked, never the first", () => {
    // A wall can arrive as a 429, and backing off five seconds does not refill
    // an allowance — so the loop tests `isUsageLimit` first and this only ever
    // sees what that rejected. Both being true here is the reason for the order.
    const wall = "API Error: 429 You've hit your weekly limit";
    assert.equal(isUsageLimit(wall), true);
    assert.equal(isTransientApiError(wall), true);
  });

  it("retries a bounded number of times", () => {
    // The cap is what keeps a broken upstream from holding a folder forever;
    // `startRun` indexes a backoff entry per retry, so it must not be zero.
    assert.equal(MAX_TRANSIENT_RETRIES >= 1, true);
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

/**
 * The credential block handed to a work cycle.
 *
 * It earns a test on the same grounds as the rest of this file: it is pure, and
 * every way it can be wrong is silent. Git ignores a `GIT_CONFIG_*` block whose
 * count and pairs disagree — no warning, no non-zero exit — so a mistake here
 * looks exactly like the unauthenticated container it exists to fix, and only
 * shows up as an agent that could not push, inside a tool call nothing here
 * reads. The empty case matters just as much: injecting a helper that answers
 * with an empty password turns "no credentials configured" into a rejected
 * login against whatever the agent was doing.
 */
describe("github credentials for a work cycle", () => {
  const token = "ghp_example";
  const env = githubEnv(token);

  it("hands nothing to the child when no token is configured", () => {
    assert.deepEqual(githubEnv(""), {});
  });

  it("sets both names the gh CLI and its ecosystem read", () => {
    assert.equal(env.GH_TOKEN, token);
    assert.equal(env.GITHUB_TOKEN, token);
  });

  it("numbers the git config block so git does not discard all of it", () => {
    const count = Number(env.GIT_CONFIG_COUNT);
    assert.equal(Number.isInteger(count) && count > 0, true);
    for (let i = 0; i < count; i += 1) {
      assert.equal(typeof env[`GIT_CONFIG_KEY_${i}`], "string");
      assert.equal(typeof env[`GIT_CONFIG_VALUE_${i}`], "string");
    }
    // A pair past the count is a pair git never reads.
    assert.equal(env[`GIT_CONFIG_KEY_${count}`], undefined);
  });

  it("resets the credential helper list before adding its own", () => {
    // A repository cloned on the host can name a helper this image does not
    // have; git consults them in order, so ours has to be the only one.
    const keys: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i += 1) {
      keys.push(env[`GIT_CONFIG_KEY_${i}`]);
      values.push(env[`GIT_CONFIG_VALUE_${i}`]);
    }
    const first = keys.indexOf("credential.https://github.com.helper");
    assert.notEqual(first, -1);
    assert.equal(values[first], "");
    assert.equal(values[first + 1]?.startsWith("!"), true);
    assert.equal(keys[first + 1], "credential.https://github.com.helper");
  });

  it("rewrites an ssh remote, which is the case that cannot be authenticated", () => {
    const rewrites = Object.entries(env)
      .filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
      .filter(([, v]) => v === "url.https://github.com/.insteadOf")
      .map(([k]) => env[k.replace("KEY", "VALUE")]);
    assert.deepEqual(rewrites.sort(), ["git@github.com:", "ssh://git@github.com/"]);
  });

  it("keeps the token out of the git config it writes", () => {
    // `git config --list` is something an agent prints; the helper reads the
    // environment at call time so the value there is `$GH_TOKEN`, not the token.
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("GIT_CONFIG_")) assert.equal(value.includes(token), false);
    }
  });
});

/**
 * Covers the argv an isolated run is spawned with, and the refusals it reports.
 *
 * Both earn a test on the same grounds as everything else here — pure, silent,
 * expensive — and both were written *after* the failure they describe. Four
 * runs finished `completed`, on their own branches, having been told to commit
 * as they went, with every `git add` and `git commit` refused by the permission
 * mode and the whole change left uncommitted in a worktree. Nothing failed;
 * `landState` simply read four branches with no commits on them. The argv is
 * what makes the preamble's instruction possible to obey, and the denial line
 * is what makes it visible when it is not.
 */
describe("buildArgs", () => {
  const base = {
    prompt: "do the thing",
    model: null,
    permissionMode: "acceptEdits" as const,
    resumeSessionId: null,
  };

  it("grants an isolated run the two git commands it is told to use", () => {
    const args = buildArgs({ ...base, isolated: true });
    const at = args.indexOf("--allowedTools");
    assert.notEqual(at, -1, "an isolated run must be able to commit");
    assert.deepEqual(args.slice(at + 1, at + 3), [
      "Bash(git add:*)",
      "Bash(git commit:*)",
    ]);
  });

  it("grants nothing to a run working in the operator's own checkout", () => {
    // It is never told to commit, and auto-approving commits into the tree
    // somebody is working in is a decision nobody asked for.
    assert.equal(buildArgs({ ...base, isolated: false }).includes("--allowedTools"), false);
  });

  /**
   * The other direction, and the more expensive one. `next-server` is the
   * process title of both this server and any dev server an agent starts to
   * check its work, so a name-matched kill aimed at one reaches the other: one
   * `pkill -f "next-server|next dev"` restarted the container and took fourteen
   * runs with it. The argv is the whole mechanism — there is no ownership
   * boundary between an agent and the process supervising it — so it is pinned
   * for every mode, including the one whose entire purpose is skipping checks.
   */
  for (const permissionMode of ["acceptEdits", "bypassPermissions"] as const) {
    for (const isolated of [true, false]) {
      it(`withholds name-matched kills from a ${permissionMode} run (isolated: ${isolated})`, () => {
        const args = buildArgs({ ...base, permissionMode, isolated });
        const at = args.indexOf("--disallowedTools");
        assert.notEqual(at, -1, "no run may select processes to kill by name");
        assert.deepEqual(args.slice(at + 1, at + 3), [
          "Bash(pkill:*)",
          "Bash(killall:*)",
        ]);
        // Denying the command without saying why buys one turn, not a fix:
        // `kill $(pgrep -f next-server)` is not `pkill` and is just as fatal.
        // And a bare prohibition trades this failure for the other one — a dev
        // server nobody can stop, holding its port for the life of the
        // container — so the safe form has to be in there too.
        const said = args[args.indexOf("--append-system-prompt") + 1] ?? "";
        assert.match(said, /next-server/, "must name the collision");
        assert.match(said, /pgrep -P/, "must give the child-process form");
        assert.match(said, /pid=\$!/, "must give the recipe, not just the ban");
      });
    }
  }

  /**
   * A specialised agent reaches a work cycle as one `--agents` pair, and the
   * branch that matters is the one where there is nothing to attach.
   *
   * Both directions are silent. An agent attached wrongly is dropped by the CLI
   * with a zero exit and no warning, leaving a run that looks exactly like a run
   * that was never given one; a flag emitted when nothing was chosen is an empty
   * object where every existing run used to have no flag at all. Neither shows
   * up in the event log, the cost or the transcript — `attributionAgent` simply
   * never names it.
   */
  it("attaches nothing when no agent was chosen", () => {
    assert.equal(buildArgs({ ...base, isolated: true }).includes("--agents"), false);
    assert.equal(
      buildArgs({ ...base, isolated: true, agents: [] }).includes("--agents"),
      false,
    );
  });

  it("attaches a chosen agent as one --agents pair", () => {
    const args = buildArgs({
      ...base,
      isolated: true,
      agents: [
        { name: "reviewer", description: "reads diffs", prompt: "You review.", model: null },
      ],
    });
    const at = args.indexOf("--agents");
    assert.notEqual(at, -1);
    assert.deepEqual(JSON.parse(args[at + 1]), {
      reviewer: { description: "reads diffs", prompt: "You review." },
    });
  });

  /**
   * An agent is offered, never imposed, and it bounds nothing. The deny list is
   * what stands between an agent and the process supervising it, and attaching a
   * specialist must not be a way around it — so the same assertions the modes
   * above make are made again with one attached.
   */
  it("changes none of what bounds the run", () => {
    const agents = [
      { name: "reviewer", description: "reads diffs", prompt: "You review.", model: "sonnet" },
    ];
    const args = buildArgs({ ...base, isolated: true, agents });
    assert.deepEqual(
      args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--disallowedTools") + 3),
      ["Bash(pkill:*)", "Bash(killall:*)"],
    );
    assert.deepEqual(
      args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--allowedTools") + 3),
      ["Bash(git add:*)", "Bash(git commit:*)"],
    );
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
    // `--agent` sets the session's *own* agent, which is a different feature
    // and a different decision. Only the plural flag is wired.
    assert.equal(args.includes("--agent"), false);
  });

  /**
   * The flag that puts a sub-agent's own words in the log, and the one that
   * makes the stream a shape this app has never parsed.
   *
   * Pinned in both directions because it is a *stream-shape* switch rather than
   * a capability: emitted when it was not asked for, every run's log gains a
   * second voice and this app's reverse-engineered parser starts seeing messages
   * with `parent_tool_use_id` on them; omitted when it was, the delegation goes
   * back to being a `Task` call followed by silence. Neither is visible in an
   * exit code. The CLI gates it on `--print` and `--output-format=stream-json`,
   * which the first two pairs of the argv supply unconditionally, so it is never
   * carried into a spawn that would ignore it — that is what the second half of
   * this asserts.
   */
  it("forwards a sub-agent's own words only when asked to", () => {
    assert.equal(
      buildArgs({ ...base, isolated: true }).includes("--forward-subagent-text"),
      false,
    );
    assert.equal(
      buildArgs({ ...base, isolated: true, forwardSubAgentText: false }).includes(
        "--forward-subagent-text",
      ),
      false,
    );

    const args = buildArgs({ ...base, isolated: true, forwardSubAgentText: true });
    assert.equal(args.includes("--forward-subagent-text"), true);
    // The two the CLI gates the flag on. `-p` is `--print`.
    assert.equal(args[0], "-p");
    assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  });

  it("still passes the mode, the model and the session to resume", () => {
    const args = buildArgs({
      ...base,
      model: "claude-opus-5",
      resumeSessionId: "sess-1",
      isolated: true,
    });
    assert.deepEqual(args.slice(0, 2), ["-p", "do the thing"]);
    assert.equal(args[args.indexOf("--model") + 1], "claude-opus-5");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(args[args.indexOf("--resume") + 1], "sess-1");
  });
});

describe("needsLiveSpendTelemetry", () => {
  // Every wrong answer here is silent. False when it should be true leaves the
  // spend guard reading a number frozen for the whole cycle, so a run asked to
  // stop mid-cycle at $5 keeps working — the exact overshoot live enforcement
  // was chosen to avoid, and nothing in the log says the guard was inert.
  const policy = (over: Partial<BudgetPolicy>): BudgetPolicy => ({
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    maxRunCostUSD: null,
    maxRunTokens: null,
    maxIterations: 5,
    maxDurationMinutes: null,
    enforcement: "between-cycles",
    continueAfterDone: false,
    ...over,
  });

  it("is needed by a live run with a spending limit", () => {
    for (const enforcement of ["live", "live-resume"] as const) {
      assert.equal(
        needsLiveSpendTelemetry(policy({ enforcement, maxRunCostUSD: 5 })),
        true,
      );
      assert.equal(
        needsLiveSpendTelemetry(policy({ enforcement, maxRunTokens: 1_000 })),
        true,
      );
    }
  });

  it("is not needed between cycles, where the result event is in time", () => {
    // The whole point of the default mode: every cycle reports its own cost
    // before the next guard check, so there is nothing for telemetry to add.
    assert.equal(
      needsLiveSpendTelemetry(
        policy({ enforcement: "between-cycles", maxRunCostUSD: 5, maxRunTokens: 1_000 }),
      ),
      false,
    );
  });

  it("is not needed by a live run guarding only on windows or the clock", () => {
    // Those move on every tick already — the fractions off a fresh snapshot,
    // the duration off the wall clock — so forcing an export would collect
    // records nothing reads.
    assert.equal(
      needsLiveSpendTelemetry(
        policy({
          enforcement: "live",
          maxSessionFraction: 0.5,
          maxWeeklyFraction: 0.8,
          maxDurationMinutes: 30,
        }),
      ),
      false,
    );
  });

  it("treats a zeroed limit as no limit, the way normalizePolicy does", () => {
    // `normalizePolicy` maps 0 to null, so a policy that reaches the loop can
    // only carry null or a real limit; going by truthiness here would then
    // disagree with the guard about whether one exists.
    assert.equal(
      needsLiveSpendTelemetry(
        normalizePolicy({
          enforcement: "live",
          maxRunCostUSD: 0,
          maxIterations: 5,
        }),
      ),
      false,
    );
    assert.equal(
      needsLiveSpendTelemetry(
        normalizePolicy({
          enforcement: "live",
          maxRunCostUSD: 5,
          maxIterations: 5,
        }),
      ),
      true,
    );
  });
});

describe("permissionDenials", () => {
  it("names the command, because every denial's tool_name is Bash", () => {
    // The shape is copied from a real `result` event: tool_name is the tool,
    // and what was actually refused is in tool_input.command.
    assert.deepEqual(
      permissionDenials([
        {
          tool_name: "Bash",
          tool_use_id: "toolu_01",
          tool_input: { command: "git push", description: "Run git push" },
        },
      ]),
      ["Bash (git push)"],
    );
  });

  it("groups a refusal the agent retried, which is how they arrive", () => {
    const denials = permissionDenials([
      { tool_name: "Bash", tool_input: { command: "git commit -am 'x'" } },
      { tool_name: "Bash", tool_input: { command: "git commit -am 'x'" } },
      { tool_name: "WebFetch" },
    ]);
    assert.deepEqual(denials, ["Bash (git commit -am 'x') ×2", "WebFetch"]);
  });

  it("is empty for a build that stops sending the field", () => {
    // Read defensively on purpose: this shape was captured from one CLI build,
    // and a cycle must not fail to finish because its result event changed.
    for (const raw of [undefined, null, "nope", [], [{}], [{ tool_name: "" }]]) {
      assert.deepEqual(permissionDenials(raw), []);
    }
  });
});

describe("matchesCopyGlobs", () => {
  // Every one of these is a file `seedWorktree` either copies into a fresh
  // checkout or leaves out, and both mistakes surface inside a tool call: an
  // agent whose first command wants an env file that is not there, or a secret
  // the operator named in an exclusion sitting in a worktree anyway.

  it("reads * as any run of characters", () => {
    assert.equal(matchesCopyGlobs(".env.local", [".env.*"]), true);
    assert.equal(matchesCopyGlobs(".env", [".env.*"]), false);
    assert.equal(matchesCopyGlobs("env.local", [".env.*"]), false);
  });

  it("reads ? as exactly one character, not as a quantifier", () => {
    // The whole of the defect: `?` used to reach the regex unescaped and
    // untranslated, making the preceding token optional — so each of these
    // three answered the opposite of what was asked.
    assert.equal(matchesCopyGlobs(".env", [".env?"]), false);
    assert.equal(matchesCopyGlobs(".envx", [".env?"]), true);
    assert.equal(matchesCopyGlobs(".en", [".env?"]), false);
  });

  it("reads ? the same way inside a negation", () => {
    // Where it is most expensive: a wrong answer here copies a file the
    // operator wrote an exclusion for, or withholds one they did not.
    const globs = [".env.*", "!.env?.local"];
    assert.equal(matchesCopyGlobs(".envx.local", globs), false);
    assert.equal(matchesCopyGlobs(".env.local", globs), true);
  });

  it("keeps every other regex metacharacter literal", () => {
    assert.equal(matchesCopyGlobs("aXc", ["a.c"]), false);
    assert.equal(matchesCopyGlobs("a.c", ["a.c"]), true);
    assert.equal(matchesCopyGlobs("ab", ["a+b"]), false);
    assert.equal(matchesCopyGlobs("a+b", ["a+b"]), true);
    assert.equal(matchesCopyGlobs("a", ["(a|b)"]), false);
    assert.equal(matchesCopyGlobs("(a|b)", ["(a|b)"]), true);
  });

  it("lets a later pattern overrule an earlier one, in both directions", () => {
    const globs = [".env", ".env.*", "!.env.example"];
    assert.equal(matchesCopyGlobs(".env", globs), true);
    assert.equal(matchesCopyGlobs(".env.local", globs), true);
    assert.equal(matchesCopyGlobs(".env.example", globs), false);
    assert.equal(matchesCopyGlobs("package.json", globs), false);
    // A re-inclusion after an exclusion wins, because later patterns win.
    assert.equal(matchesCopyGlobs(".env.example", [...globs, ".env.example"]), true);
  });
});

/**
 * Covers which `blocked` rows `reopenRun` picks up, and what each becomes.
 *
 * `blocked` splits two ways and the split is silent: the dependency kind never
 * reached a workspace and rejoins at `waiting`, where `admitWaiting` plans one;
 * the guard kind was refused by its own budget *after* `ensureWorktree` had
 * already given it a checkout, so it rejoins the queue. Refusing the second was
 * exactly backwards — raising the limit is the fix for such a run, and taking a
 * budget is why this function has the shape it does — and it left the operator
 * retyping the prompt and the guards into the new-run form, with the run's
 * branch orphaned in a slot a later run can take.
 *
 * The two ways of getting this wrong are the reason it is worth a test: sending
 * the guard kind back to `waiting` allocates a second checkout slot on top of
 * the first, and both readings typecheck and throw nothing. So the assertion is
 * the status *and* `work_dir`, never just the `ok`.
 *
 * Unlike everything above it this one is not a pure function, and it earns the
 * database on `haltedMembers.test.ts`'s terms: what it pins is a state
 * transition, and `reopenRun` is where that transition is decided. The rows are
 * inserted rather than built through `createRun`, which would drag in a git
 * probe and a real spawn.
 */
describe("picking up a blocked run", () => {
  /** Room for the reopen, so nothing but the status gate can be what refuses. */
  const RAISED: Partial<BudgetPolicy> = {
    maxIterations: 5,
    maxDurationMinutes: 60,
  };
  const BUDGET_BLOB = '{"maxIterations":1,"permissionMode":"acceptEdits"}';
  let seq = 0;

  function insertRun(fields: {
    status: string;
    workDir: string | null;
    folder?: string;
  }): string {
    const id = `reopen-${++seq}`;
    db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                           iterations, created_at, finished_at, stop_reason, work_dir)
         VALUES (?, ?, 'do the thing', ?, ?, 1, 0, ?, ?, 'refused', ?)`,
      )
      .run(
        id,
        fields.folder ?? `${ws}/RepoOne`,
        fields.status,
        BUDGET_BLOB,
        Date.now() + seq,
        Date.now() + seq,
        fields.workDir,
      );
    return id;
  }

  it("re-queues one its own guard refused, keeping the workspace it has", () => {
    // What `startRun` writes when the pre-cycle guard refuses cycle 1: blocked,
    // nothing spent, and a `work_dir` because `ensureWorktree` ran before it.
    const refused = insertRun({ status: "blocked", workDir: `${ws}/RepoOne` });
    // A run already in that folder, so `promoteQueued` at the end of the reopen
    // has nothing to start. The subject here is the row, not the spawn.
    insertRun({ status: "running", workDir: `${ws}/RepoOne` });

    const outcome = reopenRun(refused, RAISED);

    assert.equal(
      outcome.ok,
      true,
      outcome.ok ? "" : `refused: ${outcome.reason}`,
    );
    const row = getRun(refused)!;
    assert.equal(row.status, "queued", "it has a workspace, so it joins the queue");
    assert.equal(
      row.work_dir,
      `${ws}/RepoOne`,
      "the workspace it was refused with must survive — re-planning one through " +
        "`admitWaiting` would allocate a second checkout slot and orphan the first",
    );
    assert.equal(row.max_iterations, 5, "the raised budget is what it carries back");
    assert.equal(row.stop_reason, null);
    assert.equal(row.finished_at, null);
  });

  it("still sends one blocked behind a dependency back to waiting", () => {
    // The other half of the split, and the control: this row never reached a
    // workspace, so it must not be queued with a null `work_dir`.
    const dependency = insertRun({ status: "stopped", workDir: `${ws}/Other` });
    const dependent = insertRun({ status: "blocked", workDir: null });
    db()
      .prepare(
        "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
          " VALUES (?, ?, 'on-success', 0, ?)",
      )
      .run(dependent, dependency, Date.now());

    assert.equal(reopenRun(dependent, RAISED).ok, true);

    // Asked again and re-blocked inside the same call, because the run in front
    // of it is still terminal having run no cycle. What matters is that it went
    // through the admission that plans a workspace rather than round it.
    const row = getRun(dependent)!;
    assert.notEqual(row.status, "queued");
    assert.equal(row.work_dir, null);
  });
});
