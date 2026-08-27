# The orchestrator cannot ask, and nothing knows it is waiting

The operator opens `/chat` and says "clean up the tests". Two mounts are
attached. The orchestrator does not know which repository is meant, and it has
two ways to behave, both bad.

It can guess, and propose. The proposal card is complete and correct in every
field the approval gate cares about — folder, guard set, agent, task — and it is
about the wrong repository. The operator rejects it, types the clarification,
and pays for a second turn.

Or it can ask, by ending its reply with a sentence. The turn settles. The row
goes to `idle` (`src/lib/chat.ts:1932`, `:1956`). The spinner disappears
(`src/app/chat/page.tsx:765`). The composer's hint changes back to "⌘↩ or Enter
sends" (`page.tsx:943-946`). The sidebar entry for the thread shows no word at
all (`page.tsx:1553`). **Every observable signal on the page says the
conversation is finished.** The one thing that says otherwise is the last
sentence of a paragraph of prose, which the operator has to read to discover
that they are the thing being waited on.

That second case is the defect. It is not "the chat should be able to ask" — it
already can, in the only sense prose can. It is that **a chat that asked and a
chat that finished are bit-for-bit the same row**, so nothing in the app can
tell the operator apart from a bystander.

---

## <a id="f1"></a>F1 — The prompt tells it not to ask, in three places

`systemPrompt()` (`src/lib/chat.ts:2090-2177`) is the whole boundary on this
child (`docs/agent/chat.md:24`). Three of its sentences assume a turn ends in a
proposal.

`chat.ts:2096-2099`:

> "You cannot start, stop or resume a run, and you cannot press Run on a
> workflow. **The two things you can do are propose_run and propose_workflow**,
> and both only record a proposal the operator approves or rejects by hand."

An enumeration of two, stated as a closed list of what the model can do.

`chat.ts:2139-2140`, under "Proposing a run:":

> "One proposal per unit of work. The task text is the whole brief, **read by an
> agent that cannot ask you a follow-up question.**"

This is a true and load-bearing sentence about the *run* agent — a headless
child with nobody watching it. But it sits in the paragraph that shapes the
orchestrator's own behaviour, and nothing anywhere distinguishes "the agent you
are briefing cannot ask" from "you cannot ask".

`chat.ts:2173-2175`, the closing instruction:

> "Be brief. **When you have proposed**, reply with a short list of what you
> proposed and what you deliberately left out."

The reply's shape is specified for exactly one ending.

So the model is not merely unequipped to ask — it is instructed toward the
guess. What it does when it is unsure is unmeasured here (see
[the unverifiable list](28-validation.md#what-cannot-be-checked-here)), but the
prompt's incentive is one-directional and stated three times.

## <a id="f2"></a>F2 — `idle` means two different things and the app cannot tell them apart

`ChatStatus` is `"idle" | "thinking" | "failed"` (`chat.ts:92`), documented at
`src/lib/db.ts:556-559`. `parseTurnOutput` returns `status: "idle"` for every
successful turn (`chat.ts:1932`) and `finishTurn` writes it (`chat.ts:1950`,
`:1956`).

There is no third thing a settled turn can be. A turn that answered fully, a
turn that answered and asked, and a turn that did nothing but ask all land on
the same value, and every reader of that value — the poll cadence, the composer,
the sidebar, the assist-slot count in `src/lib/review.ts:379` — treats them
identically.

## <a id="f3"></a>F3 — Ten sites on the page read the status, and none of them can say "waiting on you"

Every one is an equality test against `"thinking"` (or `"failed"`), listed here
because [Option 4b](12-option-4b-awaiting-answer-status.md) turns on the fact
that none of them is exhaustive:

| `page.tsx` | what it decides |
|---|---|
| `:269` | `const thinking = chat?.status === "thinking"` — the flag under everything below |
| `:361` | poll period, 3s vs 10s |
| `:421` | whether a new message scrolls the reader down |
| `:496` | `send()`'s own refusal |
| `:610` | whether `chat.error` is surfaced as a turn failure |
| `:765` | whether the `Waiting` row is drawn |
| `:943-946` | the composer hint's text |
| `:947-951` | whether the Stop button exists |
| `:954` | whether Send is disabled |
| `:1553` | the word beside a thread in the Chats tab |

The sidebar row (`:1553-1556`) is the one that matters most for an operator with
several threads: it shows `thinking` when a turn is in flight and a
`{pendingCount} waiting` badge when proposals are undecided. **A thread holding
an unanswered question shows neither.** The affordance that says "this thread
needs you" exists, is already built, and a question cannot reach it.

## <a id="f4"></a>F4 — The answer has no structure, and nothing joins it to the question

The operator's reply goes through `POST /api/chat/[id]/message`
(`src/app/api/chat/[id]/message/route.ts:19-30`), which reads exactly one field:

```ts
21    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
23    const res = await sendChatMessage(id, String(body.message ?? ""));
```

`sendChatMessage` writes it with `appendMessage(chatId, "user", text)`
(`chat.ts:1501`) into a table whose columns are `id, chat_id, ts, seq, role,
text` (`db.ts:598-607`). There is nowhere for "this answers that" to live, and
nothing downstream asks.

Three consequences, all of them things the operator pays for:

- **The model re-derives the join.** If it asked three things and got one
  paragraph, matching answers to questions is inference, and inference is what
  the question was supposed to remove.
- **The pair cannot be rendered.** Six turns later the thread is prose; "what
  did I decide about the repository, and when" is a re-read rather than a look.
- **One-click is impossible.** A button needs something to send that is not free
  text, and there is no field on the wire that is not free text.

## <a id="f5"></a>F5 — The mechanism everyone reaches for first is a deadlock, not a timeout

The intuitive design is a tool call that blocks: `ask_operator(...)` waits, the
operator clicks, the tool returns, the model carries on in the same turn. It is
unavailable twice over, and the second reason is the interesting one.

**The turn is killed at ten minutes and its answer is thrown away.**
`CHAT_TIMEOUT_MS = 10 * 60_000` (`chat.ts:247-248`). The in-closure timer
SIGTERMs the child and sets `timedOut` (`chat.ts:1734-1740`); at settle,
`parseTurnOutput` is *never called* on a timed-out turn (`chat.ts:1758-1764`),
so the accumulated stdout — reply text, `total_cost_usd`, `session_id` — is
discarded. A sweeper backstops it at eleven minutes
(`STALE_TURN_MARGIN_MS = 60_000`, `chat.ts:258`; `sweepStuckChats`,
`chat.ts:1431-1443`).

**And the operator cannot answer while the turn that asked is alive.**
`sendChatMessage` refuses on `status === "thinking"` twice — a fast check at
`chat.ts:1480` and the authoritative `claimTurn` at `chat.ts:1498-1499`, both
returning `ALREADY_THINKING` ("This chat is still working on the last message.",
`chat.ts:1251-1254`), which the route turns into a 400
(`message/route.ts:24-26`). So a blocking tool call would not merely risk the
ten-minute wall; it would sit behind a door the app closes for the whole
duration of the thing that is waiting.

This is stated first because it forecloses the shape most of the design space
would otherwise have. Everything below assumes **the question ends the turn.**

## <a id="f6"></a>F6 — There is one precedent for a tool speaking into the thread, and it speaks as the wrong party

`save_template` appends into the conversation from inside a tool call
(`src/app/api/mcp/route.ts:1428-1436`), with the reason given in its own
docblock: *"A proposal has a card; this has nothing."* It writes role `system`.

`system` is defined at `db.ts:602-604` as **this app speaking about the chat**,
and `docs/agent/conventions.md:21` states the cost of getting it wrong:

> A `system` turn is this app speaking and keeps its own treatment, because a
> sentence about what the app did, rendered as though the model said it, is one
> the operator will later attribute to the wrong party.

That cuts both ways. A question is the *model* speaking *in* the chat. Rendered
as `system` — the quiet hairline box at `page.tsx:1135-1148` — it reads as the
app announcing something, which is the same misattribution in the other
direction. `ChatRole` has no fourth value (`chat.ts:93`), so today there is no
role a question could honestly wear.

## <a id="f7"></a>F7 — Asking is not free, and asking twice is not twice free

Every turn is a billed `claude -p` child. The gate before it is
`assistRefusal() ?? installBudgetRefusal()` (`chat.ts:1492-1493`); the ceiling
inside it is `settings.chatTurnBudgetUSD` (default $2) passed as
`--max-budget-usd` (`chat.ts:1700-1705`); each settled turn writes one dated row
to `chat_turn_spend` (`chat.ts:1975-1981`) which the install-wide 24-hour ceiling
reads (`src/lib/installBudget.ts:28`, `:74`).

A question is a turn. Its answer starts another. **A three-question
interrogation conducted one question at a time is six billed children and six
round trips through a page that polls at ten seconds** — before any work has
been proposed. That is the cost the behavioural half of this design
([forks 3 and 8](25-comparison.md)) exists to bound, and it is money as well as
patience.

## <a id="f8"></a>F8 — A question would be invisible to the thread-replay path

`chatPrompt` (`chat.ts:635-667`) sends the bare message when
`chat_sessions.session_id` is present (`chat.ts:639`), and otherwise replays the
newest `THREAD_REPLAY_MESSAGES = 20` messages inside `THREAD_REPLAY_BYTES =
20_000` (`chat.ts:243-244`, `:655-666`). The replay source is `listMessages`
(`chat.ts:1502-1504`), which reads `chat_messages` and nothing else.

Anything stored outside that table is invisible on the path where continuity is
reconstructed rather than resumed. This is not hypothetical: the session id is
null on a thread's first turn, and `finishTurn` will note a CLI that answered
under a different one (`chat.ts:1988-1993`). Any design that puts a question in
its own table has to decide what a replayed thread is told about it.

## <a id="f9"></a>F9 — Whatever is built must never reach an orchestrator block, and the machine that would stop it is already there

`/api/mcp` publishes different tool lists per subject
(`route.ts:628-633`), and `callTool` re-checks membership at the door rather
than trusting the list (`route.ts:790-800`). An orchestrator block runs with
nobody looking — that is the whole asymmetry `docs/agent/chat.md:18` is built
on. **A block that asked a question would park for ever with no one to answer
it.**

The good news is that this costs nothing: the guards at `route.ts:791-792` are
membership tests over `CHAT_TOOLS`, so a tool pushed into that array is refused
for a block with no new code. It is recorded here because it is the failure mode
a reader will worry about, and it is already closed.

## <a id="f10"></a>F10 — The affordance the operator wants already exists twenty pixels away

The proposals panel is a working answer to "the model produced something and a
person must decide about it": rows in one grouped box (`page.tsx:1013-1021`),
selection as a wash rather than a border, a consequence sentence in words above
the action row (`page.tsx:1067-1070`, built at `:628-644`), the default action at
the right edge, and the **explicit list of the ids the page displayed** on the
wire (`conventions.md:21`; `src/app/api/chat/[id]/proposals/route.ts:64-69`).

None of it is reachable for a question, because the thing it renders is a
`chat_proposals` row and a question is not one. The gap is not that the app has
no vocabulary for "a person must decide" — it is that a question has no object
to hang on.

---

## What this is not

**Not a request for the run agent to be able to ask.** `chat.ts:2139-2140` is
correct: a headless agent under `bypassPermissions` with a budget guard has
nobody to ask, and giving it a channel would be a different and much worse
proposal. The subject here is only the orchestrator chat, where a human is
already on the other end of the pane.

**Not a second route to a guard.** `docs/agent/chat.md:8` and `db.ts:616-621`
close that door and this proposal does not reopen it; see
[C7](01-constraints.md#c7).

**Not a fix for the operator having to type.** Typing works. What does not work
is that nobody is told they are being waited on, and that what they type lands
as an unattached paragraph.
