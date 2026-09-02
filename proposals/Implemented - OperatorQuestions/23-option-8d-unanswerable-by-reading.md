# Option 8d — a question is only for what no amount of reading could answer

The first of the three bounds on asking. It is prose, it is unenforceable, and
it is still the rule that decides most cases correctly — because the failure it
names is not subtle. Its companions are
[8c](22-option-8c-question-budget.md), which bounds how *often*, and
[8e](24-option-8e-branch-under-each-answer.md), which turns this file's
principle into something a schema can hold.

## The rule

> Ask only what no amount of reading could answer: what the operator wants,
> which of several jobs matters now, a fact about their intent or their
> calendar. Anything a `Grep`, a `git log`, a `gh` call or a build would tell
> you, find out.

Two clean sides. **Askable:** which of two repositories you meant; whether the
flaky test matters more than the migration this week; whether the refactor is
wanted at all. **Not askable:** which files the parser lives in; whether the
build is currently broken; what the last three commits did; whether the issue
has a reproduction attached.

## Why it is the existing principle rather than a new one

This is not a rule invented for questions. It is the rule the chat already runs
under, applied one step earlier.

`src/lib/chat.ts:2101-2105`:

> "You have every tool the CLI offers, and you are trusted with them because
> your job is to look, not to build […]"

`src/lib/chat.ts:2121-2122`:

> "Look before you propose."

And the reason the tool surface is as wide as it is — `docs/agent/chat.md:24`,
on why the allowlist was removed:

> An orchestrator's whole job is to find out enough to propose good work, and
> the allowlist this replaced […] **refused every question it had not
> anticipated** (a build log, `gh api`, `git -C <path> log`, anything compound),
> **which is a bad proposal an operator then approves believing it was
> researched.**

That paragraph is the strongest argument in the repository for this rule. The
allowlist was *removed*, at a real cost in blast radius — the chat can now write
into a checkout the operator also works in, and `githubEnv()`'s token
authenticates writes as well as reads — **specifically so the orchestrator could
answer its own questions.** A model that then spends the operator's attention on
something `Grep` would have told it has taken the widening and declined the
obligation that paid for it.

There is a second, quieter cost. Every question is a billed turn and so is its
answer ([F7](00-problem.md#f7)); reading is inside a turn the operator is
already paying for. Asking what could be read is *more* expensive than reading
it, not less — it just moves the cost onto a person.

## A test the model can actually apply

A principle a model cannot operationalise is decoration. The usable form:

> **Would this be answerable if I had the repository open in front of me for ten
> minutes?** If yes, open it.

"Ten minutes" rather than "at all" is deliberate. Almost anything is *in
principle* derivable from a repository — the operator's priorities are
sometimes inferable from what they have been committing — and a rule phrased as
"anything derivable" would forbid every question there is. The bound is on
effort a turn can afford, not on epistemology.

## The grey zone, and what resolves it

The rule is clean at the edges and genuinely ambiguous in the middle. "Which of
these two `auth.ts` files did you mean" is readable when one of them was touched
last week and the other has not moved since 2023, and unreadable when both are
live. "Should I fix the flake or delete the test" is a judgement about intent,
except when the test's own history says it was quarantined and forgotten.

This file does not resolve those, and pretending it does would be worse than
admitting it. What resolves them is
[Option 8e](24-option-8e-branch-under-each-answer.md)'s requirement that every
option state what it would lead to: **a model that has read enough to name what
each branch produces has done the reading**, and one that cannot fill the field
discovers, at the moment of writing it, that its question was a substitute for
looking. 8d says what to aim at; 8e is the only part of the pair with a
mechanism.

## What it costs

**It is unenforceable, and the file should say so rather than imply otherwise.**
Nothing in the app can tell whether a question was answerable by reading. There
is no signal to check: the tool sees a string, and the transcript of what the
model read before calling it is not something any handler here has. It cannot
be unit-tested either — [C13](01-constraints.md#c13)'s bar is a pure function
with a silent failure mode, and this is not a function at all.

So it will sometimes be ignored, and when it is, the only thing that notices is
the operator reading a question whose answer was in the repository. That is a
real limitation and it argues for 8e carrying the structural weight.

**It has a false-negative direction too**, and it is the more expensive one. A
rule stated firmly against asking pushes a model that is genuinely unsure back
toward the guess, which is [F1](00-problem.md#f1)'s existing failure — the
prompt's incentive is already one-directional and stated three times. The
wording therefore has to name what *is* askable as concretely as what is not,
which is why the rule above leads with three examples on the askable side. A
prohibition with no permitted case beside it reads as a prohibition on the whole
mechanism.

## What it does not say

It does not say "ask rarely". That is [8c](22-option-8c-question-budget.md), and
it is a different bound with a different justification — a question can be
perfectly unanswerable-by-reading and still be the fourth in a row, which is the
interrogation this survey exists to prevent.

It also does not say "read first, then ask". A model that has read the
repository and still needs to know which of two jobs matters this week should
ask immediately rather than reading further; the rule is about the *kind* of
fact, not about the order of operations.

## Verdict

**Recommended, as prompt prose, with its unenforceability stated in the same
breath.** It belongs in `systemPrompt()` rather than the tool description by
[C10](01-constraints.md#c10)'s own test — it is a judgement about this
conversation, not a fact about a call, and a description cannot reach a model
that has not yet decided to call the tool
([Option 8b](21-option-8b-tool-description-side.md)).

It carries no mechanism, and it should not be relied on to. Its job is to point
at the failure; 8e is what makes the failure hard to commit.
