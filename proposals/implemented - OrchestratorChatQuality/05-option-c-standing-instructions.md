# Option C — say what `promptOverride` is, in the words `save_template` already uses

[← Option B](04-option-b-name-the-asking-tool.md) · [Next: Option D →](06-option-d-the-edge-pair.md)

**Answers [F2](02-findings.md#f2).** Two sentences rewritten in one tool
description; nothing added to the prompt.

## The change

`src/app/api/mcp/route.ts:383-388` as it stands:

> ```
> promptOverride: {
>   type: "string",
>   description:
>     "Replaces the template's own prompt for this run only. Use when " +
>     "the template nearly fits; the task is still appended below it.",
> },
> ```

Proposed:

```
promptOverride: {
  type: "string",
  description:
    "Standing instructions replacing the template's own prompt, for this " +
    "run only. Use when the template nearly fits. It does not replace the " +
    "task, which is still required and is still appended below it — and " +
    "because it is standing text rather than this run's brief, a batch of " +
    "related proposals normally carries the same override word for word.",
},
```

Four changes, each answering something the corpus showed:

| Added words | What they fix |
|---|---|
| *"Standing instructions"* | The word `save_template.prompt` already uses (`route.ts:283`) and the one thing `promptOverride`'s description never said it was |
| *"It does not replace the task, which is still required"* | The exact confusion in `da349f53` — six calls carrying a 6,921–8,381-character override and no `task` |
| *"a batch of related proposals normally carries the same override word for word"* | The repair the model found for itself on the retry: one identical 5,058-character string (SHA-1 `06a95436`) across six proposals, where the failing message wrote six distinct ones |
| *"for this run only"* kept, demoted | It is true and it matters; it just should not be the **first** thing read, because as an opening clause it reads as an instruction to compose per-proposal |

## Why the last clause is the load-bearing one

The refusal message already says the second thing —
`A proposal needs a task. It is the whole brief the agent gets besides the
template's own prompt.` It is a good message, it fired six times, and the model
recovered from it in one message. So *"the task is still required"* buys a
recovered turn rather than a prevented failure.

What is not said anywhere, and what the retry proves the model had to discover
for itself, is that **the override is normally shared across a batch**. That is
the sentence that stops the model writing 44,000 characters of near-duplicate
standing instructions in one message. It is the difference between a 23,626-token
message and the 15,930-token one that replaced it — and the replacement was still
doing the right work, just without six redundant copies.

## What this does not touch

**The prompt's line on the pair stays as it is.**
`src/lib/chat.ts:2561-2562` —

> ```
> "- Use promptOverride rather than contradicting the template inside the task,",
> "  and say that you rewrote it.",
> ```

— is about a different failure (contradiction between the two halves) and the
corpus shows no instance of it. Adding a second `promptOverride` sentence to the
prompt would put the same fact in two places for no measured reason;
`src/lib/chat.ts:2478-2482`'s rule is that the description is where a fact about
a field's argument belongs.

**The batch size is not capped.** The obvious alternative repair to F2 is to
bound how many proposals one message may carry — the failing message had ten
`propose_run` calls and the corpus maximum is 20. That is
[refused in the recommendation](10-recommendation.md#refused-by-name): the
20-proposal turn succeeded, `MAX_PENDING_PROPOSALS = 25`
(`src/lib/chat.ts:310`) already bounds the panel — the corpus maximum sits
**under** that cap — and a cap on the message would trade a rare recoverable
failure for a common hard one.

## Cost

| | |
|---|---|
| Lines changed | 5 in `src/app/api/mcp/route.ts`, none elsewhere |
| Tokens added | ~35 to a description the model reads only when it fetches `propose_run`'s schema — which it does on 85 of 160 `ToolSearch` queries |
| Risk | Low and one-directional. The added text describes existing behaviour; nothing here can make a correct call incorrect |
| Risk it does nothing | Moderate. The failure fired once in 152 turns and only at ten proposals in one message. A fortnight of chats might contain zero instances either way |
| Verifiable | Yes: `scripts/sharp.mjs` scans for `propose_run` calls with an empty `task`; `scripts/final.mjs` prints the per-message `promptOverride` hashes that show repeated-versus-distinct overrides |

## A second, smaller repair in the same description

While in this file: `task`'s own description
(`src/app/api/mcp/route.ts:403-408`) is —

> ```
> "The full brief for the agent: what to do, the issue number and " +
> "URL if there is one, and what done looks like.",
> ```

— and it is **working**, on the numbers: 97.1% of tasks name a verification word,
96.9% name a concrete file, 21.6% carry an issue number or URL. The three clauses
map onto three measured behaviours. **Change nothing here.** It is named only so
that a later pass tightening `promptOverride` does not tidy its neighbour on the
way past.
