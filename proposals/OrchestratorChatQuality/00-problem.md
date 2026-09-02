# The problem

[← Proposal index](README.md) · [Next: the corpus →](01-the-corpus.md)

## The question

The orchestrator chat is the panel where an operator talks to a model that
proposes runs and workflows but cannot start them. **What makes a chat with it
good, and what makes it bad?**

The behaviour is produced by exactly two things, and both are text:

1. **`systemPrompt()`** — `src/lib/chat.ts:2495-2595`, whose body is 98 lines —
   and what `chatPrompt()` (`src/lib/chat.ts:968`) composes around it per turn.
2. **The thirteen MCP tool declarations** in `src/app/api/mcp/route.ts:149-603`.
   Eight shared (`SHARED_TOOLS`, `:149`), five chat-only (`CHAT_TOOLS`, `:254`).
   Each `description` and each parameter `description` is read by the model every
   turn it can see the tool at all. They are prompt, not documentation, and the
   file says so — `src/app/api/mcp/route.ts:292-300` calls `ask_operator`'s
   description "the whole of what the model is told about asking".

Nothing else moves the needle. The mode is `bypassPermissions` with no tool
allowlist (`src/lib/chat.ts:2047-2048`), the model is fixed by
`settings.defaultModel`, and the only other lever is `chatTurnBudgetUSD`. So a
survey of chat quality is a survey of two blocks of prose.

## What "good" has to mean here

A proposal is approved by a person who is trusting it to have looked. That gives
four things a good turn has to do, in the order the cost of getting them wrong
runs:

| | What a good turn does | What it costs when it fails |
|---|---|---|
| **1** | Produces a brief a downstream agent can execute with nobody to ask | A run that burns a full budget on the wrong thing |
| **2** | Gets the ordering right, or leaves it out | Two agents in one checkout, or a chain dead after step 1 |
| **3** | Spends the operator's attention once | A form, a re-read, a turn spent on bookkeeping |
| **4** | States what it assumed and what it left out | An approval nobody can audit afterwards |

The fifth thing — not setting a guard — is not a quality question here, because
the schema has no field for it. `propose_run` carries `templateId`,
`promptOverride`, `agentId`, `title`, `task`, `mountId`, `folder`, `id`,
`dependsOn` and nothing else (`src/app/api/mcp/route.ts:374-465`). There is no
budget field, no permission mode, no isolation choice. That is the whole reason
the feature is safe and it is not in scope for this survey except where the
*absence* changes what the model writes in the fields it does have — which it
does, and F6 is that finding.

## Two premises in the brief this survey was given, both refuted

Both matter, and both move the problem rather than shrink it.

**"Proposes vaguely" does not happen.** The brief asks "what lets a two-line task
through". Across **450 observed `propose_run` calls** the median `task` is
**4,946 characters / 789 words**; **1.3%** are under 500 characters and every one
of those six is the *same* defect (F2), not a laconic brief. **97.1%** name a
verification word, **96.9%** name a concrete file, **31.8%** carry a `file:line`.
The surface already pushes hard toward executable briefs. The real problem at
this end is the opposite shape and it is F2.

**"Does not look before it proposes" does not happen either.** **89.6%** of
proposing turns called `Read`, `Grep`, `Glob` or `Bash` first — 957 `Bash` calls
in total, median 5 per turn, max 25. **73.6%** called `get_usage` before the
first `propose_run`, and **82 of those 92** replies then said something about the
window. Window awareness, which the brief asks whether anything makes natural, is
one of the strongest compliance numbers in the corpus.

## The finding that replaces them

**The orchestrator has never once decided, on its own, to ask the operator a
question.**

`ask_operator` was called **3 times in 152 turns (2.0%)**, and all three
followed an operator message that explicitly told it to use the feature —
*"can you use the new question interface"*, *"Please ask some questions with the
tool you have"*, *"if you have questions use the question feature to ask me
them"*. It does not ask in prose either: at most **1 of 147** replies contains a
genuine question sentence.

Whether that is a success or a failure is the survey's central question, because
the prompt asks for exactly this behaviour — *"Prefer proposing with the
assumption stated in your reply"* (`src/lib/chat.ts:2549-2551`). The evidence
that it has gone too far is that the operator had to type *"use the question
feature"* twice, a month apart, in near-identical words. See
[F1](02-findings.md#f1).

## What this survey does not decide

It recommends changes to two blocks of prose. **Nothing under `src/` was
changed**, and the boundary was absolute: no prompt edit, no tool-description
edit, no schema change. Every recommendation in
[10-recommendation.md](10-recommendation.md) is written as replacement text so a
later run can apply it without re-deriving the reasoning.
