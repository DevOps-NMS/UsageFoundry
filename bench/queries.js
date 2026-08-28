"use strict";
/**
 * The queries the polled pages actually issue, against a database with
 * realistic row counts — and the pricing pass the runs list hangs off.
 *
 * The app's real database on a developer machine has no runs in it, so the
 * numbers here mean nothing until `populate-db.js` has built a fixture:
 *
 *     npx tsc -p tsconfig.test.json
 *     export DATA_DIR="$TMPDIR/ufbench"
 *     node bench/populate-db.js
 *     node bench/queries.js
 *
 * To see what the planner did before `migrate()` learned to `ANALYZE`, drop the
 * statistics and run a build that predates it — the flag this file used to carry
 * could not work, because `db()` runs `migrate()`, which puts them straight
 * back:
 *
 *     node -e 'new (require("better-sqlite3"))(process.env.DATA_DIR+"/usagefoundry.db")
 *                .exec("DROP TABLE IF EXISTS sqlite_stat1; DROP TABLE IF EXISTS sqlite_stat4")'
 *     BUILD=/tmp/before/lib node bench/queries.js
 */
const path = require("node:path");

const BUILD = process.env.BUILD || path.join(__dirname, "..", ".test-build", "lib");
const { listRunsPage, activeRuns, queuePosition } = require(path.join(BUILD, "orchestrator.js"));
const { pruneSavingsByRun, forkSavings, pricedCuts } = require(path.join(BUILD, "contextPruning.js"));
const { db } = require(path.join(BUILD, "db.js"));

function med(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function timeSync(fn, n) {
  fn(); // warm
  const s = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    s.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return med(s);
}

async function timeAsync(fn, n) {
  await fn();
  const s = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    s.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return med(s);
}

const DAY = 86_400_000;

async function main() {
  const handle = db();
  const runCount = handle.prepare("SELECT count(*) c FROM runs").get().c;
  const eventCount = handle.prepare("SELECT count(*) c FROM run_events").get().c;
  const hasStats = handle
    .prepare("SELECT count(*) c FROM sqlite_master WHERE name = 'sqlite_stat1'")
    .get().c;
  console.log(`fixture: ${runCount} runs, ${eventCount} run_events, stats: ${hasStats ? "yes" : "no"}\n`);

  const now = Date.now();
  const cases = {
    "listRunsPage unfiltered p1 (4s poll)": () => listRunsPage({ limit: 100, offset: 0 }),
    "listRunsPage status filter p1": () => listRunsPage({ limit: 100, offset: 0, status: "completed" }),
    "listRunsPage status offset 3000": () => listRunsPage({ limit: 100, offset: 3000, status: "completed" }),
    "listRunsPage history": () => listRunsPage({ limit: 100, offset: 0, settledBefore: now - DAY }),
    "listRunsPage unfiltered last page": () => listRunsPage({ limit: 100, offset: 4900 }),
    "listRunsPage LIKE search": () => listRunsPage({ limit: 100, offset: 0, q: "deploy" }),
    "activeRuns": () => activeRuns(),
  };
  for (const [label, fn] of Object.entries(cases)) {
    console.log(`${label.padEnd(40)} ${timeSync(fn, 50).toFixed(2).padStart(8)} ms`);
  }

  // queuePosition is called once per queued row by GET /api/runs.
  const queued = activeRuns().filter((r) => r.status === "queued");
  console.log(
    `${`queuePosition x${queued.length} (what /api/runs does)`.padEnd(40)} ${timeSync(
      () => { for (const r of queued) queuePosition(r.id); },
      30,
    ).toFixed(2).padStart(8)} ms`,
  );

  // The pricing pass hanging off the same poll. This is the one that was
  // O(clean probes x every turn in the corpus) before the session grouping.
  const ids = listRunsPage({ limit: 100, offset: 0 }).rows.map((r) => r.id);
  console.log(
    `\n${"pruneSavingsByRun (100-run page)".padEnd(40)} ${(await timeAsync(() => pruneSavingsByRun(ids), 5)).toFixed(0).padStart(8)} ms`,
  );
  const oldest = handle
    .prepare("SELECT run_id FROM fork_attempts WHERE written = 1 ORDER BY ts ASC LIMIT 1")
    .get();
  if (oldest) {
    console.log(
      `${"forkSavings (oldest fork-bearing run)".padEnd(40)} ${(await timeAsync(() => forkSavings({ runId: oldest.run_id }), 5)).toFixed(0).padStart(8)} ms`,
    );
  }
  console.log(
    `${"pricedCuts over all history".padEnd(40)} ${(await timeAsync(() => pricedCuts({ from: 0, to: Date.now() }), 3)).toFixed(0).padStart(8)} ms`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
