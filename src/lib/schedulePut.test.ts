import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * What saving a schedule keeps and what it resets, and only that.
 *
 * The defect is in the SQL, the way `chatOrder.test.ts`'s was: `putSchedule`'s
 * UPDATE carried a literal `paused=0`, so pressing **Change** on a paused
 * schedule — or opening it, altering nothing and pressing Save — switched the
 * one thing in this app that starts a billed agent with nobody present back on,
 * as a side effect of a form that never asked about it. Nothing threw, nothing
 * typechecked differently, and the card is honest afterwards only if the
 * operator happens to read it.
 *
 * It is its own file for `chatOrder.test.ts`'s reason: `config.ts` reads
 * `DATA_DIR` at module load and `schedules.test.ts` imports `./schedules`
 * statically, so by the time a test body ran the path would already be bound to
 * the repository's own `.data` — which on a developer's machine is the real one.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uf-schedule-put-"));
process.env.DATA_DIR = dataDir;

type SchedulesModule = typeof import("./schedules");
type WorkflowsModule = typeof import("./workflows");
type DbModule = typeof import("./db");

let schedules: SchedulesModule;
let workflows: WorkflowsModule;
let dbMod: DbModule;

before(async () => {
  schedules = await import("./schedules");
  workflows = await import("./workflows");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const BERLIN = "Europe/Berlin";
const DAILY_0900: import("./schedules").ScheduleSpec = { kind: "daily", minutes: 540 };
const DAILY_1000: import("./schedules").ScheduleSpec = { kind: "daily", minutes: 600 };

/** The parent row the schedule's foreign key needs, and nothing more. */
function aWorkflow(name: string): string {
  return workflows.createWorkflow({
    name,
    graph: { nodes: [], edges: [] },
    instanceBudget: {
      maxInstanceCostUSD: 5,
      maxSessionFraction: null,
      maxWeeklyFraction: null,
    },
  }).id;
}

const T0 = Date.UTC(2026, 6, 1, 6, 0);
const HOUR = 3_600_000;

describe("putSchedule", () => {
  it("leaves a paused schedule paused", () => {
    const id = aWorkflow("Nightly");
    schedules.putSchedule(id, DAILY_0900, BERLIN, T0);
    assert.equal(schedules.pauseSchedule(id, true, T0 + HOUR)?.paused, true);

    // The press is "change the recurrence". Resuming is what the Resume button
    // is for, and it goes through `pauseSchedule` so it can re-check
    // `scheduleRefusal` on the way back up; this path checks nothing of the
    // kind, so a resume here starts unattended agents nobody asked for.
    const saved = schedules.putSchedule(id, DAILY_1000, BERLIN, T0 + 2 * HOUR);
    assert.equal(saved.paused, true);
    assert.deepEqual(saved.spec, DAILY_1000);

    // Still resumable through the one control that decides it.
    assert.equal(schedules.pauseSchedule(id, false, T0 + 3 * HOUR)?.paused, false);
  });

  it("still resets the cursor and the last outcome on an edit", () => {
    // The other half, and the half that must not regress: the new recurrence
    // has no history, so reading the old one's cursor would fire it for a
    // window it was never set for — a schedule edited at 09:05 is not owed the
    // 09:00 it never had.
    const id = aWorkflow("Weekly report");
    schedules.putSchedule(id, DAILY_0900, BERLIN, T0);
    dbMod
      .db()
      .prepare(
        `UPDATE workflow_schedules
            SET cursor_at=?, last_code='overlap', last_reason='3 run(s) still live',
                last_at=?, last_fire_at=?, streak=14, streak_since=?
          WHERE workflow_id=?`,
      )
      .run(T0, T0, T0, T0, id);

    const saved = schedules.putSchedule(id, DAILY_1000, BERLIN, T0 + 5 * HOUR);
    assert.equal(saved.cursorAt, T0 + 5 * HOUR);
    assert.equal(saved.lastCode, null);
    assert.equal(saved.lastReason, null);
    assert.equal(saved.streak, 0);
    assert.equal(saved.streakSince, null);
  });

  it("saves a new schedule running, not paused", () => {
    const id = aWorkflow("Hourly sweep");
    const saved = schedules.putSchedule(
      id,
      { kind: "everyHours", hours: 6, anchorAt: T0 },
      BERLIN,
      T0,
    );
    assert.equal(saved.paused, false);
    assert.equal(saved.cursorAt, T0);
  });
});
