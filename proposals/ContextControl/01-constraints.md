# What a context-control option has to survive

Not preferences. Each of these is a property of the running system, or a number
out of `00-problem.md`, that an option either respects or breaks — and most of
them break *silently*, which is the standing complaint this repository records
about every defect it has found (`CLAUDE.md`, "Before you edit"). Read them
before the options, because the first one alone rules out most of the shapes
that read as obvious.

## The prefix cache is the whole problem

Everything a conversation carries is cached as one ordered prefix. Change
something at position *p* and every cached token after *p* stops matching:
content that would have come back at 0.1× the model's input rate returns at 2.0×
as a fresh one-hour write (`src/lib/pricing.ts:16`–`18`; the one-hour class,
never the five-minute one, because `00-problem.md` measures 26,194 turns in
which every main-thread turn wrote 1h and not one wrote 5m).

**So a saving is only a saving net of the invalidation it causes**, and that is
an arithmetic question with an answer rather than a warning.

Write the conversation as a prefix *P* that stays matched, plus a suffix *S*
after the cut point. An option that removes *D* tokens out of *S* pays and saves,
in units of the model's input rate per token:

- **once**, on the next request: `0.1·P + 2.0·(S−D)` instead of `0.1·(P+S)`, so
  an extra `1.9·S − 2·D`;
- **per turn thereafter**: `0.1·D` less.

Which gives the break-even, in further turns of the same conversation:

    T* = 19·(S / D) − 20

Read it twice, because both halves are load-bearing. It does not depend on the
model — the multipliers are ratios of one rate — so it is the same number on
Opus, Sonnet and Haiku. And it depends on *S/D* rather than on the absolute
sizes: **what matters is not how much an option removes, but how much it leaves
standing after the cut.** A mechanism that drops a tool result from the middle of
a long conversation has left almost all of *S* behind it and is paying nearly
the full invalidation for a small *D*.

The step that says the whole of `S−D` is *written* rather than partly re-read is
not an assumption about the API: it is the shape `00-problem.md` observed at
every re-writing handover, where a turn reads the 15,903-token shared base and
writes everything above it (`read 15903 write 300560` on a 193-turn session,
twenty seconds after the previous turn). Where the CLI places its cache
breakpoints is its own business; what the transcripts record is that on this
install a broken prefix costs the whole suffix.

Priced from the measurement. `00-problem.md` gives a mid-life long session
carrying a mean 229,059 cache-read tokens at its fifth decile, over a base
prefix of 15,903 tokens that stays warm across sessions, so `S ≈ 213,156`. At
`claude-opus-5`'s $5 per million input tokens (`src/lib/pricing.ts:38`):

| what an option removes | cost, once | saved per turn | break-even |
|---|---|---|---|
| half the suffix (106,578 tok) | $0.96 | $0.053 | 18 further turns |
| a tenth of it (21,316 tok) | $1.81 | $0.011 | 170 further turns |

**An option that removes a tenth of a mid-life conversation has to be followed by
170 more turns before it has paid for itself**, and `00-problem.md`'s turn-index
bands show only 807 of 11,422 turns living past index 160 at all. That is the
bar. An option is not obliged to clear it in this shape — but it is obliged to
say which shape it is in.

**There is exactly one moment where an edit is free, and it is the moment
`00-problem.md` found the money at.** On a work-cycle handover that re-writes —
79 of 108 in the measured window, a median 231,644 tokens at $2.32 — the suffix
is written again at 2.0× whether or not anything changed. Removing *D* tokens
immediately before such a handover therefore has **no invalidation cost at all**:
the write shrinks from `2.0·S` to `2.0·(S−D)`, an immediate saving of `2·D`
— $1.07 for the half-suffix row above — and the per-turn saving accrues on top
from the first turn. The same edit taken one turn earlier, or on one of the 29
handovers that hit the cache, costs the full `1.9·S − 2·D`.

An option therefore owes an answer to one question before any others: **where in
the cycle does it act, and is the prefix it is about to invalidate one that was
going to be invalidated anyway?** An option that cannot tell the two apart is
proposing to pay $1.81 for a $0.011-a-turn saving three times out of four.

Two smaller pricing facts the arithmetic must not hard-code. The rate is
date- and speed-aware — Sonnet 5's introductory pricing ends 2026-09-01
(`src/lib/pricing.ts:68`–`69`) and fast mode is a separate table at 2× for two
Opus entries (`:62`–`:66`). And `resolvePrice` returns `null` for a model the
table cannot place (`:115`–`:133`), where `costOf` reports 0 and `guardCostOf`
charges `UNKNOWN_MODEL_PRICE` at $10/$50 (`:84`, `:194`–`:199`). A surface that
claims "this saved $X" on an unpriced model would claim it saved nothing.

## A context mechanism is not a back door to a guard

`docs/agent/chat.md:10` states the split this app runs on: "guards decide what an
agent *may* do and prompts decide what it is *asked* to do", and prompt text is
"the one half of a run a model may write". `RunGuards` is the app's own name for
the other half (`src/lib/settings.ts:489`) — `permissionMode`, `isolate`,
`budget` — and it comes from a template, the run form, or
`settings.chatDefaultGuards` (`src/lib/settings.ts:477`), never from anything a
model emitted (`src/lib/db.ts:367`, `:616`, `src/lib/workflows.ts:1345`).

A context mechanism sits on the prompt side by construction: it decides what text
reaches the model. That is the permission it has, and the boundary is worth
stating because the failure is not the obvious one. Nothing on any wire here
would carry a `budget` field written by a summariser. The failure to design
against is a mechanism whose effect on the conversation *changes what a guard
means*:

- **`maxIterations` counts cycles, not money** (`src/lib/budget.ts:97`). An
  option that makes each cycle cheaper does not buy more cycles; an option that
  makes an agent re-derive what it dropped spends the terminus, and the terminus
  is the one thing `docs/agent/budgets-and-guards.md` says must stay monotone —
  `maxIterations` is nullable only alongside `maxDurationMinutes`
  (`src/lib/budget.ts:87`–`91`, refused as `no_terminus` at `:494`–`:496`).
- **`--max-budget-usd` is derived per cycle** as `max(0, maxRunCostUSD −
  spentGuardUSD)` (`src/lib/orchestrator.ts:4880`–`4882`). A mechanism that
  shrinks the conversation makes that remainder go further in turns. That is not
  a violation and it is not a widening; an option claiming a run limit "goes
  further" is describing exactly this and should say so in those words.
- **The check order is fixed** — terminus, cycles, duration, run spend, weekly,
  then session (`CLAUDE.md`, `docs/agent/budgets-and-guards.md`) — and nothing
  about a context decision may reorder it or add a rung to it.

One further line follows from the same split, and it is the one an option that
asks a *model* to decide what to drop has to answer. Deciding what an agent is
told is a prompt-side act; deciding what it is *permitted to have forgotten* is
not obviously one. An option in that shape has to argue why a model choosing to
discard the paragraph that carried a safety instruction is different from a model
choosing its own permission mode, and "it is only text" is not the argument —
`SELF_HOSTING_NOTICE` is only text too, and `src/lib/orchestrator.ts:4719`–`4731`
records two runs killed by a literal in it.

## The two endings must survive every cycle

`COMPLETION_NOTICE` (`src/lib/orchestrator.ts:4466`) and `NEEDS_REVIEW_NOTICE`
(`:4506`) are the whole contract by which a run can end for a reason rather than
by exhausting a cap, and both reach the agent as **generated** text on every
cycle bar the operator's own follow-up (`nextPrompt`, `:4330`–`:4361`).

Three properties, each with the measurement or the invariant behind it.

**They are generated, not stored, and that is load-bearing.** `getSettings()` is
`{...DEFAULTS, ...stored}` and the settings page PUTs the whole *effective*
object on Save, so a sentence added to a `DEFAULT_*` prompt is dead on every
install whose operator has ever pressed the button (`src/lib/orchestrator.ts:4448`–`4454`,
`docs/agent/conventions.md:14`). Any context mechanism with configuration of its
own inherits that rule: it must not be written out whole.

**Dropping them is expensive in a way that is already measured.** Before
`COMPLETION_NOTICE` existed, cycle 1 was judged against a protocol it had never
been given, and the docblock records the count: of the runs whose budget allowed
a second cycle, 92 of them cost $162 to say one word into a re-sent conversation
(`src/lib/orchestrator.ts:4436`–`:4446`). An option that drops, summarises or
rewrites turns must not
drop these, and must not contradict them: `NEEDS_REVIEW_NOTICE` says "work you
have not attempted is not a wall", and a summariser that replaces a cycle's
evidence with a paragraph is manufacturing exactly the ambiguity that sentence
exists to refuse.

**And the matcher runs over generated text.** `cycleEnding`
(`src/lib/orchestrator.ts:4543`) tests both sentinels against a cycle's final
text, alone on a line, with the two spellings deliberately different so a task
quoting the *status* cannot fire it. A mechanism that writes a summary back into
the conversation is writing text that this app will later read for those tokens.
It has to say what stops a summary of a run about this feature from ending the
run — the same hazard `:4531`–`:4537` accepts and bounds for task text, one door
further in.

## `--resume` needs a file another sweep is entitled to delete

The conversation this proposal is about lives in exactly one place: a `.jsonl`
under `~/.claude/projects`, written by the CLI, on the operator's own bind mount.
`retention.ts` already removes them.

`expiredTranscripts` (`src/lib/retention.ts:528`) is pure, unit-tested, and takes
a horizon plus a `keepSessions` set built from every non-terminal run and every
chat thread (`resumableSessions`, `:590`). `transcriptRetentionDays` defaults to
30 (`src/lib/settings.ts:633`). When a file goes, the sweep clears
`runs.session_id` on the terminal runs it belonged to (`:663`–`:667`), because
"`--resume` against a file that is gone fails the first cycle of a pick-up
outright, where a null session id is already the documented restart"
(`docs/agent/retention.md:12`).

Two constraints fall out.

**A scheme that treats session files as disposable is on the other side of that
decision and has to say so.** `docs/agent/retention.md:8` states the rule the
whole module is built on — a run's row is permanent, everything behind it is
evidence with a horizon — and the transcript is not merely evidence: it is the
only thing `--resume` can continue. Any option that edits, truncates or rewrites
a transcript in place is doing surgery on the one artefact whose loss the app
already treats as a restart.

**And a scheme that keeps its own copy has invented a fourth store.** There are
three today, on three media with three horizons and three separate sweeps
(`docs/agent/retention.md:8`). A summary cache, a dropped-content archive or an
index of what was elided is a fourth, and it needs its own horizon, its own
liveness question asked of the database rather than of a file's age, and its own
line in the storage report — or it is the store that fills the disk holding
`.credentials.json` (`src/lib/retention.ts:518`–`:521`).

## Three cost sources, and this is a fourth reading of one of them

`docs/agent/architecture.md:10` and `CLAUDE.md`: three data sources, never summed
or mixed in the UI. OTLP telemetry "must never reach `buildSnapshot()` or
`runs.spent_usd`", and reaches a budget decision through exactly one door.

Everything in `00-problem.md` is a **fourth reading of the transcripts** — the
same files `buildSnapshot()` walks (`src/lib/transcripts.ts:406` →
`src/lib/windows.ts:669`), read for *composition* rather than for cost. That is
an addition to one source, not a new source, and it stays that way only if three
things hold.

- **A composition figure must say which source it read**, and sit inside that
  source's band. No figure, meter, badge, total or comparison is drawn at region
  level (`docs/agent/conventions.md:46`), which on the dashboard is the never-sum
  rule made structural. A card reading "context carried: 17.1M tokens" belongs
  in the transcripts band beside the windows, never beside the OTLP card and
  never above both.
- **It must not become a second door out of OTLP.** OTLP has a `model` column
  and first-party per-request cost, and it collapses the 5m/1h cache split
  (`docs/agent/architecture.md:10`) — which is precisely the distinction the
  handover measurement turns on, so it could not answer this question anyway.
  An option that reaches for it is widening a door that is narrow on purpose.
- **`runs.spent_usd` cannot corroborate any of it.** It is a floor of what the
  CLI reported for work cycles, excludes reviews (`src/lib/db.ts:206`–`211`) and
  carries no composition at all. An option that promises the operator a
  before-and-after on the run row is promising a number that source does not
  hold.

One honest consequence: this proposal's own central figures are not readable from
inside a work cycle either. `00-problem.md` derives everything from the
transcripts because `/data` is root-owned 0700 by design
(`docker-compose.yml:35`–`36`). Any option whose validation plan requires reading
`runs` is proposing work only an operator can do.

## The pin, and which failures are silent

This app's argv was captured against one CLI build — `@anthropic-ai/claude-code@2.1.226`
(`docs/agent/agents-and-templates.md:12`) — and `docs/verification.md:630`
carries the standing list of what has *not* been checked by hand. Every lever an
option proposes must say what happens on a build that does not have it, and
whether that failure is loud or silent.

The tree already holds the four shapes, and the difference between them is the
whole point:

- **Silent, and the reason the current design is what it is.** `--plugin-dir` is
  not restored by `--resume`, so a version that sent it only on the opening cycle
  would leave every later cycle without the plugins — "silently, since a session
  missing a hook behaves exactly like one that never had it"
  (`src/lib/orchestrator.ts:4828`–`4831`). The answer was not detection; it was
  to rebuild the whole argv per cycle (`:6701`) so the shape is correct under
  either answer, plus a line on the run's own log when a directory drops out
  (`:6691`–`:6698`).
- **Silent, and caught only by making the empty case a state.** A sandbox policy
  with nothing in it hands the command back unwrapped and
  `sandbox.failIfUnavailable` does not catch it, "a sandbox nothing was asked of
  is not one that failed" — which is why `SandboxPolicy` carries an explicit
  `unconfined` variant with a reason rather than an empty array
  (`src/lib/orchestrator.ts:4891`–`4905`).
- **Loud, by moving the failure earlier.** An `--agents` member the CLI will not
  register used to cost a run its specialist at exit 0 with nothing on stderr;
  named on `--agent` it now fails the spawn outright, exit 1 before any API call
  (`docs/agent/agents-and-templates.md:12`, which carries the whole measurement;
  the closing pass found the second citation this line used to carry,
  `docs/agent/architecture.md:131`, to be the four-kinds-of-child paragraph,
  which says nothing about it).
- **Loud, because the app checks rather than assumes.** `enabledPluginDirs()`
  re-proves every stored path contained at the moment it is used
  (`src/lib/plugins.ts:359`, called at `src/lib/orchestrator.ts:6690`).

So the bar is not "the lever works on the pin". It is: **on a build where the
lever does nothing, does the run get quietly more expensive, or does something
say so?** An option whose whole mechanism is a flag that a future CLI ignores is
proposing a saving that evaporates without a symptom — and `00-problem.md`
measures the symptom it would have to be found by, which is a per-turn cost curve
nobody currently plots.

One further thing the pin owes this proposal specifically. `00-problem.md`
establishes that 79 of 108 work-cycle handovers re-wrote a prefix that a
one-hour TTL had not expired, that 29 did not, and that the difference is
neither the clock, the CLI version nor the process boundary. **What changed in
the prefix is now known, and it is the second of the two possibilities this
paragraph used to hold open.** `02-levers-on-the-pin.md` reads two cycles of one
session off the wire and finds the divergence in the CLI's own environment
block: the `gitStatus` section of the system prompt, regenerated per cycle, in
the first block carrying a cache breakpoint. Nothing on this app's argv stops it
changing, so the one-line fix worth $183.69 a week is not there.

What *is* there is `--exclude-dynamic-system-prompt-sections`, which moves the
volatile section out of the 27 KB system block into a 1.4 KB block of the first
user message — still ahead of the only breakpoint in that message, so the
conversation is still written again. It saves about 7.6 KB of prefix per
re-writing cycle against a median 231,644 written tokens. An option may build on
that, and must not describe it as fixing the handover.

## What the operator must still see, and still be able to override

Today every string this app injects is visible and editable in one place: the
**Prompts** section of the Settings page, whose lede is "What this app says to
Claude, over and above the task you type"
(`src/app/settings/page.tsx:2968`–`2971`), holding `continuationPrompt`,
`donePushbackPrompt`, `isolationPreamble` and `continuedWorkPrompt` (`:224`–`:227`).
The generated notices are deliberately not there, for the `DEFAULTS` reason
above.

Five things any option owes that arrangement.

1. **Off must be expressible, and must be the default until it is not.**
   `null` / `""` / `0` all mean "off" across this app's settings, and only an
   explicit `null` asks for the uncapped variant of anything
   (`CLAUDE.md`, `docs/agent/budgets-and-guards.md`). A context mechanism that
   cannot be switched off is a change to what every run is, not a setting.
2. **A Save must store only what differs from `DEFAULTS`**
   (`src/lib/settings.ts:693`, `docs/agent/conventions.md:14`). A mechanism with
   a settings-shaped configuration written out whole kills every future default
   on that install — the failure that measurement records, where a stored
   `"maxConcurrentRuns": null` put itself back over the shipped 4 on every read.
3. **What was actually sent must stay on the run's own log.** The `iteration`
   event already carries the whole prompt — `payload: { n: iterations, prompt,
   resuming: sessionId }` (`src/lib/orchestrator.ts:6648`–`6653`) — so an
   operator can read exactly what cycle 4 opened with. An option that changes the
   *conversation* rather than the prompt has no equivalent surface today, and
   inventing one is part of the option rather than a follow-up: a mechanism whose
   effect is invisible in the log is one whose misbehaviour reads as the agent
   being stupid.
4. **A per-run override needs a surface, and the run form is where a person
   disagrees.** `RunGuards` is what the form already carries; a context choice is
   not one of the three, so an option putting it there is widening that record and
   has to say so. The alternative — install-wide only — is defensible and should
   be argued rather than defaulted to.
5. **A run already started must be reachable, or the override is not one.** The
   row is read once before the cycle loop opens (`src/lib/orchestrator.ts:6278`,
   `for (;;)` at `:6412`), so a setting changed mid-run reaches nothing until the
   run is picked up again. Two things in that loop *are* re-resolved per cycle
   and are the precedent to follow: `enabledPluginDirs()` at `:6690` and the
   sandbox policy at `:6747`, both with the same stated reason — "a run outlives
   the plugin list it started under" (`:6686`–`:6689`). `settings` is the
   counter-precedent, read once at `:6379` so that what comes off it is fixed for
   the segment (`:6722`–`:6723`). An option must say which of those two it is.

## What falls out as criteria

Whether the option can name *where in the cycle* it acts, and whether the prefix
it invalidates was going to be invalidated anyway — because `T* = 19·(S/D) − 20`
is the difference between an immediate saving and a 170-turn wait. Whether it
stays on the prompt side of the split without becoming a way for a model to
decide what an agent may forget. Whether the DONE and `needs-review` contracts
survive it unaltered and uncontradicted. Whether it needs the transcript file to
be something other than what retention already treats it as. Whether every figure
it puts on a page says which of the three sources it read. Whether its failure on
an unpinned CLI is loud, or merely more expensive. And whether an operator can
switch it off, see what it did on the run's own log, and disagree with it on a
run that is already moving.
