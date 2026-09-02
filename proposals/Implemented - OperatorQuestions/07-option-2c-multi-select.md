# Option 2c — multi-select

[Option 2b](06-option-2b-single-choice.md) with the constraint relaxed: the
operator ticks any subset of the options and one answer carries several
selections. It is refused, and it is refused on the strongest ground available —
not that it is hard, and not that it is unsafe, but that **the question it
exists to ask already has a mechanism, and that mechanism is better than this
one.**

## What it is

The card renders checkboxes rather than buttons, plus a confirm control. The
answer is a list of labels rather than one, restated to the model as text.
Technically it is a smaller change than 2b was — the storage, the cap and the
inertness argument from 2b all carry over unchanged, and nothing in
[C7](01-constraints.md#c7) objects, since a list of labels is still only text
the model reads.

## The strongest case

**The question is real and single choice cannot express it.** "I found five
things worth doing here — which should I work on?" is the most natural question
an orchestrator has after reading a repository, and it is exactly the shape the
brief's fork is meant to cover. Forcing it into a single choice makes the model
either ask five separate questions — which [F7](00-problem.md#f7) prices at six
billed children and six round trips through a page polling at ten seconds — or
pick one arbitrarily and ask about it, which is the guess again with extra
steps.

That case is good enough that the refusal has to answer it rather than
sidestep it. It does.

## Why it is refused

### 1. That question is answered by proposing, not by asking

"Which of these should I do" is what the proposals panel is *for*. The model
proposes the five, the operator approves a subset, and the ones not approved are
rejected or left. The answer is the same answer — with one difference: the
proposals panel discloses what a multi-select question structurally cannot.

**The proposals panel is already a multi-select over things the model
produced.** Rows in one grouped box (`src/app/chat/page.tsx:1013-1021`), a
checkbox per row (`:1272-1278`), and Select all / Reject / Approve in the action
row (`:1076-1100`) — all read directly. It is the same interaction, built, on
the same pane.

### 2. It carries what the question could not

What a proposal row states and a question option does not: the guard set spelled
out including the untemplated one, the folder, the agent, the dependency order,
and a rewritten prompt marked. `conventions.md:21` names those and says
**everything that makes a proposal card approvable is unchanged and must stay**,
ending with *"what the click starts counted in words"* — which the app renders
outside the scroll region at `page.tsx:1067-1070` from the sentence built at
`:628-644`, so that a twentieth proposal cannot push it off the top of the list
it is about (both verified).

And on the wire it carries the **explicit list of the ids the page displayed**.
`docs/agent/chat.md:8`: *"The approval route takes an explicit list of ids the
page displayed, so a proposal the chat added between render and click is not
swept into an approval nobody saw."*

A multi-select question has none of this and cannot acquire it without
[C7](01-constraints.md#c7) being violated: the moment an option carries a guard
set or a folder, the answer route is writing fields that get acted on, which is
the second route to a guard the constraint closes by name.

### 3. So it is a worse copy of the approval gate, sitting beside it

Two multi-select surfaces on one pane, meaning different things, with different
disclosure. That is the failure — not that the second one is redundant, but that
an operator has to learn which set of checkboxes is the consequential one.

The second-order risk is worse and is named in the constraints already.
[C8](01-constraints.md#c8), verbatim from `chat.ts:231-241`: *"an approval list
nobody can read is an approval gate that gets clicked through, which is the same
as not having one."* An operator trained by low-stakes tick boxes in the
transcript — where the worst outcome is that the model reads the wrong labels —
will bring that same attention to the panel, where the click starts unattended
agents that spend real money. **2c does not degrade the question surface; it
degrades the approval gate.**

### 4. It also breaks the one-open-question bound's meaning

The composite allows one open question per chat, refused at the door. A 5-of-8
multi-select is eight yes/no answers wearing one row's clothing, so the bound
stops bounding the thing it was chosen to bound — how much the model may ask
before it has to go and read something. A cap of one question that admits an
eight-part question is a cap in name only.

## What the refusal does not claim

It does not claim the model should never surface several candidates. It should —
by proposing them, where every candidate arrives with its guards, its folder and
its consequence counted, and where rejecting four of five is one click on
Reject after ticking them.

Nor does it claim `chat_proposals` is a comfortable fit for exploratory
candidates. It is not: five proposals is five rows against a cap of 25
([C8](01-constraints.md#c8)), and the operator reads five full cards to dismiss
four. That cost is real. It is still the right cost, because the alternative
buys a cheaper interaction by removing the disclosure that made the decision
safe.

## Verdict

**Refused by name, with the replacement named.** "Which of these should I do" is
not a question, it is a set of proposals — propose them and let the approval gate
be the multi-select, because it is the multi-select that spells out the guards,
the folder, the order and what the click starts. A second, thinner tick-box
surface in the same pane would compete with it, disclose nothing, and teach the
operator to click through the one that matters.
