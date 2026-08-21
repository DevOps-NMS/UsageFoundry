# Implementation sketch

Six phases. Each names the invariant it must not break, what an operator sees
when it lands, and whether it earns a unit test against `CLAUDE.md`'s bar — *a
pure function whose failure mode is silent*. Phases 0 to 3 are the
recommendation; 4 is the measurement; 5 is conditional on what 4 reports.

Nothing here adds a table, a retention horizon, a `StorageReport` arm, an MCP
tool definition, a billed model call, or a byte written into a mounted folder.

## Phase 0 — the five repairs, none of which needs this proposal

**0a. `runs.repo_root` on every run, not only isolated ones.** It is written
where isolation resolves to a worktree, so 51 of 294 runs carry NULL and
`$645.28` lands in `groupRunSpend`'s single no-repository bucket beside two
unrelated directories. Resolve it at `createRun` for every run — synchronously,
because constraint 9 forbids an `await` on that path — and backfill nothing:
existing rows stay NULL and the readout names that bucket honestly rather than
pretending it is one repository.

*Invariant:* `docs/agent/concurrency-and-ownership.md` — no `await` between entry
and INSERT. *Operator sees:* the existing `repoSpend` card stops merging three
directories. *Test:* no — it is a field assignment, and its failure is visible in
the card.

**0b. The twenty rows that say they finished.** `stop_reason = 'Agent reported
the task complete.'` with `reported_done = 0`, because the column arrived
`INTEGER NOT NULL DEFAULT 0`. This is a data repair, not a code one, and it is
the exception `CLAUDE.md` describes: a destructive statement inside a single
`db.transaction` in `migrate()`, scoped by the exact `stop_reason` literal and
by `finished_at < ` the column's own introduction.

*Invariant:* schema changes are idempotent statements in `migrate()`; a
destructive one runs inside one transaction. *Test:* no.

**0c. Decide what `priorWorkNotice` is.** Zero of 500 `iteration` prompts have
ever carried it. Either the session-less-with-prior-cycles path is reachable and
something else is wrong, or it is not and the function is dead. This is a
half-hour of reading `nextPrompt`'s branch conditions, and the outcome is either
a deletion or a bug report — but not a third notice landing beside it while
nobody knows which.

**0d. Make a hook visible.** Add `--include-hook-events` to `buildArgs`, and
widen the hook-injection log block's test beyond `SessionStart` and
`UserPromptSubmit` so a `PostToolUse` injection is not silently dropped on the
floor. Phase 5 is unbuildable without both; constraint 6, "It must be visible on
the run's own log", is the reason to do it anyway.

*Invariant:* constraint 2 — `buildArgs` rebuilds the whole argv per cycle, so
this one rides every cycle like the three already there. *Operator sees:* hook
lines on the run log. *Test:* no — the existing argv test asserts flag survival.

**0e. Render the cycle's prompt.** The `iteration` event already carries it;
`describeEvent` prints "Work cycle N". Put the prompt behind a `ui/Disclosure` on
the cycle row.

*Invariant:* `docs/agent/conventions.md` — a `<details>` is `ui/Disclosure`, and a
caller's class never cancels the component's own spacing. *Operator sees:* the
exact text every cycle was sent. *Test:* no.

## Phase 1 — `src/lib/repoReading.ts`, the readout

One module, modelled on `src/lib/repoSpend.ts` and inheriting its refusals: it is
not a guard, it is not a fourth cost source, and every figure it produces says
which of the three sources it read. Three pure functions over rows the caller
supplies, so the SQL stays at the edge and the logic stays testable:

1. `crossRunReading(rows)` → per repository: `Read` calls, the share of a path an
   earlier run on the same repository already read, and **that share split by
   whether the same run went on to edit the file**. The split is the whole
   point; an unsplit number overstates the prize by a factor of two.
2. `repeatedFailures(rows)` → `tool_error` grouped by a normalised signature,
   ordered by `COUNT(DISTINCT run_id)` rather than by row count, so one run
   failing 214 times does not outrank ten runs failing once.
3. `contention(rows)` → Option F(a): `run_reviews` where `kind = 'resolve'`,
   `json_each` over `resolved_paths`, per repository, with the dollars attached.

The queries are full scans — `run_events` has only `idx_run_events_run(run_id,
id)` — and measure 0.155 s over 124,861 rows, which is fine at a page's cadence
and would not be fine per cycle.

*Invariant:* `docs/agent/conventions.md` — the route needs `runtime = "nodejs"`
and `dynamic = "force-dynamic"`; `docs/agent/metering.md` — three sources never
summed. *Operator sees:* a card per repository: what runs keep reading, what
they keep failing at, what they keep colliding in. *Test:* **yes, all three.**
The signature normaliser and the edited/not-edited split both fail silently and
both are pure — the normaliser by collapsing two unrelated failures into one row
or splitting one into two hundred, the split by quietly reporting the unsplit
number.

## Phase 2 — `ending_code`

`addColumn(db, "runs", "ending_code", "TEXT")` beside the `needs_review_reason`
line, written into the `carried` object at whichever branch already computed the
final status — never parsed back out of `stop_reason`, which `src/lib/db.ts`
names as the one thing that must never become a parse — and nulled by
`reopenRun`'s UPDATE beside the fields it already clears.

Its one populated cell on this install is cycle-cap exhaustion: 102 of 277
`completed` runs. That is the segment every later reading wants and the one
`runs.status` cannot express.

*Invariant:* written on **every** ending, or it describes a segment two pick-ups
old. *Operator sees:* the run list distinguishes "finished" from "ran out of
cycles". *Test:* no — it is a write at a branch, and phase 1's card is where a
missing write becomes visible.

## Phase 3 — the pointer, behind the holdout

A pure `priorReadRanking(rows, { decay: 0.9, limit: 20 })` returning repo-relative
paths ordered by decayed read frequency — the rule the measurement chose, at
45.0% prequential coverage against 42.3% for raw frequency and 39.2% for
distinct-run counts. Fed by one synchronous `better-sqlite3` query resolved
**once per run**, beside `settings` and `githubTokenFor` rather than beside
`enabledPluginDirs`, because the ranking cannot change inside a run and
constraint 9 asks every option to say which class it is in.

Delivered as a **generated** block in `nextPrompt`'s session-less join, in the
slot `priorWorkNotice` occupies, ahead of the task. Generated and not a
`DEFAULT_*`: constraint 1, and the same rule `COMPLETION_NOTICE` and
`continuedWorkNotice` already follow. Its wording should be a statement of fact
in the shape that was measured to work — *these are the files earlier runs on
this repository opened most* — and not an instruction to read them.

Gated by `inHoldout(runId)`, a pure function over the run id alone so that it is
stable across a restart and recoverable from the row without a column.

*Invariant:* constraint 1 (generated, four doors if any setting is added at all),
constraint 4 (tip of a fresh conversation, nothing to invalidate), constraint 9
(synchronous, once per run). *Operator sees:* the block itself, via phase 0e, on
half of their runs. *Test:* **yes, both functions.** The ranking's failure is
silent — a wrong relativisation returns absolute paths that look plausible and
match nothing — and the holdout's failure is silent in the worse direction: a
non-deterministic split makes the whole of phase 4 unanalysable after the fact.

## Phase 4 — read the holdout back

No new capture. Both halves are already persisted: the exact prompt per cycle in
the `iteration` event, and every tool call's `file_path` in the `tool` events.
The compliance query is a join between them and already returns 1,014 (cycle,
named path) pairs across 191 cycles at 62.3% opened, in 1.26 s.

Report three things per arm, and be explicit that they are three different
questions: **compliance** (did the run open a named path), **displacement**
(`d` — did it read *less*, which needs a denominator that compliance does not
supply), and **outcome** (`runs.iterations`, spend by source, whether
`reported_done` was reached).

At roughly 27 runs a day and a 50% split, a fortnight is the order of magnitude
for separating an effect the size of the observational lift. Say so on the card
rather than letting a reader infer significance from a bar.

*Invariant:* `docs/agent/metering.md` — the spend column names its source and is
never added to another. *Test:* no new pure function beyond phase 1's.

## Phase 5 — the gate hook, only if phase 4 says so

Build only if compliance rises and displacement does not — the result that says
orientation is not steerable in advance and the useful moment is the moment of
the edit.

Shape: one `--settings` composer that merges the sandbox overlay and a `hooks`
payload into a **single** object and emits whenever either half is non-empty.
Never two flags — whether the CLI merges or replaces is not established on the
pin — and never composed into `sandboxArgs`, which returns `[]` on
`arrangement === "none"` and would ship the hook to nobody on every stock
install while the run looked entirely normal.

The matcher is `PostToolUse` on `Edit|Write`, and the rule it delivers must be
the cheap ask rather than the expensive one: name the one doc that governs the
file just edited, not the gate list. `15-comparison.md`'s 21× result is a result
about specificity and cost of compliance, and a hook that reproduces the gate's
ask at a later position is a hook that reproduces the gate's decline.

*Invariant:* constraints 2, 3, 6 and 11 — the settings channel survives
`--resume` where `--plugin-dir` does not, one flag not two, the hook script ships
in the image and its path is proved contained at use time, never a shell.
*Operator sees:* the injection on the run log, which phase 0d is what makes
possible. *Test:* **yes** — the composer, because a payload that silently ships
nowhere is the exact failure `sandboxArgs`' early return would cause.

## What is deliberately not in any phase

A lessons table, a retrospective, a brief, an MCP tool, and any file written into
a mounted folder. `16-recommendation.md` refuses each by name and on arithmetic;
none of them is a later phase of this plan, and if one of them is ever built it
should be built as a new proposal rather than as phase 6 of this one.
