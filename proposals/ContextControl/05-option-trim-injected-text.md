# Option B — trim what this app itself injects

Shorten the text this app authors: `nextPrompt`'s standing notices
(`src/lib/orchestrator.ts:4299`), the appended system prompt
(`SELF_HOSTING_NOTICE`, `:4739`, pushed at `:4870`), and the task restatement
that opens a fresh conversation.

One correction to the framing before the case, because it changes what the third
of those is. **A resumed cycle does not restate the task.** `nextPrompt` branches
on `o.sessionId === null` at `:4330`, and the resumed branch returns
`settings.continuationPrompt` (or `donePushbackPrompt`) joined to
`NEEDS_REVIEW_NOTICE` and nothing else (`:4361`). The task, the isolation
preamble, `continuedWorkNotice` and `priorWorkNotice` are the *fresh-conversation*
branch — so "the restated task" is a cost of opening a conversation, not of
continuing one, and it lands on the same 237 openings that cost $95.74 in the
rolling week rather than on the 108 handovers.

## The strongest case

**The arithmetic is uniquely favourable, and it is the only option in this
survey of which that is true without qualification.** `01-constraints.md`'s
break-even is `T* = 19·(S/D) − 20`, where `S` is what stays standing after the
cut. Every option that removes something from the *middle* of a conversation
leaves nearly the whole suffix behind it and pays almost the full invalidation.
This one removes text that has not been sent yet: the continuation prompt is the
newest turn, so the cut point is the tip, `S = D`, and `T* = −1`. **It pays on
the request it is made on, every time, with no invalidation at all.** Nothing
else here can say that except Option E, and E needs a hook.

**It is the only lever this app holds outright.** Everything else in the survey
depends on a flag the CLI happens to parse, a hook the CLI happens to dispatch,
or a model choosing to behave. This is a string literal in a file in this
repository. `02-levers-on-the-pin.md` has no verdict to give about it, because
there is nothing to establish.

**And three of the four strings are already an operator's to shorten.**
`continuationPrompt`, `donePushbackPrompt`, `isolationPreamble` and
`continuedWorkPrompt` are text boxes in the Settings page's Prompts section,
whose lede is "What this app says to Claude, over and above the task you type"
(`src/app/settings/page.tsx:2968`–`2971`, the keys at `:224`–`:227`). So the
mechanism ships; the question this option asks is whether the *defaults* should
be shorter, which is a decision rather than a build.

## Shape

The text this app injects. Two of the three layers `01-constraints.md`
distinguishes, and neither is the conversation itself:

- **The argv.** `--append-system-prompt SELF_HOSTING_NOTICE` (`src/lib/orchestrator.ts:4870`),
  unconditional, on every cycle — 1,096 bytes, and prefix content rather than
  conversation content for the reason its docblock gives: "the task is only sent
  on the first cycle of a session and this is true of every cycle"
  (`:4710`–`:4711`).
- **The text this app injects into the prompt.** `nextPrompt`'s parts, at the
  shipped defaults, byte-exact from `00-problem.md`'s own run of them:

  | string | bytes | when |
  |---|---|---|
  | `SELF_HOSTING_NOTICE` | 1,096 | every cycle, on the system prompt |
  | `NEEDS_REVIEW_NOTICE` (`:4506`) | 639 | every cycle bar an operator follow-up |
  | `COMPLETION_NOTICE` (`:4466`) | 443 | cycle 1, gated on `endsOnDone` |
  | `SHARED_CHECKOUT_NOTICE` (`:4577`) | 679 | cycle 1, isolated run |
  | `DEFAULT_DONE_PUSHBACK_PROMPT` (`src/lib/settings.ts:534`) | 536 | after a DONE |
  | `DEFAULT_CONTINUED_WORK_PROMPT` (`:552`) | 364 | cycle 1, continued branch |
  | `DEFAULT_ISOLATION_PREAMBLE` (`:559`) | 199 | cycle 1, isolated run |
  | `DEFAULT_CONTINUATION_PROMPT` (`:516`) | 136 | every resumed cycle |

  Composed: a resumed continuation cycle is 777 bytes of prompt, a DONE pushback
  1,177, an isolated cycle 1 1,974. With the appended system prompt, **1,873
  bytes per resumed cycle and 19,927 across a ten-cycle isolated run**.

Nothing about the folder, the session lifecycle or this app's accounting
changes.

## What leaves the context, and when the decision is taken

**Between cycles, at `nextPrompt` and `buildArgs`, once per cycle** — the two
calls at `src/lib/orchestrator.ts:6608` and `:6701`, both inside the `for (;;)`
at `:6412`. Nothing leaves the context in the sense the other options mean:
nothing already in the conversation is removed, edited or replaced. What changes
is how much is added to the tip on each handover.

The one string that is *not* per cycle in effect is `SELF_HOSTING_NOTICE`. It is
rebuilt and re-sent on every cycle, but its content is identical each time, so it
sits in the prefix and is paid as prefix — which is the layer that matters for
pricing it, below.

## What it does to the prefix cache

**Nothing is invalidated. The whole of the saving is net.** The prompt is
appended after everything already cached, so removing bytes from it removes them
from the write and from every subsequent read, and pays nothing for the
privilege.

**And the magnitude is three orders of magnitude too small, which
`00-problem.md` establishes and this file does not get to soften.** At the
corpus fit of 0.374 tokens per visible byte (`00-problem.md`'s first-difference
regression), 1,873 bytes per resumed cycle is about 701 tokens. At
`claude-opus-5`'s $5 per million input tokens (`src/lib/pricing.ts:38`) and the
one-hour write multiplier of 2.0 (`:18`):

- written once, at 2.0×: **$0.0070 per cycle**;
- read back at 0.1× (`:16`) on every later turn of that cycle: **$0.00035 a
  turn**, so about $0.05 over a 140-turn cycle.

Call it **$0.06 a cycle if every byte of it were deleted**, against a median
handover write of 231,644 tokens at $2.32. The app's entire authored contribution
across a ten-cycle run is 2% of one handover.

`SELF_HOSTING_NOTICE` prices differently and slightly better, because it is
prefix rather than suffix: 1,096 bytes is about 410 tokens, read on all 16,605
container main-thread turns in the rolling week at 0.1× — **$3.41 a week** — plus
re-written at 2.0× on each of the 212 turns that wrote more than they read
(79 handovers plus 133 session openings), another **$0.87**. So the largest
single string this app injects is worth about **$4.28 a week** out of a $2,707.57
container bill: **0.16%**.

Two caveats, both against this option. Where `--append-system-prompt` lands in
the request — inside the 27 KB `sys[2]` block that carries a cache breakpoint, or
as a fourth system block — is **not established**; `02-levers-on-the-pin.md`'s
breakpoint probe did not carry the flag. Either way it is ahead of the
conversation and unchanged between cycles, so the arithmetic above holds and only
the block it is charged to is unknown. And the token conversion is an estimate:
`00-problem.md`'s own `~tokens @4B` column would give 468 tokens per cycle rather
than 701, and the true figure for text landing in a conversation is between them.

**So this option cannot show a saving worth having, and says so here.** Its case
is not the money.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

This is where the option is decided, and the answer is that the two strings it
could most usefully shorten are the two it may not touch.

**`COMPLETION_NOTICE` and `NEEDS_REVIEW_NOTICE` are 1,082 of the 1,873 bytes and
are load-bearing, with a price on record.** Before `COMPLETION_NOTICE` existed,
cycle 1 was judged by `reportedDone`'s matcher against a protocol it had never
been given, and of the runs whose budget allowed a second cycle, **92 of them
cost $162 to say one word into a re-sent conversation**
(`src/lib/orchestrator.ts:4436`–`4446`). That is $162 against this option's whole
weekly prize of roughly $6. Both sentences of the notice are named as
load-bearing in the same docblock (`:4456`–`:4464`): the first restates the
continuation prompt on purpose, because "cycle 1 and cycle 2 disagreeing about
the bar is the bug"; the second exists because "an instruction an agent cannot
satisfy produces churn rather than silence".

**`cycleEnding` matches over generated text and the two spellings are
deliberately different** (`:4543`–`:4545`), so any rewrite of either notice is a
rewrite of the contract the matcher reads. A shortened `NEEDS_REVIEW_NOTICE`
that dropped "work you have not attempted is not a wall" removes the clause
`01-constraints.md` names as the one keeping a stuck run from ending on nothing
actionable.

**`SELF_HOSTING_NOTICE` is the other string with an incident behind it.** Its
docblock records two runs killed by a literal it used to carry — `b81e7c70`
escalating to a bare `pgrep -f 3100` at 2026-08-15 23:39:42 and `9b98ddec`, a Go
run in another repository, dying in the same second with "exited with code 143"
— and the same again on 2026-08-16 (`:4719`–`:4731`). The current text is longer
*because* of that: "the mechanism is stated rather than the conclusion — an agent
told only 'do not use a bare number' reaches for a different literal"
(`:4733`–`:4737`). Trimming it is trading $4.28 a week against the incident class
that produced the string.

**`--resume`: untouched.** Nothing here changes when a session is resumed or
opened; only what the opening turn says.

**Retention: untouched.** No new store, no new horizon, no transcript surgery.
This is the only option in the survey that owes `docs/agent/retention.md`
nothing at all.

## Guards and the three cost sources

**Must not touch:** nothing here goes near `evaluateBudget`
(`src/lib/budget.ts:400`) or its order — `no_terminus` (`:495`), `iterations`
(`:506`), `duration` (`:518`), `run_cost` (`:525`), `run_tokens` (`:532`),
`weekly_fraction` (`:551`), `session_fraction` (`:582`). `maxIterations` counts
cycles rather than money (`:97`), so a cheaper cycle buys no extra cycles and the
terminus stays exactly as monotone as it is.

There is one guard interaction and it is the harmless direction:
`--max-budget-usd` is `max(0, maxRunCostUSD − spentGuardUSD)`
(`src/lib/orchestrator.ts:4880`–`4882`), so a cycle carrying six cents less makes
that remainder go marginally further in turns. `01-constraints.md` names this
shape and says an option claiming a run limit "goes further" should say so in
those words. It goes further by about $0.06 a cycle.

**Adds to which source: none.** No figure is produced, so nothing is read from
the transcripts, `runs.spent_usd` or OTLP, and there is nothing to put in a band.
This option has no display surface at all, which is also its largest defect —
see below.

## What the operator sees, and how they override it by hand

**Four of the eight strings: already visible and already editable**, in the
Prompts section (`src/app/settings/page.tsx:2968`–`2971`). An operator who wants
a shorter continuation prompt today types one.

**Four of them: deliberately not.** `COMPLETION_NOTICE`, `NEEDS_REVIEW_NOTICE`,
`SHARED_CHECKOUT_NOTICE` and `SELF_HOSTING_NOTICE` are generated rather than
stored, and the reason is the mechanism that decides how this option can ship at
all: `getSettings()` is `{...DEFAULTS, ...stored}` and the settings page PUTs the
whole *effective* object on Save, "so every `DEFAULT_*` prompt is materialised
into the stored blob the first time anybody presses it — after which editing the
constant reaches no install that has ever saved"
(`src/lib/orchestrator.ts:4448`–`4454`, `docs/agent/conventions.md:14`).

**That inverts the option.** A shortened `DEFAULT_CONTINUATION_PROMPT` shipped in
a release is dead on every install whose operator has ever pressed Save; a
shortened `COMPLETION_NOTICE` reaches every install, and is the string that must
not change. The strings this option can effectively change are the ones it may
not touch, and the strings it may touch reach nobody.

The one honest way out is `saveSettings` storing only what differs from
`DEFAULTS` (`src/lib/settings.ts:693`), which is already the rule — so on an
install that has *not* yet been bitten, a shorter default does reach the wire.
Whether this install is in that state is **not established here**: the settings
row is in a database this run cannot open (`docker-compose.yml:35`–`36`).

**What was sent stays legible either way.** The `iteration` event already
carries the whole prompt (`src/lib/orchestrator.ts:6651`–`6652`), so an operator
can read exactly what cycle 4 opened with, before and after.

## How it fails, and whether loudly

**Loud: nothing.** There is no flag to be dropped, no hook to be refused, no
schema to mismatch. On any CLI build, on any version, shorter text is shorter
text.

**Silent, and it is the whole risk of the option: a trimmed sentence changes
what an agent does, and the difference shows up as the agent being worse rather
than as a defect.** Every one of these strings exists because of a measured
failure — 92 runs and $162 for `COMPLETION_NOTICE`, two killed runs and five
blocked dependents for `SELF_HOSTING_NOTICE`, "either redoes the work or reverts
it as leftovers. Both are billed and both look like progress" for
`continuedWorkNotice` (`src/lib/settings.ts:544`–`551`). A trim that
reintroduces one of those failures costs more in a single run than the option
saves in a quarter, and nothing in `run_events`, on the run page or in the
dashboard would attribute it.

**Silent, in the other direction: an install that has pressed Save never
receives the change**, per the `DEFAULTS` mechanism above, and no page says so.
An operator reading release notes about shorter prompts and seeing no change in
their spend has no way to learn why.

## What it costs to build

**Files touched:** `src/lib/orchestrator.ts` (four string constants),
`src/lib/settings.ts` (four `DEFAULT_*` constants). No route, no component, no
schema, no migration, no new module. It is the smallest build in the survey after
Option A's readout, and smaller than that.

**Invariants at risk:** two, and both are stated above rather than discovered —
the `DEFAULTS`-materialisation rule (`docs/agent/conventions.md:14`) and the two
endings' contract (`01-constraints.md`). A third is worth naming: the string
constants are read by `orchestrator.test.ts`, so a trim that changes a sentinel's
spelling fails the suite rather than a run.

**It earns no new test under `CLAUDE.md`'s bar.** The bar is a pure function
whose failure mode is silent, and this option adds no function. `nextPrompt` is
already pure and already exercised; what would change is data it composes, and
`docs/agent/testing.md` is explicit that the existing list is the bar rather than
a convention to extend. The correct verification for a trim is not a unit test —
it is the run-level evidence that produced the string in the first place, which
is exactly what makes a trim unverifiable at this scale.

## What would have to be true

**That the case for this option is legibility rather than money**, because the
money is $4 to $6 a week and this file has shown it. There is a real version of
that case: every string here is text an operator may be asked to read while
debugging why an agent did something, and `docs/agent/chat.md`'s split makes
prompt text the one half of a run a model may write — so the shorter it is, the
easier it is to hold the whole of it in view. That argument does not need a
saving and should not borrow one.

**That an install exists which has never pressed Save.** Otherwise the four
editable strings cannot be changed from this repository at all, and the option
collapses to the four generated ones, three of which have incidents attached.

**And the fact that kills the money case, stated in its own words:**
`00-problem.md` measured this before the survey opened and wrote the verdict
down — "Any option that proposes to shorten these strings is optimising the wrong
three orders of magnitude, and that is worth establishing before the survey
rather than discovering inside it." The 4,982 tokens this app authors across a
ten-cycle run sit against a median long session's 17,079,927 carried tokens.
Nothing in this file disputes that; what it disputes is the inference that a
lever with no invalidation cost, no CLI dependency and no new failure mode is
therefore not worth pulling.
