# The corpus: what was and was not observed

[← The problem](00-problem.md) · [Next: the findings →](02-findings.md)

## The headline, first

**The transcript corpus was readable, and this survey is built on 152 real
orchestrator turns across 98 conversations spanning 2026-08-11 to 2026-09-02.**
Every quantified claim in this proposal comes from those transcripts. Nothing was
manufactured; the four scripts that produced every number are in
[`scripts/`](scripts/) and re-run in a few seconds with no dependencies.

The live database at `/data` is root-owned `0700` and was **not** read, and no
attempt was made to work around that. Everything the database would have told us
is in [what could not be observed](#what-could-not-be-observed) below, and three
findings are weaker for it.

## How the corpus was identified

The chat child runs with `cwd` = the workspace root (`chatCwd()`,
`src/lib/chat.ts:2604`), so its sessions land under
`/home/node/.claude/projects/-workspace/`. That directory alone is not the
corpus, because ordinary agent sessions run there too. The discriminator is the
MCP server name: `src/lib/chat.ts:2732-2733` writes `mcpServers: { uf: … }`, so a
real orchestrator tool call appears in a transcript as a `tool_use` block named
`mcp__uf__<tool>`.

Filtering on that — a `tool_use` block, not a mention in a file some agent read —
gives:

| | |
|---|---|
| Transcript files anywhere under `~/.claude/projects` containing `mcp__uf__` text | 285 |
| Of those, files with an actual `mcp__uf__*` **`tool_use` block** | **151** |
| Chat sessions (called one of the five `CHAT_TOOLS`) | **138 files** |
| Orchestrator-block sessions (called `emit_runs`) | 9 |
| Sessions calling only shared read tools | 4 |
| Chat files after deduplication | **98 conversations** |
| Operator turns within them | **152** |

Deduplication is by `(first timestamp, record count, call sequence)`. 40 of the
138 files are exact duplicates of another — the CLI writes a second session file
when a turn resumes — and counting them would have inflated every figure by
roughly 40%.

All 98 conversations ran on `claude-opus-5`. **63 of 98 are single-turn**: one
operator message, one batch of proposals, done. Median turns per conversation is
**1**, p90 is 2, max is 7. That shapes the whole survey — the orchestrator chat
is used as a one-shot dispatcher far more than as a conversation, so "wastes the
operator's turn" is mostly a question about one reply rather than about
repetition across many.

## What the turns look like

| | |
|---|---|
| Turns ending with ≥1 proposal | **125 / 152 (82.2%)** |
| Turns calling `ask_operator` | **3 / 152 (2.0%)** |
| Turns with neither | 24 / 152 (15.8%) |
| Total `propose_run` calls | **450** |
| Total `propose_workflow` calls | **2** |
| Proposals per proposing turn | median **3**, p90 7, **max 20** |
| `save_template` calls | 12 |

The 24 "neither" turns are not failures. Four are `[Request interrupted by
user]` (the Stop button, working). Two are `chatPrompt()`'s interrupted-thread
replay (`src/lib/chat.ts:988-999`) firing as designed. The rest are conversational
follow-ups — *"did i reject the right one?"*, *"are the memories present here
too?"* — and three of them are the operator asking about approval order, which is
[F7](02-findings.md#f7).

## Tool-call volume across the corpus

| Tool | Calls | | Tool | Calls |
|---|---|---|---|---|
| `propose_run` | **686**¹ | | `list_agents` | 92 |
| `list_folders` | 152 | | `list_workflows` | 67 |
| `list_templates` | 147 | | `get_run` | 40 |
| `get_usage` | 140 | | `save_template` | 12 |
| `list_runs` | 130 | | `ask_operator` | **3** |
| `list_proposals` | 117 | | `propose_workflow` | 2 |
| | | | `get_run_diff` | **0** |

¹ Pre-deduplication, across all 138 files; the deduplicated figure is 450.

Non-MCP tools inside chat turns: `Bash` 957, `Read` 258, `ToolSearch` 160,
`Grep` 156, `Glob` 19, `WebFetch` 5, `Write` 3, `Skill` 2, `Agent` 1.

**`get_run_diff` was never called once.** It is the one tool with a narrower
scope than the rest and a paragraph of `docs/orchestrator-chat.md:104-112`
justifying that narrowness. Nothing in this corpus exercises it. That is not a
defect and it is not a finding — it is a note that the narrowing cost nothing
observable, filed here because it is the kind of thing a partial sweep would
otherwise leave looking checked.

## Reliability of the tool surface

Of **1,042** `mcp__uf__*` tool results in the corpus, **8 are genuine refusals**:

| Refusal | Times |
|---|---|
| `A proposal needs a task. It is the whole brief the agent gets besides the template's own prompt.` | **6** |
| `This is set to start after "…", which is not a proposal in this chat. Give the earlier proposal an id and name that` | 1 |
| `Another proposal waiting for approval in this chat is already labelled "flow-graph-build". Give this one a different id.` | 1 |

Nothing else errored. No malformed argument, no bad enum, no unknown mount, no
schema violation in 450 proposals. **The schema is not where this surface fails**,
and all six of one refusal are one message in one turn — [F2](02-findings.md#f2).

No assistant message in the corpus ended at `max_tokens`: `stop_reason` is
`tool_use` 3,848 times, `end_turn` 177, `stop_sequence` 1, absent 8. Output
tokens per assistant message: median 512, p90 4,097, p99 15,031, **max 23,626**.

## What could not be observed

Stated in full, because three findings rest on inference where a database read
would have settled them.

- **`/data` was not read.** It is root-owned `0700` on purpose and no attempt was
  made to get around it. So: **no proposal in this corpus is known to have been
  approved, rejected or left pending**, and no proposed run is known to have
  started, succeeded or failed. Every claim about *consequence* — that an
  `on-finish` edge would have started work on a crashed branch, that a duplicate
  proposal was actually approved twice — is a claim about the mechanism and not a
  record of it happening. F3 and F5 are the findings this bounds.
- **The operator's default guard set is not known.** `list_templates` reports it
  to the model (`src/app/api/mcp/route.ts:161-163`) but the reply text is the
  only place this survey can see it, and only one turn quoted it in full
  (*"bypassPermissions, own checkout, $35, 3 work cycles, 240 min"*,
  2026-08-14). So whether the 149 `continueBranch` assertions were entitled to
  assume isolation cannot be checked directly — F4 is scored on what the surface
  tells the model to check, not on whether it got the answer right.
- **The chat page was never opened.** No browser was driven, no proposal card was
  seen rendered. Everything about what the operator *sees* beside the
  conversation is read from `docs/orchestrator-chat.md` and from the operator's
  own messages in the transcripts. F7's diagnosis rests on three operator
  sentences, not on a screenshot.
- **`chatTurnBudgetUSD` in force is unknown**, so whether the 23,626-token turn in
  F2 was near a spend ceiling cannot be determined.
- **No turn was run.** Nothing in this survey was tested by putting a message
  into the chat and watching what came back. Every recommendation is a
  prediction; [11-validation.md](11-validation.md) says how each one would be
  falsified.

## What was deliberately not examined

- **`propose_workflow`'s schema** (`src/app/api/mcp/route.ts:468-602`, 135 lines
  including every block field) was read but is **not surveyed**. Two calls in
  152 turns is not a corpus, and a finding about a surface exercised twice would
  be reasoning dressed as measurement.
- **`BLOCK_TOOLS` / `emit_runs`** (`src/app/api/mcp/route.ts:625-…`) is the
  orchestrator *block*, not the chat. Nine sessions, different subject,
  different failure modes, out of scope by the brief.
- **`get_run_diff`'s scoping argument** — zero calls, nothing to say.
- **The chat page's React** (`src/app/chat/page.tsx`, ~25k) was not read. F7
  names a cost the operator paid three times and stops at the prompt-side
  repair; whether the panel should render the order is a question for someone
  who has opened it.
- **`docs/agent/chat.md`** was not read in full. The routing line in `CLAUDE.md`
  says it settles which half of a run a model may write, how approval reads the
  page, and the capability token's life — none of which this survey touches.
  Where a finding could collide with it, [11-validation.md](11-validation.md)
  names the check.
- **Cost.** No figure here is in dollars. `otlp_requests` is in the unreadable
  database and the transcripts carry token counts without a price.
