# Recommendation

**Build Option A — the per-cycle composition readout — plus two repairs that are
owed whichever way the question goes. Build nothing else until somebody has run
`03-experiment-resumed-vs-fresh.md` against a live model.**
`04-option-see-it.md`.

That is a recommendation against every mechanism this proposal was opened to
consider, and it is reached from the measurement rather than from caution. The
survey found one real, identified waste; it also found that no lever this app
holds reaches the mechanism behind it, and that the largest option aimed at
routing around it is a bet on a quantity nobody has measured. The honest response
to that is an instrument, not an actuator.

## First, the prize, stated the way the measurement allows

**82% of this install's bill being carried context is not 82% of it being
waste.** `00-problem.md`'s headline is 61.8% cache reads plus 20.5% one-hour
cache writes, re-measured by the closing pass at 62.1% and 20.0%. A cache read is
billed at **0.1× the model's input rate** (`src/lib/pricing.ts:16`). That number
is the discount, not the bill.

Priced from this install's own week, container main thread:

    cache read total 3302633430 tok = $1651.32     (at 0.1x, src/lib/pricing.ts:16)
    the same tokens as fresh input                 = $16,513.17
    the container's whole main-thread bill         = $2,700.14

Every one of those 3.3 billion tokens would have been sent as input on some turn
anyway — that is what a conversation is. **The prompt cache is saving this
install roughly $14,860 a week, which is five and a half times the bill it
appears inside.** An option that shortens a conversation is not clawing back the
62.1%; it is declining a tenth of it and paying a fresh one-hour write at 2.0×
for the privilege, which is exactly what `01-constraints.md:32`'s
`T* = 19·(S/D) − 20` prices.

And `03-experiment-resumed-vs-fresh.md` measured what happens when the discount
is refused outright. Its headline is the unwelcome one: a fresh conversation per
cycle that re-reads the five files its predecessor read is **2.59× dearer** than
one resumed conversation, and the fresh arrangement's whole lead is spent once
each cycle re-reads about **3.9 KB — 2.5% of what its own first cycle read**.

So the number to work from is not 82%. It is this:

| | |
|---|---|
| The one identified waste | a work-cycle handover re-writing a conversation nothing changed |
| Its size, re-measured over the rolling week to 2026-08-21 | **$173.95**, 26.3% of the container's cache-write line, 72 of 99 continuation openings |
| Its size if *every* handover behaved like the 27 that hit the cache | 99 × $0.171 = $16.93, so the whole prize is **$163.74 a week** |
| Against the container's main-thread bill | **6.1%** |
| What the largest option in the survey could take of it | 72 × ($2.398 − $0.286) = **$152.06**, and only if the fresh agent re-reads nothing |
| What the one flag aimed at the mechanism takes | **$1.44 to $5.02**, on the two readings in `14-option-move-the-volatile-prefix.md` |

**Six per cent, once, in the variant that `03-` says "cannot answer Q2 through Q5
at all — the files are not in its context".** That is the prize this survey is
weighing, and it is the reason the answer is what it is.

## The case for the readout, from the measurement rather than from caution

`00-problem.md` set out to find whether a context mechanism would pay for itself
and measured four things that say not yet.

**The waste is real and its cause is out of reach.**
`02-levers-on-the-pin.md` found what changes across a re-writing handover by
reading two cycles off the wire, and the closing pass re-ran the same probe and
got the same answer: the `gitStatus` section of the CLI's own system prompt,
regenerated per cycle, inside the 27 KB `sys[2]` block that sits first after the
tool definitions and carries a cache breakpoint. Two status lines and one
`Recent commits` entry re-write the whole conversation after it. Nothing on this
app's argv stops that block changing, and this app's isolated runs are told to
commit (`src/lib/settings.ts:559`–`:562`).

**Every option's prize is a ceiling on a proxy, and the survey says so twelve
times.** `16-comparison.md`'s prize row tops out at +2, and the +2 is a bet. The
$213-a-week ceiling behind Option E, the $84 behind C, I and L, and the $152
above all descend from the same figure — 39.3% of `Read` bytes belong to files a
run never mentions again — which `00-problem.md` refuses to let anyone treat as
an oracle: "a file whose name never recurs may still have been the thing that
decided the next edit."

**The app's own contribution to the problem is three orders of magnitude too
small to matter.** Everything this app writes into a ten-cycle run is 19,927
bytes, about 4,982 tokens, re-measured to the byte by the closing pass. The
median long session carries 17.8 million cache-read tokens. `00-problem.md`
wrote the verdict before the survey opened and it held: "Any option that proposes
to shorten these strings is optimising the wrong three orders of magnitude."

**And nothing in this app can currently tell a $2.40 handover from a $0.17 one.**
That is `00-problem.md`'s closing sentence and it is still true: "the cycle that
paid $2.34 to open with *Continue working on the task* and the one that paid
$0.17 for the same sentence are the same row." Six of the twelve option files
name Option A's readout as the thing that would let them be scored. Option D says
it outright: "This option needs Option A's readout in order to be evaluated, and
does not supply it."

Against all of that, Option A is the only option in the survey that waits on
nothing. `scanUsage()` already produces the entries
(`src/lib/transcripts.ts:406`), the `iteration` event already carries the cycle
boundaries (`src/lib/orchestrator.ts:6652`), `agentSpend`
(`src/lib/windows.ts:528`) is the shape of the function and `RunAgentCost` is the
shape of the card. The classifier is one comparison — `cacheWrite1h > cacheRead`
on the turn after a continuation prompt — and `00-problem.md` has already run it
twice.

## On "not a switch flipped on somebody else's mechanism"

The operator has said they do not want a switch flipped on somebody else's
mechanism; they want something built here that works. That is worth answering
directly rather than being quietly satisfied by the outcome.

**It is a reason to hold a bought-in mechanism to the same evidence bar as a
built one, in both directions, and this file has tried to.** Option K is one
`args.push` on a vendor flag and it scores +15, third in the table, because its
failure mode is a non-zero exit and its saving is certain. Option F is also a
vendor flag and it scores −19, because on a 200k-window model it can only lower a
threshold, its refusal is a debug line, and it hands a model the decision about
what an agent may forget. The same bar produced opposite answers, which is what a
bar is for.

**It is not a reason to build something the measurement does not support.** The
thing that would be built here — Option D or G, a brief-builder and a session
lifecycle this app decides — is the option whose entire prize is conditional on a
quantity `03-` could not measure, and whose failure mode is the one this
repository has already written down twice: a fresh agent on a branch full of work
it did not do "either redoes the work or reverts it as leftovers. Both are billed
and both look like progress" (`src/lib/settings.ts:544`–`:551`).

**And Option A is built here, entirely.** It is a pure function in
`src/lib/windows.ts`, a route, a card and a test. No flag, no hook, no
environment variable, no vendor behaviour it depends on and no CLI build on which
it stops working. It is the only option in the survey of which every one of those
sentences is true — which is an odd thing to notice about the option that changes
nothing, and it is nonetheless the answer to the constraint as stated.

## Two repairs owed whichever way the question goes

Neither is context control and both are live today.

**The context-shaping environment variables already reach every agent and nothing
records it.** `childEnv` (`src/lib/orchestrator.ts:5216`–`:5231`) copies
`process.env` and strips exactly six classes — `UF_*`, `OTEL_*`,
`ANTHROPIC_ADMIN_KEY`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `DATA_DIR`,
`NODE_OPTIONS`. `DISABLE_AUTO_COMPACT`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`,
`MAX_THINKING_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `BASH_MAX_OUTPUT_LENGTH` and
`MAX_MCP_OUTPUT_TOKENS` are none of them, and all seven are in the binary
(confirmed by the closing pass). So an install whose compose sets one is running
a different context regime from one that does not, unstripped, unrecorded and
unmentioned by any page. Two option files — `09-` and `15-` — found this
independently and each made "make the leak an explicit key" its first act.

**The CLI is already compacting these runs and this app does not know.**
`02-levers-on-the-pin.md` drove a `-p --output-format stream-json --verbose`
session — the exact shape a work cycle is spawned in — to a `PreCompact` hook
firing unprompted with `trigger: "auto"`, and found that the transcript records
no marker either way, on a session that demonstrably reached it. So a run's
conversation may already have been summarised by a model, with the two endings in
it, with no record anywhere. That is `01-constraints.md`'s "the two endings must
survive every cycle" already at risk on today's install, independent of every
option here.

Both are Phase 0 of `18-implementation-sketch.md`. The second is Option F's
observation half without Option F: a `PreCompact` hook on the `--settings`
channel, which the closing pass re-confirmed survives `--resume` where
`--plugin-dir` does not.

## The fact that would overturn it

**`03-experiment-resumed-vs-fresh.md`, re-run with a live model in place of the
recorder, on this repository, and scored on work cycles as well as on cost.**

`03-` says exactly what this needs and why it could not do it: "answer quality
was not measured, and that is the part a cheaper arrangement has to earn", and
"no model answered any of the five questions; the recorder returned fixed
strings". Its own closing section is a four-step recipe, and every input it needs
is quoted in the file. Four things must be recorded:

1. **Work cycles used**, against the resumed control. `maxIterations` counts
   cycles rather than money (`src/lib/budget.ts:97`), so a fresh arrangement that
   needs an extra cycle has spent the terminus, and on a default-budget run the
   cap is 1 (`src/lib/db.ts:156`).
2. **Actual cost**, through `scanUsage()` and `pricing.ts` over the transcripts
   the children write into the per-run `CLAUDE_CONFIG_DIR` — not arithmetic
   written for the document.
3. **Whether each arrangement answered the five questions correctly**, checkable
   by hand against the five line references `03-` quotes.
4. **Whether the prefix held**, by running the resumed arrangement in a tree that
   commits between cycles rather than a clean one. `03-` priced only the clean
   case and says so; the re-writing case is the one Option D exists for.

**If a fresh-conversation-per-cycle arrangement finishes the same task in the
same number of work cycles, with the same answers, on a tree that commits — then
the $152 is real, this recommendation is wrong, and the answer is Option G**: the
threshold form, because `03-`'s clean-case result already says the blanket form
loses on the 27% of handovers that would have hit the cache. Option A is then not
wasted; it is the instrument that scores it and the meter the threshold reads.

Cost: `03-` estimates the three runs together at single-digit dollars on
`claude-opus-5` rates. **It is the cheapest decisive thing anyone can do to this
proposal**, and it is the reason this file recommends waiting rather than
refusing.

## The runner-up, and what would make it win

**Option H — delegation as context isolation**
(`11-option-delegation-as-isolation.md`), at +17 against Option A's +20.

It has the one property Option A does not: it actually removes something. A
delegated turn's context is structurally separate — the closing pass re-ran
`02-`'s probe and got the same shape, half the tools, a fraction of the system
prompt, its own first user message, no parent history, and the parent's own
prefix byte-identical across the delegation. It is the only mechanism in the
survey that takes bytes out of the main thread without touching the main thread.
And its bytes are written at a cheaper rate: on this install every delegated turn
writes a five-minute cache at 1.25× and every main-thread turn a one-hour cache
at 2.0×, with zero exceptions in 26,254 turns.

**What it would take for it to win: two things, and the first is cheap.**

The first is `11-`'s own named unknown — whether a cycle's `--max-budget-usd`
(`src/lib/orchestrator.ts:4880`–`:4882`) bounds its delegated turns as well as
its main-thread ones. It is the single question that would most change the
option's risk, because nothing on the parent's argv bounds a delegated turn's
size and `02-`'s verdict on that is *could not establish*. One billed run with a
deliberately expensive delegation answers it.

The second is the harder one, and the closing pass made it easier rather than
harder. `11-` used to say a delegation had to displace about three mean-sized
reads before its own fixed prefix paid for itself; that divided the prefix by the
delegated cost of a read rather than by the saving, and the measured figure is
**about two-thirds of one read** — the sub-agent's tool block and system prompt
came to 46,582 bytes on the closing pass's probe, ≈ $0.073 at 1.25×, against
$0.112 saved per mean-sized read moved. So the break-even is not the obstacle.
**What remains is whether the work is separable at all.** 30.3% of `Read` bytes
in the re-measured corpus belong to files the run later edited or wrote, and
those cannot be delegated — the parent needs the contents to make the edit. The
question is what share of the other 69.7% is a question with an answer rather
than reading that *is* the work, and no measurement in this survey reaches it.

If both come back well, H is a one-sentence change to `nextPrompt` with the
readout, the card and the dashboard grouping all already built — and it should
ship beside A rather than instead of it, because A is how anyone would know
whether it worked.

**And one thing that should ship beside A if anything does: Option K.** One
`args.push`, a failure mode that is a non-zero exit before any API call, and a
certain 1% to 3% correction on the largest line in the bill. It is not
recommended on its own for the reason its own file gives — "without it this
option ships into the same blind spot `00-problem.md` opened on" — and that blind
spot is exactly what Phase 1 and 2 close. What would settle it into the
recommendation is one billed pair of cycles with and without the flag, priced
through `scanUsage()`, which also decides between the two readings of its saving.

## Rejected by name

**Option F, the budget for compaction.** Not because compaction is wrong but
because of what this particular lever does. On a 200k-window model
`--autocompact` can only *lower* the threshold — re-measured on this pin,
`--autocompact 100000` gives `effectiveWindow=80000` and `--autocompact 1000000`
gives `180000`, so `min(asked, window) − 20,000` — and the whole delta over doing
nothing is compacting earlier than the CLI already does. Where it would matter
most it refuses: "fixed prefix ~83280 > threshold 67000 — compaction cannot help"
is a debug line, and this install's opening prefix runs to 91,074 tokens at p90
and 132,919 at the maximum over 264 openings. And it is the option that most
directly hands a model the decision about what an agent may be permitted to have
forgotten, with `custom_instructions` reachable from no argv this app emits, on a
codebase where `SELF_HOSTING_NOTICE`'s docblock records two runs killed by a
literal in text that was "only text" (`src/lib/orchestrator.ts:4719`–`:4731`).
**Its observation half is kept and is Phase 0b.**

**Option I, the retrieval index.** The largest build in the survey, the only
store with no liveness question the database can answer, and the only option
whose failure is *wrong* rather than *more expensive*. It also has to answer a
question it cannot: `SEARCH_TOOLS` is `["Grep", "Glob"]`
(`src/lib/orchestrator.ts:4642`), granted on every cycle's `--allowedTools`, so
the agent already has a retrieval affordance and reads whole files anyway.
Neither tool appears in the top seven by result bytes, and `12-` is right that
either reading of that is a warning.

**Option C in its saving form.** The money is not in re-reading, because
re-reading barely happens: verbatim re-reads are 0.3% of tool-result bytes,
re-measured unchanged. Files are opened once and carried for ever. `06-` is
honest that this is "an enabling option rather than a saving one", and there is
nothing here for it to enable yet. It comes back the day Option G is built.

**`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, specifically, out of Option L.** It bounds
`res.finalText`, which is exactly what `cycleEnding` (`:4543`) matches, so a
4,096-token ceiling on a cycle that meant to summarise and then say `DONE` can cut
the reply before the sentinel — the failure `COMPLETION_NOTICE`'s docblock prices
at 92 runs and $162. And it drags `thinking.budget_tokens` from 31,999 to 4,095
with it, measured on the pin, on a fleet running `xhigh` effort on every handover
in the window. An operator who sets it to shorten replies has cut reasoning by
87% and taken the thinking decision by accident.

**Option E's fourth store, but not its hook.** The `PostToolUse` mechanism is
real — the closing pass re-ran it and the model received
`"1\tHOOK-REPLACED-THE-FILE-CONTENTS"` against a file whose contents are
`canary-line-from-disk`. What is rejected is the archive behind it: a store whose
contents are by construction the largest things the runs produced, needing its own
horizon, its own liveness query and its own line in the storage report, on the
disk that holds `.credentials.json` (`src/lib/retention.ts:518`–`:521`). If the
mechanism is ever wanted, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` is the same
act with no store at all, and that is Option L.

## What a person would have to accept to overrule this

This recommendation is "build the instrument and go and measure", and the brief
under which this proposal was written says that if the evidence lands there it
should say so in as many words. It does. But it is a judgement about a bet, not a
proof, and somebody may reasonably take the bet. To build Option G now rather
than after the experiment, a person has to accept four things, and each is
written down somewhere in this survey:

1. **That a fresh agent holding an app-built brief finishes the same task in the
   same number of work cycles.** `03-` could not test it and says so. Its scripted
   turn counts make its own headline "a floor", and it warns that a live fresh
   arrangement "would very likely take *more* turns per cycle".
2. **That spending the terminus is acceptable.** `maxIterations` counts cycles
   rather than money (`src/lib/budget.ts:97`), so a run whose cap was sized against
   a resumed arrangement gets less work done under a fresh one at the same cap.
3. **That losing the measurement is acceptable.** Under D or G,
   `resumableSessions` (`src/lib/retention.ts:590`) protects one session per run,
   so every earlier cycle's transcript falls to the 30-day sweep while the run is
   live — and those files are where every figure in this proposal comes from.
4. **That $152 a week, 5.6% of the container's bill, at the theoretical maximum,
   is worth a mechanism whose failure looks like the agent being stupid.**
   `continuedWorkNotice` names that failure and this repository has paid for it
   before: "Both are billed and both look like progress."

If somebody accepts all four, the right thing to build is **G and not D** — the
threshold, so the option declines to act where `03-`'s clean-case measurement
says it would lose — and **A first anyway**, because the threshold reads the
figure A computes and `docs/agent/metering.md` already refuses a guard with
nothing to read.

## What this recommendation does not claim

It does not claim that context control is a bad idea, or that this install's
conversations are the right length. It claims that **on this measurement, the one
identified waste is 6.1% of the bill, its mechanism is not on any lever this app
holds, and the largest option aimed at routing around it rests on a quantity
nobody has measured** — and that the honest response to a survey whose prize
column is a row of ceilings is to build the thing that would turn one of them
into a number.

It does not claim Option A saves money. It saves nothing. $173.95 a week goes on
being spent while it is deployed. What it buys is that the next person who wants
to know whether a handover cost $2.40 or $0.17 can find out, and that the
experiment that would settle this proposal has somewhere to report its answer.
