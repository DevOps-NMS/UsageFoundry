import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parsePlanUsage } from "./planUsage";

/**
 * The payload shape is an undocumented internal of another program, captured
 * from a live account rather than read from any spec — the same footing as the
 * `stream-json` parser and the OTLP shapes. That is what earns these tests:
 * every way this can go wrong is silent and points the wrong way. A percentage
 * misread as a fraction understates a meter by a hundred, a fraction misread
 * as a percentage overstates it by the same, a shape change reads as an
 * account at 0%, and each of those is a number an operator acts on.
 */

/** Trimmed from a real response — a Max 20x account, mid-window. */
const LIVE = {
  five_hour: {
    utilization: 5.0,
    resets_at: "2026-08-13T00:30:00.358661+00:00",
    limit_dollars: null,
  },
  seven_day: {
    utilization: 1.0,
    resets_at: "2026-08-19T06:00:00.358689+00:00",
    limit_dollars: null,
  },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 5,
      resets_at: "2026-08-13T00:30:00.358661+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 1,
      resets_at: "2026-08-19T06:00:00.358689+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      resets_at: null,
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
};

test("reads the two windows as fractions, not percentages", () => {
  const plan = parsePlanUsage(LIVE, 1000);
  assert.ok(plan);
  assert.equal(plan.session?.utilization, 0.05);
  assert.equal(plan.weekly?.utilization, 0.01);
  assert.equal(plan.fetchedAt, 1000);
});

test("carries the reset instants the windows are anchored on", () => {
  const plan = parsePlanUsage(LIVE, 1000);
  assert.equal(
    plan?.session?.resetsAt,
    Date.parse("2026-08-13T00:30:00.358661+00:00"),
  );
  assert.equal(
    plan?.weekly?.resetsAt,
    Date.parse("2026-08-19T06:00:00.358689+00:00"),
  );
});

test("takes model-scoped weekly walls from limits[], with their names", () => {
  const plan = parsePlanUsage(LIVE, 0);
  assert.deepEqual(plan?.scopedWeekly, [
    { label: "Fable", window: { utilization: 0, resetsAt: null } },
  ]);
});

test("a scoped wall reaches the guard even for a model family we do not know", () => {
  // The reason `limits[]` is read instead of the `seven_day_opus`-style keys:
  // a new family appears here with a name and no code change.
  const plan = parsePlanUsage(
    {
      ...LIVE,
      limits: [
        ...LIVE.limits,
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 91.5,
          resets_at: "2026-08-19T06:00:00Z",
          scope: { model: { display_name: "Someone New" } },
          is_active: true,
        },
      ],
    },
    0,
  );
  assert.equal(plan?.scopedWeekly.length, 2);
  assert.equal(plan?.scopedWeekly[1].label, "Someone New");
  assert.equal(plan?.scopedWeekly[1].window.utilization, 0.915);
});

test("a window without a reset instant is still a reading", () => {
  const plan = parsePlanUsage({ five_hour: { utilization: 12 } }, 0);
  assert.deepEqual(plan?.session, { utilization: 0.12, resetsAt: null });
  assert.equal(plan?.weekly, null);
});

test("keeps a reading above 100%, because a full window is a fact", () => {
  // Clamping would report a run being refused as one merely at the line.
  const plan = parsePlanUsage({ seven_day: { utilization: 104 } }, 0);
  assert.equal(plan?.weekly?.utilization, 1.04);
});

test("a shape with no window at all is null, never an account at 0%", () => {
  assert.equal(parsePlanUsage({}, 0), null);
  assert.equal(parsePlanUsage({ five_hour: null, seven_day: null }, 0), null);
  assert.equal(parsePlanUsage({ limits: [] }, 0), null);
  assert.equal(parsePlanUsage(null, 0), null);
  assert.equal(parsePlanUsage("not json", 0), null);
  // An error body is a shape, and it names no window.
  assert.equal(parsePlanUsage({ error: { type: "rate_limit_error" } }, 0), null);
});

test("a window whose utilization is not a number is dropped, not zeroed", () => {
  const plan = parsePlanUsage(
    { five_hour: { utilization: null }, seven_day: { utilization: 3 } },
    0,
  );
  assert.equal(plan?.session, null);
  assert.equal(plan?.weekly?.utilization, 0.03);
});

test("an unparseable reset instant leaves the window without one", () => {
  const plan = parsePlanUsage(
    { five_hour: { utilization: 2, resets_at: "soon" } },
    0,
  );
  assert.deepEqual(plan?.session, { utilization: 0.02, resetsAt: null });
});
