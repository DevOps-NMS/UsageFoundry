# Option 1b — a fourth role on `chat_messages`

The question is a message. Two sub-variants, taken separately because they fail
differently: **(i)** a fourth value in `ChatRole`, and **(ii)** role `assistant`
with a nullable `question` JSON column on `chat_messages`. Both are cheaper than
[1a](02-option-1a-questions-table.md), and (ii) is the strongest objection to it
anywhere in this fork.

## What it is

**(i)** `export type ChatRole = "user" | "assistant" | "system" | "question"`
(`chat.ts:93`), with the payload as JSON in the existing `text` column or in a
new one. The question is a row in the same table as everything it interleaves
with.

**(ii)** The row stays `role='assistant'`. One `addColumn(db, "chat_messages",
"question", "TEXT")` (`db.ts:1667-1679`) carries prose-plus-options as JSON,
null on every message that is not a question. The renderer keys on the column's
presence, not on the role.

## The strongest case for it

**Ordering is free, and so is replay.** A question that is a message already has
a `seq` — taken inline in the INSERT, never null, backfilled on every boot
([C5](01-constraints.md#c5)) — so there is no anchor to invent and no two lists
to merge. And `chatPrompt`'s no-session branch reads `listMessages` and nothing
else (`chat.ts:639`, `:641-666`), so a question in that table is in the replay
by construction. That is **precisely the machinery
[1a](02-option-1a-questions-table.md) has to add and test**
([F8](00-problem.md#f8)), and 1b gets it for nothing. It is a real advantage and
should not be argued away.

**It is the smallest diff that gets a question into the thread.** Variant (ii)
is one `addColumn`, one branch inside `Message` (`page.tsx:1132-1171`), and one
optional field on `ChatMessageDTO` (`apiTypes.ts:2382-2387`). Nothing cascades,
nothing is indexed, nothing new is projected into `ChatDTO`
(`apiTypes.ts:2480-2492`).

## What variant (i) costs

Five edits, and the last two bite: `ChatRole` (`chat.ts:93`), the column comment
that enumerates exactly three (`db.ts:602-604`), `ChatMessageDTO.role`
(`apiTypes.ts:2382-2387`), the `Message` component (`page.tsx:1132-1171`), and
the replay mapping in `sendChatMessage` (`chat.ts:1502-1504`), which feeds
`chatPrompt`'s line builder:

```ts
647    const line = `${recent[i].role}: ${recent[i].text}`;
```

A fourth role goes verbatim into `<thread>` as `question: …` — a speaker the
model has never been told exists, on the one path where continuity is
reconstructed rather than resumed.

`Message` fails open worse than that. It branches on `system`
(`page.tsx:1135-1148`), then `assistant` (`:1150-1159`), and **returns the
operator's bezelled block as the fallthrough** (`:1161-1170`). An unhandled role
renders pulled right under the label "You": the model's question drawn as though
the operator typed it, which is the misattribution
`docs/agent/conventions.md:21` exists to prevent.

But the objection that decides (i) is semantic, and it is
[F6](00-problem.md#f6) read in the other direction. `system` is *this app*
speaking about the chat; `assistant` is *the model* speaking in it
(`db.ts:602-604`). A question is the model speaking in it. There is no third
party in the room. A fourth role therefore **invents a distinction the
transcript does not have** — `conventions.md:21` opens "the chat's transcript
says who is speaking with structure, never with colour", and a fourth role
claims a fourth *speaker* in order to hang a widget. A question is an assistant
turn with a control on it, which is what variant (ii) says out loud.

## What variant (ii) costs — and why it is the real rival

(ii) is cheaper than (i) and semantically honest: same speaker, extra payload,
one nullable column that reads null on every row already written. It gets
replay, gets ordering, needs no new table, needs no `asked_after_seq`, and
leaves `ChatRole` alone. On every axis but one it beats
[1a](02-option-1a-questions-table.md).

The one axis is state. The composite requires a question to be open, then
answered or superseded — three values, read by the derived `awaitingAnswer` flag
and by a renderer that must draw a settled question differently from a live one.
Recording that on the message row means `UPDATE chat_messages`, and there is
**no `UPDATE chat_messages` anywhere in `src/`**: `appendMessage`
(`chat.ts:318-340`) is the only writer and it only inserts
([C5](01-constraints.md#c5)). This would be the first mutation of the
transcript, in the one table whose entire character is that it is what was said,
in the order it was said.

The three escapes are each worse than the thing they escape:

- **A side table keyed on message id.** That is
  [1a](02-option-1a-questions-table.md) with the question split across two
  tables and a join to render either half. Strictly worse than either.
- **Derive it.** "Answered" could mean "a later `user` message exists" — the
  inference [F4](00-problem.md#f4) exists to remove, blind to supersession, and
  it marks a question answered by a message that ignored it.
- **Put the state on `chat_sessions`.** That is
  [1c](04-option-1c-session-column.md) bolted to (ii), inheriting 1c's loss of
  history while keeping two places to read.

Stated plainly: **(ii) is the strongest single objection to the recommendation,
and it fails on exactly one property.** Not on cost, not on semantics, not on
replay, not on ordering — on needing to write to a row that has never been
written to.

## Verdict

**Refused, narrowly, on mutability.** Variant (i) is refused outright: it claims
a fourth speaker the transcript does not have, and it fails open into the
operator's own bubble and into `<thread>` as an unknown role. Variant (ii) is
refused on one property only — open → answered → superseded has to live
somewhere, and the only place it fits without a second table is an `UPDATE` on
the one table in this app that has never had one.

**What would overturn it.** Drop the answered/superseded distinction. If a
question were write-once — rendered as asked, never restyled, supersession
inferred at read time or simply not shown — (ii) wins outright: one `addColumn`,
free replay, free ordering, honest role, no new table, no permanent second
artefact per question. If the design ever scopes down to that, this file is the
build and the recommendation should change rather than be patched.
