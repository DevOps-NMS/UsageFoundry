# Comparison

Seven options, ten criteria, recomputable with
`node proposals/Dreaming/scripts/score.mjs`. The weights are an argument and the
script takes `--drop` and `--weight` so that disagreeing with them costs one
command; §4 records what the obvious disagreements do.

---

## 1. The options as scored

Two of them are not quite the files they point at, and saying so is part of the
scoring rather than a footnote:

- **E** is `07-option-e-a-button-a-person-presses.md` in its concrete form: a
  press, over a day of transcripts, writing into the vault proper. The file
  argues that a press is a *firing mechanism* that can be paired with any sink;
  the scored row pairs it with Option A's sink, because that is what "a Dream
  button" would mean if nobody chose otherwise.
- **D** is scored on a press, not on a clock.
  `06-option-d-question-capture.md` scores both and the nightly form loses on
  authorised spend and on a triage backlog already visible at n=3.

## 2. The criteria, and why each carries the weight it does

| # | criterion | w | grounds |
|---|---|---:|---|
| 1 | does what was asked | 4 | The brief's own words. Weighted *below* the safety criteria because `ContinuousImprovement`, `ContextControl` and `ModelRouter` all recommend against their own subject and are the better files in this directory for it. |
| 2 | licensed by the destination | 5 | `src/lib/knowledge.ts:39` refuses the write; `/workspace2/AGENTS.md:115` permits exactly one shape; `_Meta/qc.py` fails the operator's *whole vault* on a malformed note (`_Meta/Vault Quality Control.md:17`, `:34`). |
| 3 | authorised spend | 4 | `src/lib/review.ts:34`–`:35`. A press asks; a clock does not, and `src/lib/schedules.ts:529`–`:539` already makes that argument in the app's own words. |
| 4 | a wrong item can be found and retracted | 5 | `/workspace2` has no `.git`. Retrieval selects rather than averages (`Does an Agent Defer…:33`), so the *consequence* of a wrong item does not scale with the *rate*. |
| 5 | deduplicates across days | 4 | Measured: 13.5% of a night's distinct signatures seen earlier, 30.3% of instances, 49.5% of all instances in a multi-day signature (`11-deduplication-and-retirement.md`). |
| 6 | machine-established input, non-diagnostic output | 4 | 48,978 thinking blocks with 13 non-empty; unverified failing-step diagnosis at 14.2% on the nearest benchmark (`Can an Agent Write…:27`). |
| 7 | an operator can watch it and stop it | 3 | Every view in this app is keyed on a `runs` row; anything outside the run loop is invisible until its output appears. |
| 8 | cheap per week against a $956.09 day | 2 | **Deliberately low.** The cost limb of the Option G refusal does not reach this feature ($2.57 a night against $956.09 is 0.27%), and weighting cost heavily would import an objection that has been checked and does not apply. |
| 9 | cheap to build | 2 | Low: the question is whether to build, not what fits in a sprint. |
| 10 | a mistake cannot damage the operator's own store | 5 | `knowledge.ts:39`–`:44`'s stated reason for being read-only: "a background index that can write into it is one that can lose somebody's paragraph while they are typing it." |

Total weight 38; maximum 190.

## 3. The table

```
opt  asked  licen  autho  retir  dedup  corpu  visib   cost  build  blast   total
---------------------------------------------------------------------------------
 G       1      5      5      5      5      5      5      5      4      5     172   the recurrence readout — no model, no write
 D       2      5      5      5      4      3      4      4      2      3     145   question capture into the quarantine, on a press
 E       4      0      5      3      3      1      4      4      1      1      94   pressed day-read -> vault proper
 F       5      0      3      1      0      1      5      2      5      0      70   composed workflow on a daily schedule
 C       2      0      0      1      3      4      0      5      2      0      55   failures-only pass -> vault
 B       3      0      0      1      1      4      0      4      1      0      47   nightly rows pass -> vault
 A       5      0      0      1      1      1      0      3      1      0      41   nightly transcript pass -> vault
```

**The spine of the table is the second column.** Four of the seven options score
zero on it, and they score zero for the same reason: they write into a document
store whose owner has published, in that store, the rule that a session like
this one may not. That is not a close call being reported as one — it is the
same fact appearing four times, and it is why A, B, C and F cluster at the
bottom regardless of how good their inputs are. **Option B has the best corpus in
the survey after G and still finishes sixth.**

**The second spine is columns 4 and 10 together.** They are 10 of 38 weight and
they measure one thing: what happens to the operator when this feature is wrong.
Only G (writes nothing) and D (writes into a review queue that exists before the
mistake) have an answer that is not "a person deletes a file if they notice."

**And the first column is where the winner loses.** G scores 1 on "does what was
asked", which is honest: it refuses to work anything out. The recommendation
says so in its first sentence rather than burying it.

## 4. Sensitivity — what disagreeing with the weights does

Run each of these; none of them changes the winner.

**"The vault's policy isn't binding on this app, and I'll take responsibility
for my own store."** Drop criteria 2, 4 and 10 — the entire safety half:

```
$ node proposals/Dreaming/scripts/score.mjs --drop licensed,retirement,blast
 G  97   D  80   E  74   F  65   C  50   B  42   A  36      (max 115)
```

G still wins by 17. It wins the reduced table on dedup, corpus and cost, which
are the criteria a person who dismissed the safety half would say they cared
about.

**"Doing what was asked is most of the point."** Raise criterion 1 from 4 to 10:

```
$ node proposals/Dreaming/scripts/score.mjs --weight asked=10
 G 178   D 157   E 118   F 100   A  71   C  67   B  65      (max 220)
```

G still wins by 21, and the notable move is A rising above C and B — if the
literal brief is what matters, the literal reading of it is the best of the
written options, not the narrowed ones.

**Where does G actually lose?** At `--weight asked=30`, F takes it at 200. That
is a table in which "matches the brief's wording" outweighs every other
criterion combined by nearly a factor of two. And with everything *except*
criterion 1 dropped, A and F tie at 20/20 and G finishes last at 4.

**So the honest summary is: G wins every weighting except one in which the
brief's wording is the only thing being scored.** That is a real disagreement
somebody could have, it is the operator's to have, and `14-recommendation.md`
names it as the fact that would overturn the recommendation.

## 5. What the table does not score

- **Whether any of this helps.** No criterion asks whether a written learning
  changes a later session's behaviour, because nobody has measured it — the
  literature bounds any correctness effect at "10 to 15 points and probably
  zero" at a power none of the studies reached
  (`Does a Standing Instruction File…:27`), and the vault's own question about
  this exact artefact is open with UsageFoundry named as what prompted it. A
  criterion nobody can score is worse than an absent one.
- **Latency.** G's parse lands on the cold transcript scan, measured by
  `proposals/GrowthLimits` at 2,985–3,041 ms cold against 82.5–88.9 ms warm.
  That is a real cost and it is not money, so it does not appear in a column;
  `09-option-g-the-recurrence-readout.md` states it.
- **Option B's material.** Its corpus is unread — `runs`, `run_events` and
  `run_reviews` are all 0 rows in the only reachable database. Its `corpus`
  score of 4 is from the shape of `RunEventDTO.kind`, not from a count, and
  `15-validation.md` lists the query that would replace it.
