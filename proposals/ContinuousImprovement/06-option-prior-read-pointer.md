# Option C — a generated prior-read ranking in the cycle-1 prompt

One pure function, one query, and about 1.2KB of generated text at the tip of a
fresh conversation: the twenty files earlier runs on this repository opened
most, most-recent-weighted, named and nothing more. No file in the tree, no
hook, no tool, no model call, nothing that survives past the first user message.

Every line number below was opened at `ee93684`. The tree moved twice while this
was being written, so where this file and a sibling disagree — `01-constraints.md`'s
constraint 9 cites `orchestrator.ts:6379`/`:6402`/`:6690` for three sites now at
`:6452`/`:6475`/`:6763` — the sibling is older, not wrong.

## The strongest case

**It is the only mechanism in this survey whose central claim has already been
measured rather than argued, and I reproduced the measurement independently
before writing this.** `00-problem.md`'s prequential scorer — for each run in
`created_at` order, a top-K built only from strictly earlier runs on the same
repository, scored against that run's first eight `Read` calls — re-runs to
within a point:

| ranking rule | top-20 | top-40 | `00-problem.md` |
|---|---|---|---|
| by distinct earlier runs | 39.3% | 52.1% | 39.2% / 51.6% |
| by raw earlier read calls | 42.4% | 54.1% | 42.3% / 53.9% |
| by read calls, ×0.9 decay per intervening run | **45.7%** | **59.5%** | 45.0% / 59.0% |
| ×0.9 decay, main-thread reads only, both sides | **46.5%** | **60.0%** | — |

263 runs scored, 1,828 opening reads, from a `run_events` dump scored by `python3
/tmp/score.py`. The 0.7-point gap on the decay rule at top-20 exceeds the ~0.2
points of tie-break noise `00-problem.md` flags and I did not chase it; the
ordering of the three rules is identical, which is the part that decides
anything. **Recency beats volume**, and the shipped rule is therefore the decayed
one, not the popular one.

**And this install has already run the closest available experiment on the exact
slot this option would use, at the exact grain, and it came back 21×.**
`continuedWorkNotice` (`src/lib/orchestrator.ts:4401`) is generated text injected
into the session-less join at `:4338`, one slot above where this block would go.
It names two commands, one of them an unusual one — `git diff --stat
<base>...HEAD`. Sixty-six runs on this install met its three conditions
(`continues_run` set, `isolation = 'worktree'`, a branch recorded); 217 did not:

| at any point in the run | got the notice (n=66) | matched control (n=175) |
|---|---|---|
| ran any `git log` | 66 — **100%** | 159 — 90.9% |
| ran `git diff --stat <base>...HEAD`, the exact form | 56 — **84.8%** | 7 — **4.0%** |

All 56 used the triple-dot range verbatim. `git log` is
confounded — a run continuing a branch might run it anyway — but `git diff
--stat` is not plausibly a coincidence at a 4.0% baseline, and the copied
argument form settles it. Generated text at this position, on this install, is
read and acted on.

**Its ceiling must be stated here rather than buried, and it is severe.**
`00-problem.md` measures that 50.6% of cross-run repeat reads are of a file the
same run then edits, which no pointer displaces. Scored against the ranking
itself it is worse: of the top-20's 842 hits, **496 — 58.9% — are files the
scored run then `Edit`s or `Write`s**, so only 41.1% of what the ranking gets
right is even a candidate for displacement, or 19.1% of opening reads, before
anything is said about behaviour. And constraint 13's *d* does not exist. So
**this is orientation, not saving**: it claims no dollar, only that a fresh agent
in a repository it has no memory of currently opens `CLAUDE.md` and then guesses.
Any row in `15-comparison.md` that gives it a saving is reading it wrong.

**The prior it has to survive is `00-problem.md`'s 101-of-112 gate decline, and
the honest answer is not the one I expected.** A generated block at cycle 1 is
exactly the position that was declined 90% of the time. The distinction usually
offered is facts versus instruction — this block reports what earlier runs
opened, where CLAUDE.md's gate tells a run to go and read something — and it does
not survive contact with the evidence above: `continuedWorkNotice`'s generated
half contains a bare imperative, "Before doing anything, read it:"
(`src/lib/orchestrator.ts:4410`), and is obeyed 85% of the time. Whatever
separates it from the gate is not the mood of the verb.

The split that fits both observations is **generated-and-specific versus
static-and-conditional**: the notice names one command with its argument already
filled in and a reason attached; the gate names a class of documents behind a
condition the agent must evaluate about its own future behaviour ("if you are
about to touch the files named"). If that is the mechanism, this option is on the
wrong side of it — twenty paths with no action attached sit closer to the gate
than to the notice. **That is untested**, and `03-experiment-holdout.md` is the
file that would test it.

## Shape

A pure function, one query, one slot in an existing composer, one boolean, and a
prerequisite that belongs to another option.

`rankPriorReads(repoKey)` returns an ordered list of relative paths with the
number of distinct earlier runs behind each, fed by one SQL over `run_events` —
the payload of a `kind = 'tool'` row carries the whole tool input (`emit` at
`src/lib/orchestrator.ts:482`, the `tool` case at `:6020`), so a `Read`'s
`file_path` is already in the database and no transcript parse is needed.
`clipToolInput` bounds the stored input at 4,000 characters
(`src/lib/logLine.ts:104`) but puts `file_path` second in `HEADLINE_FIELDS`
(`:57`–`:67`), so it can never be the field the budget runs out on; measured,
zero of the 5,867 stored `Read` calls carry a `truncatedFrom`.

Four filters, each with a measured reason:

1. **Key on `COALESCE(NULLIF(repo_root,''), folder)`, never `repo_root` alone.**
   51 of 294 runs carry no `repo_root`, and six of them are on
   `/workspace/VisualMerge`, which also has 14 runs that do — so keying on
   `repo_root` splits one folder's history into two rankings with nothing saying
   so.
2. **Main-thread reads only.** 1,634 of 5,867 `Read` calls (27.8%) carry a
   `parentToolUseId` and are a sub-agent's. A sub-agent gets its own fresh
   context and never sees this block, so ranking the main thread on what
   sub-agents opened is a category error. It is also worth 0.8 points at top-20.
3. **Containment, at use time.** 600 of 5,856 path-bearing reads (10.2%) name a
   path outside the run's own worktree. `resolveInMount`
   (`src/lib/orchestrator.ts:707`) is the idiom, not the function — it ends in
   `isDirectory()` at `:746` — but its two-phase shape ports directly, and
   `realpathSync` at `:733` throws for a path that is gone, so one call per
   candidate buys containment and existence together.
4. **Existence.** Of the 466 distinct paths UsageFoundry runs have read, **185
   (39.7%) are not in the tree today.**

Rendered, filtered, for this repository as of the corpus end: a one-line
generated header, then twenty indented paths each annotated with the number of
distinct runs behind it. **1,254 bytes.** The header carries the whole of the
fact/instruction distinction and has to, because nothing else does:

> The 20 files that earlier runs on this repository opened most, most-recent
> weighted. This is a record of where work has happened, not an instruction to
> read any of them.

The slot is `src/lib/orchestrator.ts:4340`, immediately before `o.task`, inside
the session-less branch at `:4331`–`:4350`. That puts it in the orientation group
with `continuedWorkNotice` (`:4338`) and `priorWorkNotice` (`:4339`) — the two
notices that already say "here is what is on this branch and who put it there" —
rather than after the task, where `COMPLETION_NOTICE` (`:4466`) and
`NEEDS_REVIEW_NOTICE` (`:4506`) sit and where the comment at `:4342`–`:4343` says
text reads as a statement about the task rather than a preamble to it. The
tension is worth naming: before the task is where a preamble goes, and a preamble
is what an instruction looks like. The header is the only thing holding that
line.

Top-20 rather than top-40, despite top-40 measuring 13.5 points better. Forty
paths is roughly 2,400 bytes for a list whose second half, on this install, is
almost entirely one recent survey's working set — see the failure section.

## What it learns from, and when the decision is taken

It learns from `run_events` rows of kind `tool` and name `Read`, on runs sharing
this run's repository key, weighted ×0.9 per intervening run. Nothing else: no
model reads the corpus, no summary is written, no row is added to any table.

**The lookup belongs in the once-per-run class, beside `settings` at
`src/lib/orchestrator.ts:6452` and `githubTokenFor` at `:6475`, not in the
per-cycle class with `enabledPluginDirs()` at `:6763`.** Constraint 9 asks for
that decision and the loop settles it: `sessionId` is initialised from the row at
`:6392` and only ever moves forward through `adoptSession` (`:6430`), which is
called with a session id off the stream — within one `startRun` invocation it can
never return to null. The session-less branch of `nextPrompt` therefore fires at
most once per invocation, and re-resolving per cycle would pay the query on every
cycle for a value every cycle but the first discards. The per-cycle argument that
carries `--plugin-dir` — a run outliving the list it started under — does not
apply, because the block is not re-sent.

It is not inside `createRun`, so constraint 9's `await` rule is not engaged; it
satisfies it anyway. Measured live, the whole lookup — join, relativisation,
decay, group and sort — runs in **41–53 ms over 124,861 `run_events` rows across
three consecutive runs** (`docker exec -i usagefoundry sqlite3 -readonly
/data/usagefoundry.db < /tmp/timing.sql`, `.timer on`). That is a full scan: the
only index is `idx_run_events_run` on `(run_id, id)` (`src/lib/db.ts:624`–`:625`)
and there is none on `kind`. Fifty synchronous milliseconds once per run, on a
path already doing `ensureWorktree` and a credential lookup, does not justify an
index migration — but a ten-fold-larger install would need one, and this option
should say so rather than discover it.

## What it does to the prefix cache

Nothing, on the cheapest terms available to any injecting option in this survey.
The block lands in the first user message of a conversation that does not yet
exist, so there is no suffix to invalidate: `D = 0`, and constraint 4's `T* =
19·(S/D) − 20` is undefined rather than large.
`proposals/ContextControl/02-levers-on-the-pin.md:462` puts a `cache_control`
breakpoint on `msg0.3`, "the prompt this app sent", on a session's first request,
so the block sits inside the cached region from the second turn onward. It
touches no file in the tree, so it never moves `gitStatus` inside `sys[2]` and
never causes the whole-suffix re-write constraint 4 prices.

It does *ride* one. The same file (`:468`–`:470`) notes that on a resumed request
the third mark moves to the newest message, so the first user message falls
inside the prefix `sys[2]` breaks — every cycle whose predecessor changed the
repository re-writes this block along with everything else. At 1,254 bytes and
the 0.374 tokens-per-byte fit from
`proposals/ContextControl/05-option-trim-injected-text.md:100` that is **469
tokens**, and at `claude-opus-5`'s $5 per million input (`src/lib/pricing.ts:38`)
and the 2.0× one-hour write multiplier (`src/lib/pricing.ts:18`) it adds
**$0.0047 to each re-write**, against the median handover write of 231,644 tokens
at $2.32 (`…05-option-trim-injected-text.md:110`) — two-tenths of one percent of
a re-write it did not cause.

Full carrying cost per run: $0.0047 written, plus 469 tokens read at 0.1× across
a mean of **102.6 OTLP requests per run** over the 285 runs with telemetry
(`SELECT ROUND(COUNT(*)*1.0/COUNT(DISTINCT run_id),1) FROM otlp_requests`), which
is $0.0241. **About $0.029 a run, $8.45 across the 294-run corpus, 0.20% of the
$4,303.70 this install spent in eleven days** — roughly $5.40 a week, or
two-thirds of what constraint 12 prices a single standing tool definition at.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: satisfied for free, and this is where the option is strictly better
than a hook-shaped or plugin-shaped sibling.** The block is part of the
conversation, not the argv, so constraint 2 never engages: no flag to re-send and
no `--plugin-dir`-style silent single firing. `buildArgs` and `sandboxArgs` are
untouched, so constraint 3 is moot.

One live interaction, and it is new. `--autocompact 200000` shipped at `ee93684`
(`AUTOCOMPACT_WINDOW_TOKENS`, `src/lib/orchestrator.ts:4795`, pushed onto the
argv at `:4947`), so a cycle past 200k tokens now compacts. Whether a compaction
preserves the opening user message is **assumed** unknown — that commit's own
message records zero `compact_boundary` records anywhere in the corpus it was
chosen from. Tolerable here, because the block is orientation delivered once
rather than a standing contract; an option needing its text still true at turn
300 would have to answer it.

**Retention: no new horizon, and retention never binds.** `sweepRunEvents`
(`src/lib/retention.ts:127`, the `DELETE` at `:137`) removes `run_events` for
settled runs past `eventRetentionDays`, default 30 (`src/lib/settings.ts:631`),
so the corpus is a rolling thirty-day window. The ×0.9 decay's own horizon is far
shorter: a run 29 back carries 4.7% of the newest run's weight, and **the last 29
UsageFoundry runs span 66.4 hours**. The ranking is a picture of the last three
days inside a thirty-day store, so the sweep can never be what changes it. No
fourth arm on `StorageReport`, nothing to add to `docs/agent/retention.md`.

**DONE and `needs-review`: untouched, with one rule.** The block is a list item
in the same array as `COMPLETION_NOTICE` and `NEEDS_REVIEW_NOTICE` and changes
neither; it sits above `o.task`, so both notices keep the last two positions the
comments at `src/lib/orchestrator.ts:4342`–`:4347` argue for. The rule is that no generated path may
contain `DONE` or `NEEDS_REVIEW` on a line of its own. `cycleEnding`
(`src/lib/orchestrator.ts:4543`) matches over a cycle's final text rather than
its prompt, so this is a small hazard rather than a live one — but a repository
containing a file called `DONE` is not a strange repository, and the filter is
one line.

## Guards, the three cost sources, and who may author it

**No guard, no cost source, no spend.** Constraint 5 is satisfied by
construction: the option makes no model call, so nothing lands in
`run_reviews.cost_usd` and nothing could reach `runs.spent_usd`. The only figure
it puts anywhere is a count of runs, which is not money. `repoSpend.ts`'s refusal
to be a guard (`src/lib/repoSpend.ts:13`–`:16`, "**This is reporting and never a
guard**") is the precedent, and there is nothing here to inherit it with.

**Constraint 7 is the one it does not fully clear, and the exposure is a
filename.** The write side is every agent's `Read` calls; the read side is a
later run's opening prompt. `emit` (`src/lib/orchestrator.ts:482`) is the loop's
only writer, fed from the CLI's own stream, so an agent votes on what a later run
is told by choosing what to open. The surface is narrow — a path is not a
sentence, the store is the container's own SQLite under `DATA_DIR` rather than
the shared `~/.claude` bind mount, and every candidate is re-proved contained and
existent at use time (constraint 11). But an agent that creates a file with a
chosen name and reads it thirty times puts roughly 35 bytes of its own text into
every subsequent run's opening prompt on that repository, and the existence check
does not stop it, because the file exists. **The write side and the read side do
have the same author; what saves it is that the author can only write
pathnames.** Whether that is enough is a judgement, not a measurement.

## What the operator sees, and how they override it

**It owes a prerequisite it does not supply, and that is constraint 6's whole
point.** The prompt a cycle was sent is persisted in the `iteration` event's
payload (`src/lib/orchestrator.ts:6681` composes it, `emit` writes it) and never
rendered: `describeEvent`'s `iteration` case reads `p.n` and `p.resuming` and
prints "Work cycle N" (`src/lib/logLine.ts:256`–`:262`). Ship this without the
prompt readout and an operator watching a run chase a file that moved three weeks
ago has no way to learn that the app pointed it there. It is one `case` arm and a
`<pre>`, and it is the prerequisite every injecting option in this survey
inherits. Given it, the block is self-describing: the header says what it is and
each path carries the run count that put it there, so a top entry reading `(1
runs)` tells an operator the ranking is thin without them knowing how the decay
works.

The override is one boolean in `Settings`, through constraint 1's four doors —
the interface member, a `DEFAULTS` entry, membership of `SETTINGS_KEYS`
(`src/lib/settings.ts:649`) and one of the explicit `if ("key" in body)` arms in
`PUT /api/settings`. A scalar `false` is safe to default: `saveSettings` stores
only what differs from `DEFAULTS` (`src/lib/settings.ts:693`–`:706`), so an
operator who never touches it is never pinned. **Default off**, until
`03-experiment-holdout.md` reports. The block's text is generated rather than a
`DEFAULT_*` prompt, which is the split constraint 1 requires and which
`continuedWorkNotice`'s docblock states at `src/lib/orchestrator.ts:4397`–`:4399`.

## How it fails, and whether loudly

Silently, in three measured ways, and the third is the one that would actually
sink it.

**It points at files that are gone.** Three of the twenty entries in the current
unfiltered UsageFoundry top-20 do not exist in the tree — `docs/ui-density-audit.md`
and `docs/external-validator.md`, both of which this repository deliberately
moved (to `docs/agent/` and `proposals/ExternalValidator/`, as `CLAUDE.md`
records), plus one absolute path into a transcript scratch directory. The
existence filter removes all three, which is why it is not optional; without it
the failure is an agent running `Read` on a moved document and getting `File does
not exist`, already the second-largest `tool_error` signature at 95 rows over 12
runs (`00-problem.md`). Loud in the log, silent as a cause.

**It points at the wrong repository.** For `/workspace/GHtranslator`, **16 of the
unfiltered top-20 are absolute paths under `/workspace/uf-eval/`** — a different
tree, read by runs whose `repo_root` was GHtranslator. Five of VisualMerge's
twenty are the same class. Containment removes them and the residue is thinner
but honest; without it, this option hands a run a map of somewhere else.

**And on a busy repository it stops being about the repository.** The decayed
ranking's effective window is the last ~29 runs, here 66 hours, which is short
enough for one recent task to capture it. The filtered top-20 for this repository
today holds **ten entries under `proposals/ContextControl/`, six of them with
a single distinct run behind them**; one (`proposals/ContextControl/00-problem.md`,
4 runs) outranks `src/lib/orchestrator.ts` outright, 16.22 against 10.14 on 74. A new run
on an unrelated area would open on a reading list for a survey that finished.

That is not a hypothesis. Splitting the prequential score by how much history the
ranking had:

| prior runs on the repository | top-20 coverage |
|---|---|
| 1–4 | 48.9% |
| 5–19 | 50.1% |
| 20+ | **43.9%** |

**The ranking does not improve as the repository accumulates history; it
degrades.** It is not learning the repository, it is echoing the last few runs,
and on a repository doing 18 runs a day those are increasingly likely to be about
something else. A gentler decay trades that against the measured ordering of the
three rules, and nobody has swept the constant.

One further drift, worth a sentence because it landed while this file was being
written: `DELEGATION_NOTICE` (`src/lib/orchestrator.ts:4797`) now tells every run
to hand investigation to sub-agents. If it works, main-thread opening reads — the
exact thing this ranking is scored against — get fewer and different, and the
46.5% above was measured on a corpus taken before it shipped.

## What it costs to build

Small, and honestly small. One pure function with a unit test (a decayed rank
over a fixed event list is exactly the "pure function whose failure mode is
silent" bar `CLAUDE.md` sets), one query, one `filter`-and-`realpathSync` pass,
one line in the array at `src/lib/orchestrator.ts:4340`, one field through
constraint 1's four doors, and the header string. Call it a day, plus a second
for the containment and existence filters, which are where the defects are. The
prerequisite is larger than the option: the cycle-prompt readout constraint 6
demands is not in scope here, is not free, and should ship first.

Running cost is the $0.029 a run priced above — $8.45 over the eleven-day corpus,
0.20% of its bill. Constraint 13 asks what it costs when it *works*, and the
answer is uncomfortable: **success costs more than failure.** A block that is
ignored costs 469 carried tokens. A block that is obeyed makes the run open files
it would not otherwise have opened, at whatever those files cost, carried for the
life of the cycle — and 58.9% of what the ranking gets right the run was going to
open anyway, so the marginal reading is drawn disproportionately from the part
with no measured value. If `d` is negative, this option is a pure loss at a rate
no idle-cost figure captures.

## What would have to be true

**One: `d` has to be non-negative.** Nothing here measures that a run given
twenty paths reads less, or better. If it reads the same and adds the block, the
option costs $8.45 for a rounding error's worth of orientation. This is
constraint 13's demand and this file cannot meet it; `03-experiment-holdout.md`
can.

**Two: the compliance mechanism has to be position, not specificity.** The 21×
lift on `continuedWorkNotice` is the strongest fact in this file and it may not
transfer. That notice names one command with its argument filled in, a reason,
and an action. This block deliberately names no action — that is how it stays
facts rather than an instruction — and in doing so it gives up the property most
likely to have produced the lift. If the CLAUDE.md gate was declined because it
was conditional and general rather than because it was early, a bare path list is
on the gate's side of that line, and the honest prediction is that it is read as
decoration.

**Three: the decay constant has to survive a sweep.** ×0.9 wins the three-way
comparison, but the coverage falling from 50.1% to 43.9% as history accumulates
says it is over-weighted, not that it is right. Nobody has run 0.95 or 0.98, and
a rule whose accuracy degrades with the size of its own corpus should not ship on
one untested constant.

**Four: the four filters have to be in the first version, not the second.**
39.7% of ranked paths are gone, 10.2% of reads are out of tree, 27.8% are a
sub-agent's, and one folder's history splits across two keys. Every one of those
is silent, and the unfiltered block for `/workspace/GHtranslator` is 80% a map of
a different repository. An option this cheap has no excuse for shipping without
them, and an implementation that treats them as polish has built something worse
than nothing.

**And the fact that would overturn it outright:** if `03-experiment-holdout.md`
finds that the CLAUDE.md gate is declined because of position rather than
content, then every cycle-1 injection in this survey is dead, this one included,
and no amount of filtering rescues it.
