# Option A — the nightly transcript pass

The brief read literally. At 03:00 in the operator's timezone, a one-shot
`claude` child is handed the day's sessions from
`~/.claude/projects/**/*.jsonl`, asked what was learned, and given write access
to the vault so it can put the answer there.

| | |
|---|---|
| **fires** | a clock — `{kind:"daily", minutes}` (`src/lib/schedules.ts:65`) |
| **reads** | the transcript corpus, all 42.8 sessions of a mean day |
| **writes** | markdown files into `/workspace2`, wherever the model judges they belong |
| **authors** | a model, unattributed |
| **retracts** | a person, by deleting a file, if they notice |
| **costs** | $2.57–$78.31 a night depending on slice, plus output |

---

## The strongest case

**It is the only option that sees the whole day.** Every alternative narrows the
corpus, and each narrowing loses something specific: the rows lose the
operator's own 180 sessions and 48.5% of the spend, the failures-only pass loses
everything that went right, the button loses the days nobody presses it. Option
A loses nothing. If the premise is "the install saw 42.8 sessions today and
should be able to say what it saw," this is the only option that can honestly
attempt the sentence.

**The corpus is genuinely rich and genuinely unread.** 53.77 MB a day of what
was actually attempted, on real work, on this operator's real repositories, and
**nothing in this app reads a word of it.** `src/lib/transcripts.ts` walks the
same files on every `/api/usage` and takes two things: `usage` token counts
(`readTokens`, `:346`, called at `:408`) and the *shape* of each tool call via
`parseToolRecord` (`:11`, called at `:485`) — a name, an id, and how many
characters came back.
Never the text. The most detailed record this install has of its own work is
opened, parsed and discarded as a billing meter, several times a minute.

**Cost is not the objection, and it would be dishonest to pretend it is.**
Reading a day's prose once is $2.57 against a $956.09 day: 0.27%, $18 a week,
$78 a month. `proposals/ContinuousImprovement`'s Option G was refused at
12.4–27.6%; this is two orders of magnitude below that. Anyone who refuses
Option A should refuse it for a reason other than money, and this survey does.

**The sink is a person, which is the one thing Option G lacked.** Option G's
objection was that it "has no delivery channel of its own"
(`proposals/ContinuousImprovement/16-recommendation.md:171`) — it wrote into a
table nothing read. A markdown file in an Obsidian vault the operator opens
every day is a real delivery channel with a real reader.

**And the vault is reachable, so this is not speculative.** `/workspace2` is
mounted with 1,224 notes, and `knowledgeBaseMountId`/`knowledgeBaseSubpath`
already exist in `Settings` (`src/lib/settings.ts:645`, `:659`) as the way to
name it — both default to `null`/`""` (`:824`–`:825`), so whether *this* install
has them set was not checked, but the mechanism for pointing the app at a vault
is built and shipped.

## What it costs, precisely

Three shapes, and the brief does not choose between them:

| shape | input/night | output/night | opus | over a week |
|---|---:|---:|---:|---:|
| whole raw corpus | 15,662k tok | ~3k | $78.39 | $548.75 |
| prose only | 514k tok | ~3k | $2.65 | $18.53 |
| assistant prose only | 135k tok | ~3k | $0.75 | $5.27 |

Output is assumed at 3k tokens, which is roughly the 4,873-byte report
`proposals/RunDecisionTree` measured for a whole grounding run, and is assumed
rather than measured because no Dreaming pass has been run.

**The raw shape does not fit in one context and the prose shape barely does.**
15,662k tokens is fifteen full 1M windows. Even the prose slice exceeds 1M on
three of 24 days and 200k on eighteen. So the real Option A is a chunked pass —
*n* reads, a synthesis over the summaries, and a cross-session finding that
survives only if it happens to fall inside one chunk. The cheapest honest
version of "read every session" is therefore several passes, and the price above
is the floor.

## What refuses it

**`src/lib/knowledge.ts:39`**, head-on. The write does not go in that module and
does not go in a route over it, so Option A brings a new write path, which
`10-the-write-path.md` costs at a new module, a containment decision the two
existing checks do not make, and an interaction with the generated read guard.

**`src/lib/review.ts:34`–`:35`**, in full force. This is spend on a clock, over
a corpus nobody asked to have read, producing a file nobody asked for. It is
Option G's automaticity with a longer cadence, and the cadence does not change
the argument — `src/lib/schedules.ts:529`–`:539` already says why: "a schedule
removes the person and keeps the press."

**`/workspace2/AGENTS.md:115`**, which is the refusal that decides it. A
UsageFoundry-spawned child is a session from another project that has not read
the vault's `CLAUDE.md`, and the vault's own instruction to it is: *do not write
notes here.* Option A ignores an instruction written for exactly this case, in
the destination, by the person who owns it.

**`_Meta/qc.py`**, which will reject most of what it writes.
`_Meta/Vault Quality Control.md:38`–`:49` puts `FM/*` (complete frontmatter,
valid enums, ordered dates), `TAG/*` (namespaced, registered in `[[Tag Index]]`),
`LINK/broken`, `LINK/sparse` (≥3 outgoing links), `LINK/orphan` (≥1 inbound
link) and `PATH/*` at **ERROR**. A nightly note has to arrive with three
resolvable wikilinks it did not invent, at least one *inbound* link from an
existing note — which means editing a second file — and tags that already exist
in `[[Tag Index]]`. A note that fails is not rejected at write time; it is
written, and the operator finds out the next time they run `qc.py` and it exits
1 on their vault.

**`_Meta/Vault Conventions.md:39`**, which names Option A's steady state as a
failure mode: "Writing a second note on the same topic beside an existing seed
is the failure mode this convention exists to prevent." A nightly writer over a
recurring corpus writes the same note repeatedly unless it edits in place, and
editing in place means a model rewriting a file a person may be editing — which
is the exact hazard `knowledge.ts:39`–`:44` gives as its reason.

## What it is blind to

Every ending. A transcript stops; it does not carry `status`, `exit_code`,
`needs_review_reason`, whether the branch landed or whether a guard tripped
(`02-what-a-day-contains.md`). So Option A can write "the agent ran the wrong
command" and cannot write "and the run then failed," which is the difference
between a learning and an anecdote.

And every reason. 48,978 thinking blocks, thirteen non-empty. The pass reads an
action log and writes causal sentences over it, which is the operation
`3 Resources/Questions/Can an Agent Write an Accurate Record of Its Own
Failure.md:27` measures at **14.2%** on the nearest available benchmark.

## What an operator sees

While it runs: nothing. There is no run row, no `/runs` entry, no log tail, no
cost card — a scheduled child outside the run loop is invisible to every view
this app has, because every view is keyed on a `runs` row. The first evidence
is a file appearing in the vault at 03:04.

When they want to correct it: they delete the file. There is no `.git` in
`/workspace2` (`01-constraints.md` C4), so there is no diff of what last night
added, no author field distinguishing it from a note they wrote themselves, and
no way to ask "what has this thing written in the last month" except by mtime.

## Verdict

**Refuse.** Not on cost — the cost limb of the Option G refusal genuinely does
not reach it. On three other grounds, any one of which is sufficient: it writes
where the destination's own policy says it may not; it performs the one
operation the operator's own vault grades as measured-to-be-unreliable, without
the external verifier `[[Self-Correction and Reflection]]` names as the
precondition; and it produces, on a nightly cadence over a recurring corpus, the
artefact the vault's conventions single out as the failure they exist to
prevent — with no version control behind it to undo one.
