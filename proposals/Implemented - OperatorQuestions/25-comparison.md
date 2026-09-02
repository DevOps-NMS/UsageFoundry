# Comparison

Eight forks, twenty-three options. They are not twenty-three alternatives — an
option in fork 2 is not a rival to an option in fork 6 — so this is not one
scored table. It is eight tables on shared axes, then the three decisions that
actually carried the weight, then where the survey is weakest.

## The axes

Every option was judged on the same eight. The first three do most of the work;
the last two broke two ties.

| # | Axis | The question it asks |
|---|---|---|
| A1 | **Honest panel** | Does the operator learn they are being waited on, without reading prose? This is [00](00-problem.md)'s defect and it outranks everything. |
| A2 | **The join** | Can the app say *this answer answered that question* — to the model, and on screen afterwards? [F4](00-problem.md#f4). |
| A3 | **Silent failure surface** | How many ways can this be wrong with nothing thrown, nothing failing `npm run typecheck`, and the page looking right? The bar `CLAUDE.md` is written to. |
| A4 | **Bounded asking** | Structural limit, or a sentence asking nicely? |
| A5 | **Cost per question to the operator** | Turns, money, wall clock, screen. [F7](00-problem.md#f7), [C3](01-constraints.md#c3), [C9](01-constraints.md#c9). |
| A6 | **Cost in code** | Files touched, new concepts a later reader must hold. |
| A7 | **Fits what is written down** | Does it need an exception added to `docs/agent/`, or does it land inside the existing reasoning? |
| A8 | **Reversibility** | If the chat gets *worse*, how much comes back out? |

`++` strong, `+` positive, `·` neutral or not applicable, `−` a cost, `−−` the
reason it was refused.

---

## Fork 1 — where the question lives

| | A1 | A2 | A3 | A6 | A7 | A8 | Verdict |
|---|---|---|---|---|---|---|---|
| **[1a] `chat_questions` table](02-option-1a-questions-table.md)** | ++ | ++ | + | −− | ++ | + | **Recommended** |
| [1b] [fourth message role / column](03-option-1b-message-role.md) | + | − | − | ++ | − | + | Refused, narrowly |
| [1c] [column on `chat_sessions`](04-option-1c-session-column.md) | ++ | −− | + | ++ | + | ++ | Refused on history |

The fork turned on one property and it is not the obvious one. It is **not**
"which is cheapest" — 1c wins that outright, at one `addColumn`. It is that a
question has *state that changes* (open → answered → superseded), and
`chat_messages` has no `UPDATE` anywhere in `src/`
([C5](01-constraints.md#c5)). 1b's stronger variant — role stays `assistant`,
add a nullable JSON column — is the single best objection to the recommendation
and it fails on exactly that one property. Say the design dropped the
answered/superseded distinction and made a question write-once, and 1b(ii) wins
and this survey's storage answer is wrong.

1c's virtue is worth carrying forward rather than discarding: it enforces
one-open-question-at-a-time *structurally and for free*, which the recommendation
then has to buy with a door check in the tool.

## Fork 2 — what a question may be

| | A1 | A2 | A4 | A5 | A6 | Verdict |
|---|---|---|---|---|---|---|
| [2a] [free text only](05-option-2a-free-text.md) | ++ | + | · | + | ++ | Retained as the floor |
| [2b] [single choice](06-option-2b-single-choice.md) | ++ | ++ | + | ++ | − | Recommended |
| [2c] [multi-select](07-option-2c-multi-select.md) | + | − | −− | · | − | **Refused by name** |
| [2d] [choice with an escape](08-option-2d-choice-with-other.md) | ++ | ++ | + | ++ | − | **Recommended — the shape** |

2a deserves more credit than its verdict suggests, and the file says so: **most
of this feature's value is the object, not the buttons.** A free-text question
still delivers A1 and most of A2. A reader who wants the smallest thing that
fixes [00](00-problem.md) should read 2a and 1c together — that pairing is the
runner-up design named in [26](26-recommendation.md).

2c is the one refusal in the survey that names a replacement rather than just a
cost: "which of these five should I do" is answered by **proposing them and
letting the approval gate be the multi-select**, and the approval gate carries
the guard set, the folder, the agent and the consequence sentence that a
multi-select question could not.

## Fork 3 — one question or several

| | A1 | A2 | A4 | A5 | A6 | Verdict |
|---|---|---|---|---|---|---|
| [3a] [one open at a time](09-option-3a-one-question.md) | ++ | ++ | ++ | − | + | Recommended |
| [3b] [several per turn](10-option-3b-several-per-turn.md) | + | − | −− | ++ | · | Refused |

**This is the fork where the recommendation pays a real price**, and A5 is where
it pays it: one-at-a-time means a model needing two facts spends two billed
turns, two poll waits and two of the operator's trips. 3b's efficiency case is
correct and is conceded in full.

It is refused anyway, on the asymmetry that decides it: a proposal is inert
until approved (`src/lib/db.ts:609-621`), so twenty-five of them cost nothing
until someone clicks. **A question is a claim on attention, and attention has no
approval gate.** The efficiency argument for batching is an argument for asking
*more*, which is the failure the brief asked to be prevented.

## Fork 4 — what the status becomes

| | A1 | A3 | A6 | A7 | A8 | Verdict |
|---|---|---|---|---|---|---|
| [4a] [stay `idle`, derive the flag](11-option-4a-idle.md) | ++ | ++ | + | ++ | ++ | Recommended |
| [4b] [a fourth status value](12-option-4b-awaiting-answer-status.md) | ++ | −− | · | − | − | Refused |

The widest gap in the survey, and it is entirely A3. **Ten sites on the page
read chat status and every one is an `===` against a literal, with no exhaustive
map anywhere** ([C4](01-constraints.md#c4)), so a fourth value type-checks clean
and fails open at all ten. `PROPOSAL_TONE` (`src/app/chat/page.tsx:118-123`,
indexed at `:1498`) is the contrast: a new *proposal* status is a compile error.

The structural argument is stronger than the site count and is the one to keep:
a chat can be `failed` **and** hold an open question — the tool call commits on
an earlier request, before the ten-minute kill discards the turn's output
([C1](01-constraints.md#c1)) — so one enum cannot carry both facts. That is not
a cost to be paid carefully; it is a modelling error.

## Fork 5 — the abandoned question

| | A1 | A2 | A3 | A7 | Verdict |
|---|---|---|---|---|---|
| [5a] [superseded at the next claim](13-option-5a-superseded.md) | ++ | + | + | ++ | Recommended |
| [5b] [operator dismisses it](14-option-5b-cancelled.md) | − | + | · | · | Refused as the mechanism |
| [5c] [left open for ever](15-option-5c-left-open.md) | −− | + | ++ | ++ | Refused on the stale signal |

5b and 5c fail the same way from opposite directions: both make an abandoned
question the **default outcome**, so `awaitingAnswer` goes permanently true on
the threads that need attention least, and the affordance built to say "this
thread needs you" becomes noise. A signal that is never cleared is not a signal.

5c has the survey's best argument against its own verdict and it should not be
skimmed: `src/lib/retention.ts:632-634` says a chat has **no terminal state to
key on** because "a thread is resumed by the operator typing into it, which they
may do at any time". The resolution is to separate *no clock* from *no event* —
the recommendation keeps the first (a horizon nobody set is refused by
[C6](01-constraints.md#c6)) and rejects the second, because supersede is caused
by the operator's own next action, which is precisely what that comment says
moves a chat.

## Fork 6 — where the answer enters

| | A2 | A3 | A6 | A7 | Verdict |
|---|---|---|---|---|---|
| [6a] [an ordinary user message](16-option-6a-ordinary-message.md) | −− | · | ++ | ++ | Refused |
| [6b] [a dedicated answer route](17-option-6b-answer-route.md) | ++ | + | − | + | Recommended |

6a is genuinely tempting — zero new server code, and it inherits every refusal
`sendChatMessage` already makes in the right order. It is refused on one
sentence: **with 6a, "answered" is not a state the app can observe.** The row
can only ever go `open → superseded`, which reads as "you ignored it" when the
operator did the opposite, and [F4](00-problem.md#f4) survives the whole build.

6b's decisive property is what it *doesn't* do: it delegates to
`sendChatMessage` rather than learning to start a turn, so it adds **no second
route to spending money** and leaves the no-`await` window at
`src/lib/chat.ts:1495-1497` untouched. Its one genuine hazard is the ordering —
latch, send, and roll back on refusal — which the sketch names as a requirement
rather than a detail.

## Fork 7 — where it surfaces

| | A1 | A2 | A6 | A7 | Verdict |
|---|---|---|---|---|---|
| [7a] [inline in the thread](18-option-7a-inline-in-thread.md) | + | ++ | − | + | Recommended |
| [7b] [a card in the side panel](19-option-7b-side-panel-card.md) | − | −− | + | −− | Refused, good half adopted |

`docs/agent/conventions.md:21` decides this: the transcript is the conversation
and the pane holds what the model *produced* for a person to act on. A question
is a turn, not an artefact — the side tabs are labelled "what to show beside the
conversation", and a question is not beside it.

7b's tab-rule objection is the one that closes it: `page.tsx:195-209` records
that nothing switches tabs on its own, so a question arriving while the operator
is on the Decided tab would be **invisible** — [F3](00-problem.md#f3) rebuilt
inside the fix for [F3](00-problem.md#f3).

Its good half is adopted: the *sidebar* does need a marker, and that is the
derived flag reaching `page.tsx:1553-1556`, not a panel card.

## Fork 8 — the behavioural half

Placement is not a fork with a winner; it is a split, and
[C10](01-constraints.md#c10) draws the line with a test that is already written
down — *is this sentence about a call, or about this conversation?*

| | Carries | Verdict |
|---|---|---|
| [8a] [`systemPrompt()`](20-option-8a-prompt-side.md) | when asking beats proposing; the budget; the three existing sentences that must change | Recommended for the *when* |
| [8b] [tool description](21-option-8b-tool-description-side.md) | that it does not block; one-open-at-a-time; what `then` means; the option cap | Recommended for the *mechanics* |

8b's limit is the clean argument for the split and is worth restating: **a
description cannot say "prefer proposing", because it has no place to stand.**
The model reads it only when considering that tool, which is exactly the moment
it has already decided to ask. A rule about choosing between two tools cannot
live inside one of them.

The three bounds are a menu, not a fork, and the recommendation takes all three:

| | A4 | Enforceable? | Verdict |
|---|---|---|---|
| [8c] [a question budget](22-option-8c-question-budget.md) | + | prose + the structural one-at-a-time cap | Both numeric forms refused |
| [8d] [only what reading cannot answer](23-option-8d-unanswerable-by-reading.md) | + | **no** — stated as such | Recommended, as prose |
| [8e] [`then` on every option](24-option-8e-branch-under-each-answer.md) | ++ | **yes**, at the schema | Recommended, required |

8c's refusals are each on their own ground, and the second is the interesting
one: a hard per-chat cap (the `MAX_PENDING_PROPOSALS` shape,
[C8](01-constraints.md#c8)) is refused because a model refused a fifth question
**proposes badly instead** — which `docs/agent/chat.md:24` records as exactly
what happened when the tool allowlist refused questions it had not anticipated.
`MAX_PENDING_PROPOSALS` differs in kind: its refusal tells the model to ask for
a filter, which is something it can act on, where "you have asked enough" leaves
it nowhere to go but a guess.

---

## The three decisions that carried the weight

**1. A question ends the turn.** Not a preference — [C1](01-constraints.md#c1)
forecloses everything else, and it does so twice: the ten-minute kill discards
the turn's output, *and* `sendChatMessage` refuses while a turn is in flight, so
a blocking tool call would hold a door shut against the only person who could
open it. Every option in the survey is downstream of this.

**2. The waiting state is derived, not stored.** Fork 4. It keeps a fourth value
out of a union that ten equality tests read blind, and it is the only shape that
can represent `failed` *and* `awaiting` at once.

**3. `then` is required.** Fork 8e. It is the only bound on asking with a
mechanism behind it, and it converts the unenforceable principle in 8d into
something a model discharges against its own knowledge at the moment of writing.
It also unlocks the survey's best behavioural rule — **propose under your best
guess and ask as well** — which removes the reason to interrogate rather than
capping the interrogation.

## Where this survey is weakest

**Nothing here was measured.** No container was started, no turn was run, no
question was asked or answered. Every claim about how the model will *behave* —
that it will ask instead of guessing, that `then` will make it read more, that
one question at a time is enough — is a claim about a language model's response
to prose, and this survey has no instrument for that. The claims about
mechanism are grounded in the tree; the claims about behaviour are arguments.

**The cost side of fork 3 is asserted, not priced.** "Two billed turns" is
right, but what a chat turn actually costs on this install is not readable from
here — `chat_turn_spend` is in `DATA_DIR`, which a work cycle cannot open. If a
turn costs $0.60 rather than $0.06, the argument for batching gets much stronger
and fork 3 should be reopened.

**One option pair is under-explored.** [1c](04-option-1c-session-column.md) plus
[2a](05-option-2a-free-text.md) is a coherent design at roughly a fifth of the
code, and it is treated here as the runner-up rather than given the same
adversarial reading the recommendation got. If the buttons turn out not to
matter, it is the better build, and nothing in this survey would have caught
that.
