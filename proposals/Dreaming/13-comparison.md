# Comparison

Nine options, ten criteria, recomputable with
`node proposals/Dreaming/scripts/score.mjs`. The weights are an argument and the
script takes `--drop` and `--weight` so that disagreeing with them costs one
command; §4 records what the obvious disagreements do.

**H and I were added after the operator corrected the brief**, and the
correction moved two columns rather than adding two rows. §6 says what changed
and why the original seven were scored the way they were.

---

## 1. The options as scored

Four of them are not quite the files they point at, and saying so is part of the
scoring rather than a footnote:

- **E** is `07-option-e-a-button-a-person-presses.md` in its concrete form: a
  press, over a day of transcripts, writing into the vault proper. The file
  argues that a press is a *firing mechanism* that can be paired with any sink;
  the scored row pairs it with Option A's sink, because that is what "a Dream
  button" would mean if nobody chose otherwise.
- **D** is scored on a press, not on a clock.
  `06-option-d-question-capture.md` scores both and the nightly form loses on
  authorised spend and on a triage backlog already visible at n=3.
- **H and I are scored on a clock**, as a one-node workflow on a
  `{kind:"daily"}` schedule, because that is the form the operator described.
  Both would score 5 rather than 3 on *authorised spend* on a press. Neither is
  scored on a press because a press is Option E's row and the point of H and I
  is that the writer is licensed, not that the firing is.
- **Both score 4, not 5, on *licensed by the destination*.** The licence is
  real — `AGENTS.md:115`'s prohibition is conditional on not having read
  `CLAUDE.md`, and a run whose cwd is the vault fails that antecedent. It is
  also unenforced: nothing verifies the run read anything, the managed sandbox
  policy carries no path-based write restriction
  (`docker-entrypoint.sh:431`–`:433`), and a skill is persuasion
  (`10-the-write-path.md` §3). A licence nothing checks is not a 5.

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
 I       4      4      3      3      5      4      5      5      3      2     140   licensed external run, errors only, write-on-recurrence
 H       5      4      3      2      1      2      5      2      3      1     104   licensed external run over tools+outputs
 E       4      0      5      3      3      1      4      4      1      1      94   pressed day-read -> vault proper
 F       5      0      3      1      0      1      5      2      5      0      70   composed workflow on a daily schedule
 C       2      0      0      1      3      4      0      5      2      0      55   failures-only pass -> vault
 B       3      0      0      1      1      4      0      4      1      0      47   nightly rows pass -> vault
 A       5      0      0      1      1      1      0      3      1      0      41   nightly transcript pass -> vault
```

**The spine of the table is still the second column, and it now has two values
rather than one.** Four options score zero on it because they write into a
document store whose owner has published, in that store, the rule that a session
like this one may not. **H and I score 4 because they are not that session** —
the rule's antecedent is "have not read `CLAUDE.md`", and an external run whose
cwd is the vault fails it. That single distinction is worth 20 points and it is
the whole difference between C at 55 and I at 140, which are otherwise the same
feature over the same corpus. **A and C are not refused for being automatic
writers; they are refused for being automatic writers that never read the rules
of the place they write to.**

**Option B still has the best corpus in the survey after G and still finishes
seventh**, because its problem was never the corpus.

**The third column is where H and I give something back.** Both are scored on a
clock, so both take 3 on authorised spend where D and E take 5 —
`review.ts:34`–`:35` and `schedules.ts:529`–`:539` do not stop applying because
the writer got a licence. What a schedule buys back is `scheduleRefusal`, which
is why 3 rather than 0: a scheduled workflow **cannot exist without a spending
ceiling**, checked at creation and again at every fire.

**The second spine is columns 4 and 10 together.** They are 10 of 38 weight and
they measure one thing: what happens to the operator when this feature is wrong.
Only G (writes nothing) and D (writes into a review queue that exists before the
mistake) have an answer that is not "a person deletes a file if they notice."

**And the first column is where the winner loses.** G scores 1 on "does what was
asked", which is honest: it refuses to work anything out. The recommendation
says so in its first sentence rather than burying it — and §4 now shows that
column overturning the table at a far lower weight than it used to.

**The two new rows split on one thing and it is not licence.** H and I have
identical scores on licence, authorised spend, visibility and build. They differ
by 36 points, and 28 of those are *dedup* and *corpus* — H's corpus does not fit
in a context on 91% of days and carries a deduplication key on 0.2% of its bytes;
I's fits with three orders of magnitude to spare and is 100% keyed.
**Scoping the corpus, not licensing the writer, is what makes this feature
buildable.**

## 4. Sensitivity — what disagreeing with the weights does

Run each of these; none of them changes the winner.

**"The vault's policy isn't binding on this app, and I'll take responsibility
for my own store."** Drop criteria 2, 4 and 10 — the entire safety half:

```
$ node proposals/Dreaming/scripts/score.mjs --drop licensed,retirement,blast
 G  97   I  95   D  80   E  74   H  69   F  65   C  50   B  42   A  36   (max 115)
```

**G's margin here collapses from 17 to 2.** This is the reweighting that used to
be comfortable and no longer is: a person who dismisses the safety half is left
choosing between a readout and a writer on dedup, corpus, cost and visibility,
and Option I is within noise of the readout on all four. It is no longer true
that G "wins the reduced table on the criteria a person who dismissed the safety
half would say they cared about" — it ties on them.

**"Doing what was asked is most of the point."** Raise criterion 1 from 4 to 10:

```
$ node proposals/Dreaming/scripts/score.mjs --weight asked=10
 G 178   I 164   D 157   H 134   E 118   F 100   A  71   C  67   B  65   (max 220)
```

G still wins by 14, and Option I has displaced D as the best writing option.

**Where does G actually lose?** **At `--weight asked=15`, Option I takes it,
184 to 183.** That is the number that changed most in this revision and it is
the one to argue about: before H and I existed the crossover was at
`asked=30`, where F took the table — a weighting in which the brief's wording
outweighed every other criterion combined by nearly a factor of two, and which
was easy to dismiss. **Fifteen is not that.** It is "doing what was asked is
worth three times a safety criterion", which is a position a reasonable person
holds, and it is the operator's own position by default since they are the one
who asked.

```
$ node proposals/Dreaming/scripts/score.mjs --weight asked=15
 I 184   G 183   D 167   H 159   E 138   F 125   A 96  B 80  C 77   (max 245)
```

**So the honest summary has changed.** It used to be: G wins every weighting
except one in which the brief's wording is the only thing scored. It is now:
**G wins on this survey's weights, and Option I overtakes it as soon as
"produces a sentence" is worth roughly three times a safety column.** Both
numbers are in the script; neither is a rounding artefact; and `14-recommendation.md`
§"The fact that would overturn this" is rewritten because of it.

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
- **The left-hand pane.** No criterion scores it, because the operator has
  required it of whichever option ships and a requirement common to every row
  cannot separate them. `18-the-dreaming-pane.md` costs it, and records the one
  asymmetry a criterion *would* have caught: H's output is 99.8% unlistable on
  that pane, because only a keyed signature can be recorded at write time.

## 6. What the operator's correction changed

The first nine files of this survey scored a nightly child **spawned by this app
into a run's checkout**, which reads a day of sessions and writes into a vault it
has never opened the conventions of. That is what "a nightly pass" was taken to
mean, and against that reading `AGENTS.md:115` is decisive: four options score
zero on licence and cluster at the bottom.

The operator's actual proposal is an **external run whose working directory is
the vault**, which reads `CLAUDE.md` first. Three things follow and all three are
scoring changes rather than opinions:

1. **`AGENTS.md:115` does not apply.** Its prohibition is conditional and the
   remedy is stated one paragraph above it (`AGENTS.md:109`). Licence goes 0 → 4.
2. **`knowledge.ts:39` does not apply.** Its bound is on "this module or the
   routes over it", and an agent's own `Write` tool is neither. The new-module
   cost in `10-the-write-path.md` §1 is not incurred.
3. **"Tools and outputs" is the transcription half.** `01-constraints.md` C6's
   14.2% figure is about a model locating the step where its own reasoning went
   wrong. A model reading an error string and restating it is not doing that, so
   C6 refuses part of the output rather than all of it. Corpus goes 1 → 4 for the
   errors-only form.

**What the correction did not change:** C4 (no `.git`), C7 (retrieval selects
rather than averages), C8 (no measured benefit), `qc.py`'s ERROR families, the
2.6 MB `build_index.py` regeneration, and the fact that a clock still removes the
person `review.ts:34` is about. Those are why I scores 140 and not 172.

**And one thing the correction made worse, which is the finding of this
revision.** Reading *all* tool inputs and outputs rather than the prose slice
takes the daily corpus from 514k tokens to **5,521k**, overflowing a 1M window on
91% of days, and takes the share of the corpus carrying a deduplication key from
"the error slice" to **0.2% of bytes**. The operator's scoping instinct — tools
and outputs rather than words — is right about *what kind of fact* to read and
expensive about *how much of it*. `16-option-h` §2 and `§4` are that argument;
`17-option-i` is what it recommends instead.
