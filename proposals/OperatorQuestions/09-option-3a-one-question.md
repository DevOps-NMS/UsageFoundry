# Option 3a — one open question at a time

Fork 3 asks how many questions one turn may leave behind, and this is the
narrow answer: at most one unanswered question per chat, enforced by the tool
rather than asked for in prose. [Option 3b](10-option-3b-several-per-turn.md) is
the other, and it has a real argument that this option has to pay for rather
than dismiss.

## The rule

`ask_operator` is refused at the door when the chat it is called on already has
an unanswered question. The refusal is not a silent no-op and not a truncation:
it is a sentence naming the question that is open, so the model can see what it
is waiting on and decide whether the second question is worth a later turn or
whether the first should have been written differently.

The mechanism has a precedent that is exact. [C8](01-constraints.md#c8) is
`MAX_PENDING_PROPOSALS = 25`, checked in the tool at `route.ts:1533-1536` and
`:1323-1326` with its refusal text built by `pendingLimitMessage`
(`route.ts:1357-1366`), and its docblock (`chat.ts:231-241`) states the
transferable half explicitly: the cap "refuses past this and says so, so the
model asks for a filter instead of silently proposing the first twenty-five."
The cost of a refusal is nil — a tool that refuses returns its message as tool
*output* rather than a protocol error, `text(message, /* isError */ true)`
(`route.ts:777-779`, `:764-769`, [C11](01-constraints.md#c11)) — which is to say
the model reads the sentence and gets another move.

The number here is one rather than twenty-five because the thing being bounded
is not a list the operator scrolls. It is the operator's attention.

## The interface can only be honest about one

The design's answer route latches one question row and delegates to
`sendChatMessage`. That is a join of one answer to one question, and it is the
whole fix for [F4](00-problem.md#f4) — today the operator's reply is
`appendMessage(chatId, "user", text)` into a table with no column that could say
"this answers that" (`db.ts:598-607`), so the model re-derives the join by
inference, which is the work the question existed to remove.

With three questions open, the operator answers the one they have an opinion
about and leaves two. There is no route that resolves the other two, because
there is nothing for the operator to say about them — and
[C6](01-constraints.md#c6) is unambiguous about what that leaves behind:
`retention.ts:632-634` keeps "every chat, whatever its status and however old",
so a question row is permanent and a question may not acquire a clock, because
expiring one would invent the terminal state that comment says a chat does not
have. Two abandoned rows per batch, forever, is not a tolerable steady state for
a mechanism whose entire job is to make waiting legible.

The screen argument is the same argument seen from the front. Three stacked
option rows in a thread is a form, and a form that arrives unasked in the middle
of a conversation is an interrogation. The proposals panel is a grouped box of
rows *because* proposals are a list ([F10](00-problem.md#f10),
`page.tsx:1013-1021`); a question is not a list, and rendering it as one imports
the wrong reading.

## It makes the bound structural rather than prose

This is the second argument and it is the one that decides the fork against a
prose alternative — "ask sparingly, and only when the answer would change what
you propose" in `systemPrompt()`.

[C9](01-constraints.md#c9) closes the obvious third option first. There is no
per-chat fraction of the budget and `docs/agent/chat.md:26` refuses to invent
one — "inventing one would be a threshold nobody set" — so a *money*-shaped or
setting-shaped budget on asking is out by the same rule that keeps
`assistRefusal() ?? installBudgetRefusal()` (`chat.ts:1492-1493`) as the only
gate. Whatever bounds asking is therefore structural or prose, and there is
nothing else on the menu.

Prose and structure are not interchangeable here. A prose instruction is advice
the model weighs against everything else in a 90-line system prompt
(`chat.ts:2090-2177`), three of whose sentences already push one-directionally
toward the guess ([F1](00-problem.md#f1)). A door check is a fact: the second
question does not exist, whatever the model concluded. Both halves should be
built — the prompt should still say when asking beats proposing, which is
[C10](01-constraints.md#c10)'s test for what is prompt-side — but the prompt is
the half that can be reasoned around and this is the half that cannot.

## The cost, stated squarely

A model that genuinely needs two facts pays for two rounds. Under
[C1](01-constraints.md#c1) the question ends the turn, so that is two billed
`claude -p` children for the questions and two more for the answers —
[F7](00-problem.md#f7)'s "asking twice is not twice free", since every one of
those four passes `assistRefusal()`, spends against `chatTurnBudgetUSD` and
writes its own `chat_turn_spend` row (`chat.ts:1975-1981`). Add up to two
ten-second waits before the operator even sees the question, because
`POLL_IDLE_MS = 10_000` and the page moves to the fast cadence only for
`thinking` (`page.tsx:361`, [C3](01-constraints.md#c3)). And the operator makes
two trips to the tab instead of one.

That is the price of this option and there is no version of it where the price
is zero. Two mitigations are real and neither is free:

- **A question may bundle facts into one prose question.** "Which repo, and how
  deep?" is one question whose 0..5 options cover the combinations — "web,
  lint-only", "web, full", "api, full". The bundling is bounded by what fits on
  five labelled buttons, so it works for two small facts and not for three
  large ones.
- **The required `then` field is the filter.** Every option must say what the
  model would propose if that option were picked. A second question whose
  answers all lead to the same `then` is a question that does not change the
  proposal, and writing the field is where the model finds that out. This is a
  design property being used as a behavioural bound, not a guarantee.

## What it does not forbid

It does not forbid proposing and asking in the same turn. Nothing here says a
turn must end with *only* a question — a turn may write two proposals it is
confident about and ask about the third, and the operator gets both cards and
the question card in one settle. That is the genuine escape from the round-trip
cost above, and it is fork 8's to decide, not this one's
([25-comparison.md](25-comparison.md)).

Nor does it forbid a second question *after* the first is answered. The bound is
on open questions, not on questions per thread. A model working through a
genuinely ambiguous brief can ask, be answered, and ask again; what it cannot do
is put three unanswerable-in-any-order cards on the screen at once.

## Verdict

**Recommended.** One question is the only count the answer route can join
honestly, the only count that cannot leave permanent abandoned rows under
[C6](01-constraints.md#c6), and the only count that does not put a form in a
conversation. The refusal-at-the-door mechanism is [C8](01-constraints.md#c8)'s,
already proven on this exact surface, and it is the structural half of a bound
that [C9](01-constraints.md#c9) says must be structural or prose. The two-turn
cost is real, is money as well as patience, and is accepted.
