# Comparison

A weighted table is a summary of arguments made in full in the option files, not
a substitute for them. It is here because the seven options differ on several
axes at once and because the operator's complaint is three complaints, which a
single ranking hides.

The criteria and their weights are defined and justified in
[01-constraints.md](01-constraints.md#the-criteria). Total weight **32**, ceiling
**160**. Scores are 1–5 with 5 always best, including for the negative criteria.

Everything below is recomputable:

```sh
node proposals/KnowledgeSection/score.mjs
```

Change a score you disagree with in that file and the ranking re-sorts. That is
the point of it existing.

## The table

| | Option | 1 Visible | 2 Overwhelm | 3 Navigate | 4 Contradicts | 5 Kbd | 6 SR | 7 Phone | 8 Regress | 9 Radius | **Total** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **G** | The combination — E1, B, C, F2, F3 | 5 | 5 | 4 | 4 | 4 | 5 | 4 | 2 | 3 | **132** |
| **B** | Orientation layer on the canvas | 5 | 1 | 4 | 5 | 4 | 5 | 2 | 2 | 4 | **117** |
| **F** | Change what it opens on | 3 | 2 | 2 | 4 | 4 | 3 | 3 | 5 | 5 | **106** |
| **C** | Progressive disclosure in the panel | 1 | 5 | 1 | 3 | 3 | 3 | 5 | 3 | 4 | **94** |
| **E** | The first three moves | 1 | 3 | 1 | 4 | 3 | 3 | 4 | 4 | 5 | **93** |
| **D** | Split the route | 1 | 4 | 2 | 3 | 4 | 3 | 5 | 1 | 1 | **85** |
| **A** | Change nothing | 1 | 1 | 1 | 5 | 3 | 2 | 2 | 5 | 5 | **84** |

## The second table, which is the one to read

Criteria 1–3 are the operator's three sentences. Everything else is the cost of
answering them. Scored alone — weight 13, ceiling 65:

| Option | Complaint score | What it leaves |
|---|---|---|
| **G** | **61** | Only C4's keyboard decision, which is a decision |
| **B** | 45 | The whole of "overwhelming" |
| **F** | 31 | Everything, for anyone with a stored settings entry |
| **C** | 29 | The whole of "not visible" and "navigate" |
| **D** | 29 | The whole of "not visible" and most of "navigate" |
| **E** | 21 | Two of the three |
| **A** | 13 | All three |

**The gap between the two tables is the survey's main finding.** A weighted
total rewards not breaking things: A scores a perfect 5 on three criteria by
construction and lands within 9 points of D, which is a real restructure. On the
complaint alone A scores 13 of 65 and D scores 29. Read the second table first
and use the first one to choose *how* rather than *whether*.

## What the table gets right

**G's lead is not an artefact of being a superset.** It is the largest thing in
the survey, so it ought to win a table that rewards closing failures — but it
does not win on criteria 4, 5, 8 or 9, where B, E and F each beat it, and it
loses 3 points to B on "contradicts". Its lead comes from criteria 1 and 2
together, and **no other option scores above 1 on both**. That is the finding
[08-option-g](08-option-g-the-combination.md) argues from and it is visible in
the columns rather than asserted.

**B and C are each other's complement and the table shows it.** B: 5 on
criterion 1, 1 on criterion 2. C: 1 on criterion 1, 5 on criterion 2. Two
options that answer disjoint halves of one complaint at almost identical total
cost (117 against 94, and the 23-point gap is entirely criteria 4 and 8, where B
is cleaner and riskier respectively). A survey that recommended either alone
would be picking one of the operator's sentences to answer.

**D loses on cost, not on merit.** It scores 5 on phone width and 4 on
"overwhelming" — the second-best answer to the complaint's first sentence — and
then takes 1 on both regression and radius, which are 5 weight between them.
That is the honest shape of it: **D is the right answer to a question nobody
asked**, and if the operator says they want the graph as a destination it
becomes the right answer to the one they did.

## Where the table is misleading, stated rather than left to be found

**F's 106 is the score most likely to be wrong, and it is wrong in both
directions.** Its 5s on regression and radius are earned — four literals in the
one file with a 30-test suite around it — and they carry 25 of its 106 points
for changes that may reach nobody. `07-option-f`'s opening objection is fatal to
its practical value for *this* operator and is not represented anywhere in the
table, because no criterion asks "does it reach the person who complained". If
there were such a criterion F would rank last. **Its 3 on criterion 1 is also
the single most uncertain number here**: F3 turns on an inference about the
zoom `fitView` produces, which was not measured (see `07-option-f`'s F3), and if
that inference is wrong F drops to 1 there and to 96 overall.

**C's 3 on "contradicts" is the score to challenge.** It departs from C9's
differ-from-default fold rule for the colour-group editor, with an argument. If
a reader rejects that argument, C3 has to open by default — which is the current
state with a triangle on it — and C's criterion 2 falls from 5 to about 3,
taking it to 86 and below E. **The whole of C rests on that one paragraph**, and
it is in `04-option-c` under "C3", not buried.

**E's 93 undersells it and the reason is structural.** E1 is two lines and
deletes the worst measured artefact in the survey (K2, ~250 stacked lines
between a phone reader and the graph). It scores 93 because it does nothing at
all for two of the three complaints, which is true. **Cost-effectiveness is not
a criterion here and if it were, E would win outright.** That is why the
recommendation sequences E1 first rather than ranking it first.

**The screen-reader column is inference, not observation.** Every score in it
was derived from markup — a `<canvas>` with no `role`, a native `<details>` with
no ARIA by design (`Disclosure.tsx:17-26`), a `role="region"` with an
`aria-label` on the note block. **Nothing was heard.** The neighbouring survey
says the same of its own document-outline finding and files it as a question
rather than a change (`OperatorInterface/08-option-g-document-outline.md`); this
one at least has an in-repo precedent to copy (`PathMapCanvas.tsx:800-801`),
which is why B scores 5 there rather than "unknown".

**Criterion 7 rewards D and C for a width the operator did not describe.** The
complaint came from somebody at a desk. Phone width is weighted 3 of 32 because
`docs/verification.md` records real narrow-viewport work having been done and
`conventions.md` calls the mobile contract a contract — not because anybody
believes this vault is browsed on a phone. If it is not, D and C each lose 15
points and the ranking above them is unchanged.

## What no criterion measures

Three things, named so their absence is deliberate rather than accidental.

- **Whether the change reaches the operator who complained.** Only F fails this,
  and it fails it completely. Stated in F's own opening.
- **Cost-effectiveness.** E would win; G would lose badly. The recommendation
  handles this by sequencing rather than by scoring.
- **Whether the operator wants the graph to be a destination.** That single
  answer moves D from sixth to first. It is the first question in
  [11-validation.md](11-validation.md) for exactly that reason.
