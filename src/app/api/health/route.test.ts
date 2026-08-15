import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * The healthcheck's whole reason for existing is that it answers *falsely* when
 * this server cannot do its job, so the only test worth having drives it in
 * both directions — and the unhealthy direction is the one that matters.
 *
 * A route that always answers 200 is indistinguishable from a working one until
 * the day the database goes read-only, which is precisely when Docker is
 * reporting the container as fine and nothing restarts it. That is not
 * something a typecheck or a happy-path smoke test can see.
 *
 * It opens a throwaway database for `src/app/api/chat/[id]/route.test.ts`'s
 * reason: the defect this guards is a status code on a payload, so the only
 * test that can see it is one that reads the payload. The unhealthy state is
 * simulated by replacing the `globalThis` database handle with one that throws
 * — which is what an I/O error, a corrupt file and a read-only directory all
 * present as at this layer, and the only way to reach both states in one
 * process, since `DATA_DIR` is fixed at the first import of `config.ts`.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-health-"));
process.env.DATA_DIR = DATA_DIR;

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

interface HealthBody {
  ok: boolean;
  status: string;
  problems: string[];
  checks: { database: string; dataDirOwned: boolean; databaseError?: string };
  runs: { running: number; queued: number; waiting: number; paused: number };
  sweeper: { lastTickAgeSeconds: number | null; failures: number };
  eventLoopLagMs: number;
  uptimeSeconds: number;
}

async function probe(): Promise<{ status: number; body: HealthBody }> {
  const { GET } = await import("./route");
  const res = await GET();
  return { status: res.status, body: (await res.json()) as HealthBody };
}

type DbSlot = { __ufDb?: Database.Database };

test("answers 200 with counts, and nothing but counts", async () => {
  const { db } = await import("../../../lib/db");
  db(); // force the schema, so the counts below are a real query

  const { status, body } = await probe();

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.checks.database, "ok");
  assert.deepEqual(body.runs, { running: 0, queued: 0, waiting: 0, paused: 0 });
  assert.equal(typeof body.eventLoopLagMs, "number");
  assert.equal(typeof body.uptimeSeconds, "number");
  assert.equal(body.sweeper.failures, 0);

  // The exemption in `middleware.ts` is justified by this and only this: the
  // payload carries counts. A prompt, a folder path, a setting or a token
  // appearing here makes an unauthenticated route into a data leak, and it
  // would arrive by someone adding a "useful" field rather than by a rewrite.
  const serialised = JSON.stringify(body);
  for (const forbidden of ["prompt", "folder", "token", "path", "model", "usd"]) {
    assert.ok(
      !serialised.toLowerCase().includes(forbidden),
      `the health payload must not carry "${forbidden}": ${serialised}`,
    );
  }
});

test("counts the runs it finds, by status", async () => {
  const { db } = await import("../../../lib/db");
  const insert = db().prepare(
    "INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, created_at)" +
      " VALUES (?, '/w', 'p', ?, '{}', 1, ?)",
  );
  insert.run("r-running", "running", Date.now());
  insert.run("r-queued", "queued", Date.now());
  insert.run("r-waiting", "waiting", Date.now());
  insert.run("r-paused-1", "paused", Date.now());
  insert.run("r-paused-2", "paused", Date.now());
  insert.run("r-done", "completed", Date.now());

  const { body } = await probe();
  assert.deepEqual(body.runs, {
    running: 1,
    queued: 1,
    waiting: 1,
    paused: 2,
  });
});

test("answers 503 when the database handle throws", async () => {
  const slot = globalThis as unknown as DbSlot;
  const real = slot.__ufDb;
  slot.__ufDb = {
    prepare() {
      throw new Error("SQLITE_IOERR: disk I/O error");
    },
  } as unknown as Database.Database;

  try {
    const { status, body } = await probe();

    assert.equal(status, 503, "an unreachable database must not answer 2xx");
    assert.equal(body.ok, false);
    assert.equal(body.status, "unhealthy");
    assert.equal(body.checks.database, "error");
    assert.ok(body.problems.includes("database"));
    // The message is worth carrying — it is what tells an operator reading a
    // failed probe apart from a container that never started — but it is the
    // message and not a stack.
    assert.match(String(body.checks.databaseError), /disk I\/O error/);
    assert.ok(!String(body.checks.databaseError).includes("\n"));
  } finally {
    slot.__ufDb = real;
  }
});

test("says so when parked runs have outlived the sweeper, and still answers 2xx", async () => {
  // A run has been parked since the test above, and nothing has swept: that is
  // a sweeper this server is no longer running for work that is waiting on it.
  // Reported, not fatal — a restart costs every in-flight run.
  const { body, status } = await probe();

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, "degraded");
  assert.ok(
    body.problems.includes("sweeper-stalled"),
    `expected a stalled sweeper to be named: ${JSON.stringify(body.problems)}`,
  );
  assert.equal(body.sweeper.lastTickAgeSeconds, null);
});
