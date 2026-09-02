# Deduplication, and retiring a learning that is wrong

Two questions this feature has and a per-run one does not. Deduplication,
because a daily cadence sees the same material every night. Retirement, because
a note written on night 3 is still there on night 300, and the code it was about
has changed.

Both are measured here rather than reasoned about, and retirement is the axis on
which every written option fails.

---

## 1. Deduplication, measured

The proxy is the only machine-established fact a day's sessions carry in
quantity: a `tool_result` with `is_error`. Signatures are normalised
aggressively — numbers to `N`, hex runs to `HASH`, path interiors to `/PATH/`,
whitespace flattened, first 400 bytes — which makes this an **upper bound** on
how well a nightly writer could dedupe, because it dedupes strings it can see
rather than lessons it cannot. Reproduce with
`node proposals/Dreaming/scripts/recurrence.mjs ~/.claude/projects`.

| day | distinct signatures | seen on an earlier day | instances | from a signature seen earlier |
|---|---:|---:|---:|---:|
| 2026-08-10 | 53 | 0 (0%) | 92 | 0 (0%) |
| 2026-08-11 | 124 | 1 (1%) | 340 | 1 (0%) |
| 2026-08-12 | 24 | 7 (29%) | 46 | 26 (57%) |
| 2026-08-13 | 33 | 4 (12%) | 48 | 17 (35%) |
| 2026-08-14 | 80 | 10 (13%) | 148 | 60 (41%) |
| 2026-08-15 | 114 | 14 (12%) | 275 | 167 (61%) |
| 2026-08-16 | 133 | 9 (7%) | 172 | 20 (12%) |
| 2026-08-17 | 39 | 8 (21%) | 55 | 21 (38%) |
| 2026-08-18 | 26 | 1 (4%) | 209 | 1 (0%) |
| 2026-08-19 | 64 | 12 (19%) | 212 | 148 (70%) |
| 2026-08-20 | 5 | 1 (20%) | 5 | 1 (20%) |
| 2026-08-21 | 55 | 7 (13%) | 65 | 10 (15%) |
| 2026-08-22 | 67 | 8 (12%) | 81 | 12 (15%) |
| 2026-08-23 | 36 | 7 (19%) | 47 | 12 (26%) |
| 2026-08-24 | 66 | 10 (15%) | 79 | 14 (18%) |
| 2026-08-25 | 69 | 7 (10%) | 123 | 19 (15%) |
| 2026-08-26 | 76 | 8 (11%) | 113 | 41 (36%) |
| 2026-08-27 | 43 | 11 (26%) | 84 | 48 (57%) |
| 2026-08-28 | 120 | 20 (17%) | 193 | 90 (47%) |
| 2026-08-29 | 14 | 3 (21%) | 15 | 4 (27%) |
| 2026-08-30 | 61 | 14 (23%) | 70 | 20 (29%) |
| 2026-08-31 | 50 | 18 (**36%**) | 66 | 33 (50%) |
| 2026-09-02 | 7 | 4 (**57%**) | 9 | 6 (67%) |
| **total** | **1,359** | **184 (13.5%)** | **2,547** | **771 (30.3%)** |

And across the whole window: **77 of 1,175 distinct signatures (6.6%) span two
or more days, and they carry 1,260 of the 2,547 instances — 49.5%.** One spans
12 of the 23 days that have errors on them.

Three readings:

- **The naive nightly writer duplicates about a third of its output by
  instance and an eighth by distinct item, and the share climbs.** The last
  three days with material are 26%, 36% and 57% of distinct signatures already
  seen. That is not noise, it is the expected shape: the set of things this
  install can get wrong is finite, and the corpus of "already written" grows
  monotonically while the daily corpus does not.
- **The 6.6% that recurs is the half worth writing.** A signature seen on eight
  separate days is a standing property of the install, not an incident. A
  signature seen once may be a typo. So deduplication is not a tax on the
  feature — it is most of the feature's value, and a Dreaming with no dedup is
  writing the wrong half.
- **The measure is a floor on the problem and a ceiling on the solution.** Two
  failures with one cause produce two signatures (`bwrap` at `settings.json`
  and `settings.local.json` are one denial and one cause); one signature carries
  many causes (`Exit code N`, the top row, is a normalisation artefact). Neither
  direction is fixable by string matching, and a model asked to fix it is back
  to unverified judgement.

## 2. What each option would have to do about it

| option | dedup mechanism available | cost |
|---|---|---|
| A — nightly transcript | read the vault before writing, then decide "same lesson?" | a second read of the vault every night, plus a model judgement with no ground truth |
| B — nightly rows | same | same |
| C — failures-only | signature set persisted in this app; skip a signature already written | cheap and honest, and it dedupes *strings*, not lessons |
| D — question capture | one note per firing, by licence | none needed; the licence is the bound |
| E — a press | the operator remembers pressing it | none needed |
| F — composed workflow | **none** — a cold agent each night with no memory of the last | writes the same note thirty times |
| G — recurrence readout | it *is* the dedup | none |

The `A`/`B` row is the one to look at. "Read the vault, decide whether this
lesson is already there" is a retrieval-then-judgement step over 1,224 notes,
every night, with no verifier — and the vault's own conventions say what happens
when it gets it wrong: "Writing a second note on the same topic beside an
existing seed is the failure mode this convention exists to prevent"
(`_Meta/Vault Conventions.md:39`). The alternative, editing in place, is the
concurrency hazard `src/lib/knowledge.ts:39`–`:44` refuses by name.

## 3. Retirement, which every prior option in this repository forgot

A learning is a claim about a codebase that changes. Some claims stop being
true. Nothing in `proposals/ContinuousImprovement`'s eleven options,
`proposals/RunDecisionTree`'s five, or the brief for this one says what happens
then.

**The vault has the vocabulary and it is a person's to use.**
`_Meta/Vault Conventions.md:74`–`:76` — `seed` → `growing` → `evergreen` →
`archived`, where archived is "kept for the record, no longer maintained". Plus
`_to_delete/` at the vault root. That is the retirement mechanism, it exists,
and it is entirely manual: somebody edits `status:`, bumps `updated:`, and moves
the file. There is no `.git` behind it (`01-constraints.md` C4), so there is no
record of when a claim was true.

**The evidence says the reading agent will not catch a stale one.** From the
operator's own vault, `3 Resources/Questions/Does an Agent Defer to a Stale
Memory Over What It Can Observe.md`:

- `:27` — "shipped memory systems score **5.1% to 17.8%** at noticing their own
  memories have been invalidated, below plain models, and Zep, which ships the
  mechanism designed for exactly this, scores 6.0."
- `:37` — `[[Self-Correction and Reflection]]` (`confidence: high`): without an
  external verifier the model's own revision degrades, so "notice the conflict
  and reason it out" is the intrinsic case. `[[Sycophancy and Agreement Bias]]`
  (`confidence: high`): "one assistant wrongly admitting error on 98% of
  challenges and the best tested folding 32% of the time. A stale record **is** a
  stated position about the code."
- `:33` — "**retrieval selects, it does not average**", with AgentPoison
  (peer-reviewed) measuring a sub-0.1% poison rate producing over 80% attack
  success at under 1% degradation on benign tasks.
- `:67` — "**Recurrence is a rate, not an event** … an entry cannot be retired by
  a single successful observation either, so 'just re-verify before trusting' is
  more expensive than it sounds."

**The consequence for a daily writer is arithmetic.** Suppose a night's note is
wrong one time in twenty — better than the 14.2% failing-step localisation
`Can an Agent Write an Accurate Record of Its Own Failure.md:27` reports for the
nearest benchmark. Over a year that is eighteen wrong claims sitting in a
document store with no version control, no author field, and a retrieval layer
that selects rather than averages. There is no rate at which this is safe
without a retraction mechanism, because the mechanism is what bounds the
*consequence*, and the consequence does not scale with the rate.

## 4. Retirement, scored per option

| option | how a wrong item is found | how it is retracted | who can do it |
|---|---|---|---|
| A | by accident, months later | delete a file | whoever notices |
| B | by accident | delete a file | whoever notices |
| C | by accident | delete a file | whoever notices |
| D | at triage, by design — the folder is a review queue | delete one file from a quarantine | the operator, before it counts as content |
| E | by the person who pressed the button, on the day | delete a file | that person |
| F | by accident; nothing records that a vault write happened | delete a file | whoever notices |
| G | **not applicable — a count is not a claim** | n/a | n/a |

Two rows are qualitatively different from the rest. **D** because the quarantine
is a review queue that exists *before* the mistake, so "found by accident" never
arises — and because the licence's own template supplies the provenance fields
(`captured_by`, `captured_from`) and the `> [!warning] Unreviewed capture`
closing block that nothing else in this survey supplies. **G** because it makes
no claim to retract: a row saying "this string appeared on eight days" is either
arithmetic or a bug, and neither needs retiring.

Everything else in the table has the same answer in all three columns, and it is
the answer `01-constraints.md` C4 gives: a person, by hand, if they happen to
notice.
