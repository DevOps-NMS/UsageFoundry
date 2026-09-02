# Recommendation

> **Revised.** The operator corrected the brief after §1–§13 were written: the
> writer is an **external run whose cwd is the vault**, which reads `CLAUDE.md`
> and therefore holds the writing conventions. That dissolves the two refusals
> this recommendation leaned on hardest and adds
> `16-option-h-the-licensed-external-run.md` and
> `17-option-i-errors-only-licensed.md` to the table. The build order below is
> the revised one; §"Why the recommendation is against the feature" is kept as
> written, with each limb marked for whether it survived.
>
> The operator has also **required a left-navigation pane** showing what
> Dreaming produced, of whichever option ships.
> `18-the-dreaming-pane.md` is that requirement, not an option in this survey.

**Build the arithmetic first, then the narrow writer.** The feature as literally
posed — read everything, work out what was learned, write it down — still should
not be built, and the reason is now scope rather than permission. The version
that should be built is the one scoped to the slice of the day that carries a
machine-established fact and a deduplication key.

In order:

1. **Ship the recurrence readout** (Option G) **behind the required pane.** No
   model, no write, no clock. It is refused by nothing, it costs nothing to run,
   its failure mode is a bug rather than a false claim in somebody's document
   store, and it is the one thing that can fill the operator's pane on day one
   with no prerequisite. `18-the-dreaming-pane.md` §5.
2. **Run the fortnight** (Option F, as an experiment and not as a feature). A
   one-node workflow on a `{kind:"daily"}` schedule, budget-capped by
   `scheduleRefusal`, watched on `/runs`, deleted afterwards. Point it at the
   vault so it reads `CLAUDE.md` — that is Option H composed, and it costs a
   fortnight and no code to find out whether the written half is worth anything.
3. **Then build Option I**: the licensed external run, scoped to `is_error`
   results, writing on a signature's **second** sighting, against a ledger this
   app keeps. 77 notes in 23 days instead of 1,361, $0.42 a week, and the ledger
   is what the pane renders and what makes retraction a list rather than an
   accident.

**Do not build Option H as posed, or A, B, C, or the standing form of F.** H is
refused on scope in `16-option-h` §7 — 91% of days overflow a 1M context and
99.8% of its corpus has no dedup key. The rest are refused, by name, in §3.

**Option D is no longer the runner-up.** It scored 145 against Option I's 140 on
this survey's weights and loses to it under every reweighting in
`13-comparison.md` §4. It remains the right shape for a *press*, and its
quarantine is still the only sink with a review queue in front of it.

---

## Why the recommendation is against the feature

Three findings, in the order they mattered when they were written. **Limb 1 did
not survive the operator's correction; limbs 2 and 3 did, in part.** They are
kept rather than rewritten so the change is visible.

**1. The destination has already answered. — DOES NOT SURVIVE.** The rule is
conditional and the corrected shape fails its antecedent: the writer reads
`CLAUDE.md`, so it is not "a session from another project [that has] not read
`CLAUDE.md`". `16-option-h` §1 argues it in full. What survives is smaller and
still real: **nothing enforces the licence.** No mechanism checks that the run
read anything, the managed sandbox policy has no path-based write restriction
(`docker-entrypoint.sh:431`–`:433`), and a skill is persuasion. The licence is
now a property of how the run is composed rather than of anything in `src/`.

The original text:
`/workspace2/AGENTS.md:115`: "If you are a session from another project and have
not read `CLAUDE.md`, you do not have the writing conventions and should not
write notes here. The one exception is a single question capture into
`3 Resources/Questions/Inbox/` … a quarantine that gets reviewed before anything
counts as vault content." A UsageFoundry-spawned child is exactly that session.
This is not a rule this survey imposed to be careful; it is the licence the
store hands out, written by the person who owns it, and four of the seven
options ignore it.

Beside it, `src/lib/knowledge.ts:39`–`:44` refuses the write from this end, and
gives a reason that is a concurrency argument rather than a preference: the
vault is open in Obsidian while this runs, and "a background index that can
write into it is one that can lose somebody's paragraph while they are typing
it."

**2. The corpus supports transcription and not diagnosis. — SURVIVES, NARROWED.**
The 14.2% figure is about a model locating the step where **its own reasoning**
went wrong, and a model restating `pdftoppm is not installed` is not doing that.
So this limb no longer refuses the whole output; it refuses a nameable part of
it — any sentence about *why* an approach was chosen, over a corpus with 48,978
empty `thinking` blocks. A note that writes the signature verbatim and marks the
cause as a hypothesis complies with the vault's own stated position. Nothing
enforces which kind of note gets written. As originally stated:

48,978 `thinking` blocks in the readable corpus,
thirteen non-empty, none from the model this install runs; and
`src/lib/orchestrator.ts:6675`–`:6704` drops every block that is not `text` or
`tool_use` by name. So "what was learned" is inference over an action log — and
`3 Resources/Questions/Can an Agent Write an Accurate Record of Its Own
Failure.md:27` measures the best method in the only peer-reviewed benchmark
locating the failing step **14.2%** of the time, with the stated working
position: "admit transcription, mark diagnosis as a hypothesis, and never let an
unverified stated cause enter a store as a fact." Option G ships the
transcription and refuses the diagnosis. Options A, B and C ship the diagnosis.

**3. There is no way to take it back. — SURVIVES, AND IS NOW THE MAIN
OBJECTION.** Nothing about the corrected shape touches it. What Option I adds is
a partial answer nobody had before: **a ledger this app keeps of what it wrote,
which is a retraction list even though it is not version control**
(`17-option-i` §3). It does not make the vault reversible; it makes this app able
to say which 77 files are its own. That is the difference between "a person
deletes a file if they notice" and "a person deletes a file from a list", and it
is why Option I scores 3 on retirement where A, B, C and F score 1. The original
statement, unchanged:

`/workspace2` has no `.git`. No history,
no author field, no list of what last night added. And the reason that matters
more than a rate does: "**retrieval selects, it does not average**" — a sub-0.1%
poison rate producing over 80% attack success at under 1% degradation on benign
tasks (`Does an Agent Defer to a Stale Memory Over What It Can Observe.md:33`,
peer-reviewed) — with shipped memory systems scoring **5.1% to 17.8%** at
noticing their own memories have been invalidated (`:27`), and the reader
measurably disposed to agree with whatever the record says (`:37`, 32%–98%).
A wrong note is not diluted by right ones. It is what the reader sees on the
query it matches.

## What the recommendation is *not* refusing

**Cost.** `proposals/ContinuousImprovement/16-recommendation.md:169` refused
Option G at 12.4–27.6% of an eleven-day bill. **That limb does not reach
Dreaming and this survey will not borrow it.** Reading a day's prose once is
$2.57 against a $956.09 day — 0.27%, $18 a week. Reading only the day's tool
errors is $0.06 a night. On money alone the feature is affordable and refusing
it on money would be repeating a figure that was measured about something else.

**The premise.** The operator is right that the install's most detailed record of
its own work goes unread: `src/lib/transcripts.ts` walks 1,370,318,045 bytes on
every `/api/usage` and takes token counts and tool-call shapes, never a word of
text. Something *should* read it. The disagreement is about what that something
writes, where it writes it, and whether a clock may start it.

## Why Option G, specifically

It scores 172/190, ahead of the runner-up by 27, and it wins every reweighting
tried (`13-comparison.md` §4) — including one that drops the whole safety half
of the criteria and one that raises "does what was asked" from 4 to 10.

What it is: a list of the failures that have happened on more than one day,
quoted verbatim from the machine that produced them, with counts, dates and
links to the sessions. **77 signatures qualify today, carrying 1,260 of 2,547
error instances — 49.5%** — and six of the top eight are one-minute fixes that
have been costing this install a work cycle at a time for eight separate days:

```
  8 days  pdftoppm is not installed. Install poppler-utils…
  8 days  error: .bash_profile: can only add regular files, symbolic links…
  8 days  bwrap: Can't create file at /PATH/settings.local.json: Permission denied
  8 days  bwrap: Can't create file at /PATH/settings.json: Permission denied
  7 days  File content (N tokens) exceeds maximum allowed tokens (N)…
  7 days  This command requires approval
```

Two of those were hit by the session that wrote this survey.

**And it is the control the expensive options need.** If the operator reads that
card for a fortnight and never acts on a row, that is direct evidence a written
nightly note would not have been read either — which is the cheapest way anyone
has proposed of testing the feature's real premise.

What it is *not*: it does not work anything out, it cannot produce a sentence,
it is blind to every day where nothing failed, and its signatures are strings
rather than causes. `09-option-g-the-recurrence-readout.md` states all four
against itself.

## Why the runner-up is Option D and not Option A

**Option D on a press** is the only *writing* option refused by nothing: the
licence permits it (`AGENTS.md:115`), the press authorises it
(`review.ts:34`–`:35` is a rule about automatic spend), the quarantine retracts
it (a review queue that exists before the mistake), and the template supplies
the provenance — `captured_by`, `captured_from`, and a closing
`> [!warning] Unreviewed capture` block — that nothing else here supplies.

And it has already worked. **Two of the three notes in that quarantine name
UsageFoundry in `captured_from`**, and one of them,
`Does Writing Lessons From a Past Run Stop an Agent Repeating the Mistake.md`,
is where `01-constraints.md`'s C6, C7 and C8 come from. A UsageFoundry session
wrote one question into the operator's vault, and that question is the best
evidence this survey has about whether the whole feature is worth building.
**The arrow this feature wants to automate has run three times by hand and
produced something valuable each time.**

What holds it at second: the licence's own limit is *a single capture*, not one
a night, and the review half has not run once — the three captures are dated
2026-08-15, 08-16 and 08-21 and all three are still `meta/inbox`. A pressed
capture inherits that backlog; a nightly one multiplies it by forty.

## Order, if somebody builds

1. **Option G's readout.** A cached rollup over `is_error` bodies plus a card.
   It must cache its own rollup rather than riding `/api/usage`'s walk — the
   cold scan is 2,985–3,041 ms against a warm 82.5–88.9 ms
   (`proposals/GrowthLimits`), and this adds to the cold number.
2. **The fortnight.** Option F, composed, budget-capped, deleted after.
3. **Only then, Option D's press** — and before it, the three latent defects in
   `05-option-c-failures-only.md`, because a third `AssistKind` inherits a
   ten-minute clock (`src/lib/review.ts:78`–`:79`), logs itself as a review
   (`src/lib/logLine.ts:561`), and spends where the install ceiling cannot see
   it (`src/lib/installBudget.ts:79`–`:136`; `--max-budget-usd` is pushed only
   at `src/lib/cycleInvocation.ts:1117`).

## One repair found while looking for something else

**`searchKnowledge` reads neither `confidence:` nor `status:`.**
`src/lib/knowledge.ts:1403`–`:1438` scores on where the match landed — title
exact 100, alias 70, title substring 50, tag 30, otherwise 10 — then sorts on
score and title. So a `status: seed`, `confidence: low` note ranks identically
to a `status: evergreen`, `confidence: high` one, and the vault's own authority
gradient, which `_Meta/Research Protocol.md` defines and `qc.py`'s `CONF/*`
family enforces at ERROR, is invisible to the app that reads it.

That is worth fixing whether or not anything here is built, and it is the
precondition for ever writing into that namespace: `12-the-loop.md` argues that
a loop with a model at both ends has no authority gradient in it, and this is
the one place in `src/` where the gradient could be restored.

## The fact that would overturn this

**One, and the threshold has halved.** If the operator says the point of the
feature is precisely that a person who has spent eleven hours on something will
not sit down afterwards and ask what they learned — that the *automaticity is
the feature* and a button is a feature that will never be pressed — then
criterion 1 in `13-comparison.md` is not weight 4.

Before the operator's correction that argument needed **weight 30** to overturn
the table, and at 30 the winner was Option F: a weighting in which the brief's
wording outweighed every other criterion combined by nearly a factor of two, and
which was easy to set aside. **It now needs weight 15, and the winner is Option
I** — 184 to G's 183 (`13-comparison.md` §4). Fifteen is "doing what was asked is
worth about three times a safety column", which is an ordinary position, and it
is the operator's default position since they are the one who asked.

So the honest statement of where this recommendation stands: **G first is a
claim about sequencing, not about I being wrong.** The readout has no
prerequisite, fills the required pane on day one, and is the cheapest possible
test of whether the operator acts on this material at all. If they read it for a
fortnight and act on rows, Option I is not overturning the recommendation — it is
the next step in it.

Two more, both cheap:

- **If `/workspace2` comes under version control**, criterion 4 changes for
  every option at once: retraction stops being "a person deletes a file if they
  notice" and becomes a diff. Options A, C and E all gain, and the write path in
  `10-the-write-path.md` loses its hardest row.
- **If the vault's own open question is settled positive at power** — 120–200
  tasks, per `Does Writing Lessons…:48` — then a written learning has a measured
  benefit for the first time and every score in column 1 is worth more. Today
  the same literature bounds it at "10 to 15 points and probably zero"
  (`Does a Standing Instruction File…:27`), and the question sits at
  `confidence: low` in a quarantine folder, prompted by this app.
- **If a `PreToolUse` deny-on-`Write` hook is built**, the licence stops being a
  property of how somebody composed the run and becomes a mechanism. That moves
  H and I from 4 to 5 on criterion 2 and is the only thing that would make an
  *unattended* vault write defensible. `10-the-write-path.md` §3 identifies it
  and §6 sizes it as the one large row in the table.

## The measurement that would settle Option I on its own

`17-option-i` §4 reports it against itself: **of the 77 notes the
write-on-recurrence policy produces, 34 (44%) describe something that occurred
again after the note existed.** The other 43 document a recurrence that had
already stopped. Re-run `scripts/ledger.mjs` over a 90-day window rather than 23
and that ratio is the closest thing available to an answer about whether this
feature writes about live problems or dead ones — and it costs one command
against a corpus that already exists.

It is not a measurement of whether writing helped. Nothing here knows whether
anybody read a note.
