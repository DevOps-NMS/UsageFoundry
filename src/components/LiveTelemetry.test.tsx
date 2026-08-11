import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveTelemetry } from "./LiveTelemetry";
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
  assert.match(html, /—/);
  assert.doesNotMatch(html, /running/, "no status may be invented for it");
});

test("nothing is described as working when no run is", () => {
  const html = renderToStaticMarkup(
    <LiveTelemetry telemetry={windowOf({ workingRunCount: 0 })} now={NOW} />,
  );
  assert.doesNotMatch(html, /working/);
});
