# Option D — an app-assembled continuation brief, with a fresh session per cycle

Stop passing `--resume`. Every work cycle opens a new conversation, and this app
builds its opening turn out of what it already holds: the task, the run's own
`run_events`, the branch diff, and the previous cycle's final text.

## The strongest case

**It is the only option that acts on the largest identified line in the bill,
and the arithmetic is not close.** `00-problem.md` measures the work-cycle
handover at $183.69 in the rolling week — 27.2% of the container's cache-write
line — a median $2.32 each and $4.38 at the worst, paid by 79 of 108 handovers to
re-write a conversation whose previous turn was a median ten seconds earlier.
Against that, the opening turn of a fresh conversation costs a median **$0.294**.
Every other option in this survey argues about the contents of the conversation;
this one declines to send it.

**And `03-experiment-resumed-vs-fresh.md` already ran it — including the part
that goes against it.** On the wire, in a clean tree, a fresh cycle that re-reads
nothing is 2.9% cheaper than a resumed one and a fresh cycle that re-reads all
five files is **2.59× dearer**, with the break-even at about 3.9 KB of re-read
per cycle. That is the honest headline and it is unfavourable. But `03-` also
says, in its own last limitation, which case it did not price: "the prefix held
byte-identical across arrangement 1's cycles because nothing committed in
between. On a real run it would not, and a re-writing handover turns the resumed
cycle's 197 new bytes into the whole suffix. **That is the case in which
arrangement 2 wins**." On this install that case is 73% of handovers.

**Extrapolating `03-`'s own weighted bytes into it — this file's arithmetic, not
`03-`'s measurement** — a resumed cycle that re-writes turns its 330,431 matched
bytes from a 0.1× read into a 2.0× write, so its weighted cost goes from 33,437
to 661,256 while the fresh cycle stays at 21,404. The fresh cycle's lead becomes
about **640,000 weighted bytes**, and at `03-`'s measured 3.06 weighted bytes per
byte of file re-read that buys roughly **209,000 bytes of re-reading per cycle**
— more than the 154,679 bytes of all five files put together. In the re-writing
case, even `03-`'s worst arrangement wins.

**And the brief is not speculative: every part of it is already in this app.**
`run_events` holds the whole log, oldest first, with a `dropped` count when it is
bounded (`src/lib/orchestrator.ts:621`–`:625`). `runDiff` builds the branch diff
(`src/lib/diff.ts:326`) and `diffAsText` bounds it at a file boundary while naming
what it withheld (`:588`–`:627`), which is the shape `review.ts` already sends a
model (`src/lib/review.ts:228`, at `REVIEW_DIFF_BYTES = 60_000`, `:54`). The
previous cycle's final text is `res.finalText`, already read for `cycleEnding`
(`src/lib/orchestrator.ts:7157`) and already published as a `result` event
(`:6083`). Assembling those three into a prompt is composition, not new capability.

## Shape

**The session lifecycle, and the text this app injects.** One variable decides
which: `let sessionId: string | null = run.session_id`
(`src/lib/orchestrator.ts:6319`), read by `nextPrompt`'s branch at `:4330` and by
`buildArgs`' `--resume` at `:4874`. This option makes `sessionId` null at the top
of every cycle and gives `nextPrompt` a fourth branch — neither the fresh-task
branch nor the continuation branch, but a brief.

The brief has four parts and each has a source that already exists:

1. **The task**, verbatim, as the fresh branch already sends it (`:4340`).
2. **What has happened**, from `run_events` — cycles run, guards that fired,
   plugin directories that dropped out, the operator's follow-ups. Bounded, and
   saying so: `runEvents`' own contract is that "callers that pass a limit must
   surface `dropped` — a truncated log that does not say it is truncated is
   worse than a slow one" (`:614`–`:617`).
3. **What is on the branch**, from `runDiff` through `diffAsText`, inheriting
   its bound and its `[TRUNCATED: … their contents were NOT shown to you — say
   so rather than reasoning about them]` block verbatim (`src/lib/diff.ts:614`–`:623`).
4. **What the last cycle said**, `res.finalText` from the previous cycle,
   persisted so a restarted server can still build the brief.

`continuedWorkNotice` (`src/lib/orchestrator.ts:4401`) and `priorWorkNotice` (`:4417`) are the
one-sentence version of exactly this, already shipped for the case where a fresh
conversation is unavoidable. This option makes that case the only case.

## What leaves the context, and when the decision is taken

**Everything leaves, at every cycle boundary, and the decision is taken between
cycles by this app rather than by a model.**

That is the cleanest answer in the survey to `01-constraints.md`'s question about
who decides what an agent may forget. No model summarises anything; no model
chooses what to drop. The whole conversation is discarded and the replacement is
assembled by code, from records this app wrote itself. The prompt side of
`docs/agent/chat.md:10`'s split is where this sits, and nothing a model emitted
reaches it.

The precise moment is between `evaluateBudget` returning and `buildArgs` being
called — the same window `enabledPluginDirs()` (`src/lib/orchestrator.ts:6690`) and the sandbox policy
(`:6747`) are already re-resolved in.

## What it does to the prefix cache

**Two regimes, and which one a run is in is decided by `gitStatus` rather than by
this app.**

*When the resumed cycle would have hit the cache* — 29 of 108 handovers in the
rolling week, a median $0.165 — this option is a loss. `03-`'s clean measurement
is the price: the resumed cycle writes 197 bytes and matches 330,431; the fresh
one writes 3,204 and matches only 149,960. "It has not saved that difference — it
has *lost* it, and whether losing it is free depends entirely on whether the model
then goes and re-reads." The lead is 11,920 weighted bytes, spent at **3,900 bytes
of re-read**, which is 2.5% of what the opening cycle read.

*When the resumed cycle would have re-written* — 79 of 108, a median $2.32 — the
extrapolation above gives the fresh cycle a lead of roughly 640,000 weighted
bytes, about 209,000 bytes of re-reading. That is the case this option is for.

**Which regime a cycle lands in is knowable only after the fact.**
`02-levers-on-the-pin.md` names the mechanism — the `gitStatus` section of the
CLI's own system prompt, regenerated per cycle in the first block carrying a
cache breakpoint — and finds that no lever on this app's argv stops it changing.
It also finds the corpus consistent with it: no handover whose previous cycle
changed nothing in the repository ever re-wrote (0 of 74), and all six handovers
with no repository change hit the cache. **This app's isolated runs are told to
commit** (`src/lib/settings.ts:559`–`562`), so on this install most cycles change
the repository and most handovers re-write — which is the empirical case for
adopting this option unconditionally, and equally the case for Option G, which
makes the same decision on a threshold instead.

**Three costs `03-` measured that must be carried into any estimate.** A
**session-title turn per conversation**: the CLI names every new session, and
arrangement 2 paid four against arrangement 1's one, 2,049 → 9,164 bytes. The
brief **grows monotonically**: cycle 2's 8,402 new bytes against cycle 3's 3,204
is the handoff file being appended to, "and on a longer run that is a second
conversation accumulating beside the one that was discarded". And `03-`'s turn
counts were scripted rather than chosen — "a live arrangement 2 would very likely
take *more* turns per cycle than arrangement 1, because it starts each one
without the answer to the previous question."

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**This is the option's hardest section, and the first item is a decision this app
has already taken in the opposite direction.**

**`--resume`: abolished, and there is a branch in the code whose whole purpose is
to refuse what this option proposes.** When a resume fails twice,
`looksLikeResumeFailure` (`src/lib/orchestrator.ts:7127`) stops the run and names the manual command
rather than starting over, because "the honest move is to stop and name the
command rather than quietly start a fresh session and lose the conversation the
resume existed to keep" (`:7113`–`:7117`). `00-problem.md` states the
consequence: "Any option that proposes to discard a conversation is proposing the
thing this branch refuses to do by accident." The answer this option owes is that
there is a difference between *losing* a conversation and *replacing* it — the
refusal is about a fresh agent with nothing but the task, and the brief is the
thing that makes it not that. Whether the brief is adequate is the question `03-`
could not answer, because "no model answered any of the five questions".

**DONE and `needs-review`: cheaper and better, and this is a genuine gain.**
`COMPLETION_NOTICE` is gated on `endsOnDone` and sent on cycle 1 (`:4466`,
`:4344`–`:4348`); `NEEDS_REVIEW_NOTICE` is sent on every cycle bar an operator
follow-up (`:4506`, `:4361`). Under this option every cycle *is* a cycle 1, so
both notices arrive on every cycle rather than being carried in a conversation
where, as `COMPLETION_NOTICE`'s own docblock puts it, an agent "has been told
about DONE four times and about this once, on a turn that has scrolled out of
reach" (`:4357`–`:4361`). `cycleEnding` (`:4543`) is unchanged and still matches
over a cycle's own final text.

The hazard is the mirror image and it is real: the brief carries the previous
cycle's final text, and a cycle that ended by *quoting* the protocol puts that
text into the next cycle's opening turn. The matcher only reads final text, so
this is not an ending fired by accident — but `:4531`–`:4537` records why the two
spellings differ on purpose, and a brief-builder is a second door into the same
room.

**Retention: no fourth store, and one silent breakage.** The brief is assembled
from `run_events`, which already has a horizon — `eventRetentionDays`, default 30
(`src/lib/settings.ts:631`, swept at `src/lib/retention.ts:131`–`:137`) — and
from the branch, which is git's. Nothing new is stored, which is
`01-constraints.md`'s test, and this option passes it cleanly.

The breakage is elsewhere and is not obvious. `adoptSession` writes
`runs.session_id` the moment the stream names a session (`src/lib/orchestrator.ts:6357`). Under this
option that column is overwritten every cycle, so it names **the last cycle's
conversation and no other** — and three things read it as though it named the
run. `reconcileKilledCycle` bounds a killed cycle's spend estimate by it
(`:6254`), which stays correct because it also bounds by time. `GET
/api/runs/[id]/agent-cost` bounds by it from `run.created_at`
(`src/app/api/runs/[id]/agent-cost/route.ts:46`–`:52`), which would silently
report only the final cycle's split under a heading saying it describes the run.
And `resumableSessions` (`src/lib/retention.ts:589`–`:615`) builds
`keepSessions` from one `session_id` per run, so **every earlier cycle's
transcript falls to the 30-day sweep while the run is still live** — which under
this option is harmless for resumption and destructive for measurement, since
those files are where `00-problem.md`'s every figure comes from.

## Guards and the three cost sources

**Must not touch:** the check order is fixed and gains nothing —
`no_terminus` (`src/lib/budget.ts:495`), `iterations` (`:506`), `duration`
(`:518`), `run_cost` (`:525`), `run_tokens` (`:532`), `weekly_fraction` (`:551`),
`session_fraction` (`:582`). `--max-budget-usd` stays derived per cycle as
`max(0, maxRunCostUSD − spentGuardUSD)` (`src/lib/orchestrator.ts:4880`–`4882`).

**It spends the terminus, and that is the guard interaction to state plainly.**
`maxIterations` counts cycles, not money (`src/lib/budget.ts:97`). A fresh agent
that re-derives what the conversation held uses turns, and if it uses enough of
them it uses a cycle — so a run whose ten cycles were sized against a resumed
arrangement may finish less work under this one at the same cap.
`01-constraints.md` names this exactly: "an option that makes an agent re-derive
what it dropped spends the terminus, and the terminus is the one thing
`docs/agent/budgets-and-guards.md` says must stay monotone."

**Adds to which source: none, and it cannot be corroborated on any of them.**
No new figure is produced. And an operator asking "did this save money" has
nowhere to look: `runs.spent_usd` is a floor of what the CLI reported and carries
no composition (`src/lib/db.ts:206`–`211`), OTLP collapses the 5m/1h cache split
which is the distinction the whole comparison turns on
(`docs/agent/architecture.md`), and the transcripts — the one source that could
answer — are exactly what the retention breakage above prunes. **This option
needs Option A's readout in order to be evaluated**, and does not supply it.

## What the operator sees, and how they override it by hand

**Sees: more than under any other option here, for free.** The brief *is* the
prompt, and the `iteration` event already carries the whole prompt —
`payload: { n: iterations, prompt, resuming: sessionId }`
(`src/lib/orchestrator.ts:6651`–`6652`). So an operator can read exactly what
cycle 4 opened with, including the diff excerpt and the log summary, on the run's
own page, with no new surface at all. `01-constraints.md`'s third obligation —
"a mechanism whose effect is invisible in the log is one whose misbehaviour reads
as the agent being stupid" — is satisfied by construction, because this option
changes the prompt rather than the conversation. `resuming: sessionId` going null
on every cycle is itself the readout that the mechanism is on.

**Overrides:** a setting, off by default until it is not — `null` / `""` / `0`
all mean off (`docs/agent/budgets-and-guards.md`), and `saveSettings` must store
only what differs from `DEFAULTS` (`src/lib/settings.ts:693`).

**Per run:** the run form carries `RunGuards` — `permissionMode`, `isolate`,
`budget` (`src/lib/settings.ts:489`) — and this is not one of the three. Putting
it there widens that record and has to be argued for; the alternative,
install-wide only, is coherent here because the choice is about how this
operator's runs are shaped rather than about what one run may do.

**Mid-run:** it must be the per-cycle case rather than the `settings` case.
`settings` is read once at `src/lib/orchestrator.ts:6379` and fixed for the segment
(`:6722`–`:6723`); `enabledPluginDirs()` (`:6690`) and the sandbox policy
(`:6747`) are re-resolved per cycle "because a run outlives the plugin list it
started under" (`:6686`–`:6689`). A brief-or-resume choice that could not be
changed on a run already moving would be a mechanism an operator can only escape
by killing the run.

## How it fails, and whether loudly

**Loud: the spawn.** There is no new flag; there is one flag *removed*. A cycle
that would have carried `--resume` and does not is a valid argv on every build,
and the CLI's own answer to an unparsable flag is loud in any case — measured on
the pin: `claude -p "hi" --not-a-real-flag` exits 1 with `error: unknown option
'--not-a-real-flag'`, before any API call.

**Silent, and it is the failure this whole repository has already written down
twice: the brief omits what mattered and the agent redoes or reverts the work.**
`continuedWorkNotice` exists because a fresh session on a branch full of work it
did not do "either redoes the work or reverts it as leftovers. **Both are billed
and both look like progress**" (`src/lib/settings.ts:544`–`551`). `03-`'s
bracket is what that costs: 2.59× when the fresh agent re-reads everything, and
its own warning is that a live arrangement 2 would take more turns than a
scripted one. Nothing in `run_events`, on the run page or in the dashboard
distinguishes a cycle that carried on from one that started over.

**Silent, second: the diff bound moves under the run.** `diffAsText` cuts at a
file boundary and names what it withheld — but the brief's budget is fixed while
the branch grows, so on cycle 12 of a large run the brief may be mostly
`[TRUNCATED: …]`. The sentence is there, and an agent reading it is being told
the truth; a mechanism whose quality degrades monotonically with run length,
without a threshold anybody set, is still a silent failure.

**Silent, third: the measurement disappears.** Per the retention breakage above,
the transcripts that would show whether this option worked are pruned while the
run is live.

## What it costs to build

**Files touched:** `src/lib/orchestrator.ts` (a fourth branch in `nextPrompt`, a
brief-builder, `sessionId` handling in the run loop, one persisted field for the
previous cycle's final text), `src/lib/settings.ts` (one key and one default),
`src/lib/db.ts` (`migrate()` — one idempotent `addColumn` for the carried final
text), plus the settings page and its route. It reuses `runDiff`, `diffAsText`
and `runEvents` rather than reimplementing any of them.

**Invariants at risk — five, and two of them are load-bearing elsewhere.**
`runs.session_id`'s three readers, above. `docs/agent/run-lifecycle.md`'s
`adoptSession` rule, which exists because writing the column only in the
post-cycle UPDATE "left the column null however far the cycle had actually got"
(`src/lib/orchestrator.ts:6350`–`:6353`) — a per-cycle session makes that column mean something new.
The `--resume`-failure branch's decision (`:7113`–`:7117`). The DONE and
`needs-review` contracts, which this option improves but re-routes.
And `docs/agent/git-and-review.md`'s rule that every `git diff` reading contents
carries `--no-ext-diff --no-textconv` — inherited free by going through `runDiff`,
and the reason to go through it rather than shell out.

**It earns a test, on `CLAUDE.md`'s stated bar.** The brief-builder is a pure
function from (task, events, diff, final text, budget) to a string, and its
failure modes are exactly the silent-and-expensive class
`docs/agent/testing.md` records: a bound applied without the truncation notice is
a confidently wrong agent, and an off-by-one in which cycle's final text is
carried is a run told it finished something it has not started. `diffAsText`'s
own bound and `selectForPatch` are tested on that argument already
(`src/lib/diff.test.ts`).

## What would have to be true

**That most handovers re-write.** 73% of them did in the rolling week, and
`02-levers-on-the-pin.md` explains why — `gitStatus`, regenerated per cycle into
a cached system block, on an install whose isolated runs are told to commit. If a
future CLI moved that section behind the conversation's cache breakpoint, the
clean case would become the common one and `03-`'s 3.9 KB break-even would be the
whole story, at which point this option is a 2.9%-cheaper arrangement that risks
2.59×.

**That a brief this app can build is enough.** `03-` is explicit that it did not
and could not test this: "answer quality was not measured, and that is the part a
cheaper arrangement has to earn". The variant of arrangement 2 that was cheaper
"cannot answer Q2 through Q5 at all — the files are not in its context." Every
dollar this option claims is conditional on a fresh agent, holding a brief,
doing the work in the same number of cycles.

**And the fact that would kill it, named in its own terms:** if a live run under
this option takes more cycles than the same run resumed, it loses on every
measure at once — more cycles is more money, and `maxIterations` is a count
rather than a budget, so the same cap delivers less work. `03-` says its
scripted turn counts make its own headline "a floor" and that the error runs
against the fresh arrangement. Nothing here has measured the live case, and the
$10 experiment `03-` specifies — drop the recorder, let a model choose the turns,
price it through `scanUsage()` — is the one that would settle it.
