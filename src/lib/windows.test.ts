import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ZERO_TOKENS } from "./pricing";
import type { UsageEntry } from "./transcripts";
import { FIVE_HOURS_MS, buildSessionBlocks, buildSnapshot } from "./windows";

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
 * The provider's own reading, and what it displaces.
 *
 * Every one of these is a silent failure: a percentage that came from the
 * wrong denominator still renders as a perfectly ordinary meter, and the
 * budget guard acts on the same number. On the machine this was written
 * against the derived reading was 1.3% where the provider said 5.0% — right
 * arithmetic, ceiling somebody had typed — so what needs pinning is which of
 * the two reaches `fraction`, and that the fallback is still there when the
 * read fails.
 */
describe("provider-reported utilisation", () => {
  const CEILINGS = {
    sessionCostLimit: 100,
    weeklyCostLimit: 1000,
    sessionTokenLimit: null,
    weeklyTokenLimit: null,
    weeklyAnchor: null,
  };

  const plan = (
    session: { utilization: number; resetsAt: number | null } | null,
    weekly: { utilization: number; resetsAt: number | null } | null = null,
    scopedWeekly: Array<{
      label: string;
      window: { utilization: number; resetsAt: number | null };
    }> = [],
  ) => ({ session, weekly, scopedWeekly, fetchedAt: now });

  // One turn costing $10 inside the current window: 10% of the typed $100
  // ceiling, against whatever the provider says.
  const spend = [entry(now - HOUR, 10)];

  it("reports the provider's fraction rather than the typed ceiling's", () => {
    const snap = buildSnapshot(spend, CEILINGS, now, null, plan({
      utilization: 0.4,
      resetsAt: null,
    }));
    assert.equal(snap.session.fraction, 0.4);
    assert.equal(snap.session.fractionMetric, "plan");
    assert.equal(snap.session.planFraction, 0.4);
    // The derived reading is kept, not overwritten — it is what the "your
    // configured ceiling says otherwise" footnote is drawn from.
    assert.equal(snap.session.costFraction, 0.1);
    // Nothing to describe: the provider names a percentage, not a ceiling.
    assert.equal(snap.session.limit, null);
    assert.equal(snap.session.limitMetric, "plan");
  });

  it("guards on the provider's fraction too, with no unpriced-model markup", () => {
    // costGuardUSD is deliberately higher than costUSD here, the shape an
    // unpriced model leaves behind. That markup exists because our price table
    // can fail to place a model; the provider's own accounting cannot, so it
    // must not inflate a first-party figure.
    const unpriced: UsageEntry[] = [
      { ...entry(now - HOUR, 10), costGuardUSD: 50 },
    ];
    const snap = buildSnapshot(unpriced, CEILINGS, now, null, plan({
      utilization: 0.4,
      resetsAt: null,
    }));
    assert.equal(snap.session.guardFraction, 0.4);
  });

  it("falls back to the derived reading when the read failed", () => {
    const snap = buildSnapshot(spend, CEILINGS, now, null, null);
    assert.equal(snap.session.fraction, 0.1);
    assert.equal(snap.session.fractionMetric, "cost");
    assert.equal(snap.session.planFraction, null);
  });

  it("falls back per window, so one missing reading does not blank the other", () => {
    const snap = buildSnapshot(spend, CEILINGS, now, null, plan(null, {
      utilization: 0.6,
      resetsAt: null,
    }));
    assert.equal(snap.session.fractionMetric, "cost");
    assert.equal(snap.weekly.fractionMetric, "plan");
    assert.equal(snap.weekly.fraction, 0.6);
  });

  it("guards the week on the worst of it and every model-scoped wall", () => {
    // An Opus week that is nearly full while the all-model window is a
    // quarter spent is a wall that stops runs and never reaches the meter.
    const snap = buildSnapshot(spend, CEILINGS, now, null, plan(
      null,
      { utilization: 0.25, resetsAt: null },
      [{ label: "Opus", window: { utilization: 0.93, resetsAt: null } }],
    ));
    assert.equal(snap.weekly.fraction, 0.25);
    assert.equal(snap.weekly.guardFraction, 0.93);
  });

  it("anchors the 5-hour window on the provider's reset, over a typed one", () => {
    // `sessionResetOverrideAt` exists only because this instant could not be
    // read. A stale typed value must not keep splitting blocks once it can.
    const providerReset = now + HOUR;
    const snap = buildSnapshot(
      [entry(now - 6 * HOUR, 1), entry(now - 30 * 60_000, 2)],
      NO_LIMITS,
      now,
      resetAt,
      plan({ utilization: 0.1, resetsAt: providerReset }),
    );
    assert.equal(snap.session.startsAt, providerReset - FIVE_HOURS_MS);
    assert.equal(snap.session.endsAt, providerReset);
    // The turn from four hours ago opened a window that has since closed, so
    // only the recent one is in the window being enforced.
    assert.equal(snap.session.costUSD, 2);
  });

  it("measures the week against the provider's reset instead of a trailing 7 days", () => {
    const weeklyReset = now + 2 * 24 * HOUR;
    const snap = buildSnapshot(spend, NO_LIMITS, now, null, plan(null, {
      utilization: 0.2,
      resetsAt: weeklyReset,
    }));
    assert.equal(snap.weekly.endsAt, weeklyReset);
    assert.equal(snap.weekly.startsAt, weeklyReset - 7 * 24 * HOUR);
    // A trailing total has no reset to wait for; this one does, and the label
    // is what tells the operator which of the two they are looking at.
    assert.equal(snap.weekly.label, "Weekly quota");
  });
});
