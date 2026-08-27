# Recommendation

**Build it — and build the object before the buttons.** One `chat_questions`
row, one `ask_operator` tool whose every option says what it would lead to, one
answer route, one card in the thread, and one derived flag that makes the
sidebar honest. The behavioural half splits along the line
[C10](01-constraints.md#c10) already draws, and its load-bearing rule is not a
cap on asking but a redirection of it: **propose under your best guess and ask
as well.**

The full shape is in [27-implementation-sketch.md](27-implementation-sketch.md).
This file says why, what the second-best is, and what would make me wrong.

---

## The design

| Fork | Chosen | File |
|---|---|---|
| 1 — where it lives | a `chat_questions` table, anchored into the thread by a `chat_messages.seq` | [02](02-option-1a-questions-table.md) |
| 2 — what it may be | one choice from ≤5 model-written options, each carrying a required `then`, plus a free-text escape in the card | [08](08-option-2d-choice-with-other.md), [06](06-option-2b-single-choice.md) |
| 3 — how many | one open per chat, refused at the tool's door | [09](09-option-3a-one-question.md) |
| 4 — the status | no fourth `chat_sessions.status`; a derived `awaitingAnswer` on both DTOs | [11](11-option-4a-idle.md) |
| 5 — when ignored | superseded when the next turn is claimed; never deleted; no clock | [13](13-option-5a-superseded.md) |
| 6 — the answer's route | a dedicated route that latches the row, then delegates to `sendChatMessage` | [17](17-option-6b-answer-route.md) |
| 7 — where it shows | inline in the thread, interleaved by `seq`; the sidebar carries the marker | [18](18-option-7a-inline-in-thread.md) |
| 8 — behaviour | mechanics in the tool description, judgement in `systemPrompt()`; all three bounds, with `then` required | [20](20-option-8a-prompt-side.md), [21](21-option-8b-tool-description-side.md), [22](22-option-8c-question-budget.md), [23](23-option-8d-unanswerable-by-reading.md), [24](24-option-8e-branch-under-each-answer.md) |

Refused by name: multi-select ([07](07-option-2c-multi-select.md)), several
questions per turn ([10](10-option-3b-several-per-turn.md)), a fourth status
value ([12](12-option-4b-awaiting-answer-status.md)), a side-panel card
([19](19-option-7b-side-panel-card.md)), an ordinary-message answer
([16](16-option-6a-ordinary-message.md)), and both numeric question budgets — a
setting and a hard per-chat cap ([22](22-option-8c-question-budget.md)).

## Why build it at all

The honest case against is short and should be read first: the operator can
already type, the model can already end a reply with a sentence, and making
asking *easy* is a real behavioural risk on a surface whose whole job is to
propose. Nothing in this survey can measure whether the chat gets better or
worse, so the case has to rest on something that is true independent of how the
model behaves.

There is one such thing. **Today a chat that asked and a chat that finished are
the same row**, so the app cannot tell the operator they are being waited on:
the spinner is gone, the composer's hint is back to "⌘↩ or Enter sends", and the
sidebar shows nothing at all ([F3](00-problem.md#f3)). An operator supervising
several threads learns they were asked something only by reading the last
paragraph of one of them. That is a defect in the app whatever the model does,
and it cannot be fixed without an object — there is nothing honest to derive
"waiting" from.

Everything else in this design is downstream of needing that object. Given a
row, the one-click answer costs an options array and a card; given a card, the
`then` field costs one string and buys the only enforceable bound on asking
there is.

## Why this shape rather than a bigger one

Three refusals are worth naming here because they are what keeps it small.

**A question is not a second approval gate.** Multi-select was refused because
"which of these five should I do" already has a mechanism, and it is better:
propose them and let the operator approve a subset, on cards that spell out the
guard set, the folder, the agent and what the click starts. Two multi-select
surfaces in one pane that mean different things is how an approval gate becomes
something people click through ([C8](01-constraints.md#c8)).

**A question is not a state of the chat.** It is a state of a *question*. Fork 4
kept it out of `chat_sessions.status` because ten readers of that column would
have to be corrected by hand with no compiler to help, and because a chat can be
`failed` and awaiting an answer at once — one enum cannot hold two facts.

**A question is not a budget.** [C9](01-constraints.md#c9) refuses per-chat money
thresholds as "a threshold nobody set", and the same reasoning refuses a
question quota. What bounds asking here is structural (one at a time), schematic
(`then`), and visible (consecutive question cards are legible to the operator in
a way a silent quota is not).

## The behavioural answer, stated plainly

The brief asked two behavioural questions. The answers:

**When should it ask instead of propose?** *Almost never instead — usually as
well.* If there is work worth doing whatever the answer, propose it and ask; the
answer refines the next proposal rather than holding everything up. A bare
question is reserved for the case where the branches are materially different
work, so proposing under a guess would spend an approval click and a run on the
wrong thing.

**What stops it interrogating over five turns?** Four things, in descending
order of how much they are relied on:

1. `then` on every option — a model that cannot say what a branch produces has
   not read enough to have a question ([8e](24-option-8e-branch-under-each-answer.md)).
2. Propose-and-ask — a question that blocks nothing creates no pressure to ask
   again.
3. One open question per chat, refused at the door with a sentence
   ([3a](09-option-3a-one-question.md)).
4. The prompt's rule that a question is only for what reading cannot answer —
   true, and stated in its own file as unenforceable
   ([8d](23-option-8d-unanswerable-by-reading.md)).

And one thing that is not a mechanism but is the only real audit: **the operator
can see it happening.** Three question cards in a row is legible. That is worth
more than a quota, because the operator can act on it and a quota cannot be
argued with.

## Second best

**A column on `chat_sessions` holding one free-text question**
([1c](04-option-1c-session-column.md) + [2a](05-option-2a-free-text.md)):
`open_question TEXT`, nulled when answered, the composer routing through an
answer that clears it, and the same derived `awaitingAnswer` flag on the DTOs.

It is roughly a fifth of the code. It gets the whole of
[F3](00-problem.md#f3) — the honest panel, the sidebar marker, the operator
learning they are being waited on — and it enforces one-question-at-a-time for
free rather than buying it with a door check.

What it gives up: the one-click answer, the asked/answered pair, and any record
that a question was ever asked once it is answered (a nulled column says
nothing, which is the failure `src/lib/chat.ts:1370-1372` describes for a turn
that stops without a word). It also gives up `then`, and with it the only
enforceable bound on asking — so its behavioural half would be prose alone.

If the appetite for this is a day rather than a week, build that. It is not a
worse version of the recommendation; it is the recommendation's first milestone
with the second one declined.

## What would overturn the choice

Four things, in the order they are likely to happen.

**Operators type instead of clicking.** If, over a few dozen questions, the
free-text escape is used more than the option buttons, then options are dead
weight: they cost a schema, a door check, a card layout and the whole `then`
argument, and the second-best design becomes the right one. This is the most
likely of the four and it is directly measurable —
`SELECT answer_option IS NULL, COUNT(*) FROM chat_questions WHERE status='answered' GROUP BY 1`.

**`then` lines come out generic.** If they are uniformly "propose a run for it",
the field is buying card height and nothing else, and the honest response is to
delete it rather than write a stricter description. Ten questions is enough to
tell. This would not overturn the whole design, but it would remove its spine
and leave fork 8 resting on prose — at which point the per-chat cap refused in
[8c](22-option-8c-question-budget.md) deserves reopening.

**A chat turn turns out to be expensive.** Fork 3's one-at-a-time rule costs two
billed turns for two facts, and this survey could not read what a turn costs on
this install — `DATA_DIR` is not openable from a work cycle. At a few cents the
argument holds; at a dollar, batching two questions becomes worth its screen
cost and 3b should be reopened. The cap lives in one door check, so the revision
is one number.

**A `Record<ChatStatus, …>` reader appears.** If anything in the app ever indexes
a map by chat status — a status chip with a tone map, say — the compiler starts
catching fork 4's ten sites, and the case against a real `awaiting-answer` value
weakens sharply. The derived flag would still be defensible on the
`failed`-and-awaiting argument, but it would stop being obvious.

## The kill criterion, decided now

If the orchestrator asks a question in more than about one turn in five, the
mechanism is being used as a substitute for reading and should be **removed**
rather than tuned. Tuning would mean tightening the prompt, and
`docs/agent/chat.md:24` already records what happened the last time this surface
was bounded by refusing things the model wanted to do: it produced worse
proposals that an operator approved believing they were researched.

The measurement is one join between `chat_questions` and `chat_turn_spend`
(`src/lib/chat.ts:1975-1981`), and it should be taken before anyone argues about
it.

## What I am least sure of

That the model will use `then` as intended rather than as a field to fill. It is
the design's spine and it is unvalidated prose all the way down — nothing checks
that a `then` is true, only that it exists and differs from its siblings. If
that assumption is wrong, three of the four anti-interrogation devices go with
it, and what is left is a mechanism that makes asking easier with nothing much
making it rarer. That is the version of this feature that would make the chat
worse, and it is the one the validation plan is pointed at.
