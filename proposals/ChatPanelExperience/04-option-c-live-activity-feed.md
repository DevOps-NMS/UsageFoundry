# Option C — a live activity feed for the turn

**Answers:** D1, D2, D5 in full, D7 substantially. Also gives F5 its real fix as
a side effect. Does not touch the cards.

This is the expensive option, and the survey's job is to price it honestly
rather than to wave at it.

---

## What the app already has

Every piece of this exists for runs. The comparison is the whole argument.

| Piece | Runs | Chat |
|---|---|---|
| Output format | `--output-format stream-json --verbose` (`src/lib/cycleInvocation.ts:1023`) | `--output-format json` (`src/lib/chat.ts:2016`) |
| Line parser | `handleStreamLine` (`src/lib/orchestrator.ts:6629`) | none — stdout is concatenated (`chat.ts:2122-2126`) and parsed once on exit (`:2153`) |
| Event kinds | `tool` (`:6767`), `tool_error` (`:6816`), `subagent` (`:6716`), `sandbox` (`:6830`) | none |
| Persistence | `emit()` — persist then publish, into `run_events` | none |
| Transport | SSE with replay and live tail (`src/app/api/runs/[id]/stream/route.ts`) | 3s poll of the whole thread |
| Client | the run page | `Waiting` |

So this is not "build a live log". It is "point an existing pipeline at a second
kind of producer".

## What it costs, piece by piece

**1. Change the child's output format.** One argument in
`runOrchestratorChild` (`chat.ts:2013-2100`). Not free: `parseTurnOutput`
(`:2273`) reads a single JSON object and would have to read the terminal
`result` line instead. The shapes are the same fields —
`orchestrator.ts`'s `type === "result"` branch (`:6846`) reads the identical
`total_cost_usd` and `usage`. `review.ts` has a third copy of the same reader
(`:788`). **This is the one change with a real correctness surface**: every
failure mode of `parseTurnOutput` is a chat that reports the wrong cost or loses
its session id, and the existing unit tests around it are the reason it is safe
today.

**2. Somewhere to put the events.** `run_events` is keyed on `run_id`
(`db.ts`), and a chat turn has no run. Options: a `chat_events` table with the
same shape; or widen `run_events`, which drags in the `subscribe`/`emit` keying
and the retention sweep's assumptions and is worse. A new table is a migration —
idempotent statements in `migrate()`, which is the documented shape.

**3. Retention.** Whatever this writes has to expire. `docs/agent/retention.md`
records what expires on which horizon; chat rows currently expire **never**
(O3), so this adds the first unbounded per-turn write on the chat path. A turn
that reads forty files writes forty rows. This is where the option's cost stops
being one-off: it opens a question the chat path has not had to answer.

**4. Transport.** Two readings.
   - **Cheap:** put the last few events on the existing `ChatDTO` and let the
     3s poll carry them. No new route, no SSE, no reconnect handling. The
     latency is 3s, which for "what is it doing" is fine. The payload grows,
     and the route is already gzipped for exactly this reason (`route.ts:17`).
   - **Full:** a second SSE route. Everything the run stream's docblock argues
     — never gzip it, `id:` on every live frame or the reconnect replays the
     whole tail, a 15s heartbeat, the abort-already-fired case
     (`stream/route.ts:145-181`) — has to be got right again, and each of those
     is a bug somebody already paid for once.

**The cheap transport is the right one here** and it is what makes this option
affordable. A run's log is hours long and thousands of events; a chat turn is
ten minutes and tens of events. SSE exists for the first shape.

**5. The client.** `Waiting` becomes a list. The run page's activity rendering is
the model; the density has to suit a card inside a scrolled transcript, and X5
applies — the conversation card may not re-pad itself, so the feed must live in
a fixed-height box or below everything else in the thread.

## What it buys beyond the feed

- **D5 properly.** The stream's `result` line carries `total_cost_usd`, and
  intermediate `assistant` lines carry `usage`. A running cost becomes possible.
- **F5 properly.** A turn killed at eight minutes has, by then, emitted lines
  whose usage can be totalled. Not exact — the CLI's own `total_cost_usd` is
  authoritative and never arrives — but a marked estimate ("at least $1.10")
  beats a silent zero. X8 is satisfied: it is the chat's own figure.
- **A record of what the turn read**, which is what an operator wants when a
  proposal looks wrong: did it actually open the issue, or did it guess?

## The argument against it

Three, and the first is the strongest.

**It changes `parseTurnOutput`, which is the one function on this path whose
silent failure costs money.** Cost accounting, session-id adoption and the
error/success discrimination all run through it. `docs/agent/testing.md` records
why it has tests. Rewriting its input format is a real risk for a benefit that
is entirely about comfort.

**It is the only option here that adds a table and a retention obligation.**
Everything else in this directory is DTO fields and JSX.

**The five-line version is a trap.** "Just stream stdout to the page" without
the parser gives the operator raw JSON lines, and without persistence gives them
a feed that is empty after a reload — for a ten-minute turn, that is most of the
time somebody would look.

## What would make it first rather than third

An operator saying they have sat through a ten-minute turn not knowing whether
to cancel, more than once. That is the experience this option exists for and
nothing else in this directory substitutes for it —
[03-option-b](03-option-b-name-the-clock.md) makes the wait *bounded*, not
*legible*.

## Score

The highest ceiling of any option here and by some way the highest cost. Two to
four days including the retention question, against tens of lines for B, D and
E put together.
