# Option 8a — the behavioural half goes in `systemPrompt()`

Fork 8 is about behaviour, and behaviour has to be written down somewhere. This
option puts *when to ask* in the appended system prompt;
[Option 8b](21-option-8b-tool-description-side.md) puts it in `ask_operator`'s
description. They are presented as rivals and they are not one: the split
between them is the answer, and this file argues for the half that lands here.

## The test is already written down

[C10](01-constraints.md#c10) is not a preference about where copy goes. It is a
decision with a stated reason, in `systemPrompt()`'s own docblock
(`chat.ts:2078-2088`):

> **The half about calling tools lives in `src/app/api/mcp/route.ts` and is
> deliberately not repeated here.** […] the schema is the copy that cannot drift
> from the tool, because it *is* the tool. What survives here is only what no
> schema can carry: an instruction to look before proposing, the facts a
> description has no field to hang on […] and **what to *say* in the reply,
> which is about this conversation rather than about a call.**

So the question is not "which file is nicer to edit". It is: *is this sentence
about a call, or about this conversation?*

## When to ask is about this conversation, and nothing else could be

The judgement is made out of the conversation's own state. How much of the brief
is underdetermined; how much of that would be settled by ten minutes of reading;
whether the branches lead to different work or to the same work with a different
label; whether a proposal made under a guess would still be worth approving. Not
one of those is a property of the call. There is no field on any schema that
could hold "the operator's last message named a repository, so the folder is not
the ambiguity here" — the input to the decision is the thread.

The same is true of the budget on asking ([Option 8c](22-option-8c-question-budget.md)).
"One question per topic; a second means you are guessing at the shape of the
work" is a rule about the arc of a conversation. A schema can enforce *one open
at a time* — that is a fact about the call and it belongs in the description —
but it cannot express what a second question means about the model's grasp of
the work.

And it is the same for the reply. `chat.ts:2173-2175` already specifies what to
say after proposing, on exactly this ground; what to say after asking is the
same kind of sentence, in the same place.

## The prompt does not merely omit asking — it forecloses it

This is the finding, and it is why a description-only change is not on the menu.
[F1](00-problem.md#f1) names three sentences, and each is an instruction the
model would be reading *against* a new tool.

**`chat.ts:2096-2099`** — a closed list of two:

> "The two things you can do are propose_run and propose_workflow, and both
> only record a proposal the operator approves or rejects by hand."

**`chat.ts:2139-2140`** — true of the run agent, and silent about the difference:

> "The task text is the whole brief, read by an agent that cannot ask you a
> follow-up question."

Nothing distinguishes "the agent you are briefing cannot ask" from "you cannot
ask". Once the orchestrator *can*, the distinction has to be drawn, and drawing
it strengthens the original sentence rather than weakening it.

**`chat.ts:2173-2175`** — a reply shape for one ending:

> "Be brief. When you have proposed, reply with a short list of what you
> proposed and what you deliberately left out."

A model that asked has proposed nothing and has no instruction for its reply.

Leave these and ship the tool, and the child reads a description saying it may
ask inside a prompt saying there are two things it can do. The prompt is the
boundary on this child (`docs/agent/chat.md:24`); a boundary that contradicts
the tool list is worse than either half alone.

## The text

Three edits and one new paragraph. Written in the register of the surrounding
lines — second person, short, bulleted sub-rules.

Replacing `chat.ts:2096-2099`:

```
You cannot start, stop or resume a run, and you cannot press Run on a
workflow. What you can do is propose_run, propose_workflow and
ask_operator, and a proposal only records something the operator approves
or rejects by hand. Say so plainly rather than implying work has started.
```

Replacing `chat.ts:2139-2140`:

```
- One proposal per unit of work. The task text is the whole brief, read by
  an agent that cannot ask you a follow-up question. You can ask, here;
  it cannot, there — so everything it will need has to be in the brief.
```

Replacing `chat.ts:2173-2175`:

```
Be brief. When you have proposed, reply with a short list of what you
proposed and what you deliberately left out. When you have asked, say in
one line what you already read and what the answer would change. What you
proposed and what you asked appear in the panel beside this conversation,
so do not repeat their full text.
```

And the new paragraph, which is fork 8's behavioural half entire — the "when" of
this option, [8c](22-option-8c-question-budget.md)'s budget line,
[8d](23-option-8d-unanswerable-by-reading.md)'s reading rule, and
[8e](24-option-8e-branch-under-each-answer.md)'s second-order rule:

```
Asking the operator:
- Prefer proposing under your best guess and asking as well, over asking
  first. When every answer leads to work worth doing now, propose it and
  put the question beside it: the answer refines your next turn instead of
  blocking this one, and it costs the operator nothing to leave it.
- Ask on its own only when the answers are materially different work, so a
  guess would waste an approval and a run.
- Ask only what no amount of reading could answer — intent, priority, what
  the operator knows and you cannot see. Anything Grep, `git log`, `gh` or
  a build would tell you is reading, and you have all of them.
- One question per topic. Wanting a second means you are guessing at the
  shape of the work: say that, and propose the smallest thing you are sure
  of.
```

## What it costs

**Every turn pays for it.** `systemPrompt()` rides `--append-system-prompt`
(`chat.ts:1659-1660`) on every spawn, so these lines are tokens on turn one and
on turn forty. That is the cost C10 already priced when it moved the tool copy
out; adding ~14 lines back is a real charge and the argument has to be that they
buy something a schema cannot.

**It cannot be tested.** [C13](01-constraints.md#c13)'s bar is a pure function
with a silent failure mode; prose in a string array is not one, and no assertion
in `npm test` distinguishes a prompt that produces good judgement from one that
does not. `docs/agent/chat.md:24` makes this the *whole* boundary on a child
running `bypassPermissions` with no allowlist — which cuts both ways. It is the
most load-bearing text in the app and the least verifiable thing in it, and
those are the same sentence.

**It can be reasoned around.** A door check is a fact; a paragraph is advice
weighed against everything else in a ninety-line prompt (`chat.ts:2090-2177`).
That is precisely why the mechanics belong in the description and the structural
one-at-a-time cap belongs in the tool
([Option 3a](09-option-3a-one-question.md)) — this option is not a claim that
prose is sufficient, only that it is the correct home for the part that cannot
be made structural.

## Verdict

**Recommended for the "when" and the budget.** *When asking beats proposing* is
a judgement about this conversation's state, made out of inputs no schema
carries, and C10's test routes it here without ambiguity. The three foreclosing
sentences have to change regardless of where the rest lands: the feature is
incoherent while the prompt still says there are two things the model can do.
The costs — paid per turn, untestable, arguable-with — are stated rather than
absorbed, and two of them are the standing costs of this child having a prose
boundary at all.
