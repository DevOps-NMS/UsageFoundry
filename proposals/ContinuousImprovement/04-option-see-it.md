# Option A — do nothing but see it

No mechanism. Nothing a run carries changes, nothing reaches an argv, a prompt
byte or a store; what changes is that the *install* can read back what its runs
have already read, which walls they have already hit, and what each cycle was
actually told. Every path and line number below was opened at `ee93684`, and
every figure is either `00-problem.md`'s or carries the query that produced it.

One correction to the framing before the case, because it decides what this
option is. This is not "add a chart". `00-problem.md` ends on a specific
absence — what every run on a repository has read, which walls they keep
hitting, and the prompt a cycle was sent are each recorded in this database and
rendered **nowhere** — and the whole content of this option is rendering them.

## The strongest case

**The install's own largest repeated cross-run mistake was already solved this
way, and the codebase says so in a comment.** 214 of this install's `tool_error`
rows are one bubblewrap failure across ten separate runs (`00-problem.md`), and
`src/lib/sandbox.ts:108` records that count in the source, marked "**Measured,
not read**". What shipped in answer was not a memory but a classifier,
`sandboxRefusal()` (`src/lib/sandbox.ts:142`), and a log line: the `sandbox`
case at `src/lib/logLine.ts:337` puts a second row directly under the tool
failure saying which condition those words were recognised as. Seeing it was the
fix. No other option here can point at a precedent inside this repository where
its own mechanism was tried and worked.

**It is the instrument every other option needs in order to be scored.**
`01-constraints.md`'s arithmetic table ends on the one that matters: `d`, the
share of aimed-at reading a pointer or brief actually removes, **does not
exist**, and every saving claim in this survey multiplies by it. Nothing in this
app can tell you whether run #93 opened `orchestrator.ts` because it needed to
or because it had no idea an earlier run had. Reading (1) is the denominator of
`d`; without it a holdout (`03-experiment-holdout.md`) has nothing to measure
its treatment arm against.

**It cannot make anything worse.** It answers constraints 2, 3, 4, 10, 11 and 12
vacuously — no argv element, no `--settings` payload, no prefix byte, no
`seedWorktree` dependency, no stored path used as a handle, no standing tool
definition at $8.14–$8.26 a week — and constraint 1 by having nothing to save:
like `/api/repo-spend` its only control is a span refused rather than clamped
(`src/app/api/repo-spend/route.ts:8`), so there is no `Settings` field and no
fourth door to fail silently at. Two of its three readings are one query each
over rows already on disk — 0.155 s over 124,861 rows (`00-problem.md`), 0.081 s
here with the edit split added — and the third is a field already parsed and
already on the wire, dropped at the last step.

## Shape

A pure function module, `src/lib/repoReading.ts`, modelled on
`src/lib/repoSpend.ts` line for line: the grouping takes rows plus an injected
`identify` and `describe` (`groupRunSpend`, `src/lib/repoSpend.ts:97`–`:101`),
the SQL feeding it is a separate exported reader (`runSpendSince`, `:169`), and
the docblock states in as many words that it is reporting and never a guard
(`:13`–`:16`) and is not a fourth cost source (`:18`–`:22`). A new rollup
inherits both refusals, which is constraint 5's requirement. Three readings per
repository.

**(1) Cross-run repeat reading, split by whether the run went on to edit the
file.** The split is the whole prize: `00-problem.md` establishes that 4,284 of
5,856 path-bearing `Read` calls (73.2%) were of a path an earlier run on the
same repository had already read, and that 2,168 of those — 50.6% — are files
the same run then edits, which no pointer, brief, ranking or index substitutes
for. A readout that shows 73.2% and stops has overstated its own case by a
factor of two. Per repository, taking `00-problem.md`'s query and adding
`edits AS (SELECT DISTINCT run_id, rel FROM p WHERE tool IN ('Edit','Write',
'NotebookEdit'))` plus a `LEFT JOIN edits e ON e.run_id=f.run_id AND e.rel=f.rel`:

| repo | `Read` calls | repeats | repeat, then edited | repeat, never edited |
|---|---|---|---|---|
| `/workspace/UsageFoundry` | 4,166 | 3,526 | 1,841 | **1,685** |
| `(no repo)` | 594 | 281 | 170 | 111 |
| `/workspace/GHtranslator` | 479 | 132 | 45 | 87 |
| `/workspace/VibeHub` | 414 | 239 | 58 | 181 |
| `/workspace/VisualMerge` | 189 | 102 | 54 | 48 |
| `/workspace/orient` | 14 | 4 | 0 | 4 |

The columns reconcile to `00-problem.md`'s totals exactly (5,856 / 4,284 / 2,168
/ 2,116), which is the check that the split is a decomposition and not a second
measurement. The last column is the only one any other option can address, and
on this repository it concentrates: the top ten files hold 501 of the 1,685
(`src/lib/land.ts`, at 38, is the one dropped from the five below).

| file | reads | distinct runs | repeat, never edited |
|---|---|---|---|
| `src/lib/orchestrator.ts` | 476 | 75 | 187 |
| `src/lib/workflows.ts` | 185 | 31 | 71 |
| `src/app/runs/new/page.tsx` | 96 | 22 | 40 |
| `src/app/settings/page.tsx` | 98 | 25 | 38 |
| `src/components/ui/Card.tsx` | 36 | 26 | 32 |

`Card.tsx` is the shape of the thing: 26 separate runs each opened it about
once, to learn a component's props, and almost none of them changed it.
`apiTypes.ts` (40 runs) and `db.ts` (39) are the same story further down.

**(2) `tool_error` grouped by normalised signature, counting
`COUNT(DISTINCT run_id)`.** Rows are the wrong unit — one run retrying the same
broken command eleven times is not eleven runs hitting a wall — and the
distinct-run count is what separates an install's standing fault from one run
having a bad afternoon. The event is emitted per failed tool call with
`{name, command, text, toolUseId}` (`src/lib/orchestrator.ts:6069`). Grouped per
*folder*, because `repo_root` is the wrong key (below), `SELECT r.folder,
COUNT(*), COUNT(DISTINCT e.run_id) FROM run_events e JOIN runs r ON r.id=e.run_id
WHERE e.kind='tool_error' GROUP BY 1` gives UsageFoundry 292 rows over 38 runs,
VibeHub 137/7, VisualMerge 68/14, GHtranslator 34/6, orient 5/3, workspace2 2/2.

**(3) The cycle's own prompt, rendered.** It is persisted — `emit` writes
`payload: { n: iterations, prompt, resuming: sessionId }`
(`src/lib/orchestrator.ts:6725`) — and `runEvents` hands the whole parsed
payload to the client (`src/lib/orchestrator.ts:665`). It is then thrown away at
the last step: `describeEvent`'s `iteration` case reads `p.n` and `p.resuming`
and nothing else (`src/lib/logLine.ts:252`, `:256`). Counting them —
`SELECT COUNT(*), COUNT(DISTINCT run_id), AVG(LENGTH(json_extract(payload,
'$.prompt'))), MAX(…) FROM run_events WHERE kind='iteration'` — this install
holds 500 such events across 288 runs, every one carrying a prompt, mean 3,021
characters, longest 13,719, 305 of them distinct.

Constraint 6 asks for this outright — "an operator cannot audit, correct or
distrust a memory they cannot read" — so every option here that injects text
owes reading (3) as a prerequisite. It is the cheapest piece of this option and
the only one another option cannot skip.

**Two things this option must state rather than assume.** First, the route needs
`export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`,
because it touches SQLite and, through `conflictKey`, the filesystem; the
precedent is `src/app/api/repo-spend/route.ts:4`–`:5`, and
`docs/agent/conventions.md:11` states the rule. Second, and larger:

**It must not group on `conflictKey(repo_root)` without naming the no-repo
bucket, because `repo_root` is not a repository field at all.** It is written
only where isolation resolved to a worktree —
`const repoRoot = probe.mode === "worktree" ? probe.repoRoot : null`
(`src/lib/orchestrator.ts:2890`) — so a run in the operator's own checkout of a
perfectly good repository carries `NULL`. On this install the correspondence is
exact: `SELECT folder, isolation, COUNT(*), ROUND(SUM(spent_usd),2) FROM runs
WHERE repo_root IS NULL OR repo_root='' GROUP BY 1,2` returns all 51 non-worktree
runs and nothing else — `/workspace2` 40 runs and $543.28, `/workspace/VisualMerge`
6 and $101.71, `/workspace` 5 and $0.29 — against 243 `worktree` runs that all
carry one.

`groupRunSpend` branches on that field before it ever calls `identify`
(`src/lib/repoSpend.ts:105`), so those 51 runs and $645.28 land in one row
labelled `(not a repository)` (`:40`–`:41`) — three unrelated directories, one
of which, `/workspace/VisualMerge`, also has 14 runs in a row of its own:
grouped by folder its reading is 325 calls and 176 repeats, split by `repo_root`
it reads as 189/102 in one row and 136/73 inside the bucket. This is a live
defect in shipped code, found while looking for something else, and the fix is
one line — key on `conflictKey(folder)` and reserve `NO_REPOSITORY_KEY` for a
folder that is not a repository, which is what the label already claims.

## What it learns from, and when the decision is taken

**It learns from `run_events` and `runs`, and no decision is taken at all.**
Reading (1) is `kind='tool'` rows carrying `$.input.file_path`, joined to the
same run's `Edit`/`Write` rows; (2) is `kind='tool_error'`; (3) is
`kind='iteration'`. Nothing comes from a transcript file, which keeps it off
`scanUsage()`'s cadence, and nothing from `otlp_requests`, which keeps it from
becoming a cost figure.

**The timing answer is "on a page request, never in the cycle loop", and
constraint 9 makes that load-bearing rather than a preference.** `createRun`
runs entry-to-INSERT with no `await`, and a per-repository lookup that went
there would have to be a synchronous `better-sqlite3` query. This one must not
go there for a different reason: it is a **full scan**. `run_events` carries one
index, `idx_run_events_run(run_id, id)` (`src/lib/db.ts:624`–`:625`), and every
existing reader but `StorageReport`'s bare `COUNT(*)`
(`src/lib/retention.ts:807`) is keyed on `run_id` and covered by it
(`src/lib/orchestrator.ts:621`, and the three statements it prepares). A
kind-filtered query across runs matches nothing: `EXPLAIN QUERY PLAN SELECT
COUNT(*) FROM run_events WHERE kind='tool_error'` answers `` `--SCAN run_events ``,
0.021 s over 124,861 rows. 21 ms at a card's cadence is free; at a work cycle's
it is a scan of the whole event log per spawn, growing with the install. So this
belongs to the class `settings` and `githubTokenFor` belong to — resolved
outside the loop — and specifically outside the run altogether.

## What it does to the prefix cache

**Nothing, and this is the one file in the survey where that needs no
qualification.** `01-constraints.md`'s `T* = 19·(S/D) − 20` prices an edit to
what the conversation carries; this option makes no edit, so `D = 0`, there is
no cut point and `T*` is undefined rather than large. No repository file is
written, so constraint 4's "a repository change is a cache write" is never
reached, and no text is appended at a prompt's tip.

**Its success cost, which constraint 13 demands, is paid outside the mechanism
and is real.** A readout that works ends with an operator acting on it, and the
action this install offers is a line in `CLAUDE.md` — which lands in two places
already measured here. It is delivered into the first user message of every run
in the folder, where `00-problem.md` shows the existing gates declined roughly
nine times in ten; and editing it is a repository change, so the run making the
edit pays a `gitStatus` cache write on its next cycle. Neither is chargeable to
the readout, but pricing only the idle cost is what constraint 13 exists to
prevent.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`, DONE and `needs-review`: untouched, and untouchable.** No code
path a run depends on gains a caller. `nextPrompt` is not called, the generated
notices are unchanged, `runs.reported_done` is not read, and nothing this option
writes reaches a model — which also disposes of constraint 7's hazard before it
arises, since there is no text for a later run's sentinel matcher to read.

**Retention: it adds no fourth horizon, and pays for that by going blind.**
Constraint 8's arithmetic applies unchanged: `sweepRunEvents`
(`src/lib/retention.ts:127`) issues `DELETE FROM run_events` (`:137`) for
settled runs past `eventRetentionDays`, default 30 (`src/lib/settings.ts:631`),
and the whole row goes, not merely its payload. `StorageReport` gains no arm,
which is the correct trade for a reporting surface. The cost, stated rather than
absorbed: **every reading here is a rolling thirty-day window**, so an install
that has worked one repository for a year sees only the last month of it.
Nothing here extracts before the sweep, and adding an extraction would be adding
the fourth horizon it has just avoided — a different option, not a refinement of
this one. `runs` itself never expires (`src/lib/retention.ts:30`), so the
*count* of runs stays true after the evidence behind it is gone: the asymmetry
an operator meets first is a repository with 200 runs and 40 days of reading.

## Guards, the three cost sources, and who may author it

**It carries counts, never dollars, which answers constraint 5 by construction
rather than by discipline.** A repeat-read count is not `runs.spent_usd`, not
`scanUsage()` and not `otlp_requests`, and cannot be summed with any of them
because it is not money. The moment somebody wants a dollar beside a file, the
figure has to name its source, and only `otlp_requests` prices sub-run spend at
all (`00-problem.md` prices the pre-first-edit window from it and says so). The
module inherits `repoSpend.ts:13`–`:16` verbatim: it reaches `buildSnapshot()`
nowhere, no meter reads it, `evaluateBudget` has no argument that could carry
it. A threshold on "files this repository re-reads" is a limit nobody set.

**Who may author it: nobody. There is no write side.** Constraint 7's gate is a
memory a run writes and a later run reads, closing the loop that makes a run an
author of the next run's instructions. This option has no store, in `DATA_DIR`
or in the mount; its inputs are rows the orchestrator already emits about what a
run *did*, and its only output is pixels. The one person who can act on it is
the operator, by hand, in a file they own.

## What the operator sees, and how they override it

Readings (1) and (2) are a card per repository next to `RepoSpendCard` on the
dashboard, in the same shape: `Card`, `CardTitle`, a `SegmentedControl` span
picker, a `Table` inside `ListView`'s typed `box`
(`src/components/RepoSpendCard.tsx:1`–`:13` is the import list). Two conventions
bind. A table stacking below `md` needs `Table stack` **and** a `label` on every
`Td`, or it is a column of unnamed figures — which four columns of read counts
would be exactly. And a heading over the two cards is a **region**: a `<div>`
with an `<h2>`, never a `<section>`, drawing no figure, meter or total of its
own (`docs/agent/conventions.md:46`).

Reading (3) goes on the run page, and where is decided by a fact worth checking
first. The log's `cycle` voice is a **sticky one-line group header** whose
comment says it "is the only place the log is allowed to take vertical space"
(`src/components/ui/Log.tsx:131`–`:140`), and `LogEntry` has four fields —
`voice`, `tone`, `label`, `text` (`src/lib/logLine.ts:40`–`:47`) — with nowhere
for a collapsible body. A 3,021-character mean prompt cannot be that header's
`text`. The cheap home is the Report tab: `cycleOutputs` already walks the same
`iteration` event into a per-cycle record of `n`, `ts`, `text`, `resumed`
(`src/lib/cycles.ts:20`–`:33`, `:41`, `:45`), and adding `prompt` pairs each
cycle's report with what that cycle was told, behind a `Disclosure` — what this
app writes a `<details>` as, and evidence is the affordance it is for. The loss
to state: `cycleOutputs` omits a cycle that produced no assistant text, and a
cycle killed mid-flight is precisely such a cycle, so the prompts hardest to
explain are the ones this placement drops.

**How the operator overrides it: they cannot, and there is nothing to override.**
Not a virtue dressed up — the honest weakness. The only control is the span, and
a value outside `[1, 7, 30]` is refused rather than clamped
(`src/app/api/repo-spend/route.ts:8`). Every other option here has a lever an
operator can turn off when it misbehaves; this one has no behaviour to turn off,
and no way for an operator to tell it that a repeat read it flags was right.

## How it fails, and whether loudly

**Every one of its failure modes is quiet, and that is the serious objection to
it.** A wrong mechanism produces a run that behaves oddly; a wrong readout
produces a plausible table, and a plausible table gets acted on. The four:

**The path relativiser is a string `REPLACE` on a prefix.** `00-problem.md`'s
query strips `worktree_path || '/'` from each `file_path`, so a read *outside*
the run's worktree — `/tmp`, another slot, `~/.claude` — stays absolute and
becomes its own key. Arguably correct, certainly undeclared, and
`00-problem.md` records the cousin of it: three of the twelve most-repeated
missing paths are one worktree slot reading another's.

**The signature is a 70-character prefix and over-groups.** On this repository,
excluding the bubblewrap family, five distinct runs share the one signature
`Bash :: Exit code 1 node:internal/modules/cjs/loader:1433 throw err; ^ Error:`
— and it resolves to four different missing modules: `better-sqlite3` twice,
`yaml`, a relative `./.test-build/…` require, and a literal
`undefined/lib/transcripts`. Only the first pair is one lesson (the app's lib
compiled out of tree cannot resolve `better-sqlite3`; 2 rows, 2 runs, one day).
The other three are unrelated accidents wearing one name, and the operator
reading the group would be told five runs hit a wall that two of them did.
Removing bubblewrap leaves
this repository with 156 rows across 76 signatures and 35 runs, whose largest
entry by distinct runs — 56 rows across 6 — is the worktree-slot artefact
`00-problem.md` already dismissed. **Reading (2) is honest only if it renders the
thinness rather than a top-ten list that looks like a corpus.**

**The bucket, quantified above**, whose symptom is a repository silently
reported as two. Checked directly, zero of the bucket's repeat reads cross a
folder boundary — the notes vault and VisualMerge share no relative paths — so
today's damage is mislabelling and split attribution rather than a false repeat
rate. That is luck, not design.

**The scan grows**: 21 ms today, linear in events, bounded only by the
thirty-day sweep.

The loud half is inherited: a failing route answers through `pollFailureMessage`
(`src/components/RepoSpendCard.tsx:52`–`:76`) into a `Notice` in a
`role="alert"` wrapper (`:109`), so a broken readout says so rather than
rendering zero. Zero and unknown must not be the same pixel, for the reason
`docs/agent/metering.md` refuses a 0% bar for an unknown ceiling.

## What it costs to build

By analogy with the slice it copies, the closest estimate available:
`repoSpend.ts` is 189 lines, `repoSpend.test.ts` 159, the route 30, the card
202 — 580 for a per-repository rollup, its tests, its route and its surface.
Readings (1) and (2) are that slice twice over in SQL and once in UI, so
**assumed** comparable: a few hundred lines and one card.

Reading (3) is much cheaper — a field on `CycleOutput`, one `Disclosure`, no
route, no query — and should ship first, because constraint 6 makes it a
prerequisite for three other options here rather than a feature of this one.

The test bar is the two precedents, not a general convention.
`repoSpend.test.ts` earns seven cases, the load-bearing ones being two mounts
rolling up as one repository, a run with no repository landing in a bucket
rather than being dropped, and the columns adding up to the account total over
the same span. This module owes those three plus one: that the repeat/edited
split decomposes the repeat count exactly, since that is the arithmetic the
whole readout rests on. `instanceReading.test.ts` is the precedent for testing
the SQL half against a temporary database rather than mocking it.

## What would have to be true

**Lead with the limit: a readout teaches the operator, not the run.** Nothing
here reaches a work cycle. The next run on this repository will open
`orchestrator.ts` for the 477th time whether or not a card says so. This is the
instrument every other option needs in order to be scored, and it is not itself
continuous improvement — it is the measurement that would say whether continuous
improvement is worth building, and calling it the answer to the survey's
question would be an equivocation.

For it to be the right first move, four things have to hold.

**That the operator reads it and can act.** The only action this install offers
is editing `CLAUDE.md` — which `00-problem.md` shows is both the most contended
file in the tree (54 of the 67 AI conflict resolutions carrying a path list name it) and a channel whose
existing gates are declined roughly nine times in ten. A readout whose only
downstream lever is that file has a known-weak actuator, and
`03-experiment-holdout.md` is what would establish whether the weakness is
position or content.

**That `d` stays unmeasured until someone measures it.** If a holdout run
established that a run told where to look reads materially less, the balance
shifts at once towards whichever option delivers the pointer, and this one
reverts to being that experiment's instrument rather than the recommendation.
That is the single fact that would overturn it.

**That reading (2) is presented as thin.** It is thin: 156 rows, 76 signatures,
35 runs on this repository once the environment fault is removed, the top entry
an isolation artefact. Rendered as a ranked list it reads as a corpus and
invites a mechanism the data does not support.

**That the `repo_root` finding is fixed rather than inherited.** Building
reading (1) on `groupRunSpend`'s existing branch ships a readout that is wrong
for every non-worktree run — 51 of 294 here, $645.28 — and wrong quietly. The
repair is one line and belongs in the same change.

And one thing that need not hold, which is what separates this option from every
other one: nothing here has to be true about how a model behaves. Every claim
above is about rows this app already wrote.
