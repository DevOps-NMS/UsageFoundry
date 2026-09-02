# Option 5c — left open, for ever

The null answer to fork 5, and the one that has to be beaten rather than
dismissed. [Option 5a](13-option-5a-superseded.md) closes a question on the
operator's next message; [Option 5b](14-option-5b-cancelled.md) closes it on an
explicit press. This option closes it on nothing at all: a question is open
until it is answered, and if it is never answered it is open for ever.

## The rule

`status` is `open | answered`. No supersede, no dismiss, no clock, no sweep. The
card stays live in the thread with its buttons pressable, the derived
`awaitingAnswer` flag stays true, and an answer that arrives at any distance is
delivered by the same route as one that arrives immediately. Two states, one
transition, one writer.

## The strongest case, and it deserves a hearing

**It is the least machinery of the three.** No third status to explain, no
statement beside `claimTurn`, no control on the card, no verb on the route.
Against [C13](01-constraints.md#c13)'s bar — a pure function whose failure is
silent gets a test — 5c has almost nothing to get wrong, because there is
almost nothing there.

**And it is honest about something the other two are not: the app does not know
whether the operator still means to answer.** 5a infers abandonment from a
message; 5b infers persistence from silence. Both are guesses about a person's
intent, and 5c is the only one that declines to make one.

[C6](01-constraints.md#c6) is directly on this side, and it is not a general
principle being stretched — it is this app's own written refusal of exactly this
move. `retention.ts:632-634`, read directly:

> Every chat, whatever its status and however old. A thread is resumed by the
> operator typing into it, which they may do at any time — there is no terminal
> state to key on, and the set is one row per conversation.

A question is in precisely that position. It belongs to a conversation the
operator may pick up in an hour or in March, and the reason the sweep cannot
key on a chat's status is the reason a question resists having a settled state
invented for it. **Inventing a moment when a question stops being open is
inventing the terminal state that comment says a chat does not have.** That is
the strongest argument anywhere in this fork against the recommendation, and any
answer to fork 5 that does not meet it head-on has not answered the fork.

## The cost that beats it

A question that is open for ever makes the signal permanent, and the signal is
the entire point of the feature.

The derived `awaitingAnswer` boolean feeds the sidebar marker on the row at
`page.tsx:1553-1556` — the row that today draws `thinking` while a turn is in
flight and a `{pendingCount} waiting` badge for undecided proposals (read
directly). Under 5c, any thread where a question was ever ignored carries that
mark until the install is rebuilt. Ten threads in, the operator has a sidebar
where half the rows say they need attention and none of them do, and the mark on
the one thread that *is* waiting is indistinguishable from the rest. **A signal
that is never cleared is not a signal.**

Note what class of failure that is. [F3](00-problem.md#f3) is the complaint that
a thread holding a real question shows nothing — the affordance "exists, is
already built, and a question cannot reach it". 5c's failure is that the same
affordance reaches every thread that ever asked, including the ones the
conversation left behind years ago. Same defect, opposite direction: in both, the
sidebar cannot answer "which thread needs me". Building the marker and then
wiring it to a flag that only ever turns on is not a partial fix; it is the
original defect with more code behind it.

**Second cost: the buttons stay pressable, and continuity does not.** An answer
can arrive twenty turns later and go to a model that has no useful hold on the
question. [C2](01-constraints.md#c2) is explicit that continuity is best-effort:
the resumed session is the model's only memory of asking, a CLI answering under
a different session id is merely *noted* as a `system` message
(`chat.ts:1988-1993`) and the thread carries on under the new one, and a thread
with no session id replays only the newest `THREAD_REPLAY_MESSAGES = 20`
messages within `THREAD_REPLAY_BYTES = 20_000` (`chat.ts:243-244`, `:655-666`).
Twenty turns after a question, that replay does not contain it — the question
row lives outside `chat_messages` and is invisible to that path anyway
([F8](00-problem.md#f8)). So the late click delivers "web" to a model with no
idea what "web" was in answer to. The one-click affordance's whole value is that
the operator does not have to restate context; a click that lands without its
context is the worst possible version of it, because it looks like it worked.

## Which half of it is right

5c bundles two claims and they are not the same claim.

**No clock is correct, and the recommendation adopts it whole.** No expiry, no
sweep, no "questions older than a day". [C6](01-constraints.md#c6) forbids a
horizon nobody configured, and a question that dies at midnight would be exactly
that — a threshold invented by the implementer, of the kind
[C9](01-constraints.md#c9) refuses in the budget's own case ("inventing one
would be a threshold nobody set"). None of the three options in this fork
proposes a timer, and 5c deserves credit for making the reason explicit.

**No event is where it goes wrong.** Supersede is not a clock. Nothing about it
runs on a schedule, nothing measures elapsed time, and a question left untouched
for a year is still `open` — because nothing happened. What ends it is the
operator sending the next message, and `retention.ts:632-634`'s own sentence
names that act as the thing a chat is moved by: *"a thread is resumed by the
operator typing into it, which they may do at any time"*. 5a keys on that
resumption, at the exact instruction where the app already records it
(`claimTurn`, `chat.ts:1498-1499`, in the no-`await` window the comment at
`chat.ts:1495-1497` describes). C6 refuses a horizon the operator did not set;
it does not refuse the operator's own action, which is the one input it says a
chat has.

Read that way, 5c and the recommendation disagree about one thing only: whether
sending an unrelated message is evidence about the question. 5c says it is not.
The thread says otherwise — the operator was shown a question, and what they did
next was something else.

## Verdict

**Refused on the stale signal — but its no-clock half is adopted.** As a whole
it cannot be taken, because it leaves `awaitingAnswer` and the sidebar marker
permanently true on every thread that ever went unanswered, which is
[F3](00-problem.md#f3) rebuilt facing the other way, and because it keeps
buttons live long past the point where a click can be delivered to a model that
still holds the question ([C2](01-constraints.md#c2)). Its argument from
[C6](01-constraints.md#c6) is the best one in the fork and it is met rather than
waved off: no timer exists in the recommendation, and the event that closes a
question is the operator's own next message — which is the single act
`retention.ts:632-634` says a chat has.
