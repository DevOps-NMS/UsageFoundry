# Option D — make an ending legible and recoverable

**Answers:** F1, F2, F3, F4, F6, and C7's second half. Partially F5.

Five small changes, each independent, each answering a place where the interface
currently asserts something the code contradicts. This is the cheapest option
per finding closed in the directory.

---

## D-1. The restart case leaves a record

`reconcileChatsOnBoot` (`chat.ts:2446-2453`) writes the row and nothing else.
`endTurn` (`:1695-1706`), three lines away, writes the row **and** appends the
same string as a system message, with a comment saying why: "the conversation
should read as what happened to it, and a turn that stops without a word looks
like an answer that never came."

The restart case is the one where that reasoning applies hardest, because
`claimTurn` clears `error` on the next message (`:1618`) — so today the only
trace of a lost turn is erased by the operator's attempt to recover from it.

**The change:** the boot reconciler appends the message it already writes to the
row. One statement in a loop over the rows it just failed, or a `SELECT` before
the `UPDATE`. This is a `src/lib` change on a boot path, and it is four lines.

**The consequence for F2:** with all four endings appending, `turnFailure`
(`page.tsx:701-704`) becomes permanently dead code. Either delete it or keep it
as the belt it says it is; it is not this proposal's business, but it should be
noticed.

## D-2. A failure is toned apart from a note

`Message`'s `system` branch (`page.tsx:1307-1320`) draws "The chat did not
answer within 10 minutes and was stopped" in the same `text-ink-muted` with the
same `border-l-line-strong` as "The chat saved a new template, 'Retry audit',
under your default guard set". Its docblock argues that `system` must be styled
apart from `assistant` — "a sentence about what the app did, rendered as though
the model said it, is a sentence the operator will later attribute to the wrong
party" — and the same argument distinguishes what the app *did* from what went
*wrong*.

**The change:** the page already knows. `chat.status === "failed"` plus "this is
the last message" identifies exactly the failure note, and `QUESTION_EDGE`
(`page.tsx:159-162`) is the pattern for a per-state complete class string.
Roughly:

```ts
const SYSTEM_EDGE: Record<"note" | "failure", string> = {
  note:    "border-l-line-strong text-ink-muted",
  failure: "border-l-danger text-ink",
};
```

`Message` takes one more prop. Six lines, no new state, no new request.

The alternative — a `kind` column on `chat_messages` distinguishing a note from
a failure — is more honest and is a migration plus five call sites in
`finishTurn` and `endTurn`. It is the right answer if this is ever wanted for
anything else; it is more than this finding is worth on its own.

## D-3. Say the message survived, and offer it back

Under a failure note, one line and one control:

> Your message is still in the thread. **Send it again**

`Send it again` puts the last user message back in the composer (`setDraft`) and
focuses it — it does **not** post. X3 and X4 both bear on this: nothing may start
a turn except the operator pressing Send, and nothing may be re-asked
unattended. Filling the composer is neither.

`caretTo` (`page.tsx:288`, `:497-505`) already exists for putting text into the
composer and moving the caret, so the mechanism is there.

## D-4. A question whose turn died says so

`AskedQuestions` (`page.tsx:1442`) already has `thinking`, and already draws a
line when a turn is in flight — "This turn is still working — you can answer
once it finishes" (`:1620-1624`). The symmetric case has no line: when the chat
is `failed` and a question is still `pending`, the card reads "Waiting on you"
and says nothing about the turn that asked it being gone.

**The change:** pass the status and draw the counterpart sentence — "The turn
that asked this was stopped. Answering starts a new one." That is true
(`answerChatQuestions` → `sendChatMessage`, `chat.ts:1923-1927`) and it is the
fact that decides whether the operator answers or starts over. Four lines and one
prop.

## D-5. A partially-answered set survives its own refusal

`settleQuestions` fails the whole call when any id has stopped being open and
tells the operator to "Reload the chat" (`chat.ts:670-674`). Reloading is what
destroys the four answers that were fine — the drafts are `useState` local to
the card (`page.tsx:1457`).

Two independent halves:

- **Change the sentence.** It should name what happened and what survives:
  "One of these was answered elsewhere, so nothing was sent. Your other answers
  are still here — press Answer again." That is a `src/lib` string and it is
  true today: the refusal happens before anything is written, so the drafts
  *are* still in the card.
- **Persist the drafts.** `sessionStorage` keyed by chat id, restored on mount.
  This survives a reload and a thread switch. It is ~10 lines and it is the one
  part of this option that adds client state; it is also the difference between
  "answering five questions is safe" and "answering five questions is safe as
  long as nothing interrupts you".

The first half is worth doing regardless. The second is worth doing if anyone
has actually lost answers, and nobody in this container can say.

## What F5 still needs

D-1 through D-5 do not record a killed turn's spend. That needs a figure that
does not exist without [04-option-c](04-option-c-live-activity-feed.md)'s
stream. What is available here is the cheap half of
[03-option-b](03-option-b-name-the-clock.md)'s third part: make the header say
what it counts, so "$0.83 this chat" stops implying it counts everything.

---

## What it costs

| Change | Files | Lines | Risk |
|---|---|---|---|
| D-1 boot message | `chat.ts` | ~4 | boot path; the statement is already written beside it |
| D-2 failure tone | `page.tsx` | ~6 | none |
| D-3 send again | `page.tsx` | ~8 | none — fills the composer, does not post |
| D-4 dead-turn note | `page.tsx` | ~4 | none |
| D-5a wording | `chat.ts` | 1 string | none |
| D-5b draft persistence | `page.tsx` | ~10 | client state only |

~35 lines across two files. Nothing on the approval path, nothing on the spawn
path, no migration, no new request.

## The argument against it

D-2 makes a visual distinction the data model does not carry — the page infers
"this system message is a failure" from `chat.status` and position rather than
from the row. That inference is wrong in one case: a chat that failed and was
then re-sent has `status` moved on, so an old failure note reverts to grey.
Since `claimTurn` clears the status, the historical failures in a long thread
all read as notes again. That is the argument for the `kind` column, and it is a
real one; the cheap version fixes the case an operator is looking at *now* and
leaves the history ambiguous.

## Score

Closes more findings per line than anything else here, and four of them are
"currently misled" rather than "not told".
