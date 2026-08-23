# Option F — a budget-aware router

The choice reacts to how much of the 5-hour or weekly window is left, read from
the same snapshot the guards read. A run that starts on Opus with a quiet window
finishes on Sonnet as the window fills, rather than stopping.

## The strongest case, first

**The reading is already taken, at the right instant, ten lines from where the
decision would go.** `startRun`'s loop calls `await currentSnapshot()` at
`src/lib/orchestrator.ts:6419` and `evaluateBudget` at `:6438`; between them is
a `UsageSnapshot` covering both windows, freshly scanned, shared with every
other run that asked while it ran (`src/lib/transcripts.ts:401`–`406`). This
option adds no source, no scan and no latency — it reads a value that exists and
is about to be thrown away.

**And it is the only option whose input is the thing the operator actually cares
about.** Every other option here routes on a proxy — a role, a template, a
regex over prose — for a quantity none of them can see. This one reads the
quantity.

## Shape

A pure function from a `UsageSnapshot` and a configured ladder to a model
string or `null`, in its own module beside `budget.ts` — same posture, and for
the same stated reason: that module "stays pure and synchronous", with *when* a
verdict is evaluated and *what is done with it* left to the orchestrator
(`src/lib/budget.ts:38`–`40`).

One call site inside `startRun`'s cycle loop, between the snapshot at
`src/lib/orchestrator.ts:6419` and `buildArgs` at `:6701`. One per-cycle write
of `runs.model`, which is new — nothing writes that column after the INSERT
today (`grep -rn "SET model" src/` returns nothing). One settings key holding
the ladder, off by default. One log line per switch on the run's own log.

## Where it sits relative to the guard check order

Exactly here, and the position is the whole safety argument:

    snapshot   := await currentSnapshot()          src/lib/orchestrator.ts:6419
    verdict    := evaluateBudget(policy, …)        src/lib/orchestrator.ts:6438
    ── the router runs here, on a cycle already authorised ──
    args       := buildArgs({ … model … })         src/lib/orchestrator.ts:6701

The order inside `evaluateBudget` is untouched: `no_terminus`, `iterations`,
`duration`, `run_cost`, `run_tokens`, weekly, then session
(`src/lib/budget.ts:492` onward, stated at
`docs/agent/budgets-and-guards.md:32`). The router adds no rung and reorders
nothing. It cannot: `evaluateBudget` compares spend already accrued against
thresholds, so a model chosen for the *next* cycle cannot change any comparison
it makes — which means the router would be safe on either side of the verdict.
It goes after it anyway, because a spend-reactive computation sitting *before*
the guard reads as a rung whether or not it behaves as one, and the check order
is load-bearing partly by being legible.

## What it means that `costGuardUSD` and `costUSD` are different numbers

They are the same number whenever every model in the window is priced *and* the
window's reading is derived (`docs/agent/metering.md:18`). Two things make them
diverge — an unpriced model, and the provider's own percentage carried forward —
and both bear on this option harder than on any other here.

**A router must read `guardFraction`, not `fraction`.** The reason is already
written down for the review path: an unpriced model contributes $0 to the
displayed figure, "and a guard that reads the display stops existing the week a
new model ships" (`src/lib/review.ts:465`–`467`). A budget-aware router reading
`fraction` would go inert in exactly the week it was most likely to have
selected the new model itself.

**And reading `guardFraction` closes a feedback loop over a number that is
deliberately not the true one.** Route onto a model the table cannot place and
its turns contribute $0 to `costUSD` and $10/$50 to `costGuardUSD`
(`src/lib/pricing.ts:84`, `src/lib/windows.ts:65`, `:353`, `:365`). The router
then sees the window filling *faster* than before and escalates its own
reaction, while the dashboard the operator is watching shows less. Nothing
throws. That is a self-amplifying loop built out of two fields whose whole
purpose is to never be collapsed, and it is this option's most specific hazard.

The second source is the provider's own percentage. When it answered, `fraction` is
its percentage alone while `guardFraction` is the worst of that carried forward
and every model-scoped weekly wall (`docs/agent/metering.md:18`,
`src/lib/windows.ts:735`–`:752`). The carried-forward term converts recent spend
at the rate the reading itself implies — so a router that changes the model
changes the rate at which its own input moves. Not a defect; a thing to write
down before somebody derives a threshold from it.

## Which half of the split

It has the strongest claim to "a third kind of thing": the value is derived from
a measurement, written by nobody. That is also its cost. `01-constraints.md`'s
rule is that everything deciding what an agent may do comes from something a
person wrote; this option produces a **spend-reactive behaviour** that no person
wrote. It is not a guard — it can neither allow nor refuse a cycle — but it is
the first thing in this app besides a guard to change what a run does because of
what a window says. It must therefore be switchable off, and off must be the
shipped default, on the same reasoning that keeps every ceiling `null` in
`DEFAULTS` (`src/lib/settings.ts:602`–`605`).

## When the decision is taken

**Per cycle, necessarily.** A window reading taken at `createRun` is stale by
cycle 5, and `createRun` cannot take one anyway: `currentSnapshot()` is async and
the path to the INSERT carries no `await`
(`docs/agent/concurrency-and-ownership.md:10`,
`src/lib/orchestrator.ts:3190`).

So this option changes the frozen row read at `src/lib/orchestrator.ts:6278`.
The precedent to follow is `enabledPluginDirs()` at `:6690`, re-resolved per
cycle for a stated reason — "a run outlives the plugin list it started under"
(`:6686`–`:6689`); the counter-precedent is `settings`, read once at `:6379` so
what comes off it is fixed for the segment. This option is on the plugin side
and has to say so.

It must also **write** what it chose, not merely pass it. A value computed at
`buildArgs` and not persisted leaves `runs.model` no longer describing what the
run ran on, which breaks the reviewer — `src/lib/review.ts:624` reads that
column to decide what a review of this run's diff runs on — and makes
`run_reviews.model` (`src/lib/db.ts:218`) disagree with the cycles it is
reviewing.

## The measured precedence

A router that writes a model every cycle makes `SavedAgent.model` permanently
unreachable (`src/lib/agents.ts:99`–`110`, `01-constraints.md`). Fill-only-the-
gap is available and is weaker than it sounds: the router would emit nothing
while the window is quiet and take over as it fills, so the agent's pin applies
early in a window and is overridden late. That is defensible and it is a strange
sentence to have to write on a page, which is itself a reason to state the
choice out loud.

## What the operator sees and controls

A switch and a ladder — thresholds against models — which must be off in
`DEFAULTS` and must go through `saveSettings`' only-what-differs loop
(`src/lib/settings.ts:693`–`:706`, `docs/agent/conventions.md:14`).

What they cannot have is the ability to predict a given run's model, because it
depends on what the rest of the fleet spent while that run was working. So the
switch has to be paired with a per-cycle record: the model, the reading it was
chosen against, and the fact that a threshold moved it. The precedent is the
plugin log line, logged per cycle on the run's own page because "an agent that
stops receiving a plugin behaves exactly like one that never had it, so nothing
else in this app would ever mention it"
(`src/lib/orchestrator.ts:6691`–`6699`).

One more thing is owed here that is not owed elsewhere. The dashboard may not
grow a card claiming this router saved anything: no figure, meter, badge, total
or comparison is drawn at region level, and any such figure would have to name
the source it read and sit inside that source's band
(`docs/agent/conventions.md:46`).

## Guards, and the three cost sources

It reads the **transcripts** source, through `buildSnapshot`
(`src/lib/transcripts.ts:406` → `src/lib/windows.ts:669`), plus the provider's
percentage where `planUsage.ts` supplied one. That is adding a reader, not a
source (`01-constraints.md`).

It must not read **OTLP**. `telemetrySpendSince` is one door — one run, one
cycle, for a live spend guard (`src/lib/orchestrator.ts:6784`, `:6848`) — and
widening it into a routing input is a change to the invariant rather than an
application of it (`docs/agent/architecture.md:10`). It has no `cwd`, no
backfill, and it collapses the 5m/1h cache split, which is 26% of this install's
bill (`00-problem.md`).

`runs.spent_usd` is the wrong reading for a different reason: it is a floor for
work cycles and excludes reviews and killed cycles (`src/lib/db.ts:206`–`211`).

## When the pricing table cannot place the model

Everything under "what `costGuardUSD` means" above, plus the ordinary exposure:
whatever set of models the router selects from is a set somebody typed, it may
not be closed (`src/lib/agents.ts:116`–`119`, `docs/agent/metering.md:20`), and
`isKnownModel` (`src/lib/pricing.ts:135`, no call site today) belongs at the
moment the set is configured, as a warning.

One rule falls out that is specific to this option: a router that ranks its
candidates by price must not compute the ranking once. `resolvePrice` is date-
and speed-aware — Sonnet 5's introductory rate ends 2026-09-01
(`src/lib/pricing.ts:68`–`69`), and fast mode is a separate table at 2× for two
Opus entries (`:62`–`:66`). A ranking computed at boot is wrong on a date
boundary and wrong under fast mode.

## How it fails, and whether loudly

**Silently inert on the default install, which is the strongest objection to
this option.** Every ceiling in `DEFAULTS` is `null`
(`src/lib/settings.ts:602`–`605`) by a deliberate no-guessed-numbers rule
(`docs/agent/metering.md:8`), and `guardFraction` is null exactly when
`fraction` is (`src/lib/windows.ts:351`–`:365`). So on a stock install the only
reading is the provider's percentage, which needs `planUsageFromApi` on, a live
login, a reachable endpoint and a reading under an hour old
(`docs/agent/metering.md:10`). Any of those missing and the router has no input
— and it looks exactly like a router that is working and has decided not to act.
`evaluateBudget`'s own posture is the answer: a rule that cannot bind is
refused, not ignored (`src/lib/budget.ts:490`–`:498` for `no_terminus`,
`no_ceiling` for the window case). This router owes the same, as a log line per
segment at minimum.

**Silently oscillating**, second: a threshold at 70% with spend that crosses it
during a cycle switches models back and forth between cycles, which is
`--resume` context churn (see Option H) paid repeatedly for no benefit.
Hysteresis is not optional here.

**Loud:** a selected model the CLI refuses fails that cycle's spawn.

## What it costs to build

Small in code: a pure function from `UsageSnapshot` and a configured ladder to a
string or `null`, which is unit-testable and meets the stated bar (`CLAUDE.md`),
plus a per-cycle write and a log line. Two to three days.

Large in verification, and disproportionately so: what it does is only
observable across a whole window, on an install with ceilings configured, over
hours. `docs/verification.md`'s "Not yet verified by hand" list is where that
lands, and it would sit there a long time.

## What would have to be true for this to be the right answer

**That degrading the model late in a window beats waiting for the window.** That
is the comparison, not "degrading beats stopping" — because waiting already
exists and is free: `live-resume` parks a run when the 5-hour window trips and
the sweeper picks it up (`src/lib/budget.ts:32`–`34`,
`docs/agent/budgets-and-guards.md:32`). For the 5-hour window, this router is
competing with a mechanism that costs nothing and loses nothing, and it wins
only where finishing sooner on a worse model beats finishing later on a better
one.

The weekly window is the case that carries it. It cannot be waited out — with
`weeklyAnchor` unset there is no reset instant at all, only decay
(`docs/agent/budgets-and-guards.md:32`) — so the alternative there is stopping,
and degrading beats stopping by a wider margin than it beats parking.

**Experiments to name.** How often does a real install actually approach a
configured window ceiling — on this install, never, since no ceiling is set and
the settings row is unreadable from a work cycle (`00-problem.md`, where the
weekly anchor's default is **assumed** unoverridden for the same reason). And
does a run that switches model mid-conversation keep its cached context? That
one is Option H's central question and this option inherits it in full.
