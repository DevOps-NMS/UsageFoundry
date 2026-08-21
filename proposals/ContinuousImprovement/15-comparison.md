# Comparison

Eleven options, ten criteria, weights stated before the scores. The totals are
at the bottom and they are the least interesting thing in the file — two of the
three highest-scoring options do not reach a run at all, which is the survey's
result rather than a defect in the scoring.

## One thing the survey learned while looking for something else

`00-problem.md` closes on a decline: 112 runs edited `src/lib/`, eleven read the
`docs/agent/` doc CLAUDE.md tells them to read. Every option that injects text
had to survive that prior, and `02-what-already-tries.md` went looking for the
control — a generated in-prompt notice this app already ships — and found the
opposite result.

`continuedWorkNotice` (`src/lib/orchestrator.ts:4401`) prints two exact git
commands into the first user message of a continuation run. Over the 66 runs
that received it, against the **matched** control of 175 runs that were also
isolated on a worktree, also ran Bash, and did not receive it — matched because
an unisolated run has no branch to diff and would inflate every lift below:

| | told (66) | matched control (175) | lift |
|---|---|---|---|
| ran **any** `git log` | 66 — **100%** | 159 — 90.9% | 1.1× |
| ran **any** `git diff … --stat` | 58 — 87.9% | 103 — 58.9% | 1.5× |
| ran `git log --oneline <base>..HEAD`, the exact form printed | 66 — **100%** | 31 — 17.7% | 5.6× |
| ran `git diff --stat <base>...HEAD`, the exact form printed | 56 — **84.8%** | 7 — **4.0%** | **21×** |

Re-measured by `18-validation.md` with an order-independent matcher (three
separate `LIKE`s, because `git diff <range> --stat` and `git diff --stat <range>`
are the same command) against the matched control. The strict and loose readings
are both given because they say different things and quoting only one would be a
sales pitch — and the earlier drafts of this survey quoted only one, at three
different wrong values.

The behaviour lift is **1.1–1.5×**: these runs were going to look at git anyway,
and the notice barely moves that. **The lift on the exact command form is 21×**,
and that is the finding: the notice does not make a run examine its branch, it
makes the run examine it *the way the notice said to*.

So the gate decline is **not** evidence that text at cycle 1 is ignored. Both
texts arrive in the same message, in the same position, from the same app. One
was obeyed by every run that saw it and one was declined by nine in ten. What
separates them is not where they sit but what they ask for: the notice names one
cheap command, and the gate asks the agent to go and read a 63,394-byte
document before doing the thing it was asked to do.

**Compliance tracks the cost of complying.** That reframes every injection
option in this survey — C and F(b) are the notice's shape, D was designed around
the position hypothesis, and E moves text between two positions that this result
says are the same position.

## The criteria, and their weights, stated before the scoring

| # | Criterion | Weight | Why it is weighted there |
|---|---|---|---|
| 1 | **Teaches the run, not only the operator** | 5 | The question asked. An instrument is not continuous improvement |
| 2 | **Acts on a measured prize** | 5 | Constraint 13: `d` does not exist, and an assumed saving is not a saving |
| 3 | **Costs nothing when it does not fire** | 4 | The MCP arithmetic: $8.14–$8.26 a week is paid before anyone calls anything |
| 4 | **Fails loudly** | 4 | `docs/agent/` exists because nearly every invariant here fails silently |
| 5 | **The operator can see it and disagree with it** | 3 | Constraint 6, and nobody can correct a memory they cannot read |
| 6 | **Reaches every cycle and every install it needs to** | 3 | Constraints 1 and 2: `--resume` restores three flags, and a `DEFAULT_*` misses an edited install |
| 7 | **Its author is not a run** | 4 | Constraint 7: the write side and the read side must differ |
| 8 | **No fourth store, horizon or `StorageReport` arm** | 2 | Constraint 8, and a horizon is a permanent tax on the operator's attention |
| 9 | **Cheap to build** | 2 | Real, and deliberately the second-lightest weight |
| 10 | **Prices its success, not only its idle** | 3 | Constraint 13. A gate that works costs a doc read |

Maximum 175. Scores are 0–5 and the cells that carry the argument are discussed
below the table rather than defended inside it.

## Scores

| | A see it | B ending code | C pointer | D gate hook | E operator note | F conflict history | G retrospective | H repo brief | I MCP tool | J agent CLAUDE.md | K delegate |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 teaches the run (×5) | 0 | 0 | 4 | 5 | 3 | 2 | 4 | 3 | 3 | 4 | 1 |
| 2 measured prize (×5) | 5 | 3 | 4 | 2 | 1 | 4 | 1 | 2 | 0 | 0 | 4 |
| 3 free when idle (×4) | 5 | 5 | 2 | 5 | 2 | 5 | 0 | 2 | 0 | 1 | 4 |
| 4 fails loudly (×4) | 4 | 3 | 2 | 1 | 2 | 4 | 2 | 1 | 3 | 1 | 3 |
| 5 operator can see it (×3) | 5 | 4 | 3 | 2 | 5 | 5 | 3 | 3 | 3 | 4 | 3 |
| 6 reaches what it must (×3) | 5 | 5 | 5 | 5 | 4 | 5 | 3 | 3 | 4 | 5 | 5 |
| 7 author is not a run (×4) | 5 | 5 | 5 | 5 | 5 | 5 | 0 | 1 | 5 | 0 | 5 |
| 8 no fourth store (×2) | 5 | 4 | 5 | 5 | 4 | 5 | 2 | 1 | 4 | 5 | 5 |
| 9 cheap to build (×2) | 4 | 5 | 4 | 2 | 3 | 4 | 1 | 1 | 2 | 5 | 5 |
| 10 prices its success (×3) | 5 | 4 | 3 | 4 | 2 | 4 | 2 | 2 | 3 | 2 | 4 |
| **Total /175** | **144** | **124** | **127** | **126** | **103** | **146** | **63** | **69** | **89** | **81** | **129** |

## Reading the interesting cells rather than the totals

**The top two options do not reach a run.** F (146) and A (144) are both
readouts, and both score 0 or 2 on the criterion that carries the most weight.
That is not a scoring artefact to be corrected — it is the survey's finding. On
this install the mechanisms that reach a run are either unmeasured (C, D),
refused on their own arithmetic (G, H, I, J) or answering a different question
(K), while the two that only look at what already happened are cheap, safe and
immediately useful. An honest recommendation has to say that out loud rather
than promote the highest-scoring actuator.

**K ranks third and answers the wrong question.** Delegation has the
best-derived per-unit arithmetic in the survey — `$0.060` against `$0.163` a
turn — and scores 1 on criterion 1 because it remembers nothing between runs.
It is in this survey only because it reduces orientation cost, which is half of
what was asked for; it does nothing about the 73.2% cross-run repeat. Its
system-prompt half also **already shipped**, at `ee93684`, while this survey was
being written.

**C and D are separated by two cells, and both cells are the same unknown.**
C scores 4 on the measured prize because its ranking is measured (45.0%
prequential coverage at top-20 with a recency decay) and D scores 2 because its
premise — that the decline is about position — is now contradicted by the 21×
result above. D scores 5 to C's 4 on teaching the run because it fires at the
moment of the edit rather than 29 tool calls earlier. Both then multiply by a
`d` that nobody has measured. **Neither can be chosen on the numbers, which is
what `03-experiment-holdout.md` exists to fix.**

**D's criterion-4 score of 1 is a live defect, not a design flaw.** A hook
firing on a work cycle today is invisible: `--include-hook-events` appears
nowhere in `src/`, and even shipping it leaves a `PostToolUse` injection
unlogged because the hook-injection block's test names only `SessionStart` and
`UserPromptSubmit`. That is two repairs, and they are owed whether or not the
gate is ever built.

**G and J score 0 on authorship, and they are the only two that do.** Both close
constraint 7's loop — a model writes what a later agent reads. J does it in the
mounted tree, where `land.ts` has nothing to strip it with; G does it in a table
this app owns, which is the better half of a bad idea.

**I's zero on criterion 2 is the strongest single refusal in the survey.** On
the day `SEARCH_TOOLS` landed — `bd25c86`, 2026-08-19 — this install made 47
voluntary `Grep`/`Glob` calls, and **zero across the 1,093 tool calls of
2026-08-20 and 2026-08-21**. A new voluntary surface has to explain why it
would be called when the free one already granted is not.

**H's collapse is arithmetic, not taste.** Of the 120 lands on this repository
in the window, 20 produced a HEAD any later run actually started on: 100 of 120
briefs would be written, billed and never opened. Its read side is healthier
than the raw commit rate suggests — 155 of 200 runs start on a base sha some
other run also started on — which is worth carrying into any future version.

## Three options are one act taken in three places

C, E and F(b) all put a per-repository sentence into the first user message. They
differ only in **who writes it**: the app from run history (C), the operator by
hand (E), the app from adjudicated conflicts (F). E's own file measures that
moving the operator's text from the mount's CLAUDE.md into `DATA_DIR` changes
neither its position nor its content, and therefore cannot change compliance —
so E is not a third option so much as a relocation, justified only by the
authorship property in constraint 7.

**Ship one delivery slot, not three.** Whichever of C/E/F(b) goes first owns
`nextPrompt`'s session-less join, and the others become entries in it.

## Two shapes the survey does not contain, and why

**A lesson that says "stop doing X".** Every mechanism here adds text; none
removes an affordance, narrows a path or records that a previous approach was
tried and failed. `10-option-retrospective.md` raises it and nothing implements
it, because the only enforcement surfaces this app has are `--allowedTools`,
`--disallowedTools` and the sandbox, and all three are policy the operator sets
rather than knowledge a run accumulates. Turning a lesson into a denial is a
different proposal.

**Retirement.** Nothing here says how a lesson is retracted once it is wrong,
who presses it, or what the operator sees when the app is telling every run
something false. A store with no retirement is a store that decays into a
liability, which is one more reason the recommendation prefers derived readings
over written ones: a query over `run_events` cannot go stale, because it is
recomputed every time it is asked.
