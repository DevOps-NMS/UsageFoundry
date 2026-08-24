import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ZERO_TOKENS, costOf, resolvePrice } from "./pricing";
import type { UsageEntry } from "./transcripts";
import type { ToolCall } from "./toolComposition";
import {
  FIVE_HOURS_MS,
  MAIN_THREAD_BUCKET,
  PERIOD_COUNT,
  WEEK_MS,
  agentOrigin,
  agentOriginIndex,
  agentSpend,
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
  requestId: `req${ts}`,
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

  // The tests above pin *where* a boundary lands. These pin which side of it an
  // entry falls on, which is the half that can move silently: an entry landing
  // exactly on a boundary is not a coincidence here but what a boundary is —
  // the provider issues the reset instant itself and `anchorOf` derives the
  // block start from it by subtraction, so it lands on the instant exactly.
  it("opens the next block at an entry exactly five hours after this one", () => {
    const first = Date.UTC(2026, 7, 10, 14, 47, 30);
    const boundary = first + FIVE_HOURS_MS;
    const blocks = buildSessionBlocks([entry(first), entry(boundary)], boundary + 1);
    // The window is five hours long, so the entry at the fifth hour is the
    // first one outside it. Kept in the old block it would extend that window,
    // and because each block opens where the last one closed the error would
    // carry down the rest of the chain.
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].endsAt, boundary);
    assert.equal(blocks[0].agg.entryCount, 1);
    assert.equal(blocks[1].startsAt, boundary);
    assert.equal(blocks[1].agg.entryCount, 1);
  });

  it("closes a block at exactly its end instant", () => {
    // `buildSnapshot` takes `blocks.find((b) => b.isActive)` as *the* session
    // window and the guard reads its fraction, so a block still counted open at
    // its own end instant is the guard measuring a window that has closed.
    const first = Date.UTC(2026, 7, 10, 14, 47, 30);
    const [closed] = buildSessionBlocks([entry(first)], first + FIVE_HOURS_MS);
    assert.equal(closed.endsAt, first + FIVE_HOURS_MS);
    assert.equal(closed.isActive, false);

    // A millisecond earlier it is still the window being enforced.
    const [open] = buildSessionBlocks([entry(first)], first + FIVE_HOURS_MS - 1);
    assert.equal(open.isActive, true);
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

  // The three boundaries the override itself turns on. Each is the `=` case of
  // a comparison whose two readings are a whole window apart, and each renders
  // as an ordinary meter either way.
  it("puts a turn at the reset instant into the block the reset opens", () => {
    // The split trigger. An entry landing exactly on the reset belongs to the
    // window the reset opened, not to the one it ended — that is the whole of
    // what the override does, and the provider's own instant is what a turn
    // here lands on.
    const blocks = buildSessionBlocks([entry(blockStart), entry(anchor)], now, resetAt);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].startsAt, blockStart);
    assert.equal(blocks[0].endsAt, anchor);
    assert.equal(blocks[0].isActive, false);
    assert.equal(blocks[0].agg.entryCount, 1);

    // …and it starts that block at the reset rather than at itself, which is
    // the same instant here — the block it opens expires with the provider's
    // window rather than five hours after this turn.
    assert.equal(blocks[1].startsAt, anchor);
    assert.equal(blocks[1].endsAt, resetAt);
    assert.equal(blocks[1].agg.entryCount, 1);
  });

  it("lets a turn at the end of the reset's own window open a fresh block", () => {
    // The far edge of the override's reach. The window it opened runs from
    // `anchor` to `resetAt`; a turn at `resetAt` is the first one past it, so
    // it opens its own five hours rather than being folded back into a window
    // that has just closed — which would report a window as fresh for five
    // hours after the one it is actually spending against.
    const blocks = buildSessionBlocks([entry(resetAt)], resetAt + 60_000, resetAt);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].startsAt, resetAt);
    assert.equal(blocks[0].endsAt, resetAt + FIVE_HOURS_MS);
    assert.equal(blocks[0].isActive, true);
  });

  it("leaves a block that already ends at the reset its full five hours", () => {
    // A block whose own window closes exactly where the reset falls. There is
    // nothing to pull forward: it ran its five hours and ended at the reset,
    // and it is closed either way.
    const startsAt = anchor - FIVE_HOURS_MS;
    const blocks = buildSessionBlocks([entry(startsAt)], now, resetAt);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].startsAt, startsAt);
    assert.equal(blocks[0].endsAt, anchor);
    assert.equal(blocks[0].endsAt - blocks[0].startsAt, FIVE_HOURS_MS);
    assert.equal(blocks[0].isActive, false);
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
    fetchedAt: number = now,
  ) => ({ session, weekly, scopedWeekly, fetchedAt });

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

  it("keeps the unpriced-model markup out of the displayed fraction", () => {
    // costGuardUSD is deliberately higher than costUSD here, the shape an
    // unpriced model leaves behind. That markup is a deliberate over-estimate,
    // so it must not reach the meter — the provider's own accounting cannot
    // fail to place a model, and the displayed number is the honest one. It
    // does reach `guardFraction`, which is the case below.
    const unpriced: UsageEntry[] = [
      { ...entry(now - HOUR, 10), costGuardUSD: 50 },
    ];
    const snap = buildSnapshot(unpriced, CEILINGS, now, null, plan({
      utilization: 0.4,
      resetsAt: null,
    }));
    assert.equal(snap.session.fraction, 0.4);
    assert.equal(snap.session.fractionMetric, "plan");
  });

  /**
   * The provider's percentage is cached — five minutes in the ordinary case,
   * up to an hour while requests are being refused. With several runs sharing
   * one account, every cycle any of them starts inside a refresh interval is
   * authorised by one identical frozen number, and the window can be walked
   * from under the guard to over it without the guard ever seeing a figure
   * that moved. Locally observed spend is recomputed on every single pre-cycle
   * check and is the only current evidence there is, so it has to be able to
   * carry the reading forward.
   *
   * What it may carry forward is only the spend the reading has *not already
   * counted*, converted at the rate that reading implies — never a fraction of
   * a typed ceiling, which is a different denominator for the same window and
   * is the bug the case below pins.
   */
  it("carries a frozen reading forward on the spend it has not yet seen", () => {
    // Read an hour ago, when this window held $30 of turns and the provider
    // called it 40% — so 1% of the allowance is $0.75, whatever the plan is.
    // $10 has landed since, which is 13.3 points more.
    const frozen = plan({ utilization: 0.4, resetsAt: null }, null, [], now - HOUR);
    const entries = [entry(now - 2 * HOUR, 30), entry(now - 30 * 60_000, 10)];
    const busy = buildSnapshot(entries, CEILINGS, now, null, frozen);

    assert.ok(Math.abs(busy.session.guardFraction! - 0.5333333) < 1e-6);

    // Same reading, same window, nothing since the fetch: the provider's
    // figure stands rather than being scaled by an invented rate.
    const quiet = buildSnapshot([entry(now - 2 * HOUR, 30)], CEILINGS, now, null, frozen);
    assert.equal(quiet.session.guardFraction, 0.4);
    assert.ok(busy.session.guardFraction! > quiet.session.guardFraction!);

    // And the meter is unmoved either way: the provider's percentage is still
    // what is shown, which is the whole of the display-versus-guard split.
    assert.equal(quiet.session.fraction, 0.4);
    assert.equal(busy.session.fraction, 0.4);
  });

  /**
   * The reported bug, with the numbers it was measured on.
   *
   * A live Max account mid-window: $2,388 of derived weekly spend that the
   * provider called 70%. The guard used to take `max(planFraction,
   * costGuardUSD / weeklyCostLimit)`, so a typed $1,000 ceiling read 238.8% —
   * and `Meter` drew the whole gap between 70% and 238.8% as a hatched band,
   * which is what "the striped bar goes to almost double" was. The two terms
   * are fractions of different denominators, and the derived one re-counts
   * spend the provider's own percentage already includes.
   *
   * No ceiling an operator can type may move this number, in either direction.
   */
  it("does not re-count spend the provider's reading already includes", () => {
    const heavy = [entry(now - 2 * HOUR, 2388)];
    const reading = plan(null, { utilization: 0.7, resetsAt: null });

    const snap = buildSnapshot(heavy, CEILINGS, now, null, reading);
    assert.equal(snap.weekly.fraction, 0.7);
    assert.equal(snap.weekly.guardFraction, 0.7);

    // The typed ceiling is 24x out at $100 and absent at null. Neither shows.
    for (const weeklyCostLimit of [100, 1000, null]) {
      const other = buildSnapshot(
        heavy,
        { ...CEILINGS, weeklyCostLimit },
        now,
        null,
        reading,
      );
      assert.equal(other.weekly.guardFraction, 0.7);
    }
  });

  it("never lets the derived reading lower the provider's own", () => {
    // $1 of a $100 ceiling is 1% derived against 40% reported. The provider's
    // superior denominator is the reason it is preferred at all, so it stays a
    // floor under the guard.
    const snap = buildSnapshot([entry(now - HOUR, 1)], CEILINGS, now, null, plan({
      utilization: 0.4,
      resetsAt: null,
    }));
    assert.equal(snap.session.costFraction, 0.01);
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

  /**
   * The same wall, on the payload that carries no all-model weekly figure
   * beside it — `five_hour` plus `limits[]` and no `seven_day`, which is a
   * shape `parsePlanUsage` accepts by name. The captured payload the parser is
   * tested against happens to include `seven_day`, so nothing ever drove this
   * branch, and it fell straight through to the derived reading: an Opus week
   * at 95% left every weekly guard on the install reading `no-ceiling`.
   */
  it("stands a model-scoped wall up when the week has no top-level reading", () => {
    const snap = buildSnapshot(spend, CEILINGS, now, null, plan(
      { utilization: 0.4, resetsAt: null },
      null,
      [{ label: "Opus", window: { utilization: 0.95, resetsAt: null } }],
    ));
    assert.equal(snap.weekly.guardFraction, 0.95);
    assert.equal(snap.weekly.fraction, 0.95);
    assert.equal(snap.weekly.fractionMetric, "plan");
    // The provider named no all-model figure for this window, and reporting
    // one it did not give is what `planFraction` exists to keep separable.
    assert.equal(snap.weekly.planFraction, null);
    // Nothing to describe: the wall is a percentage, not a ceiling.
    assert.equal(snap.weekly.limit, null);
    assert.equal(snap.weekly.limitMetric, "plan");
    // The window that *was* answered is untouched by any of it.
    assert.equal(snap.session.fraction, 0.4);
  });

  it("falls back to the derived reading when there is no wall to stand up", () => {
    // The empty-wall case has to stay a fallback and never a zero: an account
    // with no model-scoped week, on a payload with no `seven_day`, is a window
    // nobody read — not one at 0%, which is the substitution this module
    // refuses everywhere else.
    const snap = buildSnapshot(spend, CEILINGS, now, null, plan({
      utilization: 0.4,
      resetsAt: null,
    }));
    assert.equal(snap.weekly.fractionMetric, "cost");
    assert.equal(snap.weekly.fraction, 0.01); // $10 of the typed $1,000
    assert.equal(snap.weekly.planFraction, null);
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

/**
 * The exhaustion projection, which is arithmetic whose only output is a date on
 * a card — there is nothing about a wrong one that looks wrong.
 *
 * It extrapolates the trailing hour's burn against each configured ceiling and
 * reports the earliest result, and every window it projects zeroes its consumed
 * figure at a reset. Measured on this install: a 5-hour window 1.2h from
 * resetting projected 8.8h out, a weekly candidate sat 32.6h out, and the
 * earliest-wins rule returned the session one — a stated instant 7.6h after the
 * window it describes had already reset. Because `Math.min` always takes the
 * earlier, that error only ever understates remaining headroom.
 */
describe("projected exhaustion", () => {
  // A block opened four hours ago, so the 5-hour window resets in one; $10 of
  // it landed in the last half hour, which is the whole trailing-hour burn.
  const burning = [entry(now - 4 * HOUR, 1), entry(now - 30 * 60_000, 10)];

  const planWeek = (resetsAt: number) => ({
    session: null,
    weekly: { utilization: 0.25, resetsAt },
    scopedWeekly: [],
    fetchedAt: now,
  });

  it("drops a candidate that lands past the window it was projected from", () => {
    const snap = buildSnapshot(
      burning,
      { ...NO_LIMITS, sessionCostLimit: 100, weeklyCostLimit: 200 },
      now,
    );
    assert.equal(snap.session.endsAt, now + HOUR);
    assert.equal(snap.burnCostPerHour, 10);

    // Session: $89 of headroom at $10/h is 8.9h out, past a window that resets
    // in one — so the answer is the weekly candidate, $189 out at the same
    // rate, and not an instant 7.9h into a window that will have reset empty.
    assert.equal(snap.projectedExhaustionAt, now + 18.9 * HOUR);
  });

  it("keeps a session projection that lands inside its own window", () => {
    // Same shape, a ceiling low enough that the window really does run out
    // before it resets: $4 of headroom at $10/h, 24 minutes out.
    const snap = buildSnapshot(
      burning,
      { ...NO_LIMITS, sessionCostLimit: 15, weeklyCostLimit: 200 },
      now,
    );
    assert.equal(snap.projectedExhaustionAt, now + 0.4 * HOUR);
  });

  it("keeps a weekly projection that lands inside the week", () => {
    const snap = buildSnapshot(
      burning,
      { ...NO_LIMITS, weeklyCostLimit: 200 },
      now,
      null,
      planWeek(now + 3 * 24 * HOUR),
    );
    assert.equal(snap.projectedExhaustionAt, now + 18.9 * HOUR);
  });

  it("still projects a trailing 7-day window, which has no reset to drop it at", () => {
    // With no anchor and no provider reset the weekly window's `endsAt` is
    // `now`, so bounding this candidate by that would null every projection an
    // install without a weekly anchor could make. A trailing total has no
    // instant at which it zeroes — it decays as the oldest turns fall out.
    const snap = buildSnapshot(burning, { ...NO_LIMITS, weeklyCostLimit: 200 }, now);
    assert.equal(snap.weekly.label, "Trailing 7 days");
    assert.equal(snap.projectedExhaustionAt, now + 18.9 * HOUR);
  });

  it("reports no projection rather than a zero when every candidate is dropped", () => {
    // Both windows reset before the burn could exhaust either. The card reads
    // "—" off a null; a 0 or an Infinity here would print a date instead.
    const snap = buildSnapshot(
      burning,
      { ...NO_LIMITS, sessionCostLimit: 100, weeklyCostLimit: 200 },
      now,
      null,
      planWeek(now + 6 * HOUR),
    );
    assert.equal(snap.projectedExhaustionAt, null);
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

/**
 * Which bucket a turn lands in, and what the card is allowed to say about it.
 *
 * Both halves are silent when wrong. A turn that falls out of the rollup leaves
 * a column that no longer adds up to the window total, which reads as a
 * perfectly ordinary table of plausible dollar figures — the same failure the
 * calendar-bucket contiguity test exists to catch one card over. And an
 * annotation that shifts spend between rows, or that claims the operator's own
 * saved agent did work a file on disk may have done, is a confident sentence
 * about who spent the money.
 */
describe("agent attribution", () => {
  const agentEntry = (
    ts: number,
    agent: string | undefined,
    costUSD = 1,
  ): UsageEntry => ({ ...entry(ts, costUSD), agent });

  it("names where a definition lives, and never moves a bucket", () => {
    const index = agentOriginIndex(["Reviewer"], ["explorer", "Reviewer"]);

    // Case-folded, because `idx_agents_name` and `getAgentByName` are: the name
    // the CLI recorded and the name the operator saved are one agent.
    assert.equal(agentOrigin("reviewer", index), "both");
    assert.equal(agentOrigin("REVIEWER", index), "both");
    assert.equal(agentOrigin("Explorer", index), "ambient");
    // A CLI built-in, a repository's own `.claude/agents`, or one since
    // deleted — all the same statement: this install has no definition for it.
    assert.equal(agentOrigin("general-purpose", index), "unknown");
    assert.equal(agentOrigin(MAIN_THREAD_BUCKET, index), "main");

    // No lookup is "nobody asked", which the guard path never does. It must not
    // collapse into "asked, and there is no such agent".
    assert.equal(agentOrigin("Reviewer", null), null);
    assert.equal(agentOrigin(MAIN_THREAD_BUCKET, null), "main");
  });

  it("keeps a saved-only name apart from an ambient-only one", () => {
    const index = agentOriginIndex(["saved-only"], ["disk-only"]);
    assert.equal(agentOrigin("saved-only", index), "registry");
    assert.equal(agentOrigin("disk-only", index), "ambient");
  });

  it("puts every turn in a byAgent bucket, so the column reconciles", () => {
    const at = now - HOUR;
    const entries = [
      agentEntry(at, undefined, 3),
      agentEntry(at + 1, "Reviewer", 2),
      agentEntry(at + 2, "Reviewer", 1),
      agentEntry(at + 3, "general-purpose", 4),
    ];
    const snap = buildSnapshot(
      entries,
      NO_LIMITS,
      now,
      null,
      null,
      agentOriginIndex(["Reviewer"], []),
    );

    const counted = snap.byAgent.reduce((n, r) => n + r.agg.entryCount, 0);
    const summed = snap.byAgent.reduce((s, r) => s + r.agg.costUSD, 0);
    assert.equal(counted, entries.length);
    assert.equal(summed, snap.weekly.costUSD);

    // The unattributed turn is a bucket of its own rather than a remainder.
    const main = snap.byAgent.find((r) => r.agent === MAIN_THREAD_BUCKET);
    assert.equal(main?.agg.costUSD, 3);
    assert.equal(main?.origin, "main");

    const byName = new Map(snap.byAgent.map((r) => [r.agent, r]));
    assert.equal(byName.get("Reviewer")?.origin, "registry");
    assert.equal(byName.get("Reviewer")?.agg.costUSD, 3);
    assert.equal(byName.get("general-purpose")?.origin, "unknown");
  });

  it("leaves origin unasked when no lookup is supplied", () => {
    const snap = buildSnapshot([agentEntry(now - HOUR, "Reviewer")], NO_LIMITS, now);
    assert.equal(snap.byAgent[0].origin, null);
  });

  it("splits one run's turns without inventing or dropping any", () => {
    const at = now - HOUR;
    const spend = agentSpend(
      [
        agentEntry(at, undefined, 5),
        agentEntry(at + 1, "Reviewer", 2),
        agentEntry(at + 2, "Explorer", 3),
      ],
      agentOriginIndex(["Reviewer"], []),
    );

    assert.equal(spend.costUSD, 10);
    assert.equal(spend.entryCount, 3);
    // The complement of the main-thread bucket, so the two always add to the
    // total. Named `delegated` historically and asserted as what it is: every
    // row carrying an agent name, whatever put the name there — a turn the
    // session handed off, or, under `--agent`, possibly its own.
    assert.equal(spend.delegatedCostUSD, 5);
    assert.equal(
      spend.rows.reduce((s, r) => s + r.costUSD, 0),
      spend.costUSD,
    );
    assert.deepEqual(
      spend.rows.map((r) => r.agent),
      [MAIN_THREAD_BUCKET, "Explorer", "Reviewer"],
    );
    assert.equal(spend.rows.find((r) => r.agent === "Explorer")?.origin, "unknown");
  });

  it("carries the guard figure beside the displayed one", () => {
    const at = now - HOUR;
    const unpriced: UsageEntry = {
      ...agentEntry(at, "Reviewer", 0),
      costGuardUSD: 4,
      unpriced: true,
    };
    const spend = agentSpend([agentEntry(at + 1, undefined, 1), unpriced], null);

    // The display figure stays a floor — an unpriced model contributes $0 to it
    // — while the guard figure charges the fallback rate, which is the gap the
    // card draws as a hatched band rather than presenting as a correction.
    assert.equal(spend.costUSD, 1);
    assert.equal(spend.costGuardUSD, 5);
    assert.equal(spend.delegatedCostUSD, 0);
    assert.equal(spend.delegatedCostGuardUSD, 4);
  });

  it("reports nothing rather than zero for a run with no turns", () => {
    const spend = agentSpend([], agentOriginIndex([], []));
    assert.equal(spend.costUSD, 0);
    assert.equal(spend.entryCount, 0);
    assert.deepEqual(spend.rows, []);
  });
});

/**
 * The cheaper-model counterfactual on the agent column.
 *
 * It earns a test because everything about it is quiet. It is arithmetic over
 * every turn in the window against a *second* price table lookup, it is
 * date-dependent (Sonnet 5's introductory rate is a different number from its
 * list rate, and which one applies is decided per turn), and it is rendered as
 * a dollar figure beside a real one. Every way of getting it wrong produces a
 * plausible number: a memo keyed too coarsely prices a September turn at
 * August's rate, a bucket missed in the second pass reads as work that would
 * have been free, and `null` collapsing to `0` says the same thing about the
 * whole column on the guard path — which is the one caller that never asks.
 */
describe("cheaper-model counterfactual", () => {
  const tokenEntry = (
    ts: number,
    agent: string | undefined,
    input: number,
  ): UsageEntry => ({
    ...entry(ts, 0),
    agent,
    tokens: { ...ZERO_TOKENS, input },
  });

  it("leaves the figure unasked when no model is named", () => {
    const snap = buildSnapshot(
      [tokenEntry(now - HOUR, "Reviewer", 1_000_000)],
      NO_LIMITS,
      now,
    );
    // Null is "nobody asked", which is the orchestrator's guard path. A 0 there
    // would read as "the same work would have cost nothing".
    assert.equal(snap.counterfactualModel, null);
    assert.equal(snap.byAgent[0].counterfactualUSD, null);
  });

  it("reprices every bucket, and the buckets still add up to the window", () => {
    const at = now - HOUR;
    const entries = [
      tokenEntry(at, undefined, 1_000_000),
      tokenEntry(at + 1, "Reviewer", 2_000_000),
      tokenEntry(at + 2, "Reviewer", 1_000_000),
    ];
    const snap = buildSnapshot(
      entries,
      NO_LIMITS,
      now,
      null,
      null,
      null,
      [],
      "claude-sonnet-5",
    );

    assert.equal(snap.counterfactualModel, "claude-sonnet-5");
    const perToken = costOf(
      { ...ZERO_TOKENS, input: 1_000_000 },
      resolvePrice("claude-sonnet-5", { at }),
    );
    const byName = new Map(snap.byAgent.map((r) => [r.agent, r]));
    assert.equal(byName.get(MAIN_THREAD_BUCKET)?.counterfactualUSD, perToken);
    assert.equal(byName.get("Reviewer")?.counterfactualUSD, perToken * 3);

    // The same reconciliation the cost column makes: every turn is in exactly
    // one bucket, so the rows add to what the whole window would have cost.
    assert.equal(
      snap.byAgent.reduce((s, r) => s + (r.counterfactualUSD ?? 0), 0),
      perToken * 4,
    );
  });

  it("prices each turn at the rate in force on the day it ran", () => {
    // Sonnet 5's introductory rate runs through 2026-08-31 inclusive, so these
    // two turns are the same tokens at two different prices. A memo keyed on
    // anything coarser than the day would give them both the same one — and the
    // whole point of the figure is to inform a decision about *future* work, so
    // a page that quietly extended an expiring rate over it would be wrong in
    // the direction that costs money.
    const intro = Date.UTC(2026, 7, 30, 12);
    const list = Date.UTC(2026, 8, 2, 12);
    const later = Date.UTC(2026, 8, 3, 12);
    const snap = buildSnapshot(
      [
        tokenEntry(intro, "before", 1_000_000),
        tokenEntry(list, "after", 1_000_000),
      ],
      NO_LIMITS,
      later,
      null,
      null,
      null,
      [],
      "claude-sonnet-5",
    );

    const byName = new Map(snap.byAgent.map((r) => [r.agent, r]));
    assert.equal(byName.get("before")?.counterfactualUSD, 2);
    assert.equal(byName.get("after")?.counterfactualUSD, 3);
  });

  it("reprices a turn upwards when the target is dearer than what ran", () => {
    // Correct, and the reason the actual figure stays beside it rather than
    // being replaced: this is a comparison, not a correction.
    const at = now - HOUR;
    const haiku: UsageEntry = {
      ...tokenEntry(at, "cheap", 1_000_000),
      model: "claude-haiku-4-5",
      costUSD: 1,
    };
    const snap = buildSnapshot(
      [haiku],
      NO_LIMITS,
      now,
      null,
      null,
      null,
      [],
      "claude-sonnet-5",
    );
    assert.equal(snap.byAgent[0].agg.costUSD, 1);
    assert.equal((snap.byAgent[0].counterfactualUSD ?? 0) > 1, true);
  });
});

/**
 * The composition reading reaching the snapshot.
 *
 * What this pins is the boundary rather than the arithmetic, which
 * `toolComposition.test.ts` covers: that `byTool` is scoped to the same window
 * the five breakdowns are, that its placement rates come from that window's own
 * aggregate, and that a caller who supplies no calls gets an empty reading
 * rather than a wrong one. The failure it guards against is the quiet kind — a
 * card of tool shares over one span sitting under a table of costs over
 * another, both plausible and describing different weeks.
 */
describe("tool composition on the snapshot", () => {
  const call = (id: string, name: string, ts: number, chars: number): ToolCall => ({
    id,
    ts,
    name,
    isSidechain: false,
    resultChars: chars,
  });

  it("is empty for a caller that supplies none", () => {
    const snap = buildSnapshot([entry(now - HOUR)], NO_LIMITS, now);
    assert.deepEqual(snap.byTool.rows, []);
    assert.equal(snap.byTool.totalCalls, 0);
  });

  it("covers the same window as the breakdowns beside it", () => {
    const at = now - HOUR;
    const snap = buildSnapshot(
      [entry(at)],
      NO_LIMITS,
      now,
      null,
      null,
      null,
      [
        call("old", "Read", now - 8 * 24 * 3_600_000, 500),
        call("new", "Read", at, 300),
      ],
    );

    assert.equal(snap.byTool.from, snap.weekly.startsAt);
    assert.equal(snap.byTool.totalCalls, 1);
    assert.equal(snap.byTool.totalResultChars, 300);
  });

  it("prices placement off the same aggregate the weekly meter reports", () => {
    const at = now - HOUR;
    const rich: UsageEntry = {
      ...entry(at, 5),
      tokens: {
        input: 0,
        output: 10_000,
        cacheRead: 900_000,
        cacheWrite5m: 0,
        cacheWrite1h: 90_000,
      },
    };
    const snap = buildSnapshot([rich], NO_LIMITS, now, null, null, null, [
      call("a", "Bash", at, 10),
    ]);

    assert.equal(snap.byTool.placedTokens, 100_000);
    assert.equal(snap.byTool.reReadRatio, 9);
    assert.equal(
      snap.byTool.costPerMillionPlacedUSD,
      (snap.weekly.costUSD / snap.byTool.placedTokens) * 1_000_000,
    );
    // Denominated in characters and reconciling only to itself. The window
    // total is money and these are not, so no sum across the two is meaningful
    // — which is why nothing on this shape carries a cost at all.
    assert.equal(snap.byTool.rows[0].share, 1);
    assert.equal("costUSD" in snap.byTool.rows[0], false);
  });
});
