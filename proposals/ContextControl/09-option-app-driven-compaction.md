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

*Updated 2026-08-22.* That correction was made on the strength of one hook
firing. It is now made on the strength of the corpus: **20 completed
compactions** across 12 transcripts, every one `trigger: "auto"`, mean 171k
`preTokens` down to 13.7k, audited in `01-constraints.md`. Two further things
this file treated as unknowable are settled below — the transcript *does* record
a marker, and the compaction *does* survive `--resume` — and one thing it
treated as a judgement is now measured, which is the correctness price of asking
a model to summarise a conversation an agent is still working in.

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

> **Corrected 2026-08-22, and it changes what the flag is.** Two things above
> are wrong for *this install*, and both were established by measuring the
> fleet's own transcripts rather than by re-probing (`docs/verification.md`).
>
> **`effectiveWindow` is not the threshold.** The fire point is
> `effectiveWindow − 13,000`, read off the pinned bundle as `SCe(…)-WQu` with
> `WQu=13000`. So `--autocompact 200000` fires at **167,000**, and the observed
> median `preTokens` over 42 real boundaries is 168,072 — 30 of them within
> ±3,000 of 167,000 against 2 within ±3,000 of 180,000. This closes the unknown
> the "What it does to..." section below names by hand as "lower still by an
> amount the probe did not establish", and it reconciles that section's own
> quoted debug line: `effectiveWindow=80000` refused against `threshold 67000`
> is exactly 80,000 − 13,000. The answer was in the file the whole time.
>
> **The premise "on a 200k-window model" does not describe this install.** The
> probe above ran against `claude-haiku-4-5-20251001`. On the model this app
> actually spawns, the window resolves near 1M — a pre-flag container session
> recorded a single 752,172-token request — and the bundle's own gate
> (`dQe(e,t){return Nq(e,t).source!=="auto"}`, with the `model-default` branch
> guarded by `o<1e6`) **refuses** auto-compaction outright for such a model. So
> here `--autocompact` does not lower an existing threshold. It creates the only
> one there is: 604 pre-flag container sessions, 246 of them past 167,000
> tokens, produced **zero** compactions.
>
> **This does not revive the option.** The refusal case below stands unchanged,
> the three correctness measurements stand, and `custom_instructions` is still
> reachable from no argv this app emits. What changes is that the sentence "the
> only version that changes anything is one that compacts *earlier* than the CLI
> would" is false as stated — the CLI would not compact at all — and that the
> observation half this survey kept is now measured rather than assumed.

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

> *2026-08-22: the amount is **13,000**, so that threshold is 67,000 — which is
> the number the debug line above already carried. See the correction under
> "What the flag can and cannot do".*

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

> **2026-08-22 — measured, and it survives.** Two runs in the corpus resume
> across a compaction boundary. In
> `96ba3c02-1313-493c-b484-45f2f519ed3b.jsonl` a boundary at record 108 takes
> 180,694 tokens to 17,456; a `--resume` spawn lands at record 366; the last
> assistant turn of the old process reports a context of **147,513** and the
> first turn of the new one reports **151,328**, a rise of 3,815 — the
> continuation prompt and its attachments, and nothing else. In
> `f291b888-df46-4dfa-998f-515360a7852f.jsonl` a boundary at 173 takes 174,613
> to 12,296, the resume lands at 498, and the two figures are **127,731** and
> **131,552**, a rise of 3,821. Had the resume replayed the pre-boundary
> history, both would have jumped to at least the `preTokens` figure plus every
> token earned since the boundary — over 300,000, past the window. Neither did.
> Context size is read from each assistant record's own
> `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens`,
> so it is what the API was sent rather than an estimate. **This closes the
> option's load-bearing unknown, in the option's favour.**

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

**~~That a compaction survives `--resume`.~~ Answered 2026-08-22: it does.**
`02-` named this as unreachable without a live model, and it was — but the model
has since run. The measurement is in "How it fails" above: two resumes across a
boundary, both continuous, neither replaying the pre-boundary history. The
mechanism is *not* undone at the cycle boundary. Strike this from the list.

**~~That compacting earlier than the CLI already does is worth anything.~~
Half-answered, and the half that changed is the premise.** The flag can only
lower the threshold on a 200k-window model, so this option's entire delta over
doing nothing is still the difference between the CLI's `auto` and a smaller
number, and nothing measured here says what `auto` resolves to on
`claude-opus-5`. What is no longer true is the sentence that followed: *"because
the transcript records no marker, the corpus cannot say whether any of them
compacted at all."* **The transcript records a full marker** — a
`type: "system"`, `subtype: "compact_boundary"` record carrying `trigger`,
`preTokens`, `postTokens`, `durationMs`, `cumulativeDroppedTokens`,
`preservedSegment` and `preservedMessages` — and the corpus now holds 20 of
them across 12 transcripts, every one `trigger: "auto"`. `01-constraints.md`
carries the audit. So the question "how often did these runs compact" is
answerable by counting, and the answer today is that this install compacts at
roughly 171k `preTokens`, down to a mean 13.7k, at a cost of 143 seconds of
wall-clock inside a run whose `maxDurationMinutes` guard is counting.

**That the measured correctness price of this exact mechanism is one the
operator will pay.** This is the addition of 2026-08-22 and it is the reason
Option F scores −3 — the floor — on `16-comparison.md`'s eleventh criterion.
Every other option in this survey is scored on that row by analogy. F is scored
on it by name, because summary compaction is literally what all four
measurements ran:

| Source | Grade | What it measures on F's mechanism |
|---|---|---|
| `/workspace2/3 Resources/Sources/Governance Decay (Chen 2026).md` | `evidence: preprint`, `peer_reviewed: false`, `confidence: medium` | One compaction takes prohibited actions from **0% to 30%** across 1,323 episodes and seven model families, 59% on the worst. Mediated entirely by textual survival: "when the constraint survives the summary, violation remains 0%, but when it is dropped, violation reaches 38%" |
| `/workspace2/3 Resources/Sources/Lost in Compaction (Wang et al 2026).md` | `evidence: preprint`, `confidence: low` | "Current compactors retain only **17%** of injected SCs on average, and most perform worse than running the same task without compaction" |
| `/workspace2/3 Resources/Sources/Toward Reliable Context Compression for Long-Horizon Agents (Min et al 2026).md` | `evidence: preprint`, `confidence: medium` | AppWorld at the tightest budget: full context **85.7%**, summary compaction **72.8%**, FIFO **42.2%** — and the failure mode is *execution-state mislocalisation*, "agents that no longer know where they are in the task and so re-explore, repeat, and fail to terminate" |

Read the third row against this file's own "Silent, third" paragraph. That
paragraph guessed the symptom — "the observable symptom is the agent redoing
work" — from `continuedWorkNotice`'s docblock. Min measured it and named it, on
a benchmark, as the dominant failure. **The guess was right and it is no longer
a guess**, which is the whole of what changed about Option F: the argument
against it used to be a judgement about what a summariser might drop, and it is
now three independent measurements of what summarisers do drop.

Two honest limits on all three. They are unreplicated preprints, none tests
Anthropic's implementation, and none tests a **re-injected instruction file** —
which is precisely the arrangement that protects `SELF_HOSTING_NOTICE` here. The
vault's own summary of the gap is that "the choice between them is not how much
you lose but **whether the loss is recoverable**"
(`/workspace2/3 Resources/AI Context and Memory/Compaction and Context Editing.md:23`),
and a summary is the unrecoverable kind. And Chen publishes a fix — Constraint
Pinning restores violation to 0% — which is not reachable from any argv this app
emits, for the same reason `20-option-api-context-management.md` gives.

**That a compaction earlier than the CLI's own is better than the CLI's own,
given all of that.** This is the question the option now reduces to, and it is
sharper than it was. The correctness price above is being paid on this install
**today**, twenty times over, by a mechanism nobody configured. Option F does
not introduce that price. What it asks for is the authority to move the
threshold — which, on these measurements, means the authority to pay the price
*more often* in exchange for cache savings. Lowering `--autocompact` is a
request for more compactions, and more compactions is the independent variable
in every row of the table above.

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
