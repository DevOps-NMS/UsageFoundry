import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsagePeriods } from "./UsagePeriods";
import type { PeriodBucketDTO, PeriodSeriesDTO } from "../lib/apiTypes";

/**
 * This card prints a percentage against a ceiling Anthropic does not publish.
 *
 * A week is measured against the weekly ceiling as it stands, and that is a
 * plain reading. A day and a month are measured against that same ceiling
 * spread over their own length, which is a *pace* — on the transcripts this was
 * written against, one real day reads 254% of a pro-rated $314. Without the
 * sentence saying where the number came from, that is a reader being told they
 * have blown through two and a half times an allowance that does not exist, and
 * the failure is silent in both directions: the sentence attached to a weekly
 * view would instead imply the weekly window is unguarded, which is the
 * opposite of true. Nothing throws, nothing fails a typecheck, and the number
 * beside it is correct either way.
 *
 * `limitBasis` is what selects the wording and it comes off the same
 * computation that produced `fraction`, so what these tests pin is that the two
 * cannot be wired apart.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 12, 10, 0);

function bucket(over: Partial<PeriodBucketDTO> = {}): PeriodBucketDTO {
  return {
    key: "day:1",
    startsAt: NOW - 10 * HOUR,
    endsAt: NOW + 14 * HOUR,
    costUSD: 798.05,
    tokens: 899_089_689,
    entryCount: 5815,
    fraction: 2.539,
    fractionMetric: "cost",
    guardFraction: 2.539,
    limit: 100,
    isCurrent: true,
    ...over,
  };
}

function series(over: Partial<PeriodSeriesDTO> = {}): PeriodSeriesDTO {
  return {
    granularity: "day",
    timeZone: "Europe/Berlin",
    limitBasis: "prorated",
    buckets: [bucket()],
    ...over,
  };
}

function render(s: PeriodSeriesDTO) {
  return renderToStaticMarkup(
    <UsagePeriods
      series={s}
      granularity={s.granularity}
      onGranularityChange={() => {}}
      reservedHeadroomFraction={0}
    />,
  );
}

test("a pro-rated percentage never appears without saying it is a pace", () => {
  const html = render(series());
  assert.match(html, /253\.9%/, "the reading is the card's subject");
  assert.match(html, /your weekly ceiling spread over 1 day/);
  assert.match(html, /Anthropic sets no daily limit/);
  assert.match(html, /pace rather than an allowance/);
});

test("a month names its own length, not a fixed multiple of a week", () => {
  const html = render(
    series({
      granularity: "month",
      buckets: [
        // The span is read off the bucket, not off the granularity — August is
        // 31 days and February is 28, and a fixed 30 would print a ceiling
        // nobody's arithmetic produces.
        bucket({
          startsAt: Date.UTC(2026, 7, 1),
          endsAt: Date.UTC(2026, 8, 1),
          limit: 3100,
          fraction: 0.401,
        }),
      ],
    }),
  );
  assert.match(html, /spread over 31 days/);
  assert.match(html, /Anthropic sets no monthly limit/);
});

test("a week is not described as a pace, and is not called unguarded", () => {
  const html = render(
    series({
      granularity: "week",
      limitBasis: "weekly",
      buckets: [bucket({ limit: 700, fraction: 0.5 })],
    }),
  );
  assert.match(html, /Ceiling: \$700\.00 for the week/);
  assert.doesNotMatch(html, /spread over/);
  assert.doesNotMatch(
    html,
    /No budget guard reads/,
    "the weekly window is guarded — saying otherwise here inverts it",
  );
});

test("the reserve is named, so the ceiling matches what Settings shows", () => {
  const html = renderToStaticMarkup(
    <UsagePeriods
      series={series()}
      granularity="day"
      onGranularityChange={() => {}}
      reservedHeadroomFraction={0.15}
    />,
  );
  assert.match(html, /after reserved headroom/);
});

test("no ceiling reads as unknown, never as a percentage", () => {
  const html = render(
    series({
      limitBasis: null,
      buckets: [bucket({ limit: null, fraction: null, guardFraction: null })],
    }),
  );
  assert.match(html, /no weekly ceiling set/);
  assert.match(html, /Set a weekly ceiling in Settings/);
  assert.doesNotMatch(html, /0\.0%/, "an unknown share is not zero");
});

test("the guard's higher reading is shown wherever it exceeds the known one", () => {
  const html = render(
    series({
      buckets: [bucket({ fraction: 0.4, guardFraction: 0.9 })],
    }),
  );
  // Same rule the meter's hatched band follows: a run refused at a threshold
  // the visible figure has not reached needs the gap on screen.
  assert.match(html, /40\.0%/);
  assert.match(html, /90\.0%/);
});
