import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, blocksOf } from "./Markdown";

/**
 * Only the fence state machine is pinned here, on the same grounds as the other
 * two rendering tests in this repo: the failure is silent and it loses content.
 * A work cycle killed mid-sentence leaves an unterminated ``` behind, and a
 * parser that waits for a closing fence that never comes renders the rest of
 * the report as nothing — which on this page is indistinguishable from a cycle
 * that finished with nothing to say. The inline cases are here because the
 * markers leaking through as literal `**` is the one way this can be wrong that
 * a reader would mistake for the agent's own punctuation.
 *
 * The styling below that is not pinned and should not be.
 */

test("a fenced block is code, not a list of bullets", () => {
  const html = renderToStaticMarkup(
    <Markdown text={"Try this:\n```sh\n- npm test\n# not a heading\n```"} />,
  );
  assert.match(html, /<pre/);
  assert.match(html, /- npm test/, "the leading dash belongs to the code");
  assert.doesNotMatch(html, /•/, "a line inside a fence is not a list item");
  assert.doesNotMatch(html, /not a heading<\/div>/);
});

test("an unterminated fence still renders what it opened over", () => {
  // The cycle was killed part-way through writing the block.
  assert.deepEqual(blocksOf("```ts\nconst a = 1;\nconst b = 2;"), [
    { kind: "code", text: "const a = 1;\nconst b = 2;" },
  ]);
  const html = renderToStaticMarkup(<Markdown text={"```ts\nconst a = 1;"} />);
  assert.match(html, /const a = 1;/);
});

test("inline markers are consumed rather than shown", () => {
  const html = renderToStaticMarkup(
    <Markdown text={"Edited `src/lib/cycles.ts` and it is **done**."} />,
  );
  assert.match(html, /<code[^>]*>src\/lib\/cycles\.ts<\/code>/);
  assert.match(html, /<strong[^>]*>done<\/strong>/);
  assert.doesNotMatch(html, /\*\*/);
  assert.doesNotMatch(html, /`/);
});

test("emphasis markers with nothing attached stay literal", () => {
  // Arithmetic and a lone separator are not emphasis, and eating the character
  // would change what the sentence says.
  assert.deepEqual(blocksOf("a * b * c"), [{ kind: "text", text: "a * b * c" }]);
  const html = renderToStaticMarkup(<Markdown text="a * b * c" />);
  assert.doesNotMatch(html, /<em/);
  // Underscore emphasis is deliberately not understood, so identifiers survive.
  assert.match(renderToStaticMarkup(<Markdown text="run_the_thing" />), /run_the_thing/);
});

test("an ordered list keeps its numbers", () => {
  assert.deepEqual(blocksOf("1. first\n2. second"), [
    { kind: "item", marker: "1.", text: "first" },
    { kind: "item", marker: "2.", text: "second" },
  ]);
});

test("the shapes a review is asked for still render", () => {
  // RunReview shares this renderer; headings and bullets are what it produces.
  const html = renderToStaticMarkup(
    <Markdown text={"## What changed\n\n- one thing\n- another"} />,
  );
  assert.match(html, />What changed</);
  assert.doesNotMatch(html, /##/);
  assert.match(html, /•/);
});
