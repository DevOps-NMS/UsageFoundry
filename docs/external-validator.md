# An external validator: a second judgement about whether a run did the work

**One-liner:** a cheap, adversarial second reading of a finished run — task text
against branch diff — that says *did the work happen*, *it did not*, or *I cannot
tell*, and does nothing else.
**Appetite:** two weeks, one person · **Status:** draft; the offline spike this
document asks for in M1 has since been run and scored · **Date:** 2026-08-19

Shaped against the measurement in [`validator-baseline.md`](validator-baseline.md),
which is on this branch and is the input every number below rests on. Read its §4
and §5 before this. Nothing here is product code and nothing here proposes any.

> **Nothing shipped, and one milestone has run.** No run is validated today:
> `AssistKind` is still `"review" | "resolve"` (`src/lib/review.ts:51`), there is
> no validator on the assist path, and nothing in this document reached the
> product. What *does* exist is an offline harness —
> [`scripts/validator-spike/`](../scripts/validator-spike/), whose reading is
> [`RESULT.md`](../scripts/validator-spike/RESULT.md) — which put a model over
> the labelled set and scored it. Several statements below were written before
> that existed and are marked where the spike overtook them; where this document
> and `RESULT.md` disagree, `RESULT.md` is the measurement.

---

## 1. The answer first

**Build it, but build the smallest possible version, make its wrong answers free,
and do the two-hour change in front of it first.**

Three things the measurement settled, and each of them narrows the bet:

1. **The whole measured defect lives in one stratum, and the app already has the
   column that names it.** Of 32 sampled runs that replied `DONE`, **31 of 31**
   judgeable ones did the work and **none** failed to (it read 29 of 29 before
   `validator-baseline.md` §3's correction, which moved two rows out of
   `unjudgeable` and into `finished` on this same stratum). Of the 8 that ended by
   using up their cycle cap, two of four judgeable ones did not. `reported_done`
   already separates those two populations, and the run detail page already reads
   it: `describeRun` (`runs/[id]/page.tsx:239-256`) returns tone `neutral`,
   headline *"Used all N work cycles"*, detail *"It never reported the task
   complete, so there is probably more to do."* The **runs list** does not —
   `<StatusMark status={r.status} />` (`runs/page.tsx:346`) renders the raw status
   and `FILTERS` (`:86-95`) is keyed on status alone, so both endings are one
   green **Completed** chip and neither can be selected apart from the other.
   **Carrying the split that already exists on the detail page onto the list and
   into the filter is hours of work, has an exact precedent** — the *Needs review*
   segment, added for the stated reason that *"the segment is what makes this
   ending findable"* — **and targets exactly the 29.6% of runs that carry 100% of
   the measured defect.** Do it whether or not the validator is ever built.

2. **A validator that only reads the diff is blind on ~~at least 17.5% of tasks
   and plausibly 52.5%~~ at least 12.5% and plausibly 47.5%**, and no amount of
   model quality moves that: the specification is a GitHub issue body, or a
   deliverable that never enters the repository. That is a ceiling on coverage,
   not a quality target.

   **Both figures came down after `validator-baseline.md` §3 was corrected.** The
   `WF1` case that used to be the second example of this is not one: that string
   is `runs.task`, the workflow node's title, and the prompt those runs received
   carried the specification in full — so a validator reading the composed prompt
   is not blind on them. What is left is one problem rather than two: **a correct
   empty diff**, five of forty. The 47.5% inherits an unre-derived component (14
   runs pointing at a GitHub issue body), noted as such in that document.

3. **~~The one artefact that would close the biggest gap is the run's own
   testimony.~~ Measured since, and it closed nothing.** The reasoning was: five
   sampled runs correctly produced an empty diff and two wrongly produced one,
   and nothing but the run's own final text separates them. The spike tested that
   on all eight empty-diff cases and **zero of eight verdicts changed**
   (`RESULT.md`, *The testimony arm*). What separates them is the **task text**,
   which the validator already gets: every correctly-`unjudgeable` run was told
   in its own prompt not to commit or was asked a question, and both `not-done`
   runs were told to commit and did not. Testimony is still worth *having* —
   given it, the model named it and declined to lean on it (*"only testimony
   claims filing, which isn't evidence"*), which is evidence about the prompt —
   but it is not the thing that closes the gap. This document still uses
   **external** to mean *not the author, adversarially prompted, judged against
   the task text* — not *evidence-independent*, which it cannot be.

So the shape recommended here is: **an assist, not a run; fired after the run has
already released everything; three-valued; notify-only.** It writes nothing on
the `runs` table, changes no ending, gates no dependent, and reopens nothing.
Its wrong answers cost a glance. That is the only cost structure under which it
is defensible to ship an LLM judging an LLM *before* its agreement rate is known
— and its agreement rate cannot be known until it has run.

**What would make this not worth building**, stated now: the positive class in
the labelled set is **two runs**. Everything about detection rests on n=2.
Milestone 0 exists to fix that, it is two days, and if it comes back saying the
not-done rate among cycle-cap endings is at or under 5%, **stop there** — the
list change from (1) is the whole answer and this document is spent.

---

## 2. Problem

`cycleEnding(res.finalText)` (`orchestrator.ts:7157`) takes the agent's own last
turn at its word, and `completed` is written both for a `DONE` reply
(`:7201`) and for a run that merely used up `maxIterations` (`:7219`) — which
defaults to 1. Nothing anywhere asks whether the task was done.

In the operator's terms: **you run twenty-five agents overnight, and in the
morning the list is a column of green chips.** Some of those runs did the job.
At least one, on the measured rate, wrote nothing and stopped. The list cannot
tell you which, the filter cannot separate them, and the only way to find out is
to open each run and read a diff — which is the work you started the fleet to
avoid. The cost is not a wrong number on a dashboard; it is **twenty-five
branches you have to audit by hand before you land any of them**, or a landed
branch that never contained the change.

How often, measured: of 213 unattended run sessions over ten days, 63 (29.6%)
ended without `DONE`. Two of the four judgeable ones sampled from that stratum
had not done the work. On the `DONE` stratum, 31 of 31 had (29 of 29 as
originally labelled — see `validator-baseline.md` §3).

What it costs today if nothing changes: the operator either audits everything —
which scales with the fleet, and the fleet is the product — or trusts the green
chip, which is wrong at a rate nobody has measured beyond a sample of four.

---

## 3. What can a validator actually see? (question 1)

**At the moment a run ends, every artefact is present.** All three retention
sweeps are horizon-gated *and* state-gated: events need `ts < cutoff` **and** a
terminal status (`retention.ts:137-141`), a checkout needs `finished_at > cutoff`
to be spared (`:217-232`), transcripts need `mtimeMs < cutoff` (`:538-540`). So
timing is not a constraint on a validator that runs at run end. It is a hard
constraint on a *retrospective* one: the cycle log lasts 30 days
(`eventRetentionDays`), the isolated checkout 7 (`checkoutRetentionDays`), the
transcript 30 (`transcriptRetentionDays`), and 39% of the branches in the sample
no longer exist at all.

| Artefact | Reachable at run end? | Where | What it is worth |
|---|---|---|---|
| **Task text** | yes | `runs.prompt` (`db.ts:145`) | the whole question. Exact. |
| **The run row** | yes | `status`, `stop_reason`, `reported_done`, `iterations`, `spent_usd`, `max_iterations`, `origin` | what the machine says happened |
| **The branch diff** | **only if isolated** | `worktree_base...worktree_branch` via `rangeDiff` (`diff.ts:337-406`) | the only evidence the agent did not author about itself |
| **Uncommitted leftovers** | yes | `RunDiff.uncommitted` | catches "did the work, never committed it" |
| **Cycle log** | yes | `run_events` — `iteration` carries the full prompt, `assistant` the full final text, unclipped (`orchestrator.ts:6648-6653`, `:5911-5918`) | testimony, not evidence |
| **Transcript** | yes, by `session_id` | `~/.claude/projects/<sessionId>.jsonl` | the same testimony, at length |
| **The repository's own test commands** | **no** | — | see below |

**Three of those need the qualifications spelled out, because each one silently
narrows what can be built.**

**The diff is only well-defined for an isolated run.** `runDiff` takes the range
branch only when `isolation === "worktree" && worktree_branch && repo_root`
(`diff.ts:330`); otherwise it falls to `worktreeDiff`, which produces a **file
list and a caveat and no patch bodies at all** (`:471-508`). For a
non-isolated run all five of `repo_root`, `worktree_path`, `worktree_branch`,
`worktree_base`, `worktree_base_branch` are null (`orchestrator.ts:3215-3219`),
the run worked in the operator's own checkout, and whatever is in that tree is
entangled with whatever else is there. **A validator has essentially nothing to
read about a non-isolated run**, and that is a scoping decision, not a
limitation to design around.

**For a continuation, the diff is the chain's and not the run's.** `resolveIsolation`
copies the predecessor's base forward — `base: cont.base` (`orchestrator.ts:1643`),
commented *"The predecessor's, not the probe's"*, and the function header states
that `worktree_base` is *"what `diff.ts`, `review.ts`, `emitHandoff` and the
merge itself measure from"*. That is deliberate and correct for landing. It means
a validator asking "did **this run** do the work" is shown the work of every link
in the chain. 9 of 40 sampled runs were continuations. Per-run commit boundaries
are not recoverable without new machinery, so **a continuation must be judged on
the chain's task or not judged at all** — this document takes the second, and
says so as a non-goal.

**No part of this app has ever run a repository's own test or build command, and
that absence is a decision.** The only two binaries spawned anywhere under
`src/` are `CLAUDE_BIN` and `GIT_BIN`. Git runs with `core.hooksPath=/dev/null`
(`git.ts:96`) and every diff carries `--no-ext-diff --no-textconv` because those
are *"commands git runs, configured by the repository being diffed … rendering
someone's branch is not a reason to run their code"* (`diff.ts:315-324`). The one
place a command may be named is `settings.resolveVerifyTools`, default `[]`,
available to the *conflict resolver* and only on `resolveCheckout`'s reuse
branch — and the reviewer is given none, under a comment that is worth quoting
because it constrains this project directly:

> "Absent means none, deliberately rather than by omission… **The reviewer passes
> nothing here and must keep passing nothing** — it is `--permission-mode plan`
> precisely so that nothing it does can write, and a command granted through this
> field would be the one hole in that." (`review.ts:283-286`)

**So: what can a validator that only sees the diff never decide?**

1. **Whether an empty diff is correct.** Seven sampled runs produced nothing;
   five were right to (triage runs forbidden to commit, a read-only audit, a
   question) and two were not — and those two *are* the entire `not-done` count.
   The artefacts cannot separate them. This is the single most valuable thing a
   validator could decide and the diff alone cannot decide it.
2. **Whether the change works.** Every `finished` label in the measurement means
   *the change asked for is present*, never *the change asked for is correct*.
   Runs 3, 12, 24, 28 and 33 make claims about rendering, layout or a clean-clone
   build that no diff can settle; run 21 states in its own report that it never
   reproduced the symptom it fixed.
3. **Anything about a task whose specification is elsewhere.** 12.5% of the
   sample outright (was 17.5% before `validator-baseline.md` §3's correction);
   47.5% counting the 14 runs judgeable only because the prompt
   writer happened to restate a GitHub issue. **A validator's reach is set by how
   much of the specification the prompt writer inlined, not by the validator.**
4. **Which commits are this run's**, on a chain (above).
5. **Anything at all about a non-isolated run** (above).

**One thing the existing reviewer already answers, and one it refuses.**
`buildPrompt` (`review.ts:518-559`) already assembles task text + `stop_reason` +
branch summary + uncommitted paths + a 60 kB budgeted diff. That is ~80% of a
validator's input, built and tested. What it deliberately excludes is the event
log, for a stated reason: *"The log is the process rather than the outcome… a
reviewer that reads how the agent got there tends to review the journey"*
(`review.ts:511-514`). And `startReview` **refuses an empty diff outright**
(`:205-213`) — so the existing reviewer literally cannot be pointed at the case
that carries the whole measured defect.

Those are the two deliberate widenings this project needs, made narrowly and
argued rather than assumed: **the validator accepts an empty diff**, and **it is
given the last cycle's final assistant text and nothing else from the log** — one
turn, marked in the prompt as the run's own account of itself, not the journey.
The reviewer's question is *is this good work*, where a journey biases the
answer; the validator's is *did the deliverable appear*, and for an empty diff
the run's own account is the only artefact there is.

---

## 4. Where does it attach? (question 2)

| Candidate | Latency | Spend | Crash / guard | Who holds the folder |
|---|---|---|---|---|
| **(a)** a step *inside* the ending path | adds a model turn (≤10 min) to every run end | one assist | run already ended; verdict absent | **the run does** — fatal |
| **(a′)** an assist fired *after* the release | none on the critical path | one assist | verdict absent, nothing else | **nobody** |
| **(b)** a separate validating run | a queue wait plus a whole run | a run: cycles, budget, checkout | inherits every ending, incl. `failed` | it claims one |
| **(c)** a workflow block after the work block | a graph step | a whole run, against the instance budget | can **halt the graph** | it claims one |

**(a) is disqualified by one line.** `releaseDependents()` sits at
`orchestrator.ts:7345` and `promoteQueued()` at `:7350`, both inside `startRun`'s
`finally`, and the comment above the instance-budget call at `:7313-7318` states
the rule: those two are *"synchronous by requirement — the folder claim is only
atomic inside one event-loop turn — and an `await` here would put a full
transcript scan in front of both."* A validator inside that path holds the run's
folder, its checkout slot and one of `maxConcurrentRuns` for up to
`REVIEW_TIMEOUT_MS` (10 minutes, `review.ts:69`), and delays every dependent in
its chain. At twenty-five runs that is a stalled queue for a second opinion.

**(b) is the most expensive option and buys nothing extra.** A validating run
costs a `runs` row, a folder claim, a budget, a place in the FIFO queue and a
concurrency slot — and it re-enters every guard, so a validation can be
`blocked`, `paused`, rate-limited and reopened like real work. The repository has
already taken the opposite position once: a review *"is never automatic, it runs
`--permission-mode plan` so it cannot write, its cost lands in `run_reviews` and
never in `runs.spent_usd`"*. A validator is the same class of thing.

**(c) reaches only workflow runs** — a minority of `runs.origin` values, and the
operator has to draw the block. Worse, a validating block is a run, so its spend
counts against `maxInstanceCostUSD`, which is checked between blocks and calls
`stopInstance` when it trips: **a validation could halt the graph it was
validating.** Tripping a workflow-wide budget on a second opinion is the wrong
failure in the wrong direction.

**Recommendation: (a′).** A third `AssistKind` on the path `review.ts` already
owns, fired from `startRun`'s `finally` **below** `promoteQueued()` — one line
lower than `emitHandoff`, which is the existing precedent for a fire-and-forget
at run end (`:7331-7339`, gated on `finalStatus !== "paused" && isolation ===
"worktree" && worktree_path && iterations > 0`, and not awaited because *"the run
is already in its terminal state"*).

Four consequences of that placement, each of which is why it is the right one:

- **Nobody holds the folder.** `rangeDiff` is a ref operation against
  `repo_root`; it needs no worktree. `reviewCwd` (`review.ts:498-506`) already
  degrades worktree → `repo_root` → `folder`. The run's checkout has already been
  released and its slot is already reusable.
- **The dependents are released first**, so no chain waits on an opinion.
- **A validator that crashes, times out or is refused leaves no trace on the
  run.** `review.ts` writes nothing to the `runs` table on any path — refusal is
  `{ok:false, reason}` with no row at all (`:180-182`), a timeout lands `failed`
  with a sentence (`:736`), a mid-flight restart is closed out by
  `reconcileReviewsOnBoot` (`:170-178`). **"No verdict" must be a first-class
  value in the UI**, distinct from all three real verdicts, never defaulted to
  either of them.
- **It inherits `assistRefusal`** — `maxConcurrentAssists` (default 2) plus
  `windowRefusal`, and `assistRunning`, which already refuses a second live
  assist of the same kind on one run and is exactly the idempotence an automatic
  firing needs.

**Two things about (a′) that are not free and must be designed, not absorbed.**

**`spawnAssist` carries no `--max-budget-usd`.** Work cycles do
(`orchestrator.ts:4882`) and chat turns do (`chat.ts:1704`); the assist path does
not — its only money guard is `windowRefusal`. An operator-triggered review with
no ceiling is tolerable. **An automatic one is not.** The validator must carry
the flag, off a new `validationBudgetUSD`, and it should ship with a number on
`chatTurnBudgetUSD`'s precedent (which is `2`): the thing being bounded is this
app's own behaviour, not an allowance Anthropic publishes nowhere.

**`run_reviews.cost_usd` is invisible to the install-wide ceiling.**
`installSpend` (`installBudget.ts:55-103`) reads `runs`,
`workflow_instance_blocks.cost_usd` and `chat_sessions.cost_usd` — and nothing
else. Reviews sit outside it, which is defensible while a person presses a button
per review. **The day something fires per finished run, `installDailyCostLimitUSD`
stops meaning what it says**, and on a 20-block workflow it is 20 validations no
instance budget bounds either. Widening `installSpend` to read
`run_reviews.cost_usd` is therefore part of this project, not a follow-up — and
it is a decision about the fourth reading, so it belongs in
`budgets-and-guards.md` when it happens.

---

## 5. What is a verdict? (question 3)

**A row, a value, and a card. Not a status, and not a column on `runs`.**

Recommended shape — a third `kind` on the table that already exists:

- `run_reviews.kind` gains `'validate'` beside `'review'` and `'resolve'`
  (`review.ts:51`; the column itself arrived by `addColumn` at `db.ts:815`).
  This inherits `assistRunning`, `listReviews`, `liveAssistChildren`, the boot
  reconciler, the `ON DELETE CASCADE` and retention, all of which would otherwise
  be duplicated by a new table.
- One new nullable column carries the value: `verdict TEXT` — `'did-the-work'`,
  `'did-not'`, `'cannot-tell'`. `text` carries the prose, as it already does.
- Two more record **what was judged**: the base and head sha, on
  `resolved_commit`'s precedent. A verdict outlives the checkout by 23 days and
  the branch possibly for ever; one that cannot name the commits it read is not
  re-checkable.
- **Nothing is written to `runs`.** Not a status, not a column, not
  `stop_reason`.

**What it must not do, and why each of these is load-bearing.**

The ending ladder's rungs are five different claims about *who decided*: an
interrupt (a person, or a rule they configured), a CLI ceiling, a provider
refusal, a non-zero exit (the machine), and `needs-review` (the agent, about the
task). `run-lifecycle.md` states the placement rule outright: everything above
`needs-review` *"is a statement about the machine"*, and filing one as the other
*"would be a lie about who decided"*. **A validator's opinion is a sixth voice
and must be rendered as one.**

- **It must not write `needs-review`.** That word means *the agent judged it could
  not finish*. A validator writing it puts words in the agent's mouth, and it is
  not cosmetic: `TERMINAL_STATUSES` carries that value into five subsystems at
  once, `planLoopPass` would stop a loop on it, `edgeSatisfied` would block every
  `on-success` dependent, and retention would begin ageing evidence on the
  strength of a machine opinion. This is the sharpest prohibition in this
  document.
- **It must not introduce a new run status.** `needs-review` cost a 200-line
  call-site inventory across `RunStatus`, `RunDTO`, `TERMINAL_STATUSES`,
  `admitDependencies`, `branchChain`, `planLoopPass`, seven client sites and two
  hard-coded terminal lists. Paying that again for an opinion that is wrong in
  both directions is not a trade worth making.
- **It must not overwrite `reported_done`.** That column means one thing — the
  agent replied `DONE` — and it is the sole input to `reopenPrompt`'s pushback
  branch.

**And it does nothing to `on-success`.** `edgeSatisfied` is `dep.status ===
"completed"` and deliberately **not** `completed && reported_done`, for the
reason its own docblock gives (`orchestrator.ts:3485-3517`): `maxIterations`
defaults to 1, so keying success on the `DONE` reply would mean *"a dependent
almost never starts"*. Success there is *the absence of a fault*. If the agent's
own claim to have finished is not strong enough to gate that edge, **a machine's
opinion about the agent's claim certainly is not** — and a false negative gating
an edge costs the rest of the graph, not one run. The verdict changes nothing
about `edgeSatisfied`, `releasableRuns`, `TERMINAL_STATUSES` or any edge
condition. Making it gate an edge would be a new edge kind (`on-validated`),
which is a different project and is a non-goal here.

**Where it shows.** A card on the run page, below the state card, in a third
voice: `stop_reason` is the machine's account, `needs_review_reason` is the
agent's about the task, and the verdict is a reader's about the diff. Tone
**neutral**, never `ok` and never `danger` — this is an opinion, and a red chip
would read as a fault that did not happen. One filter segment on the runs list,
on the *Needs review* segment's precedent. Nothing else.

---

## 6. What happens on a negative verdict? (question 4)

| Option | Failure mode |
|---|---|
| **Reopen the run** | one billed cycle per false negative, systematically, at fleet scale — and it puts an agent that accepts edits back to work unattended on the strength of a machine opinion. `needs-review` decision 7 forbids exactly this for the *bulk pick-up*, where a person at least pressed a button. |
| **Move it to `needs-review`** | overwrites the ladder's statement about who decided, and silently reaches five subsystems (§5). |
| **Block the dependent** | converts an opinion into a chain-stopper; a false negative costs the rest of the graph. Contradicts `on-success`'s stated design. |
| **Notify only** | **nobody reads it** — which is precisely today's failure, wearing a new hat. |

**Default: notify only, and treat "findable" as part of the deliverable rather
than as a nice-to-have.** The failure mode of notify-only is real and the whole
mitigation is the one the *Needs review* ending already used: a filter segment,
because *"the segment is what makes this ending findable"*. Add a count where the
operator already looks — the runs list header — and stop there.

The reason it is the default is question 5's answer: notify-only is the only
option whose wrong answers are free, and this design has to ship before its error
rate is known. Every other option converts an unmeasured false-negative rate into
money or into blocked work. **When the false-alarm rate is measured and low, the
stronger actions become available; not before.** Kill criteria in §12 name the
numbers.

---

## 7. The validator's own failure modes (question 5)

It is an LLM judging an LLM. It is wrong in both directions, and the two errors
are not the same size.

**A false "not finished"** — a run that did the work, judged not done. Under
notify-only it costs an operator's glance. Under any design that reopens, it
costs a real billed cycle, per occurrence, across the fleet. And it costs
something notify-only does not protect against either: **credibility**. A
validator that cries wolf on one run in six is ignored within a week, at which
point it is pure spend with a card nobody reads.

**A false "finished"** — a run that did nothing, judged done. It costs **exactly
what we have today**: a green chip on a run that did not do the job. It is not a
new harm; it is an unimproved one.

**Which error should the design prefer?** Under notify-only: **prefer the false
"not finished".** Be suspicious. Being wrong is a glance, being silent is the
status quo, and the asymmetry is the entire reason notify-only is the default.

**And state the coupling, because it is the rule that keeps this safe as it
grows:** the tolerance and the consequence move together. **Any future change
that attaches an action to a negative verdict must re-tune the prompt's bias in
the same commit**, because the moment a verdict costs a cycle or blocks a chain,
the cheaper error flips to the false "finished". A design that gets suspicious
*and* actionable in two separate commits is one that spends money on false
alarms with nobody having decided to.

**The third verdict is not a hedge, it is a requirement.** `unjudgeable` is
≥12.5%, so a two-valued validator manufactures opinions on the runs where there
is nothing to be right about — which are exactly the ones it will get wrong. So
`cannot-tell` is a real verdict, and the prompt makes it the cheap and
respectable answer for the three shapes the measurement names. Coverage then
becomes a guardrail in the other direction, because a validator that shrugs at
everything costs money to say nothing; §8 bounds it from both sides.

---

## 8. Success criteria (question 6)

Baselines are the labelled set in `validator-baseline.md` §3–§4 — **n=40: 33
`finished`, 2 `not-done`, 5 `unjudgeable`** after that document's §3 correction to
rows 8 and 36; it read `31 / 2 / 7` when the table below was written, and the two
rows moved from `unjudgeable` to `finished`. Expanded by milestone 0.

| Metric | Baseline today | Target | How it is measured | Checked when |
|---|---|---|---|---|
| **Detection.** Share of human-labelled `not-done` runs the validator calls `did-not` | 0 of 2 (nothing exists) | ≥ 80% of the expanded label set | offline harness over the labelled set | end of M1 |
| **False alarm.** Share of human-labelled `finished` runs called `did-not` | n/a | ≤ 6% (≤ 2 of 33 on the current set) | same harness | end of M1 |
| **Honesty about the ceiling.** Share of the 5 known-`unjudgeable` runs called `cannot-tell` | n/a | ≥ 4 of 5 | same harness | end of M1 |
| **Coverage (guardrail).** Share of validated runs answered `cannot-tell` | ceiling is 12.5%; floor unknown | ≤ 35% on the cycle-cap stratum | count over `run_reviews` where `kind='validate'` | 2 weeks after M2 |
| **Cost (guardrail).** Median validation `cost_usd` ÷ that run's `spent_usd` | unknown — the measurement could not recover `spent_usd` | ≤ 10%, and every validation hard-capped by `--max-budget-usd` | one SQL join | 2 weeks after M2 |
| **No ending changed (guardrail).** Runs whose `status`, `stop_reason`, `reported_done` or `needs_review_reason` differ because a validator ran | 0 | **exactly 0** | the validator writes no `runs` column — a test pins it, plus a read of the diff | end of M1 |
| **No dependent delayed (guardrail).** Delta between a run's `finished_at` and its dependents' admission | 0 | **exactly 0** | structural — the call site sits below `promoteQueued()`; a read of the diff, plus one timing test | end of M2 |
| **Somebody acts on it.** Negative verdicts followed within 7 days by a reopen, a land, a delete or a set-aside on that run | n/a | ≥ 50% | join `run_reviews` against `runs.reopened_at` / `set_aside_at` / `landed_at` | 1 month after M2 |

**Two honest caveats.** The positive class is currently **two
runs**, so "80% detection" against today's set is one number about two examples;
milestone 0 exists to make it mean something, and the criterion is not checkable
until it lands. And the trivial validator — always answer `did-the-work` — scores
77.5% overall agreement on the current set while detecting nothing, which is why
agreement is deliberately **not** a criterion here and detection, false alarm and
`cannot-tell` honesty are three separate rows.

**Three of these rows now have a reading, from the offline spike rather than from
M1.** [`scripts/validator-spike/RESULT.md`](../scripts/validator-spike/RESULT.md)
scored the current labelled set, not the expanded one, so nothing below is a
criterion met — but the *Baseline today* column is no longer "nothing exists".
False alarm: 0 of 29 held-out, 1 of 30 all-in, against a ≤ 6% target. Cost:
median $0.125 per verdict measured on an upper-bound transport, against runs
costing dollars. **Detection is the one that still rests on n = 2** — both
`not-done` rows were called `not-finished`, and one of them is held out, so the
held-out detection figure is one example. That is exactly the caveat above,
unmoved.

*Honesty about the ceiling* needs one more sentence, because the row above and
the spike count it against **different label sets**. `RESULT.md` reports **5 of
7** against the labels as the measurement run wrote them, and deliberately did
not rescore. Against the corrected labels the same five are the whole set — the
two it "missed", rows 8 and 36, are the two `validator-baseline.md` §3 has since
retracted — so it is **5 of 5**. The row's target was rewritten as ≥ 4 of 5 to
keep the ≈71% the original ≥ 5 of 7 expressed; that is a re-scaling, not a
re-measurement, and M0's expanded set is what should set it properly.

---

## 9. Goals and non-goals

**Goals.** An operator reading a list of twenty-five finished runs can see which
ones a second reader doubts, and can filter to them. The doubt is cheap, bounded
and recorded. Nothing about how the run ended, what it spent, or what starts next
changes because a validator ran.

**Non-goals**, each with its reason:

- **Any automatic action on a negative verdict** — reopening, restatusing,
  blocking a dependent. §6; and the false-negative rate is unmeasured until M1.
- **A new run status, and any change to `TERMINAL_STATUSES`, `edgeSatisfied`,
  `releasableRuns` or an edge condition.** §5. An `on-validated` edge is a
  separate project.
- **Running the repository's test or build suite.** This app has never executed a
  repository's own commands and the reviewer is deliberately given no command at
  all (§3). Doing it needs a checkout, a slot, minutes-to-an-hour of wall clock
  and an answer to "is this failure the change or the environment" — that is a
  project, not a milestone, and it is M3 at the earliest.
- **Validating non-isolated runs.** There is no well-defined diff (§3).
- **Validating continuations per-link.** `worktree_base` is the chain's by
  design; per-run commit boundaries do not exist. Judge the chain or skip it.
- **Retrospective validation of historical runs.** 39% of branches are gone and
  checkouts age out at 7 days.
- **Replacing the operator's own review.** The existing on-demand reviewer
  answers *is this good work*; this answers *did the work happen*. Two questions,
  two prompts, two rows.
- **Writing the validator's prompt, or designing the card in detail.** A later
  run's job, per the brief.

---

## 10. Milestones

**M0 — Measure the stratum that carries the defect** *(~2 days, 15%)*
Expand the labelled set on the population the measurement under-sampled: 8 of 63
cycle-cap-ending runs were labelled. Take ~40, same stratified-systematic method,
same judging rule, and record the labels in a machine-readable file beside the
prose so M1's harness can score against it.
*Acceptance:* Given the 63 no-`DONE` unattended run sessions, when ~40 are
labelled by the measurement's own rule, then the file records a `not-done` rate
with a denominator above 20 and the `unjudgeable` share is stated beside it.
**Worth shipping alone:** yes — it is a number the operator does not have, about
the third of the fleet that carries every known failure. **It is also the gate:**
≤5% `not-done` there and the project stops.

**M1 — Walking skeleton: one verdict, end to end, from a script** *(~40%)*
The thinnest path that touches every layer: `kind='validate'` on `run_reviews`, a
`verdict` column and the two judged shas, a prompt composed from task text +
branch diff + the run row's own facts + the last cycle's final text marked as
testimony — **and see decision 2: the spike measured that last term buying zero
verdict changes, so M1 should compose it both ways and score the difference
rather than assume it** — `--permission-mode plan`, `--max-budget-usd` off a new setting, a
three-valued verdict parsed and written. No UI, no automatic firing — invoked by
a script against a finished run id. Ugly and hardcoded is fine.
*Acceptance:* Given a finished isolated run, when the script is run against its
id, then one `run_reviews` row exists with `kind='validate'`, one of three
verdicts, prose, a cost and the two shas; the `runs` row is byte-identical; and
the same script run over the M0 label set produces the four numbers in §8's first
three rows.
**Worth shipping alone:** yes — it *is* the offline scorer, and its numbers
decide whether M2 is ever built.

**M2 — Automatic, and the operator can see it** *(~30%)*
Fired from `startRun`'s `finally` below `promoteQueued()`, gated the way
`emitHandoff` is, behind an off-by-default setting, bounded by
`maxConcurrentAssists` and refused rather than queued when over. `installSpend`
widened to read `run_reviews.cost_usd`. A run-page card in the third voice, a
filter segment, and a distinct rendering for **no verdict**.
*Acceptance:* Given validation is on and a run finishes on a branch, when the
loop unwinds, then its dependents were released before any child was spawned, a
verdict lands within `REVIEW_TIMEOUT_MS`, a validator that is refused or crashes
leaves the run's row and page unchanged, and the install-wide daily ceiling
counts what the validation spent.

**M3 — Only if M1's numbers earned it: give it the suite** *(~15%)*
A checkout and a `resolveVerifyTools`-shaped list of named commands, so a verdict
can say *and it builds*. Last, because this is where the cost, the wall clock and
the folder claim all live, and because it is the one part that reverses §4's
"nobody holds the folder".

Ordered by risk retired per hour: M0 retires "is there a defect worth paying
for", M1 retires "can a model actually judge this", M2 retires "does it cost what
we think and does anyone read it", M3 is the expensive upgrade nobody should buy
before the first three answer.

---

## 11. Risks and rabbit holes

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The positive class is n=2; every detection number is noise | **certain today** | the project is unfalsifiable | M0, and it is a gate rather than a task |
| `cannot-tell` becomes the lazy answer and coverage collapses | high | pure spend, no information | the coverage guardrail in §8, scored against the 5 known-unjudgeable runs where the correct answer is known |
| False alarms burn the operator's trust before the rate is measured | medium | the card is ignored; spend continues | notify-only; the ≤6% criterion is a gate on M2 |
| **Prompt injection through the diff** — the diff is written by an agent, and a file could contain text addressed to the validator | medium | a verdict the branch chose | `--permission-mode plan`, the verdict parsed from a structured field rather than from prose, and the honest statement that this is **not closed** — it is the same exposure `review.ts` already carries |
| An automatic spender outside every ceiling | **certain if not designed** | `installDailyCostLimitUSD` silently stops meaning what it says | `--max-budget-usd` on the child *and* widening `installSpend`; both are in M1/M2, not follow-ups |
| A verdict outlives the evidence behind it | certain (7-day checkout, 30-day events) | an unre-checkable opinion | record the judged base and head shas |

**Rabbit holes** — sub-problems that look small and are not:

- **"Just run the tests."** It needs a checkout, a slot, network, and a
  disambiguation between "the change is broken" and "this tree has no
  `node_modules`" — which `resolveVerifyTools`' own default of `[]` exists
  because of, with 19 of 58 conflict resolutions reporting they could not compile
  what they merged. Fenced into M3 on purpose.
- **The empty diff.** Genuinely undecidable from evidence. Deciding it means
  reading the run's own testimony, which weakens the word *external*. Named in §1
  rather than solved.
- **Per-run commit boundaries on a chain.** Looks like "filter the commits by
  time"; the measurement needed 26 commits read one by one to attribute a single
  run's work. Non-goal.
- **A verdict that wants to be a status.** Every reader who meets this will reach
  for one. §5 is the answer and it should be a comment at the call site.
- **`latestAssist` and the run page's review card.** A third `kind` on
  `run_reviews` means every existing reader of that table must be checked for a
  `kind` predicate, or a validation renders where a review is expected. Cheap to
  fix, silent if missed.

---

## 12. Non-functional requirements

- **Security.** `--permission-mode plan`, `--allowedTools Grep Glob` and nothing
  else — the reviewer's exact posture, including **no** command grant. Uid
  dropped via `childCredentials()`; `reviewEnv()`'s strip of `UF_*`, `OTEL_*`,
  `ANTHROPIC_ADMIN_KEY` and `DATA_DIR` applies unchanged. No shell; argv arrays
  only.
- **The validator must not run as an agent child that reads the database.**
  `/data` is root-owned `0700` (commit `01b34b7`, *"Keep the database out of every
  agent's reach"*, re-asserted by `docker-entrypoint.sh:21` and pinned by
  `deployment.test.ts`), so a child cannot read `runs.task` at all. It is handed
  its inputs on the wire the way the reviewer already is. **Taking this the other
  way would undo #80.**
- **Cost.** A per-validation `--max-budget-usd`; the spend recorded in
  `run_reviews.cost_usd` and **never** in `runs.spent_usd`, `buildSnapshot()` or
  any window meter — the three-source rule is unchanged. It *is* added to
  `installSpend`.
- **Observability.** One `run_events` row of kind `review` per validation, as the
  existing assist already emits, so a verdict is on the stream the operator is
  watching.
- **Retention.** Verdict rows cascade with the run and age out with events; the
  judged shas are what makes a survivor readable.
- **Off by default.** It spends money on every finished run.

---

## 13. Definition of done

- M0's label file exists, its `not-done` denominator is above 20, and its
  `unjudgeable` share is stated beside the rate.
- The three offline numbers in §8's first three rows are measured and recorded in
  `docs/verification.md` — including if they fail the target.
- A validation writes no column of `runs`, and a test pins it.
- A refused, crashed or timed-out validation leaves the run's row and page
  exactly as they were, and the UI shows **no verdict** distinctly from all three
  verdicts.
- Dependents are released before any validator child is spawned; the call site
  sits below `promoteQueued()` and carries a comment saying why.
- `installSpend` reads `run_reviews.cost_usd`, and `budgets-and-guards.md` records
  the widening of the fourth reading.
- The runs list has a segment for it and the run page a card in the third voice.
- `docs/agent/run-lifecycle.md` records that a verdict is a sixth voice and
  changes no rung; `docs/agent/dependencies.md` records that `on-success` is
  untouched; `docs/runs.md` describes it in the operator's words.
- `README.md`'s **Not yet verified** list gains, by name: whether a real model
  under the pinned CLI answers `cannot-tell` when it should. And, separately,
  that **no real `claude` has ever been run through the assist path at all** —
  `docs/verification.md:1511-1515` says so today, and this project is the first
  thing to make that path automatic.

---

## 14. Kill criteria

Decided now, while nobody is attached to it:

- **M0 shows ≤5% `not-done` among cycle-cap endings.** Stop. The list-and-filter
  change from §1 is the whole answer.
- **M1's false-alarm rate on human-labelled `finished` runs exceeds 15%.** Stop or
  re-scope: one wolf-cry in six gets the card ignored.
- **M1 answers `cannot-tell` on more than half the cycle-cap stratum.** Stop —
  paying a model to shrug.
- **Median validation cost exceeds 25% of the run it validates.** Stop; at that
  price another work cycle is the better buy.
- **A month after M2, under 10% of negative verdicts are followed by any operator
  action.** Stop and remove it: nobody is reading it, which is the failure it was
  built to fix.

---

## 15. Decisions I need

Five, each answerable with "defaults are fine".

1. **Do the list-and-filter split first, on its own?** — carry the two endings
   `describeRun` already distinguishes onto the runs list and into the filter.
   *Recommended default: **yes**, before M1. It is hours, it has an exact
   precedent, and it costs nothing if the validator is never built.*
2. **Does the validator get the run's own final text?** It is testimony, not
   independent evidence, and it widens a decision `review.ts` took deliberately.
   ~~*Recommended default: **yes**, one turn only, marked as testimony in the
   prompt — it is the only thing that separates a correct empty diff from a wrong
   one, which is the largest gap the measurement found.*~~ **That premise has
   been measured false.** The spike re-ran all eight empty-diff cases with
   `--with-testimony` (`scripts/validator-spike/io-testimony/`,
   `score-report-testimony.md`, commit `5c49a08`) and **zero of eight verdicts
   changed** — six of six identical on the scored subset, case for case. The
   discrimination was never in the testimony; the task text carries it.
   *Recommended default: **measure it in M1 before paying for it.** Not "no":
   n = 8, one stratum, one sample per case, and testimony on a 100 kB patch is
   untested. But it is no longer "yes on reasoning" — the one place the document
   claimed it mattered is the one place it was tried and bought nothing, and
   shipping it means more prompt tokens on every verdict, a testimony field in
   the prompt contract, and a `review.ts` decision reversed for no measured
   change.*
3. **Which runs get validated in M2?** *Recommended default: **only `completed`
   runs that ended without `DONE`, and only isolated ones.** That is ~30% of the
   fleet and carries 100% of the measured defect; widen to all `completed` runs
   only once the false-alarm rate clears §8.*
4. **On by default?** *Recommended default: **off**, an explicit setting. It
   spends money on every finished run, and this app does not ship spenders switched
   on.*
5. **Two weeks, or one?** *Recommended default: **two**, with M3 explicitly
   outside it. If it will not fit, cut the UI, not the offline scoring — the
   scoring is what decides whether any of it should exist.*

---

## What could not be settled by reading

Two of the entries that stood here have since been settled by the spike, and are
kept with what it returned rather than deleted — the original claim is what a
reader who remembers this section will be looking for.

- **~~Whether a model can actually do this job.~~ Measured offline, once.** The
  claim here was that nothing in this repository can measure a validator that does
  not exist. `scripts/validator-spike/` is that measurement: **34 of 37 (91.9%)
  agreement** on the held-out set, 35/40 all-in, against **29 of 37 (78.4%)** for
  a trivial validator that always answers `finished`; **zero false-finished**, 5
  of 7 known-`unjudgeable` rows answered `unjudgeable` (5 of 5 against the
  corrected labels — §8), and 40 of 40 verdicts
  parsed. §8's numbers are still targets — that table is scored against an
  *expanded* label set M0 has not built — but "a model cannot be measured here"
  is no longer true.
- **~~What a validation costs or how long it takes.~~ One measured figure and one
  modelled one.** `RESULT.md` records **median $0.125 per verdict** ($5.27 for
  40) and **median 49.5 s** wall clock (11.9 – 108.0 s). The dollar figure is an
  upper bound: it prices the harness's own subagent transport, which re-sends the
  prompt once per turn and carries its own system prompt and tool schemas.
  `RESULT.md` also models **≈$0.04** for what `validate.mjs --transport api`
  would bill — that one is arithmetic over the median prompt, not a measurement,
  because no API key was reachable. Either way §8's cost guardrail (median
  validation ≤ 10% of the run it validates) clears comfortably against runs that
  cost dollars each. The 10-minute assist timeout is still the only *enforced*
  bound.

What the spike did **not** settle, and what therefore still stands here:

- **Whether a real `claude` under the pinned CLI answers the same way.** The 40
  requests went through the harness's subagent path — same prompt bytes and model
  family, different system prompt and a tool loop around it — not through
  `validate.mjs --transport api` and not through `spawnAssist`.
  `docs/verification.md` still records that **no real `claude` has been run
  through the assist path**; the spawn, the flags and the accounting were
  exercised against a stub.
- **Repeatability.** Every case was judged once, so none of the figures above
  carries a variance.
- **Anything outside the sampled stratum.** The labelled set is 40 `completed`
  runs on isolated branches; non-isolated runs and `failed` / `blocked` /
  `cancelled` ones were not looked at, and testimony was only tried on the eight
  empty-diff cases.
- **Whether any of the work is correct.** Every `finished` verdict means the
  change asked for is present, never that it works.
- **The population shape.** `runs.origin`, `status` and `spent_usd` were
  unavailable to the measurement run (`/data` is masked in the agent sandbox by
  the same invariant that makes it safe), so how many finished runs are isolated,
  how many are continuations, and how many come from a workflow are all
  **unknown**. Every share in this document is a share of the transcript-derived
  sample, not of the install.
