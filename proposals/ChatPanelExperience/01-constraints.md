# What may not change

Every option in this directory is measured against these. They are not
preferences; each is a decision already taken and written down, and an option
that breaks one has to say so and argue for it by name.

---

## X1. A proposal carries a task, never a policy

No value off a proposal sets a budget, a permission mode, a work-cycle limit or
an isolation choice. Guards come from the named template or from
`settings.chatDefaultGuards`, and `planProposal` refuses a proposal naming a
deleted template rather than falling back
(`docs/agent/chat.md:9`, `src/lib/chat.ts:814`).

**What this rules out.** Any option that lets the operator adjust a guard on the
card, and any option that lets the *chat* fill one in. It does not rule out
showing what the guards are (C2), or letting the operator switch which
template applies — that is choosing between two things a person wrote, which is
what the run form already does.

## X2. The approval is per batch, over an explicit list, and there is no way to switch it off

The route takes the ids the page displayed, so nothing added between render and
click is swept in; approvals run in one synchronous pass because `createRun`'s
folder claim is only atomic inside an event-loop turn
(`src/app/api/chat/[id]/proposals/route.ts:22-47`). There is no setting that
approves automatically and `docs/orchestrator-chat.md:34-37` says there is not
one.

**What this rules out.** Auto-approve of any shape, including "approve
everything from this template". It does not rule out changing what the operator
sees before the click, which is the whole of [08-option-g](08-option-g-room-for-the-list.md).

## X3. One billed child per conversation

`claimTurn` is a conditional UPDATE whose `changes` count decides
(`chat.ts:1613-1623`), and `busy` on the page gates the composer, Approve,
Reject, Select all and every question control together
(`chatRequest`'s docblock, `src/lib/chatRequest.ts:10-13`).

**What this rules out.** Any "retry" that sends without going through
`sendChatMessage`, and any control that could start a second turn while one is
in flight. A retry that pre-fills the composer and leaves the send to the
operator is fine; one that posts is not.

## X4. Nothing on this path may be resumed unattended

A stranded turn is failed out, never re-asked: "a chat turn is a question
somebody asked minutes ago, and re-asking it unattended is spend nobody is
present to want" (`chat.ts:1760-1762`, `:2438-2439`).

**What this rules out.** Auto-retry after a timeout or a restart. It does not
rule out putting the operator's own words back in the composer, which is a
person pressing Send.

## X5. The conversation card may not change size while it polls

`PROPOSALS_EMPHASIS` (`page.tsx:199-222`) is the only card on the page allowed
to move, and the reason is explicit: `emphasis` carries padding as well as
elevation, so a conversation keyed on anything would re-pad the scrolled
transcript and shift the composer under the reader's hands. The out-of-flow
layout at `page.tsx:747-771` was measured in Chromium against this exact
nesting.

**What this rules out.** Anything that grows the thread card, and anything that
adds a variable-height block above the two-box row — the header furniture is
already what pushes the composer under the fold on a short window (`:826-846`).
An expander *inside* the proposal panel's own scroll region is fine; the panel
is the card that may change.

## X6. Nothing switches tabs, scrolls, or moves the reader on its own

A proposal arriving while somebody is reading another list must not move them
(`page.tsx:224-238`); the thread moves only for a reader already at the bottom
(`:443-451`).

**What this rules out.** Any "jump to the failing card" or "open the proposal
that just arrived" behaviour triggered by a poll.

## X7. A question is a row, not a status

A chat with an open question is `idle`, the composer is neither disabled nor
pre-filled, and sending an ordinary message supersedes every open question —
which is a real answer, drawn as neither a failure nor an acceptance
(`docs/agent/chat.md:39`, `:43`; `page.tsx:1425-1440`).

**What this rules out.** Blocking the composer to force an answer, and treating
a superseded question as an error.

## X8. Cost from a chat turn is shown apart and never summed with a run's

`chat_sessions.cost_usd` and `chat_turn_spend` are the chat's own; nothing adds
them to `runs.spent_usd` or to a dashboard meter
(`docs/orchestrator-chat.md:130-135`, `chat.ts:2360-2375`).

**What this rules out.** Fixing F5 by reading a chat turn's spend out of the
usage window. Whatever records a killed turn's cost has to be a figure the chat
owns, and it has to be marked as an estimate if it is one.

## X9. The kit's rules

Complete class strings per state, never interpolated (`page.tsx:128-131`); a
caller's class must not cancel a component's spacing; text controls below `md`
carry a 16px floor or iOS zooms and never zooms back (`page.tsx:1008-1012`,
`:1562-1567`) — the composer is the app's one hand-written exception and is
explicitly not a precedent for a second. `docs/agent/conventions.md` is the
whole list.

**What this rules out.** A hand-rolled expander, popover or input on this page
where a kit primitive exists. `Disclosure` is already imported here
(`page.tsx:29`).

## X10. No tooltip may carry something the operator needs

The card's own comment states it for the guard set: "a hover title is not a way
of reading it at all on touch" (`page.tsx:1698-1699`). The folder is given a
`title` precisely because it is context rather than a decision.

**What this rules out.** Answering C1 with a `title` on the task paragraph. The
task is what the agent will be told to do; if the folder does not deserve a
tooltip as its only rendering, the task certainly does not.

---

## Two things that are not constraints, and are easy to mistake for them

**The panel's 360px is a number, not a decision.** `page.tsx:847` fixes the
grid column and the comment above it argues for the *row* being bounded, not for
that width. The three-tabs-in-one-box arrangement (`:224-238`) is argued from
"three stacked cards each grew without limit", which is about the column being
unbounded rather than about it being narrow.

**`Waiting`'s refusal to draw a progress bar is not a refusal to say anything.**
Its docblock (`page.tsx:1367-1380`) rejects a bar because "nothing claims to
know how far through the turn is, because nothing does". A deadline is not a
progress estimate — it is a fact the server holds — and neither is a tool name
or a running cost. The comment forbids inventing progress, not reporting facts.
