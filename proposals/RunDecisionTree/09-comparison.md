# Comparison

Five options, scored against the constraints in `01-constraints.md` and the
measurements in `00-problem.md` / `02-what-a-run-leaves-behind.md`. Every number
in the first table is measured or counted; nothing here is an impression.

---

## 1. The facts side by side

| | **A** view-time | **B** stored | **C** reconstructed | **D** declared | **E** smallest |
|---|---|---|---|---|---|
| source | transcript | transcript, frozen | transcript + a model | the run itself | `run_events` |
| node = | act | act (row) | **claimed decision** | declared decision + acts | turning point |
| edge = | sequence | sequence | sequence + **causal** | **containment** | *(none — a list)* |
| `why` provenance | quoted / structural | quoted / structural | all four | **declared** | quoted / structural |
| **quoted annotations, run A** | **27** | 27 | 27 + ~9 inferred | ~15 declared + 27 | **27** |
| attempts `rejected` | no | no | **yes (inferred)** | **yes (declared)** | no |
| model tokens per run | 0 | 0 | 53,702 in / 6,000 out | ~900 out | 0 |
| **$ per run** | **$0** | **$0** | **$0.08 – $0.42** | **< $0.05** | **$0** |
| as % of run A's $43.51 | 0% | 0% | 0.19 – 0.96% | ~0.1% | 0% |
| view-time work | **3.8 MB parse** | indexed query | indexed query | indexed query | indexed query |
| new schema | no | **yes** | **yes** | 1 union member | no (or 1) |
| **build** | 2–3 d | 3–5 d | **8–12 d** | 4–6 d | **1–2 d** |
| retroactive to existing runs | **yes** | yes* | yes* | **no** | **yes** |
| survives retention | **no** | yes | yes | yes | **yes** |
| resume handled | badly | yes (append) | inherits | **free** | **free** |
| sub-agent visible | leaf | leaf | leaf | **expandable** | **expandable** |
| compaction seam | yes | yes, durable | yes + bounds claims | **degrades** | no† |
| can be confidently wrong | **no** | no | **yes** | no‡ | **no** |

\* only while the transcript survives to be extracted from.
† unless a `compaction` event kind is added — one union member and one `emit`.
‡ the run can misdescribe itself; that is a commit-message-grade risk, not an inference-grade one.

## 2. Constraint compliance

| | C1 mark inference | C2 unknown | C3 no clock | C4 retention | C5 seam | C6 resume | C7 subagent | C8 model call | C9 schema | C13 scale |
|---|---|---|---|---|---|---|---|---|---|---|
| **A** | trivially | yes | **fails** | **fails** | yes | **fails** | leaf | n/a | none | collapse |
| **B** | trivially | yes | yes | yes | yes, durable | yes | leaf | n/a | table + retention | collapse |
| **C** | **the work** | yes, if forced | yes | yes | yes + bounds | inherits | leaf | **4 obligations** | table + retention | 15 nodes |
| **D** | trivially | yes | yes | yes | **degrades** | yes | **subtree** | n/a | 1 union member | spine |
| **E** | trivially | yes | yes | **yes** | **no**† | **yes** | **subtree** | n/a | none | list |

Three rows do the deciding.

**C3 + C4 are where A loses.** A re-parses 3.84 MB in front of the Land button
and goes permanently blank when `expiredTranscripts` (`src/lib/retention.ts:554`)
runs. Both are structural, neither is fixable inside A.

**C6 + C7 are where E wins unexpectedly.** `run_events` is keyed on `run_id`, so
resume is free; and `kind = 'subagent'` (`src/lib/orchestrator.ts:7620`) records
what the transcript's **zero** sidechain records cannot. The cheapest option is
the only cheap option that gets both right.

**C1 is where C pays.** It is the only option that can be wrong, so it is the
only option that owes the full provenance surface (`08-marking-inference.md`,
~600 lines of the ~8–12 days).

## 3. What each one is actually for

Not a ranking — the options answer different questions and it is worth being
explicit about which.

- **A** answers *"show me this run's shape, from the record, with nothing added."*
  The purist option. Correct and blunt.
- **B** answers *"keep that shape after the transcript is gone."* A plus durability,
  minus the ability to improve retroactively.
- **C** answers *"tell me why, even though nobody wrote it down."* The only option
  that attempts the brief's full ask, and the only one that can invent.
- **D** answers *"make the next run write it down."* The best `why` in the set and
  zero coverage of the runs that already exist.
- **E** answers *"what were the turning points."* Not the brief's tree, but a
  third of the cost and the fewest blank states.

## 4. The scoring

Weights reflect what the brief asks for and what the measurements showed to be
scarce. Faithfulness is weighted highest because `00-problem.md` established
that the `why` is the scarce resource and `08-marking-inference.md` established
that a wrong `why` is worse than none. 1–5, higher is better.

| criterion | w | A | B | C | D | E |
|---|---:|---:|---:|---:|---:|---:|
| **faithfulness of the `why`** | 5 | 4 | 4 | **2** | **5** | 4 |
| **density of the `why`** | 4 | 2 | 2 | **5** | 4 | 2 |
| answers "what was rejected" | 3 | 1 | 1 | **4** | **5** | 1 |
| retroactive coverage | 4 | **5** | 4 | 4 | **1** | **5** |
| survives retention | 4 | **1** | 5 | 5 | 5 | **5** |
| sub-agent visibility | 3 | 2 | 2 | 2 | **5** | **5** |
| resume / seam correctness | 3 | 2 | 4 | 4 | 3 | 4 |
| cost to build (inverse) | 4 | 4 | 3 | **1** | 3 | **5** |
| cost per run (inverse) | 2 | 5 | 5 | 4 | 5 | 5 |
| risk of misleading the operator (inverse) | 5 | 5 | 5 | **2** | 4 | 5 |
| **weighted total** | **37** | **118** | **132** | **118** | **146** | **153** |

```
node scripts/score.mjs      # recomputes this table and the sensitivity runs below
```

### Reading the totals honestly

**E wins on the numbers and does not win the brief.** It scores 153 while
declining to build a tree, to attempt `rejected`, or to draw an edge. Its win is
real — it is the cheapest, the least blank, and the only cheap option that sees
sub-agents and survives resume — but a weighted score that rewards "does less,
correctly" over "does what was asked, riskily" is measuring feasibility, not
value. The score is evidence, not the verdict.

**C ties A for last, and cost is not why.** $0.42 against $43.51 is 0.96%; at 50
runs a week it is $1,088 a year on the most expensive model, against a fleet
whose individual runs cost forty dollars. C loses on the two 5-weighted rows —
faithfulness and the risk of misleading — and on eight to twelve days of build
whose riskiest component is a prompt that nothing tests. It scores level with the
option that does a tenth of the work.

**D scores second and has the best `why` in the set**, at under $0.05 a run. Its
1 for retroactive coverage is doing all the damage — worth 20 of the 37 points
between it and E — and it is a permanent 1: no existing run can be made to have
declared anything.

**A and B are the same fold with a different lifetime.** B's +14 is retention,
resume and taking the parse off the read path, minus a build day.

### Sensitivity

The ranking is not stable, and it is worth saying exactly where it breaks:

| variation | A | B | C | D | E | winner |
|---|---:|---:|---:|---:|---:|---|
| base | 118 | 132 | 118 | 146 | **153** | E |
| "retroactive coverage" → weight 2 | 108 | 124 | 110 | **144** | 143 | **D**, by one |
| "density" → 5, "risk of misleading" → 3 | 110 | 124 | 119 | 142 | **145** | E |
| fleet delegates heavily (A/B/C sub-agent → 1) | 115 | 129 | 115 | 146 | **153** | E |
| retention horizon off (weight 0) | **114** | 112 | 98 | 126 | **133** | E, and **A overtakes B** |

Three things fall out of that table.

**E's win is robust but not total.** One plausible re-weighting flips it — an
operator who cares about future runs more than history gets D by a single point,
which is a tie in everything but arithmetic. That is the strongest argument for
doing both.

**C never wins under any weighting tried.** Even doubling the value of `why`
density and halving the penalty for misleading leaves it fourth. Its problem is
not the weights.

**A only becomes defensible when retention is off**, and even then it beats B
rather than E. There is no configuration in this set where building A alone is
the best move.

## 5. What composes and what does not

The options are not five alternatives; three of them are layers on one substrate.

```
        ┌─ C  reconstruction  ─────┐   annotates
        │                          ▼
   D ───┼──────────────►  a rendered decision view
declared│                          ▲
        └─ A/B  transcript fold ───┘   structures
                     ▲
                     │  substrate
                E  run_events timeline
```

- **E is the substrate.** Cycles, turning points, sub-agent output, results — from
  a table that survives everything. Every other option renders into the same panel.
- **A/B add structure.** File-branches, revisits, seams, commit messages — the
  things that need `tool_use.input`, which only the transcript has.
- **C adds annotation.** Rationale on nodes A/B leave blank. It must fall back to
  A/B's structural tree when the call fails or the guard trips, which means it is
  *architecturally* A-or-B plus a layer and cannot sensibly be built first.
- **D changes the input.** It makes future runs produce material A/B/E can render
  without inference — and it makes C's job easier by giving it quotes to verify
  against instead of gaps to fill.

**The one genuine conflict is A vs B**, and it is a single question: is the
retention horizon on? If yes, B. If no, A, and B becomes premature.

**The one genuine incompatibility is C vs C1**, and it is not resolved by
building C carefully. It is resolved by the acceptance test in
`08-marking-inference.md` §"The acceptance test", which should be run before C is
committed to rather than after it is built.

## 6. The cross-cutting change nobody's option owns

Emitting a `compaction` event kind at the `contextPruning.ts` boundary — one
member of a closed union (`src/lib/apiTypes.ts:1711`), one `emit` call — makes
the seam durable and available to **every** option, including the two that
currently cannot see it.

Run A compacted four times in 58 minutes, dropping 626,408 cumulative tokens. The
seam is not a corner case in this codebase; it is the most common structural
event in a long run after the tool call itself. Fifteen lines make it visible
everywhere.
