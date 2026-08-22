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
    { kind: "code", text: "const a = 1;\nconst b = 2;", lang: "ts" },
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
  // Underscore emphasis is understood, but only where the marker sits on a word
  // edge — CommonMark's flanking rule, which is also what Obsidian applies, and
  // which is the whole of what keeps an identifier intact. This text is mostly
  // about file paths and symbols, and `run_the_thing` silently becoming "run the
  // thing" in italics is a name the reader can no longer search for.
  const snake = renderToStaticMarkup(<Markdown text="run_the_thing in some_module_name.ts" />);
  assert.doesNotMatch(snake, /<em|<strong/);
  assert.match(snake, /run_the_thing in some_module_name\.ts/);
  assert.match(renderToStaticMarkup(<Markdown text="_really_ hot" />), /<em[^>]*>really<\/em>/);
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

  // And the other direction: an alias is text the author wrote, so it is
  // scanned like any other. A citation carrying its own emphasis is the case
  // this comes from.
  const alias = renderToStaticMarkup(
    <Markdown text="[[Terraform State|**n = 352**]] says so." resolveWikilink={vault} />,
  );
  assert.match(alias, /<a [^>]*href="\/knowledge\?note=ts\.md"[^>]*><strong[^>]*>n = 352<\/strong><\/a>/);
  assert.doesNotMatch(alias, /\*\*/);
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

/* -------------------------- obsidian's markdown --------------------------- */

/**
 * Everything below is here for one failure, which is the reason the knowledge
 * page reads as unrendered: a construction this does not understand does not
 * error, it falls through as its own punctuation. A callout becomes the literal
 * string `> [!warning]`, a table becomes a column of pipes, a checklist becomes
 * `- [ ]`. Each is silent, each is on the page the operator opened *to read the
 * note*, and each is indistinguishable from a file that was never parsed.
 */

test("a callout is a callout, not the literal string the author typed", () => {
  const html = renderToStaticMarkup(
    <Markdown text={"> [!warning] Careful\n> The lock is not held."} />,
  );
  assert.doesNotMatch(html, /\[!warning\]/, "the marker is consumed");
  assert.match(html, /Careful/);
  assert.match(html, /The lock is not held\./);
  // The tone is the callout's meaning, not decoration: a danger drawn in the
  // note colour is a warning the reader does not receive.
  assert.match(html, /border-warn-line/);
  assert.match(
    renderToStaticMarkup(<Markdown text="> [!danger] Stop" />),
    /border-danger-line/,
  );
  assert.match(renderToStaticMarkup(<Markdown text="> [!success] Landed" />), /border-ok-line/);

  // An unrecognised type is still a callout — Obsidian draws it as a note, and
  // a typo must not be reported as an error this app invented.
  const unknown = renderToStaticMarkup(<Markdown text={"> [!frobnicate]\n> body"} />);
  assert.match(unknown, /border-accent-line/);
  assert.match(unknown, /Frobnicate/, "with no title the type names itself");
});

test("a callout folds only where the author asked it to", () => {
  // Hiding is the author's decision here and nobody else's: a callout with no
  // `+`/`-` that renders closed hides text they wrote in the open.
  assert.doesNotMatch(
    renderToStaticMarkup(<Markdown text={"> [!note] Plain\n> body"} resolveWikilink={vault} />),
    /<details/,
  );
  const closed = renderToStaticMarkup(
    <Markdown text={"> [!note]- Hidden\n> body"} resolveWikilink={vault} />,
  );
  assert.match(closed, /<details/);
  assert.doesNotMatch(closed, /<details[^>]*open/);
  assert.match(
    renderToStaticMarkup(<Markdown text={"> [!note]+ Shown\n> body"} resolveWikilink={vault} />),
    /<details[^>]*open/,
  );
});

test("a fold never lands inside a fold", () => {
  // A nested disclosure is on this app's never-used list. `RunOutput` renders
  // every earlier cycle's report inside a `Disclosure`, so a model writing
  // Obsidian's fold syntax into a report would build the nesting from the
  // inside — and the two rungs below are what stop it from either direction.
  const report = renderToStaticMarkup(<Markdown text={"> [!note]- Hidden\n> body"} />);
  assert.doesNotMatch(report, /<details/, "no vault, no fold");
  assert.match(report, /body/, "and refusing to fold shows the text rather than dropping it");

  const inner = renderToStaticMarkup(
    <Markdown
      text={"> [!note]- Outer\n> > [!tip]- Inner\n> > deep body"}
      resolveWikilink={vault}
    />,
  );
  assert.equal(inner.match(/<details/g)?.length, 1, "the outer one folds and the inner one does not");
  assert.match(inner, /deep body/);
});

test("a blockquote is a blockquote, and a nested one nests", () => {
  const html = renderToStaticMarkup(<Markdown text={"> outer\n> > inner"} />);
  assert.equal(html.match(/<blockquote/g)?.length, 2);
  // The markers are structure. Left in, they arrive on the page as `&gt;`.
  assert.match(html, /<p[^>]*>outer<\/p>/);
  assert.match(html, /<p[^>]*>inner<\/p>/);
});

test("a table is a table, with the alignment and the column names it was given", () => {
  const html = renderToStaticMarkup(
    <Markdown text={"| Step | Cost |\n| --- | ---: |\n| build | 1.20 |\n| test | 0.40 |"} />,
  );
  assert.match(html, /<table/);
  assert.doesNotMatch(html, /\| build \|/, "the pipes are structure, not text");
  assert.match(html, /<th[^>]*>Step<\/th>/);
  assert.match(html, /<td[^>]*text-right[^>]*>[\s\S]*1\.20/, "a `---:` column is right aligned");
  // Below the breakpoint the heads come off the screen, so every cell carries
  // its column's name — a note's columns are not ones the reader can guess.
  assert.match(html, /md:hidden[^>]*>Cost<\/span>/);
});

test("a column head written in markdown is drawn as markdown in both places", () => {
  // The label is the only thing naming a value below the breakpoint, and it is
  // a second copy of the head — so handing it the raw string put `**bold**` and
  // `[[wikilinks]]` on the phone in a table that read correctly on the desktop.
  // Found in a real vault: 621 of its 785 notes carry a table.
  const html = renderToStaticMarkup(
    <Markdown
      text={"| | Ack **before** |\n| --- | --- |\n| Guarantee | at-most-once |"}
      resolveWikilink={vault}
    />,
  );
  assert.doesNotMatch(html, /\*\*/);
  assert.equal(html.match(/<strong/g)?.length, 2, "once as the head, once as the label");
  // An empty head is no label at all rather than an empty one: the cell under
  // it is the row's own name, not a value needing one.
  assert.doesNotMatch(html, /md:hidden"><\/span>|md:hidden"\/>/);
});

test("a pipe that is not a table is not made into one", () => {
  // Both lines have to carry a pipe. Without that test a paragraph followed by
  // a setext rule is a one-column table — a heading silently turned into a grid.
  const html = renderToStaticMarkup(<Markdown text={"Cost | benefit\n---\n\nAfter."} />);
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /<h3[^>]*>Cost \| benefit<\/h3>/);

  // A `\|` inside a cell is a pipe the author wanted.
  const escaped = renderToStaticMarkup(<Markdown text={"| a | b |\n| - | - |\n| x \\| y | z |"} />);
  assert.equal(escaped.match(/<td/g)?.length, 2, "the escaped pipe did not open a third cell");
  assert.match(escaped, /x \| y/);
});

test("a task list draws the state it was written with", () => {
  // A checked box drawn unchecked inverts what the note says, which is the one
  // way this can be wrong that the reader will act on.
  assert.deepEqual(blocksOf("- [x] shipped\n- [ ] pending"), [
    { kind: "item", marker: "•", ordered: false, depth: 0, text: "shipped", task: true },
    { kind: "item", marker: "•", ordered: false, depth: 0, text: "pending", task: false },
  ]);
  // An ordinary bullet carries no `task` at all, so it renders as it always has.
  assert.deepEqual(blocksOf("- plain"), [
    { kind: "item", marker: "•", ordered: false, depth: 0, text: "plain" },
  ]);
  // An empty one is the row a template leaves for the reader to fill in, and
  // every note made from that template was showing it as the text `[ ]`.
  assert.deepEqual(blocksOf("- [ ] "), [
    { kind: "item", marker: "•", ordered: false, depth: 0, text: "", task: false },
  ]);
  // A box with no space after it is not a task, which is what keeps a wikilink
  // at the start of an item from being eaten as one.
  assert.deepEqual(blocksOf("- [x]no space"), [
    { kind: "item", marker: "•", ordered: false, depth: 0, text: "[x]no space" },
  ]);

  const html = renderToStaticMarkup(<Markdown text={"- [x] shipped\n- [ ] pending"} />);
  assert.equal(html.match(/type="checkbox"/g)?.length, 2);
  assert.equal(html.match(/checked=""/g)?.length, 1);
  // Announced rather than drawn, and inert: this renderer cannot write the file
  // back, so a box that answers the pointer would lie about what it did.
  assert.match(html, /aria-label="Done"/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /\[x\]|\[ \]/);
});

test("a list nests as many levels as were written", () => {
  // One level was enough for a work cycle's report. A note is an outline, and
  // flattening its third level puts a sub-point beside the point it belongs to.
  assert.deepEqual(
    blocksOf("- a\n  - b\n    - c").map((block) => (block.kind === "item" ? block.depth : null)),
    [0, 1, 2],
  );
  const html = renderToStaticMarkup(<Markdown text={"- a\n  - b\n    - c"} />);
  assert.equal(html.match(/<ul/g)?.length, 3);
  assert.match(html, /<ul[\s\S]*a[\s\S]*<ul[\s\S]*b[\s\S]*<ul[\s\S]*c/);
});

test("highlights and strikethrough are drawn, not spelled", () => {
  const html = renderToStaticMarkup(<Markdown text="It was ==urgent== and is ~~gone~~." />);
  assert.match(html, /<mark[^>]*>urgent<\/mark>/);
  assert.match(html, /<s[^>]*>gone<\/s>/);
  assert.doesNotMatch(html, /==|~~/);
});

test("an escaped marker is the character, not the markup", () => {
  // Braces, not an attribute string: JSX attributes are HTML-like and do not
  // process backslash escapes, so `text="\\*"` is two characters, not one.
  const html = renderToStaticMarkup(<Markdown text={"Write \\*literally\\* and \\[not a link\\]."} />);
  assert.doesNotMatch(html, /<em|<a /);
  assert.match(html, /Write \*literally\* and \[not a link\]\./);
  assert.doesNotMatch(html, /\\/, "the backslash is consumed");
});

test("a tag is a vault concept and is drawn only where there is a vault", () => {
  // `#done` in a work cycle's report is a word the model wrote. Turning it into
  // a chip there would be this renderer inventing a vault that does not exist.
  const report = renderToStaticMarkup(<Markdown text="Marked #done today." />);
  assert.doesNotMatch(report, /<span/);
  assert.match(report, /Marked #done today\./);
  assert.doesNotMatch(report, /<h[1-6]/, "a tag on its own is not a heading");

  const note = renderToStaticMarkup(<Markdown text="Marked #done today." resolveWikilink={vault} />);
  assert.match(note, /<span[^>]*>#done<\/span>/);

  // A heading still needs its space, and `#42` is an issue number.
  assert.match(renderToStaticMarkup(<Markdown text="# Real heading" />), /<h3[^>]*>Real heading/);
  assert.doesNotMatch(
    renderToStaticMarkup(<Markdown text="See #42 and C# too." resolveWikilink={vault} />),
    /<span/,
  );
});

test("a footnote reference lands on its own note, in its own instance", () => {
  const html = renderToStaticMarkup(
    <Markdown text={"A claim.[^why]\n\n[^why]: The evidence for it."} />,
  );
  const href = /href="#([^"]+)"/.exec(html)?.[1];
  assert.ok(href, "the reference is a link");
  assert.match(html, new RegExp(`id="${href}"`), "and it lands on the definition");
  assert.match(html, /The evidence for it\./);
  assert.doesNotMatch(html, /\[\^why\]/);
  // A label is the author's handle for the note, not a marker: a superscript
  // "why" beside a word reads as the word having been cut short.
  assert.match(html, /<sup><a[^>]*>1<\/a><\/sup>/);

  // A reference nobody defined stays what was typed, for the reason a dangling
  // wikilink is marked rather than linked.
  const dangling = renderToStaticMarkup(<Markdown text="A claim.[^missing]" />);
  assert.doesNotMatch(dangling, /<a |<sup/);
  assert.match(dangling, /A claim\.\[\^missing\]/);

  // A chat page draws a dozen of these at once, so a bare `#fn-1` would jump to
  // whichever turn rendered first — a footnote that disagrees with the sentence.
  const two = renderToStaticMarkup(
    <>
      <Markdown text={"One.[^1]\n\n[^1]: First."} />
      <Markdown text={"Two.[^1]\n\n[^1]: Second."} />
    </>,
  );
  const ids = [...two.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "two instances do not share an anchor");
});

test("a block id is an anchor, and arithmetic is not", () => {
  // `^abc` at the end of a line is Obsidian's handle for that block, not words.
  assert.deepEqual(blocksOf("The lock is per repository. ^lock-scope"), [
    { kind: "text", text: "The lock is per repository." },
  ]);
  // But eating a trailing `^2` would change what the sentence says.
  assert.deepEqual(blocksOf("It is e = mc ^2"), [{ kind: "text", text: "It is e = mc ^2" }]);
});

test("a comment is not rendered, and does not split what surrounds it", () => {
  const inlineComment = renderToStaticMarkup(<Markdown text="Kept %%dropped%% kept." />);
  assert.doesNotMatch(inlineComment, /dropped/);
  assert.match(inlineComment, /Kept  ?kept\./);

  const block = renderToStaticMarkup(<Markdown text={"- one\n%%\nnot shown\n%%\n- two"} />);
  assert.doesNotMatch(block, /not shown/);
  assert.equal(block.match(/<ul/g)?.length, 1, "a comment between items is not a paragraph");
});

test("a wrapped sentence is one paragraph, not one per line", () => {
  // Every line used to be its own <p>, so a hard-wrapped sentence came out with
  // a paragraph gap in the middle of it.
  const html = renderToStaticMarkup(<Markdown text={"The lock is held\nfor the whole run."} />);
  assert.equal(html.match(/<p/g)?.length, 1);
  assert.match(html, /<br/, "the author's own line break is kept, as Obsidian keeps it");
});

test("a heading in a turn never outranks the page's own", () => {
  // This renders inside a chat turn and inside cards whose title is an <h2>.
  const html = renderToStaticMarkup(<Markdown text={"# Top\n\n### Deeper"} />);
  assert.doesNotMatch(html, /<h1|<h2/);
  assert.match(html, /<h3[^>]*>Top<\/h3>/);
  assert.match(html, /<h4[^>]*>Deeper<\/h4>/);
});
