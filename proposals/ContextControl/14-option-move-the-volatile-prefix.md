# Option K — move the volatile prefix off the cached system block

One argv entry: `--exclude-dynamic-system-prompt-sections`. The CLI's own
description is "Move per-machine sections (cwd, env info, memory paths, git
status) from the system prompt into the first user message. Improves cross-user
prompt-cache reuse."

This option is not on the survey's list of candidates. It is here because
`00-problem.md` and `02-levers-on-the-pin.md` both end on it — "an option may
build on that, and must not describe it as fixing the handover" — and because it
is the only lever in the survey that reaches the *mechanism* behind the largest
identified line in the bill rather than routing around it.

## The strongest case

**It is the only thing this app can put on an argv that touches the $183.69.**
`02-levers-on-the-pin.md` established what changes across a re-writing handover
and it is not anything this app writes: it is the `gitStatus` section of the
CLI's own system prompt, regenerated per cycle, inside `sys[2]` — the 27 KB
block that sits first after the tool definitions and carries a cache
breakpoint. Two cycles of one session with a commit in between:

    sys[2] 27623B -> 27660B
       Status:
      -?? uncommitted-before.txt
      +M CLAUDE.md
      +?? uncommitted-after.txt
       Recent commits:
      +5351e60 a cycle committed

That two-line difference re-writes the entire conversation after it, on 79 of
108 handovers in the rolling week, at a median $2.32 each. **This flag makes
that block identical across cycles** — measured, on the same mutation:

    system blocks: [(74,'null'), (62,'ephemeral'), (26726,'ephemeral')]
    system identical c1->c2: True
    'gitStatus' in system: False

**And it costs nothing to be wrong about.** One argv entry, no state, no store,
no schema, no text, no model behaviour. On a build that drops the flag the
spawn fails outright rather than degrading — measured on the pin: `claude -p
"hi" --not-a-real-flag` exits 1 with `error: unknown option
'--not-a-real-flag'`, before any API call, where `claude -p "hi"
--exclude-dynamic-system-prompt-sections` parses and proceeds. That is
`01-constraints.md`'s "loud, by moving the failure earlier" shape, and it is
the only option in this survey whose entire failure mode is a non-zero exit.

## Shape

**The argv, one entry, and nothing else in this app changes.** It goes in
`buildArgs` (`src/lib/orchestrator.ts:4756`), which is called from inside the
cycle loop (`:6701`) so it is re-sent on every cycle including a resumed one —
the property `--plugin-dir` needed and this flag inherits for free.

There is no text to write, no session decision to take, no folder to index and
nothing to store. It is the smallest shape any option in this survey has.

## What leaves the context, and when the decision is taken

**Nothing leaves the context, ever. The decision is taken at spawn, on every
cycle, by this app.**

What moves is *where the volatile content sits in the request*, not whether it
is sent. `cwd`, environment info, memory paths and `gitStatus` all still reach
the model; they arrive in the first user message instead of the system block.
The model receives the same information.

That is the whole reason this option is safe in a way none of the others are: it
is not a context-reduction mechanism at all. It changes cache geometry.

## What it does to the prefix cache

**It moves the break and does not remove it, which `02-levers-on-the-pin.md`
states in those words.** After the flag, the divergence is at `msg0.2`:

    first user message blocks c1: [(1786,'null'), (4968,'null'), (1360,'null'), (50,'ephemeral')]
      block2: 1360B -> 1432B identical=False    ← the volatile content, now here
      block3:   50B ->   50B identical=True

`msg0.2` "still sits ahead of the only breakpoint in that message and therefore
still ahead of the entire conversation". So the conversation is written again
either way, and this option's saving is only the content that now sits *before*
the new break.

**How much that is depends on a fact `02-` did not establish, and this file
reads its measurement differently from the way `02-` prices it. Saying so
explicitly, as the house rules require.**

`02-` computes the saving as "27,623 − 26,726 ≈ 900 bytes of system text plus
the 6,754 bytes of `msg0.0`/`msg0.1` that now stay matched — about 7.6 KB".
That counts the *shrinkage* of `sys[2]` and treats the block as written in both
worlds. But `02-`'s own measurement is that `sys[2]` goes from **changed** to
**unchanged** across a handover while carrying a cache breakpoint — and a block
that is unchanged behind a breakpoint is read at 0.1× rather than written at
2.0×. On that reading the saving is the whole 26,726 bytes changing rate, not
900 bytes disappearing.

Which is right turns on whether the API's prefix match ends at a `cache_control`
breakpoint or at the first divergent byte, and **nothing in `02-` establishes
that**: the probe recorded where the marks sit and what diverged, not what was
billed, because every `usage` block in it was invented by the recorder. Both
readings, at `claude-opus-5`'s $5 per million (`src/lib/pricing.ts:38`), an
assumed 4 bytes per token, and the 1.9× gap between a 2.0× write and a 0.1× read
(`:16`–`:18`):

| reading | bytes | per re-writing handover | × 79 in the rolling week |
|---|---|---|---|
| `02-`'s: 7.6 KB of shrinkage and newly-matched user blocks | 7,654 | $0.018 | **$1.44** |
| breakpoint-granularity: `sys[2]` moves from written to read | 26,726 | $0.064 | **$5.02** |

**Either way it is small, certain, and not a fix.** Against a median 231,644
written tokens per handover, the better of the two readings is 3% of it. The
survey should carry it as a rounding correction to the biggest line rather than
as an answer to it, which is exactly what `00-problem.md` instructs.

**And one thing the flag cannot do, which is worth stating because it looks as
though it should.** The 111,472-byte tool block sits between `sys[2]`'s
breakpoint and the one at `msg0.3`, so it is inside the prefix that `msg0.2`
breaks. It is written again in both worlds. No arrangement of this flag reaches
it.

**One second-order effect is real and unmeasured.** The flag's stated purpose is
cross-*user* cache reuse, and `00-problem.md` observes that "a ~16,000-token
prefix that every session on this install shares stays warm". Making `sys[2]`
machine-independent should grow that shared base, which would land on the 237
session openings that cost $112.02 in the rolling week as well as on the 79
handovers. Nothing here measures it, and it is **assumed** rather than
established.

**And one hazard the flag creates.** `msg0.2` is not an inert destination:
`02-`'s own block listing labels it `<system-reminder> claudeMd + currentDate`,
and `00-problem.md` confirms `CLAUDE.md` arrives there rather than in the
system block. So after the flag, that block carries `CLAUDE.md`, the date
**and** the git status — three reasons for one block to change, where it
previously had two. A run that crosses midnight, or whose agent edits
`CLAUDE.md`, already re-writes; this flag adds the commit to the same list
rather than removing it from anywhere.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**All four: untouched, and this is the only option in the survey where that
sentence needs no qualification at all.**

`nextPrompt` (`src/lib/orchestrator.ts:4299`) is not called differently.
`COMPLETION_NOTICE` (`:4466`) and `NEEDS_REVIEW_NOTICE` (`:4506`) are unchanged
and still arrive as generated text. `cycleEnding` (`:4543`) matches over the
same final text. `--resume` is still emitted at `:4874` off the same
`sessionId` local (`:6319`), and the flag was observed across a multi-cycle
probe rather than a single one. No transcript is edited, no file is written, no
store is invented and `expiredTranscripts` (`src/lib/retention.ts:528`) sweeps
exactly what it swept before.

The one thing worth checking before shipping, and it is a check rather than a
risk: whether the flag survives `--resume` in the sense that matters — that the
*second* cycle's request also has the sections moved. `02-`'s mutation probe
ran two cycles and reported `system identical c1->c2: True` with `'gitStatus'
in system: False`, which answers it for that probe. The general property is the
one `buildArgs` already guarantees by rebuilding the argv per cycle
(`src/lib/orchestrator.ts:6701`).

## Guards and the three cost sources

**Must not touch, and does not:** `evaluateBudget` (`src/lib/budget.ts:400`)
gains no caller and its order is unchanged — `no_terminus` (`:495`),
`iterations` (`:506`), `duration` (`:518`), `run_cost` (`:525`), `run_tokens`
(`:532`), `weekly_fraction` (`:551`), `session_fraction` (`:582`). `RunGuards`
(`src/lib/settings.ts:489`) gains nothing. `--max-budget-usd` is still derived
per cycle as `max(0, maxRunCostUSD − spentGuardUSD)`
(`src/lib/orchestrator.ts:4880`–`:4882`), and a cheaper handover makes that
remainder go marginally further in turns — `01-constraints.md`'s shape, stated
in its words.

**Adds to which source: none.** No figure is produced and nothing new is read.
The transcripts, `runs.spent_usd` and OTLP are all untouched, and — unlike
Options E and I — the *composition* of the transcripts does not change either,
because the flag moves content between blocks the transcript never records.
`grep -c system-reminder` over a container transcript returns 0
(`00-problem.md`), which is also why this option's effect is invisible in the
one source that could see it.

## What the operator sees, and how they override it by hand

**Sees: nothing, and that is this option's largest defect.** There is no
figure, no meter, no log line and no transcript record. The `iteration` event
carries the prompt (`src/lib/orchestrator.ts:6651`–`:6652`) and not the argv,
so an operator cannot tell from any page whether a run was spawned with the
flag.

The available answer is Option A's readout: a per-cycle carried-context and
carried-write figure would show a handover's write shrinking. Without it, this
option ships and nobody can say whether it did anything — which is the same
position `00-problem.md` describes for the handover itself, one level in.

**Overrides:** a boolean in Settings, where `null` / `""` / `0` all mean off
(`docs/agent/budgets-and-guards.md`) and `saveSettings` stores only what differs
from `DEFAULTS` (`src/lib/settings.ts:693`). A boolean is the correct shape
because the flag has no value.

**Per run:** no case for one. `RunGuards` is `permissionMode`, `isolate`,
`budget` (`src/lib/settings.ts:489`), and cache geometry is not a property of
one run. Install-wide, which `01-constraints.md` says is defensible and should
be argued: the argument here is that a flag which changes nothing the model
receives is not something an operator would want to disagree with per run.

**Mid-run:** per cycle, for free. The argv is rebuilt at
`src/lib/orchestrator.ts:6701` inside the loop, so this follows
`enabledPluginDirs()` (`:6690`) and the sandbox policy (`:6747`) rather than
`settings` frozen for the segment (`:6379`, `:6722`–`:6723`) — with the caveat
that if the flag is read off that same frozen `settings`, it inherits the
frozen behaviour and the option should say which it wants.

## How it fails, and whether loudly

**Loud, and completely: an unrecognised flag exits 1 at the parser.** Measured
on this pin, against `2.1.226 (Claude Code)`. Both invocations pointed at a
closed local port with a dummy key and a scratch `CLAUDE_CONFIG_DIR`, so
neither reached Anthropic and neither could have been billed —
`02-levers-on-the-pin.md`'s arrangement, minus the recorder:

    $ export ANTHROPIC_BASE_URL=http://127.0.0.1:1 ANTHROPIC_API_KEY=sk-ant-not-real \
             NO_PROXY=localhost,127.0.0.1 CLAUDE_CONFIG_DIR=$SCRATCH/cfg

    $ timeout 60 claude -p "hi" --not-a-real-flag
    error: unknown option '--not-a-real-flag'
    exit=1

    $ timeout 60 claude -p "hi" --exclude-dynamic-system-prompt-sections
    Terminated                    # parsed, then spent the timeout on 127.0.0.1:1
    exit=143

So on a future build that removes `--exclude-dynamic-system-prompt-sections`,
every work cycle on the install fails to spawn — immediately, before any API
call, with the flag named on stderr and therefore on the run's own page. That
is expensive in attention and free in money, and it is the opposite of
`--plugin-dir`'s silent drop.

It is also the shape an operator should be warned about: **one flag,
fleet-wide, that fails every spawn on a version bump.** The precedent for
refusing to put a fleet-wide switch on an argv for this exact reason is
`sandboxArgs`, which "never carries `sandbox.enabled`" because the binary's own
rewrite would "make every `claude` invocation on an install without bubblewrap
exit non-zero, fleet-wide, from a flag no operator can edit"
(`src/lib/orchestrator.ts:5146`–`:5152`). The difference is that this flag's
failure is at the parser rather than at a sandbox that may or may not exist, so
it is caught by the first cycle of the first run after an upgrade rather than
intermittently.

**Silent, first: the flag parses and does nothing.** A build that keeps the
option for compatibility and stops moving the sections would leave every cycle
paying the full re-write with no symptom. `01-constraints.md`'s bar — "on a
build where the lever does nothing, does the run get quietly more expensive, or
does something say so?" — is answered here by nothing, unless Option A's
readout exists.

**Silent, second: the saving is smaller than believed**, per the two readings
above. An operator told this addresses the handover has been told something
`00-problem.md` explicitly refuses.

## What it costs to build

**Files touched:** `src/lib/orchestrator.ts` (one `args.push`),
`src/lib/settings.ts` and the settings page for the switch. Nothing else — no
route, no component, no store, no sweep, no schema, no migration. Options B and
L are the same size; nothing else in the survey is.

**Invariants at risk — one, and it is a documentation obligation rather than a
code one.** `docs/verification.md`'s "Not yet verified by hand" list (`:630`)
is where a flag whose effect has been measured only against a local recorder
belongs until a real cycle has run under it: `02-`'s probes established what
the CLI puts on the wire and established **nothing** about token counts or real
cost, because every `usage` block was invented by the recorder.

**It earns no test under `CLAUDE.md`'s bar.** No pure function is added; a
boolean read off settings and pushed onto an array is neither a branch nor
arithmetic nor parsing, and `docs/agent/testing.md` is explicit that the
existing list is the bar rather than a convention to extend. What it earns
instead is a line in `orchestrator.test.ts` beside the existing argv assertions
— the same place that already asserts `--plugin-dir` survives a
`resumeSessionId` (`src/lib/orchestrator.ts:4832`–`:4833`) — because the
failure it guards is a future edit dropping the flag from the resumed path.

## What would have to be true

**That a 1% to 3% correction on the biggest line is worth one argv entry.** It
probably is, on a build cost of one `args.push`. It is not worth describing as a
fix, and `00-problem.md` says so in advance: "The survey should price it as a
small, certain saving and not as a fix."

**That the fleet-wide-flag risk is acceptable.** A version bump that removes
the option stops every run on the install. On an unattended fleet of
twenty-five that is a loud, total, immediate failure — which is the good kind,
and is still a failure nobody has to have.

**That somebody can tell whether it worked.** Nothing in this app would show
it. The measurement that would — a per-cycle write figure on the run page — is
Option A, and without it this option ships into the same blind spot
`00-problem.md` opened on.

**And the fact that bounds it, in `02-`'s own words:** "It moves the break, it
does not remove it." The `gitStatus` block still changes, still sits ahead of
the conversation's only breakpoint, and still causes the whole suffix to be
written on every cycle whose predecessor touched the repository — which, on an
install whose isolated runs are told to commit
(`src/lib/settings.ts:559`–`:562`), is most of them.
