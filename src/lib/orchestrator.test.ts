import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { BudgetPolicy } from "./budget";
// Type-only, so it is erased rather than hoisted above the environment setup
// below — the same reason the values come through `require`.
import type { PersistedRunEvent, RunStatus } from "./orchestrator";

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
// Pinned rather than left to fall back to CLAUDE_HOME: the sweeper cases below
// reach `currentSnapshot()`, which reads `planUsage()`, which sends an HTTP
// request when it finds an OAuth token in this directory. An ambient
// CLAUDE_CONFIG_DIR would make a unit test talk to Anthropic on the operator's
// own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
// The reopen case below is the one test here that reaches the database, and
// `reopenRun` ends in `promoteQueued`. Its fixture keeps the folder occupied so
// nothing is promotable, and this is the second lock on the same door: a
// `claude` that does not exist makes a regression that gets as far as a spawn a
// failed test rather than a billed one.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");
// `BUILD_CACHE_DIRS` reads GOPATH once, at import, and falls back to `$HOME/go`.
// The image sets the two equal; a developer's shell need not, and a test that
// asserted the fallback while the code read the variable would pass or fail on
// whoever ran it. Pinned above the `require` for the same reason as the others.
process.env.GOPATH = path.join(tmp, "gopath");
// And TMPDIR, which the write set follows for the same reason: the sandbox
// creates its sockets under it, and `os.tmpdir()` reads it at every call.
process.env.TMPDIR = path.join(tmp, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

// `require`, not `import`: imports are hoisted above the environment setup
// above, and the module reads WORKSPACE_ROOTS once at load.
const {
  buildArgs,
  clampRunOffset,
  compactionNotice,
  conflictKey,
  contextShapingEnv,
  cycleEnding,
  cycleSilenceMs,
  declaresSubmodule,
  dependencyCycle,
  isRunStatus,
  normalizeRunListQuery,
  duePausedRuns,
  edgeSatisfied,
  injectionFates,
  guardScanDue,
  interruptOutcome,
  liveTickPlan,
  overlaps,
  planPausedRun,
  releasableRuns,
  resolveIsolation,
  revivableDependents,
  getRun,
  githubEnv,
  isRateLimited,
  isTransientApiError,
  isUsageLimit,
  copyGlobsFor,
  cycleCostAfterResult,
  logLifecycle,
  maxRetriesFor,
  transientBackoffMs,
  matchesCopyGlobs,
  planSeedCopies,
  seedReport,
  needsLiveSpendTelemetry,
  nextPrompt,
  permissionDenials,
  refusalDisposition,
  refusalStopReason,
  refusalKind,
  refusalResumeAt,
  reopenPrompt,
  reopenRun,
  sandboxArgs,
  sandboxSettings,
  contextAfterPrune,
  startsFresh,
  SEARCH_TOOLS,
  selectPromotable,
  sweepPaused,
  telemetryEnv,
  toolResultFailures,
  worktreeSlug,
  MAX_PAUSES_PER_RUN,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RESUMES_PER_SWEEP,
  MAX_TRANSIENT_RETRIES,
  NEEDS_REVIEW_NOTICE,
  SURVIVAL_TABLE_CLI_VERSION,
} = require("./orchestrator") as typeof import("./orchestrator");

const { CLAUDE_CONFIG_DIR } = require("./config") as typeof import("./config");
const { normalizePolicy } = require("./budget") as typeof import("./budget");
const { revokeIngestTokens, runForIngestToken } =
  require("./otlp") as typeof import("./otlp");
const { db } = require("./db") as typeof import("./db");
const { saveSettings } = require("./settings") as typeof import("./settings");

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
 * Covers the name a repository's checkouts are stored under. Pure, and it earns
 * a test for the reason the predicate above does: the whole failure is silent
 * here and permanent. Two repositories sharing one slug are handed one
 * directory, and since allocation is deterministic and the other repository's
 * checkout is clean — so never `taken`, never `dirty` — every isolated run on
 * the second repository dies at `git worktree add` on the lowest slot, for
 * ever, with a git error that does not name the cause.
 */
describe("checkout slot naming", () => {
  // The store shares one directory per mount, and `scanWorkspace` descends two
  // levels, so a mount holding both `acme/web` and `acme-web` is ordinary
  // rather than contrived: some repositories cloned into an org directory and
  // some cloned flat.
  const colliding = [
    "acme/web",
    "acme-web",
    "my project",
    "my/project",
    "my-project",
    "a-/b",
    "a/-b",
    "acme/web/api",
    "acme-web-api",
  ];

  it("gives every one of them its own name", () => {
    const seen = new Map<string, string>();
    for (const rel of colliding) {
      const slug = worktreeSlug(rel);
      const clash = seen.get(slug);
      assert.equal(clash, undefined, `${rel} and ${clash} both slugify to ${slug}`);
      seen.set(slug, rel);
    }
  });

  it("gives them their own slot paths, across every slot number", () => {
    // What is actually allocated is `<slug>-<slot>`, so an injective slug is
    // only half of it: the hash is fixed-width and sits immediately before that
    // suffix, which is what keeps the trailing field readable as the slot and
    // stops one repository's slot 11 landing on another's slot 1.
    const seen = new Set<string>();
    for (const rel of colliding) {
      for (let slot = 1; slot <= 64; slot++) {
        const dir = `${worktreeSlug(rel)}-${slot}`;
        assert.equal(seen.has(dir), false, `${rel} slot ${slot} collides on ${dir}`);
        seen.add(dir);
      }
    }
  });

  it("stays a path-safe name", () => {
    for (const rel of [...colliding, "", "Ünicode/Repo", "..", "a".repeat(80)]) {
      assert.match(worktreeSlug(rel), /^[a-z0-9._-]+$/);
    }
  });

  it("is stable across calls", () => {
    // A slug that moved between processes would orphan every checkout on disk
    // and every branch's worktree registration on each restart.
    assert.equal(worktreeSlug("acme/web"), worktreeSlug("acme/web"));
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

  /**
   * A run that reported it could not finish is terminal, and is not a success.
   *
   * Both halves are cheap to get wrong and neither throws. Miss the terminal
   * half — the `TERMINAL_STATUSES` entry — and an `on-finish` dependent waits
   * for ever behind a run that finished hours ago, with nothing on any page
   * saying why. Read it as a success instead and the next run in the chain
   * starts on top of work that did not happen, which is the failure the whole
   * `on-success` reading exists to prevent.
   */
  it("settles a chain on needs-review without treating it as success", () => {
    const stuck = { id: "a", status: "needs-review" as const, iterations: 1 };
    assert.equal(edgeSatisfied(stuck, "on-success"), false);
    assert.equal(edgeSatisfied(stuck, "on-finish"), true);
    // The rule that makes a chain terminate rather than sit there applies here
    // too: a run that never opened a file satisfies neither condition, whatever
    // it ended as.
    const empty = { ...stuck, iterations: 0 };
    assert.equal(edgeSatisfied(empty, "on-success"), false);
    assert.equal(edgeSatisfied(empty, "on-finish"), false);
  });

  it("blocks an on-success dependent behind it and starts an on-finish one", () => {
    const stuck = { id: "a", status: "needs-review" as const, iterations: 1 };
    const refused = releasableRuns([stuck, waiting("b")], [link("b", "a")]);
    assert.deepEqual(refused.release, []);
    assert.equal(refused.block.length, 1);
    // Named, not merely blocked: the sentence is the only thing on the page that
    // sends the operator to the run holding the chain up.
    assert.match(refused.block[0].reason, /run a\b/);
    assert.match(refused.block[0].reason, /needs-review/);

    assert.deepEqual(
      releasableRuns([stuck, waiting("b")], [link("b", "a", "on-finish")]),
      { release: ["b"], block: [] },
    );
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

  /** What the allocator saw with every slot spoken for. */
  const census = {
    ceiling: 64,
    heldByRuns: 25,
    dirty: 39,
    foreign: 0,
    store: "/ws/.uf-worktrees" as string | null,
  };

  const args = {
    runId: "aaaaaaaa-0000-0000-0000-000000000000",
    isolate: true,
    probe,
    continueFrom: null as typeof predecessor | null,
    inheritedSlot: null as string | null,
    freeSlot: "/ws/.uf-worktrees/repo-2" as string | null,
    slotCensus: null as typeof census | null,
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

  it("still downgrades an ordinary run where isolation is unavailable", () => {
    // The other side of that asymmetry, unchanged: isolation being *unavailable*
    // here — not a repository, a bare one, submodules — is a reason and not a
    // refusal, and the run does the work it was given, in the folder.
    const notARepo = { mode: "none" as const, reason: "Not a git repository." };
    assert.deepEqual(resolveIsolation({ ...args, probe: notARepo }), notARepo);
  });

  it("refuses an ordinary isolated run when the slots have run out", () => {
    // This used to be the other half of the test above, and it was the bug: a
    // run that asked for a checkout and could not have one was moved into the
    // operator's own checkout, on whatever branch that checkout was standing
    // on, under `acceptEdits` and without even the `git add`/`git commit` grant
    // `buildArgs` gives an isolated run — announced as a scheduling note. Slots
    // running out is isolation being *used up*, not unavailable, and the
    // downgrade is the exact outcome isolation exists to prevent.
    assert.throws(
      () => resolveIsolation({ ...args, freeSlot: null, slotCensus: census }),
      (err: Error) => {
        assert.match(err.message, /No checkout is left for \/ws\/repo/);
        // What was expected, and where to go and look.
        assert.match(err.message, /all 64 slots in \/ws\/\.uf-worktrees/);
        // What was seen. The old sentence asserted uncommitted work whatever it
        // had found, so a repository whose slots were simply all in use read as
        // one that needed cleaning up.
        assert.match(err.message, /25 held by runs in flight/);
        assert.match(err.message, /39 still holding uncommitted work/);
        return true;
      },
    );
  });

  it("names the mount rather than the slots when the mount has gone", () => {
    // `worktreeStore` answering null is not exhaustion, and telling the
    // operator to go and clean up a directory that is not configured any more
    // sends them looking for something that does not exist.
    assert.throws(
      () =>
        resolveIsolation({
          ...args,
          freeSlot: null,
          slotCensus: { ceiling: 0, heldByRuns: 0, dirty: 0, foreign: 0, store: null },
        }),
      /workspace mount that would hold one is no longer configured/,
    );
  });
});

/**
 * Covers what makes a repository a superproject, and only that.
 *
 * The gate itself is right and stays: git warns against a second checkout of a
 * superproject, so a repository with submodules works in the folder. What this
 * pins is the *reading*, because getting it wrong is silent in both directions
 * and the greedy direction already happened — an unattended run's `git add -A`
 * committed an empty `.gitmodules`, an existence check read it as a
 * superproject, and every run on this repository for the next five days edited
 * the operator's own checkout on whatever branch it stood on. A folder run is a
 * legitimate degrade, so nothing threw and nothing looked wrong.
 */
describe("what counts as a repository with submodules", () => {
  it("reads an entry, not a file", () => {
    // The file that caused it, and the two shapes git itself writes.
    assert.equal(declaresSubmodule(""), false);
    assert.equal(declaresSubmodule("\n# left behind by a tidy-up\n\n"), false);
    assert.equal(
      declaresSubmodule('[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ../lib.git\n'),
      true,
    );
    // Section names are case-insensitive in git's config format, a header may
    // be indented, and a submodule section is rarely the first one.
    assert.equal(declaresSubmodule('[core]\n\tx = 1\n  [SUBMODULE "v"]\n\tpath = v\n'), true);
  });

  it("does not take the word from a value or a comment", () => {
    // A path or a comment mentioning submodules is not a declaration of one,
    // and treating it as one costs the repository its isolation permanently.
    assert.equal(declaresSubmodule("# no [submodule] sections here yet\n"), false);
    assert.equal(declaresSubmodule('[core]\n\tpath = vendor/submodule\n'), false);
  });
});

/**
 * Covers how a work cycle's own last turn ends the run.
 *
 * The regexes are not what earns this — a bare matcher would pin the language,
 * and the DONE one has gone untested since it was written. What earns it is the
 * **precedence**, which is a decision: a turn carrying both tokens is an agent
 * contradicting itself, and getting it backwards files a run that said it was
 * stuck as green `completed` — the exact defect the needs-review ending exists
 * to remove, throwing nothing and typechecking cleanly.
 *
 * The negative cases are the other half and they are the ones that will actually
 * be exercised: the first task to run through this feature is a task *about* it,
 * whose text carries the token in prose. Measured on this install, a task whose
 * text merely carried `DONE` ended its run in a single cycle 53% of the time
 * against 2 of 120 without it, so the two guards — a different spelling from the
 * stored status, and alone on its own line — are load-bearing rather than tidy.
 */
describe("what a work cycle's final text ends the run as", () => {
  it("reads each token when it is alone on its line", () => {
    assert.equal(cycleEnding("All done.\nDONE\n"), "done");
    assert.equal(cycleEnding("I cannot get past this.\nNEEDS_REVIEW\n"), "needs-review");
    // Leading whitespace is tolerated, as the DONE matcher has always been: an
    // agent that indents its last line has still reported the ending.
    assert.equal(cycleEnding("text\n   NEEDS_REVIEW   "), "needs-review");
    assert.equal(cycleEnding("nothing reported here"), null);
    assert.equal(cycleEnding(""), null);
  });

  it("lets the ending that asks for a person win over the one that does not", () => {
    // Both in one turn is an agent contradicting itself. `completed` is
    // ok-toned, green, and the one ending nobody re-reads; needs-review is
    // warn-toned, reopenable and asks for somebody — so the recoverable reading
    // is the safe one to err toward, in either order.
    assert.equal(cycleEnding("DONE\nNEEDS_REVIEW\n"), "needs-review");
    assert.equal(cycleEnding("NEEDS_REVIEW\nDONE\n"), "needs-review");
  });

  it("ignores the token mentioned rather than reported", () => {
    // The case that will bite first, because the first task to exercise this
    // feature is a task about this feature.
    assert.equal(cycleEnding("Reply with NEEDS_REVIEW to end the run."), null);
    assert.equal(cycleEnding("I added the NEEDS_REVIEW sentinel\nand tests."), null);
    assert.equal(cycleEnding("reply with exactly `NEEDS_REVIEW` on its own line"), null);
    assert.equal(cycleEnding("> NEEDS_REVIEW"), null);
    // The stored value is lowercase and hyphenated where the sentinel is
    // uppercase and underscored, so a task that quotes the *status* — which is
    // what a task about this app would do — cannot trip the matcher. This is
    // why the two spellings differ, and it should not be tidied away.
    assert.equal(cycleEnding("The run ended needs-review."), null);
    assert.equal(cycleEnding("needs-review\n"), null);
    // The same guard on the older token, which has never had one.
    assert.equal(cycleEnding("I am not DONE yet."), null);
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
    // Off in the base so every case below reads as it did before the completion
    // notice existed; the cases that are *about* it turn it on by name.
    endsOnDone: false,
  };

  /**
   * Every prompt but the operator's own note carries the needs-review contract,
   * so the equalities below compose against it rather than dropping to a
   * substring match. Weaker assertions here would stop saying that the prompt is
   * *exactly* its part plus the notice, which is the only thing that catches a
   * second sentence being appended by accident.
   */
  const wall = (s: string) => `${s}\n\n${NEEDS_REVIEW_NOTICE}`;

  it("opens with the task when there is no session to resume", () => {
    assert.equal(nextPrompt({ ...base, sessionId: null }), wall("TASK"));
  });

  it("prepends the isolation preamble only on that opening turn", () => {
    const opened = nextPrompt({
      ...base,
      sessionId: null,
      isolationPreamble: "PRE",
    });
    // Composition rather than the literal: the shared-checkout notice sits
    // between the two and pinning its whole text here would make every wording
    // change a test edit. What matters is that the preamble still opens the
    // prompt and the task still closes it.
    assert.ok(opened.startsWith("PRE\n\n"));
    assert.ok(opened.endsWith(`\n\n${wall("TASK")}`));
    // Mid-conversation the agent is already in its worktree and has been told.
    assert.equal(
      nextPrompt({ ...base, isolationPreamble: "PRE" }),
      wall("CONTINUE"),
    );
  });

  it("warns an isolated run that the stash stack is shared, and only there", () => {
    // `refs/stash` is a common ref: a bare `git stash pop` in one worktree
    // applies and drops whatever a sibling run pushed. The preamble says the
    // checkout is the agent's own, which is exactly the belief that makes the
    // bare pop look safe, so the correction travels with it.
    const isolated = nextPrompt({
      ...base,
      sessionId: null,
      isolationPreamble: "PRE",
    });
    assert.match(isolated, /refs\/stash/);
    assert.match(isolated, /stash@\{n\}/);
    // A run in the operator's own checkout has no sibling worktree to collide
    // with, and gets neither the preamble nor this.
    assert.equal(nextPrompt({ ...base, sessionId: null }), wall("TASK"));
    // Not on a resumed cycle, for the preamble's reason: it is carried by the
    // opening turn of the conversation it is true of.
    assert.equal(
      nextPrompt({ ...base, isolationPreamble: "PRE" }),
      wall("CONTINUE"),
    );
  });

  it("continues an existing session rather than restating the task", () => {
    assert.equal(nextPrompt(base), wall("CONTINUE"));
  });

  it("pushes back instead of continuing after a DONE", () => {
    // The continuation prompt asks for DONE when the work is complete, so
    // replying to a DONE with it is a billed cycle that only says DONE again.
    assert.equal(nextPrompt({ ...base, justRetriggered: true }), wall("PUSHBACK"));
  });

  it("sends the operator's note as the whole turn", () => {
    // The one branch the needs-review contract is *not* appended to: this is the
    // operator's own words, which docs/runs.md promises are sent verbatim, and a
    // run whose operator wrote a note already has the person that contract
    // exists to reach. The next cycle restates it either way.
    assert.equal(nextPrompt({ ...base, followUp: "NOTE" }), "NOTE");
  });

  it("appends the note instead when the task has to start over", () => {
    // Without a session there is no conversation for a reply to land in, and a
    // note that only makes sense as one would read as the entire job.
    assert.equal(
      nextPrompt({ ...base, sessionId: null, followUp: "NOTE" }),
      wall("TASK\n\nNOTE"),
    );
    const isolated = nextPrompt({
      ...base,
      sessionId: null,
      isolationPreamble: "PRE",
      followUp: "NOTE",
    });
    assert.ok(isolated.startsWith("PRE\n\n"));
    assert.ok(isolated.endsWith(`\n\n${wall("TASK\n\nNOTE")}`));
  });

  it("says so when the task is being reopened on top of earlier work", () => {
    // The one case the run page reports as a restart. There is no conversation
    // to carry what the previous attempt did, and a bare task tells the agent
    // to do the work it is standing on — so the prompt has to name the state on
    // disk itself.
    const restarted = nextPrompt({ ...base, sessionId: null, priorCycles: 3 });
    assert.match(restarted, /^A previous attempt at this task already ran 3 work cycles/);
    assert.ok(restarted.endsWith(`\n\n${wall("TASK")}`));

    // An isolated run's earlier work is committed, and the branch is the only
    // place a fresh session can still read it.
    const isolated = nextPrompt({
      ...base,
      sessionId: null,
      isolationPreamble: "PRE",
      priorCycles: 1,
      worktreeBranch: "uf/thing",
    });
    assert.ok(isolated.startsWith("PRE\n\n"));
    assert.match(
      isolated,
      /A previous attempt at this task already ran 1 work cycle and committed its work to this branch \(uf\/thing\)/,
    );
    // The preamble and its shared-checkout notice come first — both are facts
    // about the machine, and the prior-work notice is a fact about this run.
    assert.ok(
      isolated.indexOf("refs/stash") < isolated.indexOf("A previous attempt"),
    );
    assert.ok(isolated.endsWith(`\n\n${wall("TASK")}`));
  });

  it("stays silent about earlier work when there is none, or a session holds it", () => {
    // A first cycle is not a restart …
    assert.equal(
      nextPrompt({ ...base, sessionId: null, priorCycles: 0 }),
      wall("TASK"),
    );
    // … and a run that can resume already has the whole conversation.
    assert.equal(
      nextPrompt({ ...base, priorCycles: 3, worktreeBranch: "uf/thing" }),
      wall("CONTINUE"),
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
    // `--stat`, never the diff: what the opening turn reads is re-sent on every
    // turn after it, and the stat names the same files for a fraction of the
    // resident context. A bare `git diff` here cost tens of thousands of tokens
    // per continued run and nothing looked wrong, so the flag is pinned.
    assert.match(continued, /git diff --stat abc123\.\.\.HEAD/);
    assert.doesNotMatch(continued, /git diff abc123/);
    // The editable half is the guidance, and it comes last.
    assert.ok(continued.endsWith(wall("READ-FIRST\n\nTASK")));
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
      wall("CONTINUE"),
    );
  });

  /**
   * The one that decides whether a finished run can end itself.
   *
   * `reportedDone` matches `/^\s*DONE\s*$/m` against every cycle's final text,
   * cycle 1 included, but the token was named only by `continuationPrompt` —
   * which `nextPrompt` returns on the `sessionId !== null` branch and nowhere
   * else. So the terminus existed and the first cycle was never told it. Silent
   * in the expensive direction: nothing fails, the run simply buys a second
   * cycle to say one word into a re-sent conversation.
   */
  it("tells the opening cycle how the run ends", () => {
    const opened = nextPrompt({ ...base, sessionId: null, endsOnDone: true });
    assert.ok(opened.startsWith("TASK\n\n"));
    // The same bar the continuation prompt sets, in the same words: cycle 1 and
    // cycle 2 disagreeing about what "finished" means is the bug this closes.
    assert.match(opened, /exactly DONE on its own line/);
    // The escape clause. An instruction an agent cannot satisfy produces churn,
    // not silence — the reason `donePushbackPrompt` carries one too.
    assert.match(opened, /If work remains/);
  });

  it("promises nothing about DONE when DONE would not end the run", () => {
    // `maxIterations === 1` ends the run at the cap either way, so the sentence
    // buys nothing here — and it would still flip `reported_done`, which is the
    // one input to `reopenPrompt`'s pushback branch. `continueAfterDone` is the
    // other: that run is set to carry on past a DONE and `donePushbackPrompt`
    // says so, so promising the opposite on the opening turn is a contradiction
    // the agent meets again on every later cycle.
    assert.equal(
      nextPrompt({ ...base, sessionId: null, endsOnDone: false }),
      wall("TASK"),
    );
  });

  it("keeps the completion notice off a resumed cycle", () => {
    // `continuationPrompt` is already the whole turn there and already carries
    // the contract. Sending both would restate it at the top of a conversation
    // that is re-sent in full on every request.
    assert.equal(nextPrompt({ ...base, endsOnDone: true }), wall("CONTINUE"));
    assert.equal(
      nextPrompt({ ...base, justRetriggered: true, endsOnDone: true }),
      wall("PUSHBACK"),
    );
  });

  it("puts the completion notice after the task, never before it", () => {
    // It is a statement *about* the task above. Read first it is a preamble to
    // an instruction the agent has not seen, and it is also the last thing in
    // the opening context, which is where an instruction about when to stop
    // belongs.
    const opened = nextPrompt({
      ...base,
      sessionId: null,
      isolationPreamble: "PRE",
      followUp: "NOTE",
      endsOnDone: true,
    });
    assert.ok(opened.startsWith("PRE\n\n"));
    assert.ok(opened.indexOf("TASK") < opened.indexOf("exactly DONE"));
    assert.ok(opened.indexOf("NOTE") < opened.indexOf("exactly DONE"));
  });

  /**
   * The other half of the same contract, and the half that is easy to lose.
   *
   * `completed` was written both for a run that replied DONE and for one that
   * used up its cycle cap, so an agent that met a wall had no ending to ask for
   * and `COMPLETION_NOTICE` told it that stopping without DONE bought another
   * cycle. What these pin is that the sentence naming the other ending reaches
   * every cycle of every run — the gating is where this would silently be lost.
   */
  it("tells the opening cycle it may report that it is stuck", () => {
    const opened = nextPrompt({ ...base, sessionId: null, endsOnDone: true });
    assert.match(opened, /exactly NEEDS_REVIEW on its own line/);
    // The bar, not just the token. Without it the ending is a cheaper way out of
    // any large task than doing it.
    assert.match(opened, /only after you have actually tried and been stopped/);
    // Last, and after the completion notice: an instruction about when to stop
    // is a statement about the task above, and both endings read as one contract
    // only if they are adjacent.
    assert.ok(opened.indexOf("TASK") < opened.indexOf("exactly NEEDS_REVIEW"));
    assert.ok(
      opened.indexOf("exactly DONE") < opened.indexOf("exactly NEEDS_REVIEW"),
    );
  });

  it("carries it even where DONE would not end the run", () => {
    // The assertion that pins the ungating, and nothing else reports its loss.
    // `endsOnDone` is false for `maxIterations === 1` and for
    // `continueAfterDone`, because in both a DONE is a promise that would be
    // untrue — but reporting a wall always ends the run with the reason
    // recorded, so neither reason reaches this token. `maxIterations` defaults
    // to 1, so folding this under `endsOnDone` would withhold the new ending
    // from the majority of runs on a stock install: exactly the one-cycle runs
    // that are written green today.
    assert.match(
      nextPrompt({ ...base, sessionId: null, endsOnDone: false }),
      /exactly NEEDS_REVIEW on its own line/,
    );
  });

  it("restates it on the continuation and on the pushback, never on a note", () => {
    // On every cycle rather than on cycle 1 alone: `continuationPrompt` names
    // DONE on each resumed turn, so an agent on cycle 5 that has been re-told
    // about one ending four times and about the other once — on a turn that has
    // scrolled out of the conversation — has been told there is one ending.
    assert.match(nextPrompt(base), /exactly NEEDS_REVIEW on its own line/);
    assert.match(
      nextPrompt({ ...base, justRetriggered: true }),
      /exactly NEEDS_REVIEW on its own line/,
    );
    // And never on the operator's own words, which are promised verbatim.
    assert.equal(nextPrompt({ ...base, followUp: "NOTE" }), "NOTE");
  });
});

/**
 * Whether a work cycle drops its `--resume` because the conversation it would
 * inherit is already large.
 *
 * Pure, billed, and silent in both directions, which is why it is separated
 * from the loop at all. A threshold that fires when it should not throws away a
 * conversation the run had paid for and makes the agent re-derive it; one that
 * never fires is indistinguishable from the setting being off, which is what
 * every install has. Neither shows up anywhere except on the bill.
 *
 * The three refusals are the part worth pinning. Two of them are about a cycle
 * whose prompt is a *reply* — the operator's own message, or the pushback for a
 * run that said DONE and is set to carry on — and `nextPrompt` sends neither
 * once there is no session, so restarting there would answer a reply with the
 * original task. The third is that no reading is not a small reading.
 */
describe("starting a work cycle fresh instead of resuming", () => {
  const base = {
    sessionId: "sess-1",
    contextTokens: 200_000,
    threshold: 150_000 as number | null,
    justRetriggered: false,
    followUp: null as string | null,
  };

  it("sees the conversation a prune just shrank, not the size it was billed at", () => {
    // The two features are independent switches and this is the one place they
    // touch. `startsFresh` reads the last cycle's *billed* window, which was
    // recorded before the boundary prune ran and cannot know about it — so
    // without `contextAfterPrune` a prune that took 95k of turns out of a 200k
    // context would be followed immediately by a fresh start fired on the 200k
    // reading, and the run would pay to re-derive a conversation something had
    // just finished shrinking to fit under the threshold.
    //
    // That is `IterationResult.contextTokens`' own "Last, not largest" warning
    // reached from a direction that did not exist when it was written. Silent in
    // the usual way: the run restarts, works, and costs more, and every page
    // shows an ordinary cycle.
    const outcome = {
      tier: "standard" as const,
      tokensBefore: 250_000,
      tokensAfter: 155_000,
      tokensRemoved: 95_000,
      // Not read here — `contextAfterPrune` is handed the billed figure and
      // subtracts what came out of it. It is on the outcome for the log line,
      // which reports the prune in the ceiling's units.
      apiTokensBefore: 310_000,
      elapsedMs: 1_000,
    };
    const corrected = contextAfterPrune(200_000, outcome);
    // 200,000 - 95,000, not 200,000 x (155/250). The ratio would say 124,000,
    // which shrinks the fixed system prompt and tool list along with the turns
    // — see `contextAfterPrune`, which carries the measurement.
    assert.equal(corrected, 105_000);
    assert.equal(startsFresh({ ...base, contextTokens: 200_000 }), true);
    assert.equal(startsFresh({ ...base, contextTokens: corrected }), false);
  });

  it("leaves the billed figure alone when nothing was pruned", () => {
    // Null is every cycle on an install with pruning off, and the great majority
    // of cycles on one with it on. Scaling by a ratio that does not exist would
    // silently suppress fresh starts fleet-wide.
    assert.equal(contextAfterPrune(200_000, null), 200_000);
    // And a zero `tokensBefore` must not divide: an unreadable transcript
    // reports one, and NaN here would compare false against every threshold,
    // which is the same suppression by another route.
    assert.equal(
      contextAfterPrune(200_000, {
        tier: "standard",
        tokensBefore: 0,
        tokensAfter: 0,
        tokensRemoved: 0,
        apiTokensBefore: 0,
        elapsedMs: 1,
      }),
      200_000,
    );
  });

  it("is off unless the operator set a threshold", () => {
    // Null is the shipped value and has to mean today's behaviour exactly: the
    // resume goes on every cycle, whatever the conversation has grown to.
    assert.equal(startsFresh({ ...base, threshold: null }), false);
    assert.equal(startsFresh({ ...base, threshold: null, contextTokens: 9_000_000 }), false);
  });

  it("fires at the threshold and not below it", () => {
    assert.equal(startsFresh(base), true);
    assert.equal(startsFresh({ ...base, contextTokens: 150_000 }), true);
    assert.equal(startsFresh({ ...base, contextTokens: 149_999 }), false);
  });

  it("does nothing when there is no session to drop", () => {
    // The opening cycle of a run, and the first cycle after a pick-up. Both are
    // already starting a conversation; there is nothing here to be an
    // optimisation of.
    assert.equal(startsFresh({ ...base, sessionId: null }), false);
  });

  it("treats no reading as no reading, never as a small one", () => {
    // A cycle that reported no usage — killed before its first turn, or a
    // provider refusal — measured nothing. Reading a zero as a small context
    // would keep the resume in place, which is the safe direction and the one
    // this pins.
    assert.equal(startsFresh({ ...base, contextTokens: 0 }), false);
    assert.equal(startsFresh({ ...base, contextTokens: -1 }), false);
  });

  it("never restarts a cycle whose prompt is a reply", () => {
    // `nextPrompt` sends the operator's note verbatim only while a session
    // exists, and sends the DONE pushback only there too. Dropping the session
    // under either would replace the reply with the original task — the
    // operator's message silently unanswered, or an agent told to carry on
    // being told instead to start.
    assert.equal(startsFresh({ ...base, followUp: "look at the migration too" }), false);
    assert.equal(startsFresh({ ...base, justRetriggered: true }), false);
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
    restartKilled: false,
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

  it("tells a restart-killed run that its last cycle was cut off", () => {
    // The empty branch used to catch this, so the run was handed
    // `continuationPrompt` — "Continue working on the task. If it is fully
    // complete and verified, reply with exactly DONE" — into a conversation
    // whose last event was a child dying mid-tool-call. The agent has no way to
    // know: from inside, a severed turn and a finished one look the same.
    const killed = reopenPrompt({
      ...base,
      status: "failed",
      reportedDone: false,
      restartKilled: true,
    });
    assert.match(killed, /server restarted/);
    assert.notEqual(killed, "");
  });

  it("puts the restart notice above the pushback, not below it", () => {
    // `reported_done` is whatever the *previous* cycle left on the row, and a
    // cycle killed mid-tool-call never reached the code that changes it. Read in
    // the other order, a run that said DONE two cycles ago, was reopened, worked
    // and was then killed would be told it had reported the task complete — and
    // then forbidden from starting anything new.
    const stale = reopenPrompt({
      ...base,
      status: "failed",
      reportedDone: true,
      restartKilled: true,
    });
    assert.match(stale, /server restarted/);
    assert.notEqual(stale, "PUSHBACK");
  });

  it("keeps the operator's own note above the restart notice", () => {
    // Somebody who typed a message while picking the run up knows what happened
    // to it, and their message is the one thing that outranks every branch here.
    assert.equal(
      reopenPrompt({ ...base, status: "failed", restartKilled: true, note: "NOTE" }),
      "NOTE",
    );
  });

  it("drops the restart notice when there is no session to continue", () => {
    // `nextPrompt` reopens with the task plus `priorWorkNotice`, which already
    // says work happened in this folder. A note about a severed conversation
    // would be describing one that no longer exists.
    assert.equal(
      reopenPrompt({
        ...base,
        status: "failed",
        reportedDone: false,
        restartKilled: true,
        sessionId: null,
      }),
      "",
    );
  });

  /**
   * The pick-up branch for a run that said it could not get past something.
   *
   * Doing nothing here would already have looked correct: the pushback tests
   * `completed`, which this row is not, so the run would fall through to the
   * plain continuation — "Continue working on the task. If it is fully complete
   * and verified, reply with exactly DONE" — into a conversation whose last turn
   * was the agent reporting a wall. That is the same shape as the defect
   * `RESTART_KILLED_NOTICE` was added to fix, on this same function, and it is
   * silent: the run works, spends, and reports the same wall again.
   */
  it("asks a needs-review run whether the wall is still there", () => {
    const picked = reopenPrompt({
      ...base,
      status: "needs-review",
      reportedDone: false,
    });
    assert.notEqual(picked, "");
    assert.match(picked, /check whether what stopped you is still there/);
    // The ordinary reason to reopen one of these with no note is that somebody
    // cleared it, so the alternative is a whole billed cycle finding out.
    assert.notEqual(picked, "PUSHBACK");
  });

  it("keeps the operator's note above it, and drops it with no session", () => {
    assert.equal(
      reopenPrompt({ ...base, status: "needs-review", note: "NOTE" }),
      "NOTE",
    );
    // Without a session `nextPrompt` restarts the original task with
    // `priorWorkNotice`, and a reply-shaped notice would be describing a
    // conversation that no longer exists — both neighbours are gated the same
    // way for the same reason.
    assert.equal(
      reopenPrompt({ ...base, status: "needs-review", sessionId: null }),
      "",
    );
  });

  it("never sends the DONE pushback to a run that said it was stuck", () => {
    // `reported_done` survives the ending it described, so a run that replied
    // DONE in an earlier segment, was reopened, worked and then reported a wall
    // has a stale 1 on its row unless the loop clears it. This is the branch
    // that would act on it: the status has to win.
    assert.notEqual(
      reopenPrompt({ ...base, status: "needs-review", reportedDone: true }),
      "PUSHBACK",
    );
    // The control, and half the test: an ordinary completed run that really did
    // reply DONE is still pushed back on.
    assert.equal(reopenPrompt(base), "PUSHBACK");
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

/**
 * A rate limit is a transient failure, and it is not the same transient
 * failure.
 *
 * At one run a 429 is a burst and 5/20/60 seconds is generous. At twenty-five
 * concurrent runs against one account it is the provider describing this app's
 * own steady-state request rate — so it lasts as long as the fleet keeps
 * asking, the three fast retries become three twenty-five-wide waves into the
 * condition that caused it, and the whole fleet is `failed` inside ninety
 * seconds with every dependent chain `blocked` behind it.
 */
describe("rate limits, apart from the rest", () => {
  it("recognises the two shapes a rate limit arrives in", () => {
    assert.equal(isRateLimited("API Error: 429 Too Many Requests"), true);
    assert.equal(
      isRateLimited('{"type":"error","error":{"type":"rate_limit_error"}}'),
      true,
    );
    assert.equal(isRateLimited(""), false);
    assert.equal(isRateLimited("API Error: 529 overloaded_error"), false);
  });

  it("is a strict subset of the transient set, so it widens nothing", () => {
    // The classification was never what was wrong, and `isTransientApiError` is
    // pinned against sentences read out of the shipped binary. Everything this
    // matches was already retried; all this decides is which ladder and which
    // sentence. Anything it matched that the wider predicate did not would be a
    // new retry nobody argued for.
    for (const text of [
      "API Error: 429 Too Many Requests",
      '{"type":"error","error":{"type":"rate_limit_error"}}',
    ]) {
      assert.equal(isRateLimited(text) && isTransientApiError(text), true, text);
    }
  });

  it("is asked after the wall and before the general blip", () => {
    // A wall can arrive as a 429 and no backoff refills an allowance, so
    // `isUsageLimit` still wins. And the general predicate matches every 429
    // too, so asking it first would file every rate limit under the ladder
    // written for a dropped socket.
    assert.equal(refusalKind("API Error: 429 You've hit your weekly limit"), "allowance");
    assert.equal(refusalKind("API Error: 429 Too Many Requests"), "rate-limit");
    assert.equal(refusalKind("API Error: 503 Service Unavailable"), "transient");
  });

  it("outlasts more than the ninety seconds that killed the fleet", () => {
    // The acceptance test from the issue: a sustained rate limit must not end
    // every run inside two minutes. Measured at the floor of the spread, since
    // that is the shortest the ladder can ever be.
    const floor = Array.from({ length: MAX_RATE_LIMIT_RETRIES }, (_, attempt) =>
      transientBackoffMs({ attempt, kind: "rate-limit", random: () => 0 }),
    ).reduce((a, b) => a + b, 0);
    assert.equal(
      floor >= 10 * 60_000,
      true,
      `the rate-limit ladder tolerates only ${Math.round(floor / 1000)}s`,
    );

    // And the ladder written for a dropped socket is untouched: that fault
    // really does clear in seconds, and minutes of backoff for it would hold a
    // folder and a live session for nothing.
    const transientFloor = Array.from(
      { length: MAX_TRANSIENT_RETRIES },
      (_, attempt) =>
        transientBackoffMs({ attempt, kind: "transient", random: () => 0 }),
    ).reduce((a, b) => a + b, 0);
    assert.equal(transientFloor, 85_000);
  });

  it("ends a rate-limited run with a different sentence from a dead upstream", () => {
    // The operator's response is the opposite in the two cases — wait, versus
    // reduce how many runs share this account — so the two endings must not
    // collapse into one `cause`.
    assert.deepEqual(
      refusalDisposition({
        kind: "rate-limit",
        pauseCount: 0,
        transientRetries: MAX_RATE_LIMIT_RETRIES,
      }),
      { action: "fail", cause: "rate-limited" },
    );
    assert.deepEqual(
      refusalDisposition({
        kind: "transient",
        pauseCount: 0,
        transientRetries: MAX_TRANSIENT_RETRIES,
      }),
      { action: "fail", cause: "retries-spent" },
    );
  });

  it("gives each refusal cause its own instruction to the operator", () => {
    // The test above pins the two *causes* apart; this pins the two sentences
    // apart, which is the half an operator actually reads. `refusalStopReason`
    // is the only place a cause becomes copy, and until it was a `switch` its
    // last arm doubled as the fallback — so a cause added upstream would have
    // rendered as the generic sentence with nothing failing to say so.
    const sentences = (
      ["pauses-spent", "retries-spent", "rate-limited", "other"] as const
    ).map((cause) => refusalStopReason(cause, "API Error: overloaded_error"));

    // Every one names the underlying refusal, and no two read alike.
    for (const s of sentences) assert.match(s, /API Error: overloaded_error$/);
    assert.equal(new Set(sentences).size, sentences.length);

    const [pauses, retries, rateLimited, other] = sentences;
    assert.match(pauses, new RegExp(`waited out ${MAX_PAUSES_PER_RUN} windows`));
    assert.match(
      retries,
      new RegExp(`transient API error on ${MAX_TRANSIENT_RETRIES + 1} attempts`),
    );
    // The one sentence that asks for a different action rather than for
    // patience: it must say to lower the cap, not to wait.
    assert.match(
      rateLimited,
      new RegExp(`rate limited on ${MAX_RATE_LIMIT_RETRIES + 1} attempts`),
    );
    assert.match(rateLimited, /lower the concurrent-run limit rather than waiting/);
    assert.doesNotMatch(other, /rate limited|transient|allowance/);
  });

  it("climbs its own ladder, not the other one", () => {
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      assert.deepEqual(
        refusalDisposition({ kind: "rate-limit", pauseCount: 0, transientRetries: attempt }),
        { action: "retry", attempt, kind: "rate-limit" },
      );
    }
    assert.equal(maxRetriesFor("rate-limit"), MAX_RATE_LIMIT_RETRIES);
    assert.equal(maxRetriesFor("transient"), MAX_TRANSIENT_RETRIES);
  });
});

/**
 * The retry schedule, which was `TRANSIENT_BACKOFF_MS[transientRetries]`.
 *
 * A constant lookup on a per-run counter that starts at 0 for every run, so
 * twenty-five runs meeting one failure at one instant retried at exactly the
 * same three instants — each wave twenty-five simultaneous spawns, which is the
 * condition a rate limit is describing in the first place.
 */
describe("the retry backoff schedule", () => {
  const noJitter = () => 0;
  const allJitter = () => 1;

  for (const kind of ["transient", "rate-limit"] as const) {
    describe(kind, () => {
      it("grows, and keeps growing once the spread is on it", () => {
        for (let attempt = 1; attempt < maxRetriesFor(kind); attempt++) {
          const lower = transientBackoffMs({
            attempt: attempt - 1,
            kind,
            random: allJitter,
          });
          const upper = transientBackoffMs({ attempt, kind, random: noJitter });
          assert.equal(
            upper > lower,
            true,
            `rung ${attempt} at the bottom of its band (${upper}ms) must still ` +
              `exceed rung ${attempt - 1} at the top of its (${lower}ms) — the ` +
              "second failure in a row waiting longer is not a thing to be true " +
              "on average",
          );
        }
      });

      it("never comes back sooner than the rung it was written as", () => {
        // Jitter may only ever delay. The rung is what keeps a retry from
        // being a hot loop, and a spread that could shorten it would undo that
        // silently.
        for (let attempt = 0; attempt < maxRetriesFor(kind); attempt++) {
          const floor = transientBackoffMs({ attempt, kind, random: noJitter });
          for (const random of [noJitter, allJitter, () => 0.5]) {
            assert.equal(transientBackoffMs({ attempt, kind, random }) >= floor, true);
          }
        }
      });

      it("gives two runs at the same attempt two different delays", () => {
        // The regression, at its smallest: the same attempt index and two
        // randomness sources have to disagree, because the attempt index is
        // exactly what twenty-five runs share.
        assert.notEqual(
          transientBackoffMs({ attempt: 0, kind, random: () => 0.1 }),
          transientBackoffMs({ attempt: 0, kind, random: () => 0.9 }),
        );
      });

      it("spreads twenty-five runs meeting one failure at one instant", () => {
        // The same shape the parked fleet is pinned at, one path over: distinct
        // is not enough on its own, the band has to be wide enough that the
        // waves stop being waves.
        let state = 20250814;
        const random = () => {
          state = (state * 1_664_525 + 1_013_904_223) >>> 0;
          return state / 4_294_967_296;
        };
        const delays = Array.from({ length: 25 }, () =>
          transientBackoffMs({ attempt: 0, kind, random }),
        );
        assert.equal(new Set(delays).size >= 24, true);

        const base = transientBackoffMs({ attempt: 0, kind, random: noJitter });
        const spread = Math.max(...delays) - Math.min(...delays);
        assert.equal(
          spread >= base * 0.4,
          true,
          `twenty-five delays span ${spread}ms against a ${base}ms rung`,
        );
      });
    });
  }
});

/**
 * What the loop does about a refused work cycle.
 *
 * Pinned here rather than left inline for the reason `releasableRuns` and
 * `landRefusal` are: the decision is three-way, every wrong answer typechecks,
 * and each costs something different — a blip that ends a run holding a live
 * session, a wall re-spawned into, or a whole fleet ended for the one condition
 * that refills on its own.
 */
describe("what a refused work cycle does next", () => {
  it("names the wall before it names a blip", () => {
    // A wall can arrive as a 429, which `isTransientApiError` also matches. If
    // the order flipped, the run would back off five seconds into an allowance
    // no backoff refills.
    assert.equal(refusalKind("API Error: 429 You've hit your weekly limit"), "allowance");
    assert.equal(refusalKind("API Error: 529 overloaded_error"), "transient");
    assert.equal(refusalKind("API Error: 401 Invalid API key"), "other");
  });

  it("parks a wall whatever the enforcement mode is", () => {
    // The regression. This used to be gated on `enforcement === "live-resume"`,
    // and the default is `between-cycles` — in the run form, in
    // `normalizePolicy` and in `DEFAULT_CHAT_GUARDS` — so the ordinary run met
    // the shared account's wall and was written `failed`, terminally, with the
    // only way back an HTTP request a person makes. At twenty-five runs sharing
    // one allowance that is the steady state, not the exception.
    //
    // The mode is not an argument at all, which is the strongest form of the
    // fix: there is nothing here to gate on. Enforcement answers *when guards
    // are read*; a 5-hour window refilling on its own is a fact about the
    // provider.
    assert.deepEqual(
      refusalDisposition({ kind: "allowance", pauseCount: 0, transientRetries: 0 }),
      { action: "park" },
    );
  });

  it("still stops parking at the lifetime cap, and says it ran out of waits", () => {
    // `MAX_PAUSES_PER_RUN` survives the fix: a refusal is someone else's claim
    // about someone else's counter, and a misread one must not park for ever.
    for (let pauseCount = 0; pauseCount < MAX_PAUSES_PER_RUN; pauseCount++) {
      assert.deepEqual(
        refusalDisposition({ kind: "allowance", pauseCount, transientRetries: 0 }),
        { action: "park" },
        `pause ${pauseCount} is still within the cap`,
      );
    }
    assert.deepEqual(
      refusalDisposition({
        kind: "allowance",
        pauseCount: MAX_PAUSES_PER_RUN,
        transientRetries: 0,
      }),
      // Not "the allowance is gone" — by now it may well have refilled. What
      // ran out is how often one run may wait for it unattended, and the
      // operator's next move differs between the two.
      { action: "fail", cause: "pauses-spent" },
    );
  });

  it("retries a blip up to the ladder's length and then names the attempts", () => {
    for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
      assert.deepEqual(
        refusalDisposition({ kind: "transient", pauseCount: 0, transientRetries: attempt }),
        { action: "retry", attempt, kind: "transient" },
      );
    }
    assert.deepEqual(
      refusalDisposition({
        kind: "transient",
        pauseCount: 0,
        transientRetries: MAX_TRANSIENT_RETRIES,
      }),
      { action: "fail", cause: "retries-spent" },
    );
  });

  it("never parks or retries anything that is neither", () => {
    // A revoked key, a malformed request, an exhausted credit balance: three
    // more attempts buy three more of the same answer, and parking holds a
    // folder for hours to arrive at it.
    assert.deepEqual(
      refusalDisposition({ kind: "other", pauseCount: 0, transientRetries: 0 }),
      { action: "fail", cause: "other" },
    );
  });

  it("does not spend a run's waits on a blip, or its retries on a wall", () => {
    // The two counters are independent and count different things. A run that
    // has parked twice must still get its full retry ladder for a dropped
    // connection, and one that has retried twice must still be allowed to wait.
    assert.deepEqual(
      refusalDisposition({
        kind: "transient",
        pauseCount: MAX_PAUSES_PER_RUN,
        transientRetries: 0,
      }),
      { action: "retry", attempt: 0, kind: "transient" },
    );
    assert.deepEqual(
      refusalDisposition({
        kind: "allowance",
        pauseCount: 0,
        transientRetries: MAX_TRANSIENT_RETRIES,
      }),
      { action: "park" },
    );
  });
});

describe("refusal wake-up time", () => {
  const now = 1_700_000_000_000;
  const min = 5 * 60_000;
  const hour = 3_600_000;
  /**
   * The bottom of the spread, so every case below is about what it was about.
   *
   * The wait is jittered now — see the fleet cases at the end — and the jitter
   * is a parameter for exactly this: passed `() => 0` it contributes nothing,
   * so the ladder, the floor and the cap are still pinned at the same numbers
   * they were before the spread existed.
   */
  const noJitter = () => 0;
  /** The top of it. `Math.random` never returns 1, so this is the open bound. */
  const allJitter = () => 1;

  it("waits for the window when one is still open, plus the settling margin", () => {
    const at = refusalResumeAt({
      boundary: now + 2 * hour,
      pauseCount: 0,
      now,
      random: noJitter,
    });
    assert.equal(at > now + 2 * hour, true);
    assert.equal(at <= now + 2 * hour + 2 * 60_000, true);
  });

  it("backs off when the boundary it can see has already passed", () => {
    // The derived boundary is floored to the hour, so it can be up to an hour
    // early. Trusting it here would re-spawn straight back into the wall.
    const rung = (pauseCount: number, random: () => number) =>
      refusalResumeAt({ boundary: now - hour, pauseCount, now, random });
    const first = rung(0, noJitter);
    const second = rung(1, noJitter);
    const third = rung(2, noJitter);
    assert.equal(first > now + min, true);
    assert.equal(second > first, true);
    assert.equal(third > second, true);
    // Three waits have to cover the floor-to-hour error, or the feature never
    // reaches the reset it is waiting for.
    assert.equal(third - now >= hour, true);

    // And it still climbs once the spread is on it — the case that is not
    // implied by the three above, since a band wider than the gap to the next
    // rung would leave "the second failure in a row waits longer" true only on
    // average, which is not a thing to be true on average.
    assert.equal(rung(1, noJitter) > rung(0, allJitter), true);
    assert.equal(rung(2, noJitter) > rung(1, allJitter), true);
  });

  it("backs off identically when it can see no window at all", () => {
    assert.equal(
      refusalResumeAt({ boundary: null, pauseCount: 0, now, random: noJitter }),
      refusalResumeAt({
        boundary: now - hour,
        pauseCount: 0,
        now,
        random: noJitter,
      }),
    );
  });

  it("never re-spawns immediately, whatever the arithmetic says", () => {
    // A boundary one second out would otherwise mean a spawn per second. The
    // floor sits under the spread rather than over it, so the bottom of the
    // band is the case that has to hold.
    assert.equal(
      refusalResumeAt({
        boundary: now + 1_000,
        pauseCount: 0,
        now,
        random: noJitter,
      }) >= now + min,
      true,
    );
  });

  it("never holds a folder for longer than a window plus slack", () => {
    // Read at the top of the spread: the jitter is added after the cap, so
    // this is the assertion that says it is clamped again afterwards.
    const at = refusalResumeAt({
      boundary: now + 40 * hour,
      pauseCount: 0,
      now,
      random: allJitter,
    });
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
      random: allJitter,
    });
    assert.equal(Number.isFinite(atCap), true);
    assert.equal(atCap <= now + 6 * hour, true);
  });

  /**
   * The fleet, which is where this stopped being right.
   *
   * Everything above is a statement about one run, and every input to it is
   * shared: the ladder is a module constant and the boundary comes from a
   * transcript scan that is *coalesced* across concurrent callers, so
   * twenty-five runs refused inside the same minute read one boundary and, with
   * no randomisation anywhere, computed one answer between them — reproduced by
   * the budgets sweep as literally one distinct `resume_at` across twenty-five
   * runs. They then woke in one sweep, spawned in one turn, met the same wall
   * and re-parked together, three times, at which point the cap ended the fleet.
   */
  describe("with a fleet sharing one wall", () => {
    /**
     * A fixed sequence, so the assertions below are decided by the arithmetic
     * rather than by which draws this run happened to get. Any generator would
     * do; this one is the smallest thing that is neither sorted nor repeating,
     * which is what a real `Math.random` has in common with it.
     */
    function lcg(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 4_294_967_296;
      };
    }

    /** Twenty-five runs refused in the same instant, a millisecond apart. */
    function fleet(boundary: number | null, pauseCount = 0): number[] {
      const random = lcg(20250814);
      return Array.from({ length: 25 }, (_, i) =>
        refusalResumeAt({ boundary, pauseCount, now: now + i, random }),
      );
    }

    it("does not wake twenty-five runs at one instant", () => {
      // The reproduction from the issue: one shared boundary, `now` values a
      // millisecond apart, and before the spread every one of these collapsed
      // to a single value because the boundary branch discards `now` entirely.
      const wakes = fleet(now + 2 * hour);
      const distinct = new Set(wakes).size;
      assert.equal(
        distinct >= 24,
        true,
        `twenty-five runs produced ${distinct} distinct wake times`,
      );

      // Distinct is not enough on its own — twenty-five instants a millisecond
      // apart are also distinct, and the sweeper looks once a minute, so they
      // would still be one tick and one `promoteQueued()`. What matters is the
      // width of the band.
      const spread = Math.max(...wakes) - Math.min(...wakes);
      assert.equal(
        spread >= 10 * 60_000,
        true,
        `the wake times span ${Math.round(spread / 60_000)} minutes`,
      );
    });

    it("spreads the backoff rungs too, not only the boundary", () => {
      // A refused run whose visible boundary has already passed falls through
      // to the ladder, which is a module constant — so this is the branch where
      // the herd is at its most exact. All three rungs are used, because the
      // second and third collisions are the ones that end the fleet.
      for (const pauseCount of [0, 1, 2]) {
        const wakes = fleet(now - hour, pauseCount);
        const spread = Math.max(...wakes) - Math.min(...wakes);
        assert.equal(
          spread >= 5 * 60_000,
          true,
          `rung ${pauseCount} spans only ${Math.round(spread / 60_000)} minutes`,
        );
      }
    });

    it("still refuses to wake any of them early, or to hold one past the cap", () => {
      // The spread is bounded on both sides by the rules that were already
      // here, so widening it can never buy a re-spawn straight into the wall
      // or a folder held for a day.
      // Each run's own `now` is a millisecond later than the last, and both
      // bounds are relative to it.
      fleet(now + 1_000).forEach((at, i) => {
        assert.equal(at >= now + i + min, true);
      });
      fleet(now + 40 * hour).forEach((at, i) => {
        assert.equal(at <= now + i + 6 * hour, true);
      });
    });
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
    maxRunCostUSD: null,
    maxRunCostFactor: null,
    spentGuardUSD: 0,
  };

  /**
   * Everything the one `--allowedTools` flag names, and nothing after it.
   *
   * Written as "up to the next flag" rather than as a fixed slice because the
   * list is now two lists — the isolation grant and the search tools — and a
   * test that counted would pass while granting a command nobody meant to.
   */
  /** Spelled out rather than imported: the grant is the thing under test. */
  const ISOLATED_GIT_TOOLS_EXPECTED = ["Bash(git add:*)", "Bash(git commit:*)"];

  const allowedToolValues = (args: string[]): string[] => {
    const at = args.indexOf("--allowedTools");
    if (at === -1) return [];
    const rest = args.slice(at + 1);
    const end = rest.findIndex((a) => a.startsWith("--"));
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("grants an isolated run the two git commands it is told to use", () => {
    const args = buildArgs({ ...base, isolated: true });
    const at = args.indexOf("--allowedTools");
    assert.notEqual(at, -1, "an isolated run must be able to commit");
    assert.deepEqual(args.slice(at + 1, at + 3), [
      "Bash(git add:*)",
      "Bash(git commit:*)",
    ]);
    // One flag, both lists, and only one flag: a second `--allowedTools` is a
    // variadic option the CLI reads as a replacement, so the isolation grant
    // and the search tools have to travel together or one of them is lost.
    assert.deepEqual(allowedToolValues(args), [
      ...ISOLATED_GIT_TOOLS_EXPECTED,
      ...SEARCH_TOOLS,
    ]);
    assert.equal(args.filter((a) => a === "--allowedTools").length, 1);
  });

  it("grants no command to a run working in the operator's own checkout", () => {
    // It is never told to commit, and auto-approving commits into the tree
    // somebody is working in is a decision nobody asked for. The flag itself is
    // now always there — `SEARCH_TOOLS` is what makes the CLI offer `Grep` and
    // `Glob` at all — so what this pins is that it names nothing that can run.
    const granted = allowedToolValues(buildArgs({ ...base, isolated: false }));
    assert.deepEqual(granted, [...SEARCH_TOOLS]);
    assert.equal(
      granted.some((tool) => tool.startsWith("Bash(")),
      false,
      "a run in the operator's own checkout must be granted no command",
    );
  });

  it("carries plugin directories on a resumed cycle, not only the first", () => {
    // The invariant this exists for: `--plugin-dir` is not restored by
    // `--resume`. A version of this that sent it on the opening cycle alone
    // would leave every later cycle of the same run without its plugins, and
    // the symptom is nothing — an agent missing a hook behaves exactly like one
    // that never had it, so no run fails and no page looks wrong.
    const args = buildArgs({
      ...base,
      isolated: false,
      resumeSessionId: "sess-1",
      pluginDirs: ["/workspace/orient"],
    });
    const at = args.indexOf("--plugin-dir");
    assert.notEqual(at, -1, "a resumed cycle must still be given its plugins");
    assert.equal(args[at + 1], "/workspace/orient");
    assert.ok(args.includes("--resume"));
  });

  it("emits no compaction ceiling, because pruning replaced it", () => {
    // The inverse of the test this replaced, and it is worth a test rather than
    // a deletion. `contextPruning.ts` bounds a cycle's context now — at the
    // 167,000 `--autocompact 200000` fired at when the flag was removed, and at
    // `CYCLE_CONTEXT_CEILING_TOKENS` wherever that constant stands since — and
    // it does it by ending the cycle rather than by summarising it. Both mechanisms running would be
    // worse than either: the CLI would summarise a conversation moments before
    // this app ended the cycle to prune it, so the prune would be measuring what
    // the summariser had already thrown away and the run would pay for both.
    //
    // Silent in exactly the way the removed test guarded the other direction —
    // a reinstated flag fails nothing and looks like an ordinary cycle.
    const args = buildArgs({
      ...base,
      isolated: false,
      resumeSessionId: "sess-1",
    });
    assert.equal(
      args.indexOf("--autocompact"),
      -1,
      "context pruning owns the ceiling; --autocompact must not also be sent",
    );
    assert.ok(args.includes("--resume"));
  });

  it("sends every unconditional system-prompt notice under one flag", () => {
    // A second `--append-system-prompt` is a replacement rather than an
    // addition, exactly as a second `--allowedTools` is, so the notices have to
    // travel together. Losing one is silent in every direction: an agent that
    // never saw the process-safety half has not been told why `pkill` is
    // denied, one that never saw the delegation half simply costs more, and one
    // that never saw the rendering half goes looking for a browser that is
    // already installed and reads the refusal as "there is none", and one that
    // never saw the identity half signs its commits with the operator's own
    // address, which no part of this app would notice and a forge publishes.
    const args = buildArgs({ ...base, isolated: false });
    assert.equal(args.filter((a) => a === "--append-system-prompt").length, 1);
    const notice = args[args.indexOf("--append-system-prompt") + 1];
    assert.ok(notice.includes("pgrep -af"), "the process-safety notice is missing");
    assert.ok(notice.includes("sub-agent"), "the delegation notice is missing");
    assert.ok(notice.includes("playwright screenshot"), "the rendering notice is missing");
    assert.ok(notice.includes("GIT_AUTHOR_EMAIL"), "the commit-identity notice is missing");
    // The notice rides every run, not only the isolated ones it was written
    // for: a run in the operator's own checkout is the one whose commits land
    // where nobody reviews a branch first.
    const owned = buildArgs({ ...base, isolated: true });
    assert.ok(
      owned[owned.indexOf("--append-system-prompt") + 1].includes("GIT_AUTHOR_EMAIL"),
    );
  });

  it("adds the file price list to that same flag rather than a second one", () => {
    // The last notice is per-run and the trap is the same one `--allowedTools`
    // carries: a second `--append-system-prompt` is a replacement, so a version
    // of this that pushed its own flag would silently drop the process-safety
    // and delegation notices from every run that had a price list — which is
    // every run.
    const args = buildArgs({
      ...base,
      isolated: false,
      fileCostNotice: "src/lib/orchestrator.ts — 116k",
    });
    assert.equal(args.filter((a) => a === "--append-system-prompt").length, 1);
    const notice = args[args.indexOf("--append-system-prompt") + 1];
    assert.ok(notice.includes("pgrep -af"), "the process-safety notice is missing");
    assert.ok(notice.includes("sub-agent"), "the delegation notice is missing");
    assert.ok(notice.includes("playwright screenshot"), "the rendering notice is missing");
    assert.ok(notice.includes("GIT_AUTHOR_EMAIL"), "the commit-identity notice is missing");
    assert.ok(notice.includes("116k"), "the file price list is missing");
  });

  it("carries the file price list on a resumed cycle, not only the first", () => {
    // `--resume` restores no `--append-system-prompt`, exactly as it restores no
    // `--plugin-dir`, so a cycle that omitted this would stop being told what a
    // file costs and read from the outside like one that was never told. What is
    // passed is the run's stored copy: regenerating it here would change the
    // cached prefix mid-run, which costs far more than the notice saves and
    // makes no run look wrong while it happens.
    const stored = "src/lib/orchestrator.ts — 116k";
    const args = buildArgs({
      ...base,
      isolated: true,
      resumeSessionId: "sess-1",
      fileCostNotice: stored,
    });
    assert.ok(args.includes("--resume"));
    assert.ok(args[args.indexOf("--append-system-prompt") + 1].endsWith(stored));
  });

  it("leaves the prompt byte-identical when a run has no price list", () => {
    // Every run created before `runs.file_cost_notice` existed reads null here,
    // and so does any run whose folder could not be walked. The appended prompt
    // for those has to be the exact string this app sent before the feature —
    // trailing blank lines included — because a run mid-flight across a deploy
    // that gained one newline pays a cold prefix on its next cycle for a notice
    // it did not get.
    const without = buildArgs({ ...base, isolated: true });
    const at = without.indexOf("--append-system-prompt");
    for (const fileCostNotice of [undefined, null, "", "   \n  "]) {
      const args = buildArgs({ ...base, isolated: true, fileCostNotice });
      assert.equal(args[args.indexOf("--append-system-prompt") + 1], without[at + 1]);
    }
  });

  it("hands the vault skill to the child, alongside the enabled plugins", () => {
    // The whole feature reduced to one claim: the switch being on has to put
    // the generated skill directory on the argv of the process that is spawned.
    // Nothing downstream would report it missing — a run handed no skill
    // answers from its own knowledge and reads, from the outside, exactly like
    // one that consulted the vault and agreed with itself.
    const args = buildArgs({
      ...base,
      isolated: false,
      pluginDirs: ["/workspace/orient"],
      vaultSkill: { pluginDir: "/run/uf-skills/uf-usagefoundry-skills", vaultPath: "/vault" },
    });
    const dirs = args.flatMap((a, i) => (a === "--plugin-dir" ? [args[i + 1]] : []));
    assert.deepEqual(dirs, ["/workspace/orient", "/run/uf-skills/uf-usagefoundry-skills"]);
    // Without this the skill names a path the run may not read: an isolated run
    // gets its own checkout and nothing else, so the failure would arrive as a
    // permission error in the middle of an answer rather than at the door.
    const at = args.indexOf("--add-dir");
    assert.notEqual(at, -1, "the vault must be readable by the run it was named to");
    assert.equal(args[at + 1], "/vault");
  });

  it("carries the vault skill on a resumed cycle, not only the first", () => {
    // `--plugin-dir` is not restored by `--resume`, and neither is `--add-dir`.
    // A version of this that delivered the skill on the opening cycle alone
    // would leave cycle 2 onward with a vault it can neither find nor read,
    // silently.
    const args = buildArgs({
      ...base,
      isolated: true,
      resumeSessionId: "sess-1",
      vaultSkill: { pluginDir: "/run/uf-skills/uf-usagefoundry-skills", vaultPath: "/vault" },
    });
    assert.equal(args[args.indexOf("--plugin-dir") + 1], "/run/uf-skills/uf-usagefoundry-skills");
    assert.equal(args[args.indexOf("--add-dir") + 1], "/vault");
    assert.ok(args.includes("--resume"));
  });

  it("names no vault flags when the skill is switched off", () => {
    for (const vaultSkill of [undefined, null]) {
      const args = buildArgs({ ...base, isolated: false, vaultSkill });
      assert.equal(args.includes("--add-dir"), false);
      assert.equal(args.includes("--plugin-dir"), false);
    }
  });

  it("names no plugin flag when none are enabled", () => {
    // A bare `--plugin-dir` would swallow the following flag as its value.
    assert.equal(buildArgs({ ...base, isolated: false }).includes("--plugin-dir"), false);
    assert.equal(
      buildArgs({ ...base, isolated: false, pluginDirs: [] }).includes("--plugin-dir"),
      false,
    );
  });

  it("hands the read guard over on the same flag, on a resumed cycle too", () => {
    // Two invariants in one call, both silent. The guard is a hook plugin, so it
    // has to join the `--plugin-dir` list rather than acquire a flag of its own
    // — and `--resume` restores none of them, so a version that sent it on the
    // opening cycle alone would leave every later cycle reading as much as it
    // liked, which is exactly what the switch being off looks like.
    const args = buildArgs({
      ...base,
      isolated: false,
      resumeSessionId: "sess-1",
      pluginDirs: ["/workspace/orient"],
      vaultSkill: { pluginDir: "/run/uf-skills/vault", vaultPath: "/vault" },
      readGuardDir: "/run/uf-read-guard/uf-usagefoundry-read-guard",
    });
    const dirs = args.flatMap((a, i) => (a === "--plugin-dir" ? [args[i + 1]] : []));
    assert.deepEqual(dirs, [
      "/workspace/orient",
      "/run/uf-skills/vault",
      "/run/uf-read-guard/uf-usagefoundry-read-guard",
    ]);
    assert.ok(args.includes("--resume"));
    // It ships hooks and no skill, so unlike the vault skill it names no
    // directory the run has to be granted.
    assert.equal(args.filter((a) => a === "--add-dir").length, 1);
  });

  it("names no plugin flag for a read guard that is switched off", () => {
    for (const readGuardDir of [undefined, null]) {
      assert.equal(
        buildArgs({ ...base, isolated: false, readGuardDir }).includes("--plugin-dir"),
        false,
      );
    }
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
        // This string reaches the argv of *every* concurrent agent, so a literal
        // in it is a pattern that matches all of them. The worked example used
        // to be `pgrep -f 3100`, and twice — 2026-08-15 23:39:42 and 2026-08-16
        // 14:23:38 — a run following it SIGTERM'd a sibling in another
        // repository that had no such port and had never mentioned the number.
        // Any run of digits here is the same trap under a different number.
        assert.doesNotMatch(
          said,
          /\d\d+/,
          "no multi-digit literal: it is on every sibling's command line",
        );
        assert.match(said, /pgrep -af/, "must say to look before killing");
      });
    }
  }

  /**
   * A chosen agent reaches a work cycle as **two** flags, and the branch that
   * matters is still the one where there is nothing to attach.
   *
   * The pair is not redundant and neither half can be dropped. `--agents`
   * defines the member and `--agent` selects it, and a name that nothing on the
   * argv defined is not merely ignored — measured on the pin, `claude --agent
   * <unregistered>` exits non-zero before making any API call, so a work cycle
   * that emitted only the name would die at the spawn on every iteration.
   *
   * The empty branch is the other direction and is still silent: a flag emitted
   * when nothing was chosen is an empty object where every existing run had no
   * flag at all, and under the singular semantics it would be worse than that —
   * `--agent` with no name is an argv the CLI rejects.
   */
  const reviewer = {
    name: "reviewer",
    description: "reads diffs",
    prompt: "You review.",
    model: null,
  };

  it("attaches nothing when no agent was chosen", () => {
    for (const agent of [undefined, null]) {
      const args = buildArgs({ ...base, isolated: true, agent });
      assert.equal(args.includes("--agents"), false);
      assert.equal(args.includes("--agent"), false);
    }
  });

  it("defines the chosen agent and selects it as the session's own", () => {
    const args = buildArgs({ ...base, isolated: true, agent: reviewer });

    const defined = args.indexOf("--agents");
    assert.notEqual(defined, -1, "the definition has to travel for the name to resolve");
    assert.deepEqual(JSON.parse(args[defined + 1]), {
      reviewer: { description: "reads diffs", prompt: "You review." },
    });

    // The half that is the whole point of the change: the run *is* the agent
    // rather than being offered it as a specialist to delegate to.
    const selected = args.indexOf("--agent");
    assert.notEqual(selected, -1, "the run must be started as the agent, not offered it");
    assert.equal(args[selected + 1], "reviewer");
    // The name it selects must be the name it defined, or the spawn fails.
    assert.deepEqual(Object.keys(JSON.parse(args[defined + 1])), [args[selected + 1]]);
  });

  /**
   * Selecting an agent bounds nothing, and that is the assertion this whole
   * feature rests on. The deny list is what stands between an agent and the
   * process supervising it; the isolation grant is what lets an isolated run
   * obey the preamble ordering it to commit. Neither is the agent's to move, so
   * the same assertions the modes above make are made again with one selected.
   */
  it("changes none of what bounds the run", () => {
    const args = buildArgs({
      ...base,
      isolated: true,
      agent: { ...reviewer, model: "sonnet" },
    });
    assert.deepEqual(
      args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--disallowedTools") + 3),
      ["Bash(pkill:*)", "Bash(killall:*)"],
    );
    assert.deepEqual(
      args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--allowedTools") + 3),
      ["Bash(git add:*)", "Bash(git commit:*)"],
    );
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  });

  /**
   * The one field whose *meaning* the singular flag changed.
   *
   * An agent's `model` was the model a delegated sub-turn ran on; selected with
   * `--agent` it is the session's, which would make it a second place to set the
   * run's model — the thing `run_templates` refuses on the grounds that
   * `settings.defaultModel` is the single one. What stops it being that is
   * measured off the `init` event: an explicit `--model` outranks the agent's,
   * so the agent's fills a gap the run left rather than overriding a choice the
   * operator made. This pins our half — that a run with a model of its own still
   * emits it, and emits it unchanged, when an agent naming another is selected.
   */
  it("still sends the run's own model when the agent names a different one", () => {
    const args = buildArgs({
      ...base,
      isolated: true,
      model: "opus",
      agent: { ...reviewer, model: "sonnet" },
    });
    assert.equal(args[args.indexOf("--model") + 1], "opus");
    // And the agent's own model still travels inside the definition, which is
    // what a run that named no model of its own would then run on.
    const defined = JSON.parse(args[args.indexOf("--agents") + 1]);
    assert.equal(defined.reviewer.model, "sonnet");
  });

  /**
   * The one that would be expensive and silent, and the reason this argv was
   * measured against the pin rather than reasoned about.
   *
   * `--append-system-prompt` carries `SELF_HOSTING_NOTICE` — the explanation of
   * the `pkill` deny list *and the safe recipe that replaces it* — and an agent
   * carries a system prompt of its own. If selecting one displaced the appended
   * text, a run started as an agent would be a run that had never been told why
   * a name-matched kill is denied or what to do instead, which is the failure
   * that ended a container and fourteen runs. Verified on 2.1.226: an agent
   * asked to echo a secret word stated only in the appended text answered with
   * it, so the two coexist. This pins our half — that the flag is still emitted,
   * and still emitted with the notice on it, when an agent is selected.
   */
  it("still carries the self-hosting notice when the run is an agent", () => {
    for (const agent of [null, reviewer]) {
      const args = buildArgs({ ...base, isolated: true, agent });
      const at = args.indexOf("--append-system-prompt");
      assert.notEqual(at, -1, "the notice must survive being started as an agent");
      assert.match(args[at + 1], /next-server/);
      assert.match(args[at + 1], /pgrep -P/);
    }
  });

  /**
   * Cycle 2 and every cycle after it. The loop resumes a session rather than
   * opening one, and an agent that only reached the first cycle would be a run
   * that silently stopped being the thing it was started as, part-way through.
   * Verified on the pin that `--agent` and `--resume` coexist; this pins that
   * both are emitted together.
   */
  it("selects the agent on a resumed cycle too", () => {
    const args = buildArgs({
      ...base,
      isolated: true,
      agent: reviewer,
      resumeSessionId: "sess-1",
    });
    assert.equal(args[args.indexOf("--resume") + 1], "sess-1");
    assert.equal(args[args.indexOf("--agent") + 1], "reviewer");
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

  /**
   * The only thing that bounds what *one* work cycle spends.
   *
   * `maxRunCostUSD` is read between cycles, so on its own it bounds the number
   * of cycles that may start past a threshold and not the amount the one
   * crossing it spends: a run at $34.99 of a $35 limit was authorised for one
   * more cycle of any size at all, and twenty-five of those multiply it. The
   * flag is the fix and every way of losing it is silent — a missing argv pair
   * is not an exit code, not a stream event and not a log line, and the only
   * evidence is a bill.
   */
  it("carries what is left of the run's spending limit into the cycle", () => {
    const args = buildArgs({
      ...base,
      isolated: true,
      maxRunCostUSD: 5,
      spentGuardUSD: 1.25,
    });
    const at = args.indexOf("--max-budget-usd");
    assert.notEqual(at, -1, "a run with a spending limit must cap its own cycle");
    // The remainder, not the limit: a resumed run's later cycles would
    // otherwise each be allowed the whole figure over again.
    assert.equal(args[at + 1], "3.75");
  });

  it("attaches no ceiling when the run has no spending limit", () => {
    // Null is "no limit" everywhere in `normalizePolicy`, and a run that opted
    // out must not acquire one from whatever it has spent so far.
    assert.equal(
      buildArgs({ ...base, isolated: true, spentGuardUSD: 12 }).includes(
        "--max-budget-usd",
      ),
      false,
    );
  });

  /**
   * The guard figure, not `runs.spent_usd`.
   *
   * `spentGuardUSD` is `spent_usd + spent_usd_est` — the same sum the pre-cycle
   * check compares — and the estimate half is what a killed cycle cost, which
   * is real money the CLI never got to report. Deriving the ceiling from the
   * measured floor alone would hand the child more room than the guard believes
   * the run has left, which is the display-versus-guard split inverted at the
   * one door where it costs money. The clamp is what that reads as at the
   * boundary: never a negative, which the CLI would take as no ceiling at all.
   */
  it("never hands over a negative ceiling", () => {
    const args = buildArgs({
      ...base,
      isolated: true,
      maxRunCostUSD: 5,
      spentGuardUSD: 6.5,
    });
    assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0");
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

/**
 * Which context-shaping variables reached the agent.
 *
 * `18-implementation-sketch.md` costed this phase as "a `log()` call beside an
 * existing one" and said it earned no test on that basis. It grew one branch
 * that changes the answer, so it earns the two cases that pin the branch and
 * nothing else.
 *
 * **Blank is unset**, and getting it wrong is silent in the direction the
 * environment doc warns about: compose renders every optional variable as
 * `${VAR:-}`, so a blank string counted as "set" would put a line naming seven
 * empty variables on every run of every stock install — a permanent notice
 * about a configuration nobody made, which is how a real one stops being read.
 */
describe("contextShapingEnv", () => {
  it("treats a blank value as unset, the way compose renders one", () => {
    assert.deepEqual(
      contextShapingEnv({ DISABLE_AUTO_COMPACT: "", MAX_THINKING_TOKENS: undefined }),
      [],
    );
  });

  it("names what an operator actually set, and only that", () => {
    assert.deepEqual(
      contextShapingEnv({
        MAX_THINKING_TOKENS: "31999",
        PATH: "/usr/bin",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
      }),
      [
        { key: "MAX_THINKING_TOKENS", value: "31999" },
        { key: "CLAUDE_CODE_MAX_CONTEXT_TOKENS", value: "200000" },
      ],
    );
  });
});

/**
 * What a compaction took, classified off the argv that put it there.
 *
 * It earns a test on `agentSpend`'s grounds — a pure classifier whose every
 * failure is silent — and the failures point three different ways.
 *
 * **Drift** is the one this file is the right home for, and the reason these
 * cases run `buildArgs` rather than hand-written argv. The classification is a
 * reading of `buildArgs`' output, so the first flag added there that carries
 * text into the window would otherwise fall out of the record silently: the
 * compaction line would go on listing four things while the run injected five,
 * and nothing throws, nothing fails to typecheck, and the log reads complete.
 * The assertion that no real argv produces an `unclassified` row is what makes
 * that a failed test instead.
 *
 * **A fabricated row** is the opposite and worse. Every `note` here is
 * Anthropic's own documentation, pinned to a CLI version, carrying no
 * measurement — and an operator who reads it as a reading of their own install
 * will trust a row nobody tested. `compactionNotice` is the only thing that says
 * so, so the wording is pinned rather than left to a later edit to soften.
 *
 * **A row in the wrong direction** is the quiet one: the skill *listing* is lost
 * where the skill *bodies* are re-injected, and swapping those two would tell an
 * operator their vault skill survived a compaction when the entry saying it
 * exists did not.
 */
describe("injectionFates", () => {
  const base = {
    prompt: "do the thing",
    model: null,
    permissionMode: "acceptEdits" as const,
    resumeSessionId: null,
    maxRunCostUSD: null,
    maxRunCostFactor: null,
    spentGuardUSD: 0,
  };

  const fatesOf = (argv: string[]) =>
    Object.fromEntries(injectionFates(argv).map((i) => [i.what, i.fate]));

  /**
   * The anti-drift assertion, run over the widest argv this app emits — every
   * optional flag present at once, so nothing is missed by being absent.
   */
  it("classifies every flag a real spawn emits", () => {
    const args = buildArgs({
      ...base,
      model: "claude-opus-5",
      resumeSessionId: "sess-1",
      isolated: true,
      forwardSubAgentText: true,
      maxRunCostUSD: 10,
      spentGuardUSD: 1,
      pluginDirs: ["/workspace/plug"],
      vaultSkill: { pluginDir: "/run/uf-skills/vault", vaultPath: "/workspace2" },
      fileCostNotice: "src/lib/orchestrator.ts — 116k",
      agent: {
        name: "reviewer",
        description: "reviews",
        prompt: "You review.",
        model: null,
      },
    });
    // Plus the flag the run loop pushes after `buildArgs` returns.
    args.push(...sandboxArgs({ kind: "confined", allowWrite: ["/tmp"] }, "on"));

    const unclassified = injectionFates(args).filter((i) => i.fate === "unclassified");
    assert.deepEqual(
      unclassified.map((i) => i.via),
      [],
      "a flag on a real argv with no row means the compaction record is short by one",
    );
  });

  it("reports a flag it has never been taught rather than dropping it", () => {
    const rows = injectionFates(["--append-user-prompt", "some text"]);
    assert.equal(rows.length, 1, "the unknown flag's own value must not add a second row");
    assert.equal(rows[0].fate, "unclassified");
    assert.equal(rows[0].via, "--append-user-prompt");
  });

  /**
   * The other way `ARGV_ARITY` goes wrong, and the quieter one: a flag it knows
   * but records as taking fewer values than the argv carries. The extra value is
   * then read as a token in its own right — which is how a value became a flag
   * in the first place — so it is reported against the flag it belongs to.
   */
  it("reports a value a known flag's recorded arity did not account for", () => {
    const rows = injectionFates(["--model", "opus", "an-extra-value"]);
    const stray = rows.filter((r) => r.fate === "unclassified");
    assert.equal(stray.length, 1);
    assert.equal(stray[0].via, "--model");
    assert.match(stray[0].what, /an-extra-value/);
  });

  /**
   * Unclassified first, because `log()` cuts at `MAX_LOG_CHARS` and the row that
   * asks somebody to do something is the row that must survive the cut.
   */
  it("puts an unclassified flag ahead of the rows it does know", () => {
    const rows = injectionFates(["-p", "go", "--brand-new-flag", "x"]);
    assert.equal(rows[0].fate, "unclassified");
  });

  it("splits a plugin directory's skill bodies from the listing that names them", () => {
    const args = buildArgs({
      ...base,
      isolated: false,
      vaultSkill: { pluginDir: "/run/uf-skills/vault", vaultPath: "/workspace2" },
    });
    const fates = fatesOf(args);
    assert.equal(fates["skill bodies from /run/uf-skills/vault"], "reinjected");
    assert.equal(
      fates["the listing that told this cycle those skills exist (/run/uf-skills/vault)"],
      "lost",
    );
  });

  it("reports no skills for a cycle spawned without any", () => {
    const rows = injectionFates(buildArgs({ ...base, isolated: false }));
    assert.equal(
      rows.some((i) => i.via === "--plugin-dir"),
      false,
    );
  });

  /**
   * The two notices ride one `--append-system-prompt`, which the vendor table
   * puts in the row that survives unchanged — and the prompt they are *not* on
   * has no row at all, because message history is the thing being summarised.
   * Collapsing those two into one answer is how an operator comes to believe the
   * ending contract is safe.
   */
  it("separates the appended system prompt from the message history", () => {
    const args = buildArgs({ ...base, isolated: true });
    const rows = injectionFates(args);
    const system = rows.find((i) => i.via === "--append-system-prompt");
    const prompt = rows.find((i) => i.via === "-p");
    assert.equal(system?.fate, "survives");
    assert.equal(prompt?.fate, "unknown");
  });

  it("does not mistake the prompt for a variadic tool value", () => {
    // `--disallowedTools` is variadic and `-p` is the one short flag on the
    // argv, so a scan that stopped only at `--` would swallow the prompt.
    const rows = injectionFates(["--disallowedTools", "Bash(pkill:*)", "-p", "go"]);
    assert.equal(rows.find((i) => i.via === "-p")?.fate, "unknown");
    assert.equal(
      rows.some((i) => i.fate === "unclassified"),
      false,
    );
  });

  it("says a compaction happened, and says the classification is not measured", () => {
    const boundary = {
      sessionId: "sess-1",
      ts: 1,
      trigger: "auto",
      preTokens: 180694,
      postTokens: 17456,
      durationMs: 140432,
      cliVersion: "2.1.226",
    };
    const notice = compactionNotice(boundary, injectionFates(["-p", "go"]));
    assert.match(notice, /compacted this run's conversation \(auto\)/);
    assert.match(notice, /180,694 tokens summarised down to 17,456/);
    assert.match(notice, /140s/);
    // The pin, both versions named, and the word that keeps it a claim about
    // documentation rather than about this install.
    assert.match(notice, new RegExp(`CLI ${SURVIVAL_TABLE_CLI_VERSION}`));
    assert.match(notice, /compacted by 2\.1\.226/);
    assert.match(notice, /hypothesis/);
  });

  /**
   * The one case where the table's own pin is the version that ran. Still
   * documentation and still unmeasured, so the notice must say that too — the
   * matching version removes the version caveat, not the evidence one.
   */
  it("still refuses to call the table a measurement when the versions match", () => {
    const notice = compactionNotice(
      {
        sessionId: "s",
        ts: 1,
        trigger: "auto",
        preTokens: 1,
        postTokens: 1,
        durationMs: 1000,
        cliVersion: SURVIVAL_TABLE_CLI_VERSION,
      },
      [],
    );
    assert.match(notice, /documentation and not a measurement/);
  });
});

/**
 * Covers the per-child write set, and only that.
 *
 * It earns a test on the same grounds `buildArgs` does, and the two ways of
 * being wrong point opposite ways and are both silent. **Too narrow** fails
 * inside a tool call the run loop does not read: a policy denial comes back out
 * of a mount namespace as an ordinary `EACCES` — which is why `sandboxRefusal`
 * deliberately does not match those words — so the whole symptom is a cycle that
 * spent money and wrote nothing. **Too wide** is a boundary that is not there,
 * which is the entire thing this function exists to be, and it reads identically
 * on every page.
 *
 * So the assertions are the three `09-implementation-sketch.md` names, and the
 * middle one is the point of the exercise: the run's own checkout is writable,
 * a **sibling run's** is not, and `CLAUDE_CONFIG_DIR` is, because that is the
 * metering path and forgetting it produces a dashboard of zeros rather than an
 * error.
 *
 * Written against a set, not against a string: an entry is a directory, so
 * "writable" is containment. Asserting `!allowWrite.includes(sibling)` would
 * pass for a set naming the checkout store itself, which holds every concurrent
 * run's worktree and is the exact failure this is about.
 *
 * None of it has been executed against a sandbox. Nothing in this environment
 * can start one (`docs/verification.md`), so what this pins is the set this app
 * asks for — not that the CLI honours it, and not that the confinement covers
 * anything but Bash.
 */
describe("sandboxSettings — what one child may write", () => {
  const repo = `${ws}/RepoOne`;
  const own = `${ws}/.uf-worktrees/repoone-1`;
  const sibling = `${ws}/.uf-worktrees/repoone-2`;
  const store = `${ws}/.uf-worktrees`;

  /** Whether a path falls inside the set, which is what "writable" means here. */
  const writable = (
    policy: ReturnType<typeof sandboxSettings>,
    target: string,
  ): boolean =>
    policy.kind === "confined" &&
    policy.allowWrite.some((p) => target === p || target.startsWith(`${p}${path.sep}`));

  const isolated = sandboxSettings({ kind: "run", workDir: own, repoRoot: repo });

  it("gives an isolated run its own checkout", () => {
    assert.equal(writable(isolated, own), true);
    assert.equal(writable(isolated, `${own}/src/index.ts`), true);
  });

  it("does not give it a concurrent run's checkout", () => {
    // The gap the whole exercise was reached for: measured today, `test -w` on
    // a sibling's worktree passes from inside a run, on a branch somebody will
    // land.
    assert.equal(writable(isolated, sibling), false);
    assert.equal(writable(isolated, `${sibling}/src/index.ts`), false);
    // And not by naming the store either, which would contain every sibling
    // while still not being the sibling's own path.
    assert.equal(writable(isolated, store), false);
  });

  it("keeps the paths a tool call writes without being told to", () => {
    // The two ways this set is wrong are opposite and both silent, and this is
    // the narrow one: a write config of any kind makes the CLI bind `/`
    // read-only, so a path nobody named fails inside a tool call the run loop
    // never reads. `/tmp` is where the CLI puts its own shell snapshots — the
    // first `Bash` call is where that shows up — and the caches are where a
    // first `npm install` or `go build` writes.
    assert.equal(writable(isolated, os.tmpdir()), true);
    assert.equal(writable(isolated, path.join(os.tmpdir(), "cc-socks")), true);
    assert.equal(writable(isolated, path.join(os.homedir(), ".npm")), true);
    // The pinned GOPATH above, not the fallback: this asserts that the variable
    // is what the set follows, which is the half a developer's own `$HOME/go`
    // would otherwise hide.
    assert.equal(
      writable(isolated, path.join(process.env.GOPATH as string, "pkg", "mod")),
      true,
    );

    // And the resolver gets them too: it is the other child an operator can
    // point at a build command, through `settings.resolveVerifyTools`.
    const resolver = sandboxSettings({
      kind: "assist",
      cwd: own,
      permissionMode: "acceptEdits",
    });
    assert.equal(writable(resolver, os.tmpdir()), true);
    assert.equal(writable(resolver, path.join(os.homedir(), ".npm")), true);
  });

  it("keeps CLAUDE_CONFIG_DIR writable, which is the metering path", () => {
    // Every window, every meter and every guard but one is derived from the
    // transcripts under it. A set that forgets it reports zeros rather than
    // failing, which is the sharpest way to get this wrong.
    assert.equal(writable(isolated, CLAUDE_CONFIG_DIR), true);
    assert.equal(writable(isolated, `${CLAUDE_CONFIG_DIR}/projects/x.jsonl`), true);
    // Every child, not only a work cycle: the reviewer and the chat write
    // transcripts that the same scan bills against.
    for (const scope of [
      { kind: "assist", cwd: own, permissionMode: "plan" },
      { kind: "chat", dirs: [ws] },
    ] as const) {
      assert.equal(writable(sandboxSettings(scope), CLAUDE_CONFIG_DIR), true);
    }
  });

  it("names the repository's git directory, which widens the boundary", () => {
    // Not an oversight and not narrower than it looks. A worktree's `.git` is a
    // pointer into `<repo>/.git/worktrees/<slug>`, so an isolated run cannot
    // make the commit the isolation preamble orders it to make unless the
    // repository's own git directory is writable — which means two runs on one
    // repository can still rewrite each other's refs.
    assert.equal(writable(isolated, `${repo}/.git`), true);
    assert.equal(writable(isolated, `${repo}/.git/worktrees/repoone-1`), true);
    // The working tree beside it is still not writable: the operator's own
    // checkout is not this run's to edit.
    assert.equal(writable(isolated, `${repo}/src/index.ts`), false);
  });

  it("gives a run in the operator's own folder that folder and no repository", () => {
    const plain = sandboxSettings({ kind: "run", workDir: repo, repoRoot: null });
    assert.equal(writable(plain, repo), true);
    assert.equal(writable(plain, sibling), false);
  });

  it("gives the reviewer a read-only set and the resolver its checkout", () => {
    // One spawn site, two children. `plan` writes nothing of its own, so its
    // set is the transcript directory and the CLI's own scratch and nothing
    // else — the repository it is reading a diff out of is not in it, and
    // neither is a toolchain cache, since it installs nothing.
    //
    // Still an exact set rather than a containment check: "a read-only child,
    // spelled as one" is the claim, and `/tmp` is in it because a `plan` child
    // still runs read-only shell and the CLI writes a shell snapshot for every
    // one of those.
    const reviewer = sandboxSettings({
      kind: "assist",
      cwd: own,
      permissionMode: "plan",
    });
    assert.deepEqual(
      reviewer.kind === "confined" ? reviewer.allowWrite : null,
      [CLAUDE_CONFIG_DIR, os.tmpdir()],
    );

    // The conflict resolver edits markers in a throwaway checkout and is
    // deliberately not the thing that commits — this server makes the merge
    // commit after checking the result — so it gets that checkout and no `.git`.
    const resolver = sandboxSettings({
      kind: "assist",
      cwd: own,
      permissionMode: "acceptEdits",
    });
    assert.equal(writable(resolver, own), true);
    assert.equal(writable(resolver, `${repo}/.git`), false);
    assert.equal(writable(resolver, sibling), false);
  });

  it("gives the chat every directory it was already handed", () => {
    // Deliberately the widest of the three: the chat passes `--add-dir` for
    // every mount and runs `bypassPermissions`, so a narrower write set would be
    // this app refusing, inside a tool call, a directory it put on the argv one
    // line earlier. The same array feeds both.
    const chat = sandboxSettings({ kind: "chat", dirs: [ws, `${tmp}/alias`] });
    assert.equal(writable(chat, `${ws}/Other`), true);
    assert.equal(writable(chat, `${tmp}/alias`), true);
    // Which does include a sibling's checkout, and says so rather than
    // pretending the chat is confined by its filesystem.
    assert.equal(writable(chat, sibling), true);
  });

  it("refuses a set it cannot spell rather than emitting one with a hole", () => {
    // `sandbox.filesystem` entries carrying a glob pattern are silently dropped
    // on Linux, so a folder whose name contains one arrives here as a literal
    // path and leaves the CLI as nothing. The entry that would go missing is the
    // run's own checkout, which is the one place a hole is fatal.
    const globbed = sandboxSettings({
      kind: "run",
      workDir: `${ws}/.uf-worktrees/repo[1]-1`,
      repoRoot: repo,
    });
    assert.equal(globbed.kind, "unconfined");
    assert.match(globbed.kind === "unconfined" ? globbed.reason : "", /glob/);

    // A relative path is the same failure arriving from a caller rather than
    // from an operator: it would confine some other tree, not this one.
    assert.equal(
      sandboxSettings({ kind: "run", workDir: "checkout", repoRoot: null }).kind,
      "unconfined",
    );
  });

  it("emits nothing at all rather than an empty policy", () => {
    // The quietest failure available here: the CLI hands a command back
    // unwrapped when the whole policy resolves to nothing, and
    // `failIfUnavailable` does not catch it, because a sandbox nothing was asked
    // of is not one that failed.
    assert.deepEqual(sandboxArgs({ kind: "unconfined", reason: "why" }, "on"), []);

    // And nothing on a stock install, which is every install today: naming
    // paths against a sandbox that is not enabled configures nothing, and the
    // argv stays byte-identical to what it was.
    assert.deepEqual(sandboxArgs(isolated, "none"), []);
  });

  it("names the paths as settings, and never switches a sandbox on", () => {
    for (const state of ["on", "empty", "unknown"] as const) {
      const args = sandboxArgs(isolated, state);
      assert.equal(args[0], "--settings");
      const overlay = JSON.parse(args[1]) as {
        sandbox: { enabled?: unknown; filesystem: { allowWrite: string[] } };
      };
      assert.deepEqual(
        overlay.sandbox.filesystem.allowWrite,
        isolated.kind === "confined" ? isolated.allowWrite : null,
      );
      // The one key it must never carry. Enabling a sandbox from an argv would
      // default `failIfUnavailable` to true inside the CLI, so an install
      // without bubblewrap would have every `claude` invocation exit non-zero
      // with no off switch an operator can reach.
      assert.equal("enabled" in overlay.sandbox, false);
    }
  });
});

describe("telemetryEnv — what the exporter authenticates with", () => {
  // The app's master credential used to be here, as
  // `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer $UF_AUTH_TOKEN`, merged
  // into the child's environment *after* `childEnv` had stripped every `UF_*`
  // out of it. The child is a Claude Code session with `Bash`; `env` is
  // read-only shell, which `acceptEdits` auto-approves; and that token opens
  // `POST /api/runs`, `PUT /api/settings`, every other run's diff and the
  // approval route. Nothing about the app changes if it comes back — telemetry
  // works either way — which is why this is pinned rather than left to review.
  const previous = process.env.UF_AUTH_TOKEN;
  after(() => {
    if (previous === undefined) delete process.env.UF_AUTH_TOKEN;
    else process.env.UF_AUTH_TOKEN = previous;
  });

  it("never carries UF_AUTH_TOKEN, however it is set", () => {
    process.env.UF_AUTH_TOKEN = "master-token-that-opens-everything";
    // `required` so the settings table is not consulted: this is about the
    // values, and the branch that reads `telemetryForRuns` is one line above.
    const env = telemetryEnv("run-a", true);
    for (const [key, value] of Object.entries(env)) {
      assert.equal(
        value.includes("master-token-that-opens-everything"),
        false,
        `${key} carries UF_AUTH_TOKEN into the agent's own environment`,
      );
    }
  });

  it("authenticates with a per-run capability that resolves to that run", () => {
    process.env.UF_AUTH_TOKEN = "";
    const env = telemetryEnv("run-b", true);
    const header = env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
    assert.match(
      header,
      /^Authorization=Bearer .+/,
      "the exporter is now unauthenticated, and `middleware.ts` exempts the " +
        "ingest path — so the route would be the only gate and it would refuse.",
    );
    const token = header.slice("Authorization=Bearer ".length);
    assert.equal(runForIngestToken(token), "run-b");

    // Stable across the cycles of one run: every cycle exports for the same run
    // id, and a token per cycle would be one more thing to revoke on each of
    // the paths a cycle can end on.
    assert.equal(telemetryEnv("run-b", true).OTEL_EXPORTER_OTLP_HEADERS, header);

    // And not another run's. The route takes the run id from the token, so this
    // is what stops a record claiming a `uf.run_id` it does not hold.
    const other = (telemetryEnv("run-c", true).OTEL_EXPORTER_OTLP_HEADERS ?? "")
      .slice("Authorization=Bearer ".length);
    assert.notEqual(other, token);
    assert.equal(runForIngestToken(other), "run-c");
  });

  it("stops ingesting once the run has ended and its grace has passed", () => {
    const token = (telemetryEnv("run-d", true).OTEL_EXPORTER_OTLP_HEADERS ?? "")
      .slice("Authorization=Bearer ".length);
    assert.equal(runForIngestToken(token), "run-d");

    revokeIngestTokens("run-d");
    // Still believed for the grace window: the exporter batches on a
    // one-second timer, so revoking on the instant drops the tail of the last
    // cycle and understates what the run spent.
    assert.equal(runForIngestToken(token), "run-d");

    const clock = Date.now;
    try {
      Date.now = () => clock() + 60_000;
      assert.equal(runForIngestToken(token), null);
    } finally {
      Date.now = clock;
    }
    // Swept on the way past, so the map is bounded by live runs.
    assert.equal(runForIngestToken(token), null);
  });

  it("refuses an empty or unknown bearer", () => {
    // `middleware.ts` no longer gates this path, so "no token" must not read as
    // "no check". An empty string is the shape a missing header arrives in.
    assert.equal(runForIngestToken(""), null);
    assert.equal(runForIngestToken("not-a-token"), null);
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
    maxRunCostFactor: null,
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
          maxRunCostFactor: null,
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
          maxRunCostFactor: null,
          maxIterations: 5,
        }),
      ),
      true,
    );
  });
});

/**
 * Covers how long a work cycle may be silent before it is ended.
 *
 * `PUT /api/settings` already floors what it is sent, so what this pins is the
 * other door: the value is JSON in a settings row that outlives the build which
 * wrote it and can be edited by hand, and both ways of reading a bad one are
 * silent. A zero taken at face value switches the deadline off, which is the
 * defect the whole mechanism exists to end; a zero read as "the smallest
 * allowed" kills healthy cycles, because the stream goes quiet for the whole of
 * one model turn and the whole of one tool call.
 */
describe("how long a work cycle may be silent", () => {
  it("takes the default for a value that is not a request", () => {
    // Off, negative and corrupt are all "this row says nothing usable", not
    // "the operator asked for the shortest possible deadline".
    assert.equal(cycleSilenceMs(0), 120 * 60_000);
    assert.equal(cycleSilenceMs(-30), 120 * 60_000);
    assert.equal(cycleSilenceMs(NaN), 120 * 60_000);
  });

  it("floors a request that is too short, and honours one that is not", () => {
    assert.equal(cycleSilenceMs(1), 5 * 60_000);
    assert.equal(cycleSilenceMs(45), 45 * 60_000);
  });
});

/**
 * Covers what a run ends as, given why it was interrupted.
 *
 * A cycle killed on its deadline reaches the loop's post-cycle checkpoint in
 * exactly the shape an operator's Stop does — a dead child, a null exit code,
 * no `result` event — so this mapping is the whole of what tells them apart on
 * the runs list, and every way of collapsing it typechecks and reads like an
 * ordinary ending.
 */
describe("what an interrupt makes of a run", () => {
  const at = 1_700_000_000_000;

  it("files a deadline as a failure and a decision as a stop", () => {
    assert.deepEqual(
      interruptOutcome({ kind: "deadline", reason: "no output", pause: false, at }),
      { status: "failed", reason: "no output", resumeAt: null },
    );
    // Nobody decided the one above; somebody decided both of these.
    assert.deepEqual(
      interruptOutcome({ kind: "operator", reason: "Stopped.", pause: false, at }),
      { status: "stopped", reason: "Stopped.", resumeAt: null },
    );
    assert.deepEqual(
      interruptOutcome({ kind: "guard", reason: "over budget", pause: false, at }),
      { status: "stopped", reason: "over budget", resumeAt: null },
    );
  });

  it("still parks a live-resume step-aside", () => {
    assert.deepEqual(
      interruptOutcome({
        kind: "guard",
        reason: "window full",
        pause: true,
        resumeAt: at + 60_000,
        at,
      }),
      { status: "paused", reason: "window full", resumeAt: at + 60_000 },
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

/**
 * A tool's outcome, which is the half of a `stream-json` cycle this app used to
 * drop whole.
 *
 * The failure it exists for is silent by construction: a `git push` the one
 * configured token does not reach answers 403 *inside* the tool call, the agent
 * carries on, the cycle emits `result`, and the run is written `completed` —
 * with a `tool` row on the log saying the command was attempted and nothing
 * after it. Nothing on any page in this app tells that run from one that
 * pushed. So every case below is either "the failure is recorded, named" or
 * "nothing else changed", and the second is the longer list.
 *
 * The shapes are quoted from real transcripts written by the pinned CLI
 * (2.1.226), not invented: a string `content` for an ordinary tool, an array of
 * blocks for one that answers with several.
 */
describe("failed tool results", () => {
  const push = "git push -u origin uf/acme-web-1-1a2b3c4d";
  const calls = new Map([
    ["toolu_01", { name: "Bash", command: push }],
    ["toolu_02", { name: "Read", command: "/repo/src/index.ts" }],
  ]);
  const acc = { toolCalls: calls, subagentNames: new Map<string, string>() };

  /** One `user` event carrying one block, which is how they arrive. */
  const userEvent = (
    block: Record<string, unknown>,
    envelope: Record<string, unknown> = {},
  ) => ({
    type: "user",
    message: { role: "user", content: [block] },
    session_id: "s1",
    ...envelope,
  });

  it("names the tool and the command the result answers", () => {
    // The whole point: a `tool_result` carries the id of its call and no name,
    // so a failure that does not reach back for the command is a danger row
    // reading "tool failed — remote: Permission … denied", which does not say
    // which of a cycle's commands it was.
    const failures = toolResultFailures(
      userEvent({
        type: "tool_result",
        tool_use_id: "toolu_01",
        content:
          "remote: Permission to acme/web.git denied to uf-bot.\nfatal: unable to access 'https://github.com/acme/web.git/': The requested URL returned error: 403",
        is_error: true,
      }),
      acc,
    );

    assert.equal(failures.length, 1);
    assert.equal(failures[0].name, "Bash");
    assert.equal(failures[0].command, push);
    assert.equal(failures[0].toolUseId, "toolu_01");
    assert.match(failures[0].text, /error: 403$/);
    // Flattened, because no row in the log renders a stored newline: left in,
    // the second half of the message is a line the reader never sees.
    assert.equal(failures[0].text.includes("\n"), false);
  });

  it("records a result whose call it never saw, rather than dropping it", () => {
    // A stream this app joined mid-conversation, or a call whose block carried
    // no id. The text is the half an operator acts on, so "some tool failed
    // with this" beats silence.
    const [failure] = toolResultFailures(
      userEvent({
        type: "tool_result",
        tool_use_id: "toolu_99",
        content: "Exit code 1",
        is_error: true,
      }),
      acc,
    );

    assert.equal(failure.name, "tool");
    assert.equal(failure.command, "");
    assert.equal(failure.text, "Exit code 1");
  });

  it("reads the array shape a tool that answers in blocks uses", () => {
    const [failure] = toolResultFailures(
      userEvent({
        type: "tool_result",
        tool_use_id: "toolu_02",
        content: [
          { type: "text", text: "File does not exist." },
          { type: "text", text: "Did you mean src/index.tsx?" },
        ],
        is_error: true,
      }),
      acc,
    );

    assert.equal(failure.name, "Read");
    assert.equal(failure.text, "File does not exist. Did you mean src/index.tsx?");
  });

  it("keeps a sub-agent's failure the sub-agent's", () => {
    // Same routing as a forwarded turn's text, and for the same reason: a
    // failed `Bash` between two of the main thread's lines reads as the main
    // thread's, which sends the operator to the wrong place for the cause.
    const delegated = {
      toolCalls: calls,
      subagentNames: new Map([["toolu_task", "reviewer"]]),
    };
    const block = {
      type: "tool_result",
      tool_use_id: "toolu_01",
      content: "denied",
      is_error: true,
    };

    const [onEnvelope] = toolResultFailures(
      userEvent(block, { parent_tool_use_id: "toolu_task" }),
      delegated,
    );
    assert.equal(onEnvelope.parentToolUseId, "toolu_task");
    assert.equal(onEnvelope.subagent, "reviewer");

    // The message as a fallback, because a key that moved must fail *towards*
    // treating a delegated call as delegated.
    const [onMessage] = toolResultFailures(
      {
        type: "user",
        message: {
          role: "user",
          content: [block],
          parent_tool_use_id: "toolu_task",
        },
      },
      delegated,
    );
    assert.equal(onMessage.parentToolUseId, "toolu_task");

    // The main thread's own failure carries neither key, so nothing downstream
    // can attribute it to a sub-agent that was never asked.
    const [own] = toolResultFailures(userEvent(block), delegated);
    assert.equal(own.parentToolUseId, undefined);
    assert.equal(own.subagent, undefined);
  });

  it("records nothing for a result that worked, or a shape that moved", () => {
    // `run_events` grows without bound and this branch sees every tool result
    // in the cycle, so anything short of `is_error === true` records nothing.
    // The direction matters: a renamed field costs the failures, where a
    // truthiness test on a field that changed meaning costs the whole log.
    const shapes: Array<Record<string, unknown>> = [
      { type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
      {
        type: "tool_result",
        tool_use_id: "toolu_01",
        content: "ok",
        is_error: false,
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_01",
        content: "ok",
        is_error: "true",
      },
      { type: "text", text: "not a tool result at all" },
    ];
    for (const block of shapes) {
      assert.deepEqual(toolResultFailures(userEvent(block), acc), []);
    }
  });

  it("survives a build that stops sending the shape", () => {
    // `permissionDenials`' rule: every field here was captured from one CLI
    // build, and a cycle must not fail to finish because one of them moved.
    const events: Array<Record<string, unknown>> = [
      { type: "user" },
      { type: "user", message: {} },
      { type: "user", message: { content: "a string now" } },
      { type: "user", message: { content: [null, 7, "text"] } },
    ];
    for (const ev of events) {
      assert.deepEqual(toolResultFailures(ev, acc), []);
    }
  });

  it("clips the output, because this is a log line and not the output", () => {
    const [failure] = toolResultFailures(
      userEvent({
        type: "tool_result",
        tool_use_id: "toolu_01",
        content: "x".repeat(5_000),
        is_error: true,
      }),
      acc,
    );

    assert.equal(failure.text.length, 600);
    assert.equal(failure.text.endsWith("…"), true);
  });
});

describe("cycleCostAfterResult", () => {
  // The failure this is written against is silent and it is money: nothing
  // throws, the cycle exits 0, the log reads like an ordinary run, and the only
  // evidence is a figure on the run page that no other reading agrees with —
  // including the one `maxRunCostUSD` is compared against.

  it("takes a second result's total whole, because it already contains the first", () => {
    // Run 075f7959, verbatim. One child, two terminal `result` events in the
    // same millisecond: the agent's turn ended while a background `Explore`
    // sub-agent was still running, and the same session was woken again when it
    // answered. `total_cost_usd` is the session's running total, so $9.330155
    // *is* the whole cycle — telemetry recorded exactly that across all 110 of
    // the session's requests. Summing them stored $16.355574, 75% over.
    const first = cycleCostAfterResult(0, 7.025419);
    assert.equal(first, 7.025419);
    assert.equal(cycleCostAfterResult(first, 9.330155), 9.330155);
  });

  it("leaves a figure already reported standing when the next reading is missing", () => {
    // The whole risk of assigning rather than accumulating. A `result` whose
    // cost field is absent, unparseable or zero says nothing about the session,
    // and must not be able to erase what an earlier one measured — that would
    // trade a cycle overstated by 75% for one silently reported at $0.
    for (const absent of [undefined, null, "", "n/a", NaN, 0, -1]) {
      assert.equal(cycleCostAfterResult(7.025419, absent), 7.025419);
    }
    // …and a first reading of nothing is still nothing, rather than a NaN that
    // would poison `spent_usd` for the rest of the run.
    assert.equal(cycleCostAfterResult(0, undefined), 0);
  });

  it("does not go backwards on an out-of-order reading", () => {
    // A running total is monotone, so the larger and the last agree on every
    // well-formed stream. Where they could differ the stream is already wrong,
    // and understating spend is the direction a budget guard cannot recover
    // from.
    assert.equal(cycleCostAfterResult(9.330155, 7.025419), 9.330155);
  });

  it("is scoped to one child, so a restart still sums", () => {
    // Not a property of this function but of where it is called: a cycle that
    // died at `error_during_execution` and resumed gets a second child with a
    // CLI accumulator that starts at zero, and the run loop's own `+=` across
    // children is what makes those runs reconcile to the cent. Pinned as the
    // arithmetic that must survive: each child folds its own results, and only
    // then are the children added.
    const died = cycleCostAfterResult(0, 3.8235865);
    const resumed = cycleCostAfterResult(0, 13.6167145);
    assert.equal(Number((died + resumed).toFixed(4)), 17.4403);
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

  it("matches a path below the root only when the pattern names one", () => {
    // The half that could not be expressed at all: the walk read one directory
    // and matched a bare filename, so a monorepo's `apps/web/.env` was
    // unreachable whatever the operator typed.
    assert.equal(matchesCopyGlobs("apps/web/.env", ["apps/web/.env"]), true);
    assert.equal(matchesCopyGlobs("apps/web/.env", ["apps/*/.env"]), true);
    assert.equal(matchesCopyGlobs("apps/web/.env.local", ["apps/web/.env.*"]), true);
    // And the half that must not change with it: a bare filename still means a
    // file at the root. Reading `.env` as "any .env anywhere" would silently
    // widen every install's existing list.
    assert.equal(matchesCopyGlobs("apps/web/.env", [".env"]), false);
    assert.equal(matchesCopyGlobs("apps/web/.env", ["*"]), false);
  });

  it("refuses a pattern that climbs out of the repository", () => {
    // This walks the operator's own checkout and copies into an agent's, so a
    // pattern is not a place to resolve `..` from.
    assert.equal(matchesCopyGlobs(".env", ["../.env"]), false);
    assert.equal(matchesCopyGlobs("x/.env", ["x/../.env"]), false);
    assert.equal(matchesCopyGlobs(".env", ["/.env"]), false);
  });
});

/**
 * Which paths a seeding pass copies, given a repository and a list.
 *
 * The traversal is half the decision and it used to be a single `readdirSync`
 * of the repository root, so it is injected here rather than left on the disk:
 * both ways of getting this wrong are a checkout that starts without its
 * configuration, and the agent finds out inside a tool call, one billed cycle
 * later.
 */
describe("planSeedCopies", () => {
  type Tree = Record<string, { files?: string[]; dirs?: string[] }>;

  function readerFor(tree: Tree, opened?: string[]) {
    return (rel: string) => {
      opened?.push(rel);
      const node = tree[rel] ?? {};
      return [
        ...(node.files ?? []).map((name) => ({ name, isFile: true, isDirectory: false })),
        ...(node.dirs ?? []).map((name) => ({ name, isFile: false, isDirectory: true })),
      ];
    };
  }

  const monorepo: Tree = {
    "": { files: [".env.example", "package.json"], dirs: ["apps", "node_modules", ".git"] },
    apps: { dirs: ["web", "api"] },
    "apps/web": { files: [".env", ".env.example"] },
    "apps/api": { files: ["local.settings.json"] },
  };

  it("reaches a file below the root when a pattern names it", () => {
    assert.deepEqual(
      planSeedCopies(["apps/web/.env"], readerFor(monorepo)),
      ["apps/web/.env"],
    );
  });

  it("still honours an exclusion at depth, later pattern winning", () => {
    assert.deepEqual(
      planSeedCopies(["apps/*/.env*", "!apps/web/.env.example"], readerFor(monorepo)),
      ["apps/web/.env"],
    );
  });

  it("opens only the directories a pattern's own segments ask for", () => {
    // The property that keeps this affordable before every isolated checkout:
    // the default list costs exactly one readdir and no repository is walked
    // whole. `node_modules` and `.git` are never opened because no pattern
    // names them.
    const opened: string[] = [];
    assert.deepEqual(
      planSeedCopies([".env", ".env.*", "!.env.example"], readerFor(monorepo, opened)),
      [],
    );
    assert.deepEqual(opened, [""]);

    const openedDeep: string[] = [];
    planSeedCopies(["apps/web/.env"], readerFor(monorepo, openedDeep));
    assert.deepEqual(openedDeep, ["", "apps", "apps/web"]);
  });

  it("copies nothing for a repository whose list is empty", () => {
    assert.deepEqual(planSeedCopies([], readerFor(monorepo)), []);
  });

  it("bounds a wildcard directory segment rather than trusting the tree", () => {
    // A pattern with a wildcard directory segment is the one shape whose walk
    // is not bounded by the pattern itself, against a repository this app did
    // not write.
    const wide: Tree = {
      "": { dirs: Array.from({ length: 500 }, (_, i) => `d${i}`) },
    };
    for (let i = 0; i < 500; i++) wide[`d${i}`] = { files: [".env"] };

    const opened: string[] = [];
    const copied = planSeedCopies(["*/.env"], readerFor(wide, opened));
    assert.ok(opened.length <= 200, `opened ${opened.length} directories`);
    assert.ok(copied.length > 0 && copied.length < 500);
  });
});

describe("copyGlobsFor", () => {
  const mounts = [
    { id: "work", label: "Work", path: "/workspace" },
    { id: "notes", label: "Notes", path: "/workspace2" },
  ];
  const globalList = [".env", ".env.*", "!.env.example"];

  it("falls back to the install-wide list when nothing names the folder", () => {
    const picked = copyGlobsFor("/workspace/acme/web", globalList, {}, mounts);
    assert.deepEqual(picked, { globs: globalList, key: null });
  });

  it("lets two repositories be seeded differently from one setting", () => {
    // The whole of the finding: one list has to be simultaneously correct for
    // every repository, so a monorepo and an Azure Functions app end up seeding
    // each other's patterns.
    const byRepo = {
      "acme/web": ["apps/web/.env.local"],
      "acme/api": ["local.settings.json"],
    };
    assert.deepEqual(copyGlobsFor("/workspace/acme/web", globalList, byRepo, mounts).globs, [
      "apps/web/.env.local",
    ]);
    assert.deepEqual(copyGlobsFor("/workspace/acme/api", globalList, byRepo, mounts).globs, [
      "local.settings.json",
    ]);
  });

  it("takes a key absolute as well as relative to a mount", () => {
    const byRepo = { "/workspace2/scratch": ["config/local.yml"] };
    assert.deepEqual(copyGlobsFor("/workspace2/scratch", globalList, byRepo, mounts).globs, [
      "config/local.yml",
    ]);
  });

  it("prefers the longest key, so a parent is a default and not a verdict", () => {
    const byRepo = { acme: ["shared.env"], "acme/web": ["apps/web/.env"] };
    assert.equal(copyGlobsFor("/workspace/acme/api", globalList, byRepo, mounts).key, "acme");
    assert.equal(
      copyGlobsFor("/workspace/acme/web", globalList, byRepo, mounts).key,
      "acme/web",
    );
  });

  it("honours an empty list as an answer rather than an absence", () => {
    // "This repository copies nothing" is the one thing the global list cannot
    // say, and falling back here would hand it every pattern instead.
    const picked = copyGlobsFor("/workspace/acme/web", globalList, { "acme/web": [] }, mounts);
    assert.deepEqual(picked, { globs: [], key: "acme/web" });
  });
});

describe("seedReport", () => {
  const globs = [".env", ".env.*"];

  it("names what it copied", () => {
    assert.equal(seedReport([".env", "apps/web/.env"], [], globs), " (copied .env, apps/web/.env)");
  });

  it("tells a repository with nothing to seed from a list that matched nothing", () => {
    // These were the same line — the `(copied …)` clause simply absent — so a
    // checkout that needed configuration and got none looked exactly like one
    // that needed none. The second costs a billed cycle, and an agent under
    // `acceptEdits` may commit a placeholder config onto the branch.
    assert.equal(seedReport([], [], globs), " (nothing to seed)");

    const missed = seedReport([], ["apps/web/.env.local"], globs);
    assert.match(missed, /nothing seeded/);
    assert.match(missed, /apps\/web\/\.env\.local/);
    assert.match(missed, /matched none of \.env, \.env\.\*/);
  });

  it("counts the rest rather than listing every ignored file", () => {
    const many = ["a", "b", "c", "d", "e"];
    const line = seedReport([], many, globs);
    assert.match(line, /5 gitignored files here — a, b, c and 2 more/);
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

/**
 * Covers the terminus pair at the door every pick-up goes through.
 *
 * `POST /api/runs/[id]/reopen` refused this pair with a written-out explanation
 * and was the only place that did — so `reopenFleet`, which calls `reopenRun`
 * directly with a budget composed by a sheet that has no time-limit field,
 * could queue a whole fleet with nothing that would ever end it. The failure is
 * silent in the way this file exists for: `normalizePolicy` is total and
 * refuses nothing, the row flips to `queued` and the page looks right.
 *
 * It is worth a case rather than trusted to `evaluateBudget`'s own
 * `no_terminus` for the reason the three carried-forward checks beside it are:
 * that refusal arrives a cycle later, with the row already flickering
 * queued → blocked, and it is not what an operator watching a bulk press sees.
 * So the assertion is the refusal *and* the untouched status, never just `ok`.
 */
describe("the terminus a picked-up run must have", () => {
  let seq = 0;

  /** One row in `${ws}/Other`, in whatever state the case needs it. */
  function insertRun(status: string, budget: string): string {
    const id = `terminus-${++seq}`;
    db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                           iterations, created_at, finished_at, work_dir)
         VALUES (?, ?, 'do the thing', ?, ?, 1, 0, ?, ?, ?)`,
      )
      .run(
        id,
        `${ws}/Other`,
        status,
        budget,
        Date.now() + seq,
        Date.now() + seq,
        `${ws}/Other`,
      );
    return id;
  }

  /**
   * A finished row whose own stored budget names no time limit, with the folder
   * already occupied so the `promoteQueued` at the end of a successful reopen
   * has nothing to start. The subject here is the row, not a spawn.
   */
  function stoppedRun(budget: string): string {
    const id = insertRun("stopped", budget);
    insertRun("running", budget);
    return id;
  }

  it("refuses a pick-up with no cycle limit and no time limit, and leaves the row alone", () => {
    const id = stoppedRun('{"maxIterations":1,"permissionMode":"acceptEdits"}');

    const outcome = reopenRun(id, { maxIterations: null });

    assert.equal(outcome.ok, false);
    assert.match(
      outcome.ok ? "" : outcome.reason,
      /no work-cycle limit and no time limit/,
    );
    const row = getRun(id)!;
    assert.equal(
      row.status,
      "stopped",
      "refused before the row is touched — a run whose budget cannot be " +
        "accepted must not be left queued under it",
    );
  });

  it("accepts the same uncapped loop once a time limit answers for it", () => {
    const id = stoppedRun('{"maxIterations":1,"permissionMode":"acceptEdits"}');

    const outcome = reopenRun(id, { maxIterations: null, maxDurationMinutes: 60 });

    assert.equal(outcome.ok, true, outcome.ok ? "" : `refused: ${outcome.reason}`);
    const row = getRun(id)!;
    assert.equal(row.status, "queued");
    assert.equal(
      row.max_iterations,
      0,
      "0 is how an explicit null is stored — the refusal above is about the " +
        "pair, not about the null on its own",
    );
  });
});

/**
 * Covers what the sweeper does with one parked run.
 *
 * It earns a test on exactly the grounds `selectPromotable` and
 * `releasableRuns` do: pure, and every way of being wrong is silent, lands on
 * disk and costs money. This is the only code that decides whether a parked run
 * goes back to work, keeps waiting, or is killed, and it decides for every one
 * of them in a single tick against a single snapshot — so one inverted branch
 * is a whole parked fleet terminated that should have waited, or a whole fleet
 * waiting for ever that should have resumed, and neither throws.
 */
describe("the parked sweeper's decision", () => {
  type Verdict = import("./budget").BudgetVerdict;
  type StopCode = import("./budget").BudgetStopCode;

  /** Nothing about this run's own budget refuses it any more. */
  const cleared: Verdict = { allowed: true, meters: [] };

  /** The one refusal that clears on its own. */
  const parks = (resumeAt: number): Verdict => ({
    allowed: false,
    code: "session_fraction",
    reason: "The 5-hour window is full.",
    disposition: "pause",
    resumeAt,
    meters: [],
  });

  const stops = (code: StopCode, reason: string): Verdict => ({
    allowed: false,
    code,
    reason,
    disposition: "stop",
    meters: [],
  });

  describe("which parked runs it decides about", () => {
    it("treats a null wake time as due now", () => {
      // The hint's absence means "look on the next sweep", never "not yet".
      // Read the other way these runs are parked for ever, and a sweeper that
      // has quietly stopped deciding looks exactly like one between windows.
      const row = { id: "a", resume_at: null };
      assert.deepEqual(duePausedRuns([row], 1_000), [row]);
    });

    it("takes a wake time that has arrived and leaves one that has not", () => {
      const past = { id: "past", resume_at: 999 };
      const now = { id: "now", resume_at: 1_000 };
      const later = { id: "later", resume_at: 1_001 };
      assert.deepEqual(duePausedRuns([past, now, later], 1_000), [past, now]);
    });

    it("reports nothing when every parked run is still waiting", () => {
      // What buys the scan: no due run means no `currentSnapshot()` this tick.
      assert.deepEqual(duePausedRuns([{ id: "a", resume_at: 2_000 }], 1_000), []);
    });
  });

  describe("once its guard has cleared", () => {
    it("sends it back to the queue when the folder is free", () => {
      assert.deepEqual(planPausedRun(cleared, null), { action: "resume" });
    });

    it("holds it when a run started while it waited is in the folder", () => {
      // Resuming here is the two-agents-in-one-working-tree collision the
      // folder claim exists to prevent, arriving through the one door in this
      // app that is allowed to un-park a run.
      const plan = planPausedRun(cleared, "holder-1");
      assert.equal(plan.action, "hold");
      if (plan.action !== "hold") return;
      assert.equal(plan.heldBy, "holder-1", "the log line has to name what it waits for");
      assert.match(plan.reason, /folder/i);
    });

    it("gives the same reason every time, whoever holds the folder", () => {
      // The sweeper's UPDATE is guarded on `stop_reason IS NOT ?`, so this is
      // the whole of why a parked run does not get a rewritten row and a fresh
      // `run_events` line every 60 seconds. At twenty-five parked runs a reason
      // that varied would be twenty-five rows a minute into a table with no
      // retention.
      const first = planPausedRun(cleared, "holder-1");
      const again = planPausedRun(cleared, "holder-1");
      const other = planPausedRun(cleared, "holder-2");
      assert.equal(first.action, "hold");
      assert.equal(other.action, "hold");
      if (first.action !== "hold" || again.action !== "hold" || other.action !== "hold") return;

      assert.equal(again.reason, first.reason);
      assert.equal(other.reason, first.reason, "the holder must not reach the reason");
      assert.equal(
        first.reason.includes("holder-1"),
        false,
        "the holder's id belongs in the log payload, which is written once",
      );
    });
  });

  describe("while its guard still refuses", () => {
    it("parks it at the instant the verdict just derived", () => {
      // Re-derived rather than carried: the window that will clear this run is
      // not necessarily the one that closed it. The row is not an argument
      // here, so a carried `resume_at` is unreachable by construction.
      assert.deepEqual(planPausedRun(parks(5_000), null), {
        action: "park",
        resumeAt: 5_000,
      });
    });

    it("parks it whether or not the folder is taken", () => {
      // A refusal is a fact about this run's own budget. Who is in the folder
      // cannot answer it, so it must not change the answer.
      assert.deepEqual(planPausedRun(parks(5_000), "holder-1"), {
        action: "park",
        resumeAt: 5_000,
      });
    });
  });

  describe("when the refusal can never clear", () => {
    /**
     * Every code the sweeper can meet with a `stop` disposition, including
     * `session_fraction` — which parks only under `live-resume` and stops
     * otherwise, so reading the code instead of the disposition parks a run
     * for ever that its operator asked to be ended.
     */
    const NEVER_CLEARS: StopCode[] = [
      "weekly_fraction",
      "session_fraction",
      "run_cost",
      "run_tokens",
      "iterations",
      "duration",
      "instance_cost",
      "no_terminus",
    ];

    for (const code of NEVER_CLEARS) {
      it(`ends the run on ${code} rather than leaving it holding a folder`, () => {
        assert.deepEqual(planPausedRun(stops(code, `refused: ${code}`), null), {
          action: "end",
          reason: `refused: ${code}`,
        });
      });
    }

    it("ends it even while the folder is taken", () => {
      assert.deepEqual(planPausedRun(stops("duration", "Out of time."), "holder-1"), {
        action: "end",
        reason: "Out of time.",
      });
    });

    /**
     * `no_ceiling` was on the list above and is deliberately no longer: it is
     * the one refusal here that is not about this run at all. On a stock
     * install ceilings ship null by design and the fraction guard's reading is
     * the provider's own percentage, discarded after an hour without a fresh
     * answer — so an unreachable Anthropic host made this branch end every
     * parked run in the install, 60 seconds after the pre-cycle guard had
     * already ended every running one. That is the outcome
     * `INSTANCE_ENFORCEABLE_CODES` refuses one level up, in as many words, and
     * `RUN_ENFORCEABLE_CODES` is the same list for a run.
     *
     * It resumes rather than parking, because there is nothing here to wait
     * for: `resume_at` exists for a window that refills on a schedule, and a
     * reading that has gone comes back when it comes back. The run rejoins the
     * queue and `startRun`'s own pre-cycle check logs, once, that the guard has
     * nothing to read.
     */
    it("resumes a run whose fraction guard has nothing to read", () => {
      assert.deepEqual(
        planPausedRun(stops("no_ceiling", "No reading for that window."), null),
        { action: "resume" },
      );
    });

    it("still asks who holds the folder before resuming on an unreadable guard", () => {
      // The occupancy read is only made where the verdict clears the pause, so
      // a new clearing case that skipped it would resume straight into an
      // occupied working tree — the collision the folder claim exists to
      // prevent, arriving through the one door allowed to un-park a run.
      const plan = planPausedRun(
        stops("no_ceiling", "No reading for that window."),
        "holder-1",
      );
      assert.equal(plan.action, "hold");
      if (plan.action !== "hold") return;
      assert.equal(plan.heldBy, "holder-1");
    });
  });
});

/**
 * Covers the two writes the pure decision above cannot reach.
 *
 * These go to the database, which `CLAUDE.md` sets a bar for rather than
 * treating as ordinary, and each clears it on its own terms. The first pins
 * that a resumed run is handed to `promoteQueued` rather than to `startRun`:
 * the only evidence of the difference is that a run over the concurrency cap
 * stays `queued`, and a regression is one more billed agent per parked run at
 * the moment a window clears — which reads on the runs list exactly like a busy
 * fleet. The second pins `AND status='paused'` on the flip, which is a race by
 * definition: the sweeper reads its rows, then awaits a transcript scan that
 * takes seconds, and an operator's Stop landing in that gap must win. Nothing
 * pure can express either.
 *
 * What is deliberately *not* pinned here is that `promoteQueued()` is reached
 * at the end of the sweep at all. Its only observable effect is a run starting,
 * so a test for it is a test that spawns a child and leaves an async chain
 * running past the assertion — and a flaky suite costs more than this line
 * does, since every other terminal transition in the app calls `promoteQueued`
 * too, so a resumed run left `queued` is picked up by the next one rather than
 * stranded for ever. Calling `startRun` *instead of* it is the mistake that
 * matters, and the cap in the first case is what catches that.
 */
describe("applying the sweeper's decision", () => {
  const BUDGET_BLOB = '{"maxIterations":5,"maxDurationMinutes":600}';
  let seq = 0;

  function insertRun(fields: {
    status: string;
    workDir: string;
    resumeAt?: number | null;
  }): string {
    const id = `sweep-${++seq}`;
    db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                           iterations, created_at, started_at, work_dir, resume_at)
         VALUES (?, ?, 'do the thing', ?, ?, 5, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.workDir,
        fields.status,
        BUDGET_BLOB,
        Date.now() + seq,
        Date.now() - 60_000,
        fields.workDir,
        fields.resumeAt ?? null,
      );
    return id;
  }

  it("puts a resumed run in the queue rather than starting it", async () => {
    // A run already spending, and a cap it fills. `promoteQueued` is what knows
    // about the cap; `startRun` is not, so a sweeper that called it directly
    // would have this run `running` at the end of the tick.
    saveSettings({ maxConcurrentRuns: 1 });
    insertRun({ status: "running", workDir: `${ws}/Other` });
    const parked = insertRun({ status: "paused", workDir: `${ws}/nested/Deep` });

    await sweepPaused();

    const row = getRun(parked)!;
    assert.equal(
      row.status,
      "queued",
      "its window cleared, so it rejoins the queue — `running` here means the " +
        "sweeper started it itself and walked past a cap it does not know about",
    );
    assert.equal(row.resume_at, null, "a queued run has no wake time to keep");

    saveSettings({ maxConcurrentRuns: null });
  });

  it("leaves a run that was stopped while it was scanning stopped", async () => {
    const parked = insertRun({ status: "paused", workDir: `${ws}/nested/Deep` });

    // The sweeper runs synchronously as far as its first `await`, which is the
    // transcript scan — so by here it has already read this row as `paused`.
    const sweeping = sweepPaused();
    db().prepare("UPDATE runs SET status='stopped' WHERE id=?").run(parked);
    await sweeping;

    assert.equal(
      getRun(parked)!.status,
      "stopped",
      "the flip is guarded on `status='paused'`, so the operator's stop wins",
    );
  });

  it("hands back only so many parked runs per tick", async () => {
    // The half of the herd the jitter on `resume_at` cannot reach. A fleet
    // parked before the spread existed, or bunched against the
    // `MIN_REFUSAL_WAIT_MS` floor, or simply carrying a null, is due in one
    // tick — and every one of them used to be flipped to `queued` in a single
    // pass and handed to one `promoteQueued()`, which starts everything
    // startable in one synchronous turn. `maxConcurrentRuns` ships as `null`,
    // so nothing downstream bounds that wave either.
    //
    // The cap fills the concurrency slot as well, which is what keeps this test
    // from spawning: with one run already `running` from the case above, the
    // promotion at the end of the sweep has nothing to start.
    saveSettings({ maxConcurrentRuns: 1 });
    const parked = Array.from({ length: MAX_RESUMES_PER_SWEEP + 2 }, (_, i) =>
      insertRun({ status: "paused", workDir: `${ws}/herd-${i}` }),
    );

    await sweepPaused();

    const queued = parked.filter((id) => getRun(id)!.status === "queued");
    assert.equal(
      queued.length,
      MAX_RESUMES_PER_SWEEP,
      "one tick must not queue the whole parked fleet",
    );
    assert.deepEqual(
      queued,
      parked.slice(0, MAX_RESUMES_PER_SWEEP),
      "and it must still be the oldest first — the cap is a rate, not a reshuffle",
    );
    for (const id of parked.slice(MAX_RESUMES_PER_SWEEP)) {
      const row = getRun(id)!;
      assert.equal(row.status, "paused", "the rest wait for the next tick");
      // Nothing written, so nothing rewritten every 60 seconds into a table
      // with no retention — `FOLDER_TAKEN_REASON`'s rule, one branch over.
      assert.equal(row.stop_reason, null);
    }

    saveSettings({ maxConcurrentRuns: null });
  });
});

/**
 * Covers what one lifecycle event says on container stdout, and at what level.
 *
 * Not a pure function, and it earns the exception the way `settleOnExit` does:
 * what it decides is a *line*, and both halves of that line fail silently. A
 * level is a routing decision — one `info` for all nine statuses makes the
 * ending whose entire content is "a person should look at this" arrive
 * indistinguishable from an ordinary completion, and the only evidence is an
 * alert that never fires, which reads exactly like a fleet with nothing wrong.
 * The field set is the other half and fails the other way: the docblock over
 * `logLifecycle` says it **projects** rather than serialising, because a
 * `status` payload at creation carries the folder and an `iteration` payload
 * carries the whole prompt, so a spread added here would put both on a stream
 * with a different audience and a different lifetime from `run_events`.
 * Neither throws, neither fails to typecheck, and neither shows on any page.
 */
describe("what a lifecycle event says on stdout", () => {
  /** The JSON lines one call writes, parsed, whichever stream they went to. */
  function capture(fn: () => void): Array<Record<string, unknown>> {
    const lines: Array<Record<string, unknown>> = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    const take = (text: unknown) => {
      lines.push(JSON.parse(String(text)) as Record<string, unknown>);
    };
    console.log = take;
    console.warn = take;
    console.error = take;
    try {
      fn();
    } finally {
      Object.assign(console, real);
    }
    return lines;
  }

  const event = (
    kind: PersistedRunEvent["kind"],
    payload: Record<string, unknown>,
  ): PersistedRunEvent => ({ id: 1, runId: "run-1", ts: 1_700_000_000_000, kind, payload });

  const one = (e: PersistedRunEvent): Record<string, unknown> => {
    const lines = capture(() => logLifecycle(e));
    assert.equal(lines.length, 1, "one event is one line");
    return lines[0];
  };

  it("routes the three endings that want a person at warn, and nothing else", () => {
    // All nine, both directions: a status that stops being routed is as silent
    // as one that starts being, and the second wakes somebody for a press they
    // just made.
    const levels: Array<[RunStatus, string]> = [
      ["waiting", "info"],
      ["queued", "info"],
      ["running", "info"],
      ["paused", "info"],
      ["completed", "info"],
      ["needs-review", "warn"],
      // An operator's own cancel arrives as `stopped`, and a run a guard took
      // down already has `run.guard_tripped` at warn naming the code.
      ["stopped", "info"],
      ["failed", "warn"],
      ["blocked", "warn"],
    ];
    for (const [status, level] of levels) {
      const line = one(event("status", { status }));
      assert.equal(line.level, level, `${status} must reach stdout at ${level}`);
      assert.equal(line.event, "run.status", "the event name is not part of the change");
      assert.equal(line.status, status);
    }
  });

  it("still says exactly what it said before the levels moved", () => {
    // The creation `status` event is the one that carries the folder, which is
    // this install's own layout on a stream something else retains.
    const line = one(
      event("status", {
        status: "running",
        folder: "/workspace/PrivateRepo",
        prompt: "the whole task text",
      }),
    );
    assert.deepEqual(Object.keys(line).sort(), ["event", "level", "run_id", "status", "ts"]);
  });

  it("tells the 429 ladder's wait apart from a run that has died", () => {
    // A rung of the ladder: retried in place for 17-26 minutes holding the
    // folder, the worktree slot and one of `maxConcurrentRuns`, with the row
    // still reading `running` everywhere state is read.
    const line = one(
      event("error", {
        message: "API Error: 429 — retrying in 30s (1 of 4).",
        apiError: "API Error: 429",
        exitCode: 1,
        usageLimit: false,
        waiting: false,
        retrying: true,
      }),
    );
    assert.equal(line.level, "error");
    assert.equal(line.retrying, true);
    assert.equal(line.usage_limit, false);
    // Two named booleans, never a spread: `apiError`, `exitCode` and `waiting`
    // are beside them in the payload and must not follow them out.
    assert.deepEqual(Object.keys(line).sort(), [
      "event",
      "level",
      "message",
      "retrying",
      "run_id",
      "ts",
      "usage_limit",
    ]);
  });

  it("names an exhausted allowance on the refusal that parks rather than retries", () => {
    const line = one(
      event("error", {
        message: "Claude usage limit reached.",
        usageLimit: true,
        waiting: true,
        retrying: false,
      }),
    );
    assert.equal(line.usage_limit, true);
    assert.equal(line.retrying, false, "a park is not a retry, and false is not absent");
  });

  it("distinguishes absent from false on an error that is not a refusal at all", () => {
    // A spawn failure carries neither field. `null` is what the two accessors
    // beside it already mean by absent, and reading it as `false` would file
    // every dead container as a refusal the ladder had given up on.
    const line = one(event("error", { message: "Failed to launch /nope: ENOENT" }));
    assert.equal(line.retrying, null);
    assert.equal(line.usage_limit, null);
  });
});

/**
 * What a run-list request asks for, once every value has come off a query
 * string.
 *
 * It earns a test on the same grounds `selectBranchCandidates` does: it is pure
 * and every way it can be wrong produces a list that looks like an answer.
 * Nothing throws, nothing fails to typecheck, and the page renders rows. A
 * `limit` read as one row, a wildcard the operator typed and this did not
 * escape, an epoch of 0 read as a real boundary — each of them is a page of runs
 * that is not the page that was asked for, and the failure that matters most
 * here is the one this route was parameterised to end: a miss that reads as an
 * absence.
 */
describe("the live ticker's two cadences", () => {
  /**
   * Both halves used to ride one interval, and both ways of collapsing them
   * back are silent.
   *
   * The context reading is the only answer this app has to "how full is this
   * run", and it rode `liveGuardIntervalSeconds` — a setting about money, which
   * an operator may reasonably put at ten minutes. The panel then sat ten
   * minutes behind showing a perfectly plausible number, with nothing on screen
   * naming the setting that had moved it. The other direction costs instead of
   * lying: `buildSnapshot` is uncoalesced and is the expensive half, so a
   * `guardMs` that collapsed onto the floored tick would run it five times as
   * often as the operator asked and nothing would say so either.
   */
  it("floors the tick at the context ceiling however high the setting goes", () => {
    const plan = liveTickPlan(600);
    assert.equal(plan.tickMs, 120_000, "the reading is taken at least this often");
    assert.equal(plan.guardMs, 600_000, "and the budget keeps the operator's own");
  });

  it("leaves a setting under the ceiling exactly where it was", () => {
    // The default, and the case every install is actually on: one cadence, and
    // the split costs it nothing.
    const plan = liveTickPlan(60);
    assert.deepEqual(plan, { tickMs: 60_000, guardMs: 60_000 });
  });

  it("keeps the setting's own floor rather than trusting the row", () => {
    // `saveSettings` clamps at 15, but a row written by an older build — or by
    // hand — is not obliged to have been through it, and 0 here is an interval
    // of zero milliseconds.
    assert.deepEqual(liveTickPlan(0), { tickMs: 15_000, guardMs: 15_000 });
    assert.deepEqual(liveTickPlan(-30), { tickMs: 15_000, guardMs: 15_000 });
  });

  it("runs the budget scan on the first tick after the ticker starts", () => {
    // `guardScan.at` is zeroed when the ticker starts, so the run it was
    // started for is scanned rather than waiting out a whole interval.
    assert.equal(guardScanDue(0, 1_000_000, liveTickPlan(600)), true);
  });

  it("rounds the budget scan to the nearest tick instead of pushing it late", () => {
    const plan = liveTickPlan(600);
    const at = 1_000_000;
    // A tick a hair early. Refusing it would push the scan a whole tick past the
    // cadence the operator set — 12 minutes on a 10-minute setting — and the
    // error compounds every time it happens.
    assert.equal(guardScanDue(at, at + 599_900, plan), true);
    // Half a tick early is the boundary itself, and is included.
    assert.equal(guardScanDue(at, at + 540_000, plan), true);
    // Further out than that is a tick of its own and waits.
    assert.equal(guardScanDue(at, at + 539_999, plan), false);
    assert.equal(guardScanDue(at, at + 120_000, plan), false);
  });

  it("never stands the budget scan down where the two cadences are one", () => {
    // The default install: every tick is a guard tick, and a scan arriving a
    // few milliseconds early must not be skipped into a 2-minute cadence.
    const plan = liveTickPlan(60);
    const at = 1_000_000;
    assert.equal(guardScanDue(at, at + 59_990, plan), true);
    assert.equal(guardScanDue(at, at + 60_000, plan), true);
  });
});

describe("normalizeRunListQuery", () => {
  it("answers an unreadable page size with the ordinary page, not the smallest one", () => {
    // `selectBranchCandidates`' reasoning verbatim: these arrive off a query
    // string, and a one-row page is a far worse answer to a typo than 100 rows.
    assert.equal(normalizeRunListQuery().limit, 100);
    assert.equal(normalizeRunListQuery({ limit: 0 }).limit, 100);
    assert.equal(normalizeRunListQuery({ limit: -3 }).limit, 100);
    assert.equal(normalizeRunListQuery({ limit: Number("nope") }).limit, 100);
    // Infinity is not a page size either, and lands where every other
    // unreadable value lands rather than on the ceiling. `Number.isFinite` is
    // the same guard `selectBranchCandidates` applies to the same parameter.
    assert.equal(normalizeRunListQuery({ limit: Infinity }).limit, 100);
  });

  it("caps a page at the ceiling and honours anything under it", () => {
    assert.equal(normalizeRunListQuery({ limit: 25 }).limit, 25);
    assert.equal(normalizeRunListQuery({ limit: 5000 }).limit, 200);
    // A fractional page size is a page size, floored — `Number("25.7")` is what
    // `?limit=25.7` comes to and 25.7 rows is not a LIMIT SQLite will take.
    assert.equal(normalizeRunListQuery({ limit: 25.7 }).limit, 25);
  });

  it("reads a missing, negative or unreadable offset as the first page", () => {
    assert.equal(normalizeRunListQuery().offset, 0);
    assert.equal(normalizeRunListQuery({ offset: -40 }).offset, 0);
    assert.equal(normalizeRunListQuery({ offset: Number("") }).offset, 0);
    assert.equal(normalizeRunListQuery({ offset: 120 }).offset, 120);
    assert.equal(normalizeRunListQuery({ offset: 120.9 }).offset, 120);
  });

  it("escapes the wildcards a task or a folder may legitimately hold", () => {
    // The whole reason the needle is built here rather than interpolated at the
    // query: `%` and `_` are LIKE wildcards, and both are ordinary characters in
    // a prompt. Unescaped, a search for `50%` matches every run there is.
    assert.equal(normalizeRunListQuery({ q: "50%" }).like, "%50\\%%");
    assert.equal(normalizeRunListQuery({ q: "a_b" }).like, "%a\\_b%");
    // And the escape character itself, or the escape stops meaning anything.
    assert.equal(normalizeRunListQuery({ q: "a\\b" }).like, "%a\\\\b%");
  });

  it("reads a blank query as no text filter at all", () => {
    // Not as a needle that matches everything and not as one that matches
    // nothing: absent, so the clause is never added.
    assert.equal(normalizeRunListQuery().like, null);
    assert.equal(normalizeRunListQuery({ q: "" }).like, null);
    assert.equal(normalizeRunListQuery({ q: "   " }).like, null);
    assert.equal(normalizeRunListQuery({ q: null }).like, null);
    assert.equal(normalizeRunListQuery({ q: " fix the cache " }).like, "%fix the cache%");
  });

  it("bounds the needle rather than comparing a paste against every row", () => {
    const like = normalizeRunListQuery({ q: "x".repeat(5000) }).like;
    // 200 characters plus the two wildcards this wraps them in.
    assert.equal(like?.length, 202);
  });

  it("reads a boundary at or before the epoch as no boundary", () => {
    // `Number(null)`, `Number("")` and a blank `?settledBefore=` all come to 0
    // or NaN. Read as a real instant, every one of them would answer a history
    // request with an empty page — which on that page reads as "no older runs".
    assert.equal(normalizeRunListQuery().settledBefore, null);
    assert.equal(normalizeRunListQuery({ settledBefore: 0 }).settledBefore, null);
    assert.equal(normalizeRunListQuery({ settledBefore: -1 }).settledBefore, null);
    assert.equal(
      normalizeRunListQuery({ settledBefore: Number("yesterday") }).settledBefore,
      null,
    );
    assert.equal(
      normalizeRunListQuery({ settledBefore: 1_750_000_000_000 }).settledBefore,
      1_750_000_000_000,
    );
  });

  it("carries no status when none was named", () => {
    // Null rather than undefined, because the query below tests `!== null` to
    // decide whether the clause exists at all.
    assert.equal(normalizeRunListQuery().status, null);
    assert.equal(normalizeRunListQuery({ status: "failed" }).status, "failed");
  });
});

describe("clampRunOffset", () => {
  it("lands a page past the end on the last rows rather than on nothing", () => {
    // Pressing Next on a list that shrank under you is how an offset gets past
    // the end, and an empty page reads as "nothing matches".
    assert.equal(clampRunOffset(400, 10), 9);
    assert.equal(clampRunOffset(10, 10), 9);
    assert.equal(clampRunOffset(9, 10), 9);
  });

  it("stays at zero on an empty list", () => {
    // `total - 1` is -1 here, and a negative OFFSET is an error SQLite raises.
    assert.equal(clampRunOffset(0, 0), 0);
    assert.equal(clampRunOffset(500, 0), 0);
  });

  it("refuses to walk backwards off the front", () => {
    assert.equal(clampRunOffset(-40, 100), 0);
    assert.equal(clampRunOffset(Number.NaN, 100), 0);
  });
});

describe("isRunStatus", () => {
  it("admits every status the app writes", () => {
    for (const status of [
      "waiting",
      "queued",
      "running",
      "paused",
      "completed",
      "needs-review",
      "stopped",
      "failed",
      "blocked",
    ]) {
      assert.equal(isRunStatus(status), true, status);
    }
  });

  it("refuses what is not one, including what a prototype would answer for", () => {
    // The reason this is `includes` and not `in`: `in` walks the prototype
    // chain, so `?status=constructor` would pass the narrow at the route's door
    // and reach the query as a status no row can hold.
    assert.equal(isRunStatus("constructor"), false);
    assert.equal(isRunStatus("toString"), false);
    assert.equal(isRunStatus(""), false);
    assert.equal(isRunStatus("Failed"), false);
    assert.equal(isRunStatus(null), false);
    assert.equal(isRunStatus(7), false);
  });
});
