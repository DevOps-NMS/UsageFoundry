# Option E — a rule-based router

Something in the run lifecycle picks the model from facts already on the run. No
new record, no model asked, no reading taken: a pure function from what
`createRun` already has in its hands to a string, or to `null` for "no opinion".

## The strongest case, first

**It is the only option that can be a pure function, and this repository's bar
for a pure function whose failure mode is silent is a unit test** (`CLAUDE.md`;
`docs/agent/testing.md` records what each existing one earned). `normalizePolicy`
and `planLoopPass` are the precedent — both pure, both tested, both deciding
something a process then acts on. A router of this shape is testable without
spending a cent, which is true of no other option here that actually decides
anything.

**And it needs no second place for a person to set a value**, which is the one
objection `src/lib/templates.ts:35`–`42` makes and the one Options C and I have
to answer. Shipped rules are not a place at all; they are behaviour, argued in a
comment beside the code, the way every other decision in this app is.

## Which facts are available where the decision is taken

This is where an option of this shape is most likely to be wrong, so state it as
an inventory rather than a promise. At `createRun` the whole input is
`CreateRunInput` (`src/lib/orchestrator.ts:2554`–`2591`), plus `getSettings()`
(`:3150`), plus anything synchronous over SQLite.

**Available:**

- **`origin`** — five values (`:273`–`:284`): `form`, `chat`, `workflow`,
  `orchestrator-block`, `schedule`. Three of the five start an agent with nobody
  at the keyboard, which is the stated reason the column exists at all, and it
  is the single cleanest discriminator this app owns.
- **The prompt**, in full, as a string.
- **The agent**, as a whole `AgentDefinition` (`:2571`) — name, description,
  prompt, model.
- **The budget policy**, before normalisation: `maxIterations`,
  `maxRunCostUSD`, `maxDurationMinutes`, `enforcement`.
- **`isolate`**, and after `planWorkspace` the resolved isolation mode
  (`:3188`).
- **`continuesRun`**, resolved from the dependency edges by `admitDependencies`
  (`:3165`) — so "this run carries on another's branch" is known before the
  INSERT.
- **`originRef`**, an opaque id: a proposal, an instance, a schedule.

**Not available, and each absence rules out a rule somebody will propose:**

- **The template.** There is no `templateId` on `CreateRunInput` and none on
  `runs` — `grep -rn "templateId" src/lib/orchestrator.ts` returns nothing. The
  template's fields arrive already flattened into the input, so a rule can see
  *a* permission mode and *a* budget but never which template they came from.
  `src/lib/templates.ts:43`–`46` records that a `templateId` on the run wire
  "exists for nothing else", refused for a smaller purpose than this one.
- **The workflow block kind.** A node is one of `run`, `orchestrator`, `merge`,
  `loop` (`src/lib/workflows.ts:398`) and none of that reaches `createRun`. The
  only trace is `origin`, which files a plain node and a loop pass alike as
  `workflow` (`src/lib/workflows.ts:4727`) and separates only a block's own
  emission as `orchestrator-block`. Routing "loop passes cheaper" is therefore
  not expressible without a new field.
- **First pass or continuation, in the cycle sense.** `runs.iterations` is 0 for
  every row at INSERT; the distinction only exists inside the loop, which is
  Option H.
- **Anything requiring an `await`.** A transcript scan, a plan-usage reading, a
  `fs.promises` call: the path from `createRun`'s entry to its INSERT carries no
  `await` and adding one silently puts two agents in one directory
  (`docs/agent/concurrency-and-ownership.md:10`, `src/lib/orchestrator.ts:3190`).
  A synchronous SQLite read is admissible; a scan is not.
- **The task's size.** Nothing on the wire encodes it. At creation, "task shape"
  means a regex over operator prose, and that is the honest description of this
  option's discriminating power rather than a caricature of it.

If the decision moves outside `createRun` instead — computed by each caller and
passed as `input.model` — the `await` restriction lifts, and the option becomes
six call sites rather than one. `grep -rn "createRun({" src/` outside the tests
returns `src/app/api/runs/route.ts:229`, `src/lib/chat.ts:933` and
`src/lib/workflows.ts:3243`, `:4295`, `:4720`, `:5441`. That is worth saying
plainly: outside `createRun` it is not one router, it is six, and the sixth is
the one that will be forgotten.

## Which half of the split

It has to argue "a third kind of thing", and the argument is available but not
free. The rule is written by whoever ships the app, or by an operator in
Settings — so the *decision* is in the person-wrote half. But its **input**
includes prompt text, which is the one half of a run a model may write
(`src/lib/agents.ts:196`–`198`). No spawn parameter in this app is currently
derived from prompt text; a rule that reads the prompt to pick a model would be
the first. That is not a violation of any stated invariant, and it is a new
shape, and the option should say so rather than let a reviewer discover it.

Keeping rules off the prompt entirely — `origin`, agent, budget and isolation
only — avoids the question at the cost of most of the discriminating power.

## When the decision is taken

At creation, synchronously, before the INSERT. That is the only moment where one
router serves every path (see the five-call-sites note above for what the
alternative costs).

Per cycle is available and is a different option: it means changing the frozen
row read at `src/lib/orchestrator.ts:6278`, with `enabledPluginDirs()` at
`:6690` as the precedent for re-resolving inside the loop and `settings` at
`:6379` as the counter-precedent for deliberately not. A rule over creation-time
facts gains nothing from being re-run per cycle, because none of its inputs
changes.

## The measured precedence

A router that writes `runs.model` on every run **outranks the agent**
permanently, on every install, including the ones where the settings box is
blank today (`01-constraints.md`; the measurement is
`src/lib/agents.ts:99`–`110`). This option can avoid that, and it is the only
one that can do so cleanly: a rule that returns `null` for "no opinion" leaves
`runs.model` null, `buildArgs` emits no `--model` (`:4843`), and the agent's pin
wins. Fill-only-the-gap is a one-line property of the return type, and it should
be the default.

## What the operator sees and controls

Two sub-variants, and they are different products.

**Shipped rules.** Nothing to configure, nothing to get wrong, no settings key,
no `saveSettings` obligation. Also no way for an operator to disagree — which
makes the run form's per-run field (Option I) close to mandatory beside it, and
makes the run detail page's read-back mandatory outright, because a decision the
operator did not make is one they can only audit after the fact.

**Operator-authored rules.** A rules table in Settings: a match, a model, an
order. Call it what it is — a small DSL, with a syntax, a validator, an
evaluation order and a way to test a rule without starting a billed run. It must
go through `saveSettings`' only-what-differs loop
(`src/lib/settings.ts:693`–`:706`), or every future default on that install dies
(`docs/agent/conventions.md:14`).

Either way, the rule that fired has to be recorded on the run and said on the
run's own log — the model that was chosen, and *why*. The precedent is right
there in the loop: a plugin directory that stopped being loadable is logged per
cycle on the run's page, because "an agent that stops receiving a plugin behaves
exactly like one that never had it, so nothing else in this app would ever
mention it" (`src/lib/orchestrator.ts:6691`–`6699`). The same sentence is true
of a rule that stopped matching.

## Guards, and the three cost sources

No source is read at all — that is the option's defining property and its main
safety argument. No new reader of transcripts, no second door from OTLP
(`01-constraints.md`), no change to the check order
(`docs/agent/budgets-and-guards.md:32`).

One interaction to state in the constraints file's own words: a rule that pairs
a cheap model with an unchanged `maxIterations` is not making a run cheaper, it
is making the run limit go further in turns (`src/lib/budget.ts:86`–`98`,
`src/lib/orchestrator.ts:4880`–`4882`). If a rule selects a model it should
probably be allowed to say something about the terminus too — at which point it
is writing a guard, which is refused (`01-constraints.md`). The clean resolution
is that it may not, and the operator sets both on a template.

## When the pricing table cannot place the model

A rule's output is a string a person wrote — in a settings row, or in this
repository's source. The exposure is the same as a settings box's and repeats on
every run the rule matches. `isKnownModel` (`src/lib/pricing.ts:135`, no call
site today) belongs at the point the rule is *saved*, as a warning, and the set
may not be closed (`src/lib/agents.ts:116`–`119`,
`docs/agent/metering.md:20`).

Shipped rules are the sharper case: a model id compiled into this repository
ages, and the day the table stops placing it every matching run gets $10/$50 in
`spentGuardUSD` (`src/lib/pricing.ts:84`) and $0 on the dashboard. A rule that
names a model must therefore be data an operator can edit, or the app has
hard-coded a value that guards act on.

## How it fails, and whether loudly

**The characteristic failure is silence, and it is structural: a rule that
matches nothing is indistinguishable from a router that is switched off.** Every
run still starts, still costs what it costs, still reports normally. Nothing
throws, nothing is logged, and the page looks right — which is exactly the class
of defect `CLAUDE.md` says nearly every invariant here exists to prevent.

The mitigations are cheap and both are obligations rather than nice-to-haves:
record the deciding rule on the run, and log the choice on the run's own log at
creation. Without them this option cannot be verified in production at all.

**Loud:** a rule that produces a string the CLI refuses fails the spawn.

## What it costs to build

Small for shipped rules: one pure module, one call site, a unit test that meets
the stated bar, a log line and a recorded field. Two to three days.

Large for operator-authored rules: a settings shape, a form with ordering, a
validator, the `saveSettings` handling, a preview that shows which rule a given
run *would* match, and documentation. A week or more, and most of it is the
editor rather than the router.

## What would have to be true for this to be the right answer

That the facts available at creation actually separate the cheap work from the
dear. Nothing in `00-problem.md` measures that, and its one strong separator is
**not** on the list above: the split that produced the striking numbers is by
sub-agent bucket, which is a per-turn fact this app never sees.

`origin` is the plausible candidate — a schedule firing unattended and a person
pressing Start are different asks — and it is untested.

**The experiment to name:** group the window's spend by `runs.origin` and by
whether the run carried an agent. `runs` holds both; transcripts hold neither,
and the database is unreadable from a work cycle (`00-problem.md`), so this is a
reading an operator takes on a live install. Until somebody takes it, a
rule-based router is a mechanism with no measured discriminator to put in it.
