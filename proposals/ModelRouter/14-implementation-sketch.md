# Implementation sketch

What `13-recommendation.md` would take, module by module, in the order it would
be done. Four phases, of which the first three are the deliverable and the
fourth is a boundary rather than work.

**The rule that runs through all of it, stated once and repeated at each step
that could break it: a model choice must not become a route to a budget, a
permission mode or an isolation decision.** `RunGuards` is three fields —
`permissionMode`, `isolate`, `budget` (`src/lib/settings.ts:489`–`:493`) — and
the comment above it (`:480`–`:488`) is the whole approval gate: every route
that builds a `CreateRunInput` takes that half "from something a person wrote"
and the other half "from whatever asked for the work". The model is in neither
half today, arriving as a fourth field on `CreateRunInput`
(`src/lib/orchestrator.ts:2559`). **Nothing below moves it.** Concretely, the
change is wrong if at the end of it any of these is true:

- `RunGuards` has a fourth field, or `settings.chatDefaultGuards`
  (`src/lib/settings.ts:477`) carries a model.
- `budgetFromForm` reads one, or `normalizePolicy`
  (`src/lib/budget.ts:613`–`618`) returns one.
- `run_templates` has a model column — that is Option C, deliberately not taken.
- `planNode`, `planProposal` or `planInstanceStep` resolve a model from anything
  a model wrote. The four records that hold none (`src/lib/db.ts:367`–`370`,
  `:616`–`619`, `src/lib/workflows.ts:1345`–`1351`,
  `src/lib/templates.ts:35`–`42`) still hold none afterwards.
- Any code path derives `--permission-mode`, `--max-budget-usd` or an isolation
  decision from what the model field says.

The last one is the subtle one, and it has a true form that must be said out
loud rather than discovered: **a cheaper model does not lower a run limit, it
changes how many turns fit under it.** `--max-budget-usd` is derived per cycle
as `max(0, maxRunCostUSD - spentGuardUSD)`
(`src/lib/orchestrator.ts:4880`–`4882`) and `maxIterations` counts cycles rather
than money (`src/lib/budget.ts:97`). That is not a violation and it is not a
saving either; it is the guard behaving as designed against a different rate.

## Phase 0 — three repairs owed whichever option wins

None of these is routing. Each is a defect `02-option-do-nothing.md` records as
live today, and each is a precondition for every other option in the survey.

### 0a. Render the run's own model

**Touches** `src/app/runs/[id]/page.tsx`. The "How it was set up" region already
carries a `ListRow label="Its model"` — inside the `run.agent &&` block,
reading `run.agent.model ?? "the run's own"`
(`src/app/runs/[id]/page.tsx:1329`–`1333`). That fallback string names a value
the page never renders anywhere.

**The change** is a row for `run.model` that appears whether or not an agent was
named, and — where both exist and differ — a sentence saying which won.

**Invariants it must not break.**

- `RunDTO.model` is already on the wire (`src/lib/apiTypes.ts:559`), so nothing
  new is imported. `"use client"` files import from `apiTypes.ts` and
  `format.ts`, never `windows.ts` or `transcripts.ts`
  (`docs/agent/conventions.md:10`).
- **A region carries no figure of its own.** "A *region* is not an eighth
  affordance", it is a `<div>` with an `<h2>` and never a `<section>`, and "no
  figure, meter, badge, total or comparison is drawn at region level"
  (`docs/agent/conventions.md:46`). The row goes inside a `Section`/`ListGroup`
  band, beside the agent's, not on the region.
- **The two values are different and must not read as one.** `run.model` is what
  `buildArgs` sends (`src/lib/orchestrator.ts:4843`); `run.agent.model` is what
  the member definition carries, and an explicit `--model` outranks it, measured
  on the pin (`src/lib/agents.ts:99`–`110`). A page that shows the agent's where
  the run's won is the failure this row exists to end.
- The review card keeps rendering the *review's* model
  (`src/components/RunReview.tsx:44`), which is a third value and is recorded
  separately (`src/lib/db.ts:218`) precisely so its cost never folds into
  `runs.spent_usd` (`:206`–`211`).

### 0b. Give `isKnownModel` its first call site

**Touches** `src/app/settings/page.tsx:2229`–`2248`, the "Default model" row.

**The change** is an inline warning under the input when
`isKnownModel(value)` is false (`src/lib/pricing.ts:135`; `grep -rn
"isKnownModel" src/` returns its own definition and nothing else). The wording
has to name both consequences, because they point in opposite directions: the
dashboard will read $0 for those turns (`docs/agent/metering.md:16`) *and* every
dollar-denominated guard will charge $10/$50 (`src/lib/pricing.ts:84`,
`:194`–`:199`), which is twice `claude-opus-5`'s rate and ten times
`claude-haiku-4-5`'s (`:38`, `:56`).

**Invariants.**

- **It stays a warning.** Narrowing to a list this build knows would refuse the
  model that ships next week (`src/lib/agents.ts:116`–`119`), and the price
  table refuses catch-all prefixes on the same principle
  (`docs/agent/metering.md:20`). A refusal here becomes the list this repository
  has twice declined to keep.
- It is client-side only. `PUT /api/settings` trims and maps empty to `null`
  (`src/app/api/settings/route.ts:215`–`218`) and must go on doing exactly that
  and no more — a server-side gate is the refusal by another name.
- `saveSettings` stores only what differs from `DEFAULTS`
  (`src/lib/settings.ts:693`–`706`), which is a correctness decision rather than
  a size one (`docs/agent/conventions.md:14`). This phase adds no settings key,
  so there is nothing to get wrong there — but that is the reason to add none.

### 0c. Fix the agents page's hint

**Touches** `src/app/agents/page.tsx:282`, which reads "What the delegated turn
runs on — an alias or a full id. Blank inherits the run's."

**The change** is one sentence. Under `--agent` the pin is the **session's**
model, not a delegated sub-turn's — `src/lib/agents.ts:88`–`96` records this as
"the one field that did" change meaning with the flag — and an explicit
`--model` outranks it, so it reaches only a run that named none. On an install
with the Settings box filled in, that is no run at all, and the hint should say
so.

**Invariant.** The field itself stays. `src/lib/agents.ts:110`–`113` is the
ground it is admissible on — it "moves cost rather than capability … every cost
guard already covers it" — and nothing here touches that.

## Phase 1 — the field on the run form

**Touches** `src/app/runs/new/page.tsx` only. An `<Input>` beside the agent
picker, sending `model` in the POST body.

**No server change is needed and none should be made.**
`CreateRunInput.model` exists (`src/lib/orchestrator.ts:2559`), `POST
/api/runs` reads it as `model: body.model ? String(body.model) : null`
(`src/app/api/runs/route.ts:233`), and `createRun` resolves `input.model ??
settings.defaultModel` at the INSERT (`src/lib/orchestrator.ts:3205`).

**Invariants.**

- **The blank box must reach the route as falsy.** `createRun`'s resolution is
  `??`, which treats `""` as a value — so a form that sent an empty string would
  write `""` onto `runs.model`, `buildArgs`' `if (opts.model)` would emit no
  `--model` (`src/lib/orchestrator.ts:4843`), and the run would silently take
  the CLI's own default instead of `settings.defaultModel`. What stops that
  today is the route's
  `body.model ? … : null`, which is load-bearing rather than incidental. Trim at
  the input as well, or `" "` becomes a truthy model string that fails the spawn.
- **No `await` is added between `createRun`'s entry and its INSERT.** This phase
  adds none — the value arrives on the request body — and that is the reason a
  field is admissible where a classifier is not
  (`docs/agent/concurrency-and-ownership.md:10`, `src/lib/orchestrator.ts:3190`).
- **The precedence stays four-deep and reachable.** Typed box beats
  `settings.defaultModel` beats `SavedAgent.model` beats the CLI's own default.
  That is the current code's order with the top rung finally connected to a
  control, and it is the only arrangement in the survey where all four are
  reachable.
- **The model is not a guard.** It sits beside the budget and permission-mode
  controls on the same form, and the form is on both of
  `src/lib/settings.ts:480`–`488`'s lists — but it must be sent as a sibling of
  `prompt` and `folder`, not folded into whatever the form builds for
  `RunGuards`.
- The `isKnownModel` warning from Phase 0b belongs under this input too, for
  `src/lib/templates.ts:22`–`31`'s stated reason: narrowing at save is what puts
  the mistake where it was made rather than at the first attempt to use it.

## Phase 2 — the two sentences that become false

**Touches** `src/app/runs/new/page.tsx:2209` and
`src/app/settings/page.tsx:2232`.

The template picker's description currently tells the operator a template keeps
"the task, the limits and how it behaves. Not the model — that stays a single
global setting". After Phase 1 the second half is false. It should say what is
true and remains a useful thing to know: a template still carries no model, and
the box above is where a run disagrees with the setting.

The Settings label "Default model" becomes accurate for the first time. A
default that a per-run box may override is exactly what the word says; today it
is a setting mislabelled as a default.

**Invariant.** A label over a control the app routinely ignores has stopped
describing its control (`01-constraints.md`). This phase exists so that no
sentence in the UI describes a mechanism that changed underneath it — which is
precisely the defect 0c repairs and which took a flag change to create.

## Phase 3 — the boundary, written down rather than built

Three of the five origins start a run with nobody at the keyboard —
`chat`, `workflow`, `orchestrator-block` and `schedule` are four of the five
values and three of them are unattended, which is "the whole reason this is a
column" (`src/lib/orchestrator.ts:263`–`284`). **This answers for `form` and for
nothing else.** A chat proposal holds no model by design
(`src/lib/db.ts:616`–`619`), a workflow node holds none (`:367`–`370`), an
orchestrator block's run spec holds none (`src/lib/workflows.ts:1345`–`1351`),
and after this change all four still hold none.

A run already started stays un-overridable. `startRun` freezes the row before
the loop opens (`src/lib/orchestrator.ts:6278`, loop at `:6412`) and `reopenRun`
carries the model forward by not touching it (`:8080`; `grep -rn "SET model"
src/` returns nothing). `01-constraints.md`'s fourth obligation asks for more
than that and this deliberately does not deliver it: a route to the model on a
*running* run is a second route to a value a person set, which is the objection
`reopenRun` already refuses on its own account
(`docs/agent/agents-and-templates.md:18`).

Both boundaries belong in `docs/runs.md` when this is implemented, in one
paragraph, with the sentence that makes them legible: **the box decides one run,
the setting decides every run nobody typed a box for.**

## What an operator sees, and what they can override

Four levels, top to bottom, and after Phase 0a the run page names which one
applied:

| Level | Where it is set | Scope | Beats |
|---|---|---|---|
| The run form's box | `src/app/runs/new/page.tsx` (new) | one run | everything below |
| `settings.defaultModel` | Settings → Runs (`src/app/settings/page.tsx:2229`) | every run that named none | the agent's pin |
| `SavedAgent.model` | Agents page (`src/app/agents/page.tsx:279`–`292`) | runs started as that agent | the CLI's default |
| Claude Code's own default | nowhere in this app | everything else | — |

The third rung is reachable only where the two above it are blank, and that is
the measured behaviour rather than a design choice (`src/lib/agents.ts:99`–`110`).
Saying so on the Settings page is part of Phase 2.

What an operator still cannot do afterwards, and should be told: change the
model of a run that has already started, set one on a template, set one on a
workflow node, or set one for a delegated turn.

## What tests it earns

**By `docs/agent/testing.md`'s bar, Phase 1 earns none — and the reason has to
be argued, because the nearest precedent in the tree points the other way.**

The precedent is `src/app/runs/new/budgetPayload.test.ts`, which is a test of
what this exact form sends, on this exact question. It exists because "every
limit here has an off state, `null` is what expresses it, and a number left in a
box the operator switched off is a valid `BudgetPolicy` — so sending it starts
an unattended agent under a cap nobody set, with nothing on the page, in the
types or in the log saying so" (`:9`–`:13`). `docs/agent/testing.md` names
`budgetFromForm` as one of the ten whose grounds are not obvious from the name,
and that is the sentence.

The model box's off state fails **neither** of those two ways, and both halves
of that matter:

- **Its off state is narrowed on the server, not only in the form.**
  `model: body.model ? String(body.model) : null`
  (`src/app/api/runs/route.ts:233`) turns `""` into `null` whatever the page
  sent. A budget field has no equivalent — the wire takes the number the form
  built — which is why the narrowing had to be pinned in a pure function there
  and does not here.
- **Its remaining failure is loud.** A stale `"  "` reaching `runs.model` is a
  model string the CLI refuses: non-zero exit, before any API call, on the run's
  own page. A stale `5` reaching `maxRunCostUSD` is a valid policy that stops a
  run at a limit nobody set, and nothing says so.

So: no new test, and the argument for it is that the two properties which earned
the neighbouring file its test are both absent here. If Phase 1 is ever built
with the narrowing moved *out* of the route and into a form-side helper — which
would be a reasonable-looking refactor — then both properties come back and the
test is owed at that moment.

Phase 0a is a rendering, and eight renderings in this tree do have tests. They
clear the bar on a specific argument: `Meter`, `Table`, `Disclosure`,
`LimitField`, `ListView` and the rest each pin something that "fails silently at
a breakpoint or to a screen reader" (`docs/agent/testing.md`). A `ListRow`
showing a string does not; a `Table` with `stack` and no `label` would. So: no
test here either, and the reason is written down rather than assumed.

**One thing this proposal found that would earn a test, and does not propose to
write.** There is no `pricing.test.ts` in the tree, and the only reference to
`resolvePrice`, `guardCostOf` or `isKnownModel` in any test file is a comment
(`src/lib/windows.test.ts:482`). Those three are pure functions whose failure
modes are silent and expensive by exactly the stated criterion, and two of them
have branches nobody exercises: `resolvePrice` is date-aware — Sonnet 5's
introductory rate ends 2026-09-01 (`src/lib/pricing.ts:68`–`69`) — and
speed-aware, with a separate fast-mode table at 2× for two Opus entries
(`:62`–`:66`). A wrong answer there moves every window, every dashboard figure
and every dollar-denominated guard at once. It is out of scope here because it
is not routing, and it stops being optional the moment any option that **ranks
models by price** is built: Option F's ladder is exactly that, and
`07-option-budget-aware-router.md` already records that a ranking computed once
is wrong on a date boundary and wrong under fast mode.

## Cost

Phase 0: an afternoon for 0a, an hour each for 0b and 0c. Phase 1: half a day.
Phase 2: an hour. No schema change, no migration, no new module, no new settings
key, no new `claude` child, and nothing added to `docs/agent/`'s invariant list
because no invariant changes — two sentences in `docs/runs.md` and a line in
`docs/verification.md`'s "Not yet verified by hand" list for the one thing this
cannot verify from a work cycle, which is that the run page renders what the run
actually ran on.
