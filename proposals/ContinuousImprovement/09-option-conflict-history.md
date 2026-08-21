# Option F — conflict history as the lesson corpus

Every other option in this survey that wants to know what runs get wrong reaches
for `run_events` kind `tool_error`. `00-problem.md` measures why that is the
wrong table: 538 rows, 40% of them one environment fault the codebase already
answered with a classifier, and the whole of it on a thirty-day sweep.

`run_reviews` is the table nobody opened: 68 rows, each a collision between two
runs that git found and a model was paid to reconcile, each carrying a file list
and a dollar figure, and none of it expires. This file makes that corpus's case,
builds the cheapest thing it supports, and then says what it is not — because the
answer to "is this a lesson?" is *only partly*, and the surviving part is not the
one the corpus's size suggests.

## The strongest case

**It is the only cross-run evidence store in this database with no horizon.**
`retention.ts`'s own docblock says it — "Nothing here deletes a `runs` row, a
review, a workflow record or a setting" (`src/lib/retention.ts:29`–`:32`) — and
the module never names the table at all: both `grep -rn "DELETE FROM run_reviews"
src/` and `grep -n "merge_queue\|run_reviews" src/lib/retention.ts` return
nothing. A mechanism reading `tool_error` reads a rolling thirty-day window
(constraint 8); this one reads the install's whole life.

**Every column it would read is written by git or by this app, never by a model
— constraint 7 answered by construction rather than by policy.** The path list is
`git diff --name-only --diff-filter=U` (`src/lib/land.ts:1058`–`:1060`), written
into the row at INSERT before the child is spawned (`src/lib/review.ts:316`–
`:330`), so it records what git found and not what the agent said it did. The
`completed` status is this app's own verification: markers re-read off disk
(`src/lib/land.ts:1302`–`:1312`), `ls-files -u` proved empty, and the commit made
by the app rather than the agent (`:1314`–`:1336`). The cost is the CLI's own
figure. The one model-authored column is `text`, the agent's prose account of
what it kept, and this option reads none of it.

**It is already an accounting citizen.** `run_reviews.cost_usd` was built to be
money spent on a run *outside* its work cycles: out of `runs.spent_usd`
deliberately (`src/lib/review.ts:40`–`:45`, `src/lib/db.ts:206`–`:211`) and out
of telemetry deliberately (`:46`–`:47`). Constraint 5's hardest question — *is
this a fourth cost source?* — is already answered no by the table itself, and a
rollup over it inherits `repoSpend.ts`'s refusal to be a guard verbatim
(`src/lib/repoSpend.ts:13`–`:22`).

**And it is per-repository, small, and instant.** Joined to `runs.repo_root` and
exploded with `json_each`, the whole corpus groups in 1 ms:

```sql
WITH p AS (SELECT rr.id, rr.cost_usd, r.repo_root, j.value AS path
           FROM run_reviews rr JOIN runs r ON r.id = rr.run_id, json_each(rr.resolved_paths) j
           WHERE rr.kind='resolve' AND rr.status='completed' AND rr.resolved_paths IS NOT NULL)
SELECT repo_root, path, COUNT(DISTINCT id) FROM p GROUP BY 1,2 ORDER BY 3 DESC;  -- real 0.001
```

| the corpus, this install | |
|---|---|
| rows | 68 — 59 `resolve`/`completed`, 8 `resolve`/`failed`, 1 `review`/`completed` |
| resolve rows carrying a path list | **67 of 67** — the one null is the `review` row, which by design has none (`src/lib/review.ts:98`) |
| spend | **$238.20**, mean $4.04, range $0.43–$16.26 |
| span | 2026-08-11 → 2026-08-18 |
| on `/workspace/UsageFoundry` | 57 completed resolutions, **$233.42** |

$238.20 is 5.5% of the install's $4,303.70 (`00-problem.md`); on UsageFoundry
alone it is 7.8% of $2,986.58. And the merge queue records what that money
bought: 49 queue rows carry a non-zero `resolve_cost` totalling $166.79, of which
**48 went on to land** — a $3.40 mean for a 98% success rate. (The two sets are
not the same: `merge_queue.resolve_cost` is one figure per queue row, so a run
resolved twice, or resolved from the run page rather than through a batch, sits
outside it.)

## Shape

Two halves sharing a query and nothing else, separable on purpose — the second is
much weaker than the first and must not be allowed to sink it.

**(a) A repository contention card.** A pure function beside `repoSpend`, taking
the joined rows and returning, per repository: resolutions, corpus spend, the
paths ranked by how many distinct resolutions named them, and how many paths were
seen exactly once. A route with `runtime = "nodejs"` and `dynamic =
"force-dynamic"`, and a card on the dashboard beside `<RepoSpendCard />`
(`src/app/page.tsx:1190`) — the precedent is exact, down to the DTO in
`apiTypes.ts` and the fixed span list that keeps a settings field out of it
(`src/app/api/repo-spend/route.ts:8`). It reads four columns and no others:
`run_reviews.resolved_paths`, `.cost_usd`, `.status`, and `runs.repo_root`.

**(b) Optionally, one generated line at cycle 1** naming the two or three most
contended paths on this repository, in `nextPrompt`'s `sessionId === null` array
(`src/lib/orchestrator.ts:4330`–`:4351`) between `priorWorkNotice` and `o.task` —
generated in `orchestrator.ts`, never a `DEFAULT_*`, which is constraint 1's rule
and the split `continuedWorkNotice` already makes (`:4401`). Same delivery slot
and same prior as option C, and it inherits option C's ceiling entirely. It is
written down here because the survey's question asks about it, not because this
file recommends it; see "How it fails".

## What it learns from, and when the decision is taken

It learns from 67 adjudicated file lists and 59 priced outcomes, and the timing
is the first thing wrong with it: **a conflict is recorded at merge time, which
is after the run that caused it is dead.** Nothing in the run loop writes here —
`resolveConflicts` refuses outright while the run is `running`, `queued` or
`paused` (`src/lib/land.ts:1194`–`:1199`), and refuses again if a sibling on the
same branch is still live (`:1204`–`:1211`). The evidence exists only once the
work is finished and somebody has tried to land it.

For half (a) the decision is taken nowhere: it is a report, read on a dashboard
poll, outside the cycle loop and outside `createRun`. Constraint 9 is satisfied
the way `repoSpend` satisfies it — one synchronous `better-sqlite3` read
(`src/lib/repoSpend.ts:170`–`:178` is the shape), no `await` anywhere near the
INSERT path. For half (b) it would be taken once per run, before the cycle loop,
in the `settings` class rather than the `enabledPluginDirs` class that constraint
9 distinguishes: the ranking is stable over minutes and re-resolving it per cycle
would buy nothing.

## What it does to the prefix cache

**Half (a): nothing, unqualified.** No argv entry, no injected text, no file in
the tree, no change to any spawn. `D = 0`, there is no cut point, `T*` is
undefined rather than large.

**Half (b) is the cheap injection case and not the expensive one.** Text appended
at the tip of a cycle-1 prompt is `S = D`, `T* = 19·(S/D) − 20 = −1`, paid once
at the write rate and carried at 0.1× thereafter (constraint 4). Two or three
path names is tens of tokens, which is noise against the 82% of the bill that
`proposals/ContextControl/README.md` records as carried context.

**The shape this option must never take is a file in the repository.** A
maintained `CONTENTION.md`, or an agent asked to append to a lessons file, is a
repository change, and constraint 4 prices that on every cycle it writes. The
store this option reads is already in `DATA_DIR`, which pays none of it and also
answers the other half of constraint 7: the corpus lives in the named volume, not
in the `~/.claude` bind mount the agent uid can write.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: untouched, and the survival question does not arise.** Neither half
adds a flag, so constraint 2's `--settings`-survives / `--plugin-dir`-does-not
split is irrelevant. Half (b) rides in the first user message and reaches cycle 1
only — the same reach `isolationPreamble` has (`src/lib/orchestrator.ts:4332`),
and deliberate: a contention list is context for planning, not a contract that
must be restated.

**Retention: it creates no horizon, and this is its single best constraint
answer.** No fourth arm on `StorageReport`, no fourth thing an operator reasons
about, no sweep. One dependency is worth naming out loud: `run_reviews.run_id` is
`REFERENCES runs(id) ON DELETE CASCADE` (`src/lib/db.ts:214`), so the corpus's
permanence rests entirely on nothing ever deleting a `runs` row. That is an
invariant today — but if it stopped being one the corpus would vanish silently,
taking a card that then reads "no contention" with it.

**DONE and `needs-review`: untouched by half (a).** `nextPrompt` is not called,
`COMPLETION_NOTICE` and `NEEDS_REVIEW_NOTICE` are unchanged, and `cycleEnding`
still matches over a cycle's own final text. Half (b) inserts above both in the
array (`src/lib/orchestrator.ts:4340`, `:4344`, `:4347`), so the notices stay
last and the sentinel vocabulary is untouched — but a generated line listing file
names is text a later summariser could echo, so it must carry no token the ending
matcher looks for. In practice nothing here touches `needs-review` at all: it has
fired once in 294 runs (`00-problem.md`).

## Guards, the three cost sources, and who may author it

**No guard, by construction and by inheritance.** Nothing reaches
`buildSnapshot()`, a window meter or `evaluateBudget`; there is no argument that
could carry it. `src/lib/repoSpend.ts:13`–`:17` is the precedent and the wording
— "a threshold on a repository is a limit nobody set".

**Not a fourth source, and the card says which source it read.** It reads
`run_reviews.cost_usd`, already the one figure in this database that is neither
`runs.spent_usd` nor a transcript meter nor OTLP (`src/lib/review.ts:40`–`:47`),
and it carries the footer `RepoSpendCard` carries: spend *outside* work cycles,
never added to them.

**One arithmetic trap the card must avoid.** A resolution naming fifteen files
has one cost, so a per-path dollar column that sums `cost_usd` per path
double-counts wildly — the naïve query attributes $196.66 to `CLAUDE.md` alone,
against the $233.42 of UsageFoundry resolutions containing it. The honest
presentation is counts per path and money per corpus; money is attributable per
path only for the 29 single-path rows of 59, and the 21 naming `CLAUDE.md` alone
total $60.36.

**Authorship: git writes the paths, this app writes the status, the CLI writes
the cost, and no model writes anything the option reads.** Half (b)'s sentence is
generated in `orchestrator.ts` from that data — constraint 1 — so an operator who
has pressed Save cannot pin a stale version of it, and an agent cannot author the
next run's instructions through it, which is constraint 7's actual worry.

## What the operator sees, and how they override it

The card, with this install's real figures:

| `/workspace/UsageFoundry` | resolutions naming it | runs that edited it |
|---|---|---|
| `CLAUDE.md` | **44** | 88 |
| `README.md` | 13 | 55 |
| `docs/verification.md` | 10 | 25 |
| `src/lib/orchestrator.ts` | 7 | 52 |
| `.env.example` | 5 | 13 |
| `src/lib/orchestrator.test.ts` | 5 | 26 |

with a line beneath saying 57 resolutions, $233.42, 46 distinct paths of which 28
were seen exactly once.

**There is nothing to override, because half (a) instructs nobody** — which is
why it is the half worth building rather than a dodge. Half (b) would need an
override, and constraint 1 prices that at four doors each failing silently and
differently; if it ever ships it should ship as a fixed generated line with no
`Settings` field rather than as a thirty-fifth `if ("key" in body)` arm.

**Constraint 6 is already satisfied on the write side and not at all on the read
side.** A resolution's start and end are visible on the run's own log —
`emitRunEvent({ kind: "review" })` at `src/lib/review.ts:336` and `:867`,
rendered at `src/lib/logLine.ts:477`–`:500` with the label `resolve`, and the
resolved path list going out as a `land` event (`src/lib/land.ts:1345`–`:1350`)
rendered at `src/lib/logLine.ts:416`. An operator can already watch the corpus
being written one run at a time; what they cannot do is see it in aggregate,
which is the gap. Half (b) is worse off: it would inject text into a cycle-1
prompt that is persisted and never rendered, and owes that disclosure first.

## How it fails, and whether loudly

**The structural failure first, because it is fatal to half (b) and no amount of
corpus quality fixes it. A conflict is a property of a *pair* of runs and of the
scheduler that let them overlap, not of either run.** git found it merging two
branches, minutes or hours after both agents exited. Telling run #200 that
`CLAUDE.md` is the most contended file in the tree does not tell it what to do:
if its task requires editing `CLAUDE.md`, it edits `CLAUDE.md`. The only
instruction that would actually avoid the collision is "do not touch this file",
which is the wrong instruction to give a run that was started to touch it.

**The corpus is one file.** 46 of the 59 completed resolutions name `CLAUDE.md`,
and 21 name it and nothing else. Across 47 distinct paths, 29 appear exactly
once. There is a head and there is no tail — nothing between "the file everything
collides in" and "a file that collided once".

**And that file tops the table because it tops the *edit* table, not because runs
misunderstand it.** Counting distinct runs that ran `Edit`, `Write` or
`MultiEdit` against each path on this repository, `CLAUDE.md` is edited by **88
runs** — more than `README.md`'s 55 and far more than `src/lib/orchestrator.ts`'s
52. A ranking of what runs collide in is, to first order, a ranking of what runs
write. That is a fact about this install's working habits and not a lesson about
this codebase.

**The one non-obvious thing in the corpus survives that objection, and it is not
about file identity.** Normalising conflicts by editors, the rates separate
cleanly by file *shape*:

| | conflicts | editing runs | per editor |
|---|---|---|---|
| `CLAUDE.md` | 44 | 88 | **0.50** |
| `docs/agent/testing.md` | 3 | 7 | 0.43 |
| `docs/verification.md` | 10 | 25 | 0.40 |
| `.env.example` | 5 | 13 | 0.38 |
| `docker-compose.yml` | 4 | 14 | 0.29 |
| `src/lib/orchestrator.test.ts` | 5 | 26 | 0.19 |
| `src/lib/chat.ts` | 4 | 24 | 0.17 |
| `src/lib/orchestrator.ts` | 7 | 52 | 0.13 |
| `src/lib/db.ts` | 3 | 31 | 0.10 |

**Prose and configuration conflict per edit at three to five times the rate of
TypeScript.** That is a real finding, it is stable across the whole visible
corpus, and the lesson it implies is about *how* a file is edited — append at a
stable anchor, do not reflow a paragraph two runs are both extending — rather
than about which file. Which is to say: it is guidance for whoever authors
`CLAUDE.md`, which is `13-option-agent-claude-md.md`'s problem and not a run's.

**The corpus is non-stationary, and part of it records this app's own defects
rather than any repository's.** All eight failed resolutions do: six on
2026-08-15 saying "It did not finish within 10 minutes and was stopped", two on
2026-08-18 that are `API Error: 529 Overloaded`. The first six are a clock that
no longer exists: `src/lib/review.ts:55`–`:68` describes exactly this failure —
"Killed at ten minutes it took the merge with it… the branch was rolled back and
the queue reported a failure, for a conflict the agent may well have been most of
the way through" — and `assistTimeoutMs` (`:78`–`:79`) now returns 0 for a
resolution. Zero of the eight is a fact about any codebase, and mining this table
means knowing which rows predate which fix, which nothing in the schema records.

**It also stops.** All 68 rows fall between 2026-08-11 and 2026-08-18, none in
the last three days of the eleven-day window, and $32.54 of the $238.20 lands on
the first day alone. A card built on it will show an ageing table on a quiet
install and must date what it shows.

**Half (a)'s own failure is silent and reads backwards.** An install that has
never used the merge queue, or resolves conflicts by hand, gets an empty card —
and an empty contention table reads as "nothing collides here" rather than
"nothing was measured here". It must distinguish the two the way
`docs/agent/metering.md` requires unknown to render as an indeterminate meter
rather than a 0% bar. This install is also, as far as this survey knows, the only
one the shape has ever been measured on.

**One small verified defect in the write path.** `conflictedFiles` splits git's
output on `"\n"` (`src/lib/land.ts:1058`–`:1060`) and `core.quotePath` is set
nowhere in the tree — `grep -rn "quotePath" src/` returns nothing — so a path
carrying a non-ASCII byte or a newline would be stored in git's quoted form and
would not join against `run_events`' `file_path` in the table above. Nothing in
this corpus has one: of the 47 distinct paths, none begins with a quote or
contains a byte outside printable ASCII.

## What it costs to build

**Half (a) has a precedent that can be measured rather than estimated.**
`repoSpend` is 189 lines of module, a 30-line route, a 202-line card and a
159-line test — 580 lines across four files, and `groupRunSpend` is named in the
tested list at `docs/agent/testing.md:8`. This is smaller on every axis: the
grouping is a `json_each` and two counts, with none of `repoSpend`'s
mount-identity work. Call it two thirds, with the pure function unit-tested to
the same bar — a contention ranking that silently drops the `NULL`-path row or
double-counts a multi-path resolution is exactly the failure mode CLAUDE.md's
rule exists for. Its running cost is one indexed read, measured at 1 ms over the
whole corpus against `idx_run_reviews_run` (`src/lib/db.ts:643`–`:644`): no new
index, no transcript scan, no CPU competing with a live agent, and zero tokens.

**Half (b) costs the line in `nextPrompt`, the synchronous lookup before the
loop, and constraint 6's prerequisite** — the cycle-1 prompt must become readable
before text is injected into it, or an operator meets a memory they cannot audit.

**And constraint 13, the success cost, is where half (b) collapses.** If the line
names `CLAUDE.md` and is obeyed, the run opens `CLAUDE.md` — a file the CLI
already delivers into the first user message of every run in the mounted folder
(`00-problem.md`). The success cost is a second copy of a file the run already
has, and the benefit is nothing. Naming the next paths down is no better:
`docs/verification.md` and `README.md` are contended because they are appended
to, and knowing that does not change what a task requires appending. Neither half
claims a dollar saving, so `d` never enters — half (a) removes no reading, and
half (b) would multiply through a number `01-constraints.md` records as
non-existent.

## What would have to be true

**For half (a), only that an operator wants to know what conflicts cost — which
is already true and already measured.** $238.20 is 5.6% of this install's spend,
$166.79 of it went through the merge queue and 48 of those 49 branches landed,
and `00-problem.md`'s "what this app can see today" table lists "which files runs
keep colliding in" as *nowhere*. This is the smallest honest thing that changes
that: it reads a table that never expires, adds no horizon, no guard and no cost
source, spends no tokens, and cannot make any run worse. Build it.

**For half (b), a corpus with a tail — and this one has none.** Concretely:
twenty or more distinct paths each named by three or more resolutions, on a
repository whose top file is not the one the CLI already injects. Here it is 47
paths, 29 of them singletons, and the top file is `CLAUDE.md` by a factor of 3.4.
Half (b) would be telling every run about a file every run is already handed, and
`00-problem.md` has already run that experiment: a rule placed in the
highest-authority position available was declined roughly nine times in ten.

**And the survey's question deserves the blunt answer.** What can be derived from
68 rows is a claim about *file-level contention* — which files two branches tend
to disagree in — not a claim about anything an agent did wrong. No row here
records a mistake. Every one records two runs doing the work they were asked to
do, in the same paragraph, and a third process being paid $4.04 to reconcile
them. **That is not a lesson; it is a scheduling cost.** The one part that *is* a
lesson — prose and configuration colliding at three to five times the per-edit
rate of code — is a lesson for whoever writes the prose, and half (a)'s card
delivers it without any run being told anything.

**The measurement that would overturn any of this** is a second install's
`run_reviews` table showing a different distribution: a real tail, and a top file
that is not `CLAUDE.md`. Failing that, the follow-on worth taking is the one this
file did not — whether the colliding runs were concurrent by construction, which
would make the whole $238.20 a fleet-scheduling figure rather than a repository
one. That is assumed here and not established: nothing above checks whether the
colliding branch pairs overlapped in time.
