# Option H — per-phase routing within one run

Different models for different work cycles of the same run. A cheap first pass
that reads the repository and drafts, an expensive one that finishes; or the
reverse — an expensive cycle 1 that decides the approach and cheap cycles after
it.

## The strongest case, first

**The mechanism is already there and costs one expression.** `buildArgs` is
called from inside the cycle loop and rebuilds the whole argv every time — the
loop opens at `src/lib/orchestrator.ts:6412`, `buildArgs({ … model: run.model …
})` is at `:6701`–`:6703` — so `--model` is re-sent on every cycle including
resumed ones, and that is asserted rather than assumed
(`src/lib/orchestrator.test.ts:2353`, "still passes the mode, the model and the
session to resume"). Nothing has to be added to the spawn path. The only change
is where the expression at `:6703` gets its value.

**And the loop already has the phase in hand.** `iterations` is incremented and
written per cycle (`src/lib/orchestrator.ts:6680`–`6684`), so "this is pass 1"
needs no new read, no new column and no new source. Of every option here, this
one has the smallest diff between where it is and where it would be.

**And it is the only option that routes on the axis the money is actually spread
along inside a run.** Cycle 1 of a run reads and plans; cycle 6 is applying a
diff it already understands. Those are different asks, they are the same run,
and no record in this app can tell them apart.

## What `--resume` does to it, and the fact that decides the option

`00-problem.md` settled half of the question and it is the half that does not
matter here: `buildArgs` re-sends `--model` per cycle regardless, so the failure
`--plugin-dir` records — a flag that is *not* restored across `--resume`
(`src/lib/orchestrator.ts:4824`–`4838`) — cannot bite. Whether the CLI would
restore a model across a resume on its own is **not measured**, and this option
does not need it to be.

The other half is not answered anywhere and it is the one that decides whether
this option is worth anything:

**Does switching model on a `--resume` keep the conversation's cached context?**
That is **assumed**, in the unsafe direction, by anyone who proposes this — and
nothing in this repository measures it. The stakes are the largest single line
in `00-problem.md`'s bill: 62.1% of the week is cache reads and 20.9% is 1-hour
cache writes, so 83% of the money is context being carried between turns. Cache
classes are multiples of the *input* rate (`src/lib/pricing.ts:16`–`18`), and a
1-hour write is 2.0× input. If a model switch invalidates the prompt cache, then
cycle 2 on the new model re-writes the whole conversation at 2.0× before it does
any work — and a cheap second pass can cost more than an expensive one would
have. The saving is spent before the first turn.

Nothing here claims which way it goes. It is the experiment named at the bottom
of this file, and until it is run this option's arithmetic is unknown rather than
favourable.

## Which half of the split

Neither, as today — but with a difference worth naming. The value stops being
something a person wrote *for this run* and becomes a **schedule over cycles**:
"cheap until pass 3". Whoever writes that schedule owns the decision, and if the
schedule ships in the source it is nobody the operator can argue with. Beside
Option I's per-run box it is coherent; alone it is a behaviour with no dissent
channel.

## When the decision is taken

**Per cycle, necessarily**, and that means changing a frozen read. `startRun`
reads the row once at `src/lib/orchestrator.ts:6278`, before the loop opens at
`:6412`, so writing `runs.model` mid-run changes nothing until the run is picked
up again — the trap `01-constraints.md` says an option of this shape is most
likely to be wrong about.

Two admissible shapes:

- **Re-resolve per cycle**, the `enabledPluginDirs()` precedent at `:6690` with
  its stated reason at `:6686`–`:6689`. The counter-precedent is `settings`,
  read once at `:6379` precisely so what comes off it is "fixed for the segment
  rather than per cycle".
- **Compute from `iterations`**, which the loop already holds and already writes
  (`:6680`–`:6684`). This needs no new read at all and is the smaller change —
  but the value it produces is not on the row, and a value not on the row means
  `runs.model` no longer describes what the run ran on. That breaks the
  reviewer, which reads that column to decide what a review of this run's diff
  runs on (`src/lib/review.ts:624`), and makes `run_reviews.model`
  (`src/lib/db.ts:218`) disagree with the cycles it is reviewing.

So the honest form is: compute from `iterations`, **and write what was chosen**,
per cycle. `runs.model` then means "the last cycle's model", which is a change
of meaning for a column three other things read, and should be stated as one.

There is a cheaper form of this option that needs none of the above. A workflow
loop block already creates **a fresh run per pass**, each continuing the last
one's branch (`src/lib/workflows.ts:4720`–`4729`), and every fresh run goes
through `createRun` and gets its own `runs.model`. So per-phase routing at
*run* granularity exists today for free — except that a loop node names one
template and unrolls it, so every pass is the same template, and a template
carries no model anyway (Option C). Two chained nodes on two templates would be
the same thing at graph level. Worth knowing before building anything inside the
cycle loop.

## The measured precedence

Writing a model on some cycles and not others makes the agent's pin apply on
exactly the cycles the schedule declines to name — `buildArgs` emits `--model`
only when `opts.model` is truthy (`:4843`), and an explicit one outranks the pin
(`src/lib/agents.ts:99`–`110`). A run whose agent names `sonnet` and whose
schedule names `opus` for pass 1 only would run pass 1 on Opus and every later
pass on Sonnet, which is a coherent behaviour nobody designed. Say which one the
schedule intends.

## What the operator sees and controls

This is the option that **forces** the read-back every other option merely owes.
One string on the row cannot answer "what did this run cost per token" once the
answer differs by cycle, and today the run page renders no model at all
(`src/lib/apiTypes.ts:559` is on the wire and on no page;
`src/app/runs/[id]/page.tsx:1329`–`1333` shows the *agent's*). Per-cycle
routing without a per-cycle record on the run's timeline is unauditable in
principle, not just in practice.

## Guards, and the three cost sources

No new reader and no new source. The interaction that lands hardest is the
terminus, and it is decisive rather than incidental:

**`maxIterations` counts cycles, not money** (`src/lib/budget.ts:84`–`97`), and
the loop must always have a monotone terminus — `maxIterations` is nullable only
alongside `maxDurationMinutes` (`:86`–`91`, refused as `no_terminus` at `:496`).
A cheap first pass that needs two cycles to do what one expensive cycle did has
spent two of the terminus.

And the default makes it worse in the most common case: `max_iterations` is
`NOT NULL DEFAULT 1` (`src/lib/db.ts:156`), and `maxIterations` defaults to 1
(`src/lib/orchestrator.ts:110`–`111`). **A "cheap first pass, expensive second" scheme
on a default-budget run gets one cheap cycle and then stops.** That is not a
first pass; that is the whole run on the cheap model, filed `completed`. This
option is therefore only meaningful on runs whose cycle cap is above 1, and it
should say so rather than let the default quietly invert it.

`--max-budget-usd` is derived per cycle as `max(0, maxRunCostUSD -
spentGuardUSD)` (`src/lib/orchestrator.ts:4880`–`4882`), so it needs no change
— but it is the mechanism by which a cheap early pass leaves more of the run
limit for a dear later one, which is the one place this option's arithmetic
works out cleanly and is worth stating in those words.

## When the pricing table cannot place the model

Two strings per run instead of one, which produces something no other option
here does: **a single run whose own displayed cost is part-priced.** Half its
cycles at $0 and named as unpriced (`docs/agent/metering.md:16`), half real, and
`costGuardUSD` diverging from `costUSD` *inside one run's figure* rather than
across the window. Every rollup still reconciles — each turn lands in a bucket —
but the run's own number becomes a floor for a reason that has nothing to do
with the run.

## How it fails, and whether loudly

**Silent, and expensive:** the cache question above. If a switch invalidates the
context, the run costs more and nothing anywhere reports anything unusual — the
turns are ordinary turns, the totals are ordinary totals, and the only evidence
is a cache-write line in a rollup nobody compares against a counterfactual.

**Silent, and structural:** the frozen read. A version of this that writes
`runs.model` and forgets that `startRun` froze the row at `:6278` changes
nothing at all and looks exactly like a schedule that decided not to switch.

**Silent, third:** the cycle cap inverting the scheme, above.

**Loud:** a scheduled model the CLI refuses fails that cycle's spawn — with the
useful property that it fails at cycle 2 rather than cycle 1, so the run has
already done work and the failure is legible as "something changed".

## What it costs to build

Small in code — the expression at `:6703`, a per-cycle write, a place to put the
schedule, and a per-cycle record on the run's timeline. Two to three days.

**The largest verification burden in this survey**, and disproportionate to the
diff: the thing it must not do is not observable from the code, is not observable
from the run page, and is only observable by comparing a cache-write column
against a run that did not switch. `docs/verification.md` is where that
obligation lands.

## What would have to be true for this to be the right answer

That a model switch on `--resume` is accepted **and** keeps the cached context;
that runs carry a cycle cap above 1 often enough for a phase scheme to have
phases; and that the phases of a run differ enough in kind to be worth different
models — which nothing measures, because this app records no per-cycle cost
breakdown.

**Experiments to name.** The decisive one: start a run, let cycle 1 complete,
switch the model, resume, and compare the second cycle's `cacheRead` and
`cacheWrite1h` counts against a control run that did not switch. It is billed,
it is small, and it is the only measurement that turns this option's arithmetic
from unknown into known. Second, and free: read `runs.max_iterations` on a live
install to find what share of runs could have a phase at all — a query against
the database that is unreadable from a work cycle (`00-problem.md`).
