# Recommendation

**Do not build Dreaming.** Build the half of it that is arithmetic, keep the
half that is a sentence behind a person's press and inside the licence the vault
itself issued, and settle the question the whole feature rests on with a
fortnight of an experiment that needs no code.

In order:

1. **Ship the recurrence readout** (Option G). No model, no write, no clock. It
   is refused by nothing in this repository or in the operator's vault, it costs
   nothing to run, and it is the only artefact here whose failure mode is a bug
   rather than a false claim in somebody's document store.
2. **Run the fortnight** (Option F, as an experiment and not as a feature). A
   one-node workflow on a `{kind:"daily"}` schedule, budget-capped by
   `scheduleRefusal`, watched on `/runs`, deleted afterwards. It can read the
   day's sessions — the correction in `08-option-f-workflow-block.md` — so it
   composes the literal brief for the price of a fortnight and no code, and it
   is the only way to find out whether the written half is worth anything.
3. **If the fortnight says yes, build the press, not the clock** (Option D,
   pressed): a control that captures **one question** into
   `3 Resources/Questions/Inbox/` using that folder's `_TEMPLATE.md`, with the
   provenance fields the template already carries. That is the one write the
   destination licenses, and it is the shape the corpus supports.

**Do not build Options A, B, C or the standing form of F.** Each is refused, by
name, in §3.

---

## Why the recommendation is against the feature

Three findings, in the order they matter.

**1. The destination has already answered.**
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

**2. The corpus supports transcription and not diagnosis, and the operator's own
vault has the numbers.** 48,978 `thinking` blocks in the readable corpus,
thirteen non-empty, none from the model this install runs; and
`src/lib/orchestrator.ts:6675`–`:6704` drops every block that is not `text` or
`tool_use` by name. So "what was learned" is inference over an action log — and
`3 Resources/Questions/Can an Agent Write an Accurate Record of Its Own
Failure.md:27` measures the best method in the only peer-reviewed benchmark
locating the failing step **14.2%** of the time, with the stated working
position: "admit transcription, mark diagnosis as a hypothesis, and never let an
unverified stated cause enter a store as a fact." Option G ships the
transcription and refuses the diagnosis. Options A, B and C ship the diagnosis.

**3. There is no way to take it back.** `/workspace2` has no `.git`. No history,
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

**One.** If the operator says the point of the feature is precisely that a
person who has spent eleven hours on something will not sit down afterwards and
ask what they learned — that the *automaticity is the feature* and a button is a
feature that will never be pressed — then criterion 1 in `13-comparison.md` is
not weight 4, and at weight 30 Option F takes the table. That is a claim about
the operator, not about the corpus, and it is not this survey's to settle. The
recommendation stands on the assumption that a card the operator reads is worth
more than a note nobody asked for, and that assumption is the operator's to
overturn in one sentence.

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
