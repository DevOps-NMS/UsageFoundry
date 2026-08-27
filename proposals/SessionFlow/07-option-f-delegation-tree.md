# Option F — the delegation tree

Nodes are the main thread and its sub-agents; edges are `parentToolUseId`. **The
only genuinely tree-shaped relation in `run_events`** — and the reason it is not
recommended is that a tree three levels deep is a list.

## The strongest case for it

**The edge is real, directed and stored.** `orchestrator.ts:7586-7593` writes
`parentToolUseId` on every delegated tool call and `subagent` beside it when the
`Task` call was seen in the same cycle. `kind: "subagent"` (`:7521-7536`) carries
the sub-agent's prose with the same parent id. Unlike every candidate in
[06-option-e](06-option-e-file-tool-graph.md), this is a parent-child relation
that exists in the data rather than being synthesised from co-occurrence.

**It answers a question that has no surface.** "Which sub-agent burned the
context?" and "what did the reviewer actually read?" are real questions on a
delegating run. Today the log interleaves them: `logLine.ts:29-34` documents the
split — "the split is `parent_tool_use_id` and only that" — and the log labels
each line with its voice, but nothing *aggregates* per sub-agent.

**It has a natural direction**, which is what the word "flow" asked for.

## Why it is not the recommendation

### 1. It is a tree of single-digit width and depth two

The Claude Code agent model is main thread → `Task` → sub-agent. A sub-agent's
own delegation is not forwarded as a further level in a way this app records — a
delegated call arrives with `parentToolUseId` set to *the `Task` block's id*
(`orchestrator.ts:7586`), so every delegated call hangs directly off its `Task`.
**The tree is depth 2 by construction**, and its width is the number of `Task`
calls in the run.

A depth-2 tree with a handful of branches is an indented list. Drawing it as a
canvas graph is the mistake `docs/agent/conventions.md:65` names from the other
side: below a threshold the answer is not a canvas.

### 2. Two named gaps make the labels unreliable

Both are stated in the code, not inferred:

- **A delegation whose `Task` call was in an earlier cycle loses its name.**
  `acc.subagentNames` is per-cycle (`orchestrator.ts:7550-7551`: "Recorded so
  those messages can be labelled; per cycle, because the ids are"). A sub-agent
  spanning a cycle boundary appears as an unnamed parent id.
- **It depends on a CLI flag.** `logLine.ts:29-34` and `orchestrator.ts:7300-7301`
  record that the attribution needs the CLI's `--forward-subagent-text`, and
  `logLine.ts:32-34` says outright: "Whether a `--agent` session delegates at all
  is unmeasured; if it never does, this voice goes quiet rather than wrong."

**So the subject of this view may be empty on most runs and nobody has measured
whether it is.** That is a strong reason not to lead with it and a weak reason
never to build it.

### 3. It is not what was asked for

The request is "what the session touched and changed". This is "who did the
touching". Valuable, adjacent, and a different feature.

## What is worth keeping from it

**One column, not one view.** If a touch table is built
([09-option-h](09-option-h-reconciliation-table.md)), attributing each touched
path to `main` or to a named sub-agent is a `json_extract(payload, '$.subagent')`
in the same query and a column in the same table. It costs nothing extra, it
degrades gracefully (an unnamed parent renders as "delegated"), and it answers
"what did the reviewer read" without a second surface.

That is the whole of this option that survives, and it survives into the
recommendation.

## Verdict

**Not recommended as a view; folded into
[09-option-h](09-option-h-reconciliation-table.md) as a column.** The relation is
real and it is the only true tree here, but a depth-2 tree of single-digit width
is an indented list, its labels have two documented failure modes, and its
subject is who worked rather than what was touched.
