# Validation

`npm test` in this repository covers a deliberately short list of pure functions
whose failure modes are silent and expensive; `CLAUDE.md` says the real
verification loop is `npm run typecheck` plus a `docker compose up --build` smoke
test, and that `docs/verification.md` — **including its "Not yet verified by
hand" list, which must stay honest** — records what was actually checked.

So this file is in three parts: what has to be true, the small part a test can
hold, and the click list a person runs. It ends with what cannot be checked here
at all.

---

## What has to be true

Nine statements. Each is observable, and each names the option file whose
argument it is testing. If one of these is false the feature is not working,
whatever the code does.

**V1 — The operator learns they are being waited on without reading prose.**
*Given* a chat where the last turn called `ask_operator`, *when* the operator
looks at the page, *then* the thread shows a question with its options, and the
sidebar entry for that thread says it is waiting — the same place `thinking` and
`N waiting` already appear (`src/app/chat/page.tsx:1553-1556`).
This is [F3](00-problem.md#f3) and it is the whole reason to build anything.

**V2 — One click starts exactly one turn, and the model acts on the choice.**
*Given* an open question with options, *when* the operator clicks one, *then* the
chat goes to `thinking`, exactly one child is spawned, and the reply that follows
demonstrably follows the chosen branch — the simplest check is that it matches
that option's own `then`.

**V3 — The pair is legible afterwards.** *Given* an answered question, *when* the
operator scrolls back six turns later, *then* the question and which option was
chosen are both on screen, in order, between the messages they happened between.
[F4](00-problem.md#f4).

**V4 — Ignoring a question is a legible outcome, not a disappearance.** *Given*
an open question, *when* the operator types something unrelated and sends it,
*then* the card stops being interactive, says the conversation moved on, and
**stays in the thread**. [Option 5a](13-option-5a-superseded.md).

**V5 — A second question in one turn is refused, by name.** *Given* a turn that
has already called `ask_operator`, *when* it calls it again, *then* it gets a
tool result naming the question already open, and only one card appears.
[Option 3a](09-option-3a-one-question.md).

**V6 — A stale answer is refused rather than sent.** *Given* a question answered
in one browser tab, *when* the operator clicks an option in a second tab still
showing the stale poll, *then* the second click is a 400 with a sentence and no
second turn starts. [Option 6b](17-option-6b-answer-route.md).

**V7 — An orchestrator block cannot ask.** *Given* a workflow whose orchestrator
block is instructed to ask a clarifying question, *when* the block runs, *then*
the tool is not on its list and calling it returns *"ask_operator is not
available to an orchestrator block. Use emit_runs."*
[F9](00-problem.md#f9).

**V8 — A question survives a restart with its buttons working.** *Given* an open
question, *when* the container is restarted, *then* the card is still there and
still answerable — `reconcileChatsOnBoot` fails out `thinking` rows and nothing
else (`src/lib/chat.ts:2052-2060`), and a question is not a turn.

**V9 — Nothing about guards moved.** *Given* any answered question, *when* a
proposal is then approved, *then* the run's guard set, permission mode, folder
claim and isolation are identical to what they would have been with no question
in the thread. [C7](01-constraints.md#c7). This is a *negative* check and it is
the one worth being pedantic about.

## What a unit test can hold

Three functions, and the bar is `CLAUDE.md`'s — a pure function whose failure
mode is silent. `docs/agent/testing.md` names what every existing test earned and
is the standard to write against; do not add a fourth out of habit.

**`renderAnswer`** — the user-message text the model is resumed with. Silent and
expensive in exactly `planApprovalBatch`'s way: a wrong render means the model
reads the wrong answer and proposes the wrong work with complete confidence.
Cases: option only; free text only; both; no option chosen; a question long
enough to truncate; a question containing the quote character the render wraps
it in; an option id not on the row (unreachable through the route, must still
not throw).

**`normalizeQuestionInput`** — the tool's door checks. Silent: an option array
that passes validation with a blank `label` renders a button with no text on it,
and nothing anywhere throws. Cases: missing `question`; `options` not an array;
six options; an option missing `then`; two options with identical `then`; and
the shape that must *succeed* — a question with `options` omitted entirely,
which is the free-text case and must not be confused with an empty array.

**The thread interleave** — questions merged with messages by `seq`. This is
client-side and its failure is visible rather than silent, which normally puts it
under the bar. It earns a test anyway because **the identical failure has
happened here before and is written down**: `src/lib/db.ts:905-916` records an
ordering that "rendered a footnote above the message it annotates and so
reversed what the operator was being told", which is precisely what a
mis-anchored question does to the reply that motivates it.

`chatPrompt` is already pure and already tested — its docblock at
`src/lib/chat.ts:632-633` says so and gives the reason ("both branches are billed
and the wrong one is invisible — a model that silently lost the thread still
answers confidently"). If the open-question replay is built, it extends that
test rather than starting a new one.

**What is deliberately not unit-tested:** the answer route's ordering, the
latch, the supersede statement and the DTO projection. All four are database
writes rather than pure functions; they are checked by the click list below.

## The click list

Run in this order. Every step past B1 costs real money — `npm run dev` on the
host reads the real `~/.claude` and spawns real, billed `claude` processes, and
each turn here is one.

### A — before anything runs

Both traps in `CLAUDE.md` apply and both make a green tree look broken:

```bash
NODE_ENV=development npm ci --include=dev     # a bare npm ci skips devDependencies
npm run typecheck                             # must be exit 0
npm test                                      # the three above, plus the existing suite
env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build
docker compose up --build
```

The `env -u` is not optional if this is run from inside an agent this app
spawned: an inherited `__NEXT_PRIVATE_STANDALONE_CONFIG` makes `next build` die
with `TypeError: generate is not a function`, which is not about this change.

### B — the mechanism

**B1 — nothing changed for a chat with no questions.** Open `/chat`, send an
unambiguous message ("list the folders you can see"). The thread, the composer,
the poll, the sidebar and the proposals panel must all behave exactly as before.
This is the step that catches an interleave that mis-orders an ordinary thread.

**B2 — V1.** Send something genuinely ambiguous against an install with two
mounts attached — "clean up the flaky tests" is the canonical one. Expect a
question card in the thread with two or more options, each with a line under it
saying what it would lead to. Check the sidebar row for the thread says it is
waiting. Note how long it took to appear: it should be within one idle poll,
ten seconds ([C3](01-constraints.md#c3)).

**B3 — V2.** Click an option. The chat goes to `thinking`; the answer appears in
the thread as your own message; the reply that follows is about the branch you
picked. Read the reply against that option's `then` — if they disagree, the
`then` field is decoration and [26](26-recommendation.md)'s spine is unsound.

**B4 — V3.** Scroll back. The question, the chosen option and the answer are in
order and read as one exchange.

**B5 — V4.** Ask another ambiguous thing. When the question appears, *ignore it*
— type something unrelated in the composer and send. The card must grey, stop
being clickable, and stay where it is.

**B6 — V5.** Send "ask me two things before you propose anything". Exactly one
card must appear. If the CLI's transcript is readable, confirm the second call
was refused with a sentence rather than silently dropped.

**B7 — V6.** Open the same chat in two tabs. Ask a question. Answer it in tab
one. In tab two — which is up to ten seconds stale — click an option. Expect an
error in the composer's hint area and **no second turn**. Confirm no second
child by watching the thread, not the process list.

**B8 — V8.** Ask a question, leave it open, `docker compose restart`, reload.
The card is there and the buttons work.

**B9 — V7.** Build a two-block workflow whose orchestrator block's prompt says
"ask the operator which repository to use". Run it. The block must not see the
tool, and if it calls it anyway must get the block refusal. This is the one step
that cannot be shortcut, because it is the failure with no operator on the other
end.

**B10 — V9.** Approve a proposal made in a thread that contained a question.
Open the run and check its guard set, permission mode, folder and isolation
against a run proposed in a question-free thread with the same template. They
must be identical.

### C — after the click list

Add every step above to `docs/verification.md`, and add anything not run to its
**"Not yet verified by hand"** list rather than leaving it unmentioned.

## What cannot be checked by hand here

Five things. Each is stated because a validation plan that omits its own blind
spots is worse than none.

**No container was started and no turn was run for this survey.** Everything
above is a plan. Nothing in this directory has been executed, and no claim in it
about behaviour has been observed.

**The tool surface cannot be driven directly.** The MCP capability is minted per
turn, written to a 0600 file in a directory the server owns, and revoked when the
child exits (`docs/agent/chat.md:22`). There is no way to `curl` `/api/mcp` by
hand with a valid credential, so every tool-level check (V5, V7) has to be driven
by *asking the model to do the thing*, which tests the description as much as the
handler. A handler bug that the model never triggers will not be found this way.

**A question outliving a failed turn is not reachable without a code edit.**
[C1](01-constraints.md#c1)'s kill fires at a hard-coded `CHAT_TIMEOUT_MS`
(`src/lib/chat.ts:247-248`) with no setting behind it, so producing "the tool
call committed and then the turn was killed" means temporarily lowering the
constant. The design deliberately handles this state — `awaitingAnswer` is not
`&& status === "idle"` — and that branch will ship unexercised unless someone
does the edit. **This belongs on the "Not yet verified by hand" list by name.**

**The thread-replay path needs a manual database edit.** The open-question replay
only runs when `chat_sessions.session_id` is null, which does not happen on
demand; reaching it means `UPDATE chat_sessions SET session_id = NULL` against
the dev database. Worth doing once, and worth recording that it was done that
way.

**Whether the chat gets better cannot be checked at all in a session.** Whether
the model asks instead of guessing, whether `then` makes it read more, whether
one question at a time is enough — these are claims about a language model's
response to prose over weeks of real use. This survey has no instrument for any
of them.

## The measurements that settle the arguments later

Three queries against `DATA_DIR`'s database, none of which could be run from
here (`/data` is not openable from a work cycle). They are the falsifiers named
in [26-recommendation.md](26-recommendation.md), written out so nobody has to
re-derive them.

**Do the buttons earn their place?** If most answers are free text, options are
dead weight and the second-best design was the right build:

```sql
SELECT answer_option IS NULL AS typed, COUNT(*)
  FROM chat_questions WHERE status = 'answered' GROUP BY 1;
```

**Is the chat interrogating?** The kill criterion is roughly one question per
five turns; `chat_turn_spend` holds one row per settled turn
(`src/lib/chat.ts:1975-1981`):

```sql
SELECT (SELECT COUNT(*) FROM chat_questions) * 1.0
     / (SELECT COUNT(*) FROM chat_turn_spend) AS questions_per_turn;
```

**Are questions being abandoned?** A high superseded share means the model is
asking things the operator does not think are worth answering:

```sql
SELECT status, COUNT(*) FROM chat_questions GROUP BY status;
```

And one that is not a query: **read ten `then` lines.** If they are uniformly
"propose a run for it", the field is buying card height and nothing else, and it
should be deleted rather than described more strictly.
