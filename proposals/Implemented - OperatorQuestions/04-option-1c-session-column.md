# Option 1c — a column on `chat_sessions`

`open_question TEXT`, holding the prose and options as JSON, written when the
tool asks and nulled when the answer arrives. The cheapest of the three by a
distance, and the runner-up rather than a straw man — it is refused on one thing
only, and that thing is history.

## What it is

One statement: `addColumn(db, "chat_sessions", "open_question", "TEXT")`,
idempotent by construction because `addColumn` reads `PRAGMA table_info` first
(`db.ts:1667-1679`), and additive, so no `SCHEMA_VERSION` bump
([C12](01-constraints.md#c12)). The row is already the per-thread state object
for everything that is not a message: `session_id`, `status`, `cost_usd`,
`tokens` and `error` (`db.ts:550-563`), plus `turn_started_at`, itself an
`addColumn` (`db.ts:924`). `awaitingAnswer` on both DTOs
(`apiTypes.ts:2480-2492`, `:2494-2501`) is `open_question !== null`, computed
off a row the list query already reads.

## The strongest case for it

**One open question per chat is not a rule here, it is the shape.** The cap that
otherwise has to be decided and then enforced at the door — the way
`MAX_PENDING_PROPOSALS` is enforced inside the tool with a sentence the model
can act on ([C8](01-constraints.md#c8)) — is structural and free: the column
holds one value. Fork 3's answer falls out of the storage choice. There is no
counting query to write and therefore none to get wrong, and no window in which
two questions can both be open because two tool calls raced.

**Nothing to cascade, nothing to index, no second table.**
[1a](02-option-1a-questions-table.md) adds a foreign key with `ON DELETE
CASCADE`, an index beside `idx_chat_proposals_chat` (`db.ts:628-629`), a row
type, a DTO and a projection. This adds a string and a column comment.

**It touches no invariant.** `chat_messages` stays insert-only
([C5](01-constraints.md#c5)); `ChatRole` stays at three values (`chat.ts:93`);
`ChatStatus` stays at three, so none of the ten equality tests at
[F3](00-problem.md#f3) is left failing open the way
[C4](01-constraints.md#c4) says a fourth value would. It is the least invasive
answer to fork 1 that exists, and on a page with ten non-exhaustive `===` tests
that is worth something real.

## What it costs

**No history.** This is the whole refusal, and no amount of implementation care
recovers it.

A nulled column says nothing. Six turns later the thread holds the operator's
answer as an unattached paragraph and carries no record that anything was ever
asked. The app has already reasoned about exactly this reading failure, in its
own words, at `chat.ts:1370-1372` — the comment explaining why `endTurn` bothers
to append a `system` message when a turn is cancelled:

> In the thread as well as on the row: the conversation should read as what
> happened to it, and a turn that stops without a word looks like an answer that
> never came.

A question that vanishes the instant it is answered is that failure with the
polarity flipped: an answer arriving with no question in front of it reads as an
unprompted remark. The standard is already set, in this file, for this table's
sibling — the conversation must read as what happened to it — and 1c cannot
meet it.

**The pair cannot be rendered, so the answer has nothing to attach to.**
[F4](00-problem.md#f4)'s second and third consequences stand undiminished. A
one-click option can still be *offered*, because the card reads the live column
— but what survives the click is a free-text `user` message like any other,
which is where this design started. The structured answer has nowhere to land,
because the structured question is deleted by the act of answering it.

**"Superseded" is not representable.** The composite distinguishes a question
the next turn moved past from a question that was never asked. Null is both. The
obvious patch — a `last_question` column beside `open_question` — is two columns
encoding a state machine on a row that still has no room for the answer, and at
that point [1a](02-option-1a-questions-table.md) is back with worse ergonomics
and no cascade.

**And it does not fix the replay problem it superficially looks like it fixes.**
The column is on `chat_sessions`, not `chat_messages`, so it is as invisible to
`chatPrompt`'s no-session branch as a whole table is (`chat.ts:639`,
`:641-666`; [F8](00-problem.md#f8)). 1c pays 1a's replay cost without buying
1a's history. Only [1b](03-option-1b-message-role.md) escapes that, by living in
the table the replay reads.

## What it does not refuse

Scope the feature down — free text only, no options list, no rendered
asked/answered pair, no supersession — and almost every cost above disappears.
What remains is "no record that it was asked", which a smaller design might
knowingly accept in exchange for an implementation that is one column and cannot
be got wrong. **On that scope 1c is the second-best design in this fork**, and
the recommendation names it as the runner-up for that reason: it holds the
one-question rule structurally, it has no state machine to mutate, and its
entire surface is a string.

Its edge over [1b(ii)](03-option-1b-message-role.md) on that same scope is the
free cap and the total absence of state to write; 1b(ii)'s edge is that the
question survives in the transcript. The runner-up is 1c because the scoped-down
feature that makes either viable is one whose question is genuinely ephemeral,
and an ephemeral question left permanently in a transcript that never expires
([C6](01-constraints.md#c6)) is the worse artefact of the two.

## Verdict

**Refused on history.** A question whose only trace is a column that is now null
cannot render the asked/answered pair [F4](00-problem.md#f4) names as the
missing thing, cannot tell superseded from never-asked, and leaves a thread that
does not read as what happened to it — which `chat.ts:1370-1372` already
establishes as a failure this app does not accept.

**With one live caveat, not a courtesy.** If the design settles on
free-text-only questions with no pair rendering, this refusal is void and 1c is
the build: one `addColumn`, no cascade, no index, no new table, and fork 3
answered for free. It is refused *for the feature as specified*, and it remains
the cheapest thing in this fork by a wide margin.
