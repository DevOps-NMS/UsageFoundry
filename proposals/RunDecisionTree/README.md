# RunDecisionTree

**A view that shows how a finished run got where it did** — its branch points,
what it chose, what it discarded, and why — for an operator who has read the log
tail and the diff and still does not understand the run.

An option set, not a plan. Read `00-problem.md` first: one measurement in it
decides most of the design, and it is not the one the brief expected.

---

## The finding that shapes everything

**The model's reasoning is not in the transcript, and for the model this app runs
it never is.** Across 266,362 records on this machine, `claude-opus-5` produced
**28,857 `thinking` blocks with zero non-empty bytes**. Every record carrying an
`effort` field is empty, 28,859 times without exception. The eleven non-empty
blocks in the entire corpus are Haiku 4.5 probe sessions replying `"ok"`.

So "the reasoning behind each decision" cannot be lifted. It has to come from
somewhere else, and every option names its source and says how faithful it is.

Three more measurements narrow it further:

- **The run barely narrates.** A 58-minute, 297-tool-call run wrote **5,578 bytes
  of assistant prose** — eleven stage directions totalling 680 bytes, one
  sentence that states a reason, and a 4,873-byte final report. Zero `TodoWrite`
  calls, in both runs measured.
- **Sub-agents leave nothing.** `isSidechain: true` appears **0 times in 266,362
  records**. A delegation is one tool call and one result, and when the result
  exceeds ~50 KB even that is a `<persisted-output>` pointer.
- **`run_events` already knows more than the transcript does.** Its `kind` union
  (`src/lib/apiTypes.ts:1711`) separates `assistant` from `tool` from
  `tool_error` from **`subagent`** from `iteration` — a decision vocabulary,
  written as the run happened, that survives the transcript's deletion and
  records delegated work the transcript throws away.

## Recommendation, in one line

**Ship E, then A folded into E. Do not build C yet. Run D as an experiment
first.** Phases 0–2 are 3.5–5.5 days and produce a tree with 27 quoted
annotations, four rendered compaction seams, expandable sub-agents, and no
inference anywhere. `10-recommendation.md` has the sequencing and why C — the
runner-up — lost on trust rather than on money.

---

## The files

| | |
|---|---|
| [`00-problem.md`](00-problem.md) | What is recoverable and what is not, measured. The empty-thinking re-verification, the 5,578 bytes of prose, the zero sidechain records, what `run_events` already carries, and what compaction and resume do to the chain. |
| [`01-constraints.md`](01-constraints.md) | Thirteen constraints. C1 (mark inference), C3 (no clock in front of Land), C4 (survive retention) and C7 (sub-agents) are the ones that decide the ranking. |
| [`02-what-a-run-leaves-behind.md`](02-what-a-run-leaves-behind.md) | The grounding run, censused field by field — plus **the tree it actually produces**, drawn. Why the two runs the brief named could not be used. The bytes-per-token calibration and the decision skeleton. |
| [`03-option-a-derived-at-view-time.md`](03-option-a-derived-at-view-time.md) | **A — derive from the transcript on every request, store nothing.** Cannot lie, improves retroactively, goes permanently blank when retention runs. |
| [`04-option-b-extracted-once-stored.md`](04-option-b-extracted-once-stored.md) | **B — the same fold, run once at the terminus, stored as rows.** Survives retention and resume; freezes an interpretation before it has been iterated on. |
| [`05-option-c-model-reconstruction.md`](05-option-c-model-reconstruction.md) | **C — a second model reconstructs the decisions and the rationale.** The only option that attempts *what was rejected*, and the only one that can be confidently wrong. Costed in real numbers. |
| [`06-option-d-first-hand-log.md`](06-option-d-first-hand-log.md) | **D — the run writes its own decision log**, as markers the stdout parser turns into `run_events`. The best `why` in the set, under $0.05 a run, and zero retroactive coverage. |
| [`07-option-e-smallest-useful-thing.md`](07-option-e-smallest-useful-thing.md) | **E — a timeline built from `run_events` alone.** Not a tree. Two days, zero new state, immune to retention and resume, and the only cheap option that can show a sub-agent. |
| [`08-marking-inference.md`](08-marking-inference.md) | How the view marks an inferred rationale apart from a first-hand one. Four provenance values, the byte-exact verification rule, where inference is refused outright, and the acceptance test. |
| [`09-comparison.md`](09-comparison.md) | The table, the weighted score, four sensitivity runs, and what composes with what. |
| [`10-recommendation.md`](10-recommendation.md) | The phased plan, and why C is the runner-up and lost. |
| [`11-validation.md`](11-validation.md) | Every claim re-checked, with the command. Three sections: verified, **corrected** (six things the brief or an earlier draft got wrong, including two of this proposal's own numbers), and **not verified** (seven claims that stand on reasoning, each flagged where it is used). |
| [`scripts/`](scripts/) | Nine dependency-free Node scripts. Every number in this proposal comes out of one of them. |

## The options at a glance

| | source of the `why` | $/run | build | retroactive | survives retention | sees sub-agents | can be wrong |
|---|---|---:|---:|---|---|---|---|
| **A** view-time | quoted + structural | $0 | 2–3 d | yes | **no** | leaf | no |
| **B** stored | quoted + structural | $0 | 3–5 d | yes* | yes | leaf | no |
| **C** reconstructed | a second model | $0.08–$0.42 | 8–12 d | yes* | yes | leaf | **yes** |
| **D** declared | **the run, at the time** | < $0.05 | 4–6 d | **no** | yes | **yes** | no |
| **E** smallest | quoted + structural | $0 | **1–2 d** | yes | **yes** | **yes** | no |

\* only while the transcript survives to be extracted from.

Weighted totals — A 118, B 132, C 118, D 146, **E 153** — with the weights and
four sensitivity runs in `09-comparison.md`, recomputable via
`node scripts/score.mjs`.

## Reproducing the measurements

```sh
cd proposals/RunDecisionTree
T=~/.claude/projects/-workspace--uf-worktrees-usagefoundry-721638d11c0b-1/4c7c4e5c-9581-4e38-8e4a-f73cbe1eec1d.jsonl

node scripts/thinking-by-model.mjs   # the empty-thinking re-verification, corpus-wide
node scripts/census.mjs "$T"         # records, tools, prose, seams, parent-chain integrity
node scripts/types.mjs  "$T"         # record-type histogram, null-parent breakdown
node scripts/seams.mjs  "$T"         # compaction metadata, attachments, prompt sources
node scripts/decisions.mjs "$T"      # prose blocks, commit messages, tool errors, verbatim
node scripts/calib.mjs  "$T"         # bytes-per-token, from the transcript's own usage deltas
node scripts/skeleton.mjs "$T"       # the decision-bearing 3.6% of a transcript
node scripts/cost.mjs   "$T"         # what the run cost, and what a reconstruction would
node scripts/score.mjs               # the comparison table's arithmetic
```

Node ≥ 20, no dependencies, read-only.

## What this proposal does not do

No change under `src/`. No route, component, table or migration. The
implementation sketch is the phase table in `10-recommendation.md`; the
constraints an implementer must not break are in `01-constraints.md`, and each
one routes to the `docs/agent/` file that owns it.
