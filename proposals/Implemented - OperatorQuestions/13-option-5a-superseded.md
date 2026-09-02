# Option 5a — superseded when the next turn is claimed

Fork 5 asks what becomes of a question the operator does not answer — they type
something unrelated, they start a new turn, they leave it for a day.
[Option 5b](14-option-5b-cancelled.md) hands that decision to the operator with
a Dismiss control; [Option 5c](15-option-5c-left-open.md) says nothing but an
answer ever closes a question. This option says the operator's next message
already closed it, and that the app's job is to read that message for what it
is rather than to keep asking.

## The rule

When the next turn is claimed, every open question in that chat is marked
`superseded` and stamped with `settled_at`. One statement, beside `claimTurn`.

The placement is exact, and it is why this costs nothing. Reading
`sendChatMessage` end to end (`chat.ts:1465-1532`, read directly), the comment
at `chat.ts:1495-1497` states the property this option rides on:

> From here to the spawn there is deliberately no `await`: one event-loop turn
> covers claiming the chat, recording the message and starting the child, so a
> request that loses the claim adds nothing to the thread.

`claimTurn` is `chat.ts:1498-1499` and `appendMessage(chatId, "user", text)` is
`chat.ts:1501`. The supersede is a third synchronous statement inside that same
window, after the claim and beside the append — no new `await`, no new failure
mode, one `UPDATE` on an indexed `chat_id` of the kind `chat_proposals` already
carries (`db.ts:628-629`, per [C12](01-constraints.md#c12)). A request that
loses the claim returns `ALREADY_THINKING` at `chat.ts:1499` and supersedes
nothing, which is the correct outcome: the thread it was writing into is not
the thread that moved.

## Why the next message is the answer

A question is a request for the next input. If the operator's next input is
something else, they have answered by moving on — and the model finds out
without being told anything, because the turn is resumed against the same
session ([C2](01-constraints.md#c2)): `--resume` at `chat.ts:1698`, the bare
message with no replay when a session id is present (`chat.ts:639`). The model
remembers asking. It reads a message that is not an answer. It carries on. That
is not a degraded path; it is how a conversation works.

What the app must not do is leave the buttons live through it. A card still
offering "web" and "api" after the conversation has moved three exchanges past
the ambiguity invites a click, and that click delivers an answer to a question
the model is no longer asking — into a session whose most recent context is
about something else entirely. The operator gets a reply that reaches back for a
decision they thought they had already routed around. **That is the failure this
option closes, and it is the only one of the three that closes it.**

The second argument is structural. [Option 3a](09-option-3a-one-question.md)
caps a chat at one open question and enforces it at the tool's door, on
[C8](01-constraints.md#c8)'s precedent. Supersede makes that cap true by
construction rather than by the door check alone: with this rule, the set of
open questions is emptied by the same event that starts the turn which might
add to it, so the invariant holds even if the door check is ever wrong. A cap
that two independent mechanisms maintain is a cap that can be relied on by the
DTO's derived `awaitingAnswer` flag without a second thought.

## What a superseded question renders as, and why it is never deleted

It stays in the thread, interleaved by `seq` where it was asked, as a quiet,
non-interactive record: the question text greyed, its options shown as unchosen
labels rather than buttons, and one line saying the conversation moved on. No
action row. Nothing to click.

Deleting the row instead would be cheaper to build and it is refused, on the
app's own reasoning about exactly this situation. `endTurn` appends a `system`
message when it settles a turn, and the comment at `chat.ts:1370-1372` gives
the reason (read directly; the append is `chat.ts:1373`):

> In the thread as well as on the row: the conversation should read as what
> happened to it, and a turn that stops without a word looks like an answer
> that never came.

A question that vanishes is precisely that failure with the parties swapped. The
operator saw a card, typed something else, and on the next render the card is
gone — leaving a thread that reads as though the model never asked, and an
operator who cannot tell whether they missed something. The transcript has to
read as what happened to it, and what happened is that a question was asked and
overtaken.

[C6](01-constraints.md#c6) removes the only argument for deleting it anyway.
`retention.ts:632-634` keeps every chat "whatever its status and however old",
so the row is permanent regardless: the question's text and options are already
on disk for the life of the install. Deleting the *display* saves nothing and
buys nothing. It would be a choice to show the operator a thread that is less
true than the database behind it.

## The cost

**An operator who meant to answer, and typed an aside first, loses the button.**
"Hang on — is the flake in CI the same one?" sent into the composer supersedes
the question they were about to click on. When the model replies, the buttons
are gone. This is a real annoyance, it will happen, and there is no fix for it
inside this option: the escape is that they type the answer instead, which works
and always did — [F4](00-problem.md#f4)'s point is that typing was never the
broken part. It is a worse experience than 5b offers in exactly this case, and
5b's own costs are what decide the fork rather than a claim that this one does
not exist.

**And `superseded` is a third state the reader has to hold.** `open` and
`answered` explain themselves; `superseded` needs the sentence on the card to
do its work every time, and it is a word about the app's bookkeeping in a pane
whose vocabulary is otherwise about work. That is a genuine cost against 5c's
two-state simplicity, and it is paid for by the failure above.

## The edge: a claim that does not become a turn

Worth checking, because a supersede that fires and then leaves no turn behind
would silently eat a question. **Verified against `chat.ts:1465-1532`.** Every
refusal in `sendChatMessage` returns *before* the claim: `dataDirRefusal` at
`:1473-1474`, the missing chat at `:1477`, the fast `thinking` check at `:1480`,
empty text at `:1482-1483`, and `assistRefusal() ?? installBudgetRefusal()` at
`:1492-1493` — which [C9](01-constraints.md#c9) notes is the only `await` before
the claim. So no refusal path can supersede a question.

One post-claim failure path does exist and it is not a refusal: `runTurn` is
wrapped in a `try`/`catch` at `chat.ts:1521-1529`, and a throw there settles the
row with `finishTurn(chatId, { status: "failed", … })`. A question would be
superseded and no child would run. That outcome is still correct rather than
tolerable, and the reason is the ordering above: `appendMessage` at
`chat.ts:1501` has already run, so the operator's message *is* in the thread.
The conversation did move on; only the turn failed. The operator sees their own
message, a `system` line saying the turn could not start, and a superseded
question — which is an honest reading of what happened. If that is ever judged
wrong, the fix is one line inside the existing `catch`, reverting the
superseded rows to `open` beside the `finishTurn` call; no new mechanism is
needed and the recommendation does not include it.

## Verdict

**Recommended.** The operator's next message is the event that ends a question,
because it is the event the question was waiting for. The write is one statement
in a window that already exists and already forbids `await`, it makes fork 3's
cap structural, and it is the only option in this fork that prevents a click on
a stale card being delivered as an answer. The row is kept and rendered greyed
for `chat.ts:1370-1372`'s reason, and under [C6](01-constraints.md#c6) keeping
it costs nothing that deleting it would save. The vanishing-button annoyance is
real, is not fixed here, and is what [Option 5b](14-option-5b-cancelled.md) is
retained as a possible affordance for.
