# Option B — tell the truth about the turn in flight

**Answers:** D3 (the clock is measured from the wrong instant), D4 (the deadline
is nowhere), D5 (no spend). Does **not** answer D2 or D7 — an operator still has
no idea what the turn is doing, only how much longer it has to do it.

---

## What it is

Three facts the server already holds, sent and drawn. No new mechanism, no new
process, no change to the child.

**1. Clock from the turn, not from the thread.** Add `turnStartedAt: number | null`
to `ChatDTO` and map `chat.turn_started_at` in `chatDTO`
(`src/app/api/chat/dto.ts:44-62`). Change `waitingSince` (`page.tsx:706`) to
prefer it, keeping `lastMessage?.ts` as the fallback for a row written before the
column existed — which is exactly the fallback `staleTurn` already makes
(`chat.ts:1671`) and for the same reason.

This deletes the `save_template` reset (D3) outright, and it is the fix that
makes the other two possible: a deadline and a spend rate are both arithmetic on
the real start.

**2. Name the deadline.** `Waiting` (`page.tsx:1381`) gains a second clause once
the turn is past some threshold. The threshold is a design choice; the honest
default is to say it from the start, because the number is the operator's whole
basis for deciding whether to wait:

```
Thinking…  4m 12s          of up to 10 min
```

Past the deadline — reachable, because the sweeper runs every 30s and allows a
60s margin (`chat.ts:327`, `:330`) — the clause becomes "past the 10-minute
limit; being stopped". That is a true statement about a row `staleTurn` has
already marked, and it is the difference between a page that looks stuck and a
page that says what is happening.

`CHAT_TIMEOUT_MS` is already exported (`chat.ts:317`). A client component may
import a constant from `src/lib` — `docs/agent/conventions.md` bounds what a
`"use client"` file may import and a plain number is inside it — but if that is
contested the value can ride the DTO beside `turnStartedAt`, which is one more
field and settles the question.

**3. Show what the turn has spent.** This is the only one of the three that
needs anything new, and it needs it because of D2: with `--output-format json`
there is no incremental cost on the wire either. Two honest readings:

- **The cheap one:** show nothing during the turn, but make the *header* say
  what it is counting — "`$0.83` this chat, settled turns only". One string. It
  removes the false impression without pretending to a figure nobody has.
- **The real one:** requires [04-option-c](04-option-c-live-activity-feed.md)'s
  stream, whose `result` events carry `total_cost_usd`. Not available here.

This option takes the cheap one and hands the real one to C.

---

## What it costs

| | |
|---|---|
| Files | `src/app/api/chat/dto.ts`, `src/lib/apiTypes.ts`, `src/app/chat/page.tsx` |
| Lines | ~15 |
| New state | none |
| New requests | none |
| Test | `waitingSince`'s fallback chain is arithmetic on two nullable numbers and its failure is silent — it renders a plausible wrong duration. That is the bar `docs/agent/testing.md` records, and it is one pure function if the selection is extracted. |
| Risk | The DTO grows one field. `Waiting` gains a string. Nothing on the safety path is touched. |

## What it does not fix

An operator watching `Thinking… 4m 12s of up to 10 min` still cannot tell a turn
reading forty files from a turn wedged on a network call. The decision to wait or
stop is better informed — they know the wait is bounded and by how much — and it
is still a decision taken blind. D7 stands.

## The argument against it

`Waiting`'s docblock (`page.tsx:1367-1380`) rejects a progress bar because
"nothing claims to know how far through the turn is, because nothing does". A
deadline could be read as the bar by another name: at 9m30s a reader may
conclude the answer is nearly here, when the deadline says only that the turn is
nearly over — which is the opposite fact.

The counter is that a bar *invents* a completion fraction, and this reports a
constant the server enforces. The wording carries the difference: "of up to 10
min" is a ceiling, not a projection, and "past the 10-minute limit; being
stopped" is a statement about what the sweeper is doing rather than about the
answer. If the wording cannot be made to carry it, the deadline clause is the
part of this option to drop; parts 1 and 3 stand alone.

## Score

Answers three findings, one of which (D3) is a straightforward wrongness. Cheap,
low risk, and it is the prerequisite for the honest version of C's cost readout.
