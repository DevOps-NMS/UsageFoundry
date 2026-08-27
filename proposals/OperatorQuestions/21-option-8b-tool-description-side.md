# Option 8b — the behavioural half goes in the tool description

The rival to [Option 8a](20-option-8a-prompt-side.md): put what the model needs
to know about asking in `ask_operator`'s own schema, where it sits beside the
call it governs. Most of what this option claims is right, and the part that is
wrong is wrong in a way that decides the fork cleanly.

## The case, which is strong for everything except the one thing

[C10](01-constraints.md#c10) makes the argument itself, in the prompt's own
docblock (`chat.ts:2078-2088`): the schema "is the copy that cannot drift from
the tool, because it *is* the tool". A description cannot fall out of step with
the handler, because the two are edited in the same file next to each other,
and a sentence in `systemPrompt()` about what a tool does can be wrong for
months without anything failing.

The token argument is a wash rather than a win, and should be stated as one. The
tool list and the appended prompt "arrive in the same request", so a sentence
costs the same either way. What the description buys is *locality*: it is read
at the moment of the call, not recalled from a paragraph ninety lines up.

House style, verified at `route.ts:287-291`:

```ts
      description:
        "Propose one run for the operator to approve. This does NOT start " +
        "anything: it records a proposal that a person approves or rejects by " +
        "hand. Guards come from the template — or from the operator's default " +
        "guard set when no template is named — and cannot be set here.",
```

Three habits to copy. The critical negation goes in SCREAMING caps. The negative
space is stated outright rather than left to inference — "cannot be set here" is
doing as much work as anything positive in the string. And the sibling tool that
supplies a value is named on the property that takes it, not in the prose: "id
from list_agents" (`route.ts:307-316`), "Mount from list_folders"
(`route.ts:327-331`), "id from list_templates" (`route.ts:295-300`).

One more thing worth keeping true. `CHAT_TOOLS`' docblock reads *"Tools only the
orchestrator chat gets. None of them starts anything."* (`route.ts:247`,
verified). `ask_operator` starts nothing, so the sentence survives the addition
unchanged — and [C11](01-constraints.md#c11) means the orchestrator-block
refusal ([F9](00-problem.md#f9)) comes free with membership.

## What genuinely belongs here

Everything about the *call*, and the list is longer than it looks:

- **It does not block, and the turn ends.** [C1](01-constraints.md#c1) is the
  most important fact in the whole feature and it is a fact about the call. A
  model that thinks the tool returns an answer will write a reply that reads as
  though it already has one.
- **One question may be open, and a second call is refused**
  ([Option 3a](09-option-3a-one-question.md)) — the shape of the refusal, so the
  model is not surprised by it.
- **`then` is required, and what it means.**
- **What an empty `options` array means** — a prose question the operator types
  into, rather than a broken call.
- **The option cap, with its reason attached**, on [C8](01-constraints.md#c8)'s
  mechanism: a refusal is a sentence the model reads and acts on
  (`text(message, /* isError */ true)`, `route.ts:777-779`).

Written out:

```ts
  {
    name: "ask_operator",
    description:
      "Ask the operator one clarifying question and end your turn. This " +
      "does NOT wait for an answer: the turn ENDS here, and the answer " +
      "reaches you at the start of a later turn. Only one question may be " +
      "open in a conversation — while one is unanswered, a second call is " +
      "refused. Every option must say what you would propose if it were " +
      "chosen.",
```

and its properties, each carrying its own description as every leaf property in
this file does:

```
question:      "The question, in one or two sentences. Say what you already
                looked at, so the operator is not asked for something you
                could have read."
options:       "Up to five answers the operator can click. Omit it, or pass
                an empty list, when the answer is open and the operator
                should type. Do not invent branches to fill the list."
options.label: "What the button says. Short: 'the web app', 'after the
                release cut'."
options.then:  "What you would propose if the operator picked this — one
                clause, e.g. 'one run rewriting the fixtures'. Required. If
                two options would have the same one, the answer does not
                change what you do, and the question is not worth asking."
```

## The limit, which is the whole point of the file

**A description cannot say "prefer proposing over asking", because it has
nowhere to stand.**

The model reads `ask_operator`'s description when it is considering calling
`ask_operator` — which is to say, after the decision this instruction is meant
to govern has already been made. A sentence there arrives one step too late to
be the thing that stopped the call. Worse, it is the wrong reader's copy: the
turn that should have read "propose under your best guess" is the turn that
never opened this description at all, because it went to `propose_run` or — the
case that costs money — because it guessed silently and proposed badly.

A rule about *choosing between two tools* cannot live inside one of them. That
is not a style objection; it is a fact about when descriptions are read. The
only surface that is in front of the model before it has chosen is the appended
system prompt, which is [Option 8a](20-option-8a-prompt-side.md).

The tempting compromise is a one-line nudge in the description anyway — "when
every answer would still lead to work worth doing, prefer propose_run and ask as
well". Refuse it. It is read too late to change the outcome, it duplicates a
sentence the prompt already carries, and C10 moved copy out of the prompt
precisely to stop paying twice per turn for text that exists elsewhere. Paying
twice in the other direction is the same defect.

## A new tool is a new place for C10's hazard

The paragraph ends with a standing warning: *"Before deleting a sentence from a
description over there, check it is not the only copy left."* Two sentences in
this feature will be the only copy of themselves, and they are worth naming now
so a later tidy-up does not take them:

- **"the turn ENDS here"** exists nowhere else. `systemPrompt()` must not gain a
  second copy, so the description is load-bearing and permanently so.
- **the meaning of `then`** likewise. The prompt says when to ask; only the
  schema says what the field is for, and a model that reads `then` as a label
  writes a card that fails [Option 8e](24-option-8e-branch-under-each-answer.md)
  while type-checking clean.

The hazard runs the other way too: the refusal text for a second open question
will exist both as a runtime sentence (the shape `pendingLimitMessage` has at
`route.ts:1357-1366`) and as a clause in this description. That duplication is
deliberate and cheap — one is read before the call, one after — but it should be
written down as deliberate, or someone will helpfully delete one.

## Verdict

**Recommended for the mechanics — and the split with 8a is the answer, not a
compromise.** Everything about the call goes here, in this file's voice, with
the negation in caps and the negative space explicit; the schema is the copy
that cannot drift. The one thing it cannot carry is the choice between asking
and proposing, because a description is read only by a model that has already
made that choice. That is not a shortcoming to be worked around with a nudge
sentence: it is the clean line between the two halves, and following it means
neither half repeats the other.
