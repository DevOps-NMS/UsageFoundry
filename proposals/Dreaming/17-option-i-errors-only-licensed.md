# Option I — the licensed writer, scoped to what recurs

Option H with one narrowing: **the corpus is `tool_result` blocks carrying
`is_error`, and a signature is written only on the night it appears on a second
day.** Everything else is the same — an external run whose cwd is the vault,
which reads `CLAUDE.md` first and therefore holds the writing conventions, and
which writes into the vault proper under those conventions.

The narrowing is not a compromise on scope. It is the two things Option H breaks
on, removed by construction.

| | |
|---|---|
| **fires** | a `{kind:"daily"}` schedule over a one-node workflow |
| **reads** | `tool_result` with `is_error` — **0.90 MiB over 23 days, 11k tokens a night** |
| **writes** | **77 notes in 23 days — 3.3 a night**, into the vault proper |
| **authors** | a model that has read `CLAUDE.md`, over a machine-established string |
| **retracts** | a person, from a list this app kept of what it wrote |
| **costs** | **$0.06 a night** at Opus input, $0.42 a week |

---

## 1. What the narrowing buys, in three numbers

**It fits.** 11k tokens against a 1,000k window. Option H overflows on 91% of
days by a mean of 5.5× and by 12.8× on 2026-08-19; Option I uses 1.1% of one
context on the worst day in the corpus. The cross-session synthesis a daily pass
is *for* — noticing the same failure in three different runs — is a thing this
reader can actually do, because it holds the whole day at once.

**The ledger becomes exact.** An error result carries a message, so it has a
signature: numbers to `N`, hex runs to `HASH`, path interiors to `/PATH/`. That
is a string this app can store and compare with no model in the loop. Option H's
dedup step was a nightly retrieval-then-judgement pass over 1,224 notes for 99.8%
of its input; Option I's is a set membership test.

**The write policy makes the output small and makes it the right half.**
`node proposals/Dreaming/scripts/ledger.mjs ~/.claude/projects`:

| policy | notes in 23 days | per night | composition |
|---|---:|---:|---|
| none | 1,361 | 59.2 | 184 exact re-writes |
| first sight, with a ledger | 1,177 | 51.2 | **1,100 (93.5%) about a one-off** |
| **second sighting** | **77** | **3.3** | all seen on ≥2 days |

Per night, the third policy is mostly quiet and occasionally busy — 0 notes on
six of the 23 days, 1–2 on eight, and a maximum of 10 (2026-08-19). It is the
only cadence in this survey that a 1,224-note vault can absorb: 3.3 notes a night
is 6.3% growth a year, against Option H's 1,177 notes in 24 days.

**And it writes about standing properties rather than incidents**, which is
`11-deduplication-and-retirement.md`'s own conclusion turned into a rule: "the
6.6% that recurs is the half worth writing. A signature seen on eight separate
days is a standing property of the install, not an incident. A signature seen
once may be a typo." The 77 include the six one-minute fixes that have each cost
this install a work cycle on eight separate days:

```
  8 days  pdftoppm is not installed. Install poppler-utils…
  8 days  error: .bash_profile: can only add regular files, symbolic links…
  8 days  bwrap: Can't create file at /PATH/settings.local.json: Permission denied
  8 days  bwrap: Can't create file at /PATH/settings.json: Permission denied
  7 days  File content (N tokens) exceeds maximum allowed tokens (N)…
  7 days  This command requires approval
```

The latency the policy pays is measured: **median 3 days from first sighting to
the write, mean 3.8, min 1, max 20; 40% recur on the very next day with
material.** A standing problem is written down within three days of becoming one.

## 2. How this differs from Option C, which was refused

`05-option-c-failures-only.md` scored 55/190 and was refused on three grounds.
Option I answers two of them outright and reduces the third.

| Option C's ground | Option I |
|---|---|
| **not licensed** — writes into a vault whose policy forbids a foreign session | **licensed.** The writer reads `CLAUDE.md` and holds the conventions, so `AGENTS.md:115`'s antecedent is false. `16-option-h` §1 argues this in full. |
| **49.5% duplicate by instance; "left alone, Option C writes the `bwrap` note eight times"** | **solved, and measured.** The write-on-second policy writes it once, on the day it becomes a recurrence. 1,361 → 77. |
| **the output is unverified diagnosis** | **reduced, not solved.** §4. |

Option C also noted that half its top signatures are not failures. That one
survives intact and is §4 as well.

## 3. The one thing the ledger buys that dedup does not

A signature ledger is a table in this app's own database — `(signature,
first_seen, days_seen, written_at, note_path)`. Its dedup job is a membership
test. But the same table is the **only** way three other things in this survey
become possible, and each is impossible without it:

- **A retraction list.** `01-constraints.md` C4: the vault has no `.git`, no
  author field, no diff of what last night added. The ledger is the diff. It does
  not make the vault versioned; it makes *this app* able to say "these 77 files
  are mine, written on these nights, from these signatures" — which is the row
  `10-the-write-path.md` §6 sizes as "medium, and nothing in this repository is a
  precedent for it", and the one that turns retraction from "a person deletes a
  file if they notice" into a list with a button.
- **The pane.** `18-the-dreaming-pane.md` renders the ledger. There is no way to
  render "what Dreaming wrote" by reading the vault, because a note in the vault
  carries nothing saying this app produced it.
- **Retirement, eventually.** A signature that has not recurred in 30 days is a
  note whose claim may have stopped being true — `pdftoppm is not installed`
  stops being true the moment somebody installs it. The ledger can *flag* that;
  it cannot decide it, for the reason `01-constraints.md` C7 gives at `:67`,
  "recurrence is a rate, not an event … an entry cannot be retired by a single
  successful observation either."

## 4. Where it breaks

**Half the recurring signatures are not failures, and nothing separates them.**
`The user doesn't want to proceed with this tool use` spans 11 days and is a
person declining. `This command requires approval` spans 7 and is a permission
prompt working correctly. `Exit code N` spans 12 and is a normalisation artefact
carrying no information at all. Three of the top eight are noise, and telling
them apart from `pdftoppm is not installed` is a judgement the model makes
unverified. At 3.3 notes a night that is roughly one junk note every night —
which is survivable in a way it is not at 59 a night, and is still a junk note in
somebody's vault.

**A signature is not a cause, in both directions.** `bwrap` denials at
`settings.json`, `settings.local.json`, `launch.json` and `skills` are four
signatures and one cause, so the policy writes four notes about one thing — and
`_Meta/Vault Conventions.md:39` names writing a second note beside an existing one
as "the failure mode this convention exists to prevent". In the other direction
`Exit code N` is one signature over many causes. Neither is fixable by string
matching, and a model asked to fix it is back to unverified judgement.

**The diagnosis step is still there and still unverified.** Option I's *input* is
transcription — the error string is what the machine said, and a note restating
it is checkable by running one command. Its *output* is "what would have avoided
this", which is a cause. `Can an Agent Write an Accurate Record of Its Own
Failure.md:27` is the bound: the best method in the only peer-reviewed benchmark
locates the failing step 14.2% of the time, with the working position "admit
transcription, mark diagnosis as a hypothesis, and never let an unverified stated
cause enter a store as a fact." **A note that writes the signature verbatim, the
days it spanned, and the hypothesis marked as one is compliant with that
position.** A note that asserts the cause is not, and nothing enforces which gets
written.

**56% of the notes are about something already over.** Of the 77 the policy
writes, **34 (44%) describe something that occurred again after the note
existed** — so 43 do not. Written on the second sighting, they document a
recurrence that then stopped. That is not a bug in the policy; it is what
recurrence looks like at n=2 in a 23-day window, and a longer window would move
it. But it means nearly half of a compliant Option I's output is a permanent note
about a problem that had already gone away when it was written, sitting in a
store where retrieval selects rather than averages. **This is the strongest
single argument against writing at all**, and it comes from the option's own
measurement rather than from the literature.

And that 44% is not evidence the feature works. Nothing here knows whether
anybody read a note. `01-constraints.md` C8 stands: the literature bounds any
correctness effect from a written instruction at "under 10 to 15 points and
probably zero" at a power none of the studies reached, and the vault's own
question about this exact artefact is open, at `confidence: low`, with
UsageFoundry named as what prompted it.

**`qc.py` and `build_index.py` are unchanged from Option H.** `LINK/orphan` is at
ERROR, so a compliant write is the note plus an edit to a parent that links to
it; `AGENTS.md:113` requires regenerating a 2,633,599-byte `INDEX.md` and every
file under `_Meta/index/` afterwards. At 3.3 notes a night this is 3.3 pairs of
writes and one 2.6 MB regeneration a night into a store the operator has open in
Obsidian. `knowledge.ts:39`–`:44`'s concurrency argument is about exactly this
and it does not stop being true because the writer moved outside the module.

**And nothing enforces the licence.** Same as Option H §1: no mechanism verifies
the run read `CLAUDE.md`, the sandbox policy has no path-based write restriction
(`docker-entrypoint.sh:431`–`:433`), and a skill is persuasion. A `PreToolUse`
deny-on-`Write` hook is the only enforcement point and does not exist.

**If somebody implements it as an `AssistKind` rather than a run, three latent
defects bite**, re-checked at HEAD in `05-option-c-failures-only.md` and all three
still reproducing: `assistTimeoutMs` is a ternary on one member so a third kind
silently inherits the review's ten-minute clock (`src/lib/review.ts:78`–`:79`);
`describeEvent` logs it as a review (`src/lib/logLine.ts:561`); and `installSpend`
does not sum `run_reviews`, so the install ceiling cannot see it
(`src/lib/installBudget.ts:79`–`:136`). **The recommendation is that it is a run,
not an assist**, which sidesteps all three — a run lands in `runs.spent_usd`,
where the ceiling does look.

## 5. What an operator sees

The run, on `/runs`, with a cost and an origin of `schedule`. And the pane —
`18-the-dreaming-pane.md` — which for this option is a table with real columns,
because the ledger has them: the signature, the days it spanned, the night it was
written, the note it became, and whether that file is still there.

That last column is the one worth building. It is a `statSync` per row against a
path this app recorded, and it is the only thing in this survey that would tell
an operator that a note Dreaming wrote has been deleted — which is what
retraction looks like in a store with no version control.

## 6. Verdict

**Build this one, after Option G and after the fortnight.**

It is the only option in the directory that is licensed by the destination, fits
in a context, deduplicates with a mechanism rather than a judgement, writes at a
cadence a 1,224-note vault can absorb, keeps a list of what it wrote, and costs
$0.42 a week. It does what was asked in the sense that matters — something reads
the day's sessions and writes what it learned into the vault — on the slice of
the day where "what it learned" is a machine-established fact rather than a
reconstruction.

What it does not do is escape `01-constraints.md` C8. Nobody has measured whether
a written learning changes a later session's behaviour, this option does not
measure it either, and 43 of its own 77 notes are about problems that had stopped
by the time they were written. **That is the case for running the fortnight
first** — `14-recommendation.md` step 2, unchanged — and for shipping Option G's
readout before either, since a recurrence card is Option I's input rendered
without the write, and an operator who never acts on a row of it has answered the
question for free.
