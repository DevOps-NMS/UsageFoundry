# Validation

Nine readers over the eighteen files: eight taking disjoint groups with a
mandate to open every `path:line`, re-run every quoted query and fix what was
wrong in place, and one reading everything and editing nothing, looking for
figures that disagree between files.

**Seventy-one corrections were applied by the groups — four making the
recommendation easier, four making it harder, sixty-three neither. Of 239
measurements re-run, 211 reproduced and 28 did not.** A closing pass then fixed
the disagreements the consistency reader found, including the survey's headline
figure, which was wrong in three successive drafts and wrong in the same
direction every time.

## The headline figure was wrong three times

The survey's central claim is that `continuedWorkNotice` — generated text in the
first user message — is complied with where CLAUDE.md's gate is not. Its lift
was stated as **61×**, then **46×**, then **37×**. It is **21×**.

| draft | control | matcher | baseline | lift |
|---|---|---|---|---|
| `06-`, first | 217 untold runs, first ten tool calls | truncated dump | 3 — 1.4% | 61× |
| `15-`/`16-`/README | 217 untold runs | `LIKE '%git diff%--stat%...HEAD%'` | 4 — 1.8% | 46× |
| `06-`, after validation | 217 untold runs | corrected | 5 — 2.3% | 37× |
| **settled** | **175 matched: isolated, ran Bash, untold** | **three separate `LIKE`s** | **7 — 4.0%** | **21×** |

Three independent errors, all inflating the same number:

- **The dump was truncated.** `/tmp/cont.tsv`, which the first draft scored, cut
  each command at about 110 characters, so a `git diff --stat <sha>...HEAD`
  chained behind a `git log` lost its `...HEAD` and was scored as a miss.
- **The matcher was order-dependent.** `LIKE '%git diff%--stat%...HEAD%'` matches
  `git diff --stat <range>` and misses `git diff <range> --stat`, which is the
  same command. Three separate `LIKE`s find both.
- **The control was not matched.** The 217 untold runs include unisolated runs
  with no branch to diff, which cannot comply and so depress the baseline.
  Restricting to the 175 untold runs that were isolated on a worktree and ran
  Bash is the comparison the told group belongs to.

**Direction: harder**, and it is the most important correction in this pass. The
conclusion survives — 84.8% against 4.0% is not a coincidence — but the
behaviour lift beside it is only **1.1×** on running any `git log` at all, and
that is the figure that says what the notice actually does. It does not make a
run examine its branch. Untold isolated runs do that 90.9% of the time anyway.
It makes the run examine it *the way the notice said to*, which is a claim about
specificity rather than about attention.

## The spend figure was the wrong row

`00-problem.md` reported the corpus spend as **$4,236.62**. That is the
`completed` subtotal. All 294 rows sum to **$4,303.70** (`completed` 4,236.62 +
`stopped` 52.63 + `failed` 14.15 + `needs-review` 0.29). The figure was taken
from a status histogram's `completed` row and captioned as the corpus total, and
four option files inherited it.

One group diagnosed the gap as the database having grown during the survey,
which would have been a reasonable guess and is wrong: the run count is 294 in
both readings. **Direction: neither** — every percentage derived from it moved by
less than a tenth of a point — but the wrong *explanation* would have entered the
record, and that is worth more than the number.

## Verdict table

| Claim | Verdict |
|---|---|
| 73.2% of `Read` calls are of a path an earlier run on the same repository read | **reproduces exactly** — 4,284 of 5,856 |
| 50.6% of those are files the same run then edits | **reproduces exactly** — 2,168 |
| the per-folder table, all twenty cells | **reproduces exactly** |
| 81 of 189 UsageFoundry runs opened nothing new | **reproduces** — but see the 189/190 residual below |
| 20.9% of OTLP spend before the first edit | **reproduces** |
| 45.0% prequential top-20 coverage with a ×0.9 decay | **reproduces to about one point**; the ordering of the three ranking rules, which is what the design decision rests on, is stable |
| 112 runs edited `src/lib/`, 11 read a `docs/agent/` doc | **reproduces** — the "named one in any tool call" figure corrected 13 → 14 |
| one `needs-review`, one non-zero `exit_code` in 294 runs | **reproduces exactly** |
| 538 `tool_error` rows over 70 runs, and the per-tool histogram | **reproduces exactly** |
| 214 bubblewrap rows across 10 runs, dated to two days | **reproduces exactly** |
| `run_reviews` never swept | **reproduces** — `grep -rn "DELETE FROM run_reviews" src/` returns nothing |
| 59 completed resolutions at $238.20, mean $4.04 | **reproduces** — corrected where it was paired with the 68-row total, which is $240.03 |
| the compliance lift | **wrong three times, corrected to 21×** |
| the corpus spend | **wrong row, corrected to $4,303.70** |
| 157 distinct `tool_error` signatures | **does not reproduce** — 158 under three normalisation variants |
| 324 rows after removing bubblewrap | **ambiguous** — 324 drops the one 214-row signature, 320 drops every `bwrap`/`[Sandbox Linux]` row. Both defensible, neither stated |
| 618 commits in the window | **does not reproduce** — the open-ended `--since` form drifts as the window slides; pinned with `--until` it is 612 |

## The stale-line-number class, for the third survey running

`HEAD` moved to `ee93684` while the option files were being written, adding 73
net lines to `src/lib/orchestrator.ts` above line 4753. Every citation past that
point was off by exactly +73, and the survey carried about thirty of them —
`sandboxArgs` at `:5159` for `:5232`, the hook-injection block at `:6135`–`:6148`
for `:6208`–`:6221`, the once-per-run settings read at `:6379`/`:6402` for
`:6452`/`:6475`.

That is the same defect `proposals/ContextControl/19-validation.md` found fifty
times and `proposals/ModelRouter/15-validation.md` found before it. **Three
surveys, three passes, the same class.** The bare-`:NNNN` variant recurred too —
a reference like `` `:4397`–`:4399` `` chains off whatever file was last named,
and in at least two places that was `src/lib/settings.ts` when the intended file
was `src/lib/orchestrator.ts`.

The lesson this repository has now learned three times and not acted on: a
survey written against a moving tree needs its citations resolved mechanically
at the end, and a bare `:NNNN` should not be written at all.

## Also found, not a claim anyone in the survey made

**`src/lib/sandbox.ts:108`'s own comment is stale.** It says "214 of this
install's 484 `tool_error` rows". The table now holds 538. The 214 and the
"**Measured, not read**" marker both still hold; the denominator does not.

**`proposals/ContextControl/02-levers-on-the-pin.md` carries the same stale
line numbers** this survey had — `5158` for `sandboxArgs`, `4828`–`4831` for the
`--plugin-dir` docblock — because the same commit moved them. Not this survey's
files and not edited here.

**`storageReport` reads `run_events` with a bare unkeyed `COUNT(*)`**
(`src/lib/retention.ts:807`), which is the counterexample to one option file's
claim that every existing reader of that table is keyed on `run_id`. Corrected
in the file; recorded here because it is also the precedent that a full scan of
that table is already something this app does.

**The whole directory is untracked in git.** `?? proposals/ContinuousImprovement/`
— so no line number in it can be checked against a committed baseline, and no
edit made in this pass is recoverable from history.

## Unverifiable from here

- **That `--settings` survives `--resume` and `--plugin-dir` does not.** Read out
  of `proposals/ContextControl/02-levers-on-the-pin.md:183`–`:217` verbatim. No
  CLI was run in this pass, and unlike that survey this one did not rebuild the
  recorder. Every option that depends on the channel depends on that survey's
  probe rather than on one of ours.
- **The byte-weighted reading figures** — 27.2 MB of 31.1 MB, about 6.8M tokens.
  The script that charges a sliced read at `limit × mean bytes per line` is a
  reconstruction of what was read, not a record of it, and `00-problem.md`
  already says to treat it as an order of magnitude.
- **Wall-clock timings** (0.155 s, 1.26 s, 0.081 s) re-ran within noise on the
  same container and were left as written rather than churned to a second
  decimal that will move again.
- **Whether the 21× is causal.** Runs receiving `continuedWorkNotice` are
  continuation runs. The matched control removes the isolation confound and not
  the continuation one. `03-experiment-holdout.md`'s probe (b) is the design that
  would separate them, and it has not run.

## What this validation did not check, and what is still inconsistent

The consistency reader found more disagreements than the closing pass fixed.
These are known and left standing, because each needs a decision rather than an
edit:

- **189 or 190 runs read on `/workspace/UsageFoundry`.** `00-problem.md` says
  189 grouped by folder; `03-experiment-holdout.md` says 190 grouped by
  `repo_root`, and its arrival rate and its `C(190,2)` pair count depend on 190.
  Repair 0a — `repo_root` on every run — is what makes the two agree.
- **The cycle-cap class is 102 runs or 83.** `17-implementation-sketch.md` uses
  `completed` + `reported_done = 0` (102); `05-option-ending-code.md` reconstructs
  the class from `stop_reason` and gets 83. `05-` shows the 102 contains rows the
  sentence does not support, which is the same defect as the twenty bad rows.
- **The rolling week is $2,900.81 over 172 runs or $1,907.25 over 113.**
  `07-option-gate-hook.md` and `12-option-mcp-tool.md` measure different windows
  and neither says which.
- **`14-option-delegate-the-reading.md` attributes a phrase to
  `02-what-already-tries.md` that is not in it**, and gives `DELEGATION_NOTICE`
  two lengths in one file (664 and 666 bytes).
- **`09-` and `13-` give different per-path resolution counts** for the same
  table at different scopes and reach different characterisations from them.
- **`15-comparison.md` scores Option C a 4 on "acts on a measured prize"** where
  `06-option-prior-read-pointer.md` says in as many words that the option is
  orientation and not saving. Both are defensible — the *ranking* is measured and
  the *saving* is not — but the score table does not say which is being scored.

And two things nobody checked at all: that the eleven option files' *arguments*
are sound rather than merely cited, which is a job for a reader and not a pass;
and whether any of the repairs in `17-implementation-sketch.md` phase 0 actually
work, since none has been written.
