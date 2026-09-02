# Option 7a — the question renders in the thread

Fork 7 asks where the question and its answer surface. This option puts them
where the rest of the conversation is, interleaved with messages by `seq`.
[Option 7b](19-option-7b-side-panel-card.md) is the other half of the fork and
puts the question beside the proposals; it is refused, with one thing it is
right about carried over here.

## A question is a turn, not an artefact

The placement rule is already written down and it decides this. The chat's side
strip is documented as "The three lists that stand beside the conversation, one
at a time" (`page.tsx:195-209`), its type is
`type SideTab = "proposals" | "decided" | "chats"` (`:210`), and the control
that switches it is labelled, in the markup, **"What to show beside the
conversation"** (`page.tsx:989-994`). Everything in that column is something the
model *produced* for a person to act on afterwards, or a list of other subjects.

`docs/agent/conventions.md:21` gives the pane the complementary half: "The
answer is the pane: plain prose at a readable measure with nothing drawn round
it, because it is what the reader came for."

A clarifying question is not beside the conversation. It **is** the
conversation — the model's turn, in the model's voice, addressed to the person
reading the pane. Putting it in the column labelled "what to show beside the
conversation" is a category error before it is a layout choice, and
[C14](01-constraints.md#c14) supplies the third confirmation from the other
direction: a modal is out by name, since a question is not destructive, not
irreversible and handles no credential.

## Reading order, and the pair

The turn that asks does not consist only of the question. It says what it found,
what it can propose, and what it cannot decide — and *then* it asks. Split
across two columns, the operator reads the reason on the left and the question
on the right, and has to reconstruct the join that the question existed to
remove. The order the model wrote its reasoning in is the order it should be
read in, and one column is the only arrangement that preserves it.

The stronger form of the same point is [F4](00-problem.md#f4)'s asked/answered
pair. Under [Option 6b](17-option-6b-answer-route.md) the answer is a `user`
message in the thread — it has to be, because the model reads it through
`listMessages` and nothing else ([F8](00-problem.md#f8)). So if the question
lives anywhere but the thread, **the pair can never render as a pair**: one half
is a message, the other half is not, and no scrollback shows both. Inline, the
pair is what it is in life — a question with the answer under it, six turns
back where the operator left it.

## The mechanism: interleave by `seq`

`asked_after_seq` on the question row holds a `chat_messages.seq` value, and the
page merges the two lists on it. `seq` is the right anchor and
[C5](01-constraints.md#c5) says why in three parts: it is a single global
sequence taken inside the INSERT — `(SELECT IFNULL(MAX(seq), 0) + 1 FROM
chat_messages)`, "the only shape in which the next number cannot be handed out
twice" (`chat.ts:327-331`); it is never null, backfilled `seq = rowid` on every
boot rather than on the one that added the column (`db.ts:915-916`); and
`listMessages` already orders by it alone, with nothing else in the ORDER BY
(`chat.ts:312-316`).

**One wire change is forced.** `ChatMessageDTO` is `{ id, ts, role, text }`
(`apiTypes.ts:2382-2387`) — it carries no `seq`, so today the page has nothing
to merge on. Adding it is additive and the field is already non-null on every
row, but it has to be named as a change rather than assumed.

## What binds the card

`conventions.md:21` constrains the treatment more tightly than a new element
usually is:

- **Who is speaking is said with structure and never with colour.** So the card
  is distinguished by its shape and position, not by a tint.
- **The operator's own words are a bezelled block pulled right.** A question is
  not the operator's, so it is not that.
- **A `system` turn keeps its own treatment**, because "a sentence about what
  the app did, rendered as though the model said it, is one the operator will
  later attribute to the wrong party." [F6](00-problem.md#f6) runs that argument
  backwards: a question is the model speaking in the chat, and the quiet
  hairline `system` box (`page.tsx:1135-1148`) would read as the app announcing
  something. So the card may not borrow that treatment either.

A question therefore needs a **third** treatment, built from what already
exists. [C14](01-constraints.md#c14) lists what is imported at `page.tsx:23-36`,
and records that `Icon`'s name union is closed (`Icon.tsx:19-52`) with no
question-mark glyph in it — verified: the union runs from `dashboard` through
`chevron-down`, `folder`, `guard`, `dot`, `check`, `close`, and there is no
question mark. The card is drawn without one.

## Costs

**The thread gains a non-prose element**, and `conventions.md:21` wants it not
to: the pane is "plain prose at a readable measure with nothing drawn round it,
because it is what the reader came for". A bordered card in that column is a
real departure and should be argued for rather than waved through.

The argument is the clause's own justification. The rule is not "no boxes"; it
is *the reader came for the prose, so do not put furniture between them and it*.
A question is not furniture between the reader and what they came for — at the
moment it renders it **is** what they came for, because it is the thing the
conversation is stopped on and nothing else in the thread will move until they
act. The card earns the treatment exactly as long as it is the last thing in the
thread, which is exactly as long as it is `open`. An answered question, further
up the scrollback, should read quieter than a live one for the same reason.

**And the scroll-follow logic has to count it.** The follow effect keys on
`messageCount` — `const added = messageCount - seen.current.count`, scrolling
down only when the reader is already at the bottom and otherwise incrementing
the unseen badge (`page.tsx:398-416`) — with a second effect following the
waiting row on `thinking` (`:420-422`), noted in its own comment as "content
too". A question that is not a message is invisible to both. Whatever the follow
logic counts has to include questions, or the one element the operator most
needs to see arrives without moving the scroll and without incrementing the
badge that says something arrived.

## Verdict

**Recommended.** The transcript is where turns go, the side strip is labelled
for what stands beside them, and a question is a turn; putting it anywhere else
also costs the asked/answered pair, since the answer is a message and cannot be
moved. The two real costs — a card in a column that wants prose, and a
follow-count that must learn about a non-message — are both bounded and both
named above.
