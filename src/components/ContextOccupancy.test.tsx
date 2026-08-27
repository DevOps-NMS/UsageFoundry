import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextOccupancy } from "./ContextOccupancy";
import type {
  ContextOccupancyDTO,
  ContextPruneMarkDTO,
  ContextSampleDTO,
} from "../lib/apiTypes";

/**
 * Four failure modes, all silent, all of which render a picture that looks
 * entirely ordinary:
 *
 *  - A percentage computed against a hardcoded 200,000. `CYCLE_CONTEXT_CEILING_TOKENS`
 *    has already moved twice, which is why it travels on the DTO at all; a
 *    component that divided by a literal would go on drawing the old number
 *    after the next move, with nothing to say it had.
 *  - A run with no readings drawn as a 0% fill. "Nothing measured" and "measured
 *    at nothing" are opposite statements and the same empty bar.
 *  - A fall in the line with no mark under it. That is what an operator reads as
 *    a bug in the graph rather than as the prune mechanism working, which is the
 *    single most useful thing this picture says.
 *  - The caption's currency sentence going missing. This page carries token
 *    figures in two bases that differ by tens of thousands in **both**
 *    directions, and the arithmetic across them typechecks.
 *
 * `LiveTelemetry.test.tsx` is the precedent for the last one: a component whose
 * copy is load-bearing gets that copy pinned.
 */

const NOW = 1_700_000_000_000;
/** Half a real ceiling, so nothing here matches what a literal 200,000 gives. */
const CEILING = 120_000;

function sample(over: Partial<ContextSampleDTO> = {}): ContextSampleDTO {
  return {
    ts: NOW - 60_000,
    iteration: 1,
    tokens: 40_000,
    basis: "api",
    turnIndex: 4,
    turnsExact: true,
    ...over,
  };
}

/** Three readings a thousand milliseconds apart, so a prune's x is arithmetic. */
function series(over: Partial<ContextOccupancyDTO> = {}): ContextOccupancyDTO {
  const samples = [
    sample({ ts: NOW - 2_000, tokens: 30_000 }),
    sample({ ts: NOW - 1_000, tokens: 90_000, iteration: 2 }),
    sample({ ts: NOW, tokens: 60_000, iteration: 2 }),
  ];
  return {
    ceilingTokens: CEILING,
    samples,
    sampleCount: samples.length,
    prunes: [],
    pruneCount: 0,
    ...over,
  };
}

function prune(over: Partial<ContextPruneMarkDTO> = {}): ContextPruneMarkDTO {
  return { ts: NOW - 1_000, trigger: "boundary", tokensRemoved: 44_000, ...over };
}

function render(context: ContextOccupancyDTO, live = true): string {
  return renderToStaticMarkup(
    <ContextOccupancy context={context} now={NOW} live={live} />,
  );
}

test("the percentage is against the ceiling the DTO reports, never a literal", () => {
  const html = render(series());
  // 60,000 of 120,000. A hardcoded 200,000 would put the same run at 30%.
  assert.match(html, /50\.0%/, "the reading is against ceilingTokens");
  assert.match(html, /aria-valuenow="50"/);
  assert.doesNotMatch(html, /30\.0%/, "200,000 is not the denominator");
  assert.doesNotMatch(html, /aria-valuenow="30"/);
  // And the ceiling is named in the legend at the value it was given, so the
  // denominator is on screen rather than only in the arithmetic.
  assert.match(html, /ceiling 120\.0k/);
});

test("a ceiling that moves moves the reading with it", () => {
  // The control half of the test above: a component that ignored the DTO and
  // divided by a literal would pass the first one for any ceiling that happened
  // to be 120,000, and this is what separates the two.
  const html = render(series({ ceilingTokens: 240_000 }));
  assert.match(html, /25\.0%/);
  assert.match(html, /ceiling 240\.0k/);
  assert.doesNotMatch(html, /50\.0%/);
});

test("a run with no readings says so instead of drawing a zero", () => {
  const html = render(
    series({ samples: [], sampleCount: 0, prunes: [prune()], pruneCount: 1 }),
  );
  // `Meter`'s vocabulary for "no figure": hatched, and no value claimed.
  assert.match(html, /not measured yet/);
  assert.match(html, /hatched/);
  assert.doesNotMatch(html, /aria-valuenow/, "no percentage may be asserted");
  assert.doesNotMatch(html, /0\.0%/, "an unmeasured run is not a run at zero");
  assert.doesNotMatch(html, /bg-ok|bg-warn|bg-danger/);
  // The prune it did record is still accounted for rather than dropped.
  assert.match(html, /1 prune is[\s\S]*recorded, with no series to mark[\s\S]*it on/);
});

test("a single reading is a reading, and says it has no shape yet", () => {
  const one = sample({ ts: NOW, tokens: 60_000 });
  const html = render(series({ samples: [one], sampleCount: 1 }));
  // It is a real measurement, so the indicator is real.
  assert.match(html, /50\.0%/);
  assert.match(html, /aria-valuenow="50"/);
  assert.doesNotMatch(html, /hatched/);
  // But nothing about a trend may be implied.
  assert.match(html, /One reading so far; the line appears from the second/);
  assert.match(html, /one reading so far/, "and the same in the text alternative");
  assert.match(html, /No shape yet/);
});

test("a finished run's last point is a final reading, not a stale poll", () => {
  const live = render(series(), true);
  assert.match(live, /read /, "a live run says how old its reading is");
  assert.doesNotMatch(live, /final reading/);

  const done = render(series(), false);
  assert.match(done, /final reading/);
});

test("a prune is marked at the moment the DTO gives it", () => {
  // The span is 2,000ms across a 314-unit plot inset 3 from the left edge, so a
  // cut at the midpoint lands at 160 and one at a quarter lands at 81.5. Pinned
  // as geometry rather than as "a mark exists": a marker drawn at a fixed
  // offset, or against the wrong end of the span, still renders a mark.
  const html = render(
    series({
      prunes: [prune({ ts: NOW - 1_000 }), prune({ ts: NOW - 1_500 })],
      pruneCount: 2,
    }),
  );
  assert.match(html, /M160 5V46/, "the midpoint cut is drawn at the midpoint");
  assert.match(html, /M81\.5 5V46/, "and the quarter cut at the quarter");
  // Not colour alone: each mark carries a triangle at the baseline as well as
  // the rule, and the legend names it.
  assert.match(html, /M160 47\.5L163 54L157 54Z/);
  assert.match(html, /2 prunes/);
});

test("a prune outside the drawn span is counted, never pinned to an edge", () => {
  // Samples and prune marks are capped independently on the wire, so a long run
  // can return a cut older than its oldest returned reading. Clamping it to the
  // first point would state a time the cut did not happen.
  const html = render(
    series({ prunes: [prune({ ts: NOW - 90_000 })], pruneCount: 1 }),
  );
  assert.doesNotMatch(html, /V46/, "nothing may be marked inside the span");
  assert.match(html, /1 prune falls[\s\S]*outside the span drawn/);
  assert.match(html, /No prune falls inside this span/, "and the alternative says so");
});

test("the caption keeps the two token currencies apart", () => {
  const html = render(series());
  // The load-bearing sentence: this page carries a prune's `tokensRemoved` in
  // `contextTokens` and this series in `apiContextTokens`, and the difference
  // runs in both directions.
  assert.match(html, /The pruning figures on this page are in the transcript/);
  assert.match(html, /own turns instead/);
  assert.match(html, /either side of this in both/);
  assert.match(html, /must not be subtracted from anything here/);
  // And the two facts a reader needs to place the number at all.
  assert.match(html, /the whole prompt as the API was billed/i);
  assert.match(html, /lags one turn by construction/);
});

test("the sr-only prune table repeats the currency warning at its own figures", () => {
  const html = render(series({ prunes: [prune()], pruneCount: 1 }));
  assert.match(html, /sr-only/);
  assert.match(html, /44\.0k tokens/);
  assert.match(html, /at a work-cycle boundary/);
  assert.match(html, /never how far the line should drop/);
});

test("an unknown trigger renders as itself rather than as a guess", () => {
  const html = render(
    series({ prunes: [prune({ trigger: "something-new" })], pruneCount: 1 }),
  );
  assert.match(html, /something-new/);
});

test("a fallback reading is not presented as the same measurement", () => {
  const context = series();
  const html = render({
    ...context,
    samples: [
      { ...context.samples[0], basis: "transcript" },
      context.samples[1],
      context.samples[2],
    ],
  });
  // Drawn as a hollow square rather than a dot on the same line.
  assert.match(html, /fill-surface stroke-accent/);
  assert.match(html, /1 byte estimate/, "and named in the legend");
  assert.match(html, /a different measure rather than a[\s\S]*rougher one/);
});

test("a fallback as the newest reading qualifies the headline figure itself", () => {
  const context = series();
  const html = render({
    ...context,
    samples: [
      context.samples[0],
      context.samples[1],
      { ...context.samples[2], basis: "transcript" },
    ],
  });
  assert.match(html, /This last reading had no usage frame to read/);
  assert.match(
    html,
    /the percentage above is against a quantity the rest of[\s\S]*the series is not in/,
  );
});

test("an all-api series claims nothing about a fallback", () => {
  // The control for the two above: a component that printed the qualification
  // unconditionally would satisfy both and mean nothing.
  const html = render(series());
  assert.doesNotMatch(html, /byte estimate/);
  assert.doesNotMatch(html, /fill-surface stroke-accent/);
});

test("a series holding the end of a longer one says which end", () => {
  const html = render(series({ sampleCount: 900 }));
  assert.match(html, /Drawn from the newest 3 of 900 readings/);
  assert.match(html, /the end of the series, not a thinning of it/);
});

test("a complete series claims no tail", () => {
  const html = render(series());
  assert.doesNotMatch(html, /Drawn from the newest/);
});

test("the dots stand down on a long run, and the caption says they have", () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    sample({ ts: NOW - (79 - i) * 1_000, tokens: 30_000 + i * 100 }),
  );
  const html = render(series({ samples: many, sampleCount: 80 }));
  // One dot: the newest reading, which is the point the indicator above names.
  assert.equal(html.match(/<circle/g)?.length, 1);
  assert.match(html, /the per-point dots stand down/);
  assert.match(html, /still passes through every one of them/);

  // And a short run draws them all, so the clause above is not always true.
  const short = render(series());
  assert.equal(short.match(/<circle/g)?.length, 3);
  assert.doesNotMatch(short, /dots stand down/);
});

test("the series is not sighted-only", () => {
  const html = render(series({ prunes: [prune()], pruneCount: 1 }));
  assert.match(html, /role="img"/);
  // The shape and its notable points, which is what a sparkline's alternative
  // is — the marks themselves are the table below it.
  assert.match(html, /aria-label="Context occupancy: 3 readings/);
  assert.match(html, /starts at 30\.0k \(25%\)/);
  assert.match(html, /peaks at 90\.0k \(75%\)/);
  assert.match(html, /is now 60\.0k \(50%\)/);
  assert.match(html, /1 prune is marked inside it/);
});

test("a ceiling of zero is refused rather than divided by", () => {
  // Not reachable from `contextOccupancy` today, but the DTO's type permits it
  // and `x / 0` is `Infinity` — which `Meter` would treat as unknown by
  // accident rather than because anything here checked.
  const html = render(series({ ceilingTokens: 0 }));
  assert.match(html, /hatched/);
  assert.match(html, /no ceiling reported/);
  assert.doesNotMatch(html, /aria-valuenow/);
  // The reading itself is still real and still shown.
  assert.match(html, /60\.0k/);
});
