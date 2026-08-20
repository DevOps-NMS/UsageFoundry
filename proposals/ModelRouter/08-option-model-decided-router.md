# Option G — a model-decided router

A cheap `claude` child reads the task text and answers with a model. The app
spawns it before the run, takes its answer, and starts the work cycle on
whatever it named.

## The strongest case, first

**It is the only option that can read the thing that actually varies.**
`00-problem.md` measures the spread at fourteen times across 179 sessions of
fifty turns or more — $4.75 to $66.66 — every one of them on `claude-opus-5`.
Whatever explains that is the task, and no field on `CreateRunInput` encodes it.
The prompt does, in prose. Reading prose is what a model is for; every other
option in this survey routes on a proxy for it.

**And there is a precedent in this app for letting a model decide more than
this.** An orchestrator block already decides *which runs happen at all*: it
emits a `RunSpec` per run, and the boundary is five fields — a title, a brief, a
folder, an agent, and which sibling it starts after
(`src/lib/workflows.ts:1345`–`1356`). A classifier that answers with one string
is strictly less than that, and it is answering a question about cost rather
than about capability, which is the line this app draws
(`src/lib/agents.ts:110`–`113`).

**And it degrades to something already argued safe.** Constrain the classifier
to choose among options *an operator configured* and it stops emitting free text
altogether — it becomes Option E's rule table with a model as the matcher, which
is the strongest form this option has and the one it should be read in.

## Which half of the split

Cost, not capability — and the argument has to be made rather than assumed,
because it is the whole of what makes this admissible. `src/lib/agents.ts:187`–
`198` is the rule: prompt text is the one half of a run a model may write, a
tool list is the other half and is refused at the door. A model is on the cost
side by `src/lib/agents.ts:110`–`113`'s reasoning: the spend lands on the run's
own `result` event and every existing cost guard covers it whatever produced it.

One thing is genuinely new and should be stated. A model-written *choice among
records a person wrote* already reaches an argv — a chat proposal names a
template and an agent, resolved at the click (`src/lib/chat.ts:920`–`926`). A
model-written **free-form string** reaching an argv has no precedent here. That
is the difference between the two forms of this option, and it is the reason the
constrained form is the defensible one.

## What it costs, exactly

**Another child process, and this one is invisible to the cap.** There are four
kinds of agent child from four modules, plus `claudeAuth.ts`'s fifth, which
starts no agent (`docs/agent/architecture.md:131`). `maxConcurrentAssists`
bounds three of the four through one door — `assistRefusal()`
(`src/lib/review.ts:437`) over `liveAssistChildren()` (`:375`), which counts
rows in `run_reviews`, `chat_sessions` and `workflow_instance_blocks`. Counting
rows rather than holding a number is deliberate: it is what makes the answer
survive the module boundaries (`:360`–`374`). A classifier has no table, so it
is invisible to that count and unbounded — twenty-five runs starting together
spawn twenty-five classifiers that nothing knows about, against a `mem_limit`
sized for the fleet. It needs a row of its own, or a slot in an existing table,
or an explicit bound of its own kind, the way the login child is bounded by "at
most one pending per install" (`src/lib/claudeAuth.ts:18`). None of those is
free and one of them has to be chosen.

**Another failure mode, and several of them are new shapes.** It can hang, be
refused by the provider, return prose instead of a string, or return a model the
price table cannot place — which is `01-constraints.md`'s worst case reached by
the app's own decision rather than by an operator's typo. It needs a timeout, a
recorded reason, and a fallback policy that is written down rather than assumed.

**Another thing to meter, and getting it wrong is silent both ways.** Its spend
lands in the transcripts like every other turn and must not land in
`runs.spent_usd`, which is a floor of what the CLI reported *for work cycles*
(`src/lib/db.ts:206`–`211`). A review got its own table for exactly this reason
(`:200`–`211`). So the classifier needs its own row too, or its cost either
inflates the run it decided for or appears in the dashboard's window total while
appearing in none of this app's own ledgers.

**The `createRun` boundary, which rules out one path outright.** The classifier
is asynchronous, so it cannot run inside `createRun`
(`docs/agent/concurrency-and-ownership.md:10`,
`src/lib/orchestrator.ts:3190`). It has to run before the call, at each of the
six call sites (`grep -rn "createRun({" src/`, outside the tests:
`src/app/api/runs/route.ts:229`, `src/lib/chat.ts:933`,
`src/lib/workflows.ts:3243`, `:4295`, `:4720`, `:5441`). Workflow instantiation
is "topological, one synchronous pass, all or nothing" (`CLAUDE.md`;
`src/lib/workflows.ts:3243` is inside it), so a per-node classifier call would
break that outright — half a graph is not a smaller workflow. **On the workflow
path this option is not available as stated**, and would have to classify before
instantiation begins or not at all.

**And a fifth cost that is not technical:** an operator cannot predict what
their runs will cost per token, because the answer is generated. Every other
option in this survey produces a value a person could have looked up in advance.

## When the decision is taken

Before `createRun`, per run, once. Per cycle is worse on every axis — a
classifier child per work cycle doubles the number of `claude` processes the
install runs and adds its latency to every cycle boundary.

## The measured precedence

Whatever it emits lands on `runs.model`, so it **outranks the agent**
(`src/lib/agents.ts:99`–`110`) on every run it decides. Returning `null` for "no
opinion" is available and is worth taking seriously here more than elsewhere:
"the classifier abstained" is a better default than "the classifier guessed",
and abstaining hands the run back to the agent's pin and then to the setting.

## What the operator sees and controls

A switch, and — in the constrained form — the list of models it may choose
among. What they cannot have is the ability to predict a particular run's
choice, so the read-back obligation is absolute rather than owed: the chosen
model, the reason, and the fact that a classifier chose it, on the run's own log
and on the run page. Today `RunDTO.model` renders nowhere
(`src/lib/apiTypes.ts:559`), and this is the option that cannot ship in that
state.

## Guards, and the three cost sources

The classifier itself must read no cost source — if it did, it would be Option F
with a model in the loop and would inherit every hazard there. Its *own* spend
touches all three by accident unless it is placed deliberately: transcripts
(unavoidable, it is a `claude` turn on this machine), `runs.spent_usd` (must not
— see above), and OTLP if it is given telemetry env, which a review deliberately
is not, because `otlp_requests.run_id` is compared against the run's own spend
and a non-cycle child's requests would make an accounted-for run look
unaccounted-for (`docs/agent/architecture.md:131`).

The check order is untouched (`docs/agent/budgets-and-guards.md:32`). The
classifier is not a guard and must never become one.

## When the pricing table cannot place the model

In the free-form form, **the app has handed the $10/$50 guard rate to a
generative process** (`src/lib/pricing.ts:84`). A hallucinated model id that the
CLI happens to accept bills real money, displays $0
(`docs/agent/metering.md:16`), and charges every dollar guard on that run at
twice Opus's rate through `spentGuardUSD`
(`src/lib/orchestrator.ts:4880`–`4882`). A hallucinated id the CLI rejects fails
the spawn, which is the good outcome.

`isKnownModel` (`src/lib/pricing.ts:135`) is the obvious check, and here it is
the one place in this survey where turning it into a **refusal** is arguable:
refusing a *model's* invention is not the same act as refusing an *operator's*
typed string, and it does not become the closed list this repository twice
declined to keep (`src/lib/agents.ts:116`–`119`,
`docs/agent/metering.md:20`) — the operator's own boxes stay free-form. That is
an argument, not a settled point, and it should be made explicitly if this
option is built.

In the constrained form the question does not arise: the set is an operator's
and the exposure is Option E's.

## How it fails, and whether loudly

The tempting design is the quiet one: classifier fails, fall back to
`settings.defaultModel`, carry on. That is a fallback that hides a failure, and
this app's stated posture on exactly that shape is the opposite — a rule that
cannot bind is refused rather than ignored (`src/lib/budget.ts:490`–`:498`,
`docs/agent/metering.md:12`, which also records what happened the one time a
refusal was acted on too widely). The honest design says which it is: either the
run refuses to start (loud, and stops the fleet when the provider is having a
bad hour), or it falls back **and logs it on the run** (quiet in aggregate, but
visible per run, and countable afterwards).

Silent in a way no logging catches: a classifier that is confidently wrong. It
routes a migration onto Haiku, the run takes four cycles instead of one, spends
the terminus (`src/lib/budget.ts:86`–`98`) and produces a worse change. Nothing
in this app measures change quality, so that failure is invisible to every meter
here by construction.

## What it costs to build

The largest of the options in this survey. A module, a table or an explicit
bound, a timeout, a fallback policy, a metering decision, up to six call sites,
a settings surface, run-page read-back, and a way to test it that does not spend
money on every `npm test` — which means a seam for a fake classifier, since the
existing suite is pure functions only (`docs/agent/testing.md`). A week and a
half, and it is the only option here that adds a process to the install's
steady-state footprint.

## What would have to be true for this to be the right answer

That the classifier is right often enough that its own cost plus the cost of its
mistakes is less than the difference it captures. The difference measured is
1.1% of the weekly window on the documentation wave and 6.8% on sub-agent turns
that this option does not reach (`00-problem.md`). A classifier turn at
Haiku-tier rates is cents; one misrouted run is dollars, and this app cannot see
a misrouted run at all.

**Experiments to name.** First, and it needs no new code: take the eight runs of
2026-08-19 that `00-problem.md` costs at $74.80, show a cheap model each task
text with the set of candidate models, and score its answers against what a
person would have chosen. That is offline, cheap, and it is the same shape as
`proposals/ExternalValidator/`'s offline spike — which is the precedent for
scoring a proposed model-in-the-loop before building it. Second: run one of
those tasks end to end on the cheaper model and compare cost *and* outcome. That
is a billed experiment and it is the only one that settles the fixed-token-count
assumption `00-problem.md` says the whole case rests on; it is named here rather
than run.
