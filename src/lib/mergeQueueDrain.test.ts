import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * That the worker always answers the row it took, and only that.
 *
 * `setStatus` is reachable from `drainRepo` and from nowhere else: `cancelBatch`
 * and `cancelQueuedFor` touch `queued` rows alone, and `reconcileMergeQueueOnBoot`
 * needs a restart. So this loop is the only thing in the process that can move a
 * row off `landing` or `resolving`, and a throw escaping it stranded that row
 * for the life of the container — while `queuedRunIds` went on counting the run
 * as queued, so `enqueue` refused it by name and the operator's only retry was
 * the manual Land button, which worked, on a branch whose queue row still said
 * `landing`. Nothing crashes: Next's own `unhandledRejection` handler logs the
 * rejection and the server keeps serving the frozen panel.
 *
 * It earns a database and a real repository for the reason the parked sweeper's
 * writes do — no pure function reaches the transition, and a second copy of the
 * loop in a test would be the copy that stayed right.
 *
 * The failure is provoked where it does the most damage and where it is a real
 * shape rather than an invented one: a database error on the `land` event
 * `landRun` emits **after** it has merged into the operator's checkout and
 * written `runs.landed_at` (`land.ts:965`). The merge is on disk and has
 * succeeded; only this app's own bookkeeping broke. That is what the row has to
 * be honest about, and it is why the answer is `failed` with "it is not known
 * whether the merge went through" rather than a retry. The trigger stands in for
 * the reachable causes — `SQLITE_BUSY` or `IOERR` on any of the four statements
 * that path runs, and, before `git()` was made total, an `EMFILE` rejection out
 * of any of a dozen git children.
 *
 * Its own file for `mergeQueueOrder.test.ts`'s reason: `config.ts` reads
 * `DATA_DIR` at module load, so a file that imports `./mergeQueue` statically
 * would bind the path to the repository's own `.data` directory, which on a
 * developer's machine is the real one.
 */

let mergeQueue: typeof import("./mergeQueue");
let dbMod: typeof import("./db");
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

before(async () => {
  // `realpathSync` around the temp root, which eight sibling test files already
  // do and this one did not. On macOS `os.tmpdir()` is `/var/folders/…`, a
  // symlink to `/private/var/folders/…`, and `resolveInMount` checks
  // containment on the resolved path *and again* after `realpathSync` —
  // `security.md` says both are load-bearing. So a mount registered at the
  // unresolved path refuses its own checkout, and all three tests in this file
  // failed off Linux with "This run's repository is no longer inside a
  // workspace mount." A fixture bug, not a landing bug: the assertion it broke
  // is the one proving a clean branch lands.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-merge-drain-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // Nothing here resolves a conflict, so nothing here should reach a spawn. A
  // `claude` that does not exist makes a regression that gets that far a failed
  // test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  process.env.WORKSPACE_ROOTS = path.join(root, "ws");
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  repo = path.join(root, "ws", "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");

  mergeQueue = await import("./mergeQueue");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Break the `land` event `landRun` emits once the merge is already committed.
 *
 * Narrow on purpose: everything up to and including the merge is real, and what
 * fails is one statement inside `emit()`, which is the shape a `SQLITE_BUSY`
 * takes. Returns the undo.
 */
function breakLandEvent(): () => void {
  dbMod
    .db()
    .prepare(
      `CREATE TRIGGER uf_test_break_land BEFORE INSERT ON run_events
         WHEN NEW.kind = 'land'
         BEGIN SELECT RAISE(ABORT, 'the disk went away'); END`,
    )
    .run();
  return () => {
    dbMod.db().prepare("DROP TRIGGER uf_test_break_land").run();
  };
}

/** A completed isolated run whose branch is one commit ahead of `main`. */
function makeRun(id: string, file: string, repoRoot = repo): string {
  const branch = `uf/repo-${id}`;
  git(repo, "checkout", "-q", "-b", branch);
  fs.writeFileSync(path.join(repo, file), `${file}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `work ${id}`);
  const base = git(repo, "rev-parse", "main").trim();
  git(repo, "checkout", "-q", "main");

  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, isolation, repo_root, worktree_branch, worktree_base,
                         worktree_base_branch)
       VALUES (?, ?, 'task', 'completed', '{}', 1, 1, ?, 'worktree', ?, ?, ?, 'main')`,
    )
    .run(id, repoRoot, Date.now(), repoRoot, branch, base);
  return branch;
}

/** Wait for the worker to owe the batch nothing, or give up and report. */
async function settle(batchId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = mergeQueue.batchRows(batchId);
    if (rows.length > 0 && !rows.some((r) => mergeQueue.isQueueActive(r.status))) {
      return rows;
    }
    if (Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("the merge worker", () => {
  it("lands a clean branch and says so on the row", async () => {
    makeRun("aaaaaaaa", "b.txt");
    const queued = mergeQueue.enqueue(["aaaaaaaa"], {
      strategy: "merge",
      autoResolve: false,
    });
    assert.ok(queued.ok, JSON.stringify(queued));

    const rows = await settle(queued.batchId);
    assert.equal(rows[0].status, "landed", rows[0].message ?? "");
  });

  it("answers the row it was on when this server itself breaks", async () => {
    makeRun("bbbbbbbb", "c.txt");
    makeRun("cccccccc", "d.txt");
    const undo = breakLandEvent();

    try {
      const queued = mergeQueue.enqueue(["bbbbbbbb", "cccccccc"], {
        strategy: "merge",
        autoResolve: false,
      });
      assert.ok(queued.ok, JSON.stringify(queued));

      const rows = await settle(queued.batchId, 10_000);

      // The row it was holding. `landing` here is the whole defect: nothing in
      // the process can move it afterwards, `enqueue` refuses the run by name
      // for as long as it stands, and the panel shows it in flight for ever.
      assert.equal(rows[0].status, "failed", `left on ${rows[0].status}`);
      assert.match(rows[0].message ?? "", /not known whether the merge went through/);

      // And the branch behind it, which must not be left waiting on a loop that
      // has gone. `skipped` for the same reason a dirty checkout skips the rest:
      // this fault will meet it identically, and each attempt is another merge
      // into a directory a person owns.
      assert.equal(rows[1].status, "skipped", `left on ${rows[1].status}`);
    } finally {
      undo();
    }
  });

  it("takes the next branch after that, rather than waiting for a restart", async () => {
    // A drain that answered a broken row still reaches its own tail and hands
    // the queue on. Before the row-level catch the throw went past the loop
    // entirely, so the `startWorker()` after it never ran and every repository
    // the `MAX_MERGE_WORKERS` cap was holding back waited for the next enqueue
    // — which, for the runs in the stranded rows, `enqueue` refused by name.
    makeRun("dddddddd", "e.txt");
    const queued = mergeQueue.enqueue(["dddddddd"], {
      strategy: "merge",
      autoResolve: false,
    });
    assert.ok(queued.ok, JSON.stringify(queued));

    const rows = await settle(queued.batchId);
    assert.equal(rows[0].status, "landed", rows[0].message ?? "");
  });
});
