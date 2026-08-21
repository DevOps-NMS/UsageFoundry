# Option A — do nothing but see it

No mechanism. Nothing about what a run carries changes; what changes is that a
run says what it carried, per cycle, out of the transcripts this app already
walks on every guard check.

One correction to the framing before the case, because it decides what this
option is. This is not "add a chart". `00-problem.md` closes on a specific
failure — "the cycle that paid $2.34 to open with *Continue working on the task*
and the one that paid $0.17 for the same sentence are the same row" — and the
whole content of this option is making those two different rows.

## The strongest case

**It is the only option that answers the question `00-problem.md` actually
ends on, and it is the only one that cannot make anything worse.** 79 of 108
work-cycle handovers in the rolling week re-wrote a conversation nothing had
changed, at a median $2.32 each and $183.69 for the week; 29 paid $0.165 for the
identical prompt. Neither the run page, the dashboard nor `run_events`
distinguishes them, because all three read cost and none reads composition. A
readout is not a step towards a mechanism — it is the instrument every other
option in this survey needs in order to be *scored*, and none of them supplies
it as a by-product.

**And the reading already exists, one field over.** `RunAgentCost`
(`src/components/RunAgentCost.tsx`) is a card on the run page that joins
`runs.session_id` to `scanUsage()`'s entries, bounded by session id *and* by time
because "a resumed session copies earlier turns forward into the same file
carrying their original timestamps"
(`src/app/api/runs/[id]/agent-cost/route.ts:46`–`48`), polls on its own 30-second
cadence because the answer costs a full transcript scan (`:14`–`:19`), and
carries copy at its foot saying the three readings of a run's cost must never be
added. Everything in the paragraph above is the same route with
`entry.tokens.cacheRead` and `entry.tokens.cacheWrite1h` read instead of
`entry.costUSD`. The precedent for the join is older still: `reconcileKilledCycle`
(`src/lib/orchestrator.ts:6254`) has done exactly this since a killed cycle first
needed a spend estimate.

**And the classifier is already written and already run.** `00-problem.md`'s
re-write test is one comparison — `cacheWrite1h > cacheRead` on the turn
immediately after a continuation prompt — and it separated the 79 from the 29
without a tokenizer, a hook or a flag. This option is that comparison, moved from
a shell script into `windows.ts` beside `agentSpend`, and shown.

## Shape

This app's own accounting, and nothing else. No argv entry, no injected text, no
change to the folder, no change to the session lifecycle.

Three pieces, in the order they would be built:

1. A pure function in `src/lib/windows.ts`, beside `agentSpend` (`:528`), taking
   the `UsageEntry[]` already filtered to one session and a list of cycle
   boundaries, and returning per cycle: turns, tokens carried in
   (`tokens.cacheRead`), tokens written (`tokens.cacheWrite1h`), and whether the
   cycle's opening turn wrote more than it read.
2. Cycle boundaries from `run_events`. The `iteration` event already carries
   `{ n: iterations, prompt, resuming: sessionId }` (`src/lib/orchestrator.ts:6651`–`6652`)
   and is emitted immediately before the spawn, so consecutive `iteration`
   timestamps bound each cycle's turns exactly as `cycleStartedAt` (`:6661`)
   bounds `reconcileKilledCycle`'s.
3. A route and a card, `GET /api/runs/[id]/agent-cost`'s shape in both cases —
   its own route because the answer needs a transcript scan and the run page
   polls its row every three seconds against an agent competing for the same CPU
   (`src/app/api/runs/[id]/agent-cost/route.ts:14`–`:19`).

The dashboard half is optional and separable: the same function over the week's
container entries would give the count that `00-problem.md` had to compute by
hand — how many handovers re-wrote, and what that cost.

## What leaves the context, and when the decision is taken

Nothing leaves the context, and no decision is taken. That is the option.

The only timing question it has is when the *reading* is taken, and the answer
is "after the fact, on a poll, outside the cycle loop". Nothing here runs inside
the `for (;;)` at `src/lib/orchestrator.ts:6412`, nothing is read before a spawn,
and no code path a run depends on gains a caller.

## What it does to the prefix cache

Nothing, and this is the only file in the survey where that sentence needs no
qualification. `01-constraints.md`'s formula prices an edit to the conversation;
this option makes no edit, so `D = 0`, there is no cut point, and `T*` is
undefined rather than large.

What it is worth is measured on the other side of the ledger. The prize it makes
visible is $183.69 a week at the handover and $95.74 at session openings
(`00-problem.md`), against a build that adds one pure function, one route and one
card. It cannot claim any of that money — it removes nothing — and the honest
statement of its value is that **every other option in this survey is a bet on a
number nobody can currently read back**, and this is the readout.

One real cost, and it is CPU rather than tokens. `scanUsage()` walks
`~/.claude/projects`, which held 513 main-thread and 495 sub-agent transcript
files when `02-levers-on-the-pin.md` counted them. The scan is coalesced on the
in-flight promise (`currentSnapshot`, `src/lib/orchestrator.ts:6198`–`6210`) and
`RunAgentCost` already pays it every thirty seconds per open run page, so a
second card on the same page doubles that unless it shares the route — which is
the argument for putting the composition figures on the *existing*
`agent-cost` payload rather than beside it.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**DONE and `needs-review`: untouched.** `nextPrompt` (`src/lib/orchestrator.ts:4299`)
is not called, `COMPLETION_NOTICE` (`:4466`) and `NEEDS_REVIEW_NOTICE` (`:4506`)
are unchanged, and `cycleEnding` (`:4543`) still matches over a cycle's own final
text. Nothing this option writes reaches a model at all, which also disposes of
`01-constraints.md`'s summariser hazard — there is no text for the sentinel
matcher to later read.

**`--resume`: untouched.** `sessionId` is read from the row and written by
`adoptSession` (`:6319`, `:6357`) exactly as now.

**Retention: it inherits a horizon rather than creating one, and that is the one
real interaction.** The reading is derived from transcript files that
`expiredTranscripts` (`src/lib/retention.ts:528`) will delete at
`transcriptRetentionDays`, default 30 (`src/lib/settings.ts:633`). So a run's
context readout **disappears** when its transcript is swept, on a row that
persists for ever (`docs/agent/retention.md:8`). That is exactly what happens to
`RunAgentCost` today and the card's null state already carries it: no session id,
or nothing readable, is "no reading", rendered as the hatched indeterminate meter
rather than as zero (`src/lib/apiTypes.ts:733`–`737`). This option must reuse
that state and must not cache the answer on the row — a stored copy would be a
fourth store with its own horizon (`01-constraints.md`), invented to preserve a
figure the source is entitled to forget.

## Guards and the three cost sources

**It must not touch a guard, and it does not.** `evaluateBudget`
(`src/lib/budget.ts:400`) gains no caller, no rung and no reordering; the check
order stands as written — `no_terminus` at `:495`, `iterations` at `:506`,
`duration` at `:518`, `run_cost` at `:525`, `run_tokens` at `:532`,
`weekly_fraction` at `:551`, `session_fraction` at `:582`.

**Which source it adds to: the transcripts, and only them.** It is
`01-constraints.md`'s "fourth reading of one of the three" in its narrowest form
— the same files `buildSnapshot()` walks (`src/lib/transcripts.ts:406` →
`src/lib/windows.ts:669`), read for composition instead of for cost. The three
rules that keep it an addition rather than a new source are all satisfiable and
all structural:

- The card says which source it read and sits in the transcripts band. No
  figure, meter, badge, total or comparison is drawn at region level
  (`docs/agent/conventions.md:46`), so a "carried context" figure cannot end up
  above the OTLP card and the never-sum rule stays visible in the layout.
- It does not go near OTLP. It could not: OTLP collapses the 5m/1h cache split
  (`docs/agent/architecture.md`), which is the one distinction every figure here
  turns on.
- It promises nothing on `runs.spent_usd`. That column is a floor of what the
  CLI reported for work cycles, excludes reviews (`src/lib/db.ts:206`–`211`) and
  carries no composition at all, so the readout is beside it and never a
  correction to it — `RunAgentCost`'s own standing sentence.

## What the operator sees, and how they override it by hand

**Sees:** on the run page, per cycle, the tokens that cycle carried in and wrote,
and a mark on the cycles whose opening turn wrote more than it read. That mark is
the whole product. Today an operator reading a run's log sees eleven `iteration`
events that look identical; after this, two of them say they cost fourteen times
what the others did.

**Overrides:** there is nothing to override, and that is worth stating rather
than skipping. `01-constraints.md`'s five obligations resolve to almost nothing
here — no setting, so nothing to switch off (1) and nothing for `saveSettings`
to write out whole (2); what was sent is already on the run's own log via the
`iteration` event (3); no `RunGuards` widening (4); and no mid-run
re-resolution question (5), because the reading is taken after the fact rather
than fixed at the start of a segment.

The one decision it does owe is whether the card polls while a run is working.
`RunAgentCost` takes an `active` flag and re-reads when the run stops
(`src/components/RunAgentCost.tsx:53`–`:54`); this reading has the same property,
because a turn only reaches a transcript when Claude Code flushes it (`:41`–`:48`).

## How it fails, and whether loudly

**Loud:** an unreadable transcript directory. `scanUsage` already reports read
failures and the loop already says so on the run's own log when a guard was
evaluated against a partial scan (`src/lib/orchestrator.ts:6421`–`:6435`); the
card's null state is the display half of the same answer.

**Silent, and this is the failure to design against:** *cycle boundaries drawn
in the wrong place*. If the join uses `iteration` timestamps and a cycle was
killed mid-flight, or a run was picked up by `reopenRun` — which deliberately
writes no `origin` and clears `set_aside_at` (`docs/agent/run-lifecycle.md`) —
then turns can be attributed to the wrong cycle, and the result is a per-cycle
table that is wrong in a way nothing throws on. `reconcileKilledCycle`'s
docblock names the same trap from the other side: "a resumed session copies
earlier turns forward into the same file carrying their original timestamps"
(`src/lib/orchestrator.ts:6246`–`:6248`), which is why session id alone is not a
bound. A per-cycle split is that hazard once per boundary rather than once per
run.

**Silent, and unavoidable:** the readout is a *floor*. Thinking text is stripped
from every transcript — 13,454 blocks, zero bytes retained — and the fixed
prefix is a median 31,575 tokens that never appears in the file at all
(`00-problem.md`). So a card that says "this cycle carried 229,000 tokens" is
reporting what the usage blocks say, which is complete for cost and incomplete
for composition. The card has to say which of the two it is answering.

## What it costs to build

**Files touched:** `src/lib/windows.ts` (one pure function beside `agentSpend`
at `:528`), `src/lib/apiTypes.ts` (fields on `RunAgentSpendDTO` at `:738`, or a
sibling DTO), `src/app/api/runs/[id]/agent-cost/route.ts`,
`src/components/RunAgentCost.tsx` or one component beside it. No schema change,
no migration, no new module, nothing inside the cycle loop.

**Invariants at risk:** three, all in `docs/agent/conventions.md` and all
structural rather than subtle — the region rule (`:46`), the client/server
import split, and `runtime = "nodejs"` plus `dynamic = "force-dynamic"` on the
route. The route being new means it starts with both rather than needing them
added.

**It earns a test, and the grounds are the ones `docs/agent/testing.md` already
records.** The new function is pure, and both ways of getting it wrong are
silent: a boundary off by one turn moves a $2.32 write onto the wrong cycle, and
a re-write test written as `>=` rather than `>` marks every turn in a quiet
session. `agentSpend` cleared the same bar and has four cases in
`src/lib/windows.test.ts` (`:710`, `:744`, `:756`). This is not a general
convention being followed; it is the same argument.

## What would have to be true

That the survey's remaining options are worth **scoring** rather than adopting.
Everything after this file proposes to change what a run carries, and
`00-problem.md`'s own conclusion is that the broad claim — that this app can
shorten conversations profitably — is refused by the measurement, while the
narrow one, that the boundaries this app owns are priced wrongly and measured not
at all, is supported. This option is the whole of the narrow claim's second half
and none of its first.

That an operator will act on the mark. A run page that says cycle 4 wrote
231,644 tokens and cycle 5 wrote 197 changes what a person does — when they
break a task into blocks, when they let a run carry on, whether they turn on a
mechanism a later option builds. If nobody would act on it, it is a chart, and
`CLAUDE.md`'s standing complaint about defects nobody can see from a run page
does not apply to a number nobody reads.

And, in the other direction, the fact that most weakens it: **it saves nothing.**
$183.69 a week goes on being spent while this option is deployed. Every figure in
its case is about knowing, and a survey that ends here has decided the measuring
is worth more than the mechanism — which `00-problem.md` says is an available
outcome ("a survey that ends against building anything is a good outcome for
this proposal rather than a failed one") but does not say is the right one.
