# The problem, measured

**The question:** a turn in the orchestrator chat is not a chat message. It
spawns a child agent that may read a dozen files, run `git log` and call `gh`,
and it is allowed ten minutes (`CHAT_TIMEOUT_MS`, `src/lib/chat.ts:317`). The
panel polls. What does an operator know, and what can they do, during and after
those ten minutes?

Everything below carries a file and a line, or the command whose output it
quotes. Where something was measured in a browser the measurement says so; where
it was read from source, that is stated too. Nothing under `src/` was changed.

---

## How the evidence was taken

Two ways, and they are kept apart because they answer different questions.

**Read.** Every claim about what the code decides is read from the file named.

**Run.** A dev server was started against a throwaway `DATA_DIR`, its database
seeded with a thread carrying 26 pending proposals, 5 open questions, a
dependency edge and a template, and the page driven with Playwright. The exact
commands and their output are in [12-validation.md](12-validation.md). The
harness runs with `UF_AUTH_TOKEN` empty, so every screenshot carries the
"Authentication is off" banner; it is 49px tall (measured) and every geometry
figure below is quoted **with that strip discounted**, which is what an install
with a token set gets.

---

# During the turn

## D1. The panel renders three things, and refreshes every three seconds

While `chat.status === "thinking"` the page draws `Waiting`
(`src/app/chat/page.tsx:1381-1409`): a `Spinner`, the word `Thinking…`, and an
elapsed clock ticking once a second. That is the whole of it. Its own docblock
says so and defends it — "Nothing claims to know how far through the turn is,
because nothing does; the elapsed time is the only real progress there is, and a
bar would be an invention" (`:1373-1376`).

The refresh is `POLL_ACTIVE_MS = 3_000` (`page.tsx:55`), selected at `:415`
against `POLL_IDLE_MS = 10_000`.

Measured, on a row set `thinking` after boot: the status row read
`Thinking…13m 26s` and the composer hint read `Stop ends this turn and signals
the process answering it`. Nothing else on the page referred to the turn.

## D2. There is nothing incremental to show, and that is structural

The chat's child is spawned with `--output-format json`
(`src/lib/chat.ts:2016`). Its stdout is accumulated into a string
(`:2122-2126`) and parsed once, on exit (`:2153-2158`, into `parseTurnOutput`
`:2273`). There is no per-line output on the wire at all. A tool call, a file
read, a `gh` invocation — none of it reaches this process until the child is
dead.

**This is the one place the comparison with the run views is decisive.** A run
gets `--output-format stream-json --verbose` (`src/lib/cycleInvocation.ts:1023`),
a line parser (`handleStreamLine`, `src/lib/orchestrator.ts:6629`) that emits
`tool` (`:6767`), `tool_error` (`:6816`) and `subagent` (`:6716`) events, an
`emit()` that persists then publishes, and a Server-Sent-Events route that
replays history and then tails
(`src/app/api/runs/[id]/stream/route.ts:33-193`). The run page consumes it.

So the honest cost of a mid-turn activity feed here is **not** "add an SSE
route". Every piece exists: the flag, the parser, the event table, the stream
route, the client. What is missing is (a) the flag on the chat child, (b) a
place to put the events — `run_events` is keyed on `run_id` and a chat turn has
no run — and (c) whatever the parser does with a chat's shape. That is a real
piece of work and it is bounded by reuse rather than by invention.
[04-option-c](04-option-c-live-activity-feed.md) prices it.

## D3. The clock is measured from the last message, not from the turn

`waitingSince = lastMessage?.ts ?? chat?.updatedAt ?? Date.now()`
(`page.tsx:706`). The server knows better: `chat_sessions.turn_started_at` is
written in the same statement that claims the turn (`chat.ts:1617-1621`), and
its own docblock says why it is not `updated_at` — "the chat's own
`save_template` tool writes a system message mid-turn, which moves that column"
(`chat.ts:152-157`).

**`ChatDTO` does not carry `turn_started_at`.** Verified against the live
payload: the chat object's keys are
`id,createdAt,updatedAt,title,status,costUSD,tokens,error,messages,proposals,questions`
and nothing else (`src/app/api/chat/dto.ts:44-62`).

The consequence is narrow but real. Normally `lastMessage` *is* the message that
started the turn — `sendChatMessage` appends it and spawns in the same tick
(`chat.ts:1848`, `:1870`) — so the clock is right. It stops being right when a
mid-turn message lands, and one does: `save_template` appends a system note
while the turn is still running (`src/app/api/mcp/route.ts:1635`). At that
instant the displayed elapsed **resets to zero**, on the one surface whose whole
job is to say how long this has been going.

## D4. The ten-minute deadline is nowhere on the page

`CHAT_TIMEOUT_MS` is named in `chat.ts` and in `TIMED_OUT_REASON`
(`chat.ts:1649-1650`), which is the sentence written *after* the turn is killed.
Nothing renders it before. `grep -n "10 minutes\|ten minutes\|timeout"
src/app/chat/page.tsx` returns nothing.

At 9m50s the panel is identical to 20s. An operator deciding whether to wait or
press Stop is deciding without the one number that settles it.

## D5. Nothing shows what the turn in flight has cost

`chat.costUSD` moves only in `finishTurn` (`chat.ts:2340-2357`), after the child
has settled. The header reads `{fmtUSD(chat.costUSD)} this chat`
(`page.tsx:778-781`) — a figure that stands still for the whole ten minutes and
then jumps. `chatTurnBudgetUSD` defaults to `2` (`src/lib/settings.ts:883`) and
is passed to the child as its own ceiling (`chat.ts:2211`), so there *is* a
denominator; nothing shows the numerator.

## D6. One thing does move, and it is worth stating as the mitigation

Proposals and questions are **rows**, written by the MCP route while the turn
runs, and the three-second poll reads them. So a turn spending its ten minutes
writing proposals has a visible pulse: cards appear in the right panel one by
one, and the `N waiting` badge climbs. A turn spending its ten minutes reading
twelve files and running `git log` — which is exactly the turn
`systemPrompt()` asks for (`chat.ts:2495`, "look before you propose") — shows
nothing at all.

## D7. What the silent wait costs

Put together: an operator ten seconds into a turn and an operator nine minutes
into one see the same screen, differing by a number they have no scale for. The
only lever is Stop (`page.tsx:1114-1118`), which fails the turn out and throws
away whatever the child had done that was not already a row. The information
that would make that a decision — which tool it is on, how long it has been on
it, what it has spent, how close the deadline is — is either not collected (D2)
or collected and not sent (D3, D5).

---

# When it ends badly

There are four ways a turn stops without an answer. Three of them append a
system message to the thread; one does not; **and the one that does not is the
only one drawn in red.**

## F1. The four endings, and what each writes

| Ending | Where | Row | Thread |
|---|---|---|---|
| Timeout (in-process timer at exactly `CHAT_TIMEOUT_MS`) | `chat.ts:2130-2134` → `land` → `finishTurn` | `failed`, `error = TIMED_OUT_REASON` | system message (`:2391`) |
| Timeout (sweeper, for a turn whose `close` never comes) | `sweepStuckChats` `:1764` → `endTurn` `:1695` | same | system message (`:1706`) |
| Operator pressed Stop | `cancelChatTurn` `:1739` → `endTurn` | `failed`, `error = CANCELLED_REASON` | system message (`:1706`) |
| Child exited with unparseable output | `parseTurnOutput` `:2285-2292` → `finishTurn` | `failed`, `error` = last 3 stderr lines or `The chat produced no readable output (exit N)` | system message (`:2391`) |
| **Server restarted mid-turn** | `reconcileChatsOnBoot` `:2446-2453` | `failed`, `error = 'The server restarted while this message was being answered.'` | **nothing** |

The two timeout sentences are the same string, and the operator cannot tell the
in-process kill from the sweeper — which is correct, they mean the same thing.

`staleTurn` (`:1662`) is the sweeper's predicate: `turn_started_at` (falling
back to `updated_at`) plus `CHAT_TIMEOUT_MS + STALE_TURN_MARGIN_MS`, so a
swept turn is failed out at eleven minutes rather than ten.

## F2. The tone is inverted

`turnFailure` (`page.tsx:701-704`) renders `chat.error` in a red-edged box —
**but only when `chat.error !== lastMessage.text`**. Since three of the four
endings append the error as the last message, that box is normally suppressed by
construction, and its own comment says so ("This is the belt for the case where
only the row carries it").

What the operator actually sees for a timeout or a cancellation is a `system`
message, and `Message`'s system branch (`page.tsx:1307-1320`) draws it in
`text-ink-muted` with a `border-l-line-strong` edge — **the same treatment as
"The chat saved a new template, 'Retry audit', under your default guard set."**
A ten-minute timeout and a routine bookkeeping note are typographically
identical.

The restart case, which appends nothing, is the one that falls through to the
red box. Measured: seeding a `thinking` row and restarting the server produced
exactly this — the thread showed the grey `save_template` note and, below it, a
red-edged `The server restarted while this message was being answered.`
(screenshot `thinking-1440.png`).

## F3. The restart notice is not durable

`claimTurn` starts every turn with `SET status='thinking', error=NULL`
(`chat.ts:1618`). Because the restart case wrote nothing into the thread, the
operator's next message erases the only record that a turn was ever lost. The
other three endings leave a permanent row in `chat_messages`.

## F4. Nothing offers a next step, in any of the five cases

The operator's message is safe — `sendChatMessage` appends it before spawning
(`chat.ts:1848`), so it is in the thread as a right-aligned bubble whatever
happens to the child. Nothing *says* that, and there is no retry: the composer
is empty, and re-asking means retyping or selecting text out of the bubble.
`grep -n "again\|retry\|resend" src/app/chat/page.tsx` returns nothing on any
control.

The row is usable immediately — `claimTurn`'s predicate is `status<>'thinking'`
(`chat.ts:1619`), and its docblock names this: "a turn that failed leaves the
row `failed`, and the next message is how an operator retries it". The mechanism
is right; nothing on the page says it exists.

## F5. A turn that did not settle normally records no spend

`finishTurn` takes `costUSD` from `TurnResult`, and `parseTurnOutput` reads it
from the CLI's final JSON object (`chat.ts:2301`). A child that was signalled
never prints that object — `finishTurn`'s own comment says so
(`:2338-2339`), concluding "Nothing is lost by that". Nothing is lost *for the
latch*; the money is another matter. `endTurn` (`:1695-1702`) writes no cost at
all, and neither does `reconcileChatsOnBoot`.

So a turn cancelled at eight minutes, or timed out at ten, contributes **zero**
to `chat_sessions.cost_usd` and zero to `chat_turn_spend` — and the header's
"$0.83 this chat" understates the thread by up to `chatTurnBudgetUSD` per lost
turn. The dashboard's own meters are unaffected: they are read from the CLI's
transcripts, which record the tokens either way. The chat page's own readout is
the one that is wrong, and it is the one an operator uses to decide whether this
conversation is getting expensive.

## F6. What survives, and what it turns into

Proposals and questions written mid-turn are rows and survive intact. A question
asked by a turn that then died stays `pending`; `AskedQuestions` disables its
controls only while `busy || thinking` (`page.tsx:1465`), so the moment the row
goes `failed` the card becomes answerable again. Answering it starts a *fresh*
turn resumed against the same session (`answerChatQuestions` → `sendChatMessage`,
`chat.ts:1923-1927`).

That is the right behaviour and nothing says it. The card reads "Waiting on
you"; it does not read "the turn that asked this was stopped, and answering
starts a new one".

---

# The cards

## C1. Two thirds of the task text is unreadable, with no way to see the rest

The task is rendered `line-clamp-3` (`page.tsx:1683`). Measured on a real card:
the paragraph's `scrollHeight` is **162px** inside a `clientHeight` of **54px**
— a third of it. Its `title` attribute is `null`, so there is no hover fallback
either, and there is no expander, no detail view and no link on a pending card.

The folder beside it *is* given a `title` (`page.tsx:1691`) and the guard set is
deliberately made to wrap rather than truncate, with a comment explaining why —
"a press of Approve is approved against this guard set, so it is a fact a
decision is taken on — visible with no interaction" (`:1695-1702`). The same
argument applies to the task, which is the actual instruction the agent will be
given, and it is the one field on the card that is clipped.

The full text exists in exactly one place an operator can reach: the run, after
approval.

## C2. The guard set is legible exactly when the operator did not choose one

`guardsLabel` is `template.name` for a templated proposal, and the spelled-out
default set for an untemplated one (`src/app/api/chat/dto.ts:150-154`).

Measured from the live payload:

| | `guardsSource` | `guardsLabel` |
|---|---|---|
| untemplated | `defaults` | `acceptEdits · own checkout · 4 cycles · 60 min · $5.00` |
| templated | `template` | `Bug fix` |

The seeded template's actual guards are `acceptEdits`, own checkout, 12 cycles,
45 minutes, $4 — none of which is on the card. `docs/orchestrator-chat.md:24-26`
states the intent: "Every proposal card says which guard set it will run under,
spelling the untemplated one out in full — an approval gate that does not show
what is being approved is a gate that gets clicked through." The untemplated
case honours it. The templated case shows a name, and the numbers behind that
name live on `/settings`, in another tab, with no link from the card —
`templateId` is on the DTO (`dto.ts:146`) and the page never uses it.

This is defensible in one direction: the template is a thing the operator wrote
and can go and read. It is not defensible for the operator who wrote it three
weeks ago, or for the one about to approve twenty-six cards naming it.

## C3. A dependency names a label no card displays

`dependsOn[].label` is the chat's own `specId` (`dto.ts:163-167`), and the card
renders it verbatim: "Starts after `auth-fix` (only if it succeeds), on its
branch. Approve them together, or this one is not started." (`page.tsx:1753-1766`,
seen in `panel-26-bottom.png`).

**No card shows its own `specId`.** It is not on `ChatProposalDTO` at all. The
sentence tells the operator to do something — find and tick `auth-fix` — using
an identifier that appears nowhere else on the page. With 26 cards in a 318px
column, that instruction is unexecutable except by guessing from the titles.

## C4. There is no path between "approve this exactly" and "reject and retype"

`POST /api/chat/[id]/proposals` takes `action: "approve" | "reject"` and a list
of ids, and refuses anything else with a 400
(`src/app/api/chat/[id]/proposals/route.ts:55-61`). There is no field on the
wire for a changed task, a different folder or a different template.

So a proposal whose task is right and whose folder is wrong costs a rejection, a
typed correction, and another billed turn — minutes, and `chatTurnBudgetUSD` of
exposure, to change one string. The alternative available today is to approve it
and then fix the run, which is worse: the agent has already started.

This is the strongest single argument *against* changing it, and it is a real
one: the approval gate's whole claim is that the operator approved the card they
read. An editable card is a card whose text at approval differs from the text
the model wrote, and the audit story has to survive that.
[07-option-f](07-option-f-amend-before-approving.md) takes it seriously.

## C5. Twenty-five pending cards, measured

`MAX_PENDING_PROPOSALS = 25` (`chat.ts:310`). Seeded to 26 (25 issue proposals
plus the dependent one) and measured, banner discounted:

| Viewport | Visible list | Content | Cards on screen |
|---|---|---|---|
| 1280 × 800 | **217px** | 3791px | 1.2 of 26 |
| 1440 × 900 | **317px** | 3791px | 1.8 of 26 |
| 1920 × 1080 | **497px** | 3791px | 2.8 of 26 |

One row is 178.5px. The panel's inner scroller is 318px wide (the `360px` grid
column at `page.tsx:847` less padding).

The approve row sits outside the scroll region, deliberately — "a twentieth
proposal must not push the sentence off the top of the list it is about"
(`page.tsx:1232-1235`). Pressing `Select all` then reads:

> Approve starts 26 unattended runs that spend real money, under the guards
> shown on each.

and the button reads `Approve 26` (both captured). **"Shown on each" is true of
the two cards on screen.** The other twenty-four were shown at some point, or
were not; nothing distinguishes a list that was scrolled from one that was not.
This is the gap between the gate's design and its geometry: the reasoning at
`page.tsx:1232-1235` and at `chat.ts:301-309` is entirely about not letting an
approval be clicked through, and the column it is drawn in shows 7% of what is
being approved.

## C6. Select all selects what approval will refuse

`Select all` sets every pending id (`page.tsx:1250-1254`). A proposal whose
template was deleted, or whose agent is gone, carries a red sentence saying
approval will be refused (`page.tsx:1768-1786`) — and is ticked along with the
rest. The batch reports the failures afterwards through `decisionNote`
(`chat.ts:1432`), which is correct, but the operator has agreed to a count that
includes runs that were never going to start.

## C7. Questions are fast to answer and fragile to interrupt

`MAX_OPEN_QUESTIONS = 5` (`chat.ts:289`), `MAX_QUESTION_CHOICES = 8` (`:298`).

**Fast.** With one question open, a choice press sends immediately
(`page.tsx:1479-1484`) — one click, no confirmation. With more than one, choices
fill in and the row's `Answer 5` button sends them together, and the card says
so (`:1502-1507`). Enter in a text field submits (`:1579-1586`). The reasoning
for the split is at `:1433-1440` and is sound.

**Fragile.** The drafts are `useState` local to the card
(`page.tsx:1457`), keyed by the first question's id (`:891`). A poll landing
mid-sentence preserves them — that is what the key buys. Nothing else does: a
browser reload, switching to another thread in the Chats tab and back, or
closing the tab loses everything typed, with no warning.

And a partially-answered set is not recoverable through the door that refuses
it. `settleQuestions` (`chat.ts:661-693`) fails the **whole call** if any id has
stopped being open, and the reason it gives is:

> That question is no longer waiting for an answer — it was answered or the
> conversation moved past it. Reload the chat.

The refusal is right (`chat.ts:1893-1898` argues it: a dropped id is the
operator's answer silently missing from the text the model reads). The
*instruction* is wrong on this page: reloading the chat is precisely what
destroys the four answers that were fine.

---

# The ordinary things

## O1. Composer keys

Enter sends, Shift+Enter makes a line, ⌘↩ sends (`page.tsx:1083-1091`). The
mention list deliberately never takes Enter, with the reasoning at `:1034-1040`.
IME composition is handled in both branches. This is good, and better than most.

Two small things. `Ctrl+Enter` is not bound — the branch tests `e.metaKey` only
(`:1084`) — and the hint renders the `⌘` glyph on every platform (`:1112`,
`:1126`). Enter alone sends, so nothing is unreachable; a Linux or Windows
operator is shown a chord their keyboard does not have.

## O2. Scrolling is right

The thread moves on its own only for a reader already within `NEAR_BOTTOM_PX = 48`
of the bottom (`page.tsx:63`, `452-470`); everyone else gets a floating `N new`
button (`:928-939`). The waiting row and an arriving question follow the same
rule (`:474-485`). A long turn landing on a reader half-way up the thread does
not move them. Nothing to report here except that it works.

## O3. Chat history is reachable for thirty conversations and then is not

- `listChats(limit = 30)` (`chat.ts:358`), and `chatListDTO` calls it with no
  argument (`dto.ts:118`). No pagination, no search.
- The Chats tab only exists when `chats.length > 1` (`page.tsx:686`).
- **There is no URL for a conversation.** `find src/app -path "*chat*" -name
  "page.tsx"` returns one file: `src/app/chat/page.tsx`. Opening a thread is
  client state (`load(c.id)`, `page.tsx:1224`), so a thread cannot be
  bookmarked, linked from a run, or reopened after a reload.
- QuickOpen indexes panes, runs and workflows (`QuickOpen.tsx:204-236`) and not
  chats.
- **No delete.** `grep -rln "export const DELETE" src/app/api/chat/` returns
  nothing.
- Chats never expire, and every chat's `session_id` is held out of the
  transcript sweep for ever (`retention.ts:670-675`, and
  `docs/agent/retention.md:20` states the rule: "**every** chat thread — a chat
  has no terminal state to key on").

Taken together: the thirty-first conversation is unreachable from the UI, its
row is permanent, and its transcript is permanently protected from the sweep
that exists to bound disk. Nothing on the page tells the operator either fact.

## O4. Width

At `lg` and above the panel is a fixed `360px` column beside a `minmax(0,1fr)`
thread (`page.tsx:847`); the inner list scroller measures 318px. Below `lg` the
panel stacks under the conversation, both boxes bounded at `max-h-[34rem]`
(`:857`, `:1144`).

At 390 × 844 (measured, banner present): the conversation card's top is at
**y = 335** — 40% of the screen is header furniture (banner, data-directory
notice, `<h1>`, the standing `Notice`) before the thread starts — and the
composer's top is at y = 670, leaving roughly 174px of visible transcript. The
proposals panel is entirely below the fold, under a thread of unknown length.

## O5. The tabs appear and disappear

`Decided` exists only when something has been decided, `Chats` only when there
is more than one thread (`page.tsx:679-687`), and the whole strip collapses to a
plain title when there is one tab (`:1154-1169`). Nothing switches tabs on its
own (`:224-238`). This is deliberate and well argued; it is recorded here only
because it means the panel an operator learns on a fresh install is not the
panel they get later.

---

## What was not inspected

- **`src/lib/workflows.ts`'s `summarizeProposedGraph` and the whole workflow
  proposal path.** A `ProposedGraph` card (`page.tsx:1807-1879`) was read but
  never rendered — no workflow proposal was seeded — so every claim about the
  run card is measured and every claim about the workflow card would be read
  only. It is excluded rather than half-covered.
- **Everything after Approve.** The brief scopes it out and a companion survey
  owns it: `planApprovalBatch`, `approveRunBatch`, `decisionNote` and the
  dependency resolution are read only where they decide what the *card* must
  say.
- **`/api/mcp`'s tool surface** beyond the three descriptions quoted, and the
  capability token's life.
- **The `Decided` tab with real content** — it was never populated.
- **Any screen reader.** The `role="log" aria-live="polite" aria-relevant="additions"`
  region (`page.tsx:864-868`) and the `role="status"` on the waiting word
  (`:1402`) are read from markup and were not heard.
- **A real turn.** No `claude` process was spawned. Every claim about what a
  turn *does* is read from `chat.ts`; the states were reproduced by writing
  rows.
