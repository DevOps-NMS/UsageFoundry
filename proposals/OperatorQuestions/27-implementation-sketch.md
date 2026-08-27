# Implementation sketch

Enough that a later run can build this without re-deciding anything. Every
decision below is settled in an option file and linked; where a detail was not
settled anywhere, it is marked **[open]** and given a default.

Nothing here has been built. This is a shape, not a record.

---

## The files touched, in the order they should be touched

| # | File | What changes |
|---|---|---|
| 1 | `src/lib/db.ts` | one `CREATE TABLE IF NOT EXISTS` + one index, in `migrate()` |
| 2 | `src/lib/chat.ts` | row type, five accessors, two pure functions, one constant, three call-site edits |
| 3 | `src/lib/chat.test.ts` | three tests |
| 4 | `src/lib/apiTypes.ts` | two new DTO interfaces, three fields on existing ones |
| 5 | `src/app/api/chat/dto.ts` | one projection, two derived fields |
| 6 | `src/app/api/chat/[id]/questions/[qid]/answer/route.ts` | **new** |
| 7 | `src/app/chat/page.tsx` | interleave, one component, one handler, sidebar marker |
| 8 | `src/app/api/mcp/route.ts` | one tool definition, one `callTool` case |
| 9 | `src/lib/chat.ts` (again) | `systemPrompt()` sentences |
| 10 | `docs/agent/chat.md`, `docs/verification.md` | the invariant, and the by-hand list |

**The order is load-bearing and 8 comes after 7 on purpose.** A tool pushed into
`CHAT_TOOLS` is published to the model on the very next turn by `toolsFor`
(`route.ts:628-633`), whether or not `systemPrompt()` mentions it. Landing the
tool before the UI means a model that reads the description and asks a question
that nothing renders — the operator sees a turn that stopped mid-thought. Steps
1–7 are all invisible until a question row exists, and no question row can exist
until step 8.

Step 9 is separated from step 8 for a reason worth keeping: between them, the
tool exists and is described but the prompt says nothing about it. Whatever the
model does in that window is the honest first measurement of whether
`21-option-8b-tool-description-side.md`'s half is sufficient on its own.

---

## 1. The migration

One statement, idempotent, in the large `db.exec` in `migrate()`, placed
immediately after `${CHAT_PROPOSALS_TABLE}` (`db.ts:622`) so the three chat
tables read together. `SCHEMA_VERSION` is **not** bumped — `db.ts:52-66` says
the version records that a *rebuild* completed, and this is additive
([C12](01-constraints.md#c12)).

```sql
    -- A question the chat asked the operator, which no one has answered.
    --
    -- Its own table for the reason chat_proposals has one: it is a thing a
    -- model produced that a person must act on, and it has state a message
    -- row cannot carry. chat_messages is insert-only and stays that way.
    --
    -- asked_after_seq is a chat_messages.seq, which is a single global
    -- sequence that is never null (see the backfill above), so the thread
    -- renders as one ordered list of messages and questions. It is written
    -- when the tool is called and moved once, in finishTurn, to sit after
    -- the reply that turn ends with — the tool call happens mid-turn and the
    -- reply is appended at settle, so the unmoved anchor would put the
    -- question above the sentence that motivates it.
    --
    -- What it deliberately does not hold, for chat_proposals' reason: any
    -- value that is acted on. An answer is text the model reads and has
    -- exactly the standing the operator's own typing has.
    CREATE TABLE IF NOT EXISTS chat_questions (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      asked_at        INTEGER NOT NULL,
      asked_after_seq INTEGER NOT NULL,
      question        TEXT NOT NULL,
      -- JSON array of {id, label, then}. Null for a question with no
      -- enumerated answers, which is a different fact from an empty array.
      options         TEXT,
      -- 'open' | 'answered' | 'superseded'
      status          TEXT NOT NULL DEFAULT 'open',
      answer_option   TEXT,
      answer_text     TEXT,
      settled_at      INTEGER
    );
```

and beside the other two chat indexes at `db.ts:626-629`:

```sql
    CREATE INDEX IF NOT EXISTS idx_chat_questions_chat
      ON chat_questions(chat_id, asked_after_seq);
```

`ON DELETE CASCADE` matches `chat_proposals` (`db.ts:28`).

## 2. `src/lib/chat.ts`

### The constant

Beside `MAX_PENDING_PROPOSALS` (`chat.ts:241`), with a docblock in the same
register saying what it bounds and why five:

```ts
/**
 * How many one-click answers a question may offer.
 *
 * Not a storage bound — five short labels is where a question stops reading as
 * a question and starts reading as a form, and a model given ten slots fills
 * ten. The tool refuses past this and says so, so the model narrows the
 * question rather than being silently truncated.
 */
export const MAX_QUESTION_OPTIONS = 5;
```

### The row type

Beside `ChatProposalRow` (`chat.ts:161-199`), same style — one comment per field
that carries a decision:

```ts
export type QuestionStatus = "open" | "answered" | "superseded";

export interface ChatQuestionOption {
  id: string;      // "1".."5", stable within the question
  label: string;
  then: string;
}

export interface ChatQuestionRow {
  id: string;
  chat_id: string;
  asked_at: number;
  asked_after_seq: number;
  question: string;
  options: string | null;   // JSON ChatQuestionOption[]
  status: QuestionStatus;
  answer_option: string | null;
  answer_text: string | null;
  settled_at: number | null;
}
```

### Five accessors

```ts
createQuestion(chatId, { question, options }): ChatQuestionRow
listQuestions(chatId): ChatQuestionRow[]        // ORDER BY asked_after_seq, asked_at
getQuestion(id): ChatQuestionRow | null
openQuestion(chatId): ChatQuestionRow | null    // the at-most-one
answerQuestion(id, { optionId, text }): boolean // conditional UPDATE, see below
reopenQuestion(id): void                        // the compensating write
supersedeOpenQuestions(chatId): void
```

`createQuestion` takes `asked_after_seq` inline the way `appendMessage` takes
`seq` (`chat.ts:330-331`), for the same reason — one statement is the only shape
in which the number cannot be read stale:

```sql
INSERT INTO chat_questions
  (id, chat_id, asked_at, asked_after_seq, question, options, status)
VALUES (?, ?, ?, (SELECT IFNULL(MAX(seq), 0) FROM chat_messages), ?, ?, 'open')
```

`answerQuestion` is the settle-once latch, the same shape as `rejectProposal`
(`chat.ts:1051-1058`) and `finishTurn`'s `WHERE status='thinking'`
(`chat.ts:1939-1953`):

```sql
UPDATE chat_questions
   SET status = 'answered', answer_option = ?, answer_text = ?, settled_at = ?
 WHERE id = ? AND status = 'open'
```

returning `changes === 1`. `supersedeOpenQuestions` is the same with
`status = 'superseded'` and both answer columns left null, over `chat_id`.

### Two pure functions, both of which earn a test

Per [C13](01-constraints.md#c13) — a pure function whose failure mode is silent
gets one, and `docs/agent/testing.md` is the bar.

**`renderAnswer(q: ChatQuestionRow, choice): string`** — the user-message text
the model is resumed with. Its failure is silent and expensive in exactly the
way `planApprovalBatch`'s is: a wrong render means the model reads the wrong
answer and proposes the wrong work, nothing throws, and the operator sees a
confident proposal about the thing they did not choose.

```
Answering “<question, truncated to 200 chars>”: <label>
<free text, when there is any, on its own line>
```

with the label omitted when no option was chosen. Cases the test must pin:
option only; text only; both; an option id that is not on the row (must be
unreachable — the route checks first — but the function must not throw); a
question long enough to truncate; a question containing a `”`.

**`normalizeQuestionInput(args: Record<string, unknown>)`** →
`{ ok: true; value } | { ok: false; reason: string }`. The door checks, pulled
out of the route the way the rest of that file's validation is not, precisely so
they can be tested. Silent failure: an option array that passes with a blank
`label` renders a button with no text on it.

Refusals, each a sentence the model can act on
([C11](01-constraints.md#c11) — a refusal is tool output, not a protocol error):

| condition | refusal |
|---|---|
| `question` empty after trim | `"A question needs something to ask."` |
| `options` present but not an array | `"options must be a list of answers."` |
| `options.length > MAX_QUESTION_OPTIONS` | `"A question may offer at most 5 answers; you gave N. Narrow the question."` |
| an option missing `label` or `then` | `` `Option N needs both a label and a "then" saying what you would propose if it were picked.` `` |
| two options with the same `then` | **[open]** — recommended as a *refusal*, per [Option 8e](24-option-8e-branch-under-each-answer.md): if two branches lead to the same work the question does not change anything. Default to refusing, since it is the one place the `then` requirement can be enforced rather than merely asked for. |

Option ids are assigned by the app (`"1"`..`"5"`), never taken from the model —
there is nothing for a model-chosen id to be useful for and one more string to
validate if there were.

A third test is worth writing and is left to the builder's judgement: the
thread interleave (below). It is client-side and its failure is visible rather
than silent, which normally puts it under the bar — but the identical failure
has happened here before, and `db.ts:905-916` records it: an ordering that
"rendered a footnote above the message it annotates and so reversed what the
operator was being told" is exactly what a mis-anchored question would do.

### Three call-site edits

**a. Supersede at the claim.** In `sendChatMessage`, immediately after
`claimTurn` succeeds (`chat.ts:1498-1499`) and beside
`appendMessage(chatId, "user", text)` (`chat.ts:1501`):

```ts
    // An open question is a request for the next input. If the next input is
    // something else, the operator has answered by moving on, and live buttons
    // under a conversation that has left the question behind would deliver an
    // answer to something the model is no longer asking.
    supersedeOpenQuestions(chatId);
```

This sits inside the window `chat.ts:1495-1497` says has deliberately no
`await`, and adds none. Every *refusal* that could abandon a superseded question
returns before the claim — `dataDirRefusal` (`:1473-1474`), no-such-chat
(`:1477`), `thinking` (`:1480`), empty text (`:1482-1483`),
`assistRefusal`/`installBudget` (`:1492-1493`).

One path does supersede and then fail, and it is not a refusal: `runTurn` is
wrapped in a `try`/`catch` at `chat.ts:1521-1529`, and a synchronous throw there
lands on `finishTurn(chatId, { status: "failed", … })`. That outcome is correct
rather than merely tolerable, and the reason is
`appendMessage(chatId, "user", text)` at `chat.ts:1501`: the operator's message
is already in the thread, so the conversation genuinely did move on and only the
child failed to spawn. **Do not add a rollback there.** If that judgement is ever
reversed the fix is one statement inside the existing `catch` reverting the rows
to `open`, and it should be written down as a change of mind rather than slipped
in as a repair. (Found by reading `chat.ts:1465-1532`; the brief this sketch was
written from asserted no such path existed.)

**b. Re-anchor at settle.** In `finishTurn`, where the reply is appended
(`chat.ts:1996`), keeping the returned row so its `seq` is in hand:

```ts
  if (r.text) {
    const reply = appendMessage(chatId, "assistant", r.text);
    // The tool call happens mid-turn and this reply is appended at settle, so
    // a question anchored where it was asked renders above the sentence that
    // motivates it. At most one question is open — the claim superseded any
    // older one — so this needs no narrower predicate than the chat.
    reanchorOpenQuestion(chatId, reply.seq);
  }
```

**c. `chatPrompt` replays an open question.** `chatPrompt` (`chat.ts:635-667`)
replays `chat_messages` only, so on the no-session-id path a question is
invisible to the model that asked it ([F8](00-problem.md#f8),
[C2](01-constraints.md#c2)). Add the open question, if any, as a final block
inside `<thread>`:

```
<question>What you asked and have not been answered: …</question>
```

**[open]** whether this is worth its complexity. The alternative is to accept
that a replayed thread loses the question and the model asks again — bounded,
rare and self-healing. Default to building it, because the failure it prevents
(the model proposing under a guess while a question sits unanswered on the
operator's screen) is exactly the state this feature exists to remove.

## 3. `src/lib/apiTypes.ts`

```ts
export interface ChatQuestionOptionDTO {
  id: string;
  label: string;
  then: string;
  chosen: boolean;
}

export interface ChatQuestionDTO {
  id: string;
  askedAt: number;
  askedAfterSeq: number;
  question: string;
  options: ChatQuestionOptionDTO[];   // empty array when the row's options are null
  status: "open" | "answered" | "superseded";
  answerText: string | null;
  settledAt: number | null;
}
```

Three fields on existing types:

- `ChatMessageDTO` (`apiTypes.ts:2382-2387`) gains `seq: number` — without it the
  page cannot interleave, per [Option 7a](18-option-7a-inline-in-thread.md).
- `ChatDTO` (`apiTypes.ts:2480-2492`) gains `questions: ChatQuestionDTO[]` and
  `awaitingAnswer: boolean`.
- `ChatListEntryDTO` (`apiTypes.ts:2494-2501`) gains `awaitingAnswer: boolean`.

`awaitingAnswer` is derived, never stored — [Option 4a](11-option-4a-idle.md).
It is `questions.some(q => q.status === "open")`, and it is deliberately *not*
`&& status === "idle"`: a turn that asked and then timed out leaves a live
question behind a `failed` row ([C1](01-constraints.md#c1) — the tool call
commits before the kill), and the operator's answer is still worth taking.

## 4. `src/app/api/chat/dto.ts`

`chatDTO` (`dto.ts:39-57`) gains `questions: questionDTOs(listQuestions(chat.id))`
and the derived flag. `chatListDTO` (`dto.ts:88-97`) gains `awaitingAnswer` per
chat — the same per-chat subquery shape `pendingCount` already uses at
`dto.ts:95`, so the cost is known and the precedent is established.

`questionDTO` marks `chosen` on the option whose id matches `answer_option`, and
parses `options` defensively: a row whose JSON does not parse yields an empty
option list and the question still renders as prose. It is the same posture the
proposal projection takes toward a template that has since been deleted — the
row the operator is looking at does not vanish.

## 5. The answer route

`src/app/api/chat/[id]/questions/[qid]/answer/route.ts`, wrapped in
`auditMutation` like every other mutating chat route (`message/route.ts:33`,
`proposals/route.ts:175`), with `runtime = "nodejs"` and
`dynamic = "force-dynamic"` per `docs/agent/conventions.md:11`.

Request `{ optionId?: string; text?: string }`; response `{ chat: ChatDTO | null }`
on 200 and `{ error: string }` on 400 — matching `message/route.ts:24-29` so the
existing `chatRequest` helper (`src/lib/chatRequest.ts:28-38`) can be reused
unchanged.

```
1  read id, qid, body
2  optionId = body.optionId == null ? null : String(body.optionId)
3  text     = String(body.text ?? "").trim() || null
4  if (!optionId && !text)  → 400 "An answer needs a choice or some text."
5  q = getQuestion(qid)
6  if (!q || q.chat_id !== id) → 404 "Not found"
7  if (q.status !== "open")    → 400 `This question was already ${q.status}.`
8  if (optionId && not on q's own options) → 400 "That is not one of the answers offered."
9  message = renderAnswer(q, { optionId, text })
10 if (!answerQuestion(qid, { optionId, text })) → 400 "This question was already answered."
11 res = await sendChatMessage(id, message)
12 if (!res.ok) { reopenQuestion(qid); return 400 { error: res.reason } }
13 return { chat: chatDTO(getChat(id)) }
```

Four things about that sequence are decisions rather than mechanics:

- **Step 8 validates against the row, never against the request.** The options
  the operator could see are the ones stored; a client that posts an id that was
  never offered is refused. Same posture as the approval route taking the
  explicit list of ids the page displayed (`docs/agent/chat.md:8`).
- **Step 10 is the latch, and it is before the send.** Two tabs, or a click on a
  ten-second-stale poll ([C3](01-constraints.md#c3)), get one turn and one
  sentence rather than two turns.
- **Step 12 is the compensating write, and it is required.** Without it a
  refused `sendChatMessage` — an assist ceiling, an install budget, a turn that
  raced in — leaves a question marked answered with nothing behind it, which is
  the one state the operator cannot recover from by clicking.
- **Step 11 delegates rather than reimplements.** This route does not learn how
  to start a turn. Every gate stays exactly where it is, and in particular the
  no-`await` window at `chat.ts:1495-1497` is untouched, because the route's own
  `await` is on `sendChatMessage` as a whole.

The route writes nothing that is acted on — [C7](01-constraints.md#c7). It may
not touch a `chat_proposals` row, and no field of an answer may reach a guard.

## 6. The MCP tool

One object pushed into `CHAT_TOOLS` (`route.ts:247-521`) and one `case` in
`callTool` (`route.ts:805-1016`). The orchestrator-block refusal is free — the
door check at `route.ts:791-792` is a membership test over that same array
([C11](01-constraints.md#c11), [F9](00-problem.md#f9)).

```ts
    {
      name: "ask_operator",
      description:
        "Ask the operator one clarifying question. This does NOT wait: it " +
        "records the question, the operator sees it under your reply, and " +
        "their answer arrives as the next message you are resumed with. " +
        "Only one question may be open in a chat at a time, and a second " +
        "call is refused while one is. Every option must say what you would " +
        "propose if the operator picked it — if you cannot say that, you " +
        "have not read enough to have a question.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "What you need to know, in a sentence or two, and why it " +
              "changes what you would propose. Do not ask what reading the " +
              "repository would answer.",
          },
          options: {
            type: "array",
            description:
              "Up to five answers the operator can give with one click. " +
              "Omit it when the answer cannot be enumerated — they can " +
              "always type instead. A question whose branches you cannot " +
              "name is usually one you should have answered by looking.",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description:
                    "The answer itself, short enough to read on a button.",
                },
                then: {
                  type: "string",
                  description:
                    "What you would propose if the operator picked this. One " +
                    "line. Two options with the same one is a question that " +
                    "changes nothing, and is refused.",
                },
              },
              required: ["label", "then"],
              additionalProperties: false,
            },
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
```

The handler: `normalizeQuestionInput(args)`, then the open-question refusal —

```ts
const open = openQuestion(chatId!);
if (open) {
  return text(
    `You already asked: “${open.question}”. The operator answers one thing ` +
      "at a time; wait for it, or make your reply say what you would do " +
      "under each answer.",
    true,
  );
}
```

— then `createQuestion`, then a success string in the house shape, which names
what was recorded and ends by asserting that nothing started
(`route.ts:1684-1687` is the pattern):

```ts
return text(
  `Asked the operator: “${question}”${optionCount} Their answer arrives as ` +
    "your next message. Nothing is running and nothing is proposed — if " +
    "there is work worth doing under every answer, propose it now and let " +
    "the answer refine it.",
);
```

## 7. The page

**Interleave.** One `useMemo` over `chat.messages` and `chat.questions`, merged
by `seq` / `askedAfterSeq`, questions after the message they share a number with:

```ts
type ThreadItem =
  | { kind: "message"; seq: number; message: ChatMessageDTO }
  | { kind: "question"; seq: number; question: ChatQuestionDTO };
```

Two existing readers must move from `chat.messages` to this array or they go
silently wrong: the grouping test at `page.tsx:756-762`
(`chat.messages[i-1].role === m.role` — a question between two assistant turns
must break the grouping), and the added-items effect at `page.tsx:398-416`,
which drives scroll-follow and the unseen count off `chat.messages.length` and
would not notice a question arriving on its own.

**The card.** A new `Question` component beside `Message`
(`page.tsx:1132-1171`). Structure, bound by
[C14](01-constraints.md#c14) / `docs/agent/conventions.md:21` — who is speaking
is said with structure, never with colour, and the two existing treatments are
taken (the operator's bezelled block pulled right, the `system` hairline):

- open: the question prose at the thread's measure; then the options as a
  vertical stack of `Button variant="secondary"`, each with its `then` as a
  `Hint` under it; then a small labelled text field and a Send-answer button.
  A `Hint` says the operator can also just type below.
- answered: the same box, quiet, with the chosen option marked and the free text
  shown. Not interactive.
- superseded: quiet, options shown unchosen, one line saying the conversation
  moved on. Not interactive. Never removed —
  [Option 5a](13-option-5a-superseded.md).

`Icon`'s name union is closed and holds no question glyph
([C14](01-constraints.md#c14)), so the card is built without one.

**The handler.** `answer(qid, body)` beside `decide` (`page.tsx:540-554`), same
`busy` discipline, calling `chatRequest`.

**The sidebar.** At `page.tsx:1553-1556`, beside the `thinking` word and the
`{pendingCount} waiting` badge:

```tsx
{entry.awaitingAnswer && <span className="text-accent">waiting on you</span>}
```

This is the highest-value pixel in the feature — it is the whole of
[F3](00-problem.md#f3) — and it is one line because
[Option 4a](11-option-4a-idle.md) kept it off the status union.

**The poll cadence stays at idle.** `page.tsx:361` is unchanged: nothing
server-side moves while a question waits, so the fast cadence would be spending
requests to watch a row only the operator can change
([C3](01-constraints.md#c3)). The ten-second delay is on the question
*appearing*, which is the same delay every other settled turn already has.

**The composer is not disabled.** `page.tsx:493-495` records that the textarea
is deliberately never `disabled`, and a question does not change that: typing is
the escape, and it supersedes.

## 8. `systemPrompt()`

Three existing passages change and one section is added. The full argument is in
[Option 8a](20-option-8a-prompt-side.md); the text:

- `chat.ts:2096-2099` — "The two things you can do" becomes three, naming
  `ask_operator` and saying it starts nothing either.
- `chat.ts:2139-2140` — keep the sentence, and make it say which agent it is
  about: the *run* agent cannot ask, which is why the brief has to be whole.
- `chat.ts:2173-2175` — the reply shape covers both endings.
- A new section between "Ordering runs against each other:" and "Proposing a
  workflow:":

```
Asking instead of guessing:
- Ask only what no amount of reading could answer: what the operator wants,
  which of several jobs matters now, a fact about their intent. Anything a
  Grep, a git log or a build would tell you, find out.
- Prefer proposing and asking to asking and waiting. If there is work worth
  doing whatever the answer, propose it and ask as well — the answer then
  refines the next proposal instead of holding everything up.
- Every option you offer says what you would propose if it were picked. If
  you cannot write that line, you have not read enough to have a question.
- One question, then propose. If you find yourself wanting a second, you are
  guessing at the shape of the work: say that in your reply, propose your
  best reading of it, and let the operator correct you.
```

## 9. Docs

- `docs/agent/chat.md` gains one paragraph in the house register, recording:
  that a question ends the turn and why a blocking one is impossible; that a
  question holds nothing that is acted on and an answer has the operator's own
  standing; that the waiting state is derived rather than a fourth status, and
  the ten silent failures that decided it; that an ignored question is
  superseded rather than expired, and that it may never gain a clock.
- `docs/verification.md` gains the by-hand list from
  [28-validation.md](28-validation.md), including its **"Not yet verified by
  hand"** entries. `CLAUDE.md` requires that list to stay honest.

## What is deliberately not built

- No setting. No `maxQuestionsPerChat`, no toggle to disable asking —
  [Option 8c](22-option-8c-question-budget.md).
- No new `chat_sessions.status` value —
  [Option 4b](12-option-4b-awaiting-answer-status.md).
- No sweeper and no expiry — [C6](01-constraints.md#c6).
- No `globalThis` state. Nothing here is long-lived module state, so there is no
  new key and no shape-change hazard.
- No change to the poll, the composer's disabled state, `claimTurn`,
  `reconcileChatsOnBoot`, or `review.ts`'s assist count. Every one of them is
  already correct for a chat with an open question, and each was checked rather
  than assumed ([C4](01-constraints.md#c4)).
