# Option C — a provider chosen at spawn time

Give a run a `provider` the way it already has a `model`: a column on `runs`, a
field on the run form, a value threaded to the spawn site. The allowance wall
stops being the trigger. A run is a Claude run or a Codex run from the moment it
is created, and it stays one.

Fallback is then a *policy* built on top: "if this run's provider walls, and a
second provider is configured, create a continuation run under the other one".

---

## The strongest case

**It separates two questions the brief runs together, and separating them makes
both easier.**

Question one: *can this app drive a second agent CLI at all?* That is the
handover contract, and it is the same work whether the trigger is a wall or an
operator's choice.

Question two: *should a wall cause a switch?* That is a policy question, and it
is much easier to answer once question one has an implementation you can point
at and measure.

Option B answers both at once and can only be tested at a wall — which is to say,
against a condition you cannot summon, on a code path that runs unattended, in a
folder holding real work. Option C's first cycle is an operator pressing Run
with `provider: codex` selected, watching a page.

There is also a direct precedent in this repository. `proposals/README.md:20`
records the ModelRouter survey's recommendation as **against building a router**
and in favour of shipping "the per-run field and the read-back that already have
wire support". Option C is that argument with `provider` in place of `model` —
and it inherits the same caution: a field is not a router, and the router is the
part that lost.

*Cited from the index rather than from the survey, because the survey is gone:
`ls proposals/` shows no `ModelRouter` directory, so `proposals/README.md`'s row
for it is the only surviving statement of its finding. See `14-validation.md` §5.*

## Its shape

```
migrate()      addColumn(db, "runs", "provider", "TEXT")     db.ts:845's neighbour
runs           provider: "claude" | "codex" | null           null = claude, for every existing row
run form       a select beside the model box
startRun       provider decides which adapter builds argv and parses stdout
run page       a label, sourced from the column
```

The adapter boundary is the real design: `runIteration`
(`orchestrator.ts:5600`) currently hard-codes `CLAUDE_BIN` at `:5621` and
`handleStreamLine` at `:6595`. Option C's shape is a pair —
`{ bin, buildArgs, parseLine }` — selected once per cycle. That is a genuine
refactor of the run loop's hottest path, and `CLAUDE.md`'s rule about long-lived
module state on `globalThis` applies to anything cached across it.

**Nothing about it is cheaper than Option B's adapter.** The whole contract in
`02-the-handover-contract.md` is still owed, item for item. What is different is
*when* it runs and *who* is watching.

## Continuity

**Best in the set, and by construction: there is none to lose.** A Codex run
resumes Codex sessions with `codex exec resume <thread_id>` (U3); a Claude run
resumes Claude sessions. No cycle ever crosses a provider, so `--resume` never
has to do something impossible.

`runs.session_id` holds whichever id the run's own provider issued. That is one
column doing two jobs, which is acceptable exactly because the two never coexist
on one row — and it becomes unacceptable the moment fallback-as-continuation is
built, which is why that is a separate phase with a separate column.

The fallback *policy* built on top produces a **new run** rather than a
provider-switch inside one, and a new run is a shape the app already has:
`runs.continues_run` exists, `reopenPrompt`/`reopenFleet` exist
(`docs/agent/run-lifecycle.md`), and `startsFresh` already reasons about a cycle
that begins with no conversation. The continuation starts from the branch and a
written brief — `08-continuity.md` §"What a fresh cycle can start from" — which
is a thing an operator can read before it runs.

## Guards and metering

**The same problem as Option B, met earlier and more honestly.**

A run with `provider: codex` has, from creation:

- `maxWeeklyFraction` / `maxSessionFraction` that constrain nothing (C2);
- `maxRunCostUSD` with no in-cycle enforcement (U4);
- `maxIterations` and `maxDurationMinutes` doing all the work.

The difference from Option B is that this is **knowable at admission**. `POST
/api/runs` already refuses a policy with no monotone terminus — `no_terminus`,
`src/lib/budget.ts:92`–`:95` — and it is the natural place to refuse a Codex run
whose only limits are window fractions. That refusal can carry a sentence.
Option B's equivalent failure happens six hours into an unattended run.

Metering: a Codex run's spend is unknown or pessimistically derived (C1), and
because the provider is a property of the *run*, the run page can say so once,
at the top, instead of per cycle. `guardCostOf`'s existing substitution
(`pricing.ts:194`) applies cleanly.

## Permission and sandbox parity

Same gaps as Option B — `10-permission-and-credentials.md` — with one
improvement that matters: **the operator chose this.** A run created with
`provider: codex` is a run whose operator can be shown, on the form, what is
different: no `--disallowedTools`, no self-hosting notice, a different sandbox,
a different credential. Option B applies those differences to a run whose
operator asked for a Claude run.

That is not a technical fix. It is the difference between a disclosed
limitation and an undisclosed one, and `docs/agent/git-and-review.md`'s rule
that no row may carry a mark it did not earn is the same instinct.

## Review and landing

**Cleanest in the set.** Provider is a property of the run, so:

- the run page labels it once;
- the `needs-review` card labels it once;
- a diff is attributable without per-cycle bookkeeping;
- the merge queue does not change at all (C6).

## Blast radius

**Per run**, chosen deliberately at creation. The fleet is unaffected unless the
operator makes it so. The orchestrator chat is **explicitly out of scope** —
`chat.ts:2104` keeps its own spawn and its own guards
(`docs/agent/chat.md`), and a chat that could silently change provider mid-thread
is a second capability wearing this one's clothes.

## How it fails, and whether loudly

Better than Option B on the two failures that matter most:

| failure | loud? |
|---|---|
| the operator does not realise what a Codex run gives up | **loud, if the form says so** — this is the only option where there is a form to say it on |
| `maxRunCostUSD` unenforceable | **loud at admission**, beside `no_terminus` |
| Codex quota exhausted mid-run | **still misattributed** — C3 and C4 are unpaid until the classifier and the four sentences are fixed |
| JSONL drift | **still silent** — `orchestrator.ts:6604` |
| commit identity notice absent | **still silent** |

Three of five, against Option B's one of six.

## What it costs to build

| phase | | |
|---|---|---|
| 1 | the adapter pair, the column, the form field, the label | 8–12 d |
| 2 | second refusal classifier, cost story, admission refusal | 3–4 d |
| 3 | fallback-as-continuation policy (a *new run*, not a switch) | 3–4 d |
| | **total to a usable fallback** | **14–20 d** |

Higher than Option B's headline because it builds the general mechanism, and the
general mechanism is what makes phases 2 and 3 testable. Phase 1 alone is
shippable and is the only phase whose value does not depend on any unknown being
resolved favourably — it is worth exactly as much as "an operator wants to run
Codex on this repository" is worth, and this survey has no evidence that anybody
does.

## What would have to be true

1. **Somebody wants a Codex run for its own sake**, not merely as a wall
   response. Without that, phase 1 is 8–12 days of infrastructure for a policy
   that is 3 days of the total.
2. The same U1/U4/U5/U6 answers Option B needs, for phases 2–3.
3. An operator willing to hold an OpenAI credential.

Item 1 is the discriminating one, and it is a question for the operator rather
than a measurement. **This survey found no evidence for it in the repository:**
nothing under `src/`, `docs/` or `README.md` mentions OpenAI or Codex, and no
proposal in `proposals/` raises multi-provider operation as a want.
