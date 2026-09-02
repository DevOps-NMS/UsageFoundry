# The measurement scripts

Every number in this proposal comes from these seven files. No dependencies —
plain Node over the JSONL transcripts under `~/.claude/projects/`.

They write intermediate JSON to a scratch directory named for the branch that
produced them. Set it once and run them in order:

```sh
export SCRATCH=/tmp/uf-orchestrator-chat
mkdir -p "$SCRATCH"
sed -i "s#/tmp/uf-721638d11c0b-1#$SCRATCH#g" *.mjs   # or edit the constant by hand
node scan.mjs      # → $SCRATCH/sessions.json   : finds the corpus
node analyse.mjs   # → $SCRATCH/turns.json      : splits it into operator turns
node deep.mjs      # proposal quality, dependency edges, reply shape
node sharp.mjs     # stop_reason, tool-result errors, ToolSearch queries, Write targets
node verify.mjs    # ToolSearch deferral, the task-less batch, the edge pairs
node asking.mjs    # prose questions vs ask_operator; which tools the prompt names
node batch.mjs     # F2's table: the six task-less calls and the retry's shared override
node final.mjs     # ToolSearch by date, list_proposals by turn position, one worked example
```

`asking.mjs` reads `src/lib/chat.ts` from an absolute path — point it at your
checkout if it is not `/workspace/.uf-worktrees/usagefoundry-721638d11c0b-1`.

## What each one establishes

| | |
|---|---|
| `scan.mjs` | Identifies orchestrator-chat transcripts by `mcp__uf__*` **`tool_use` blocks** (not by text mention, which matches any agent that read `route.ts`). Separates chat from orchestrator-block sessions by which tools were called. |
| `analyse.mjs` | Deduplicates 138 files to 98 conversations, splits into 152 operator turns, and produces the propose/ask/neither split, the task-length distribution and the look-before-proposing rates. |
| `deep.mjs` | `continueBranch` against `templateId`; `on-success`/`on-finish` shape; guard vocabulary in task text; reply length and repetition; the "neither" turns in full. |
| `verify.mjs` | Which uf tools appear in `ToolSearch` queries and the fetched-vs-called correlation for `ask_operator`; the `da349f53` message call by call; the seven `on-finish` + `continueBranch` proposals; the three `ask_operator` turns with the operator message that produced each. |
| `sharp.mjs` | `stop_reason` and output-token distributions (no message ended at `max_tokens`); the eight genuine tool refusals separated from 1,034 clean results; every `ToolSearch` query; every `Write` target. |
| `asking.mjs` | Whether the model asks in prose instead (it does not), and which tool names `systemPrompt()` mentions, checked against the source rather than from memory. |
| `batch.mjs` | F2 in full: every `propose_run` in `da349f53` with its `task` length, `promptOverride` length and the override's SHA-1 — which is what shows six distinct overrides in the failing message and one shared override in the retry. |
| `final.mjs` | `ToolSearch` use by date (it spans the whole corpus, so the deferral is not a recent change); `list_proposals` split by first-versus-later proposing turn; one worked example turn printed end to end. |

## Caveat on the corpus

The transcripts are the chat child's own sessions, found under
`/home/node/.claude/projects/-workspace/` because `chatCwd()`
(`src/lib/chat.ts:2604`) puts the child in the workspace root. They record what
the model *called*, not what the server *stored*: `/data` is root-owned `0700`
and was not read, so no proposal here is known to have been approved, rejected or
started. See [01-the-corpus.md](../01-the-corpus.md#what-could-not-be-observed).
