# What a routing option has to survive

Not preferences. Each of these is a property of the running system that an
option either preserves or breaks, and most of them break *silently* — the
standing complaint this repository records about every defect it has found
(`CLAUDE.md`, "Before you edit"). Read them before the options, because three of
them rule out shapes that otherwise read as obvious.

## The model is currently in neither half of the split

`RunGuards` is the app's own name for the boundary (`src/lib/settings.ts:489`),
and the comment above it states the rule the whole approval gate rests on
(`:480`–`:488`):

> Everything that decides what an agent may do, as against what it is asked to
> do. […] `CreateRunInput` is this plus a folder and a prompt, and every route
> that builds one takes this half from something a person wrote — a template,
> the run form, or the settings above — and the other half from whatever asked
> for the work.

`RunGuards` is three fields: `permissionMode`, `isolate`, `budget`. The model is
not one of them, and it is not the prompt or the folder either. It arrives on
`CreateRunInput` as a fourth thing (`src/lib/orchestrator.ts:2559`) resolved from
`settings.defaultModel` (`:3205`).

**An option must say which half it is putting the model into, and the answer is
load-bearing.** If it is in the "what an agent may do" half, then everything
that guards that half applies: a template would have to be able to carry it, a
chat proposal would not, an orchestrator block's spec would not, and a workflow
node would not — the four refusals quoted in `00-problem.md`. If it is in the
"what it is asked to do" half, then a model that writes a proposal may pick it,
and the option has to argue why that is safe when picking a permission mode is
not.

Neither answer is free, and "it is a third kind of thing" is an available
position that has to be argued rather than assumed.

## Guards are not the router's to touch

The budget, the work-cycle cap, the permission mode and the isolation choice
come from a template or the default guard set, never from anything a model
emitted (`src/lib/db.ts:367`, `:616`, `src/lib/workflows.ts:1345`,
`settings.chatDefaultGuards` at `src/lib/settings.ts:477`). A model choice must
not become a back door to any of them.

The concrete failure to design against is not a router writing a `budget` field
— nothing on the wire would carry it. It is a router whose *choice of model*
changes what a guard means:

- `--max-budget-usd` is derived per cycle as `max(0, maxRunCostUSD -
  spentGuardUSD)` (`src/lib/orchestrator.ts:4880`–`4882`). A cheaper model does
  not change that number; it changes how many turns fit under it. That is not a
  violation, but an option claiming a run limit "goes further" on a cheap model
  is describing exactly this and should say so in those words.
- `maxIterations` counts cycles, not money (`src/lib/budget.ts:97`). Routing a
  run onto a model that needs more cycles spends the terminus, and the terminus
  is the one thing `docs/agent/budgets-and-guards.md` says must stay monotone —
  `maxIterations` is nullable only alongside `maxDurationMinutes`
  (`src/lib/budget.ts:87`–`91`, refused as `no_terminus` at `:494`–`:496`).
- The check order is fixed — terminus, cycles, duration, run spend, weekly, then
  session (`docs/agent/budgets-and-guards.md:32`) — and nothing about a model
  choice may reorder it or add a rung to it.

## The pricing table decides whether a guard still guards

This is the constraint that most narrows what a router may select, and it is the
one an option is most likely to miss.

`resolvePrice` returns `null` for a model string the table cannot place
(`src/lib/pricing.ts:115`–`133`), and the two consumers of that null go opposite
ways on purpose:

- `costOf(t, null)` is `0`. That is the honest number to **display** — the
  dashboard reports the floor and names the model
  (`docs/agent/metering.md:16`).
- `guardCostOf(t, null)` charges `UNKNOWN_MODEL_PRICE`, `{ input: 10, output: 50
  }` (`src/lib/pricing.ts:84`, `:194`–`:199`). The comment above it
  (`:71`–`:83`) says why that rate and not another: it is the most expensive
  *current-generation* entry in the table, "deliberately not the $5/$25 Opus
  tier: an unrecognised ID must not be able to look cheaper than a model that is
  actually in the table."

Those flow to two different fields that must never be collapsed: `costUSD` /
`fraction` are what the user is shown, `costGuardUSD` / `guardFraction` are what
the guard acts on (`src/lib/windows.ts:65`, `:259`, `:353`,
`docs/agent/metering.md:18`).

Three consequences for a router:

1. **A router that can select a model the table cannot place makes every
   dollar-denominated guard on that run fire early.** The guard charges it
   $10/$50 — twice `claude-opus-5`'s rate and ten times `claude-haiku-4-5`'s
   (`src/lib/pricing.ts:38`, `:56`) — so a router reaching for something cheap
   and new gets the *most* expensive treatment the guard can give. Early is the
   safe direction, and it is still a behaviour change nobody asked for,
   arriving as a run stopped at a limit it had not reached. Note the perverse
   incentive it creates: the newer and cheaper the model, the harsher the guard.
2. **The same run's dashboard will read $0 for those turns.** A run that both
   contributes nothing to the displayed total and trips the guard is the exact
   shape of "looks right, is wrong" this app treats as the expensive failure.
3. Whatever the router selects from, it cannot be a hard-coded list of the
   models this build knows. `settings.defaultModel` is free-form for a stated
   reason — "an alias (`sonnet`), a full id (`claude-opus-5`) and the literal
   `inherit` are all accepted by the CLI, and narrowing to a list this build
   knows would refuse the model that ships next week"
   (`src/lib/agents.ts:116`–`119`). And the price table itself refuses short
   catch-all keys on the same principle: `canonicalModelId` strips decoration
   only, and `docs/agent/metering.md:20` forbids adding `claude-opus-4`-style
   prefixes because they "would price an unreleased `claude-opus-4-9` at a
   confident wrong number instead of surfacing it as unknown."

So an option may not close the set, and may not pretend the set is priced.
`isKnownModel()` already exists (`src/lib/pricing.ts:135`) and is the shape of
the check a router would owe the operator at the moment of selection — but
answering "unknown" there is a warning, not a refusal, or the router becomes the
list this repository twice refused to keep.

Two smaller pricing facts a router's arithmetic must not hard-code. Cache classes
are multiples of the model's *input* rate, not independent numbers — 0.1× read,
1.25× 5-minute write, 2.0× 1-hour write (`src/lib/pricing.ts:16`–`18`) — and
`resolvePrice` is date- and speed-aware: Sonnet 5's introductory rate ends
2026-09-01 (`:68`–`:69`) and fast mode is its own table at 2× for two Opus
entries (`:62`–`:66`). A router that ranks models by a number it computed once
is wrong on a date boundary and wrong under fast mode.

## The measured precedence, and what staying consistent with it costs

The pin's behaviour, quoted at `src/lib/agents.ts:99`–`110`: an explicit
`--model` outranks a selected agent's own pin, and an agent that names one only
reaches a run that named none.

`buildArgs` passes `--model` whenever `opts.model` is truthy
(`src/lib/orchestrator.ts:4843`), and `opts.model` is `run.model`, which is
`settings.defaultModel` unless a caller supplied one. So on any install with
that text box filled in, **the agent's pin is already unreachable**. A router
that writes a model onto every run makes it permanently unreachable on every
install, including the ones where the box is blank today.

An option therefore has to pick one of three, in the open:

- **Fill only the gap.** Emit a model only where the run named none, leaving the
  agent's pin to win where there is one. Preserves the precedence exactly and
  makes the router the weakest voice in the room.
- **Outrank the agent.** Write `runs.model` and accept that `SavedAgent.model`
  becomes dead configuration — which needs a change to the agents page, where
  the field is currently offered (`src/app/agents/page.tsx:286`), or operators
  will keep setting something that no longer does anything.
- **Route the agent's pin instead.** Decide the value that goes in the
  `--agents` payload rather than the one on `--model`. Note this does *not*
  reach delegated turns any more: `agentsFlagValue` emits `model` into the
  member (`src/lib/agents.ts:385`), and with `--agent` beside it that is the
  session's model, not a sub-turn's (`src/lib/agents.ts:88`–`96`).

Whichever is chosen, `agentsFlagValue` **omits** `model` rather than nulling it —
"the only spelling of 'inherit' that survives", and a member whose `model` is
JSON `null` is dropped by the CLI outright, measured on the pin
(`docs/agent/agents-and-templates.md:12`). A router that emits `null` for "no
opinion" produces a run that fails at the spawn.

## Three cost sources, and a router may read only some of them

`docs/agent/architecture.md:10` and `CLAUDE.md`: three data sources, never
summed or mixed in the UI. OTLP telemetry "must never reach `buildSnapshot()` or
`runs.spent_usd`", and reaches a budget decision through exactly one door —
`telemetrySpendSince` → a `*Guard*` figure, for one run, one cycle.

A router that decides on evidence has to name which source it reads, and each
has a disqualifying property for some purpose:

- **Transcripts** (`src/lib/transcripts.ts:406` → `src/lib/windows.ts:669`) are
  the only source with a `cwd`, a model string per turn, and the sub-agent
  attribution a per-turn policy would need — and they are also the only one the
  windows and every guard but one already read. A router reading them adds a
  reader, not a source.
- **`runs.spent_usd`** is a floor of what the CLI reported for work cycles, and
  deliberately excludes reviews (`src/lib/db.ts:206`–`211`) and killed cycles
  (which land in `spent_usd_est`).
- **OTLP** carries first-party per-request cost and a `model` column
  (`src/lib/db.ts:192`), is the only way to account for a cycle killed before
  its `result` event, and is gated on `settings.telemetryForRuns` with one
  exception. It has no backfill and no `cwd`, and it collapses the 5m/1h cache
  split. **A router must not become a second door from it into a decision** —
  the existing door is narrow on purpose, and widening it is a change to that
  invariant, not an application of it.

The UI rule is separate and just as binding: no figure, meter, badge, total or
comparison is drawn at region level, so a card claiming "this router saved $X"
would have to say which source it read and sit inside that source's band
(`docs/agent/conventions.md:46`).

## When the decision may be taken

Three candidate moments, and the code answers each differently today.

**At creation.** `createRun` writes `runs.model` inside a transaction reached
with no `await` from the function's entry (`src/lib/orchestrator.ts:3190`,
`docs/agent/concurrency-and-ownership.md:10`, which adds that "the
`db().transaction()` wrapper does not save you"). **A router that runs here may
not be asynchronous.** That rules out asking a model, calling an API, or reading
a file with `fs.promises` at this point — adding an `await` on this path is the
change that silently puts two agents in one directory. A synchronous rule over data
already in memory is admissible; anything else has to happen before `createRun`
is called, on the route, and be passed in as `input.model`.

**Between cycles.** This is where an option is most likely to be wrong about the
current behaviour. `buildArgs` is called inside the cycle loop and re-sends
`--model` every time (`src/lib/orchestrator.ts:6412`, `:6701`–`:6703`) — but
the row it reads is frozen before the loop opens:

    const run = getRun(id);            src/lib/orchestrator.ts:6278
    …
    for (;;) {                         src/lib/orchestrator.ts:6412

So writing `runs.model` mid-run changes nothing until the run is picked up
again. Two things in that same loop *are* re-resolved per cycle and are the
precedent to follow if an option wants this: `enabledPluginDirs()` at
`src/lib/orchestrator.ts:6690`, and the sandbox policy, both with the same
stated reason — "a run outlives the plugin list it started under, and each
stored path is re-proved contained at the moment it is used rather than
trusted from when it was switched on" (`:6686`–`:6689`). `settings` is the
counter-precedent, read once at `:6379` so that what comes off it is "fixed
for the segment rather than per cycle" (`:6722`–`:6723`).

An option that wants per-cycle routing must say which of those two it is, and
must state that it is *changing* a frozen read rather than adding to a live one.

**At spawn.** Effectively the same as per-cycle, since `buildArgs` is the last
thing before the spawn — with the difference that a value computed there is not
recorded anywhere. `runs.model` would then no longer describe what the run ran
on, which breaks the reviewer (`src/lib/review.ts:624` reads the column) and
makes `run_reviews.model` disagree with the cycles it is reviewing.

**What `--resume` does to each.** Nothing, and that is the useful answer.
`buildArgs` rebuilds the whole argv per cycle, so the resumed cycle carries
whatever `opts.model` says; the test at `src/lib/orchestrator.test.ts:2353`
pins it. Whether the CLI would have *restored* a model across `--resume` on its
own is **not verified here**, and no option should need it to be: `--plugin-dir`
is the flag that measurably does not survive
(`src/lib/orchestrator.ts:4824`–`4838`), and the shape that survives both
answers is the one already in the code — send it every cycle. An option that
proposes to send `--model` only on the opening cycle is depending on an
unmeasured property, and the failure would be silent.

There is a fourth moment worth naming because it is where the money is and the
app does not reach it at all: **the delegated turn**. `00-problem.md` measures
1,231 `general-purpose` turns on Sonnet and 948 on Opus in one week, inside
sessions whose main thread was Opus. Nothing on any argv this app builds chose
either.

## What the operator must still be able to do by hand

Today there is exactly one control — the "Default model" text box on the
Settings page (`src/app/settings/page.tsx:2229`–`2248`), placeholder "Claude
Code's own default", writing `settings.defaultModel` through
`PUT /api/settings` (`src/app/api/settings/route.ts:215`–`218`, which trims and
maps empty to `null`).

Four things any option owes it:

1. **The box must keep meaning what it says.** If a router can overrule it, the
   row is a default rather than a setting and the copy has to say so — a label
   reading "Default model" over a control the app routinely ignores has stopped
   describing its control. The same edit is owed to the template picker's
   description, which currently tells the operator the model "stays a single
   global setting" (`src/app/runs/new/page.tsx:2209`).
2. **A Save stores only what differs from `DEFAULTS`, and that is a correctness
   decision rather than a size one** (`docs/agent/conventions.md:14`). A router
   with a settings-shaped configuration must not be written out whole, or every
   future default on that install is dead.
3. **Per-run override needs a surface, because the wire already has the field
   and nothing sets it.** `CreateRunInput.model` is read at
   `src/app/api/runs/route.ts:233` and no page sends it. Whatever the router
   decides, the run form is where a person disagrees with it, and the run detail
   page is where they would find out what it chose — today `RunDTO.model` is on
   the wire (`src/lib/apiTypes.ts:559`) and rendered on no page.
4. **A run already started must be overridable, or the override is not one.**
   Given the frozen read above, that is a change to `startRun` and not just a
   new button. `reopenRun` reaches the model the way it reaches the agent and
   the permission mode — by not touching it, with no argument on the function
   and no field on the reopen route that could
   (`docs/agent/agents-and-templates.md:18`; `grep -rn "SET model" src/` returns
   nothing). So an option that wants "change it and pick it back up" is opening
   a **second** route to the model, which is the precise objection
   `src/lib/templates.ts:35`–`38` records against a template holding one: "two
   places to set one thing is how they drift, and the second place would be the
   one nobody remembers to check." Answering it is not optional.

## What falls out as criteria

Whether the decision is expressible without opening a second route to something
a person is supposed to decide; whether it survives an unpriced model without
either lying to the meter or firing a guard early; whether it holds the measured
`--model`-over-agent precedence or replaces it deliberately; where it sits
relative to the `no-await` boundary in `createRun` and the frozen row in
`startRun`; whether it reaches delegated turns, which is where 12% of the week's
money is and where this app currently has no voice at all; and whether its
failure is loud — because a router that quietly stops routing looks exactly like
one that never ran.
