#!/usr/bin/env node
// Put a backup taken by scripts/backup-db.mjs back in place.
//
// Four things this does that a `cp` back over the file does not, each of them
// the difference between a restore and a second incident:
//
//   1. It refuses while a server is live. The app holds the database open with
//      its own WAL; replacing the file underneath it leaves that process
//      writing into a stale write-ahead log, which is the one way to corrupt
//      this database rather than merely lose it. Liveness is decided the way
//      `src/lib/serverLock.ts` decides it — by watching `server.lock` for a
//      beat — because a restore runs in a *different container* from the
//      server, where a pid means nothing.
//   2. It moves the existing database aside instead of deleting it, along with
//      its `-wal` and `-shm`. The sidecars are not tidiness: a leftover `-wal`
//      belongs to the database that was there before, and SQLite would apply it
//      to the restored file on the next open.
//   3. It checks the file is this app's database before anything is moved. A
//      restore is run under pressure, from a directory of similar-looking
//      files, and finding out afterwards is the expensive order to find out in.
//   4. It copies under a temporary name and renames into place, so a restore
//      that dies part-way leaves the database that was there rather than no
//      database at all. An empty data directory is not an outage: the next boot
//      creates a database, migrates it, and the app comes up green and empty.
//
// Usage:
//   node scripts/restore-db.mjs <backup file> [--db <path>]
//
//   --db <path>  Where to restore to. Defaults to $DATA_DIR/usagefoundry.db.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** Mirrors `DATA_DIR` in src/lib/config.ts, which this script cannot import. */
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");

/**
 * How long to watch `server.lock` for a heartbeat.
 *
 * Comfortably more than `HEARTBEAT_MS` in src/lib/serverLock.ts, and framed as
 * an observation rather than as a copy of that module's `STALE_MS` so the two
 * cannot drift into disagreeing about a number. A lock that beats at all is a
 * live owner; one that does not is the corpse of a container that was killed,
 * which is the ordinary state of things at the moment somebody needs a restore.
 */
const OBSERVE_MS = 2_500;

/**
 * Tables every version of this schema has had. A file with neither is not this
 * app's database, whatever it is called.
 */
const REQUIRED_TABLES = ["runs", "settings"];

const SUMMARY_TABLES = [
  "runs",
  "run_events",
  "workflows",
  "workflow_schedules",
  "run_templates",
  "agents",
  "settings",
];

function fail(message) {
  console.error(`restore: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { source: null, db: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") {
      args.db = argv[(i += 1)];
      if (!args.db) fail("--db needs a path");
    } else if (arg === "-h" || arg === "--help") {
      console.log("Usage: node scripts/restore-db.mjs <backup file> [--db <path>]");
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option ${arg}`);
    } else if (args.source === null) {
      args.source = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  if (!args.source) fail("name the backup file to restore, e.g. /backups/usagefoundry-20260814T201530Z.db");
  return args;
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function readLock(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      typeof value?.heartbeatAt !== "number" ||
      typeof value?.ownerId !== "string" ||
      typeof value?.pid !== "number"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `stillBeating` from src/lib/serverLock.ts, read from outside the process. */
async function serverIsLive(dataDir) {
  const file = path.join(dataDir, "server.lock");
  const before = readLock(file);
  if (!before) return null;
  await sleep(OBSERVE_MS);
  const after = readLock(file);
  if (!after) return null;
  const beating = after.ownerId !== before.ownerId || after.heartbeatAt > before.heartbeatAt;
  return beating ? before : null;
}

/**
 * Remove a half-written copy, along with any sidecar inspecting it created.
 *
 * Best effort on purpose: the operator is already being told the restore
 * failed, and what matters is that none of this is at the path the app opens.
 */
function discardPartial(partial) {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${partial}${ext}`, { force: true });
    } catch {
      // Nothing to do about it that the message this precedes does not say.
    }
  }
}

/** Throws unless the file is a readable SQLite database holding this schema. */
function inspect(file) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.pragma("integrity_check");
    const verdict = rows[0]?.integrity_check;
    if (verdict !== "ok") {
      throw new Error(`integrity_check said: ${rows.map((r) => r.integrity_check).join("; ")}`);
    }
    const present = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length) {
      throw new Error(
        `it has no ${missing.join(" or ")} table, so it is not a UsageFoundry database`,
      );
    }
    const parts = [];
    for (const table of SUMMARY_TABLES) {
      if (!present.has(table)) continue;
      const { n } = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get();
      parts.push(`${n.toLocaleString("en-GB")} ${table}`);
    }
    return { tables: present.size, parts };
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const source = path.resolve(args.source);
  if (!fs.existsSync(source)) fail(`no such file: ${source}`);

  const target = path.resolve(args.db ?? path.join(DATA_DIR, "usagefoundry.db"));
  const dataDir = path.dirname(target);
  if (source === target) fail("the backup and the database are the same file");

  let summary;
  try {
    summary = inspect(source);
  } catch (err) {
    fail(`${source} cannot be restored: ${err.message}`);
  }

  const owner = await serverIsLive(dataDir);
  if (owner) {
    fail(
      `a server is running against ${dataDir} (pid ${owner.pid} in its own ` +
        `container). Stop it first — \`docker compose stop\` — and run this ` +
        `again. Restoring under a live server corrupts the database rather ` +
        `than replacing it.`,
    );
  }

  fs.mkdirSync(dataDir, { recursive: true });

  // Copied under a temporary name and renamed into place, `backup-db.mjs`'s
  // discipline in the other direction: the database that is there is not moved
  // until there is a whole, inspected copy to put in its place. A copy that
  // dies part-way — `ENOSPC` on the volume, or the container killed mid-restore
  // — then leaves the operator's database exactly where the app opens it,
  // rather than a data directory with no database in it at all, which the next
  // boot fills with a fresh empty one and comes up green.
  const partial = `${target}.partial`;
  try {
    fs.copyFileSync(source, partial);
  } catch (err) {
    discardPartial(partial);
    fail(`could not copy ${source} to ${partial}: ${err.message}. ${target} is untouched.`);
  }

  // Read it back through a fresh handle rather than trusting the copy, and
  // before anything is moved, so a copy that arrives unreadable costs nothing.
  let restored;
  try {
    restored = inspect(partial);
  } catch (err) {
    discardPartial(partial);
    fail(`the copy at ${partial} is not usable: ${err.message}. ${target} is untouched.`);
  }

  // The sidecars go with it. A `-wal` left behind belongs to the database being
  // superseded, and SQLite would replay it into the restored file.
  const moved = [];
  if (fs.existsSync(target)) {
    const suffix = `superseded-${stamp(new Date())}`;
    for (const ext of ["", "-wal", "-shm"]) {
      const from = `${target}${ext}`;
      if (!fs.existsSync(from)) continue;
      const to = `${target}${ext}.${suffix}`;
      fs.renameSync(from, to);
      moved.push({ from, to });
    }
  }

  try {
    fs.renameSync(partial, target);
  } catch (err) {
    discardPartial(partial);
    const stranded = [];
    for (const { from, to } of moved) {
      try {
        fs.renameSync(to, from);
      } catch {
        stranded.push(to);
      }
    }
    if (stranded.length) {
      // Said here because this is the only disclosure of those names there is,
      // and the success path below is no longer going to be reached.
      console.error(`restore: the database that was there could not be put back. It is here:`);
      for (const file of stranded) console.error(`  ${file}`);
    }
    fail(`could not move ${partial} into place: ${err.message}`);
  }

  // A backup that is itself in WAL mode leaves the inspection's `-shm` and
  // `-wal` behind under the temporary name. They hold nothing committed — the
  // source's own WAL was never copied — and the restored file makes its own on
  // the next open, so they are debris rather than sidecars.
  discardPartial(partial);

  console.log(`restored ${source}`);
  console.log(`      to ${target}`);
  console.log(`         ${restored.tables} tables · ${restored.parts.join(" · ")}`);
  if (moved.length) {
    console.log(`\nThe database that was there is kept, not deleted:`);
    for (const { to } of moved) console.log(`  ${to}`);
    console.log("Delete those once you are satisfied with the restore.");
  }
  console.log("\nStart the app:\n  docker compose up -d");
}

await main();
