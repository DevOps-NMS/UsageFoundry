# Option L — cap what a tool may return, with the CLI's own environment variables

Set `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, and its siblings, on the child's
environment. The CLI shortens the tool result itself, before it reaches the model,
and this app writes no code that touches a conversation.

This option is not on the survey's list of candidates. It is here because
`02-levers-on-the-pin.md` established three of these by running them and left
three more *could not establish*, and because it is Option E's mechanism —
content intercepted before it lands — with the CLI doing the intercepting and no
hook, no store and no schema in the way.

## The strongest case

**It aims at the largest single contributor with the smallest possible
mechanism.** `00-problem.md`: `Read` results are 72.1% of tool-result bytes over
1,260 calls at a mean of 12,928 bytes, which is 46% of everything in a main-thread
conversation. `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` acts on exactly that
class, and `02-levers-on-the-pin.md` measured it working: a `Read` of an
84,000-byte file returned **93,401 → 32,226 characters**, a 65% reduction on one
call.

**And it is already reachable — this app just does not know it.** `childEnv`
(`src/lib/orchestrator.ts:5216`–`:5231`) copies `process.env` and strips only
`UF_*`, `OTEL_*`, `ANTHROPIC_ADMIN_KEY`, `CLAUDE_CODE_ENABLE_TELEMETRY`,
`DATA_DIR` and `NODE_OPTIONS`. Every variable in this option is therefore already
inherited by every agent this app spawns, on any install whose operator set it in
compose — unstripped, unrecorded and unmentioned by any page. **The first content
of this option is making an existing, invisible lever explicit**, which is the same
argument Option F makes about `DISABLE_AUTO_COMPACT`.

**And the arithmetic is the best in the survey, for the same reason Option E's
is.** The shortening happens before the block enters the conversation, so
`01-constraints.md`'s cut point is at the tip: `S = D`, `T* = 19·(S/D) − 20 = −1`,
and the saving is net from the request it is made on. There is no invalidation to
price against it.

**And it reaches the one component this whole proposal cannot measure.**
`MAX_THINKING_TOKENS` moved `thinking.budget_tokens` from 31,999 to 2,000 on the
pin. `00-problem.md` found 13,454 thinking blocks in this corpus with **not one
carrying its text** — "the signature survives and the reasoning does not, so how
much of a resumed conversation is retained thinking cannot be answered from the
transcript. It is not nothing: the calibration below shows context growing faster
than the visible bytes explain." Every other option in this survey acts on the
visible two-thirds. This one has a lever on the invisible third.

## Shape

**The environment of the spawn — the one layer no other option in this survey
uses.** Not the argv, not the injected text, not the folder, not the session
lifecycle, not this app's accounting.

The variables, with `02-`'s verdicts:

| variable | verdict | observed |
|---|---|---|
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | **exists** | a `Read` of an 84,000-byte file: 93,401 → 32,226 chars, plus a paging instruction |
| `MAX_THINKING_TOKENS` | **exists** | `thinking.budget_tokens` 31,999 → 2,000, `max_tokens` unchanged |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | **exists** | `max_tokens` 32,000 → 4,096, **and drags `thinking.budget_tokens` 31,999 → 4,095 with it** |
| `BASH_MAX_OUTPUT_LENGTH` | could not establish | in the binary; `Bash` cannot run inside the probing agent's sandbox |
| `MAX_MCP_OUTPUT_TOKENS` | could not establish | in the binary; no MCP server is on a work cycle's argv |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | could not establish | in the binary; needs a long live conversation |

`Bash` is the second-largest tool-result contributor at 21.2% over 3,182 calls
(`00-problem.md`), so `BASH_MAX_OUTPUT_LENGTH` being unestablished leaves a fifth
of the addressable bytes unreachable by anything this file can promise.

The build is `childEnv`'s `extra` argument, a compose key each, and a reader in
`src/lib/config.ts`.

## What leaves the context, and when the decision is taken

**Mid-cycle, per tool call, by the CLI — and the decision this app takes is once,
at spawn, as a number.**

Nothing is removed from a conversation. What is capped is what a tool is allowed
to hand back, so the content never becomes a block. No model chooses anything, no
summary is written and `01-constraints.md`'s question about who decides what an
agent may forget does not arise: the decision is a byte count in an environment
variable, and it is this app's.

**The exception is `MAX_THINKING_TOKENS`, and it is a different kind of
decision.** Capping thinking does not shorten a record of work already done; it
changes how much reasoning the model may do before answering. That is not context
control at all — it is a change to what the run is. This file argues for the tool
caps and names the thinking cap as a separate, harder decision below.

## What it does to the prefix cache

**No invalidation, ever.** Same property as Options E and H: nothing already in
the conversation is touched, so there is no cut point and `T*` does not apply.

**What the file-read cap is worth, and the reason it is not what it looks like.**
`02-` is precise, and quotes the CLI's own appended text:

    [… truncated. Use offset=516 and limit=516 for the next page, or Grep to find a
     specific section. Do NOT answer from this page alone if the answer may be further
     in the file.]

"It *pages*. The saving is real on the turn it happens and is repaid in full, plus
a fresh tool-call round trip, the moment the model asks for page two — which is
precisely what that instruction tells it to do." So the ceiling on this option is
not the 65% reduction it achieved on one call; it is 65% **times the share of
reads where the model does not go back for the rest**, and nothing measured
anywhere establishes that share.

The honest bound is `00-problem.md`'s own, and it is the same one Options C and I
inherit: 39.5% of `Read` bytes belong to files the run never mentions again, which
carried through this survey's shared chain — tool results are 64.2% of
conversation content, `Read` is 72.1% of tool results, visible bytes buy about
66.8% of the growth they cause, growth is 41.9% of a mean turn's cache read — is
**5.1% of the container main-thread cache-read line, about $84 a week**. And that
figure is an upper bound on a proxy `00-problem.md` refuses to call an oracle: "a
file whose name never recurs may still have been the thing that decided the next
edit."

**One further cap the CLI already applies unasked, and it bounds the option.** A
`Read` of a 402,000-byte file was refused outright — a 199-character result ending
"…mit parameters to read specific portions of the file, or search for specific
content instead of reading the whole file." — and the environment variable did not
change that. So the very largest reads are already handled, and the corpus's
p99 of 41,227 bytes and maximum of 602,196 are what remains after both the refusal
and the CLI's own spilling of 81.7 MB to `<session>/tool-results/*.txt`.

**And `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is a trap rather than a lever.** It moved
`max_tokens` 32,000 → 4,096 and **took `thinking.budget_tokens` down with it**,
31,999 → 4,095. Output is 12.1% of the week's bill and falls with turn index —
721 mean output tokens in the first decile against 618 in the last
(`00-problem.md`) — so capping it buys little and silently caps reasoning. Any
version of this option that sets it has taken the thinking decision by accident.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**DONE and `needs-review`: untouched by the tool caps, and exposed by the output
cap.** The notices are prompt text (`src/lib/orchestrator.ts:4466`, `:4506`) and
never pass through a tool. `cycleEnding` (`:4543`) matches `DONE` and
`NEEDS_REVIEW` alone on a line against `res.finalText` — which is the model's
reply, and therefore the one thing `CLAUDE_CODE_MAX_OUTPUT_TOKENS` bounds. A
4,096-token ceiling on a cycle that intended to summarise its work and then say
`DONE` can cut the reply before the sentinel. That is a silent way to spend a
whole extra work cycle, and it is exactly the failure `COMPLETION_NOTICE`'s
docblock prices at 92 runs and $162 (`:4436`–`:4446`).

**`--resume`: untouched.** Environment is read at spawn (`:5470`) and every cycle
is a spawn, so the caps apply to a resumed cycle exactly as to a first one.
Nothing about `sessionId` (`:6319`) or `--resume` (`:4874`) changes.

**Retention: nothing at all.** No file is written, no store is invented, no
transcript is edited. This option and Option K are the only two in the survey that
owe `docs/agent/retention.md` nothing.

**One measurement consequence.** The transcripts record what the model received,
so a capped read appears in the corpus as a smaller `tool_result`. Every
composition figure in `00-problem.md` becomes non-comparable across the change,
with nothing dating it — the same discontinuity Options E and I create, and here
with no hook event to mark it.

## Guards and the three cost sources

**Must not touch, and does not:** `evaluateBudget` (`src/lib/budget.ts:400`)
gains no caller and its order stands — `no_terminus` (`:495`), `iterations`
(`:506`), `duration` (`:518`), `run_cost` (`:525`), `run_tokens` (`:532`),
`weekly_fraction` (`:551`), `session_fraction` (`:582`). `RunGuards`
(`src/lib/settings.ts:489`) gains nothing.

**But it is on the wrong side of one line and has to say so.** A cap on what a
tool may return is not far from a statement about what a run may *do*, and this
app's rule is that capability comes from a guard set a person wrote, "reached
through exactly two routes and re-narrowed at every one of them"
(`src/lib/agents.ts:190`–`:198`). The defence is that a cap changes how much a
successful call returns rather than whether the call is permitted — `Read` is not
denied, it is paged, and the model is told so in the result. That is a real
distinction and it is thinner than the one Option E has, because Option E's hook
fires after the tool has already run.

**Adds to which source: none.** No figure is produced and nothing new is read.

**One guard interaction worth naming.** `--max-budget-usd` is derived per cycle as
`max(0, maxRunCostUSD − spentGuardUSD)` (`src/lib/orchestrator.ts:4880`–`:4882`),
so cheaper turns make that remainder go further in turns. `01-constraints.md`
names the shape and asks for those words. If the model pages, it goes further in
turns and buys the same content in more of them.

## What the operator sees, and how they override it by hand

**Sees: nothing today, and that is the first thing this option should fix.** These
variables already reach every agent through `childEnv` if compose sets them, and
no page, log line or event records it. An install with a file-read cap and one
without are running different context regimes and nothing in this app can tell
them apart — the same gap Option F names for `DISABLE_AUTO_COMPACT`, and the
reason both options begin by making an inherited variable an explicit key.

The one thing the *agent* sees is better than any other option offers: the paging
instruction is in the tool result, so the model is told, in words, that it has a
page rather than a file. Nothing else in this survey tells the model what was done
to it.

**Overrides:** compose keys, governed by `docs/agent/environment.md` — `DATA_DIR`
refuses the boot and every other variable warns, and compose renders every
optional variable as `${VAR:-}`, so a blank-by-default key read through `env()`
(`src/lib/config.ts:22`–`:26`) becomes a permanent warning on every stock install.
These have to be read the other way, through the blank-is-the-answer sibling at
`:28`, whose docblock already splits "blank is an off switch" from "blank is take
the default" and says why the split belongs in the app rather than in compose.

**Per run: no surface, and no route to one.** Environment is process
configuration, fixed at spawn from `process.env`, and `RunGuards` is
`permissionMode`, `isolate`, `budget`. A per-run cap would mean a per-run
environment, which `childEnv`'s `extra` argument technically allows — it is how
`telemetryEnv` and `githubEnv` already work (`:5470`) — and which would put a
context choice on the run form. `01-constraints.md` says that widening has to be
argued; this file does not argue for it.

**Mid-run: not reachable.** `childEnv` reads `process.env` at each spawn, so a
compose change needs a container restart. That is the same answer every
environment key gets and is worth stating rather than glossing: an operator who
sets a cap while a twenty-cycle run is working reaches nothing until the restart.

## How it fails, and whether loudly

**Loud: nothing.** An environment variable the CLI does not recognise is ignored.
There is no parser to refuse it, no exit code, no stderr.

**Silent, first, and it is the defining failure of this option: a typo does
nothing and says nothing.** `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` misspelled,
or dropped in a future build, leaves every run reading whole files while an
operator believes a cap is in force. That is `01-constraints.md`'s first shape —
`--plugin-dir`'s, where "a session missing a hook behaves exactly like one that
never had it" — and unlike `--plugin-dir` there is no `enabledPluginDirs()`-style
check that could prove the lever landed, because nothing in the response says a
cap was applied. The only available detection is the effect: Option A's readout,
showing a run's carried context on its old curve.

**Silent, second: the model pages, and pays more.** A run that fetches page two,
three and four has paid the original bytes plus three extra tool round trips.
Nothing distinguishes it in `run_events`, on the run page or in the dashboard from
a run whose first page was enough.

**Silent, third: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` caps thinking.** Measured on the
pin, and it is the kind of coupling nobody would look for. An operator setting an
output cap to shorten replies has cut `thinking.budget_tokens` by 87% on a fleet
running `xhigh` effort on all 108 handovers in the measured window
(`00-problem.md`).

**Silent, fourth: a thinking cap changes the work and looks like a worse model.**
The thinking text is stripped from every transcript, so there is no before-and-
after to inspect — 13,454 blocks, zero bytes retained. A run that got worse after
`MAX_THINKING_TOKENS` was set is indistinguishable from a run that got a harder
task.

## What it costs to build

**Files touched:** `src/lib/orchestrator.ts` (`childEnv`'s `extra`, or nothing at
all if the variables are left to inherit), `docker-compose.yml`, `.env`,
`src/lib/config.ts` for the blank-is-the-answer reading, and the settings page
only if the values become app settings rather than compose keys. It is the
second-smallest build in the survey after Option K, and there is a zero-build
variant: set them in compose and inherit.

**Invariants at risk — three.** `docs/agent/environment.md`'s asymmetry, and the
`${VAR:-}` rendering that turns a blank optional key into a permanent warning.
`childEnv`'s strip list, which exists because "the child is a full Claude Code
session with tool access" (`:5175`–`:5176`) and which must not grow a hole.
And the `CLAUDE_CODE_MAX_OUTPUT_TOKENS`/thinking coupling, which is not an
invariant in this repository at all — it is a property of the pin, and it belongs
in `docs/verification.md` rather than in a docblock.

**It earns one test on `CLAUDE.md`'s stated bar.** The value reader is pure, and
both ways of reading it wrong are silent: a blank or corrupt value taken as `0`
would cap every tool result at nothing, and a `0` taken as "off" when the operator
meant it is the opposite. That is `cycleSilenceMs`' argument verbatim
(`src/lib/orchestrator.ts:455`–`:476`) — "both ways of reading a bad value are
silent and each is expensive in the opposite direction" — and
`config.ts`'s three existing tests earn their place on the same grounds, that they
"each fail *as an ordinary state* rather than as an error"
(`docs/agent/testing.md`).

## What would have to be true

**That the model does not page.** The entire option turns on it, `02-` says the
CLI actively instructs the model to page, and nothing measured anywhere gives the
rate. That is the single experiment that would settle this option, and it is
cheap: one live run over this repository with the cap set and without, counting
`Read` calls that were followed by an `offset` on the same path.

**That `BASH_MAX_OUTPUT_LENGTH` works.** `Bash` is 21.2% of tool-result bytes over
3,182 calls, and it is `could not establish` — not because the variable is absent
but because "`Bash` cannot run inside this agent's sandbox: every call returns
`Sandbox is required but failed to initialize: EPERM`". A fifth of the
addressable bytes is behind a verdict nobody has yet been able to take.

**That a cap is a context decision rather than a capability one.** The line is
thinner here than anywhere else in the survey, and the honest statement is that
`Read` returning a page instead of a file is a change to what a run can do in one
call, defended only by the fact that it can make a second call.

**And the fact that most weakens it, in `02-`'s own words:** "An option built on
this is betting that the model does not need the rest, and `00-problem.md` already
refuses the equivalent claim about file reads generally: its own proxy 'cannot
distinguish *wasted* from *read and understood*'."
