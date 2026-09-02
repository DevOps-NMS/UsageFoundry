# Option H — reach the history

**Answers:** O3. Nothing else.

---

## The finding

Six facts, each read from source, which together mean a conversation is
reachable for a while and then is not:

1. `listChats(limit = 30)` (`chat.ts:358`), called with no argument by
   `chatListDTO` (`dto.ts:118`). No pagination, no search, no filter.
2. **There is no URL for a conversation.** `find src/app -path "*chat*" -name
   "page.tsx"` returns one file. Opening a thread is client state
   (`page.tsx:1213-1225`), so a thread cannot be bookmarked, linked from a run,
   reopened after a reload, or sent to anyone.
3. QuickOpen indexes panes, runs and workflows (`QuickOpen.tsx:204-236`) and not
   chats.
4. `grep -rln "export const DELETE" src/app/api/chat/` returns nothing — there
   is no way to delete a conversation.
5. Chat rows never expire. `docs/agent/retention.md` describes three sweeps and
   none of them touches `chat_sessions`, `chat_messages`, `chat_proposals` or
   `chat_questions`.
6. Every chat's `session_id` is held out of the transcript sweep **for ever**
   (`retention.ts:670-675`), and the reason is stated: "a chat has no terminal
   state to key on, since an operator may type into one at any moment"
   (`docs/agent/retention.md:20`).

The thirty-first conversation is unreachable from the UI, its row is permanent,
and its CLI transcript is permanently exempt from the sweep that exists to bound
disk. Nothing on the page says any of that.

## What is actually wrong here, and what is not

**Not wrong:** thirty is plenty for finding "the one I was in yesterday", and a
tab that appears only when there is more than one thread is a good default.

**Wrong, in order of how much it matters:**

- **(6) is an unbounded, invisible retention obligation.** Every conversation
  ever started pins a transcript against a sweep the operator configured. The
  Settings page shows storage sizes and what the last sweep did; it does not say
  that N transcripts are held by chat threads. On an install used for a year
  that number only goes up, and the only lever — deleting a chat — does not
  exist.
- **(2) is the one an operator hits weekly.** A chat is where a run came from.
  From `/runs/<id>` there is no way back to the conversation that proposed it,
  and `chat_proposals.run_id` records the link in the database. That is a
  one-way arrow that could be two.
- **(1) and (3) are ordinary and cheap.**
- **(4) is a consequence of (6), not an independent want.**

## What it is

**H-1. A URL per thread.** `/chat/[id]`, with `/chat` redirecting to the latest.
`GET /api/chat/[id]` already exists and already answers with both the thread and
the list (`src/app/api/chat/[id]/route.ts:32`), so the route handler is done.
What is left is a second `page.tsx` — or, more cheaply, a `?chat=<id>` search
param read on mount and written on switch, which is ~10 lines in the existing
page and gets bookmarking, back/forward and linking without a route.

**The cheap version is the right one.** A second page duplicates 1,900 lines or
extracts them, and neither is worth it for an address.

**H-2. A link from a run back to its chat.** `chat_proposals` holds `run_id`;
`chatOwnsRun` (`chat.ts:712`) already queries in that direction. A run's own DTO
gaining `proposedByChatId` is a join the run route does not do today, and the
run page gaining one line. Depends on H-1 for somewhere to point.

**H-3. Chats in QuickOpen.** A fourth source beside runs and workflows
(`QuickOpen.tsx:204-236`), keyed on title. `chatListDTO` is already the shape.
Depends on H-1.

**H-4. Delete a conversation.** A `DELETE /api/chat/[id]`; every child table
cascades on `chat_id` (`db.ts:28`, `:600`, `:639`), so the statement is one row.
The reason to want it is (6): deleting a thread releases its transcript to the
sweep. It needs a confirmation, and it needs to say what it releases — which
means it needs (5) and (6) to be visible somewhere first.

**H-5. Say what chats are holding.** The Settings storage card already shows
sizes and sweep counts. One more line — "N transcripts held by chat threads" —
turns an invisible obligation into a visible one, and is the change that makes
H-4 worth having rather than a button nobody has a reason to press.

## What it costs

| | Lines | Depends on |
|---|---|---|
| H-1 `?chat=` param | ~10 | — |
| H-2 run → chat link | ~20 | H-1 |
| H-3 QuickOpen | ~15 | H-1 |
| H-4 delete | ~30 + route | H-5 |
| H-5 storage line | ~10 | — (touches `retention.ts` and the Settings page, both outside this survey's read) |

## The argument against it

Everything here is about a surface the operator visits to *start* work, not to
keep records. If nobody has looked for last week's conversation, H-1 through
H-3 buy nothing. The one item that is true whether or not anybody looks is H-5
plus H-4 — the retention obligation exists on every install regardless of
whether the history is browsed.

And H-4/H-5 reach outside this survey's scope. `retention.ts` and the Settings
storage card were not read for this proposal; `docs/agent/retention.md` was.
Anything acted on there should be checked against
[the retention doc's own invariants](../../docs/agent/retention.md) first.

## Score

Scores on one finding and reaches two files this survey did not read. H-1 is
ten lines and buys the address; the rest is a separate question about retention
that this survey has surfaced rather than answered.
