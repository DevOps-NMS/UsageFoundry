# The recommendation

**Ship the cheap tier — B, D, E and two pieces of G — as four commits.
Price C and do not build it yet. Refuse F. Surface H-5 as a question for
somebody else's survey.**

Roughly 100 lines across `src/lib/chat.ts`, `src/lib/apiTypes.ts`,
`src/app/api/chat/dto.ts` and `src/app/chat/page.tsx`. No migration, no new
table, no new route, nothing on the approval or spawn path. It closes 14 of the
20 findings, including five of the six where the panel currently asserts
something the code contradicts.

---

## If only one change is made

**Carry `turn_started_at` on the DTO and name the ten-minute deadline in
`Waiting`** — [03-option-b](03-option-b-name-the-clock.md), parts 1 and 2, about
fifteen lines.

Why this one:

- It is the only cheap change that touches the brief's central question. An
  operator ten seconds into a turn and one nine minutes in currently see the
  same screen differing by a number they have no scale for; a ceiling gives them
  the scale, and the decision they take every single turn — wait, or press Stop
  and lose whatever the child has done — becomes an informed one.
- It fixes a wrongness rather than adding a feature. The elapsed clock is
  measured from the last thread message (`page.tsx:706`) while the server holds
  the real start (`chat.ts:1617-1621`), and a mid-turn `save_template` note
  (`src/app/api/mcp/route.ts:1635`) resets the display to zero on the one
  surface whose job is to say how long this has been going.
- It is the prerequisite for the honest version of everything about turn cost,
  including [04-option-c](04-option-c-live-activity-feed.md)'s.

**The reading that would pick something else.** If the priority is the approval
gate's correctness rather than the operator's wait, the single change is
[06-option-e](06-option-e-open-the-proposal.md)'s **E-2**: spell out a templated
proposal's guards. `docs/orchestrator-chat.md:24-26` claims every card says what
it will run under; measured, a templated card says `Bug fix` where the guards
are `acceptEdits · own checkout · 12 cycles · 45 min · $4.00`. That is a claim
the documentation makes and the interface does not keep, and `defaultGuardsLabel`
(`dto.ts:213-228`) already builds the string. Set the `wait` criterion to 0 in
[score.mjs](score.mjs) and E leads.

Both are cheap enough that "which one first" is a smaller question than it
looks; together they are about 55 lines.

---

## The sequence

Four commits, in this order, because each is independently shippable and the
order puts the cheapest correctness fixes first.

### 1. Say how long, and how long is left — Option B

- `turnStartedAt: number | null` on `ChatDTO`, mapped in `chatDTO`
  (`dto.ts:44-62`).
- `waitingSince` (`page.tsx:706`) prefers it, falling back to `lastMessage?.ts`
  the way `staleTurn` falls back to `updated_at` (`chat.ts:1671`).
- `Waiting` (`page.tsx:1381`) gains "of up to 10 min", and past the deadline
  "past the 10-minute limit; being stopped".
- The header's cost says what it counts: "settled turns only".

~15 lines. Extract the start-instant selection so it can be unit tested — it is
arithmetic on two nullable numbers whose failure renders a plausible wrong
duration, which is the bar `docs/agent/testing.md` records.

### 2. Make an ending legible — Option D

- `reconcileChatsOnBoot` (`chat.ts:2446`) appends the system message it already
  writes to the row, so the restart case leaves a permanent record the way the
  other three endings do. **Do this one first within the commit**; it is four
  lines and it is the only finding here that is a genuine asymmetry between two
  functions three lines apart.
- A failure note is toned apart from a bookkeeping note (`page.tsx:1307-1320`),
  with the honest limit stated: the page infers "failure" from `chat.status`, so
  older failures in a long thread revert to grey. The durable fix is a `kind`
  column and it is more than this is worth today.
- Under a failure, one line: the message survived, and **Send it again** puts it
  back in the composer without posting.
- A question whose turn died says so.
- `settleQuestions`' refusal (`chat.ts:670-674`) stops telling the operator to
  reload the chat, which is what destroys the answers that were fine.

~25 lines.

### 3. Make the card say what is being approved — Option E

- A `Disclosure` per pending card holding the full task, the rewritten prompt,
  and the proposal's own `specId`.
- `guardsDetail` on the DTO for a templated proposal, built by the same
  `defaultGuardsLabel` the untemplated case uses, plus a link to `/settings`.
- `specId` on the DTO, so "Starts after `auth-fix`" names something findable.

~40 lines. **Keep the fold closed by default** until step 4 has shipped — see
the arithmetic in [10-comparison.md](10-comparison.md#the-four-things-this-table-decides).

### 4. Give the list back the room the page already has — Option G, parts 5 and 3

- `Select all` excludes proposals whose card already says approval will be
  refused, and says how many it skipped. Five lines, strictly correct — the
  route drops them anyway, so this only aligns the number agreed to with the
  number that happens.
- Reclaim the ~40px the standing `Notice` spends on two lines that never change,
  by moving them into the disclosure summary or beside the `<h1>`.

~15 lines.

**G-2 — a compact row past a threshold, or a Compact/Full toggle — is
deliberately not in this sequence.** It is the change that answers C5 at its
worst (1.2 of 26 cards at 1280×800) and it is the one that costs a second
rendering of the card to keep in step. It is worth building the day somebody
says they have actually reviewed twenty-five proposals in one batch, and not
before: the median thread proposes two or three, which fit.

---

## What is deferred, and on what condition

**[04-option-c](04-option-c-live-activity-feed.md) — the live activity feed.**
Two to four days including the retention question, against ~100 lines for the
whole cheap tier. It is deferred rather than refused, and the difference matters:
it is the only option that makes the wait *legible* rather than merely bounded,
and every piece it needs already exists for runs. **Build it when an operator
says they have sat through a ten-minute turn more than once not knowing whether
to cancel** — that is the experience it exists for and B does not substitute for
it.

If it is built, the order inside it is: the flag and `parseTurnOutput`'s new
reader first with its tests, then the table and retention, then the client. Not
the client first — a feed with nothing persisted behind it is empty after a
reload, which for a ten-minute turn is most of the time somebody would look.

**[09-option-h](09-option-h-reach-the-history.md) — H-1 only**, the `?chat=<id>`
search param, ten lines, whenever somebody is in the file. H-4 and H-5 are a
real finding — every conversation ever started permanently exempts a transcript
from the sweep (`retention.ts:670-675`) and nothing says so — and they reach
`retention.ts` and the Settings storage card, neither of which this survey read.
**They should be handed to whoever owns retention rather than done here.**

---

## What is refused, by name

- **[07-option-f](07-option-f-amend-before-approving.md) — editing a proposal
  before approving it.** One finding, the most sensitive route in the feature,
  and probably dominated by E. The sentence that reverses it: *"I reject and
  re-ask because the folder or the template is wrong, not because the task is
  wrong."* That would move F-b — folder and template only, never the task —
  from refused to first.
- **A `title` on the task paragraph.** The card's own comment rules out a hover
  title for the guard set because "a hover title is not a way of reading it at
  all on touch" (`page.tsx:1698-1699`); the task deserves it less, not more.
- **A progress bar or any completion estimate in `Waiting`.** Its docblock is
  right and a deadline is not one — "of up to 10 min" is a ceiling the server
  enforces, not a projection.
- **Auto-retry of a stranded turn.** `chat.ts:1760-1762` and `:2438-2439` refuse
  it twice, and "Send it again" is a person pressing Send.
- **Widening the 360px column on its own** (G-1). One token, buys half a card,
  and costs the thread the measure it is sized to.
- **A second `page.tsx` for `/chat/[id]`.** 1,900 lines duplicated or extracted
  for an address a search param gets for ten lines.
- **A `kind` column on `chat_messages`** as part of this work. It is the right
  answer for D-2's historical case and it is a migration for a tone.
- **Reading a killed turn's spend out of the usage window.** X8: a chat turn's
  cost is the chat's own figure, never summed with a run's.
- **Switching tabs, scrolling or opening a card in response to a poll.** X6.

---

## What would overturn the whole recommendation

Two sentences, from an operator rather than from the code.

1. *"The wait is fine; I go and do something else."* That deletes B's `wait`
   score and C's whole case, and the recommendation collapses to E, D and G-5 —
   about 70 lines, and a better proposal for it.
2. *"I have never had more than three proposals at once."* That deletes C5, C6
   and most of G, and makes E's fold something to open by default rather than
   keep closed.

Neither is inferable from the code and both are in
[12-validation.md](12-validation.md) as the questions to ask.
