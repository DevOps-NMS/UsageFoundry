# Who picks the model

**Closed 2026-08-20 with a recommendation against the thing it surveyed.** Ten
options for choosing a model per run, per task, per phase or per delegated turn,
weighed against a measurement that does not support any of them — and one
control that the measurement does support, which nobody has built because the
question was framed as routing.

## The recommendation

**Build no router. Ship Option I — the model field on the new-run form and the
row on the run page that reads it back — plus three repairs that are owed
whichever way the routing question goes.**
[13-recommendation.md](13-recommendation.md).

The field is on the wire already. `CreateRunInput.model` exists
(`src/lib/orchestrator.ts:2559`), `POST /api/runs` reads it
(`src/app/api/runs/route.ts:233`), `createRun` prefers it over the setting
(`src/lib/orchestrator.ts:3205`), `buildArgs` emits it (`:4843`), and no page
this app ships sends it. What is missing is an `<Input>` and a `<ListRow>`.

**What would overturn it:** re-run two of the four read-only audits of
2026-08-19 on `claude-sonnet-5` and compare work cycles, actual cost, ending
status and the issues filed. If both come in at or under the original cycle
count for at or under 0.400× the cost with the same output, the
fixed-token-count counterfactual holds for read-only work and the answer becomes
a model that travels with the kind of task.

**Runner-up:** Option D, the saved agent's model leaned on harder. It wins if a
query nobody here can run — what share of runs carry `runs.agent` — comes back
high.

## The measurement, and why it says no

From this install's own transcripts, through the app's own `scanUsage()` and
`pricing.ts`, over the rolling seven days to 2026-08-20:

| | |
|---|---|
| Share of the week's $4,080 on one model | **99.3%**, `claude-opus-5`, because one text box picked it |
| Share of the bill that is carried context, not generated answers | **83%** — 62.1% cache reads, 20.9% one-hour cache writes |
| Spread between runs of fifty turns or more | **fourteen times** ($4.75 to $66.66), every one at the same model |
| Prize on the documentation wave that opened this proposal | $44.88, **1.1% of the window**, and 0.7% after 2026-09-01 |
| Prize on delegated turns, as first measured | $275.65, 6.8% of the window |
| …of which this app could actually reach | **$101.57, 2.5%** — the rest is host sessions in directories the container cannot see |
| Options scoring above +1 on "measured prize" | **none of the ten** |

Every cheaper-model figure above is a counterfactual on a fixed token count. It
says what this week's traffic would have cost at another model's rates, not that
a cheaper model would have emitted the same tokens. Nothing here measures that,
and experiment 7 in [15-validation.md](15-validation.md) is the ~$10 that would.

## What one control does today

| | |
|---|---|
| Where the model is set | one free-form text box, Settings → Runs (`src/app/settings/page.tsx:2229`) |
| What sets a run's model | `input.model ?? settings.defaultModel`, once, at the INSERT (`src/lib/orchestrator.ts:3205`) |
| What changes it afterwards | nothing — `grep -rn "SET model" src/` returns no output |
| What reads it | a work cycle (`src/lib/orchestrator.ts:4843`), a review and a conflict resolution (`src/lib/review.ts:624`); the chat reads the setting directly (`src/lib/chat.ts:1699`) |
| Where an operator sees what a run ran on | **nowhere** — `RunDTO.model` is on the wire (`src/lib/apiTypes.ts:559`) and rendered on no page |
| What warns about an unpriced model | **nothing** — `isKnownModel` exists (`src/lib/pricing.ts:135`) and has no call site |
| Whether a saved agent's model can reach a run | not while that box has text in it: an explicit `--model` outranks the pin (`src/lib/agents.ts:99`–`110`) |

The last three are live defects independent of routing, and they are Phase 0 of
[14-implementation-sketch.md](14-implementation-sketch.md).

## Index

| File | What it is for |
|---|---|
| [00-problem.md](00-problem.md) | What one setting decides, measured from this install's transcripts |
| [01-constraints.md](01-constraints.md) | What any routing option has to survive, and the criteria that fall out |
| [02-option-do-nothing.md](02-option-do-nothing.md) | A: the one global text box, kept |
| [03-option-settings-default.md](03-option-settings-default.md) | B: a default per install, per kind of child |
| [04-option-model-on-the-template.md](04-option-model-on-the-template.md) | C: a model column on `run_templates` |
| [05-option-model-on-the-agent.md](05-option-model-on-the-agent.md) | D: the saved agent's model, leaned on harder — **runner-up** |
| [06-option-rule-based-router.md](06-option-rule-based-router.md) | E: a pure function over what `createRun` already holds |
| [07-option-budget-aware-router.md](07-option-budget-aware-router.md) | F: react to the window — **rejected by name** |
| [08-option-model-decided-router.md](08-option-model-decided-router.md) | G: a cheap child classifies the task — **free-form form rejected by name** |
| [09-option-per-phase-routing.md](09-option-per-phase-routing.md) | H: a model per work cycle — **parked on one unmeasured fact** |
| [10-option-run-form-override.md](10-option-run-form-override.md) | I: the person asking picks — **recommended** |
| [11-option-route-the-delegated-turn.md](11-option-route-the-delegated-turn.md) | J: decide what a sub-agent turn runs on |
| [12-comparison.md](12-comparison.md) | Weighted criteria stated before the scores, and the four options that differ only in where a string is stored |
| [13-recommendation.md](13-recommendation.md) | The case, the overturning fact, the runner-up, and what is rejected by name |
| [14-implementation-sketch.md](14-implementation-sketch.md) | Four phases, the invariant each must not break, what an operator sees, and why it earns no test |
| [15-validation.md](15-validation.md) | Verdict table, the re-run measurements, what is unverifiable, and every experiment gathered |

Every option file answers the same nine headings — the strongest case, shape,
which half of the split, when the decision is taken, the measured precedence,
what the operator sees, guards and the three cost sources, the unpriced model,
how it fails and whether loudly, what it costs to build, and what would have to
be true — so `12-comparison.md` is a table over a fixed set rather than over ten
arguments.

**On the numbering.** The four closing files carry on from `11` rather than
taking Sandboxing's `07`–`10`, because this survey ran to ten options and those
numbers are option files. Nothing was renumbered.

## Corrections made to the survey by the closing pass

`15-validation.md` opened every citation in `00-` through `11-` and re-ran every
measurement. Five things were wrong and all five were fixed in place:

- The delegated-turn prize is 59% spend this app never started.
- `spawnAssist` carries no `--max-budget-usd`; there are exactly two call sites
  and neither is it.
- "No caller supplies an agent to `spawnAssist`" is recorded at
  `src/lib/agents.ts:354`–`355`, not at `docs/agent/architecture.md:131`.
- `migrate()` holds fifty-five `addColumn` statements, not thirty.
- Twenty-seven bare `` `:NNNN` `` references resolved against the wrong file.

The recommendation is not made easier by any of them: the first moves the
largest number in the survey *down*, which is why it is the reason this proposal
ends where it does rather than a convenience for it.
