# Option I — the run form carries the model

The person asking for the work picks, on the form where they already write the
prompt and choose the folder. No router, no new record, no new route — the field
is already on the wire and nothing sends it.

**Why this file is here.** It is not on the list of shapes this survey was asked
to cover, and both prior files point straight at it. `00-problem.md` closes on
it: "the wire already carries `CreateRunInput.model` per run and
`SavedAgent.model` per agent, and no surface this app ships sets the first".
`01-constraints.md` lists it as something *every* option owes — "Per-run
override needs a surface, because the wire already has the field and nothing sets
it" — which makes it worth reading once as an option in its own right rather
than only as a tax on the others.

## The strongest case, first

**It is the only option that changes no decision path at all.**
`CreateRunInput.model` exists (`src/lib/orchestrator.ts:2559`),
`POST /api/runs` reads it (`src/app/api/runs/route.ts:233`), `createRun` prefers
it over the setting (`:3205`), `buildArgs` emits it (`:4843`), and the reviewer
reads the column it lands in (`src/lib/review.ts:624`). Every line of the
mechanism is written, tested and in production. What is missing is an `<Input>`.

**And it is the only option that restores the measured precedence rather than
overriding it.** `01-constraints.md`'s first branch — fill only the gap — is
this one: a blank box means the run names no model, `settings.defaultModel`
applies, and if the operator blanks that too, `SavedAgent.model` becomes
reachable for the first time on this install (`src/lib/agents.ts:99`–`110`).
Every option that writes a model onto every run makes the agent's pin
permanently dead; this one is the only one that can hand it back.

**And it puts the choice where the knowledge is.** `00-problem.md` measures the
spread as the task, at fourteen times, on one model. The person writing the task
text is the only party in this app who knows which kind of task it is at the
moment the decision has to be taken.

## Shape

An input on `src/app/runs/new/page.tsx`, beside the agent picker, sending
`model` in the POST body. A row on the run detail page rendering `RunDTO.model`
(`src/lib/apiTypes.ts:559`), which is on the wire and drawn nowhere — the run
page currently shows the *agent's* model
(`src/app/runs/[id]/page.tsx:1329`–`1333`) and the review card the *review's*
(`src/components/RunReview.tsx:44`). One copy edit: the template picker's
description says the model "stays a single global setting"
(`src/app/runs/new/page.tsx:2209`), which this makes false.

No server change. No schema change. No new module.

## Which half of the split

The "what it is asked to do" half, and this option is the reason that half is
even available for a model. `src/lib/settings.ts:480`–`488` says every route
building a `CreateRunInput` takes the guard half "from something a person wrote
— a template, the run form, or the settings above — and the other half from
whatever asked for the work". The run form is on *both* lists. A model typed
there is not a model a proposal wrote or a graph carried; it is the same person,
in the same act, as the prompt beside it.

That is also the limit: it says nothing about the four records that
deliberately hold no model (`src/lib/db.ts:367`, `:616`,
`src/lib/workflows.ts:1345`, `src/lib/templates.ts:35`–`42`), because it never
reaches them.

## When the decision is taken

At `createRun`, from the request body, synchronously — the existing line, the
existing transaction, no `await` added
(`docs/agent/concurrency-and-ownership.md:10`).

Frozen thereafter, like everything else on the row: `startRun` reads it once
before the loop (`:6278`), and `reopenRun` carries it forward by not touching it
(`:8080`). So this option answers `01-constraints.md`'s third obligation and not
its fourth — "a run already started must be overridable, or the override is not
one" is a change to `startRun`, and it is deliberately **not** attempted here.
Adding one would open a second route to the model on a *running* run, which is
the objection `reopenRun` already refuses on its own account.

## The measured precedence

Cleanly preserved, in the one arrangement that makes all three levels reachable:
a typed box beats `settings.defaultModel`, which beats `SavedAgent.model`, which
beats the CLI's own default. That is the current code's order
(`src/lib/orchestrator.ts:3205` then `:4843` then
`src/lib/agents.ts:99`–`110`) with the top rung finally connected to a control.

## What the operator sees and controls

Everything, at the moment they can judge best — and **nothing when they are not
there**, which is the option's boundary and should be stated as such. Three of
the five origins start a run with nobody at the keyboard
(`src/lib/orchestrator.ts:263`–`284`): a chat proposal, a workflow instance and
a schedule. This option answers for `form` and for no other. A chat proposal
holds no model by design (`src/lib/db.ts:616`–`619`) and a schedule fires a
saved configuration nobody is watching.

The read-back is the half that is worth more than the input. An operator today
cannot see, on any page, what model any run used. Adding the field without
adding the row would make that worse rather than better, because now there would
be two places the value could have come from and still nowhere to see which.

## Guards, and the three cost sources

No change to any of it. No new reader, no new source, no change to the check
order (`docs/agent/budgets-and-guards.md:32`). `runs.model` keeps meaning
exactly what it means today, so `review.ts:624` and `run_reviews.model`
(`src/lib/db.ts:218`) keep agreeing.

One consequence to state plainly rather than sell: a cheaper model under an
unchanged `maxRunCostUSD` does not make the run cheaper, it makes the limit go
further in turns (`src/lib/orchestrator.ts:4880`–`4882`). The run form carries
the budget controls too, so the operator can set both in one place — but they
are separate fields and nothing pairs them.

## When the pricing table cannot place the model

This is the best available place for a free-form model string, and the argument
is not that it is safe but that a person is standing there. `isKnownModel`
(`src/lib/pricing.ts:135`, no call site anywhere today) as an inline warning
under the input is a two-line change and puts the mistake where it was made —
which is `src/lib/templates.ts:22`–`31`'s own stated reason for narrowing at
save rather than only at use.

It stays a warning. Narrowing to a list this build knows would refuse the model
that ships next week (`src/lib/agents.ts:116`–`119`), and the price table
refuses catch-all prefixes on the same principle
(`docs/agent/metering.md:20`).

Everything else is unchanged: `costOf` reports the $0 floor and names the model
(`docs/agent/metering.md:16`), the guard charges $10/$50
(`src/lib/pricing.ts:84`), and the run stops early at a limit its displayed
spend has not reached — but now with the person who typed it able to see, on the
run page, what they typed.

## How it fails, and whether loudly

**Loud, and this is the option's quiet strength.** A refused string fails the
spawn immediately, non-zero, in front of the person who typed it seconds
earlier. An unpriced-but-accepted string is warned about at the input and shown
on the run page.

**Silent, one way, and it is new:** a box on the form makes the *absence* of a
value meaningful, and an operator who leaves it blank expecting "the same as
last time" gets the setting, which may have changed. That is a small cost of
having three levels where there was one.

**Silent, one way that already exists and this does not fix:** a run started by
a schedule, a workflow or an approved proposal still takes the setting, with no
box and nobody to fill it.

## What it costs to build

The smallest change in this survey that changes anything. An input, a payload
key, a row on the detail page, an `isKnownModel` warning, and one copy edit.
Half a day, no schema, no migration, no new module, no test surface beyond what
exists.

## What would have to be true for this to be the right answer

That the runs worth routing are the ones a person starts, and that the person
starting them will bother.

The measurement is ambiguous on both. `00-problem.md`'s documentation wave —
eight runs, $74.80, four of them forbidden from writing a file — is exactly the
case where somebody knew in advance that half the work was read-only; whether
those runs came through the form is not recorded in anything readable from here
and is **not verified**. Against it: an empty box is a box nobody fills, and
`settings.defaultModel` would go on deciding, which is Option A with an extra
control.

**The experiment to name:** it needs no code. Ask an operator to blank
`settings.defaultModel` for a week and set a model per run by hand — today that
requires editing the box between runs, which is the point — and see whether the
per-run choices differ from each other at all. If they do not, every option in
this survey that routes per run is answering a question nobody has.
