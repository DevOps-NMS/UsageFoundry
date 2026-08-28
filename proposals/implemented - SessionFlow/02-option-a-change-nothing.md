# Option A — change nothing

The null. Scored honestly, because two of the questions the brief poses are
already answered on the run page and the burden is on any new surface to name
something that is not.

## The case for it

**The Log tab already shows every touch, in order, attributed.**
`src/lib/logLine.ts:318-608` renders each `kind: "tool"` row as a chip and a
line, `toolArgs` (`:90-101`) picks the field the call is actually about, and a
delegated call carries its sub-agent's name (`orchestrator.ts:7589-7591`). The
log gained a text filter and a kind picker — `matchesLogFilter`
(`logLine.ts:690`) takes the event's *kind* beside the rendered line, precisely
so "show me the tool calls" does not silently exclude the ones that failed
(`docs/agent/conventions.md:17`). An operator asking "did it touch
`src/lib/db.ts`?" types it into that box and gets every event naming it.

**The Changes tab already answers "what changed", definitively and from git.**
`runDiff` (`src/app/api/runs/[id]/diff/route.ts:22-31`) reports `base..branch`
with per-file numstat. It is the authority — a flow view derived from tool events
would be a *second*, weaker answer to a question already answered exactly, and
`docs/agent/conventions.md:16` records what happens when two readers of one fact
drift apart.

**The per-tool rollup exists** (`src/lib/toolComposition.ts`) and is on the
dashboard. "How many `Bash` calls did this cost" is not an open question.

**And the thing being proposed is a reader, so the null costs nothing to keep.**
The events are being written either way ([F1](00-problem.md#f1)); nothing decays
by not building this; no operator is currently blocked.

## What beats it

Three questions have no surface anywhere, and all three are set operations
rather than searches — which is why the Log's filter does not reach them. From
[F6](00-problem.md#f6):

1. **"Did this run change a file it never read?"** A `Write` or `Edit` with no
   preceding `Read` of the same path is an agent editing blind. Nothing
   aggregates this. Answering it today means reading the whole log by eye.
2. **"What did it read and then not use?"** The read-but-unchanged set is the
   context an operator is paying for and the run threw away. Reachable only by
   diffing two lists nothing prints.
3. **"Did it touch anything outside the checkout?"** A `Bash` that wrote to
   `/tmp`, a `gh` call, a `Read` of the operator's home directory. The events are
   there; `readCountsFor`'s `ELSE NULL` (`fileCostNotice.ts:343`) shows the app
   already knows how to detect the case and currently discards it.

The five-seconds-versus-two-minutes test the brief asks for is met by (1) and
(3), and only by them. Neither is a *flow*; both are a set difference.

## Where it fails

The null's real weakness is that it is not stable. `readCountsFor` already
extracts file paths out of `run_events` for a different purpose
(`fileCostNotice.ts:328-363`), so the capability is in the tree and unexposed. A
question an operator can nearly answer is the kind that gets answered badly by
whoever needs it next, in whichever component they happen to be editing.

## Verdict

**Not recommended, but it beats six of the eight things that could be built.**
It is the correct answer to "should there be a canvas" and the wrong answer to
"should the read-but-not-changed set be printable". It is the baseline every
option in [11-comparison.md](11-comparison.md) is scored against.
