# Option 4b — a fourth `chat_sessions.status`

The other half of fork 4, against [Option 4a](11-option-4a-idle.md):
`ChatStatus` becomes `"idle" | "thinking" | "failed" | "awaiting-answer"`, and a
chat holding an unanswered question says so in the column every reader already
consults. It is the option a reader of [F2](00-problem.md#f2) reaches for first,
and it is refused on a cost that is measured rather than argued.

## The strongest case

**It is the honest name for the state.** [F2](00-problem.md#f2)'s whole
complaint is that `idle` covers a turn that answered and a turn that asked; a
fourth value fixes that at the source rather than beside it. One value, one
union, one place — no derived field to keep in step with the rows it is derived
from, which is [Option 4a](11-option-4a-idle.md)'s stated cost.

**It makes the condition impossible to forget.** Every future reader of a chat's
state is handed the fact whether or not it thought to ask for it. A derived
boolean can be ignored by a component that only destructures `status`; an enum
value cannot be, because it arrives in the field that component is already
reading.

**And it would let the poll cadence be chosen per state.** `page.tsx:361` picks
between `POLL_ACTIVE_MS` and `POLL_IDLE_MS` off one equality test, and
[C3](01-constraints.md#c3) observes that the right cadence for an awaiting chat
is a genuine question — nothing server-side will change while a question waits,
so the fast poll would burn requests watching a row only the operator can move.
A named state is the natural place to express "slow, and deliberately so".

These are not weak arguments. The refusal is not that the option is wrong in
principle; it is that this codebase, as it stands today, will not tell anyone
when it breaks.

## The decisive cost: ten sites, all silent

[C4](01-constraints.md#c4) is the measurement. Ten sites on `page.tsx` read a
chat's status, every one is an `===` against a literal, and **there is no
`Record<ChatStatus, …>` anywhere on the page**. A fourth value type-checks clean
and fails open at all ten, because "not `thinking`" is what every one of them
tests and an awaiting chat is not thinking.

Five of them, with what the operator sees:

- **`page.tsx:269`** — `const thinking = chat?.status === "thinking"` is false,
  and it is the flag under everything below it. Every consequence in this list
  is inherited from this one line getting the wrong answer.
- **`page.tsx:496`** — `send()`'s own refusal does not fire, so a message is
  sent into a chat the app believes is waiting for a structured answer.
- **`page.tsx:954`** — Send stays enabled, so nothing on screen suggests the
  operator should be doing something else first.
- **`page.tsx:947-951`** — no Stop button. This one is *correct* — there is no
  child to stop — but it is correct by accident, because the condition it tests
  happens to coincide. A correct-by-accident branch is not a working branch; it
  is one that will stop being correct the day the condition changes.
- **`page.tsx:765`** — the `Waiting` row is not drawn. Which is right, and is
  also the reason the feature ships invisible: the page shows nothing at all,
  which is [00-problem.md](00-problem.md)'s opening defect reproduced by the fix
  for it.

Hold that against `PROPOSAL_TONE` (`page.tsx:118-123`), an `as const` object
indexed at `page.tsx:1498`: a new *proposal* status is a compile error at the
index. Chat status has no such reader anywhere, so the same class of change is a
compile error on one union and silence on the other.

This is precisely the failure class `CLAUDE.md` is written against — "nearly
every one of them fails **silently** — nothing throws, nothing fails to
typecheck, and the page looks right." Adding a fourth value would create ten new
instances of it in one commit.

## The second cost: the state is not one state

This is the structural objection and it is stronger than the site count, because
it does not depend on how many `===` tests happen to exist today.

A chat can be `failed` **and** have an open question. Under
[C1](01-constraints.md#c1), a turn is killed at `CHAT_TIMEOUT_MS` and
`parseTurnOutput` is never called (`chat.ts:1758-1764`) — everything the child
wrote is discarded and the row lands `failed`. But the `ask_operator` call
happened earlier, over a separate `/api/mcp` request that wrote its row in this
process (`docs/agent/chat.md:20`, and [C11](01-constraints.md#c11)'s "the chat's
tools run in this process") and committed before the kill. Nothing rolls it
back. So a timed-out turn can leave a perfectly good question behind on a
`failed` chat. *(That the two states co-occur is derived from C1 and C11 rather
than observed — unverified by measurement here, but it does not require an
unusual sequence: any turn that asks and then keeps working past ten minutes
produces it.)*

And a chat can be `idle` with an open question, which is the ordinary case.

A single enum column cannot hold two independent facts. Whichever value is
written, information is lost: `awaiting-answer` on a timed-out turn hides that
the turn failed, and `failed` hides that a question is waiting. There is no
ordering of the two that is right in both directions, because they are not
points on one axis — one is about a child process and one is about a person.
[Option 4a](11-option-4a-idle.md) represents both because a boolean beside an
enum is two fields.

## The third cost: two accidents that would become obligations

`reconcileChatsOnBoot` fails out `thinking` rows and only those
(`chat.ts:2052-2060`). It would need auditing to confirm it does **not** sweep
the new value — a restart must not turn a waiting chat into a failed one,
because [C6](01-constraints.md#c6) makes a question permanent and clockless, so
it has to survive the boot with its buttons intact.

`claimTurn` is `'thinking' WHERE status<>'thinking'` (`chat.ts:1284-1288`) and
would need re-reading to confirm an awaiting chat is still claimable — the
operator must be able to type past a question, since `page.tsx:493-495` never
disables the textarea ([C14](01-constraints.md#c14)).

Both happen to be correct today, for the same reason the ten sites happen to
compile: the new value is not `thinking`. The cost is not that they are wrong.
It is that two behaviours currently guaranteed by a two-way condition become two
behaviours guaranteed by a convention, in a file where [C4](01-constraints.md#c4)
already records that `WHERE status<>'thinking'` was written deliberately and "so
would a fourth value be" retryable.

## What would overturn this

If this app ever gains a `Record<ChatStatus, …>` reader — a status chip with a
tone map, the shape `PROPOSAL_TONE` already has at `page.tsx:118-123` — the type
system starts catching the sites, and the ten silent failures become ten compile
errors. At that point the first cost above largely evaporates and the second
becomes the only argument, which is a much closer call.

That reader would be worth building on its own merits, and building it *first*
would be the honest route to this option. It is not a prerequisite anybody has
asked for, and it is not this proposal's to add.

## Verdict

**Refused, on ten silent failures and one state that is two states.** The name
is honest and the poll-cadence argument is real, but a fourth value fails open
at every one of the ten `===` tests [C4](01-constraints.md#c4) counts, with no
exhaustive reader anywhere to catch it — the exact silent-failure class this
repository's own instructions are written against. And a chat that is `failed`
with a question outstanding is two facts that one column cannot carry, which is
an argument no amount of careful editing at the ten sites would answer. The
overturning condition is named above and is a real one.
