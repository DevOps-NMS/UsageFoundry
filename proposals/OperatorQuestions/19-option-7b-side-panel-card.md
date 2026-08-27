# Option 7b — a card beside the proposals

The other half of fork 7, and the option [F10](00-problem.md#f10) points
straight at: the app already has a working answer to "the model produced
something and a person must decide about it", and it is twenty pixels from the
thread. This option puts a question card in that column.
[Option 7a](18-option-7a-inline-in-thread.md) is the recommendation; 7b is
refused, and one thing it is right about is taken.

## The strongest case

**The layout is solved, and it is good.** Proposals are rows of one grouped box
(`page.tsx:1013-1021`), selection is a `--selection` wash rather than a border,
the consequence of the action is spelled out in words above the action row
(`page.tsx:1067-1070`), and the action row puts the one default action at the
right edge — `Select all` left, `Reject` pushed over with `ml-auto`, `Approve`
last (`page.tsx:1076-1100`). `conventions.md:21` states all of that as the rule
rather than as a description. A question card dropped into that column would
inherit a decided answer to every layout question it has, and would not have to
invent the third treatment [Option 7a](18-option-7a-inline-in-thread.md) has to
argue for.

**It is findable in one place.** "Things this thread wants from me" would be one
column rather than two, which is a real property for an operator who has left a
thread and come back.

**And there is room.** [C14](01-constraints.md#c14) caps a `SegmentedControl`
strip at five, and the chat's strip holds at most three (`page.tsx:210`,
`:587-595` — Proposals always, Decided when there is something decided, Chats
when there is more than one thread). A fourth segment is within the cap. Unlike
the sixth-tab case on the run page, this option is not refused on a count.

**It keeps the thread pure prose**, which `conventions.md:21` explicitly wants:
"plain prose at a readable measure with nothing drawn round it". That is a cost
7a pays and this option does not.

## Why it is refused

### 1. The pane's contents are decisions about work; a question is not one

Everything in that column is a decision whose consequence is a run. Approving a
proposal starts work: `planProposal` turns the row into a run, under guards a
person configured, and the consequence sentence above the button exists because
the click is expensive and irreversible in the way starting an agent is.
Answering a clarifying question starts nothing at all — under
[C7](01-constraints.md#c7) and [Option 6b](17-option-6b-answer-route.md) its
only effect is text the model reads, with exactly the standing the operator's
own typing has.

Putting the two in one column teaches the operator that everything in that
column carries the same weight. That is the direction [C8](01-constraints.md#c8)
warns about in the sentence it bounds `MAX_PENDING_PROPOSALS` with: "an approval
list nobody can read is an approval gate that gets clicked through, which is the
same as not having one." The cap exists because a gate degrades when the column
holding it fills with items that do not each deserve a decision. A question is a
cheap click sitting in the column whose whole value is that its clicks are not
cheap, and the direction it moves the operator's habit is the wrong one.

### 2. The conversation would be split across two columns

The question would be in the panel. Its answer is a `user` message and therefore
in the thread — it cannot be anywhere else, because the model reads the thread
through `listMessages` and nothing else ([F8](00-problem.md#f8)). The reason for
the question is the model's reply, also in the thread, immediately above where
the question would have been.

So the operator reads a reply that stops mid-thought, looks right for the
question, clicks, and looks left again for what happened. And
[F4](00-problem.md#f4)'s asked/answered pair becomes unrenderable in either
place: the panel has the question without the answer, the thread has an answer
with nothing above it to explain what it answers. Six turns later the record of
what was decided is worse than the prose it replaced, because it is prose with a
hole in it.

### 3. The tab rules make an arriving question invisible

`page.tsx:195-209` records the two rules the side strip is offered on: **a tab
exists only when there is something behind it**, and **nothing switches tabs on
its own** — "a proposal arriving while somebody is reading another list must not
move them". Both are right and neither should be relaxed for this.

Together they mean a question arriving while the operator sits on the Decided or
Chats tab is invisible until they happen to switch. That is
[F3](00-problem.md#f3)'s defect rebuilt one level down: the app knows it is
waiting on the operator, the operator is looking at the page, and no observable
signal says so. The comment at `:206-208` already names the workaround for the
same problem with proposals — the badge is drawn beside the control from any
tab, not on the Proposals segment. A question would need its own version of that
workaround, which is a badge pointing at a tab pointing at a card, to say
something the thread could have said by containing it.

## The one thing it is right about, and where that goes

**A thread that is waiting must be findable from a thread you are not in.** That
is real, it is [F3](00-problem.md#f3)'s sharpest observation — the sidebar row
shows `thinking` for a turn in flight and a `{pendingCount} waiting` badge for
undecided proposals (`page.tsx:1553-1556`), and a thread holding an unanswered
question shows neither — and no amount of putting the question in the right
place inside a thread fixes it.

The recommendation takes it, in the smaller form: the derived `awaitingAnswer`
boolean on the DTOs reaches that sidebar row, so the thread that is waiting
carries a marker beside the two that already exist. That is one flag on a list
entry that is already rendered. It is not a panel card, it is not a fourth tab,
and it does not put a question in the column where decisions about work live.

## Verdict

**Refused, with its good half adopted.** The panel is the right shape for
proposals and the wrong column for a question: it mixes a free click in with
expensive ones, splits the conversation across two columns so the asked/answered
pair renders in neither, and hides an arriving question behind a tab that
nothing may switch. What 7b sees correctly — that a waiting thread must be
visible from outside itself — is answered by `awaitingAnswer` reaching the
sidebar, which
[Option 7a](18-option-7a-inline-in-thread.md) carries.
