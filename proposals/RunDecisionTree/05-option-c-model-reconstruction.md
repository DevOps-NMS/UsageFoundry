# Option C — A model pass reconstructs the decisions and the rationale

Feed the run's decision skeleton to a second model and ask it: *where did this
run branch, what did it choose, what did it discard, and why?* Store the answer
as the tree.

This is the only option that produces a `why` on most nodes. It is also the only
option that can be **confidently wrong about a run nobody re-read**, which is why
`08-marking-inference.md` exists and why the numbers below are the easy part.

---

## What a node is

A **claimed decision**, not an act. Where Options A/B/E fold 297 tool calls into
a tree of things that happened, Option C asks a model to name the 8–20 moments
where the run had a real choice and to describe each as:

```jsonc
{
  "cycle": 3,                                   // structural, from the fold
  "at": "2026-08-22T02:45:29Z",                 // structural
  "anchors": ["uuid-a", "uuid-b"],              // structural — the records this rests on
  "decision": "Rewrote Option F's framing rather than adding a new option",
  "chosen":   "…",
  "rejected": ["…"],                            // the discards — the part only C attempts
  "why":      "Two of Option F's stated unknowns became answerable from the corpus",
  "why_provenance": "quoted",                   // 'quoted' | 'structural' | 'inferred'
  "why_quote": "Two of Option F's stated unknowns are now answerable from the corpus.",
  "confidence": "high"
}
```

The important field is `why_provenance`, and the important discipline is that
**the model does not get to choose it freely.** The extractor sets `quoted` only
when `why_quote` is a byte-exact substring of the transcript — verified in code,
not trusted from the model — and downgrades to `inferred` otherwise. A model that
paraphrases loses its `quoted` badge automatically.

`rejected` is what makes Option C worth the risk. Nothing else in the option set
attempts "what was discarded", because nothing else can: a rejected path that was
never taken leaves no tool call. It exists only in the thinking, which is
empty 28,857 times out of 28,857 — so `rejected` is **always** inference, and
must be typed that way at the schema level, never `quoted`.

## What an edge means

Two edge kinds, and the distinction is the whole difference from Option A:

- **sequence** — structural, as A. Free, sound.
- **`because` / `led_to`** — a claimed causal link between two decisions. This is
  the thing an operator actually wants and the thing the data does not contain.
  Rendered as a dashed edge with the inference chip, always.

## Where the "why" comes from, and how faithful

From a second Opus 5 (or Haiku/Sonnet) call over the **decision skeleton**
(`02-…` §3): tool calls reduced to name-plus-digest, assistant text in full,
tool results truncated to 240 characters, compaction markers, prompts to 400
characters. 616 lines, 139,089 bytes, 3.6% of the transcript.

Faithfulness, honestly stated, is a two-tier thing:

| field | faithfulness |
|---|---|
| `cycle`, `at`, `anchors` | **exact** — computed by the fold, never by the model |
| `why` where `why_provenance = quoted` | **verbatim**, verified as a substring in code |
| `decision`, `chosen` | **grounded** — a description of acts the skeleton contains |
| `why` where `why_provenance = inferred` | **a guess**, and the honest word is guess |
| `rejected` | **always a guess**, about a path that left no trace |

The distribution matters more than the tiers. Run A offers **13 quotable prose
blocks and 14 commit messages** for 297 acts. So a 15-node reconstruction can be
mostly `quoted` **if the extractor is disciplined about mapping quotes to nodes
and refusing to invent for the rest**, and will be mostly `inferred` if it is
asked for "a rationale for every decision". The prompt is the product here.

### The failure mode, concretely, from this run

Run A's five tool errors are all shell typos (`02-…` §1). A reconstruction
prompted to explain branch points will read:

```
DO(Bash): grep -n "COMPLETION_NOTICE\|NEEDS_REVIEW_NOTICE\|…"
ERR: Exit code 2  src/lib/agents.ts:428: *  keeps `SELF_HOSTING_NOTICE` —
DO(Bash): grep -n "…" -A 12 src/lib/agents.ts
```

and can very plausibly write *"the first search was too broad, so the run
narrowed it to the file it had identified"*. That reads well, it is the kind of
sentence the feature promises, and in this case the run simply mis-typed a
`grep` and re-ran it. **Five opportunities to fabricate in one run**, all of them
in the shape the model is most likely to narrativise.

This is not an argument against Option C. It is the specification for its
guardrails: refusal is a valid output, `confidence: low` must be renderable, and
the prompt must say that a mechanical retry is not a decision.

## Sub-agents, forks, resumes

**Sub-agents: the most dangerous node in this option.** The transcript has zero
sidechain records; a delegation is one call and one result, and sometimes the
result is a `<persisted-output>` stub. A model handed *"Agent 'Design
live-kill and pause/resume', prompt 9,145 B, result: Output too large (52.4 KB),
saved to …"* has everything it needs to write a confident three-branch account of
a sub-agent's reasoning **and no information about it whatsoever.**

The rule has to be mechanical, not prompted: a delegation node is
`why_provenance: absent`, `rejected: []`, and un-annotatable by the model.
Enforced in the extractor.

**Resumes:** Option C inherits whichever fold feeds it (A's or B's), so it
inherits A's blind spot or B's append. It adds one hazard of its own — a
reconstruction over a *partial* history will confidently explain a run whose
first three cycles it never saw, with no signal that anything is missing. The
skeleton must carry an explicit `[HISTORY BEGINS AT RESUME]` marker and the
prompt must be told what it means.

**Forks:** not present in this corpus.

## The compaction seam, explicitly

Two distinct obligations, and only the first is obvious.

**The seam is a node, as in A/B** — the harness dropped 156,149 tokens, and the
run's next decision was made without them. The reconstruction should be *told*
this, because it is the single best explanation available for a whole class of
apparently-redundant acts (cycle 3 re-reading what cycle 1 read).

**The seam bounds what the model may claim.** A causal edge that crosses a seam
asserts that decision N+1 was made in light of decision N, when the run
demonstrably could not see decision N — only the five records
`preservedMessages.uuids` names. Cross-seam `because` edges should be refused
outright, or emitted at `confidence: low` with the seam on the edge. Run A has
four seams and four cycles of work after them; this is not an edge case.

## Cost per run — measured, not estimated

Skeleton: 139,089 bytes → 53,702 tokens at the corpus-calibrated 2.59 B/token
(`02-…` §2; the ratio counts JSON punctuation, so this **over**-counts prose and
these are upper bounds). Output: a 15-node annotated tree ≈ 6,000 tokens.

```
node scripts/cost.mjs ~/.claude/projects/…/4c7c4e5c-….jsonl
```

| model | $/MTok in | $/MTok out | **cost per run** | as % of the run's $43.51 |
|---|---:|---:|---:|---:|
| Haiku 4.5 | 1 | 5 | **$0.0837** | 0.19% |
| Sonnet 5 (intro, to 2026-08-31) | 2 | 10 | **$0.1674** | 0.38% |
| Sonnet 5 (list) | 3 | 15 | **$0.2511** | 0.58% |
| Opus 5 | 5 | 25 | **$0.4185** | 0.96% |

**Under one percent of the run, at the top of the range.** For contrast, the
prose-only skeleton (22 lines, 7,922 B, ~3,059 tokens) costs $0.16 on Opus 5 —
but it discards the 297 acts that give the reconstruction anything to be
grounded *in*, which is exactly the trade that produces fabrication.

At 50 runs a week, the annual figures are $218 on Haiku, $1,088 on Opus 5.
Against a fleet whose individual runs cost $43.51, this is noise. **Cost is not
the objection to Option C and pretending otherwise would be dishonest.**

### Where the cost lands, and what it must respect (C8)

This is a **new class of model call**: made by the app, about a run, not by a run
about a repo. `docs/agent/architecture.md` enumerates the kinds of agent child
process and what bounds each, and this is not one of them. Four answers are
mandatory before it exists:

1. **It draws on the install ceiling's rolling 24 hours**, like a chat turn does
   (`docs/agent/budgets-and-guards.md`). A reconstruction is not exempt because
   it is small.
2. **It does not run when the guard has tripped.** A budget-exhausted operator
   getting a $0.42 surprise from opening a tab is the worst version of this
   feature.
3. **Its cost is attributed beside the run's total, not inside it** — the split
   `docs/agent/chat.md` already draws for a chat turn's cost. The run cost
   $43.51; the explanation cost $0.42; summing them misreports what the agent
   spent.
4. **It is off by default, or at minimum switchable off**, and the switch is in
   `Settings` (`saveSettings`, `docs/agent/conventions.md`).

## Cost to build

The largest of the five, and most of it is not the model call.

| piece | size | notes |
|---|---|---|
| Option A's fold + skeleton builder | ~500 lines | the skeleton is `scripts/skeleton.mjs` productionised |
| prompt + structured-output schema | ~150 lines | must force `why_provenance`, allow refusal, allow `confidence: low` |
| the call itself | ~120 lines | `claude-opus-5`; structured outputs via `output_config.format`; adaptive thinking |
| **quote verification** | ~60 lines | byte-exact substring check that downgrades `quoted` → `inferred`. **The load-bearing 60 lines** |
| seam and delegation guards | ~80 lines | refuse cross-seam causal edges; force `absent` on delegation nodes |
| budget integration | ~100 lines | install ceiling, guard check, settings switch, cost attribution beside the total |
| storage (Option B's schema + provenance) | ~120 lines | migration, extraction hook |
| `RunDecisions.tsx` + provenance rendering | ~600 lines | `08-marking-inference.md` is a real design surface, not a badge |
| tests | ~400 lines | quote verification and the guards are pure and silent-failing |

**8–12 days**, and the risk is concentrated in the parts that have no test: the
prompt, and whether the rendering actually stops an operator from over-trusting
an inferred sentence.

## How it degrades

| situation | what the operator sees |
|---|---|
| transcript compacted | the tree, with seams; causal claims across seams refused or low-confidence |
| transcript swept (post-extraction) | the stored tree, evidence links dead — inherits B |
| transcript swept (pre-extraction) | nothing, permanently |
| run crashed mid-task | **the dangerous case.** A partial skeleton reads like a complete run; the model will explain a truncated story as if it ended on purpose. The skeleton must carry the run's `stop_reason` and the prompt must be told the run failed |
| model call fails / rate-limited | fall back to Option A/B's structural tree. **This must be the designed path, not an error** — which means C is architecturally *A-or-B plus a layer*, and building it any other way is a mistake |
| budget guard tripped | no reconstruction; structural tree; a line saying why |
| model is confidently wrong | **no signal at all.** Nothing detects it. Only the provenance chip stands between the operator and the claim |

That last row has no mitigation, only mitigation-shaped things. It is the reason
this option's real cost is measured in trust rather than dollars.

## Where it is strongest

- **It is the only option that attempts `rejected`** — the discarded
  alternatives the brief explicitly asks for.
- **It produces a readable page.** 15 annotated decisions beats 297 acts with 13
  quotes, for a reader who wants to understand a run in two minutes.
- **It is genuinely cheap** — 0.19–0.96% of the run, measured.
- **It scales to the runs that need it most.** A 484-tool-call run (run B) with
  seven prose blocks is where structural options are thinnest and this one is
  unchanged.

## Where it is weakest

- **It can be confidently wrong and nothing will catch it.** Five shell typos in
  run A are five ready-made fabrications.
- **It is a new class of model call** with four budget/guard obligations before
  it may exist (C8).
- **It cannot expand a sub-agent** but will look like it could.
- **Its output is only as good as a prompt that nothing tests.** Every other
  option's core is a pure function with a failing test; this one's core is
  English.
