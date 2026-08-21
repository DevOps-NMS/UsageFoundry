# Option F — compaction driven by this app

Take the CLI's own compaction and make it a decision: choose the threshold with
`--autocompact`, switch it off with `DISABLE_AUTO_COMPACT`, and watch it with a
`PreCompact` hook.

One correction to the framing before the case, because it changes what "driven
by this app" can mean. **Compaction is already happening and this app neither
asked for it nor knows about it.** `02-levers-on-the-pin.md` drove a `-p
--output-format stream-json --verbose` session — the exact shape a work cycle
is spawned in — to a `PreCompact` hook firing unprompted with `trigger:
"auto"`. So this option is not "add compaction". It is "stop having it happen
by default at a threshold nobody chose".

## The strongest case

**No other option that edits a conversation already under way has compaction's
arithmetic, and the reason is the one thing `01-constraints.md` says the formula
turns on.** `T* = 19·(S/D) −
20` depends on `S/D` — "what matters is not how much an option removes, but how
much it leaves standing after the cut." Every content-editing option leaves
nearly the whole suffix behind and waits 170 turns. Compaction leaves almost
nothing:

| what it removes | `T*`, in further turns of the same conversation |
|---|---|
| half the suffix | 18.0 |
| 70% | 7.1 |
| 80% | 3.7 |
| 90% | 1.1 |
| 95% | 0.0 |

At the compression a summary actually achieves, **the invalidation is paid back
within one or two turns**, and everything after that is the 0.1× saving on a
conversation an order of magnitude shorter. That is the whole of the case and it
is a strong one.

**And this app writes almost none of it.** `--autocompact <auto|tokens>` is on
the parser and its own error names the range: "It must be 'auto', or between
100k and 1M". `DISABLE_AUTO_COMPACT=1` suppresses `PreCompact` on two otherwise
identical runs. Both are verified on the pin. The summarising is the
provider's, using a mechanism built for it, and this app contributes a number
and an environment variable.

**And it acts at the one moment `S/D` is smallest, without anybody having to
predict it.** Every other option here fires on a rule this app writes — a cycle
boundary, a byte threshold, an operator's choice of block. Compaction fires when
the conversation is actually long, measured by the CLI against the model's own
window, using the `count_tokens` calls `02-` found it already making over large
tool results.

## Shape

**The argv and the environment.** Three pieces, and the third is optional:

- **`--autocompact <tokens>`** on every cycle's argv, from `buildArgs`
  (`src/lib/orchestrator.ts:4756`, rebuilt per cycle at `:6701`).
- **`DISABLE_AUTO_COMPACT`** in the child's environment. `childEnv`
  (`:5216`–`:5231`) copies `process.env` and strips only `UF_*`, `OTEL_*`,
  `ANTHROPIC_ADMIN_KEY`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `DATA_DIR` and
  `NODE_OPTIONS`, so this variable **already reaches every agent this app spawns
  if it is set in compose** — unstripped, unrecorded and unmentioned by any page.
  The option's first act is to make that an explicit key rather than a leak.
- **A `PreCompact` hook**, through the `--settings` channel that survives
  `--resume`, purely so the run's log says a compaction happened. The event
  carries `session_id`, `transcript_path`, `trigger` and `custom_instructions`
  (`02-levers-on-the-pin.md`), and `--include-hook-events` puts the dispatch on
  the same `stream-json` channel `handleStreamLine`
  (`src/lib/orchestrator.ts:5830`) already reads.

**What the flag can and cannot do is decided by the model's window, and it is
one-directional.** Measured on `claude-haiku-4-5-20251001`:

    --autocompact 100000    →  effectiveWindow=80000
    --autocompact 1000000   →  effectiveWindow=180000

100,000 − 20,000, and min(1,000,000, 200,000) − 20,000. **On a 200k-window model
the flag can only ever lower the threshold, never raise it, and asking for 1M
buys nothing.** So the only version of this option that changes anything is one
that compacts *earlier* than the CLI would — which is the version whose refusal
case, below, is live.

## What leaves the context, and when the decision is taken

**Mid-cycle, at a threshold, and what leaves is decided by a model this app
cannot instruct.**

The trigger is the CLI's: `level` moves `ok` → `compact` → `blocked` as the
conversation grows and the CLI acts on it (`autocompact: routing through
reactive (thresholdSource=settings)`). What survives the compaction is a
summary written by the model, and `custom_instructions` is a field on the
`PreCompact` payload — "parameterisable from somewhere, though not from
anything this app puts on an argv" (`02-levers-on-the-pin.md`).

**That is the sharpest form of `01-constraints.md`'s hardest question.**
Deciding what an agent is told is a prompt-side act; deciding what it is
*permitted to have forgotten* is not obviously one, and this option hands that
decision to a model with no way to constrain it. The constraint's own test —
"an option in that shape has to argue why a model choosing to discard the
paragraph that carried a safety instruction is different from a model choosing
its own permission mode" — has one honest answer here, and it is not a strong
one: the model doing the discarding is the same model that was already carrying
the paragraph, and the alternative on offer (Option F switched off) is a
conversation that grows until the window ends the run. That is a choice between
two bad outcomes rather than a defence.

## What it does to the prefix cache

**One large invalidation, immediately repaid.** A compaction replaces the whole
suffix, so the next request re-writes `S − D` at 2.0× — but `S − D` is a
summary, and the table above prices the trade at one to two further turns at
any realistic compression. No option that edits a conversation already under
way has a better ratio; the ones that intercept content before it lands pay
nothing at all, and reach a different share of it.

**Two costs the table does not carry.** The compaction turn itself is a model
turn over the whole conversation, and neither `02-` nor `03-` priced it —
`02-`'s recorder "cannot produce a summary a real compaction would accept, so
no probe reached a *completed* compaction, only the decision to attempt one."
And the saving does not obviously survive a cycle boundary: **whether a
compaction survives `--resume` is `02-`'s explicit *could not establish*.** If
it does not, a resumed cycle re-sends the pre-compaction conversation and the
whole saving is paid for once and thrown away; if it does, it compounds across
every later cycle. That single unknown moves this option between "the best
arithmetic in the survey" and "a turn-level optimisation that a handover
undoes".

**And there is a case where the flag does nothing at all, silently.** The CLI
computes a fixed prefix and declines when that alone exceeds the threshold:

    autocompact: fixed prefix ~83280 > threshold 67000 — compaction cannot help

`02-` calls this "the most consequential line in the section for the survey",
and this install is squarely in its range. A UsageFoundry run's opening turn
writes a median **42,380** tokens of prefix beyond the 15,903-token base that
stays warm across sessions, and the distribution runs to **92,085 at p90 and
132,919 at the maximum** over 261 openings. So a fixed prefix of roughly 58,000
tokens at the median and 108,000 at p90. Set `--autocompact 100000` —
`effectiveWindow=80000`, and the *threshold* is lower still by an amount the
probe did not establish — and a p90 UsageFoundry run is refused compaction
outright, with the reason in the debug log and nowhere else.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**This is where the option is most exposed, and it has one real mitigation.**

**The two endings can be summarised away, and `01-constraints.md` forbids
exactly that**: "An option that drops, summarises or rewrites turns must not
drop these, and must not contradict them." A compaction summary is written by a
model with no instruction from this app, so nothing guarantees
`COMPLETION_NOTICE` (`src/lib/orchestrator.ts:4466`) or `NEEDS_REVIEW_NOTICE`
(`:4506`) survive it.

**The mitigation is already in the tree, and it covers cycle 2 onwards but not
cycle 1.** `nextPrompt`'s resumed branch sends `continuationPrompt` joined to
`NEEDS_REVIEW_NOTICE` on every cycle (`:4361`), and
`DEFAULT_CONTINUATION_PROMPT` names the DONE token in its own words
(`src/lib/settings.ts:516`). `COMPLETION_NOTICE`'s docblock says why that
overlap exists — "The first restates `DEFAULT_CONTINUATION_PROMPT` almost
verbatim on purpose — cycle 1 and cycle 2 disagreeing about the bar is the bug"
(`src/lib/orchestrator.ts:4456`–`:4459`) — and the accidental consequence is
that a compaction which eats the notices is repaired at the next handover.

**Cycle 1 is not repaired, and cycle 1 is where the measured failure lives.** A
compaction at turn 90 of a first cycle removes both notices from a conversation
that will receive no continuation prompt before it ends. That is precisely the
state `COMPLETION_NOTICE` was written to end, and the docblock carries its
price: of the runs whose budget allowed a second cycle, **92 of them cost $162
to say one word into a re-sent conversation** (`:4436`–`:4446`).

**`cycleEnding` is untouched but newly reachable.** It matches `DONE` and
`NEEDS_REVIEW` alone on a line against a cycle's final text (`:4543`–`:4545`).
A compaction summary is not final text, so no ending fires from the summary
itself — but a summary is text this app's own matcher may later read if the
agent quotes it, which is the hazard `01-constraints.md` raises for any
mechanism that writes a summary back into the conversation.

**Retention: no fourth store, and one thing this app must not do.** The
compaction is the CLI's and the transcript is the CLI's; this app writes nothing
new and invents no horizon, which is a genuine advantage over Options E and I.
What it must not do is help: `01-constraints.md` is explicit that "any option
that edits, truncates or rewrites a transcript in place is doing surgery on the
one artefact whose loss the app already treats as a restart"
(`src/lib/retention.ts:663`–`:667`, `docs/agent/retention.md:12`), and a version
of this option that trimmed the `.jsonl` itself would be that.

**And the transcript records nothing either way**, which is the measurement
consequence. `00-problem.md` found `records 111845 compaction markers {}`, and
`02-` reproduced the same empty set on a session that demonstrably reached
`PreCompact`. So **a compaction leaves no trace in the file this proposal
reads**, and no before-and-after comparison of composition can attribute a
change to it without the hook.

## Guards and the three cost sources

**Must not touch, and does not:** the check order is unchanged — `no_terminus`
(`src/lib/budget.ts:495`), `iterations` (`:506`), `duration` (`:518`),
`run_cost` (`:525`), `run_tokens` (`:532`), `weekly_fraction` (`:551`),
`session_fraction` (`:582`). `RunGuards` (`src/lib/settings.ts:489`) gains
nothing. Compaction happens inside a cycle, and `--max-budget-usd` — derived per
cycle as `max(0, maxRunCostUSD − spentGuardUSD)`
(`src/lib/orchestrator.ts:4880`–`4882`) — still bounds it, including the
summarisation turn.

**It makes a run limit go further in turns, and `01-constraints.md` says to use
those words.** A compacted conversation is cheaper per turn, so the same
remainder buys more turns. That is not a widening.

**Adds to which source: none, and it degrades one.** No figure is produced. But
the compaction turn's own usage lands in the transcripts like every other turn,
uncounted as anything special, so `scanUsage()`'s totals silently begin to
include a cost class that did not exist as a category before. That does not
break the never-mix rule; it means the transcripts source stops being
comparable across the change, and only the `PreCompact` hook's log line would
date it.

## What the operator sees, and how they override it by hand

**Sees, if and only if the hook is built: a line on the run's log saying a
compaction happened, with its trigger.** Without the hook, the operator sees
nothing at all — no marker in the transcript, no event, no exit code, and a bill
that moved. `01-constraints.md`'s third obligation applies with full force here,
because this is the option whose effect is on the *conversation* rather than on
the prompt: "a mechanism whose effect is invisible in the log is one whose
misbehaviour reads as the agent being stupid." **The hook is part of the option
rather than a follow-up.**

**Overrides:** a threshold in Settings, `null` / `""` / `0` all meaning off
(`docs/agent/budgets-and-guards.md`), stored only when it differs from
`DEFAULTS` (`src/lib/settings.ts:693`). And an explicit compose key for
`DISABLE_AUTO_COMPACT`, which `docs/agent/environment.md` governs: compose
renders every optional variable as `${VAR:-}`, so a blank-by-default key read
through `env()` becomes a permanent warning on every stock install — meaning
this one has to be read in a way that does not warn when unset.

**Mid-run:** per cycle, following `enabledPluginDirs()`
(`src/lib/orchestrator.ts:6690`) and the sandbox policy (`:6747`) rather than
`settings` frozen for the segment (`:6379`, `:6722`–`:6723`). The argv is
rebuilt every cycle anyway. The environment variable is *not* re-resolvable in
the same way — `childEnv` reads `process.env` at spawn, so a compose change
needs a restart, which is the same answer every other environment key gets.

**By hand:** nothing. Unlike Option E's externalised files, a compacted
conversation is not recoverable by the operator: the pre-compaction turns are in
the `.jsonl` and the CLI is the only thing that reads it back.

## How it fails, and whether loudly

**Loud: an out-of-range value.** `claude --autocompact 50000` and
`--autocompact 2000000` both fail at the parser with the range in the message,
and an unknown flag on a future build is equally loud — measured on the pin,
`claude -p "hi" --not-a-real-flag` exits 1 with `error: unknown option
'--not-a-real-flag'` before any API call. So a build that removes
`--autocompact` fails the spawn rather than quietly ignoring it, which is the
good half of `01-constraints.md`'s four shapes.

**Silent, first: the refusal.** "fixed prefix ~83280 > threshold 67000 —
compaction cannot help" is a debug line. On a run whose fixed prefix is above
the threshold — a p90 UsageFoundry opening, at any `--autocompact` value near
the bottom of the range — the mechanism is configured, believed to be on, and
does nothing.

**Silent, second: the environment variable that is already live.**
`DISABLE_AUTO_COMPACT` set in compose today reaches every agent through
`childEnv` and appears on no page. An install that has it set is running a
different context regime from one that does not, and nothing in this app can
tell them apart.

**Silent, third: the summary is wrong.** A compaction that drops the constraint
that mattered leaves an agent confidently working from an incomplete account,
and the observable symptom is the agent redoing work — the same symptom
`continuedWorkNotice` names for a fresh session, where "both are billed and
both look like progress" (`src/lib/settings.ts:544`–`551`).

**Silent, fourth, and it is the one that decides the option's value:** whether
the compaction survives `--resume`. If it does not, every compaction is paid for
and discarded at the next handover, and the bill looks like a mechanism that is
not working rather than one that is being undone.

## What it costs to build

**Files touched:** `src/lib/orchestrator.ts` (one argv entry in `buildArgs`,
one key in `childEnv`'s `extra`, and a `PreCompact` entry in the `--settings`
payload), `src/lib/settings.ts` and the settings page for the threshold,
`docker-compose.yml` and `.env` for the off switch, `src/lib/config.ts` for the
blank-is-the-answer reading (`:22`–`:26` against the sibling at `:28`). Smaller
than Option E and much smaller than Option I: there is no store, no sweep, no
schema change and no migration.

**Invariants at risk — four.** `docs/agent/environment.md`'s asymmetry —
`DATA_DIR` refuses the boot and every other variable warns — and the `${VAR:-}`
rendering that turns a blank optional key into a permanent warning. The
`--settings` single-flag question Option E raises, if the `PreCompact` hook
shares that payload with `sandboxArgs`. The two endings' contract, above. And
`docs/agent/retention.md`'s rule that the transcript is evidence with a
horizon, which this option must respect by not touching the file.

**It earns one test and only one.** The bar is a pure function whose failure
mode is silent (`docs/agent/testing.md`), and the candidate is the threshold
reader: `--autocompact` takes `auto` or 100,000 to 1,000,000, and the settings
blob is JSON in a row that outlives the build which wrote it. That is
`cycleSilenceMs`' exact argument (`src/lib/orchestrator.ts:455`–`:476`) — off,
negative and corrupt must take the default, and a value below the floor is a
request that gets the floor — and here the CLI *refuses* an out-of-range value
at the parser, so a number read wrong is a whole fleet failing to spawn.

## What would have to be true

**That a compaction survives `--resume`.** This is the option's load-bearing
unknown and `02-` names it as one: no completed compaction was reachable
without a live model, and no marker is written either way. If it does not
survive, the mechanism is undone at every cycle boundary — 108 of them in the
rolling week.

**That compacting earlier than the CLI already does is worth anything.** The
flag can only lower the threshold on a 200k-window model, so this option's
entire delta over doing nothing is the difference between the CLI's `auto` and
a smaller number. Nothing measured here says what `auto` resolves to on
`claude-opus-5`, or how often the runs in `00-problem.md`'s corpus reached it —
because the transcript records no marker, the corpus cannot say whether any of
them compacted at all.

**That a model's summary may decide what an agent forgets.** This is the option
that most directly puts that decision in a model's hands, with no
`custom_instructions` reachable from any argv this app emits, on a run where
`SELF_HOSTING_NOTICE`'s docblock records two runs killed by a literal in text
that was "only text" (`src/lib/orchestrator.ts:4719`–`:4731`).

**And the fact that most weakens it, stated plainly:** on a run whose fixed
prefix is already over the threshold, the pin's answer is that **nothing
happens**, in the debug log, on a mechanism the operator believes is protecting
them. This install's openings run to 92,085 tokens of prefix at p90 and 132,919
at the maximum, and `--autocompact`'s own clamp puts the reachable ceiling at
`min(asked, window) − 20,000`.
