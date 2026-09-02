# Constraints, and the criteria every option is scored on

Two halves. **C1–C13** are things already decided, in descending order of how
much field they remove; an option that contradicts one argues against it by name
or is out. **The criteria** are what the comparison table scores, defined here so
the scoring cannot be invented later to fit a preferred answer.

---

## The constraints

### C1. The page is read-only, and it says so on the page

`src/app/knowledge/page.tsx:31-40`:

> **Read-only, and it says so on the page.** There is no write endpoint under
> `/api/knowledge` and no control here that could reach one. The vault is a
> store somebody edits in Obsidian, usually while a run is working in it, and
> an app that could half-edit it from a second place is one nobody could trust
> either half of.

`ls src/app/api/knowledge/` is seven directories — `graph`, `health`, `note`,
`notes`, `search`, `skill`, `status` — and
`grep -rn "export async function \(POST\|PUT\|DELETE\|PATCH\)" src/app/api/knowledge/`
returns **nothing**. `PageHead` states it in the page's second sentence
(`page.tsx:826-827`).

**No option in this survey may add a write path**, and none does. Recorded first
because it is the constraint most likely to be violated by accident: a legend
row that says "broken" invites a Fix button, and a readout of a node invites a
Rename.

### C2. One fetch of every kind, narrowed in the browser

`KnowledgeGraphView.tsx:44-50`:

> **One fetch, every kind, no server-side query.** `/api/knowledge/graph`
> accepts `kinds`, `tag` and `q`, and none of them is used here beyond asking
> for all four kinds at once. Every control in the panel then narrows what was
> fetched, in `knowledgeGraph.ts`, in the browser. That is the difference
> between a toggle that answers in a frame and one that answers in a round
> trip over a vault walk — and the whole panel is built to be *swept* through,
> because what it is for is finding the setting that makes a shape appear.

The URL is a literal constant with every kind in it
(`KnowledgeGraphView.tsx:69`). The narrowing is three pure memos in sequence —
`localGraph`, `filterGraph`, `capGraph` (`:186-193`) — each in `src/lib` so it
is testable (`knowledgeGraph.ts:5-10`).

**A proposal that reintroduces a round trip per toggle is rejected on arrival.**
This also bounds the *readout* in Option B: everything it can show has to be on
a `KnowledgeNodeDTO` already in memory (`apiTypes.ts:2752-2763` — id, kind,
title, path, tags, aliases, inDegree, outDegree). A readout that wanted a note's
body would be a fetch per hover, which is this constraint twice over.

### C3. Graph settings live in `localStorage`, not in `Settings`

`KnowledgeGraphView.tsx:59-63`: presentation state for one operator at one
screen size, the same class of thing as the sidebar's docked width and the
workflow editor's saved layout. Key `uf.knowledge-graph` (`:66`), read once
after mount (`:110-124`), written back on every change except while a seed is
owed (`:126-132`), coerced through `coerceGraphSettings` on the way in
(`knowledgeGraph.ts`, and every slider clamped by `GRAPH_RANGES` at `:547-556`).

Two consequences for the options:

- **Any new persistent state an option introduces goes in the same key** and
  through the same coercion, or it is a second store for one surface.
- **A disclosure's open/closed state is a candidate for that key**, and Option C
  has to decide whether it goes there. It is not free: `coerceGraphSettings`
  is what stops a hand-edited entry throwing, and a new field needs the same
  treatment.

### C4. The graph is a pointer surface with no keyboard route, deliberately

`KnowledgeGraphCanvas.tsx:70-75`:

> **The pointer is the only input here that has no keyboard route, and that is
> deliberate.** Panning and zooming a force layout is a way of *looking*; every
> note this can open is also a row in the list above it, which is reachable,
> ordered and searchable. A graph is the second route to that content, not the
> only one, so it stays a pointer surface rather than growing a spatial
> keyboard model nobody would find.

This is the constraint that decides half of the "difficult to navigate"
complaint, and it decides it **against** the obvious repair. It is not a gap
somebody forgot; it is a paid-for trade with a named alternative — the browse
table — and the alternative is genuinely reachable, ordered and searchable
(`page.tsx:510-694`).

What it permits, and this is the seam every option should use: the constraint is
about a **spatial keyboard model** — arrowing between nodes, tabbing through a
force layout. It says nothing about ordinary keyboard-operable *controls* placed
beside the canvas. A `Fit` button is a button. A readout is text. Neither is a
spatial model and neither is barred by this sentence.

What it forbids: `tabIndex` on the canvas with arrow-key node traversal, a
roving tabindex over nodes, or a hidden focusable list of nodes overlaid on the
canvas. **Any option proposing one of those is arguing against this paragraph
and must say so.** None here does.

### C5. The graph does not read the list's filters, and that is a decision

`KnowledgeGraphView.tsx:52-57` and again at `page.tsx:702-708`:

> **The panel's search is not the page's.** The list above this has its own
> folder / tag / type / text filters, and the graph deliberately does not read
> them: the graph's query is the one Obsidian's graph view has, over the whole
> vault, and a graph silently showing the twenty notes the list happened to be
> filtered to would be a second view of the vault that disagrees with the first
> about what is in it.

Note the second half of `page.tsx:703` — *"which an earlier note here expected
it to"*. This was got wrong once and then written down twice. An option that
joins the two filter sets is not proposing a feature; it is reverting a fix.

**No option in this survey proposes joining them.** Option E moves the two
blocks nearer each other, which makes the independence *more* visible rather
than less, and that is a cost it has to carry — see `06-option-e`.

### C6. The note leads the page, and the reason is not aesthetic

`page.tsx:57-68`:

> The open note is the first block, above the list it was picked from. The list
> is a height-capped box, so with the note under it a click could scroll
> nothing, move no focus and change only a panel below the fold: the reader's
> own click was the only evidence anything had happened.

Plus a mechanism: the note sits in its own JSX slot ahead of the list's, so
React *inserts* rather than moves, and the capped list keeps its scroll position
(`:66-68`); and focus is moved into the note region, which is `tabIndex={-1}`
with `role="region"` and an `aria-label` (`:416-428`).

**The note block stays first.** Every reordering option in this survey moves
blocks 2, 3 and 4 and leaves block 1 where it is. An option that moved the note
below anything would have to explain what a reader's click does instead, and
none of them has an answer.

### C7. Hiding is the fourth move, not the first

`docs/agent/ui-density-audit.md:92-107`, §1.0:

> 1. **Delete redundancy.** … 2. **Group.** … 3. **Reorder.** … 4. **Hide.**
> Last, and only under §2.
>
> Hiding is not the default fix for a crowded page, and treating it as one is
> how a page becomes fuzzy in a second way: a reader who cannot find a control
> assumes it does not exist.

Per K5 this route has never had that pass. So unlike
`proposals/OperatorInterface/09-option-h`, an option here that proposes hiding
is **not automatically the fourth move on a page where three have been made** —
but it does owe an account of the first three. Option C owes it and pays it in
`04-option-c`; Option E is the first three and nothing else.

### C8. What §1.2 forbids by name, and what it explicitly permits

`ui-density-audit.md:155-197`. Six of the ten bear on this survey:

| # | Forbidden | Live here |
|---|---|---|
| 1 | A tenth pane | Option D's sub-route variant must be a **sub-route**, not a pane. `/knowledge` is already the ninth (`panes.ts:49`) |
| 2 | An **accordion** — a coordinated set where opening one closes another | Option C must use independent siblings. §1.2 is explicit: "**Independent sibling `Disclosure`s are not an accordion**: four folds in one section, each opening and closing on its own, are four folds" (`:173-176`) |
| 3 | Nested disclosure | A fold inside the `Colour groups` fold is out |
| 4 | A tab strip inside a tab | Bounds Option D: a tab strip over the four blocks means the graph panel may not then grow one |
| 6 | A tooltip carrying anything the reader needs | **The whole reason the readout in Option B is a fixed box.** A hover-only node readout is this violation wearing a different name |
| 7 | A hover-reveal of any kind | Same. The readout must persist after the pointer leaves |

Item 2's carve-out is what makes Option C legal at all, and it is quoted rather
than paraphrased because the distinction is the entire argument.

### C9. §2.2's tiers say what may fold, and §2.3 says what may not

`ui-density-audit.md:343-379`. **Tier 1** is anything read or changed on more
than half of visits, anything that changes on its own, or **anything a decision
taken on this surface is approved against** — that last clause is a safety floor
that outranks the other two.

This page approves no decisions. It is read-only (C1), spends no money, starts
no run and lands no branch. **So clause (c) is empty here**, which is unusual
and is why folding is safer on this route than on any other surface in the app:
the worst case of a fold in the wrong place is a picture that looks wrong, not a
run that costs wrong.

**Tier 2** is "set once per run, per repository or per install, **and** not
covered by (c)". Display and Forces are exactly that. So is the colour-group
*editor*.

And the rule that makes a fold safe (`:365-366`):

> **A fold whose contents differ from their defaults opens by default, and its
> summary says how many differ.**

Every default is a literal in `GRAPH_DEFAULTS` (`knowledgeGraph.ts:531-544`), so
"differs from default" is a cheap comparison and the escape hatch at `:373-374`
— "where a build run cannot compute it cheaply, it does not get to fold" — does
not apply. **Any fold Option C proposes must implement this rule.**

§2.3's anti-rule 1 also binds: *rarity never demotes a control below the thing
it modifies*. `Reset to defaults` (`KnowledgeGraphView.tsx:565-569`) is the only
way to undo everything above it, so it stays outside every fold.

### C10. The kit's grouping vocabulary is closed, and a region is not a group

`ui-density-audit.md:109-122` is seven affordances and no eighth. Three caps
bind here:

- **Card**: ≤ 7 as peers at one level; ≤ 9 controls in one card without an inner
  `ListGroup`; at most one `primary` per page. The graph panel is one `Card`
  with five `ListGroup`s (`KnowledgeGraphView.tsx:347`), which is how 64 controls
  are legal in one card.
- **Group** (`ListGroup` with `label`): 3–9 rows. **`Colour groups` at seven
  seeded rows is at the top of that range and `Filters` at five is mid-range.**
  A fold that split `Filters` into two groups of two and three would be creating
  a group of two, which `:118` allows only where the label states something
  neither row does.
- **Tab strip**: ≤ 5 segments, **one strip per page**. `/knowledge` has two
  `SegmentedControl`s today — sort (`page.tsx:596-601`) and view scope
  (`KnowledgeGraphView.tsx:348-353`) — and neither is a tab strip, because
  neither switches which pane is shown. So Option D's tab variant would be the
  page's **first** strip, at four segments, which is legal. It would also be its
  last.

And §2.3's anti-rule 4: a **region** names *why* its contents sit together and
may hold one card. `page.tsx:416-423` already builds one by hand — a `<div>`
with `role="region"`, `tabIndex={-1}` and an `aria-label` — with a comment
saying why it is not a `<section>` (the legacy sheet's `section + section`
margin). That is the precedent any option adding a labelled region copies.

### C11. Nothing on a canvas may state an outline, a ratio, or its own colour

Four rules from `docs/agent/conventions.md`'s canvas paragraph, all of which the
existing component already obeys and none of which an option may quietly break:

- **A 2D context takes a string, not a custom property**, so a colour is
  resolved by `probeTokens` off a real element and re-probed on both a
  `data-theme` mutation and a `prefers-color-scheme` change
  (`KnowledgeGraphCanvas.tsx:103-125`, `:384-394`). **A legend drawn *on* the
  canvas would need every swatch probed; a legend drawn in DOM beside it takes
  `bg-accent` like any other box.** That is the whole reason Option B's legend
  is markup.
- **The backing store is device pixels and the element is CSS pixels**
  (`observeCanvasSize`).
- **The loop ends** when `step()` reports the alpha is spent (`:346-364`), and
  every gesture reheats it explicitly. A `Fit` button must call `schedule()` and
  must not reheat, or pressing it disturbs a settled layout.
- **The element is out of flow**, because the observer writes the host's measured
  height back onto it, and an in-flow canvas ratchets against a host a panel can
  shrink (`:651-657`). **Anything an option overlays on the canvas is a sibling
  of the `<canvas>` inside the same `relative` host, never a child**, and it
  needs `pointer-events-none` or it eats the drag.

The 4:3 box is a **floor** held by a `self-start` sizer sharing the canvas's
grid cell (`:254-257`), for the reason written at `:232-251`: the panel is the
taller column at every width the two sit side by side. **An option that shortens
the panel shortens the graph**, because the row's height is the taller column's.
That is a real and counter-intuitive cost of Option C and it is scored.

### C12. The mobile boundary is `md`, the graph column collapses at `lg`, and every mobile rule is additive

`conventions.md`: the boundary is `md` (768px), the touch target is 44px, and
every mobile rule is additive behind a breakpoint prefix — never an edit to an
unprefixed class, because the app at 1440px must be pixel-identical.

The graph region has a **second** boundary: `lg:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]`
(`KnowledgeGraphView.tsx:252`), so below 1024px the panel goes **underneath** the
canvas, for the reason at `:228-230` — a 19rem column of sliders next to a 12rem
canvas is neither.

So at phone width the order is: whatever is above the graph, then a canvas about
4:3 of ~358px, then 64 controls, then the caption. **Every option is scored at
390px as well as at 1440px**, and the two do not agree: Option C's fold is worth
more on a phone than on a desk, and Option B's legend costs more.

### C13. Nothing that renders is checked by anything

From `proposals/OperatorInterface/01-constraints.md`'s C10, unchanged here:
zero page components are rendered by a test, and the eight component tests all
go through `renderToStaticMarkup` asserting on class strings.

`src/lib/knowledgeGraph.ts` is the exception and it is deliberate — the file's
own header says it lives in `src/lib` because that is what `tsconfig.test.json`
compiles (`:5-10`). `grep -c "^test(" src/lib/knowledgeGraph.test.ts` returns
**30**. So the query parser, the group matcher, the local-graph traversal, the
filters, the settings coercion and the cap are covered, and **nothing that draws
or lays out anything is**.

The consequence for scoring: an option whose work lands in `knowledgeGraph.ts`
arrives in a file with a 30-test suite already around it, and an option whose
work lands in a `.tsx` render arrives somewhere nothing watches. Every option
here is mostly the second kind, which compresses that criterion rather than
removing it — but it is the reason a recommendation should push what it can into
the tested file, and `10-recommendation.md` does.

---

## The criteria

Nine, weighted. Total weight 32, so the ceiling is 160. Scores are 1–5 with **5
always best**, including for the negative criteria — 5 on "contradicts a
documented decision" means it contradicts none.

| # | Criterion | Weight | Why this weight |
|---|---|---|---|
| 1 | **Closes "not visible what I am looking at"** | 5 | The one complaint of the three that has exactly one mechanism. Scored on *marginal* contribution: options are being chosen among, so an option whose content is another's is worth its difference |
| 2 | **Closes "overwhelming"** | 4 | Real, and it has three independent mechanisms (move, fold, split), so no single option owns it. Below 1 because K3 measures it as concentrated in one block — 48 of 64 controls — rather than diffuse |
| 3 | **Closes "difficult to navigate"** | 4 | Half of it is `fitView` being unreachable, which is cheap. The other half is C4, which is closed by decision rather than by code, so the criterion has a ceiling below 5 for every option |
| 4 | **Contradicts a documented decision** | 5 | `CLAUDE.md`: the invariants encode the product's reasoning and nearly every one fails **silently**. Four file headers and two audit sections are live here. Equal to criterion 1 because trading a silent failure for a silent failure is not progress |
| 5 | **Keyboard cost** | 3 | C4 sets the baseline at "the canvas has none and that is on purpose", so this criterion is about the *controls* an option adds or removes: tab stops added, tab stops removed, and whether a fold puts a stop behind a press |
| 6 | **Screen-reader cost** | 3 | The canvas has no accessible name at all (K4) and the app's newer canvas does. Scored on whether an option leaves a listener better, worse or where they were. Weighted equal to keyboard and below the invariants because **nothing here was heard** — this is inference from markup, as `08-option-g` in the neighbouring survey says of itself |
| 7 | **Phone width (390px)** | 3 | C12 gives this route two breakpoints rather than one, and K2 shows the worst artefact of the current order is a phone artefact. Not higher because the operator described a desk |
| 8 | **Risk of silent regression** | 3 | C13: nothing renders in a test, no browser in the container. Below the invariants only because an invariant violation is a *certain* silent failure and this is a risk of one |
| 9 | **Blast radius and reversibility** | 2 | Merged, because on this route they are the same axis: everything is in four files and one `localStorage` key, and the largest option touches a route boundary. Lowest weight for the reason `OperatorInterface/11-comparison.md` gives — it is all in git and the container rebuilds |

Criteria 1, 2 and 3 are the operator's three sentences, weighted 5, 4 and 4. That
is deliberate and it is the survey's thesis: **the complaint is three problems,
and the recommendation has to close three.**

### What is not a criterion, and why

- **Lines of code.** `page.tsx` at 1,017 lines is a symptom in K1 and not a
  target. `proposals/OperatorInterface/11-comparison.md` scores a 3,502-line
  file's restructure at 40 points, and it lost on invariants, not on size.
- **Fidelity to Obsidian.** `knowledgeGraph.ts:12-21` says the controls are
  reimplemented from the outside and names the one place the behaviour cannot
  follow. Matching Obsidian more closely is not a goal anybody stated.
- **Dependency cost.** Nothing in this survey adds a dependency; every option is
  built from `src/components/ui/` and the two canvas libraries already here. The
  criterion would score 5 for all seven options and discriminate nothing.
