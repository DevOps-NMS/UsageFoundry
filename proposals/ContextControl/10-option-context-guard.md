# Option G — a context guard

A ceiling on what a run may carry. Checked between cycles, where the other
guards are checked; and when it trips, the next cycle opens a fresh
conversation rather than the run being stopped or parked.

## The strongest case

**It is Option D with a trigger, and the trigger is what makes the arrangement
defensible.** `03-experiment-resumed-vs-fresh.md`'s result is that starting
fresh is *dearer* on a clean prefix — the fresh cycle's lead is 11,920 weighted
bytes, spent at about 3.9 KB of re-read, "2.5% of what the opening cycle read".
A rule that starts fresh on every cycle pays that on the 29 handovers of 108
that would have hit the cache. A rule that starts fresh only when the
conversation is actually long pays it almost never, because a short
conversation is one nothing here is trying to shorten.

**And it is the only shape in the survey that spends money in proportion to
what is at stake.** `00-problem.md`'s handover write is a median 231,644 tokens
and a maximum 437,994 — the cost of a re-write is the size of the suffix. A
threshold on carried context is therefore a threshold on the size of the thing
being paid for, which is what a guard is: `maxRunCostUSD` bounds spend,
`maxDurationMinutes` bounds wall clock, and this bounds the quantity
`00-problem.md` found explains almost everything — **carried context, at r² =
0.935 against total session cost, against turn count's 0.410 and output tokens'
0.512.**

**And this app already has every piece of the machinery.** The guard site is
the top of the cycle loop (`src/lib/orchestrator.ts:6412`), where
`currentSnapshot()` (`:6198`) is already awaited and `evaluateBudget`
(`src/lib/budget.ts:400`) already runs. The reading is the join
`reconcileKilledCycle` (`src/lib/orchestrator.ts:6254`) and `GET
/api/runs/[id]/agent-cost` already perform. The meter shape is `BudgetMeter`,
which already carries a `tokens` unit (`src/lib/budget.ts:131`–`:136`). The
action is one assignment to the `sessionId` local at
`src/lib/orchestrator.ts:6319`. Nothing here is new capability; it is a
threshold over a figure this app can already compute and an action it already
takes in three other circumstances.

## Shape

**This app's own accounting, deciding the session lifecycle.** In the primary
form, no argv entry changes and no text changes — `buildArgs` simply receives
`resumeSessionId: null` on the cycle after the ceiling was crossed, and
`nextPrompt` takes its `sessionId === null` branch (`:4330`).

Three parts:

1. **A reading**, per cycle: the tokens this run's session has carried, from the
   entries `scanUsage()` already produces, bounded by session id *and* by time for
   `reconcileKilledCycle`'s stated reason — "a resumed session copies earlier
   turns forward into the same file carrying their original timestamps"
   (`:6246`–`:6248`).
2. **A threshold**, in the run's `BudgetPolicy`-shaped configuration or beside it.
3. **An action**: clear `sessionId`, log it, and let the next cycle open fresh.

**Where the check sits is the whole design question, and `01-constraints.md`
answers it in the negative.** The check order — terminus, cycles, duration, run
spend, weekly, then session — is "load-bearing" (`CLAUDE.md`), enforced in code
at `src/lib/budget.ts:495`, `:506`, `:518`, `:525`, `:532`, `:551`, `:582`, and
"nothing about a context decision may reorder it or add a rung to it". So:

- **The shape that survives** is *not* a `BudgetVerdict`. It is a decision taken
  after `evaluateBudget` has already returned `allowed: true`, in the same window
  where `enabledPluginDirs()` (`src/lib/orchestrator.ts:6690`) and the sandbox
  policy (`:6747`) are re-resolved. `evaluateBudget` stays pure, its order is
  untouched, and `BudgetStopCode` (`src/lib/budget.ts:138`–`:150`) gains no
  member — which matters because a new member would have to be placed in or out of
  `RUN_ENFORCEABLE_CODES` (`:229`–`:239`) and `LIVE_ENFORCEABLE_CODES`
  (`:194`–`:200`), two lists whose contents are arguments rather than
  enumerations.
- **The shape that does not survive** is a rung. A `context` code returning a
  refusal would be a `BudgetVerdict` whose disposition is neither `stop` nor
  `pause` but "carry on differently", and the union is deliberately built so that
  "an optional `disposition` lets a caller read a pause as a stop and still
  compile, which is the one mistake this type exists to prevent"
  (`:152`–`:157`). A third disposition is a change to that type, and the check
  order is where it would have to be placed.

**A mid-cycle variant exists and is a different option in everything but name.**
Interrupting a working cycle when its context crosses a line would use
`liveGuards` (`src/lib/orchestrator.ts:426`, `:6780`) on the
`liveGuardIntervalSeconds` tick (`:7507`), throw away an in-flight cycle whose
spend then needs `reconcileKilledCycle`, and add a code to
`LIVE_ENFORCEABLE_CODES` — whose exclusions are each argued individually
(`src/lib/budget.ts:186`–`:192`). It also collides with the interrupt ordering
`docs/agent/run-lifecycle.md` fixes: `cancelled` is checked twice per cycle and
the interrupt test comes **before** the exit-code test. The between-cycles form
avoids all of it, and this file argues for that one.

## What leaves the context, and when the decision is taken

**Everything leaves, at a cycle boundary, on a threshold this app evaluates.**

The decision is taken between cycles and by code — no model summarises, no
model chooses. It is the same answer Option D gives to `01-constraints.md`'s
question about who decides what an agent may forget, with the addition that the
*timing* is also this app's rather than a blanket rule.

**Three triggers are available and they are not equivalent**, which is worth
setting out because the survey's brief names only the first:

- **On size** — carried context above N tokens. Simple, and it fires on the
  quantity that predicts cost (r² = 0.935). It cannot tell whether the coming
  handover would have re-written.
- **On the last handover's behaviour** — whether the previous cycle's opening turn
  wrote more than it read, which is `00-problem.md`'s own classifier and is in the
  transcript. Retrospective by one cycle, and on a run that keeps committing that
  is a good predictor.
- **On the repository** — whether the previous cycle changed anything, which
  `02-levers-on-the-pin.md` found necessary but not sufficient (0 of 74 re-writing
  handovers followed a cycle that changed nothing; 23 of 29 cache hits followed one
  that did). Readable without a transcript scan at all, through `git`
  (`src/lib/git.ts:182`).

## What it does to the prefix cache

**It converts one re-writing handover into one fresh opening, and the sign of
that trade depends on something the trigger cannot see.**

From `00-problem.md`'s own table of the two: a resumed handover that re-writes
costs a median **$2.335**; one that hits costs **$0.165**; a fresh
conversation's opening turn costs **$0.294**.

- Fired before a handover that *would* have re-written: **saves about $2.04**,
  before whatever the fresh agent re-reads.
- Fired before one that would have hit: **costs about $0.13**, plus whatever the
  fresh agent re-reads.

At the rolling week's 79-to-29 split, a size trigger that fired on every
handover of a long run would be right about three times in four. That is Option
D's expected value; the threshold's contribution is to stop paying the $0.13 on
short runs where there was nothing to save in the first place.

**The re-reading is what decides it, and `03-` gives both ends.** In the clean
case the fresh cycle's whole lead is spent at about **3.9 KB** of re-read per
cycle. Extrapolating `03-`'s weighted bytes into the re-writing case — this
file's arithmetic, not `03-`'s measurement — the resumed cycle's 330,431 matched
bytes become a 2.0× write instead of a 0.1× read, the lead grows to roughly
**640,000 weighted bytes**, and at `03-`'s measured 3.06 weighted bytes per byte
re-read that is about **209,000 bytes** of allowance. The threshold's job is to
fire only where the second number applies.

**One property this option has and Option D does not: the ceiling is also the
thing being measured.** The trigger reads carried context, which is the same
figure a meter would show, so a `BudgetMeter` with `unit: "tokens"` reports the
run's distance from its own ceiling on the run page beside the existing guards
— and it comes from the transcripts, the same source `weeklyFraction` and
`sessionFraction` in the `budget` event already come from
(`src/lib/orchestrator.ts:6468`–`:6469`). No never-mix boundary is crossed.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**DONE and `needs-review`: strengthened at the boundary, at a known cost.**
Every fresh conversation gets `COMPLETION_NOTICE` gated on `endsOnDone`
(`:4344`, `:4466`) and `NEEDS_REVIEW_NOTICE` (`:4347`, `:4506`) as its opening
context, rather than carrying them from a turn that has scrolled out of reach —
the failure `COMPLETION_NOTICE`'s docblock names at `:4357`–`:4361`.
`cycleEnding` (`:4543`) is untouched.

The cost is the one `nextPrompt` already anticipates: a fresh conversation on a
run that has worked gets `priorWorkNotice` (`:4417`), because "that combination
is a restart, not a first attempt, and the difference is invisible from inside
the prompt: the conversation that held what the previous attempt did is gone,
while its work is still on disk" (`:4294`–`:4297`). This option makes that
sentence load-bearing on ordinary runs rather than only on pick-ups.

**`--resume`: deliberately withheld, on a run that could have used it, and the
tree contains the argument against.** `looksLikeResumeFailure` (`:7127`) stops
a run rather than starting over, because "the honest move is to stop and name
the command rather than quietly start a fresh session and lose the conversation
the resume existed to keep" (`:7113`–`:7117`). This option's answer is narrower
than Option D's: it does not discard conversations in general, only ones that
have grown past a ceiling an operator set, and only where the alternative is
paying to re-write them.

**Retention: no fourth store, and one interaction to get right.** Nothing new
is kept. But every fired ceiling leaves an *abandoned* session behind, and
`resumableSessions` (`src/lib/retention.ts:589`–`:615`) builds `keepSessions`
from one `session_id` per non-terminal run — so the abandoned transcripts fall
to `transcriptRetentionDays` (default 30, `src/lib/settings.ts:633`) while the
run is still live. For resumption that is correct, because nothing will resume
them. For measurement it is the same loss Option D has: those files are where
every figure in `00-problem.md` comes from, and they are the evidence that the
guard did any good.

## Guards and the three cost sources

**What it must not touch, and what it therefore is not.** It must not become a
`BudgetStopCode`, must not reorder or extend the check order, and must not be a
refusal — because a refusal is a thing a run can be *ended* on, and this is a
thing a run carries on past. `enforceableForRun` (`src/lib/budget.ts:242`) and
its list stay exactly as they are. `RunGuards` (`src/lib/settings.ts:489`) is
`permissionMode`, `isolate`, `budget`; a context ceiling is a fourth thing, and
putting it inside `budget` is what would drag it into `BudgetPolicy`,
`normalizePolicy` (`src/lib/budget.ts:592`) and `evaluateBudget` all at once.

**One guard meaning it does change, in the direction `01-constraints.md`
names.** `maxIterations` counts cycles, not money (`src/lib/budget.ts:97`). A
fresh agent re-deriving what it lost uses turns, and enough turns is a cycle —
so a run whose cap was sized against a resumed arrangement gets less work done
under this one. The constraint states it as a rule: "an option that makes an
agent re-derive what it dropped spends the terminus, and the terminus is the
one thing … that must stay monotone." It stays monotone; it just buys less.

**Adds to which source: the transcripts, and it must say so.** The reading is
`01-constraints.md`'s fourth reading of one of the three, and both rules bind.
The meter belongs in the transcripts band and never at region level
(`docs/agent/conventions.md:46`). And **a run with no reading must render as
the hatched indeterminate meter rather than a 0% bar** —
`docs/agent/metering.md`'s first rule, and the exact case that arises when a
run has no session id yet or the transcript directory is unreadable, which
`RunAgentSpendDTO` already handles by being null on the wire
(`src/lib/apiTypes.ts:733`–`:737`).

## What the operator sees, and how they override it by hand

**Sees:** a meter, beside the run's other guards, saying how much this run is
carrying against the ceiling; and a line on the run's own log at the moment the
ceiling fires. The log line is not optional — `enabledPluginDirs()`'s
missing-dirs line (`src/lib/orchestrator.ts:6691`–`:6698`) is the precedent,
written "on the run's own log rather than left to be inferred", and a fresh
conversation an operator did not ask for is at least as invisible as a plugin
that stopped loading. `resuming: sessionId` going null on the next `iteration`
event (`:6651`–`:6652`) is the machine-readable half and comes free.

**Overrides:** a number, where `null` / `""` / `0` all mean off
(`docs/agent/budgets-and-guards.md`), stored only when it differs from
`DEFAULTS` (`src/lib/settings.ts:693`). Off must be the default until it is
not.

**Per run:** this is the option with the strongest claim on the run form,
because it is shaped exactly like the things already there — a ceiling, per
run, that changes what the run does. `01-constraints.md` still requires the
widening to be argued rather than assumed: `RunGuards` is three fields and this
would be a fourth, on a record `docs/agent/chat.md` says a model may not write.
The argument is that a context ceiling decides how a run is *shaped* rather
than what it may do, which is the same distinction that keeps `model` off
`RunGuards` today.

**Mid-run:** it must be re-resolved per cycle, `enabledPluginDirs()`'s case
(`src/lib/orchestrator.ts:6686`–`:6689`), not `settings` frozen for the segment
(`:6379`, `:6722`–`:6723`). A ceiling an operator raises while watching a run
burn is useless if it reaches nothing until the next pick-up.

## How it fails, and whether loudly

**Loud: nothing to be loud about, and that is neutral rather than good.** There
is no flag, no hook and no env var, so there is no CLI build on which this
stops working. `01-constraints.md`'s pin question — "on a build where the lever
does nothing, does the run get quietly more expensive?" — does not apply.

**Silent, first: the ceiling never fires.** Set above what any run carries, the
mechanism is configured, believed active, and inert. This is the failure
`evaluateBudget` already refuses for its own fraction guards — `no_ceiling`
exists because "silently passing would leave the user believing a guard is
active" (`docs/agent/metering.md`) — and this option has no equivalent refusal,
because there is nothing to refuse: a ceiling nothing reaches is a valid
configuration. The available answer is the meter, which shows the distance.

**Silent, second: the ceiling fires on every cycle**, at which point this
option *is* Option D and inherits `03-`'s 2.59× worst case without anybody
having decided to. Nothing distinguishes the two on any page: the run's log
would say the ceiling fired, eleven times, and the eleven lines look like the
mechanism working.

**Silent, third, and it is the one that matters: the reading is a floor.**
Thinking text is stripped from the transcript — 13,454 blocks, zero bytes
retained — and the fixed prefix is a median 31,575 tokens that never appears in
the file at all (`00-problem.md`). So the guard measures less than the run
carries, always, and by an amount it cannot know. A ceiling set at 200,000
tokens fires later than the operator believes, in the direction that spends
money.

**Silent, fourth: the fresh agent redoes or reverts the work.** `03-`'s ceiling
case, and `continuedWorkNotice`'s stated reason — "both are billed and both look
like progress" (`src/lib/settings.ts:544`–`551`).

## What it costs to build

**Files touched:** `src/lib/windows.ts` (the same pure reading Option A needs),
`src/lib/orchestrator.ts` (the per-cycle read, the threshold test, the
`sessionId` clear and one `log()`), `src/lib/settings.ts` plus the settings page
and route, and — if the ceiling goes on the run form —
`src/app/api/runs/route.ts`, `CreateRunInput` and the form. No schema change is
needed for the between-cycles form; a per-run ceiling stored outside `budget`
needs one idempotent `addColumn` in `migrate()` (`src/lib/db.ts`).

**Invariants at risk — five.** The check order and `BudgetVerdict`'s union,
both avoided by construction rather than by care, and both re-entered the
moment somebody prefers the rung. `RunGuards`' three fields. The
unknown-renders-as-hatched rule. `runs.session_id`'s meaning, which changes for
any run that fired the ceiling — the same three readers Option D disturbs
(`reconcileKilledCycle`, the agent-cost route, `resumableSessions`). And the
`adoptSession` rule at `src/lib/orchestrator.ts:6350`–`:6353`, which exists
because the column was once written too late.

**It earns a test on `CLAUDE.md`'s stated bar, and the grounds are already
written down for its nearest neighbour.** The threshold evaluator is pure —
(carried tokens, ceiling, previous handover's behaviour) → resume or not — and
both failure modes are silent and expensive: a ceiling read as zero when the
operator switched it off starts every cycle fresh, and a ceiling read as
`Infinity` when it was set does nothing. That is `budgetFromForm`'s argument
verbatim: "`null` is the wire form of 'off', so a number left in a box the
operator switched off is a perfectly valid `BudgetPolicy` and starts an
unattended agent under a cap nobody set" (`docs/agent/testing.md`).

## What would have to be true

**That Option A's reading exists and is trusted.** This option is a threshold
over a figure nothing in this app currently computes, and it acts on it
unattended, twenty-five runs at a time. Building the actuator before the
instrument is the shape `docs/agent/metering.md` refuses for every window
guard: a fraction guard with nothing to read is refused at the door rather than
passed silently.

**That most handovers re-write.** 73% did in the rolling week. If a future CLI
moved `gitStatus` behind the conversation's cache breakpoint —
`--exclude-dynamic-system-prompt-sections` moves it, but "it moves the break, it
does not remove it" (`02-levers-on-the-pin.md`) — then handovers become cheap,
the ceiling's trade turns negative, and the right ceiling is `null`.

**That a fresh agent at the ceiling does the work.** `03-` could not test this:
"answer quality was not measured, and that is the part a cheaper arrangement has
to earn." A guard that fires at 200,000 carried tokens is discarding the most
context of any option in this survey, at the moment the run knows the most.

**And the fact that most weakens it:** the trigger cannot see what it is
buying. The cost of the handover it prevents depends on whether the CLI's
`gitStatus` block changed, which `02-` establishes "no lever this app holds"
reaches. So this guard is a bet on a distribution — a good bet at 79 to 29, and
still a bet placed without the information, on every run, for ever.
