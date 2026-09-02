# Option H — the licensed external run over tools and outputs

The brief as its author meant it, which is not the brief this survey first
scored. **An external run whose working directory is the vault**, which reads
`CLAUDE.md` before it writes anything, walks the day's `tool_use` inputs and
`tool_result` outputs across every session, works out what was learned from what
the tools actually did, deduplicates against what it has already written, and
writes into the vault proper — not into a quarantine.

Three things separate it from Option A, and two of them dissolve refusals that
`13-comparison.md` scored as zeroes.

| | |
|---|---|
| **fires** | a `{kind:"daily"}` schedule over a one-node workflow, or a press |
| **reads** | `tool_use` + `tool_result`, all sessions — **435.06 MiB over 23 days** |
| **writes** | markdown into the vault proper, under the vault's own conventions |
| **authors** | a model that has read `CLAUDE.md` and holds the writing conventions |
| **retracts** | a person deleting a file, unless a ledger is built to list what was written |
| **costs** | **$27.60 a night** at Opus input, $193 a week |

Measured by `node proposals/Dreaming/scripts/tool-corpus.mjs ~/.claude/projects`
and `node proposals/Dreaming/scripts/ledger.mjs ~/.claude/projects`, both added
for this option.

---

## 1. The two refusals that do not apply

This matters more than anything else in the file, because four of the seven
original options scored zero on *licensed by the destination* and Option H does
not.

**`AGENTS.md:115` is a conditional and Option H fails its antecedent.** The
sentence is:

> "**If you are a session from another project and have not read `CLAUDE.md`**,
> you do not have the writing conventions and should not write notes here. The
> one exception is a single question capture into
> `3 Resources/Questions/Inbox/`…"

The prohibition is on a session that lacks the conventions, and the remedy is
named in the clause immediately above it (`AGENTS.md:109`): "Read `CLAUDE.md`
first; the conventions are strict and a note that violates them is worse than no
note." A run whose cwd *is* the vault, that opens `CLAUDE.md` as its first act,
is not the session that sentence forbids — it is the session that sentence tells
you how to become. **Options A, B, C and F score zero here because they were
scored as foreign sessions writing blind. Option H is not one.**

Two consequences, and the second is a cost rather than a win. Option H is
licensed to write into the vault *proper* rather than into
`3 Resources/Questions/Inbox/`, which is a strictly larger permission than
Option D's. And it inherits the full six non-negotiables of
`_Meta/Vault Conventions.md:23`–`:30` — complete frontmatter with `updated:`
bumped, at least three outgoing wikilinks with a `## Related` section explaining
each, namespaced tags registered in `[[Tag Index]]`, every claim sourced with
`confidence` not exceeding the evidence grade it cites, no orphans, gaps left as
seed notes — enforced by `_Meta/qc.py`, which "exits non-zero on any violation"
across the operator's **whole vault** (`_Meta/Vault Quality Control.md:17`).
Being licensed and being compliant are different problems and only the first one
just got solved.

**`src/lib/knowledge.ts:39`–`:44` is about a different writer.** Its bound is
"nothing in this module **or in the routes over it** opens a file for writing",
and its reason is a concurrency argument about a background index racing
Obsidian. An external run using its own `Write` tool is neither the module nor a
route over it. `10-the-write-path.md` §1 costs a *new module inside this app*
that writes to the vault, and Option H does not need one: the writer is an agent
in a run, and the app's involvement ends at spawning it.

That is genuinely better and it is also the trapdoor. `10-the-write-path.md` §3
already names it: **the licence is a sentence in a file that no mechanism
reads.** Nothing verifies the run opened `CLAUDE.md`. `vaultSkill.ts`'s text is
persuasion, not enforcement — and the managed sandbox policy has no path-based
write restriction at all, only `"denyRead": ["${DATA_DIR:-/data}", "/backups"]`
(`docker-entrypoint.sh:431`–`:433`). The one place a write licence could be
enforced against an agent is a `PreToolUse` deny-on-`Write` hook, which
`10-the-write-path.md` §6 sizes as **large** and which does not exist. So Option
H's licence is real and its compliance is a hope.

## 2. The corpus, measured

`tool-corpus.mjs` walks the same 1,953 files and splits every content block.

| day | `tool_use` | results | errors | corpus tokens | opus | fits 1M? |
|---|---:|---:|---:|---:|---:|---|
| 2026-08-10 | 6,664 | 6,570 | 92 | 7,791k | $38.96 | no ×7.8 |
| 2026-08-14 | 8,410 | 8,262 | 148 | 7,919k | $39.59 | no ×7.9 |
| 2026-08-16 | 8,480 | 8,308 | 172 | 7,948k | $39.74 | no ×7.9 |
| 2026-08-19 | 8,078 | 7,866 | 212 | **12,807k** | **$64.03** | no **×12.8** |
| 2026-08-25 | 5,723 | 5,600 | 123 | 9,075k | $45.38 | no ×9.1 |
| 2026-08-28 | 8,138 | 7,932 | 193 | 9,250k | $46.25 | no ×9.2 |
| 2026-08-20 | 427 | 422 | 5 | 380k | $1.90 | **yes** |
| 2026-09-02 | 430 | 418 | 11 | 490k | $2.45 | **yes** |
| **mean** | | | | **5,521k** | **$27.60** | |

Full table from the script. Two figures decide the option.

**A day does not fit. 21 of 23 days (91%) exceed a 1,000k window**, the largest
this install has, and the mean day is 5.5× it. The two that fit are 2026-08-20
and 2026-09-02, which are a four-session day and a five-session day — the
corpus's two near-empty days, not its typical ones.

That is not a cost problem, it is a *claim* problem. The thing a daily pass
offers over a per-run one is cross-session synthesis: noticing that the same
approach failed in three different runs. A reader that has to take a day in six
chunks is not doing that. It is doing six within-chunk syntheses and stapling
them, and nothing in the stapling step has seen the whole day either.
`00-problem.md` §1 made this point about the *prose* slice, where 75% of days
need chunking; on the tool corpus it is 91% and the mean overflow is 5.5× rather
than 1.4×.

**And 99.8% of the corpus carries no deduplication key.** Of 435.06 MiB across
23 days, the error results — the only blocks that carry a message a signature can
be taken from — are **0.90 MiB, 0.2%**. The other 206,259 blocks are successful
results and tool inputs, and two identical `Read`s of the same file on two
different nights are the same event with nothing to match on but the model's own
judgement. Section 4 is about what that does.

The tool distribution is the shape you would expect and is worth one line
because it bounds what a learning could be *about*: of 104,461 tool calls,
**60,441 are `Bash` — 57.9%** — then 15,594 `Read`, 15,379 `Edit`, 3,329 `Write`,
2,432 `WebFetch`. A corpus that is nearly three-fifths shell invocations is a
corpus about this install's environment, which is exactly where the recurring
failures in `11-deduplication-and-retirement.md` live.

## 3. The strongest case

**It is the only option that both does what was asked and is allowed to.**
Option G refuses to work anything out. Option D is licensed but capped at one
question into a quarantine. Options A, C and F do the work and are not licensed.
Option H is the first row in the survey with a yes in both columns, and that is
a real change to the table rather than a rescoring of the same facts.

**Its input is transcription and its subject is the environment.** The
distinction `Can an Agent Write an Accurate Record of Its Own Failure.md:31`
draws — transcription of what happened versus diagnosis of why — was applied in
this survey mostly to *introspection*, and the 14.2% failing-step figure at `:27`
is about a model locating the step where its own reasoning went wrong. **A model
reading `pdftoppm is not installed. Install poppler-utils` and writing "this
container lacks poppler-utils" is not doing that.** It is reading an artefact the
harness recorded and restating it, and the claim is checkable by running one
command. `proposals/ExternalValidator`'s zero-of-eight result is likewise about
testimony, not about a tool's own output.

So C6 does not refuse Option H outright the way it refuses Option A. It refuses
**a part** of it, and the part is nameable: any sentence about *why an approach
was chosen* is reconstruction over a corpus with 48,978 empty `thinking` blocks;
any sentence about *what the environment did when touched* is transcription.
A note that keeps those apart is compliant with the position the vault already
holds. A note that does not is `01-constraints.md` C6 with extra steps.

**It sees all three corpora.** The transcripts carry all 63 of an ordinary day's
sessions where the `runs` table carries 42 and 74.6% of the money
(`00-problem.md` §2), and the operator's own machine is the largest prose class
at 18.70 MiB. Option B's corpus knows how a run *ended* and cannot see the day
the operator spent in chat. Option H reads the corpus that contains everybody.

**And the firing mechanism arrives with a budget refusal attached.** As a
one-node workflow on a `{kind:"daily"}` schedule it inherits
`scheduleRefusal` (`src/lib/schedules.ts:529`–`:539`), which refuses to schedule
a workflow whose instance budget sets nothing, and it lands in `runs.spent_usd`
where `installSpend`'s rolling 24 hours can see it
(`src/lib/installBudget.ts:79`). Every other automatic option in this survey
needs that built.

## 4. Deduplication, which is where it actually fails

The operator asked for this to be taken into account, and taking it into account
is what sinks the unscoped version.

**The three policies, measured.** `ledger.mjs` replays the 23 days in order and
counts the notes each write policy would add:

| policy | notes in 23 days | per night | what they are about |
|---|---:|---:|---|
| **none** — write every distinct signature every night | **1,361** | 59.2 | 184 are exact re-writes of a note already there |
| **first** — a ledger; write each signature once, on first sight | **1,177** | 51.2 | **1,100 (93.5%) about something that never recurred** |
| **second** — write a signature the night it reaches a second day | **77** | 3.3 | all about something seen on ≥2 days |

Three readings, and the third is the design.

**A ledger is nearly worthless on its own.** Going from "none" to "first" saves
184 notes of 1,361 — 13.5%, the same figure `recurrence.mjs` reports, because it
is the same measurement. The naive intuition is that dedup is the fix; it removes
an eighth of the volume and leaves 1,177 notes in a 1,224-note vault. **Option H
with a perfect ledger still doubles the operator's vault in 24 days.**

**The volume is not the worst of it — the composition is.** Of the 1,177
distinct signatures, **1,100 (93.5%) appear on exactly one day**. A writer that
writes on first sight is, 93.5% of the time, writing a permanent note about a
transient. That is the failure `_Meta/Vault Conventions.md:39` is aimed at from
the other side, and it is worse than duplication: a duplicate is noise a reader
can skip, and a note about a one-off is a *claim about the install* that was true
once and is now retrieval-eligible for ever. `01-constraints.md` C7's numbers
apply directly — retrieval selects rather than averages, and no memory system
authenticates what wrote a memory.

**Writing on the second sighting fixes both, and is the one design contribution
this option makes.** 77 notes over 23 days, 3.3 a night, every one about
something that happened on at least two separate days — which is
`11-deduplication-and-retirement.md`'s own argument that "the 6.6% that recurs is
the half worth writing", turned into a write policy. The latency it pays is
measured rather than assumed: **median 3 days between first and second sighting,
mean 3.8, min 1, max 20, and 40% recur on the very next day with material.** So a
standing problem is written down within three days of becoming one, and nothing
is written about the 1,100 transients at all.

**But the policy only works on the 0.2% of the corpus that has a key.** That is
the sentence this option breaks on. A signature exists because an error carries a
message. There is no signature for "the agent learned that `rg --json` is faster
than three `Grep` calls", so for 99.8% of what Option H reads, the dedup step is
*the model deciding whether it has said this before* — a retrieval-then-judgement
pass over 1,224 notes, nightly, with no verifier, which is precisely the step
`11-deduplication-and-retirement.md` §2 prices for Options A and B and calls out
as having no ground truth. **Option H's ledger is a real mechanism for 0.2% of
its input and a hope for the rest.**

## 5. Where else it breaks

**Retirement is untouched.** `/workspace2` has no `.git` (C4). Option H writes
into the vault proper rather than a quarantine, so unlike Option D there is no
review queue that exists before the mistake. A wrong note is found by accident,
months later, by whoever notices. The write-on-second policy reduces the *rate*
and `01-constraints.md` C7 is explicit that the rate is not what matters:
"there is no rate at which this is safe without a retraction mechanism, because
the mechanism is what bounds the *consequence*."

A ledger helps here in a way it does not help with dedup: **the same table that
records what was written is the list of what to retract**, which is the row
`10-the-write-path.md` §6 sizes as "medium, and nothing in this repository is a
precedent for it". That is worth building and it is not the same as version
control — it records what this app wrote, not what the file says now.

**`qc.py` compliance is a second file edited, every time.** `LINK/orphan` is at
ERROR and needs an *inbound* link, so a compliant write is the note plus an edit
to a MOC or parent that links to it (`10-the-write-path.md` §4). That doubles the
concurrency surface against Obsidian — and the second file is a hand-maintained
index note, the exact kind of file the operator has open.

**`build_index.py` has to run afterwards**, rewriting a 2,633,599-byte
`INDEX.md` and every file under `_Meta/index/` (`AGENTS.md:113`). A nightly job
that regenerates 2.6 MB of the operator's vault is a nightly job that can leave
it half-written.

**Cost is 10× the figure the survey argued was affordable.** $27.60 a night is
2.9% of a $956.09 day and $193 a week. `01-constraints.md` C2 established that
refusing this feature on money would be repeating a figure measured about
something else, and that still holds — 2.9% is not a refusal. But the honest
statement is that the prose read was $2.57 and this is not that number, and on
2026-08-19 it is $64.03.

**And nothing marks the note as machine-written.** The vault has no author
field. The `Questions/Inbox/` template supplies `captured_by`, `captured_from`
and a `> [!warning] Unreviewed capture` block — and that template belongs to the
quarantine Option H has just been licensed *past*. Writing into the vault proper
means writing something that renders in Obsidian in the same graph with the same
link colours, indistinguishable from a note the operator wrote themselves. The
fix is to carry the provenance fields anyway, by convention, which is one more
thing nothing enforces.

## 6. What an operator sees

As a scheduled workflow: everything the run loop shows — `/runs` while it runs,
a `run_events` timeline, a log tail, a cost, an origin of `schedule`
(`src/lib/runOrigin.test.ts:229`). What it does **not** show is what was written
into the vault, because `runTouches`/`runTouchScan` reconcile against the run's
checkout and the vault is a different mount (`08-option-f-workflow-block.md`).

That gap is the operator's stated requirement, and it is
`18-the-dreaming-pane.md`: a pane that lists what was written, on which night,
from which signature, still present or since deleted. Note that the pane needs
the ledger from §5 to exist — **there is no way to render "what Dreaming wrote"
by reading the vault**, because a note in the vault carries nothing that says
this app produced it.

## 7. Verdict

**Refuse the unscoped form; the narrowing is `17-option-i`.**

Option H dissolves the two refusals the original survey leaned on hardest, and
that is a real correction to `13-comparison.md` rather than a concession. What
kills it is not licence and not cost. It is that **the corpus it names does not
fit in a context and does not carry a deduplication key** — 91% of days overflow
by a mean of 5.5×, and 99.8% of the material has no handle a ledger can hold,
which throws the dedup step back onto unverified model judgement over 1,224
notes a night.

Both of those are properties of the *scope*, not of the idea. Narrow the corpus
to the slice that has a signature and both disappear at once: it fits in one
context with room to spare, the ledger becomes exact, and the write-on-second
policy turns 1,361 notes into 77. That option is `17-option-i-errors-only-licensed.md`,
it keeps the licence fix that Option H established, and it is the one this
survey now recommends building.
