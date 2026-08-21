# What a run re-derives from the ones before it

**Open. One recommendation, and it is to build two readouts and an $8.45
injection measured behind a holdout — not a memory.** Eleven options for stopping a run repeating what an
earlier run already established, weighed against 294 runs of one install's own
database, and refused in five cases on arithmetic taken from that database.

## The recommendation

**Build the readout — Option A, with Option F's contention card as its third
reading — and ship Option C, the prior-read pointer, in the same change, behind
a deterministic 50% holdout so that the readout measures the pointer. Fold in
Option B's `ending_code` column. Hold Option D, the gate hook, until the holdout
separates position from content. Ship five repairs regardless.**
[16-recommendation.md](16-recommendation.md).

Nothing in it needs a new table, a fourth retention horizon, a `StorageReport`
arm, an MCP tool definition, a billed model call, or a byte written into a
mounted folder. `run_events` already carries every `Read`'s `file_path`
by construction, `run_reviews` already carries every adjudicated collision and
never expires, and the exact prompt of every cycle is already persisted — so the
mechanism the survey recommends is mostly a query the app has never asked.

**What would overturn it:** run the holdout and find Option C's block declined
the way CLAUDE.md's gate is. The compliance half costs nothing — 1,014 (cycle,
named path) pairs are already queryable — and at ~27 runs a day a 50% split
separates an effect the size of the observational lift in about a fortnight. If
the pointer is declined, no injected pointer works on this install and the answer
is the two readouts alone.

**Runner-up:** Option D, the gate hook. It wins if the pointer is complied with
but does not displace — if runs read the named files *in addition to* everything
else — because that result says orientation is not steerable in advance and the
only useful moment is the moment of the edit.

## The finding that reframed the survey

`00-problem.md` opens on a decline: 112 runs edited `src/lib/`, and eleven read
the `docs/agent/` doc that CLAUDE.md — delivered into every run's first user
message — tells them to read first. That looked like proof that text at cycle 1
is ignored, and half the options in this survey were designed around it.

Then `02-what-already-tries.md` measured the control. `continuedWorkNotice`
prints two exact git commands into the same message, in the same position, from
the same app:

| | told (66 runs) | matched control (175) | lift |
|---|---|---|---|
| ran **any** `git log` at any point | **100%** | 90.9% | 1.1× |
| ran `git diff --stat <base>...HEAD`, the exact form printed | **84.8%** | **4.0%** | **21×** |

The control is matched — isolated runs with Bash events that did not receive
the notice — because an unisolated run has no branch to diff. **The notice does
not make a run examine its branch; untold runs do that 90.9% of the time anyway.
It makes the run examine it the way the notice said to.**

Both texts arrive in the same message, in the same position, from the same app.
One is obeyed and one is not, so **what separates them is not where the sentence
sits.** The notice names one command costing a few hundred bytes; the gate asks a
mid-task agent to open a 63,394-byte document first. That is why the
recommendation ships a block that *names files* rather than one that *instructs
an agent to study them*, and why the gate hook — designed on the position
hypothesis — is held rather than built.

## The measurement, and what it does and does not license

From 294 runs over the eleven days to 2026-08-21, through the install's own
container database:

| | |
|---|---|
| `Read` calls of a path an earlier run on the same repository had already read | **73.2%** — 4,284 of 5,856 |
| of those, files the same run then **edits**, which nothing displaces | **50.6%** |
| addressable share of all reading, therefore | **36.1%** |
| distinct file-opens already opened by an earlier run, this repository | **81.4%**, median run 91.7% |
| runs that opened nothing an earlier run had not | **81 of 189** |
| OTLP-reported spend before a run's first edit | **20.9%**, median run 24.4% |
| tool calls before the first edit, median | **29** |
| prequential top-20 coverage of a new run's opening reads, ×0.9 recency decay | **45.0%** (42.3% by raw frequency, 39.2% by distinct runs) |
| runs ending `needs-review`, and runs with a non-zero exit code | **1** and **1**, of 294 |
| `tool_error` rows, and the share that is one environment fault | 538, and **214 across ten runs** |
| paid conflict resolutions, never expiring, and the share naming `CLAUDE.md` | 59 at **$238.20**, and **84.6% of the money** |
| cost of the recommended pointer, per run and across the corpus | **$0.029** and **$8.45** |

**73.2% is an opportunity, not a bill.** Half of it is files the run is about to
change. And constraint 13's `d` — the share of aimed-at reading a pointer removes
rather than reorders — **does not exist anywhere in this repository**, so no
option here may state a dollar saving, and none does.

## What this app can see today

| | |
|---|---|
| What one run cost | the run page and the dashboard, three sources kept apart |
| What every run on a repository has **read** | **nowhere** |
| Which walls runs keep hitting | **nowhere** — one classifier renders one log line on one run page |
| Which files runs keep colliding in | **nowhere** — `run_reviews` is read per run, never per repository |
| Whether a run finished or ran out of cycles | the run page only, from `reported_done` — never in a list or a rollup, and wrong on 20 rows |
| The exact prompt a cycle was sent | persisted in the `iteration` event and **never rendered** |
| Whether a hook fired | **nowhere** — `--include-hook-events` appears nowhere in `src/` |

The first six are the readout. The last is a prerequisite for the runner-up.

## Index

| File | What it is for |
|---|---|
| [00-problem.md](00-problem.md) | What a run re-derives and what re-deriving it costs, measured from this install |
| [01-constraints.md](01-constraints.md) | The thirteen things any option has to survive, and the three arithmetic facts it is scored against |
| [02-what-already-tries.md](02-what-already-tries.md) | What already does part of this job — and the 21× result that reframed the survey |
| [03-experiment-holdout.md](03-experiment-holdout.md) | The deterministic holdout, why n=1-per-arm cannot work, and the two billed probes |
| [04-option-see-it.md](04-option-see-it.md) | A: do nothing but see it — **recommended** |
| [05-option-ending-code.md](05-option-ending-code.md) | B: name how a run ended — **fold into whatever ships first** |
| [06-option-prior-read-pointer.md](06-option-prior-read-pointer.md) | C: the prior-read pointer at cycle 1 — **recommended, behind the holdout** |
| [07-option-gate-hook.md](07-option-gate-hook.md) | D: a `PostToolUse` gate on `--settings` — **runner-up; its two repairs ship now** |
| [08-option-operator-note.md](08-option-operator-note.md) | E: the operator's per-repository note — **rejected, and by its own measurement** |
| [09-option-conflict-history.md](09-option-conflict-history.md) | F: contention as the lesson corpus — **half (a) recommended, half (b) rejected** |
| [10-option-retrospective.md](10-option-retrospective.md) | G: a retrospective and a lessons table — **rejected by name; a manual button survives** |
| [11-option-repo-brief.md](11-option-repo-brief.md) | H: a per-repository brief gated on HEAD — **rejected: 100 briefs in 120 never opened** |
| [12-option-mcp-tool.md](12-option-mcp-tool.md) | I: a project-knowledge MCP tool — **rejected; one free fix extracted from it** |
| [13-option-agent-claude-md.md](13-option-agent-claude-md.md) | J: an agent-maintained `CLAUDE.md` — **rejected: negative money, and the most contended file in the tree** |
| [14-option-delegate-the-reading.md](14-option-delegate-the-reading.md) | K: delegate the opening read — **answers a different question, and half of it already shipped** |
| [15-comparison.md](15-comparison.md) | Ten weighted criteria stated before the scores, and why the top two options reach no run |
| [16-recommendation.md](16-recommendation.md) | The case, the five repairs, the overturning fact, the runner-up, and what is rejected by name |
| [17-implementation-sketch.md](17-implementation-sketch.md) | Six phases, the invariant each must not break, and which three earn a unit test |
| [18-validation.md](18-validation.md) | Every citation re-resolved, every measurement re-run, and what was wrong |

Every option file answers the same ten headings — the strongest case, its shape,
what it learns from and when the decision is taken, what it does to the prefix
cache, what it does to `--resume`/retention/the DONE contract/`needs-review`,
guards and the three cost sources and who may author it, what the operator sees
and how they override it, how it fails and whether loudly, what it costs to
build, and what would have to be true — so
[15-comparison.md](15-comparison.md) is a table over a fixed set rather than
over eleven arguments.

## Five repairs this survey found while looking for something else

Each is independent of whether any option ships, and each is argued in
[16-recommendation.md](16-recommendation.md).

1. **`runs.repo_root` is not a repository field** — written only where isolation
   resolved to a worktree, so 51 of 294 runs carry NULL and `$645.28` lands in
   one bucket with two unrelated directories.
2. **Twenty runs say they finished when they did not** — `stop_reason = 'Agent
   reported the task complete.'` with `reported_done = 0`.
3. **`priorWorkNotice` has never been delivered** — 0 of 500 `iteration` prompts
   carry it, since the commit that made pick-up resume a session.
4. **A hook that fires is invisible** — `--include-hook-events` is absent, and
   the injection log block's test names only two events.
5. **The prompt a cycle was sent is persisted and never rendered.**

## Corrections made to the survey by the closing pass

[18-validation.md](18-validation.md) resolved every citation in `00-` through
`17-` mechanically, re-ran every quoted query, and had one reader compare every
figure that appears in more than one file. **Seventy-one corrections were applied
across the eighteen files** — four making the recommendation easier, four harder,
sixty-three neither — and of 239 measurements re-run, 211 reproduced.

The four that matter:

- **The headline compliance lift was wrong three times, always flatteringly:
  61×, then 46×, then 37×. It is 21×.** Three independent causes — a dump
  truncated at 110 characters, an order-dependent `LIKE` that missed `git diff
  <range> --stat`, and a control group containing runs with no branch to diff.
  **Harder**, and the recommendation still stands: 84.8% against 4.0% survives,
  but the behaviour lift beside it is only 1.1×, which changes what the result
  means from "generated text is obeyed" to "generated text that names one cheap
  command is copied verbatim".
- **The corpus spend was the `completed` subtotal, not the corpus total** —
  $4,236.62 where all 294 rows are $4,303.70. **Neither**; every derived
  percentage moved by under a tenth of a point. One group diagnosed it as the
  database growing mid-survey, which would have been wrong.
- **About thirty line numbers were stale**, all by exactly +73, because `HEAD`
  moved to `ee93684` while the option files were being written. **Neither** — and
  it is the third consecutive survey in this directory to carry the same defect.
- **The commit count drifts.** `git log --since="2026-08-10"` returned 618, then
  615, then 612 as the window slid. Pinned with `--until` it is 612.
  **Neither**, and the pinned form is now what the file quotes.

Six disagreements between files are recorded and deliberately left standing,
because each needs a decision rather than an edit — including whether the
cycle-cap class is 102 runs or 83, which is the same defect as the twenty rows
that say they finished.
