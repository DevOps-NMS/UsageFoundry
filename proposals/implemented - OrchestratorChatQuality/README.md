# Orchestrator chat quality

**The question:** what makes a chat with the orchestrator good, and what makes it
bad — answered from evidence rather than taste.

**The state:** open. Eight findings, six options, two recommended, six things
refused by name. **Nothing here is a decision and nothing under `src/`
changed.**

## The corpus, first, because it is what this survey is worth

**The transcripts were readable.** 152 real operator turns across 98 deduplicated
conversations, 2026-08-11 to 2026-09-02, all on `claude-opus-5`, containing
**450 `propose_run` calls**. Found under `/home/node/.claude/projects/-workspace/`
because `chatCwd()` (`src/lib/chat.ts:2604`) puts the chat child in the workspace
root, and identified by `mcp__uf__*` **`tool_use` blocks** rather than by text
mention — which is what separates a real chat turn from an agent that happened to
read `route.ts`.

**`/data` was not read.** It is root-owned `0700` on purpose and no attempt was
made to get around it. So **no proposal here is known to have been approved,
rejected or started**, and three findings are bounded by that. Full accounting in
[01-the-corpus.md](01-the-corpus.md#what-could-not-be-observed).

Every figure is reproducible: [`scripts/`](scripts/), seven files, no
dependencies.

## Two of the brief's premises are refuted by the corpus

**It does not propose vaguely.** The median `task` is **4,946 characters / 789
words**; **1.3%** are under 500 characters and all six of those are the same
defect. **97.1%** name a verification word, **96.9%** a concrete file, **31.8%** a
`file:line`.

**It does look before it proposes.** **89.6%** of proposing turns ran
`Read`/`Grep`/`Glob`/`Bash` first — 957 `Bash` calls, median 5 per turn.
**73.6%** called `get_usage` before the first proposal and 83 of 125 replies then
said something about the window, so window awareness is among the strongest
compliance numbers here.

## The finding that replaces them

**The orchestrator has never once decided, on its own, to ask the operator a
question.** `ask_operator` was called **3 times in 152 turns**, and all three
followed an operator message that named the feature — *"can you use the new
question interface"*, *"Please ask some questions with the tool you have"*, *"if
you have questions use the question feature to ask me them"*. It does not ask in
prose either: **at most 1 of 147** replies contains a genuine question sentence.

The mechanism is measurable. The chat child's CLI defers MCP schemas, so the
model must fetch one before it can call anything — **160 `ToolSearch` calls
across 85 of 98 conversations, 159 of them explicit `select:mcp__uf__…` fetches**.
`ask_operator` is named in **3 of those 160 queries**, and the correlation is
exact: fetched in 3 conversations, called in 3, **the same 3**.

So the 1,100 characters of asking judgement at
`src/app/api/mcp/route.ts:302-321` — whose own comment calls it *"the whole of
what the model is told about asking"* — **were never read in 95 of 98
conversations.** What produces the behaviour instead is three restrictive bullets
at `src/lib/chat.ts:2544-2554` that never name a tool.

## The recommendation

**Ship B and C** — nine lines of prose in two files, two unrelated failure
domains, no interaction. [10-recommendation.md](10-recommendation.md) has the
replacement text.

1. **B — name the asking tool** (`src/lib/chat.ts:2543`, 4 lines added). Makes
   the deferred description reachable, without touching the three bullets that
   produce the 82.2%-propose / 2.0%-ask split. Deliberately procedural: this
   survey reads that split as designed behaviour.
2. **C — say what `promptOverride` is** (`src/app/api/mcp/route.ts:383`, 5 lines
   rewritten), in the words `save_template.prompt` already uses at `:283`. It
   repairs the only defect in the corpus with a receipt: one message of **23,626
   output tokens** wrote six proposals carrying a 6,921–8,381-character
   `promptOverride` and **no `task`**, was refused six times, and recovered by
   re-issuing all six with **one identical override** (SHA-1 `06a95436`) plus
   their own tasks.

Then **D — make each dependency field name the other**
(`src/app/api/mcp/route.ts:442`) if there is appetite for a third, and stop.

## The other findings, in brief

- **F3** — `on-finish` + `continueBranch` is the hazard the prompt names and the
  schema permits. **7 of 31** `on-finish` edges carry it; one is a
  documentation-only run told to record that other work shipped, starting on that
  run's branch *once it is out of the way either way*.
- **F4** — `continueBranch` states *"Only when both runs work in a checkout of
  their own"* as a fact about the world. It is a **guard the model cannot set**,
  and the description does not say where to look it up. Set on **149 of 450**
  proposals; only **30** name a template.
- **F5** — the duplicate check runs backwards: `list_proposals` before proposing
  on **61.9%** of first turns (nothing to duplicate) and **21.4%** of later ones
  (the panel is full).
- **F7** — the operator asked *"what order do I approve these in?"* in three
  separate conversations, while **81 of 85** dependency turns complied perfectly
  with the instruction to say they need one click. The rule is about the click;
  the question is about the sequence.
- **F6** — near-refuted. 50.7% of briefs touch guard vocabulary and almost none
  of it tries to set anything; **2 of 99** "budget" mentions quote a figure. Filed
  so a later tightening pass does not forbid the one useful pattern it found.
- **F8** — "Be brief" produces a median 2,188-character reply, because four other
  paragraphs each require a sentence. **Not worth fixing**; tightening it would
  delete compliance with the instructions that produce it.

## Refused by name

Capping proposals per message (the 20-proposal turn succeeded, and
`MAX_PENDING_PROPOSALS = 25` already bounds the panel); refusing `on-finish` +
`continueBranch` server-side (the combination is sometimes correct, and one of the
seven observed cases is coherent); putting `ask_operator` on the child's
`--allowedTools` (out of scope, and a behavioural bet nothing here supports);
moving the asking judgement into the prompt (`route.ts:293-296` decides against
it and the reasoning holds); weakening *"Prefer proposing with the assumption
stated"*; tightening *"Be brief"*; changing `list_runs`' placement; and any
guard-vocabulary tightening. Each with its reversing fact in
[10-recommendation.md](10-recommendation.md#refused-by-name).

## What would overturn it

**The operator saying the chat asks them too few questions.** This survey reads
2.0% as designed; if it is not, B stops being the fix and becomes a prerequisite,
and the change that matters is to `src/lib/chat.ts:2549-2551`. That single
sentence moves the recommendation more than any measurement here and is not
inferable from the transcripts. It is the blocking question in
[11-validation.md](11-validation.md).

## What was not examined

- **`/data`, at all.** Root-owned `0700`, deliberately not worked around.
- **The chat page.** No browser was driven; F7's diagnosis rests on three
  operator sentences, not a screenshot.
- **`propose_workflow`'s 135-line schema** (`route.ts:468-602`) — 2 calls in 152
  turns is not a corpus, and a finding about it would be reasoning dressed as
  measurement.
- **`BLOCK_TOOLS` / `emit_runs`** — the orchestrator *block*, a different subject.
- **`get_run_diff`** — **0 calls**. The one deliberately narrowed tool, and
  nothing in this corpus exercises it.
- **`src/app/chat/page.tsx`** (~25k) and **`docs/agent/chat.md`** in full.
- **Cost.** No figure here is in dollars; prices are not in the transcripts.

## Verification

`npm run typecheck` exit 0, with **nothing under `src/` changed**. The write
scope was `proposals/OrchestratorChatQuality/` plus one row in
`proposals/README.md`.

## Reading order

[00-problem](00-problem.md) →
[01-the-corpus](01-the-corpus.md) →
[02-findings](02-findings.md) →
options [A](03-option-a-change-nothing.md)
[B](04-option-b-name-the-asking-tool.md)
[C](05-option-c-standing-instructions.md)
[D](06-option-d-the-edge-pair.md)
[E](07-option-e-the-duplicate-check.md)
[F](08-option-f-the-approval-order.md) →
[09-comparison](09-comparison.md) →
[10-recommendation](10-recommendation.md) →
[11-validation](11-validation.md).
