# Option C — a model on the template

`run_templates` gains a model column; a run started from a template takes it,
and a blank one falls through to `settings.defaultModel`. This is a proposal to
overturn a decision that is written down in the file it would change, so the
cost of overturning it is part of the option rather than an objection to it.

## The strongest case, first

**It is the only option that reaches every creation path at once without adding
anything a model may write.** A workflow node, a chat proposal and an
orchestrator block's run spec each deliberately hold no guards, no permission
mode and no model, and each takes them from *the template it names*
(`src/lib/db.ts:367`–`370`, `:616`–`619`, `src/lib/workflows.ts:1345`–`1351`).
A model on the template arrives through that same door, decided by the same
person, at the same moment they decided the permission mode and the budget.
`planNode`, `planProposal` and `planInstanceStep` each already resolve a
template into a `CreateRunInput`; none of them needs a new field.

**And it is the only option that puts the model beside the budget.** The
interaction `01-constraints.md` warns about — a cheaper model does not lower a
run limit, it changes how many turns fit under it
(`src/lib/orchestrator.ts:4880`–`4882`) — is only ever set right by somebody
choosing both together. A template is the one record in this app that already
carries `budget`, `maxIterations`, `permissionMode` and `isolate` in one form,
which is precisely where "cheap model, more cycles" and "expensive model, one
cycle" are two coherent settings rather than two unrelated boxes.

**And it makes the model travel with the task.** `00-problem.md`'s measurement
says the spread between runs is the task, not the pin — fourteen times, at one
model. A template is this app's only record of *what kind of ask this is*. A
read-only audit template and an implement-this-issue template are two different
asks; today they are two rows that differ in everything except the one field
that decides what they cost per token.

## Shape

`addColumn(db, "run_templates", "model", "TEXT")` in `migrate()` — an idempotent
statement beside the thirty already there (helper at `src/lib/db.ts:1330`, call
sites from `:697`). `RunTemplate` gains the field
(`src/lib/templates.ts:51` onward), narrowed on save and again on read, which is
that file's own stated three-narrowings rule (`:22`–`:31`). The templates page
gains an input. `createRun` is unchanged: the template's model becomes
`input.model` at the call site that already resolves the template, and lands on
`runs.model` at `:3205` as a frozen copy — so editing the template afterwards
cannot reach a run already created, exactly as the agent copy behaves
(`:6703` and the comment beneath it).

## What it costs to overturn the written decision

The decision is `src/lib/templates.ts:35`–`42`, and it is worth quoting in full
because its argument is not the one this option has to beat:

> **The model.** `settings.defaultModel` already sets it globally and the run
> form does not offer it at all. Two places to set one thing is how they drift,
> and the second place would be the one nobody remembers to check.

That is a **drift** argument, not a capability argument — the other three
refusals (`db.ts:367`, `:616`, `workflows.ts:1345`) are about what a model may
write, and this one is not. So overturning it does not touch the approval gate.
What it costs is four edits, and one of them is the real price:

1. **A precedence rule, written down and rendered.** Template's model wins;
   blank means "take the setting". That is a third state on a free-form text box
   — set, blank-meaning-inherit, and the setting itself possibly blank
   meaning "Claude Code's own default" — and a person has to be able to read
   which one applied to a given run.
2. **`src/app/runs/new/page.tsx:2209` becomes false.** The template picker
   currently tells the operator a template keeps "the task, the limits and how it
   behaves. Not the model — that stays a single global setting."
3. **The Settings label improves.** "Default model"
   (`src/app/settings/page.tsx:2232`) becomes accurate for the first time: a
   default that a template may override is exactly what the word says.
4. **`src/lib/templates.ts:33`–`42` has to be rewritten as the argument for.**
   This is the price. It is a paragraph a future editor will read as *the*
   reason, and it currently says the opposite; leaving it would make the file
   contradict its own schema. A comment that argues against the code beside it
   is the failure this repository's whole `docs/agent/` convention exists to
   prevent.

One consequence should be stated rather than discovered: a chat proposal names a
template (`src/lib/chat.ts:920`–`926`), so after this change **a model choosing
a template is choosing a model**. That is not new in kind — the same choice
already carries a permission mode, a budget and an isolation setting, and
`db.ts:616`–`619`'s rule is that those are fine *because a person wrote the
template*. The same sentence covers this. It is the strongest defence available
and it should be made explicitly rather than left implicit, because the first
reader who notices will otherwise file it as a violation.

## Which half of the split

It forces the answer, and the answer is the "what an agent may do" half — not
because a model is capability, but because a template holds only that half. The
model would sit beside `permissionMode`, `isolate` and `budget` on a record
whose entire purpose is to be the person-written source for them. That is a
coherent position and it is the one this option takes; it just has to be taken
out loud, since `01-constraints.md` records that "it is a third kind of thing"
was also available and is now spent.

## When the decision is taken

At `createRun`, synchronously, from a template the caller has already resolved
before the call — no `await` is added on the path from entry to INSERT
(`docs/agent/concurrency-and-ownership.md:10`,
`src/lib/orchestrator.ts:3190`). Frozen for the run thereafter, like everything
else on the row.

## The measured precedence

This option **outranks the agent**, and cannot honestly claim otherwise: a
template model writes `runs.model`, `buildArgs` emits `--model` whenever that is
truthy (`:4843`), and an explicit `--model` beats a selected agent's pin —
measured on the pin (`src/lib/agents.ts:99`–`110`). A run from a template with a
model set can never take its agent's.

So it owes the agents-page edit `01-constraints.md` names
(`src/app/agents/page.tsx:279`–`292`), and it owes it more than the other
options do, because `templates.ts:38`–`42` currently cites that very precedence
as the reason `agentId` on a template is *not* a second route to the model. Add
a model column and that sentence stops being true of the record it is written
on.

## What the operator sees and controls

An input on the template form, beside the guards they already set there. The
run form stays modelless unless Option I is taken with it, so a person starting
an ad-hoc run still cannot disagree with the setting. The run detail page still
shows nothing (`src/lib/apiTypes.ts:559` renders on no page), and the read-back
obligation is larger here than under Option A: with two places to set one thing,
"which one applied" becomes a question a person will actually ask.

## Guards, and the three cost sources

No new reader, no new source, no change to the check order
(`docs/agent/budgets-and-guards.md:32`). The one substantive interaction is the
good one described above: the model and the cycle cap become settable together,
so a template that pairs a cheaper model with a higher `maxIterations` is
expressible by one person in one form — where every option that sets a model
apart from the budget leaves the terminus to be adjusted, or not, somewhere
else.

## When the pricing table cannot place the model

Free-form, for the same stated reason as the settings box
(`src/lib/agents.ts:116`–`119`) — and now stored on a record that is
instantiated **repeatedly and unattended**. A schedule firing a template whose
model the table cannot place repeats the early-guard failure every night:
$10/$50 into `spentGuardUSD` (`src/lib/pricing.ts:84`,
`src/lib/orchestrator.ts:4880`–`4882`), $0 on the dashboard
(`docs/agent/metering.md:16`), and nobody at the keyboard either time.

`isKnownModel` (`src/lib/pricing.ts:135`) as a warning at save is the right
mitigation and is worth more here than anywhere else, because a template save is
the moment a person is present and the run is not. It stays a warning: narrowing
to a list this build knows is the thing this repository has refused twice
(`src/lib/agents.ts:116`–`119`, `docs/agent/metering.md:20`).

## How it fails, and whether loudly

**Silent, and it is the failure the file predicted:** two human-editable places
for one value, and the template is the one a person edits once and then forgets
is there. Six months on, an operator who changes "Default model" and sees no
effect has no page that would tell them why.

**Silent, second order:** a template edited after a run was created does not
change that run. Correct, deliberate, and indistinguishable from the edit not
having been saved.

**Loud:** a string the CLI refuses fails the spawn — but under a schedule that
is loud to nobody until somebody reads the run list.

## What it costs to build

A column, two narrowings, a form field, three plan call sites that need no
change but do need reading, and copy edits across two pages and one module
comment. Two to three days, and most of it is the argument rather than the code:
the diff is small and the paragraph in `templates.ts` is the deliverable.

## What would have to be true for this to be the right answer

That the task is the axis — which `00-problem.md` measures — **and** that the
task is written down on a template often enough for a template to be where the
decision lands.

Nothing measures the second, and it cannot be measured from the tree: there is
no `templateId` on the run wire or on the row. `grep -rn "templateId"
src/lib/orchestrator.ts` returns nothing, and `src/lib/templates.ts:43`–`46`
records the reason — a `templateId` on the run wire "exists for nothing else"
and was refused for a smaller purpose than this one.

**The experiment to name:** what fraction of runs on a real install come from a
template, and does template identity separate the cheap runs from the dear ones?
Today that is unanswerable from the database, because the link is not recorded.
Answering it means adding the column that was refused — which is itself part of
this option's cost, and should be counted against it rather than assumed away.
