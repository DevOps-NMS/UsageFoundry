# Recommendation

**Build Option G — E1, then B, then C, with F2 and F3 — as one piece of work in
three commits.** [08-option-g-the-combination.md](08-option-g-the-combination.md)
is the argument; this file is the specification, and it is meant to be built from
without a second design decision.

Nothing in this proposal is a decision yet and no product code has changed.

---

## The order, and why it is an order

| | What | Why it goes here |
|---|---|---|
| **1** | **E1** — move the graph above the Notes table | `ui-density-audit.md:92-107`: hiding is the fourth move and this route has never had the first three. Two lines. Land it, look at it, and if the section stops feeling overwhelming, step 3 is unnecessary |
| **2** | **B + F3** — the orientation layer, and `textFade` set from a measurement | The only work that touches "not visible at first look". F3's number can only be read once B's `Fit` exists to produce it reliably |
| **3** | **C + F2** — the three folds, and seed three colour groups | Last, because B makes the panel taller and C is what pays for it, and because after step 1 somebody can say whether it is still needed |

Each step is independently revertible. Step 3 is the only one with an argument
against a documented rule in it, and it is the one to drop if the budget runs out.

---

## Step 1 — E1

**Move**, in `src/app/knowledge/page.tsx`: the block at `:696-709` — the comment
and the `<KnowledgeGraphView notePath={selected} onOpenNote={openNote} />` line —
goes **above** the browse block that starts at `:510`. The note block at
`:405-508` stays first (C6). Health stays last.

Final order: note (when open) → graph → Notes → Health.

**Two edits ride with it and are not optional.**

1. `src/components/KnowledgeGraphCanvas.tsx:72-73` currently reads "every note
   this can open is also a row in the list **above** it". Replace `the list above
   it` with `the Notes list on this page`. The claim C4 rests on is that the list
   is reachable, ordered and searchable — not where it sits — and leaving the
   word would falsify a header comment silently, which is the failure mode
   `CLAUDE.md` names.
2. `src/components/KnowledgeGraphView.tsx:401-410`, the `Filters` footnote, ends
   "…not its body, which is not part of the graph." Append: **"The Notes list
   below has its own filters and this search does not read them."** The two
   filter sets are deliberately independent (C5, and `page.tsx:702-708` records
   that this was got wrong once); adjacency makes the question likely enough to
   be worth one clause.

## Step 2 — B, and F3

### 2a. Two colour repairs, in `KnowledgeGraphCanvas.tsx`

Both are preconditions of the legend: a legend cannot say what a colour means
while two things share one.

**The open note's ring changes from `--tint` to `--fg`.** `:306`,
`ctx.strokeStyle = palette["--tint"]` becomes `palette["--fg"]`. `--tint` and
`--accent` are the same hex in light mode (`globals.css:89`, `:70`) and
`--accent` is the hover fill (`:292-294`), so today the open note and the node
under the pointer are the same colour. `GROUP_PALETTE`'s own docblock
(`knowledgeGraph.ts:663-669`) shows this exact reasoning already applied to the
seven group colours; this is the one call site it was not applied to.

**An attachment gets a stroke.** After the fill at `:295` and beside the phantom
branch at `:296-302`:

```ts
// A phantom is hollow because there is no file; an attachment is a file that
// is not a note, so it takes an outline rather than a hole. Without one it is
// `--fg-muted`, which is also what a note with no colour group is.
if (meta[i].kind === "attachment") {
  ctx.lineWidth = 1.2 / view.k;
  ctx.strokeStyle = palette["--fg"];
  ctx.stroke();
}
```

Both tokens are already in `TOKENS` (`:103-111`). No new token, no change to
`globals.css`.

### 2b. `fitNonce`, in both files

`KnowledgeGraphCanvas` takes one new prop, `fitNonce: number`, and one effect:

```ts
useEffect(() => {
  // The operator asking, which is a different event from the automatic first
  // fit at `tick`: that one is suppressed once the view has been touched, and
  // this one must not clear `touchedRef` or the automatic fit would come back
  // and move a graph somebody had panned on purpose. One frame, no reheat —
  // framing a settled layout must not disturb it.
  if (fitNonce === 0) return;
  fitView();
  schedule();
}, [fitNonce, fitView, schedule]);
```

`KnowledgeGraphView` holds `const [fitNonce, setFitNonce] = useState(0)` and
passes it. **Not `useImperativeHandle`**: `grep -rn "useImperativeHandle\|forwardRef" src/`
returns zero hits and this is not the place to introduce the first one.
`fitNonce` is an event, not a setting, and never reaches the `localStorage` key.

### 2c. An accessible name for the canvas, in `KnowledgeGraphCanvas.tsx`

The `<canvas>` at `:645-664` takes two attributes, matching the shape
`PathMapCanvas.tsx:800-801` already uses:

```tsx
role="img"
aria-label={ariaLabel}
```

and a new `ariaLabel: string` prop, written by the view as:

> The vault's link graph, **{shown}** of **{total}** notes drawn. The same notes
> are listed, ordered and searchable, in the Notes list on this page.

`shown` and `total` are the two figures the caption already computes
(`KnowledgeGraphView.tsx:298-301`). **Not `role="application"` and not
`tabIndex`**: either would advertise a keyboard model C4 says will not be built.

### 2d. The panel's new head: legend, readout, Fit

Three things at the **top** of the panel `Card`, above the view-scope strip.

**Why the top rather than in the panel's rare-at-the-bottom order.** They are
about the *canvas*, not about the panel. Below `lg` the panel sits directly
under the canvas (`:252`), so the top of the panel is the row of pixels nearest
the picture; above `lg` it is the top of the column beside it. Both are where a
reader looks when they look up from the graph.

#### The legend, word for word

Rendered as a `<ul>` of swatch rows — the construct at
`runs/[id]/touched/page.tsx:412-419`, copied, not imported (it is a local
function on that page). Under a `GroupLabel`. **Not a `ListGroup`**, which is
for rows carrying controls.

> ### What the marks mean
>
> | swatch | text |
> |---|---|
> | a disc in the group's own colour | **1 · `tag:llm`** |
> | a disc in the group's own colour | **2 · `path:Areas`** |
> | *…one row per colour group, in the panel's order, numbered as the editor numbers them* | |
> | a disc, `bg-ink-muted` | **A note no group claims** |
> | a disc, `bg-accent` | **A tag** |
> | a hollow disc, `bg-ink-faint` with a `bg-raised` centre | **A link nobody has written the note for yet** |
> | a disc, `bg-ink-muted`, outlined `border-ink` | **An attachment** |
> | a ring, `ring-ink`, nothing inside | **The note open above** |
> | a disc, `bg-accent` | **The node under the pointer.** Its links and neighbours stay lit; everything else dims |
>
> A node's size is how many of its links are **drawn**. Turning a filter on makes
> a node smaller without the vault having changed.
>
> Colour groups are tried in order and the first match wins, so a note two groups
> match takes the higher one's colour.

**Which rows render when.**

| Row | Rendered |
|---|---|
| Colour-group rows | One per entry in `settings.groups`, always |
| A note no group claims | Always. **When `settings.groups` is empty the text is `A note`** — "no group claims" names a distinction that does not exist |
| A tag | Only when `filters.showTags` (default `false`, `knowledgeGraph.ts:536`) |
| A link nobody has written the note for yet | Only when `!filters.existingOnly` (default `false`, `:538`) — with it on, no phantom is drawn |
| An attachment | Only when `filters.showAttachments` (default `false`, `:537`) |
| The note open above | Only when `focusId !== null` |
| The node under the pointer | Always |
| Both sentences | Always. The precedence sentence only when `settings.groups.length > 1` |

So the legend an operator opens on today — no note, default filters, three
seeded groups after F2 — is **three group rows, "A note no group claims", "The
node under the pointer", and two sentences**: six rows of content, which is what
a legend should be. It grows to nine when everything is on.

**Copy rules honoured.** No row explains the interface. No row has a full stop;
both sentences do. No article that carries nothing. "Work cycle" does not appear
because nothing here is about a run. The last row is two clauses because the
dimming is a second visible effect of one cause and splitting it would make two
marks out of one.

#### The readout, word for word

Under a `GroupLabel` reading **Under the pointer**. Modelled on
`runs/[id]/touched/page.tsx:428-456` — a bordered `bg-inset` box, a mono
headline, then a `<dl>` of `Fact` rows.

With nothing hovered yet:

> **Under the pointer**
>
> *(an `Empty`)* Point at a node to read it.

With a node hovered or last hovered — **it persists after the pointer leaves the
canvas**, which is what makes it not a hover-reveal (C8 items 6 and 7):

| Row | Value | Rendered |
|---|---|---|
| *(headline, mono)* | `node.title` | Always |
| **Path** | `node.path`; or **No file — a link nobody has written yet** for a phantom; or **A tag** for a tag | Always |
| **Links** | `{inDegree} in, {outDegree} out — in the whole vault` | When the node is a note or attachment |
| **Drawn** | `{degree} of those are on screen` | Always |
| **Colour** | `Group {n} — {query}`, or **Its kind** | Always |
| **Tags** | `node.tags.join(", ")` | When `node.tags.length > 0` |

Every value is already in memory (C2): the DTO fields come from `metaRef.current[i]`
(`apiTypes.ts:2752-2763`) and `degree` from `simRef.current.nodes[i].degree`.
**No fetch.**

**Links against Drawn is the point of the box.** They disagree whenever a filter
or the cap is on, because the drawn radius is degree over the filtered slice
(`countDegrees(sim.nodes, sim.edges)`, `:434`) and the wire's degrees are the
vault's. The legend's first sentence says why; the readout is where a reader
sees it happen.

**Wiring, and the one trap.** `KnowledgeGraphCanvas` takes an
`onHover: (node: KnowledgeNodeDTO | null, degree: number) => void` prop and
calls it **only when the hovered index changes**, not on every `pointermove`.
`onPointerMove` already compares against `hoverRef.current` before scheduling a
frame; the callback goes inside that same guard. Called with `null` **never** —
`onPointerLeave` (`:600-605`) clears the ref and redraws but must not clear the
readout. A readout that emptied when the pointer left the canvas would be the
hover-reveal this box exists instead of.

**No `aria-live`.** A polite region firing on every node change across an
893-node graph is a screen reader reading a hundred titles. The box is ordinary
content in a labelled region. This is the decision in the whole proposal least
supported by evidence and it is on the validation list.

#### Fit

One `ButtonRow` under the readout:

```tsx
<Button variant="secondary" size="compact" onClick={() => setFitNonce((n) => n + 1)}>
  Fit
</Button>
```

**Here rather than beside `Reset to defaults`**, which is the panel's other
level-of-the-whole action. `KnowledgeGraphView.tsx:563-564` states the rule that
decides it — a reset sits at the level of what it resets. `Fit` resets the
*view*; `Reset to defaults` resets the *settings*. Two different objects, two
places, and `Fit` belongs with the other canvas-facing things at the top.

### 2e. F3 — `textFade`

`GRAPH_DEFAULTS.display.textFade` is `1.1` (`knowledgeGraph.ts:542`) and the
label fade is `view.k <= textFade ? 0 : …` (`KnowledgeGraphCanvas.tsx:315`), so
nothing is labelled below zoom 1.1 — above the canvas's opening `k` of 1 and
above any fit of a graph wider than its viewport.

**This proposal does not name the replacement number**, because the right value
is just below the `k` that `fitView` produces on the real vault at a real width,
and that has not been measured. `11-validation.md` check 2 is the measurement.
It is five minutes with the app open and it may be the single highest-value
change in the proposal.

## Step 3 — C, and F2

### 3a. F2 — seed three colour groups

In `src/lib/knowledgeGraph.ts`, beside `MAX_GROUPS`:

```ts
/**
 * Colour groups a first visit is given.
 *
 * Below `MAX_GROUPS` deliberately: that constant is the ceiling on how many an
 * operator may *have*, argued from legibility — seeding straight to a ceiling
 * argued from legibility is the thing that argument is against. Three names the
 * vault's three biggest tags, which is where the signal is, and a fourth is one
 * chip away.
 */
export const SEED_GROUPS = 3;
```

and `tagGroups(tags, limit = SEED_GROUPS)` slicing to `limit` rather than to
`MAX_GROUPS` (`:283`). The call site (`KnowledgeGraphView.tsx:163`) is unchanged.

This is the only change in the proposal that lands in the file with a test suite
around it (30 tests). **Write the assertion first**: `tagGroups` over a
12-tag fixture returns 3, and `tagGroups(tags, 7)` still returns 7.

### 3b. Three folds, in `KnowledgeGraphView.tsx`

All `ui/Disclosure`, all siblings, none nested (C8 item 3). Each replaces the
`ListGroup` at the named lines, with the group's contents moved inside
unchanged.

| Fold | Replaces | `summary` | `count` | Open by default |
|---|---|---|---|---|
| Colour groups | the editor half of `GroupList`, `:651-771` | `Edit colour groups` | `groups.length` | **Never** |
| Display | `:466-519` | `Display` | how many of the 5 differ from `GRAPH_DEFAULTS.display` | `count > 0` |
| Forces | `:521-561` | `Forces` | how many of the 4 differ from `GRAPH_DEFAULTS.forces` | `count > 0` |

**Display and Forces implement C9's rule literally** — a fold whose contents
differ from their defaults opens by default and its summary says how many differ
(`ui-density-audit.md:365-366`). Every default is a literal in one frozen object,
so the comparison is a loop over five and four keys.

**The colour-group fold deliberately does not.** `GRAPH_DEFAULTS.groups` is `[]`
(`:541`) and the seed writes three, so a literal reading opens it for every
operator forever — which is today's state with a triangle added. The rule exists
so that a reader is never surprised by a hidden value; **the legend shows the
values, above, permanently**, which serves that purpose directly and better than
a count does. That is a departure from a documented rule and this paragraph is
the argument for it. If a reader rejects it, the fold opens by default and step 3
loses most of its value — see `09-comparison.md`.

**`Edit colour groups` contains**, moved unchanged: the `ColorSwatch`, query
`Input`, Up, Down and Remove per row (`:659-713`), the most-used-tags chip row
(`:723-761`) and `Add group` (`:764-769`). The read-only list that used to be its
first half **does not move here and is not duplicated** — it is the legend's
group rows at the top of the panel, which is the same seven values in the same
order with the same numbers.

### 3c. What is not folded, and why each

- **View scope** (`:348-353`) — changed on most visits. C9 Tier 1(a).
- **The four `Around this note` controls** (`:358-399`) — Tier 1 in local view,
  and already conditional on the scope.
- **All five filters** (`:401-462`) — changed constantly, and
  `KnowledgeGraphView.tsx:48-50` says the panel exists to be *swept*.
- **The legend, the readout and `Fit`** — the explanation stays visible, which
  is the finding both `04-option-c` and `08-option-g` lean on.
- **`Reset to defaults`** (`:565-569`) — `ui-density-audit.md:383-385`: rarity
  never demotes a control below the thing it modifies, and this is the only undo
  for everything above it.

---

## The panel, before and after

| | Today | After |
|---|---|---|
| | | 1 `What the marks mean` — 6 rows, 2 sentences |
| | | 2 `Under the pointer` — a readout |
| | | 3 `Fit` |
| 1 View scope | ✓ | 4 unchanged |
| 2 `Around this note` (local only) | ✓ | 5 unchanged |
| 3 `Filters` | ✓ | 6 unchanged |
| 4 `Colour groups` — 7 rows × 5 controls, 12 chips, Add | ✓ | 7 `▸ Edit colour groups (3)` |
| 5 `Display` — 5 controls | ✓ | 8 `▸ Display` |
| 6 `Forces` — 4 controls | ✓ | 9 `▸ Forces` |
| 7 `Reset to defaults` | ✓ | 10 unchanged |
| **Focusable controls, `Whole vault`, first visit** | **64** | **11** |
| **Focusable controls, `This note`** | **68** | **15** |

Eleven is 1 `Fit` + 1 scope + 5 filters + 3 fold summaries + 1 reset. Display and
Forces add their contents back whenever they differ from default, which is the
point of C9's rule.

## Files that change

| File | What | Rough size |
|---|---|---|
| `src/app/knowledge/page.tsx` | E1's move of `:696-709` above `:510` | 14 lines relocated |
| `src/components/KnowledgeGraphView.tsx` | The legend, the readout, `Fit`, `fitNonce`, `ariaLabel`, the three folds, the footnote clause | ~160 added, ~40 restructured |
| `src/components/KnowledgeGraphCanvas.tsx` | Ring colour, attachment stroke, `fitNonce` prop and effect, `onHover` prop and its guard, `ariaLabel` prop, `role`/`aria-label`, one comment | ~35 |
| `src/lib/knowledgeGraph.ts` | `SEED_GROUPS`, `tagGroups`'s `limit` parameter, `textFade`'s literal | ~10 |
| `src/lib/knowledgeGraph.test.ts` | Two assertions on `tagGroups`' seed limit | ~15 |

Four source files and one test file. **No new component in `src/components/ui/`**,
no new token, no change to `globals.css`, no new dependency, no route added or
moved, no API change, and nothing written to the vault.

## Refused by name

- **Splitting the route into tabs or sub-routes (Option D).** E1 gets most of its
  benefit for two lines; its own cost is a 7.3 MB fetch per tab visit
  (`docs/verification.md:775-777`) with no free answer; and
  `docs/verification.md:1996-2044` is an unrun ten-step click-list for this
  canvas, which must not be moved to a new URL before somebody runs it. **What
  reverses this: the operator saying they want the graph as a destination.**
- **Four tabs specifically.** A note tab and a Notes tab break C6 — a click on a
  row would either switch tabs under the reader, which `/runs/[id]` forbids for
  itself, or produce no visible change, which is the failure C6 was written to
  prevent.
- **A keyboard route into the graph** — arrow traversal, a roving tabindex over
  nodes, a hidden focusable node list. `KnowledgeGraphCanvas.tsx:70-75` decides
  against it with a named alternative that is genuinely reachable, and nothing
  found in this survey overturns that. `Fit` is a button, not a route in.
- **A tooltip or a hover-only readout.** `ui-density-audit.md:184-190` forbids
  both, and a readout that emptied when the pointer left the canvas is the
  second one wearing different clothes.
- **`aria-live` on the readout.** Reasoned above; filed as a question rather than
  refused for good.
- **A `Sheet` for the colour editor.** C9's Tier 3 is "large enough to be its own
  screen", and 15 controls is not; and a `Sheet` is a focus trap over the canvas,
  so an operator could not watch the colours change while changing them.
- **Joining the graph's search to the Notes list's filters.**
  `KnowledgeGraphView.tsx:52-57` and `page.tsx:702-708` refuse it twice, the
  second time noting it was got wrong once. E1 makes the independence more
  visible and adds a clause saying so; it does not reopen it.
- **An eighth `globals.css` token for attachments.** A stroke solves it with two
  already-probed values.
- **`useImperativeHandle` for `Fit`.** Zero hits in the repository today.
- **Making `textFade` relative to the fitted zoom.** It changes what a stored
  value means, silently, on a slider an operator may already have set, and
  `coerceGraphSettings` cannot detect it.
- **Deleting three of the four gestures from the caption at
  `KnowledgeGraphView.tsx:310`.** Two thirds of it carries no information and
  the same three gestures are stated on the other canvas
  (`runs/[id]/touched/page.tsx:404-407`). Deleting one and not the other makes
  two canvases disagree about how much they explain themselves. **Filed**, in
  `06-option-e`'s E3, as a question for whoever owns the pair.

## What could not be settled

Seven things, each of which is somebody's five minutes at a desk and none of
which this container could do.

1. **The number `textFade` should be.** Step 2e. Needs the `k` that `fitView`
   produces on the real vault at 1440px. **If the graph fits at `k > 1.1`, F3 is
   wrong entirely and the first paint is already labelled.**
2. **Whether a 1.2px stroke is visible on a 2.5px-radius disc.** B0.1's
   attachment mark, at the smallest node the default `nodeSize` draws.
   `docs/verification.md:2117-2123` records the same doubt about the other
   canvas's half-radius core and says nobody has seen it below about 5px.
3. **Whether `aria-live` on the readout helps or floods.** Needs a screen reader.
4. **Whether the operator wants the graph to be a destination.** One answer moves
   Option D from sixth to first.
5. **Whether the display and force sliders are part of the "sweep".**
   `KnowledgeGraphView.tsx:48-50` says the panel is built to be swept and does
   not say which controls it means. If it means the sliders, C1 and C2 are wrong
   and only the colour-group fold survives.
6. **Whether the panel getting shorter makes the graph shorter.** C11: the row's
   height is the taller column's, and the arithmetic in `04-option-c` says the
   4:3 floor already wins above about 1200px and does not below it. That is
   arithmetic on a window nobody has opened.
7. **Whether E1 alone is enough.** If the section stops feeling overwhelming
   after two lines, step 3 should not be built. The sequence exists to make that
   answerable.

## What would overturn the whole recommendation

**The operator saying the panel is fine and the picture is the only problem.**
Then B and F3 are the work, C and F2 are dropped, E1 is kept because it is free,
and the proposal is a third of its size. B alone scores 117 against G's 132 and
loses only on criterion 2 — the sentence that would have been withdrawn.

That is a single question and it is the first one in
[11-validation.md](11-validation.md).
