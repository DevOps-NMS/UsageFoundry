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

`COMPLETION_NOTICE` (`src/lib/orchestrator.ts:4467`) and `NEEDS_REVIEW_NOTICE`
(`:4507`) are the whole contract by which a run can end for a reason rather than
by exhausting a cap, and both reach the agent as **generated** text on every
cycle bar the operator's own follow-up (`nextPrompt`, `:4331`–`:4362`).

Three properties, each with the measurement or the invariant behind it.

**They are generated, not stored, and that is load-bearing.** `getSettings()` is
`{...DEFAULTS, ...stored}`, so a sentence added to a `DEFAULT_*` prompt has to
survive whatever the operator's install already has stored
(`src/lib/orchestrator.ts:4449`–`4455`, `docs/agent/conventions.md:14`). Any
context mechanism with configuration of its own inherits that rule: it must not
be written out whole.

> **Correction, 2026-08-22.** The original of this paragraph said the settings
> page "PUTs the whole *effective* object on Save, so a sentence added to a
> `DEFAULT_*` prompt is dead on every install whose operator has ever pressed
> the button". It was quoting the docblock at `src/lib/orchestrator.ts:4449`–`:4455`
> accurately, and the docblock is stale: `saveSettings`
> (`src/lib/settings.ts:727`–`:731`) compares each key against `DEFAULTS` with
> `sameValue` (`:756`) and stores **only what differs**, which is `CLAUDE.md`'s
> own rule — "Writing the whole object kills every future default on that
> install." So the hazard is real, the code already refuses it, and the comment
> describing the old behaviour is a `src/` fix outside this revision's scope,
> recorded in `19-validation.md` rather than made. The constraint on an option's
> own configuration is unchanged either way: it must not be written out whole.

**Dropping them is expensive in a way that is already measured.** Before
`COMPLETION_NOTICE` existed, cycle 1 was judged against a protocol it had never
been given, and the docblock records the count: of the runs whose budget allowed
a second cycle, 92 of them cost $162 to say one word into a re-sent conversation
(`src/lib/orchestrator.ts:4437`–`:4447`). An option that drops, summarises or
rewrites turns must not
drop these, and must not contradict them: `NEEDS_REVIEW_NOTICE` says "work you
have not attempted is not a wall", and a summariser that replaces a cycle's
evidence with a paragraph is manufacturing exactly the ambiguity that sentence
exists to refuse.

**And the matcher runs over generated text.** `cycleEnding`
(`src/lib/orchestrator.ts:4544`) tests both sentinels against a cycle's final
text, alone on a line, with the two spellings deliberately different so a task
quoting the *status* cannot fire it. A mechanism that writes a summary back into
the conversation is writing text that this app will later read for those tokens.
It has to say what stops a summary of a run about this feature from ending the
run — the same hazard `:4532`–`:4538` accepts and bounds for task text, one door
further in.

## What survives a compaction, audited row by row

*Added 2026-08-22. The survey treated compaction as invisible and as somebody
else's mechanism. Anthropic publishes a table saying which injected text
survives one, and this app injects five kinds of text. This section is that
table crossed with this app's argv.*

The source is
`/workspace2/3 Resources/AI Context and Memory/Mid-Session Context Mutation with Claude.md:63`–`:79`,
which reproduces a vendor table it pins at **v2.1.198**. The vault grades the
underlying page `evidence: documentation`, `confidence: medium`
(`/workspace2/3 Resources/Sources/Claude Code Context Window Documentation (Anthropic).md`)
and records that it carries "no measurement of any kind" — so every row below is
a **documented mechanism**, not a measured outcome, and the distinction is
carried into the last column rather than flattened.

**This install pins 2.1.226** (`Dockerfile:215`, `ARG CLAUDE_CLI_VERSION=2.1.226`;
`claude --version` → `2.1.226 (Claude Code)`). The vault's stated observation
range for these pages is v2.1.198–v2.1.234, so 2.1.226 is inside the range the
note's author watched, and it is **28 patch releases after the table's own
pin**. Where a row was not independently probed here, it is a hypothesis about
this install and is written as one.

| What this app injects | How it reaches the model | Vendor table's row | Status on this install |
|---|---|---|---|
| `SELF_HOSTING_NOTICE` + `DELEGATION_NOTICE`, one `--append-system-prompt` (`src/lib/orchestrator.ts:4943`–`:4948`) | **system prompt** | "System prompt and output style — Unchanged; not part of message history" | **Survives.** Documented, unprobed. The argv is rebuilt per cycle (`:6821`) so it is re-sent regardless |
| `COMPLETION_NOTICE` (`:4467`), `NEEDS_REVIEW_NOTICE` (`:4507`), the task prompt, `continuation`, `donePushback` — via `nextPrompt` (`:4331`–`:4362`) | **user message** | *no row* — message history is the thing being summarised | **Open, and the table cannot close it.** See below |
| The generated vault skill, `renderVaultSkill` → `SKILL.md` (`src/lib/vaultSkill.ts:203`, `:370`) under `/run/uf-skills` (`:90`), on argv as `--plugin-dir` | **invoked skill body** | "Invoked skill bodies — Re-injected, capped at 5,000 tokens per skill and 25,000 total; oldest dropped first" | **Under the cap, measured.** 3,540 bytes rendered (3,479 with no ranked search script). No tokenizer can make 3,540 bytes exceed 3,540 tokens, so truncation cannot bite and the 25,000 total would need seven such skills |
| The skill's *menu entry* | **skill listing** | "the **skill listing itself is not re-injected**" (vault note `:77`) | **Lost.** A run that compacts before it has ever invoked the vault skill loses the entry telling it the skill exists. `writeVaultSkill`'s own docblock (`src/lib/vaultSkill.ts:357`) already relies on the CLI reading `SKILL.md` at invocation rather than at startup |
| Operator plugin directories — skills, agents, MCP servers (`src/lib/plugins.ts:129`, `:204`) | same as above, per component | skills as above; agents and MCP servers have **no row** | **Something is re-sent, contents unread.** Each of the 18 boundaries is followed by an `agent_listing_delta`, and 3 by an `mcp_instructions_delta`. What those carry was not opened |
| Project-root `CLAUDE.md` in the mounted repository | file, read by the CLI | "Project-root `CLAUDE.md` and unscoped rules — **Re-injected from disk**" | **Survives, per the table, and not checkable here.** The marker text appears nowhere in any transcript, before or after a boundary, which `00-problem.md` already predicts for the invisible fixed prefix. Documented, unprobed |
| A **nested** `CLAUDE.md` in a subdirectory of a mounted repository | file | "**Lost** until a file in that subdirectory is read again" | **Would be lost.** This repository has exactly one `CLAUDE.md`, at the root, so nothing is lost here today. A mounted monorepo with per-package `CLAUDE.md` files loses every one at a compaction, silently, and gets each back only where the agent happens to re-read a file in that package. Same mechanism as the row below, which *was* observed |
| `paths:`-scoped rules under `~/.claude/rules/` | file | "Rules with `paths:` frontmatter — **Lost** until a matching file is read again" | **Confirmed on 2.1.226, in the exact shape the row describes** — see below. Live exposure: three of the five files on this install carry `paths:` (`typescript.md`, `python.md`, `interface-copy.md`) and two do not. `~/.claude` is one bind mount shared with the host, so those three govern every agent this app spawns |
| Hooks, via `--settings` | code | "Hooks — Not applicable; hooks run as code, not context" | **Confirmed, and stronger than the row.** All 18 boundaries are followed by a `hook_success` attachment naming `SessionStart:compact`, so a hook not only survives but has a firing point at the boundary itself |

**The corpus behind the last column, and the one row it turned from
documentation into observation.** A JSON parse of all 1,120 transcripts under
`~/.claude/projects` on 2026-08-22 finds **18** `compact_boundary` records — 12
in this worktree's project, 1 in the sibling worktree's, 5 in `-workspace2` —
all with `trigger: "auto"`, a mean 171,063 `preTokens` against 13,673
`postTokens`, and a mean 143,427 ms spent compacting (2,582 s in total). Every
one of them post-dates `ee93684`, which put `--autocompact` on the argv. The
count grows while this app runs: the same scan earlier the same day, over 1,117
transcripts, returned 16.

The records a boundary is followed by are the same every time:

    + 1  user (isCompactSummary)              ← the summary, mean 24,153 bytes
    + 2..5  attachment:compact_file_reference ← a path, no content
    + 6  attachment:file                      ← full content
    + 7  attachment:deferred_tools_delta
    + 8  attachment:agent_listing_delta
    + 9  attachment:hook_success              ← hookName "SessionStart:compact"
    +10  last-prompt
    +11  agent-setting
    +12  assistant (thinking)
    +13  assistant tool_use Grep {"pattern":…,"path":"/workspace/.uf-worktrees/…
    +14  user (the tool result)
    +15  attachment:nested_memory  /home/node/.claude/rules/typescript.md

**Read line +15 against line +13.** `typescript.md` carries `paths:`
frontmatter, so the table says it is lost at the boundary "until a matching file
is read again" — and it comes back not at the boundary but two records after the
agent's *first tool call touching a matching path*. Across the 18 boundaries the
first `nested_memory` lands at offset +15 to +18 with one or two tool uses in
between, never earlier; and the five boundaries where no matching file was
touched have **no `nested_memory` at all** within 200 records. That is the
documented mechanism, observed on 2.1.226 rather than assumed from a page pinned
at v2.1.198, and it is the strongest single reason to trust the rest of the
table on this install.

Two smaller readings from the same records. `compact_file_reference` outnumbers
`file` 63 to 27, so more than twice as many files come back after a compaction
as a **name** than as content — the summariser's own "carry forward the five
most recently accessed files" is mostly carrying forward paths. And the boundary
costs wall-clock: 143 seconds of compaction, per compaction, inside a run whose
`maxDurationMinutes` guard is counting.

**What this settles about "the two endings", and precisely what it does not.**
It settles the **process-safety half and only that half**. `SELF_HOSTING_NOTICE`
and `DELEGATION_NOTICE` — the text that tells an agent not to `pkill` its own
supervisor, and how to delegate — ride `--append-system-prompt`, which the table
puts in the one row that survives *unchanged*. That is the half of this section's
title that is now answered, and it is answered by mechanism rather than by hope.

**The ending contract is the open half.** `COMPLETION_NOTICE` and
`NEEDS_REVIEW_NOTICE` are appended to a **user message**, and message history is
not a row in the table because message history is the thing a compaction
rewrites. So the two sentences that decide whether a run can end for a reason
are in the one class the vendor documents no protection for. `nextPrompt` re-issues
`NEEDS_REVIEW_NOTICE` on every continuation cycle (`:4331`–`:4362`), which
repairs it at the next handover — but *within* a cycle, after a compaction, the
contract is whatever the summariser chose to keep.

**And the table settles less than it appears to even where it says "survives".**
The vault flags this in its own callout at `:81`–`:82`, and the flag is the
reason this section is not the end of the argument:

> The table settles *what text is present after compaction*. It does not settle
> whether a re-injected rule still **binds** — [[Governance Decay (Chen 2026)]]
> measures 30% prohibited-action rates post-compaction, mediated entirely by
> whether the constraint text survived, and nobody has run that experiment on a
> re-injected file.

So even the top row's "unchanged" is a claim about **presence**, not about
force. `16-comparison.md` carries what the measurements say about the
difference.

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
