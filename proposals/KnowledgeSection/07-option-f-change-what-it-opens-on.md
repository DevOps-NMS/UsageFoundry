# Option F: change what it opens on, not what it offers

The second option the brief's four do not contain, and the cheapest thing in the
survey. Nothing moves, nothing folds, nothing splits. Four literals change in
`src/lib/knowledgeGraph.ts` — **the one file on this route with a test suite
around it** (C13: `grep -c "^test(" src/lib/knowledgeGraph.test.ts` returns 30).

It has one objection that nearly kills it, stated up front rather than at the
end.

---

## The objection, first

**A default only reaches an operator with no stored settings, and the operator
who complained has stored settings.**

`KnowledgeGraphView.tsx:110-124` reads `localStorage["uf.knowledge-graph"]` once
after mount and, if anything is there, that is what the panel shows. The write
back fires on every settings change (`:126-132`). So anybody who has ever moved
a slider on this page has an entry, and **every change in this option is
invisible to them** until they press `Reset to defaults`.

That is not a reason to reject it — a default is what every *future* first look
gets, and the complaint was a first-look complaint — but it does mean **F cannot
be the answer to the complaint that prompted this survey**, and any file that
did not say so would be selling it dishonestly.

There is a second-order effect worth knowing: `Reset to defaults`
(`KnowledgeGraphView.tsx:566`) calls `defaultGraphSettings()`, which is
`structuredCloneDefaults()` (`knowledgeGraph.ts:659-661`), and
`GRAPH_DEFAULTS.groups` is `[]` (`:541`). The seed cannot re-fire, because
`seedable.current` was cleared when the fetch settled (`KnowledgeGraphView.tsx:161-167`).
**So pressing Reset removes every colour group permanently, on a control labelled
"Reset to defaults", and the graph goes grey.** That is a defect worth naming
whether or not this option is built, and it is the one thing in this file with a
claim on being fixed regardless.

---

## F1. `view` opens on `This note` when a note is open

`GRAPH_DEFAULTS.view = "global"` (`knowledgeGraph.ts:532`). The docblock above it
(`:523-530`) justifies `showOrphans` being on and `existingOnly` being off, at
length, and **says nothing about `view`**. It is the one default on that object
with no written reason, which is the first place to look.

The whole-vault graph at this vault's size is 893 nodes and 19,995 edges
(`docs/verification.md:776-777`) — the hairball the operator is describing when
they say it is not visible what they are looking at. The local graph at
`depth: 1` around one note is a handful of nodes with readable labels. **The
picture that answers "what am I looking at" is the local one, and the page only
ever opens on the global one.**

The change is not to `GRAPH_DEFAULTS.view` — that would open a note-less page on
a view that says "Open a note above and the graph follows it"
(`KnowledgeGraphView.tsx:354-356`) and shows an `Empty` (`:258-261`). It is
conditional: **when the page loads with `?note=` in the URL and nothing is
stored, the graph opens on `This note`.** Which is one extra clause in the same
`useEffect` that reads `localStorage`, gated on the same `stored === null` that
already gates the colour seed.

**Cost:** it makes the first paint depend on the URL, and the seed already
depends on the fetch, so there are now two first-visit behaviours instead of
one. `KnowledgeGraphView.tsx:99-108` is a 10-line comment about how delicate the
existing one is. Adding a second thing to that moment is the risk in this
option.

## F2. Seed three colour groups, not seven

`tagGroups` slices to `MAX_GROUPS` (`knowledgeGraph.ts:283`), and `MAX_GROUPS = 7`
is the cap on how many an operator may *have* — "more than this is a legend
nobody reads, and seven distinct colours is already past what most people can
tell apart on a dim node" (`:680-682`).

**The cap and the seed are the same number for no stated reason.** The cap's own
docblock argues that seven is at the edge of legibility; seeding straight to the
edge is the one thing that sentence argues against.

Seeding three:

- Removes **20 of the 35** colour-group editor controls from a first visit
  (K3), taking the panel from 64 to 44 with no fold and no move.
- Gives Option B's legend three group rows instead of seven, taking it from
  **thirteen rows to nine** — which is the difference between a legend somebody
  reads and one they scroll.
- Leaves the top three tags coloured, which is where the signal is: `graphTags`
  sorts by count descending (`:254-256`), and a long tail of tags is a long tail.
- Costs nothing to undo. The chip row offers twelve (`MAX_TAG_CHOICES`, `:694`)
  and lighting a fourth is one press (`KnowledgeGraphView.tsx:723-761`).

The change is a `SEED_GROUPS = 3` constant beside `MAX_GROUPS`, and `tagGroups`
takes a `limit = SEED_GROUPS` parameter. It lands in the tested file, and the
suite already covers `tagGroups` — this is the one change in the survey that can
have a test written before it and after it.

**Against:** three colours on a 893-node graph paints less of it, and the
seven-colour first paint is more *informative* even if it is more crowded. The
counter-argument to that is that the crowding is in the panel and the colour is
on the canvas, so the trade is not one-for-one: seven colours cost 35 controls
and three cost 15, while the canvas loses four hues out of a picture that has
893 nodes in it. Nobody has looked at either.

## F3. `textFade` opens lower

`GRAPH_DEFAULTS.display.textFade = 1.1` (`:542`), on a range of 0 to 3
(`:549`), and the field's own docblock (`:493-500`) says the two failure modes
are opposite — labels at every zoom are a wall of text, none at all is an
unreadable local graph.

The canvas opens at `k = 1` (`:640`) and then, on the first cold layout, calls
`fitView` (`KnowledgeGraphCanvas.tsx:336-344`), which sets `k` to
`min(width/extentX, height/extentY)` clamped into `[0.05, 8]`
(`src/lib/canvasView.ts:250-261`, `:73-74`). The fade is
`view.k <= textFade ? 0 : ...` (`:315`), so **no label is drawn at all until the
zoom passes 1.1** — which is above the canvas's own opening `k` of 1 and above
any fit of a graph wider than its viewport.

**Inferred, not measured**, and the missing measurement is the graph's extent in
world units: a 893-node layout at `linkDistance: 90` is very likely wider than
900px and therefore fits at `k < 1`, but this survey has no browser and did not
compute the extent. If it fits at `k > 1.1` the whole of F3 is wrong. That is a
one-line thing to check and it is on the validation list.

If the inference holds, **this is the most likely single cause of "not visible at
first look what I am looking at", and it is one number**: the operator's first
look is a field of unlabelled dots, which is close to a literal restatement of
the complaint.

It is also the number this survey is least able to choose. The right value is
whatever puts labels on the ten or twenty largest nodes at the framed zoom, and
that depends on the vault's extent in world units, which depends on the forces,
the node count and the window. **This file does not propose a number.** It
proposes that somebody open the page, note the `k` that `fitView` produces at
1440px on the real vault, and set `textFade` just below it — a five-minute
measurement that nobody can do in this container, and the highest-value
five minutes in the survey.

**A rejected alternative:** make `textFade` relative to the fitted zoom rather
than absolute. That is a behaviour change to a documented field on a slider an
operator may already have set, it makes a stored value mean something different
than it did when it was stored, and it is the kind of change C3's coercion
cannot detect. No.

## F4. Nothing else on `GRAPH_DEFAULTS` changes

Stated so the option's edge is visible.

`showOrphans: true` and `existingOnly: false` are argued for in writing
(`:523-530`): the page's own health card counts orphans and broken links as
things to go and fix, and a graph that hid both by default "would be a second
view of the vault that disagrees with the first about what is in it". That is
the same argument as C5 and it is right. **Not touched.**

`showTags: false`, `showAttachments: false`, `arrows: false`, `animate: true`,
`nodeSize: 1`, `linkThickness: 1`, `local.depth: 1` and all four forces are
either self-evidently right or unmeasurable from here. **Not touched.**

## What Option F does not fix

- **Anything, for the operator who complained**, until they press Reset — see
  the objection above.
- **K1 and K2.** The route is unchanged.
- **All of K4 except F3.** No legend, no readout, no fit, no accessible name,
  and B0's two colour collisions are untouched — a default cannot fix two marks
  meaning the same thing.
- **The 64 controls**, except by 20 of them, on a first visit only.

## What is good about it

It is the only option that lands in a tested file; it is the only option where a
change can be pinned by an assertion before and after; it is four literals; and
**F3 alone may be the largest single contributor to the complaint's third
sentence.** For an option this cheap, "may be" is enough to earn the five
minutes.

## Score

| Criterion | Score | Note |
|---|---|---|
| 1 Not-visible | 3 | F3 plausibly closes a large part of it and F1 helps. Not 4 or 5 because the number is unknown and the whole thing misses anyone with stored settings |
| 2 Overwhelming | 2 | 20 controls on a first visit, none for a returning operator |
| 3 Navigate | 2 | F1 opens on a navigable picture rather than a hairball |
| 4 Contradicts | 4 | F2 argues against `MAX_GROUPS`' docblock reading as a seed, which is a reading rather than a decision. F1 adds a second behaviour to the delicate first-visit moment `:99-108` documents |
| 5 Keyboard | 4 | 20 fewer tab stops on a first visit, none added |
| 6 Screen reader | 3 | Unchanged |
| 7 Phone | 3 | A shorter panel below `lg`, on a first visit only |
| 8 Regression | **5** | The only option landing in `src/lib`, beside a 30-test suite |
| 9 Radius | **5** | Four literals and one constant |

**Total 106 of 160.** Recomputable with `node proposals/KnowledgeSection/score.mjs`.
