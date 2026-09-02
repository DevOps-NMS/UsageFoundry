# The comparison

[← Option F](08-option-f-the-approval-order.md) · [Next: the recommendation →](10-recommendation.md)

Arithmetic in [`score.mjs`](score.mjs); run it to reproduce the table. Seven
criteria, weighted 5/5/4/3/3/3/3, maximum 130. **The scores are judgements
argued in each option's own file** — the script multiplies, it does not judge.

| | evidence | cost | cheap | safe | check | freq | place | **total** |
|---|---|---|---|---|---|---|---|---|
| **B** — name the asking tool | 5 | 4 | 5 | 4 | 5 | 5 | 5 | **121** |
| **C** — standing instructions | 5 | 4 | 5 | 5 | 5 | 1 | 5 | **113** |
| **D** — the edge pair | 4 | 5 | 4 | 3 | 3 | 3 | 5 | **102** |
| **F** — the approval order | 5 | 3 | 5 | 5 | 3 | 3 | 3 | **102** |
| **E** — the duplicate check | 2 | 2 | 5 | 5 | 4 | 3 | 4 | **88** |
| **A** — change nothing | 5 | 1 | 5 | 5 | 1 | 1 | 1 | **74** |

Weights: evidence ×5, cost-of-failure ×5, low risk ×4, cheapness ×3,
verifiability ×3, frequency ×3, lands-where-the-decision-is-made ×3.

## Where the scores come from

**B scores 121 on the only 5 nobody else has: frequency.** F1 is not a failure
that fires sometimes — it fires on **95 of 98 conversations**, because that is
how many never fetched the schema holding the asking judgement. Every other
option repairs something that happens in 1–33% of the corpus. B repairs the one
thing that is true almost every time. Its single 4 is *safe*: any change to the
asking paragraph risks moving a rate that [Option A](03-option-a-change-nothing.md)
argues persuasively is already correct, which is why B's wording is procedural
(*"when you do ask, it is `ask_operator`"*) rather than encouraging.

**C scores 113 with a 1 on frequency and full marks on everything else.** The
failure fired once in 152 turns. But it is the only defect in the corpus with a
receipt — six refused calls, a 23,626-token message re-spent — and the repair is
five lines that cannot make a correct call incorrect, in words the neighbouring
tool already uses. It is the cheapest confident win in the set.

**D scores highest of all on cost-of-failure (5) and lowest of the top four on
safety (3).** An `on-finish` + `continueBranch` chain that hits a crash puts an
agent into a repository on a half-finished branch believing the work landed —
the worst outcome anything here describes. Its 3s are honest: telling a model to
*prefer* `on-success` when 85% of edges are already `on-success` could push the
remaining 15% wrongly, and the outcome cannot be verified from transcripts
because run results live in the unreadable database.

**F scores 102 on the strongest evidence in the survey and the weakest
placement.** Three operator sentences in their own words is as direct as evidence
gets. But the fix may be in the wrong file: if the panel does not render the
chain, a clause in the reply is a workaround for a missing view, and *place*
scores 3 for that reason.

**E scores 88 and its 2 on evidence is the reason.** No duplicate proposal was
observed, only a trigger firing at what looks like the wrong time — and the
option's own file concedes the model may be reasoning correctly from a resumed
thread.

**A scores 74 and the score understates it.** Eight instructions measured at
high compliance; a surface with 8 refusals in 1,042 calls. A is the right answer
for the eight things nobody should touch, and it is carried into the
recommendation as a constraint rather than discarded as a loser.

## The D/F tie, broken

Both 102. **D ranks above F**, on two grounds:

1. **Cost asymmetry.** F's failure costs a turn — the operator re-asks and gets
   a 2,000-character answer. D's failure costs a repository: an agent committing
   into a half-finished branch under the belief the prior work is there, which
   nothing downstream detects, and which is the one failure mode in this survey
   that no human is watching for.
2. **F may not be the right file.** D's fix is unambiguously in the two
   descriptions where the two fields are typed. F's is in the prompt only because
   the panel could not be inspected. An option whose location is uncertain should
   not outrank one whose location is not.

## Robustness of the ranking

Re-run `score.mjs` with a weight changed to see which conclusions survive.

- **B stays first** unless *frequency* is dropped to weight 0 **and** *cost* is
  raised — B leads C by 8 points, of which 12 come from frequency alone.
- **C stays second** under every single-weight change tried. Its only 1 is on the
  criterion B leads on, so the two do not trade places.
- **D and F swap** if *cost-of-failure* is weighted below *evidence*. That is the
  tie above and it is decided by argument, not arithmetic.
- **A never rises above fifth**, because its 1s sit on the two heaviest criteria.
- **E never rises above fifth either.** Nothing plausible moves it.

## What the ranking means for an operator implementing two

The brief says an operator will implement the top two and ignore the rest. **B
and C together are 9 lines of prose in two files, in different failure domains,
with no interaction between them.** They can ship in either order, in one commit
or two, and neither touches an instruction that
[Option A](03-option-a-change-nothing.md) shows measuring well.

That is the recommendation, and [10-recommendation.md](10-recommendation.md) is
where it is written out as replacement text.
