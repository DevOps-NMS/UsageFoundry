import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextOccupancy } from "./ContextOccupancy";
import type {
  ContextCheckDTO,
  ContextCompositionDTO,
  ContextOccupancyDTO,
  ContextPruneMarkDTO,
  ContextSampleDTO,
} from "../lib/apiTypes";

/**
 * Five failure modes, all silent, all of which render a picture that looks
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
 *  - The caption rendering as an empty paragraph. Its standing prose was removed
 *    — the operator read it as wall-of-text — so every clause left in it is
 *    conditional, and a `<p>` with no children still takes its bottom margin
 *    under the chart. Its currency sentence went with the prose, and with it the
 *    assertion that used to pin that sentence: the hazard it named is unchanged
 *    and now lives only in `ContextOccupancy.tsx`'s module doc and in the
 *    sr-only prune table's warning at its own figures.
 *  - The age drawn against the newest *point* rather than the newest *read*.
 *    Samples are deduplicated on the `usage` frame they came from, so a run
 *    inside one sub-agent gains none for as long as that lasts — 22 minutes,
 *    measured on this install — and the panel then reported a poll that had
 *    died over a figure that was current. Both halves are pinned: the age comes
 *    off `lastCheck`, and the hold is named rather than left to be inferred
 *    from an age that no longer moves.
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
    // Read on the same tick that wrote the newest point, which is the ordinary
    // steady state: the cases below are the ones where it is not.
    lastCheck: { ts: NOW, basis: "api" },
    // The default is a run whose composition has not been read yet, so every
    // case above stays a case about the series alone. The composition's own are
    // the ones that pass it.
    composition: [],
    compositionCount: 0,
    compositionAbsence: "pending",
    ...over,
  };
}

/**
 * One composition reading. `window` deliberately differs from the sample at the
 * same instant — that is the divergence the panel exists to keep apart, not a
 * mistake in the fixture.
 */
function reading(over: Partial<ContextCompositionDTO> = {}): ContextCompositionDTO {
  return {
    ts: NOW,
    iteration: 2,
    window: 100_000,
    slices: [
      { label: "tool traffic", tokens: 50_000, kind: "estimated" },
      { label: "prefix", tokens: 30_000, kind: "derived" },
      { label: "retained reasoning", tokens: 12_000, kind: "derived" },
      { label: "standing configuration", tokens: 5_000, kind: "estimated" },
      { label: "conversation", tokens: 2_000, kind: "estimated" },
      { label: "unattributed", tokens: 1_000, kind: "residual" },
    ],
    ...over,
  };
}

/** A tick that looked, at a time of its own. */
function check(over: Partial<ContextCheckDTO> = {}): ContextCheckDTO {
  return { ts: NOW, basis: "api", ...over };
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
  assert.match(html, /one reading so far/, "said in the text alternative");
  assert.match(html, /No shape yet/);
});

test("a finished run's last point is a final reading, not a stale poll", () => {
  const live = render(series(), true);
  assert.match(live, /read /, "a live run says how old its reading is");
  assert.doesNotMatch(live, /final reading/);

  const done = render(series(), false);
  assert.match(done, /final reading/);
});

/**
 * A run that has spent 22 minutes inside one sub-agent, which is the case
 * measured on this install: the tick read the transcript 22 times, found the
 * same `usage` frame every time and wrote no row, and the figure it found was
 * correct throughout — a sub-agent's turns are not this conversation's context.
 */
function heldSeries(over: Partial<ContextOccupancyDTO> = {}): ContextOccupancyDTO {
  // The read is 20 seconds old and the newest point is 22 minutes older than
  // the read, so the two ages are separable in the output rather than differing
  // by a rounding.
  const read = NOW - 20_000;
  const held = [
    sample({ ts: read - 24 * 60_000, tokens: 30_000 }),
    sample({ ts: read - 22 * 60_000, tokens: 60_000 }),
  ];
  return series({
    samples: held,
    sampleCount: held.length,
    lastCheck: check({ ts: read }),
    ...over,
  });
}

test("the age is the tick's, not the newest point's", () => {
  const html = render(heldSeries());
  // 20 seconds since the read, so the age rounds to nothing. The bug this
  // replaces put "22m ago" here — a dead poll over a live figure.
  assert.match(html, /read just now/);
  assert.doesNotMatch(html, /read 22m ago/, "the point's own age is not the read's");
  assert.doesNotMatch(html, /read 22m/, "nor anywhere near it");
  // And the gap is named rather than left to be inferred from an age that has
  // stopped moving, which is the half that makes the first one readable.
  assert.match(html, /unchanged for 22m 0s/);
  assert.match(
    html,
    /main thread<\/em> finishes another request/,
    "and the caption says why a live run's figure can sit still",
  );
});

test("a gap inside one read interval is not worth naming", () => {
  // Two minutes is the ceiling on the read itself, so anything under it is one
  // tick that found the same frame — the ordinary case on any tool call, and a
  // "unchanged for" on every second run is noise that trains an operator to
  // stop reading the line.
  const html = render(
    heldSeries({
      samples: [sample({ ts: NOW - 2 * 60_000 - 20_000, tokens: 60_000 })],
      sampleCount: 1,
      lastCheck: check({ ts: NOW - 20_000 }),
    }),
  );
  assert.doesNotMatch(html, /unchanged for/);
});

test("with no read reported the age falls back to the point's own", () => {
  // A server restarted mid-run has read nothing yet. Borrowing the previous
  // process's reading would be exactly the freshness `lastCheck` exists to stop
  // this panel inventing, so it says what it did before the field existed.
  const html = render(heldSeries({ lastCheck: null }));
  assert.match(html, /read 22m ago/);
  assert.doesNotMatch(html, /unchanged for/, "there is no read to hold against");
});

test("a read that found nothing is not a fresh reading", () => {
  // `unreadable` is a different statement from a figure that has not moved, and
  // "read just now" over a number nothing could confirm is the one wording that
  // would leave this panel worse than absent.
  const html = render(
    heldSeries({ lastCheck: check({ ts: NOW - 20_000, basis: "unreadable" }) }),
  );
  assert.match(html, /last read just now found nothing to read/);
  assert.doesNotMatch(html, /read just now ·/);
});

test("a finished run is not given an age at all", () => {
  // Its tick stopped when it did, so an age would count up for ever against a
  // number nothing is going to change.
  const html = render(heldSeries(), false);
  assert.match(html, /final reading/);
  assert.doesNotMatch(html, /unchanged for/);
  assert.doesNotMatch(html, /read /);
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

test("a caption with nothing to say renders nothing at all", () => {
  // Every clause under the chart is conditional now that the standing prose is
  // gone, so the ordinary steady state — a complete, current, all-api series —
  // owes the reader no paragraph, and an empty <p> would still take its own
  // bottom margin under the chart.
  const html = render(series());
  // Counted rather than asserted absent: `max-w-[68ch]` is this panel's prose
  // class, and the composition stack under the chart renders one line in it for
  // a run whose composition has not been read yet. A caption that emitted an
  // empty <p> anyway would be the second.
  assert.equal(
    html.match(/max-w-\[68ch\]/g)?.length,
    1,
    "no caption element is emitted",
  );
  assert.match(
    html,
    /What the window is made of is taken on the guard tick/,
    "and the one paragraph that is there is the stack's",
  );
  // What the panel is for is untouched by that.
  assert.match(html, /50\.0%/);
  assert.match(html, /role="img"/);
});

test("the first clause that renders opens the paragraph", () => {
  // Each clause carried a leading separator because prose ran before it. With
  // the prose gone, whichever one comes first must not start with a space, and
  // any two that render together must still be separated by one — a leading
  // space indents the paragraph against every other block in the region, and a
  // missing one runs two sentences together.
  const held = render(heldSeries());
  assert.match(held, /leading-snug text-ink-muted">Nothing has moved it for/);

  const context = series({ sampleCount: 900 });
  const two = render({
    ...context,
    samples: [
      context.samples[0],
      context.samples[1],
      { ...context.samples[2], basis: "transcript" },
    ],
  });
  assert.match(two, /text-ink-muted">This last reading had no usage frame/);
  assert.match(two, /the series is not in\. Drawn from the newest 3 of 900/);
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

/* ------------------------------------------------------------------ */
/* The composition stack                                               */
/* ------------------------------------------------------------------ */

test("the bands are ordered once over the series, not per reading", () => {
  // Winnow sorts its nodes largest-first *per reading*, so a provenance that
  // overtakes another mid-run arrives in a different position in the array.
  // Stacked in arrival order the two bands swap places and cross, which reads
  // as one provenance turning into another — a picture of a thing that did not
  // happen, drawn from correct data.
  const early = reading({
    ts: NOW - 1_000,
    window: 100_000,
    slices: [
      { label: "prefix", tokens: 60_000, kind: "derived" },
      { label: "tool traffic", tokens: 40_000, kind: "estimated" },
    ],
  });
  const late = reading({
    window: 200_000,
    slices: [
      { label: "tool traffic", tokens: 140_000, kind: "estimated" },
      { label: "prefix", tokens: 60_000, kind: "derived" },
    ],
  });
  const html = render(
    series({ composition: [early, late], compositionCount: 2, compositionAbsence: null }),
  );

  // `tool traffic` totals 180,000 against `prefix`'s 120,000, so it is band 1
  // at both readings however the arrays arrived.
  const bands = [...html.matchAll(/class="fill-band-(\d)[^"]*"[^>]*>\s*<title>([^<]+?) —/g)];
  assert.deepEqual(
    bands.map((m) => [m[1], m[2]]),
    [
      ["1", "tool traffic"],
      ["2", "prefix"],
    ],
  );
});

test("the residual is the top band whatever its size", () => {
  // It is the one band whose height is a statement about the measurement rather
  // than about the conversation. Sorted by size alone it lands in the middle of
  // two real provenances and reads as a third one.
  const html = render(
    series({
      composition: [
        reading({
          window: 100_000,
          slices: [
            { label: "tool traffic", tokens: 50_000, kind: "estimated" },
            { label: "unattributed", tokens: 40_000, kind: "residual" },
            { label: "conversation", tokens: 10_000, kind: "estimated" },
          ],
        }),
      ],
      compositionCount: 1,
      compositionAbsence: null,
    }),
  );
  const bands = [...html.matchAll(/<title>([^<]+?) —/g)].map((m) => m[1]);
  assert.deepEqual(bands, ["tool traffic", "conversation", "unattributed"]);
});

test("a lone reading is drawn as a column and not as an area", () => {
  // One point stretched across the box asserts this composition held for the
  // whole span, which is the one claim a single measurement cannot make — and
  // it is indistinguishable from a flat run.
  const html = render(
    series({
      composition: [reading()],
      compositionCount: 1,
      compositionAbsence: null,
    }),
  );
  // The column is 44 wide about the midpoint of a 320 box: 138 to 182.
  assert.match(html, /M138 /, "the column is drawn at its own width");
  assert.match(html, /H182/);
});

test("the stack is drawn against winnow's own window", () => {
  // Both charts are in tokens, both are the same measure, and they are anchored
  // differently — the sample excludes sidechains and winnow does not — so they
  // part company for as long as a sub-agent runs. Scaling the bands onto the
  // sample's figure would make them agree by construction, and the bands would
  // then apportion a total they were never measured against.
  const html = render(
    series({
      composition: [reading()],
      compositionCount: 1,
      compositionAbsence: null,
    }),
  );
  // 50,000 of winnow's 100,000 is half the box, where against the sample's
  // 60,000 it would be five sixths.
  assert.match(html, /the window was 100\.0k tokens/);
});

test("pruning switched off is not a run that has nothing to show yet", () => {
  // Two blanks that look identical on the page and have opposite fixes: one is
  // waiting for growth, the other is winnow deliberately never being spawned
  // against this conversation.
  const off = render(series({ compositionAbsence: "off" }));
  assert.match(off, /context pruning is switched off/);
  assert.doesNotMatch(off, /paced by/);

  const pending = render(series({ compositionAbsence: "pending" }));
  assert.match(pending, /paced by\s+how far the conversation has grown/);
  assert.doesNotMatch(pending, /switched off/);
});

test("the stack is not sighted-only", () => {
  const html = render(
    series({
      composition: [reading()],
      compositionCount: 1,
      compositionAbsence: null,
    }),
  );
  // The shape in words, and the figures as rows — the split the sparkline
  // already makes, because six trajectories is not a sentence anyone can hold.
  assert.match(html, /aria-label="What the context is made of, over 1 reading/);
  assert.match(html, /tool traffic 50\.0k \(50%\)/);
  assert.match(html, /How it was reached/);
  // `kind` reaches a reader here and nowhere else: no fill can carry whether a
  // figure was read, subtracted or estimated.
  assert.match(html, /residual/);
});
