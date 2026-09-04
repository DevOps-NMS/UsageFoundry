import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LiveTelemetry,
  LiveTelemetryAside,
  LiveTelemetryTotals,
} from "./LiveTelemetry";
import type { TelemetryWindowDTO } from "../lib/apiTypes";

/**
 * This card puts a first-party dollar figure on a page whose two headline
 * meters are transcript-derived, and the app's central rule is that the three
 * sources are never summed or mixed. Both failure modes here are silent: a card
 * that shows $2.43 beside a $166 meter with the separation sentence lost reads
 * as an addend, and a run list capped at six with nothing saying so reads as the
 * complete set — the same failure `selectForPatch` is tested against in
 * `diff.ts`. Neither throws, logs, or fails a typecheck.
 */

const NOW = 1_700_000_000_000;

function windowOf(over: Partial<TelemetryWindowDTO> = {}): TelemetryWindowDTO {
  return {
    requests: 5,
    costUSD: 2.43,
    tokens: 1_684_600,
    lastAt: NOW - 30_000,
    runCount: 2,
    workingRunCount: 1,
    runs: [
      {
        runId: "aaaa1111-2222-3333-4444-555555555555",
        status: "running",
        requests: 3,
        costUSD: 0.93,
        tokens: 757_100,
        lastAt: NOW - 30_000,
      },
      {
        runId: "bbbb1111-2222-3333-4444-555555555555",
        status: "completed",
        requests: 2,
        costUSD: 1.5,
        tokens: 927_500,
        lastAt: NOW - 1_800_000,
      },
    ],
    ...over,
  };
}

test("the figure never appears without the statement that it is not an addend", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetry telemetry={windowOf()} now={NOW} />,
  );
  assert.match(html, /\$2\.43/, "the first-party total is the card's subject");
  // The three claims that stop it being read as headroom.
  assert.match(html, /Kept apart from the meters above rather than added to them/);
  assert.match(html, /transcript-derived/);
  assert.match(html, /budget guard reads the transcripts, never this/);
});

test("a capped list says how many runs it left out", () => {
  const html = renderToStaticMarkup(
    // Eight runs in the window, six of them listed: what `telemetryWindow`
    // returns once TOP_RUNS bites.
    <LiveTelemetry telemetry={windowOf({ runCount: 8 })} now={NOW} />,
  );
  assert.match(html, /6 cheaper runs are in the total above but not listed/);
});

test("a complete list claims nothing about omissions", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetry telemetry={windowOf()} now={NOW} />,
  );
  assert.doesNotMatch(html, /not listed/);
});

test("a run with no matching row reads as unknown, not as a status", () => {
  const telemetry = windowOf();
  const html = renderToStaticMarkup(
    <LiveTelemetry
      telemetry={{
        ...telemetry,
        runCount: 1,
        workingRunCount: 0,
        runs: [{ ...telemetry.runs[0], status: null }],
      }}
      now={NOW}
    />,
  );
  // Anchored on the cell, not on the document: the card title and the closing
  // footnote each carry an em-dash of their own, so a bare /—/ is satisfied
  // before the table body is reached and a component that rendered an *empty*
  // cell for a null status would pass it. The null branch is a bare dash as the
  // only child of its `Td`, which is what `>—<` picks out.
  assert.match(html, />—</, "the unknown status is a dash in its own cell");
  // Against the badge markup rather than the bare word, so this does not start
  // depending on "running" being absent from unrelated copy on the card.
  assert.doesNotMatch(
    html,
    /<span[^>]*>running<\/span>/,
    "no status may be invented for it",
  );
});

test("a run with a status wears it, so the dash is not what every cell says", () => {
  // The control half of the test above, for the reason `haltedMembers.test.ts`
  // carries three: a status cell that rendered a dash whatever it was handed
  // satisfies the unknown case just as happily, and the two assertions only
  // mean something as a pair.
  const telemetry = windowOf();
  const html = renderToStaticMarkup(
    <LiveTelemetry
      telemetry={{
        ...telemetry,
        runCount: 1,
        runs: [telemetry.runs[0]],
      }}
      now={NOW}
    />,
  );
  assert.match(html, /<span[^>]*>running<\/span>/, "a known status is a badge");
  assert.doesNotMatch(html, />—</, "and it is not also an unknown");
});

test("nothing is described as working when no run is", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetry telemetry={windowOf({ workingRunCount: 0 })} now={NOW} />,
  );
  assert.doesNotMatch(html, /working/);
});

/**
 * The aside is the same claim at the one place it is hardest to make. In the
 * band, a lost separation sentence leaves a first-party figure under its own
 * heading, four thousand pixels from a meter. Beside the meters it leaves one
 * against the other with nothing in between, which is the arithmetic the
 * provenance bands were built to make impossible — and the top of the page is
 * where a figure gets quoted from.
 */
test("the aside's figure never appears without the statement that it is not an addend", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetryAside telemetry={windowOf()} now={NOW} />,
  );
  assert.match(html, /\$2\.43/, "the first-party total is the card's subject");
  // The same three claims the band's footnote carries, and the one word that
  // has to differ: beside the meters, "above" would point at the page header.
  assert.match(html, /Not added to the meters beside it/);
  assert.match(html, /transcript-derived/);
  assert.match(html, /budget guard reads the transcripts, never this/);
});

test("the aside names the source of its figure, not just the figure", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetryAside telemetry={windowOf()} now={NOW} />,
  );
  // A dollar amount in the top row with no provenance on it is read as one more
  // reading of the window the card next to it meters. The title is what says
  // otherwise before the footnote is reached, so it is pinned separately.
  assert.match(html, /Live from runs — first-party/);
});

test("both cards draw one reading of the totals, not two", () => {
  const telemetry = windowOf();
  // Rendered standalone and looked for verbatim inside each card: the assertion
  // is not that the two agree today but that there is one component producing
  // them, which is the only form of "cannot disagree" that survives an edit to
  // either card. Re-inlining the figures into either one fails this.
  const totals = renderToStaticMarkup(
    <LiveTelemetryTotals telemetry={telemetry} now={NOW} />,
  );
  assert.ok(
    renderToStaticMarkup(
      <LiveTelemetry telemetry={telemetry} now={NOW} />,
    ).includes(totals),
    "the band draws the shared totals",
  );
  assert.ok(
    renderToStaticMarkup(
      <LiveTelemetryAside telemetry={telemetry} now={NOW} />,
    ).includes(totals),
    "and the aside draws the same ones",
  );
});

test("nothing is described as working on the aside when no run is", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetryAside
      telemetry={windowOf({ workingRunCount: 0 })}
      now={NOW}
    />,
  );
  assert.doesNotMatch(html, /working/);
});
