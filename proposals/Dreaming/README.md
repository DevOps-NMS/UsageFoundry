# Dreaming

**Once a day, something reads that day's sessions and writes what was learned
into the operator's vault.** Should this install build that, in what form, what
does each form cost, and what does it collide with?

Seven options, each given its strongest honest case, and the recommendation is
against building the feature as posed. An option set, not a plan. Read
`00-problem.md` first: three of its five sections are measurements nobody had
taken, and two of them move the answer.

---

## The findings that shape it

**1. The destination has already published a rule for exactly this session.**
`/workspace2/AGENTS.md:115` — "If you are a session from another project and
have not read `CLAUDE.md`, you do not have the writing conventions and **should
not write notes here**. The one exception is a single question capture into
`3 Resources/Questions/Inbox/` … a quarantine that gets reviewed before anything
counts as vault content." A UsageFoundry-spawned child is that session. Four of
the seven options ignore it.

**2. There is no `.git` in the vault.** No history, no author field, no diff of
what last night added. Retraction is a person deleting a file, if they notice —
and "if they notice" is doing all the work, because the operator's own vault
measures shipped memory systems at **5.1%–17.8%** at spotting that their own
memories have been invalidated, and records that "**retrieval selects, it does
not average**" (sub-0.1% poison → >80% attack success, peer-reviewed).

**3. Cost is not the objection, and this survey will not borrow one that was
measured about something else.** `ContinuousImprovement` refused its automatic
retrospective at 12.4–27.6% of an eleven-day bill. Dreaming reading a day's
prose once is **$2.57 against a $956.09 day — 0.27%**, $18 a week; reading only
the day's tool errors is **$0.06 a night**. The Option G refusal carries on
**authorship**, not on cost, and `01-constraints.md` C2 argues that rather than
asserting it.

**4. "Every session" is three different corpora and they disagree.** On
2026-08-28 the install saw **63 sessions: 42 in run worktrees, 11 in container
checkouts, 10 on the operator's own machine.** A Dreaming on this app's `runs`
table sees 42 of 63 and 74.6% of the money; a Dreaming on the transcripts sees
all 63 but no run's ending. Over the whole corpus the operator's own sessions
are the **largest prose class** — 18.70 MB against run-worktree's 16.99 MB.

**5. The reasoning is not there, and the diagnosis that would replace it is
measured to be bad.** 48,978 `thinking` blocks in the readable corpus,
**thirteen non-empty**, none from the model this install runs — replicating
`RunDecisionTree`'s finding on a corpus 1.7× larger — and
`src/lib/orchestrator.ts:6675`–`:6704` drops every non-`text`/`tool_use` block
by name. Against that, the operator's vault reports the best method in the only
peer-reviewed benchmark locating a failing step **14.2%** of the time, and states
the working position: *admit transcription, mark diagnosis as a hypothesis, and
never let an unverified stated cause enter a store as a fact.*

**6. Deduplication, measured rather than reasoned about.** 2,548 tool errors in
24 days, 1,175 distinct signatures; **13.5% of a night's distinct signatures
were already seen on an earlier night, 30.3% of instances, and 49.5% of all
instances belong to a signature spanning two or more days** — with the
seen-before share climbing to 36% and 57% on the last two days with material.
One signature spans 12 of 23 days.

**7. The loop has already run, three times, by hand, and it worked.** All three
notes in the vault's quarantine were captured by external sessions; **two name
UsageFoundry in `captured_from`.** One of them is where this survey's evidence on
staleness, self-report accuracy and instruction-file efficacy comes from. **None
has been triaged** since 2026-08-15.

And one thing this survey got wrong before checking it: **the transcript corpus
is readable from inside a run.** The containment pair decides a run's cwd, not
what an agent may `Read`; the managed sandbox policy's whole filesystem clause
is `"denyRead": ["${DATA_DIR:-/data}", "/backups"]`
(`docker-entrypoint.sh:431`–`:433`). Every figure here was taken from inside a
run with no special grant — and so, already, could every prompt the operator has
typed on their own machine.

## Recommendation, in one line

**Don't build it — ship the recurrence readout, run the fortnight, and if a
sentence is still wanted, put one question behind a person's press.**
[14-recommendation.md](14-recommendation.md) has the case, the runner-up, the
build order, one repair found on the way, and the single fact that would
overturn it.

---

## The files

| file | what is in it |
|---|---|
| [00-problem.md](00-problem.md) | The four nouns in the operator's sentence, measured: a day is 42.8 sessions / 53.8 MB / $956.09; "every session" is three corpora; "what was learned" is not in any of them; the vault is reachable, strict and unversioned. Plus what could not be measured. |
| [01-constraints.md](01-constraints.md) | Eight bounds. `knowledge.ts:39`'s read-only invariant; whether the Option G refusal carries (argued, not asserted); the vault's own licence; the missing `.git`; what a schedule may point at; the two vault-graded results on stale memory and self-report; and the null prior on written instructions. |
| [02-what-a-day-contains.md](02-what-a-day-contains.md) | The three corpora side by side, what each is blind to, and the cost of every slice from $0.06 to $78.31 a night. |
| [03-option-a-nightly-transcript-pass.md](03-option-a-nightly-transcript-pass.md) | The brief read literally. **Refused** — on the destination's policy, not on cost. |
| [04-option-b-nightly-rows-pass.md](04-option-b-nightly-rows-pass.md) | The same clock over `runs`/`run_events`. Best corpus for endings, worst for intent, and **unscored** because no database here has a row in it. |
| [05-option-c-failures-only.md](05-option-c-failures-only.md) | The strongest automatic form: machine-established failures only, $0.06 a night. **Refused** — its input is the best in the survey and its output is unverified diagnosis. Carries the re-check of the three latent `review.ts` defects. |
| [06-option-d-question-capture.md](06-option-d-question-capture.md) | The one write the vault licenses. **Kept, on a press; refused on a clock.** |
| [07-option-e-a-button-a-person-presses.md](07-option-e-a-button-a-person-presses.md) | The firing mechanism refused by nothing — and why a press fixes authorisation but not destination. |
| [08-option-f-workflow-block.md](08-option-f-workflow-block.md) | Build nothing: compose it. **Refused as a feature, kept as the experiment**, and carries the correction about what a run can read. |
| [09-option-g-the-recurrence-readout.md](09-option-g-the-recurrence-readout.md) | No model, no write, no clock. The transcription half with the diagnosis half deleted. **The recommendation.** |
| [10-the-write-path.md](10-the-write-path.md) | What writing into somebody's live document store actually costs: which module, the check the two containment checks don't make, what happens to `vaultSkill.ts` and the read guard, and what `qc.py` and `build_index.py` do afterwards. |
| [11-deduplication-and-retirement.md](11-deduplication-and-retirement.md) | The per-day recurrence table, what each option could do about it, and retirement scored per option — the thing every prior proposal here forgot. |
| [12-the-loop.md](12-the-loop.md) | Whether Dreaming closes a loop or adds an arrow, and why a loop with a model at both ends has no authority gradient in it. Contains the one repair worth making regardless. |
| [13-comparison.md](13-comparison.md) | Ten criteria, seven options, the weights defended one by one, and three sensitivity runs that do not change the winner. |
| [14-recommendation.md](14-recommendation.md) | The recommendation, the build order, and the fact that would overturn it. |
| [15-validation.md](15-validation.md) | A pass back over these figures: three of this survey's own claims corrected, what is a proxy, what is assumed, what could not be measured, and what a reader should distrust most. |
| [scripts/](scripts/) | `day-corpus.mjs`, `slices.mjs`, `recurrence.mjs`, `score.mjs` — every figure and the score, re-runnable. |

## Reproducing the measurements

```bash
node proposals/Dreaming/scripts/day-corpus.mjs ~/.claude/projects --split
node proposals/Dreaming/scripts/slices.mjs     ~/.claude/projects
node proposals/Dreaming/scripts/recurrence.mjs ~/.claude/projects
node proposals/Dreaming/scripts/score.mjs
node proposals/Dreaming/scripts/score.mjs --drop licensed,retirement,blast
```

Nothing here writes. `15-validation.md` §6 lists the four SQL queries that would
settle what the empty database could not, and §9 ranks what to distrust.
