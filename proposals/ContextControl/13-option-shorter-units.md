# Option J — shorter units by construction

Stop making one run do a long job. Split it into workflow blocks joined by
`continueBranch` edges: each block is a separate run with its own conversation,
the branch carries the state between them, and every block starts empty.

## The strongest case

**It is the only option in the survey that is already built, already reachable
from the UI, and already used by one shipped feature for a different reason.**
`continueBranch` is a field on the edge (`src/lib/workflows.ts:321`), validated
at `:809`–`:890`, carried on the wire (`src/lib/apiTypes.ts:531`, `:1011`),
checkboxed in the editor (`src/components/WorkflowEditor.tsx:1571`–`:1572`),
labelled on the canvas (`src/components/WorkflowCanvas.tsx:731`) and accepted by
`POST /api/runs` (`src/app/api/runs/route.ts:109`–`:132`). Nothing in this file
proposes writing any of it.

**And the loop block is this option, shipped and running.** Every pass of a
loop is "a fresh run continuing the last one's branch, and `run_deps` never
learns a loop exists" (`CLAUDE.md`), created with `[{ runId: previous.id, edge:
"on-success", continueBranch: true }]` (`src/lib/workflows.ts:4678`). So the
arrangement this option asks for — a chain of short conversations on one branch
— is not hypothetical on this install; it is what a loop block already does,
and it does it because a pass is a unit of work rather than because anybody was
counting tokens.

**And the difference from every other fresh-start option is what the fresh
agent has to reconstruct.** `03-experiment-resumed-vs-fresh.md`'s unfavourable
result — a fresh cycle is cheaper only while it re-reads under about 3.9 KB —
is measured on an arrangement where each new conversation is asked to *continue
the same task* and therefore has to rebuild where it was. A block boundary is a
task boundary: block 2 has its own task text, and what it needs from block 1 is
on the branch, which is the entire purpose of `continueBranch`. The re-reading
`03-` prices is work block 2 was going to do anyway.

**And the app already tells the next agent what it is walking into.**
`continuedWorkNotice` fires exactly here — `nextPrompt` sets `continuedFrom`
when `run.continues_run && run.isolation === "worktree" && run.worktree_branch`
(`src/lib/orchestrator.ts:6618`–`:6626`) — carrying `continuedWorkPrompt`,
which exists because a fresh session on a branch full of work it did not do
"either redoes the work or reverts it as leftovers"
(`src/lib/settings.ts:544`–`:551`). The mitigation for the failure this option
risks was written for this option's own mechanism.

## Shape

**The session lifecycle, chosen by the operator at design time.** No argv
changes, no injected text changes, no store, no accounting. What changes is how
many `runs` rows a job is, and each row gets a conversation.

The mechanism has hard edges that decide what this option can and cannot be, all
of them enforced at graph validation:

- **Both ends must be isolated.** A `continueBranch` edge is refused when the
  source is not isolated — "has no branch to hand to" — or when the target's
  template is not (`src/lib/workflows.ts:844`–`:866`). So this option is
  unavailable to a run working directly in the operator's folder.
- **Orchestrator and merge blocks are refused by name** (`:810`–`:831`), because
  one "decides what to run rather than working in a checkout" and the other
  "lands other blocks' branches rather than working in a checkout of its own".
- **One branch, one taker.** Two blocks set to carry on the same predecessor is
  refused with both names (`:871`–`:890`), and `admitDependencies` refuses the same
  thing between live runs.
- **A node holds no guards of its own** — "guards come from its template"
  (`CLAUDE.md`, `docs/agent/workflows-and-schedules.md`), so splitting a job into
  four blocks is choosing four templates.

## What leaves the context, and when the decision is taken

**Everything leaves, at a block boundary, and the decision is taken by a person
before the run starts.**

That is unique in this survey. Every other option that discards a conversation
decides *at runtime*: Option D on a rule, Option G on a threshold, Option F on
a window. This one is decided by whoever drew the graph, at the moment they
knew what the job was — which is the only moment anybody has the information
`00-problem.md` says is missing, because they know where the natural seams are
and no measurement does.

The cost of that is the mirror image: the decision cannot respond to anything.
A block that turns out to need twenty cycles gets twenty cycles in one
conversation, and this option has nothing to say about it.

## What it does to the prefix cache

**Per boundary: one fresh conversation instead of one resumed handover, priced
by `00-problem.md`'s own pair.** A resumed handover that re-writes costs a
median **$2.335** and one that hits costs **$0.165**; a fresh conversation's
opening turn costs a median **$0.294**. So each boundary replaced saves about
$2.04 or costs about $0.13, on the 79-to-29 split the rolling week measured.

**But the count is what matters and it runs the other way.** This option does
not convert handovers — it *removes* them, by making the job fewer cycles per
run and more runs. A job that was one run of twelve cycles (eleven handovers,
of which about eight re-write, ≈ $18.68 in writes) becomes four blocks of three
cycles (eight handovers, of which about six re-write, ≈ $14.01) **plus four
fresh openings** (≈ $1.18) **plus whatever each new block re-reads**. The
saving is real and it is roughly a third of the handover line, not all of it,
because a block of three cycles still hands over twice.

**And there are three costs `03-` and `02-` measured that apply in full.** A
**session-title turn per conversation**, which the CLI spends on every new
session — four against one in `03-`'s arrangements, 2,049 → 9,164 bytes. The
**fixed prefix paid again per block**: a UsageFoundry run's opening turn writes
a median **42,380** tokens beyond the 15,903-token shared base, with p75 at
82,283 and p90 at 92,085 over 261 openings, so four blocks pay that four times.
And the re-reading `03-` brackets, which here is bounded by the new task rather
than by the old one.

**Netting those honestly:** four openings at a median 42,380 written tokens is
about $1.70 in writes against three saved re-writing handovers at about $2.34
each. It is positive at the median and it is not obviously positive at the p90
opening, where four blocks write 368,340 tokens of prefix — **more than one
median handover re-write**.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**DONE: strengthened per block, and each block ends for its own reason.** Every
block is a fresh conversation, so it gets `COMPLETION_NOTICE` gated on
`endsOnDone` (`src/lib/orchestrator.ts:4344`, `:4466`) and `NEEDS_REVIEW_NOTICE`
(`:4347`, `:4506`) as opening context rather than four cycles back.
`cycleEnding` (`:4543`) is untouched.

**`needs-review` is where splitting has a consequence nobody would predict, and
it is the strongest argument against this option.** It "is terminal and is
**not** a success: `on-success` stays blocked, `on-finish` starts"
(`CLAUDE.md`, `docs/agent/dependencies.md:12`). A `continueBranch` edge is
`on-success` by construction in the loop's case (`src/lib/workflows.ts:4678`),
and in a hand-drawn graph it is whatever the operator chose. So **every extra
block is an extra place the chain can stall on an agent's own judgement about
the task** — four blocks have four chances to end in `needs-review` where one
run had one, and each one blocks everything behind an `on-success` edge.
Splitting a job multiplies the number of terminal states it can reach.

**And a block that did nothing satisfies nothing.** "A run that ran no work
cycle satisfies nothing" (`CLAUDE.md`, `docs/agent/dependencies.md`), so a
block whose guards refused it at the door does not release its dependents —
correct, and one more stall per boundary.

**`--resume`: still used, inside each block.** This option does not abolish
resumption; it shortens the conversations that get resumed. A three-cycle block
resumes twice.

**Retention: nothing new, and one thing that gets better.** Each block is an
ordinary run with an ordinary transcript on the ordinary horizon
(`transcriptRetentionDays`, default 30, `src/lib/settings.ts:633`), and
`resumableSessions` (`src/lib/retention.ts:589`) protects each live one because
each has its own row and its own `session_id`. That is the breakage Options D
and G introduce, avoided here for free: four blocks are four rows, so four
sessions are protected rather than one.

**Landing is the one thing splitting complicates, and it is already decided.**
"One branch, one Land button: the last run on the chain, and only once nothing
behind it can still commit" (`CLAUDE.md`,
`docs/agent/isolation-and-landing.md`). Four blocks on one branch is one Land,
on the fourth — which is the correct answer and also means an operator watching
block 2 finish cannot land what it built.

## Guards and the three cost sources

**Must not touch, and does not:** the check order is untouched — `no_terminus`
(`src/lib/budget.ts:495`), `iterations` (`:506`), `duration` (`:518`),
`run_cost` (`:525`), `run_tokens` (`:532`), `weekly_fraction` (`:551`),
`session_fraction` (`:582`). No new code, no new rung, no new reader.

**But it multiplies the guards rather than leaving them alone, and that is the
real cost.** Every block's `maxIterations`, `maxDurationMinutes` and
`maxRunCostUSD` come from its own template, so a job split four ways has four
cycle caps and four spending limits where it had one. `maxIterations` counts
cycles rather than money (`src/lib/budget.ts:97`), so four blocks of three is
twelve cycles' worth of terminus against one run's twelve — the same number,
distributed, and now impossible to spend where the work turns out to be. The
workflow-level ceiling exists for exactly this and is not optional:
`evaluateInstanceBudget` (`:752`) is what bounds the instance, and "a workflow
whose instance budget sets nothing cannot be scheduled" (`CLAUDE.md`).

**Adds to which source: none.** No figure is produced, nothing new is read —
which is true here without qualification, as it is of Options B, K and L.

## What the operator sees, and how they override it by hand

**Sees: everything, on surfaces that already exist.** Four rows in the runs list
instead of one, four spend figures, four cycle counts, the instance page, the
canvas with `· branch` on the edge (`src/components/WorkflowCanvas.tsx:731`) and
the tooltip saying the successor "carries on its branch" (`:719`). An operator
using this option can see what each unit of work cost, which is more granular
attribution than any other option here delivers and it costs nothing to get.

**Overrides: the graph.** There is no setting to switch off, because there is
nothing switched on — this is a way of using the app rather than a behaviour of
it. `01-constraints.md`'s first obligation, that off must be expressible and the
default, is met by the mechanism defaulting to absent:
`continueBranch` "is the one field here that *is* defaulted, and to false … set
wrongly, a run commits onto a branch nobody put it on. So absence is the safe
answer rather than an ambiguous one" (`src/app/api/runs/route.ts:80`–`:85`).

**Mid-run: nothing to reach.** A graph is instantiated topologically in one
synchronous pass, all or nothing (`CLAUDE.md`,
`docs/agent/workflows-and-schedules.md`), so the shape of a running instance is
fixed. An operator who wanted a different split has to stop and redraw. That is
a genuine limitation and not a small one: the information that would tell you
where to split arrives while the job is running.

## How it fails, and whether loudly

**Loud, and unusually so: the graph refuses at validation.** A `continueBranch`
edge onto a non-isolated block, or two blocks carrying one branch, or an
orchestrator block at either end — all are refused with a sentence naming the
blocks (`src/lib/workflows.ts:810`–`:890`), before anything is created, because
"instantiation is topological, one synchronous pass, all or nothing. Half a
graph is not a smaller workflow" (`CLAUDE.md`). There is no CLI build on which
any of this changes, because none of it is on an argv.

**Silent, first: the split is in the wrong place.** A boundary drawn where the
job does not have a seam gives block 2 a task it cannot do without redoing
block 1's reading — `03-`'s 2.59× case, and `continuedWorkNotice`'s "both are
billed and both look like progress" (`src/lib/settings.ts:544`–`:551`). Nothing
in this app would show it as anything but four runs that each took longer than
expected.

**Silent, second: the chain stalls on `needs-review` and reads as finished.**
`needs-review` is terminal and settled; the block is not `completed`, so an
`on-success` successor never starts, and an instance whose status is derived
four ways is where an operator would have to notice — "act on `instanceIsOpen`,
never on `status === 'started'`" (`CLAUDE.md`) is the rule that exists because
that distinction is easy to get wrong.

**Silent, third: the fixed prefix is paid per block and nobody counts it.** Four
openings at a p90 UsageFoundry prefix is 368,340 written tokens, which does not
appear as a line anywhere — it is spread across four runs' `spent_usd`, each of
which looks unremarkable.

## What it costs to build

**Nothing. The mechanism ships.** No file is touched, no schema changes, no
migration, no new failure mode, no new invariant. That is true of no other
option in this survey.

What it costs instead is **documentation and a default**: `docs/workflows.md`
is where an operator learns what a block is for, and nothing in it — or
anywhere else — currently says that a shorter block is a cheaper conversation.
Whether anybody uses `continueBranch` today is **not readable from here**: it
would be a query against `run_deps`, and `/data` is root-owned 0700 by design
(`docker-compose.yml:35`–`36`), which is the same limit `00-problem.md` states
for every figure it could not take from the transcripts.

**It earns no test under `CLAUDE.md`'s bar**, and the functions that would have
earned one already have theirs: `releasableRuns`, `dependencyCycle` and
`topologicalOrder` are named in `docs/agent/testing.md` as pure functions whose
failure modes are silent — "a run queued behind something that will never move,
or a run told to start after another one that is never woken" — and
`planLoopPass` is there too, "pure for `releasableRuns`' reason: a loop that
never terminates is billed, and one that stops a pass early is silent"
(`src/lib/workflows.ts:162`–`:163`).

## What would have to be true

**That jobs have seams.** This option is only available where a long task
decomposes into blocks with checkable boundaries, and the whole of its
advantage over Option D is that block 2's re-reading is work it was going to do
anyway. On a job that is genuinely one continuous investigation, a boundary is
an arbitrary cut and this becomes Option D with extra configuration.

**That the operator knows where the seams are before starting.** The graph is
fixed at instantiation, and the information that would place the cut — how long
each part actually takes, where the conversation got heavy — arrives afterwards.
Option A's readout is what would supply it for the *next* job, which makes this
option's usefulness cumulative rather than immediate.

**That four blocks' fixed prefixes cost less than one run's handovers.** At
this install's median opening — 42,380 written tokens — they do. At p90 —
92,085 — four openings write more than one median handover re-write, and the
arrangement loses. Nothing here establishes what moves a run between those two,
and `00-problem.md` says so in as many words: "A run's opening prefix ranges
over an order of magnitude on one repository, and nothing measured here says
what moves it."

**And the fact that most weakens it:** every extra block is an extra terminal
state. `needs-review` is not a success, an `on-success` edge behind one stays
blocked, and a block that ran no work cycle satisfies nothing. A job split four
ways has four ways to stop half-finished, and the arrangement that was adopted
to make conversations shorter has made the chain more fragile in a way that
costs an operator's attention rather than tokens.
