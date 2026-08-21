# Option H — the per-repository brief

One document per repository, written by a billed model out of what earlier runs
did, stored in `DATA_DIR`, copied into a run's checkout before its first cycle,
and named to the agent by a single generated sentence. The body costs nothing
until the agent opens it; the pointer costs a sentence. Its liveness is decided
by one equality — the brief carries the HEAD sha it was written against, and a
run reads it only if that sha is the sha its own checkout was cut from.

That equality is the whole option, and it turns out to be neither as fatal as
it sounds nor as survivable as the shape implies.

## The strongest case

**It puts a document in front of a run without writing the prefix, and that is
measured rather than argued.** Constraint 4's rule is that a repository change
is a cache write, because `gitStatus` sits ahead of the CLI's own breakpoint. A
gitignored file is not a repository change as `git status --porcelain` sees it
— verified in a scratch repository on the host's git 2.50.1 and again inside
the container's 2.39.5, where an excluded `.uf-brief.md` in a linked worktree
produces no porcelain output at all. So the body can be arbitrarily large and
the conversation carries none of it. The two obvious alternatives both cost: a
file the agent maintains in the tree pays `T* = 19·(S/D) − 20` on every cycle
it writes, and text injected into the prompt is carried at 0.1× for the life of
the run. This shape does neither.

**Second, it is immune to constraint 2 by construction.** The brief is copied
into the checkout by `seedWorktree` (`src/lib/orchestrator.ts:2404`) from
`ensureWorktree` (`:2189`), which is awaited once at
`src/lib/orchestrator.ts:6466` — before the cycle loop, not inside it. Nothing
has to survive `--resume`, nothing has to be re-sent per cycle, and
`--plugin-dir`'s measured non-survival is not this option's problem. It never
touches `sandboxArgs` either, so constraint 3 does not apply.

**Third, and this is the figure that keeps the option alive: the sha gate hits
far more often than the commit rate suggests.** `runs.worktree_base` records
the sha each isolated checkout was cut from. On the 200 UsageFoundry runs there
are 45 distinct base shas, and **155 of 200 runs (77.5%) started on a sha some
earlier run had already started on**:

```sql
WITH r AS (SELECT ROW_NUMBER() OVER (PARTITION BY worktree_base
             ORDER BY created_at, id) AS rn FROM runs
           WHERE folder='/workspace/UsageFoundry' AND worktree_base<>'')
SELECT COUNT(*), SUM(rn>1) FROM r;                              -- 200 | 155
```

612 commits against 200 runs (`00-problem.md`) reads like a brief stale before
it is written. It is not, because runs do not arrive one per commit — they
arrive in fan-outs off one sha, and nobody would have guessed that from the
commit rate.

## Shape

A `repo_briefs` table added as idempotent statements inside `migrate()`
(`src/lib/db.ts:124`, whose first `db.exec` block is `:136`), carrying `id`,
`repo_key`, `head_sha`, `created_at`, `run_id` and `text`, keyed the way
`repoSpend.ts` already keys a per-repository rollup that refuses to be a guard.

The writer is an `AssistKind` rather than a new module: `src/lib/review.ts:51`
is `"review" | "resolve"`, and `startAssist` (`:309`) already owns the timeout
table, the concurrency bound and the row. Its cost lands in
`run_reviews.cost_usd`, which the docblock at `src/lib/review.ts:43` says "is
displayed separately" — that is what keeps it out of `runs.spent_usd`.

Delivery is one line inside `seedWorktree`, alongside the gitignored `.env` it
already copies for exactly this reason — "the environment file that every
command depends on is exactly what is missing"
(`src/lib/orchestrator.ts:2396`–`:2403`). The brief is the same kind of object:
present in the slot, absent from the commit.

The pointer is a generated sentence, not a `DEFAULT_*`. Constraint 1's rule is
that any sentence which must stay true is generated in `orchestrator.ts`, and
this one names a path — `continuedWorkNotice` (`src/lib/orchestrator.ts:4401`)
is the precedent, for the stated reason that "the sentence naming the branch
must not be able to drift from the branch". About 200 bytes, appended at the
tip of cycle 1's prompt where `S = D` and `T* = −1` (constraint 4).

Two writing policies are available and behave very differently, so the rest of
this file scores both: **eager**, one brief after every land against the new
HEAD, which is 120 briefs in eleven days on this folder; and **lazy**, one at
run start only where no brief exists for that base, which is 45.

## What it learns from, and when the decision is taken

From the two corpora `00-problem.md` establishes and nothing else: the `Read`
paths in `run_events` (5,856 calls carrying a `file_path`, 81.4% of distinct
file-opens on this folder already opened by an earlier run) and the
`run_reviews.resolved_paths` lists (67 rows, `CLAUDE.md` in 54). Both are in
SQLite and neither needs a transcript parse. `tool_error` is available and
mostly not worth reading — `00-problem.md` measures its largest family as one
environment fault the codebase already answered with a classifier.

The decision is taken **once per run, before the cycle loop**, at
`ensureWorktree`. That places it in the same class as `settings` and
`githubTokenFor`, which constraint 9 notes are resolved once — `getSettings()`
at `src/lib/orchestrator.ts:6286`, `githubTokenFor` at `:6475` — rather than in
`enabledPluginDirs()`'s deliberately per-cycle class (`:6763`). It is not in
`createRun`: the lookup is a synchronous `better-sqlite3` read, the copy is a
`copyFileSync`, and both sit behind an `await` that is already there.

On UsageFoundry that is 200 consultations across 319 work cycles (`SELECT
SUM(iterations) FROM runs WHERE folder='/workspace/UsageFoundry'` → 319), which
is the right grain: what an agent knows about a repository does not change
between cycle 2 and cycle 3.

## What it does to the prefix cache

Nothing, **if the file is excluded**. That conditional is not a formality, and
it is the first place the shape gets more expensive than it looks. With no
exclude entry the brief is untracked, and untracked is exactly what `gitStatus`
reports:

```
$ git -C ../wt status --porcelain
?? .uf-brief.md
```

So the option must arrange the exclusion itself, and git will not let it do
that per worktree. Measured on both gits: writing `.uf-brief.md` into the
linked worktree's own `$GIT_DIR/info/exclude` —
`.git/worktrees/<slot>/info/exclude` — leaves it reported as `??`. Only the
**common** dir suppresses it, and `git -C <worktree> rev-parse
--git-common-dir` resolves to the operator's own `.git`, so the entry lands
there and the operator's checkout starts ignoring the name too:

```
$ echo ".uf-brief.md" >> "$(git -C ../wt rev-parse --git-common-dir)/info/exclude"
$ git -C ../wt status --porcelain      # (empty — worktree now clean)
$ git status --porcelain               # (empty — the MAIN checkout too)
```

The alternatives are a tracked `.gitignore` line the operator commits by hand
per repository, which this app has no other example of asking for, or
`core.excludesFile` through `GIT_CONFIG_COUNT` on every git spawn, which
`docs/agent/git-and-review.md` warns must equal the number of pairs or git
discards the block silently. None of the three is free, and the first writes an
untracked file into the operator's repository that no diff will ever show.

The pointer sentence itself is the cheap half and stays cheap: appended at the
tip, paid once at the write rate, read at 0.1× thereafter.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: nothing.** The file is in the slot before cycle 1 and does not
move, so `adoptSession` and the resume argv are untouched.

**DONE: one hazard, and it is small.** `cycleEnding`
(`src/lib/orchestrator.ts:4543`) matches `/^\s*DONE\s*$/m` over a cycle's own
final text, not over a file, so a brief body containing a bare `DONE` line ends
nothing by itself. It ends something if an agent quotes the brief back in its
final message. The only available fix is the writer's prompt refusing those two
tokens, which is a prompt constraint rather than a mechanism and is unenforced.

**`needs-review`: untouched.** `NEEDS_REVIEW_NOTICE`
(`src/lib/orchestrator.ts:4506`) is unchanged and no rung moves. The one
interaction worth naming is upstream: a brief mined from endings would be
mining a distribution with one `needs-review` row in 294 (`00-problem.md`).

**Retention is where it costs an operator something new, and both sides are
real.** `StorageReport` (`src/lib/retention.ts:677`) carries three arms plus
`lastSweep`, and brief rows live inside the same SQLite file, so
`database.bytes` already counts them: no *fourth arm* is strictly added, a
third counter beside `runEvents` and `telemetryRows` is. What is genuinely new
is a fourth **horizon**, which constraint 8 says has to be earned.

The case for never expiring is the `run_reviews` precedent: it was paid for,
and `src/lib/retention.ts:29`–`:32` says in as many words that nothing here
deletes a review. The case for expiring is that a brief is derived rather than
evidence — a claim about a tree — and the `run_events` rows behind it are swept
at `eventRetentionDays`, default 30 (`src/lib/retention.ts:131`,
`src/lib/settings.ts:631`), so a brief older than a month outlives everything
that could audit or rebuild it.

The resolution that fits this codebase is neither: **sweep on supersession, not
on a clock.** Delete every brief whose `head_sha` is not the newest for its
`repo_key` — retention's own rule that every sweep asks the database what is
live, and no horizon at all. Under the sha gate no run will ever read a
superseded row anyway, and growth without some sweep is not trivial: 120 lands
on one folder in eleven days.

## Guards, the three cost sources, and who may author it

The write is billed and lands in `run_reviews.cost_usd`, never in
`runs.spent_usd` and never in OTLP — the separation `startAssist` already
maintains and `docs/agent/metering.md` requires. The brief store is not a
meter, is read by no guard, and puts no figure on a page that would have to
name a source. Price, from this install's own assists:

```sql
SELECT COUNT(*), ROUND(SUM(cost_usd),2), ROUND(AVG(cost_usd),2)
FROM run_reviews WHERE kind='resolve' AND status='completed';   -- 59 | 238.2 | 4.04
```

$4.04 mean per completed billed assist, 299.4 s median wall clock (same 59
rows, ordered by `finished_at - created_at`). So the eager policy costs **120 ×
$4.04 = $484.80** for eleven days on one folder, against $2,986.58 of measured
spend there — 16.2% of the folder's bill. The lazy policy costs **45 × $4.04 =
$181.80**, 6.1%.

Constraint 7 gets the better of its two answers: the canonical row lives in
`DATA_DIR`, which no work cycle can open, and the slot copy is disposable, so
an agent rewriting its own copy under `acceptEdits` poisons only itself and
only for one run. The honest half is that a model still writes what a later
model reads, so the loop is closed at a distance; the only mitigation is that
the brief be descriptive — which files, which walls, which collisions — rather
than imperative, and nothing enforces that.

Containment (constraint 11) is the easy case: the server composes
`path.join(slotPath, …)` off an already-proved slot, with `resolveInMount`
(`src/lib/orchestrator.ts:707`) as the precedent if the path ever becomes
configurable. Paths inside the *body* are model-authored strings nothing
re-proves — the same standing a `CLAUDE.md` line has.

## What the operator sees, and how they override it

Less than it should, and the deficit is constraint 6's, inherited.

The pointer sentence goes into cycle 1's prompt, which **is persisted in the
`iteration` event and never rendered** — `describeEvent`'s `iteration` case
(`src/lib/logLine.ts:256`) reads `p.n` and `p.resuming` and prints "Work cycle
N". So on the log as it stands, a run that was handed a brief and a run that
was not look identical. That is a prerequisite this option does not own and
cannot ship without.

The body is worse off: never on the log at all, and living in a checkout under
`.uf-worktrees` that gets reclaimed. An operator wanting to know what the run
was told has to read the `repo_briefs` row, so the option owes a page — the
brief, its sha, its cost, whether the sha is still live. `seedReport`
(`src/lib/orchestrator.ts:2487`, called at `:2199`) is the shape for the log
line saying the copy happened; naming a file is not showing it. Override is the
cheap part: delete the row, or regenerate against current HEAD.

## How it fails, and whether loudly

**Under the eager policy it mostly fails by being unread, and silently.** Of
the 120 lands on this folder, only **20 produced a HEAD that any later run
actually started on**:

```sql
WITH l AS (SELECT landed_at, landed_tip FROM runs
           WHERE folder='/workspace/UsageFoundry' AND landed_tip<>'')
SELECT COUNT(*), SUM(EXISTS (SELECT 1 FROM runs r2
  WHERE r2.folder='/workspace/UsageFoundry' AND r2.created_at > l.landed_at
    AND r2.worktree_base = l.landed_tip)) FROM l;               -- 120 | 20
```

100 of 120 briefs — **$404 of the $484.80** — would be written, billed, and
never opened by anything. Nothing on any page would say so, because a brief
nobody reads produces no event.

**Under the lazy policy it fails on a race, and the race is the fan-out.** The
155 hits are not a queue, they are batches: of the runs sharing a base with an
earlier run, **125 of 155 started within sixty seconds of that predecessor**,
and the largest single base carries 23 runs inside a 3.9-hour span. A lazy
write takes a median 299.4 s. So for a 23-run fan-out the choice is to
serialise 22 run starts behind one billed assist, or to let 23 assists start at
once and pay $92.92 for one sha. Nothing in this app makes a run's start wait
on a billed child today, so the first branch is assumed to be new behaviour
rather than a variation on something existing.

**And relaxing the gate produces a failure that is different in kind from
costing money for nothing.** If a stale brief is served rather than withheld,
what the agent gets is a confident description of a tree that has moved.
Measured, on the 45 distinct base shas in `created_at` order, all of which are
reachable from this checkout:

```
$ git rev-list --count <prev_base>..<next_base>   # over the 44 consecutive pairs
n=44  median=8  min=1  max=68  total=575
```

A median of **eight commits** between one base and the next; 292 of the
window's commits touch `src/lib/` and 207 touch CLAUDE.md (`git log --oneline
--since=2026-08-10 -- <path> | wc -l`, against a total the same command gives
as 615 today where `00-problem.md` quotes 618). A brief served one base out of
date describes a layout with a coin-flip chance of having moved underneath it.

A brief that is merely unread costs money for nothing. A brief served stale
fails by being **wrong** — an agent acting on a false statement about the tree,
with no signal distinguishing it from a true one, carrying more authority than
a guess because a model was paid to write it. The gate is what prevents that,
which is precisely why it cannot be relaxed to buy back the hit rate.

## What it costs to build

Small, and smaller than its prerequisites: idempotent statements in
`migrate()`, one more `AssistKind` arm through machinery that exists, a few
lines in `seedWorktree`, one generated sentence beside `continuedWorkNotice`,
and a one-statement supersession sweep.

Three things it does **not** own and cannot ship without. Constraint 6's
unrendered prompt, which is a defect independent of this option and a
prerequisite for anything that injects text. The exclude decision, which has no
clean answer and whose least-bad form writes the operator's own `.git`. And
`d`: constraint 13's rule is that an option prices what it costs when it works,
and a brief that *is* read leaves the conversation carrying the pointer, the
brief and then the file anyway, unless the brief displaces reading — which
nothing in this repository measures.

Coverage is better than constraint 10 implies but not complete: 243 of 294 runs
are `isolation = 'worktree'`, and the other 51 — 35 on `/workspace2`, a notes
vault, five on `/workspace`, plus 11 rows predating the column — have no seed path and would get
nothing. All 200 UsageFoundry runs are isolated, so the folder holding the
whole prize is fully covered.

## What would have to be true

**First, the fan-out has to be written for.** The measured hit rate of 77.5%
belongs overwhelmingly to batches launched off one sha within a minute of each
other — 125 of the 155 — and a lazy writer taking 299.4 s cannot serve them.
The option only works if the brief is written **eagerly, the moment a base sha
first appears**, at the worktree creation inside `ensureWorktree` rather than
at a land, and if runs 2 through 23 of a fan-out start without it. That variant
is not the one the shape suggests and nobody has costed it.

**Second, `d` has to be greater than zero, and specifically for a brief.**
81.4% of distinct file-opens on this folder repeat an earlier run's, but 50.6%
of the repeat `Read` calls are of a file the same run then edits, so at most
36.1% of reading is addressable (`00-problem.md`). A brief that reorders
reading rather than removing it is pure cost. The experiment is small: ten runs
with a brief, ten without, tool calls before the first edit against the
measured median of 29.

**Third, the exclusion has to be arrangeable without writing the operator's
`.git`.** Measured above: a per-worktree `info/exclude` works on neither git
2.39.5 nor 2.50.1, and the common-dir one changes what the operator's own
checkout ignores. If the answer is a committed `.gitignore` line per
repository, the headline advantage costs a manual step in every repository an
operator ever points this app at — and an install that skips it gets a `??` in
`gitStatus` on every cycle and pays exactly the cache write the option was
built to avoid.

**And the fact that would overturn the whole option:** a demonstration that
serving a brief across a base change is safe — that a brief written to be
sha-independent (which files matter, which walls runs hit, which files collide)
survives a median of eight commits without saying anything false. If that
holds, the sha gate is the wrong gate, the store should be keyed on the
repository alone, and this option collapses into a cheaper one with no
supersession problem and a hit rate of 100%. Nobody has tried it, and until
somebody does, the gate is load-bearing and 100 of every 120 briefs this
install would write are paid for and never read.
