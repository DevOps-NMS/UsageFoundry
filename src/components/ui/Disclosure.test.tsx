import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Disclosure } from "./Disclosure";

/**
 * This component exists because a hit target is invisible from every file that
 * has one. Seven hand-rolled `<details>` carried the recipe or did not, and
 * nobody could tell which from reading any one of them; a recipe that goes
 * missing from the component itself is the same failure with one place left to
 * look, so the class is asserted rather than assumed.
 *
 * The ARIA is the other half and fails the other way. A native `<details>`
 * already announces itself; a `role` or an `aria-expanded` added on top of it
 * is redundant in one engine and wrong in another, and either way the reader
 * who finds out is using a screen reader and not writing this file.
 */

const closed = renderToStaticMarkup(
  <Disclosure summary="Older runs">
    <p>behind it</p>
  </Disclosure>,
);

test("the summary buys the 44px target with padding, below the breakpoint only", () => {
  // Not `max-md:min-h-11`: a min-height on a `list-item` leaves the word and
  // its triangle at the top of a box the finger is aiming at the middle of.
  assert.match(closed, /<summary class="[^"]*max-md:py-3\.5/);
  assert.doesNotMatch(closed, /min-h-11/);
});

test("nothing states an ARIA role or state the element already carries", () => {
  assert.doesNotMatch(closed, /role="/);
  assert.doesNotMatch(closed, /aria-expanded/);
  assert.doesNotMatch(closed, /aria-controls/);
});

test("the fold is shut unless it was asked to open", () => {
  assert.doesNotMatch(closed, /<details[^>]*open/);
  const open = renderToStaticMarkup(
    <Disclosure summary="Older runs" defaultOpen>
      <p>behind it</p>
    </Disclosure>,
  );
  assert.match(open, /<details[^>]*open=""/);
});

test("a count says how much is behind the fold", () => {
  const html = renderToStaticMarkup(
    <Disclosure summary="Older runs" count={12}>
      <p>behind it</p>
    </Disclosure>,
  );
  assert.match(html, /Older runs<span class="text-ink-faint"> \(12\)<\/span>/);
});

test("half of the controlled pair is refused rather than left to go stale", () => {
  // The guard is a development one by contract, and this container's shell
  // ships `NODE_ENV=production` — so say which mode is being tested rather
  // than letting the assertion pass or fail on the environment.
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    assert.throws(
      () =>
        renderToStaticMarkup(
          <Disclosure summary="Earlier presses of Land" open>
            <p>behind it</p>
          </Disclosure>,
        ),
      /one pair/,
      "a lone `open` goes stale the first time the browser toggles it",
    );
    assert.throws(
      () =>
        renderToStaticMarkup(
          <Disclosure summary="Earlier presses of Land" onToggle={() => {}}>
            <p>behind it</p>
          </Disclosure>,
        ),
      /one pair/,
      "a lone `onToggle` is the fetch-on-open the contract refuses",
    );
  } finally {
    process.env.NODE_ENV = was;
  }
});
