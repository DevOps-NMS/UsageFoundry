# The orchestrator chat panel

**The question:** a turn here is not a chat message. It spawns a child agent
that may read a dozen files, run `git log` and call `gh`, and it is allowed ten
minutes (`CHAT_TIMEOUT_MS`, `src/lib/chat.ts:317`). The panel polls. What does
an operator know, and what can they do, during and after those ten minutes?

**The state:** open. Twenty findings across three passes, eight options, one
recommended as four commits, one refused with the sentence that reverses it, and
nine things refused by name. **Nothing here is a decision and no product code
changed.**

## The recommendation

**Ship the cheap tier — B, D, E and two pieces of G — as four commits**,
[11-recommendation.md](11-recommendation.md). About 100 lines across four files.
No migration, no new table, no new route, nothing on the approval or spawn path.
It closes twelve of the twenty findings in full and three more in part —
including four of the six places where the panel asserts something the code
contradicts.

**If only one change is made:** carry `turn_started_at` on the DTO and name the
ten-minute deadline in `Waiting` — about fifteen lines. It is the only cheap
change that touches the brief's central question, and it fixes a wrongness
rather than adding a feature: the elapsed clock is measured from the last thread
message (`page.tsx:706`) while the server holds the real start
(`chat.ts:1617-1621`), and a mid-turn `save_template` note
(`src/app/api/mcp/route.ts:1635`) resets the display to zero.

The reading that would pick something else is stated: if the priority is the
approval gate's correctness rather than the operator's wait, the single change
is spelling out a templated proposal's guards.

## The three headline findings

**1. Nothing incremental exists to show, and the run views are the proof of what
it would cost.** The chat's child runs `--output-format json`
(`chat.ts:2016`); its stdout is concatenated (`:2122-2126`) and parsed once on
exit (`:2153`). A run gets `stream-json` (`cycleInvocation.ts:1023`), a line
parser emitting `tool`/`tool_error`/`subagent` (`orchestrator.ts:6629`, `:6767`,
`:6816`, `:6716`), and an SSE route with replay and tail
(`api/runs/[id]/stream/route.ts`). So a mid-turn activity feed is not "add a
stream" — every piece exists — but it is a table, a migration, a retention
decision and a rewrite of `parseTurnOutput`, the one function on this path whose
silent failure costs money. Deferred, not refused.

**2. The one failure with no permanent record is the only one drawn in red.**
Four of the five endings append a system message; `reconcileChatsOnBoot`
(`chat.ts:2446-2453`) writes the row only, and `claimTurn` clears `error` on the
next message (`:1618`), so recovering erases the evidence. Meanwhile a
ten-minute timeout is drawn in the same grey as *"The chat saved a new
template"* (`page.tsx:1307-1320`). Reproduced in the browser.

**3. The approval gate's reasoning and its geometry disagree, measured.**
`MAX_PENDING_PROPOSALS`' own docblock says "an approval list nobody can read is
an approval gate that gets clicked through" (`chat.ts:301-309`). With 26 pending
at 1440×900 the list shows **1.8 cards of 26** — 317px of 3791px — and the
button reads `Approve 26` above the sentence *"under the guards shown on each"*.
On each card the task is clipped to a third of itself (162px of text in a 54px
box, no `title`, no expander), and a templated card's "guard set" is the
template's **name**: `Bug fix`, where the guards are
`acceptEdits · own checkout · 12 cycles · 45 min · $4.00`.

## Two corrections to the brief

**The panel is not silent during a turn.** Proposals and questions are rows, and
the three-second poll reads them — so a turn writing proposals has a visible
pulse and the `N waiting` badge climbs. What has no pulse at all is the turn
`systemPrompt()` actually asks for: reading before proposing. That makes the
finding narrower and sharper than "the panel shows nothing".

**The operator's message is never lost.** `sendChatMessage` appends it before
spawning (`chat.ts:1848`), and the row is usable the instant a turn fails
(`claimTurn`'s `status<>'thinking'`, `:1619`). Nothing on the page says either,
and there is no retry — the composer is empty and the operator retypes.

## What was measured, and what was not

A dev server was run against a throwaway `DATA_DIR` and a seeded database of 26
proposals, 5 questions and three threads; the page was driven with Playwright.
`npm run typecheck` exit 0, `npm test` 2085 passing.
[12-validation.md](12-validation.md) has the commands, the geometry table and
the three environment traps (`.env` sets `UF_AUTH_TOKEN`, so `/chat` answers 307
until it is overridden empty; `newPage({viewportSize})` is silently ignored —
the option is `viewport`; a server started in one Bash call is dead by the next).

**Not measured:** no real `claude` turn was ever spawned — every claim about
what a turn does is read from `chat.ts`. The workflow proposal card was never
rendered. Nothing was heard by a screen reader. And the `chat_proposals` table
on this install could not be read (both databases are outside this worktree's
sandbox), so the distribution of how many proposals actually pile up is unknown
— which is what most of Option G rests on.

## Refused by name

Editing a proposal before approving it (with the sentence that reverses it), a
`title` on the task paragraph, a progress bar in `Waiting`, auto-retry of a
stranded turn, widening the 360px column on its own, a second `page.tsx` for
`/chat/[id]`, a `kind` column on `chat_messages` as part of this work, reading a
killed turn's spend out of the usage window, and anything that switches tabs or
scrolls in response to a poll. Full list at the foot of
[11-recommendation.md](11-recommendation.md).

## The files

| | |
|---|---|
| [00-problem.md](00-problem.md) | twenty findings, three passes, each at `file:line` and marked read or measured |
| [01-constraints.md](01-constraints.md) | ten invariants an option may not break, and two things that look like invariants and are not |
| [02-option-a-change-nothing.md](02-option-a-change-nothing.md) | the baseline, and the six things it leaves the operator misled about |
| [03-option-b-name-the-clock.md](03-option-b-name-the-clock.md) | the turn's real start, the deadline, and what the cost figure counts |
| [04-option-c-live-activity-feed.md](04-option-c-live-activity-feed.md) | the expensive one, priced against the run pipeline it would reuse |
| [05-option-d-legible-endings.md](05-option-d-legible-endings.md) | five small changes to how a turn ends and what is left to do |
| [06-option-e-open-the-proposal.md](06-option-e-open-the-proposal.md) | the full task, the real guards, and the label a dependency names |
| [07-option-f-amend-before-approving.md](07-option-f-amend-before-approving.md) | **refused**, at length, with the reversing sentence |
| [08-option-g-room-for-the-list.md](08-option-g-room-for-the-list.md) | five candidates for twenty-six cards in a 317px window |
| [09-option-h-reach-the-history.md](09-option-h-reach-the-history.md) | no URL, thirty threads, no delete, and transcripts pinned for ever |
| [10-comparison.md](10-comparison.md) | the table, and where its weights could be wrong |
| [11-recommendation.md](11-recommendation.md) | the sequence, the one change, and what is refused |
| [12-validation.md](12-validation.md) | commands, output, gaps, and the three questions to ask |
| [score.mjs](score.mjs) | the arithmetic behind the table |

## Neighbours

[OperatorInterface](../OperatorInterface/) is the shape this survey follows.
[KnowledgeSection](../KnowledgeSection/) is the nearest precedent for the
argument used here about a combination beating any single option: the complaint
covers three passes, and **no option scores on more than one of them**.

Verification loop on the tree this was written against:
`npm run typecheck` exit 0, `npm test` 2085 passing, with **nothing under
`src/` changed by this survey**.
