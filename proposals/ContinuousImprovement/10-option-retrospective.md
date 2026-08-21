# Option G — the retrospective

A fourth `AssistKind`. When a run settles, a one-shot `claude` child reads what
happened, writes what the next run on this repository should know, and the
sentences land in a `run_lessons` table that some other option's delivery
channel reads back.

This is the design anybody asks for first, and it is the one this survey has to
refuse properly rather than wave away, because three of its four premises are
correct: the module it would live in already exists and is the right shape, the
spend already has a column that keeps it out of `runs.spent_usd`, and it is the
only option here that produces a lesson in **words** rather than a file list.
The refusal turns on the fourth premise, and on one line of code that would
inherit a ten-minute clock with no typecheck error.

## The strongest case

**It is the only option in this survey whose output is a sentence, and a
sentence is the only form some lessons have.** Every other mechanism here
delivers a *pointer* — a file, a ranking, a path list — and `00-problem.md`
bounds what a pointer is worth: 50.6% of the repeat reading is a file the run
then edits, which no pointer displaces, so the addressable share is at most
36.1% of all reading. *The `iteration` event already carries the prompt, so do
not add a column for it* is not a path, and cannot be delivered by anything that
only knows which files were opened.

**And the machine-checked corpus is far larger than the ending distribution
suggests.** `00-problem.md` counts one `needs-review` and one non-zero
`exit_code` in 294 runs, which reads as an empty corpus. That is the *endings*.
Counting every run carrying at least one signal a machine established without
asking a model to introspect:

```sql
SELECT COUNT(*) FROM runs r
 WHERE (r.exit_code IS NOT NULL AND r.exit_code<>0)
    OR (r.needs_review_reason IS NOT NULL AND r.needs_review_reason<>'')
    OR EXISTS (SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.kind='tool_error')
    OR EXISTS (SELECT 1 FROM run_reviews rr WHERE rr.run_id=r.id AND rr.kind='resolve');
-- 126
```

**126 of 294 runs, 42.9%** — 70 carrying one of 538 `tool_error` rows, 58
carrying a merge-conflict resolution. That is a corpus. A retrospective gated on
it fires on fewer than half the fleet and never asks a run how it felt about its
own work.

**That gating is also what answers the external-verifier objection.**
`proposals/ExternalValidator/`'s spike found that handing a validator the run's
own final turn — testimony, in its words — changed **zero of eight verdicts**
(`proposals/ExternalValidator/README.md:29`,
`proposals/ExternalValidator/external-validator.md:535`): a model's account of
its own work bought nothing. But that is about *introspection*, and a
retrospective shown `bwrap: No permissions to create new namespace`, an exit
code, or a conflict in `CLAUDE.md` is reading an artefact the app recorded — the
posture `buildPrompt` (`src/lib/review.ts:518`) already takes when it hands a
reviewer a diff and the task text and withholds the event log. So the strongest
form of this option is: **retrospect only on machine-established failures, never
on the run's self-report**, and in that form the objection does not reach it.

**And the plumbing is nearly free.** `startAssist` (`src/lib/review.ts:309`)
inserts the row and spawns without awaiting, `finish` (`:841`) writes `cost_usd`
back, `settleOnExit` handles the exited-but-not-closed grandchild,
`reconcileReviewsOnBoot` (`:170`) fails out what a restart stranded, and
`assistRunning` (`:152`) is keyed on `(run_id, kind)`, so a third kind gets its
own one-at-a-time latch for free.

## Shape

`export type AssistKind = "review" | "resolve"` (`src/lib/review.ts:51`) becomes
`"review" | "resolve" | "retro"`, reusing that module's whole lifecycle — one
child, one JSON result, one row — which is what puts the spend in
`run_reviews.cost_usd` and keeps it out of `runs.spent_usd` by construction,
exactly as the module docblock says (`:40`–`:45`).

The child runs `--permission-mode plan` like a review, gets `SEARCH_TOOLS` and
nothing else on `--allowedTools` (`:641`), inherits `reviewEnv()`'s four
exclusions including telemetry (`:760`), and is spawned as an argv array with no
shell (`:660`) — constraint 11 satisfied without new work. Its `cwd` is
`reviewCwd(run)` (`:498`), which falls back to `repo_root` then `folder`, and
that fallback is constraint 10's answer: a run with `isolation: "none"` still
has a folder to read.

The store is one more `CREATE TABLE IF NOT EXISTS` inside `migrate()`'s single
`db.exec` block (`src/lib/db.ts:136`–`:688`), beside `run_reviews` at `:212`:

| column | why |
|---|---|
| `id`, `run_id`, `created_at` | the row's identity and the run it came from |
| `repo_root` | copied from `runs.repo_root`; `run_reviews` has no repository key and its only index is `(run_id, created_at DESC)` (`src/lib/db.ts:643`–`:644`) |
| `text` | the lesson |
| `evidence` | the machine-checked fact that triggered it, so the row can be audited |
| `retired_at`, `retired_by` | see below; nothing in any other option has these |

`repo_root` is denormalised for constraint 9's reason: the read side has to be a
synchronous `better-sqlite3` query if it is ever to sit near `createRun`, and a
join through `runs` is the shape that invites an `await`.

**And there the shape stops, because option G has no read side.** Nothing in it
puts a sentence into a run. It must borrow option C's or option E's
delivery channel (`06-option-prior-read-pointer.md`,
`08-option-operator-note.md`), inherits every cost and hazard that channel
carries, and cannot be scored independently of one.

## What it learns from, and when the decision is taken

From artefacts, **once, after the run has settled** — never inside the cycle
loop, never before a spawn, never on a guard check path.

| source | volume on this install | what it is |
|---|---|---|
| `run_events` kind `tool_error` | 538 rows, 70 runs | mostly one environment fault |
| `run_reviews` kind `resolve` | 67 rows, 58 runs, $238.20 | real cross-run collisions, with a file list, durable |
| `runs.exit_code <> 0` | 1 | — |
| `runs.needs_review_reason` | 1 | — |
| the branch diff | every isolated run | what `buildPrompt` already sends a reviewer |

`00-problem.md` establishes what the first row is made of: 380 of the 538 rows
belong to a signature recurring across two or more runs, and the largest family,
214 rows, is `bwrap: No permissions to create new namespace` — the harness
failing on commands as ordinary as `echo hello; pwd`. **The codebase's answer to
that was not a lesson.** It was a needle in `MARKERS` (`src/lib/sandbox.ts:112`)
and a pure classifier, `sandboxRefusal()` (`:142`), whose job is to make the log
*say* what happened; the measurement that justified it sits four lines above the
needle (`:108`–`:110`). The largest repeated cross-run mistake this install has
ever made was answered by seeing it, not by remembering it.

**And it cannot see the reasoning, only the actions.** `handleStreamLine` drops
every assistant block that is not `text` or `tool_use`, naming the one it means:
"Everything else — `thinking` above all — is deliberately dropped"
(`src/lib/orchestrator.ts:6042`). The CLI's `thinking_tokens` system events are
dropped by name too (`:6168`–`:6185`). Nothing in `src/lib/` reads reasoning back
out of the transcript either — `grep -n "thinking" src/lib/transcripts.ts`
returns nothing, and that module parses `message.usage`, not `message.content`.
A retrospective therefore sees what was done and what failed, never why either
was chosen, and for a lesson about *how to work in this repository* that is the
half that matters.

**Negative knowledge is the shape that would matter most, and nobody in this
survey proposes it.** Every option here, this one in its natural form included,
produces *start doing X* — read this file, look here first. The lesson with the
highest value per token is the opposite: *stop doing X.* Do not add a column for
the prompt; do not put an `await` in `createRun`. A prohibition removes a branch
of the search rather than adding a candidate to it, and it is short.

What that would take is uncosted by anyone. A prohibition that is merely prose
competes with `CLAUDE.md`, which already carries a page of them in the
highest-authority position available and is declined roughly nine times in ten
(`00-problem.md`). A prohibition that *works* has to be machine-checkable at the
moment of the act, and this codebase has exactly one worked example:
`sandboxRefusal()` is a "stop doing X" compiled into a classifier and a log line,
unit-tested, with no model in the loop. **The highest-value lesson shape is the
one that stops being a lesson and becomes code** — and no retrospective can
perform that conversion. A person did, in one commit, after seeing 214 rows.

## What it does to the prefix cache

**Nothing on the write side, and that is a real advantage.** The retro child is
a separate one-shot invocation with its own conversation: no work cycle's argv,
nothing added to any prompt, and — for constraint 4 — no file written into the
repository, so it triggers none of the `gitStatus` invalidation priced there,
where no handover whose previous cycle changed nothing in the repository ever
re-wrote, 0 of 74. It pays no standing tool-definition rent either, which
constraint 12 prices at $8.14–$8.26 per definition per week; a retrospective is
a child, not a capability. On the read side `D` and `T*` are undefined, and
saying so is not a dodge — they belong to whichever channel it borrows. Option
G's cache arithmetic is the borrowed option's, plus zero: the best cache
position of any writing option here, and another statement of why it cannot be
scored alone.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: untouched.** The retro child spawns `-p <prompt> --output-format
json` (`src/lib/review.ts:616`–`:622`) with no session id, exactly as a review
does, so nothing about `adoptSession` or the run's stored `session_id` changes.

**DONE and `needs-review`: untouched, and this is where the "after it settles"
timing earns its keep.** `nextPrompt`, `COMPLETION_NOTICE` and
`NEEDS_REVIEW_NOTICE` are unchanged and `cycleEnding` still matches only a
cycle's own final text, so no text the retro generates can reach the sentinel
matcher of the run it is about. Constraint 1's summariser hazard reappears only
through the delivery channel: a lesson containing the word `DONE`, injected into
a *later* run's prompt, is that option's problem.

**Retention: it inherits `run_reviews`' answer, which is "never".**
`src/lib/retention.ts:29`–`:32` says it in as many words — "Nothing here deletes
a `runs` row, a review, a workflow record or a setting" — so `run_lessons` adds
no fourth arm to `StorageReport` (`:677`) and constraint 8 is satisfied cheaply.
The *input* side does expire: `sweepRunEvents` deletes settled runs' payloads
past `eventRetentionDays`, default 30 (`src/lib/retention.ts:137`,
`src/lib/settings.ts:631`), so `tool_error` is a rolling thirty-day window.
Firing on settle beats the sweep, and resolutions never expire at all.

## Guards, the three cost sources, and who may author it

**The cost source is right, and this is the option's cleanest property.** Spend
lands in `run_reviews.cost_usd` via `finish` (`src/lib/review.ts:841`, the UPDATE
at `:850`–`:851`), never in `runs.spent_usd`, and `reviewEnv()` (`:760`)
withholds telemetry routing so OTLP records stay keyed to work cycles —
constraint 5 satisfied by reuse rather than by care. The process budget is right
too: `liveAssistChildren()` (`:375`) counts `run_reviews WHERE status='running'`,
so a retro takes a slot against `maxConcurrentAssists` automatically and
`assistBudgetRefusal` (`:402`) refuses it in the same words a review gets.

**But the money guards are wrong for anything automatic, and this is verified
rather than feared.** `installSpend()` (`src/lib/installBudget.ts:55`–`:105`)
sums `runs.spent_usd`, `workflow_instance_blocks.cost_usd` and
`chat_sessions.cost_usd`, and does **not** read `run_reviews`; `review.ts` never
calls `installBudgetRefusal()` — `grep -n "installBudget" src/lib/review.ts`
returns nothing — where `chat.ts:1492` and `workflows.ts:4801` each add it at
their own door. An assist's spend is therefore invisible to
`installDailyCostLimitUSD` and is not refused by it. Today that is 68 rows and
$240.03 over eleven days, every one started by a person pressing a button;
automatic and per-run it would be the largest un-ceilinged spender in the app.
Nor does an assist carry `--max-budget-usd`: the flag reaches the work cycle
(`src/lib/orchestrator.ts:4955`) and the chat turn (`src/lib/chat.ts:1704`), and
`spawnAssist`'s argv (`src/lib/review.ts:616`–`:641`) has no equivalent. The
only ceilings are `windowRefusal()` (`:469`), which fires only when the
configured window is *already* at 1.0, and the clock — which brings us to the
accident.

**Who may author it: the model, and that is constraint 7 answered the wrong
way.** `docs/agent/chat.md`'s gate is that prompt text is the one half of a run a
model may write. A retrospective written by a model and read by a later run
closes that loop directly, with no human between. The store sits in `DATA_DIR`
rather than the `~/.claude` bind mount, which is the better of the two answers
constraint 7 offers, but it does not change who wrote the sentence.

## What the operator sees, and how they override it

Today almost nothing, and one thing actively wrong.

**A `retro` row would render on the run log as a review.** `describeEvent`'s
`review` case reads `const label = p.assist === "resolve" ? "resolve" : "review"`
(`src/lib/logLine.ts:480`), so a third `assist` value falls into the `else` and
is labelled `review`, with the text `started — 0/0 files`. Constraint 6 requires
a mechanism to be visible on the run's own log; this one is visible and
mislabelled, which is worse, and no typecheck catches a comparison against a
string. The run page's review card would not show it at all: `GET
/api/runs/[id]/review` filters `listReviews(id, "review")`
(`src/app/api/runs/[id]/review/route.ts:17`).

**And retirement — how a wrong lesson is withdrawn — is proposed by nobody in
this survey, including, until this paragraph, by this file.** Every option
describes how knowledge is created and delivered; none describes how it is
retracted, who presses it, or what an operator sees when they do. That matters
more here than anywhere else, because a lesson in prose is the only artefact
that can be *confidently wrong*: a stale file pointer wastes a read, where a
stale sentence — *`--plugin-dir` survives `--resume`* — misleads every run that
receives it and reads as the agent being stupid.

Retirement would take three things, none free. A row-level `retired_at` with
every read path filtering on it, where forgetting one is silent and the lesson
keeps shipping. A page listing the lessons per repository with the evidence
beside each — the same disclosure constraint 6 already demands for the injected
prompt and this app does not have, since `describeEvent`'s `iteration` case
prints "Work cycle N" and the prompt a cycle was sent is persisted and never
rendered. And a refusal for a lesson whose repository is gone, on
`agentRefusal`'s precedent (`src/lib/agents.ts:478`): a deleted agent is refused
**by name** at every door rather than dropped to none, because dropping to none
is the failure nobody notices. The second is the whole of it. **A memory nobody
reads is a memory nobody can correct**, and this option's output is the only one
in the survey a person would have to read prose to audit.

## How it fails, and whether loudly

**Silently, in one line, and the source file predicts the accident by name.**
`REVIEW_TIMEOUT_MS`'s docblock (`src/lib/review.ts:55`–`:68`) explains why a
review is bounded at ten minutes and a resolution is not, and closes:

> `assistTimeoutMs` is where that split is made rather than at this constant, so
> a third kind cannot inherit a clock by accident.

The function it points at is:

```ts
const assistTimeoutMs = (kind: AssistKind): number =>
  kind === "resolve" ? 0 : REVIEW_TIMEOUT_MS;
```

(`src/lib/review.ts:78`–`:79`.) It is a ternary on one member, not an exhaustive
switch. Adding `"retro"` to the union makes it fall through to the `else` and
inherit the review's ten-minute clock, with **no typecheck error** — exactly the
accident the docblock says the split exists to prevent. The docblock and the code
disagree today, and only a third kind reveals it. The risk is not academic: the
one `review` row this install has ever produced took 246,805 ms — 4 minutes 7
seconds, 41% of the clock — over 962,056 tokens (`SELECT finished_at-created_at,
tokens FROM run_reviews WHERE kind='review'`), and a retro reading a 538-row
event log is not a smaller job.

Two further silent failures of the same species: the `logLine` mislabel above,
and a lesson that is simply wrong — a well-formed row, delivered on time, at the
correct cost, into every subsequent run on that repository, until a person reads
a page that does not exist and presses a button that has not been built. The
loud failures are already handled: a child that will not launch lands
`status='failed'` with the error on the row (`src/lib/review.ts:348`–`:353`),
and a restart mid-flight is reconciled at boot (`:170`).

## What it costs to build

The plumbing is small: the union member, an exhaustive `assistTimeoutMs` (worth
doing whether or not this ships), a prompt builder beside `buildPrompt`, a
`CREATE TABLE` in the `db.exec` block, a `logLine` case, a trigger on run settle,
and a read-back page — plus whatever the borrowed delivery channel costs.

**The money is the cost, and it is paid before anything is delivered.** Over the
eleven-day corpus, by `SELECT COUNT(*), ROUND(SUM(spent_usd),2),
ROUND(AVG(spent_usd),2) FROM runs` and its median sibling: 294 runs, $4,303.70,
mean **$14.64**, median **$11.86**. ($4,236.62, the figure earlier drafts
quoted, is the `completed` subtotal rather than the corpus total —
`18-validation.md`.) The two rates a retrospective could
plausibly cost are the two this install has actually paid for an assist: $1.82
for the single `review` row, n=1, and $4.04 mean over 59 completed resolutions.

| firing rule | invocations | at $1.82 | at $4.04 | share of $4,303.70 |
|---|---|---|---|---|
| every run | 294 | $535.08 | $1,187.76 | **12.4% – 27.6%** |
| only the 126 with a machine-checked signal | 126 | $229.32 | $509.04 | **5.3% – 11.8%** |

Per run that is **15.3% to 34.1% of the median run's spend**, paid on every run
that fires, before a single lesson has reached a single run.

**Constraint 13's question — what it costs when it *works* — has the worse
answer.** A good lesson is a sentence carried in every later run's context on
that repository, written once at the 1h rate and read at 0.1× thereafter, which
is cheap. What is not cheap is the success case where the lesson turns out to be
a pointer after all: constraint 13 prices a gate that fires and is obeyed at
`docs/agent/conventions.md`'s 63,394 bytes, and a lesson that is *not enough*
leaves the conversation carrying the lesson, the pointer and the file.

## What would have to be true

Option G is refused here. Four things would have to hold for that refusal to be
wrong, and the first two are measurable for single-digit dollars.

**One: a delivery channel has to exist and be shown to work first.** Option G
produces rows and nothing else. Every dollar it could claim runs through `d`, the
displacement fraction `00-problem.md` states does not exist here — and through a
second unmeasured term, whether a *sentence* is obeyed at all. On that second
term the install has already run the experiment and the result is bad: 112 runs
edited `src/lib/`, eleven read the doc the gate names. Until
`03-experiment-holdout.md` separates position from content, a retrospective pays
12–28% of the bill to write text into the slot currently declined nine times in
ten.

**Two: the corpus has to be about the codebase rather than the container.** It
is 42.9% of runs by count — the honest steelman — but 70.6% of the `tool_error`
rows belong to a cross-run signature and the largest family by far is one
environment fault a classifier answered. The durable, per-repository,
non-expiring half — 58 runs with a merge resolution, naming `CLAUDE.md` 54 times
— is the part worth mining, and the part `13-option-agent-claude-md.md` has to
survive. A retrospective firing only on a conflict resolution, 58 invocations
rather than 294, is a $106–$234 experiment and the only version of this option
worth costing again.

**Three: the guard gaps have to be closed before anything automatic spawns.**
`installSpend()` cannot see `run_reviews`, `review.ts` does not call
`installBudgetRefusal()`, and `spawnAssist` carries no `--max-budget-usd` — all
fine while every assist is a button a person presses, none fine for a child that
fires 294 times unattended. Repairs the app wants anyway, whatever this survey
concludes.

**Four, and this one will not move: the module says no in as many words.**
`src/lib/review.ts:34`–`:35`, the first bullet of the docblock explaining why the
module exists at all:

> Neither is ever automatic. Both cost money, and spend nobody asked for is
> spend nobody authorised — so nothing in the run loop reaches this module.

An automatic retrospective is precisely what that sentence refuses, on grounds —
authorisation, not cost-effectiveness — that no measurement in this survey can
overturn. A *manual* retrospective, a button on a finished run beside "Review",
does not contradict it and would cost $1.82 a press. That version is refused by
nothing here. It is also not a mechanism for stopping runs re-deriving what
earlier runs established, because nobody presses it 294 times.

The fact that would overturn this file: a measured `d` above roughly 0.2 for
prose lessons delivered by whichever channel option C or E lands on, taken on the
58-run conflict corpus, with the `assistTimeoutMs` ternary made exhaustive first.
Absent that, this is $535 to $1,188 of certain spend against an uncertain
delivery of a lesson the run cannot see the reasoning behind, into a slot this
install has already measured as ignored.
