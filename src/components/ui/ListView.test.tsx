import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ListView, STICKY_HEAD, STICKY_HEAD_FLAT } from "./ListView";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Three boxes that look like one box with two typos in it, which is exactly
 * why this is tested: every difference between them is invisible on a desktop
 * and none of them throws, logs or fails a typecheck.
 *
 * `capped` is the touch one. Below the breakpoint the column heads are hidden
 * and the rows are blocks, so a 320px scroll region inside a scrolling pane is
 * a nested scroller with nothing pinned to the top of it — a trap, where the
 * only way past a list is through it. Losing either half of the release is a
 * pixel-identical desktop and a phone you cannot scroll past.
 *
 * `plain` is the opposite mistake. Giving the runs list an `overflow` would
 * pin its sticky header to a box that never scrolls, which reads on a desktop
 * as a header that has quietly stopped working.
 *
 * `scrolling` and `STICKY_HEAD_FLAT` are each one caller's deviation from the
 * other four, and each is an open question for a person rather than a
 * decision anybody recorded. They are pinned here so that answering one is a
 * deliberate edit and not a tidy-up.
 */

const boxOf = (markup: string) => /class="([^"]*)"/.exec(markup)?.[1] ?? "";

test("the capped box releases both halves below the breakpoint", () => {
  const cls = boxOf(renderToStaticMarkup(<ListView>x</ListView>));
  assert.match(cls, /(^| )max-h-80( |$)/);
  assert.match(cls, /(^| )overflow-auto( |$)/);
  assert.match(cls, /(^| )max-md:max-h-none( |$)/, "the cap is released");
  assert.match(cls, /(^| )max-md:overflow-visible( |$)/, "and so is the scroll");
});

test("the plain box is not a scroll container", () => {
  const cls = boxOf(renderToStaticMarkup(<ListView box="plain">x</ListView>));
  assert.doesNotMatch(
    cls,
    /overflow/,
    "the runs list's header pins to the content pane, which a scroll container of its own would take away",
  );
  assert.doesNotMatch(cls, /max-h/, "and there is no height to scroll inside");
});

test("the scrolling box keeps its missing height cap", () => {
  const cls = boxOf(renderToStaticMarkup(<ListView box="scrolling">x</ListView>));
  assert.doesNotMatch(cls, /max-h/, "unresolved, and preserved rather than answered");
  assert.match(cls, /(^| )overflow-auto( |$)/);
  assert.match(cls, /(^| )max-md:overflow-visible( |$)/);
});

test("className is the caller's margin and never a second cap", () => {
  const cls = boxOf(
    renderToStaticMarkup(<ListView className="mt-4">x</ListView>),
  );
  assert.match(cls, /(^| )max-h-80( |$)/, "the box's own cap survives it");
  assert.match(cls, /(^| )mt-4( |$)/);
});

test("the two sticky heads differ by the hairline and nothing else", () => {
  assert.equal(
    STICKY_HEAD,
    `${STICKY_HEAD_FLAT} shadow-[inset_0_-1px_0_var(--border)]`,
  );
});
