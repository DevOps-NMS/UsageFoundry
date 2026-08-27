# Option 6b — a route that records which question is being answered

The other half of fork 6. It pays one route to hold the one fact
[Option 6a](16-option-6a-ordinary-message.md) throws away — *which question this
answers* — and it pays nothing else, because it does not start the turn itself.
It forwards to `sendChatMessage` and inherits everything 6a inherits.

## The shape

`POST /api/chat/[id]/questions/[qid]/answer`, body `{ optionId?: string,
text?: string }`. Three steps, in this order:

1. **Validate the choice against the row.** The options live on the
   `chat_questions` row the model wrote; `optionId` is looked up there and
   nowhere else. Nothing the client sent about an option — its label, its
   `then`, its index — is trusted, because the page's copy of the card is up to
   a poll period old ([C3](01-constraints.md#c3)) and a label is not an
   identity.
2. **Latch the row.** `UPDATE chat_questions SET status='answered',
   answered_at=? WHERE id=? AND chat_id=? AND status='open'`. If `changes` is
   zero the question was already answered or already superseded, and the
   response is a sentence saying so rather than a turn.
3. **Send.** Render the answer string — the chosen option's text, or the typed
   text — and call `sendChatMessage(chatId, answer)`.

## The latch is the house pattern, not an invention

`rejectProposal` is one statement, and its `WHERE` is the whole of its
concurrency story:

```ts
"UPDATE chat_proposals SET status='rejected', decided_at=? WHERE id=? AND status='pending'"
```

(`chat.ts:1051-1058`, returning `res.changes > 0`.) `finishTurn` does the same
thing on the chat row and says why in its own comment: `WHERE status='thinking'`
"makes the row itself the settle-once latch", which is what lets the sweeper and
`cancelChatTurn` end a turn without waiting for a `close` that may never come —
"a late one lands here and changes nothing" (`chat.ts:1939-1945`, statement at
`:1946-1953`).

A stale click is the late one. **It gets a sentence rather than a second turn.**
That is not a new rule being introduced for questions; it is the rule the
approval route's explicit-ids requirement already states for proposals, where
"an id that is not pending in *that* chat is dropped rather than approved"
(`docs/agent/chat.md:8`; `src/app/api/chat/[id]/proposals/route.ts:64-69`). The
failure both exist to catch is identical: a person acting on a render that the
server has since moved past.

## It adds no second route to spending money

This is the architectural point and it should be read before the rest.

**Every gate that stands between a click and a billed child stays exactly where
it is**, because this route does not know how to start a turn. It writes one row
and calls `sendChatMessage`, which then runs its own sequence unchanged:
`dataDirRefusal()`, no-such-chat, the fast `thinking` check, empty text, then
`(await assistRefusal()) ?? installBudgetRefusal()` at `chat.ts:1492-1493`, then
the claim — with the no-`await` window between them that the code names
explicitly: "From here to the spawn there is deliberately no `await`: one
event-loop turn covers claiming the chat, recording the message and starting the
child, so a request that loses the claim adds nothing to the thread"
(`chat.ts:1495-1497`). `--max-budget-usd` still bounds the child from inside
([C9](01-constraints.md#c9)), and the settled turn still writes its own
`chat_turn_spend` row.

The contrast is worth stating because it is the thing that would be wrong. A
route that spawned its own child — even correctly, even copying the sequence
line for line — would be a second copy of an ordering that is load-bearing in
five places, and the second copy is the one that drifts the day one of the five
changes. There is one function that starts a chat turn. This route is a caller
of it.

## Ordering, and the compensating write

**Latch first, then send. If `sendChatMessage` returns `{ ok: false }`, the
route must put the row back to `open` and return the refusal.** This is a named
requirement rather than an implementation detail, and the reason is that the
refusals are ordinary: an operator who answers while another tab has a turn in
flight gets `ALREADY_THINKING`, and one who answers past the install ceiling
gets `installBudgetRefusal()`. Without the compensating write, a question is
marked `answered` with no turn behind it — the app's record says the operator
answered, the conversation contains no answer, and the derived `awaitingAnswer`
flag goes false on a thread that is still waiting. That is worse than 6a's
defect, because it is wrong in the direction the operator cannot see.

The alternative ordering — send first, latch after — is worse for a smaller
window but a nastier one. Between the spawn and the latch the question is
`open` while its answer is already in flight and already costing money, so a
second click in that window passes the `status='open'` test, reaches
`sendChatMessage`, and is refused by `claimTurn` — the right outcome by
accident, from a state the app briefly believed. Latching first makes the row
the authority for both, which is what the two precedents above already do.

## What the route carries

It is a mutating chat route, so it is wrapped in `auditMutation` like the others
(`message/route.ts:33`, `proposals/route.ts:175`), and it exports
`runtime = "nodejs"` and `dynamic = "force-dynamic"`, which
`docs/agent/conventions.md:11` requires of every handler that touches SQLite —
"Every existing data route has both."

## The [C7](01-constraints.md#c7) boundary, stated

**The answer's only effect is text the model reads.** The route may not write a
field on a `chat_proposals` row, may not set a guard, a budget, a permission
mode or an isolation choice, and may not touch anything else that is acted on.
The `chat_questions` row it does write is inert: status and a timestamp, read by
the page and by nothing that starts work.

The temptation this forecloses is specific and looks harmless — "which
repository?" answered with a folder, so write the folder onto the pending
proposal and save the operator a click. That is the second route to a guard
[C7](01-constraints.md#c7) closes, because the card the operator approved would
no longer be the card they read. An answer has exactly the standing the
operator's own typing has, and no more; the model reads it and writes a new
proposal, which the operator approves on its own card.

## Costs

One more route file. One more `chatRequest` call site on the page (`page.tsx:14`
imports it; `:500`, `:530`, `:545` are the three that exist). And one more thing
to keep in step with `sendChatMessage`'s refusal set — specifically the
compensating write above, which has to keep meaning "any `ok: false`" rather
than enumerating reasons. That last one is the real maintenance cost and the
reason it is written down as a requirement rather than left to the diff.

## Verdict

**Recommended.** It buys the one fact 6a cannot hold, using the latch this
codebase already uses twice for the same class of race, and it buys it without
adding a second path to a billed child: the route writes a row and forwards, and
every gate stays where it is.
