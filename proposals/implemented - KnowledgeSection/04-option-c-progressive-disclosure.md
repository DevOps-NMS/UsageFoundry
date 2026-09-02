# Option C: progressive disclosure in the graph panel

Scope and filters stay visible. Display, Forces and the colour-group *editor*
move behind independent `Disclosure`s, with defaults chosen so that the closed
state is the common case.

The neighbouring survey refused this pattern on `/settings`
(`proposals/OperatorInterface/09-option-h-progressive-disclosure.md`) on four
grounds. **Three of the four do not transfer, and this file says exactly why for
each rather than hoping nobody checks.**

---

## Why the refusal next door does not carry

| Its ground | Here |
|---|---|
| **1. §1.2 forbids it by name** — an accordion and nested disclosure | §1.2 forbids a *coordinated* set and a *nested* one, and is explicit that "**Independent sibling `Disclosure`s are not an accordion**: four folds in one section, each opening and closing on its own, are four folds" (`ui-density-audit.md:173-176`). It then **requires** exactly that shape in §3.B. Three independent siblings, none nested, is the sanctioned pattern rather than the banned one |
| **2. §1.0 orders the moves and the first three were made on `/settings`** | **They were never made here.** K5: the audit landed 2026-08-19 and this route on 2026-08-21. §3's eleven surfaces do not include it; across 2,774 lines `/knowledge` appears twice, both about the pane ban. This is the ground that genuinely differs, and it is the reason this option cannot simply be adopted either — see "What C owes §1.0" below |
| **3. The peer-reviewed evidence points the other way** | It still does, and this file does not argue with it. Carroll's population is novices in a two-hour session; the population here is one returning expert. But the evidence next door was cited against hiding *settings a reader needs to find*, and the strongest of it — that always-visible explanation is consulted roughly twice as often as hidden explanation — is about **explanation**. C hides four sliders and a colour editor; **Option B's legend, which is the explanation, is put on the page permanently.** The two options point the same way that finding does |
| **4. The diagnosis was wrong — it was reachability, not density** | Partly transfers, and it is C's real weakness. See "The diagnosis check" below |

## What C owes §1.0

§1.0 orders Delete, Group, **Reorder**, Hide, and says hiding is not the default
fix. Since nobody has run the first three on this panel, C owes an account of
each.

**Delete.** There is nothing to delete. Every one of the 64 controls changes
what is drawn, and the panel's prose is already thin — five `ListRow`
descriptions, one `ListGroup` footnote explaining the query language, and one
`Hint` that fires only in local view with no note. `page.tsx:713-715` records
that this page's one lede was *already deleted* for restating its heading. The
first move is spent.

**Group.** Already done, and done well: five labelled `ListGroup`s, plus the
`GroupList`'s own label. `ui-density-audit.md:129` — "a `ListGroup` without a
`label` is not a group, it is a box" — and every group here has one. The second
move is spent.

**Reorder.** Partly done and partly not. Scope → local → filters is right;
display → forces → reset is right. **Colour groups sitting fourth at 48 of the
64 controls is the one thing out of order** (K3), and reordering alone would
move it below Forces — which fixes nothing, because 48 controls below the fold
of a 19rem column is still 48 controls in the column and still the thing that
decides the column's height, and by C11 the graph's height with it.

That last sentence is C's licence. **The third move does not work here**, and it
does not work for a reason specific to this panel: the column's height is a
shared resource with the canvas, so moving a block down the column does not
reduce anything. Only removing it from the column's height does, and that is
what a fold is.

## The three folds

All `ui/Disclosure`, all siblings of each other inside the panel `Card`, none
nested inside another (C8).

### C1. `Display` — closed by default

Arrows, Label fade, Node size, Link thickness, Animate
(`KnowledgeGraphView.tsx:466-519`). Five controls, all Tier 2 by C9: set once
per install, and clause (c) is empty on this page because it approves no
decisions.

`summary="Display"`, `count` = **the number of the five that differ from
`GRAPH_DEFAULTS.display`** (`knowledgeGraph.ts:542`), and `defaultOpen` = that
count > 0. That is C9's fold-safety rule implemented literally, and it is cheap
because every default is a literal in one object.

### C2. `Forces` — closed by default

Center, Repel, Link, Link distance (`:521-561`). Four controls, the same tier,
the same rule against `GRAPH_DEFAULTS.forces` (`:543`).

These are the clearest Tier 2 controls in the app. A force slider is tuned once
into a shape somebody likes and then never touched, and the *evidence* for that
is in the repository: `PathMapCanvas`'s `FORCES` is described at
`docs/verification.md:2113-2116` as "the graph panel's defaults with
`linkDistance` dropped from 90 to 70", which is somebody copying a settled set
of four numbers rather than reaching for the sliders.

### C3. `Colour groups` — the **editor** folds, the **swatches** do not

This is the fold that matters and the one that needs care, because 48 of the 64
controls are here and because the block is not homogeneous.

Split it in two:

- **Always visible: the colour-group list, read-only.** One row per group: the
  position number, a swatch, and the query as text. Zero focusable controls,
  seven rows, and it is the same content the legend needs anyway — which means
  **B1's legend and this list are the same element**, and the combination in
  `08-option-g` collapses them into one.
- **Behind `summary="Edit colour groups"`**: the `ColorSwatch`, the query
  `Input`, Up / Down / Remove per row, the most-used-tags chip row, and
  `Add group`. **48 controls, one press.**

`count` = the number of groups. `defaultOpen` = **false, always** — and this is
the one place C9's differ-from-default rule is deliberately not applied, because
`GRAPH_DEFAULTS.groups` is `[]` (`knowledgeGraph.ts:541`) and the seed writes
seven on the first visit (`KnowledgeGraphView.tsx:161-167`). A literal reading of
the rule would open this fold for every operator forever, which is the current
state with an extra triangle. **The rule's purpose is that a reader is never
surprised by a hidden value; the always-visible swatch list serves that purpose
directly and better**, because it shows the values rather than counting them.
That is an argument against a documented rule and it is made here rather than
buried.

### What stays outside every fold

- **View scope** (`:348-353`) — changed constantly, Tier 1 by C9 clause (a).
- **The four local-graph controls** (`:358-399`) — Tier 1 in local view, and
  already conditional on the scope being local, which is a fold the panel
  already has and did not call one.
- **All five filters** (`:401-462`) — changed constantly, and the panel's header
  says the whole thing is built to be *swept* (`:48-50`). A filter behind a
  press is a sweep that costs a press.
- **`Reset to defaults`** (`:565-569`) — C9's anti-rule 1: rarity never demotes
  a control below the thing it modifies, and this is the only undo for
  everything above it.
- **The legend**, if B is also built.

## What the panel becomes

| | Today | After C |
|---|---|---|
| Focusable controls visible on open, `Whole vault` | **64** | **14** — 1 scope + 5 filters + 3 summaries + 1 Fit\* + 1 Reset, plus 3 more when a fold's contents differ from default |
| Focusable controls visible on open, `This note` | 68 | 18 |
| Rows of *anything* in the column | ~30 | ~20 (7 read-only swatch rows carry no tab stop) |

\* Only if B is built too; C alone has no Fit.

The column gets much shorter, which by C11 makes **the canvas shorter too** —
the 4:3 sizer becomes the floor rather than a formality. That is a real cost and
it is the counter-intuitive one: **shrinking the panel shrinks the graph.**

Two ways out, and the survey does not settle between them because it cannot be
settled without looking:

- Let it shrink to the 4:3 floor. On a 1440px window with a 19rem panel the
  canvas column is roughly 900px, so 4:3 is ~675px, which is more than the
  panel's ~500px after folding. So on a *wide* window nothing shrinks — the
  ratio was already winning. It shrinks on a narrow desktop window between
  `lg` and about 1200px, and only there.
- Raise the floor for the graph card specifically. That is a number nobody has a
  reason for, and `KnowledgeGraphView.tsx:232-237` explains at length why a
  fixed height was already tried and rejected. **Do not.**

The arithmetic above is arithmetic and not a measurement; nobody has seen either
window.

## The diagnosis check

The refusal next door turned on the diagnosis being wrong: `/settings`'
complaint was reachability, and hiding makes reachability worse.

**Is the complaint here reachability?** Partly. "Not visible at first look what
I am looking at" is not — it is about the picture, and C does not touch it.
"Overwhelming" is about the column, and C is the direct answer. "Difficult to
navigate" is about the canvas, and C does not touch it either.

So C answers exactly one of the three, and it answers a question about a column
by making the column shorter, which is the direct rather than the indirect
repair. The `/settings` failure mode — a reader who knows a field exists and
cannot find it — is weaker here for a countable reason: **nine `ListGroup`
labels versus `/settings`' nine sections is not the comparison; it is three fold
summaries whose labels are the words already on the groups.** An operator
looking for `Repel force` presses `Forces`. There is nowhere else it could be.

**What would make this wrong:** if the operator sweeps display and force sliders
more often than the panel's header implies. `KnowledgeGraphView.tsx:48-50` says
the panel "is built to be *swept* through, because what it is for is finding the
setting that makes a shape appear" — and that sentence is about the whole panel,
not about the filters. If the sliders are part of the sweep, C1 and C2 are
wrong and only C3 survives. **That is the single observation that would overturn
this option, and nobody has made it.**

## What Option C does not fix

- **All of K4.** Nothing about the picture. The graph after C is exactly as
  unreadable as before, in a shorter panel.
- **K1 and K2.** The graph is still third of four blocks, still under 50 rows on
  a phone.
- **Anything for a screen reader**, except negatively: three folds is three more
  things to pass. `Disclosure` is a native `<details>` with no ARIA at all by
  deliberate design (`Disclosure.tsx:17-26`), so the cost is small and real.

## Score

| Criterion | Score | Note |
|---|---|---|
| 1 Not-visible | 1 | Touches none of K4 |
| 2 Overwhelming | **5** | 64 controls to 14. Nothing else in the survey comes near |
| 3 Navigate | 1 | |
| 4 Contradicts | 3 | Deliberately departs from C9's differ-from-default rule for C3, with an argument. Nothing else |
| 5 Keyboard | 3 | Nine controls now cost one press each to reach; three tab stops added. Net roughly even, and much shorter to tab through |
| 6 Screen reader | 3 | Three native `<details>` to pass; no ARIA added or needed |
| 7 Phone | **5** | Worth most here: below `lg` the panel is a column under the canvas, and this is the option that shortens it |
| 8 Regression | 3 | JSX restructuring in a file nothing renders, but `Disclosure` is a landed primitive with its own test and the fold contents move unchanged |
| 9 Radius | 4 | One file, one primitive already in the kit |

**Total 94 of 160.** Recomputable with `node proposals/KnowledgeSection/score.mjs`.
