import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ZERO_TOKENS } from "./pricing";
import type { UsageEntry } from "./transcripts";
import { FIVE_HOURS_MS, buildSessionBlocks, buildSnapshot } from "./windows";

/**
 * Covers the manual 5-hour reset override, and only that.
 *
 * Blocks derived from transcripts alone are exercised by every dashboard load;
 * the override is not, and it is arithmetic on window boundaries where being
 * off by one branch means the meter and the budget guard both measure a window
 * that is not the one being enforced.
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

// 17:00, a reset at 22:29 (so the window opened 17:29), now 20:50 — the shape
// of a tier change made partway through a block.
const blockStart = Date.UTC(2026, 7, 10, 17, 0);
const resetAt = Date.UTC(2026, 7, 10, 22, 29);
const anchor = resetAt - FIVE_HOURS_MS;
const now = Date.UTC(2026, 7, 10, 20, 50);

describe("session reset override", () => {
  const entries = [
    entry(blockStart + 5 * 60_000), // 17:05 — before the reset
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
    assert.equal(snap.session.startsAt, Date.UTC(2026, 7, 10, 23, 0));
    assert.equal(snap.session.costUSD, 1);
  });

  it("leaves blocks that do not contain the reset alone", () => {
    const old = [entry(Date.UTC(2026, 7, 9, 9, 30))];
    const blocks = buildSessionBlocks(old, now, resetAt);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].startsAt, Date.UTC(2026, 7, 9, 9, 0));
    assert.equal(blocks[0].endsAt, Date.UTC(2026, 7, 9, 9, 0) + FIVE_HOURS_MS);
  });
});
