# Recommendation

**Build no router. Ship Option I — the model field on the new-run form and the
row on the run page that reads it back — and the three repairs that are owed
whichever way the routing question goes.** `10-option-run-form-override.md`.

That is a recommendation *against* the thing this proposal was opened to
consider, and it is reached from the measurement rather than from caution. The
one control this install has is the wrong shape, and the fix for a wrong shape
is a control in the right place, not a mechanism that decides for the operator.

## The case, from the measurement rather than from preference

`00-problem.md` set out to find whether a router would pay for itself and
measured four things that say it would not.

**83% of the bill is context being carried, not answers being generated.**
62.1% cache reads and 20.9% one-hour cache writes, against 12.0% output. Cache
classes are multiples of the model's own *input* rate
(`src/lib/pricing.ts:16`–`18`), so a model swap is a flat multiplier on the
whole bill rather than a lever on the expensive part — there is no expensive
part to aim at.

**The spread between runs is the task, and it is fourteen times at one model.**
181 sessions of fifty turns or more in `.uf-worktrees` directories, $4.75 to
$66.66, every one of them `claude-opus-5`. Nothing a router selects addresses a
spread the pin did not create.

**Every cheaper-model figure in the survey is a fixed-token-count
counterfactual.** They say what this week's traffic would have cost at another
model's rates. They do not say a cheaper model would have emitted the same
tokens, and the honest prior is that it would emit more. Nothing in this install
measures it, and a router sold on "spend less" is being sold on that assumption.

**And the largest single prize is mostly not this app's to take.** The $488.24
of delegated turns that made Option J the biggest number in the survey is 59%
`workflow-subagent` turns in two host directories — the operator's own Claude
Code sessions, which this container cannot even see the path of. The reachable
part is $198.08, the reachable difference $101.57, **2.5% of the weekly
window**, and every dollar of it sits in the `Explore` and `general-purpose`
buckets that `normalizeAgentInput` refuses by name
(`src/lib/agents.ts:179`–`185`). The place where routing demonstrably works on
this machine is the one place this app may not name.

Against all of that, the same file measured a complaint that survives: **one
global text box is the wrong shape for a decision that differs between a
read-only audit, a delegated turn and a multi-cycle implementation run.** Four
of the eight documentation runs of 2026-08-19 were forbidden from writing a file
at all and cost $12.15, $9.21, $7.52 and $6.29 on the same string as the run
that added an orchestrator block. That is a shape complaint, and Option I is the
whole of the fix for it.

## Why Option I and not one of the other nine

It is the only option in `12-comparison.md` that scores positive on unpriced
models, on loudness and on predict-and-audit at once, and all three come from
one property: a person is standing there when the string is typed. A refused
model fails the spawn in front of them seconds later; an accepted-but-unpriced
one is warned about at the input and then shown on the run's page. Nothing else
in the survey can say that.

It restores the measured precedence instead of ending it. `01-constraints.md`'s
first branch — fill only the gap — is this one: a blank box means the run names
no model, `settings.defaultModel` applies, and if the operator blanks that too,
`SavedAgent.model` becomes reachable for the first time on this install
(`src/lib/agents.ts:99`–`110`). Every option that writes a model onto every run
makes the agent's pin permanently dead.

It changes no decision path. `CreateRunInput.model` exists
(`src/lib/orchestrator.ts:2559`), `POST /api/runs` reads it
(`src/app/api/runs/route.ts:233`), `createRun` prefers it over the setting
(`src/lib/orchestrator.ts:3205`), `buildArgs` emits it (`:4843`), and
`src/lib/review.ts:624` reads the column it lands in. Every line of the
mechanism is written and in production. What is missing is an `<Input>` and a
`<ListRow>`.

And it is the precondition every router in this survey owes anyway.
`01-constraints.md` lists a per-run override and a read-back as obligations on
*all* of them, and F, G and H cannot ship without the second. So building it is
not a bet on this recommendation being right: if the fact below overturns the
recommendation, the work is still wanted.

## The fact that would overturn it

**One end-to-end repeat of a 2026-08-19 read-only audit on a cheaper model,
scored on cycles and output as well as on cost.**

The four audits of that evening are the cleanest case in this install's history:
one prompt each, `--permission-mode` irrelevant because they were forbidden to
edit, a bounded deliverable (a GitHub issue per confirmed drift), and a recorded
cost of $12.15, $9.21, $7.52 and $6.29. Re-run two of them — same prompt, same
guards, same repository state, `settings.defaultModel` set to
`claude-sonnet-5` — and record four things:

1. **Work cycles used**, against the original. A cheaper model that needs two
   cycles where one sufficed has spent the terminus, which `maxIterations`
   counts rather than money (`src/lib/budget.ts:97`), and on a default-budget
   run `maxIterations` is 1 (`src/lib/budget.ts:613`–`618`,
   `max_iterations INTEGER NOT NULL DEFAULT 1` at `src/lib/db.ts:156`) — so it
   would not get a second one.
2. **Actual cost**, off `scanUsage()` rather than off arithmetic: the same
   grouping `00-problem.md` used, filtered to the new session ids.
3. **Whether it ended `completed` rather than `needs-review`**, which is the
   agent's own judgement about the task (`src/lib/orchestrator.ts:105`–`118`,
   whose own docblock notes that `completed` is written both for a run that
   replied DONE and for one that used up its cycle cap).
4. **Whether the issues it filed match** the originals — the only quality signal
   available, because nothing in this app measures change quality.

**If two of the two come in at or under the original cycle count, at or under
0.400× the cost, and file the same issues, the fixed-token-count counterfactual
holds for read-only work and this recommendation is wrong.** The answer then is
a model that travels with the *kind of task* — Option C if the kinds are written
down on templates, Option E if `origin` turns out to separate them — and Option
I becomes the per-run override beside it rather than the whole answer.

Two numbers make the test sharper than it looks. Sonnet 5 is 0.400× Opus 5 today
and **0.600× from 2026-09-01**, when its introductory rate ends
(`src/lib/pricing.ts:68`–`69`), so a result that only just clears 0.400× does
not clear the bar it will face in eleven days. And a run that needs one extra
cycle at 0.400× has spent 0.800× — a saving of 20% on 1.1% of the weekly window,
which is inside the noise of the fourteen-fold spread it sits in.

## A second, cheaper fact — this one decides between I and doing nothing

`10-option-run-form-override.md` names it and it needs no code at all: blank
`settings.defaultModel` for a week and set the model by hand between runs, which
today means editing the Settings box each time. **If every run gets the same
string, the field is Option A with an extra control** and the honest answer is to
ship only the read-back and the two copy fixes. If the choices differ — audits
cheap, migrations dear — the field is doing the work the survey was opened to
find.

Run this one first. It costs nothing, it takes a week of ordinary use, and it is
the only experiment here that can *stop* work rather than start it.

## The runner-up, and what it would take to win

**Option D — the saved agent's model, leaned on harder**
(`05-option-model-on-the-agent.md`), at +10 against Option I's +25.

It has the one thing Option I does not: it works when nobody is at the keyboard.
Three of the five origins start a run unattended (`src/lib/orchestrator.ts:263`–
`284`), and a run started as an agent takes that agent's role — and, if the
Settings box is blank or the fallback order is changed at
`src/lib/orchestrator.ts:3205`, that agent's model. It carries the largest
single cell in `12-comparison.md`, +3 on precedence, because it is the only
option that makes a field this app already offers do the thing its own form says
it does.

**What it would take for it to win: a reading of what share of runs carry
`runs.agent`, and whether agent-carrying runs cost differently from the rest.**
Both live in the `runs` table, which is unreadable from a work cycle by design —
`/data` is root-owned 0700 (`docker-compose.yml:35`–`36`) — so this is a query
an operator runs, not one this proposal can run:

    SELECT agent IS NOT NULL AS has_agent, COUNT(*), ROUND(AVG(spent_usd), 2)
    FROM runs GROUP BY 1;

If most runs carry an agent, D routes by role for a one-line change and hands
back a precedence that is dead today, and the recommendation becomes **D with I
beside it** — the agent's pin as the unattended default, the run form as the
place a person disagrees. If most runs carry none, D reaches almost nothing:
`settings.defaultAgentId` is `null` in `DEFAULTS` (`src/lib/settings.ts:612`),
so on a stock install no run has an agent at all, and a run with none on an
install that blanked the Settings box carries no `--model` and runs on whatever
the CLI defaults to, with `runs.model` null and no page showing anything — which
is strictly worse than today for the ad-hoc run.

D also cannot ship without one copy fix that is owed regardless: the agents
page's hint reads "What the delegated turn runs on"
(`src/app/agents/page.tsx:282`), which is the meaning `--agents` alone carried
and which the singular flag removed (`src/lib/agents.ts:88`–`96`).

## Rejected by name

**Option F, the budget-aware router.** Not because it is complicated but
because of what it does on the install that ships. Every ceiling in `DEFAULTS`
is `null` (`src/lib/settings.ts:602`–`605`) and `guardFraction` is null exactly
when `fraction` is (`src/lib/windows.ts:351`–`:365`), so with no ceiling
configured its only possible input is the provider's own percentage — which
needs `planUsageFromApi` on, a live login, a reachable endpoint and a reading
under an hour old (`docs/agent/metering.md:10`). Any of those missing and it has
no input and looks exactly like a router that is working and has decided not to
act. And where it does act it closes a feedback loop over `costGuardUSD`: route
onto a model the price table cannot place and the window fills *faster* in the
number the router reads while the dashboard reads $0 for the same turns. Those
two fields exist to never be collapsed (`docs/agent/metering.md:18`), and this
is the only option in the survey that joins them.

**Option G in its free-form form.** It hands the $10/$50 unknown-model guard
rate (`src/lib/pricing.ts:84`) to a generative process, and it breaks workflow
instantiation's "topological, one synchronous pass, all or nothing" outright
(`CLAUDE.md`, `src/lib/workflows.ts:3243`). Its constrained form — a classifier
choosing among models an operator configured — is not rejected on principle; it
is Option E's rule table with a model as the matcher, and it should be read as
that if it is ever read again.

**Option H until the cache question is answered.** Its arithmetic is unknown
rather than unfavourable, and the experiment that settles it is small, billed
and named in its own file: start a run, let cycle 1 complete, switch the model,
resume, and compare the second cycle's `cacheRead` and `cacheWrite1h` counts
against a control that did not switch. Nobody should build on the assumption
before that is run, and this file does not.

## What this recommendation does not claim

It does not claim a router is a bad idea in general. It claims that **on this
install, on this week's measurement, nothing separates the options on the axis
that would justify one**, and that the honest response to a proposal whose prize
row is a column of zeros and ones is to ship the control and go and measure.

It does not claim Option I saves money. It saves nothing by itself. What it buys
is that the next person who wants to know what a run ran on can find out, and
the next person who wants to try a cheaper model on one task can do it without
editing a global setting between runs — which is the whole of what stands
between this proposal and the experiment that would settle it.
