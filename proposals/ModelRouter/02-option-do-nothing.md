# Option A — do nothing

Keep the one global text box. `createRun` copies `settings.defaultModel` onto
`runs.model` at INSERT (`src/lib/orchestrator.ts:3205`), `buildArgs` re-sends it
on every cycle (`:4843`, called at `:6701`–`:6703`), `review.ts:624` reads the
same column for a review and a conflict resolution, and `chat.ts:1699` reads the
setting directly. Nothing else decides anything.

One correction to the framing before the case, because it changes what this
option is. This is **not** "the operator pins a model per run". `CreateRunInput`
carries a `model` (`src/lib/orchestrator.ts:2559`) and `POST /api/runs` reads it
(`src/app/api/runs/route.ts:233`), and no page this app ships sends it — the
grep is in `00-problem.md`. Doing nothing means *one string per install*, chosen
once, applying to every run, every review and every resolution until somebody
edits the box.

## Shape

Nothing. No module changes, no schema change, no new setting, no copy edit. That
is the entire content of the option and it is worth reading as a positive claim
rather than as an absence: every other option in this survey buys its behaviour
by adding a writer, a reader, a record or a process, and each of those is a way
for the app to be wrong in a manner nobody can see from a run page.

## Which half of the split

Neither, and that is the only answer here that costs nothing to defend.
`RunGuards` is `permissionMode`, `isolate`, `budget` (`src/lib/settings.ts:489`–
`:493`) and the model is not among them; it is not the prompt or the folder
either. It sits on `CreateRunInput` as a fourth thing and stays there. Every
other option owes the argument in `01-constraints.md`'s first section; this one
does not, because it moves nothing.

## When the decision is taken

Once, at `createRun`'s INSERT, synchronously, off a `getSettings()` already in
memory (`src/lib/orchestrator.ts:3150`) — inside the no-`await` region the
concurrency invariant protects (`docs/agent/concurrency-and-ownership.md:10`)
and legal there precisely because it reads nothing.

Nothing re-reads it. `startRun` freezes the row before the loop opens
(`:6278`, loop at `:6412`), `reopenRun` carries the value forward by not
touching it (`:8080`), and `grep -rn "SET model" src/` returns nothing. A run's
model is therefore fixed at its creation instant for the whole of its life,
including cycles a restart picks up days later.

## The measured precedence

Held where the box is blank; **already dead where it is not**, and that is a
cost of standing still rather than a neutral fact. `buildArgs` emits `--model`
whenever `run.model` is truthy, and an explicit `--model` outranks a selected
agent's own pin — measured on the pin, quoted at `src/lib/agents.ts:99`–`110`.
So on any install with text in that box, `SavedAgent.model` cannot reach a work
cycle at all, while the agents page goes on offering the field
(`src/app/agents/page.tsx:279`–`292`).

Worse, the sentence beside that field describes the meaning the singular flag
removed: "What the delegated turn runs on" (`src/app/agents/page.tsx:282`),
against `src/lib/agents.ts:88`–`96`, which records that under `--agent` the pin
is the **session's** model. Doing nothing keeps one field that does nothing on
most installs, under one sentence that is wrong on the path a work cycle takes.
Both are fixable without a router and neither is fixed today.

## What the operator sees and controls

One text box, "Default model", in the Settings page's Runs section
(`src/app/settings/page.tsx:2229`–`2249`), placeholder "Claude Code's own
default", trimmed and mapped empty-to-`null` by
`src/app/api/settings/route.ts:215`–`218`.

**Nothing reads it back.** `RunDTO.model` is on the wire
(`src/lib/apiTypes.ts:559`) and rendered on no page: the run detail page renders
the *agent's* model (`src/app/runs/[id]/page.tsx:1329`–`1333`) and the review
card the *review's* (`src/components/RunReview.tsx:44`). An operator who changes
the box cannot tell, from any page this app ships, which runs took the old
value and which took the new one. That is do-nothing's largest defect, it is
independent of routing, and it is the one thing every other option in this
survey inherits an obligation to fix.

## Guards, and the three cost sources

Untouched. The check order stands as written — terminus, cycles, duration, run
spend, weekly, then session (`docs/agent/budgets-and-guards.md:32`, in code at
`src/lib/budget.ts:492`–`:560`). No new reader of transcripts, `runs.spent_usd`
or OTLP; `telemetrySpendSince` keeps its one door
(`src/lib/orchestrator.ts:6784`, `:6848`).

One property is worth naming because only this option has it for free: with a
single priced model per install, `costUSD` and `costGuardUSD` are the same
number for every run whose window's reading is derived
(`docs/agent/metering.md:18`). The display and the guard cannot disagree,
because there is nothing for them to disagree about.

## When the pricing table cannot place the model

It can already happen, and today nothing stands between the operator and it. The
box is free-form for a stated reason (`src/lib/agents.ts:116`–`119`), so a typo
or a model that shipped this week goes straight onto every run's argv.
`resolvePrice` returns `null` (`src/lib/pricing.ts:115`–`133`), `costOf` reports
$0 and the dashboard banners the name (`docs/agent/metering.md:16`), and every
dollar-denominated guard on every run charges $10/$50
(`src/lib/pricing.ts:84`) — so `--max-budget-usd` is computed against a
`spentGuardUSD` at twice Opus's rate (`src/lib/orchestrator.ts:4880`–`4882`) and
the run stops early at a limit its displayed spend has not reached.

The check that would warn already exists and is dead code:
`grep -rn "isKnownModel" src/` returns exactly one line, its own definition at
`src/lib/pricing.ts:135`. Doing nothing leaves the one-install-wide-mistake
unguarded at the one place a person could be told about it.

## How it fails, and whether loudly

**Loud:** a model string the CLI refuses fails at the spawn, non-zero, before any
API call, and lands on the run's own page.

**Silent, and both of these are live today:** an unpriced-but-accepted string
bills real money, displays $0 and trips guards early; and a box last edited
months ago silently decides every run since, with no page that would show it. A
third is silent by omission — the agents page's model field on an install with
the box filled in, which changes nothing and says nothing.

## What it costs to build

Zero. Nothing to write, nothing to test, nothing to document, nothing to migrate
and no new failure mode. It is the only option here of which that is true, and a
survey that does not say so before the others is arguing for motion rather than
for an outcome.

## What would have to be true for this to be the right answer

Two things, and `00-problem.md` measures both as at least partly true.

That the spread between runs is the **task** rather than the pin: 179 sessions
of fifty turns or more, $4.75 to $66.66, fourteen times the cheapest, every one
of them on `claude-opus-5`. Nothing a router selects addresses a spread the pin
did not create.

And that the aggregate prize does not pay for a mechanism: 1.1% of the weekly
window on the documentation wave of 2026-08-19, 6.8% on sub-agent turns — of
which a share is already being taken by something that is not this app — and
every one of those figures a fixed-token-count counterfactual that a cheaper
model would not hold. If the complaint being answered is "spend less", the
measurement does not yet support building anything, and doing nothing is the
answer that is honest about it.

What would overturn it is the other complaint: that one global string is the
wrong *shape* for a decision that differs between a read-only audit, a delegated
turn and a multi-cycle implementation run. Doing nothing has no answer to that
at all.
