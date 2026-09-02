# Option B: an orientation layer on the canvas, and nothing else

Four pieces, all in the graph region, no layout change to the route and no
control moved. A legend, a persistent readout, an honest open-note marker, and a
reachable fit.

This is the only option in the survey that touches criterion 1 at all.

---

## B0. The precondition: two marks currently mean two things at once

A legend states what a mark means. Two marks on this canvas do not have a single
meaning to state, so the legend cannot be written until they do. **These are not
polish; they are what makes B1 possible.**

### B0.1 A note and an attachment are drawn identically

`KnowledgeGraphCanvas.tsx:669-675`:

```ts
function colourFor(node: KnowledgeNodeDTO, palette: Palette): string {
  if (node.kind === "tag") return palette["--accent"];
  if (node.kind === "phantom") return palette["--fg-faint"];
  if (node.kind === "attachment") return palette["--fg-muted"];
  return palette["--fg-muted"];
}
```

The last two branches return the same value. The `attachment` line exists, so
somebody meant to distinguish it and the distinction was lost or never landed.

**The repair, and it reuses a path that is already there.** A phantom is drawn
hollow — filled, then stroked in `--bg-raised` so it reads as a hole
(`:296-302`). Give an attachment the same *shape* treatment with a different
stroke: after the fill, stroke in `--fg` at `1.2 / view.k`. An attachment is
then a muted disc with a thin dark outline, a phantom is a muted disc with a
hole in it, and a note is a plain disc. Three shapes, two tokens, both already
probed (`TOKENS`, `:103-111`), no new palette entry, and the code is four lines
beside the four that already exist.

**Rejected alternative: give attachments their own colour.** The probed palette
has seven entries and the four that are colours are spoken for — `--accent` is
tags and the hover fill, `--tint` is the open note, `--fg-muted` is notes,
`--fg-faint` is phantoms. `--border` is the only one left and it is
`light-dark(#e3e3e6, #3a3a3d)`, which against `--bg-raised` is very nearly
invisible; that is what a border colour is for. Adding an eighth token to
`globals.css` for one node kind on one surface is a change to a file
`conventions.md` calls load-bearing, to solve a problem a stroke solves.
**Shape, not colour.**

**Not verified:** that a 1.2px stroke is distinguishable at the smallest radius
on screen. `radiusOf` is `(2.5 + sqrt(degree) * 1.7) * nodeSize` (`:128-130`), so
a degree-0 attachment at the default `nodeSize` of 1 is a **2.5px radius disc**,
and a 1.2px stroke on a 5px disc is most of the disc. `docs/verification.md:2117-2123`
records exactly this doubt about the neighbouring canvas's half-radius core and
says "nobody has seen it below about 5px". Same doubt, same size, and it goes on
the click-list rather than being asserted here.

### B0.2 The open-note ring and the hover fill are the same colour in light mode

`--tint` is `light-dark(#0069d9, #0a6cd8)` (`globals.css:89`); `--accent` is
`light-dark(#0069d9, #4a9bff)` (`:70`). Identical in light mode. The ring is
`--tint` (`KnowledgeGraphCanvas.tsx:306`); the hover fill is `--accent`
(`:292-294`).

**This repository has already had this exact thought, one function away, and got
it right there.** `GROUP_PALETTE`'s docblock (`knowledgeGraph.ts:663-669`):

> Chosen to stay apart from each other and from the graph's own palette on both
> themes, and **deliberately not the app's `--accent`: a group that happened to
> match the accent would be indistinguishable from the node under the pointer.**

Seven group colours were picked to avoid colliding with the hover fill. The
open-note ring collides with it, in light mode, exactly. That is not a
disagreement with a decision — it is the same decision, unapplied at one call
site, and it is the strongest evidence in this survey that B0.2 is a defect
rather than a preference.

**The repair: draw the ring in `--fg`.** `--fg` is the strongest foreground
token, already probed, and on this canvas it is used for one other thing —
label text (`:320`), which is small, positioned below a node, and not a fill. A
2px `--fg` ring around a disc shares a meaning with nothing else drawn.

**Rejected alternative: keep `--tint` and make the ring thicker or doubled.**
Thickness is a weak signal at the zoom range this canvas spans — `2 / view.k`
means the ring is drawn in world units and the reader's sense of "thick" changes
with the wheel — and a doubled ring on a 5px disc is a blob.

**Rejected alternative: change the hover fill instead.** The hover fill is the
*transient* mark and the ring is the *persistent* one; changing the transient
one moves the problem to whatever it becomes. And the hover fill is already
tangled with the neighbourhood dimming at `:284-285`, which is the more delicate
half.

---

## B1. The legend

**Where.** In the panel `Card`, as the **first** thing in it, above the view
scope strip — so that on a desk it is the top of the right-hand column beside
the canvas, and below `lg`, where the panel goes underneath (C12), it is the
first thing under the canvas. Both are correct: the legend is read once per
visit and read *before* the controls.

**Not on the canvas.** C11: a 2D context takes a resolved string, so a legend
drawn on the canvas needs every swatch probed through `probeTokens` and redrawn
on both theme events, and it would have to be culled, transformed and
positioned. In DOM it takes `bg-accent` like any other box. The two existing
legends in this app are both markup for the same reason
(`runs/[id]/conflicts/page.tsx:354-403`, `runs/[id]/touched/page.tsx:326-410`),
and `LegendRow` at `touched/page.tsx:412-419` is the shape to copy — a `<ul>` of
`<li>`s, each a swatch and a sentence.

**What it says, word for word.** Six fixed rows, one row per colour group, and
two sentences. Every row was checked against the drawing code; nothing here is
aspirational.

> **What the marks mean**
>
> - ⬤ *(a swatch in the group's own colour)* — **Group 1 `tag:llm`** *(one row per colour group, in the group's order, showing its query)*
> - ⬤ `--fg-muted` — **A note no group claims**
> - ⬤ `--accent` — **A tag**  *(only when `Tags` is on)*
> - ◯ `--fg-faint` *hollow* — **A link nobody has written the note for yet**
> - ⬤ `--fg-muted` *outlined* — **An attachment** *(only when `Attachments` is on)*
> - ◯ *a ring in* `--fg` — **The note open above**
> - ⬤ `--accent` — **The node under the pointer**, with its links and neighbours lit and everything else dimmed
>
> A node's size is how many of its links are **drawn**. Turning a filter on
> makes a node smaller without the vault having changed.
>
> Colour groups are tried in order and the first match wins, so a note two
> groups match takes the higher one's colour.

The colour-group rows are generated from `settings.groups`, so a vault with no
groups shows none and today's seeded default shows seven — which is the honest
reading, since with seven groups seeded "a note no group claims" is a minority
of the graph. **Six fixed rows plus seven group rows is thirteen**, which is why
`07-option-f`'s F2 (seed three, not seven) is in the recommended combination and
not filed as a nicety: it takes the legend from thirteen rows to nine.

Two of the six fixed rows are conditional on a filter that is off by default
(`GRAPH_DEFAULTS.filters.showTags` and `.showAttachments` are both `false`,
`knowledgeGraph.ts:536-537`), so the legend an operator opens on today is four
fixed rows plus their groups.

**Why the last two lines are sentences and not rows.** Both are facts about the
*system* rather than about a mark. The size sentence exists because K4 measured
the size as degree-in-the-drawn-slice (`countDegrees(sim.nodes, sim.edges)`,
`:434`) while the number an operator would guess is the vault's, and
`RunConflictMap.tsx:31` already sets the precedent of answering exactly this
with a legend line: "the legend beside it says the size is not a count". The
precedence sentence exists because `groupIndexFor`'s docblock
(`knowledgeGraph.ts:197-204`) says a list that did not show its order "would
make that look like a bug in the colouring" — the panel shows the order as a
number, and the legend is where the *rule* goes.

**Cap check (C10).** Thirteen rows with seven groups seeded is past
`ListGroup`'s 3–9 range, and nine with three seeded is at its ceiling. Neither is
a violation, because **this is not a `ListGroup`**: it is a `<ul>` of swatch
rows, the same non-`ListGroup` construct both existing legends use
(`touched/page.tsx:334-403` is a `<ul>` of `LegendRow`s, several of them
conditional, and it carries more rows than this one would). Stated so the next
reader does not have to work it out — and it is still the reason to prefer nine
to thirteen.

**Copy check.** Every row is a noun phrase, no articles beyond the ones that
carry meaning, no row explains the interface, no full stops on the rows and full
stops on the two sentences — the house rule for a `ListGroup` `footnote` versus a
row label. "Work cycle" does not appear because nothing here is about a run.

## B2. The readout

**Where.** Directly under the legend, in the panel, as a fixed-height box that
is present whether or not anything is selected. The precedent is
`runs/[id]/touched/page.tsx:428-456`'s `Inspector`, which is the same idea on
the app's other canvas: a `GroupLabel` reading **Selected**, then either an
`Empty` saying what to do or a bordered `bg-inset` box of `<dl>` facts.

**What triggers it.** The node under the pointer, and it **persists after the
pointer leaves**. `onPointerLeave` currently clears `hoverRef` and redraws
(`KnowledgeGraphCanvas.tsx:600-605`); the readout does not follow it back to
null. That is the whole of C8's item 7 — a hover-reveal is one that stops
existing when the pointer moves, and the last-seen readout is the fix rather
than the violation. A click still opens the note, unchanged.

**What it shows**, all of it already on the `KnowledgeNodeDTO` in memory (C2 —
`apiTypes.ts:2752-2763`):

| Row | Value | Source |
|---|---|---|
| *(headline)* | The title | `node.title` |
| Path | The vault-relative path, or **"No file — a link nobody has written yet"** for a phantom, or **"A tag"** for a tag | `node.path` is `null` on both (`apiTypes.ts:2757-2758`) |
| Links | `N in, M out — in the whole vault` | `node.inDegree`, `node.outDegree` |
| Drawn | `K of those are on screen` | `sim.nodes[i].degree` |
| Colour | `Group 3 — tag:llm`, or `Its kind` | `groupOfRef.current[i]` |
| Tags | Comma-joined, or the row is absent | `node.tags` |

The **Links** and **Drawn** pair is the point. It is the one place an operator
can see the two numbers that disagree, side by side, with the legend's sentence
above saying why — which is a stronger repair than either alone, and it costs
nothing because both numbers are already in the two arrays the canvas holds
(`metaRef`, `simRef`).

**Rejected: showing it on the canvas beside the node.** That is a tooltip. C8
item 6, and `ui-density-audit.md:184-187` names it: no touch equivalent, and
WCAG 1.4.13 wants dismissable, hoverable and persistent, which a canvas-drawn
label next to a cursor is none of.

**Rejected: `aria-live` on the readout.** A polite live region that fires on
every pointer move over a 893-node graph is a screen reader reading a hundred
titles a second. The readout is a plain region a listener can navigate to. If
one thing here should be tested with a real screen reader it is this decision,
and `11-validation.md` lists it.

## B3. Fit to view

**The control.** One `Button variant="secondary" size="compact"` labelled
**Fit**, in a `ButtonRow` beside `Reset to defaults` at the foot of the panel —
which is where the panel's other view-level action already is, and
`KnowledgeGraphView.tsx:563-564` explains why that row sits at the panel's level
rather than inside a group.

**The wiring, and why it is a prop rather than a ref.** `fitView` is already
written (`KnowledgeGraphCanvas.tsx:336-344`) and is called once (`:356-359`).
Exposing it needs a route from the panel into the canvas. `grep -rn "useImperativeHandle\|forwardRef" src/`
returns **zero hits** — this codebase has never used an imperative handle, and
adding the first one for one button is a pattern the next canvas would copy.

So: `KnowledgeGraphCanvas` takes a `fitNonce: number` prop, and an effect
`useEffect(() => { if (fitNonce > 0) { fitView(); schedule(); } }, [fitNonce, fitView, schedule])`.
`KnowledgeGraphView` holds `const [fitNonce, setFitNonce] = useState(0)` and the
button is `onClick={() => setFitNonce((n) => n + 1)}`.

Three things this has to get right, each of which is a rule from C11:

- **It must not reheat.** `schedule()` asks for exactly one more frame
  (`:366-368`); `reheat()` restarts the simulation. A Fit that reheated would
  scatter the layout the operator was trying to find again.
- **It must not clear `touchedRef`.** That flag is what stops the automatic
  first fit from firing later over a deliberate pan (`:352-355`). Fit is the
  operator asking; the automatic one is the app guessing, and they stay separate.
- **`fitNonce` is not persisted.** It is not a setting; it is an event. It never
  reaches the `localStorage` key (C3).

**Not `Reset view`.** The label is one word and says what happens: the whole
graph is framed. "Reset" is already the panel's other word and means the
settings.

## B4. An accessible name for the canvas

`KnowledgeGraphCanvas.tsx:645-664` is a bare `<canvas>`. `PathMapCanvas.tsx:800-801`
carries `role="img"` and an `aria-label`, and `RunTouchedMap.tsx:156` writes that
label to name the *table* holding the same content:

> "The files this run touched, positioned by directory. The same files are
> listed, ordered and searchable, in the table on the run's Files tab."

That is the exact sentence pattern C4 needs, because C4's whole justification is
that the list is the reachable route. So:

```
role="img"
aria-label="The vault's link graph, {N} of {M} notes drawn. The same notes are
listed, ordered and searchable, in the Notes table on this page."
```

with `N` and `M` the two figures the caption already computes
(`KnowledgeGraphView.tsx:298-301`). A listener gets what the picture is, how
much of the vault is in it, and where the operable route is — which is the
honest description of a surface C4 has decided is pointer-only.

**Not `role="application"`, not `tabIndex`.** Both would advertise a keyboard
model that does not exist and that C4 says will not be built.

---

## What Option B costs

**Files.** `KnowledgeGraphCanvas.tsx` (B0.1, B0.2, B3's prop and effect, B4's
two attributes — perhaps 25 lines), `KnowledgeGraphView.tsx` (the legend, the
readout, the Fit button, the nonce state, plus lifting the hovered/last-seen
node up — perhaps 120 lines). `src/lib/` is untouched, which by C13 means **none
of this lands anywhere a test watches**.

**The panel gets taller, and by C11 that makes the graph taller too.** The
legend is 7–9 rows and the readout is a fixed box; call it 260px added to a
column that is already the taller of the two, and the row's height is the taller
column's (`KnowledgeGraphView.tsx:232-251`). So the canvas grows by the same
amount. On a desk that is a bigger graph, which is a gift. **Below `lg` it is
260px of scroll between the canvas and the controls**, which is not.

**A per-frame cost that has to be bounded.** The readout needs the hovered index
in React state, and hover changes on every `pointermove` over a node. Today
hover lives in a ref and drives a canvas redraw and nothing else
(`:164`, `:543-552`). Naively setting React state there is a re-render per
pointer move across a 893-node graph. **The readout must update only when the
hovered *node* changes, not on every move** — the handler already computes
`nearestWithin` and already compares against `hoverRef.current` before
scheduling (`:600-604` does exactly this for the leave case), so the guard is
one `if` and it must be written deliberately rather than discovered.

## What Option B does not fix

- **Nothing about the route.** The graph is still the third of four blocks and
  still under 50 rows of table on a phone (K1, K2). An operator still scrolls
  past everything to reach the thing this option improves — which is a real
  argument that B alone is the wrong shape.
- **Nothing about the 64 controls.** It **adds** to the panel: a legend, a
  readout and a button. On the count that matters for criterion 2 it is one more
  tab stop (`Fit`), but on the count that matters for the word "overwhelming" —
  how much is in that column — it is worse.
- **Nothing about the keyboard.** C4 stands. `Fit` is one new keyboard-operable
  control, which is a real gain for a keyboard user and not a route into the
  graph.

That first and second bullet together are why this file does not end in a
recommendation. Option B is necessary and it is not sufficient, and an option
that makes the crowded column more crowded needs a partner.

## Score

| Criterion | Score | Note |
|---|---|---|
| 1 Not-visible | **5** | The only option that touches it, and it closes it |
| 2 Overwhelming | **1** | Adds to the panel. Scored honestly rather than neutrally |
| 3 Navigate | 4 | Fit is most of it; C4 caps it below 5 |
| 4 Contradicts | 5 | B0's two repairs correct code against its own stated intent, not against a decision. Nothing here argues with a header |
| 5 Keyboard | 4 | One control added, none removed, none folded |
| 6 Screen reader | **5** | B4 closes a live gap with the app's own precedent |
| 7 Phone | 2 | 260px of new column between the canvas and its controls below `lg` |
| 8 Regression | 2 | Two changes to drawing code and a hover path with a per-frame trap in it, in a file nothing renders in a test |
| 9 Radius | 4 | Two files, no shared component, no token |

**Total 117 of 160.** Recomputable with `node proposals/KnowledgeSection/score.mjs`.
