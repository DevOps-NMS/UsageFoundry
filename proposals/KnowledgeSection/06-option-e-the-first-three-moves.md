# Option E: the first three moves, and no fourth

An option the brief's four do not contain, and the one the repository's own rule
says to try before any of them.

`ui-density-audit.md:92-107` orders the moves **Delete, Group, Reorder, Hide**
and says hiding is not the default fix for a crowded page. Options C and D are
the fourth move and a fifth one the list does not have. K5 established that the
first three have never been run on this route. This option is those three moves
and nothing else.

---

## E1. Reorder: the graph goes above the Notes table

**One JSX move.** `page.tsx:709` — the `<KnowledgeGraphView />` line and its
comment block at `:696-708` — moves above the browse block at `:510-694`. Order
becomes:

1. The open note (unchanged — C6 binds it and it stays first)
2. **The graph**
3. Notes
4. Health

**What it costs, and it is not nothing.**

*The header comment at `KnowledgeGraphCanvas.tsx:70-75` becomes false in one
word.* It reads: "every note this can open is also a row in the list **above**
it, which is reachable, ordered and searchable". After E1 the list is below. The
*substance* of C4 — that the graph is a second route and the reachable one is a
list — survives at any order; the word does not. **The comment is edited in the
same commit or this option is a documented invariant quietly falsified**, which
is the failure mode `CLAUDE.md` names. The replacement is "is also a row in the
Notes list on this page".

*It makes C5 more visible, which is a gain wearing a cost's clothes.* The graph
and the Notes list now sit adjacent, each with its own search box, and they
deliberately do not share filters (C5, and `page.tsx:702-708` records that this
was got wrong once). Adjacency makes the independence obvious to an operator who
types in one box and watches the other not change — which is better than the
current arrangement, where three screens of separation let a reader assume
whatever they like. But it is more likely to *prompt* the question, and the
answer has to be on the page. `KnowledgeGraphView.tsx:401-410`'s `Filters`
footnote already explains the query language; one clause is missing from it and
E1 is what makes the clause worth adding: **"…not its body, and not the filters
on the Notes list below."**

*Nothing else.* The graph does not read page state, is mounted unconditionally,
and holds all its own settings. Moving it is a move.

**What it fixes.** On a desk, the graph is one block below the note instead of
two, and the block it skips is the 320px capped table plus four filter controls
and a sort strip. On a phone, it skips **the uncapped 50-row table** — K2's ~250
labelled lines — and that is the whole of K2's cost, removed by moving one JSX
element.

## E2. Reorder inside the panel: the colour-group *list* rises, the editor sinks

Not a fold (that is Option C). A move.

`GroupList` (`KnowledgeGraphView.tsx:651-771`) currently renders as one block
fourth in the panel. Split it where it is already two things:

- The **seven read-only rows** — position number, swatch, query as text — stay
  where they are, at position four, carrying **zero** focusable controls.
- The **editing controls** — `ColorSwatch`, query `Input`, Up, Down, Remove per
  row, the tag chip row, `Add group` — move to the **bottom of the panel**,
  below Forces and above `Reset to defaults`, under their own `ListGroup
  label="Edit colour groups"`.

That is §1.0's third move applied literally: common above rare, within the
group. It removes 48 controls from position four and puts them at position
seven.

**Why this is weaker than folding them, and the file says so.** The 48 controls
are still in the column and still decide its height, and by C11 the column's
height is the graph's. Reordering moves the crowding down; it does not remove
it. `04-option-c` makes exactly this argument in the other direction and both
files agree: **on this panel the third move genuinely does not do the third
move's job**, and that is the licence for the fourth. E2 is included because
§1.0 requires it to be tried, and it is scored on what it actually achieves,
which is less than C.

## E3. Delete: three clauses, and the count is small

The first move, run honestly. Nearly nothing qualifies, and saying so is the
point — this page has already had a deletion pass (`page.tsx:713-715` records
its lede being cut for restating its heading).

What survives a reading:

- **`KnowledgeGraphView.tsx:310`** — "Drag to pan, scroll to zoom, drag a node
  to place it, click one to open the note." Four gestures in one 12px line under
  the card. Three of the four are the browser's conventions for any pannable
  surface and the fourth — click opens the note — is the only one carrying
  information. Under the house rule (delete the sentence; if nothing became
  unclear it was not working) the first three go and **"Click a node to open the
  note."** stays. *But* — `runs/[id]/touched/page.tsx:404-407` states the same
  three gestures on the other canvas, so deleting them here makes two canvases
  disagree about how much they explain themselves. **Not deleted. Filed as a
  question for whoever owns the canvas pair**, and named here so it is not
  silently kept.
- **`page.tsx:824-828`'s second sentence** is not deletable: "Read-only" is the
  one fact this page exists to assert and C1 turns on it.
- **The five `ListRow` descriptions in the panel** each state a consequence the
  label does not (`:362`, `:389`, `:442`, `:453`, `:476`, `:510`). None is
  redundant. Kept.

**Net deletion: zero words, one filed question.** That is the honest result of
the first move on this page, and it is worth having run: it means the crowding
is controls rather than prose, which is what decides between C and E in the
first place.

## What Option E does not fix

- **All of K4.** Nothing about the picture.
- **The 64 controls.** E2 moves 48 of them down a column they are still in.
  Criterion 2 gets a small score, not a large one, and the file is explicit
  about why.
- **Anything for a keyboard or a screen reader.** Order changes for everyone
  equally; a listener navigating by heading now hears `Graph` before `Notes`,
  which is a change and not an improvement.

## What is good about it

**It is the cheapest thing in the survey by an order of magnitude, and it
removes the single worst artefact anyone measured.** E1 is one JSX move plus one
comment edit plus one added clause in a footnote, and it deletes K2 — the
uncapped 50-row, ~250-line table between a phone reader and the graph. Nothing
else in the survey gets that ratio.

It is also the move that **must** happen before Option C is judged, because §1.0
says so, and because a reader who has run it can then say whether the panel is
still the problem. If E1 alone satisfies the "overwhelming" complaint, C is
unnecessary; if it does not, C has evidence rather than an argument.

## Score

| Criterion | Score | Note |
|---|---|---|
| 1 Not-visible | 1 | Touches none of K4 |
| 2 Overwhelming | 3 | Removes two blocks from above the graph; moves 48 controls without removing them |
| 3 Navigate | 1 | |
| 4 Contradicts | 4 | Falsifies one word of `KnowledgeGraphCanvas.tsx:70-75` and repairs it in the same commit; nothing else |
| 5 Keyboard | 3 | Order changes, nothing added or removed |
| 6 Screen reader | 3 | Heading order changes; neither better nor worse |
| 7 Phone | 4 | E1 deletes K2 outright. Below 5 only because the 64-control panel is still under the canvas |
| 8 Regression | 4 | A JSX move of a self-contained component with no page state, plus a panel split with no logic in it |
| 9 Radius | **5** | Two files, one of them by two lines |

**Total 93 of 160.** Recomputable with `node proposals/KnowledgeSection/score.mjs`.
