import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, blocksOf, parseWikilink, type WikilinkResolution } from "./Markdown";

/**
 * What is pinned here is content and structure, never styling, on the same
 * grounds as the other two rendering tests in this repo: each failure is silent
 * and each one loses or corrupts something the reader would act on.
 *
 * The fence state machine is the original case. A work cycle killed mid-sentence
 * leaves an unterminated ``` behind, and a parser that waits for a closing fence
 * that never comes renders the rest of the report as nothing — which on this
 * page is indistinguishable from a cycle that finished with nothing to say. The
 * inline cases are here because the markers leaking through as literal `**` is
 * the one way this can be wrong that a reader would mistake for the agent's own
 * punctuation. The list, link and heading cases below are the same argument:
 * ordered steps announced as an unordered pile, a `javascript:` URL turned into
 * something clickable, and a model's `#` outranking the page's own heading are
 * all things that typecheck and render.
 *
 * The styling is not pinned and should not be.
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
    { kind: "item", marker: "1.", ordered: true, depth: 0, text: "first" },
    { kind: "item", marker: "2.", ordered: true, depth: 0, text: "second" },
  ]);
  const html = renderToStaticMarkup(<Markdown text={"1. first\n2. second"} />);
  assert.match(html, /<ol[^>]*>/, "numbered steps are a numbered list");
  assert.match(html, /1\.[\s\S]*first[\s\S]*2\.[\s\S]*second/);
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

test("a run of items is one list, and a change of marker starts another", () => {
  // A blank line between items is a loose list, not two lists — splitting it
  // tells a screen reader "list of 1 item" twice and loses the count.
  const loose = renderToStaticMarkup(<Markdown text={"- one\n\n- two"} />);
  assert.equal(loose.match(/<ul/g)?.length, 1);
  assert.equal(loose.match(/<li/g)?.length, 2);

  const mixed = renderToStaticMarkup(<Markdown text={"- one\n1. two"} />);
  assert.match(mixed, /<ul[\s\S]*<ol/, "numbered steps are not swept into a bullet list");

  // A paragraph does end the list.
  const split = renderToStaticMarkup(<Markdown text={"- one\nprose\n- two"} />);
  assert.equal(split.match(/<ul/g)?.length, 2);
});

test("an indented item hangs under the one above it", () => {
  assert.deepEqual(blocksOf("- parent\n  - child"), [
    { kind: "item", marker: "•", ordered: false, depth: 0, text: "parent" },
    { kind: "item", marker: "•", ordered: false, depth: 1, text: "child" },
  ]);
  // Four-space indentation is as common as two in what a model writes, and both
  // have to nest — the depth is "indented at all", not a column count.
  assert.deepEqual(blocksOf("- parent\n    - child"), [
    { kind: "item", marker: "•", ordered: false, depth: 0, text: "parent" },
    { kind: "item", marker: "•", ordered: false, depth: 1, text: "child" },
  ]);
  const html = renderToStaticMarkup(<Markdown text={"- parent\n  - child"} />);
  assert.match(
    html,
    /<ul[\s\S]*parent[\s\S]*<ul[\s\S]*child/,
    "the child list is inside the parent item",
  );

  // Two sub-items are siblings. Nesting the second under the first is what
  // happens if the child list is re-nested by depth, and it reads as an outline
  // the model did not write.
  const two = renderToStaticMarkup(<Markdown text={"- parent\n  - one\n  - two"} />);
  assert.equal(two.match(/<ul/g)?.length, 2, "one list per level, not one per item");
});

test("a link is a link, and an unknown scheme is not", () => {
  const md = renderToStaticMarkup(
    <Markdown text="See [issue 12](https://github.com/x/y/issues/12) for the detail." />,
  );
  assert.match(md, /<a [^>]*href="https:\/\/github\.com\/x\/y\/issues\/12"/);
  assert.match(md, />issue 12<\/a>/);
  assert.doesNotMatch(md, /\]\(/, "the markdown markers are consumed");

  const bare = renderToStaticMarkup(<Markdown text="Opened https://example.com/a-b, then waited." />);
  assert.match(bare, /href="https:\/\/example\.com\/a-b"/);
  assert.match(bare, /, then waited\./, "the trailing comma is prose, not part of the URL");

  // Model-written text is unreviewed, so the scheme allowlist is the boundary.
  // The token stays visible rather than being dropped: a link this refused to
  // make is worth seeing.
  const unsafe = renderToStaticMarkup(
    <Markdown text="[click](javascript:alert(1)) and [also](data:text/html,x)" />,
  );
  assert.doesNotMatch(unsafe, /<a /);
  assert.match(unsafe, /javascript:/);
  assert.match(unsafe, /data:text\/html/);

  // A URL inside backticks is a string being quoted, not a destination.
  const quoted = renderToStaticMarkup(<Markdown text="curl `https://example.com/x`" />);
  assert.doesNotMatch(quoted, /<a /);
  assert.match(quoted, /<code[^>]*>https:\/\/example\.com\/x<\/code>/);
});

/* ------------------------------ wikilinks -------------------------------- */

/**
 * The vault this renderer is pointed at on the knowledge page. `Terraform State`
 * is a note, `diagrams/state.png` exists and is not one, and everything else is
 * a link somebody wrote against a note that was never created.
 */
const vault = (link: { target: string }): WikilinkResolution => {
  if (link.target === "Terraform State") return { kind: "note", href: "/knowledge?note=ts.md" };
  if (link.target === "diagrams/state.png") return { kind: "other" };
  return { kind: "missing" };
};

test("a wikilink's parts are the ones that were written", () => {
  // Each of these is silent when misread: a `|label` swallowed into the target
  // breaks a link that resolves, and an alias read as a heading points one at a
  // note that exists.
  assert.deepEqual(parseWikilink("[[Terraform State]]"), {
    embed: false,
    target: "Terraform State",
    heading: null,
    label: "Terraform State",
  });
  assert.deepEqual(parseWikilink("[[Terraform State|the state file]]"), {
    embed: false,
    target: "Terraform State",
    heading: null,
    label: "the state file",
  });
  assert.deepEqual(parseWikilink("[[Terraform State#Locking]]"), {
    embed: false,
    target: "Terraform State",
    heading: "Locking",
    label: "Terraform State#Locking",
  });
  // A block reference keeps its caret: `#^abc` and `#abc` are different places.
  assert.equal(parseWikilink("[[Terraform State#^abc123]]")?.heading, "^abc123");
  assert.equal(parseWikilink("![[diagrams/state.png]]")?.embed, true);
  // A label may contain a pipe, so only the first one separates.
  assert.equal(parseWikilink("[[A|b | c]]")?.label, "b | c");
  // `[[#Locking]]` addresses this note; `[[|x]]` addresses nothing at all.
  assert.deepEqual(parseWikilink("[[#Locking]]"), {
    embed: false,
    target: "",
    heading: "Locking",
    label: "#Locking",
  });
  assert.equal(parseWikilink("[[|x]]"), null);
});

test("a wikilink with no vault behind it stays the text the model wrote", () => {
  // Every caller that existed before the resolver prop passes only `text`, and
  // this is what pins that adding the prop changed none of them: a run report
  // saying `[[wikilinks]]` is prose about wikilinks, not a link to one.
  const html = renderToStaticMarkup(<Markdown text="Handled [[Terraform State]] today." />);
  assert.doesNotMatch(html, /<a |<span class/);
  assert.match(html, /Handled \[\[Terraform State\]\] today\./);
});

test("a resolved wikilink is a link into this page, not a new tab", () => {
  const html = renderToStaticMarkup(
    <Markdown text="Start at [[Terraform State|the state file]]." resolveWikilink={vault} />,
  );
  assert.match(html, /<a [^>]*href="\/knowledge\?note=ts\.md"/);
  assert.match(html, />the state file<\/a>/, "the label is what was written after the pipe");
  assert.doesNotMatch(html, /target="_blank"/, "a note is not somewhere else");
  assert.doesNotMatch(html, /\[\[/, "the markers are consumed");
});

test("an unresolved wikilink is visibly broken rather than ordinary text", () => {
  // This is the whole point of the extension. A link to a note nobody wrote is
  // indistinguishable from prose once the brackets are gone, so a vault with 40
  // dangling links reads as a vault with none — and the operator's reason for
  // opening the page is to find them.
  const html = renderToStaticMarkup(
    <Markdown text="A dangling one: [[Nothing Written Yet]]." resolveWikilink={vault} />,
  );
  assert.doesNotMatch(html, /<a /, "a link that goes nowhere is not something to press");
  assert.match(html, /Nothing Written Yet/);
  // Not colour alone: the dotted underline is the cue that survives a monochrome
  // display, and the suffix is what reaches a reader who sees neither.
  assert.match(html, /decoration-dotted/);
  assert.match(html, /class="sr-only">[^<]*broken link/);
});

test("a target that exists and is not a note is neither a link nor broken", () => {
  // The renderer draws no images, so an embed has nowhere to go — but marking it
  // broken would report a healthy vault as a broken one, which is the same
  // failure as the test above with the sign flipped.
  const html = renderToStaticMarkup(
    <Markdown text="See ![[diagrams/state.png]] for it." resolveWikilink={vault} />,
  );
  assert.doesNotMatch(html, /<a |decoration-dotted/);
  assert.match(html, /See diagrams\/state\.png for it\./);
});

test("a wikilink inside code is a string being quoted, not a destination", () => {
  const inlineCode = renderToStaticMarkup(
    <Markdown text="Write `[[Terraform State]]` to link it." resolveWikilink={vault} />,
  );
  assert.doesNotMatch(inlineCode, /<a /);
  assert.match(inlineCode, /<code[^>]*>\[\[Terraform State\]\]<\/code>/);

  const fenced = renderToStaticMarkup(
    <Markdown text={"```md\n[[Nothing Written Yet]]\n```"} resolveWikilink={vault} />,
  );
  assert.doesNotMatch(fenced, /<a |decoration-dotted/);
  assert.match(fenced, /\[\[Nothing Written Yet\]\]/);
});

test("a wikilink inside emphasis is still a wikilink", () => {
  // `INLINE` is one flat alternation, so the `**` token swallows the brackets
  // whole and the link arrives at <strong> as literal text — the exact failure
  // the two tests above exist to prevent, hiding inside a pair of asterisks.
  // Measured, not hypothetical: 213 of the 13,100 wikilinks in the vault this
  // was built against are written inside emphasis.
  const bold = renderToStaticMarkup(
    <Markdown text="**Start at [[Terraform State]].**" resolveWikilink={vault} />,
  );
  assert.match(bold, /<strong[^>]*>/);
  assert.match(bold, /<a [^>]*href="\/knowledge\?note=ts\.md"/);
  assert.doesNotMatch(bold, /\[\[/);

  const italic = renderToStaticMarkup(
    <Markdown text="*Not written: [[Nothing Written Yet]]*" resolveWikilink={vault} />,
  );
  assert.match(italic, /<em[^>]*>/);
  assert.match(italic, /decoration-dotted/);
});

test("emphasis with no vault behind it is byte-for-byte what it always was", () => {
  // The rescan is gated on the resolver for this: every caller that predates
  // wikilinks passes only `text`, and a silent change to how their bold renders
  // is a regression nobody asked for. What a model writes inside `**` stays
  // exactly the characters it wrote.
  const html = renderToStaticMarkup(
    <Markdown text="**See [[A Note]] and `code` and https://example.com**" />,
  );
  assert.doesNotMatch(html, /<a |<code/);
  assert.match(html, /See \[\[A Note\]\] and `code` and https:\/\/example\.com/);
});

test("a heading in a turn never outranks the page's own", () => {
  // This renders inside a chat turn and inside cards whose title is an <h2>.
  const html = renderToStaticMarkup(<Markdown text={"# Top\n\n### Deeper"} />);
  assert.doesNotMatch(html, /<h1|<h2/);
  assert.match(html, /<h3[^>]*>Top<\/h3>/);
  assert.match(html, /<h4[^>]*>Deeper<\/h4>/);
});
