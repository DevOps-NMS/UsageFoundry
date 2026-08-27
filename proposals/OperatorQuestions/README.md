# OperatorQuestions

**The question this surveys:** the orchestrator chat proposes work the moment it
can guess. What would it take for it to ask the operator a clarifying question
first — with a real interface, not a sentence at the end of a paragraph — and
what stops it interrogating the operator instead of reading the repository?

**State:** open. One recommendation, and it is **to build**, at the smaller of
the two coherent scopes described below. Nothing here has been implemented,
nothing was measured, and no container was started.

---

## The finding the survey turns on

Not "the chat cannot ask" — it can, in the only sense prose can. It is that
**a chat that asked and a chat that finished are bit-for-bit the same row.**

`ChatStatus` is `idle | thinking | failed` (`src/lib/chat.ts:92`), and a turn
that asked settles to `idle` exactly like one that answered. So the spinner
disappears, the composer's hint goes back to "⌘↩ or Enter sends", the sidebar
entry shows no word at all, and the operator — who may be supervising several
threads — learns they were asked something only by reading the last paragraph of
one of them. That is a defect in the app whatever the model does, and it is the
one thing here that cannot be fixed without an object to hang "waiting" on.

Everything else in the recommendation is downstream of needing that object.

## The constraint that narrowed the design most

**A tool call cannot wait for a human, and the reason is a deadlock before it is
a timeout** ([C1](01-constraints.md#c1)).

`CHAT_TIMEOUT_MS` is ten minutes (`src/lib/chat.ts:247-248`) and a turn that
overruns is killed with its answer discarded — `parseTurnOutput` is never called
(`chat.ts:1758-1764`). But the sharper half is that `sendChatMessage` refuses
while a turn is in flight (`chat.ts:1480`, `:1498-1499`), so a blocking
`ask_operator` would hold a door shut against the only person who could open it,
for as long as it held it. And there is no channel to deliver a click on:
`/api/mcp` answers plain JSON and refuses `GET` with "No server stream"
(`src/app/api/mcp/route.ts:710-715`).

The most obvious design in the space is therefore unavailable, and every option
in this survey assumes **the question ends the turn**.

## The recommendation in one paragraph

One `chat_questions` row anchored into the thread by a `chat_messages.seq`; one
chat-only `ask_operator` tool taking a question and up to five options, **each of
which must say what the model would propose if it were picked**; one dedicated
answer route that latches the row and then delegates to `sendChatMessage`, so it
adds no second route to spending money; one card rendered inline in the thread;
and a **derived** `awaitingAnswer` flag on the DTOs rather than a fourth
`chat_sessions.status` value, because ten sites on the chat page read that column
with `===` and none of them would fail to compile. An ignored question is
superseded when the next turn is claimed — never deleted, and never given a
clock. The behavioural half splits along the line
[C10](01-constraints.md#c10) already draws: mechanics in the tool description,
judgement in `systemPrompt()`, whose load-bearing new rule is not a cap on asking
but a redirection of it — **propose under your best guess and ask as well.**

## The files

| | |
|---|---|
| [00-problem.md](00-problem.md) | What is wrong today, in the operator's terms. Ten findings, `#f1`–`#f10`. |
| [01-constraints.md](01-constraints.md) | Fourteen verified facts that bound the field, `#c1`–`#c14`. C1 kills the obvious design. |

**Fork 1 — where the question lives**

| | Verdict |
|---|---|
| [02 — a `chat_questions` table](02-option-1a-questions-table.md) | **Recommended** |
| [03 — a fourth `chat_messages` role, or a column on it](03-option-1b-message-role.md) | Refused, narrowly, on mutability |
| [04 — a column on `chat_sessions`](04-option-1c-session-column.md) | Refused on history — and it is the runner-up design |

**Fork 2 — what a question may be**

| | Verdict |
|---|---|
| [05 — free text only](05-option-2a-free-text.md) | Retained as the floor |
| [06 — one choice from model-written options](06-option-2b-single-choice.md) | **Recommended** |
| [07 — multi-select](07-option-2c-multi-select.md) | **Refused by name** — that question is what the approval gate is |
| [08 — a choice with an escape](08-option-2d-choice-with-other.md) | **Recommended — the shape** |

**Fork 3 — one question or several**

| | Verdict |
|---|---|
| [09 — one open at a time](09-option-3a-one-question.md) | **Recommended** |
| [10 — several per turn](10-option-3b-several-per-turn.md) | Refused; its efficiency case conceded in full |

**Fork 4 — what the chat's status becomes**

| | Verdict |
|---|---|
| [11 — stay `idle`, derive the flag](11-option-4a-idle.md) | **Recommended** |
| [12 — a fourth status value](12-option-4b-awaiting-answer-status.md) | Refused on ten silent failures |

**Fork 5 — the abandoned question**

| | Verdict |
|---|---|
| [13 — superseded at the next claim](13-option-5a-superseded.md) | **Recommended** |
| [14 — the operator dismisses it](14-option-5b-cancelled.md) | Refused as the mechanism, kept as a possible affordance |
| [15 — left open for ever](15-option-5c-left-open.md) | Refused on the stale signal; its no-clock half adopted |

**Fork 6 — where the answer enters**

| | Verdict |
|---|---|
| [16 — an ordinary user message](16-option-6a-ordinary-message.md) | Refused: it cannot tell an answer from a coincidence |
| [17 — a dedicated answer route](17-option-6b-answer-route.md) | **Recommended** |

**Fork 7 — where it surfaces**

| | Verdict |
|---|---|
| [18 — inline in the thread](18-option-7a-inline-in-thread.md) | **Recommended** |
| [19 — a card beside the proposals](19-option-7b-side-panel-card.md) | Refused; its good half (a sidebar marker) adopted |

**Fork 8 — the behavioural half**

| | Verdict |
|---|---|
| [20 — in `systemPrompt()`](20-option-8a-prompt-side.md) | **Recommended for the *when*** |
| [21 — in the tool description](21-option-8b-tool-description-side.md) | **Recommended for the mechanics** |
| [22 — a stated question budget](22-option-8c-question-budget.md) | Prose plus the structural cap; both numeric forms refused |
| [23 — only what reading cannot answer](23-option-8d-unanswerable-by-reading.md) | **Recommended**, and stated as unenforceable |
| [24 — every option says what it leads to](24-option-8e-branch-under-each-answer.md) | **Recommended, required** — the design's spine |

**And the conclusions**

| | |
|---|---|
| [25-comparison.md](25-comparison.md) | Eight axes, eight tables, the three decisions that carried the weight, and where the survey is weakest |
| [26-recommendation.md](26-recommendation.md) | The design, the second-best, four things that would overturn it, and the kill criterion |
| [27-implementation-sketch.md](27-implementation-sketch.md) | Ten files in the order they should be touched, the migration statement, the tool schema, the DTOs, the route's nine steps |
| [28-validation.md](28-validation.md) | Nine acceptance statements, three unit tests, a ten-step click list, and five things that cannot be checked by hand |

## Three refusals worth knowing about without reading the files

**Multi-select is refused because that question already has a better
mechanism.** "Which of these five should I work on" is answered by proposing
them and letting the operator approve a subset — on cards that spell out the
guard set, the folder, the agent and what the click starts
(`docs/agent/conventions.md:21`). A multi-select question would be a worse copy
of the approval gate sitting twenty pixels from it, and two tick-box surfaces
meaning different things is how an approval gate becomes something people click
through.

**A numeric question budget is refused twice.** As a setting, because
`docs/agent/chat.md:26` refuses per-chat thresholds as "a threshold nobody set".
As a hard per-chat cap, because a model refused a fifth question **proposes badly
instead** — which `docs/agent/chat.md:24` records as exactly what happened when
the tool allowlist refused questions it had not anticipated, producing "a bad
proposal an operator then approves believing it was researched".

**A fourth `chat_sessions.status` is refused on measurement, not taste.** Ten
sites on `src/app/chat/page.tsx` read that column with `===` and there is no
`Record<ChatStatus, …>` anywhere, so a new value type-checks clean and fails open
at all ten. The structural argument is stronger still: a chat can be `failed`
**and** hold an open question, and one enum cannot carry two facts.

## What is unverified

- **Everything about behaviour.** No container was started, no turn was run, no
  question was asked. Whether the model asks instead of guessing, and whether
  the required `then` field makes it read more rather than fill a box, are
  arguments, not observations — and the second is the assumption the whole
  design rests on.
- **What a chat turn costs on this install.** `DATA_DIR` is not openable from a
  work cycle, so `chat_turn_spend` could not be read. Fork 3's one-question-at-a-
  time rule is priced in turns, not in money, and at a dollar a turn its verdict
  should be reopened.
- **One reachable state will ship unexercised.** A question that outlives a
  timed-out turn cannot be produced by hand without lowering a hard-coded
  constant. The design handles it deliberately; nobody will have seen it.
- **The runner-up got a lighter reading than the recommendation.** A column on
  `chat_sessions` plus free-text-only questions is a coherent design at roughly a
  fifth of the code, and this survey treated it as second place rather than
  attacking it as hard as it attacked the winner.

## Not done

`proposals/README.md` has one row per proposal directory and has **not** been
given one for this survey — the run that wrote these files was bounded to this
directory. Adding it is the first thing a follow-up should do.
