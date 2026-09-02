# Option 1a — a `chat_questions` table

The question is a row of its own, keyed to the chat and anchored into the thread
by the `chat_messages.seq` it was asked after. It is the most code of the three
placements and the only one that can hold state, and the second fact is why it
wins.

## What it is

One child table beside `chat_proposals`: `id`, a `chat_id` cascading off
`chat_sessions`, `created_at`, `asked_after_seq`, the prose, the options as
JSON, and the mutable trio — status, `answered_at`, the answer as given. The
rest of the composite is settled in the other forks; this file argues only that
the *storage* is a table, against [1b](03-option-1b-message-role.md) and
[1c](04-option-1c-session-column.md).

## The strongest case for it

**The precedent is exact, and the app already wrote down why.** `chat_proposals`
is this shape — `chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE
CASCADE`, plus a status, a `decided_at` and an `error` (`db.ts:25-50`) — and
`db.ts:609-621` gives the reason it is a table rather than a message:

> The approval gate is this table. […] until an operator approves it, it is
> form input.

A question passes that test on every clause: inert, claiming nothing,
meaningless until a person acts on it. [C12](01-constraints.md#c12) already
names `chat_proposals` as the precedent for a per-chat child table with the
right cascade, so the migration is one `CREATE TABLE IF NOT EXISTS` in the same
`db.exec` that installs it (`db.ts:622`) and one index beside
`idx_chat_proposals_chat` (`db.ts:628-629`), with no `SCHEMA_VERSION` bump.

**The decisive property is mutability.** A question moves open → answered, or
open → superseded, and it must be readable in each of the three. There is no
`UPDATE chat_messages` anywhere in `src/`: `appendMessage` (`chat.ts:318-340`)
is the only writer and it only inserts ([C5](01-constraints.md#c5)).
`chat_proposals`, by contrast, is updated in place twice — a rejection at
`chat.ts:1054`, an approval outcome at `chat.ts:1150`. A table of its own gets
the state transition without changing the character of the message table, and
that single property is the whole argument against
[1b(ii)](03-option-1b-message-role.md).

**It is the only option that can hold a structured answer joined to a structured
question.** [F4](00-problem.md#f4)'s three consequences — the model re-deriving
the join, the pair being unrenderable, one-click being impossible — all reduce to
there being no structure on either side. A row carrying an options array and an
answer column is that structure, on one row, so the join is a column rather than
an inference.

**The anchor is safe and already load-bearing.** `seq` is a single global
sequence taken inline in the INSERT, never null, backfilled `seq = rowid` on
**every** boot rather than only the one that added the column
(`chat.ts:330-331`, `db.ts:915-916`), and `listMessages` orders on it alone
(`chat.ts:312-316`). So `asked_after_seq` interleaves with no new ordering rule
and no risk of a null key. One consequence: `ChatMessageDTO` has no `seq` field
today (`apiTypes.ts:2382-2387`), so one must be added before the page can merge
two ordered lists.

## Where the question's prose lives

The sub-decision inside this option. Does the prose live only on the row, or is
it *also* appended to `chat_messages` as an `assistant` message, so the thread
reads correctly with no new rendering at all?

**The row, and only the row.** The tool call that asks happens mid-turn; the
turn's own closing reply is appended at settle, in `finishTurn`:

```ts
1996    if (r.text) appendMessage(chatId, "assistant", r.text);
```

So a question appended from inside the tool takes a *lower* `seq` than the reply
that motivates it, and the thread reads backwards — the question arrives, then
the paragraph explaining why it was asked. `save_template` gets away with
appending from inside a tool call (`route.ts:1428-1436`,
[F6](00-problem.md#f6)) because what it appends is a fact whose position carries
no meaning; a question's position carries all of it. That makes the replay fix
below **necessary rather than optional** — the two are one decision, not two.

## What it costs

**It is the most code of the three, by a wide margin.** A table, a row type,
insert/latch/supersede/read, a DTO, a projection into `ChatDTO`
(`apiTypes.ts:2480-2492`), a boolean onto `ChatListEntryDTO` (`:2494-2501`), and
a page-side merge of two ordered lists. [1c](04-option-1c-session-column.md) is
one `addColumn` (`db.ts:1667-1679`). This option does not get to pretend that
gap is small.

**Every question row is permanent.** [C6](01-constraints.md#c6) is not a
retention gap to close later: `retention.ts:632-634` says a chat has no terminal
state to key on, so nothing sweeps chats, and a question may not acquire a clock
without inventing the terminal state that comment denies. An operator asked
something who then closes the tab leaves a row that lives as long as the
install — a cost to accept out loud, mitigated only by the row being small and
the set being bounded by conversations a human actually had.

**A question outside `chat_messages` is invisible to thread replay.**
[F8](00-problem.md#f8), [C2](01-constraints.md#c2): with no `session_id`,
`chatPrompt` replays `listMessages` and nothing else (`chat.ts:639`,
`:641-666`), so a turn resumed by replay is told nothing about the question it
asked. The fix is that `chatPrompt` learns to render an open question inside
`<thread>` — a function already pure and unit-tested for this exact class of
failure ("both branches are billed and the wrong one is invisible",
`chat.ts:632-633`), so [C13](01-constraints.md#c13) is met by extending a suite
that exists. It is still an extra moving part with its own test, on the path
taken only on a first turn or after a session id is lost, which is the path
least likely to be exercised by hand.

**Two tables now describe "the chat produced something a person must act on."**
They differ in what the person does — decide versus answer — and every reader
has to hold that. `page.tsx:1553` makes it concrete: the `{pendingCount}
waiting` badge is sourced from proposals, and a thread with an open question and
no proposals must not read as one with nothing outstanding. That badge now reads
two sources.

## What it does not refuse

It is not a second route to a guard: the row holds prose, labels and an answer,
and an answer's only effect is text the model reads — the standing
[C7](01-constraints.md#c7) requires. It does not touch `ChatStatus` either, so
none of the ten `===` tests at [F3](00-problem.md#f3) is left failing open the
way [C4](01-constraints.md#c4) says a fourth status value would.

## Verdict

**Recommended.** It is the only placement that holds open → answered →
superseded without making `chat_messages` mutable, and the only one that can
render the asked/answered pair [F4](00-problem.md#f4) names as missing. Its
costs are code volume, one permanent row per question, and a replay path taught
about a table — all payable once, where
[1c](04-option-1c-session-column.md)'s missing history is payable on every
thread for ever.
