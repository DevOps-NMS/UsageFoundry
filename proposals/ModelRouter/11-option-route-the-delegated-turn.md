# Option J — route the delegated turn

Decide what a *sub-agent* turn runs on, rather than what the session runs on.
Not the run's model: the model of the turns a work cycle hands off to
`general-purpose`, to `Explore`, to a workflow sub-agent.

**Why this file is here.** `00-problem.md`'s most useful measurement is that
something is already routing these turns and it is not this app: 1,231
`general-purpose` turns on Sonnet and 948 on Opus in one week, inside sessions
whose main thread was Opus throughout. `01-constraints.md` names it as "a fourth
moment worth naming because it is where the money is and the app does not reach
it at all". A survey of who picks the model that omits the only place where
somebody else is already picking is not a survey of the question.

## The strongest case, first

**It is where the money is, by a factor of six over the next-largest measured
prize.** 7,263 sub-agent turns in the window at $488.24 — 12% of the bill — of
which $459.62 is still on Opus. At Sonnet's rates the same tokens are $212.59, a
difference of $275.65 or **6.8% of the weekly window**, against 1.1% for the
documentation wave that started this proposal (all from `00-problem.md`).

**And it is where the fixed-token-count counterfactual is least unsafe.** Every
cheaper-model figure in `00-problem.md` assumes a cheaper model emits the same
tokens, and the honest prior is that it emits more. A delegated turn is the case
where that prior is weakest: the turn is bounded, the task is narrow, the result
goes back to a main thread that will check it. `00-problem.md` says so directly.

**And somebody is already doing it, successfully, on this machine.** The CLI
moved 1,231 `general-purpose` turns onto Sonnet inside the same week it left 948
on Opus. That is the strongest available evidence that per-turn routing is
tractable at all — and the strongest available warning about what this option
actually is.

## What it actually is: displacement, not a gap

Whatever routes `general-purpose` today is not readable from here and this app
cannot see its policy. So an option that decides a delegated turn's model is
**displacing an existing mechanism**, and has to say what happens when the two
disagree. The honest answer is that this app would not know that they had:
nothing in the transcripts records what asked for a model, only what ran
(`src/lib/transcripts.ts:255`–`267`).

And note what the split really shows. Two of the three sessions with delegated
Sonnet turns had Opus main threads, and in one of them the delegated turns cost
*more* than the session that delegated them — $24.34 against $17.23
(`00-problem.md`). Routing delegated turns down is not obviously a saving; it is
a change to where a large and variable share of the money goes.

## Shape — and the problem is that there may not be one

**There is no argv this app builds that expresses this.** `SavedAgent.model` was
exactly that field, and the singular flag took the meaning away:

> **This changed meaning with the flag, and it is the one field that did.** Under
> `--agents` alone it was the model a *delegated sub-turn* ran on […] Selected
> with `--agent` it is the **session's** model
> — `src/lib/agents.ts:88`–`96`

A work cycle selects (`sessionAgentArgs` at `src/lib/orchestrator.ts:4851`), so
on the path where the money is, an agent's model is the session's.

The one surface left is the *offered* path: `agentsArgs`, the plural flag alone,
which "hands the session's main agent a role it may delegate a subtask to"
(`src/lib/agents.ts:391`–`401`). Its one caller is `spawnAssist`
(`src/lib/review.ts:627`) — a reviewer, not a work cycle — and
`docs/agent/architecture.md:131` records that no caller supplies an agent to it
anyway. So the offered path exists, carries nothing today, and is on the wrong
child.

**Whether a member's `model` still governs a delegated sub-turn on the offered
path is not measured in this repository.** Every quoted measurement is off the
`system`/`init` event (`src/lib/agents.ts:99`–`110`), which reports the
session's model — it cannot answer a question about a turn that has not happened
yet. That it still works the way the pre-`--agent` comment described is
**assumed**, and this option's viability rests entirely on it.

And the built-ins are unreachable by construction: `general-purpose` and
`Explore` — the two buckets carrying the measured spend — are refused by name at
save, because a saved agent under a built-in name "either does nothing or
replaces the built-in one, and it does not say which"
(`src/lib/agents.ts:179`–`185`, `:284`–`:292`). The refusal is right. It also
means this app cannot name the two agents whose turns it would want to route.

## Which half of the split

Cost, not capability, on exactly the ground already written for the field this
would revive: an agent's model "moves cost rather than capability … every cost
guard already covers it, since the run's spend lands on its own `result` event
and in its telemetry whatever model produced it"
(`src/lib/agents.ts:110`–`113`). Nothing here reaches a permission mode, a tool
list, a folder or a budget — the registry refuses the first two at the door
(`:187`–`:198`) and has no column for the rest.

## When the decision is taken

At the spawn, inside the `--agents` payload, which `buildArgs` rebuilds every
cycle from the run's frozen agent copy (`src/lib/orchestrator.ts:4851`,
`:6701`–`:6703`). So it is per cycle for free and needs no change to the frozen
row read at `:6278`.

What it can never be is per *turn*: the delegation happens inside the CLI, after
the spawn, with no hook this app owns. Whatever policy this app expresses is
fixed for the cycle and applies to every delegated turn in it, which is coarser
than the mechanism it would be displacing.

## The measured precedence

`agentsFlagValue` **omits** `model` rather than emitting JSON `null`
(`src/lib/agents.ts:385`), because a member whose `model` is null is dropped by
the CLI outright and a dropped member named on `--agent` fails the spawn
(`:360`–`366`, `docs/agent/agents-and-templates.md:12`) — "the only spelling of
'inherit' that survives". Any router on this path goes through that encoder
rather than beside it; there is one encoder for all four spawn sites for exactly
this reason.

Against the session's own `--model` there is no conflict to resolve: this option
does not write `runs.model` and does not touch `--model`, so
`settings.defaultModel`, a template's model or a per-run box would all continue
to decide the session while this decides what it hands off.

## What the operator sees and controls

The field already exists and the page already describes *this* meaning:
"What the delegated turn runs on — an alias or a full id. Blank inherits the
run's. It moves cost, not capability: the spend lands on the run like any other
turn" (`src/app/agents/page.tsx:282`). That sentence is either the copy this
option makes true again, or the copy that is wrong today — the experiment below
decides which, and there is no third possibility.

Everything else is invisible. This app has no per-turn surface at spawn time.
The only per-turn evidence it holds is after the fact: `attributionAgent` off
each transcript record (`src/lib/transcripts.ts:263`–`264`), rolled up as
`byAgent` (`src/lib/windows.ts:877`) and as `agentSpend`'s rows
(`:528`–`557`), whose bucket key "stays the name the CLI recorded, always"
(`:873`–`876`). That is a reading, not a control.

## Guards, and the three cost sources

No new reader and no new source. The evidence for the *decision* would be the
transcripts, which already attribute per turn — but only historically, which is
the point: a per-turn decision is inside the CLI and this app's only per-turn
data arrives after the money is spent.

Every existing guard already covers the spend either way
(`src/lib/agents.ts:110`–`113`). The check order is untouched
(`docs/agent/budgets-and-guards.md:32`).

## When the pricing table cannot place the model

Same free-form exposure as everywhere else (`src/lib/agents.ts:116`–`119`), with
one aggravation: a delegated turn's model is not the run's, so a run can carry
priced session turns and unpriced delegated ones. Its dashboard figure is then a
partial floor (`docs/agent/metering.md:16`) while `costGuardUSD` charges the
delegated share at $10/$50 (`src/lib/pricing.ts:84`) — and the `byAgent` rollup
is the only place a person could see which bucket did it, since it carries
`costGuardUSD` per row (`src/lib/windows.ts:501`) precisely so the two figures
stay separable.

## How it fails, and whether loudly

**The worst failure mode in this survey, and it is total silence.** If a
member's `model` no longer governs a delegated turn, the payload is accepted,
the member registers, the run behaves identically, the money is spent
identically, and the settings page says otherwise. Nothing throws, nothing logs,
no exit code changes, and the only evidence is a transcript rollup compared
against an expectation nobody wrote down. `src/lib/agents.ts:360`–`366` records
that the CLI's handling of this payload is silent on **every** violation — a
member missing a required key is dropped, a payload that is not JSON is ignored
entirely, "no error, no warning and a zero exit".

**Loud:** nothing here is loud. A malformed payload on the *selected* path fails
the spawn (`:40`–`43`), but this option is on the offered path, where the
failure mode is the one the singular flag was praised for ending.

## What it costs to build

Trivial in code and almost entirely measurement. The encoder already emits the
key (`src/lib/agents.ts:385`); the field, the column and the form already exist.
What has to be built is the measurement that says whether any of it does
anything — and, if it does, a way for this app to name the agents whose turns
carry the money, which the built-in refusal currently forbids.

It is the option with the highest measured prize and the least evidence that it
can be built at all.

## What would have to be true for this to be the right answer

Three things, none of them established:

1. That a member's `model` still governs a delegated sub-turn on the offered
   path. **Assumed**, not measured here.
2. That this app's delegated turns go through members it wrote, rather than
   through built-ins it may not name (`src/lib/agents.ts:179`–`185`). The
   measured spend is in `general-purpose` and `Explore` buckets, which are
   built-ins.
3. That displacing whatever routes those turns today is an improvement rather
   than an argument — and that a policy fixed per cycle beats one taken per
   turn by something with more context than this app has.

**Experiments to name.** The decisive one is small, billed and offline from the
app: spawn `claude -p` with `--agents '{"uf-x":{…,"model":"haiku"}}'` and no
`--agent`, prompt the main thread to delegate to `uf-x`, and read the delegated
turn's model off the transcript — `attributionAgent` and `model` are both on the
record (`src/lib/transcripts.ts:255`–`264`), so `scanUsage()` answers it
directly with no new code. Second: whether anything on an argv this app can
build reaches a *built-in* agent's model at all. Third, free and worth doing
first: run `agentSpend` over this install's window grouped by bucket and origin
(`src/lib/windows.ts:528`) to see whether the delegated share is stable enough
across weeks for a policy to be aimed at it.
