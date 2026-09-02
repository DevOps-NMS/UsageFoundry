# Option D: split the route — tabs, or sub-routes

The four blocks stop being one scroll. Two variants, and they are genuinely
different proposals rather than one idea with an implementation detail.

---

## D1. A tab strip on `/knowledge`

One `SegmentedControl` under the `<h1>`, four segments, and the page renders one
block at a time.

**It is legal, once.** C10: `ui-density-audit.md:120` caps a tab strip at five
segments and **one strip per page**. `/knowledge` has two `SegmentedControl`s
today — the sort strip (`page.tsx:596-601`) and the graph's view scope
(`KnowledgeGraphView.tsx:348-353`) — and **neither is a tab strip** under §1.1's
definition, because neither switches which pane is shown. So this would be the
page's first strip. It would also be its last, and §1.2 item 4 forbids a tab
strip inside a tab, which retires the option of ever splitting the graph panel
the same way.

The precedent is `/runs/[id]`, which does exactly this: a `SegmentedControl` at
`page.tsx:1595`, tab state in `useState` (`:482`), a tab that would be empty is
not offered (`:973`, `:995`), and only the active tab is mounted.

**But three of the four segments break something specific.**

**The note tab breaks C6.** `page.tsx:57-68` puts the note above the list
because otherwise a click on a row "could scroll nothing, move no focus and
change only a panel below the fold: the reader's own click was the only evidence
anything had happened". A tab makes that worse, not better: the row is now on a
*different tab* from the note it opens, so a click either switches tabs under the
reader — which `/runs/[id]`'s own rule forbids, and the comment at
`page.tsx:416` in that file says so ("one tab never moves you to another") — or
it does nothing visible at all, which is the exact failure C6 was written to
prevent.

**The graph tab breaks nothing and gains the most.** A tab is a whole pane for
one canvas, at the pane's full width, with the panel beside it above `lg`.

**The health tab is right.** Three cards read once a week.

So the honest form of D1 is **not four tabs**. It is: the note and the list stay
together on one tab (because C6 binds them), and graph and health are the other
two. Three segments — `Notes`, `Graph`, `Health` — with the reader living inside
`Notes`.

That is a better proposal than the brief's four, and it is worth stating that
the constraint produced it rather than taste.

**What a tab costs that a scroll does not.** The graph unmounts when the tab
changes. `KnowledgeGraphView`'s fetch is a mount effect with `[]` deps
(`:134-179`), so **every return to the Graph tab is a fresh
`/api/knowledge/graph`** — measured at 7,330,042 bytes in 605ms on the real
vault (`docs/verification.md:775-777`), and separately at 9,864,990 bytes and a
30.6ms main-thread block for `JSON.parse` at `:1284`, `:1338`. Today that
happens once per page load. Under D1 it happens once per tab visit.

That is fixable — hoist the fetch, or keep the graph mounted and hide it — but
"keep it mounted and hide it" is precisely what `/runs/[id]` decided *against*
(`ui-density-audit.md:301-303`: "only the active tab is mounted" is a tab-strip
decision that stays one), and hoisting the fetch to the page means the page owns
graph state, which is the coupling `KnowledgeGraphView` exists to avoid. **The
cost is real and D1 does not have a free answer to it.**

## D2. Sub-routes: `/knowledge`, `/knowledge/graph`, `/knowledge/health`

The same split, in the URL.

**It costs nothing in the shell.** `activePane` matches on a path segment
(`panes.ts:68-76`), so `/knowledge/graph` still lights the Knowledge row and ⌘7
still comes back. `toolbarTitle` falls through to `activePane(pathname)?.label`
(`:101`), so the toolbar would read "Knowledge" on all three — which is either
fine or wants two lines beside the `/runs/*` cases at `:90-94`, and that is the
`/touched` precedent exactly.

**It is not a tenth pane** (C8 item 1). §1.2's own note records why `/knowledge`
got a row rather than a sub-route — "a vault is neither a run, a workflow nor a
setting" — and that reasoning does not extend to *the graph of the vault*, which
is about the vault and belongs under it. `/runs/[id]/touched` and
`/runs/[id]/conflicts` are the shape.

**It is the only variant that gives the graph a bookmark.** An operator who
looks at the graph daily gets a URL. Under D1 they get a page and a click.

**It costs what D1 costs and one thing more.** A sub-route is a fresh document,
so the graph fetch happens on every arrival with no possibility of hoisting, and
the status fetch (`page.tsx:146-158`) has to be repeated on each of the three
routes or lifted into a layout. `/api/knowledge/status` is cheap, but the graph
is not.

And it fragments the reader: today a wikilink inside a note body, a backlink, a
health row and a graph node all go through **one** `openNote`
(`page.tsx:388-390`, `:709`), which is a mechanism the page's header is proud of
and which makes ⌘-click work everywhere. Under D2 a graph node's click has to
navigate to a *different route* carrying `?note=`, and the delegated handler on
`/knowledge` no longer covers it. That is not fatal; it is one more thing that
has to keep working, in a repository where nothing that renders is tested.

## What either variant fixes

**K1 and K2, completely and better than anything else in the survey.** The graph
is not below the note, the table, or 250 stacked lines on a phone. It is the
whole surface. On a phone that is the single largest improvement available.

## What Option D does not fix

- **All of K4.** A tab containing an unreadable picture is an unreadable picture
  with a tab. This is the point worth stating loudest: **splitting the route
  answers the complaint the operator did not lead with and none of the two they
  did.**
- **The 64 controls.** They are all still there, in a column, beside a bigger
  canvas. Arguably worse: with the graph on its own surface at full width, the
  panel is the only other thing on screen and its density is the surface's
  density.

## What it risks

The largest blast radius in the survey. D1 restructures the render of a
1,017-line page; D2 splits it into three route files plus a shared layout, moves
the status fetch, and changes the click contract for graph nodes. C13: nothing
renders in a test, and `docs/verification.md:1996-2044` still lists a ten-step
manual click-list for this canvas that **nobody has run** — under D2 that list
would have to be re-run at a new URL before anyone knew whether the extraction
that prompted it was still sound.

## Score

Scored as D2, the stronger variant. D1 scores the same on 1–3 and one better on
9.

| Criterion | Score | Note |
|---|---|---|
| 1 Not-visible | 1 | Touches none of K4 |
| 2 Overwhelming | 4 | Removes three blocks from the graph's surface; leaves 64 controls on it |
| 3 Navigate | 2 | A bigger canvas is easier to navigate; nothing else changes |
| 4 Contradicts | 3 | Four tabs would break C6 and §1.2 item 4; the three-segment form does not. Scored for the three-segment form, with a point off because the four-segment form is what was asked for and it is refused |
| 5 Keyboard | 4 | One roving-tabindex stop replaces a long scroll; no control folded |
| 6 Screen reader | 3 | Three shorter documents beat one long one; the canvas is still unnamed |
| 7 Phone | **5** | The largest phone gain available. K2 stops existing |
| 8 Regression | **1** | The largest restructure here, in the least-tested part of the app, with an unrun click-list already outstanding |
| 9 Radius | **1** | Three route files, a layout, the status fetch, and the click contract |

**Total 85 of 160.** Recomputable with `node proposals/KnowledgeSection/score.mjs`.
