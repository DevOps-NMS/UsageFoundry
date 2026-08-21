# Option C — working notes as memory

The prompt tells the agent to externalise what it has learnt into a file in its
own checkout, and to treat that file — not the conversation — as what it
remembers. Nothing on the argv, nothing about the session, no CLI feature. Text.

## The strongest case

**It is the only mechanism in this survey that acts on what *enters* a
conversation, and it needs nothing from the CLI to do it.** Every other option
either removes content after the fact and pays `01-constraints.md`'s invalidation
(`T* = 19·(S/D) − 20`), or depends on a hook, a flag or an env var that a future
build may drop. This one is a sentence. `02-levers-on-the-pin.md` has no verdict
to give about it, and there is no version of Claude Code on which it stops
parsing.

**And it is the load-bearing half of three other options.**
`03-experiment-resumed-vs-fresh.md` measured that a fresh conversation is cheaper
than a resumed one **only while each cycle re-reads under about 3.9 KB — 2.5% of
what its own first cycle read**. That is a very small allowance, and a
maintained notes file is the only thing in this survey that could plausibly fit
inside it. Every "start fresh" shape — an app-assembled brief, a context guard
that opens a new session, a workflow chain of short blocks — is buying a fresh
agent that must not re-read, and this is what it would read instead.
`03-`'s own arrangement 2 already assumed it: its brief was "the previous cycle's
final text appended to a handoff file kept on disk".

**And this repository already believes the failure it addresses.**
`continuedWorkNotice` exists because a fresh agent on a branch full of work it
did not do "either redoes the work or reverts it as leftovers. Both are billed
and both look like progress" (`src/lib/settings.ts:544`–`551`), and
`priorWorkNotice` because that agent "does the first thing that task says, which
is the work it is standing on top of" (`src/lib/orchestrator.ts:4364`–`4373`).
Both are one-sentence notices about work the agent cannot see. A notes file is
the same argument carried one step further: rather than telling the next agent
that work happened, leave it what the work found.

## Shape

The text this app injects, and nothing else. `nextPrompt`
(`src/lib/orchestrator.ts:4299`) is where it lands, and the split the file
already makes decides how:

- **The instruction that has to stay true is generated**, like
  `COMPLETION_NOTICE` (`:4466`) and `NEEDS_REVIEW_NOTICE` (`:4506`) — the file
  path, the promise that the next cycle will still have it, and the rule that
  the reply must not be the notes. Generated for the reason that docblock states:
  `getSettings()` is `{...DEFAULTS, ...stored}` and the settings page PUTs the
  whole effective object, "so every `DEFAULT_*` prompt is materialised into the
  stored blob the first time anybody presses it" (`:4448`–`:4454`,
  `docs/agent/conventions.md:14`). A notes contract written as a `DEFAULT_*`
  reaches no install that has ever saved.
- **The guidance is editable**, beside `continuedWorkPrompt` in the Settings
  page's Prompts section (`src/app/settings/page.tsx:2968`–`2971`, keys at
  `:224`–`:227`) — what belongs in the notes, at what grain, for this operator's
  work. "The sentence that has to stay true is generated, and only guidance is
  editable" is the split `COMPLETION_NOTICE` already names (`src/lib/orchestrator.ts:4453`–`:4454`).

The file itself lives in the run's working directory — `workDir`, which for an
isolated run is the worktree under `.uf-worktrees` (`:6327`, re-proved contained
before every spawn at `:6729`–`:6739`). This app writes nothing: the agent does,
with the `Write` tool it already has.

## What leaves the context, and when the decision is taken

**Nothing leaves, and the decision is the model's, mid-cycle, every time it
chooses.**

That is the honest statement and it is unlike every other option here. Under this
option alone the conversation is **strictly larger**: it gains the `Write` calls
that maintain the file, their results, and any read of the file back. Nothing is
dropped, truncated, summarised or discarded. What the option is betting on is a
change in behaviour — that an agent which has written down what it learnt reads
fewer whole files afterwards, and that a *later* mechanism can therefore throw the
conversation away.

The timing that matters is therefore not when text is removed but when the file
becomes load-bearing, and that is at the boundary of the next cycle. On a resumed
cycle the conversation still holds everything and the file is redundant. On a
fresh conversation — a run picked up after a pause, a workflow chain's second
block, a retention sweep that cleared `runs.session_id`
(`src/lib/retention.ts:663`–`667`) — it is the only thing carried across.

## What it does to the prefix cache

**The instruction itself: nothing.** It goes on the tip of the conversation with
the rest of `nextPrompt`'s output, so `S = D`, `T* = −1`, and it is paid once as
a few hundred written tokens. Option B's arithmetic, at Option B's magnitude.

**The saving is second-order and this option cannot show it nets out positive.**
It has no `D`. What it claims is that the model reads less, and the best
available upper bound on that is `00-problem.md`'s proxy: 39.5% of `Read` bytes
belong to files the run never mentions again — 6.4 MB of the 35.2 MB measured,
18% of a conversation. Carried through the same chain the rest of this survey
uses (tool results are 64.2% of conversation content; `Read` is 72.1% of tool
results; visible bytes buy 4/2.67 ≈ 67% of the context growth they cause; growth
is 41.9% of a mean turn's cache read at the pooled OLS intercept of 128,271 and
slope of 1,304), that is **5.1% of the container main-thread cache-read line, or
about $84 a week** — and `00-problem.md` refuses to let it be read as more than
a bound: the proxy "cannot distinguish *wasted* from *read and understood*", and
"a file whose name never recurs may still have been the thing that decided the
next edit."

**And it cannot save by preventing duplication, because there is none.**
Verbatim re-reads — a ≥2 KB tool result whose tool, length and first 200
characters had already appeared in the same conversation — are **0.3% of
tool-result bytes**. Files are opened once and carried for ever. Any story about
notes replacing a second read of the same file is refuted by that number before
it is told.

**There is one cost it pays that is measurable, and it runs against the largest
line in the bill.** `02-levers-on-the-pin.md` established that the prefix which
moves between cycles is the `gitStatus` section of the CLI's own system prompt,
in the first block carrying a cache breakpoint — and that in the corpus, **no
handover whose previous cycle changed nothing in the repository ever re-wrote (0
of 74), and all six handovers with no repository change hit the cache**. A notes
file is a repository change. On the cycle it first appears, `Status:` gains a
line; on an isolated run, whose preamble tells the agent to "commit your work as
you go" (`src/lib/settings.ts:559`–`562`), `Recent commits` changes on every
cycle that commits it.

Priced from `00-problem.md`'s own pair: a handover that hits costs a median
$0.165 and one that re-writes costs $2.335, a difference of $2.17. Converting the
six quiet handovers in the rolling week into re-writing ones is **about $13 a
week of harm** — small against $183.69, and in the wrong direction. On this
install most isolated runs already commit and already re-write, so the exposure is
bounded to those six; on an install of read-only audits it would not be.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**DONE and `needs-review`: intact, with one hazard this option owes an answer
to.** Neither notice is dropped or contradicted — nothing is removed from the
conversation at all, so `01-constraints.md`'s "must not drop these" is satisfied
trivially. The hazard is the sentinel matcher. `cycleEnding`
(`src/lib/orchestrator.ts:4543`–`4545`) tests `DONE` and `NEEDS_REVIEW` against a
cycle's final text, alone on a line. An instruction that asks the agent to
maintain a notes file about a task, on a run whose task is about this feature, is
an instruction to write those tokens into a file — and if the same instruction
also asks the agent to *report* its notes, that file becomes final text. The
answer is in the generated half: the contract must say the reply is not the
notes. That is the same door `:4531`–`:4537` already accepts and bounds for task
text, one further in.

**`--resume`: untouched, and that is a defect rather than a neutral fact.** The
session lifecycle is decided by one local (`sessionId`, `:6319`) and this option
does not touch it, so on a resumed cycle the notes are pure overhead — the
conversation already holds everything they contain. Under this option alone, the
file is only ever *used* on the three occasions a fresh conversation opens
(`:4330`; the cases enumerated in `00-problem.md`). It is written on every cycle
and read on few.

**Retention: it writes into a store that already has a sweep, and there are two
distinct outcomes.** An uncommitted notes file lives in the run's checkout under
`.uf-worktrees`, one of the three stores (`docs/agent/retention.md:8`); the
checkout sweep "removes a *directory* and never a ref", so an uncommitted file
goes with the worktree and a committed one survives on the branch. That second
case is the real cost: a committed notes file is in `runDiff`
(`src/lib/diff.ts:326`), in the review the operator reads, and in what
`land.ts` merges. **The agent's memory becomes part of the deliverable**, and
nothing in the landing path would strip it. No fourth store is invented, which is
`01-constraints.md`'s test — but the file is on the branch, and one branch, one
Land button is what `docs/agent/isolation-and-landing.md` governs.

## Guards and the three cost sources

**Must not touch, and does not:** `evaluateBudget` (`src/lib/budget.ts:400`)
gains no caller and its order is unchanged — `no_terminus` (`:495`), `iterations`
(`:506`), `duration` (`:518`), `run_cost` (`:525`), `run_tokens` (`:532`),
`weekly_fraction` (`:551`), `session_fraction` (`:582`). `RunGuards`
(`src/lib/settings.ts:489`) is unchanged; this is prompt text, which
`docs/agent/chat.md:10` names as the one half of a run a model may write.

**It does spend the terminus, and `01-constraints.md` names that shape by
name.** `maxIterations` counts cycles rather than money (`src/lib/budget.ts:97`),
so an agent doing housekeeping is doing it inside a cycle budget sized for the
task. A cycle spent tidying notes is a cycle not spent on the work, and the
guard cannot tell the difference. That is not a violation and it is not a
widening — it is the cost, stated in the terms the constraint uses.

**Adds to which source: none.** No figure is produced. Nothing reads the
transcripts, `runs.spent_usd` or OTLP; `telemetrySpendSince` keeps its one door
(`src/lib/orchestrator.ts:6784`).

## What the operator sees, and how they override it by hand

**Sees:** the notes file itself, in the run's checkout and — if committed — in
the diff on the run page. That is more visibility than any other option in this
survey offers, because the mechanism's entire product is a file a person can
open. And the instruction that produced it is on the run's own log: the
`iteration` event carries the whole prompt (`src/lib/orchestrator.ts:6651`–`6652`).

**Overrides:** emptying the guidance box switches the guidance off, which is the
app's standing convention — `null` / `""` / `0` all mean off
(`docs/agent/budgets-and-guards.md`). The *generated* half cannot be emptied,
which is deliberate and is the same asymmetry `COMPLETION_NOTICE` already has;
whether the whole mechanism needs its own off switch is the design decision this
option must take rather than inherit, because a contract that says "your notes
survive the next cycle" is false if the notes are not being written.

**A run already started is not reachable**, and this option is on the wrong side
of that. `settings` is read once at `src/lib/orchestrator.ts:6379` and fixed for the segment
(`:6722`–`:6723`), which is what makes every prompt on a run come from one read.
The counter-precedent is per-cycle re-resolution: `enabledPluginDirs()` at
`:6690` and the sandbox policy at `:6747`, both "because a run outlives the
plugin list it started under" (`:6686`–`:6689`). This option is the `settings`
case: an operator who turns the notes contract on mid-run reaches nothing until
the run is picked up again.

**Per run: no surface.** `RunGuards` is `permissionMode`, `isolate`, `budget`
(`src/lib/settings.ts:489`) and a prompt choice is not one of the three. This
option is install-wide, and `01-constraints.md` says that is defensible and
should be argued rather than defaulted to — the argument here is that a notes
contract is about how this operator's agents work, not about what one run may do.

## How it fails, and whether loudly

**Loud: nothing.** There is no flag to be dropped and no schema to mismatch. On
every CLI build, a sentence is a sentence.

**Silent, and it is the failure that matters here: the agent quietly stops
maintaining the file, and nothing checks.** No hook fires, no exit code changes,
no event is written. A run whose notes went stale at cycle 3 looks exactly like
one whose notes are current — and if this option is carrying an option that
*discards* the conversation, the next fresh cycle opens against a stale file and
re-derives from nothing. `03-`'s arrangement 2b is what that costs: **2.59× the
resumed arrangement** when the fresh agent re-reads everything, against a lead
that is spent at 3.9 KB.

That failure has a shape this repository already refuses elsewhere. `--plugin-dir`
not surviving `--resume` was answered not by detection but by making the correct
shape the default (`src/lib/orchestrator.ts:4828`–`4831`, `:6701`) plus a line on
the run's own log when a directory drops out (`:6691`–`:6698`). There is no
equivalent default here — the agent either writes the file or it does not — so
the only available answer is detection: a check between cycles that the file
exists and moved, and a line on the run's log when it did not. That check is part
of the option rather than a follow-up, for `01-constraints.md`'s reason: "a
mechanism whose effect is invisible in the log is one whose misbehaviour reads as
the agent being stupid."

**Silent, second:** the notes are *wrong* rather than absent. A file that
confidently records a conclusion the run later abandoned is worse than an empty
one, because the next cycle believes it. Nothing in this app reads the file, so
nothing could ever say so.

## What it costs to build

**Files touched:** `src/lib/orchestrator.ts` (one generated notice in
`nextPrompt`), `src/lib/settings.ts` (one `DEFAULT_*` and one key),
`src/app/settings/page.tsx` (one `PromptFold` in the Prompts section),
`src/app/api/settings/route.ts` (one key on the wire). If the staleness check
above is built: one `existsSync`/`statSync` between cycles in the run loop and one
`log()` call.

**Invariants at risk:** four. The `DEFAULTS` materialisation rule
(`docs/agent/conventions.md:14`) decides which half is generated and which
stored, and getting it backwards means the contract reaches no saved install.
`saveSettings` storing only what differs from `DEFAULTS`
(`src/lib/settings.ts:693`) must hold for the new key. The sentinel hazard above
is a real path from prompt text to `cycleEnding`. And the committed-notes case
touches `docs/agent/isolation-and-landing.md`'s territory without asking it
anything.

**It earns no test under `CLAUDE.md`'s bar as specified, and one if the
staleness check is built.** The bar is a pure function whose failure mode is
silent (`docs/agent/testing.md`). Composed prompt text is data, and `nextPrompt`
is already exercised. A staleness predicate — "did this path change during this
cycle's window" — *is* a pure function, and both its failure modes are silent: a
false negative writes a warning on every healthy run until it is ignored, and a
false positive is the option's whole safety net not existing.

## What would have to be true

**That something else in the survey discards a conversation.** Alone, this option
adds text and removes nothing, so its only route to a saving is behavioural and
its own upper bound — $84 a week, on a proxy that refuses to be an oracle — is
not something it can claim. Paired with a mechanism that opens a fresh session,
it is the difference between `03-`'s arrangement 2a and 2b, which is the
difference between 2.9% cheaper and 2.59× dearer.

**That a model asked to keep notes keeps them.** Nothing here measures that.
`03-` did not measure it either — "no model answered any of the five questions;
the recorder returned fixed strings" — so the compliance rate, the grain the
agent chooses and whether the notes are any good are all unmeasured, on an option
whose entire value is those three things.

**And the fact that most weakens it, stated plainly:** the money is not in
re-reading, because re-reading barely happens. 0.3% of tool-result bytes are
verbatim repeats. The conversation is expensive because files are opened once and
carried for ever, and a notes file does not stop the first read — it can only
make a *discarded* conversation survivable. That makes this an enabling option
rather than a saving one, and a survey that scores it on its own numbers will
find almost nothing there.
