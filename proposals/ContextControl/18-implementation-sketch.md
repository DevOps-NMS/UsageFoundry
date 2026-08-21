# Implementation sketch

What `17-recommendation.md` would take, module by module, in the order it would
be done. Five phases: the first is two repairs owed whichever way the question
goes, the next two are the deliverable, the fourth is optional and separable,
and the fifth is a boundary rather than work.

**The rule that runs through all of it, stated once and repeated at each step
that could break it: a readout is not a mechanism, and a figure is not a
source.** Two halves, and both are gates rather than preferences.

The first half is `01-constraints.md`'s "three cost sources, and this is a
fourth *reading* of one of them". Everything below reads the transcripts — the
same files `buildSnapshot()` walks (`src/lib/transcripts.ts:406` →
`src/lib/windows.ts:669`) — for *composition* rather than for cost. That stays
an addition to one source only if every figure says which source it read and
sits inside that source's band, if nothing reaches for OTLP (which collapses the
5m/1h cache split, `docs/agent/architecture.md:10`, and could not answer the
question anyway), and if nothing promises a before-and-after on
`runs.spent_usd`, which is a floor of what the CLI reported for work cycles,
excludes reviews (`src/lib/db.ts:206`–`:211`) and carries no composition at all.

The second half is that **nothing here may become an input to a decision.**
Concretely, the change is wrong if at the end of it any of these is true:

- `evaluateBudget` (`src/lib/budget.ts:400`) has gained a caller, a rung or a
  reordering. The check order stands as written: `no_terminus` (`:495`),
  `iterations` (`:506`), `duration` (`:518`), `run_cost` (`:525`), `run_tokens`
  (`:532`), `weekly_fraction` (`:551`), `session_fraction` (`:582`).
- `BudgetStopCode` (`src/lib/budget.ts:138`–`:150`) has a new member, which
  would have to be placed in or out of `RUN_ENFORCEABLE_CODES` (`:229`–`:239`)
  and `LIVE_ENFORCEABLE_CODES` (`:194`–`:200`).
- `RunGuards` (`src/lib/settings.ts:489`–`:493`) has a fourth field.
- Anything inside the cycle loop (`for (;;)` at `src/lib/orchestrator.ts:6412`)
  reads the new figure, or a spawn waits on it. The reading is taken after the
  fact, on a poll, outside the loop.

That last one is the line between this recommendation and Option G, which is the
same reading wired to an actuator. **Building the instrument is not half of
building the guard**, and a later change that crosses this line owes the whole
of `10-option-context-guard.md` rather than a follow-up ticket.

## Phase 0 — two repairs owed whichever option wins

Neither is context control. Each is a live defect this survey found while
looking for something else.

### 0a. Record the context-shaping environment, or strip it

**Touches** `src/lib/orchestrator.ts` (`childEnv` at `:5216`–`:5231`, and the
run loop's log around `:6691`–`:6698`), `src/lib/config.ts`,
`docker-compose.yml` and `.env` if the keys become explicit.

**The defect.** `childEnv` copies `process.env` and strips exactly six classes —
`UF_*`, `OTEL_*`, `ANTHROPIC_ADMIN_KEY`, `CLAUDE_CODE_ENABLE_TELEMETRY`,
`DATA_DIR`, `NODE_OPTIONS`. Seven variables that change what a run carries are
none of them, and all seven are present in the pinned binary (`grep -c -a` over
`/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, run by
the closing pass, returns 6 to 16 hits each): `DISABLE_AUTO_COMPACT`,
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`,
`MAX_THINKING_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `BASH_MAX_OUTPUT_LENGTH`. So an install
whose compose sets one is running a different context regime and nothing in this
app can tell.

**The change** is the smaller of the two available ones: on each spawn, name any
of the seven that is set on the run's own log. Not stripping them — an operator
who set one meant it, and `childEnv`'s strip list exists for credentials and
telemetry rather than for configuration.

**Invariants it must not break.**

- `childEnv`'s strip list "must not grow a hole": it exists because "the child
  is a full Claude Code session with tool access, so it can read its own
  environment and so can anything it runs"
  (`src/lib/orchestrator.ts:5175`–`:5176`). This phase adds nothing to the
  environment and removes nothing from it.
- **It must not become a warning on a stock install.**
  `docs/agent/environment.md` is explicit that compose renders every optional
  variable as `${VAR:-}`, so a blank-by-default key read through `env()`
  (`src/lib/config.ts:22`–`:26`) becomes a permanent warning on every install.
  If these become explicit keys they are read through the blank-is-the-answer
  sibling at `:28`, whose docblock already splits "blank is an off switch" from
  "blank is take the default".
- The log line follows `enabledPluginDirs()`'s missing-directories precedent
  (`src/lib/orchestrator.ts:6691`–`:6698`), which is written on the run's own
  log "rather than left to be inferred".

**What an operator sees when it lands.** On a run whose container has one of the
seven set, a line at the top of the run's log naming it and its value. On every
other run, nothing — which is the point: today those two runs look identical.

**Test:** none. No pure function is added; a `log()` call beside an existing one
is neither a branch nor arithmetic nor parsing, and `docs/agent/testing.md` is
explicit that its list is the bar rather than a convention to extend.

### 0b. A `PreCompact` hook, observation only

**Touches** `src/lib/orchestrator.ts` (`buildArgs` at `:4756`, and the
`--settings` payload `sandboxArgs` already builds at `:5158`–`:5164`, pushed at
`:6760`).

**The defect.** `02-levers-on-the-pin.md` drove a `-p --output-format
stream-json --verbose` session — the exact shape a work cycle is spawned in — to
a `PreCompact` hook firing unprompted with `trigger: "auto"`, and found no
marker in the transcript either way on a session that demonstrably reached it.
So a run's conversation may already have been summarised by a model, with
`COMPLETION_NOTICE` (`src/lib/orchestrator.ts:4466`) and `NEEDS_REVIEW_NOTICE`
(`:4506`) in it, and nothing anywhere records that it happened.

**The change** is a `PreCompact` entry in the `--settings` payload and one
`log()` line when it fires, carrying the `trigger` and nothing else. No
`--autocompact`, no `DISABLE_AUTO_COMPACT`, no threshold: this is Option F's
third piece without Option F, and taking any of the other two is taking the
option `17-recommendation.md` rejects by name.

**Invariants it must not break.**

- **It must be `--settings` and must not be `--plugin-dir`.** Re-measured by the
  closing pass on this pin: a hooks payload on `--settings` fired on all three
  cycles of one session; a plugin directory's hook fired on cycles 1 and 2 and
  not on cycle 3 without the flag, exiting 0 with nothing on stderr. That is the
  docblock at `src/lib/orchestrator.ts:4828`–`:4831` confirmed twice.
- **Whether the CLI merges two `--settings` flags or lets the second replace the
  first is not established** (`08-option-externalise-tool-output.md` raises it
  and `02-` exercised one at a time). So the `PreCompact` entry composes into
  `sandboxArgs`' object rather than being pushed beside it, and that is a change
  to `sandboxArgs`' contract. The precedent for getting this wrong is one flag
  over: `--allowedTools` is emitted once with everything in it, because "a
  second `--allowedTools` is a variadic option the CLI would read as a
  replacement rather than an addition" (`src/lib/orchestrator.ts:4856`–`:4858`).
- **`sandboxArgs` never carries `sandbox.enabled`**
  (`src/lib/orchestrator.ts:5146`–`:5152`), and nothing here may put a second
  fleet-wide switch on that flag for the same reason.
- `--include-hook-events` puts the dispatch on the `stream-json` channel
  `handleStreamLine` (`src/lib/orchestrator.ts:5830`) already reads, so no
  second channel is invented.

**What an operator sees when it lands.** A line on the run's log saying a
compaction happened and what triggered it, at the moment it happens. Today that
event is invisible in the transcript, in `run_events`, on the run page and in
the dashboard.

**Test:** none, on the same grounds as 0a — and one line in
`docs/verification.md`'s "Not yet verified by hand" list (`:630`), because
`02-`'s probes established what the CLI dispatches and established **nothing**
about a completed compaction: "no completed compaction was reachable without a
live model".

## Phase 1 — the reading

**Touches** `src/lib/windows.ts` only, one pure function beside `agentSpend`
(`:528`).

**The change.** Given the `UsageEntry[]` `scanUsage()` already produces
(`src/lib/transcripts.ts:406`), filtered to one session, plus a list of cycle
boundaries, return per cycle: turns, tokens carried in (`tokens.cacheRead`),
tokens written (`tokens.cacheWrite1h`), and whether the cycle's **opening** turn
wrote more than it read. That last flag is the whole product; it is the
comparison `00-problem.md` used to separate the 72 handovers that re-wrote from
the 27 that did not, moved out of a shell script.

**Invariants it must not break.**

- **Bounded by session id *and* by time.** `reconcileKilledCycle`'s docblock is
  the reason and it is not optional: "a resumed session copies earlier turns
  forward into the same file carrying their original timestamps"
  (`src/lib/orchestrator.ts:6246`–`:6248`). `GET /api/runs/[id]/agent-cost`
  already does both (`src/app/api/runs/[id]/agent-cost/route.ts:46`–`:52`).
- **Cycle boundaries come from `run_events`.** The `iteration` event carries
  `payload: { n: iterations, prompt, resuming: sessionId }`
  (`src/lib/orchestrator.ts:6652`) and is emitted immediately before the spawn,
  so consecutive `iteration` timestamps bound each cycle's turns the way
  `cycleStartedAt` (`:6661`) bounds `reconcileKilledCycle`'s estimate.
  `runEvents` (`:621`–`:625`) is where they come from, and a caller that passes
  a limit must surface `dropped` (`:614`–`:617`) — a per-cycle table built from
  a silently truncated log is wrong at the oldest end and says nothing.
- **The re-write test is `>` and not `>=`.** A quiet turn with zero of both
  satisfies `>=` and would mark every cycle of an idle session.
- **The reading is a floor and the type has to carry that.** Thinking text is
  stripped from every transcript — 13,734 blocks in the re-measured corpus, zero
  bytes retained — and the fixed prefix is a median 31,373 tokens that never
  appears in the file at all. So the function answers "what the usage blocks
  say", which is complete for cost and incomplete for composition, and the name
  and the DTO field must not suggest otherwise.

**What an operator sees when it lands.** Nothing. This phase is a function and a
test.

**It earns a test, and the grounds are already written down for its neighbour.**
`docs/agent/testing.md` names `agentOrigin` / `agentOriginIndex` / `agentSpend`
"and that every turn still lands in a `byAgent` bucket" among the pure functions
whose failure modes are silent, and `agentSpend` has its cases at
`src/lib/windows.test.ts:710`, `:744` and `:756`. This function clears the same
bar by the same argument, and both ways of getting it wrong are silent and
expensive in opposite directions: **a boundary off by one turn moves a $2.39
write onto the wrong cycle**, so an operator reads the mark against the wrong
prompt; and **`>=` for `>` marks every turn in a quiet session**, so the mark
means nothing and is ignored, which is the same outcome as not building it. It
is not a general convention being followed. It is the same sentence `agentSpend`
earned.

## Phase 2 — the route and the card

**Touches** `src/app/api/runs/[id]/agent-cost/route.ts`, `src/lib/apiTypes.ts`
(fields on `RunAgentSpendDTO` at `:738`, or a sibling DTO), and
`src/components/RunAgentCost.tsx` or one component beside it.

**The change.** Per cycle, on the run page: what that cycle carried in, what it
wrote, and a mark on the cycles whose opening turn wrote more than it read.

**Put it on the existing `agent-cost` payload rather than beside it.** A second
route means a second transcript scan, and the existing one already polls every
thirty seconds per open run page "because the answer costs a full transcript
scan" while the run page polls its row every three seconds against an agent
competing for the same CPU
(`src/app/api/runs/[id]/agent-cost/route.ts:14`–`:19`). `scanUsage()` is
coalesced on the in-flight promise (`currentSnapshot`,
`src/lib/orchestrator.ts:6198`–`:6210`), which bounds the damage and does not
remove it.

**Invariants it must not break.**

- **Unknown renders as the hatched indeterminate meter, never a 0% bar**
  (`docs/agent/metering.md`). `RunAgentSpendDTO` is already "null on the wire
  when there is nothing to read — a run with no session id yet"
  (`src/lib/apiTypes.ts:733`–`:737`), and this reuses that state rather than
  inventing one.
- **Nothing is cached on the row.** The reading derives from transcript files
  `expiredTranscripts` (`src/lib/retention.ts:528`) deletes at
  `transcriptRetentionDays`, default 30 (`src/lib/settings.ts:633`), on a row
  that persists for ever (`docs/agent/retention.md:8`). A stored copy would be
  the fourth store `01-constraints.md` refuses, invented to preserve a figure
  the source is entitled to forget. The readout **disappearing** when the
  transcript is swept is correct, and is what already happens to `RunAgentCost`.
- **A region carries no figure of its own.** "A *region* is not an eighth
  affordance", it is a `<div>` with an `<h2>` and never a `<section>`, and "no
  figure, meter, badge, total or comparison is drawn at region level"
  (`docs/agent/conventions.md:46`). The per-cycle table goes inside a card in
  the transcripts band, beside `RunAgentCost`, never on the region — which on
  this page is the never-sum rule made structural.
- **A table stacks below `md` only with `Table stack` *and* a `label` on every
  `Td`** (`docs/agent/conventions.md`). A per-cycle table is four numeric
  columns; one without the other is a column of unnamed figures.
- **The client/server import split.** `"use client"` files import from
  `apiTypes.ts` and `format.ts`, never `windows.ts` or `transcripts.ts`.
- **The route needs `runtime = "nodejs"` and `dynamic = "force-dynamic"`.** The
  existing one has both; a new field on it inherits them, which is the second
  argument for not adding a route.
- **It re-reads when the run stops.** `RunAgentCost` takes an `active` flag and
  settles on the final split (`src/components/RunAgentCost.tsx:53`–`:54`),
  because a turn only reaches a transcript when Claude Code flushes it
  (`:41`–`:48`). The per-cycle reading has the same property and must not be
  exempted from it.

**What an operator sees when it lands.** This is the deliverable. Today a run's
log shows eleven `iteration` events that look identical. After this, two of them
say they cost fourteen times what the others did — and the operator can see, for
the first time, whether a given run is one where a context mechanism would have
been worth anything.

**Test:** none, and the argument has to be made rather than assumed, because
eight renderings in this tree *do* have tests. They clear the bar on a specific
property: each pins something that "fails silently at a breakpoint or to a
screen reader" — `Meter`'s `data-sev`/`data-unknown` tiebreak is the named
example, where losing it "paints a solid green 100% bar instead of the hatched
indeterminate one" (`docs/agent/conventions.md:46`). A `Td` showing a number
does not have that property. **If this phase is ever built with the re-write
mark rendered as a `Meter` rather than as a badge, the tiebreak comes back and
so does the test.**

## Phase 3 — the dashboard half, optional and separable

**Touches** `src/lib/windows.ts` (the same function, over the week's container
entries) and `src/app/page.tsx`.

**The change.** How many handovers re-wrote this week, and what that cost — the
count `00-problem.md` had to compute by hand and which no page carries.

**Invariants.** The card sits in the transcripts band beside the windows, never
beside the OTLP card and never above both, for `01-constraints.md`'s reason: on
the dashboard the region rule *is* the never-sum rule. And the figure says it is
a floor, for Phase 1's reason.

**What an operator sees.** One number that says whether this install has the
problem `00-problem.md` measured, this week, rather than in the week the file
was written.

**Test:** none. The function is Phase 1's and already has one.

## Phase 4 — the boundary, written down rather than built

Three things this deliberately does not do, and each is a place a later change
would cross a line rather than extend one.

**It does not act.** Nothing here clears `sessionId`
(`src/lib/orchestrator.ts:6319`), sets a threshold, or reaches the cycle loop.
The moment the figure is read *before* a spawn rather than after one, the change
is `10-option-context-guard.md` and owes that file's five invariants — the check
order, `BudgetVerdict`'s union, `RunGuards`' three fields, the
unknown-renders-as-hatched rule, and `runs.session_id`'s meaning for three
readers.

**It does not change what a run carries.** No argv entry, no injected text, no
environment key, no folder. `buildArgs` (`src/lib/orchestrator.ts:4756`) is
untouched, `nextPrompt` (`:4299`) is untouched, and `cycleEnding` (`:4543`)
still matches over a cycle's own final text. The two endings are not merely
unharmed; they are not on the path.

**It cannot see the whole thing, and the docs must say so.** The fixed prefix is
invisible from the transcript, and the closing pass's own attempt to attribute
it to `CLAUDE.md` failed at r² = 0.166 across five repositories, with a 27 KB
`CLAUDE.md` producing a *smaller* opening prefix than a 15 KB one. When this
lands, `docs/runs.md` gets one paragraph with the sentence that makes it
legible: **the card says what the conversation carried, not what the request
contained.**

## What an operator can do afterwards, and what they still cannot

| | |
|---|---|
| See what a cycle carried and wrote | the run page, per cycle, after Phase 2 |
| See which cycles re-wrote a conversation nothing changed | the same table's mark — the whole product |
| See how often that happened this week | the dashboard card, after Phase 3 |
| See what context-shaping environment a run was spawned under | the run's log, after Phase 0a |
| See that the CLI compacted a conversation | the run's log, after Phase 0b |
| **Change** any of it | **nothing** — that is Options D, E, F, G, K and L, none of which is recommended |
| See the fixed prefix, or the retained thinking | never, from this source |

## Cost

Phase 0: an hour for 0a, half a day for 0b (most of it in composing one
`--settings` object rather than two). Phase 1: half a day including the test.
Phase 2: a day. Phase 3: an afternoon.

No schema change, no migration, no new module, no new settings key, no new
`claude` child, no new store and no new sweep. Two lines in
`docs/agent/architecture.md`'s module map for the new function, one paragraph in
`docs/runs.md`, and two lines in `docs/verification.md`'s "Not yet verified by
hand" list (`:630`): that the `PreCompact` hook fires on a real cycle against a
live model, which no probe in this proposal could reach, and that the per-cycle
table's boundaries land where the `iteration` events say they do on a run that
was killed mid-cycle.
