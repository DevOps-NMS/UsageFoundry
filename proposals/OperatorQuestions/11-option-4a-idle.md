# Option 4a — stay `idle`, and derive "waiting" in the DTO

Fork 4 asks what a chat's status becomes when a question is left open. This
option says it becomes nothing: `chat_sessions.status` keeps its three values,
and a derived `awaitingAnswer: boolean` on `ChatDTO` and `ChatListEntryDTO`
carries the fact to the page. [Option 4b](12-option-4b-awaiting-answer-status.md)
adds a fourth status value instead.

On the face of it this is the dishonest option — the one that leaves a lie in the
column and papers over it on the wire. It is not, and the argument for it starts
by conceding the objection in full.

## The objection, taken seriously

[F2](00-problem.md#f2) is that `idle` already means two different things: a turn
that answered fully and a turn that answered and asked land on the same value,
because `parseTurnOutput` returns `status: "idle"` for every successful turn
(`chat.ts:1932`) and `finishTurn` writes it (`chat.ts:1950`, `:1956`). Leaving
`idle` in place with an unanswered question hanging off the thread makes that
worse, not better: it is the same value covering a third situation.

If `chat_sessions.status` were "what state is this conversation in", that
objection would be decisive and this option would be indefensible.

## The distinction that resolves it

**`chat_sessions.status` is about the turn, not about the conversation.** Read
what every consumer of it actually asks, and each is a question about a child
process:

- `claimTurn` sets `'thinking' WHERE status<>'thinking'` (`chat.ts:1284-1288`)
  and `sendChatMessage`'s fast check at `chat.ts:1480` — *is a child running
  right now, and may I start one?*
- `reconcileChatsOnBoot` fails out `thinking` rows and only those
  (`chat.ts:2052-2060`, called from `src/instrumentation.ts:123-124`) — *did a
  child die with the process that owned it?*
- `review.ts:379` counts `thinking` rows toward the assist-concurrency limit —
  *is a child occupying a slot?*
- `page.tsx:361` picks the poll period, `POLL_ACTIVE_MS` against `POLL_IDLE_MS`
  — *is something server-side going to change without me asking?*

"The operator has not answered yet" is not a fact about a child process. It is a
fact about a person. Putting it in that column makes every reader above answer a
question nobody asked it — and answer it wrong, because the truthful answer to
all four, for a chat with an open question, is the same as for a chat with none.
No child is running. No child died. No slot is held. Nothing server-side will
move until the operator acts. `idle` is the *correct* answer to each of those
four questions, and it is only a lie about a question none of them poses.

The column is not being asked to carry a second meaning here. It is being left
carrying the one it has.

## The mechanism

`ChatDTO.awaitingAnswer` and `ChatListEntryDTO.awaitingAnswer`, both `boolean`,
both derived in the projection at fetch time from whether this chat has an
unanswered `chat_questions` row.

The precedent is already in the file this would be edited in.
`ChatListEntryDTO.pendingCount` is derived per chat in the list projection —
`pendingCount: pendingProposals(c.id).length` (`src/app/api/chat/dto.ts:95`) —
so a per-chat derived field computed one query per row is the established shape
on this exact surface, and its cost is a known quantity rather than a guess. The
docblock above `chatListDTO` gives the rule this must follow too: the projection
is shared because the single-chat route returns the list as well, and "two
routes that answer about the same rows must not answer differently."

Nothing about the wire's shape changes. `ChatStatus` on the wire
(`src/lib/apiTypes.ts:2485`, `:2498`) keeps its three values, so no consumer of
the union gains a case.

## The payoff

This buys the feature's single most valuable pixel, and it buys it without
touching a union.

The sidebar row is the affordance for an operator with several threads open. It
renders `thinking` in accent when a turn is in flight and a
`{pendingCount} waiting` badge when proposals are undecided
(`page.tsx:1553-1556`). [F3](00-problem.md#f3) is that a thread holding an
unanswered question shows *neither* — "the affordance that says 'this thread
needs you' exists, is already built, and a question cannot reach it."

`awaitingAnswer` reaches it. The row already reads two fields off
`ChatListEntryDTO` and renders each conditionally; a third is the same
expression again. The operator who has three threads and one open question sees
which thread it is, from the Chats tab, without opening any of them — which is
the whole complaint in [00-problem.md](00-problem.md) answered where the
operator actually stands.

## The cost, honestly

The wire type grows a field that must be kept in step with the question rows.
Two projections compute it, so a future question-writing path that forgets one
of them ships a chat that is waiting in the database and not waiting on the
page. A derived boolean is not free of drift; it just relocates it from "did
every reader handle the new enum value" to "did every writer of the underlying
rows leave the derivation true".

The honest comparison is that this drift is *detectable by looking at one
function* — the projection — where the drift under
[Option 4b](12-option-4b-awaiting-answer-status.md) is spread across ten `===`
tests that type-check clean ([C4](01-constraints.md#c4)). It is a smaller
surface, not a clean one. Say so.

There is a second, smaller cost: `awaitingAnswer` and `status` are two fields
that a reader must combine to get the full picture, and nothing in the type
system forces them to be read together. A chat that is `failed` and awaiting an
answer is representable, which is correct — see 4b's second cost, where the same
situation is what a single enum cannot hold — but a component that reads only
one of the two will render a partial truth.

## What stays correct with no work

Two things fall out for free, and both are worth naming because under
[Option 4b](12-option-4b-awaiting-answer-status.md) both become obligations.

`claimTurn` is `WHERE status<>'thinking'` (`chat.ts:1284-1288`, and
[C4](01-constraints.md#c4) notes it is deliberately not `='idle'`), so an `idle`
chat with an open question is claimable. The operator can type past the question
— ignore it, change the subject, say something the buttons do not cover — and
the composer works, which matters because `page.tsx:493-495` never disables the
textarea and [C14](01-constraints.md#c14) says that is deliberate.

`reconcileChatsOnBoot` touches `thinking` rows and only those
(`chat.ts:2052-2060`), so a restart leaves an awaiting chat exactly where it
was. That is the right behaviour and it is right for a reason:
[C6](01-constraints.md#c6) says a question is permanent and may not acquire a
clock, so a question survives a container restart and its buttons should still
work afterwards. Under this option they do, and nobody has to have thought about
it.

## Verdict

**Recommended.** `chat_sessions.status` answers "what is the child process
doing", four readers depend on that meaning, and "waiting on a person" is not an
answer to it. A derived `awaitingAnswer` puts the fact where the fact is needed
— on the wire, next to `pendingCount`, which is already derived exactly this way
at `dto.ts:95` — and reaches the sidebar badge that [F3](00-problem.md#f3)
identifies as the missing affordance. The drift risk is real and is smaller and
more localised than the ten silent equality tests the alternative would leave
open.
