# Option G — the recurrence readout

No model, no write, no clock that spends. The app counts what went wrong more
than once and shows it. A card on the dashboard, or a page: *these 77 failures
have happened on more than one day; here is each one, how many times, on which
days, and in which sessions.* Nobody writes a sentence about why. The operator
reads the list and decides whether any of it is a learning.

| | |
|---|---|
| **fires** | a page load, and a cache with the shape `transcriptCacheStats()` already has |
| **reads** | `tool_result` blocks with `is_error` — 0.90 MB across 24 days |
| **writes** | nothing, anywhere |
| **authors** | nobody; every string is quoted from the machine that produced it |
| **retracts** | not applicable — a count is not a claim |
| **costs** | **$0.00** |

---

## The strongest case

**It is the transcription half of Option C with the diagnosis half deleted, and
the diagnosis half is the part the evidence says not to build.**

`3 Resources/Questions/Can an Agent Write an Accurate Record of Its Own
Failure.md:31` draws the line this option is built on: a record "mixes two
things the reflection literature never separates: **transcription** of what
happened (the command that failed, the exit code, the observed output) and
**diagnosis** of why. The first is a logging problem with no obvious reason to
be unreliable. The second is intrinsic self-correction wearing different
clothes, and nobody has measured it." Option G ships the first and refuses the
second. It is the only option in this directory that can be wrong only in the
way a `SELECT COUNT(*)` can be wrong.

**It is free, and free is not a rounding error here.** Every other option costs
between $0.06 and $78.31 a night, for ever, against an unmeasured benefit
(`01-constraints.md` C8). This costs one parse of a corpus the app already
walks on every `/api/usage`.

**The material is real, and this survey measured it rather than asserting it.**
Over 24 days: 2,548 error blocks, 1,175 distinct normalised signatures, **77
spanning two or more days and carrying 1,260 of the 2,547 dated instances —
49.5%.** One signature spans 12 of the 23 days with errors on them. Six of the
top eight are ordinary, fixable, and would each take a person about a minute:

```
  8 days  pdftoppm is not installed. Install poppler-utils…
  8 days  error: .bash_profile: can only add regular files, symbolic links…
  8 days  bwrap: Can't create file at /PATH/settings.local.json: Permission denied
  8 days  bwrap: Can't create file at /PATH/settings.json: Permission denied
  7 days  File content (N tokens) exceeds maximum allowed tokens (N)…
  7 days  This command requires approval
```

**Nothing about it is refused by anything.** It does not write, so
`knowledge.ts:39` does not apply. It does not spend, so `review.ts:34`–`:35`
does not apply. It does not schedule, so `schedules.ts:529` does not apply. It
does not touch the vault, so `AGENTS.md:115` does not apply. It does not
diagnose, so C6 does not apply. It has no author, so C7's "no memory system
authenticates what wrote a memory" does not apply. **It is the only row in
`13-comparison.md` with a clean sheet.**

**And it is the one option whose reader is guaranteed to be a person.** Every
written option's output is a file that may be read by a person or by a later
agent, and `12-the-loop.md` explains why the second reader is the hazard. A card
on a page has exactly one kind of reader.

**It also answers "what does it collide with" in the operator's favour.** The
brief asks what Dreaming collides with. Option G collides with nothing, which
means it can ship first and be the control the other options are measured
against: if the operator reads the recurrence card for a fortnight and never
acts on a row, that is direct evidence that the written version would not have
been read either.

## Where it breaks

**It is not what was asked.** The brief says *works out what was learned*.
Option G refuses to work anything out. It is a report about repeated failures,
not a record of learning, and it cannot produce the one thing the whole feature
is for: a sentence. `proposals/ContinuousImprovement/10-option-retrospective.md`
makes exactly this case for its own Option G, and it is the strongest thing
against this one: "*The `iteration` event already carries the prompt, so do not
add a column for it* is not a path, and cannot be delivered by anything that
only knows which files were opened."

**Errors are a proxy for learning and a poor one.** A day where everything
worked produces no rows and no card, and may be the day the most was learned.
Every architectural decision, every abandoned approach, every thing that worked
first try is invisible. The card can only ever say "this keeps breaking", which
is a fraction of what a person means by what they learned today.

**Signatures are not causes.** Normalisation collapses `Exit code 1` and
`Exit code 127` into `Exit code N`, which is the top row at 12 days and carries
no information at all; it splits one cause across four rows when four different
files hit the same `bwrap` denial. `11-deduplication-and-retirement.md` states
both directions. A count of signatures is a count of strings.

**Half the top rows are not failures.** `The user doesn't want to proceed with
this tool use` (11 days) is a person declining. `This command requires approval`
(7 days) is a permission prompt working correctly. A card that shows them
alongside a missing binary is a card whose top half an operator learns to skip,
and there is no non-judgement rule that separates them.

**It needs a parse the app does not have.** `transcripts.ts` takes token counts
and tool-call shapes and never text (`:346`, `:485`); `toolComposition.ts`
records how many characters a result had, not what they said. Reading `is_error`
bodies is new work in the hot path of `/api/usage`'s cache, and
`proposals/GrowthLimits` measured the cold transcript scan at **2,985–3,041 ms**
against a warm 82.5–88.9 ms. This adds to the cold number. It is not free in
latency even though it is free in money, and the honest version caches its own
rollup rather than riding the existing walk.

**And it does not deduplicate across days so much as it *is* the
deduplication.** That is the point, but it means the card's own value decays:
after a month the same eight rows sit at the top for ever, and a list that never
changes stops being read. It needs an acknowledgement — "I have seen this one" —
which is one column and the first place a state machine creeps in.

## What an operator sees

A list, sorted by days-spanned, each row quoting the machine verbatim with a
count, a date range and a link to the sessions. No prose, no inference, no
provenance problem, and nothing to retract.

## Verdict

**Build this one.** It is the smallest thing in the survey, it is the only thing
refused by nothing, it is the half of Dreaming the evidence supports, and it is
the control that would tell an operator whether the expensive half is worth
having. `14-recommendation.md` puts it first, and is explicit that it is **not**
the feature that was asked for.
