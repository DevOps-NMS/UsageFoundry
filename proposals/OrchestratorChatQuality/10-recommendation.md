# The recommendation

[← The comparison](09-comparison.md) · [Next: validation →](11-validation.md)

**Ship B and C.** Nine lines of prose across two files, in two unrelated failure
domains, with no interaction between them. Then D if there is appetite for a
third, and stop.

Ranked, with the reason each earns its place:

| Rank | | What it changes | Why here |
|---|---|---|---|
| **1** | **B** — name the asking tool | 4 lines added to `src/lib/chat.ts:2543` | Repairs the only failure that fires on **95 of 98** conversations |
| **2** | **C** — say what `promptOverride` is | 5 lines rewritten at `src/app/api/mcp/route.ts:383` | The only defect with a receipt; the repair cannot make a correct call incorrect |
| **3** | **D** — make each dependency field name the other | ~14 lines at `src/app/api/mcp/route.ts:442` | Highest cost-of-failure in the survey; least verifiable |
| 4 | **F** — say the order, not just the rule | 5 lines at `src/lib/chat.ts:2578` | Strongest evidence, but the fix may belong in the panel |
| 5 | **E** — move the duplicate check | 3 lines at `src/lib/chat.ts:2556` | No duplicate was ever observed |
| — | **A** — change nothing | — | Carried as a **constraint**, below, not discarded |

---

## 1. B — name the asking tool

**File:** `src/lib/chat.ts`. **Anchor:** the line `"Asking the operator:"` at
`:2543`, immediately before the existing `"- Ask only for what only they know: …"`
at `:2544`.

Insert as the first bullet of that block:

```ts
    "- When you do ask, it is `ask_operator`: it records the questions, ends",
    "  your turn, and the operator's next message is the answer. Read its",
    "  description before you use it — the judgement about what is worth asking",
    "  is in there.",
```

**Change nothing else in that paragraph.** The three existing bullets at
`:2544-2554` produce the 82.2%-propose / 2.0%-ask split, and this survey has no
measurement saying that split is wrong. What changes is *which text* produces it:
after this, a model that declines to ask has declined for the reasons at
`src/app/api/mcp/route.ts:302-321`, rather than never having read them.

**Why the wording is procedural.** Every clause is a fact about mechanism —
what the tool is called, what it does, that the answer arrives as a message.
None of it encourages asking. That is deliberate: B must not move a rate
[Option A](03-option-a-change-nothing.md) argues is already correct.

**Why the second clause is duplicated from the description.** `src/lib/chat.ts:2480-2482`
and `src/app/api/mcp/route.ts:293-296` both say the tool-calling half of the
instructions belongs in the description and is *"deliberately not repeated in the
prompt"*. That reasoning holds and B does not disturb it — 1,000 of the 1,100
characters stay where they cannot drift from the schema. One fact is copied:
that the tool does not return an answer. It is copied because it is the only
sentence whose absence costs a **whole turn's budget** rather than a worse
decision, and `src/app/api/mcp/route.ts:296-300` says exactly that:

> ```
> // that reads this as "returns the operator's answer" calls it, gets a
> // receipt, calls it again, and spends the turn's whole budget asking the
> // same question in a loop
> ```

**If a maintainer objects to the duplication**, the fallback is the first and
third clauses only — `"- When you do ask, it is \`ask_operator\`. Read its
description before you use it."` That is 2 lines and still fixes the reachability
problem, at the cost of the one fact worth insuring against.

---

## 2. C — say what `promptOverride` is

**File:** `src/app/api/mcp/route.ts`. **Anchor:** `:383-388`.

Replace:

```ts
        promptOverride: {
          type: "string",
          description:
            "Replaces the template's own prompt for this run only. Use when " +
            "the template nearly fits; the task is still appended below it.",
        },
```

with:

```ts
        promptOverride: {
          type: "string",
          description:
            "Standing instructions replacing the template's own prompt, for " +
            "this run only. Use when the template nearly fits. It does not " +
            "replace the task, which is still required and is still appended " +
            "below it — and because it is standing text rather than this " +
            "run's brief, a batch of related proposals normally carries the " +
            "same override word for word.",
        },
```

Three sentences doing three jobs, in descending order of value:

1. **"a batch of related proposals normally carries the same override word for
   word"** — the sentence the corpus proves is missing. The failing message wrote
   six *distinct* overrides of 6,921–8,381 characters; the retry that worked used
   **one identical string** (SHA-1 `06a95436`, 5,058 chars) across all six. The
   model discovered this for itself at a cost of one re-spent 23,626-token
   message.
2. **"It does not replace the task, which is still required"** — the confusion
   itself. The server already catches it, so this buys a prevented failure where
   there is currently a recovered one.
3. **"Standing instructions"** — the words `save_template.prompt` already uses at
   `src/app/api/mcp/route.ts:283` (*"The standing instructions every run from
   this template starts with. The per-run task is appended below it."*). The
   distinction was written once and belongs in both places.

**Do not touch `task`'s description** at `:403-408`. Its three clauses map onto
three measured behaviours — 97.1% name a verification word, 96.9% name a concrete
file, 21.6% carry an issue number or URL. It is the best-performing instruction
in the surface.

---

## 3. D — the edge pair, if a third is wanted

**File:** `src/app/api/mcp/route.ts`, `:442-455`. Full replacement text is in
[06-option-d-the-edge-pair.md](06-option-d-the-edge-pair.md#the-change-to-edge)
and is not repeated here.

Two independent halves, and **they can ship separately**:

- **D-a, the `continueBranch` half** (`:449-455`): adds *"which is a guard you do
  not set — check the template's isolation, or the default guard set's, in
  `list_templates` before you set this"*. This is the safer half and the one
  worth taking if only one is taken. 149 proposals set `continueBranch` and only
  30 name a template; the field states a precondition as a fact about the world
  without saying where the answer lives.
- **D-b, the `edge` half** (`:442-448`): copies the system prompt's own hazard
  clause into the schema. Riskier — 85% of edges are already `on-success`, and a
  nudge toward it could push the remaining 15% wrongly.

If both ship, apply the same change to `propose_workflow`'s equivalent fields at
`src/app/api/mcp/route.ts:574-587` **only after** D has been observed for a
fortnight. Two `propose_workflow` calls in 152 turns is not evidence, and copying
an unmeasured fix into an unmeasured surface is how a description acquires text
nobody can justify later.

---

## Refused by name

Each of these was considered and is rejected, with the fact that would reverse it.

- **Capping proposals per message.** The failing message had ten `propose_run`
  calls; the corpus maximum is 20 and that turn succeeded.
  `MAX_PENDING_PROPOSALS = 25` (`src/lib/chat.ts:310`) already bounds the panel
  and the corpus maximum sits under it. A cap would trade a rare recoverable
  failure for a common hard one. *Reversed by:* a second observed instance of the
  F2 shape at a **lower** proposal count.
- **Refusing `on-finish` + `continueBranch` server-side.** The combination is
  sometimes correct — two independent batches of issue fixes in one repository,
  serialised, where the second is worth doing either way, is one of the seven
  observed cases and is coherent. A hard refusal forces `on-success` and drops
  the second batch when the first crashes. *Reversed by:* a run outcome showing
  an agent actually committed onto a crashed branch believing the work landed.
- **Putting `ask_operator` on the child's `--allowedTools`.** Out of scope
  (spawn argv, `docs/agent/security.md`'s routing) and, worse, a behavioural bet
  nothing here supports: `ToolSearch` appears from the first conversation
  (2026-08-11) to the last (2026-09-02), including on turns that called
  `propose_run`, so a name on the argv is not known to switch deferral off.
- **Moving the asking judgement out of the description and into the prompt.**
  `src/app/api/mcp/route.ts:293-296` decides against it and the reasoning holds:
  the description cannot drift from the schema and the prompt can.
- **Weakening *"Prefer proposing with the assumption stated in your reply"***
  (`src/lib/chat.ts:2549-2551`). 82.2%-propose is the designed behaviour and
  nothing measured here says it is wrong. *Reversed by:* the operator saying they
  want to be asked more — one sentence, not inferable from the transcripts, and
  the blocking question in [11-validation.md](11-validation.md).
- **Tightening "Be brief"** (`src/lib/chat.ts:2591`). The median reply is 2,188
  characters because four other paragraphs each require a sentence and **107 of
  125** replies name the guard set, **83** the window, **81 of 85** the same-click
  rule. Shortening the adjective would delete compliance with the instructions
  that produce it. Any fix is to the *list of required sentences*, not the
  adjective — and no such fix is proposed, because every sentence on the list
  earns its place.
- **Changing `list_runs`' placement** alongside E. Its 63.2% has the same
  first-turn skew, but the failure it prevents — work already in flight, started
  by an earlier turn or by hand — is one a first turn genuinely needs to check.
- **Adding anything about guards to the task-writing instruction.**
  [F6](02-findings.md#f6) found 50.7% of briefs touching guard vocabulary and
  almost none of it attempting to set anything. The one recurring pattern —
  *"If budget or work cycles run short, finish fewer notes properly and seed the
  rest"* — is a useful sentence, and a tightening pass would forbid it.
- **A `MAX_OPEN_QUESTIONS` change.** Five cannot currently read as a target,
  because it is only visible inside a description read in 3 of 98 conversations.
  Revisit **after** B, not before: the one observed reading of that sentence
  produced a 4-question call, which is the largest number the prompt names as bad.

## The constraint Option A contributes

**Eight instructions measure well and none of them may be disturbed** by any
change here: look-before-you-propose (89.6%), the brief's length and specificity
(median 4,946 chars, 96.9% naming a file), the window mention (73.6% / 83 of
125), the guard-set statement (107 of 125), the same-click rule (81 of 85),
do-not-repeat-the-briefs (0 of 125 echo), do-not-edit-a-workspace (3 `Write`
calls, all outside the mounts), and the folder rule — **446 of 450** proposals
carry both `mountId` and `folder`, the other 4 omit both, which
`src/app/api/mcp/route.ts:412` explicitly permits (*"Omit to use the template's
own folder"*), and **no proposal in the corpus was refused for an unknown mount
or folder**.

That rules out the obvious global repair — *"the prompt is 98 lines, shorten it"*
— because the length is where the compliance comes from. Every recommendation
above is additive or a same-length rewrite for exactly this reason.

## What would overturn the whole recommendation

**The operator saying the chat asks too few questions.** B is deliberately
procedural because this survey reads 2.0% as designed behaviour. If the operator
wants a consultative chat rather than a dispatcher, B is the wrong shape: the
change would be to `src/lib/chat.ts:2549-2551` — the *"prefer proposing"* bullet
— and B becomes a prerequisite rather than the fix. That single sentence moves
this recommendation more than any measurement in the survey, and it is not
inferable from the transcripts. It is the blocking question in
[11-validation.md](11-validation.md).
