# Option A: change nothing

The null, at its strongest, because everything else is scored against it and a
weak null flatters the field.

## What an operator can do today, honestly

This is a good page in more ways than the complaint suggests, and the parts that
are good are the parts an option could break.

**Reading a note works and is finished.** The note is state, the URL follows it,
Back works five links deep, every link is a real `<a href>` so ⌘-click opens a
second tab, and one delegated handler covers the list, the backlinks, the health
rows and the wikilinks inside a body (`page.tsx:41-55`, `:390`). Opening a note
moves focus into a labelled region and announces it politely
(`:416-428`). None of that is a workaround; it is a small, complete design.

**The graph answers in a frame.** Every toggle narrows a payload already in
memory (C2). `docs/verification.md:771-804` measured the real vault at 893 nodes
and 19,995 edges settling in 251 frames / 374ms, at 1.49ms mean per step, with
the draw loop's own JS at 0.137ms a frame — about 1.6ms of a 16.7ms budget. The
panel *is* sweepable, which is what its header says it is for.

**The counts do not lie.** `shown of total drawn` is gated on the fetch rather
than defaulted to zero, with a comment saying why (`KnowledgeGraphView.tsx:294-297`).
The health cards show the whole count and say the list was cut
(`page.tsx:887-893`). The truncation notices fire on both the vault walk and the
node cap (`page.tsx:398-403`, `KnowledgeGraphView.tsx:221-226`).

**The seven-group seed is a real courtesy.** A first-time operator's graph opens
already coloured by the vault's own most-used tags, which is a better first
picture than seven identical grey clouds, and the seed fires exactly once with
two guards against undoing an operator's edit (`KnowledgeGraphView.tsx:99-108`,
`:156-167`).

**A node the reader is reading is already ringed.** K4 corrects the complaint on
this point: the marker is drawn (`KnowledgeGraphCanvas.tsx:303-310`).

## What an operator cannot do today

- **Learn what any mark means.** No legend, and the only prose is four gestures
  (`KnowledgeGraphView.tsx:310`).
- **Get back to a framed view after one drag.** `fitView` runs once and only
  while `touchedRef.current` is false (`KnowledgeGraphCanvas.tsx:356-359`).
  After a pan, a reload is the only route.
- **Read a node without opening it.** A click opens the note (`:593-596`), which
  is a navigation. There is no way to ask "what is this node" and stay where you
  are.
- **Tell an attachment from a note.** Same fill (`:669-675`).
- **Tell the open note from the node under the cursor, in light mode.** Same
  colour (`globals.css:70`, `:89`).
- **Reach the graph without scrolling past the note and the table**, which on a
  phone is roughly 250 labelled lines (K2).
- **Use the canvas from a keyboard**, which is deliberate (C4), or hear anything
  about it from a screen reader, which is not deliberate — it is an omission the
  app's newer canvas does not share (`PathMapCanvas.tsx:800-801`).

## The honest case for doing nothing

Three arguments, and the first is not weak.

**1. There is one operator and they have already learned it.** The controls are
Obsidian's, reimplemented (`knowledgeGraph.ts:12-21`), and somebody who uses
Obsidian knows what "Existing files only" and "Link distance" do without being
told. The complaint is a first-look complaint — "not visible at first look" —
and a surface with exactly one user has exactly one first look, which has
already happened.

Against it: the complaint was made *after* that first look, by the person who
built it, which is the strongest possible evidence that the learning did not
stick. And two of K4's items are not learnable at any exposure — the
attachment/note collision and the tint/accent collision are not knowledge an
operator can acquire by looking harder.

**2. Nothing here is wrong, and the change budget has a queue.**
`proposals/` holds fourteen open surveys. `docs/verification.md:1996-2044` still
carries a ten-step click-list for this exact canvas that **nobody has run** —
the `canvasView.ts` extraction was done by a run with no browser, and pan, zoom,
hit-testing, dpr and the resize ratchet are all "known to compile" and nothing
more. Changing this surface before that list is run means the next person cannot
tell a new bug from an old one.

This is the strongest argument in this file and it survives into the
recommendation as a sequencing constraint rather than as a reason to stop —
see `11-validation.md`.

**3. Every option risks the thing that is good.** The panel is sweepable; a fold
makes it less so. The picture settles and stops; anything overlaid on the canvas
can restart the loop. The note leads the page for a measured reason (C6); a
reorder is one JSX move away from breaking it.

## What Option A does not fix

All of K4. That is the whole objection to it, and it is enough on its own.

"Not visible at first look what I am looking at" is the one complaint of the
three where doing nothing has no partial credit: the reader is looking at a
field of grey and blue dots and there is no path from more exposure to knowing
what a size means, because the size means something the interface has never
stated and which is not what the obvious guess would be (K4: degree in the
*drawn* graph, not the vault).

## Score, and where it is generous

| Criterion | Score | Note |
|---|---|---|
| 1 Not-visible | **1** | The only 1 in the table |
| 2 Overwhelming | 1 | |
| 3 Navigate | 1 | |
| 4 Contradicts | **5** | By construction |
| 5 Keyboard | 3 | Unchanged, and C4 says unchanged is a decision |
| 6 Screen reader | 2 | Not neutral: an unnamed canvas is a live gap, and the app has already answered it elsewhere |
| 7 Phone | 2 | K2 is a phone artefact that exists today |
| 8 Regression | **5** | By construction |
| 9 Radius | **5** | By construction |

**Total 84 of 160.** As `OperatorInterface/11-comparison.md` warns of its own
table, a weighted table rewards not breaking things and the null scores a
perfect 5 on three criteria by construction. **Read column 1 first.**
