# Option K — delegate the opening read

One generated sentence telling a run to do its orientation reading in a
delegated turn and bring back the answer rather than the files. Every path and
line number below was opened at `ee93684`, and every figure is either
`00-problem.md`'s or carries the query that produced it.

Two corrections to the framing before the case, and between them they decide
what this option is. **It has the best-measured per-unit arithmetic in the
survey and the weakest total**: it removes bytes inside one run and remembers
nothing across runs, so it does not touch the 73.2% cross-run repeat this survey
is about at all. And **half of it already shipped, hours ago and unmeasured** —
`DELEGATION_NOTICE` (`src/lib/orchestrator.ts:4797`) landed in this repository at
`ee93684`, dated 2026-08-21, after `00-problem.md`'s corpus closed.

## The strongest case

**Its per-unit ratio is the only one in either survey that was measured on the
wire rather than derived, and the one correction made to it ran in its favour.**
`proposals/ContextControl/11-option-delegation-as-isolation.md` priced the two
thread classes off this install's own transcripts: main-thread turns at **$0.163
each** against sidechain turns at **$0.060** — 37% — and the parent's prefix is
byte-identical across a delegation (`sha unchanged` on its `req-003` probe). That
file first put the break-even at "about three mean-sized reads";
`proposals/ContextControl/19-validation.md:50` refuted the arithmetic — it
divided the sub-agent's fixed prefix by the *delegated cost* of a read rather
than by the *saving* — and corrected it to **0.65 reads, not three**, at a
46,582-byte sub-agent prefix costing $0.073 at 1.25× against $0.112 saved per
mean-sized read moved. `proposals/ContextControl/19-validation.md:12`–`:17`
calls that the one finding of the whole closing pass that moved a number in an
option's favour, and the reason Option H is that survey's runner-up rather than a
curiosity.

**This survey re-measured the same ratio from a different source and it holds.**
`otlp_requests` splits every first-party request by `query_source`, and the three
`agent:` buckets — `Explore` at $148.13, `general-purpose` at $133.13,
`agent:custom` at $3.12 — are delegated turns
(`SELECT query_source, COUNT(*), ROUND(SUM(cost_usd),2) FROM otlp_requests GROUP
BY 1;`):

| over 2026-08-10 → 2026-08-21, `otlp_requests` | |
|---|---|
| delegated (`query_source LIKE 'agent:%'`) | **$284.39 of $4,325.95 — 6.57%**, 3,271 requests |
| cost per delegated request | **$0.0869** |
| cost per main-thread (`sdk`) request | **$0.1665**, over 24,092 requests |
| ratio | **52.2%** |

This is OTLP and is neither `runs.spent_usd` nor `scanUsage()`; per
`docs/agent/metering.md` the three are never summed, and nothing in this file
adds them. The unit differs from `11-`'s too — a request, not a transcript turn —
which is why 52.2% and 37% are not the same number and neither is wrong.

**And the fleet already delegates a large share of it in exactly the window this
option aims at.** Splitting delegated spend on each run's first `Edit`/`Write`:

```sql
WITH firstedit AS (
  SELECT run_id, MIN(ts) AS t FROM run_events
  WHERE kind='tool' AND json_extract(payload,'$.name')
        IN ('Edit','Write','MultiEdit','NotebookEdit')
  GROUP BY run_id)
SELECT CASE WHEN f.t IS NULL THEN 'never edited'
            WHEN o.ts < f.t THEN 'before first edit' ELSE 'after first edit' END,
       COUNT(*), ROUND(SUM(o.cost_usd),2)
FROM otlp_requests o LEFT JOIN firstedit f ON f.run_id=o.run_id
WHERE o.query_source LIKE 'agent:%' GROUP BY 1;
```

**$125.16 of the $284.39 — 44.0% — is already spent before the run's first
edit.** So the behaviour this option asks for is behaviour some runs already
have, unaimed, and the option is a sentence pointing it at the phase
`00-problem.md` priced at 20.9% of the UsageFoundry folder's OTLP bill.

**Every mechanical piece is already in the tree, and this is the only option in
the survey whose build is a string edit.** `--forward-subagent-text` is pushed at
`src/lib/orchestrator.ts:4897` from a setting defaulting to `true`
(`src/lib/settings.ts:615`), passed per cycle at
`src/lib/orchestrator.ts:6799` from a `buildArgs` call inside the run loop
(`:6774`). Delegated spend already has its own
accounting — `agentSpend` (`src/lib/windows.ts:528`) with a `delegatedCostUSD`
field (`:522`), served by `src/app/api/runs/[id]/agent-cost/route.ts:58` and
rendered by `src/components/RunAgentCost.tsx`. And the instruction itself is
already on every cycle's system prompt
(`src/lib/orchestrator.ts:4925`–`:4928`).

## Shape

**One string, and it may not be a second flag.** `src/lib/orchestrator.ts:4923`–
`:4924` records the constraint in as many words: "a second
`--append-system-prompt` is a replacement, not an addition, and losing one of the
two would be silent". So there are exactly two doors.

The first is **extending `DELEGATION_NOTICE`** (`:4797`), 664 characters today,
which already tells a run to hand off "anything where you want the conclusion and
not the files it was read out of" and already carries a floor — "below that a
sub-agent's own start-up costs more than the thread saves". Its docblock
(`:4764`–`:4767`) carries the measurement behind it: over 1,011 transcripts, a
tool call inside a sub-agent cost 6.5 cents against 13.9 on a main thread, almost
all of the gap cache re-read. What that text does *not* say is anything about
*when*: it is phrased by shape of task, not by phase of run. Option K's whole
content is a clause naming the opening read — before the first edit, when the run
does not yet know where anything is, ask for the answer and not the files.

The second door is **a generated clause in `nextPrompt`** (`:4299`), beside
`COMPLETION_NOTICE` (`:4466`) and `NEEDS_REVIEW_NOTICE` (`:4506`), gated on cycle
1 where the orientation reading happens — conversation bytes rather than prefix
bytes, in exchange for firing only when relevant.

Either door answers constraint 1 by construction: the text is a source constant,
not a `DEFAULT_*`, so it reaches an install whose operator has pressed Save.
Neither may go further. No version may narrow a sub-agent by capability —
`src/lib/agents.ts:272` refuses a `tools` field by name, and its docblock
(`:190`–`:221`) says such a list is **not** verified to bound anything. And no
version may name `Explore` or `general-purpose`, which `BUILT_IN_AGENTS`
(`src/lib/agents.ts:179`) reserves and `:284` refuses by name — awkward, because
those two buckets carry $281.26 of the $284.39 above.

## What it learns from, and when the decision is taken

**It learns from nothing, and this is the honest heart of the option.** There is
no store, no corpus, no ranking and no horizon. The decision is the model's,
mid-cycle, once per delegation, on evidence entirely inside the current
conversation. Nothing it does survives the run.

So it does not touch **73.2%** — `00-problem.md`'s share of `Read` calls opening
a path an earlier run on the same repository had already opened — nor the 81.4%
figure on this folder, the prequential top-40 of 59.0%, or the `run_reviews`
corpus. **It is an answer to a different question than the one this survey
asks**, and it belongs here only because it is the cheapest thing that reduces
orientation cost at all.

Its second limit is `00-problem.md`'s, and it is the one every option here meets:
**50.6% of repeat reads are of files the same run then edits**. A parent about to
change `src/lib/orchestrator.ts` needs its contents in its own context, and a
sub-agent's summary is not a substitute. Those calls cannot be delegated away any
more than they can be pointed away.

## What it does to the prefix cache

**Nothing to the parent's, during a delegation, ever** — the `sha unchanged`
measurement in `proposals/ContextControl/11-`. There is no cut point and
constraint 4's `T*` does not apply. Nothing here writes a file into the tree, so
the "a repository change is a cache write" clause is not reached either.

**The string's own idle cost scales from a measured neighbour.**
`proposals/ContextControl/05-option-trim-injected-text.md:113`–`:118` prices
`SELF_HOSTING_NOTICE` — 1,096 bytes on `--append-system-prompt`, every cycle — at
about **$4.28 a week** out of a $2,707.57 container bill. `DELEGATION_NOTICE` is
666 bytes (`node -e` over the literal at
`src/lib/orchestrator.ts:4797`), so about **$2.60 a week** on
that scaling, and an added orientation clause of ~300 bytes about **$1.17**.
Which system block the flag lands in is **not established** — `05-:121`–`:124`
says so — but either way it is ahead of the conversation and constant between
cycles, so it is written once per session and read at 0.1× thereafter.

**Constraint 13, the success cost, is where this option gets expensive and no
other file has stated it.** A delegated *turn* is cheap; a *delegation* is not:

| | |
|---|---|
| delegated requests | 3,271 |
| `Agent` tool calls (`run_events`, `kind='tool'`) | **194** (`02-what-already-tries.md:211`) |
| requests per delegation | **16.9** |
| mean cost of one delegation | **$1.47** |
| most expensive single delegated request | $2.23 |

So an instruction that adds one delegation per run to 200 runs proposes about
**$294** of new spending, and every dollar meant to offset it runs through `d` —
the displacement fraction constraint 13's table says **does not exist**. `11-`'s
$0.112 saved per mean-sized read moved is a per-read figure; nothing measures how
many reads a delegation displaces on this install's real tasks, and
`proposals/ContextControl/19-validation.md:250` lists that as an unrun
billed experiment.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: unaffected, and constraint 2 is answered without a re-send rule of
its own.** `buildArgs` is called from inside the cycle loop
(`src/lib/orchestrator.ts:6774`) and rebuilds
the whole argv, so `--append-system-prompt` and `--forward-subagent-text` are
re-sent on every cycle including a resumed one. Sub-agent conversations are not
resumable and are not meant to be; what `--resume` continues is the parent's
session, which holds the replies rather than the sub-agents' histories.

**DONE and `needs-review`: untouched, and structurally so — but this option
leans harder on the one property that makes that true.** `cycleEnding`
(`src/lib/orchestrator.ts:4543`) matches over the cycle's own final text, and
`src/lib/orchestrator.ts:5946`–`:5960` keeps a forwarded delegated turn out of
`finalText`, out of `apiError` and in its own event kind, naming the failure
precisely: "a sub-agent reporting `DONE` would end a run whose main thread had
not finished". An option whose whole content is "delegate more" is an option
whose safety is that comment continuing to hold across a CLI upgrade, and it
owes the sentence rather than inheriting it.

**Retention: no fourth store, and constraint 8 is answered vacuously.**
`listTranscriptFiles` walks the projects directory recursively
(`src/lib/transcripts.ts:166`), so sub-agent transcripts are already inside every
scan, and they are swept with the session by the transcript sweep
(`src/lib/retention.ts:638`–`:641`) at `transcriptRetentionDays`, default 30
(`src/lib/settings.ts:633`). Nothing is added to `StorageReport`.

## Guards, the three cost sources, and who may author it

**This is the section that decides the option, and the finding is that the hole
is real, is in the guard today, and is one measurement smaller than
`proposals/ContextControl/11-` left it.** That file's closing verdict was that
whether a cycle's `--max-budget-usd` (`src/lib/orchestrator.ts:4953`–`:4955`)
bounds its delegated turns is *not established*, and
`proposals/ContextControl/19-validation.md:249` makes it experiment 2 — "Yes →
Option H's largest risk is gone and it should ship beside A. No → H stays a
runner-up with an unbounded exposure." Three of the four guard paths can be
settled from this database without a billed child. The fourth cannot.

**Settled, first: the between-cycles `run_cost` guard already counts delegated
spend.** `spentUSD += res.costUSD` at `src/lib/orchestrator.ts:6930` accumulates
what the CLI itself reported per cycle, and `src/lib/budget.ts:524` compares it.
Comparing that column against the OTLP split per run — a comparison, not a sum,
and the two sources stay apart:

```sql
WITH o AS (SELECT run_id, SUM(cost_usd) AS all_otlp,
             SUM(CASE WHEN query_source='sdk' THEN cost_usd ELSE 0 END) AS sdk
           FROM otlp_requests WHERE run_id IS NOT NULL GROUP BY run_id)
SELECT COUNT(*),
       SUM(ABS(r.spent_usd/o.all_otlp - 1.0) < 0.005),
       SUM(ABS(r.spent_usd/NULLIF(o.sdk,0) - 1.0) < 0.005)
FROM runs r JOIN o ON o.run_id=r.id
WHERE r.spent_usd_est=0 AND o.all_otlp>0
  AND EXISTS (SELECT 1 FROM otlp_requests q
              WHERE q.run_id=r.id AND q.query_source LIKE 'agent:%');
```

**Of 25 delegating runs with no reconciled estimate, 20 match the OTLP total
*including* delegated requests to within 0.5%, and none matches the `sdk`-only
total.** On the run with the widest split — $51.30 delegated against $2.03
main-thread — both figures are $64.67 to the cent. The CLI's own per-cycle
`result` figure therefore includes what its sub-agents spent, which is a fact
about the pin nothing in this repository had written down.

**Settled, second: the live in-cycle guard would count them too, and has never
once run on this install.** `telemetrySpendSince` (`src/lib/otlp.ts:382`) sums
`cost_usd` over `otlp_requests WHERE run_id = ? AND ts >= ?` with **no
`query_source` filter** (`:388`–`:392`), and it feeds `spentGuardUSD` at
`src/lib/orchestrator.ts:6868`. It is only wired in when
`needsLiveSpendTelemetry` (`:5321`) is true, which needs a non-`between-cycles`
enforcement mode *and* a run-cost or token ceiling:

```sql
SELECT COUNT(*) FROM runs WHERE COALESCE(json_extract(budget,'$.enforcement'),
  'between-cycles') <> 'between-cycles' AND (json_extract(budget,'$.maxRunCostUSD')
  IS NOT NULL OR json_extract(budget,'$.maxRunTokens') IS NOT NULL);   -- 0
```

**Zero of 294 runs.** All 77 `live`/`live-resume` runs carry no cost ceiling; of
the 134 runs that do, 131 record `between-cycles` and three record no
`enforcement` key at all, which `src/lib/budget.ts:624`–`:628` normalises to
`between-cycles`.

**Settled, third: the window guards include sidechains by default.**
`buildCurrentSnapshot` filters on `settings.includeSidechains`
(`src/lib/orchestrator.ts:6297`–`:6299`), default `true`
(`src/lib/settings.ts:614`), so delegated turns are inside the weekly and 5-hour
readings unless an operator switched them out.

**Not settled, and this is the hole: on the 134 runs with a ceiling, the only
in-cycle bound is `--max-budget-usd`, and nothing here shows it has ever
fired.** `docs/verification.md:1264`, inside the "Not yet verified by hand"
section opening at `:638`, says a work cycle actually stopping at that ceiling
has not been observed, and that two things about it are reasoned rather than
measured.
The ledger is consistent with the flag working and with nothing ever testing it:
four of 71 capped runs created before 2026-08-15 overshot their cap, none of 63
created after — and `--max-budget-usd` landed at `3be876c`, 2026-08-14. The two
overshoots carrying a stop reason are both the between-cycles `run_cost` message,
from 2026-08-11 and 2026-08-12, one of them $8.91 against a $5 cap. **They
predate the flag and are evidence of the failure it was built to fix, not against
it.** So: whether the CLI's in-cycle ceiling counts a sub-agent's spending is
unestablished, it is unestablished whether or not this option ships, and this
option is the one that makes it matter.

**Three cost sources: nothing new.** The delegated split already reads through
`agentSpend`, whose route carries `excludedFromTotals`
(`src/app/api/runs/[id]/agent-cost/route.ts:78`) and whose card already says the
three readings must never be added.

**Who may author it: nobody but this repository, and constraint 7 is answered
vacuously across runs.** No run writes anything a later run reads. Within a run
the sub-agent authors what the parent is *told* — the prompt side of
`docs/agent/chat.md`'s split rather than the guard side, arriving as a tool
result rather than as an instruction.

## What the operator sees, and how they override it

**Sees: better than any other option here, and only because a switch defaults
on.** `RunAgentCost` is already a card on the run page with a share and a meter;
the dashboard already groups the week by agent; and the sub-agent's own words
reach the run log as their own voice (`src/lib/logLine.ts:273`). Constraint 6 is
met without building anything and without touching the `--include-hook-events`
defect that gates the hook options — this option installs no hook.

**But the visibility is conditional, and that is constraint 6's real bite here.**
It is gated on `forwardSubAgentText`, and `src/lib/settings.ts:122`–`:125` states
what off looks like: "a delegation is a `Task` tool call followed by silence for
however long the sub-agent takes, and the run that spent the money has nothing to
show for the part of it that was handed on." An install that has switched it off
and then adopts this option has made its most expensive turns its least legible
ones.

**Overrides: there is no operator override, and that is a genuine cost of the
shape.** Constraint 1 forces any sentence that must stay true into generated
text, and generated text has no box to empty. An operator whose runs are short,
or whose repository is small enough that orientation is one file, cannot turn
this off without a rebuild; `DELEGATION_NOTICE` already has that property today,
and the `nextPrompt` door only moves the bytes. Per run there is no surface and
none is needed: the operator's own task text reaches the agent verbatim.

## How it fails, and whether loudly

**Loud: nothing.** No flag, no hook, no schema, no store, no migration. On a
build with no `Agent` tool the sentence is ignored and the run behaves exactly as
it does today.

**Silent, first — it is declined, and the survey's own prior for that is bad.**
`02-what-already-tries.md:211` counts 194 `Agent` calls across 21 of the 283 runs
that ran any tool and reads that as `DELEGATION_NOTICE` being "largely declined".
**That inference does not hold, and the correction runs in this option's
favour**: `git log -S "hand self-contained" -- src/lib/orchestrator.ts` returns
one commit, `ee93684`, dated 2026-08-21 22:08, and `git log -S
"append-system-prompt"` shows no earlier delegation text on that flag. The 194 is
a **no-instruction baseline**, not a decline rate. What stands as the prior
instead is `00-problem.md`'s harder finding: 112 runs edited `src/lib/`, eleven
read the `docs/agent/` doc CLAUDE.md's gate names — a rule in the
highest-authority position available, declined roughly nine times in ten.

**Silent, second — it is taken too far, and the base is five runs.** Delegated
spend is concentrated: 25 of 294 runs delegated at all, and the top five carry
**$195.93 of $284.39, 68.9%**. So the 6.57% aggregate is not a fleet habit that
would scale smoothly; it is a handful of runs, and an instruction that moves the
median run into that class is extrapolating from five points.

**Silent, third — the sub-agent returns everything.** A delegated turn that reads
five files and reports them verbatim has moved the bytes into the parent by a
worse door: the parent writes them at 2.0× having also paid the sub-agent's
$0.073 prefix. Nothing in `RunAgentCost` distinguishes that from a delegation
that worked.

**Silent, fourth — the delegated turn re-derives, and the guard hole above.** A
sub-agent has no parent history, which is the mechanism and also the cost: it
re-reads what the parent already had, one level down. And a delegation that goes
wrong on one of the 134 ceilinged runs is a conversation this app can observe
after the fact and has not been shown to bound during.

## What it costs to build

**The string half is built.** What remains is a clause in an existing source
constant (`src/lib/orchestrator.ts:4797`) or a generated clause in `nextPrompt`
(`:4299`), and the
settings page and route are untouched because neither door adds a `Settings`
key — which means none of constraint 1's four doors is opened. No route, no
component, no store, no schema, no migration. It is the smallest build in the
survey, smaller than Option A's one function, one route and one card.

**Invariants at risk: three, all already drawn in this tree.** `BUILT_IN_AGENTS`'
refusal (`src/lib/agents.ts:179`, `:284`); the `tools`-field refusal (`:272`,
docblock `:190`–`:221`); and `handleStreamLine`'s separation of a forwarded
delegated turn from `finalText` (`src/lib/orchestrator.ts:5946`–`:5960`), which
is what keeps the DONE contract honest under more delegation.

**It earns no test under `CLAUDE.md`'s bar** — no pure function is added, and
`docs/agent/testing.md` is explicit that the existing list is the bar rather than
a convention to extend. What it owes instead is one line in
`docs/verification.md`'s "Not yet verified by hand" section (`:638`): whether a
cycle's `--max-budget-usd` bounds its delegated turns.

## What would have to be true

**That the survey's question is the one being answered — and it is not.** This
option reduces the cost of orientation reading *within* a run. It carries nothing
between runs, so on `00-problem.md`'s central measurement it scores zero by
construction. Anyone shipping it should ship it as a cost-control measure beside
whatever this survey recommends for the memory question, never instead of one.

**That `d` is non-zero for delegation specifically.** The per-unit arithmetic is
the best in the survey and is entirely conditional on it: $0.112 saved per
mean-sized read moved, a $0.073 prefix per delegation, break-even at 0.65 reads
(`proposals/ContextControl/19-validation.md:50`) — and, from this install, a mean
delegation that actually costs **$1.47**. If a delegation displaces one read and
adds fifteen turns of its own, the option loses money on every call, and nothing
distinguishes that outcome from the good one on any page this app renders.

**That `--max-budget-usd` bounds a cycle's delegated turns.** The between-cycles
guard and the live guard both count them, measured above. The in-cycle ceiling is
unestablished on 134 runs and $2,250.57 of this install's spend, and
`docs/verification.md:1264` says the ceiling has never been watched firing at
all. That experiment is small, billed, and settles a hole that exists today.

**And the fact that would overturn the case against it:** a billed pair of runs
on one of this install's real tasks, one with the orientation clause and one
without, showing the treated run reaching its first edit at materially lower OTLP
cost *and* in no more work cycles. `00-problem.md` puts pre-first-edit spend at
20.9% of the UsageFoundry folder's OTLP bill, median 24.4% per run; if delegating
the opening read moves a quarter of that for one $1.47 delegation, Option K
becomes the only mechanism in the survey with a measured prize. If it moves
nothing, the 666 bytes already shipping at about $2.60 a week are the whole of
what this option will ever be.
