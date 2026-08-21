# Option J — the agent maintains the mount's own CLAUDE.md

No table, no column, no argv entry, no store. The run is told that before it
finishes it should write what the next run on this repository needs to know into
the folder's own `CLAUDE.md`, and the CLI does the rest: that file is already
delivered into the first user message of every run in the mount, on every cycle,
for free.

This is the option a reader arrives with, and it deserves the most careful
refusal in the survey rather than the shortest. Its case is not naive — it
answers ten of `01-constraints.md`'s thirteen constraints by not participating in
them, and it is the only candidate here whose store cannot go stale relative to
the code, because it *is* the code's tree. What kills it is not any of the things
that kill the others. It is that on this install the file it proposes to write is
the single most expensive file in the repository to touch, and that is measured
three separate ways.

## The strongest case

**It needs no code, and that is verifiable rather than asserted.** Re-running
`02-what-already-tries.md`'s grep against this tree:

```
$ grep -rn "CLAUDE\.md" src/ | wc -l
13
```

All thirteen are comments citing *this* repository's own copy as the reason a
decision went the way it did: three CSS comments in `src/app/globals.css`
(`:14`, `:282`, `:426`), nine TypeScript docblocks (`src/lib/sandbox.ts:132`,
`src/lib/land.ts:35`, `src/lib/budget.ts:918` and six more), and one SQL comment
inside `migrate()` (`src/lib/db.ts:490`). **Nothing in `src/` opens, composes,
copies, seeds or writes a `CLAUDE.md` inside a mount.** The delivery is the
CLI's, and this app is not on the path.

**And the delivery reaches every cycle, which is the thing constraint 2 exists
to make hard.** The two-cycle mutation probe changed the memory file between
cycle 1 and cycle 2 of *one* session and watched the first user message change
with it — `proposals/ContextControl/02-levers-on-the-pin.md:442`–`:448`, where
`block2` goes 662B → 697B carrying "first version of the project memory" →
"SECOND version…"; the block is labelled at `:461` as `claudeMd + currentDate`.
So the CLI re-reads the file on each cycle and re-sends it, and this option
inherits `--settings`'s survival property without composing a `--settings` at
all. It never touches `sandboxArgs`, so constraint 3 does not apply either.

**It is the only option in the survey with no coverage gap.** Constraint 10 asks
which part of the fleet a file-delivery mechanism reaches; every other
file-shaped option rides `seedWorktree` (`src/lib/orchestrator.ts:2404`) and so
covers only isolated runs. This one covers both modes, because a run with
`mode: "none"` (`src/lib/orchestrator.ts:1571`) works in the operator's own
checkout, where the file already is —
`SELECT isolation, COUNT(*) FROM runs GROUP BY isolation` gives worktree 243,
none 40, empty 11.

**Its liveness question is identity rather than a file's age, and that is a real
advantage over `11-option-repo-brief.md`.** Option H's brief carries the HEAD sha
it was written against and is read only when that sha matches; a store in
`DATA_DIR` can describe a tree that no longer exists. A `CLAUDE.md` in the tree
cannot: it is checked out at the same sha as everything around it. Constraint 8
has the same shape — no horizon, because git is the horizon, and no fourth arm on
`StorageReport`.

**And it is the most reviewable store any option here proposes.** An edit is an
`Edit` event in `run_events`, it appears on `GET /api/runs/[id]/diff` — "What
this run changed", `src/app/api/runs/[id]/diff/route.ts:11` — and it is in
`git log -p CLAUDE.md` forever. Constraint 6 is satisfied without anything being
built: no `--include-hook-events` problem, no un-rendered `iteration` prompt.

That is a genuinely strong hand. Constraints 1, 2, 3, 5, 6, 8, 9, 10, 11 and 12
are all answered by non-participation. Three are left, and each of the three is
independently fatal.

## Shape

There is no schema and no module. The whole option is one instruction and a
decision about where it lives.

The instruction cannot be a `DEFAULT_*` prompt if it has to stay true, because
constraint 1's mechanism is exact here: `getSettings()` is
`{...DEFAULTS, ...stored}` (`src/lib/settings.ts:653`–`:655`) and an operator who
has *edited* a prompt has pinned it permanently. So the sentence is generated in
`orchestrator.ts` beside `COMPLETION_NOTICE` (`:4466`) and `NEEDS_REVIEW_NOTICE`
(`:4506`), appended by `nextPrompt` (`:4299`), with any editable half kept as
separate guidance the way `continuedWorkNotice` (`:4401`) does it. A `Settings`
toggle for whether the run maintains the memory is a new field with four doors
and is where the build cost actually sits — not the sentence.

The decision that matters is **when** the write happens, and there are only two
placements:

| placement | what it costs in cache | how often it happens |
|---|---|---|
| mid-run, as the lesson is learned | a full prefix invalidation at the next handover | whenever the agent complies |
| in the same turn as `DONE` | nothing — no handover follows | only on runs that report done |

Both are bad, in different directions, and the next two sections are why.

## What it learns from, and when the decision is taken

**Its corpus is one agent's opinion of its own run, and it is the only option in
the survey that reads nothing.** `06-option-prior-read-pointer.md` reads
`run_events` kind `tool`; `09-option-conflict-history.md` reads `run_reviews`;
`10-option-retrospective.md` reads a settled run's transcript with a second
model. This one reads nothing. The 538 `tool_error` rows, the 5,856 path-bearing
`Read` calls and the 67 conflict resolutions `00-problem.md` measures are
all left on the floor, and what reaches the next run is whatever the previous
agent believed about itself while still inside the task it was judging. The
decision is taken by the model, mid-cycle, with no gate: constraint 9 is not
engaged because nothing goes near `createRun`, and nothing else is engaged
either, because there is no code in which to put a check.

**And the compliance prior is measured, not guessed, and it is bad.**
`00-problem.md`'s closing finding is that this install has already run the
experiment: a rule in CLAUDE.md, in the highest-authority position the
conversation has, on every run, was declined by roughly nine runs in ten — 112
runs edited `src/lib/`, eleven read the `docs/agent/` doc the gate names. An
option whose entire mechanism is *another instruction in the same file* has to
argue that its instruction is the one that gets followed, and
`03-experiment-holdout.md` exists precisely because nobody has separated position
from content well enough to make that argument.

## What it does to the prefix cache

**This is the option's negative-money section, and the harm is doubled rather than
single.** Constraint 4's rule is that a repository change is a cache write,
because `gitStatus` sits inside the CLI's own `sys[2]` block ahead of the only
breakpoint that matters
(`proposals/ContextControl/02-levers-on-the-pin.md:419`–`:437`, `:470`–`:474`).
A `CLAUDE.md` edit is a repository change, so it moves `gitStatus`. But the same
probe shows it *also* moves `block2`, the injected memory itself (`:445`–`:447`),
and `:468`–`:470` records that on a resumed request the third `cache_control`
mark moves to the newest message, "so the first user message carries no
breakpoint at all and everything in it sits inside the prefix `sys[2]` breaks".
**A memory edit therefore invalidates the prefix twice over, and the second
invalidation is the memory's own bytes.**

That second half is what makes this option immune to the one repair
ContextControl found. `--exclude-dynamic-system-prompt-sections` moves the
volatile per-machine sections out of the system prompt and into the first user
message (`:487`–`:498`) — which fixes `gitStatus` and does nothing whatever for
the memory block, since it lands in the same unbroken first message.

The price is the handover pair, from `proposals/ContextControl/00-problem.md:943`–`:947`:

| first turn after a continuation prompt | n | median write | median $ |
|---|---|---|---|
| re-wrote the conversation | 79 | 231,644 tok | **$2.335** |
| hit the cache | 29 | 1,872 tok | **$0.165** |

$2.17 per handover flipped, at the one-hour write multiplier of 2.0× input
(`src/lib/pricing.ts:16`–`:18`).

**The per-week harm is between about $13 and $63, and the corpus cannot narrow it
further.** The floor is certain: six of the 29 hits followed a cycle that changed
nothing in the repository, and all six hit — "no handover whose previous cycle
changed nothing in the repository ever re-wrote (0 of 74), and every handover with
no repository change hit the cache (6 of 6)"
(`proposals/ContextControl/02-levers-on-the-pin.md:516`–`:518`). A memory write on
those six cycles flips them: **6 × $2.17 = $13.02 a week**. The ceiling assumes
the write flips every currently-hitting handover: **29 × $2.17 = $62.93 a week**.
The spread exists because 23 of the 29 hits followed a cycle that *did* change
something and hit anyway, which is why that file calls a repository change
"necessary but not sufficient in this data" and calls its own cycle boundaries
approximate.

Scale, from this survey's own database rather than from transcripts —
`SELECT SUM(n-1) FROM (SELECT run_id, COUNT(*) AS n FROM run_events WHERE
kind='iteration' GROUP BY run_id)` gives **212 handovers** over the eleven days,
about 135 a week against ContextControl's transcript-side 108. The exposure is if
anything a quarter larger than the pricing above assumes.

**The standing cost of a bigger file is a different claim, and it is not
established.** Regressing median opening prefix against `CLAUDE.md` bytes over
five repositories gives r² = 0.165, and VisualMerge's 27 KB memory produces a
*smaller* opening prefix than UsageFoundry's 15 KB
(`proposals/ContextControl/00-problem.md:1274`–`:1279`). This repository's copy
is 15,473 bytes today (`wc -c CLAUDE.md`), up from the 15,172 that file recorded
days earlier. So growth is real and its price is unmeasured; what is measured is
the write.

**The one placement that escapes all of this is the placement that mostly does
not happen.** A memory written in the same turn as `DONE` has no handover after
it, so it invalidates nothing. But `00-problem.md` counts 102 of 277 `completed`
runs carrying `reported_done = 0` — 36.8% used up their cycle cap rather than
finishing — and those runs never reach the turn where the write was supposed to
be. The cheap placement is silently skipped by more than a third of runs, and
nothing anywhere records that it was skipped.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: nothing to do, and that is exactly the trap.** The file is re-read
per cycle by the CLI, so the memory needs no re-send and cannot be lost to
`--plugin-dir`'s measured non-survival. The same property is what turns one write
into a re-write of everything the conversation has said.

**Retention: no horizon, and no sweep either.** Constraint 8 is satisfied without
a fourth arm — but the reason is that nothing in this app can ever trim the
store. `run_events` expires at `eventRetentionDays` (default 30,
`src/lib/settings.ts:631`); `run_reviews` never expires but also never grows on
its own. A memory every run appends to grows monotonically, is carried at 0.1×
on every turn of every future run on that repository, and the only thing that
shrinks it is a person deleting lines. That is a fine answer for an
operator-authored file and a poor one for one an agent appends to.

**The DONE contract is in direct tension with the instruction.**
`COMPLETION_NOTICE` says to reply DONE "and make no further changes"
(`src/lib/orchestrator.ts:4470`–`:4471`). "Write the memory, then say DONE" is
satisfiable; "say DONE, then write the memory" is a contract violation. So the
write is crammed into the same turn as the ending — the turn an agent is least
likely to spend on housekeeping — and while a memory edit does not disturb
`cycleEnding` (`:4543`), a run that writes a long memory and then forgets the
sentinel buys another whole work cycle.

**`needs-review` is where the loss is largest and the mechanism is weakest.** A
run that ends `needs-review` has, by the survey's own count, the rarest and most
valuable lesson in the corpus — one of 294. It also, by definition, ended without
landing. Its memory dies on an unlanded branch, and the survey is left where
`00-problem.md` found it: a distribution with one point in it.

## Guards, the three cost sources, and who may author it

**Constraint 5 is answered by not participating, and that is a genuine
strength.** The write happens inside the run's own cycle, so it is charged to
`runs.spent_usd` like any other tool call: no fourth cost source, no new
per-repository rollup, no `run_reviews` row. Where `10-option-retrospective.md`
has to keep a billed child out of `runs.spent_usd` the way `review.ts` does
(`src/lib/review.ts:51`, `:261`), this option has nothing to keep out.

The cost of that is that the memory write sits **inside** the budget guard. The
check order in `docs/agent/budgets-and-guards.md` — terminus, cycles, duration,
run spend, weekly, then session — means a run that trips its ceiling while
composing its memory leaves a partial `CLAUDE.md` on the branch. Nothing detects
a half-written memory, and the next run reads it as fact.

**Constraint 7 is the second of the three killers, and the honest version is
sharper than the naive one.** The naive objection is that the write side and the
read side become the same author. The complication is that on this install they
partly already are:

```sql
WITH e AS (SELECT ev.run_id, json_extract(ev.payload,'$.input.file_path') AS fp
           FROM run_events ev JOIN runs r ON r.id=ev.run_id
           WHERE ev.kind='tool' AND r.folder='/workspace/UsageFoundry'
             AND json_extract(ev.payload,'$.name') IN ('Edit','Write','MultiEdit','NotebookEdit'))
SELECT COUNT(*), COUNT(DISTINCT run_id) FROM e WHERE fp LIKE '%/CLAUDE.md';
-- 338 | 88
```

**88 of the 200 UsageFoundry runs already edit `CLAUDE.md`, across 338 edit
calls.** So an agent writing that file is not new. What is new is *why*: today
those edits are the deliverable the operator asked for, they arrive on a branch,
and a person reads them before pressing Land. Under this option the same edits
are instructions the run writes to its successors — and nothing on the landing
path distinguishes the two, because nothing on the landing path looks. `landRun`
merges the branch whole, `git merge --squash <branch>` or
`git merge --no-edit <branch>` (`src/lib/land.ts:992`–`:993`), with no pathspec,
no exclusion and no filter. On the squash path the memory edit is folded into one
commit whose subject is the first line of the run's own prompt (`taskSubject`,
`src/lib/land.ts:1080`, used at `:1016`), so an agent-authored instruction to
every future run arrives in history under the title of the task it was doing.

## What the operator sees, and how they override it

**Better than any other option here, and still not enough.** The edit is an
`Edit` event on the run's log, it is in the run's diff, and it is in
`git log -p CLAUDE.md`. The override is the strongest in the survey: the operator
edits the file, or reverts the commit, and the mechanism obeys immediately
because there is no mechanism.

Two gaps. First, what the operator reviews is not what future runs read, because
only just over half of the isolated runs ever land —
`SELECT COUNT(*), SUM(landed_at IS NOT NULL) FROM runs WHERE isolation='worktree'`
gives 243 and 131, or 53.9%. **46% of isolated runs' memory writes never reach
the tree**, silently, and the run page shows the edit as a success either way.
Second, the app has no per-repository view of the memory or its history —
`repoSpend.ts` is the only per-repository rollup that exists, and it is about
money. Reviewing the memory means leaving the app for `git log`.

## How it fails, and whether loudly

**Failure one is contention, and it is the third killer.** `00-problem.md` states
that 54 of the 67 conflict resolutions carrying a path list name `CLAUDE.md`,
3.6× the next file. Re-read against the database, the picture is worse than that
sentence:

```sql
WITH named AS (SELECT DISTINCT rr.id, rr.status, rr.cost_usd
               FROM run_reviews rr, json_each(rr.resolved_paths) j
               WHERE rr.kind='resolve' AND rr.resolved_paths IS NOT NULL
                 AND j.value='CLAUDE.md')
SELECT status, COUNT(*), ROUND(SUM(cost_usd),2), ROUND(AVG(cost_usd),2)
FROM named GROUP BY status;
```

| resolutions naming `CLAUDE.md` | n | spend | mean |
|---|---|---|---|
| `completed` | 46 | **$201.45** | **$4.38** |
| `failed` | 8 | $0.00 | — |

Against `SELECT kind, status, COUNT(*), SUM(cost_usd) FROM run_reviews GROUP BY 1,2`,
which gives 59 completed resolutions at $238.20 and eight failed. So **this one
file accounts for $201.45 of the $238.20 the install has paid to resolve
conflicts — 84.6% — at a mean of $4.38 against the $4.04 all-file mean, and every
single resolution that failed outright names it.**

The mechanism behind that is writer count, not anything peculiar to the file, and
saying so is what makes the objection load-bearing rather than rhetorical.
`CLAUDE.md` is the most-edited file in this tree by distinct runs (88, against
`README.md` 55 and `src/lib/orchestrator.ts` 52), and its conflicts-per-editing-run
rate is unremarkable:

| path | editing runs | resolutions | per editing run |
|---|---|---|---|
| `CLAUDE.md` | 88 | 54 | 0.61 |
| `.env.example` | 13 | 9 | 0.69 |
| `docs/verification.md` | 25 | 15 | 0.60 |
| `docker-compose.yml` | 14 | 8 | 0.57 |
| `README.md` | 55 | 14 | 0.25 |
| `src/lib/orchestrator.ts` | 52 | 12 | 0.23 |

**So the file is not cursed; it is crowded.** That reading of the table is
*assumed* to be causal — a paid resolution names several paths and needs two
concurrent runs, so 0.61 is an observed rate rather than a measured elasticity —
but if it is even directionally right, an option whose whole content is adding
writers to the file that already has the most is buying roughly $2.67 of paid
conflict resolution per additional editing run, on top of the cache.

**Failure two is silence in three places.** The instruction is declined (the
90%-decline prior above) and nothing records a decline. The DONE-turn write never
happens for the 36.8% of runs that exhaust their cycle cap, and nothing records
that. The write happens and the branch never lands, for 46% of isolated runs, and
nothing records that either. All three read on the run page as a run that
finished normally.

**Failure three is that the money is invisible.** The cache flip this option
causes appears on no page in this app — that is `04-option-see-it.md`'s whole
subject, and constraint 6's second half. An operator whose weekly bill rises by
$13–$63 has no instrument that would attribute it.

**Failure four is the only loud one, and it is loud in the wrong way.** A wrong
memory does not throw. It arrives in the highest-authority position the
conversation has, on every run, forever, and is argued with by no one.

## What it costs to build

**Hours, and it is the cheapest option in the survey by an order of magnitude.**
One generated sentence in `nextPrompt`'s composition beside `COMPLETION_NOTICE`,
and — if the operator is to be able to switch it off — one `Settings` field
through constraint 1's four doors: the interface member, a `DEFAULTS` entry,
membership of `SETTINGS_KEYS` (`src/lib/settings.ts:649`) and an
`if ("key" in body)` arm in `PUT /api/settings`. No migration, no table, no
route, no component, no sweep, no test that `docs/agent/testing.md`'s bar would
admit.

That number is real and it is the reason this option keeps being proposed. It is
also the wrong number to decide on: the build is nearly free and the operation
costs $13–$63 a week in cache plus an assumed ~$2.67 per new editing run in paid
conflict resolution, against a displacement fraction `d` that `01-constraints.md`'s
scoring table says does not exist.

## What would have to be true

Three things, and they are independent — any one of them failing is enough.

**One: the memory write would have to land on cycles that are not followed by
another cycle, reliably.** That is the DONE-turn placement, and it is
contradicted by the 102 of 277 completed runs that never reach a DONE turn. If
someone can show that a run writes its memory only on a terminal cycle *and* that
non-terminal runs lose nothing by not writing, the cache objection goes away
entirely and this becomes a serious candidate.

**Two: adding writers to `CLAUDE.md` would have to not add conflicts.** The
measurement that would establish it is a per-file conflict rate that does not
scale with editing runs — the table above is consistent with linear scaling and
this survey cannot rule out that the 0.61 rate is an artefact of concurrency
rather than of the file. Someone who separated those would settle it. Until then,
the file that has already cost $201.45 in paid resolutions is the wrong place to
put a new class of write.

**Three: a model-authored instruction in the first user message would have to be
reviewable before it takes effect.** Constraint 7 is not satisfiable by anything
downstream of the write, because `landRun` merges the branch whole
(`src/lib/land.ts:992`–`:993`) and the squash subject is the task's own first
line. It would need a gate on the landing path that this app does not have and
that `docs/agent/isolation-and-landing.md` gives no room for.

**And there is a version that survives all three, which is not this option.** If
a file in the tree is what is wanted — for the free delivery, the identity-based
liveness and the git-native review — then the **server** writes it before cycle
1, out of a corpus, and no run edits it. That removes the cache write (one server
write before the first spawn, not a write per cycle), removes the contention
(one writer, not 88 plus the memory), and removes the authorship problem
(constraint 7's answer becomes "the app", not "the previous agent"). That shape
already exists in this survey and it is `11-option-repo-brief.md`, which puts the
document in `DATA_DIR` and seeds it into the checkout — plus
`08-option-operator-note.md` if the author should be a person rather than a
model.

The right conclusion is not that a per-repository file is a bad idea. It is that
**the agent must not be the one holding the pen**, and once it is not, there is
no reason for the file to be `CLAUDE.md`.
