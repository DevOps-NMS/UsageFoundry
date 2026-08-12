import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Meter, type MeterSize } from "./Meter";

const SIZES: MeterSize[] = ["compact", "default", "hero"];

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

/**
 * The size variants are the only thing standing between the invariant above and
 * a third lookup map, so each one is checked rather than only the default. A
 * size that forgot the `known` short-circuit — or that reached the fill class
 * through an interpolated string, which Tailwind emits as nothing — would leave
 * exactly one meter on the page painting an unknown window as a healthy one.
 */
test("the unknown state survives every size", () => {
  for (const size of SIZES) {
    const html = renderToStaticMarkup(
      <Meter label="Session" fraction={null} size={size} />,
    );
    assert.match(html, /hatched/, `${size}: unknown fill must be hatched`);
    assert.doesNotMatch(html, /bg-ok|bg-warn|bg-danger/, `${size}: no severity`);
    assert.match(html, /no ceiling set/, `${size}: must say it is unknown`);
    assert.doesNotMatch(html, /aria-valuenow/, `${size}: claims no value`);
  }
});

test("every size still colours a known reading by severity", () => {
  for (const size of SIZES) {
    const html = renderToStaticMarkup(
      <Meter label="Session" fraction={0.95} size={size} />,
    );
    assert.match(html, /bg-danger/, `${size}: severity fill`);
    assert.doesNotMatch(html, /hatched/, `${size}: no hatch on a known bar`);
  }
});

test("size selects a track height rather than interpolating one", () => {
  const at = (size: MeterSize) =>
    renderToStaticMarkup(<Meter label="w" fraction={0.5} size={size} />);
  assert.match(at("compact"), /h-1\.5/);
  assert.match(at("default"), /h-2/);
  assert.match(at("hero"), /h-3/);
});

test("an unknown reading is announced as unknown, not as a bare bar", () => {
  const html = renderToStaticMarkup(<Meter label="Session" fraction={null} />);
  assert.match(html, /aria-valuetext="no ceiling set"/);
});

test("a supplied value is suppressed when the fraction is unknown", () => {
  // `value` exists for readings where the raw pair says more than the ratio
  // ("2/5"). With no ceiling there is no pair, and any number in that slot
  // reads as a measurement of a window nothing has measured.
  const html = renderToStaticMarkup(
    <Meter label="w" fraction={null} value="2/5" />,
  );
  assert.doesNotMatch(html, /2\/5/);
  assert.match(html, /no ceiling set/);
});

test("a tiny non-zero reading is drawn, a zero one is not", () => {
  // 0.2% of a 200px track is a third of a pixel, so it paints as an empty bar —
  // "nothing used" for a window that has been used. The floor is on the drawn
  // width only: the reported percentage and aria-valuenow are untouched.
  const tiny = renderToStaticMarkup(<Meter label="w" fraction={0.002} />);
  assert.match(tiny, /min-width:3px/);
  assert.match(tiny, /aria-valuenow="0"/);

  const zero = renderToStaticMarkup(<Meter label="w" fraction={0} />);
  assert.doesNotMatch(zero, /min-width/, "a real zero must draw nothing");
});
