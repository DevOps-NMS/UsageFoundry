# The experiment that decides this survey

Every option in this directory ends in the same place: a claim that a run told
something reads less, or gets it right sooner, or finishes in fewer cycles. None
of those is measured, and `01-constraints.md`'s last table names the missing term
— *d*, the displacement fraction — as the multiplier on every dollar any option
could claim. This file designs the measurement that would produce it, and spends
its first section arguing against the design that the question invites.

Everything below was checked against the tree at `ee93684` and against
`/data/usagefoundry.db` on 2026-08-21 through `docker exec -i usagefoundry
sqlite3 -readonly`. The corpus is `00-problem.md`'s: 294 runs over 10.761 days,
`SELECT COUNT(*), ROUND(JULIANDAY(MAX(created_at)/1000.0,'unixepoch') −
JULIANDAY(MIN(created_at)/1000.0,'unixepoch'),3) FROM runs`.

## Why three billed runs cannot answer anything

**The naive design is one task, three arms, one run each, and it has zero
degrees of freedom.** A two-sample comparison with a single observation per arm
cannot estimate the within-arm variance at all; there is no *t*, no *p*, and no
honest statement stronger than "these two runs differed". That is arithmetic
rather than pedantry, and it is the whole objection.

The empirical version is worse, because this install's task variance is enormous.
Distinct files opened per run on `/workspace/UsageFoundry` — the concentrated
folder, 190 runs that read anything — has mean 11.47 and standard deviation
15.50, a coefficient of variation of 1.35. Quartiles are 4 / 7 / 13 against a
maximum of 124. That is `00-problem.md`'s per-folder relativised `Read` query
with `COUNT(DISTINCT rel)` per run and `SQRT(AVG(k*k)−AVG(k)*AVG(k))` over it.

Take every pair of those 190 runs — all 17,955 of them, same folder, same
arm, no treatment anywhere — and **51.7% of pairs differ by at least half the
fleet mean, and 26.4% by a full fleet mean.** So an A-versus-B result reading
"the treated run opened eleven fewer files" is a result the null hypothesis
produces one time in four.

Granting the fleet variance as known — which n=1 cannot do — the naive design's
power is what the table says, against a nominal 5% false-positive rate. Three
runs at this install's mean `spent_usd` of $14.64 is about $44 of
information-free spending, and the failure is not that it is underpowered but
that it is *indistinguishable from a coin*.

| n=1 per arm, true effect | power |
|---|---|
| −30% files read | 5.3% |
| −50% files read | 5.8% |
| −100% files read | 8.2% |
| 80% power first reached at | −535% of the mean (impossible) |

The install produces roughly 27 runs a day (294 / 10.761). The design that uses
them is not three runs; it is every run, split.

## The design: a deterministic holdout, keyed on the run id

**Ship any injection behind a holdout that is a pure function of `runs.id`, so
the arm is recomputable from the row for ever and no new column, table or
retention horizon exists.** `createRun` already mints the id as
`randomUUID()` (`src/lib/orchestrator.ts:3151`), which is uniform, so a digest
over it splits the fleet evenly without a coin, a counter or a stored decision.

The idiom is already in the file. `worktreeSlug` (`src/lib/orchestrator.ts:1680`)
takes exactly this shape at `:1684` — `createHash("sha256").update(relPath)
.digest("hex").slice(0, 12)` — and `createHash` is already imported at
`src/lib/orchestrator.ts:4`. Nothing is added to the dependency list and nothing
new is learned by a reader.

```ts
/**
 * Which arm a run is in, decided by its own id and by nothing else.
 *
 * The experiment name is inside the preimage deliberately: two experiments
 * keyed on bare ids would draw the identical split, and their effects would be
 * perfectly confounded with no way to tell afterwards.
 */
export function inTreatment(runId: string, experiment: string, share = 0.5): boolean {
  const digest = createHash("sha256").update(`${experiment}:${runId}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < share;
}
```

**Where it is evaluated: at the `nextPrompt` call site,
`src/lib/orchestrator.ts:6681`, inside the cycle loop.** Three consequences
follow from that position and each answers a constraint.

It is synchronous and pure and it is not in `createRun` at all, so constraint 9
is answered by construction — no `await` goes near the folder claim.

It is recomputed each cycle from a value that cannot change, so it survives a
container restart, a `reopenRun` and a mid-cycle kill with nothing to persist and
nothing to migrate. That is the point: constraint 8 asks a store to state its
horizon, and this design's answer is that it adds no store. A `runs` row is
permanent — "Nothing here deletes a `runs` row, a review, a workflow record or a
setting" (`src/lib/retention.ts:30`–`:31`) — so the arm of a run from 2026-08-11 is
still computable in 2027, long after every event behind it has been swept.

And the treatment is *self-documenting on the wire*: `emit` writes the whole
composed prompt into the `iteration` event at `src/lib/orchestrator.ts:6724`,
payload `{ n, prompt, resuming }`, so a treated cycle carries the injected
sentence there and a held-out one does not, and the split can be audited rather
than trusted. That half-satisfies constraint 6 for free — half, because
`describeEvent`'s `iteration` case still renders only `Work cycle ${p.n}`
(`src/lib/logLine.ts:256`–`:262`), so the prompt is stored and invisible and the
readout constraint 6 demands is still owed.

## The query the app is already paying for

**The two halves of the compliance question are both already persisted, so
"did a run whose prompt named a path go on to open it" is a retroactive query
against evidence nobody wrote for the purpose.** The prompt is the `iteration`
payload above; every tool call's `file_path` is the `tool` payload
`00-problem.md` already mines. Joining them costs one statement:

```sql
WITH opens AS (
  SELECT e.run_id, e.ts,
         COALESCE(NULLIF(r.repo_root,''),'(no repo)') AS repo,
         REPLACE(json_extract(e.payload,'$.input.file_path'),
                 COALESCE(NULLIF(r.worktree_path,''),NULLIF(r.work_dir,''),r.folder)||'/','') AS rel
  FROM run_events e JOIN runs r ON r.id=e.run_id
  WHERE e.kind='tool' AND json_extract(e.payload,'$.input.file_path') IS NOT NULL),
-- The vocabulary of paths a prompt could name: anything any run on this
-- repository has ever opened. A path nobody ever opened cannot be scored.
vocab AS (SELECT DISTINCT repo, rel FROM opens WHERE rel LIKE '%/%'),
cycles AS (
  SELECT e.run_id, e.ts, json_extract(e.payload,'$.n') AS n,
         json_extract(e.payload,'$.prompt') AS prompt,
         COALESCE(NULLIF(r.repo_root,''),'(no repo)') AS repo
  FROM run_events e JOIN runs r ON r.id=e.run_id WHERE e.kind='iteration'),
named AS (
  SELECT c.run_id, c.n, c.ts, v.rel,
         CASE WHEN EXISTS (SELECT 1 FROM opens o
                WHERE o.run_id=c.run_id AND o.rel=v.rel AND o.ts>=c.ts)
              THEN 1 ELSE 0 END AS hit
  FROM cycles c JOIN vocab v ON v.repo=c.repo AND INSTR(c.prompt, v.rel) > 0)
SELECT COUNT(*) AS pairs, COUNT(DISTINCT run_id||'/'||n) AS cycles, SUM(hit) AS opened
FROM named;
```

| | |
|---|---|
| (cycle, named path) pairs | **1,014** |
| distinct cycles naming at least one path | 191 |
| pairs the run then opened, at or after that cycle's start | **632 — 62.3%** |
| wall clock over 124,861 `run_events` rows | **1.26 s** |

Dropping the `rel LIKE '%/%'` filter and admitting bare filenames raises it to
1,582 pairs across 223 cycles, 820 opened — 51.8%. The slashed-path form is the
one to use: a bare `README.md` is a substring of `docs/README.md` and the looser
form silently scores the wrong file.

**Three things about this measure make it the one worth designing around.** It
has 1,014 units where the fleet has 294, because a cycle names several paths and
each is scored separately. Its clustering is mild — the ANOVA intra-class
correlation over the 191 cycles is **ρ = 0.070**, mean cluster 5.30, so the
design effect is **1.30** rather than the 5× a heavily clustered outcome would
cost. And 138 of the 191 cycles are *partial* — some named paths opened, some
not — against 46 all-opened and 7 none-opened, which is what a low ρ looks like
from the other side and is why the pairs inside one cycle are not one
observation wearing five hats.

## The outcome measures, and what each cannot show

**Compliance.** Did the run open a path its prompt named. The query above,
baseline 62.3%. What it cannot show is whether the run needed the prompt: the
632 hits it counts include every path the run would have opened anyway. It is a
*floor test on delivery*, not a measure of effect — its whole job is to
distinguish "the injection did not work" from "the injection worked and the
reading did not move".

**Displacement *d*.** Did the run read *less*. This is the number
`01-constraints.md` says does not exist, and the trap is that it looks like the
same query. It is not: compliance counts named paths that were opened, and *d*
requires the complement — paths opened that were **not** named. Across the 316
cycle-1 prompts this install has written (`kind='iteration'` with `$.n = 1`, over
288 distinct runs — a reopened run restarts the counter), the mean run has 11.8
distinct file-opens of which **10.0 are of paths its prompt never named**, and
that 10.0 is the denominator. A treatment that raises compliance while leaving
the unnamed count flat has displaced nothing; it has added a pointer to a
conversation that then read the same files. Reporting compliance as though it
were displacement is the likeliest way this experiment misleads.

**`runs.iterations`.** Mean 1.59, sd 0.58, and the distribution is nearly
binary: 6 runs at 0 cycles, 115 at 1, 167 at 2, 5 at 3, 1 at 4. It should be
analysed as the proportion reaching a second cycle — 173/294 = 58.8% — rather
than as a mean, and it cannot show quality: a run that gave up early and a run
that finished early are the same number.

**Spend by source.** `runs.spent_usd` mean $14.64, sd $15.05. Constraint 5
governs: the experiment reports one source per figure and never a sum. Two of
the three cannot even see the treatment — `scanUsage()` has no run id, and the
`buildSnapshot()` reading is a window rather than a run — so the per-run
comparison is `runs.spent_usd`, and any statement about *which turns* moved is
OTLP and is stated separately.

**`runs.reported_done`.** 59.5% across the fleet. It cannot show whether the
task was done, only whether the agent said so, and `00-problem.md` has already
established that 102 of 277 `completed` rows carry `reported_done = 0` with
nothing on the row distinguishing them from success. As an outcome it is the
weakest of the five and belongs in the table as a guard against harm rather than
as evidence of benefit.

## How long it runs, and the answer is uncomfortable

Two-sample, α = 0.05 two-sided, 80% power, so n per arm = 15.70·σ²/δ² for a
mean and 15.70·[p₁(1−p₁)+p₂(1−p₂)]/(p₁−p₂)² for a proportion, times the design
effect where units cluster. Arrival rates are this corpus's: 94.2 pairs, 27.32
runs and 17.66 UsageFoundry runs per day. A 50% holdout means both arms fill
from that one stream, so days = 2·n_arm / rate.

| measure | effect to detect | n per arm | days |
|---|---|---|---|
| compliance, pair grain (DEFF 1.30) | 62.3% → 77.3% | 372 pairs | **7.9** |
| compliance, pair grain (DEFF 1.30) | 62.3% → 72.3% | 888 pairs | 18.8 |
| compliance, pair grain (DEFF 1.30) | 62.3% → 67.3% | 3,713 pairs | 78.8 |
| distinct file-opens, UsageFoundry | −50% (11.47 → 5.74) | 115 runs | 13.0 |
| distinct file-opens, UsageFoundry | −30% | 319 runs | 36.1 |
| distinct file-opens, UsageFoundry | −20% | 717 runs | 81.2 |
| P(reaches a 2nd cycle), fleet | 58.8% → 43.8% | 341 runs | 24.9 |
| P(reaches a 2nd cycle), fleet | 58.8% → 48.8% | 773 runs | 56.6 |
| `runs.spent_usd`, fleet | −25% (−$3.66) | 265 runs | 19.4 |
| `runs.spent_usd`, fleet | −15% | 737 runs | 54.0 |
| `runs.reported_done`, fleet | 59.5% → 69.5% | 711 runs | 52.1 |

**Read the table as a statement about which claims this install can ever
support.** A fortnight of traffic settles whether an injection is *delivered* —
a fifteen-point compliance move — and settles nothing about money. The
cost-saving claim every option in this survey wants to make needs 20% off the
reading, which is **81 days** at this install's rate, or a 25% cut in
`spent_usd` at nineteen; anything finer runs into a quarter. The holdout answers
the behaviour question in a fortnight and the economics question not at all, and
an option file that says otherwise is promising a measurement the fleet is too
small to produce.

Moving the holdout share off 50% buys nothing, because the arms cost the same.
Blocking on the folder removes the between-repository variance —
`/workspace/GHtranslator` has sd 45.45 against UsageFoundry's 15.50 — but the
fleet is already 200 runs of 294 on one folder, so the gain is small; it is
**assumed** rather than computed here that the reduction is under a fifth.

## The thirty-day sweep is a design constraint, not a footnote

**`run_events` is swept at `eventRetentionDays`, default 30
(`src/lib/settings.ts:631`), by `sweepRunEvents` (`src/lib/retention.ts:127`)
whose `DELETE FROM run_events` at `:137` takes every event of a settled run past
the cutoff.** The compliance query above reads nothing else. So an experiment
budgeted at 79 days loses its first month of evidence before its last week
arrives, and does so silently — the query still runs, still returns a number,
and the number is now about the recent half of the window.

Three answers, and the first is the one that also survives constraint 8.
**Extract nightly into a derived table**: pairs accrue at 94.2 a day, so a
hundred-day run is about 9,400 rows against an 88 MB database, and a table of
settled facts about permanent `runs` rows inherits `run_reviews`' horizon, which
is none, without adding a fourth arm to `StorageReport` — it holds one scored
pair per row, not an evidence blob. The alternatives are raising
`eventRetentionDays` for the duration, which costs disk (`tool` payloads alone
are 25 MB of the current 88 MB after 10.8 days, so a 120-day horizon is
order-of-gigabyte — an extrapolation, not a measurement), or capping the
experiment at 30 days and accepting that it answers only the compliance
question.

## Probe A — does `--max-budget-usd` bound a delegated turn?

**This is a guard question the app owes an answer to regardless of any option in
this survey, and `proposals/ContextControl/11-option-delegation-as-isolation.md:244`–`:247`
calls it "the single question that would most change this option's risk".**
`buildArgs` pushes `--max-budget-usd` at `src/lib/orchestrator.ts:4955` as
`max(0, maxRunCostUSD − spentGuardUSD)`, per invocation. If the CLI's own
accounting behind that flag counts only main-thread turns, then a run that
delegates has a ceiling that does not bound what it spends, and every budget
guard in the app is quietly optional for any agent that calls `Agent`.

**The corpus cannot answer it, and that is measured rather than assumed.**
`otlp_requests.query_source` already separates the two — 24,092 rows and
$4,010.67 at `sdk`, against 2,180 rows / $133.13 at
`agent:builtin:general-purpose`, 1,045 / $148.13 at `agent:builtin:Explore` and
46 / $3.12 at `agent:custom` — so the split is free. But only two runs in 294
have ever stopped at a spending ceiling (`stop_reason LIKE '%spending limit%'`:
`e8756d01`, cap $5, spent $8.91; `b5793951`, cap $35, spent $36.65), and
bucketing their OTLP rows between consecutive `iteration` timestamps shows
**every cycle of both at exactly $0.000 of delegated spend**. Neither run
delegated at all, so neither tests the flag.

**The probe.** One run, `maxRunCostUSD` set to $3, `maxIterations` 1, on a task
that forces delegation and nothing else — a fixed list of twenty files, each to
be read by a separate `Agent` call returning one line. Then:

```sql
SELECT query_source, ROUND(SUM(cost_usd),3), COUNT(*)
FROM otlp_requests WHERE run_id = ? GROUP BY 1;
```

If the cycle ends with `sdk` alone near $3 and delegated spend piled on top, the
flag counts main-thread turns only. If the two sum to $3, it counts everything.
**Read one source and one only:** the ceiling derives from `spentGuardUSD`, the
`runs.spent_usd` accounting, and the observation is OTLP, so the verdict is
stated in OTLP terms and never as a `runs.spent_usd` figure — constraint 5, and
the reason the two ceiling-stopped runs above are suggestive of a main-thread
overshoot and prove nothing.

**Price: bounded at $3 by the flag under test, which is the pleasing part.** If
the bound holds the probe costs $3; if it does not it costs twenty delegations,
which at this install's `agent:builtin:Explore` mean of $0.142 a request is
single-digit dollars. Budget $20 and stop the run by hand if it passes it.

## Probe B — is the gate declined for its position or for its content?

**`00-problem.md`'s closing finding is that 112 runs edited `src/lib/` and 11
read the `docs/agent/` doc the gate names — reproduced here exactly, 112 and 11
— and it explicitly does not establish whether the cause is position or
content.** That is the fact deciding between the options which rewrite the
sentence and the option which moves it, and the two are confounded in every
observation this install has: the gate is one wording in one position, so no
reading of the corpus can separate them.

**The separation is a 2×2, and it costs the same as the two-arm design it
replaces.** Factor POSITION: the sentence at the tip of the cycle-1 prompt, as
today, versus the same sentence delivered just in time by a `PreToolUse` hook on
`Edit`/`Write` under `src/lib/`. Factor CONTENT: the sentence as it stands
versus a rewrite naming the specific consequence rather than the rule. Each main
effect is tested on the whole sample, so both questions fall out of one design.

| | current wording | rewritten |
|---|---|---|
| **cycle-1 prefix** | today's install | content effect, position held |
| **just-in-time hook** | position effect, content held | both |

An interaction — the hook helping only with the rewrite — is itself the answer
that neither option alone is enough, and the factorial is the only design that
can report it.

Three mechanics the probe has to get right, all of them constraints this survey
already carries. The hook arm reaches the cycle through `--settings`, because
that survives `--resume` and `--plugin-dir` does not (constraint 2), merged into
the one composer that also emits the sandbox overlay rather than added as a
second flag (constraint 3). And it is **invisible on the run's log by
construction**: `src/lib/orchestrator.ts:6208` logs a `hook_response` only when
`ev.hook_event` is `SessionStart` or `UserPromptSubmit` (`:6210`), the comment
above saying why `PreToolUse` is excluded — it fires on every tool call and would
bury the run's own output. So the probe cannot assume delivery; it must confirm
from the transcript that each treated run's hook fired before scoring it. And
`--include-hook-events` appears nowhere in `src/` (`grep -rn
"include-hook-events" src/` → 0), so shipping the arm without that flag ships an
unobservable treatment.

**Price.** The outcome is binary per run — did a run that edited `src/lib/` read
any `docs/agent/*.md` — against a baseline of 11/112 = 9.8%, and a low baseline
is cheap to move away from.

| effect to detect | n per level | runs total | worst case at a $6 cap | at the median |
|---|---|---|---|---|
| 9.8% → 50% | 33 | 66 | $395 | $179 |
| 9.8% → 40% | 57 | 113 | $680 | $308 |
| 9.8% → 30% | 115 | 230 | $1,381 | $626 |
| 9.8% → 25% | 188 | 376 | $2,257 | $1,023 |

The $6 cap is not arbitrary: main-thread OTLP spend before a run's first
`Edit`/`Write` on this folder is median **$2.72**, mean $3.07, p90 **$5.39**
over 177 runs, so $6 covers nine runs in ten to the moment the outcome is
decided, and `--max-budget-usd` makes the worst case a multiplication rather
than a hope. The cap also introduces the probe's one real bias: a run cut off
before its first edit produces no observation at all, and if the treatment
changes how long a run takes to reach an edit then the censoring is not random.
Score censored runs as a reported figure, not a silent drop.

**This is the expensive probe, and the survey should say so rather than round it
down.** Detecting a move to 40% compliance costs about $308 at the median and is
bounded at $680; detecting a move to 25% costs three times that. There is no
version of this measurement that is single-digit dollars, because the effect
being tested is a behaviour whose baseline is one run in ten.

## What this design cannot settle

**It cannot price anything on its own.** Every money row of the power table
needs a month or more of traffic and the survey's recommendation will land
first. What the holdout delivers inside a fortnight is a compliance verdict —
the injection is read, or it is not — which is enough to close the options it
refutes and not enough to open the ones it does not. It also cannot tell a
treatment that helps from one that merely reorders: the displacement
denominator is a count of unnamed file-opens, and a run that reads the same ten
files in a different order scores identically.

**It measures one install, at 200 runs of 294 on one repository.** The
compliance baseline of 62.3% and the ICC of 0.070 are properties of this corpus,
and the direction of the error elsewhere is not obvious — more folders means
more between-run variance and a longer experiment, but also a lower
repeat-reading rate and therefore less for any option to displace.

**And it is a measurement of injections, not of memory.** Every option that
proposes a store rather than a sentence — a retrospective, a brief, a
per-repository index — is measured here only through the sentence it eventually
puts in front of a model. If an option's value is that the store is *right*
rather than that the run reads it, this design reports the compliance and says
nothing about the correctness, and that half of its case belongs somewhere other
than here.
