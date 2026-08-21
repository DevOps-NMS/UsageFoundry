# One long conversation against k fresh ones

**The headline first, because it is the result this proposal most needed and it
is the unwelcome one: starting fresh is dearer.** On the measurement below, a
resumed work cycle adds **197, 200 and 199 bytes** to what has to be written,
against **8,402, 3,204 and 3,332** for a fresh conversation that re-reads
*nothing* — and a fresh conversation that re-reads the files it lost costs
**2.59× the whole resumed arrangement**. A fresh cycle breaks even with a
resumed one only while it re-reads under about **3.9 KB**, which is 2.5% of what
the opening cycle read. `01-constraints.md` predicted this was possible; it is
what the wire says.

**And the second thing first, because it bounds the first: this was not priced
in dollars and answer quality was not measured at all.** The experiment as
specified needed a live model and this run could not reach one. What follows
says exactly what was measured instead, what that licenses, and what it does
not.

## What stopped the priced experiment

This agent's own sandbox masks the credential file with `/dev/null`:

    $ ls -la /home/node/.claude/.credentials.json
    crw-rw-rw- 1 nobody nogroup 1, 3 Aug 19 21:22 /home/node/.claude/.credentials.json

    $ claude auth status
    {"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}

so a spawned `claude` cannot authenticate:

    $ claude -p '…' --output-format stream-json --verbose
    … "text": "Not logged in · Please run /login" … "error": "authentication_failed"
    … "total_cost_usd": 0, "usage": {"input_tokens": 0, …}

The network is fine — `api.anthropic.com/v1/models` answers `401` and
`api.github.com` answers `200` — and there is no other credential in this
container's environment (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_AUTH_TOKEN` are all zero-length). Going around the mask is not
something to try; it is a control this agent is running under, not a bug.

So there are no `usage` blocks to price with `scanUsage()`/`pricing.ts`, no
input/output/cacheRead/cacheWrite5m/cacheWrite1h split, and no model to judge
five answers. Those parts of this file are absent rather than estimated.

**Child spend: $0.00**, and measured rather than assumed. Across every `claude`
child this run spawned:

    $ python3 …   # every result event under /tmp/uf-721638d11c0b-1
    result events: against the real endpoint and refused (Not logged in): 1
                 | against the recorder, cost fabricated by the recorder: 57
                 | zero-cost: 0

    $ python3 …   # every URL any child requested
      125 x /v1/messages            (127.0.0.1, the recorder)
       22 x /v1/messages/count_tokens (127.0.0.1, the recorder)

One request left this container for Anthropic and was refused before a token was
counted. Every `total_cost_usd` any child printed is the CLI's arithmetic over
numbers the recorder invented and is not money.

## What was measured instead

The same two arrangements, run with the same real binary, the same flags, the
same real files on disk and the same real session lifecycle — with the model
replaced by a local recorder that logs each request body verbatim and answers
from a script (`02-levers-on-the-pin.md` describes it). That prices nothing, and
it measures the one thing the prefix-cache constraint actually turns on: **what
each arrangement puts on the wire, and how much of it the previous request
already established.**

The accounting is byte-exact. Each request is flattened into ordered units —
the tool definitions, then each system block, then each message content block —
and compared to the previous conversation request. The longest run of
byte-identical leading units is the prefix that stays matched; everything from
the first divergence on is new. That is `P` and `S − D` from
`01-constraints.md:22`–`28`, in bytes.

Two things are excluded and both matter. `/v1/messages/count_tokens` calls, which
the CLI makes over every large tool result, are not billed as inference and are
counted separately (123,401 bytes per run here). The one-per-conversation
session-title turn *is* billed and is counted, because arrangement 2 pays four
of them and arrangement 1 pays one.

## The task

Five questions over five files, chosen so the answers are checkable against the
tree and the reads are heavy. The files were copied into a scratch checkout —
`/tmp/uf-721638d11c0b-1/scratch/src/lib/` — so nothing ran against a mount:

    $ wc -c /tmp/uf-721638d11c0b-1/scratch/src/lib/*.ts
     41537 budget.ts
      7602 pricing.ts
     32820 retention.ts
     23682 transcripts.ts
     49038 windows.ts
    154679 total

    Answer these five questions about the files under src/lib, one per work cycle,
    quoting the line you read it from.
    Q1 windows.ts: what does weekStart(now, null) return when no anchor is set?
    Q2 pricing.ts: what does resolvePrice return for a model the table cannot place?
    Q3 budget.ts: which two fields must both be nullable together?
    Q4 retention.ts: what does the sweep clear on the runs it belonged to when a
       transcript file goes?
    Q5 transcripts.ts: which record type does scanUsage read a usage block from?

The answers are `weekStart(now, null)` returning the rolling seven-day window
(`src/lib/windows.ts:276`–`277`), `resolvePrice` returning `null`
(`src/lib/pricing.ts:115`–`133`), `maxIterations` nullable only alongside
`maxDurationMinutes` (`src/lib/budget.ts:87`–`91`), `runs.session_id`
(`src/lib/retention.ts:663`–`667`), and an `assistant` record
(`src/lib/transcripts.ts:226`). k = 4 cycles: cycle 1 reads all five files and
answers Q1, cycles 2–4 answer the rest.

## Arrangement 1 — one long conversation

Four cycles, spawned the way `buildArgs` spawns one, `--resume` on every cycle
after the first, and `settings.continuationPrompt`'s shipped default as the
continuation turn:

    claude -p "$PROMPT" --output-format stream-json --verbose \
      --model claude-haiku-4-5-20251001 --permission-mode bypassPermissions \
      --allowedTools Read Grep Glob --disallowedTools KillShell \
      --append-system-prompt "…" [--resume "$S"]

    $ node -e '… DEFAULT_CONTINUATION_PROMPT …'
    "Continue working on the task. If it is fully complete and verified, reply with
     exactly DONE on its own line and make no further changes." 136 bytes

Three deviations from a real work cycle's argv, all of them the same on both
arrangements and therefore cancelling in the comparison: the model is
`claude-haiku-4-5-20251001` rather than the run's, `--append-system-prompt`
carries a one-line stand-in rather than `SELF_HOSTING_NOTICE`'s 1,096 bytes, and
the tool lists are `Read Grep Glob` / `KillShell` rather than `SEARCH_TOOLS` /
`PROCESS_KILLERS`. Each shifts the fixed prefix by under 2 KB, and the fixed
prefix is matched in both arrangements from cycle 2 on.

## Arrangement 2 — k fresh conversations

No `--resume`. Each cycle opens a new conversation with a brief assembled the way
an implementation would build one: the task, plus the previous cycle's final text
appended to a handoff file kept on disk, plus the same continuation prompt.

    prev=$(final $((CY-1)))
    printf '%s\n' "$prev" >> HANDOFF.md
    BRIEF="$TASK

    Prior work on this task, from the cycle before this one:
    $(cat HANDOFF.md)

    $CONT"

Because how much a fresh agent re-reads is exactly the quantity a live model
would decide, arrangement 2 was run twice, to bracket it rather than to guess it:

- **2a, re-reads nothing.** Every cycle after the first works from the brief
  alone. This is the floor — no "start fresh" mechanism can do better.
- **2b, re-reads all five files.** Every cycle re-reads everything cycle 1 read.
  This is the ceiling.

The truth for any real task lies between them, and the break-even below says
where.

## What each arrangement sent

    $ python3 mock/measure.py arr1-resume arr2-fresh-none arr2-fresh-all

    === arr1-resume ===
      13 requests: 9 conversation turns, 1 session-title turns, 3 count_tokens (unbilled)
      billed bytes on the wire        :    2,452,423
        matched a cached prefix       :    2,119,544
        new, so written               :      332,879
      session-title turns cost        :        2,049 bytes
      count_tokens bytes (unbilled)   :      123,401

    === arr2-fresh-none ===
      16 requests: 9 conversation turns, 4 session-title turns, 3 count_tokens (unbilled)
      billed bytes on the wire        :    1,921,245
        matched a cached prefix       :    1,573,820
        new, so written               :      347,425
      session-title turns cost        :        9,164 bytes
      count_tokens bytes (unbilled)   :      123,401

    === arr2-fresh-all ===
      40 requests: 24 conversation turns, 4 session-title turns, 12 count_tokens (unbilled)
      billed bytes on the wire        :    5,853,112
        matched a cached prefix       :    4,965,741
        new, so written               :      887,371
      session-title turns cost        :        9,164 bytes
      count_tokens bytes (unbilled)   :      493,604

Per cycle, which is where the shape shows:

    === arr1-resume ===
      cycle | billed turns | new bytes | matched bytes | count_tokens calls
        1    |       7      |   332,283 |     1,128,248 | 3
        2    |       1      |       197 |       330,234 | 0
        3    |       1      |       200 |       330,431 | 0
        4    |       1      |       199 |       330,631 | 0

    === arr2-fresh-none ===
        1    |       7      |   332,487 |     1,129,268 | 3
        2    |       2      |     8,402 |       144,632 | 0
        3    |       2      |     3,204 |       149,960 | 0
        4    |       2      |     3,332 |       149,960 | 0

    === arr2-fresh-all ===
        1    |       7      |   332,436 |     1,129,013 | 3
        2    |       7      |   188,401 |     1,275,034 | 3
        3    |       7      |   183,203 |     1,280,687 | 3
        4    |       7      |   183,331 |     1,281,007 | 3

Cycle 1 is the control and it holds: 332,283 / 332,487 / 332,436 new bytes for
the same work in all three.

**A resumed continuation cycle writes two hundred bytes.** That is the whole
`--resume` claim, measured: with the prefix unchanged, the conversation stays
matched and the only new content is the continuation prompt and the answer. It
is the same result `02-levers-on-the-pin.md` gets from the other direction —
`system identical: True`, `tools identical: True`, `first user message
identical: True` — and it is what the 27% of real handovers that hit the cache
look like.

**A fresh cycle writes less than one might fear and matches far less than it
needs.** Its 3,204 new bytes are cheap; its 149,960 matched bytes are less than
half the 330,431 a resumed cycle matches, because there is no conversation to
match. It has not saved that difference — it has *lost* it, and whether losing it
is free depends entirely on whether the model then goes and re-reads.

## Putting the rates on it

`pricing.ts` bills a cache read at 0.1× the model's input rate and a one-hour
cache write at 2.0× (`src/lib/pricing.ts:16`–`18`), and `00-problem.md` measures
26,194 turns on this install in which every main-thread turn wrote 1h and none
wrote 5m. Weighting the bytes above by those two multipliers — **a first-order
estimate in byte-equivalents, not dollars, and its assumption is stated below**:

| arrangement | matched × 0.1 | new × 2.0 | weighted total | vs arrangement 1 |
|---|---|---|---|---|
| 1 — one conversation, 4 cycles | 211,954 | 665,758 | **877,712** | — |
| 2a — 4 fresh, re-reads nothing | 157,382 | 694,850 | **852,232** | 2.9% cheaper |
| 2b — 4 fresh, re-reads all five | 496,574 | 1,774,742 | **2,271,316** | **2.59× dearer** |

And per continuation cycle, in steady state (cycles 3 and 4):

| | weighted per cycle |
|---|---|
| resumed | 33,443 / 33,461 |
| fresh, re-reads nothing | 21,404 / 21,660 |
| fresh, re-reads all five | 494,475 / 494,763 |

**The break-even.** A fresh cycle starts 11,920 weighted bytes ahead of a resumed
one. Re-reading all five files — 154,679 bytes of file text — costs a further
473,087 weighted bytes per cycle, so re-reading costs about 3.06 weighted bytes
per byte of file. The lead is spent at:

    11,920 / 3.06 ≈ 3,900 bytes of file re-read per cycle

**A fresh conversation is cheaper than a resumed one only while each cycle
re-reads under about 3.9 KB — 2.5% of what its own first cycle read.** Above
that it is dearer, and the curve is steep: at one file it is already losing, at
five it is losing by 2.59×.

That bar is worth holding against what this repository already believes about
fresh agents. `continuedWorkNotice` exists because a fresh agent "either redoes
the work or reverts it as leftovers. Both are billed and both look like
progress" (`src/lib/settings.ts:544`–`551`), and `priorWorkNotice` because that
agent "does the first thing that task says, which is the work it is standing on
top of" (`src/lib/orchestrator.ts:4364`–`4373`). Neither of those behaviours fits
under 3.9 KB.

Two structural costs arrangement 2 pays that are visible in the table and easy to
miss. It spends a **session-title turn per conversation** — four against one,
2,049 → 9,164 bytes — because the CLI names every new session. And the brief
**grows monotonically**: cycle 2's 8,402 new bytes against cycle 3's 3,204 is the
handoff file being appended to, and on a longer run that is a second
conversation accumulating beside the one that was discarded.

## What this does not say

Four limits, in the order they would bite.

**It is bytes, not tokens.** Applying 0.1 and 2.0 to bytes assumes a constant
bytes-per-token ratio across content that is mostly TypeScript in the tool
results and mostly English in the prompts. `00-problem.md` already warns that its
own four-bytes-per-token estimate is low for text that lands in a conversation.
The 2.59× is robust to a wide error in that ratio; the 2.9% and the 3.9 KB are
not, and should be read as "arrangement 2's advantage before re-reading is small"
rather than as figures.

**The turn counts were scripted, not chosen.** Seven turns in cycle 1, one or two
after — those came from the recorder's plan, not from a model deciding when it
had enough. A live arrangement 2 would very likely take *more* turns per cycle
than arrangement 1, because it starts each one without the answer to the previous
question, and every extra turn re-sends the whole conversation. That error runs
against arrangement 2, so the direction of the headline is safe and its
magnitude is a floor.

**Answer quality was not measured, and that is the part a cheaper arrangement has
to earn.** No model answered any of the five questions; the recorder returned
fixed strings. So this file cannot say whether arrangement 2 got Q3 right, and it
must not be read as saying arrangement 2 answers as well for less. What it can
say is that on this task the cheaper-looking arrangement is only cheaper in the
one variant where it looks at nothing, and that variant cannot answer Q2 through
Q5 at all — the files are not in its context.

**One cycle, one repository, one clean tree.** The prefix held byte-identical
across arrangement 1's cycles because nothing committed in between. On a real run
it would not (`02-levers-on-the-pin.md`), and a re-writing handover turns the
resumed cycle's 197 new bytes into the whole suffix. **That is the case in which
arrangement 2 wins**, and the measurement above deliberately does not include it,
because whether it happens is decided by `gitStatus` rather than by this app.
The survey has to price both, and this file supplies only the clean one.

## How to run it for real

The harness that produced the numbers above lived under `/tmp` and is gone with
the run, deliberately — this proposal adds no files to the tree beyond its own.
It is four steps, and everything needed to rebuild it is quoted above:

1. Copy the five files into a scratch checkout outside any mount, and set
   `CLAUDE_CONFIG_DIR` to a fresh directory so the children neither read the
   operator's settings nor write into the shared bind mount.
2. Arrangement 1: four invocations of the argv quoted above, `--session-id` on
   the first and `--resume` with that id on the rest, the task as cycle 1's
   prompt and `DEFAULT_CONTINUATION_PROMPT` as the other three.
3. Arrangement 2: four invocations with no `--resume`, each prompted with the
   brief-building snippet quoted above — task, handoff file, continuation
   prompt — appending each cycle's `result` text to the handoff file. Run it
   once as specified; the `-none`/`-all` bracket was only needed because no
   model was choosing.
4. Drop `ANTHROPIC_BASE_URL` and the dummy key. The plan files disappear with
   the recorder, because the model decides the turns.

Pricing is then this app's own, over the transcripts the children write into the
per-run `CLAUDE_CONFIG_DIR`:

    scanUsage() → entries filtered to the probe project → addTokens → resolvePrice
      → input, output, cacheRead, cacheWrite5m, cacheWrite1h

Answer quality is checkable by hand against the five line references above. On
`claude-opus-5` rates and the byte volumes measured here, the three runs together
would be single-digit dollars, well inside the ~$10 this run was given and never
spent.
