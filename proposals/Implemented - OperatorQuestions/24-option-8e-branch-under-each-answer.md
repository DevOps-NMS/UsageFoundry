# Option 8e — every option states what it would lead to

The third bound on asking, and the only one of the three with a mechanism. It is
one required field on the tool schema, and it does three unrelated jobs at once
— which is why it is the recommendation's spine rather than one more sentence in
a prompt.

## The rule

`ask_operator`'s `options` are objects, not strings, and each carries a required
`then`: one line saying what the model would propose if the operator picked it.

```ts
options: [
  { label: "the API repo",  then: "propose one run to fix the flaky auth test there" },
  { label: "the web repo",  then: "propose two runs: the failing snapshot suite, then the lint sweep" },
]
```

A question with no enumerated answers (`options` omitted) carries the same
obligation in the prose of the question itself. The schema cannot force it
there, and the prompt says it anyway.

## What it buys, three times over

### 1. The click becomes informed

`docs/agent/conventions.md:21` states what a proposal card owes its reader, and
the clause is not about proposals in particular:

> Everything that makes a proposal card approvable is unchanged and must stay:
> the guard set spelled out (including the untemplated one), a rewritten prompt
> marked, the dependency order named, **what the click starts counted in words**,
> and the explicit list of the ids the page displayed on the wire.

An option button with no stated consequence asks the operator to choose blind.
It is a smaller decision than approving a run — nothing starts —  but it is the
same defect in a smaller box, and this app has already decided that a control
which leads somewhere says where.

### 2. It is a bound on asking that enforces itself

This is the argument to lead with, and it is the reason this option outranks its
two companions.

[8d](23-option-8d-unanswerable-by-reading.md) says: do not ask what reading
would answer. It is true and it is unenforceable — nothing in the app can see
what the model read. [8c](22-option-8c-question-budget.md) says: do not ask too
often. It is true and both of its numeric forms are refused.

`then` is different, because **a model that has not read enough to say what each
branch produces cannot fill the field.** The obligation is discharged at the
moment of writing, by the model, against its own knowledge — no handler has to
adjudicate anything. A question asked to avoid thinking arrives at `then` and
has nothing to put there.

That converts a principle into a schema obligation without anyone having to
verify a claim. It is the cheapest enforcement available on a surface where
[C13](01-constraints.md#c13)'s testable-pure-function bar cannot reach.

### 3. It exposes the question that changes nothing

If two options have the same `then`, the answer does not change what happens.
The model can see it while writing; the operator can see it on the card. The
implementation sketch takes this further and **refuses** the call at the door
([C11](01-constraints.md#c11) — a refusal is tool output the model can act on),
which is the one place the requirement can be checked mechanically rather than
merely asked for.

Worth being precise about what that check is worth: it catches the literal
duplicate and nothing else, and a model can trivially evade it by rewording. It
is not a defence against a determined bad question. It is a tripwire for the
careless one, which is the common case.

The third audience matters most and is easy to miss: **the operator can see
it.** A card whose two buttons lead to the same sentence is visibly a waste of
their attention, and they can say so. That is the only real audit this feature
has — nothing else in the app can judge whether a question was worth asking.

## The second-order rule that follows

Once every branch has a stated consequence, a question the model was about to
ask often turns out not to need asking at all:

> **Prefer proposing and asking to asking and waiting.** If there is work worth
> doing whatever the answer, propose it and ask as well — the answer then
> refines the next proposal instead of holding everything up.

This is the strongest anti-interrogation device in the survey, and it works by a
different route from every other option here: it **removes the reason to
interrogate** rather than capping the interrogation. A question that blocks
nothing costs the operator nothing, so the pressure to bound it falls away.

It is only reachable because of `then`. Without the field, "is there work worth
doing under every answer?" is a question the model has no occasion to ask
itself; with it, the model has just written both branches down and the overlap
is in front of it.

A bare question is then reserved for the case the mechanism actually exists for:
**the branches are materially different work**, so proposing under a guess would
spend an approval click and a run on the wrong thing. That is a narrow case, and
it should be.

## What it costs

**`then` is model-written prose and nothing validates it.** A model can write a
plausible `then` it has not thought through, exactly as it can write a plausible
proposal `task`. The field is a prompt for thought, not a proof of it, and
claiming otherwise would be the kind of confident-and-wrong sentence this
directory is supposed to avoid.

**It lengthens the card.** A five-option question is ten lines of text before the
operator has read a button. That is a direct argument for the small option cap
in the implementation sketch — the two decisions are coupled, and a design that
allowed eight options would have to drop `then` or accept a form.

**It is more schema than the minimum.** `ask_operator` could have been two
strings. It is now a string and an array of two-field objects, with a door check
per option ([C11](01-constraints.md#c11)). That is real complexity bought with a
behavioural argument rather than a mechanical one, and a reader who does not
accept the behavioural argument should reject the field.

**It does not apply cleanly to the free-text question.** With `options` omitted
there is nothing to hang `then` on, so the obligation reverts to prose and to
[8d](23-option-8d-unanswerable-by-reading.md)'s unenforceability. The
recommendation accepts this and leans on the prompt's discouragement of
unenumerable questions rather than inventing a `then` field on the question
itself — a single "what I would do next" line on a question with no branches is
just the reply, and the reply is already there.

## What would overturn it

If, in use, `then` lines turn out to be uniformly generic — "propose a run for
it" under every option — then the field is costing schema complexity and card
height and buying nothing, and the honest response is to delete it rather than
to write a stricter description. That is checkable by reading ten questions'
worth of rows, and it is on the validation list
([28-validation.md](28-validation.md)).

## Verdict

**Recommended, required rather than optional.** It is the only one of the three
bounds that a mechanism can carry, it is what makes the one-click answer an
informed decision rather than a guess with a button on it, and the
propose-and-ask rule it unlocks is the survey's best answer to the question the
brief asked hardest — what stops the orchestrator interrogating the operator
instead of looking at the repository.
