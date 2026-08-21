# Option H — delegation as context isolation

Push read-heavy work into delegated turns. The sub-agent reads the files, the
parent gets the answer, and everything the sub-agent read dies with its turn.

One correction to the framing before the case. The `Explore` and
`general-purpose` bucket figures the survey brief attributes to `00-problem.md`
are in **`proposals/ModelRouter/00-problem.md`** (`:397`–`:400`, `:412`–`:416`);
this proposal's `00-problem.md` carries the aggregate, corrected by
`02-levers-on-the-pin.md` — 3,116 sidechain turns and $188.03 in the rolling
week, 6.5% of this container's bill, already inside `buildSnapshot()`.

## The strongest case

**A delegated turn's context is genuinely, structurally separate, and
`02-levers-on-the-pin.md` measured it on the wire.** Three requests from one
probe:

    req-001  main   tools 28  system 27,452 B  msgs 1   first user 7,111 B
    req-002  agent  tools 14  system  3,204 B  msgs 1   first user 5,309 B
    req-003  main   tools 28  system 27,452 B  msgs 3   first user 7,111 B   (sha unchanged)

Half the tools, an eighth of the system prompt, its own first user message and
**no parent history at all** — and the parent's own prefix is byte-identical
across the delegation (`sha unchanged`). So this is the one mechanism in the
survey that removes content from the main thread without touching the main
thread: nothing is edited, nothing is invalidated, and the parent pays only for
the sub-agent's reply arriving as a tool result.

**And delegated context is written at a cheaper rate, which nothing in this app
had noticed.** `00-problem.md`'s cleanest finding is that "every main-thread turn
on this install writes a one-hour cache and never a five-minute one; every
delegated turn writes a five-minute cache and never a one-hour one. **Zero
exceptions in 26,194 turns.**" The multipliers are 2.0× and 1.25×
(`src/lib/pricing.ts:17`–`:18`), so **the same tokens carried on a delegated turn
are written at 62.5% of what the main thread pays**, and the TTL is a property of
which thread the turn is on rather than of anything this app selects.

**The effect is already visible in this install's own numbers.** Over the rolling
week: main-thread turns cost $2,693.79 over 16,529 turns and sidechain turns cost
$188.03 over 3,116 — **$0.163 a turn against $0.060, so a delegated turn costs 37%
of a main-thread one** (`02-levers-on-the-pin.md`). That is not a counterfactual;
it is what the two thread classes actually cost on this machine.

**And every piece already ships.** The `Agent` tool is in the CLI's tool set, the
sub-agent's cost already reaches `buildSnapshot()` through `listTranscriptFiles`'
recursive walk (`src/lib/transcripts.ts:163`–`:184`), what a delegated turn says
already reaches the run's own log through `--forward-subagent-text` (`:4845`,
default on at `src/lib/settings.ts:615`), and the per-agent split is already a
card on the run page (`src/components/RunAgentCost.tsx`). This option is the one
place in the survey where the instrument, the readout and the mechanism all exist
and only the instruction is missing.

## Shape

**The text this app injects.** That is the whole of it, and it is a consequence of
a decision this app has already taken twice.

The obvious alternative — offering specialists on the argv — is closed. `--agents`
"used to be a list, offered to the run's own main thread as specialists it might
delegate to. It is now the session's own agent: `sessionAgentArgs` emits the
definition *and* selects it by name, so the saved prompt is what this run opens
with rather than a role it may hand a subtask to"
(`src/lib/orchestrator.ts:4792`–`:4799`, the encoder at
`src/lib/agents.ts:433`–`:436`, which emits exactly one member). And the two
buckets where every reachable delegated dollar sits cannot be named by this app at
all: `Explore` and `general-purpose` are on `BUILT_IN_AGENTS`
(`src/lib/agents.ts:179`–`:185`) and `normalizeAgentInput` refuses a saved agent
whose name matches one, by name (`:284`–`:292`) — "the routing that works is
happening in the place this app may not name"
(`proposals/ModelRouter/00-problem.md:412`–`:416`).

So the shape is: a sentence in the generated half of `nextPrompt`
(`src/lib/orchestrator.ts:4299`) or in the editable half beside
`continuedWorkPrompt`, telling the agent that a read-heavy question belongs in a
delegated turn. Optionally, three environment keys the binary carries and
`childEnv` (`:5216`–`:5231`) does not strip —
`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
and `CLAUDE_CODE_SUBAGENT_MODEL` — none of which was exercised on the pin.

## What leaves the context, and when the decision is taken

**Nothing leaves the parent's context, because it never enters. The decision is
the model's, mid-cycle, once per delegation.**

This is Option E's property — content intercepted before it lands — reached
without a hook, without a `--settings` payload and without a fourth store,
because the CLI already builds the sub-agent's conversation as a separate file
under `<session>/subagents/` and returns only its final text.

**Two consequences follow and they pull against each other.** The parent's
saving is bounded by what the sub-agent chooses to say back, so a sub-agent that
returns its findings in full has externalised nothing. And the decision belongs
to the model on every call, which is exactly the boundary `01-constraints.md`
asks about — but with a better answer than compaction has: the sub-agent is not
deciding what the parent may *forget*, it is deciding what the parent is *told*,
which is unambiguously the prompt side of `docs/agent/chat.md:10`'s split.

## What it does to the prefix cache

**Nothing to the parent's, ever.** `sha unchanged` on `req-003` is the
measurement. There is no cut point, so `01-constraints.md`'s `T*` does not apply.

**What it is worth, per large read moved.** Take `00-problem.md`'s mean `Read`
result of 12,928 bytes ≈ 3,232 tokens at the assumed 4 bytes per visible token,
landing at the middle of a 140-turn cycle, at `claude-opus-5`'s $5 per million
(`src/lib/pricing.ts:38`):

| | written | read back | total |
|---|---|---|---|
| on the main thread | 2.0× once = $0.032 | 0.1× × ~70 turns = $0.113 | **$0.145** |
| inside a delegated turn | 1.25× once = $0.020 | 0.1× × its own few turns ≈ $0.008 | **$0.028**, plus the reply the parent then carries |

A 500-byte reply carried by the parent for 70 turns adds about $0.005, so the
move is roughly **$0.145 → $0.033**. That is the best per-unit ratio in the
survey.

**And the counterweight is the sub-agent's own fixed prefix, which is paid per
delegation.** The probe's sub-agent carried 14 tool definitions and a 3,204-byte
system prompt; at the main thread's measured 111,472 bytes for 28 tools, half of
that is roughly 55,700 bytes ≈ 13,900 tokens, written once at 1.25× ≈ **$0.087**.
So a delegation has to displace about three mean-sized reads before it breaks
even — unless a second delegation in the same session matches that prefix from
cache, which is plausible given the 5-minute TTL and is **not established**: no
probe measured two delegations in one session.

**The honest aggregate is that the addressable pool is small.** Delegated turns
are already 6.5% of this container's bill, and
`proposals/ModelRouter/00-problem.md` splits the same figure by directory: inside
the container it is $198.08 over 3,227 turns, **4.8% of the window**. Moving more
main-thread work into that class is moving from a $0.163-a-turn regime into a
$0.060-a-turn one — the ratio is excellent and the base is 5%.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**DONE and `needs-review`: untouched, and structurally so.** Both notices are
prompt text on the main thread (`:4466`, `:4506`), and `cycleEnding` (`:4543`)
matches over the *cycle's* final text, which is the parent's. A sub-agent's reply
arrives as a tool result and never as `res.finalText`.

There is one hazard and it is real rather than theoretical: `forwardSubAgentText`
puts what a delegated turn says into the run's own stream (`:4845`,
`:4813`–`:4822`), and a sub-agent asked to summarise a task about this feature
could emit `DONE` on a line of its own. The flag's docblock already names the
property that makes that safe — "What it changes is the *shape* of the stream
rather than what the run may do — see `settings.forwardSubAgentText` for why that
is worth a switch, and `handleStreamLine` for the one property that makes the new
shape safe" — and any option that leans harder on delegation is leaning harder on
that property holding.

**`--resume`: untouched and unaffected.** Sub-agent conversations are not
resumable and are not meant to be; the parent's session is what
`--resume` continues, and it holds the replies rather than the sub-agents'
histories.

**Retention: no fourth store, and one thing already true that nobody chose.** The
sub-agent transcripts are inside the session directory under
`<session>/subagents/` — 495 files beside 513 main-thread ones — so they are swept
with the session by `expiredTranscripts` (`src/lib/retention.ts:528`) and need no
new horizon. `01-constraints.md`'s fourth-store test is passed without effort.

## Guards and the three cost sources

**Must not touch, and does not:** the check order is untouched — `no_terminus`
(`src/lib/budget.ts:495`), `iterations` (`:506`), `duration` (`:518`),
`run_cost` (`:525`), `run_tokens` (`:532`), `weekly_fraction` (`:551`),
`session_fraction` (`:582`). `RunGuards` (`src/lib/settings.ts:489`) gains
nothing. A sub-agent carries a role and never a capability, which is what
`agents.ts`' refusal of a `tools` field enforces (`:187`–`:228`) — and the
refusal got *stronger* under `--agent`, not weaker (`:200`–`:207`).

**One guard interaction, and it is the sharpest in this file.**
`buildCurrentSnapshot` filters the entries the window guards are evaluated
against on `settings.includeSidechains` (`src/lib/orchestrator.ts:6224`–`:6226`).
The default is `true` (`src/lib/settings.ts:614`), so on a stock install
delegated spend is inside the weekly and 5-hour readings and nothing changes. **On
an install whose operator has switched it off, moving work into delegated turns
moves that spend outside what `maxWeeklyFraction` and `maxSessionFraction` are
measured against.** That is not the option widening a guard — the setting already
does it — but an option whose whole content is "do more of the thing that setting
excludes" is the option that makes it matter, and it owes the sentence.

**Adds to which source: nothing new, and the reading it needs already exists.**
The delegated split is `agentSpend` (`src/lib/windows.ts:528`) over transcript
entries scoped to one session, served by `GET /api/runs/[id]/agent-cost` and shown
by `RunAgentCost` — a card whose own docblock already says the three readings of a
run's cost measure it by three routes and that "adding any pair of them counts the
same work twice".

## What the operator sees, and how they override it by hand

**Sees, and this is the best-served option in the survey.** The per-agent split is
already on the run page, with a share and a meter, on its own 30-second poll. The
sub-agent's own text is already on the run's log, gated by a setting
(`forwardSubAgentText`, `src/lib/settings.ts:144`, default `true` at `:615`). The
dashboard already groups the week `byAgent` (`src/lib/windows.ts:877`, rendered at
`src/app/page.tsx:400`). An operator can see, today, without building anything,
what proportion of a run happened off the main thread.

**Overrides:** the instruction is prompt text, so emptying its box switches it
off — `null` / `""` / `0` all mean off (`docs/agent/budgets-and-guards.md`) — and
`saveSettings` stores only what differs from `DEFAULTS`
(`src/lib/settings.ts:693`). The generated half, if there is one, is not
editable, for `COMPLETION_NOTICE`'s reason (`src/lib/orchestrator.ts:4448`–`:4454`).

**Per run:** no surface, and none is needed. The operator's own task text already
reaches the agent verbatim and is the natural place to say "audit this by
delegating"; `docs/runs.md` promises a follow-up is sent verbatim as the next
turn (`:4353`–`:4355`).

**Mid-run:** the `settings` case, read once at `:6379` and fixed for the segment
(`:6722`–`:6723`), unless the instruction is moved to a per-cycle read. Prompt
text composed per cycle at `:6608` could be re-resolved; nothing forces it either
way, and the option should say which it is rather than inherit.

## How it fails, and whether loudly

**Loud: nothing, and nothing to be loud about.** No flag, no hook, no schema. On
a build with no `Agent` tool the instruction is ignored and the run behaves as it
does today.

**Silent, first: the sub-agent's context is unbounded and this app cannot cap
it.** `02-levers-on-the-pin.md`'s verdict is explicit — "Nothing observed bounds
the *size* of a delegated turn's context — no flag, no env var and no `--agents`
field reached it in any probe", **could not establish**. So a delegation that goes
wrong is a conversation this app has no lever over, spending against the run's
budget, visible only as sidechain cost after the fact. Whether `--max-budget-usd`
(`:4880`–`:4882`) bounds a cycle's delegated turns as well as its main-thread ones
is **not established here** and is the single question that would most change this
option's risk.

**Silent, second: the agent ignores the instruction, or takes it too far.** Both
are invisible in the same way. `RunAgentCost`'s share is the only place either
would show, and it shows it as a number nobody has a baseline for.

**Silent, third: the sub-agent returns everything.** A delegated turn that reads
five files and reports them verbatim has moved the bytes into the parent by a
different door, at a *worse* rate — the parent writes them at 2.0× having also
paid the sub-agent's prefix. Nothing distinguishes that from a delegation that
worked.

**Silent, fourth: the delegated turn re-derives.** A sub-agent has no parent
history, which is the mechanism and also the cost. It re-reads what the parent
already had, and `03-experiment-resumed-vs-fresh.md`'s bracket is the same
argument one level down: the fresh conversation is cheap until it starts reading.

## What it costs to build

**Files touched:** `src/lib/orchestrator.ts` (one notice in `nextPrompt`),
`src/lib/settings.ts` and the settings page if the guidance half is editable. If
the environment keys are used: `childEnv`'s `extra`, `docker-compose.yml`, `.env`
and `src/lib/config.ts`. Nothing else — no route, no component, no store, no
schema, no migration. It is the second-smallest build in the survey after Option B.

**Invariants at risk — three, and all of them are lines this app has already
drawn.** `BUILT_IN_AGENTS`' refusal (`src/lib/agents.ts:179`–`:185`,
`:284`–`:292`), which means no version of this option may try to define
`Explore`. The `tools`-field refusal (`:187`–`:228`), which means no version of it
may narrow a sub-agent by capability. And `--agents`-as-a-list, which
`buildArgs`' docblock records as a deliberate move away
(`src/lib/orchestrator.ts:4792`–`:4799`) — an option that wants specialists on the
argv is proposing to undo it, and owes that argument rather than assuming it.

**It earns no test under `CLAUDE.md`'s bar.** No pure function is added. The
existing `agentSpend` tests (`src/lib/windows.test.ts:710`, `:744`, `:756`) already
cover the reading, and `docs/agent/testing.md` is explicit that the list is the
bar rather than a convention to extend. What this option needs instead is a line
in `docs/verification.md`'s "Not yet verified by hand" section (`:630`): whether a
cycle's `--max-budget-usd` bounds its delegated turns.

## What would have to be true

**That the work this app's runs do is separable.** A delegated turn returns text,
so it fits a question with an answer — an audit, a search, a "which files
mention X". It fits badly where the reading *is* the work, and
`00-problem.md` measures that 31.2% of `Read` bytes belong to files the run
later edited or wrote. Those cannot be delegated: the parent needs the contents to
make the edit.

**That the addressable base is worth the instruction.** Delegated turns are 4.8%
of the container's window today. Doubling that at a 37%-of-main-thread rate moves
roughly 5% of the bill from $0.163 a turn to $0.060 — the ratio is the best in the
survey and the pool is the smallest.

**And the fact that most weakens it, from the file that established the
mechanism:** nothing on the parent's argv bounds a delegated turn's size, and
`02-`'s verdict on that is *could not establish* rather than *does not exist*. An
option whose whole content is "do more of this" is an option that increases
exposure to a class of spending this app can observe and cannot bound.
