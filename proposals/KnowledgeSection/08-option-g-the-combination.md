# Option G: the combination — E1, then B, then C, with F2 and F3

**E1** moves the graph above the Notes table. **B** puts an orientation layer on
the canvas. **C** folds Display, Forces and the colour-group editor. **F2**
seeds three colour groups instead of seven. **F3** sets `textFade` from a
measurement.

D is not in it. E2 is superseded. F1 is deferred. Each of those is argued below
rather than assumed.

---

## Why these compose rather than merely coexist

Three of the pairings are load-bearing. A combination whose parts only sit
beside each other is a list; these interlock, and the interlocks are the reason
this option beats its own components.

### B needs C, or B makes the complaint worse

`03-option-b` scores **1** on criterion 2 and says why: the legend is 5–9 rows
and the readout is a fixed box, call it 260px added to a 19rem column that is
already the taller of the two. The operator's first complaint is that the
section is overwhelming. **An orientation layer alone answers the third
complaint by aggravating the first.**

C removes 50 focusable controls from that column. Together the column is
*shorter* than it is today while carrying more information, which is the only
arrangement that answers both sentences at once.

### C needs B, or C is hiding without explaining

`ui-density-audit.md:105-107`: "a reader who cannot find a control assumes it
does not exist". The controlled evidence quoted in
`proposals/OperatorInterface/09-option-h` cuts the same way — always-visible
explanation is consulted roughly twice as often as hidden explanation.

C hides nine sliders and a colour editor. B makes the **explanation** permanent
for the first time on this surface. Folding controls while un-hiding the
legend is the shape both findings point at; folding controls alone is the shape
they warn about.

### C3 and B1 are the same element, and only the combination notices

`04-option-c`'s C3 splits the colour-group block into a read-only list of
`(position, swatch, query)` rows plus a folded editor. `03-option-b`'s B1 opens
the legend with one row per colour group, `(swatch, query)`, in the group's
order.

**Those are the same seven rows.** Built separately they are two lists of the
same data, twenty rows apart in one column, which is the "two names for one
concept" defect `ui-density-audit.md:389-390` calls a defect rather than a
layout problem. Built together they are one list: the legend's group rows *are*
the colour-group list, and pressing **Edit colour groups** opens the controls
under them.

That is not a saving of code. It is the difference between a panel that says
what the colours mean and a panel that says it twice in different words.

### F2 shrinks both of them

Seven seeded groups make the legend nine rows — at the top of `ListGroup`'s 3–9
range (C10) — and the folded editor 35 controls. Three make the legend five rows
and the editor 15. **F2 is the difference between a legend at its cap and a
legend comfortably inside it**, and it costs one constant in the one file on
this route with a test suite.

### E1 is independent of all of it, and goes first

E1 touches no file B or C touches — it is a JSX move in `page.tsx` plus a
comment edit in `KnowledgeGraphCanvas.tsx`. It can land, be looked at, and be
kept or reverted on its own.

It goes first for the reason `ui-density-audit.md:92-107` gives: hiding is the
fourth move and this route has never had the first three. **After E1 somebody
can say whether the section still feels overwhelming**, and if it does not, C is
unnecessary and this proposal is smaller than it looks. That is a real
possibility and the sequence is built to expose it rather than to foreclose it.

---

## What is left out, and why

### D is refused

Not on merit — `05-option-d` scores it well on criterion 7 and it is the only
option that deletes K2 outright rather than by side effect. It is refused on
three grounds:

1. **E1 gets most of D's benefit for two lines.** D's largest gain is that the
   graph is not under the note and the table. E1 puts it under the note and
   above the table, which on a phone removes ~250 stacked lines (K2). The
   remainder — that the graph shares a scroll with Health below it — is a much
   smaller problem than the one E1 solves.
2. **D's cost is a fetch of 7.3 MB per tab visit or per navigation**
   (`docs/verification.md:775-777`), with no free answer: hoisting it couples the
   page to the graph's state, and keeping the tab mounted is the decision
   `/runs/[id]` explicitly made the other way (`ui-density-audit.md:301-303`).
3. **`docs/verification.md:1996-2044` is an unrun ten-step click-list for this
   exact canvas.** Moving it to a new URL before that list is run means the next
   person cannot tell a new bug from the one the list exists to find. This is
   `02-option-a`'s strongest argument and it survives here as a sequencing
   constraint.

**What would reverse this:** if the operator says they want the graph as a
destination — a URL, a bookmark, a thing they open rather than scroll to. That
is a preference nobody has stated and it is not inferable from "overwhelming".
It is the first question in `11-validation.md`.

### E2 is superseded by C3

E2 moves 48 controls down the column; C3 removes them from it. `06-option-e`
makes the argument against itself: on this panel the third move does not do the
third move's job, because the column's height is a shared resource with the
canvas and moving a block down the column does not shorten it.

### F1 is deferred

Opening on `This note` when the URL carries `?note=` is probably right and it
adds a second behaviour to the first-visit moment that
`KnowledgeGraphView.tsx:99-108` spends ten lines explaining the delicacy of.
Once F3 has been measured and the global graph carries labels, the case for F1
is weaker — a labelled hairball is a different object from an unlabelled one.
**File it; do not build it in this piece of work.**

### The colour editor does not go in a `Sheet`

Considered and rejected. C9's Tier 3 is "used once per install **and** large
enough to be its own screen; or destructive, irreversible, or handling a
credential". The editor is used once per install and it is 15 controls after F2,
which is not a screen. And a `Sheet` is a focus trap over the canvas
(`ui-density-audit.md:121`), so an operator could not see the colours changing
while they changed them — which is the whole activity. Tier 2 is correct.

---

## What it costs

**Files:** `src/app/knowledge/page.tsx` (E1's move), `src/components/KnowledgeGraphView.tsx`
(the legend, the readout, the folds, Fit, the nonce), `src/components/KnowledgeGraphCanvas.tsx`
(B0's two colour repairs, the `fitNonce` prop and effect, the two ARIA
attributes, one comment edit), `src/lib/knowledgeGraph.ts` (F2's constant, F3's
literal). Four files, one of them by two lines, one of them tested.

**The risk is B's, not C's.** C moves JSX unchanged into a landed primitive that
has its own test. B changes drawing code, adds a hover path that touches React
state on a surface that redraws per pointer move, and adds a prop-driven imperative
call into a canvas. Every one of the survey's regression concerns is in B.

**Nothing about it is verifiable in this container.** No browser, no vault. Every
claim about how it looks is inference, and `11-validation.md` is the list of what
somebody at a desk has to do before any of it can be called done.

## What it still does not fix

- **The keyboard.** C4 stands and this option does not argue with it. A keyboard
  user gets three fewer things to tab past, one new button, and no route into
  the graph. That is the decision, not an oversight.
- **A screen reader's access to the graph's *content*.** B4 gives the canvas a
  name and points at the Notes table. It does not make the graph itself
  navigable, and nothing here proposes to.
- **The 7.3 MB fetch.** Untouched by every option in this survey.
- **`Reset to defaults` wiping the colour groups permanently**
  (`07-option-f`'s opening). Named as a defect; not in this piece of work.

## Score

| Criterion | Score | Note |
|---|---|---|
| 1 Not-visible | **5** | All of B, plus F3 |
| 2 Overwhelming | **5** | C's 64→14 net of B's additions, plus E1 removing two blocks from above the graph |
| 3 Navigate | 4 | B's Fit and readout; C4 caps it |
| 4 Contradicts | 4 | C3's departure from C9's differ-from-default rule, argued; E1's one falsified word, repaired in the same commit |
| 5 Keyboard | 4 | Net far fewer stops, one new control, nine controls one press away |
| 6 Screen reader | **5** | B4's name and the Notes pointer; three native `<details>` against it |
| 7 Phone | 4 | E1 deletes K2; C shortens the column under the canvas; B's legend adds to it |
| 8 Regression | 2 | B's drawing changes and hover path, in files nothing renders |
| 9 Radius | 3 | Four files, no shared component, no token, one `localStorage` key untouched |

**Total 132 of 160.** Recomputable with `node proposals/KnowledgeSection/score.mjs`.
