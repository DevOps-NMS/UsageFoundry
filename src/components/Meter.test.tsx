import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Meter } from "./Meter";

/**
 * The one invariant in this app that is expressed purely in styling: an
 * unconfigured ceiling must render as a hatched indeterminate bar, never as a
 * bar that looks like a reading.
 *
 * It earns a test on the same grounds as the others in this repo — the failure
 * is silent and expensive. `severityFor(null)` returns "ok" and an unknown
 * fill is clamped to full width, so the two ways of getting this wrong are an
 * empty bar reading "0% used, plenty left" and a solid green bar reading
 * "100% and fine". Both are the opposite of "we don't know", and neither
 * throws, logs, or fails a typecheck.
 */

test("no ceiling renders hatched, never as a severity colour", () => {
  const html = renderToStaticMarkup(<Meter label="Session" fraction={null} />);
  assert.match(html, /hatched/, "unknown fill must be hatched");
  assert.doesNotMatch(html, /bg-ok/, "unknown must not read as a healthy bar");
  assert.doesNotMatch(html, /bg-warn|bg-danger/);
  // No number may be claimed for a window with no ceiling.
  assert.match(html, /no ceiling set/);
  assert.doesNotMatch(html, /aria-valuenow/);
});

test("a known fraction renders its severity colour and no hatch", () => {
  const html = renderToStaticMarkup(<Meter label="Session" fraction={0.95} />);
  assert.match(html, /bg-danger/);
  assert.doesNotMatch(html, /hatched/);
  assert.match(html, /aria-valuenow="95"/);
});

test("severity thresholds map to the three fills", () => {
  const at = (f: number) => renderToStaticMarkup(<Meter label="w" fraction={f} />);
  assert.match(at(0.5), /bg-ok/);
  assert.match(at(0.7), /bg-warn/);
  assert.match(at(0.9), /bg-danger/);
});

test("an unpriced-model band is hatched and sits behind the solid fill", () => {
  const html = renderToStaticMarkup(
    <Meter label="Session" fraction={0.4} upperFraction={0.8} />,
  );
  // Both readings are shown, so a run refused above the visible bar is explicable.
  assert.match(html, /40\.0%/);
  assert.match(html, /80\.0%/);
  assert.match(html, /hatched/);
  assert.match(html, /bg-ok/);
  assert.ok(
    html.indexOf("hatched") < html.indexOf("bg-ok"),
    "hatched band must be emitted first so the solid fill paints over it",
  );
});

test("an upper reading equal to or below the known one draws no band", () => {
  // The normal, fully-priced case: a zero-width hatch would be visual noise.
  const equal = renderToStaticMarkup(
    <Meter label="w" fraction={0.4} upperFraction={0.4} />,
  );
  assert.doesNotMatch(equal, /hatched/);
});
