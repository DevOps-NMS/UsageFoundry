# Option 2a — free text only

The question is prose and nothing else. The model writes a sentence or two, the
operator types an answer, and the answer is joined to the question by the row
rather than by its shape. There is no options array, no button row, and no
decision to make about what an answer looks like on the wire.

It is the floor of this fork. [Option 2b](06-option-2b-single-choice.md) and
[Option 2d](08-option-2d-choice-with-other.md) are this plus structure;
[Option 2c](07-option-2c-multi-select.md) is this plus structure the app
already has twenty pixels away. Everything below is an argument about whether
the structure earns itself, and this file is the case that it does not have to.

## What it is

The `chat_questions` row holds prose and `asked_after_seq`. The card renders the
text inline in the thread and marks the thread as awaiting an answer. The
operator answers in the composer — which is where they would have answered
anyway — or, if the composed design's escape field is kept, in the card.

Stated precisely: **what this adds over today is the object, not the
interface.** The model can already end a reply with a question
([F1](00-problem.md#f1) shows the prompt steering it away from doing so, not a
mechanism preventing it). What it cannot do is leave behind anything the app can
read.

## The strongest case, and it is real

**It is nearly free.** Against [C11](01-constraints.md#c11)'s three edits for a
new chat tool, 2a needs the smallest possible version of each: one string
property on the `inputSchema`, one `case` that inserts a row. No options array
to describe in the house style [C10](01-constraints.md#c10) requires of every
leaf property. No per-option validation at the door. No cap to choose, defend
and enforce. No button row to design against the closed vocabulary in
[C14](01-constraints.md#c14) — which matters more than it sounds, since `Icon`'s
name union carries no question-mark glyph and a card built around one would need
the union opened first.

**It can express any question.** Enumeration is a lossy encoding of a question
and prose is not. "What should the acceptance test be", "what does 'clean up'
mean for this repository", "is the flake in CI the same one you mentioned" —
none of these has a small closed answer set, and 2a asks them all at the same
cost as asking which of two mounts was meant.

**It never puts the model in the position of writing four wrong choices.** An
option set is a claim that the branches are known. A model that does not know
them and is offered a field for them will fill it, and the operator then reads a
false dichotomy presented with the confidence of a button row. 2a cannot fail
that way because it has nowhere to fail.

**And the two defects it fixes are the two expensive ones.** The operator can
already type: the composer is pinned to the foot of the pane and is deliberately
never `disabled` — the guard sits inside `send()` instead, so the textarea stays
usable even while a turn is in flight (`src/app/chat/page.tsx:493-496`, read
directly; the reasoning is `conventions.md:21` and
[C14](01-constraints.md#c14)). 00-problem says the same thing in its own words:
this is *"Not a fix for the operator having to type."* So what is left for any
option in this fork to fix is [F3](00-problem.md#f3), the "waiting on you"
signal that the sidebar badge already knows how to draw and a question cannot
reach, and [F4](00-problem.md#f4), the asked/answered pair. **2a fixes both, in
full, and neither fix depends on a single button existing.**

A reader could reasonably stop here. On the problem statement's own framing —
*"a chat that asked and a chat that finished are bit-for-bit the same row"* —
2a is a complete repair.

## What it costs

**It does not deliver what was asked for.** The brief says answerable in one
click. 2a has no click. That is not a quibble about scope: one-click is the
thing [F4](00-problem.md#f4) names as impossible today ("A button needs
something to send that is not free text"), and an option that leaves it
impossible has declined the fork rather than answered it.

**The deeper cost is that the disambiguation work goes straight back onto the
operator's typing.** The guess in 00-problem's opening is attractive to the
model precisely because it spares the operator a round of exact recall. Asked
"which repository did you mean?" in prose, the operator has to produce a name
that matches something the model will accept, from memory, in a textarea with no
completion for it — the `@`-mention popover names agents, not folders
(`docs/agent/chat.md:14`). A question that trades one turn of guessing for one
turn of typing a path has moved the cost, not removed it.

**And a free-text question is indistinguishable in effort from what the model
can do today.** Ending a reply with a sentence costs the model nothing and
already happens. If the question object changes no part of the exchange except
what the app records about it, then the entire justification for a table, a
route, a tool and a card rests on a badge and a rendered pair. Those are worth
having — but they are a thin return on that much surface, and it is worth saying
so rather than letting the row's cheapness stand in for its value.

## It must exist as a sub-case whatever else is chosen

This is the part of 2a that survives its own refusal.

Some questions have no enumerable answers, and a schema that requires options
does not stop those questions being asked — it makes the model invent options
for them. That is a worse failure than prose, because a fabricated option set
looks authoritative in a way a fabricated sentence does not: the operator reads
three buttons as three branches the model actually considered.

So the recommendation allows `options: []`, and the prose-only question is a
first-class shape rather than a degenerate one.
[Option 2d](08-option-2d-choice-with-other.md) says what it renders as, and why
the *prompt* rather than the schema is what should discourage overusing it.

## Verdict

**Not chosen as the whole answer; retained as the floor.** It is the correct
fallback, and it is the correct behaviour whenever the model cannot name the
branches — which is a real and recurring case, not an edge one. What it cannot
be is the whole fork's answer, because it leaves one-click impossible and leaves
every disambiguation costed in the operator's typing, which is the cost that
made guessing look reasonable in the first place.
