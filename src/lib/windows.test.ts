import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ZERO_TOKENS } from "./pricing";
import type { UsageEntry } from "./transcripts";
import {
  FIVE_HOURS_MS,
  PERIOD_COUNT,
  WEEK_MS,
  buildPeriods,
  buildSessionBlocks,
  buildSnapshot,
  resolveTimeZone,
} from "./windows";

/**
 * Covers the two ways a 5-hour boundary is decided: where a derived block
 * opens, and the manual reset override.
 *
 * Every dashboard load exercises block building, but not in a way that *checks*
 * it — a boundary an hour out of step with the provider's renders as a
 * perfectly ordinary meter and reset time. It is arithmetic on window
 * boundaries where being off by one branch means the meter and the budget guard
 * both measure a window that is not the one being enforced.
 */

const HOUR = 3_600_000;

const entry = (ts: number, costUSD = 1): UsageEntry => ({
  key: `k${ts}`,
  ts,
  model: "claude-opus-5",
  tokens: { ...ZERO_TOKENS, input: 100 },
  costUSD,
  costGuardUSD: costUSD,
  project: "p",
  sessionId: "s",
  isSidechain: false,
  unpriced: false,
});

const NO_LIMITS = {
  sessionCostLimit: null,
  weeklyCostLimit: null,
  sessionTokenLimit: null,
  weeklyTokenLimit: null,
  weeklyAnchor: null,
};

// 17:05, a reset at 22:29 (so the window opened 17:29), now 20:50 — the shape
// of a tier change made partway through a block.
const blockStart = Date.UTC(2026, 7, 10, 17, 5);
const resetAt = Date.UTC(2026, 7, 10, 22, 29);
const anchor = resetAt - FIVE_HOURS_MS;
const now = Date.UTC(2026, 7, 10, 20, 50);

describe("derived 5-hour blocks", () => {
  // Anthropic issues the reset instant in a response header and Claude Code
  // renders its minutes, so a window does not begin at the top of an hour.
  // Rounding one down there both misreports the reset time and — because the
  // next block opens where this one closed — rolls the window over up to an
  // hour early, which reads as a fresh empty session while the provider is
  // still counting the old one.
  it("opens a block at its first turn, not at the top of that hour", () => {
    const first = Date.UTC(2026, 7, 10, 14, 47, 30);
    const blocks = buildSessionBlocks([entry(first)], first + 60_000);
    assert.equal(blocks[0].startsAt, first);
    assert.equal(blocks[0].endsAt, first + FIVE_HOURS_MS);
  });

  it("holds the window open for the whole five hours", () => {
    const first = Date.UTC(2026, 7, 10, 14, 47, 30);
    // 19:00 — where flooring to the hour used to put the boundary. The window
    // is still running, and the turn belongs to it rather than to a new one.
    const at19 = Date.UTC(2026, 7, 10, 19, 0);
    const blocks = buildSessionBlocks([entry(first), entry(at19)], at19);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].isActive, true);
    assert.equal(blocks[0].agg.entryCount, 2);
  });

  it("opens the next block where the last one closed, not on a grid", () => {
    const first = Date.UTC(2026, 7, 10, 14, 47, 30);
    const next = first + FIVE_HOURS_MS + 30_000; // 19:48:00
    const blocks = buildSessionBlocks([entry(first), entry(next)], next);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1].startsAt, next);
    assert.equal(blocks[1].endsAt, next + FIVE_HOURS_MS);
  });

  it("reports the window a turn now would open when none is running", () => {
    const stale = now - 9 * HOUR;
    const snap = buildSnapshot([entry(stale)], NO_LIMITS, now);
    assert.equal(snap.session.startsAt, now);
    assert.equal(snap.session.endsAt, now + FIVE_HOURS_MS);
    assert.equal(snap.session.costUSD, 0);
  });
});

describe("session reset override", () => {
  const entries = [
    entry(blockStart), // 17:05 — before the reset
    entry(anchor - 60_000), // 17:28
    entry(anchor + 60_000), // 17:30 — after it
    entry(now - 10 * 60_000),
  ];

  it("groups everything into one block when no override is set", () => {
    const blocks = buildSessionBlocks(entries, now);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].startsAt, blockStart);
    assert.equal(blocks[0].endsAt, blockStart + FIVE_HOURS_MS);
    assert.equal(blocks[0].agg.entryCount, 4);
  });

  it("splits the block at the reset and re-anchors the new one", () => {
    const blocks = buildSessionBlocks(entries, now, resetAt);
    assert.equal(blocks.length, 2);

    // The pre-reset block ends at the reset, not five hours after its first
    // entry, so it is no longer the active window.
    assert.equal(blocks[0].startsAt, blockStart);
    assert.equal(blocks[0].endsAt, anchor);
    assert.equal(blocks[0].isActive, false);
    assert.equal(blocks[0].agg.entryCount, 2);

    // The new block starts at the reset itself, not at its first entry floored
    // to the hour, so it expires exactly when the provider's window does.
    assert.equal(blocks[1].startsAt, anchor);
    assert.equal(blocks[1].endsAt, resetAt);
    assert.equal(blocks[1].isActive, true);
    assert.equal(blocks[1].agg.entryCount, 2);
  });

  it("charges the session window only the post-reset spend", () => {
    const before = buildSnapshot(entries, NO_LIMITS, now);
    assert.equal(before.session.costUSD, 4);

    const after = buildSnapshot(entries, NO_LIMITS, now, resetAt);
    assert.equal(after.session.costUSD, 2);
    assert.equal(after.session.startsAt, anchor);
    assert.equal(after.session.endsAt, resetAt);
    // The weekly window is a different quota and is not reset by a tier change.
    assert.equal(after.weekly.costUSD, 4);
  });

  it("opens the window at the reset even with no turns since", () => {
    const preResetOnly = entries.filter((e) => e.ts < anchor);
    const snap = buildSnapshot(preResetOnly, NO_LIMITS, now, resetAt);
    assert.equal(snap.session.startsAt, anchor);
    assert.equal(snap.session.costUSD, 0);
  });

  it("stops steering the window once its reset has passed", () => {
    const later = resetAt + HOUR;
    const snap = buildSnapshot(
      [...entries, entry(later - 5 * 60_000)],
      NO_LIMITS,
      later,
      resetAt,
    );
    // A new block opened after the reset on the usual rules; the stale
    // override neither extends nor re-opens the window it named.
    assert.equal(snap.session.startsAt, later - 5 * 60_000);
    assert.equal(snap.session.costUSD, 1);
  });

  it("leaves blocks that do not contain the reset alone", () => {
    const earlier = Date.UTC(2026, 7, 9, 9, 30);
    const blocks = buildSessionBlocks([entry(earlier)], now, resetAt);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].startsAt, earlier);
    assert.equal(blocks[0].endsAt, earlier + FIVE_HOURS_MS);
  });
});

/**
 * Calendar bucketing, which fails silently in three ways that all render as a
 * perfectly ordinary table.
 *
 * A boundary cut in the wrong zone files an evening's work under the next day,
 * and the container runs in UTC while every reader is somewhere else. A
 * pro-rated ceiling off by the span ratio prints a confident percentage against
 * a number nobody set — the failure `guardCostOf` and the no-default-ceilings
 * rule both exist to prevent, arriving here as display rather than as a guard.
 * And a gap between two buckets loses spend outright: an entry that falls in no
 * bucket is simply not in the totals, and nothing on the page would say so.
 */
describe("calendar periods", () => {
  const BERLIN = "Europe/Berlin";
  const LIMITS = { ...NO_LIMITS, weeklyCostLimit: 700 };

  // 22:30 UTC on 11 August is already 00:30 on the 12th in Berlin. Bucketing in
  // UTC would file it under the 11th, and it is the entry that decides which
  // day the reader is told they spent it on.
  const lateEvening = Date.UTC(2026, 7, 11, 22, 30);
  const berlinNow = Date.UTC(2026, 7, 12, 10, 0);

  it("cuts a day at local midnight, not at UTC midnight", () => {
    const series = buildPeriods(
      [entry(lateEvening)],
      "day",
      NO_LIMITS,
      berlinNow,
      BERLIN,
    );
    const today = series.buckets[0];
    assert.equal(today.isCurrent, true);
    assert.equal(today.entryCount, 1, "the turn belongs to the local day");
    // 00:00 Berlin on 12 August is 22:00 UTC on the 11th (CEST, UTC+2).
    assert.equal(today.startsAt, Date.UTC(2026, 7, 11, 22, 0));
    assert.equal(today.endsAt, Date.UTC(2026, 7, 12, 22, 0));
  });

  it("leaves no gap between buckets, across a DST change", () => {
    // 25 October 2026: Berlin leaves CEST, so one local day is 25 hours long.
    const afterDst = Date.UTC(2026, 9, 28, 12, 0);
    // Old enough that no granularity trims a bucket for want of history, so
    // this walks the full span of each series.
    const ancient = [entry(Date.UTC(2025, 0, 1))];
    for (const granularity of ["day", "week", "month"] as const) {
      const series = buildPeriods(
        ancient,
        granularity,
        NO_LIMITS,
        afterDst,
        BERLIN,
      );
      assert.equal(series.buckets.length, PERIOD_COUNT[granularity]);
      // Newest first, so walking backwards is walking forwards in time.
      for (let i = series.buckets.length - 1; i > 0; i--) {
        assert.equal(
          series.buckets[i].endsAt,
          series.buckets[i - 1].startsAt,
          `${granularity} bucket ${i} does not meet the next one`,
        );
      }
    }
    const days = buildPeriods(ancient, "day", NO_LIMITS, afterDst, BERLIN)
      .buckets;
    const longDay = days.find(
      (b) => b.startsAt === Date.UTC(2026, 9, 24, 22, 0),
    );
    assert.ok(longDay, "25 October is in the fortnight");
    assert.equal(longDay.endsAt - longDay.startsAt, 25 * HOUR);
  });

  it("measures a week against the weekly ceiling as it stands", () => {
    const series = buildPeriods(
      [entry(berlinNow - HOUR, 350)],
      "week",
      LIMITS,
      berlinNow,
      BERLIN,
    );
    assert.equal(series.limitBasis, "weekly");
    assert.equal(series.buckets[0].limit, 700);
    assert.equal(series.buckets[0].fraction, 0.5);
  });

  it("spreads that ceiling over a day and a month, and says which", () => {
    const day = buildPeriods([], "day", LIMITS, berlinNow, BERLIN);
    assert.equal(day.limitBasis, "prorated");
    assert.equal(day.buckets[0].limit, 100);

    // August has 31 days, so a month is not a fixed multiple of a week.
    const month = buildPeriods([], "month", LIMITS, berlinNow, BERLIN);
    assert.equal(month.limitBasis, "prorated");
    assert.equal(month.buckets[0].limit, (700 * 31) / 7);
  });

  it("reports no basis at all when no weekly ceiling is set", () => {
    const series = buildPeriods([], "week", NO_LIMITS, berlinNow, BERLIN);
    assert.equal(series.limitBasis, null);
    assert.equal(series.buckets[0].limit, null);
    // Null, never 0 — an unknown share renders as the hatched meter.
    assert.equal(series.buckets[0].fraction, null);
  });

  it("aligns weekly buckets to a configured anchor, not to Monday", () => {
    const anchored = {
      ...NO_LIMITS,
      weeklyAnchor: { weekday: 4, hourUTC: 9 }, // Thursday 09:00 UTC
    };
    const series = buildPeriods([], "week", anchored, berlinNow, BERLIN);
    const current = series.buckets[0];
    // 12 August 2026 is a Wednesday, so the live week opened the Thursday
    // before it. A calendar Monday here would put a different total under the
    // same word as the weekly meter above it on the page.
    assert.equal(current.startsAt, Date.UTC(2026, 7, 6, 9, 0));
    assert.equal(current.endsAt, current.startsAt + WEEK_MS);
  });

  it("drops buckets that closed before the first recorded turn", () => {
    const firstTurn = Date.UTC(2026, 7, 10, 12, 0);
    const series = buildPeriods(
      [entry(firstTurn)],
      "day",
      NO_LIMITS,
      berlinNow,
      BERLIN,
    );
    // Two days of history, not a fortnight of $0.00 above it.
    assert.equal(series.buckets.length, 3);
    assert.ok(series.buckets.length < PERIOD_COUNT.day);
  });

  it("keeps every turn in the window in exactly one bucket", () => {
    const spread = [
      entry(berlinNow - 30 * HOUR),
      entry(berlinNow - 6 * HOUR),
      entry(berlinNow - HOUR),
      entry(lateEvening),
    ];
    const series = buildPeriods(spread, "day", NO_LIMITS, berlinNow, BERLIN);
    const counted = series.buckets.reduce((n, b) => n + b.entryCount, 0);
    assert.equal(counted, spread.length);
  });

  it("falls back to the server's zone rather than throwing on a bad one", () => {
    const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(resolveTimeZone("Europe/Berlin"), "Europe/Berlin");
    assert.equal(resolveTimeZone("Mars/Olympus_Mons"), server);
    assert.equal(resolveTimeZone(null), server);
    assert.equal(resolveTimeZone("x".repeat(200)), server);
  });
});
