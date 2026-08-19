# Validator baseline: how often does a `completed` run actually do the work?

Measured 2026-08-19 against this install's finished runs. This document answers one
question and nothing else: of the runs this app files as `completed`, how many did
not carry out the text in `runs.task` — and how many cannot be judged at all from
the artefacts an external validator would have.

It measures. It proposes nothing and changes no product code.

> **An offline spike has since run against these labels**, and it is the reason
> parts of this document carry corrections rather than only their original text.
> [`scripts/validator-spike/RESULT.md`](../scripts/validator-spike/RESULT.md) is
> its reading; the pitch it feeds is
> [`external-validator.md`](external-validator.md). Nothing shipped —
> `AssistKind` is still `"review" | "resolve"` (`src/lib/review.ts:51`) and no
> run is validated today.

---

## 1. What could not be reached, first

**The operator's database was not reachable from this checkout, and the sample was
rebuilt from session transcripts instead.** Everything below inherits that.

- `DATA_DIR` resolves to `<cwd>/.data` (`src/lib/config.ts:281-283`). The only
  `usagefoundry.db` files this container can open — `/workspace/UsageFoundry/.data/`,
  its `.next/standalone` copy, and the identical copies under the `/workspace3` and
  `/workspace4` mounts — are **empty**: `SELECT COUNT(*) FROM runs` returns 0 in all
  five. They are fresh databases created by a `next` process in the checkout, not the
  operator's history.
- The real one is at `/data/usagefoundry.db` on `/dev/vda1`, and `/proc/mounts` shows
  an empty `tmpfs` mounted over `/data` (and over `/backups`) in this sandbox. Opening
  it returns `unable to open database file`. There is no backup inside any readable
  mount: `scripts/backup-db.mjs` writes to `/backups`, which is masked by the same
  tmpfs.
- So **`status`, `stop_reason`, `spent_usd`, `iterations`, `origin`, `worktree_base`
  and `run_events` were all unavailable**, along with every run that produced no
  session transcript.

**And this part is not an accident of one sandbox — it is a deliberate invariant, and
it constrains the design directly.** Commit `01b34b7`, *"Keep the database out of every
agent's reach (#80)"*, made `/data` root-owned `0700` precisely so that the uid an agent
child runs as cannot read the SQLite file, the WAL or `server.lock`: *"the settings each
guard reads, the budget and status on every run, and the whole record of what happened —
rewritable with no HTTP request and no token."* `docker-entrypoint.sh` reclaims the mode
on every boot for installs whose volume predates it, and `deployment.test.ts` pins it.

So **a validator that runs as an agent child cannot read `runs.task` at all**, let alone
`status` or `stop_reason`. It has to either run inside the server process, or be handed
its inputs on the wire the way the reviewer already is (`review.ts` composes the prompt;
the child reads no table). That is a decision to take before anything else about a
validator is designed, and taking it the other way would undo #80.

The fallback the brief names is "the `uf/*` branches plus their commit messages, with
the task text unavailable". This run did better than that, and the difference matters
for how much weight the numbers carry:

`~/.claude/projects/-workspace--uf-worktrees-*/` holds **295 session transcripts** of
the agent children this app spawned, one directory per isolated checkout. Every entry
carries a `gitBranch` field, and `orchestrator.ts:1594` names a run's branch
`uf/<slot>-<runId.slice(0,8)>` — so a transcript's branch identifies the run that
minted it. **225 of the 295 are run transcripts** (their first turn is the app's run
preamble, "You are working in a dedicated git worktree…"); the other 70 are 67 merge-
conflict resolvers, one review agent, one probe, and one resumed run whose opening turn
is in a different file.

That recovers the **task text verbatim**, which is the input the whole judgement turns
on. What it does not recover, and what is therefore proxied:

| Field | Source used instead | Reliability |
|---|---|---|
| `runs.task` | first user turn of the transcript | exact |
| `reported_done` | last assistant turn is exactly `DONE` | exact — this is the string `cycleEnding` reads (`orchestrator.ts:4543`, called at `:7157`) |
| `status` | inferred: `DONE` → `completed` at `orchestrator.ts:7201` | exact for `reported_done`, **inferred** otherwise |
| `stop_reason` | inferred from the same signal | prose is not recoverable |
| `iterations` | count of run-prompt + `Continue…` turns in the session | close, not exact |
| `spent_usd` | **not recoverable.** Transcripts carry `usage` token counts, not cost | output tokens reported instead |
| the diff | commits attributed per run, see §2 | exact for 29/40, reconstructed for 11 |

The consequence for the headline number: **32 of the 40 sampled runs are certainly
`completed`** (they replied `DONE`, and `orchestrator.ts:7201` writes `completed` and
breaks). The other **8 are inferred `completed`** — they produced a full final report
and neither `DONE` nor `NEEDS_REVIEW`, which is the shape of a run whose cycle cap ran
out at `orchestrator.ts:7219`, also `completed`. Some of those 8 could instead be
`failed`, `blocked` or `cancelled`. Both label counts are given split by that line in
§4, because the split turns out to be where the whole finding lives.

Two further reach limits, both about what a *retrospective* look can see and not about
what a validator running at finish time would see:

- **66 of the 169 branches these runs worked on no longer exist** (39%). They were
  deleted after landing or when the checkout was reclaimed.
- **The merge queue moves the surviving refs forward.** `uf/usagefoundry-1-01df809b`
  today points at `d115a36`, a commit whose subject is
  `Merge branch 'uf/usagefoundry-5-f0ab2ed8'` — the drain's result, not that run's
  work. Five branches share that one tip. `git diff $(git merge-base <branch> main)
  <branch>` is empty for **all 103 surviving branches**, because every one of them was
  merged into `main` and is now an ancestor of it.

---

## 2. The sample, and how it was chosen

**40 runs**, from **6 folders**, over **2026-08-10 to 2026-08-18**.

| Folder | Runs | Reported `DONE` | No `DONE` |
|---|---|---|---|
| UsageFoundry | 25 | 21 | 4 |
| VisualMerge | 5 | 4 | 1 |
| VibeHub | 5 | 3 | 2 |
| GHtranslator (`gh-layer10`) | 3 | 3 | 0 |
| orient | 1 | 1 | 0 |
| RSSDashboard | 1 | 1 | 0 |
| **Total** | **40** | **32** | **8** |

**Universe.** The 225 run transcripts, minus the 12 sessions carrying an operator turn
mid-run (those are not unattended runs) → **213 unattended run sessions**, of which 150
end in `DONE`.

**Selection.** Stratified by folder × `reported_done`, systematic within each stratum:
each stratum was sorted by start time and every *k*-th run taken, so the sample spans
the whole ten days and nothing was picked for looking interesting. All of the smaller
folders' strata were taken whole where the quota exceeded the pool. The `DONE` quota was
set to 32 so that the certainly-`completed` subset alone clears the brief's floor of 25.
No run was dropped after its evidence was read.

**Attributing a diff to one run.** This is where the reconstruction was hardest, and the
difficulty is itself a finding (§6).

- **29/40 by commit message.** The transcript's own `git commit` command carries the
  message, and the subject matches exactly one commit in the repository. 378 of 407
  extracted subjects resolved uniquely across the six repositories.
- **3/40 by time window** (runs 22, 24, 38). The agent committed in a form that hides
  the message from the transcript (`-F <file>`, `-a` with an editor), so the fallback was
  non-merge commits on the run's branch dated inside the session's window. **For run 38
  that window held 26 commits from other concurrent runs**, and only reading them one by
  one identified `b73546d` as this one's.
- **1/40 by the run's own report** (run 30). Its branch is deleted and no ref reaches
  its commit; the sha was recoverable only because the final report named it.
- **7/40 with no commits at all** (runs 1, 2, 6, 10, 15, 31, 34). Five of those seven
  were right to commit nothing. Two — runs 2 and 34 — were not, and that is the whole
  `not-done` count.
- **17/40 sit on a branch shared by more than one run session**, and **9/40 are explicit
  continuations** ("This branch already carries the work of run X, which you are
  continuing"). For a continuation, `resolveIsolation` deliberately records
  `base: cont.base` — the *predecessor's* base, commented "The predecessor's, not the
  probe's" (`orchestrator.ts:~1640`), and `apiTypes.ts:613` states it outright: *"Its
  `worktree_base` is the chain's, so the diff above covers every link."* So the
  `worktree_base..HEAD` diff a validator would take is, for those 9 runs, the chain's
  diff and not the run's.

**Judging rule.** Each run was judged on **task text + diff + commit messages** only —
the evidence a validator gets. The final report was recorded but used only as a
cross-check, never as the thing that decided a label; where the two disagree, the note
says so. A run is `finished` when the change asked for is demonstrably in the diff;
`unjudgeable` when the artefacts cannot establish whether the deliverable exists at all.
Style, scope creep and "I'd have done it differently" were not graded.

---

## 3. The judged runs

`stop`: `done` = replied `DONE`, so `stop_reason` is *"Agent reported the task
complete."* and `status` is certainly `completed`. `cap?` = no `DONE`; most likely
*"Used all N work cycles allowed for this run."*, also `completed`, but inferred.

The run id is the branch's 8-hex suffix, which is `runId.slice(0,8)` of the run that
minted the branch. For the 9 continuations it is the predecessor's id; the session
column disambiguates.

| # | run id | session | folder | stop | label | reason | evidence |
|---|---|---|---|---|---|---|---|
| 1 | `49e86e67` | `7d04dae5` | UsageFoundry | cap? | **unjudgeable** | Task was "can you check for code quality problems?"; the product is prose, and an empty diff cannot separate a review done from nothing done | empty diff; branch deleted |
| 2 | `e37bfe6a` | `f85a9e16` | UsageFoundry | cap? | **not-done** | Asked to implement issue #16 with a regression test and commit it; nothing is committed and no commit exists | empty diff; no `git commit` in the session; branch deleted |
| 3 | `2514d080` | `caee658f` | UsageFoundry | done | finished | The named *Earlier chats* row now truncates only the title and carries time + waiting badge on a second line | diff of `src/app/chat/page.tsx` |
| 4 | `40e0cc2c` | `dea99e22` | UsageFoundry | done | finished | A cancel route, a Stop control and a `staleTurn` sweeper give an operator a way out of a stuck `thinking` row | new `api/chat/[id]/cancel/route.ts`, `chat.ts`, `chat.test.ts` |
| 5 | `59316d77` | `3206acaf` | UsageFoundry | done | finished | The pre-promise window named in #19 is wrapped so a throw fails the turn instead of stranding it | diff of `chat.ts`; new `chatTurn.test.ts` (98 lines) |
| 6 | `ddff2cf3` | `dc1d43af` | RSSDashboard | done | **unjudgeable** | Read-only context audit; the run was forbidden to write anything and its whole output was stdout prose | empty diff (correct); branch deleted |
| 7 | `41397184` | `a3c09412` | UsageFoundry | done | finished | Both owned pages rewritten, nothing else touched, and the section list regrouped from schema fields to decisions — the stated Done test | `settings/page.tsx` (+1111/−493), `account/page.tsx` |
| 8 | `dd927763` | `a20af8db` | UsageFoundry | done | ~~**unjudgeable**~~ → **finished** (corrected, see below) | The entire task text is "Implement WF1"; the specification it names is not in the artefacts, so a large diff has nothing to be checked against | task text; 5 commits exist |
| 9 | `e0cbde08` | `bfc4a3c3` | UsageFoundry | done | finished | The complaint was that a deciding block leaves no account of itself; the diff puts its reply, its refusals and a status line on the instance page | `workflows.ts`, instance page, `db.ts` columns, `workflows.test.ts` |
| 10 | `504855a6` | `10ae0848` | UsageFoundry | cap? | **unjudgeable** | Triage run explicitly forbidden to commit; the deliverable is GitHub issues, which are not in the repository | empty diff (correct) |
| 11 | `7c219726` | `4961e361` | UsageFoundry | done | finished | The land card's strategy splits into chosen-vs-default so a re-read stops overwriting the operator's pick — the defect as described | diff of `RunLand.tsx` (the GitHub close step is not visible) |
| 12 | `b319db9c` | `aa5cd606` | UsageFoundry | done | finished | Continuation; the five files the task scoped are the five its commits touch, with the level-indicator and list-view treatment asked for | 4 commits over `Meter`/`LiveTelemetry`/`RunCard`/`page.tsx`/`UsagePeriods` |
| 13 | `9408c6f3` | `b7493007` | UsageFoundry | done | finished | `zonedTime` now picks the candidate that renders on the requested local date, and the tests gained Santiago and Havana by name | `schedules.ts` (+23), `schedules.test.ts` (+186) |
| 14 | `7982210b` | `244a5df0` | UsageFoundry | done | finished | A run block carries an agent name on the node, refused by name at each door, with the editor, the MCP schema and tests | `workflows.ts` (+314), `agents.ts`, `WorkflowEditor.tsx`, `api/mcp/route.ts`, tests |
| 15 | `f5990cea` | `0e6c0477` | UsageFoundry | cap? | **unjudgeable** | Same shape as run 10 — issues filed on GitHub, nothing in the tree | empty diff (correct) |
| 16 | `de0d018f` | `f97b8722` | UsageFoundry | done | finished | `duePausedRuns` and `planPausedRun` are exported and the test file covers the four branches the task enumerated | `orchestrator.ts` (+213/−60), `orchestrator.test.ts` (+243) |
| 17 | `e7d8d50e` | `c23c5f1a` | UsageFoundry | done | finished | Backup is `VACUUM INTO` rather than `cp`, a restore script exists, both are covered by tests, and the operator doc is written | `scripts/backup-db.mjs`, `restore-db.mjs`, `backupRestore.test.ts` (359), `docs/backup-and-restore.md` |
| 18 | `2fda340c` | `1788e5b9` | UsageFoundry | done | finished | Three commits, one per issue — park regardless of enforcement, jitter the wake-ups, give a rate limit its own ladder — each with tests | `orchestrator.ts` + `orchestrator.test.ts` ×3 |
| 19 | `6e7db44b` | `9d902b7b` | GHtranslator | done | finished | The spec asked for exists with the write path, the read path and the drop rule, plus the decisions record and a filled Readme | `docs/SPEC.md` (739), `docs/DECISIONS.md` (214), `Readme.md` (198) |
| 20 | `3ab6c659` | `2065a0b8` | GHtranslator | done | finished | Issues #4 and #5: referential checks against HEAD, and PR/commit/comment schemas, each with its own test file | `internal/check/referential.go` (718) + `pr.go`/`commit.go`/`comment.go` + tests |
| 21 | `048518d3` | `44f8961c` | UsageFoundry | done | finished | The symptom was a queue panel whose statuses never move; the diff answers every row it took and removes the poll gating that froze the panel | `mergeQueue.ts`, `git.ts`, `branches/page.tsx`, `mergeQueueDrain.test.ts` (213) |
| 22 | `f8da8c51` | `e8970070` | VisualMerge | done | finished | `docs/00-shape.md` exists at 293 lines and nothing else changed — a documents-only run doing exactly that | commit `61423da` (time-window attribution) |
| 23 | `3ab6c659` | `ddd92e5d` | GHtranslator | done | finished | `digest` exists with its four sections, the drop rule and the non-optional footer | `internal/digest/*` (2913 lines incl. 3 test files) |
| 24 | `53822343` | `9bcf9107` | VisualMerge | done | finished | WP1's named deliverables are all present: schema types + JSON schema, a CLI emitting the four verdicts, the widget, fixtures, CI | 5 commits (time-window attribution) |
| 25 | `53822343` | `97cb0fbe` | VisualMerge | cap? | finished | The six trap tests are committed red against the naive parser and green after, and the WP2 mapping, fixtures and `unsupported[]` are there | 14 commits; `traps.test.ts` red then green; `unsupported.ts`, 5 fixture cases |
| 26 | `a6c9d659` | `5f56af4e` | VibeHub | done | finished | Both mandatory tasks landed as documents: W4/D2 settled in `docs/03-walls.md`, and the A2A memo as `docs/09-why-not-a2a.md` | 5 doc commits over `docs/03-walls.md`, `docs/09-why-not-a2a.md`, `research/sources.md` |
| 27 | `a6c9d659` | `053283db` | VibeHub | done | finished | The Track B harness exists under `poc/` — wire schema, verifier, adversaries, scenarios, tests — and D11 is left open as required | 5 commits, >4000 new lines under `poc/` |
| 28 | `02c3e132` | `f07ad374` | UsageFoundry | cap? | finished | Both reported symptoms addressed: the pane's absolute boxes are contained (one scrollbar) and the checkout card gains the missing margin | `AppShell.tsx` (+14), `branches/page.tsx` (+1/−1) |
| 29 | `fb9a7303` | `efb99289` | UsageFoundry | done | finished | Every named deliverable is under `scripts/sandbox-probe/`: probe Dockerfile, seccomp JSON, probe script, its test, a runbook | 7 new files, 2935 lines |
| 30 | `27441d0c` | `cffbabb2` | UsageFoundry | done | finished | The measurement asked for is written into `docs/verification.md` — but its branch is deleted and **no ref reaches the commit now** | commit `83fa7ab` (+117/−24), locatable only via the run's own report |
| 31 | `a0edf3c2` | `24e538ca` | VibeHub | cap? | **unjudgeable** | Task was "can you tell me whats going on in this repo?"; no diff is expected and none exists | empty diff |
| 32 | `66123348` | `126c3ad2` | orient | done | finished | The evidence document asked for exists at 844 lines, and no code was touched, as instructed | commit `3000634`, `docs/fundamentals-premise.md` |
| 33 | `6fe5ac47` | `567e63d6` | VisualMerge | done | finished | Documents-only shaping run: the shape doc gains the third layout and refuses the diagram, the plan gains a work package, `src/ bin/ test/ scripts/` untouched | 3 doc commits over `docs/00-shape.md`, `docs/01-implementation-plan.md`, `CLAUDE.md` |
| 34 | `4f89e703` | `96583812` | VibeHub | cap? | **not-done** | The audit was to run the `poc` suite from a cold install and correct every number that does not reproduce; nothing in the tree changed | empty diff; no commits in window |
| 35 | `c55bc71b` | `c742c8ef` | UsageFoundry | done | finished | The check and the claim are one guarded write in `sendChatMessage`, with a regression test around the race | `chat.ts` (+54), `chat.test.ts` (+147) |
| 36 | `dd927763` | `b7ed0edf` | UsageFoundry | done | ~~**unjudgeable**~~ → **finished** (corrected, see below) | The entire task text is "Implement WF2" — same as run 8, the specification is not in the artefacts | task text; 7 commits exist |
| 37 | `f0ab2ed8` | `ba4fd162` | UsageFoundry | done | finished | #54 releases the chat's busy flag through `chatRequest`, #56 stops an unread template list reading as deleted; both with tests | 2 commits; `chatRequest.test.ts`, `format.test.ts` |
| 38 | `4041605f` | `def257d1` | UsageFoundry | done | finished | `docker-compose.yml` gains `mem_limit`, `pids_limit`, `ulimits` and `security_opt` with the numbers justified, and `deployment.test.ts` is revised to match | commit `b73546d`, identified out of 26 commits in the window |
| 39 | `f8da8c51` | `f33e8480` | VisualMerge | done | finished | `docs/01-implementation-plan.md` exists at 1175 lines and takes a position on each numbered question the task listed | commit `fed425c` |
| 40 | `a6c9d659` | `a600983d` | VibeHub | done | finished | `docs/08-track-b-shape.md` is written and `docs/06` reconciled in place, which is what the task named | 4 commits; `docs/08-track-b-shape.md` new at 486 lines, `docs/06` +45/−13 |

### Correction to rows 8 and 36

**Both labels were wrong, and for the same reason: this measurement read
`runs.task` where a validator reads the composed prompt.** `runs.task` on a
workflow member is the *node's own title* — here, literally `Implement WF1` and
`Implement WF2` — and the reason column above describes that title. The prompt
the run actually received is far longer and carries the specification in full.

Re-derived from the spike's own committed case files
(`scripts/validator-spike/cases/08-a20af8db.json`, `36-b7ed0edf.json`), which
hold the composed prompt under `task`:

| | case 8 (`a20af8db`) | case 36 (`b7ed0edf`) |
|---|---:|---:|
| prompt length | **4,953 characters** | **6,210 characters** |
| sections | `# Task`, `## Order`, `## What must survive it`, `## Afterwards`, `## Out of scope`, `# Tests`, `# Verify` | `# Task`, `## Reuse the budget machinery`, `## Enforcement and overshoot`, `## When it trips`, `## Counting the spend`, `## Who sets it`, `# Tests`, `# Verify` |
| where `WF1`/`WF2` appears | once, under `## This run specifically` | once, under `## This run specifically` |

Named deliverables, ordering constraints and a definition of done are all in the
prompt. `WF1`/`WF2` is a label, not the specification. On the input a validator
actually receives, both rows are judgeable and `finished` is defensible — which
is what the spike returned for both.

**The row labels above are struck through rather than rewritten, and the reason
column is left as the measurement run wrote it.** `scripts/validator-spike/RESULT.md`
deliberately did *not* rescore: both rows are still counted as misses in the
spike's 34/37, and had they been rescored it would read 36/37. Keeping the
original text here is what makes that decision checkable. **The counts in §4 and
§5 below are the corrected ones**, because a base rate that a reader carries into
a build decision should not be the superseded number.

---

## 4. Base rate

**n = 40.** Corrected for rows 8 and 36 above; the original figures are kept
beside each.

| Label | Count | Share of n = 40 | As originally labelled |
|---|---:|---:|---|
| `finished` | 33 | 82.5% | 31 / 77.5% |
| `partial` | 0 | 0% | 0 / 0% |
| `not-done` | 2 | 5.0% | 2 / 5.0% |
| `unjudgeable` | **5** | **12.5%** | 7 / 17.5% |

Split by the one signal that separates the two ways a run becomes `completed`
(both corrected rows are `DONE` runs, so the whole change lands in the top row):

| | n | `finished` | `partial` | `not-done` | `unjudgeable` |
|---|---:|---:|---:|---:|---:|
| `reported_done = 1` — certainly `completed` | **32** | 31 (96.9%) | 0 | **0 (0%)** | 1 (3.1%) |
| no `DONE` — inferred `completed` via the cycle cap | **8** | 2 (25%) | 0 | **2 (25%)** | 4 (50%) |

*As originally labelled the top row read 29 (90.6%) / 3 (9.4%). The bottom row is
untouched by the correction.*

**That split is the result**, and the correction sharpens rather than softens it.
Both runs that failed to do the work were runs that never said `DONE`. Among the
32 that did, every judgeable one had the work in the diff — **31 for 31**, where
the original labelling said 29 for 29. Among the 8 that did not, the judgeable
ones split evenly: two did the work, two did not.

The honest reading is narrower than "DONE is trustworthy". `reported_done` and the
cycle-cap ending are already distinguishable in the database — `reported_done` is its own
column and `stop_reason` is different prose — so this is not a case for a validator so
much as a case for *not treating one `completed` as the other*. On this install, the
run that is worth validating is the one that used up its cycles, and there are far fewer
of them: 63 of 213 unattended run sessions (29.6%) end without `DONE`.

Three cautions on the numbers, all of which push the same way:

- **`partial = 0` is real but fragile.** Every judgeable run either had the asked-for
  change or had nothing. Nothing landed half-built. But the labelling rule was "is the
  change present", not "does it work" — see §6.
- **The `not-done` denominator is four.** Only 4 of the 8 non-`DONE` runs were judgeable
  at all, so "25% not-done" rests on 2 of 4. It is a signal about where to look, not an
  estimate.
- **The strata are not equally sampled** (32/150 of `DONE` runs, 8/63 of the rest), so
  the 5% overall `not-done` figure is a property of this sample and not a population
  estimate.

---

## 5. Unjudgeable: 5 of 40 (12.5%), and why

*Originally 7 of 40 (17.5%). Rows 8 and 36 were corrected out of this count —
see §3 — and with them the entire middle category below, which now has **no
members in this sample**.*

This is the number the validator idea turns on, because it is a ceiling no validator
clears however good it is. All five are about the **task**, not the run — and all
five are now one thing: **an empty diff that is correct.**

| Kind | Runs | Why nothing can decide it |
|---|---|---|
| **The deliverable never enters the repository** — 4 runs | 6, 10, 15, 31 | Two triage runs whose product is GitHub issues and that were *forbidden* to commit; one read-only context audit whose whole output is stdout; one question ("can you tell me whats going on in this repo?"). The correct diff is empty, and an empty diff is also what a run that did nothing leaves. Run 1 below is a fifth empty diff, and runs 2 and 34 — the two `not-done` cases — are empty diffs as well. **The artefacts cannot separate the five correct empties from the two wrong ones.** |
| ~~**The task names a specification the artefacts do not contain** — 2 runs~~ | ~~8, 36~~ | **Retracted — this category is empty.** The claim was that the complete task text is `Implement WF1` / `Implement WF2`. That is `runs.task`, the workflow node's title; the composed prompt those runs received is 4,953 and 6,210 characters and carries the specification in full. The measurement was reading the wrong field, not describing a class of task. |
| **The deliverable is an analysis, not a change** — 1 run | 1 | "can you check for code quality problems?" — the answer is prose, and the run correctly wrote no code. |

That collapse matters more than the two percentage points. The 17.5% figure was
carried by *two* different problems, and one of them was an artefact of how this
document read the database. What is left is a single problem — a correct empty
diff — with a single candidate fix, and it is the one the spike's testimony arm
went after and found did not work (`RESULT.md`, *The testimony arm*): the
discrimination is in the task text, which a validator already reads.

**12.5% is a floor, not the whole ceiling.** A second, larger group was judged
`finished` on a *restatement* of the specification rather than the specification itself:
**14 of 40 runs (35%) point at a GitHub issue** ("every acceptance-criteria box is a
requirement") that the artefacts do not contain. They were judgeable only because the
prompt happened to restate the defect and a "Done looks like" sentence. Where the run
prompt is generated from a template that does *not* restate it, those 14 lose their
specification the same way. **A validator's reach is set by how much of the
specification the prompt writer chose to inline — not by the validator.**

Counting both: **19 of 40 (47.5%)**, down from the 21 of 40 (52.5%) this section
originally reported.

**Two cautions on that figure, and the second is the important one.** It is
arithmetic over this document's own two components — the corrected 5 plus the
unchanged 14 — not a fresh count. And **the 14 has not been re-derived.** It came
from the same measurement run, on the same basis, and the defect just corrected
in rows 8 and 36 was precisely that `runs.task` is not the prompt. Whether some
of those 14 also carry their specification in a composed prompt nobody read is
open; if they do, 47.5% is itself too high. Re-deriving it needs the case files
under `scripts/validator-spike/cases/`, which now hold every composed prompt, and
was not done here.

---

## 6. Which signals carried the judgements, ranked

1. **The set of files the commits touched.** The strongest single signal: most tasks
   name a file, a function or a directory, and a `--name-status` against the run's
   commits answers "did it go where it was asked" before a line of the patch is read.
   Runs 7, 12, 14, 22, 24, 29, 32, 33, 39 and 40 were settled on the file list alone.
2. **The presence of a test file, and its contents.** Roughly half the tasks demand "a
   regression test that fails before the change and passes after". A validator cannot
   see the *fails before* half, but it can see whether a test exists and whether it
   names the thing the task named — Santiago and Havana in run 13, the four enumerated
   branches in run 16, six named traps in run 25. Cheap and high-yield.
3. **Commit messages, as a scaffold rather than as evidence.** They made the
   time-window attributions tractable (run 25's `Commit the six trap tests red against a
   naive parser` is the acceptance criterion restated) and they were essential to pull
   run 38's one commit out of 26 in its window. They were never taken as proof of
   anything on their own.
4. **The patch body.** Needed for maybe a third of the runs, and only for tasks that
   named a specific mechanism — the `try` around a non-`async` call in run 5, the
   split of chosen-vs-default strategy in run 11.

**What I wanted and did not have, in the order I wanted it:**

- **A way to tell a correct empty diff from a wrong one.** This is the single largest
  gap, and after the §3 correction it is the *only* thing left in §5. Seven sampled
  runs produced nothing; five were right to and two were not. **What I wanted here
  was the run's own final text, and that turned out to be the wrong ask.** The
  spike gave the validator exactly that, on all eight empty-diff cases, and
  **zero of eight verdicts changed** (`scripts/validator-spike/RESULT.md`, *The
  testimony arm*). What separates them is the task text: every one of the five
  correct empties was told not to commit or was asked a question, and both
  `not-done` runs were told to commit and did not. The sentence above — "only the
  run's own final text distinguishes them" — is kept because it is what this
  measurement concluded, but it is measured false on n = 8.
- ~~**The specification the task points at.**~~ **Half retracted.** No amount of
  diff-reading recovers a GitHub issue body, and that is still true of the 14 in
  §5. But the two rows I filed under it — 8 and 36 — did not have a missing
  specification at all; I was reading `runs.task` rather than the prompt. See §3.
- **A run of the suite.** Nothing in the artefacts establishes that anything *works*.
  Every `finished` label above means "the change asked for is present", never "the
  change asked for is correct". Runs 3, 12, 24, 28 and 33 make claims about rendering,
  layout or a clean-clone build that no diff can settle. Several run reports say so
  themselves — run 21 states outright that it never reproduced the reported symptom.
- **Per-run commit boundaries.** §2. `worktree_base..HEAD` is the chain's diff for the
  9 continuation runs here, by design and documented as such.
- **The transcript.** Deliberately not used to judge, but it is worth recording that it
  answers almost everything above, and it is the only artefact that does. Which is also
  the warning: it is the run's own account of itself. Runs 26 and 32 delivered documents
  asserting that a paper was read in full and that measurements were taken; both are
  self-attesting, and neither the diff nor the transcript can confirm the claim.

---

## 7. What is left unmeasured

- **Every run that produced no transcript**, and every run predating the transcript
  retention window. Population size and the true `completed` count are unknown.
- **Runs that did not end in `completed`.** `failed`, `blocked`, `cancelled` and
  `needs-review` were out of scope, and without `status` they cannot be separated from
  the 8 inferred-`completed` runs anyway.
- **Real `stop_reason` prose and real `spent_usd`.** No cost figure in this document —
  the sample's 40 sessions emitted 6.40M output tokens, which is the only spend-shaped
  number recoverable, and it is not what `runs.spent_usd` holds.
- **Whether any `finished` run's change actually works.** Not attempted; no suite was
  run against any of these branches.
- **Whether the two `not-done` runs were in fact filed `completed`.** Both lack `DONE`
  and both end with a full report of what they could not do, which is the cycle-cap
  shape — but `failed` or `blocked` cannot be excluded without the database.
- **The runs behind the 66 deleted branches.** Their work is still in `main` where it
  landed, but nothing reachable ties it back to a run, so they could not be sampled with
  a diff. Four sampled runs (1, 2, 6, 30) had deleted branches; run 30's commit was
  found only because its own report named the sha, and no ref reaches it. A validator
  running at the moment a run finishes is unaffected by any of this — the branch is
  there and it is the run's. A retrospective audit is affected, and the configurable
  horizons in `retention.ts` bound how far back one can ever be run.
