# Option D — the saved agent's model, leaned on harder

Stop stamping `settings.defaultModel` onto every row and let a run started *as*
a saved agent take that agent's model. Route by role: the record already exists,
the field already exists, the precedence is already measured, and the page
already offers it.

## The strongest case, first

**Every piece of this is already built.** A saved agent may carry a model
(`src/lib/agents.ts:121`, column at `src/lib/db.ts:289`); `agentsFlagValue`
already encodes it into the `--agents` payload (`src/lib/agents.ts:385`);
`sessionAgentArgs` already selects the member with `--agent`
(`src/lib/orchestrator.ts:4851`); the run carries a frozen copy of the whole
definition so a deleted agent cannot reach cycle 4
(`src/lib/orchestrator.ts:6703` and the comment under it); and the agents page
already renders the input (`src/app/agents/page.tsx:279`–`292`). Nothing has to
be designed. What stands between this and working is one line:
`input.model ?? settings.defaultModel` at `src/lib/orchestrator.ts:3205`, which
fills the gap the agent's pin was meant to fill.

**And the precedence is measured rather than assumed** — the only option here of
which that is true. Quoted at `src/lib/agents.ts:99`–`110`, off the
`system`/`init` event on the pinned CLI:

    --agents '{"uf-m":{…,"model":"sonnet"}}'                 → claude-opus-5[1m]
    --agents '{"uf-m":{…,"model":"sonnet"}}' --agent uf-m    → claude-sonnet-5
    --model opus  … --agent uf-m                             → claude-opus-5
    --model haiku … --agent uf-m                             → claude-haiku-4-5-20251001

An explicit `--model` outranks the pin, so an agent's model is a fallback for a
run that named none. Leaning on it does not require overturning that rule; it
requires letting it apply, which on any install with the settings box filled in
it currently cannot.

**And the record is already argued to be the safe place for it.**
`src/lib/agents.ts:45`–`57` records that an agent holds no tool list, no
permission mode, no folder, no budget and no isolation choice, and
`:110`–`113` gives the ground on which the model is admissible at all: it
"moves cost rather than capability … every cost guard already covers it, since
the run's spend lands on its own `result` event and in its telemetry whatever
model produced it." That sentence is this option's whole defence and it was
written before this proposal existed.

## Where a role is the wrong axis

A role says nothing about size. The same `typescript` agent fixes a typo and
performs a migration; `00-problem.md` measures the spread at fourteen times
across 179 sessions **at one model**, so the axis that explains the money is not
one an agent record could hold.

A role says nothing about phase. Cycle 1 reads a repository and cycle 6 is
finishing a diff, and one pin covers both.

And a role reaches only the runs that have one. A run that names no agent gets
nothing, which on a stock install is every run: `settings.defaultAgentId`
defaults to `null` (`src/lib/settings.ts:612`). How many real runs carry an
agent is not measured anywhere — `runs.agent` holds the answer and lives in the
database that is unreadable from a work cycle (`00-problem.md`).

## Shape

Two variants, and they differ in one line.

*Passive.* Change nothing in code; the operator blanks the Settings box, and
every run started as an agent takes the agent's model. Works today. Costs the
install its global default entirely — a run with no agent then takes Claude
Code's own default, which this app neither records nor displays.

*Active.* Reorder the fallback at `src/lib/orchestrator.ts:3205` so an agent's
model outranks `settings.defaultModel` and `input.model` outranks both. That
makes the setting a default *for runs with no agent*, which is what the label
already says, and keeps the measured precedence intact for the argv.

Either way the copy has to change, for a reason that is not this option's doing.

## Which half of the split

Neither, and this is the option that can say so with a citation instead of an
argument. `src/lib/agents.ts:45`–`57` enumerates what an agent may not hold, and
the list is exactly the "what an agent may do" half; `:110`–`113` places the
model outside it as cost. The registry enforces it: a `tools` array is refused
by name at save (`src/lib/agents.ts:187`–`198`), and there is no column for a
permission mode.

## When the decision is taken

At `createRun`, synchronously, from the `AgentDefinition` the caller already
resolved before the call (`src/lib/orchestrator.ts:2571`) — no `await` added
(`docs/agent/concurrency-and-ownership.md:10`). Then at every spawn, because
`buildArgs` rebuilds the argv per cycle
(`src/lib/orchestrator.ts:6701`–`:6703`) and re-emits both the member
definition and the selection.

## The measured precedence

This is `01-constraints.md`'s third branch — *route the agent's pin* — taken
deliberately. Two properties of the encoder are load-bearing and both are
already handled: `agentsFlagValue` **omits** `model` rather than emitting JSON
`null` (`src/lib/agents.ts:385`), because a member whose `model` is null is
dropped by the CLI outright and a dropped member named on `--agent` fails the
spawn (`:360`–`366`). Anything built on top of this must go through that
encoder rather than beside it.

The limit is equally measured: under `--agent` the pin is the **session's**
model, not a delegated turn's (`src/lib/agents.ts:88`–`96`). This option routes
the run. It does not reach the 7,263 sub-agent turns `00-problem.md` measures —
that is Option J, and it is not the same option.

## What the operator sees and controls

The field, which they already have — and a sentence beside it that is wrong
today. `src/app/agents/page.tsx:282` reads "What the delegated turn runs on",
which is the meaning `--agents` alone carried and which the singular flag
removed for the work-cycle path (`src/lib/agents.ts:88`–`96`, where the change
is recorded as "the one field that did" change meaning). This option cannot ship
without fixing that copy, and doing nothing does not make it true again.

What they still cannot see: which model a given run actually ran on. The run
detail page renders `run.agent.model` (`src/app/runs/[id]/page.tsx:1329`–
`1333`) and not `run.model`, so on an install where the setting outranks the
pin, the page displays the value that lost.

## Guards, and the three cost sources

Nothing changes. `src/lib/agents.ts:110`–`113` is explicit that the agent's
model is inside every existing cost guard, because the spend lands on the run's
own `result` event and in its telemetry regardless of which model produced it.
No new reader, no new source, no change to the check order
(`docs/agent/budgets-and-guards.md:32`).

## When the pricing table cannot place the model

Free-form by the same stated reason as everywhere else
(`src/lib/agents.ts:116`–`119`), stored per agent, and an agent is reused across
many runs — so the exposure repeats like a template's rather than being a
one-off like a typed box. `resolvePrice` null → $0 displayed
(`src/lib/pricing.ts:115`–`133`, `docs/agent/metering.md:16`) and $10/$50
charged to every dollar guard on every run started as that agent
(`src/lib/pricing.ts:84`).

`isKnownModel` at the agents form (`src/lib/pricing.ts:135`, no call site today)
is the mitigation, as a warning. The registry already refuses several things by
name at that door, so adding a *refusal* here would be idiomatic and would still
be wrong: it would become the list this repository twice declined to keep.

## How it fails, and whether loudly

**Silent, and specific to this option:** a run that names no agent, on an
install that blanked the settings box, carries no `--model` at all. It runs on
whatever the CLI defaults to; `runs.model` is null, no page shows anything, and
the only way to learn what it was is to read a transcript. That is a strictly
worse position than today's for the ad-hoc run.

**Silent, second:** an operator sets a model on an agent, the settings box is
non-blank, and nothing happens — no error, no log line, the run simply takes the
other value. This is live behaviour today and this option is the one that ends
it.

**Loud:** a member the CLI will not register fails the spawn outright, exit
non-zero before any API call — which is the improvement the singular flag
brought (`src/lib/agents.ts:40`–`43`).

## What it costs to build

The smallest of the options that change behaviour: a fallback order at one line,
two copy edits, and a settings-page sentence. Half a day of code. The argument
takes longer than the diff, and the argument is where the risk is — `01-
constraints.md` warns that a router writing a model onto every run makes the
pin permanently unreachable, and this option is the one that argues the
converse.

## What would have to be true for this to be the right answer

That operators start runs *as* agents at all, and that a role predicts cost well
enough to be worth pinning. Neither is measured.

**Experiments to name.** First: what share of runs carry a `runs.agent`, and do
agent-carrying runs differ in cost from the rest? Answerable from the live
database, not from a work cycle. Second, and sharper because it decides whether
Option J exists at all: does a member's `model` still govern a *delegated*
sub-turn on the **offered** path — `agentsArgs` without `--agent`
(`src/lib/agents.ts:391`–`401`), whose one caller is `spawnAssist`
(`src/lib/review.ts:627`)? Every measurement quoted in this repository is off the
`system`/`init` event, which reports the session's model, so the offered path's
behaviour is **assumed unchanged and is not verified here**. Note that no caller
supplies agents to `spawnAssist` today — `src/lib/agents.ts:354`–`355` says so
in as many words, and `spawnAssist` passes `req.agents ?? []`
(`src/lib/review.ts:627`) — so the experiment has to be run by hand rather than
observed.
