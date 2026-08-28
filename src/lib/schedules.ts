import { randomUUID } from "node:crypto";
import { instanceBudgetIsOff, type InstanceBudgetPolicy } from "./budget";
import { db } from "./db";
import { mayWriteDataDir } from "./serverLock";
import { currentSnapshot } from "./orchestrator";
import { newWorkPaused } from "./settings";
import { isTimeZone, zonedParts, zoneOffset } from "./windows";
import {
  getWorkflow,
  liveBlocksOf,
  liveRunsOf,
  startWorkflow,
  type Workflow,
} from "./workflows";

/**
 * When a saved workflow starts itself.
 *
 * **This is the first thing in this app that starts an agent with no person
 * present at all.** The run form, the chat's approval route and a workflow's Run
 * button all have somebody pressing something at the moment the spend begins;
 * a schedule moves that moment to whenever the operator happens not to be
 * looking. Everything below is shaped by that one fact, and the invariant in
 * CLAUDE.md says which properties are load-bearing. In short:
 *
 *   - **Guards still come from what a person wrote.** Nothing here reaches
 *     `--permission-mode`, a budget or an isolation choice. A schedule presses
 *     Run; `startWorkflow` does the rest exactly as it does for a click, so each
 *     block's guards come from its template or from `settings.chatDefaultGuards`
 *     and the instance guard and the instance stop cover a scheduled instance
 *     unchanged.
 *   - **A workflow with no instance budget cannot be scheduled at all.** See
 *     `scheduleRefusal`.
 *   - **A missed window is not made up.** See `decideSchedule` and
 *     `reconcileSchedulesOnBoot`.
 *   - **An overlap is skipped with a reason, and repeated skips are one
 *     state.** See `decideSchedule` and `recordOutcome`.
 *
 * The decision itself — fire, skip, missed, idle — is pure and unit-tested,
 * because both ways of getting it wrong are expensive and neither throws: a
 * schedule that fires twice bills twice, and one that never fires is
 * bit-for-bit what a working schedule looks like on a quiet day.
 */

/* ------------------------------------------------------------------ */
/* The recurrence                                                      */
/* ------------------------------------------------------------------ */

/**
 * How often a workflow starts itself.
 *
 * Three plain choices rather than a cron expression, which is the obvious input
 * and the worst one to hand-write: `0 0 * * 1` and `0 0 1 * *` differ by one
 * character and by a factor of four in how much they spend. Everything here can
 * be rendered back in words by `describeSchedule`, which is the property a cron
 * field would have had to earn before it was worth accepting.
 *
 * `everyHours` is an *interval* and not a wall-clock time: `anchorAt` plus a
 * multiple of N hours, fixed-millisecond arithmetic that no DST change can move.
 * The two wall-clock kinds are read in the schedule's own zone and therefore do
 * shift against UTC twice a year, which is the whole reason the zone is stored.
 */
export type ScheduleSpec =
  | { kind: "everyHours"; hours: number; anchorAt: number }
  | { kind: "daily"; minutes: number }
  | { kind: "weekly"; weekday: number; minutes: number };

/** A week. Longer than this is a date, not a recurrence. */
const MAX_EVERY_HOURS = 168;

const MINUTES_IN_DAY = 24 * 60;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/* ------------------------------------------------------------------ */
/* The stored schedule                                                 */
/* ------------------------------------------------------------------ */

/**
 * What the last fire decision was, as a code the streak can compare.
 *
 * `overlap` and `unbudgeted` and `refused` are all skips and are kept apart
 * because only one of them is benign: an overlap means the previous instance is
 * still working, where the other two mean the schedule will go on doing nothing
 * until somebody edits the workflow.
 */
export type ScheduleOutcomeCode =
  | "started"
  | "overlap"
  | "unbudgeted"
  | "refused"
  | "missed";

export interface WorkflowSchedule {
  id: string;
  workflowId: string;
  spec: ScheduleSpec;
  timeZone: string;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * The last occurrence this schedule has decided about — started, skipped, or
   * recorded as missed. Not the same fact as `lastFireAt`, which is what the
   * page shows: a boot moves this to the instant of the boot without firing
   * anything, and that is what stops a restart making up a missed window.
   */
  cursorAt: number | null;
  lastCode: ScheduleOutcomeCode | null;
  lastReason: string | null;
  lastAt: number | null;
  lastFireAt: number | null;
  lastInstanceId: string | null;
  /** Consecutive outcomes with this same code, collapsed. */
  streak: number;
  streakSince: number | null;
}

/* ------------------------------------------------------------------ */
/* Reading a recurrence out of a form                                  */
/* ------------------------------------------------------------------ */

export type ScheduleNormalization =
  | { ok: true; value: { spec: ScheduleSpec; timeZone: string } }
  | { ok: false; error: string };

/**
 * A schedule from the wire, or a sentence naming what is wrong with it.
 *
 * `now` is an argument rather than read, so this is pure: `everyHours` needs an
 * anchor to be a recurrence at all, and taking it from the clock inside here
 * would make the one kind that has no wall-clock time the one kind that cannot
 * be tested.
 *
 * The zone is **refused** when this build's ICU does not know it, where
 * `/api/usage` falls back to the server's. That divergence is deliberate and is
 * the reason `isTimeZone` was split out: a calendar bucket cut an hour out is a
 * display error in front of the operator, and a schedule an hour out is an hour
 * out for months with nobody watching.
 */
export function normalizeScheduleInput(
  raw: unknown,
  now: number,
): ScheduleNormalization {
  const o = (raw ?? {}) as Record<string, unknown>;

  const timeZone = typeof o.timeZone === "string" ? o.timeZone.trim() : "";
  if (!timeZone) {
    return { ok: false, error: "A schedule needs the timezone its time is in." };
  }
  if (!isTimeZone(timeZone)) {
    return {
      ok: false,
      error:
        `“${timeZone}” is not a timezone this server knows. It has to be an ` +
        "IANA name such as Europe/Berlin — a schedule stored in the wrong zone " +
        "fires an hour out twice a year, with nobody watching.",
    };
  }

  const kind = o.kind;
  if (kind === "everyHours") {
    const hours = Math.trunc(Number(o.hours));
    if (!Number.isFinite(hours) || hours < 1 || hours > MAX_EVERY_HOURS) {
      return {
        ok: false,
        error: `“Every N hours” takes a whole number of hours from 1 to ${MAX_EVERY_HOURS}.`,
      };
    }
    return { ok: true, value: { spec: { kind, hours, anchorAt: now }, timeZone } };
  }

  if (kind === "daily" || kind === "weekly") {
    // The absence is caught **before** any coercion, and that ordering is the
    // whole fix: a cleared `<input type="time">` reaches `save()` as `NaN`, JSON
    // has no NaN so `JSON.stringify` emits `null`, and `Number(null)` is `0` —
    // so the range check below is written against a NaN it can never see, and
    // read a missing time as a deliberate midnight. The schedule then started
    // the graph at 00:00 every day with nobody present. Refused by name the way
    // a missing zone is, and for the reason `planUsage.ts`'s `num()` refuses to
    // coerce: "there is no reading" and "the reading is zero" are different
    // facts. A number is required rather than coerced from a string, because a
    // string is exactly what carries the empty case back in.
    if (typeof o.minutes !== "number") {
      return {
        ok: false,
        error: "A daily or weekly schedule needs the time of day it starts at.",
      };
    }
    const minutes = Math.trunc(o.minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes >= MINUTES_IN_DAY) {
      return { ok: false, error: "The time of day has to be between 00:00 and 23:59." };
    }
    if (kind === "daily") {
      return { ok: true, value: { spec: { kind, minutes }, timeZone } };
    }
    const weekday = Math.trunc(Number(o.weekday));
    if (!Number.isFinite(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, error: "The day of the week has to be Sunday through Saturday." };
    }
    return { ok: true, value: { spec: { kind, weekday, minutes }, timeZone } };
  }

  return {
    ok: false,
    error: "A schedule is every N hours, daily at a time, or weekly on a day.",
  };
}

/** `540` → `"09:00"`. */
function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The recurrence in words, zone included.
 *
 * On the page beside the next fire time rather than instead of it: the words
 * say what the rule is and the instant says what the rule *means*, and an
 * operator leaving an unattended agent switched on needs to check the second.
 */
export function describeSchedule(spec: ScheduleSpec, timeZone: string): string {
  switch (spec.kind) {
    case "everyHours":
      return spec.hours === 1
        ? "Every hour"
        : `Every ${spec.hours} hours`;
    case "daily":
      return `Every day at ${hhmm(spec.minutes)} (${timeZone})`;
    case "weekly":
      return `Every ${WEEKDAYS[spec.weekday]} at ${hhmm(spec.minutes)} (${timeZone})`;
  }
}

/* ------------------------------------------------------------------ */
/* When it fires                                                       */
/* ------------------------------------------------------------------ */

/**
 * Epoch ms of a wall-clock time on a calendar date in `timeZone`.
 *
 * The same two-pass solve `zonedMidnight` uses, and for the same reason: the
 * offset depends on the instant being solved for, so the first guess reads it at
 * the same wall time in UTC and the second reads it at the instant that guess
 * produced.
 *
 * On a spring-forward day the nominal time may not exist — 02:30 in
 * Europe/Berlin on the day the clocks go from 02:00 to 03:00 — and this lands
 * an hour to one side of it, at 03:30 local. That is the answer a schedule
 * wants: the occurrence still happens, once, within an hour of the time asked
 * for, and it is still strictly between the day before's and the day after's.
 * Returning nothing would silently skip a day once a year, which is the failure
 * that looks exactly like a schedule that works.
 *
 * Which side of the gap the second pass lands on is *not* a property of the
 * solve, though — it depends on where the nominal time sits in UTC relative to
 * the transition instant, so it goes forward in Berlin (whose clocks move at
 * 01:00Z, already behind a 02:30 nominal) and backward in a zone that moves them
 * at local midnight (America/Santiago, America/Havana), where it lands on the
 * *previous local date*: one local day with no occurrence, the day before it
 * with two, and a weekly schedule firing on Saturday under the words "Every
 * Sunday". So the date is checked rather than assumed. Both candidates are in
 * hand already; the second pass is kept unless it has fallen off the day that
 * was asked for and the first pass is still on it, which is the only case where
 * the two disagree about the calendar. In Berlin both are on the requested day —
 * 01:30 and 03:30 — and the second is the one at-or-after the nominal time.
 */
function zonedTime(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day) + minutes * 60_000;
  const first = wall - zoneOffset(wall, timeZone);
  const second = wall - zoneOffset(first, timeZone);
  if (second === first) return second;

  const onRequestedDate = (at: number) => {
    const p = zonedParts(at, timeZone);
    return p.year === year && p.month === month && p.day === day;
  };
  if (!onRequestedDate(second) && onRequestedDate(first)) return first;
  return second;
}

/**
 * How many local days forward `nextOccurrence` will look.
 *
 * Daily needs 2 and weekly 8; the rest is headroom, and hitting it at all means
 * the zone arithmetic has stopped being monotonic, which is a throw rather than
 * a shrug — a schedule that quietly returns the wrong instant is the expensive
 * half of this module's two failure modes.
 */
const MAX_DAYS_AHEAD = 15;

/** The first instant this schedule fires *strictly after* `after`. */
export function nextOccurrence(
  spec: ScheduleSpec,
  timeZone: string,
  after: number,
): number {
  if (spec.kind === "everyHours") {
    const step = spec.hours * 3_600_000;
    // Strictly after, so an occurrence landing exactly on `after` is the one
    // just acted on rather than the next one — which is what stops a fire from
    // being decided twice.
    const steps = Math.floor((after - spec.anchorAt) / step) + 1;
    return spec.anchorAt + steps * step;
  }

  const from = zonedParts(after, timeZone);
  for (let i = 0; i < MAX_DAYS_AHEAD; i++) {
    // Walked as a UTC calendar date, which is only ever used to name a local
    // day: `zonedTime` resolves it back into the zone, so the offset never
    // enters this arithmetic.
    const day = new Date(Date.UTC(from.year, from.month - 1, from.day + i));
    if (spec.kind === "weekly" && day.getUTCDay() !== spec.weekday) continue;
    const at = zonedTime(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      spec.minutes,
      timeZone,
    );
    if (at > after) return at;
  }
  throw new Error(
    `No occurrence of ${describeSchedule(spec, timeZone)} within ` +
      `${MAX_DAYS_AHEAD} days of ${new Date(after).toISOString()}.`,
  );
}

/* ------------------------------------------------------------------ */
/* The decision                                                        */
/* ------------------------------------------------------------------ */

/**
 * How late a fire time may be honoured.
 *
 * This covers a tick that ran late — a slow transcript scan, a busy event
 * loop — and nothing else. It is deliberately far shorter than the shortest
 * recurrence this app accepts (one hour), so it can never honour a window that
 * a later one has already superseded, and `reconcileSchedulesOnBoot` moves the
 * cursor past everything before the boot so it can never make a restart into a
 * catch-up.
 */
export const FIRE_GRACE_MS = 2 * 60_000;

/**
 * The most occurrences one decision will enumerate.
 *
 * A safety valve rather than a routine path: a boot resets the cursor, so the
 * gap a live tick sees is one tick. Hitting it costs nothing but a second pass —
 * the cursor advances to the last one enumerated and the next tick continues —
 * and consecutive `missed` records collapse into one streak either way.
 */
const MAX_CATCHUP = 500;

export type ScheduleAction =
  | { kind: "paused" }
  | { kind: "idle" }
  | { kind: "fire"; fireAt: number }
  | { kind: "skip"; fireAt: number; code: "overlap"; reason: string };

export interface ScheduleDecision {
  /** What to do about this instant. */
  action: ScheduleAction;
  /**
   * Fire times passed over without firing, oldest first. Recorded, never made
   * up: a server coming back up must not start unattended agents because of
   * something that should have happened hours ago, which is the rule a queued
   * run and a queued merge already follow from their own directions.
   */
  missed: number[];
  /** Where the cursor stands after this decision; unchanged when nothing did. */
  cursorAt: number | null;
  /** The instant this schedule fires next, given everything above. */
  nextFireAt: number;
}

export interface ScheduleContext {
  spec: ScheduleSpec;
  timeZone: string;
  paused: boolean;
  /** `WorkflowSchedule.cursorAt`. */
  lastFireAt: number | null;
  /** Runs and blocks of this workflow that have not finished. */
  liveCount: number;
  now: number;
}

/**
 * Fire, skip, missed or nothing — and why.
 *
 * Pure, and the only place the four answers are decided. Both failure modes are
 * silent: firing a window twice bills twice, and never firing is what a working
 * schedule looks like between occurrences.
 *
 * The overlap answer is a **skip with a reason** rather than a retry, because
 * `startWorkflow` already refuses a second instance while the first still has
 * live members and a schedule that fired into that refusal every hour would be
 * fifty identical failures in the record. The next occurrence is the next
 * chance; nothing is queued, because a queued press of Run is a press of Run
 * nobody is present for by the time it happens.
 */
export function decideSchedule(ctx: ScheduleContext): ScheduleDecision {
  const { spec, timeZone, now } = ctx;

  if (ctx.paused) {
    return {
      action: { kind: "paused" },
      missed: [],
      cursorAt: ctx.lastFireAt,
      // Still answered, so the page can say what resuming would mean.
      nextFireAt: nextOccurrence(spec, timeZone, now),
    };
  }

  // No cursor is no history to reason about, so nothing is due and nothing was
  // missed — the schedule starts from here. Reachable only for a row written
  // before the cursor was set; `putSchedule` stamps it at creation precisely so
  // a schedule saved at 09:05 does not immediately fire a 09:00 daily.
  if (ctx.lastFireAt === null) {
    return {
      action: { kind: "idle" },
      missed: [],
      cursorAt: null,
      nextFireAt: nextOccurrence(spec, timeZone, now),
    };
  }

  const passed: number[] = [];
  let at = nextOccurrence(spec, timeZone, ctx.lastFireAt);
  while (at <= now && passed.length < MAX_CATCHUP) {
    passed.push(at);
    at = nextOccurrence(spec, timeZone, at);
  }

  if (passed.length === 0) {
    return {
      action: { kind: "idle" },
      missed: [],
      cursorAt: ctx.lastFireAt,
      nextFireAt: at,
    };
  }

  const newest = passed[passed.length - 1];
  const older = passed.slice(0, -1);

  // Only the newest window is still this window, and only for the grace. Older
  // ones are recorded and left alone — the point of the whole cursor.
  if (now - newest > FIRE_GRACE_MS) {
    return { action: { kind: "idle" }, missed: passed, cursorAt: newest, nextFireAt: at };
  }

  if (ctx.liveCount > 0) {
    return {
      action: {
        kind: "skip",
        fireAt: newest,
        code: "overlap",
        reason:
          `${ctx.liveCount} run(s) and block(s) from an earlier press of Run ` +
          "have not finished. Skipped rather than queued — the next occurrence " +
          "is the next chance.",
      },
      missed: older,
      cursorAt: newest,
      nextFireAt: at,
    };
  }

  return {
    action: { kind: "fire", fireAt: newest },
    missed: older,
    cursorAt: newest,
    nextFireAt: at,
  };
}

/* ------------------------------------------------------------------ */
/* What may be scheduled                                               */
/* ------------------------------------------------------------------ */

/**
 * Why this workflow may not be scheduled, or null.
 *
 * **A workflow whose instance budget sets nothing is refused**, and the choice
 * between refusing, warning and allowing is the one worth defending here.
 *
 * The precedent is an orchestrator block's fan-out cap, which
 * `normalizeWorkflowInput` refuses to leave null for a reason stated in exactly
 * these terms: it is the one block whose runs start with nobody looking, so a
 * missing ceiling is an unbounded number of billed agents from one press of Run.
 * A schedule is that argument one level up. Every other press of Run is bounded
 * by a person being there to see what it cost and decide whether to press it
 * again; a schedule removes the person and keeps the press.
 *
 * Warning was the alternative and it fails on what it would be warning about: a
 * banner is read once, when the schedule is created, and the spend it is about
 * happens every hour for the next month. Allowing fails harder — the app's
 * standing rule is that a guard with nothing behind it is refused rather than
 * ignored, because silently passing leaves the operator believing a guard is
 * active.
 *
 * Any one of the three limits is enough. `maxInstanceCostUSD` bounds one press;
 * the two window fractions are the ones that bound *repetition*, since an
 * instance that would start into an already-spent window is refused at
 * `startWorkflow`'s door — which is why this asks `instanceBudgetIsOff` rather
 * than asking for a cost limit by name.
 *
 * Checked at creation, where there is an error channel and a person, and again
 * at every fire, because clearing the budget on the workflow afterwards is one
 * edit away and nothing about that edit knows a schedule exists.
 */
export function scheduleRefusal(workflow: {
  name: string;
  instanceBudget: InstanceBudgetPolicy;
}): string | null {
  if (!instanceBudgetIsOff(workflow.instanceBudget)) return null;
  return (
    `“${workflow.name}” sets no limit for a whole press of Run, and a schedule ` +
    "presses Run with nobody there to see what it cost. Set a spending limit " +
    "or a window guard under “Limits for the whole workflow” first."
  );
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

interface ScheduleRow {
  id: string;
  workflow_id: string;
  spec: string;
  time_zone: string;
  paused: number;
  created_at: number;
  updated_at: number;
  cursor_at: number | null;
  last_code: string | null;
  last_reason: string | null;
  last_at: number | null;
  last_fire_at: number | null;
  last_instance_id: string | null;
  streak: number;
  streak_since: number | null;
}

const SCHEDULE_COLUMNS =
  "id, workflow_id, spec, time_zone, paused, created_at, updated_at," +
  " cursor_at, last_code, last_reason, last_at, last_fire_at," +
  " last_instance_id, streak, streak_since";

function rowToSchedule(row: ScheduleRow): WorkflowSchedule {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    spec: JSON.parse(row.spec) as ScheduleSpec,
    timeZone: row.time_zone,
    paused: row.paused === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cursorAt: row.cursor_at,
    lastCode: row.last_code as ScheduleOutcomeCode | null,
    lastReason: row.last_reason,
    lastAt: row.last_at,
    lastFireAt: row.last_fire_at,
    lastInstanceId: row.last_instance_id,
    streak: row.streak,
    streakSince: row.streak_since,
  };
}

export function getSchedule(workflowId: string): WorkflowSchedule | null {
  const row = db()
    .prepare(
      `SELECT ${SCHEDULE_COLUMNS} FROM workflow_schedules WHERE workflow_id = ?`,
    )
    .get(workflowId) as ScheduleRow | undefined;
  return row ? rowToSchedule(row) : null;
}

/**
 * Save the one schedule this workflow has, replacing whatever was there.
 *
 * The cursor is stamped at `now`, which is what makes "a schedule saved at 09:05
 * does not fire the 09:00 daily it just missed" true rather than a coincidence
 * of when the first tick lands. Editing a schedule resets it for the same
 * reason: the new recurrence has no history, and reading the old one's cursor
 * would fire the new one for a window it was never set for.
 *
 * `paused` is deliberately **not** in the UPDATE. This press means "change the
 * recurrence"; switching the schedule back on is what the Resume button is for,
 * and that goes through `pauseSchedule` — the one path that re-checks
 * `scheduleRefusal` on the way back up. Clearing the flag here restarted the
 * only thing in this app that starts a billed agent with nobody present, as a
 * side effect of a form that never asked: `normalizeScheduleInput` has no
 * `paused` field precisely because it is not the form's to decide, so the SQL
 * was deciding it alone. An edit that arrives while paused stays paused, and
 * `startScheduler` below then finds nothing active and holds no timer.
 */
export function putSchedule(
  workflowId: string,
  spec: ScheduleSpec,
  timeZone: string,
  now = Date.now(),
): WorkflowSchedule {
  const existing = getSchedule(workflowId);
  if (existing) {
    db()
      .prepare(
        `UPDATE workflow_schedules
            SET spec=?, time_zone=?, updated_at=?, cursor_at=?,
                last_code=NULL, last_reason=NULL, last_at=NULL,
                last_fire_at=NULL, last_instance_id=NULL,
                streak=0, streak_since=NULL
          WHERE workflow_id=?`,
      )
      .run(JSON.stringify(spec), timeZone, now, now, workflowId);
  } else {
    db()
      .prepare(
        `INSERT INTO workflow_schedules
           (id, workflow_id, spec, time_zone, paused, created_at, updated_at,
            cursor_at, streak)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0)`,
      )
      .run(randomUUID(), workflowId, JSON.stringify(spec), timeZone, now, now, now);
  }
  startScheduler();
  return getSchedule(workflowId)!;
}

/**
 * Pause or resume.
 *
 * Resuming moves the cursor to now, so the time spent paused leaves no missed
 * records behind: a schedule that was switched off did not miss anything, and a
 * page reporting a week of missed windows for a week somebody deliberately
 * turned it off would say the wrong thing about the one number that matters.
 */
export function pauseSchedule(
  workflowId: string,
  paused: boolean,
  now = Date.now(),
): WorkflowSchedule | null {
  const changed = db()
    .prepare(
      `UPDATE workflow_schedules
          SET paused=?, updated_at=?, cursor_at=CASE WHEN ? THEN cursor_at ELSE ? END
        WHERE workflow_id=?`,
    )
    .run(paused ? 1 : 0, now, paused ? 1 : 0, now, workflowId);
  if (changed.changes === 0) return null;
  if (!paused) startScheduler();
  return getSchedule(workflowId);
}

export function deleteSchedule(workflowId: string): boolean {
  return (
    db()
      .prepare("DELETE FROM workflow_schedules WHERE workflow_id = ?")
      .run(workflowId).changes > 0
  );
}

function activeSchedules(): WorkflowSchedule[] {
  const rows = db()
    .prepare(
      `SELECT ${SCHEDULE_COLUMNS} FROM workflow_schedules
        WHERE paused = 0 ORDER BY created_at`,
    )
    .all() as ScheduleRow[];
  return rows.map(rowToSchedule);
}

function setCursor(id: string, at: number): void {
  db()
    .prepare("UPDATE workflow_schedules SET cursor_at=? WHERE id=?")
    .run(at, id);
}

/**
 * Record what a fire decision came to, collapsing a repeat into one state.
 *
 * The streak keys on the *code* and not on the sentence, which is what makes it
 * collapse the case it exists for: an hourly schedule firing into a workflow
 * whose previous instance never finishes produces a reason whose run count moves
 * every hour, and a streak that broke on that would be the fifty identical rows
 * again with a counter stuck at one.
 */
function recordOutcome(
  schedule: WorkflowSchedule,
  code: ScheduleOutcomeCode,
  reason: string | null,
  fireAt: number,
  instanceId: string | null,
  now: number,
): void {
  const continues = schedule.lastCode === code;
  db()
    .prepare(
      `UPDATE workflow_schedules
          SET last_code=?, last_reason=?, last_at=?, last_fire_at=?,
              last_instance_id=?, streak=?, streak_since=?
        WHERE id=?`,
    )
    .run(
      code,
      reason,
      now,
      fireAt,
      instanceId,
      continues ? schedule.streak + 1 : 1,
      continues ? (schedule.streakSince ?? now) : now,
      schedule.id,
    );
  // The caller may record twice in one tick (missed, then what happened to the
  // newest window), and the second record has to see what the first wrote.
  schedule.lastCode = code;
  schedule.streak = continues ? schedule.streak + 1 : 1;
  schedule.streakSince = continues ? (schedule.streakSince ?? now) : now;
}

function missedSentence(missed: number[], timeZone: string): string {
  const last = missed[missed.length - 1];
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(last));
  return missed.length === 1
    ? `Missed the occurrence at ${when} (${timeZone}). Not started late — a ` +
        "server coming back up does not press Run for a window that has passed."
    : `Missed ${missed.length} occurrences, the last at ${when} (${timeZone}). ` +
        "None of them was started late.";
}

/* ------------------------------------------------------------------ */
/* The timer                                                           */
/* ------------------------------------------------------------------ */

/**
 * How often the schedules are looked at.
 *
 * Cheap: one indexed read of a table with one row per scheduled workflow, and
 * `currentSnapshot()` — the expensive part — only on a tick that actually
 * fires. Faster than `sweepPaused`'s minute because a fire time an operator
 * verified on the page should not be visibly late, and slower than a second
 * because nothing here is watching anything that moves.
 */
const SCHEDULE_TICK_MS = 30_000;

/**
 * One timer per process, `globalThis`-pinned like the other long-lived state,
 * or dev's hot reload silently gives every request its own.
 *
 * Lazily started and stopped when there is nothing to do, the shape
 * `sweepPaused` already has: an install with no schedules holds no interval.
 */
const timer = ((
  globalThis as unknown as {
    __ufScheduleTimer?: { tick: NodeJS.Timeout | null; running: boolean };
  }
).__ufScheduleTimer ??= { tick: null, running: false });

export function startScheduler(): void {
  if (timer.tick) return;
  if (activeSchedules().length === 0) return;
  timer.tick = setInterval(() => void tickSchedules(), SCHEDULE_TICK_MS);
  timer.tick.unref?.();
}

function stopScheduler(): void {
  if (!timer.tick) return;
  clearInterval(timer.tick);
  timer.tick = null;
}

/**
 * Exported for its test and for nothing else — no other module calls it.
 *
 * It is the one of the four creation routes with no seam a caller can reach:
 * the other three are decided by a pure function a test can hand a flag to,
 * where this one reads the hold itself, inside a timer. A route that quietly
 * stopped consulting it would look exactly like a quiet hour.
 */
export async function tickSchedules(): Promise<void> {
  // Asked here rather than only at the boot that started this timer, because
  // ownership moves: a server that stalls past `STALE_MS` loses the directory
  // to a second process, and the two would then press Run for the same window.
  // The timer stops rather than skipping a tick — the schedules belong to
  // whoever owns the directory, and this process will never own it again.
  if (!mayWriteDataDir()) {
    stopScheduler();
    return;
  }

  // A tick that spawns a graph takes longer than the interval; stacking them
  // would press Run twice for one window.
  if (timer.running) return;
  timer.running = true;
  try {
    const active = activeSchedules();
    if (active.length === 0) {
      stopScheduler();
      return;
    }
    const now = Date.now();
    for (const schedule of active) {
      try {
        await fireIfDue(schedule, now);
      } catch (err) {
        // Loud rather than swallowed: this is the only surface the operator
        // has, and a schedule that has quietly stopped deciding looks exactly
        // like one that is between occurrences.
        recordOutcome(
          schedule,
          "refused",
          err instanceof Error ? err.message : String(err),
          now,
          null,
          now,
        );
      }
    }
  } catch (err) {
    // Reading the table, or writing the record above, failed. Caught rather
    // than left to propagate because this runs as `void tickSchedules()`: a
    // throw out of it is an unhandled rejection, and Node ends the process on
    // one — taking the server and every run in flight with it, which is a far
    // worse outcome than a tick that did nothing. The next tick retries.
    console.error("[usagefoundry] Schedule tick failed:", err);
  } finally {
    timer.running = false;
  }
}

/**
 * One schedule's turn.
 *
 * The cursor is advanced **before** the snapshot is awaited, so a tick that
 * overruns cannot decide the same window twice. The cost is that a process dying
 * between the two loses that window with nothing recorded — the safe direction,
 * and the same one `reconcileSchedulesOnBoot` takes.
 */
async function fireIfDue(schedule: WorkflowSchedule, now: number): Promise<void> {
  const workflow = getWorkflow(schedule.workflowId);
  // Deleting a workflow cascade-deletes its schedule, so this is a row a
  // concurrent delete removed between the read and here. Nothing to say.
  if (!workflow) return;

  const decision = decideSchedule({
    spec: schedule.spec,
    timeZone: schedule.timeZone,
    // The install-wide hold reaches this route through the argument that
    // already means "do not fire, and do not make the window up afterwards" —
    // the cursor stays put, so clearing the hold records the windows that
    // passed as missed rather than pressing Run for each of them. A schedule's
    // own pause never gets here: `activeSchedules` filters those out in SQL.
    paused: newWorkPaused(),
    lastFireAt: schedule.cursorAt,
    liveCount:
      liveRunsOf(schedule.workflowId).length + liveBlocksOf(schedule.workflowId),
    now,
  });

  if (decision.missed.length > 0) {
    recordOutcome(
      schedule,
      "missed",
      missedSentence(decision.missed, schedule.timeZone),
      decision.missed[decision.missed.length - 1],
      null,
      now,
    );
  }
  if (decision.cursorAt !== null && decision.cursorAt !== schedule.cursorAt) {
    setCursor(schedule.id, decision.cursorAt);
  }

  const action = decision.action;
  if (action.kind === "skip") {
    recordOutcome(schedule, action.code, action.reason, action.fireAt, null, now);
    return;
  }
  if (action.kind !== "fire") return;

  // Re-checked at every fire rather than only at creation: clearing the
  // workflow's own limits is one edit away, and nothing about that edit knows a
  // schedule exists.
  const refusal = scheduleRefusal(workflow);
  if (refusal) {
    recordOutcome(schedule, "unbudgeted", refusal, action.fireAt, null, now);
    return;
  }

  // Named as the schedule's, so the runs this fire creates are distinguishable
  // from the same graph started by hand. This is the one press of Run with
  // nobody present at all, which is exactly the case an audit column exists for.
  const outcome = startWorkflow(schedule.workflowId, await currentSnapshot(), {
    kind: "schedule",
    scheduleId: schedule.id,
  });
  if (!outcome.ok) {
    recordOutcome(schedule, "refused", outcome.reason, action.fireAt, null, now);
    return;
  }
  recordOutcome(schedule, "started", null, action.fireAt, outcome.instance.id, now);
}

/**
 * Close out every window that passed while this process was not running, and
 * start nothing.
 *
 * This is the queued-run rule and the queued-merge rule arrived at from a third
 * direction: a server coming back up must not start unattended agents because of
 * something that should have happened hours ago. The cursor jumps to the boot
 * instant whatever it finds, so the grace in `decideSchedule` can only ever
 * cover a late tick and never a restart.
 *
 * Gated on the data-directory claim by its caller, exactly as the other
 * reconcilers are: a second server process firing the same schedules would press
 * Run twice for one window, and the row it read says nothing about whose it is.
 */
export function reconcileSchedulesOnBoot(now = Date.now()): void {
  for (const schedule of activeSchedules()) {
    let decision: ScheduleDecision;
    try {
      decision = decideSchedule({
        spec: schedule.spec,
        timeZone: schedule.timeZone,
        paused: false,
        lastFireAt: schedule.cursorAt,
        liveCount: 0,
        now,
      });
    } catch {
      // An unreadable spec must not stop the boot; the tick will record it.
      continue;
    }
    const action = decision.action;
    const passed =
      action.kind === "fire" || action.kind === "skip"
        ? [...decision.missed, action.fireAt]
        : decision.missed;
    if (passed.length > 0) {
      recordOutcome(
        schedule,
        "missed",
        missedSentence(passed, schedule.timeZone),
        passed[passed.length - 1],
        null,
        now,
      );
    }
    setCursor(schedule.id, now);
  }
  startScheduler();
}

/* ------------------------------------------------------------------ */
/* For the page                                                        */
/* ------------------------------------------------------------------ */

export interface ScheduleView extends WorkflowSchedule {
  /** The recurrence in words. */
  description: string;
  /**
   * The absolute instant it fires next. Answered while paused too, because
   * "what would resuming this mean" is the question the pause control raises.
   *
   * Null only when it cannot be worked out at all — which in practice means
   * this build's ICU has stopped recognising a zone `normalizeScheduleInput`
   * accepted, a base image away. Null rather than a plausible number, the same
   * rule a window with no ceiling follows: a schedule whose next fire is
   * unknown must not display an instant.
   */
  nextFireAt: number | null;
  /** Why this schedule cannot fire as things stand, or null. */
  refusal: string | null;
}

export function scheduleView(
  schedule: WorkflowSchedule,
  workflow: Workflow,
  now = Date.now(),
): ScheduleView {
  let nextFireAt: number | null = null;
  let unreadable: string | null = null;
  try {
    // From `now` rather than from the cursor: a paused schedule's cursor is as
    // old as the pause, and a "next fire" in the past is not a next fire.
    nextFireAt = nextOccurrence(
      schedule.spec,
      schedule.timeZone,
      Math.max(now, schedule.cursorAt ?? now),
    );
  } catch (err) {
    // Reported rather than thrown: this is read by the workflows list, and a
    // 500 there would leave the operator unable to open the page the Remove
    // button is on.
    unreadable = `This schedule's next start cannot be worked out: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  return {
    ...schedule,
    description: describeSchedule(schedule.spec, schedule.timeZone),
    nextFireAt,
    refusal: unreadable ?? scheduleRefusal(workflow),
  };
}
