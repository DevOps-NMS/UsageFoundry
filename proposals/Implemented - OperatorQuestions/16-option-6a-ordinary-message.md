# Option 6a — the answer enters as an ordinary user message

Fork 6 asks where the answer enters. This is the option that needs no server
code at all: the click composes a sentence in the browser and posts it down the
pipe the composer already uses, so the answer is a message and nothing else.
[Option 6b](17-option-6b-answer-route.md) is the other half of the fork, and it
exists for exactly one thing this option cannot do.

## The rule

Clicking an option renders that option's `label` — or its `then`, or both —
into a string client-side and POSTs the existing
`POST /api/chat/[id]/message`. The handler reads exactly one field:

```ts
21    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
23    const res = await sendChatMessage(id, String(body.message ?? ""));
```

(`src/app/api/chat/[id]/message/route.ts:19-30`.) There is nothing to add to it
and nothing to add beside it. The card's free-text escape is the same POST with
the operator's own string, and the `chat_questions` row is touched by nobody.

## The strongest case, and it is real

**It is the smallest possible change on the server** — zero routes, zero new
call sites, zero new refusals to keep in step. Every option in this survey that
touches the wire should have to beat that.

**It inherits every refusal `sendChatMessage` already makes, in the right
order.** Read at `chat.ts:1465-1532`: `dataDirRefusal()` first, because a claim
is only a claim when one process makes it (`:1473-1474`); no-such-chat
(`:1477`); the fast `status === "thinking"` check, which its own comment says
decides nothing (`:1480`); empty text after `trim()` (`:1482-1483`);
`(await assistRefusal()) ?? installBudgetRefusal()`, the only `await` before the
claim (`:1492-1493`); then the authoritative `claimTurn` race (`:1498-1499`).
An answer that arrives while a turn is in flight is refused by the same sentence
a typed message would be refused by, at the same instant, for the same reason.

**It is bit-for-bit indistinguishable to the model from the operator typing.**
Nothing new can go wrong inside the conversation, because there is nothing new
inside the conversation: a click produces a `user` row via
`appendMessage(chatId, "user", text)` (`chat.ts:1501`) exactly as typing does,
and the thread-replay path ([F8](00-problem.md#f8)) sees it without being told
about it.

**It composes with fork 5.** A click and an unrelated message take the same
path, so there is one code path to reason about when the operator answers
something other than what was asked.

## What it costs

**Nothing records which question was answered.** This is the whole of the
objection and everything below is a consequence of it. The wire carries one
string; `chat_messages` has columns `id, chat_id, ts, seq, role, text`
(`db.ts:598-607`, per [F4](00-problem.md#f4)); there is nowhere for "this
answers that" to live and nothing downstream asks.

So **the row can never be marked `answered`.** The only status transition the
app can still observe is the one it makes on its own account — superseded when
the next turn is claimed. An operator who read the question, clicked an option
and got the work they asked for ends up looking at a question the app has
recorded as passed over. That reads as "you ignored it" when they did precisely
the opposite, and it is the app being wrong about the one fact the feature was
built to hold.

**[F4](00-problem.md#f4)'s asked/answered pair cannot be rendered**, in the
thread or anywhere else. Six turns later "what did I decide about the
repository, and when" is still a re-read of prose, because the answer is prose
adjacent to a question rather than attached to it. Whichever way fork 7 goes,
the pair is two unrelated things that happen to be near each other.

**And there is no server-side check that the click was still valid.** The page
polls at ten seconds ([C3](01-constraints.md#c3), `page.tsx:51-52`, `:361`), so
the buttons an operator is looking at are up to ten seconds stale. A second tab
that already answered, or a turn that already superseded the question, leaves
the first tab's buttons live and clickable — and this option will happily send
the click, spend a turn on it and tell the model an answer to a question it has
moved past. There is no id on the wire to check, so there is nothing to check
it against. Compare the approval route, which takes the explicit list of ids the
page displayed precisely so that "a proposal the chat added between render and
click is not swept into an approval nobody saw"
(`docs/agent/chat.md:8`; `src/app/api/chat/[id]/proposals/route.ts:64-69`).
6a is that route without its list.

## The sharpest version

With 6a, **"answered" is not a state the application can observe.** Not "is
awkward to observe" — cannot. The `chat_questions.status` vocabulary the
composite specifies collapses from `open | answered | superseded` to
`open | superseded`, and the missing value is the one that says the mechanism
worked. The brief asked for a question that can be asked *and* answered; this
option delivers a question that can be asked and then, at some point, stops
being open for reasons the app attributes to the passage of a turn.

Every downside above is one downside wearing four coats. It is not a rendering
problem and it is not a polish problem: the answer is real and the record of it
is a coincidence of timing.

## Verdict

**Refused, on the fact that it cannot tell an answer from a coincidence.** The
saving is genuine and it is the right saving to want — but what it buys is a
feature whose central state transition happens outside the app's knowledge.
[Option 6b](17-option-6b-answer-route.md) keeps every property listed under the
strongest case above, because it forwards to the same function; it pays one
route for the one fact 6a throws away.
