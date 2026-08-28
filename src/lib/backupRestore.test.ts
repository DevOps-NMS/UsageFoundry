import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";

import Database from "better-sqlite3";

/**
 * Covers the two shipped scripts that copy this database and put it back.
 *
 * It is neither a pure function nor a rendering, and it earns its place the way
 * `deployment.test.ts` does — on a failure that is silent, expensive and
 * invisible to everything else here. The database is opened in WAL mode, so the
 * committed state is spread across three files and the backup an operator
 * reaches for first — `docker cp` of `usagefoundry.db`, or a `tar` of `/data` —
 * omits every transaction since the last checkpoint. The restored file opens
 * cleanly, passes `integrity_check`, and is simply missing the newest runs.
 * There is no assertion available anywhere else in this repository that tells
 * that apart from a good backup, and nobody looks at a backup until the day the
 * volume is gone.
 *
 * So the subject is the real database and the real scripts, driven as an
 * operator drives them: a snapshot taken while another connection holds a write
 * transaction open, restored into a directory standing in for a fresh volume,
 * and compared table by table against the source once it is quiesced. The four
 * refusals beside it are the ones that turn a restore into a second incident —
 * restoring under a live server, whether or not its heartbeat is still moving
 * (which corrupts rather than replaces), losing the database that was there,
 * restoring some other SQLite file, and a prune that deletes the wrong thing.
 *
 * `DATA_DIR` is set before the first import for `chatTurn.test.ts`'s reason:
 * `config.ts` reads it at module load, and this file needs the real `migrate()`
 * so the schema it round-trips is the shipped one rather than a hand-written
 * imitation of it. `node --test` gives each file its own process; the assertion
 * in `before` is what makes a change to that fail loudly instead of backing up
 * the developer's own database.
 */

let root: string;
let dataDir: string;
let backupDir: string;
/**
 * One backup taken in `before`, for the cases that are about restoring rather
 * than about taking one. `node --test` runs the suites in this file
 * concurrently, so a test that read another suite's output directory would be
 * depending on an order nothing guarantees.
 */
let fixtureBackup: string;
let dbMod: typeof import("./db");
/** For the one number `restore-db.mjs` has to keep a copy of. */
let lockMod: typeof import("./serverLock");

function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `no package.json above ${__dirname}`);
    dir = parent;
  }
  return dir;
}

interface ScriptRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawned rather than run in-process, and asynchronously rather than with
 * `spawnSync`: these ship as executables an operator runs, and the live-server
 * case below needs the event loop free to keep a heartbeat going while the
 * child watches for one.
 *
 * `fileLimitBlocks` is how the interrupted-restore case makes a copy fail part
 * of the way through. Node exposes no `setrlimit`, so the limit is set by a
 * shell between the fork and the exec; the script and its arguments are passed
 * as positional parameters rather than interpolated into the command, since
 * they are `mkdtemp` paths. `ulimit -f` raises `EFBIG` where a full volume
 * raises `ENOSPC`, which is the same unhandled throw out of the same call.
 */
function runScript(
  script: string,
  args: string[],
  opts: { fileLimitBlocks?: number } = {},
): Promise<ScriptRun> {
  let file = process.execPath;
  let argv = [path.join(repoRoot(), "scripts", script), ...args];
  if (opts.fileLimitBlocks !== undefined) {
    argv = ["-c", 'ulimit -f "$1"; shift; exec "$@"', "sh", String(opts.fileLimitBlocks), file, ...argv];
    file = "/bin/sh";
  }
  return new Promise((resolve) => {
    const child = spawn(file, argv, {
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Every table and index, plus how many rows each table holds. */
interface Shape {
  schema: string[];
  counts: Record<string, number>;
}

function shapeOf(file: string): Shape {
  const db = new Database(file, { readonly: true });
  try {
    const objects = db
      .prepare(
        "SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master" +
          " WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as { type: string; name: string; sql: string }[];
    const counts: Record<string, number> = {};
    for (const object of objects) {
      if (object.type !== "table") continue;
      const row = db.prepare(`SELECT count(*) AS n FROM "${object.name}"`).get() as { n: number };
      counts[object.name] = row.n;
    }
    return {
      schema: objects.map((o) => `${o.type} ${o.name} ${o.sql.replace(/\s+/g, " ").trim()}`),
      counts,
    };
  } finally {
    db.close();
  }
}

/** One run row, with only the columns the schema insists on. */
function insertRun(id: string): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations, created_at)
       VALUES (?, ?, ?, 'completed', '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, 1, ?)`,
    )
    .run(id, path.join(root, "workspace"), `task for ${id}`, Date.now());
}

/**
 * A database standing in for the one a restore would replace, holding a row
 * nothing else writes so that its survival is a fact rather than an inference.
 */
function seedLiveDatabase(target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const live = new Database(target);
  live.exec("CREATE TABLE runs (id TEXT PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY)");
  live.prepare("INSERT INTO runs VALUES ('the-live-one')").run();
  live.close();
}

/** Whether `target` is still the database `seedLiveDatabase` wrote. */
function stillTheLiveDatabase(target: string): boolean {
  const db = new Database(target, { readonly: true });
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM runs WHERE id = 'the-live-one'")
      .get() as { n: number };
    return row.n === 1;
  } finally {
    db.close();
  }
}

/** `server.lock` as `serverLock.ts` writes it, stamped once and left alone. */
function writeLock(dir: string, heartbeatAt: number): void {
  fs.writeFileSync(
    path.join(dir, "server.lock"),
    JSON.stringify({
      pid: process.pid,
      ownerId: "test-owner",
      startedAt: heartbeatAt - 60_000,
      heartbeatAt,
    }),
  );
}

/** The newest file the backup script wrote into `dir`. */
function newestBackup(dir: string): string {
  const names = fs
    .readdirSync(dir)
    .filter((name) => /^usagefoundry-\d{8}T\d{6}Z\.db$/.test(name))
    .sort();
  assert.ok(names.length > 0, `no backup was written into ${dir}`);
  return path.join(dir, names[names.length - 1]);
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-backup-"));
  dataDir = path.join(root, "data");
  backupDir = path.join(root, "backups");
  process.env.DATA_DIR = dataDir;
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    dataDir,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  dbMod = await import("./db");
  lockMod = await import("./serverLock");

  // Enough rows that a snapshot missing the tail of them is unmistakable.
  for (let i = 0; i < 40; i += 1) insertRun(`run-${String(i).padStart(3, "0")}`);
  const event = dbMod
    .db()
    .prepare("INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, 'log', '{}')");
  for (let i = 0; i < 200; i += 1) event.run(`run-${String(i % 40).padStart(3, "0")}`, Date.now());
  dbMod.db().prepare("INSERT INTO settings (key, value) VALUES ('weeklyCostLimit', '650')").run();

  const fixtureDir = path.join(root, "fixture");
  const taken = await runScript("backup-db.mjs", [fixtureDir]);
  assert.equal(taken.code, 0, `the fixture backup failed: ${taken.stderr}`);
  fixtureBackup = newestBackup(fixtureDir);
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a backup taken while the database is being written", () => {
  it("round-trips the whole schema and every committed row", async () => {
    // Committed a moment before the snapshot and never checkpointed, so it is
    // in the WAL and nowhere else: this is the row a `docker cp` of the main
    // file loses while reporting success.
    insertRun("run-committed-just-before");

    // A second connection holding an open write transaction: the writer this
    // app's own runs are, at the instant a scheduled backup fires. Its rows are
    // never committed, so a snapshot that contains them is not a snapshot of
    // any state that ever existed. It is opened after the row above because
    // SQLite has one writer at a time — with this transaction open, the app's
    // own connection could not commit anything either.
    const writer = new Database(path.join(dataDir, "usagefoundry.db"));
    writer.exec("BEGIN IMMEDIATE");
    const uncommitted = writer.prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations, created_at)
       VALUES (?, '/w', 'never committed', 'running', '{}', 1, 0, ?)`,
    );
    for (let i = 0; i < 10; i += 1) uncommitted.run(`uncommitted-${i}`, Date.now());

    const backup = await runScript("backup-db.mjs", [backupDir]);
    assert.equal(backup.code, 0, `backup failed: ${backup.stderr}`);

    writer.exec("ROLLBACK");
    writer.close();

    // The reference: the source database with nothing writing to it.
    const reference = shapeOf(path.join(dataDir, "usagefoundry.db"));

    // A directory that has never held a database, standing in for the fresh
    // volume `docker compose down -v` leaves behind.
    const freshDir = path.join(root, "fresh");
    const restore = await runScript("restore-db.mjs", [
      newestBackup(backupDir),
      "--db",
      path.join(freshDir, "usagefoundry.db"),
    ]);
    assert.equal(restore.code, 0, `restore failed: ${restore.stderr}`);

    const restored = shapeOf(path.join(freshDir, "usagefoundry.db"));
    assert.deepEqual(restored.schema, reference.schema);
    assert.deepEqual(restored.counts, reference.counts);
    assert.ok(reference.counts.runs > 40, "the seeded rows are missing from the reference");

    const check = new Database(path.join(freshDir, "usagefoundry.db"), { readonly: true });
    try {
      assert.equal(
        (check.prepare("SELECT count(*) AS n FROM runs WHERE id = ?").get(
          "run-committed-just-before",
        ) as { n: number }).n,
        1,
        "the run committed a moment before the snapshot is not in it",
      );
      assert.equal(
        (check.prepare("SELECT count(*) AS n FROM runs WHERE id LIKE 'uncommitted-%'").get() as {
          n: number;
        }).n,
        0,
        "the snapshot contains rows from a transaction that never committed",
      );
    } finally {
      check.close();
    }
  });
});

describe("restoring", () => {
  it("refuses while a server still holds the data directory", async () => {
    const target = path.join(root, "live", "usagefoundry.db");
    fs.mkdirSync(path.dirname(target), { recursive: true });

    // `serverLock.ts`'s heartbeat, from outside the process that writes it —
    // which is what a restore in its own container can see of a live server.
    const lock = path.join(path.dirname(target), "server.lock");
    const write = () =>
      fs.writeFileSync(
        lock,
        JSON.stringify({
          pid: process.pid,
          ownerId: "test-owner",
          startedAt: Date.now(),
          heartbeatAt: Date.now(),
        }),
      );
    write();
    const beat = setInterval(write, 500);

    try {
      const restore = await runScript("restore-db.mjs", [fixtureBackup, "--db", target]);
      assert.equal(restore.code, 1);
      assert.match(restore.stderr, /a server is running/);
      assert.equal(fs.existsSync(target), false, "it restored anyway");
    } finally {
      clearInterval(beat);
    }
  });

  it("refuses while the owner's event loop is blocked and the beat has stopped", async () => {
    const dir = path.join(root, "blocked");
    const target = path.join(dir, "usagefoundry.db");
    seedLiveDatabase(target);

    // The case above with its one moving part taken away. A server inside
    // `gitSync` — a `spawnSync` bounded by git's own 20s ceiling, several of
    // them back to back on the admission path — cannot fire the `setInterval`
    // that beats this lock, so the file stops moving while the process is
    // perfectly healthy, holds the database open and goes on writing its WAL.
    // Watching for a beat read that as a corpse: the live database was renamed
    // aside, the backup put in its place, and everything the server committed
    // from that moment went into an inode nothing would ever open again — with
    // a success message and an exit status of 0.
    writeLock(dir, Date.now());

    const restore = await runScript("restore-db.mjs", [fixtureBackup, "--db", target]);
    assert.equal(restore.code, 1);
    assert.match(restore.stderr, /a server is running/);
    // The pid is the only thing in that sentence naming *which* process, and it
    // is what an operator checks before concluding the refusal is wrong.
    assert.match(restore.stderr, new RegExp(`pid ${process.pid}\\b`));
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".superseded-")),
      [],
      "the live database was moved aside",
    );
    assert.ok(stillTheLiveDatabase(target), "the live database was replaced");
  });

  it("proceeds against a lock nothing has beaten for longer than STALE_MS", async () => {
    const dir = path.join(root, "abandoned");
    const target = path.join(dir, "usagefoundry.db");
    seedLiveDatabase(target);

    // The control, and half of the case above: a refusal keyed on a lock being
    // *present* rather than on its age passes every assertion up there and
    // refuses every restore after a killed container, which is the state an
    // operator reaches for this script in. The app itself stops honouring this
    // lock at the same boundary — `lockVerdict` answers `claim` past it.
    writeLock(dir, Date.now() - lockMod.STALE_MS - 60_000);

    const restore = await runScript("restore-db.mjs", [fixtureBackup, "--db", target]);
    assert.equal(restore.code, 0, restore.stderr);
    assert.equal(stillTheLiveDatabase(target), false, "it refused the restore");
  });

  it("holds its copy of STALE_MS to the number serverLock.ts derives", () => {
    // The script cannot import it — the runtime image ships `scripts/` without
    // `src/` — so the number is a copy, and a copy drifts silently in both
    // directions: a restore refused against a directory nothing holds, or one
    // that replaces a database under a server this app still calls its owner.
    // `deployment.test.ts`'s grounds, one pair of files over.
    const source = fs.readFileSync(path.join(repoRoot(), "scripts", "restore-db.mjs"), "utf8");
    const declared = /^const STALE_MS = ([\d_]+) \* (\d+);$/m.exec(source);
    assert.ok(declared, "restore-db.mjs no longer declares STALE_MS where this test can read it");
    assert.equal(
      Number(declared[1].replace(/_/g, "")) * Number(declared[2]),
      lockMod.STALE_MS,
      "the restore script and serverLock.ts disagree about when a lock is stale",
    );
  });

  it("keeps the database it replaces, and its sidecar files with it", async () => {
    const dir = path.join(root, "existing");
    const target = path.join(dir, "usagefoundry.db");
    fs.mkdirSync(dir, { recursive: true });
    const old = new Database(target);
    old.pragma("journal_mode = WAL");
    old.exec("CREATE TABLE runs (id TEXT PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY)");
    old.prepare("INSERT INTO runs VALUES ('the-old-one')").run();
    old.close();
    // A `-wal` from the database being replaced. Left in place, SQLite would
    // replay it into the restored file on the next open.
    fs.writeFileSync(`${target}-wal`, "stale wal");

    const restore = await runScript("restore-db.mjs", [fixtureBackup, "--db", target]);
    assert.equal(restore.code, 0, restore.stderr);

    const kept = fs.readdirSync(dir).filter((name) => name.includes(".superseded-"));
    assert.equal(kept.length, 2, `expected the database and its -wal to be kept, got ${kept}`);
    assert.equal(fs.existsSync(`${target}-wal`), false, "the superseded -wal is still in place");

    const restored = new Database(target, { readonly: true });
    try {
      assert.equal(
        (restored.prepare("SELECT count(*) AS n FROM runs WHERE id = 'the-old-one'").get() as {
          n: number;
        }).n,
        0,
        "the old database is still there",
      );
    } finally {
      restored.close();
    }
  });

  it("leaves the database that was there when the copy dies part-way", async () => {
    const dir = path.join(root, "interrupted");
    const target = path.join(dir, "usagefoundry.db");
    fs.mkdirSync(dir, { recursive: true });
    const live = new Database(target);
    live.exec("CREATE TABLE runs (id TEXT PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY)");
    live.prepare("INSERT INTO runs VALUES ('the-operators-data')").run();
    live.close();

    // Half the backup's own size, so the copy is certain to meet the limit part
    // of the way through rather than before it starts or after it finishes.
    const size = fs.statSync(fixtureBackup).size;
    const blocks = Math.floor(size / 2 / 512);
    assert.ok(blocks > 0, `the fixture backup is too small to truncate: ${size} bytes`);

    const restore = await runScript("restore-db.mjs", [fixtureBackup, "--db", target], {
      fileLimitBlocks: blocks,
    });

    assert.equal(restore.code, 1);
    // The one that fails against an unguarded copy: with the database moved
    // aside first, this directory held nothing but a `.superseded-` file whose
    // name was never printed, and the next boot created a fresh empty database
    // here and came up green.
    assert.ok(fs.existsSync(target), `the database is gone: ${restore.stderr}`);
    const kept = new Database(target, { readonly: true });
    try {
      assert.equal(
        (kept.prepare("SELECT count(*) AS n FROM runs WHERE id = 'the-operators-data'").get() as {
          n: number;
        }).n,
        1,
        "the database is at its own path but the rows that were in it are not",
      );
    } finally {
      kept.close();
    }
    // Says the failure was reported as one rather than thrown, and that what it
    // told the operator about their data is true.
    assert.match(restore.stderr, /untouched/);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".partial") || name.includes(".superseded-")),
      [],
      "a half-written copy or a moved-aside database was left behind",
    );
  });

  it("refuses a file that is not this app's database", async () => {
    const stranger = path.join(root, "stranger.db");
    const other = new Database(stranger);
    other.exec("CREATE TABLE notes (body TEXT)");
    other.close();

    const restore = await runScript("restore-db.mjs", [
      stranger,
      "--db",
      path.join(root, "stranger-target", "usagefoundry.db"),
    ]);
    assert.equal(restore.code, 1);
    assert.match(restore.stderr, /not a UsageFoundry database/);
  });
});

describe("pruning", () => {
  it("keeps the newest N of its own files and touches nothing else", async () => {
    const dir = path.join(root, "pruned");
    fs.mkdirSync(dir, { recursive: true });
    // Two older backups and one file that is not ours. The names carry the
    // ordering, which is why the timestamp is written the way it is.
    for (const name of ["usagefoundry-20200101T000000Z.db", "usagefoundry-20200102T000000Z.db"]) {
      fs.writeFileSync(path.join(dir, name), "older");
    }
    fs.writeFileSync(path.join(dir, "keep-me.db"), "not ours");

    const backup = await runScript("backup-db.mjs", [dir, "--keep", "2"]);
    assert.equal(backup.code, 0, backup.stderr);

    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, [
      "keep-me.db",
      "usagefoundry-20200102T000000Z.db",
      path.basename(newestBackup(dir)),
    ].sort());
  });

  it("refuses to overwrite a backup that already exists", async () => {
    const named = path.join(root, "explicit.db");
    const first = await runScript("backup-db.mjs", [named]);
    assert.equal(first.code, 0, first.stderr);
    const again = await runScript("backup-db.mjs", [named]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already exists/);
  });
});
