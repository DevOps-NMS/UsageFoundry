#!/usr/bin/env node
// Take a consistent snapshot of the live SQLite database.
//
// `cp` is not a backup here and neither is `docker cp`. The database is opened
// in WAL mode (`db.ts`), so the committed state is spread across three files:
// `usagefoundry.db`, `-wal` and `-shm`. Copying the main file alone silently
// omits every transaction committed since the last checkpoint — it restores
// cleanly and is simply missing the newest runs, which is the worst failure
// available. Copying all three copies them at three different instants while
// runs are writing between them, so the `-wal` can reference pages the main
// file does not have.
//
// `VACUUM INTO` is SQLite's own answer: it reads one consistent snapshot under
// a read transaction and writes a fresh, compacted, single-file database. It
// does not block writers, it does not checkpoint or otherwise touch the source,
// and its output has no `-wal` of its own — one file that can be moved around
// like any other.
//
// The source connection is opened read-only, which is the guarantee rather than
// the intent: `db.ts` opens with why this app is single-writer, and a second
// process holding a writable handle on that file is the thing that invariant is
// about. SQLite refuses any write through this handle; `VACUUM INTO` still
// works, because the only file it writes is the target.
//
// Usage:
//   node scripts/backup-db.mjs [<destination>] [--keep N] [--db <path>]
//
//   <destination>  A directory (a timestamped file is written inside it) or a
//                  path ending in `.db`. Defaults to $UF_BACKUP_DIR, then
//                  /backups when that is a directory, then ./backups.
//   --keep N       After a successful backup, delete all but the newest N
//                  files this script generated in that directory.
//   --db <path>    The database to back up. Defaults to
//                  $DATA_DIR/usagefoundry.db.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** Mirrors `DATA_DIR` in src/lib/config.ts, which this script cannot import. */
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");

/** Only ever matched against files this script itself wrote. */
const GENERATED = /^usagefoundry-\d{8}T\d{6}Z\.db$/;

/** Reported after every backup, so an empty snapshot cannot look like a full one. */
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
  console.error(`backup: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { dest: null, keep: null, db: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") {
      const raw = argv[(i += 1)];
      const n = Number.parseInt(raw ?? "", 10);
      if (!Number.isFinite(n) || n < 1) fail(`--keep needs a positive integer, got ${raw ?? "nothing"}`);
      args.keep = n;
    } else if (arg === "--db") {
      args.db = argv[(i += 1)];
      if (!args.db) fail("--db needs a path");
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/backup-db.mjs [<destination>] [--keep N] [--db <path>]",
      );
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option ${arg}`);
    } else if (args.dest === null) {
      args.dest = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  return args;
}

/** `2026-08-14T20:15:30.123Z` → `20260814T201530Z`, which sorts as it reads. */
function stamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function defaultDestination() {
  if (process.env.UF_BACKUP_DIR) return process.env.UF_BACKUP_DIR;
  // The container's bind mount. Absent outside Docker, where ./backups is the
  // directory the compose file binds by default anyway.
  try {
    if (fs.statSync("/backups").isDirectory()) return "/backups";
  } catch {
    /* not in the container */
  }
  return path.join(process.cwd(), "backups");
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Row counts for the tables an operator would check before trusting a file.
 * Missing tables are skipped rather than reported as zero: a backup taken from
 * an older schema is still a backup, and "0 workflows" and "no such table" are
 * different sentences.
 */
function summarize(file) {
  const db = new Database(file, { readonly: true });
  try {
    const present = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
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

/**
 * `integrity_check` rather than `quick_check`: this runs once a day against a
 * file nobody will look at until the day it is needed, and the difference is
 * seconds. A backup that fails it is deleted rather than left in the directory,
 * because a corrupt file with a plausible name is exactly what this whole
 * script exists to stop an operator from finding at the worst moment.
 */
function verify(file) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.pragma("integrity_check");
    const verdict = rows[0]?.integrity_check;
    if (verdict !== "ok") throw new Error(`integrity_check said: ${rows.map((r) => r.integrity_check).join("; ")}`);
  } finally {
    db.close();
  }
}

function prune(dir, keep) {
  const generated = fs
    .readdirSync(dir)
    .filter((name) => GENERATED.test(name))
    .sort()
    .reverse();
  const doomed = generated.slice(keep);
  for (const name of doomed) fs.unlinkSync(path.join(dir, name));
  return doomed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const source = path.resolve(args.db ?? path.join(DATA_DIR, "usagefoundry.db"));
  if (!fs.existsSync(source)) {
    fail(
      `no database at ${source}. Set DATA_DIR or pass --db; inside the ` +
        `container it is /data/usagefoundry.db.`,
    );
  }

  const rawDest = args.dest ?? defaultDestination();
  const asDirectory = !rawDest.endsWith(".db");
  const dir = path.resolve(asDirectory ? rawDest : path.dirname(rawDest));
  const target = asDirectory
    ? path.join(dir, `usagefoundry-${stamp(new Date())}.db`)
    : path.resolve(rawDest);

  if (args.keep !== null && !asDirectory) {
    fail("--keep applies to a backup directory, not to a single named file");
  }

  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(target)) {
    fail(`${target} already exists — refusing to overwrite a backup`);
  }

  // Written under a temporary name and renamed into place, so a backup
  // interrupted half-way through leaves nothing that looks complete.
  const partial = `${target}.partial`;
  if (fs.existsSync(partial)) fs.unlinkSync(partial);

  const db = new Database(source, { readonly: true });
  try {
    // Bound rather than interpolated: the destination is a path, and a quote in
    // it would otherwise end the SQL string literal.
    db.prepare("VACUUM INTO ?").run(partial);
  } finally {
    db.close();
  }

  try {
    verify(partial);
  } catch (err) {
    fs.unlinkSync(partial);
    fail(`the snapshot did not verify and has been deleted: ${err.message}`);
  }

  fs.renameSync(partial, target);

  const { tables, parts } = summarize(target);
  console.log(`source  ${source} (${bytes(sizeOf(source))} + ${bytes(sizeOf(`${source}-wal`))} WAL)`);
  console.log(`wrote   ${target} (${bytes(sizeOf(target))})`);
  console.log(`checked integrity_check ok · ${tables} tables · ${parts.join(" · ")}`);

  if (args.keep !== null) {
    const removed = prune(dir, args.keep);
    console.log(
      removed.length
        ? `pruned  ${removed.length} older backup(s), keeping the newest ${args.keep}`
        : `pruned  nothing, keeping the newest ${args.keep}`,
    );
  }

  console.log(`\nRestore with:\n  node scripts/restore-db.mjs ${target}`);
}

main();
