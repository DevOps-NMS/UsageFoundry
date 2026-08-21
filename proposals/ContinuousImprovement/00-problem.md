# What a run re-derives, and what re-deriving it costs

Every run this app starts is a fresh agent in a folder some earlier run has
usually already worked in. It re-reads what the last one read, and — the claim
this survey has to test — it re-makes what the last one got wrong. Nothing in
this app carries anything from one run to the next except a git branch and, on a
continuation, three generated sentences naming it.

This file measures both halves against one install, and it ends with a shape
that neither half predicts.

## The corpus

One install, its own container database, over the eleven days to 2026-08-21.
Everything below is `docker exec -i usagefoundry sqlite3 -readonly
/data/usagefoundry.db` against `/data/usagefoundry.db`, and the SQL for each
figure is quoted where the figure is stated.

| | |
|---|---|
| Runs | **294**, over 8 folders |
| Window | 2026-08-10 → 2026-08-21 |
| Spend | **$4,303.70** by `runs.spent_usd` |
| Concentration | **200 runs, $2,986.58** on one folder, `/workspace/UsageFoundry` — this repository |
| `run_events` rows | **124,861** |
| `otlp_requests` rows | 29,251 |

```sql
SELECT COUNT(*), COUNT(DISTINCT folder), MIN(DATE(created_at/1000,'unixepoch')),
       MAX(DATE(created_at/1000,'unixepoch')), ROUND(SUM(spent_usd),2) FROM runs;
```

`$4,303.70` is all 294 runs. The `completed` subtotal alone is `$4,236.62`, and
earlier drafts of this survey quoted the second figure for the first; every
`spent_usd` total below is the corpus total unless it says otherwise.

That concentration is what makes the install worth measuring: 200 attempts at
one codebase is a corpus, and a mechanism that cannot show a prize there will
not find one anywhere.

## Half one: the same mistakes

### The endings are almost all the same ending

```sql
SELECT status, COUNT(*) FROM runs GROUP BY status ORDER BY 2 DESC;
SELECT COUNT(*) FROM runs WHERE status='completed' AND reported_done=1;   -- 175
SELECT COUNT(*) FROM runs WHERE status='completed' AND reported_done=0;   -- 102
SELECT COUNT(*) FROM runs WHERE exit_code IS NOT NULL AND exit_code<>0;   --   1
SELECT COUNT(*) FROM runs WHERE needs_review_reason IS NOT NULL
                            AND needs_review_reason<>'';                  --   1
```

| status | n |
|---|---|
| `completed` | 277 |
| `stopped` | 11 |
| `blocked` | 3 |
| `failed` | 2 |
| `needs-review` | **1** |

**One run in 294 used `needs-review`, and one carries a non-zero `exit_code`.**
The signal `docs/needs-review.md` was designed around — the agent's own
judgement that the task cannot be done — has fired once. Any mechanism that
proposes to learn from how runs *end* is proposing to learn from a distribution
with two points in it.

The one ending class that does have volume is invisible: **102 of the 277
`completed` runs carry `reported_done = 0`**, meaning they used up their cycle
cap rather than finishing. `runs.status` does not distinguish them, and
`stop_reason` is prose that `src/lib/db.ts:993` names as "the one thing in this
codebase that must never become a parse". A run that quietly ran out of budget
and a run that finished are the same row to every reader in the app.

### The finest-grained mistake signal is real, and is mostly one environment fault

`run_events` carries a `tool_error` row for every failed tool call, emitted at
`src/lib/orchestrator.ts:6066`–`:6071` with the payload
`{name, command, text, toolUseId}`.

```sql
SELECT json_extract(payload,'$.name'), COUNT(*), COUNT(DISTINCT run_id)
FROM run_events WHERE kind='tool_error' GROUP BY 1 ORDER BY 2 DESC;
```

| tool | rows | runs |
|---|---|---|
| `Bash` | 379 | 69 |
| `Read` | 121 | 14 |
| `Edit` | 18 | 13 |
| `WebFetch` | 10 | 1 |
| `Agent` | 5 | 1 |
| `Grep` | 3 | 2 |
| `Glob` | 2 | 1 |
| | **538** | **70** |

Normalising each row to `tool :: first 70 characters of the error, digits → N,
/paths → PATH` gives 157 distinct signatures, and the distribution is extremely
top-heavy: **380 of the 538 rows (70.6%) belong to a signature that recurs
across two or more distinct runs**, 357 (66.4%) across three or more, and
eighteen signatures account for all of the first figure.

| rows | distinct runs | signature |
|---|---|---|
| 214 | 10 | `Bash :: bwrap: No permissions to create new namespace` |
| 95 | 12 | `Read :: File does not exist. Note: your current working directory is PATH` |
| 14 | 8 | `Read :: EISDIR: illegal operation on a directory` |
| 10 | 9 | `Bash :: Exit code N` (bare) |
| 6 | 6 | `Bash :: Cannot find module` |
| 6 | 5 | `Bash :: Traceback … File "<string>"` |

**This is the finding that most weakens the mistakes half of the question, and
it is the codebase's own.** The largest entry is not a lesson about any
codebase; it is one environment fault, dated to two days —

```sql
SELECT DATE(ts/1000,'unixepoch'), COUNT(*), COUNT(DISTINCT run_id)
FROM run_events WHERE kind='tool_error' AND payload LIKE '%bwrap%' GROUP BY 1;
-- 2026-08-16 | 1 | 1     2026-08-18 | 134 | 6     2026-08-19 | 84 | 9
```

— and it hit commands as ordinary as `echo hello; pwd`, so it was the harness
failing, not an agent choosing badly. What happened to it is the whole argument:
`src/lib/sandbox.ts:105`–`:110` records the same measurement in a comment ("214
of this install's 484 `tool_error` rows carry the first of these verbatim"), and
the answer shipped was a needle in `MARKERS` and a classifier, `sandboxRefusal()`
(`src/lib/sandbox.ts:142`), whose whole job is to make the run log *say* what
happened. **The largest repeated cross-run mistake this install has ever made
was solved by seeing it, not by remembering it.**

Remove the bubblewrap family and what is left is 324 rows across 156 signatures,
of which the repeats are small in both senses: no remaining signature spans more
than twelve runs, and the largest — `Read: File does not exist` — is an agent
guessing a sibling worktree's slot number, an artefact of the isolation scheme
rather than a fact about any repository. Three of the twelve most-repeated
missing paths are literally
`/workspace/.uf-worktrees/usagefoundry-721638d11c0b-2/…` read from a run living
in slot `-1`.

### And the corpus expires

`sweepRunEvents` deletes the payloads of settled runs past
`settings.eventRetentionDays` (`src/lib/retention.ts:137`), which defaults to 30
(`src/lib/settings.ts:631`). Any mechanism that mines `tool_error` is mining a
rolling thirty-day window, and must extract before the sweep or store elsewhere.

## Half two: the same reading

### It is large, it reproduces across five independent folders, and it is a query

`run_events` rows of kind `tool` carry the whole tool input, so a `Read`'s
`file_path` is already in the database and no transcript parse is needed.
Relativising each path against the run's own worktree and grouping by
`runs.repo_root`:

```sql
WITH p AS (
  SELECT e.id, e.run_id, r.created_at,
         COALESCE(NULLIF(r.repo_root,''),'(no repo)') AS repo,
         REPLACE(json_extract(e.payload,'$.input.file_path'),
                 COALESCE(NULLIF(r.worktree_path,''),NULLIF(r.work_dir,''),r.folder)||'/','') AS rel,
         json_extract(e.payload,'$.name') AS tool
  FROM run_events e JOIN runs r ON r.id=e.run_id
  WHERE e.kind='tool' AND json_extract(e.payload,'$.input.file_path') IS NOT NULL),
reads AS (SELECT * FROM p WHERE tool='Read'),
firsts AS (SELECT id, run_id, repo, rel,
             FIRST_VALUE(run_id) OVER (PARTITION BY repo, rel ORDER BY created_at, id) AS first_run
           FROM reads)
SELECT COUNT(*) FROM firsts WHERE run_id <> first_run;
```

| | |
|---|---|
| `Read` calls carrying a `file_path` | **5,856** |
| of a path an earlier run on the same repository had already read | **4,284 — 73.2%** |
| of *those*, files the same run then edits | **2,168 — 50.6%** |
| whole query, wall clock, over 124,861 rows | **0.155 s** |

Counted at the coarser grain that a pointer or a brief could actually act on —
one charge per distinct file per run — it is larger still. Per folder:

| folder | runs that read | distinct file-opens | already opened by an earlier run | median per run |
|---|---|---|---|---|
| `/workspace/UsageFoundry` | 189 | 2,105 | **81.4%** | 91.7% |
| `/workspace/VisualMerge` | 18 | 241 | 67.2% | 71.2% |
| `/workspace/GHtranslator` | 13 | 113 | 66.4% | 60.0% |
| `/workspace/VibeHub` | 12 | 285 | 54.4% | 69.2% |
| `/workspace2` (a notes vault) | 32 | 418 | 47.1% | 58.6% |

**81 of the 189 UsageFoundry runs opened no file that an earlier run had not
already opened.** `src/lib/orchestrator.ts` was opened in 476 separate calls;
`README.md` 60 times, `CLAUDE.md` 54, `docs/agent/conventions.md` 27.

### Half of it cannot be displaced by anything

The 50.6% above is the single most important number in this file. A run that
opens `src/lib/orchestrator.ts` and then edits it does not need a pointer, a
brief, a ranking or an index — it needs the file. No mechanism in this survey
substitutes for reading a file you are about to change, so **the addressable
share of the repeat reading is at most 2,116 calls of 5,856, or 36.1% of all
reading**, before anything is said about whether pointing a run at a file makes
it read less.

### What the reading costs, stated in the one source that can price it

`otlp_requests` carries per-request `cost_usd` with timestamps, so the spend
before a run's first `Edit`/`Write` can be summed directly. This is OTLP and is
neither `runs.spent_usd` nor `scanUsage()`; per `docs/agent/metering.md` the
three are never summed, and nothing below mixes them.

| over the 177 UsageFoundry runs with both an OTLP `sdk` request and a first edit | |
|---|---|
| OTLP cost before the first edit | **$543.79 of $2,596.08 — 20.9%** |
| per-run share, median / mean | **24.4% / 27.3%** |
| per-run share of tokens *entering* the conversation before the first edit, median | **35.8%** |
| tool calls before the first edit, median / mean / p90 | **29 / 34.1 / 55** |
| share of a run's tool calls that precede its first edit, median | **30.2%** |

Twenty-one of 198 runs never edited anything and are excluded; a research or
planning run legitimately spends its whole life in that window, so this is an
upper bound on "orientation" and not a synonym for it.

### The install's own history predicts what a run will open next

Ranked prequentially — for each run in `created_at` order, a top-K built only
from strictly earlier runs on the same repository, scored against that run's
first eight `Read` calls, 263 runs scored:

| ranking rule | top-20 | top-40 |
|---|---|---|
| by distinct earlier runs that read the file | 39.2% | 51.6% |
| by raw earlier read calls | 42.3% | 53.9% |
| by read calls with a ×0.9 decay per intervening run | **45.0%** | **59.0%** |

Ties inside `most_common` are broken arbitrarily, which moves the first row by
about 0.2 points between runs of the scorer; the ordering of the three rules is
stable. **Recency matters more than volume**, which is the one design decision
this measurement settles on its own.

## The shape neither half predicted

CLAUDE.md is delivered by the CLI into the first user message of every run in
the mounted folder. This repository's copy says, in as many words: *"The lines
below are gates, not summaries: if you are about to touch the files named, read
the doc first."*

```sql
-- runs that edited or wrote anything under src/lib/            → 112
-- ...of those, runs that read any docs/agent/*.md              →  11
-- ...of those, runs that named any docs/agent/ path at all     →  14
```

**112 runs edited `src/lib/`. Eleven read the doc the gate names.** This install
has therefore already run the experiment that every "inject the lesson at cycle
1" option in this survey proposes: a rule was placed in the highest-authority
position available, on every run, and was declined roughly 90% of the time.

Two caveats, in opposite directions. Some of the 112 made edits the gates do not
really cover, so 101 is an upper bound on non-compliance rather than a count of
it. And `clipToolInput` bounds a stored tool input (`src/lib/logLine.ts:104`),
so a mention could in principle have been truncated out of a payload — though
not a `Read`'s `file_path`, which is kept first.

What this does **not** establish is whether the cause is position or content.
Nobody has separated "text at the top of a fresh conversation is discounted"
from "this particular sentence is unpersuasive", and the difference decides
which options in this survey are worth building. `03-experiment-holdout.md` is
that separation.

## The corpus nobody had opened

`run_reviews` holds the AI conflict resolutions this install has paid for. It is
the only cross-run evidence store in the database that **never expires** —
`src/lib/retention.ts:29`–`:32` says it in as many words, "Nothing here deletes
a runs row, a review, a workflow record or a setting", and `grep -rn "DELETE
FROM run_reviews" src/` returns nothing.

| | |
|---|---|
| rows | 68 — 59 `resolve`/`completed`, 8 `resolve`/`failed`, 1 `review`/`completed` |
| spend | **$238.20** over the 59 completed resolutions, mean $4.04; all 68 rows total $240.03 |
| rows carrying a `resolved_paths` list | 67 |

```sql
WITH p AS (SELECT rr.id, j.value AS path FROM run_reviews rr, json_each(rr.resolved_paths) j
           WHERE rr.kind='resolve' AND rr.resolved_paths IS NOT NULL)
SELECT path, COUNT(DISTINCT id) FROM p GROUP BY path ORDER BY 2 DESC LIMIT 6;
```

| path | resolutions naming it |
|---|---|
| **`CLAUDE.md`** | **54** |
| `docs/verification.md` | 15 |
| `README.md` | 14 |
| `src/lib/orchestrator.ts` | 12 |
| `.env.example` | 9 |
| `docker-compose.yml` | 8 |

Every row is a real, externally-adjudicated collision between two runs, with a
file list and a dollar figure attached, and it is durable. It is a better
lesson corpus than `tool_error` on every axis that matters — non-empty,
non-expiring, per-repository, and about the code rather than about the
container.

It also carries a warning for one option in this survey: **CLAUDE.md is already
the most contended file in this tree by a factor of 3.6** across the whole
corpus — 54 against `docs/verification.md`'s 15, where
`09-option-conflict-history.md` measures 3.4 scoped to this repository alone —
which is what
`13-option-agent-claude-md.md` has to survive.

## What this app can see today

| | |
|---|---|
| What one run cost | the run page and the dashboard, three sources kept apart |
| What every run on a repository has *read* | **nowhere** |
| Which walls runs keep hitting | **nowhere** — one classifier, `sandboxRefusal()`, renders one log line on one run page (`src/lib/logLine.ts:337`) |
| Which files runs keep colliding in | **nowhere** — `run_reviews` is read per run, never per repository |
| Whether a run finished or ran out of cycles | the run page only, from `reported_done` (`src/app/runs/[id]/page.tsx:243`, `:258`) — never in a list, a rollup or `runs.status`, and wrong on 20 rows |
| The exact prompt a cycle was sent | persisted in the `iteration` event and **never rendered**: `describeEvent` reads `p.n` and `p.resuming` and prints "Work cycle N" |

## What the numbers do not say

Four limits, stated here so no option file has to re-earn them.

**"Already read by an earlier run" is not "wasted".** The file may have changed
between runs — this repository took 612 commits in the same eleven days (`git
log --oneline --since="2026-08-10" --until="2026-08-21" | wc -l`; the open-ended
`--since` form drifts as the window slides, and earlier drafts quoted 614 and 618
from it) — and knowing that run #47 read
`orchestrator.ts` does not put a single byte of it into run #93's context. The
repeat rate bounds an opportunity; it does not price one.

**No displacement fraction exists.** Every dollar any option here could claim
runs through *d*, the share of aimed-at reading that a pointer or a brief
actually removes rather than reorders or simply adds to. Nothing in this
repository measures *d*, nobody has run the experiment, and until someone does,
the cost-saving half of the user's question has no derived answer. Options are
scored on that basis in `15-comparison.md`.

**The byte figures are soft.** Charging one read per distinct file per run and
billing a sliced read at `limit × mean bytes per line` gives 27.2 MB of 31.1 MB
(87.6%) repeated on this folder, about 6.8M tokens; 53.5% of `Read` calls carry
an `offset` or `limit`, 217 of the paths are no longer on disk and were skipped,
and `proposals/ContextControl/05-option-trim-injected-text.md:127`–`:129` flags
that its own two bytes-per-token conversions disagree by 1.5×. Treat every
byte-derived dollar in this survey as an order of magnitude.

**Eleven `Read` rows carry no `file_path`.** The tool histogram counts 5,867
`Read` calls and the path-bearing query 5,856. The gap is not explained here.

## Where this leaves the question

The repeated-mistake half is measured near-empty *as this install is
configured*: two ending signals with one instance each, and a tool-failure
corpus that is 40% one environment fault which the codebase already answered
with a classifier. The repeated-reading half is large and reproduces everywhere,
but half of it is unaddressable by construction and the other half's prize is
undemonstrated.

And the one repeated mistake with real volume is neither: it is a rule this
install already delivers to every run, in the best position it has, being
declined nine times in ten.

That is the problem this survey is about.
