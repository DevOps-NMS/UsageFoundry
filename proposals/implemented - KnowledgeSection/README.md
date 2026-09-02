# The Knowledge section

**The question:** the operator says `/knowledge` is overwhelming, its node view
is hard to navigate, and it is not visible at first look what they are looking
at. What is worth changing, with the graph as the priority?

**The state:** open. Six findings, seven options, one recommended as a sequence
of three commits, one refused with the answer that would reverse it, and eleven
things refused by name. **Nothing here is a decision and no product code
changed.**

## The recommendation

**Option G — E1, then B, then C, with F2 and F3 — in three commits**,
[10-recommendation.md](10-recommendation.md).

1. **Move the graph above the Notes table.** Two lines, and it deletes the worst
   thing anyone measured here: on a phone the browse table is 50 rows at full
   height (`ListView`'s cap is deliberately released below `md`), roughly 250
   stacked lines between a reader and the graph.
2. **Give the canvas an orientation layer.** A legend that says what every mark
   means; a readout of the node under the pointer that persists after the
   pointer leaves; the open note's ring changed from `--tint` to `--fg`, because
   `--tint` and `--accent` are the same hex in light mode and `--accent` is the
   hover fill; an outline on attachments, which are currently drawn identically
   to notes; a `Fit` button, because `fitView` already exists and is unreachable
   after one drag; and `role="img"` with an `aria-label`, which the app's other
   canvas has and this one does not.
3. **Fold Display, Forces and the colour-group editor.** 64 focusable controls
   on a first visit become 11.

**Why a combination rather than one of them:** the complaint is three sentences,
and **no single option scores above 1 on more than one of the three**. B answers
"not visible" and makes "overwhelming" worse by adding to the panel. C answers
"overwhelming" and hides controls without explaining anything. Together the
column is shorter than it is today while carrying more information, which is the
only arrangement that answers both.

**What would overturn it:** the operator saying they want the graph as a
*destination* — a URL — rather than part of a page. That single answer moves
Option D from sixth to first. It is the blocking question in
[11-validation.md](11-validation.md) and it is not inferable from "overwhelming".

**Refused by name:** splitting the route (with the sentence that reverses it),
four tabs specifically, a keyboard route into the graph, a tooltip or hover-only
readout, a `Sheet` for the colour editor, joining the graph's search to the
list's filters, an eighth `globals.css` token, `useImperativeHandle`, making
`textFade` relative, and deleting three of the four gestures from the caption.
Full list at the foot of [10-recommendation.md](10-recommendation.md).

## The findings at a glance

| | |
|---|---|
| Lines in `src/app/knowledge/page.tsx` | **1,017**, four unrelated blocks, one scroll, no navigation between them |
| Rows the browse table draws | **50** (`KNOWLEDGE_PAGE_SIZE`, and the page sends no `limit`) |
| Height that table is capped to | 320px above `md`; **uncapped below it**, by design |
| Focusable controls in the graph panel, first visit | **64** in `Whole vault`, **68** in `This note` |
| Of those, in the colour-group block | **48**, three quarters, and it is the block used once |
| Why 48 rather than the ~25 the complaint counted | The seed writes `MAX_GROUPS` = **7** groups on a first visit, at 5 controls each |
| Legends on this canvas | **0**. The app has two, both on canvases built later |
| Accessible name on this canvas | **none**. `PathMapCanvas` has one |
| Ways back to a framed view after one pan | **0** short of a reload, though `fitView` is written and called once |
| Node kinds drawn with the same colour | **2** — a note and an attachment, both `--fg-muted` |
| Marks that are the same colour in light mode | **2** — the open note's ring (`--tint`) and the hover fill (`--accent`), both `#0069d9` |
| What a node's size means | Degree **in the drawn slice**, not in the vault. Nothing says so |
| Days between the density audit landing and this route landing | **2**. `/knowledge` was never one of the audit's eleven surfaces |
| `docs/agent/` docs for this route | **0**. Its reasoning is in four file headers, all read in full |
| Browsers driven by this survey | **0** |

## Files

| | |
|---|---|
| [00-problem.md](00-problem.md) | K1–K6, measured, with what the three complaints each map to and what was not inspected |
| [01-constraints.md](01-constraints.md) | C1–C13, every decision that bounds the field, and the nine criteria with their weights |
| [02-option-a-change-nothing.md](02-option-a-change-nothing.md) | The null at its strongest, including the sequencing argument that survives into the plan |
| [03-option-b-orientation-layer.md](03-option-b-orientation-layer.md) | **Recommended.** The legend word for word, the readout, two colour repairs, `Fit`, an accessible name |
| [04-option-c-progressive-disclosure.md](04-option-c-progressive-disclosure.md) | **Recommended.** Three folds, and why the refusal next door does not carry |
| [05-option-d-split-the-route.md](05-option-d-split-the-route.md) | Refused on cost and sequence, with the operator's sentence that reverses it |
| [06-option-e-the-first-three-moves.md](06-option-e-the-first-three-moves.md) | **Recommended in part (E1).** Delete, Group, Reorder — the moves the audit requires before any fold |
| [07-option-f-change-what-it-opens-on.md](07-option-f-change-what-it-opens-on.md) | **Recommended in part (F2, F3).** Four literals in the one tested file, and the objection that nearly kills it |
| [08-option-g-the-combination.md](08-option-g-the-combination.md) | **Recommended.** Why these compose rather than coexist; what is left out and why |
| [09-comparison.md](09-comparison.md) | Nine weighted criteria, a second table scoring the complaint alone, and where the first one misleads |
| [10-recommendation.md](10-recommendation.md) | The build specification: every control's place, the legend's copy, every fold's default state, the readout's rows, the files |
| [11-validation.md](11-validation.md) | Seven checks, one blocking question, what would count as failure, and what this owes `docs/agent/` |
| [score.mjs](score.mjs) | The table's arithmetic. `node proposals/KnowledgeSection/score.mjs`, no dependencies |

## Two corrections to the brief this survey was given

Both matter, and both are in the direction of the problem being different rather
than smaller.

**The open-note marker exists.** The brief says nothing on screen says which node
is the open note. `KnowledgeGraphCanvas.tsx:303-310` rings it. What is true is
that nothing *explains* the ring — and that in light mode it is drawn in the
same colour as the hover fill, which is a defect the brief did not know about
and which is worth more than the original claim.

**The panel is 64 controls, not 25.** The ~25 figure is the count for an
operator who has removed every colour group. A first visit gets seven seeded
groups at five controls each. The crowding is worse than reported and it is
concentrated in one block, which is what makes it fixable.

## What was not done

- **No browser was driven and no vault was mounted.** There is none in this
  container. Every claim about what is on screen is read from source; every
  claim about a colour is arithmetic on a declared value. Nothing here has been
  *seen*.
- **Nothing was heard.** The screen-reader column is inference from markup.
- **Nothing was timed.** The frame-budget and payload figures are quoted from
  `docs/verification.md:771-804` and `:1284-1342`, measured 2026-08-22 on a
  vault that has changed since.
- **§3 and §8 of `docs/agent/ui-density-audit.md`** — about 2,300 lines of
  per-surface specification — were not read, on the ground that none of the
  eleven surfaces is this route. Sections 1.0, 1.1, 1.2, 2.1, 2.2 and 2.3 were.

Full accounting: [00-problem.md](00-problem.md#what-was-not-inspected).

## Neighbours

[OperatorInterface](../OperatorInterface/) is the shape this survey follows and
the source of two of its constraints. Its
[09-option-h](../OperatorInterface/09-option-h-progressive-disclosure.md)
**refuses progressive disclosure** on `/settings`, and this survey recommends it
here. That is not a contradiction and the difference is countable: that refusal
rests on §1.0's move order and on `/settings` having already had the first three
moves in two documented passes. **This route has had none**, because it landed
two days after the audit and was never one of its surfaces. The other three
grounds of that refusal — the named prohibitions, the evidence, and the
diagnosis — are each answered in
[04-option-c](04-option-c-progressive-disclosure.md)'s opening table rather than
ignored.

Its C10 — nothing that renders is checked by anything — is unchanged and is why
this survey pushes what it can into `src/lib/knowledgeGraph.ts`, the one file on
this route with a test suite around it.

Verification loop on the tree this was written against (`bdaefdf`):
`npm run typecheck` exit 0, with **nothing under `src/` changed by this survey**.
