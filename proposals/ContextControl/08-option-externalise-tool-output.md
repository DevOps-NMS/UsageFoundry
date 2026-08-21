# Option E — externalise tool output at the hook

A `PostToolUse` hook writes a large tool result to disk and replaces it, before
the model sees it, with a pointer: the path, the size, and enough of a preview
to decide whether to fetch it.

The survey brief asked whether this is buildable at all, and reserved the
possibility that the pin allows only observation. **It does not: it allows
replacement.** `02-levers-on-the-pin.md` established `updatedToolOutput` by
running it, so this option gets its full case rather than the fallback one.

## The strongest case

**It removes bytes from the conversation without paying for a broken prefix,
and unlike the others in that class it removes the bytes that actually
matter.** The hook runs *before* the result enters the conversation, so
`01-constraints.md`'s cut point is at the tip: `S = D`, `T* = 19·(S/D) − 20 =
−1`, and the saving is net from the first request. Every option that edits a
conversation after the fact is paying `1.9·S − 2·D` for the privilege; this one
pays nothing, and then keeps saving `0.1·D` on every turn for the rest of the
cycle.

**And the distribution is exactly the shape a threshold mechanism wants.**
`00-problem.md`: tool results are 64.2% of a main-thread conversation; their
median is **278 bytes** and the largest 10% carry **72.2%** of all tool-result
bytes. So the money is in about 722 blocks of 7,221 — eighteen per conversation
— and a threshold reaches all of it while leaving 6,500 small results
untouched. `Read` alone is 72.1% of tool-result bytes over 1,260 calls at a
mean of 12,928 bytes each: **46% of everything in a main-thread conversation is
file contents an agent chose to read**, and it is not duplication — verbatim
re-reads are 0.3%.

**And the CLI already does a version of it, unasked, which is the strongest
existence proof available.** Large tool outputs are spilled to
`<session>/tool-results/*.txt` and replaced in the transcript by a
`<persisted-output>` wrapper carrying a 2 KB preview — **174 files, 81.7 MB on
this container alone** (`00-problem.md`). The mechanism is not novel, the model
copes with it, and the numbers above are what remains *after* it: the corpus
still holds a 602,196-byte tool result, so whatever threshold the CLI uses,
results well above it survive into context.

**And the pin answers every question a hook-based option has to ask.**
`02-levers-on-the-pin.md`: `PostToolUse` fires under `-p --output-format
stream-json --verbose`; `hookSpecificOutput.updatedToolOutput` "Replaces the
tool output before it is sent to the model" and was observed doing so, with a
`Read` of `canary-line-from-disk` arriving at the model as
`"1\tHOOK-REPLACED-THE-FILE-CONTENTS"`; the replacement is validated against
the tool's own output schema and a mismatch is refused rather than coerced; and
hooks delivered through `--settings` — a file *or* JSON on the argv — **survive
`--resume`**, verified across three cycles of one session.

## Shape

**The argv, and one new artefact on disk.** Two pieces:

- **A hook script** in the image, dispatched by the CLI on `PostToolUse`. It
  reads the tool result on stdin, and above a threshold writes it to a file and
  answers with `{"hookSpecificOutput":{"hookEventName":"PostToolUse",
  "updatedToolOutput": …}}`. The payload it receives already carries
  `session_id`, `transcript_path`, `cwd`, `prompt_id` and `permission_mode`
  (`02-levers-on-the-pin.md`), so it needs nothing from this app at run time.
- **A `--settings` payload** naming it, built in `buildArgs`
  (`src/lib/orchestrator.ts:4756`) and re-sent on every cycle because the argv is
  rebuilt per cycle at `:6701`.

**It must be `--settings` and must not be `--plugin-dir`, and the pin decides
that rather than taste.** `--plugin-dir` does not survive `--resume` — measured:
a plugin hook fired on cycles 1 and 2 with the flag and not on cycle 3 without
it, "cycle 3 exited 0 with nothing on stderr and no hook". A run whose
externalising hook silently stopped on cycle 3 would go back to full-size tool
results with no symptom but the bill.

**One unresolved build detail, and it is on the argv rather than in the
model.** `sandboxArgs` already emits `["--settings", JSON.stringify({sandbox:
…})]` (`:5158`–`:5164`), pushed at `:6760`, and it chose JSON on the argv
rather than a file because "a file would be a per-child lifecycle to write,
chown and remove for something that carries no secret" (`:5154`–`:5156`) —
which is equally true of a hooks payload. Whether the CLI **merges** two
`--settings` flags or lets the second replace the first is **not established**;
`02-` exercised one at a time. Until it is, the two payloads have to be
composed into one object, and that is a change to `sandboxArgs`' contract
rather than an addition beside it. The precedent for getting this wrong is one
flag over: `--allowedTools` is emitted once with everything in it because "a
second `--allowedTools` is a variadic option the CLI would read as a
replacement rather than an addition" (`:4856`–`:4858`).

## What leaves the context, and when the decision is taken

**Mid-cycle, per tool call, by a threshold this app sets — and the content never
enters the conversation at all.**

That is a materially different claim from every other option here. Nothing is
removed, summarised, compacted or discarded, because nothing was ever added: the
hook stands between the tool and the message list. `01-constraints.md`'s hardest
question — whether a mechanism lets a *model* decide what an agent may be
permitted to have forgotten — does not arise, because the decision is a byte
count in a script.

The trade is that the model can undo it. The pointer is only worth anything if
the agent can fetch what it points at, and the moment it does, the content
arrives after all. `02-` names this precisely for the CLI's own file-read cap:
"The saving is real on the turn it happens and is repaid in full, plus a fresh
tool-call round trip, the moment the model asks for page two — which is
precisely what that instruction tells it to do."

## What it does to the prefix cache

**No invalidation, at all, ever.** The replacement happens before the block is
appended, so there is no cut point and nothing after it to re-write. This is the
one heading where this option has no qualification to make.

**What it is worth, as one chain with every step named.** All of these come from
`00-problem.md` except the last multiplication:

1. Tool results are **64.2%** of main-thread conversation content.
2. The largest 10% of them hold **72.2%** of tool-result bytes → **46.4%** of
   conversation content bytes.
3. Visible bytes buy only part of the growth they cause. The corpus fit is 0.374
   context tokens per visible byte, against an **assumed** 4 bytes per token for
   the visible text itself, so a dropped visible byte removes about **66.8%** of
   the context it was responsible for → **30.9%** of growth.
4. Growth is **41.9%** of a mean turn's cache read, from the pooled OLS —
   intercept 128,271 tokens, slope 1,304 tokens per turn, at the mean turn index
   of about 71 across the 11,422-turn corpus.
5. So the ceiling is **13.0% of the container main-thread cache-read line**:
   0.130 × $1,642.86 = **about $213 a week**. The same 30.9% applied to the
   re-writing share of the one-hour write line — $301.80 of $675.83, carried by
   1.4% of turns — is a further **about $93 a week**.

**Four things make that a ceiling rather than an estimate, and they all cut the
same way.** A pointer is not zero bytes. The model asks for the content back,
and the largest results are the ones most likely to be wanted. The composition
came from the forty largest transcripts rather than from the week. And the
fixed prefix — a median 31,575 tokens that never appears in the transcript at
all — is untouched, which is why step 4 exists.

**One property is worth naming because only this option has it: the saving is
front-loaded within a cycle.** A result dropped at turn 10 of a 140-turn cycle
is saved 130 times over; the same result dropped at turn 130 is saved ten
times. So the mechanism is worth most on exactly the long cycles where
`00-problem.md` measures the last ten turns costing 1.9× the first ten.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**DONE and `needs-review`: untouched, and structurally out of reach.** The hook
acts on tool results. `COMPLETION_NOTICE` (`src/lib/orchestrator.ts:4466`) and
`NEEDS_REVIEW_NOTICE`
(`:4506`) are prompt text and never pass through a tool; `cycleEnding`
(`:4543`) matches over `res.finalText`, which is the model's own reply. A hook
cannot reach any of the three. `01-constraints.md`'s summariser hazard — a
mechanism writing text this app will later read for those tokens — does not
apply either, provided the pointer's preview is a byte range of the original
rather than a generated description. **That is a design constraint rather than
an observation: a preview generated by a model would put the hazard back.**

**`--resume`: intact, and the hook survives it** — measured on the pin through
the `--settings` channel, and the reason the option must not use `--plugin-dir`.
The conversation the resume continues already holds the pointers rather than the
content, so the saving compounds across cycles rather than being re-paid.

**Retention: this option invents a fourth store, and that is its largest
structural cost.** `01-constraints.md` is explicit: "a dropped-content archive
… is a fourth, and it needs its own horizon, its own liveness question asked of
the database rather than of a file's age, and its own line in the storage
report — or it is the store that fills the disk holding `.credentials.json`"
(`src/lib/retention.ts:518`–`:521`). The scale is not hypothetical: the CLI's
own equivalent is 81.7 MB on this container.

Three of the four requirements have a clear answer and one does not. The horizon
should be the *checkout's*, not the transcripts' — `checkoutRetentionDays`
defaults to 7 against `transcriptRetentionDays`' 30 (`src/lib/settings.ts:632`,
`:633`) — because the content is only useful while a run may still fetch it. The
liveness question is a database one, `resumableSessions`' shape
(`src/lib/retention.ts:589`). The storage report has a place for it beside
`checkouts` and `transcripts` (`:802`–`:812`). What has no clean answer is
**where the files go**: inside the run's checkout they are on the branch and
reach `runDiff` and `land.ts`; outside it they are a new directory that
`resolveInMount`'s containment rules (`docs/agent/security.md`) have to be
extended to cover.

## Guards and the three cost sources

**Must not touch, and does not:** the check order stands — `no_terminus`
(`src/lib/budget.ts:495`), `iterations` (`:506`), `duration` (`:518`),
`run_cost` (`:525`), `run_tokens` (`:532`), `weekly_fraction` (`:551`),
`session_fraction` (`:582`). `RunGuards` (`src/lib/settings.ts:489`) is
unchanged. The hook cannot deny a tool call — it fires *after* the tool ran — so
it cannot become a second place deciding what a run may do, which is the failure
`agents.ts`' refusal of a `tools` field exists to prevent
(`src/lib/agents.ts:187`–`:228`).

One thing it does touch and must not get wrong: **a `PreToolUse` hook would be a
capability**, because `permissionDecision: "allow"|"deny"|"ask"|"defer"` and
`updatedInput` are on that event's surface (`02-levers-on-the-pin.md`). This
option is `PostToolUse` only, and that boundary is load-bearing rather than
incidental.

**Adds to which source: none directly, and one indirectly.** It produces no
figure. But it changes what the transcripts contain, which is the source
`buildSnapshot()` reads (`src/lib/transcripts.ts:406` →
`src/lib/windows.ts:669`) — so every window meter, every guard fraction and
`00-problem.md`'s own composition measurement are measuring a different thing
after this ships than before. That is not a violation of the never-mix rule; it
is a discontinuity in one source that any before-and-after comparison has to
date.

## What the operator sees, and how they override it by hand

**Sees, and this is unusually good: the hook's own dispatch, on the stream this
app already parses.** `--include-hook-events` puts every hook dispatch on the
same `stream-json` channel `handleStreamLine` (`src/lib/orchestrator.ts:5830`)
already reads, as `{"type":"system","subtype":"hook_started"|"hook_response",
…}` carrying `hook_name`, `outcome`, `exit_code`, `stdout` and `stderr` — "so a
hook's failure is observable by this app without a second channel"
(`02-levers-on-the-pin.md`). That is the surface `01-constraints.md` says an
option changing the conversation has to invent, and here it exists already. The
precedent for adding a flag that changes the stream's shape rather than what
the run may do is `--forward-subagent-text`
(`src/lib/orchestrator.ts:4845`, `:4819`–`:4821`).

**Overrides:** a threshold in Settings, where `null` / `""` / `0` all mean off
(`docs/agent/budgets-and-guards.md`), stored only if it differs from `DEFAULTS`
(`src/lib/settings.ts:693`). A threshold is the right shape for the off switch
because the mechanism is already a threshold.

**Mid-run:** it should be the per-cycle case, `enabledPluginDirs()`
(`src/lib/orchestrator.ts:6690`) and the sandbox policy (`:6747`), not the
`settings`-frozen-for-the-segment case (`:6379`, `:6722`–`:6723`) — the argv is
rebuilt every cycle anyway, so re-resolving costs nothing and the alternative
is a run that cannot be changed.

**By hand, the whole way out:** the operator can fetch any externalised file
themselves, because it is a file. That is a better answer than any
summarisation-based option can give.

## How it fails, and whether loudly

**Loud, and this option can make it loud by construction:** a hook that fails,
times out or exits non-zero reports on the `hook_response` event with its
`exit_code`, `stdout` and `stderr`, on the channel `handleStreamLine` already
reads. Nothing else in this survey has an equivalent.

**Silent, and it is the one `02-levers-on-the-pin.md` names in the file
itself.** The replacement is validated against the tool's own output schema,
and a mismatch is **refused** — the model receives the real, unreplaced output
and the run carries on:

    [ERROR] "PostToolUse hook returned updatedToolOutput that does not match Write's
             output shape: [ { "expected": "object", "code": "invalid_type", … } ]"

"That refusal is loud in the debug log and silent everywhere else — the run
continues with the unreplaced output, which is the `--plugin-dir` failure mode
from `01-constraints.md` in a new place: an option built on this must state what
happens when a future build changes a tool's output shape." The answer this
option must give: `Read`'s shape is a union discriminated on `type` and the
schema is the CLI's, so a build that reshapes it turns the mechanism off with no
symptom except the bill going back up. The available mitigation is not detection
of the schema change but detection of the *effect* — Option A's readout, which
would show a run's carried context returning to its old curve.

**Silent, second: the agent fetches everything back.** The pointer is an
invitation, and `02-`'s paging note is that the CLI's own instruction actively
tells the model to take it. A run that fetches every pointer pays the original
cost plus a tool round trip per fetch, and nothing distinguishes it from a run
that fetched none.

**Silent, third: the threshold is wrong in the cheap direction.** Set above the
p99 of 41,227 bytes it reaches almost nothing; set near the p75 of 2,177 it
pointer-ises results small enough that the round trip costs more than the block.
Neither shows up anywhere.

## What it costs to build

**Files touched:** a hook script added to the image (`Dockerfile`),
`src/lib/orchestrator.ts` (`buildArgs`, plus composing one `--settings` object
with `sandboxArgs`' — see above), `src/lib/settings.ts` and the settings page
for the threshold, `src/lib/retention.ts` (a fourth sweep, its horizon, its
liveness query and its line in the storage report). It is the largest build in
the survey after Option I.

**Invariants at risk — six, and three of them are in `docs/agent/security.md`'s
territory.** The `--settings` single-flag question above. `resolveInMount()`
checking containment on the resolved path *and* again after `realpathSync`, if
the store lives outside a checkout. "Never a shell. Argv arrays only" — the hook
is a script that receives arbitrary tool output on stdin, so its own
implementation is the thing that must not interpolate. The retention rule that
every sweep asks the database what is live and never a file's age
(`docs/agent/retention.md`). `--plugin-dir`'s non-survival of `--resume`, which
decides the delivery channel. And the `PostToolUse`/`PreToolUse` boundary above.

**It earns a test, and clearly.** The threshold decision — given a tool name, a
result size and a settings value, replace or not — is a pure function whose
failure modes are silent in both directions, which is the bar
`docs/agent/testing.md` records and the same grounds `plugins.ts`' two earned
("they decide what code every agent loads"). The hook script itself is not a
pure function and is not testable on that bar; what would cover it is the
verification list in `docs/verification.md`, and it belongs on the "Not yet
verified by hand" section until a real cycle has run under it.

## What would have to be true

**That the composition of the forty largest transcripts is the composition of
the week.** Everything in the chain above rests on it. `00-problem.md` measured
35.2 MB across 40 files; the container's week is 235 sessions. Nothing
establishes that the ratio holds at the other end of the distribution, and a
short session that reads two files has a different shape from a 258-turn one.

**That the model tolerates a pointer where it expected a file.** The CLI's own
81.7 MB of spilling is evidence that it does at *some* threshold, and no
evidence at all about a lower one. The failure is not an error: it is a fetch,
and then another fetch, and a run that spends its cycle budget paging.

**That a fourth store is worth having.** `01-constraints.md` sets the bar and it
is not rhetorical — three stores today, on three media, with three horizons and
three sweeps, and the one that fills the disk holds `.credentials.json`. This
option adds a fourth whose contents are, by construction, the largest things the
runs produced.

**And the fact that would most weaken it, from the file that established the
mechanism:** on a build where a tool's output schema moves, `updatedToolOutput`
is refused, the debug log says so, and nothing else does. `01-constraints.md`'s
bar for the pin is not "does the lever work" but "on a build where the lever
does nothing, does the run get quietly more expensive, or does something say
so?" — and for this option the honest answer is that it gets quietly more
expensive unless Option A's readout is there to notice.
