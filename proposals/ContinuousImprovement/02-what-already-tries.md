# What already tries, and how far each gets

Nine mechanisms in the shipped product already carry something from one run to
the next, or already try to stop a run re-deriving what an earlier one
established. None of them was built for this survey's question and none of them
answers it whole, but between them they hold more ground than an option file
reading `00-problem.md` alone would assume — and one of them holds the single
most encouraging measurement in the whole survey.

Every figure below is either taken from `00-problem.md` or measured here against
the same install and the same eleven days, with the query quoted. The corpus is
`00-problem.md`'s 294 runs, of which 288 reached a spawn
(`SELECT COUNT(DISTINCT run_id) FROM run_events WHERE kind='iteration'`) across
500 work cycles.

## The mount's own CLAUDE.md

**It is the only channel that is per-repository, operator-authored, durable and
free, and it is the one that is measurably ignored.** The CLI delivers the
mounted folder's CLAUDE.md into the first user message of every run
(`00-problem.md`); nothing in `buildArgs` composes it, and `grep -rn "CLAUDE\.md"
src/` returns thirteen hits, every one a comment citing *this* repository's copy
as documentation rather than a read of a mount's. So it
costs this app nothing to maintain, survives every run, expires on no horizon,
and is authored by a person rather than by a model — it answers constraints 1,
7 and 8 by not participating in any of them.

What it cannot carry is anything that has to be true of a *particular* run:
there is one file per repository, it is the same text for a research run and a
refactor, and it is written before the run whose lesson would justify editing
it. And the measurement is the one `00-problem.md` closes on: 112 runs edited
`src/lib/`, eleven read the `docs/agent/` doc the gate names. CLAUDE.md is also
already this tree's most contended file by a factor of 3.6 — 54 of the 67
`run_reviews` path lists name it — so it is not a surface with spare capacity.

## `continuedWorkNotice` — and the one compliance figure that went the other way

**This is the app's real answer to "the next agent cannot see what the last one
did", and on this install it is obeyed by every single run that received it.**
`continuedWorkNotice` (`src/lib/orchestrator.ts:4401`) fires on the
`sessionId === null` branch of `nextPrompt` (`:4299`) when a run carries another
run's branch, composed at `:4338` ahead of `priorWorkNotice` at `:4339`. It
names the predecessor by short id, names the branch, and prints two commands
against the chain range — `git log --oneline <base>..HEAD` and
`git diff --stat <base>...HEAD` — before appending `settings.continuedWorkPrompt`
as guidance.

Sixty-six of the 288 spawned runs were sent it. Every one of them ran the exact
`git log --oneline <range>..HEAD` form inside its **first three tool calls**:

```sql
-- `told`: the run's *first* iteration prompt carried the notice.
CREATE TEMP TABLE told AS
WITH it AS (SELECT run_id, MIN(ts) AS ts0 FROM run_events WHERE kind='iteration' GROUP BY run_id)
SELECT e.run_id AS run_id FROM run_events e JOIN it ON it.run_id=e.run_id AND it.ts0=e.ts
WHERE e.kind='iteration' AND json_extract(e.payload,'$.prompt') LIKE '%already carries the work of run%';
-- `toolseq`: every tool call, numbered within its run.
CREATE TEMP TABLE toolseq AS
SELECT run_id, json_extract(payload,'$.input.command') AS cmd,
       ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY ts, id) AS k
FROM run_events WHERE kind='tool';
SELECT COUNT(DISTINCT t.run_id) FROM toolseq t JOIN told x ON x.run_id=t.run_id
WHERE t.k<=3 AND t.cmd LIKE '%git log --oneline%..HEAD%';   -- 66
```

| | told (66) | not told, worktree, with tool events (175) |
|---|---|---|
| ran a `git log` in the first three tool calls | **66 — 100%** | 102 — 58.3% |
| ran a `git log` at any point | 66 — 100% | 159 — 90.9% |
| ran `git diff --stat` at any point | 58 — 87.9% | 103 — 58.9% |
| ran `git diff --stat <base>...HEAD`, the **exact form printed** | 56 — **84.8%** | 7 — **4.0%** |

The last row is the one that carries the argument, and `18-validation.md` had to
correct it twice before it settled: matched with an order-independent matcher it
is a **21×** lift, against 1.1× on running any `git log` at all. The notice does
not make a run examine its branch — untold worktree runs do that 90.9% of the
time anyway. It makes the run examine it *the way the notice said to*.

**Two caveats, and they matter more than the headline.** The base rate is not
zero: a majority of untold worktree runs open with a `git log` anyway, so the
notice's lift at the first-three-calls grain is 58.3% → 100%, not 0 → 100. And
the two instructions are not comparable in what they ask for — the notice asks
for two commands costing a few hundred bytes at the top of a fresh conversation,
where CLAUDE.md's gate asks a mid-task agent to open a 63,394-byte doc
(constraint 13). What separates 100% from 10% here is confounded between
position, specificity and cost, and this file does not separate them;
`03-experiment-holdout.md` is the file that tries.

The `--stat` discipline the docblock argues for (`:4388`–`:4395`: a `git diff`
read at the opening turn is re-sent on every later turn, 176KB against 1.2KB on
five commits of this repo) is honoured as an opener and then overridden by about
a quarter of the runs — the same two temp tables with
`cmd LIKE '%git diff%...HEAD%' AND cmd NOT LIKE '%--stat%' AND cmd NOT LIKE '%--name%'`
return 18 of the 66, which took the full diff over the chain range at some later
point.

What it cannot carry is anything but a pointer at a branch. It transmits no
lesson, no reading order and no fact about the repository; the whole content is
"the commits under you are someone else's, here is how to read them". It reaches
only a run whose `continues_run` is set **and** whose isolation is `worktree`
(`src/lib/orchestrator.ts:6691`–`:6698` composes it), which is 72 runs by
`SELECT COUNT(*) FROM runs WHERE continues_run IS NOT NULL` and 66 by delivery.
On this install it is the mechanism that fired most often, and the only one with
a clean compliance measurement.

## `priorWorkNotice`, which has never fired

**It is the app's stated answer to a run restarting its own task, and in eleven
days across 500 work cycles it has been delivered zero times.**
`priorWorkNotice` (`src/lib/orchestrator.ts:4417`) requires `priorCycles > 0`
*and* `sessionId === null` — a run charged for cycles whose conversation is gone.

```sql
SELECT COUNT(*) FROM run_events WHERE kind='iteration'
  AND json_extract(payload,'$.prompt') LIKE '%A previous attempt at this task already ran%';
-- 0, against 500 iteration events
```

It has been in the tree since `8962e9a`, 2026-08-11 — the second day of the
window, and a commit whose subject is the reason it never fires: *"Keep a run's
session, so picking it up continues instead of restarting"*. A reopened run
resumes, so the branch that needs this notice is reached only when the session
is genuinely lost. That is not a defect; it is a fallback whose primary case was
closed. But it means any option citing "the app already tells a restarted run
what it did before" is citing a code path this install has never taken.

Both notices are **facts rather than instructions**, and that is the property an
option should copy rather than the wording. One states which branch, which
predecessor and which range; the other states how many cycles were charged and
where the work went. Neither competes with the task for authority, because
neither asserts anything the task could contradict — where a remembered
*instruction* ("always run the tests before editing") sits in the same prompt as
a task that may say otherwise, and the agent has to rank the two. Facts dodge
that, and they dodge constraint 1 as well: the sentence naming the branch is
generated in `orchestrator.ts` and only the guidance is a `DEFAULT_*`, the split
`COMPLETION_NOTICE` (`:4466`) and `NEEDS_REVIEW_NOTICE` (`:4506`) also make.

One observation from reading both docblocks: `priorWorkNotice`'s is stranded at
`src/lib/orchestrator.ts:4364`–`:4374`, immediately above `continuedWorkNotice`'s
at `:4375`, so the function at `:4417` carries none — and the same drift exists
one file over, `DEFAULT_ISOLATION_PREAMBLE`'s docblock sitting at
`src/lib/settings.ts:520`–`:524`, 35 lines above the constant at `:559`.

## The four editable prompt keys

**They are the only per-install text surface an operator owns, they are already
delivered on every relevant cycle, and none of them can hold anything a run
learned.** `isolationPreamble` (`src/lib/settings.ts:253`, default `:559`) is
prepended to cycle 1 of a worktree run; `continuedWorkPrompt` (`:267`, default
`:552`) is the guidance half of the notice above; `continuationPrompt` (`:114`,
default `:516`) is what every cycle after the first opens with; and
`donePushbackPrompt` (`:286`, default `:534`) replaces it after a DONE the run is
set to override.

`isolationPreamble` reached 243 of the 288 spawned runs — the same first-prompt
query with `LIKE '%dedicated git worktree%'`, exactly matching the 243
`isolation='worktree'` rows — and its instruction is followed at a rate that is
suggestive rather than clean (`run_events` of kind `tool`, `$.name='Bash'`,
`$.input.command LIKE '%git commit%'`, split on `runs.isolation`):

| | ran `git commit` | of runs with tool events |
|---|---|---|
| worktree runs, told to commit | 186 | 241 — **77.2%** |
| non-worktree runs, told nothing | 10 | 42 — 23.8% |

That gap is heavily confounded — a worktree run's task is more likely to be code
in the first place — so read it as consistent with the preamble working, not as
evidence that it does.

What none of the four can carry is a lesson, for constraint 1's reason stated at
`src/lib/settings.ts:664`–`:666`: a prompt an operator has actually edited is
pinned permanently, with "no versioning and no migration, and nothing anywhere
surfaces the divergence", so anything later written into a `DEFAULT_*` reaches no
install whose operator has touched that key. They are guidance, deliberately, and
an option that proposes to accumulate anything in one is proposing a write side
and a read side with the same author (constraint 7).

## The system-prompt channel, and the one lesson a human already promoted

**`--append-system-prompt` is the only text this app puts on every cycle of every
run, and it already carries one hand-promoted lesson learned from a measured
cross-run failure — which is exactly the loop this survey is asking whether to
automate.** `buildArgs` emits it once at `src/lib/orchestrator.ts:4926`, carrying
`SELF_HOSTING_NOTICE` (`:4739`) and `DELEGATION_NOTICE` (`:4797`) joined into a
single flag, because a second `--append-system-prompt` is a replacement rather
than an addition and losing one would be silent. It is re-sent per cycle for
free, since `buildArgs` rebuilds the whole argv (constraint 2).

`SELF_HOSTING_NOTICE`'s docblock is the closest thing in the tree to a written
retrospective: two dated incidents (`:4724`–`:4731`) in which a run escalated
from a narrow `pgrep -f "next dev -p 3100"` to a bare `pgrep -f 3100` and killed
a sibling run in another repository, five dependents blocked behind it. The
lesson was extracted by a person, generalised — the example became a variable,
"because an agent told only *do not use a bare number* reaches for a different
literal, where one told *why* a literal is dangerous checks first" (`:4733`–
`:4737`) — and written into the constant. Total elapsed cost: one human reading
two run logs.

**But the notice on its own did not stop it. The deny list did.**
`PROCESS_KILLERS` (`:4690`) puts `Bash(pkill:*)` and `Bash(killall:*)` on
`--disallowedTools` at `:4921`, and agents kept typing them anyway — Bash `tool`
events whose `$.input.command` matches `%pkill%` or `%killall%` number 32 across
16 runs, 15 of them across 8 runs on or after 2026-08-12, the day after the
notice landed (`888db55`). None after 2026-08-14, a seven-day gap this file
cannot attribute, since nothing isolates the notice from everything else that
changed in the same week.

`DELEGATION_NOTICE` is the counter-example, and it is the more important one for
this survey. A purely voluntary instruction with no enforcement, on every cycle's
system prompt — and landed at `ee93684`, so this is its no-instruction baseline
(`SELECT json_extract(payload,'$.name'), COUNT(*), COUNT(DISTINCT run_id) FROM
run_events WHERE kind='tool' GROUP BY 1`):

| tool | calls | runs |
|---|---|---|
| `Bash` | 16,754 | 283 |
| `Read` | 5,867 | 269 |
| `Agent` (delegation) | **194** | **21** |

Twenty-one of the 283 runs that ran any tool delegated anything at all. That is
the same shape constraint 12 records for `Grep` and `Glob` — a surface this
install already grants and its agents already decline — and it is the honest
prior for any option whose mechanism is "put a sentence on the system prompt".

## `sandboxRefusal()`, the one shipped classifier of a recurring failure

**It is the only code in the product that recognises a repeated cross-run
mistake by name, and what it does with the recognition is render a log line.**
`MARKERS` (`src/lib/sandbox.ts:84`) is a list of literal, case-sensitive
substrings; `sandboxRefusal()` (`:142`) returns the first match. The call site is
`src/lib/orchestrator.ts:6081`, beside the `tool_error` emit and never instead of
it, and the output is a `sandbox` event that `describeEvent` renders as a single
warn-toned line under the failure (`src/lib/logLine.ts:337`).

Its provenance is the argument. The `bwrap:` entries were read off this
install's own `run_events` after a sandbox that could not start went unnoticed
for fifteen hours, and `src/lib/sandbox.ts:105`–`:110` carries the measurement
verbatim: 214 of 484 `tool_error` rows, and not one `sandbox` row beside them.
That is the largest repeated cross-run mistake this install has ever made, and —
`00-problem.md`'s finding — **it was solved by seeing it, not by remembering
it.** No agent was ever told about bubblewrap.

What it cannot carry: it is a fixed table compiled into the image, not a store.
It learns nothing, it is per-condition rather than per-repository, adding an
entry is a code change, and its whole output is addressed to the operator. It
proves a classifier over `tool_error` is cheap and the line it renders useful; it
proves nothing about feeding a classification back to an agent, which no shipped
code does.

## Review, and `needs-review`

**Both are real cross-run evidence and neither is ever read by a later run.**
`run_reviews` is the durable corpus `00-problem.md` opens — 68 rows, $240.03,
never swept (`src/lib/retention.ts:29`–`:32`) — but it is a per-run record by
construction: every read in the tree is keyed on `run_id`
(`src/lib/review.ts:125`, `:129`, `:155`) or on one review's own id (`:146`),
and the only unkeyed query is a global count of what is running (`:378`). There
is no per-repository view and no reader outside the run page.

Reviews are also almost entirely unused. Of the 68 rows, 67 are merge-conflict
`resolve` assists and **one** is a `review`:

```sql
SELECT kind, status, COUNT(*) FROM run_reviews GROUP BY kind, status;
-- resolve|completed|59   resolve|failed|8   review|completed|1
```

That is by design — "Neither is ever automatic. Both cost money, and spend
nobody asked for is spend nobody authorised" (`src/lib/review.ts:34`–`:35`) — but
it means the review corpus an option might mine is 59 conflict resolutions and
one code review, and the resolutions are about *collisions between branches*
rather than about the code being right.

`needs-review` is thinner still. One run in 294 carries a
`needs_review_reason`, and that string reaches exactly one reader: the run page
at `src/app/runs/[id]/page.tsx:947`–`:949`. It is cleared on reopen
(`src/lib/orchestrator.ts:8301`) and reaches no later run's prompt. Any option
proposing to learn from how runs end is, per `00-problem.md`, learning from a
distribution with two points in it.

## Workflows, and the branch hand-over

**A workflow is the only shipped way to make a later run start from an earlier
one's output rather than from the folder, and it is the same mechanism
`continuedWorkNotice` renders.** A `continueBranch` edge sets
`run_deps.continue_branch` (`src/lib/orchestrator.ts:3227`–`:3234`) and
`runs.continues_run`, and a loop block's passes reuse it — "through the same
`continue_branch` mechanism a hand-over edge uses — so the chain rules in
`land.ts` see one branch with one owner, and nothing here is a second definition
of what continuing a branch means" (`src/lib/workflows.ts:4665`–`:4671`).

On this install `SELECT continue_branch, COUNT(*) FROM run_deps GROUP BY 1`
returns 29 and **72**, against 2 rows in `workflows`, 7 in `workflow_instances`
and 34 in `workflow_instance_runs`. So most hand-overs are not from workflows at
all — they are dependency chains started elsewhere.

What a workflow carries between runs is a branch and an ordering, nothing else.
A node holds no budget, no model and no permission mode; guards come from its
template (`docs/agent/workflows-and-schedules.md`). The successor gets commits
and a `--stat`, not a conclusion, and `run_deps` never learns a loop exists. It
is staging, not memory.

## Agents and templates

**An agent is a role a run is asked to take, frozen onto the run at spawn, and
it is the only per-run text this app persists that survives the run.** Three
rows in `agents`, and `SELECT COUNT(*) FROM runs WHERE agent IS NOT NULL AND
agent<>''` returns 55 — 46 `ts-coder`, 9 `project-shaper` — with `runs.agent`
holding the whole JSON definition, because
"every spawn writes the whole definition onto its own argv"
(`src/lib/agents.ts:12`–`:19`). `--agent` survives `--resume`, which is what makes
it true of every cycle rather than only the first (constraint 2).

An agent carries a role and never a capability: `tools` is refused by name at
save (`TOOLS_REFUSAL`, `src/lib/agents.ts:222`, returned at `:273`) because a
list there would be a second place deciding what the whole session may do. That
refusal is exactly the wall an option would meet if it tried to make an agent
carry a learned constraint about what a run may touch — the mechanism is
available for *how to work*, not for *what is permitted*.

What neither an agent nor a template can carry is anything derived from a run.
Both are form input authored by a person: a template "holds no folder claim,
consumes no concurrency slot… the only thing it ever does is pre-fill
`POST /api/runs`" (`src/lib/templates.ts:12`–`:20`), and six exist here. Nothing
in the product writes to either table from inside a run loop, and constraint 7 is
the reason that would have to be argued rather than assumed.

## What is already carried between runs today

| Carried | Not carried |
|---|---|
| A git branch, and the range that reads it (`continuedWorkNotice`, 66 runs, 100% first-three-call compliance) | Anything about *why* the predecessor did what it did |
| An ordering between runs (`run_deps`, 101 edges, 72 continuing a branch) | Any output of an earlier run except its commits |
| A role, frozen per run (`runs.agent`, 55 runs) | Any role a run selected or amended for itself |
| Operator-authored guidance, per install (four `DEFAULT_*` prompt keys) | Any per-repository guidance except the mount's CLAUDE.md |
| Operator-authored guidance, per repository (CLAUDE.md — its gate obeyed by 11 of 112) | Anything a run could add to it that a person did not write |
| One hand-promoted lesson, on every cycle's system prompt (`SELF_HOSTING_NOTICE`) | Any lesson promoted without a person reading two run logs |
| One classification of one recurring failure (`sandboxRefusal()`, a fixed table) | Any classification that grows, or that reaches an agent |
| A durable, never-swept record of every AI conflict resolution (`run_reviews`, 68 rows) | Any read of it that is not keyed on one `run_id` |
| The exact prompt every cycle was sent (`iteration` events, 500 rows) | Any rendering of it — `describeEvent` prints "Work cycle N" |
| Which files every run opened (`run_events` kind `tool`, 30-day horizon) | Any reader of that, per repository or otherwise |

The pattern across the ten rows is one thing repeated: **what is carried is
carried in the git tree or on the argv, and what is stored in the database is
stored per run and read per run.** No shipped mechanism aggregates across the
runs on a repository, and no shipped mechanism lets a run contribute to what a
later run is told. The two shipped things that *do* change a later run's prompt —
the branch notice and the system-prompt notices — were both authored by a person,
and only one of them is obeyed.
