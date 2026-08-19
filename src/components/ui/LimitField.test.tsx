import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LimitField } from "./Field";

/**
 * The one control in the kit that can express "no limit at all".
 *
 * It earns a test on this repo's bar rather than as a component convention:
 * every failure below is silent, and each of them starts an unattended agent
 * under a guard the operator believes they set. `null` is the wire form of
 * "off" and `normalizePolicy` reads it as an unset cap, so a picker whose two
 * options are the wrong way round does not throw, does not fail a typecheck,
 * and does not look wrong on the page — it starts an uncapped run.
 *
 * The other two are the halves the run form needs and that a `ListRow` cannot
 * supply: the picker's own id, which is what a "switch one of these back on"
 * error has to send the cursor to, and `invalid`, which a row provides as a
 * fixed `false`.
 */

function render(props: Partial<Parameters<typeof LimitField>[0]> = {}) {
  return renderToStaticMarkup(
    <LimitField
      id="cycles"
      modeLabel="Whether the work cycles are capped"
      enabled
      onEnabledChange={() => {}}
      value="5"
      onValueChange={() => {}}
      unit="cycles"
      offLabel="No cycle limit"
      {...props}
    />,
  );
}

test("the picker says which state it is in, and off is not on", () => {
  const on = render({ enabled: true });
  assert.match(on, /<select[^>]*>[\s\S]*?<option value="on" selected=""/);
  const off = render({ enabled: false });
  assert.match(off, /<option value="off" selected=""/);
  // Both options exist in both states, so the way back is always on screen.
  for (const html of [on, off]) {
    assert.match(html, /<option value="on"/);
    assert.match(html, /<option value="off"/);
  }
});

test("the value box, its unit and its id exist only while the limit is on", () => {
  const on = render({ enabled: true });
  assert.match(on, /<input[^>]*id="cycles"/);
  assert.match(on, /value="5"/);
  assert.match(on, /cycles<\/span>/);

  // A row's `htmlFor` points at this id, so its absence is what the caller's
  // `htmlFor={capped ? "cycles" : undefined}` ternary exists to mirror.
  const off = render({ enabled: false });
  assert.doesNotMatch(off, /<input/);
  assert.doesNotMatch(off, /id="cycles"/);
});

test("the picker takes an id of its own, in both states", () => {
  for (const enabled of [true, false]) {
    const html = render({ enabled, modeId: "cycles-on" });
    assert.match(
      html,
      /<select[^>]*id="cycles-on"/,
      "the half that is there when the limit is off is the half an error points at",
    );
  }
});

test("no modeId means no id, rather than an id nothing named", () => {
  assert.doesNotMatch(render(), /<select[^>]*id="/);
});

test("invalid reddens the pair and is announced, and defaults to neither", () => {
  const bad = render({ invalid: true });
  assert.match(bad, /aria-invalid="true"/);
  assert.match(bad, /border-danger/);

  const fine = render();
  assert.doesNotMatch(fine, /aria-invalid/);
  assert.doesNotMatch(fine, /border-danger/);
});
