# Option I — a read-only project-knowledge MCP tool

Every other option in this survey pushes: a sentence, a pointer, a brief, a
notice, all composed before the run has read a line of the task. This one is the
only pull. A work cycle gets a tool on its argv, and if it wants to know what
earlier runs on this repository read, where they hit walls, or which files two of
them collided in, it asks — and pays for exactly the answers it asked for.

The machinery is not hypothetical. This app already speaks MCP over streamable
HTTP by hand (`src/app/api/mcp/route.ts:77`–`:84`), already publishes a tool list
that depends on who is asking (`toolsFor`, `:628`), and already mints a
per-subject bearer capability that dies with the caller (`src/lib/chat.ts:1205`,
revoked at `:1749`). The question is not whether it could be built. It is whether
a standing tool definition earns its rent on this install, and what a work cycle
holding an MCP capability does to a boundary `privsep.ts` was written to draw.

## The strongest case

**It is the only option in the survey where the run decides, and therefore the
only one that cannot be declined into pure cost at the point of use.** Every push
option pays its full price on the run that ignores it: a pointer nobody follows
is still in the prompt, a brief nobody reads is still written and still carried.
`00-problem.md` measures what that costs in practice — 112 runs edited
`src/lib/`, eleven read the doc the CLAUDE.md gate names — and a pull surface
inverts that. A run that never asks pays for the tool *definition* and nothing
else. A run that asks three times pays for three answers.

**It answers constraint 7 outright, and no other option does.** The write side
here is the app, querying its own tables; the read side is a run. No model
authors a byte of what a later run is told, so the loop `docs/agent/chat.md`
refuses to close stays open by construction. The store is `run_events` and
`run_reviews` in `DATA_DIR`, not a file in the shared `~/.claude` mount and not a
file in the tree, which also disposes of constraint 11: no new path is stored, so
no new path needs re-proving in a mount at use time. It adds no horizon either
(constraint 8) — `run_events` is swept at `eventRetentionDays` default 30
(`src/lib/settings.ts:631`, `src/lib/retention.ts:137`) and `run_reviews` never
(`:29`–`:32`), both already true — so `StorageReport` gains no fourth arm.

**It covers the whole fleet and it is visible for free.** Constraint 10 bites
anything riding `seedWorktree`: a run in the operator's own checkout has no seed
path. An argv flag has no such split. And `logLine.ts:289`–`:290` renders a
`tool` event by `p.name` with its input clipped at `MAX_TOOL_INPUT_CHARS`
(`src/lib/logLine.ts:104`), so an `mcp__uf__…` call and its answer appear on the
run's own log with no new rendering code — where the hook-delivered options
inherit `01-constraints.md`'s live defect that `--include-hook-events` appears
nowhere in `src/`. Constraint 6's first half comes with the mechanism.

**And the corpus is already fast enough to serve synchronously.** `00-problem.md`
runs the whole prior-read attribution — a window function over 124,861
`run_events` rows — in 0.155 s. A lookup narrowed to one `repo_root` is a
fraction of that, so it is a `better-sqlite3` call in a request handler.

## Shape

A third `CapabilitySubject` kind and a third tool list, delivered on the work
cycle's argv.

`CapabilitySubject` is a discriminated union of two kinds today
(`src/lib/chat.ts:1176`–`:1178`), deliberately so that `/api/mcp` cannot forget
which it holds. This adds `{ kind: "run"; runId: string }`, a `RUN_TOOLS` array
alongside `SHARED_TOOLS` and `BLOCK_TOOLS`, an arm in `toolsFor`
(`src/app/api/mcp/route.ts:628`) and the matching refusal inside `callTool`,
which the route repeats on purpose because "a tool absent from a list is not a
tool absent from the wire" (`:104`–`:105`). The token is minted per run rather
than per cycle, and the precedent is exact: `ingestTokenFor`
(`src/lib/otlp.ts:87`) mints one capability per run and revokes it on a grace in
`revokeIngestTokens` (`:97`) from `startRun`'s `finally`, because "a token per
cycle would be one more thing to revoke on each of the paths a cycle can end on".

Delivery is two argv entries in `buildArgs` (`src/lib/orchestrator.ts:4808`),
beside the `--allowedTools` push at `:4913`–`:4917`: `--mcp-config <path>` to a
per-run config file, and `--strict-mcp-config`. The second is not optional and
the reason is in the next-but-one section.

The tools are the narrow part. One definition with a `kind` enum — `reads`,
`walls`, `collisions` — costs one definition's rent; three separate tools cost
three. Each answers for the calling run's own `repo_root`:

| `kind` | source | what it returns |
|---|---|---|
| `reads` | `run_events` kind `tool`, `Read` inputs | files earlier runs on this repository opened, ranked ×0.9-decayed by intervening run |
| `walls` | `run_events` kind `tool_error` | recurring normalised failure signatures, with the run count each spans |
| `collisions` | `run_reviews.resolved_paths` | files two runs have actually been adjudicated over, with the cost |

The ranking rule is not a choice: `00-problem.md` measured three prequentially
and the ×0.9 decay wins at both top-20 and top-40, which is the one design
decision that measurement settles on its own.

## What it learns from, and when the decision is taken

**It learns from three stores the app already writes, and takes the decision
later than any other option here.** Every push option composes its text before
the spawn, which means before the model has read the task. This one decides at
whatever turn the model chooses, after it has read the task and usually after it
has looked at the folder — the best-informed decision point available, and the
only one where the thing deciding knows what it is about to do.

That is also the whole risk. `00-problem.md`'s CLAUDE.md finding is the base rate
for voluntary compliance here: a rule in the highest-authority position
available, on every run, declined roughly nine times in ten. A tool the model
must remember to call is strictly more voluntary than a sentence it has already
been given, which is constraint 12 stated from the tool side.

The corpus's own quality is mixed. `walls` is the weakest of the three: 214 of
the 538 `tool_error` rows are one bubblewrap fault over two days, a fact about a
container rather than about any repository, and the codebase already answered it
with a classifier (`src/lib/sandbox.ts:142`) rather than a memory. `collisions`
is the strongest — 67 rows, $238.20, externally adjudicated, per-repository,
non-expiring.

## What it does to the prefix cache

**It does not invalidate anything, and that is exactly why it is expensive.** A
tool definition sits in the tool block, ahead of every cut point in the
conversation. Adding one changes the prefix once, at the first cycle that carries
it, and is then stable for ever — so constraint 4's `T* = 19·(S/D) − 20` does not
describe it. There is no turn at which it pays itself off, because it is not a
saving with a write attached. It is rent.

The rent has been measured twice.
`proposals/ContextControl/12-option-retrieval-index.md:111` puts one added tool
definition at **$8.14 to $8.26 a week**, read at 0.1× across the rolling week's
container main-thread turns before it is called once, and
`proposals/ContextControl/19-validation.md:53` is the re-measurement that widened
it from a single figure to that range, noting the tool block is not a constant.
`19-validation.md:93` re-derives the arithmetic and it reproduces.

**Answers, by contrast, are the cheap half.** A tool result is appended at the tip
of the conversation: `S = D`, paid once at the write rate and read at 0.1×
thereafter (constraint 4). And nothing here writes the repository, so the
`gitStatus` cache write constraint 4 prices — no handover whose previous
cycle changed nothing ever re-wrote, 0 of 74 — is not paid at all. Against the options
whose mechanism is "the agent maintains a file in the tree" that is a real
structural advantage, and it is the one the economics cannot rescue.

### The economics, and why they refuse it

The per-substitution saving on the other side of the ledger is
`12-option-retrieval-index.md:96`–`:101`'s **$0.14**, from replacing a
12,928-byte read with an 800-byte answer. Break-even is therefore:

| | |
|---|---|
| standing cost, one tool definition | $8.14 – $8.26 / week |
| saving per substitution | $0.14 |
| **break-even** | **58 – 59 substitutions a week** |
| a three-tool server | $24.42 – $24.78 / week, 175 – 177 substitutions |

Now the demand side, measured on this install rather than assumed. `Grep` and
`Glob` are a voluntary read-only surface this install *already* grants on every
cycle's argv — `SEARCH_TOOLS` at `src/lib/orchestrator.ts:4642`, pushed
unconditionally at `:4916`:

```sql
SELECT DATE(ts/1000,'unixepoch') AS d, COUNT(*) AS tool_calls,
       SUM(CASE WHEN json_extract(payload,'$.name') IN ('Grep','Glob')
                THEN 1 ELSE 0 END) AS search
FROM run_events WHERE kind='tool' AND ts >= strftime('%s','2026-08-19')*1000
GROUP BY 1 ORDER BY 1;
```

| date | tool calls | search calls | runs |
|---|---|---|---|
| 2026-08-19 | 3,931 | **47** | 22 |
| 2026-08-20 | 408 | **0** | 3 |
| 2026-08-21 | 685 | **0** | 4 |

The flag landed in `bd25c86`, 2026-08-19 (`git log -S'SEARCH_TOOLS = ["Grep"'`),
which is why the window starts there. Five calls are excluded — four on
2026-08-18 and one on 2026-08-19 — because each carries a `tool_error` reading
"No such tool available", which is the evidence they ran before the flag took
effect rather than an inference from the commit time; they are the five refusals
`:4626`–`:4628` records. Over the whole corpus the
recorded figures are `Grep` 49 in 6 runs and `Glob` 2 in 1 run — 46 of the 51
succeeded — against `Bash`
16,754 in 283 and `Read` 5,867 in 269: **51 of 33,193 tool calls, 0.154%**.

So: break-even 58–59 calls a week; the best week the comparable surface has ever
had, **47**, all of it on one day; the two full days since, **0 of 1,093 tool
calls**. At the generous end — every one of the 47 migrating *and* each
displacing a full file read — the tool returns $6.58 against $8.14–$8.26 of rent,
80% of break-even on its single best day. And that day is 2026-08-19, the second
day of the bubblewrap outage (`00-problem.md`), when `Bash` was dying inside the
sandbox and the search tools were the fallback the `SEARCH_TOOLS` docblock at
`:4632`–`:4635` was added to supply. On the two days when `Bash` worked, measured
demand for a voluntary read-only surface was **zero**.

Two corrections against my own argument. Three days is a small denominator and
08-20/08-21 carried only seven runs, so that zero is a weak zero. And $8.20 a
week is 0.43% of this install's rolling-week spend of $1,907.25 across 113 runs,
so the refusal is not that the money is large — it is that it is certain money
against a benefit nobody can show. Which is the third arithmetic fact: **`d` does
not exist.** $0.14 assumes a *substitution*, and an answer about what earlier runs
read displaces nothing this run was going to read anyway. It is additive text
unless `d > 0`, and nothing in this repository measures `d`.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: `buildArgs` re-sends the flag per cycle, but whether the CLI honours
a tool-list change mid-session is not established on the pin.**
`proposals/ContextControl/02-levers-on-the-pin.md:183`–`:217` probed three flags
on the pin — `--settings <json>`, `--settings <path>` and `--plugin-dir` — and
`--mcp-config` is not among them. The failure mode if it behaves like
`--plugin-dir` is the one constraint 2 names and calls silent: cycle 3 exits 0,
writes nothing to stderr, and simply has no tool. `buildArgs` rebuilding the whole
argv per cycle is the correct shape either way, which is why this is a probe
rather than a redesign — but it is an unrun probe.

**Retention: nothing new, and one asymmetry.** The `reads` and `walls` answers
thin as `run_events` is swept at 30 days (`src/lib/retention.ts:137`);
`collisions` never thins (`:29`–`:32`). A tool that answered "no earlier run read
anything here" without saying whether that is a fact or an expiry would be lying
by omission, so each answer states the window it saw.

**DONE: untouched.** `cycleEnding` matches over the cycle's own final text and a
tool result is never final text — the same disposal `12-option-retrieval-index.md`
makes. The sentinel hazard is real only in the sense already accepted: a run about
this feature has the sentinels in its repository, and a `collisions` answer could
name a file whose path contains one. Paths, not prose.

**`needs-review`: untouched by the mechanism — and here is where the survey found
something free.**

### The free fix: `get_run` cannot say why a run needs review

`getRunDetail` (`src/app/api/mcp/route.ts:994`) builds the `get_run` payload at
`:1007`–`:1038`. It carries `stopReason: run.stop_reason` (`:1017`) — prose that
`src/lib/db.ts:993` names as the one thing in this codebase that must never
become a parse — and it does **not** carry `runs.needs_review_reason`. The column
exists (`src/lib/db.ts:1062`), sits on `RunRow` (`src/lib/orchestrator.ts:200`),
is returned by the `getRun` the payload already calls
(`src/lib/orchestrator.ts:601`), reaches the wire on `RunDTO`
(`src/lib/apiTypes.ts:638`), and is rendered on the run page
(`src/app/runs/[id]/page.tsx:947`–`:949`). Only the model cannot see it.

The edge is that the *same route* already tells the caller `needs-review` matters:
`list_runs`'s description says such a run "is finished, holds nothing, and is
waiting on a person, so proposing work that depends on it parks that work on the
same question" (`src/app/api/mcp/route.ts:161`–`:166`). An orchestrator is told to
care about the status and given no way to read the agent's account of it.

It is already bounded at the write. `MAX_NEEDS_REVIEW_REASON` is 2,000
(`src/lib/orchestrator.ts:4264`), applied by `clipReason` (`:4267`) "at the write
and nowhere else", and that docblock's reason decides where the field belongs:
`RunDTO` "is the row shape the runs list ships for *every* row, so an unbounded
model-authored blob multiplies by the length of the list" (`:4256`–`:4260`). So it
goes on `get_run`, which answers for one run, and **not** on `list_runs` (`:894`),
which ships up to 100. This install's single `needs_review_reason` row is 700
characters, comfortably inside the cap.

**This costs no new tool definition and therefore no standing prefix cost** — one
line in an object literal, on a payload the model already pays for whenever it
calls `get_run`. It does not depend on Option I in any way and should be done
whether or not anything else here is; it was found in this file only because this
is the file that opened the payload.

## Guards, the three cost sources, and who may author it

**Who authors it: the app, from its own tables, read-only.** Constraint 7's loop
never closes. No write path, no `chat_proposals`-style inert row, nothing a run
can put in front of a later run. The cleanest answer to constraint 7 in the
survey.

**The three cost sources: the tool names its source or omits the figure.** A
`collisions` answer carrying `run_reviews.cost_usd` and a `reads` answer carrying
`runs.spent_usd` are different sources and `docs/agent/metering.md` forbids
summing them. `src/lib/repoSpend.ts:13` is the precedent, inherited verbatim —
"This is reporting and never a guard" — together with `:18`, "It is not a fourth
cost source". Nothing returned reaches `buildSnapshot()` or `evaluateBudget`, and
the seven-rung check order is untouched.

**But it spends inside the run's own guard budget, and that is the awkward half.**
A tool call's tokens land in that cycle's `result`, hence in `runs.spent_usd`,
hence under `--max-budget-usd` and the run-spend rung. A run that asks four
questions has spent its own budget on asking. That is the opposite of the
retrospective options, whose spend lands in `run_reviews.cost_usd` and stays out
of `runs.spent_usd` by construction the way `startAssist` already does — and it
means a run near its cap is a run that will not ask, which is exactly backwards.

**Constraint 9: nothing here goes near `createRun`.** The token is minted where
`telemetryEnv` mints the OTLP one (`src/lib/orchestrator.ts:5381`), inside the run
loop's setup. The per-repository queries run in a request handler, not in the
synchronous entry-to-INSERT window.

## What the operator sees, and how they override it

**They see every call, at no build cost.** `logLine.ts:289` renders a `tool` event
by name, so `mcp__uf__project_knowledge` and its clipped input appear inline on
the run page with the rest of the cycle's calls.

**They cannot see the rent, and nothing in the app would tell them.** No page
prices a tool definition; the $8.14–$8.26 figure exists only because
`proposals/ContextControl/` went and measured the tool block. An operator would
see the weekly bill move by 0.43% with no instrument that attributes it — which is
`04-option-see-it.md`'s argument arriving from another direction: the readout that
would let this option be scored does not exist yet.

**Override is a Settings boolean, through constraint 1's four doors** — the
interface member, a `DEFAULTS` entry that must be `{}` or the deep compare pins it
into every install, membership of `SETTINGS_KEYS` (`src/lib/settings.ts:649`), and
one of the explicit `if ("key" in body)` arms in `PUT /api/settings`. Miss the
last and the route answers 200 without the key while the form reverts under a
"Saved" confirmation. It is guidance rather than a fact that must stay true, so a
`DEFAULT_*` is the right home and constraint 1's generated-in-`orchestrator.ts`
rule does not bind.

## How it fails, and whether loudly

Four ways, and three of them are silent.

**It is never called.** The run works, the log looks normal, and $8.14–$8.26 a
week leaves by a door nothing in the app watches. This is the modal outcome given
the measurement above and it is invisible by construction.

**The flag does not survive `--resume`.** Cycle 1 has the tool, cycles 2 to *n* do
not, every cycle exits 0, and a session missing a tool behaves exactly like one
that never had it — the `--plugin-dir` shape, confirmed silent on the pin
(`02-levers-on-the-pin.md:204`–`:217`).

**`--strict-mcp-config` is omitted.** `buildArgs` emits neither flag today; both
appear only on the chat child, at `src/lib/chat.ts:1654` and `:1658`, and the
comment at `:1656`–`:1657` gives the reason in one sentence: "Without this, an MCP server
configured in the mounted `~/.claude` joins this child — a tool surface the
operator never granted this feature." `~/.claude` is one bind mount shared with
the host and writable by the agent uid. Shipping the first flag alone admits every
MCP server an operator ever configured on their laptop into twenty-five unattended
agents, and the failure is silent in the worst way: the run still works, and works
*better*, until one of those servers does something nobody sanctioned. A test
pinning the pairing is not optional.

**And the one that is not about flags at all: a work cycle holding an MCP
capability is a boundary this codebase deliberately drew the other way.**
`--mcp-config <path>` is an argv element and `/proc/<pid>/cmdline` is
world-readable (`src/lib/chat.ts:2286`). That is not a hypothetical here — it is a
recorded incident: "a work-cycle agent read the path off a sibling's command line
and opened a file its own uid owned" (`src/lib/chat.ts:2287`–`:2288`,
`src/lib/privsep.ts:43`–`:45`). The fix shipped was a group: under `UF_CHAT_GID`
the per-turn directory and file are 0710/0040 and handed to a group "the chat and
block child is in and no work cycle is", so a thief fails the owner check, fails
the group check, and gets the "other" bits, which are zero
(`src/lib/chat.ts:2291`–`:2292`, `src/lib/privsep.ts:50`–`:52`).

**That fix does not transfer, and `privsep.ts` says so by refusing the
configuration.** `resolveChatGid` throws when `UF_CHAT_GID` equals the agents' own
gid, with the sentence "The MCP capability file would be handed to the group it is
being kept from" (`src/lib/privsep.ts:182`–`:189`). Under Option I every holder of
a capability *is* a work cycle, all at one uid and one gid, so there is no group
to hand the file to that does not contain the thief. A concurrent run reads a
sibling's path off `/proc`, opens a file its own uid owns, and calls `list_runs`
and `get_run` as that sibling — two tools `docs/agent/chat.md:22` keeps
install-wide *deliberately*, on the reasoning that "a file list is not a patch".
Read-only bounds the damage; it does not remove the fact that a run would be
speaking as another run.

Env delivery instead of argv is the obvious dodge and the OTLP token is the
precedent (`src/lib/orchestrator.ts:5381`). It is weaker than it looks: this
container has no Yama LSM (`docker exec usagefoundry cat
/proc/sys/kernel/yama/ptrace_scope` → "No such file or directory"), so the classic
same-uid rule applies and a sibling can be **assumed** able to read
`/proc/<pid>/environ`. The OTLP token survives that because it opens one thing —
writes to its own run's telemetry — where this one would open a read surface over
the whole install.

## What it costs to build

Larger than it looks, and the tail is a security review rather than code.

| piece | where |
|---|---|
| third `CapabilitySubject` kind | `src/lib/chat.ts:1176`–`:1178` |
| `RUN_TOOLS`, `toolsFor` arm, matching `callTool` refusal | `src/app/api/mcp/route.ts:628`, `:104`–`:105` |
| per-run mint and revoke on the loop's `finally` | pattern of `src/lib/otlp.ts:87`, `:97` |
| per-run config file and its ownership decision | `src/lib/chat.ts:2264`–`:2306`, unanswered for runs |
| two argv entries, paired, with a test pinning the pairing | `src/lib/orchestrator.ts:4808` |
| three queries and their source-naming | pattern of `src/lib/repoSpend.ts:4`–`:29` |
| Settings toggle, four doors | constraint 1 |
| a `--resume` probe on the pin | `02-levers-on-the-pin.md`'s method |

Comparable in code to `12-option-retrieval-index.md`'s index, minus the corpus
build, plus the privilege-separation question that has no answer yet.

**The free fix is one line**, in the object literal at
`src/app/api/mcp/route.ts:1017`, and carries none of the above.

## What would have to be true

**First, demand would have to be roughly 59 calls a week where the comparable
surface measured 0 in two days.** Break-even is 58–59 substitutions weekly for one
definition, 175–177 for three. The install's voluntary read-only surface returned
47 calls on the day it landed — during an outage that broke `Bash` — and none
since across 1,093 tool calls and seven runs. Nothing in this file argues the new
tool would be more attractive than `Grep`; `00-problem.md`'s CLAUDE.md finding
argues the reverse.

**Second, `d` would have to be greater than zero for asked-for knowledge
specifically.** The $0.14 per call is a *substitution* figure. A project-knowledge
answer does not replace a file the run was going to open — at most it changes
which file that is. If it merely reorders, the option is rent plus tokens, and
`01-constraints.md`'s third arithmetic fact says no measurement in this repository
establishes otherwise.

**Third, `--mcp-config` would have to be shown to take effect on a `--resume`
cycle**, on the pin, by the method `02-levers-on-the-pin.md` used for the other
three flags. Until then the mechanism might reach cycle 1 only, silently.

**Fourth, `--strict-mcp-config` would have to ship in the same commit as
`--mcp-config`, with a test that fails if either is removed.** Adding the first
alone is not a smaller version of this option; it is a different and worse change,
and it looks like success while it happens.

**Fifth, the capability would have to reach a work cycle by a route a concurrent
work cycle cannot read.** Today there is none: argv is world-readable and the
recorded theft used it; env is same-uid readable and this kernel has no Yama to
narrow that; and the gid that fixed it for chat is refused by name for agents
(`src/lib/privsep.ts:182`–`:189`). Solving this is a privilege-separation change,
not a feature.

**And the fact that would overturn the whole option:** a measurement showing that
a run which *asked* reached its first edit in materially fewer tool calls than the
measured median of 29 (`00-problem.md`). That is `d`, on the one surface where it
could be read cleanly, because a pull design leaves a log line every time it is
used. Ten runs with the tool against ten without, tool calls before the first
edit, is a single-digit-dollar experiment — and if it came back at, say, 20 calls
instead of 29, the per-call saving is no longer $0.14 borrowed from a different
option's arithmetic but a figure of this option's own, and the break-even moves
from 59 calls a week to something the install might actually reach.

Until that experiment runs, this file recommends **against** the tool and **for**
the one line at `src/app/api/mcp/route.ts:1017`.
