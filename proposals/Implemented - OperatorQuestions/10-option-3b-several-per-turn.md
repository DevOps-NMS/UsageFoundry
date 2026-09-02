# Option 3b — several questions in one turn

The other half of fork 3, against [Option 3a](09-option-3a-one-question.md):
`ask_operator` may be called two or three times in a turn, the thread renders
the questions together, and the operator answers them in one visit. It is
refused, but not on a rule and not cheaply — its central argument is the only
one in this survey that is straightforwardly about the operator's own money and
time, and it wins on both.

## The strongest case, which is genuinely strong

**One round trip instead of three.** [C1](01-constraints.md#c1) settles that a
question ends the turn — a blocking `ask_operator` is a deadlock before it is a
timeout, since `sendChatMessage` refuses on `thinking` at `chat.ts:1480` and
again in `claimTurn` at `chat.ts:1498-1499`, so the turn holding the question
open holds the door shut against the only person who could answer it. Given
that, N questions asked one at a time is N turns, and every one of them is a
billed `claude -p` child under [C9](01-constraints.md#c9): the
`assistRefusal() ?? installBudgetRefusal()` gate, the `--max-budget-usd` ceiling
from `settings.chatTurnBudgetUSD` (`chat.ts:1700-1705`), a `chat_turn_spend` row
(`chat.ts:1975-1981`). The answers cost N more.
[F7](00-problem.md#f7) does the arithmetic: three questions asked one at a time
is six billed children before any work has been proposed.

Batching three into one turn is one child for the asking and one for the
answer — a third of the money — and it removes two of the three waits, each of
which is up to ten seconds of `POLL_IDLE_MS` (`page.tsx:361`,
[C3](01-constraints.md#c3)) plus however long it takes the operator to notice.
It also removes two of the three trips to the tab, which is the cost the
operator actually feels and the one no budget line records.

This should be stated without hedging: **if the model really does need three
facts, one-at-a-time is worse by every measure the operator can perceive.** The
case against batching cannot be that it is inefficient, because it is not.

## The screen

Three question cards arriving together is a form. The proposals panel is a
grouped box of rows because a proposal *is* a list item — several units of work,
each independently approvable ([F10](00-problem.md#f10), `page.tsx:1013-1021`).
A question is not a list item; it is one thing being asked of one person. Three
of them stacked, each with its own prose and its own row of up to five buttons,
is a questionnaire that arrived unbidden in the middle of a conversation. That
is the interrogation this brief names as the thing to avoid, rendered.

`conventions.md:21`, quoted in [C14](01-constraints.md#c14), says the transcript
"says who is speaking with structure, never with colour" and that the pane is
"plain prose at a readable measure with nothing drawn round it, because it is
what the reader came for". Three bordered cards in a row is the transcript
briefly ceasing to be a transcript.

## Partial answers

The operator answers two and ignores the third — because it is the one they have
no view on, which is often the one the model most needed. The model then gets an
incomplete answer set and does one of two things: it asks again, which spends
the round trip the batch was supposed to save, or it guesses.

**Guessing is the failure the whole mechanism was built to remove.** It is the
first paragraph of [00-problem.md](00-problem.md): the orchestrator guesses which
repository, proposes a card that is complete and correct in every field the
approval gate cares about, and is about the wrong repository. A design that ends
in a guess, having first spent a turn asking, has arrived at the original defect
by a longer and more expensive route.

The leftover is also permanent. [C6](01-constraints.md#c6) —
`retention.ts:632-634`, "there is no terminal state to key on" — means the
unanswered third row lives as long as the install and may not be given a clock.

## The join gets harder inside one turn

[F4](00-problem.md#f4)'s complaint is that nothing joins an answer to a
question: `appendMessage(chatId, "user", text)` (`chat.ts:1501`) writes into a
table whose columns are `id, chat_id, ts, seq, role, text` (`db.ts:598-607`),
and "if it asked three things and got one paragraph, matching answers to
questions is inference, and inference is what the question was supposed to
remove." A batch reintroduces exactly that, one level down: the answer route
latches a row, so three rows need three latches, and a free-text escape typed
into one card's box is a paragraph that may answer any of the three. The
structure that makes a single question honest degrades as the batch grows.

## The deeper objection

Take the efficiency argument at full strength and it turns into its own
refutation: **it is an argument for asking more, not for asking better.**

A cap of three makes three the target. That is not cynicism about models, it is
the observed reason [C8](01-constraints.md#c8) exists — `chat.ts:231-241`
describes "open a run for every issue" against a repository with four hundred of
them, and bounds it in the tool precisely because a model given room to produce
N of something produces N. A per-turn allowance of three questions is read as
permission to have three questions, and the turn that would have asked the one
question that mattered asks it with two makeweights attached.

The same argument does *not* apply to proposals, and the difference is the point.
A proposal is inert: `db.ts:609-621` says it "holds no folder claim, consumes no
concurrency slot and nothing derived from `activeRuns()` can see it… until an
operator approves it, it is form input." Twenty-five bad proposals cost a scroll
and a click. A question *blocks* — it is a request for the operator's attention,
and attention has no approval gate. Nothing stands between the model's decision
to ask and the operator's obligation to read. That asymmetry is why the cap that
is generous for proposals is one for questions.

## What would overturn this

Say it plainly, because the concession is real. If measurement showed that
questions cluster in twos — "which repository" and "how deep", asked together
because neither is useful alone — a cap of two would be a defensible revision,
and it would be a revision rather than a redesign. The storage carries no unique
constraint on open questions per chat; the bound lives entirely in the tool's
door check, which is the same place [C8](01-constraints.md#c8)'s number lives and
is one edit. Nothing in the `chat_questions` table, the answer route or the
renderer assumes exactly one, only that each answer names its question.

What that revision would still owe is the interface: two cards must read as one
decision rather than as a form, and the partial-answer path must do something
better than guess. Neither is solved here and neither is impossible.

## Verdict

**Refused, on the interrogation cost.** The efficiency case is correct and is
conceded — three questions batched is a third of the money and a third of the
wall clock. It is refused because the batch turns a conversation into a form,
because a partial answer routes back to the guess the mechanism exists to
remove, and because a per-turn allowance is read as a target by the same
mechanism [C8](01-constraints.md#c8) was written to bound. The revision path is
named above and costs one number in one door check, so this is a refusal that
measurement can reopen — which is the right shape for a refusal made on a
judgement about behaviour nobody has measured yet.
