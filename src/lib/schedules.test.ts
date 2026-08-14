import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideSchedule,
  describeSchedule,
  FIRE_GRACE_MS,
  nextOccurrence,
  normalizeScheduleInput,
  scheduleRefusal,
  type ScheduleContext,
  type ScheduleSpec,
} from "./schedules";

/**
 * The decision a schedule makes, and only that.
 *
 * It clears the same bar every other test here does — a pure function whose
 * failure modes are silent and expensive — and it clears it from both sides at
 * once, which is unusual. A schedule that fires a window twice bills twice, with
 * nobody present to notice; a schedule that never fires is bit-for-bit what a
 * working schedule looks like between occurrences, so the failure is invisible
 * until somebody asks why last week's work never happened.
 *
 * The zone cases are here for a third reason: the container runs in UTC and the
 * operator does not, so every wall-clock instant this computes is computed in a
 * zone the server is not in, and the two days a year that arithmetic is hard are
 * the two days nothing else in the app would catch.
 */

const BERLIN = "Europe/Berlin";
/** Two zones whose spring-forward transition lands at local midnight. */
const SANTIAGO = "America/Santiago";
const HAVANA = "America/Havana";

/** Everything a context needs but the parts a case is actually about. */
function ctx(over: Partial<ScheduleContext> & { spec: ScheduleSpec }): ScheduleContext {
  return {
    timeZone: BERLIN,
    paused: false,
    lastFireAt: null,
    liveCount: 0,
    now: 0,
    ...over,
  };
}

const DAILY_0230: ScheduleSpec = { kind: "daily", minutes: 150 };
const DAILY_0900: ScheduleSpec = { kind: "daily", minutes: 540 };
const MIDNIGHT: ScheduleSpec = { kind: "daily", minutes: 0 };
const DAILY_0030: ScheduleSpec = { kind: "daily", minutes: 30 };
const SUNDAY_MIDNIGHT: ScheduleSpec = { kind: "weekly", weekday: 0, minutes: 0 };

/** 09:00 Berlin is 07:00Z in summer. */
const JUL_1_0900 = Date.UTC(2026, 6, 1, 7, 0);
const JUL_2_0900 = Date.UTC(2026, 6, 2, 7, 0);

describe("nextOccurrence", () => {
  it("reads a daily time in the schedule's zone, not the server's", () => {
    // Berlin is UTC+2 on this date, so 09:00 local is 07:00Z. A schedule stored
    // in the server's zone would answer 09:00Z, which is two hours out — and
    // one hour out for half the year, which is the version that hides.
    assert.equal(
      nextOccurrence(DAILY_0900, BERLIN, Date.UTC(2026, 6, 1, 6, 0)),
      JUL_1_0900,
    );
    // Strictly after: the occurrence just acted on is not the next one, which
    // is what stops one window being decided twice.
    assert.equal(nextOccurrence(DAILY_0900, BERLIN, JUL_1_0900), JUL_2_0900);
  });

  it("puts a weekly occurrence on the named weekday", () => {
    // 2026-07-01 is a Wednesday; the next Monday is the 6th.
    const monday: ScheduleSpec = { kind: "weekly", weekday: 1, minutes: 540 };
    const at = nextOccurrence(monday, BERLIN, JUL_1_0900);
    assert.equal(at, Date.UTC(2026, 6, 6, 7, 0));
    assert.equal(nextOccurrence(monday, BERLIN, at), Date.UTC(2026, 6, 13, 7, 0));
  });

  it("steps every-N-hours off its anchor", () => {
    const spec: ScheduleSpec = { kind: "everyHours", hours: 6, anchorAt: 1_000 };
    assert.equal(nextOccurrence(spec, BERLIN, 1_000), 1_000 + 6 * 3_600_000);
    assert.equal(nextOccurrence(spec, BERLIN, 1_001), 1_000 + 6 * 3_600_000);
    assert.equal(
      nextOccurrence(spec, BERLIN, 1_000 + 6 * 3_600_000),
      1_000 + 12 * 3_600_000,
    );
  });
});

describe("nextOccurrence across a DST boundary", () => {
  /** Every occurrence in `[from, to)`, walked the way the tick walks it. */
  function walk(
    spec: ScheduleSpec,
    zone: string,
    from: number,
    to: number,
  ): number[] {
    const out: number[] = [];
    let at = nextOccurrence(spec, zone, from);
    while (at < to) {
      out.push(at);
      at = nextOccurrence(spec, zone, at);
    }
    return out;
  }

  /**
   * The weekday is in here rather than left implicit because the calendar half
   * of the invariant is the half that broke: an instant an hour to one side of
   * the time asked for is the answer a schedule wants, and the *previous local
   * date* is not — which on a weekly schedule reads as Saturday under the words
   * "Every Sunday".
   */
  function localOf(ts: number, zone: string): string {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  }

  /** The local calendar date alone, for "exactly one occurrence a day". */
  function localDateOf(ts: number, zone: string): string {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ts));
  }

  /** Strictly increasing, and no local date fired on twice. */
  function assertOnePerLocalDay(days: number[], zone: string): void {
    for (let i = 1; i < days.length; i++) assert.ok(days[i] > days[i - 1]);
    const dates = days.map((ts) => localDateOf(ts, zone));
    assert.equal(new Set(dates).size, dates.length);
  }

  it("fires 02:30 once a day through the spring-forward gap", () => {
    // Berlin goes 02:00 → 03:00 on 2026-03-29, so local 02:30 does not exist
    // that day. The two-pass solve lands an hour to one side of the gap, which
    // is the answer a schedule wants: the day still gets exactly one
    // occurrence, within an hour of the time asked for, still strictly between
    // its neighbours. Returning nothing would silently skip a day once a year —
    // a schedule that stops for a day and starts again is indistinguishable
    // from one that works.
    const days = walk(
      DAILY_0230,
      BERLIN,
      Date.UTC(2026, 2, 27, 0, 0),
      Date.UTC(2026, 3, 1, 0, 0),
    );
    assert.deepEqual(
      days.map((ts) => localOf(ts, BERLIN)),
      [
        "Fri, 27/03/2026, 02:30",
        "Sat, 28/03/2026, 02:30",
        "Sun, 29/03/2026, 03:30",
        "Mon, 30/03/2026, 02:30",
        "Tue, 31/03/2026, 02:30",
      ],
    );
    assertOnePerLocalDay(days, BERLIN);
    // The gap day is 23 hours after its predecessor, not 24 — the clocks moved,
    // and the schedule moved with them rather than drifting against UTC.
    assert.equal(days[2] - days[1], 24 * 3_600_000);
    assert.equal(days[3] - days[2], 23 * 3_600_000);
  });

  it("fires 02:30 once on the day it happens twice", () => {
    // Berlin goes 03:00 → 02:00 on 2026-10-25, so local 02:30 comes round
    // twice. Firing on both would bill a whole graph twice, unattended.
    const days = walk(
      DAILY_0230,
      BERLIN,
      Date.UTC(2026, 9, 23, 0, 0),
      Date.UTC(2026, 9, 28, 0, 0),
    );
    assert.deepEqual(
      days.map((ts) => localOf(ts, BERLIN)),
      [
        "Fri, 23/10/2026, 02:30",
        "Sat, 24/10/2026, 02:30",
        "Sun, 25/10/2026, 02:30",
        "Mon, 26/10/2026, 02:30",
        "Tue, 27/10/2026, 02:30",
      ],
    );
    assert.equal(new Set(days).size, days.length);
    assert.equal(days[2] - days[1], 25 * 3_600_000);
  });

  it("keeps a midnight occurrence on the local day it was asked for", () => {
    // Santiago goes 04/09/2027 23:59 → 05/09/2027 01:00, so local midnight on
    // the 5th does not exist at all. Berlin's gap sits in the middle of the
    // local day, so both instants the two-pass solve can produce are on the
    // date asked for and either one is defensible; here the earlier of them is
    // on the *previous* date, which is a day with no occurrence and a day
    // before it with two — and a schedule that stops for a day is
    // indistinguishable from one that works.
    const days = walk(
      MIDNIGHT,
      SANTIAGO,
      Date.UTC(2027, 8, 2, 0, 0),
      Date.UTC(2027, 8, 8, 0, 0),
    );
    assert.deepEqual(
      days.map((ts) => localOf(ts, SANTIAGO)),
      [
        "Thu, 02/09/2027, 00:00",
        "Fri, 03/09/2027, 00:00",
        "Sat, 04/09/2027, 00:00",
        "Sun, 05/09/2027, 01:00",
        "Mon, 06/09/2027, 00:00",
        "Tue, 07/09/2027, 00:00",
      ],
    );
    assertOnePerLocalDay(days, SANTIAGO);
  });

  it("keeps a midnight occurrence on its own day in Havana too", () => {
    // The same shape in the other hemisphere's spring: 13/03/2027 23:59 →
    // 14/03/2027 01:00. Two zones rather than one because the fault is not a
    // property of a zone — it is where the nominal time happens to sit in UTC
    // relative to the transition instant, which is why Berlin was fine.
    const days = walk(
      MIDNIGHT,
      HAVANA,
      Date.UTC(2027, 2, 11, 0, 0),
      Date.UTC(2027, 2, 17, 0, 0),
    );
    assert.deepEqual(
      days.map((ts) => localOf(ts, HAVANA)),
      [
        "Thu, 11/03/2027, 00:00",
        "Fri, 12/03/2027, 00:00",
        "Sat, 13/03/2027, 00:00",
        "Sun, 14/03/2027, 01:00",
        "Mon, 15/03/2027, 00:00",
        "Tue, 16/03/2027, 00:00",
      ],
    );
    assertOnePerLocalDay(days, HAVANA);
  });

  it("keeps 00:30 on its own day when midnight is the skipped hour", () => {
    // Anywhere inside the skipped hour, not only at its first minute: 00:30 on
    // the 5th does not exist either, and lands at 01:30 — within an hour of the
    // time asked for, on the date asked for. 01:00 was already correct before
    // this, which is what bounds the fault to the gap itself.
    const days = walk(
      DAILY_0030,
      SANTIAGO,
      Date.UTC(2027, 8, 2, 0, 0),
      Date.UTC(2027, 8, 8, 0, 0),
    );
    assert.deepEqual(
      days.map((ts) => localOf(ts, SANTIAGO)),
      [
        "Thu, 02/09/2027, 00:30",
        "Fri, 03/09/2027, 00:30",
        "Sat, 04/09/2027, 00:30",
        "Sun, 05/09/2027, 01:30",
        "Mon, 06/09/2027, 00:30",
        "Tue, 07/09/2027, 00:30",
      ],
    );
    assertOnePerLocalDay(days, SANTIAGO);
  });

  it("fires a weekly Sunday schedule on Sunday through the gap", () => {
    // The sharp one: `describeSchedule` renders this as "Every Sunday at
    // 00:00", and an occurrence pushed onto the previous local date is a fire
    // on Saturday under those words — a whole graph of unattended agents on the
    // wrong day, with the page still saying Sunday.
    for (const [zone, from, to] of [
      [SANTIAGO, Date.UTC(2027, 7, 25, 0, 0), Date.UTC(2027, 8, 15, 0, 0)],
      [HAVANA, Date.UTC(2027, 2, 3, 0, 0), Date.UTC(2027, 2, 24, 0, 0)],
    ] as const) {
      const days = walk(SUNDAY_MIDNIGHT, zone, from, to);
      assert.equal(days.length, 3);
      for (const ts of days) {
        assert.match(localOf(ts, zone), /^Sun,/, `${zone}: ${localOf(ts, zone)}`);
      }
      assertOnePerLocalDay(days, zone);
      // A full seven days to the occurrence inside the gap — it is an hour
      // later in the local day than the two either side of it — and an hour
      // short of seven days from there to the next. The clocks moved and the
      // schedule moved with them rather than drifting against UTC.
      assert.equal(days[1] - days[0], 7 * 24 * 3_600_000);
      assert.equal(days[2] - days[1], 7 * 24 * 3_600_000 - 3_600_000);
    }
  });

  it("leaves every-N-hours alone at the boundary", () => {
    // An interval, not a wall-clock time: the whole reason the two kinds are
    // separate is that this one must not move when the clocks do.
    const spec: ScheduleSpec = {
      kind: "everyHours",
      hours: 6,
      anchorAt: Date.UTC(2026, 2, 28, 0, 0),
    };
    const steps = [
      nextOccurrence(spec, BERLIN, Date.UTC(2026, 2, 28, 22, 0)),
    ];
    for (let i = 0; i < 3; i++) {
      steps.push(nextOccurrence(spec, BERLIN, steps[steps.length - 1]));
    }
    for (let i = 1; i < steps.length; i++) {
      assert.equal(steps[i] - steps[i - 1], 6 * 3_600_000);
    }
  });
});

describe("decideSchedule", () => {
  it("does nothing between occurrences", () => {
    const d = decideSchedule(
      ctx({
        spec: DAILY_0900,
        lastFireAt: JUL_1_0900,
        now: Date.UTC(2026, 6, 1, 12, 0),
      }),
    );
    assert.equal(d.action.kind, "idle");
    assert.deepEqual(d.missed, []);
    assert.equal(d.cursorAt, JUL_1_0900);
    assert.equal(d.nextFireAt, JUL_2_0900);
  });

  it("fires the window it is in", () => {
    const d = decideSchedule(
      ctx({ spec: DAILY_0900, lastFireAt: JUL_1_0900, now: JUL_2_0900 + 5_000 }),
    );
    assert.deepEqual(d.action, { kind: "fire", fireAt: JUL_2_0900 });
    assert.deepEqual(d.missed, []);
    assert.equal(d.cursorAt, JUL_2_0900);
    assert.equal(d.nextFireAt, Date.UTC(2026, 6, 3, 7, 0));
  });

  it("still fires a tick that ran late, up to the grace", () => {
    const inside = decideSchedule(
      ctx({
        spec: DAILY_0900,
        lastFireAt: JUL_1_0900,
        now: JUL_2_0900 + FIRE_GRACE_MS,
      }),
    );
    assert.equal(inside.action.kind, "fire");
  });

  it("records a window the process was not there for, and does not make it up", () => {
    // The container was down over 09:00. A server coming back up must not start
    // unattended agents because of something that should have happened hours
    // ago — the queued-run rule and the queued-merge rule from a third
    // direction. The cursor still moves past it, so the next tick does not
    // rediscover it and the page can say what was lost.
    const d = decideSchedule(
      ctx({
        spec: DAILY_0900,
        lastFireAt: JUL_1_0900,
        now: JUL_2_0900 + FIRE_GRACE_MS + 1,
      }),
    );
    assert.equal(d.action.kind, "idle");
    assert.deepEqual(d.missed, [JUL_2_0900]);
    assert.equal(d.cursorAt, JUL_2_0900);
  });

  it("fires only the newest of several passed windows", () => {
    const jul3 = Date.UTC(2026, 6, 3, 7, 0);
    const d = decideSchedule(
      ctx({ spec: DAILY_0900, lastFireAt: JUL_1_0900, now: jul3 + 1_000 }),
    );
    assert.deepEqual(d.action, { kind: "fire", fireAt: jul3 });
    assert.deepEqual(d.missed, [JUL_2_0900]);
    assert.equal(d.cursorAt, jul3);
  });

  it("skips into a workflow that is still running, and says so", () => {
    // `startWorkflow` refuses a second instance while the first still has live
    // members. A schedule that fired into that refusal every hour would be
    // fifty identical failures in the record, so the decision is taken here and
    // the reason names the count.
    const d = decideSchedule(
      ctx({
        spec: DAILY_0900,
        lastFireAt: JUL_1_0900,
        now: JUL_2_0900 + 5_000,
        liveCount: 3,
      }),
    );
    assert.equal(d.action.kind, "skip");
    if (d.action.kind !== "skip") return;
    assert.equal(d.action.code, "overlap");
    assert.equal(d.action.fireAt, JUL_2_0900);
    assert.match(d.action.reason, /^3 run\(s\) and block\(s\)/);
    // Skipped, never queued: the cursor moves past the window, so the next
    // occurrence is the next chance rather than this one again in 30 seconds.
    assert.equal(d.cursorAt, JUL_2_0900);
    assert.equal(d.nextFireAt, Date.UTC(2026, 6, 3, 7, 0));
  });

  it("starts nothing while paused, and still says when it would", () => {
    const d = decideSchedule(
      ctx({
        spec: DAILY_0900,
        lastFireAt: JUL_1_0900,
        paused: true,
        now: JUL_2_0900 + 5_000,
      }),
    );
    assert.deepEqual(d.action, { kind: "paused" });
    // Nothing is missed by a schedule somebody switched off, and the cursor is
    // left where it was — `pauseSchedule` moves it on resume instead.
    assert.deepEqual(d.missed, []);
    assert.equal(d.cursorAt, JUL_1_0900);
    assert.equal(d.nextFireAt, Date.UTC(2026, 6, 3, 7, 0));
  });

  it("does not fire the occurrence a brand-new schedule just missed", () => {
    // `putSchedule` stamps the cursor at creation, so a schedule saved at 09:05
    // for "daily at 09:00" waits for tomorrow. Saved five minutes earlier it
    // would have run today, which is a press of Run nobody made.
    const d = decideSchedule(
      ctx({
        spec: DAILY_0900,
        lastFireAt: JUL_1_0900 + 5 * 60_000,
        now: JUL_1_0900 + 5 * 60_000,
      }),
    );
    assert.equal(d.action.kind, "idle");
    assert.deepEqual(d.missed, []);
    assert.equal(d.nextFireAt, JUL_2_0900);
  });

  it("treats a row with no cursor as starting from now", () => {
    const d = decideSchedule(
      ctx({ spec: DAILY_0900, lastFireAt: null, now: Date.UTC(2026, 6, 1, 12, 0) }),
    );
    assert.equal(d.action.kind, "idle");
    assert.deepEqual(d.missed, []);
    assert.equal(d.cursorAt, null);
    assert.equal(d.nextFireAt, JUL_2_0900);
  });
});

describe("scheduleRefusal", () => {
  const off = {
    maxInstanceCostUSD: null,
    maxSessionFraction: null,
    maxWeeklyFraction: null,
  };

  it("refuses a workflow that bounds a press of Run with nothing", () => {
    const reason = scheduleRefusal({ name: "Nightly", instanceBudget: off });
    assert.ok(reason);
    assert.match(reason, /Nightly/);
  });

  it("accepts any one of the three limits", () => {
    for (const budget of [
      { ...off, maxInstanceCostUSD: 5 },
      { ...off, maxSessionFraction: 0.5 },
      { ...off, maxWeeklyFraction: 0.5 },
    ]) {
      assert.equal(scheduleRefusal({ name: "Nightly", instanceBudget: budget }), null);
    }
  });
});

describe("normalizeScheduleInput", () => {
  const NOW = 1_700_000_000_000;

  it("refuses a zone this build does not know", () => {
    // Refused rather than falling back to the server's, which is what
    // `/api/usage` does: a calendar bucket an hour out is in front of the
    // operator, and a schedule an hour out is an hour out for months.
    const r = normalizeScheduleInput(
      { kind: "daily", minutes: 540, timeZone: "Mars/Olympus_Mons" },
      NOW,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /not a timezone/);
  });

  it("refuses a schedule with no zone at all", () => {
    const r = normalizeScheduleInput({ kind: "daily", minutes: 540 }, NOW);
    assert.equal(r.ok, false);
  });

  it("anchors every-N-hours on the instant it was saved", () => {
    const r = normalizeScheduleInput(
      { kind: "everyHours", hours: 6, timeZone: BERLIN },
      NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.value.spec, { kind: "everyHours", hours: 6, anchorAt: NOW });
  });

  it("refuses a time that is missing, rather than reading it as midnight", () => {
    // What a cleared `<input type="time">` actually arrives as. `minutesOf("")`
    // is `NaN`, JSON has no NaN so `JSON.stringify` emits `null`, and
    // `Number(null)` is `0` — so the range check below saw a legal 00:00 and
    // the graph started at midnight every day, unattended, until somebody
    // noticed. The same coercion `planUsage.ts`'s `num()` refuses for the same
    // reason: "there is no reading" and "the reading is zero" are different
    // facts, and only one of them is a time somebody chose.
    const missing: unknown[] = [
      { kind: "daily", minutes: null, timeZone: BERLIN },
      { kind: "daily", timeZone: BERLIN },
      { kind: "weekly", weekday: 1, minutes: null, timeZone: BERLIN },
      { kind: "weekly", weekday: 1, timeZone: BERLIN },
      // The wire itself, rather than a hand-written null: this is the value the
      // form put on it, round-tripped through the serialiser that loses the NaN.
      JSON.parse(JSON.stringify({ kind: "daily", minutes: NaN, timeZone: BERLIN })),
    ];
    for (const raw of missing) {
      const r = normalizeScheduleInput(raw, NOW);
      assert.equal(r.ok, false, JSON.stringify(raw));
      if (r.ok) continue;
      assert.match(r.error, /time of day/);
    }
  });

  it("still accepts a midnight somebody typed", () => {
    // The other half of the refusal above: 00:00 is a legal time, and a fix
    // that reached it by narrowing the range would have taken it away.
    const r = normalizeScheduleInput({ kind: "daily", minutes: 0, timeZone: BERLIN }, NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.value.spec, { kind: "daily", minutes: 0 });
  });

  it("refuses the values that would make a recurrence meaningless", () => {
    const bad: unknown[] = [
      { kind: "everyHours", hours: 0, timeZone: BERLIN },
      { kind: "everyHours", hours: 169, timeZone: BERLIN },
      { kind: "daily", minutes: 1440, timeZone: BERLIN },
      { kind: "daily", minutes: -1, timeZone: BERLIN },
      { kind: "weekly", weekday: 7, minutes: 540, timeZone: BERLIN },
      { kind: "0 0 * * 1", timeZone: BERLIN },
      { timeZone: BERLIN },
    ];
    for (const raw of bad) {
      assert.equal(normalizeScheduleInput(raw, NOW).ok, false, JSON.stringify(raw));
    }
  });
});

describe("describeSchedule", () => {
  it("says the rule and the zone it is read in", () => {
    assert.equal(
      describeSchedule(DAILY_0900, BERLIN),
      "Every day at 09:00 (Europe/Berlin)",
    );
    assert.equal(
      describeSchedule({ kind: "weekly", weekday: 1, minutes: 90 }, BERLIN),
      "Every Monday at 01:30 (Europe/Berlin)",
    );
    // No zone on an interval: it does not have a wall-clock time to read.
    assert.equal(
      describeSchedule({ kind: "everyHours", hours: 1, anchorAt: 0 }, BERLIN),
      "Every hour",
    );
    assert.equal(
      describeSchedule({ kind: "everyHours", hours: 6, anchorAt: 0 }, BERLIN),
      "Every 6 hours",
    );
  });
});
