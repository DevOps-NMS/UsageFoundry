# Validation: how somebody would know it worked

Seven checks. One is a question for the operator and blocks the rest. Two run in
a container. Three need a browser at a desk. One needs a screen reader.

They are in the order they should be done, and **only checks 3 and 4 can this
proposal promise**, because there is no browser in this container and no vault
mounted to it.

---

## 0. Blocking: one question for the operator, before anything is built

**Do you want the graph as a destination — a URL you open — or as part of the
Knowledge page you scroll to?**

One sentence, and it decides between two different proposals.

- **"Part of the page."** Build the recommendation as written.
  [05-option-d](05-option-d-split-the-route.md) stays refused.
- **"A destination."** Option D moves from sixth to first, and the
  recommendation becomes: land E1 anyway (it is free and it is on the way),
  build B and F3 on the graph's new surface rather than on the shared one, and
  reconsider C afterwards — because a graph at a pane's full width with nothing
  else on the screen is a different density problem from a graph in a column.

The second sentence worth asking with it: **"Is the panel a problem, or only the
picture?"** If only the picture, drop C and F2 and the work is a third the size
(`10-recommendation.md`, "What would overturn the whole recommendation").

Neither question is inferable from "overwhelming", and guessing wrong on the
first costs the largest restructure in the survey.

## 1. Before anything: run the click-list nobody has run

`docs/verification.md:1996-2044` carries a ten-step manual list for **this
canvas**, outstanding since the `canvasView.ts` extraction, which was done by a
run with no browser. Pan, zoom-about-the-pointer, both clamps, hit targets, node
drag, click-versus-drag, device pixel ratio, the resize ratchet, theme, and that
the loop stops — all "known to compile" and nothing more.

**Run it first, on the tree as it stands.** This is `02-option-a`'s strongest
argument surviving into the plan: if it is run after the recommendation lands,
nobody can tell a new bug from the one it exists to find. Ten minutes, and it is
owed regardless of whether any of this is built.

## 2. The one measurement the recommendation is waiting on

`10-recommendation.md`'s step 2e names no number for `textFade` because nobody
has read the zoom it should sit under.

With the app running on the real vault, at 1440×900, on `/knowledge` with no
stored settings (clear `localStorage["uf.knowledge-graph"]` first, or use a
private window — and note that this also re-arms the colour seed):

1. Let the whole-vault graph settle. It framed itself once, automatically
   (`KnowledgeGraphCanvas.tsx:352-359`).
2. In the console, read the fitted zoom. There is no exported handle, so read it
   off the effect that produced it — or, less invasively, wheel out until the
   graph just fills the box and note where labels appear against where they are
   wanted.
3. **Set `GRAPH_DEFAULTS.display.textFade` just below that `k`.**

**What the answer means.**

| Fitted `k` | Then |
|---|---|
| **below 1.1** | F3 is right: the first paint is unlabelled and the number is the fix |
| **above 1.1** | **F3 is wrong and should be dropped**, and one of the survey's three answers to "not visible at first look" was an inference that did not hold. Say so in `docs/verification.md` rather than quietly not doing it |

## 3. Automatic: `tagGroups`' seed limit

The only part of the recommendation that lands where a test can see it (C13).
Written **before** the change, failing, then passing:

```sh
NODE_ENV=development npm ci --include=dev   # CLAUDE.md's trap: a bare npm ci skips devDeps
npm test
```

Two assertions in `src/lib/knowledgeGraph.test.ts`, beside the 30 already there:

- `tagGroups` over a 12-tag fixture returns **3** entries, in count order, with
  `GROUP_PALETTE`'s first three colours.
- `tagGroups(tags, MAX_GROUPS)` still returns **7**, so the cap is unchanged and
  only the seed moved.

Expect: **2 failures before, 2 passes after, and the other 30 untouched.** If
any of the 30 moves, the parameter was added in the wrong place.

## 4. Automatic: the tree stays green

```sh
npm run typecheck
env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build   # CLAUDE.md's second trap
npm test
```

`npm run typecheck` is the only thing that catches the two new props
(`fitNonce`, `onHover`, `ariaLabel`) not being threaded, and `next build` is the
only thing that catches a Tailwind class the emitted sheet does not carry —
which for a legend of swatches is a real risk, because `bg-ink-muted`,
`bg-ink-faint` and `ring-ink` must each exist as utilities. **Check the emitted
CSS rather than assuming:**

```sh
grep -oE '\.(bg-ink-muted|bg-ink-faint|ring-ink|border-ink)\b' .next/static/css/*.css | sort -u
```

Four hits expected. `conventions.md` states the rule this check exists for:
Tailwind emits nothing at all for a spelling it does not know, silently.

## 5. Manual, at a desk, 1440×900: does the picture explain itself

The whole of criterion 1, and it is the check the proposal is for.

1. **The legend matches the picture.** Against `10-recommendation.md`'s table,
   row by row: a note is grey, a tag is accent, a phantom is hollow, **an
   attachment is grey with a thin dark outline** — turn `Attachments` on for
   this — and the open note carries a ring in the foreground colour. Every
   colour-group row's swatch matches the nodes it paints.
2. **The attachment mark is visible at the smallest node.** Find a degree-0
   attachment at the default `Node size`. That is a 2.5px radius disc with a
   1.2px stroke on it. **This is the single most likely thing in the proposal to
   be invisible**, and `docs/verification.md:2117-2123` records the same doubt
   about the neighbouring canvas. If it is not visible, the answer is a larger
   minimum radius for attachments, not a colour.
3. **The open note is now unmistakable in light mode.** Open a note, find its
   node, hover a different one. Before the change both are `#0069d9`; after, one
   is a foreground-colour ring and one is an accent fill. Do this in light mode
   specifically — it is fine in dark mode today, which is why nobody noticed.
4. **`Fit` works and does not disturb.** Pan somewhere, press `Fit`: the whole
   graph frames. Press it on a settled layout: the picture must **not** move
   apart from the framing — no scatter, no re-settling. Watch the CPU after:
   it must go back to idle. A `Fit` that reheated would show up here and
   nowhere else.
5. **The readout persists.** Hover a node, move the pointer off the canvas
   entirely. The box must still show that node. Then check `Links` against
   `Drawn`: turn `Orphans` off and watch `Drawn` fall while `Links` does not.
   That disagreement is the thing the legend's first sentence exists to explain,
   and this is where a reader would meet it.
6. **The folds say how many differ.** Move one force slider, reload. `Forces`
   must be **open**, with `(1)`. Press `Reset to defaults`, reload: closed, no
   count. This is C9's rule and it is the half of Option C most likely to be
   implemented as decoration.
7. **`Reset to defaults` still erases every colour group.** It does today
   (`07-option-f`'s opening). Confirm the proposal did not accidentally fix or
   worsen it, and file it either way.

## 6. Manual, at 390px: the phone reading

`conventions.md` calls the mobile contract a contract and `docs/verification.md`
already carries narrow-viewport entries. Chrome DevTools at 390×844 is enough.

1. **The graph is above the Notes table.** E1's whole point: scroll from the top
   and reach the canvas before the 50-row stacked table, not after it. Count the
   scroll — it should be the note (if open) and nothing else.
2. **The panel is under the canvas and is short.** Below `lg` the panel stacks
   (`KnowledgeGraphView.tsx:252`). Closed, it should be legend, readout, `Fit`,
   scope, five filters, three summaries, reset. If it is longer than about two
   screens, C did not do its job.
3. **Every new control clears 44px.** `Fit` is a `Button size="compact"`, which
   carries the floor; each `Disclosure` `<summary>` carries it as padding
   (`Disclosure.tsx:8-15`). Check the summaries specifically — that component's
   own docblock says a `<summary>` cannot buy the target the way other controls
   do.
4. **The legend does not wrap into nonsense.** Nine rows of swatch-plus-sentence
   in a 358px column, with one row two clauses long.

## 7. Manual, with a screen reader: the one decision with no evidence behind it

Ten minutes with VoiceOver or NVDA on `/knowledge`.

**The question is single: does the readout need `aria-live`?**
`10-recommendation.md` says no, and says that is the least-supported decision in
the proposal.

- Navigate to the graph. The canvas should announce as an image with its label:
  "The vault's link graph, N of M notes drawn. The same notes are listed,
  ordered and searchable, in the Notes list on this page." **If it announces as
  nothing, B4 did not land.**
- Navigate to the readout region and read it. It should be reachable and legible
  as ordinary content.
- Then decide: **is a listener who cannot see the canvas served better by a
  readout they navigate to, or by one that announces?** If the honest answer is
  that neither serves them and the Notes list is the only real route, that is
  worth writing down — it is exactly what `KnowledgeGraphCanvas.tsx:70-75`
  already claims, and nobody has ever checked it.

---

## What would count as this having failed

Stated in advance so it cannot be reinterpreted afterwards.

- **The fitted zoom is above 1.1.** Then F3 was an inference that did not hold,
  one of three answers to the operator's third sentence evaporates, and B's
  legend and readout are carrying that complaint alone. Say so; do not quietly
  ship the other two and call the complaint closed.
- **The attachment stroke is invisible below 5px.** Then B0.1 did not close the
  note/attachment collision and the legend has a row that lies. Either raise the
  minimum radius for attachments or **remove the attachment row from the legend
  and record that two node kinds are drawn identically** — a legend with a false
  row is worse than no legend.
- **The panel gets shorter and the graph gets shorter with it** below about
  1200px (C11). Then Option C bought a shorter column at the price of a smaller
  picture, which is the wrong trade on this surface, and the answer is not a
  fixed height (`KnowledgeGraphView.tsx:232-237` explains at length why that was
  tried and rejected) — it is to reconsider whether the legend and readout
  should be under the canvas rather than beside it.
- **The operator opens `Display` or `Forces` on most visits.** Then
  `KnowledgeGraphView.tsx:48-50`'s "built to be swept" meant the sliders, C1 and
  C2 were wrong, and they should be unfolded. One week of use answers it.
- **Nobody runs check 1.** This is the likeliest failure and the one worth
  naming. That click-list has been outstanding since the `canvasView.ts`
  extraction. If this proposal lands on top of it, the honest record is that a
  canvas nobody has driven was rebuilt around, and that sentence belongs in
  `docs/verification.md` rather than in nobody's head.

## What this proposal owes `docs/agent/` if it is built

K6: there is no `docs/agent/` doc for `/knowledge` and `CLAUDE.md`'s routing
table has no line for it. Four file headers carry the reasoning instead, and this
proposal touches three of them.

If the recommendation is implemented, the promotion step in `proposals/README.md`
— "a proposal is promoted by implementing it and moving its reasoning into those
two places" — means a **`docs/agent/knowledge.md`** and a line in `CLAUDE.md`'s
table. What it would have to settle, from this survey:

- Which colour on the canvas means what, and that a group outranks a kind.
- That size is degree **in the drawn slice**, and that the readout shows both
  numbers because they disagree.
- That the graph is a pointer surface with no keyboard route, that the Notes
  list is the named alternative, and that the canvas's `aria-label` points at it.
- That the graph's search and the list's filters are independent, and that this
  was got wrong once.
- Which panel groups fold, which never do, and that the colour-group fold
  departs from C9's differ-from-default rule with an argument.
- The seed's three numbers: `SEED_GROUPS`, `MAX_GROUPS`, `MAX_TAG_CHOICES`, and
  why they are three different numbers.

Writing that doc is not part of the change. It is the condition on the change
being finished.
