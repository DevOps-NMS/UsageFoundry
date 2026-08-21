# Option I — retrieval instead of reading

A per-folder index the agent queries for the fragment it needs, rather than
reading whole files into the conversation.

## The strongest case

**It aims at the single largest thing in a conversation, and the measurement is
unambiguous about what that is.** `00-problem.md`: 1,260 `Read` results holding
16.3 MB — **72.1% of tool-result bytes, and therefore 46% of everything in a
main-thread conversation is file contents an agent chose to read**, at a mean of
12,928 bytes each. `Bash` is a distant second at 21.2% over two and a half times
as many calls. Nothing else in the survey addresses a share that large from the
front.

**And the shape of the waste is the shape retrieval is built for.** Files are
opened once and carried for ever — verbatim re-reads are 0.3% of tool-result
bytes — and the best available proxy says **39.5% of `Read` bytes belong to
files the run never mentions again**: 6.4 MB of the 35.2 MB measured, 18% of a
whole conversation. The complaint is not that the agent reads the same file
twice; it is that it reads 12 KB to use 400 bytes and then carries the other
11.6 KB for seventy turns.

**And it does not have to be built from nothing.** `--plugin-dir` is the
delivery channel this app already has: `pluginDirArgs`
(`src/lib/plugins.ts:123`) emits one flag per directory, `enabledPluginDirs()`
(`:359`) re-proves every stored path contained at the moment it is used, and
`buildArgs` pushes the result on **every** cycle
(`src/lib/orchestrator.ts:4873` from `:6690`) precisely because the flag does
not survive `--resume`. A plugin directory carrying one skill and one script is
a shipped mechanism, not a new one.

**And the arithmetic is favourable at the point of use.** A query result enters
at the tip of the conversation, so `01-constraints.md`'s cut point is the tip,
`S = D`, and there is no invalidation — the same property Options B, E and H
have and the editing options do not.

## Shape

**The folder, reached through the argv.** Two channels exist and they are not
equally available:

- **A plugin directory** carrying a skill and an executable, handed over on
  `--plugin-dir`. It is what this app already does, it is re-proved contained per
  cycle, and its non-survival of `--resume` is already handled. Its cost is that
  "a stored path is proved contained in a mount again at use time. It becomes a
  directory whose hooks the container runs" (`CLAUDE.md`) — and that a plugin's
  skills are announced in the first user message, which `02-levers-on-the-pin.md`
  measured as `msg0.1`, 4,968 bytes of "available skills", ahead of the only cache
  breakpoint that message carries.
- **An MCP server**, which is **not on a work cycle's argv at all today**.
  `--mcp-config` and `--strict-mcp-config` belong to a chat turn
  (`src/lib/chat.ts:1654`, `:1658`), where they arrive with a capability token
  minted per turn that "dies with it, and is never `UF_AUTH_TOKEN`"
  (`docs/agent/chat.md`), and where `--mcp-config <path>` was made a path rather
  than a string because "a string would put the capability token in
  `/proc/<pid>/cmdline`" (`src/lib/chat.ts:2278`–`:2288`). Putting an MCP server
  on a work cycle is opening a door that is currently shut, and the reasoning
  behind its narrowness is about credentials rather than about context.

**And one thing this option may not do**, whichever channel it takes: `claude
plugin install` is refused outright, because "`~/.claude` is one bind mount
shared with the host and its registry records absolute paths" (`CLAUDE.md`,
`docs/agent/architecture.md`).

**Plus a store.** Whatever answers the query has to be built and kept, and that
is the fourth store `01-constraints.md` names: "an index of what was elided is
a fourth, and it needs its own horizon, its own liveness question asked of the
database rather than of a file's age, and its own line in the storage report —
or it is the store that fills the disk holding `.credentials.json`"
(`src/lib/retention.ts:518`–`:521`).

## What leaves the context, and when the decision is taken

**Nothing leaves; less enters; and the decision is the model's, mid-cycle, on
every call.**

The mechanism is a substitution the agent chooses: it calls the index instead
of `Read`, and the 12,928-byte mean result is replaced by whatever the index
returns. Like Option C, this option cannot force it — and unlike Option C, it
does not even have the fallback of the content still being in the conversation,
because the whole point is that it is not.

**The critical property is that the substitution is voluntary in both
directions.** `SEARCH_TOOLS` is `["Grep", "Glob"]`
(`src/lib/orchestrator.ts:4642`), granted on every cycle's `--allowedTools`
(`:4862`–`:4866`), so **the agent already has a retrieval affordance and
chooses `Read` anyway**. Neither `Grep` nor `Glob` appears in `00-problem.md`'s
top seven tools by result bytes — a fact that cannot distinguish "rarely
called" from "called often and returns little", and either reading is a
warning: in the first the tool is being ignored, in the second it is already
doing this option's job and the money stayed where it is.

## What it does to the prefix cache

**At the point of use: no invalidation, and a real saving per substitution.** A
query result of, say, 800 bytes replacing a 12,928-byte read removes about 3,032
tokens from the conversation at the assumed 4 bytes per visible token. Never
written at 2.0× and never read at 0.1× on the ~70 later turns of a 140-turn
cycle, at `claude-opus-5`'s $5 per million (`src/lib/pricing.ts:38`), that is
about **$0.14 per substitution** — the same per-unit arithmetic Option H gets by
delegating.

**Against that, it grows the fixed prefix, and the fixed prefix is paid on
every turn of every run for ever.** `02-levers-on-the-pin.md` measured the tool
block at **111,472 bytes for 28 tool definitions** — 3,981 bytes each, about
995 tokens at 4 bytes per token. Read at 0.1× on all 16,605 container
main-thread turns in the rolling week, **one added tool definition costs about
$8.26 a week**, before it is called once. A skill announcement in `msg0.1` is
charged the same way.

So the option is a trade: about $8 a week of standing cost per tool against
about $0.14 per substitution, which breaks even at roughly **sixty
substitutions a week** across the whole install. Over 235 container sessions
that is undemanding — and it is a floor rather than the answer, because the
standing cost is certain and the substitutions are the model's choice.

**And `00-problem.md` refuses the claim this option would most like to make.**
The 39.5% figure "is a lower bound on what a perfect oracle could have dropped
and an upper bound on nothing: a file whose name never recurs may still have
been the thing that decided the next edit. The proxy is named here so an option
cannot quietly promise the oracle." Carried through the same chain the rest of
this survey uses, that 39.5% is worth about **5.1% of the container main-thread
cache-read line, or roughly $84 a week** — and only if a fragment is as good as
the file.

**And `02-` prices the failure mode from the CLI's own equivalent.**
`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` does not truncate, it *pages*: "The
saving is real on the turn it happens and is repaid in full, plus a fresh
tool-call round trip, the moment the model asks for page two — which is
precisely what that instruction tells it to do." An index that returns the
wrong fragment is a paging instruction with extra steps.

## What it does to the DONE contract, `needs-review`, `--resume` and retention

**DONE and `needs-review`: untouched.** Both are prompt text
(`src/lib/orchestrator.ts:4466`, `:4506`) and `cycleEnding` (`:4543`) matches
over the cycle's own final text. An index returns tool results, which are never
final text.

One hazard belongs here rather than being waved past: the index's corpus is the
repository, and on a run about this feature the repository contains the
sentinels. That is the same door `:4531`–`:4537` already accepts and bounds for
task text — "both tokens must be alone on their line, and the spellings differ
on purpose" — and an index is one more thing that can put them in front of a
model.

**`--resume`: unaffected by the mechanism, and constrained by the channel.**
`--plugin-dir` is not restored by `--resume`, "silently, since a session
missing a hook behaves exactly like one that never had it"
(`src/lib/orchestrator.ts:4828`–`:4831`), confirmed on the pin by
`02-levers-on-the-pin.md`: two firings across three cycles, "cycle 3 exited 0
with nothing on stderr and no hook". The app's answer — rebuild the argv every
cycle — already covers it, and any version of this option that sends the flag
once reintroduces the exact failure.

**Retention: the fourth store, and its horizon is the hard part.** The other
three stores each have a clear liveness question — a run's status, a chat
thread's existence, a checkout's owner. An index has none: it is stale when the
*files* change, and `docs/agent/retention.md`'s rule is that "every sweep asks
the database what is live; never a file's age". An index keyed on mtime is a
file's age with extra steps, and an index keyed on a run is rebuilt per run,
which removes the reason to have one.

## Guards and the three cost sources

**Must not touch, and does not:** the check order is unchanged — `no_terminus`
(`src/lib/budget.ts:495`), `iterations` (`:506`), `duration` (`:518`),
`run_cost` (`:525`), `run_tokens` (`:532`), `weekly_fraction` (`:551`),
`session_fraction` (`:582`).

**But it is closer to a capability than any other option here, and that has to
be argued rather than assumed.** `--allowedTools` is emitted once with
everything in it, and it is *additive* — "it names what skips the prompt, and
everything else still follows the mode. It is not the allowlist `chat.ts` runs
under, where `manual` mode is what makes the same flag exhaustive"
(`src/lib/orchestrator.ts:4852`–`:4854`). A tool the agent may call is a thing
the run may do, and this app's standing rule is that capability comes from a
guard set a person wrote, "reached through exactly two routes and re-narrowed
at every one of them" (`src/lib/agents.ts:190`–`:198`). A read-only index query
over a folder the run already has read access to is defensible on those
grounds; a index tool that could be pointed at a path outside the mount is not,
and the containment answer is `resolveInMount()`'s — checked on the resolved
path **and again** after `realpathSync`, both load-bearing
(`docs/agent/security.md`).

**Adds to which source: none directly.** No figure is produced. Indirectly it
changes the composition of the transcripts, which is the source
`buildSnapshot()` reads (`src/lib/transcripts.ts:406` →
`src/lib/windows.ts:669`) — the same discontinuity Option E creates, and it
wants dating for the same reason.

## What the operator sees, and how they override it by hand

**Sees: the plugin, on the page that already lists them.** `/api/plugins` and
the plugin surface exist, `enabledPluginDirs()` returns `missing` "so the
caller can put it where an operator will see it"
(`src/lib/plugins.ts:352`–`:358`), and the run loop already writes a line on
the run's own log when a directory drops out
(`src/lib/orchestrator.ts:6691`–`:6698`). So the *presence* of the mechanism is
already legible.

**What is not legible is what it did.** No page would show that cycle 4
answered six questions from the index instead of reading six files, and the
index's answers are tool results in a transcript nothing summarises.
`01-constraints.md`'s third obligation applies: the effect is invisible in the
log, so its misbehaviour reads as the agent being stupid. The available surface
is Option A's readout — a per-cycle carried-context figure would show the curve
flattening.

**Overrides:** switching the plugin off, which is what the plugin surface
already does, and is a real off switch rather than a settings key that has to
be invented.

**Mid-run:** already correct. `enabledPluginDirs()` is re-resolved per cycle
"because a run outlives the plugin list it started under"
(`src/lib/orchestrator.ts:6686`–`:6689`), so an operator who switches the index
off reaches the next cycle rather than the next restart.

## How it fails, and whether loudly

**Loud: the plugin path stops being contained.** `enabledPluginDirs()`
re-proves every stored path at use time and reports what dropped, and the loop
logs it. That is `01-constraints.md`'s "loud, because the app checks rather
than assumes" shape, and it is inherited free.

**Silent, first, and this is the one that decides the option: the index is
stale.** A fragment returned from an index built before the last three commits
is a confident, well-formed, wrong answer. Nothing throws; the agent acts on
it; the edit is made against code that no longer exists. This is worse than any
failure in the rest of the survey, because every other option's failure is
*more expensive* and this one's is *wrong*. `CLAUDE.md`'s standing complaint is
about defects that fail silently, and a stale index is that class by
construction.

**Silent, second: the agent ignores it.** It already ignores `Grep` and `Glob`
at some rate this measurement cannot pin down, and an index it does not call is
a tool definition costing $8 a week to sit in the prefix.

**Silent, third: the fragment is not enough and the agent reads the file
anyway.** The conversation then carries the query, the fragment *and* the file
— strictly worse than doing nothing, and indistinguishable in the transcript
from a run that never had an index.

**Silent, fourth: `--plugin-dir` drops off a cycle.** Confirmed silent on the
pin. The app's per-cycle rebuild covers it and the log line names it, but only
for a directory that stopped being contained — a flag omitted by a code change
would be silent.

## What it costs to build

**Files touched: the most of any option in the survey.** A new module to build
and query the index; a new store with a horizon, a liveness question and a line
in `storageReport` (`src/lib/retention.ts:802`–`:812`); a new sweep beside the
three in `retention.ts`; a plugin directory shipped in the image, or a
work-cycle MCP config with everything `docs/agent/chat.md` requires of one;
`src/lib/plugins.ts` if the directory is app-managed rather than
operator-added; the settings page and route. Plus an indexer that has to run
somewhere, on a machine whose CPU is already contested by twenty-five agents —
`RunAgentCost` polls at 30 seconds rather than 3 for exactly that reason
(`src/app/api/runs/[id]/agent-cost/route.ts:14`–`:19`).

**Invariants at risk — six, and three are in `docs/agent/security.md`.**
`resolveInMount()`'s double containment check. "Never a shell. Argv arrays
only" — an indexer over repository contents is the classic place that gets
violated. The `--mcp-config`-as-a-path rule if the MCP channel is taken
(`src/lib/chat.ts:2278`–`:2288`). Never `claude plugin install`. The
`--plugin-dir`-per-cycle rule. And `docs/agent/retention.md`'s "never a file's
age", which this option has no clean answer to.

**It earns at least two tests, on `CLAUDE.md`'s stated bar.** The staleness
predicate is pure and its failure is silent in the expensive direction — an
index believed current is a wrong answer nothing throws on. And any path
handling it does is `plugins.ts`' own argument: its two tests exist because
"they decide what code every agent loads, and a bare `--plugin-dir` with no
value takes the *next* argv entry as its path — which in `buildArgs` is a
permission mode nobody chose" (`docs/agent/testing.md`).

## What would have to be true

**That a fragment is as good as the file, on this repository.** `00-problem.md`
declines to assert it and names the reason: the proxy that says 39.5% of `Read`
bytes are never referred to again "cannot distinguish *wasted* from *read and
understood*", and the thinking that would settle it is stripped from every
transcript — 13,454 blocks, zero bytes retained. This repository's own
`CLAUDE.md` is a list of invariants that fail silently and whose reasoning lives
one file away; it is close to the worst case for retrieval, and it is the corpus
the index would be built over.

**That `Grep` is not already the answer.** The agent has it on every cycle and
reads whole files anyway. Unless something establishes *why*, an index is a
better-shaped version of a tool that is being declined, and the same decline is
the most likely outcome.

**That a fourth store is affordable.** `01-constraints.md` sets the bar, and
this is the only option whose store has no liveness question the database can
answer.

**And the fact that most weakens it:** the standing cost is certain and the
benefit is voluntary. About $8 a week per tool definition is paid on every turn
of every run whether or not the index is ever called, against a benefit that
requires the model to prefer a fragment to a file on a repository whose own
documentation says the reasoning is what matters.
