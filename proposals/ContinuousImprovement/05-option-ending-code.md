# Option B — an `ending_code` column on `runs`

One nullable `TEXT` column, written from the branch that already decided how the
run ended, cleared when the run is picked up again. It injects no text, spawns
nothing, reads nothing, and adds no horizon. It is the smallest thing in this
survey and it is not a learning mechanism at all — it is the *selector* that
three other options in this survey need before they can name the runs they
propose to learn from, and it is worth reading in that light rather than as a
candidate answer to the survey's question.

## The strongest case

**The app already computes how every run ended and then throws the machine-readable
half away.** `evaluateBudget` returns a `BudgetVerdict` carrying a closed union,
`BudgetStopCode` (`src/lib/budget.ts:138`–`:150`: ten members, from
`weekly_fraction` to `no_terminus`), and the loop emits it on a `budget` event
before it breaks — but what lands on the row is `verdict.reason`, a sentence
(`src/lib/orchestrator.ts:6575`, and again for the install ceiling at `:6614`).
The code goes onto the event log, and the event log expires: `sweepRunEvents`
`DELETE`s `run_events` rows for settled runs past `eventRetentionDays`
(`src/lib/retention.ts:137`), default 30 (`src/lib/settings.ts:631`), where the
`runs` row is permanent by design — "Nothing here deletes a `runs` row, a review,
a workflow record or a setting" (`src/lib/retention.ts:29`–`:32`). So this
install's guard codes have a thirty-day life and the rows they describe do not.
Measured, over the whole corpus:

```sql
SELECT json_extract(payload,'$.code'), json_extract(payload,'$.allowed'),
       COUNT(*), COUNT(DISTINCT run_id)
FROM run_events WHERE kind='budget' GROUP BY 1,2 ORDER BY 3 DESC;
-- (null)|1|500|288   run_cost|0|5|5   session_fraction|0|1|1
```

**The one machine-readable ending field this app does have is silently wrong on
twenty of this install's 294 rows, and only the prose knows it.** `reported_done`
was added as `INTEGER NOT NULL DEFAULT 0` (`src/lib/db.ts:722`), and its own
comment states the consequence in as many words — "Rows written before this
column read as false" (`:718`) — with the direction chosen deliberately, because
the wrong way round costs a billed cycle rather than a wrong prompt (`:718`–`:721`).
On this install that clause has twenty instances:

```sql
SELECT status, reported_done, COUNT(*), SUBSTR(COALESCE(stop_reason,'(null)'),1,64)
FROM runs GROUP BY 1,2,4 ORDER BY 3 DESC;
-- completed|0|20|Agent reported the task complete.
```

Twenty rows whose `stop_reason` is the sentence only the DONE branch writes
(`src/lib/orchestrator.ts:7273`, the sole writer of that string in `src/`) and
whose `reported_done` reads 0. The boundary is clean: the last of the twenty
finished at 2026-08-11 20:09:53, the first row ever carrying `reported_done=1`
finished at 20:58:22 the same day, and `git log -S 'addColumn(db, "runs",
"reported_done"' -- src/lib/db.ts` dates the column to commit `4f46b80`,
2026-08-11. They are worth $46.29 of the install's spend. This is not an argument
against columns; it is the argument for what shape this one takes, and it is
answered below.

**And the ending class with the volume is the one nothing can name.**
`00-problem.md` counts 102 of 277 `completed` runs at `reported_done = 0`.
Reconstructing what an `ending_code` would actually have carried — by hand, from
the prose, which is exactly the parse `src/lib/db.ts:992`–`:995` forbids the app
from doing and which is done once here as a proposal rather than as code — the
294 rows fall out as:

| would-be code | n | `runs.spent_usd` |
|---|---|---|
| `done` | 195 — the 175 at `reported_done=1`, plus the twenty above | — |
| `cycle-cap` | 83 | $1,334.08 (the 82 `completed` ones) |
| `operator-stop` | 8 | — |
| `dependency-blocked` | 3 | $0.00 |
| `run-guard` (`run_cost`) | 2 | — |
| `exit-code` | 1 | — |
| `worktree-gone` | 1 | — |
| `needs-review` | 1 | $0.29 |

One row in that reconstruction disagrees with the status beside it — a
2026-08-10 row carrying the cycle-cap sentence under status `stopped` — and this
file does not explain it. Aggregated the other way, **$1,380.37 of the $4,236.62
across this install's `completed` runs sits in an ending class the row cannot
name** — `completed` with
`reported_done = 0` — against $2,856.25 that reported the task done.

```sql
SELECT CASE WHEN status='completed' AND reported_done=1 THEN 'done'
            WHEN status='completed' AND reported_done=0 THEN 'cap/other-completed'
            ELSE status END AS cls, COUNT(*), ROUND(SUM(spent_usd),2) FROM runs GROUP BY 1;
```

**One correction to `00-problem.md`, in the direction that weakens this option.**
Its "what this app can see today" table says the finished/ran-out distinction is
visible **nowhere**. On the run's own page it is: `describeRun`'s `completed`
branch reads `run.reported_done` and returns either "Reported the task complete"
or "Used all N work cycles", with a comment saying calling the second one
complete "would be a lie" (`src/app/runs/[id]/page.tsx:239`–`:264`), and the
Resume button renames itself off the same boolean (`:808`, `:817`–`:822`). What
does not exist is any way to ask the question of *more than one run*: the runs
list draws `StatusMark`, whose entire prop surface is `{ status }`
(`src/components/StatusMark.tsx:108`). The gap is aggregate, not per-run, and
this option closes the aggregate half only.

## Shape

Three edits, and nothing else in `src/` changes.

```ts
addColumn(db, "runs", "ending_code", "TEXT");
```

placed beside `needs_review_reason` (`src/lib/db.ts:1062`), whose comment at
`:1056`–`:1061` already establishes every schema fact this needs: "`runs.status`
carries no CHECK constraint, so the new status itself is additive at the schema
level… `addColumn` reads the live schema, is not keyed on `SCHEMA_VERSION` and
destroys nothing, so it needs no transaction and no version bump — that constant
records that a *rebuild* completed, and this is not one." The helper is thirteen
lines and idempotent: `PRAGMA table_info`, then `ALTER TABLE … ADD COLUMN` only
if absent (`src/lib/db.ts:1320`–`:1332`). The no-CHECK claim holds against the
live database as well as against the comment —

```sql
SELECT sql FROM sqlite_master WHERE type='table' AND name='runs';
```

— which shows the original sixteen-column `CREATE TABLE` followed by thirty
`ALTER`-added columns and no constraint on `status`. `PRAGMA table_info('runs')`
counts 46; `ending_code` would be the forty-seventh.

**Nullable `TEXT`, no default, and that is the load-bearing part of the shape.**
`reported_done`'s `NOT NULL DEFAULT 0` is what makes the twenty rows above lie:
a defaulted column cannot distinguish "this ending was not that" from "this row
predates the column". `NULL` says *not recorded* and nothing else, so the
backfill problem becomes a display problem instead of a wrong answer, and the
same property covers the second failure mode — a `break` added later that forgets
to set a code writes `NULL` rather than something plausible.

The write goes into the existing `carried` object (`src/lib/orchestrator.ts:7334`),
one line under `needs_review_reason` (`:7346`) and inheriting its comment
verbatim: "Written on every ending, not only the one that sets it: the column
describes the ending this row records, so a run picked up and finished some other
way must not keep the reason its previous segment left" (`:7343`–`:7345`).
`carried` is spread into both `setStatus` calls, the paused one and the terminal
one (`:7357`–`:7375`), and `setStatus` builds its `UPDATE` by iterating
`Object.entries(patch)` (`:679`–`:689`), so no SQL is written by hand and the
value rides the emitted `status` event for free (`:688`).

The vocabulary is not a design question; it is an enumeration of the `break`
sites already in the loop at `:6485`, each of which already sets `finalStatus`
and a sentence:

| line | today's status | code |
|---|---|---|
| `:6439` (`applyInterrupt`) | `stopped` / `failed` / `paused` | `operator-stop`, `deadline` |
| `:6575`–`:6588` | `paused` / `blocked` / `stopped` | the `BudgetStopCode` itself |
| `:6614`–`:6616` | `blocked` / `stopped` | `install_cost` |
| `:7030` | `stopped` | `cli-budget` |
| `:7141` | `paused` | `allowance-wall` |
| `:7174` | `failed` | `refusal` + `plan.cause` |
| `:7223` | `failed` | `exit-code` / `resume-failed` |
| `:7256` | `needs-review` | `needs-review` |
| `:7274` | `completed` | `done` |
| `:7292` | `completed` | `cycle-cap` |
| `:7298` (`catch`) | `failed` | `threw` |

And `reopenRun` clears it in the same `UPDATE` that clears `stop_reason` and
`needs_review_reason` (`src/lib/orchestrator.ts:8294`–`:8301`), for the reason
already written there: "a reopened run may end without re-entering the loop at
all — stopped while queued, closed out by a boot — after which a reason left
behind would be describing an ending two segments old."

Nothing else needs touching. Every reader of the table is `SELECT *`
(`src/lib/orchestrator.ts:605`–`:607` and `src/lib/fleet.ts:72` among twelve such
call sites — `grep -rn "SELECT \* FROM runs" src/` returns twelve lines), so
the column arrives on every existing payload the moment the field is added to
`RunRow` and to `RunDTO` beside `reported_done` (`src/lib/apiTypes.ts:631`).

## What it learns from, and when the decision is taken

It learns from nothing. It records, once, at the moment the loop already knows
the answer, and the decision is taken at the `break` rather than derived later —
which is the whole point, because at the `break` the code is a local variable and
after it the only surviving evidence is a sentence written for a human.

The write is inside `startRun`'s `finally`, on the same synchronous
`better-sqlite3` statement that already writes thirteen other fields. It is
therefore in neither of the two classes constraint 9 asks an option to declare:
it is not resolved once before the cycle loop like `settings`
(`src/lib/orchestrator.ts:6452`) nor re-resolved per cycle like
`enabledPluginDirs()` (`:6763`), because it is not resolved at all. And it is
nowhere near `createRun` (`src/lib/orchestrator.ts:3124`), so the no-`await`
invariant is untouched.

## What it does to the prefix cache

Nothing, and unusually for this survey that sentence needs no qualification.
Constraint 4 prices a repository change as a cache write and text at the tip of a
prompt as `T* = −1`; this option writes neither. No file in the tree changes, no
prompt gains a character, `D = 0` and `T*` is undefined rather than large.

The honest other half: for the same reason it cannot save anything. There is no
`d` to multiply by because nothing is displaced. Every dollar figure in this file
is a description of the corpus, not a claim on it.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: untouched.** `sessionId` is read and written by `adoptSession`
(`src/lib/orchestrator.ts:6430`–`:6434`) exactly as now; nothing here reads or
writes it, and no argv is composed.

**Retention: no fourth horizon, and one asymmetry worth naming.** The column
lives on `runs`, which is never swept (`src/lib/retention.ts:29`–`:32`), so
`StorageReport` gains no arm and constraint 8 is answered by inheritance. The
asymmetry is that the *code* then outlives the *evidence for it*: the `budget`
event carrying `run_cost` is deleted at thirty days while the row saying
`run-guard` is permanent. That is the property that makes the column worth having
— it is the extract-before-the-sweep that constraint 8 asks any `tool_error`
miner to perform, done for one field at zero cost — and it is also the hazard: a
year-old `refusal` code with no `error` event behind it cannot be audited.

**The DONE contract: derived from it, and must not become a second source of
truth.** `reported_done` has three live readers — the run page twice
(`src/app/runs/[id]/page.tsx:240`, `:808`), `reopenPrompt`'s pushback branch
(`src/lib/orchestrator.ts:8070`, fed from the row at `:8271`), and `loopPasses`
inside `src/lib/workflows.ts:4583`, where `planLoopPass` stops on
`runs.reported_done` and never on `completed`. If `ending_code` were allowed to
answer any of those, two fields would describe one fact and could drift; the
proposal is therefore strictly additive — the column is written and **nothing in
`src/` reads it on day one**. That is a real cost, stated plainly in the last
section, not a hedge.

**`needs-review`: same branch, same invariant, no new rung.** The code is set at
`:7249`–`:7256` beside `needsReviewReason = clipReason(res.finalText)`, below
every refusal and exit-code test and above `DONE`, and it clears nothing that
branch does not already clear. `docs/agent/run-lifecycle.md` records the
placement and the `reportedDone = false` trap; this option adds one assignment
inside a branch that already exists and changes no ordering.

## Guards, the three cost sources, and who may author it

**Not a guard, by construction.** The column is written in the `finally`, after
the last guard check of the run's life; nothing in `evaluateBudget` has an
argument that could carry it, and no meter reads it. `repoSpend.ts:13`–`:22` is
the precedent constraint 5 names — "**This is reporting and never a guard.** It
is derived from `runs`, it reaches `buildSnapshot()` nowhere" — and this inherits
that refusal on easier terms, because it carries no number at all.

**Not a fourth cost source, because it is not a cost.** It is a label. Any page
that shows spend beside it goes on reading `runs.spent_usd` and says so, exactly
as `repoSpend` does; the three sources stay apart because nothing here touches
them.

**Author: the orchestrator, from a closed union, with one narrow model channel
that should be named rather than glossed.** Every value comes from a `break` in
`src/lib/orchestrator.ts`; no run writes a code and no run reads one, so
constraint 7's loop — a memory a run writes and a later run reads — is not closed
by this option. The channel that does exist is `cycleEnding` (`:4543`): an agent
printing `DONE` or `NEEDS_REVIEW` alone on a line selects between two of the
codes in the table above. That is not authorship — it cannot produce a value
outside the union, or any free text — but an option downstream that selects "the
runs on this repository that went badly" would be giving the model a one-bit
lever over its own inclusion in that set — a fact about the *downstream* option's
design, inherited from here.

## What the operator sees, and how they override it

There is nothing to override, which is both the clean answer and the weakness:
the column records what happened, and an operator who disagrees with it
disagrees with the branch that ran. The remedy is the one they have today —
reopen the run, which clears the field.

What they would *see* depends entirely on what is built on top, because on its
own the column changes no pixel. The run page already draws the only distinction
it could draw for one run (`src/app/runs/[id]/page.tsx:239`–`:264`) and the list
cannot draw any (`src/components/StatusMark.tsx:108`); the cheapest thing worth
adding is a filter or a grouping on the runs list, at which point the eight-row
table above becomes a page rather than a hand-run query. That is a separate
build and is deliberately not counted below.

**On the log, constraint 6 is answered only half.** `setStatus` emits the whole
patch on the `status` event (`src/lib/orchestrator.ts:688`), so the code is on
the wire; but `describeEvent`'s `status` case renders `${p.status} — ${why}` with
`why = p.stop_reason ?? p.message` (`src/lib/logLine.ts:505`–`:516`), so the code
would be present and unrendered. Constraint 6's force is aimed at mechanisms
whose misbehaviour reads as the agent being stupid, and this one has no
behaviour to misbehave — the sentence the operator needs is already on that line.
Naming the code beside it is one string change and should ship with the column,
because a field that nothing renders is how the twenty rows above have gone on
reading wrong for the ten days since the last of them was written.

## How it fails, and whether loudly

Silently, in three ways, all of them survivable and one of them measured.

The first is the migration lie, and `NULL` is the whole answer to it: a row that
predates the column reads as unrecorded rather than as `done`. The twenty rows
this install carries are the counterexample of what happens when the default is a
value instead.

The second is a `break` site added later that sets `finalStatus` and forgets the
code. TypeScript cannot catch this — an omitted property on a `Partial<RunRow>`
is legal, and there is no exhaustiveness check available at a `break`. The
detection is `NULL` on a terminal row, which is a query anyone can run and
nothing surfaces on its own; the honest mitigation is a unit test in the style of
the three that already pin `reported_done` (`src/lib/orchestrator.test.ts:1038`,
`:1206`, `:1285`–`:1297`), asserting a code on each ending the existing loop
tests already reach.

The third is drift against `reported_done`, and it is only reachable if somebody
later lets the column answer a question the boolean answers. Keeping the column
read by nothing makes drift undetectable but also harmless; making it the single
source of truth makes it detectable but is a much larger change touching
`reopenPrompt`, the run page and `planLoopPass`. This proposal takes the first,
and names the choice rather than pretending there is no cost.

Nothing here throws, nothing degrades a run, and there is no state in which the
column's absence stops a run from finishing.

## What it costs to build

Three edits — one `addColumn` line with its comment, one field in `carried` plus
eleven assignments at the `break` sites, one `ending_code=NULL` in `reopenRun`'s
`UPDATE` — plus two type members and one test. Call it forty lines with the
comments this codebase's style requires. No route changes, because every read is
`SELECT *`; no settings field, so none of constraint 1's four doors is opened; no
argv, so constraints 2 and 3 do not apply; no file in a mount, so constraints 10
and 11 do not apply.

Its running cost is zero on every axis this survey scores. No tool definition, so
none of constraint 12's **$8.14–$8.26 per definition per week**. No text, so
nothing at the 0.1× carry rate. And constraint 13's question — what it costs when
it *works* — has the unusual answer of zero, because a run's behaviour is
identical with and without it. The reason it can say that is the same reason it
saves nothing.

The costs that are real are structural. A forty-seventh column on `runs`, on a
table that has already grown thirty columns past its `CREATE`. A second field
describing an ending, where one exists. And a field with no reader, which in this
codebase is the shape most likely to be quietly wrong for a fortnight — as it was.

## What would have to be true

**This is a selector, not a learning mechanism, and on its own it teaches only the
operator.** Nothing about it stops a run re-deriving what an earlier run
established; it makes the population of badly-ended runs *addressable*, which is
a precondition for three options in this survey and an answer to none of them.
Judged against the survey's own question it should lose.

For it to be worth shipping **alone**, an operator would have to want a cross-run
ending question that the run page cannot answer, often enough to justify a column
nothing reads. The evidence for that appetite on this install is thin and should
be stated at its weakest: the ending signal designed to be read across runs,
`needs_review_reason`, has exactly **one** populated cell in 294 rows, and
`restart_closed` — the other ending-fact column, added for a bulk reader — is set
on **zero**. The class with the volume is cycle-cap exhaustion, 83 rows, of
which the 82 `completed` ones are $1,334.08 — and the operator response to that
is to raise a cap, a per-run decision they already make from the run page.

**So the recommendation is to fold it into whichever actuator ships first, not to
ship it alone.** Every option here that proposes to act on "the last N runs on
this repository that went badly" — a retrospective, a per-repository brief, a
digest — needs this column as its `WHERE` clause, and each of them can carry
forty lines without noticing. Shipped that way the column arrives with a reader,
which is the one thing that would have caught its own predecessor's twenty wrong
rows in a day rather than leaving them uncorrected ten days later.

**What would overturn this:** a measurement, which nobody has taken, that the
ending distribution *moves* — that the cycle-cap class is not a stable 28% of
runs but something an operator would act on if they could see it weekly. If a
per-repository ending rollup changed a cap, a template or a guard even a handful
of times, the column stops being a selector and becomes the cheapest actuator in
the survey. Nothing in this repository measures that, and the eleven-day corpus
is too short to, so it is assumed absent rather than shown to be.
