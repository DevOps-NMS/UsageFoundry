# Option 2d — a choice with an "other, let me type" escape

[Option 2b](06-option-2b-single-choice.md) and
[Option 2a](05-option-2a-free-text.md) composed: prose, zero to five options
each carrying a `label` and a required `then`, and a free-text field in the card
for an operator whose answer is none of them. This is the shape.

It inherits 2b's whole argument — inert options, the `then` as both affordance
and bound — and adds exactly one thing, the escape. So this file argues the one
thing, because the one thing is where the real objection lives.

## What it is

The card renders the question, the option buttons if there are any, and a small
labelled text field. Every route out of the card — a clicked option, typed text
in the field — latches the `chat_questions` row and delegates to
`sendChatMessage`. What the model receives is the question restated with the
answer beside it, whichever route produced it.

Options are still labels echoed back as text. The escape field is still text.
Nothing here writes a field that gets acted on, so [C7](01-constraints.md#c7) is
satisfied for the same reason it was in 2b: **an answer's only effect is text
the model reads**, which is the standing the operator's typing already has.

## Why the escape is not redundant with the composer

This is the real question, and it deserves a direct answer rather than a
deflection, because the composer *is* right there. It is pinned to the foot of
the pane, takes ⌘↩ as well as Enter, and is deliberately never `disabled` — the
guard sits inside `send()` instead, so the textarea stays typable even while a
turn is in flight (`src/app/chat/page.tsx:493-496`, read directly;
`conventions.md:21` and [C14](01-constraints.md#c14) for the reasoning). An
operator who wants to type an answer can already type one, today, with no
feature shipped.

**The escape is not about being able to type. It is about the join.**

Text typed in the composer is an ordinary message. It arrives through
`POST /api/chat/[id]/message`, which reads exactly one field
([F4](00-problem.md#f4)), lands as `appendMessage(chatId, "user", text)`, and
carries nothing that says what it is about. Under the composite's supersession
rule it ends the open question by claiming the next turn without ever answering
it — see [Option 5a](13-option-5a-superseded.md).

Text typed in the card's own field is an **answer**. It latches the row, so the
question is closed as answered rather than superseded; it renders as the pair
[F4](00-problem.md#f4) says cannot be rendered today; and it reaches the model
with the question restated around it, so the model is not re-deriving which of
its questions this paragraph is about — which is the inference the question
existed to remove.

Those are two different facts about what happened, and **the app should be able
to tell them apart.** An operator who reads the question and answers it, and an
operator who ignores the question and says something else, have done different
things; a design where both produce the same row has rebuilt
[F2](00-problem.md#f2) one level up, with "answered" as the value that means two
things.

## What it costs

**Two text inputs on screen at once.** While a question is open there is a field
in the card and a composer at the foot of the pane, and "which box do I type in"
is a question the interface is now asking the operator. This is the strongest
objection to 2d and it should not be waved off: an interface that makes the
reader choose between two identical-looking affordances has moved work onto them
in exactly the way this proposal claims to be removing it.

Three things bound it, and they are design commitments rather than mitigations:

- **The card's field is small and labelled as answering *this* question** — a
  single-line input, not a second composer. It sits with the options, inside the
  card's bounds, so its association is positional as well as textual.
- **It exists only while a question is open.** There is no steady state in which
  both are present; the open question is a transient the operator is being asked
  to clear.
- **The composer keeps its own hint** ("⌘↩ or Enter sends", `page.tsx:943-946`
  per [F3](00-problem.md#f3)), so the two are not silently interchangeable.

**The alternative that was considered and rejected:** route the composer through
the answer route while a question is open. It removes the second input entirely
and it is wrong, because it records whatever the operator typed as an answer to
whatever was asked. An operator who types "actually, forget the tests, look at
the deploy script" has not answered "which repository" — and a design that
stores it as the answer makes `answered` mean "something was typed while a
question was open", which is not a fact anyone wants to read six turns later.
**A join that is sometimes false is worse than no join**, because the pair
renders either way and the rendering is what the operator trusts.

## The degenerate case

A question with `options: []` renders as prose plus the escape field, and is
then nearly indistinguishable from the composer sitting under it. That is the
honest cost of keeping [Option 2a](05-option-2a-free-text.md) as a first-class
sub-case, and it is accepted rather than designed around.

What discourages it is the **prompt, not the schema.** A schema that required at
least one option would not stop unenumerable questions being asked; it would
make the model invent branches for them, which is the failure 2a names and the
worse of the two. So the field stays optional, and the pressure moves to prose —
where a model that cannot name the branches is usually holding a question it
should have answered by reading, which is
[Option 8d](23-option-8d-unanswerable-by-reading.md)'s subject.

The `then` requirement does some of this work by itself: it applies per option,
so a model with no options escapes it, but a model with two options has to state
both consequences and will find out at that moment whether it has them.

## Verdict

**Recommended. This is the shape.** Prose plus 0..5 options, each with a `label`
and a required `then`, plus an escape field in the card. The options make
one-click possible, which is what [F4](00-problem.md#f4) says nothing on the
wire can do today. The `then` makes each click's consequence stated, which
`conventions.md:21` requires of every approval surface on this pane. And the
escape makes a typed answer an *answer* rather than an unrelated message that
happened to arrive while a question was open — which is the whole difference
between a question object and a sentence at the end of a reply.
