import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * What a process that does not own the data directory may do.
 *
 * The lock's *decision* is pure and covered next door in `serverLock.test.ts`.
 * What is covered here is the thing that decision was never wired to: with the
 * directory correctly reported as somebody else's, `createRun` went on
 * resolving a folder, inserting a row and spawning a billed agent. The claim
 * that keeps two agents out of one directory is a synchronous check-then-insert
 * and it is atomic because *one* event loop runs it, so a second process
 * admitting runs against this database is exactly the collision `db.ts` opens
 * by naming the single process as what prevents it — and it is silent: two
 * plausible rows, two agents, one checkout.
 *
 * Its own file, and the environment is set before anything is required, for the
 * reason every database-backed test here needs: `config.ts` fixes `DATA_DIR`
 * and `CLAUDE_HOME` at module load, and a static import would be hoisted above
 * it and run against the operator's own database.
 *
 * The control is half of it. A refusal that fired for every caller would pass
 * this test and break the app, so the same call is made again with the
 * directory owned and has to come back with a row.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-datadir-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
// Belt to the fake `spawn` below: if the replacement ever stopped taking
// effect, this is a path that cannot be executed rather than a real, billed CLI.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above.
const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { claimDataDir, heartbeat, ownsDataDir, parseLock, releaseDataDir } =
  require("./serverLock") as typeof import("./serverLock");
const { createRun, getRun } = require("./orchestrator") as typeof import("./orchestrator");
const { db } = require("./db") as typeof import("./db");

/**
 * Count the children an admission would start, without starting one.
 *
 * `orchestrator.ts` reaches `spawn` through the module object under the test
 * build's CommonJS emit, so replacing it here is what every spawn below gets.
 */
const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;
let spawnCount = 0;
childProcess.spawn = () => {
  spawnCount++;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 424242,
  });
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  releaseDataDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const lockPath = () => path.join(config.DATA_DIR, "server.lock");

/** Let a started run's loop reach its terminal state before the row is read. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

const task = {
  folder: "project",
  mountId: null,
  prompt: "do the thing",
  budget: { maxIterations: 1 },
  origin: "form" as const,
};

describe("a process that does not own the data directory", () => {
  it("refuses to admit a run, and names the pid that does", async () => {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    // A pid that is alive and is not ours, which is what `lockVerdict` needs to
    // answer "held" rather than watching a corpse: the process that started
    // this test file. A fresh heartbeat, so nothing about staleness is in play.
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: process.ppid,
        ownerId: "another-server",
        startedAt: Date.now() - 60_000,
        heartbeatAt: Date.now(),
      }),
    );

    assert.equal(await claimDataDir(), false, "the lock should have been refused");
    assert.equal(ownsDataDir(), false);

    const before = spawnCount;
    assert.throws(
      () => createRun(task),
      (err: Error) => {
        assert.match(err.message, /does not own its data directory/);
        assert.match(
          err.message,
          new RegExp(`process ${process.ppid}\\b`),
          "the refusal has to name the owner, or there is nothing to go and stop",
        );
        return true;
      },
    );

    const rows = db().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    assert.equal(rows.n, 0, "a refused admission must leave no row behind");
    assert.equal(spawnCount, before, "a refused admission must spawn nothing");
  });

  it("admits one again once it owns the directory", async () => {
    // The control. `claimDataDir` is asked once per process in the app, but
    // nothing here is stateful beyond the lock file, so removing it and asking
    // again is the same question with the other answer.
    fs.rmSync(lockPath(), { force: true });
    assert.equal(await claimDataDir(), true);
    assert.equal(ownsDataDir(), true);

    const run = createRun(task);
    assert.equal(getRun(run.id)?.id, run.id, "the run must exist after an owned admission");

    await settle();
  });
});

describe("an owner that loses the directory while it is up", () => {
  it("stands down at the next beat instead of restamping the stranger's lock", () => {
    // Reached by a stall rather than by a second server being started: one
    // `gitSync` can hold the event loop to git's own ceiling, so the heartbeat
    // simply does not fire, the lock goes stale, and another process claims it.
    // The old `beat()` wrote over that claim with no comparison at all, leaving
    // two processes both believing they held the directory for ever — and with
    // it the folder claim's one guarantee, that a single event loop decides
    // whether a folder is free.
    assert.equal(ownsDataDir(), true, "this case starts from owning it");

    const stranger = {
      pid: process.ppid,
      ownerId: "the-other-server",
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    fs.writeFileSync(lockPath(), JSON.stringify(stranger));

    heartbeat();

    assert.equal(ownsDataDir(), false, "the beat must notice the directory is gone");
    assert.equal(
      parseLock(fs.readFileSync(lockPath(), "utf8"))?.ownerId,
      stranger.ownerId,
      "the beat must not stamp its own claim back over the new owner's",
    );

    // And the gate every writer reads — including the one the six boot
    // reconcilers sit behind — now answers no. That is the whole of what this
    // process can still do about it: whoever took the directory has already
    // closed out the runs, and the damage from here on would be this server
    // going on writing to a database it does not own.
    const before = spawnCount;
    assert.throws(() => createRun(task), /lost its claim on the data directory/);
    assert.equal(spawnCount, before);
  });
});
