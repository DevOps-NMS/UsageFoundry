# Option C — the failures-only pass

The strongest automatic form. The nightly child is not asked "what was learned
today"; it is handed the day's **machine-established failures only** — every
`tool_result` with `is_error`, or every `run_events.kind IN ('tool_error',
'sandbox')` — and asked to write down what would have avoided each one. It never
sees a session's prose, never asks a run how it felt about its own work, and
never writes about anything that went right.

| | |
|---|---|
| **fires** | a clock, or a threshold on the error count |
| **reads** | tool results with `is_error` — 0.90 MB across 24 days, 2,548 blocks |
| **writes** | markdown into `/workspace2`, or a table in this app |
| **authors** | a model, over a machine-established fact |
| **retracts** | a person; the fact is checkable, the diagnosis is not |
| **costs** | **$0.06 a night** at Opus input, $0.42 a week |

---

## The strongest case

**This is the form that survives the external-verifier objection, and it
survives it for a reason already established in this repository.**
`proposals/ExternalValidator`'s offline spike found that handing a validator the
run's own final turn — testimony, in its words — changed **zero of eight
verdicts** (`proposals/ExternalValidator/README.md:30`). That result is about
*introspection*. A model shown `bwrap: Can't create file at …: Permission
denied` and an exit code is reading an artefact the harness recorded, which is
the posture `buildPrompt` (`src/lib/review.ts:518`) already takes when it hands
a reviewer a diff and withholds the event log.
`proposals/ContinuousImprovement/10-option-retrospective.md:53`–`:57` makes the
argument in those terms, and it transfers to Dreaming unchanged.

**It is the cheapest option in the survey by an order of magnitude.** The whole
error corpus is 0.90 MB — 37 KB a night, 10.9k tokens, **$0.055 at Opus input,
$0.011 at Haiku 4.5**. A week is 42 cents. Against a $956.09 day that is
0.006%. No budget guard in this app would notice it, which is both the argument
for it and, in `14-recommendation.md`, part of the argument against relying on
guards to bound this class of feature.

**The corpus is real and it is not thin.** ContinuousImprovement refused Option
G partly on "a corpus with two ending-level failures in 294 runs". That is the
*endings*. The tool-level corpus measured here is **2,548 error blocks over 24
days, 1,175 distinct signatures, mean 106 a night** — and the eight that recur
across the most days are ordinary, fixable, and exactly the kind of thing a
person would want written down:

```
 12 days  Exit code N
 11 days  The user doesn't want to proceed with this tool use…
  8 days  pdftoppm is not installed. Install poppler-utils…
  8 days  error: .bash_profile: can only add regular files, symbolic links…
  8 days  bwrap: Can't create file at /PATH/settings.local.json: Permission denied
  8 days  bwrap: Can't create file at /PATH/settings.json: Permission denied
  7 days  File content (N tokens) exceeds maximum allowed tokens (N)…
  7 days  This command requires approval
```

**And it splits cleanly along the line the operator's own vault draws.**
`3 Resources/Questions/Can an Agent Write an Accurate Record of Its Own
Failure.md:27` states the working position as "admit transcription, mark
diagnosis as a hypothesis, and never let an unverified stated cause enter a
store as a fact." Option C's input is pure transcription — the error string is
what the machine said. Its output is diagnosis. If the note it writes marks the
two apart, it is the only automatic option in this directory that complies with
the position the vault already holds.

## Where it breaks

**The corpus is 49.5% duplicate by instance.** 77 signatures span two or more
days and carry **1,260 of the 2,547 instances**; 30.3% of a night's instances
carry a signature seen on an earlier night, and that share climbs as the corpus
grows — 13.5% of a night's *distinct* signatures were seen before across the
whole window, but 36% on 2026-08-31 and 57% on 2026-09-02. Left alone, Option C
writes the `bwrap` note eight times. `11-deduplication-and-retirement.md`
handles this and the handling is not free.

**Half the top signatures are not learnings at all.** `Exit code N` at 12 days
is a normalisation artefact carrying no information. `The user doesn't want to
proceed with this tool use` at 11 days is a *person declining*, which is not a
failure to learn from. `This command requires approval` at 7 days is a
permission prompt. A nightly writer that cannot tell those apart from
`pdftoppm is not installed` produces a note that is mostly noise, and telling
them apart is itself a judgement call made by the model, unverified.

**The two failures with one cause problem, in both directions.** The signature
is a normalised string. Two different causes can share one — `Exit code N`
demonstrates it — and one cause routinely produces several: this session alone
produced `bwrap: Can't create file at …/settings.json` and
`…/settings.local.json` and `…/launch.json` and `…/skills`, four signatures, one
cause, none of which is about the command that triggered them. A count of
signatures is not a count of lessons and the survey does not claim it is.

**And it still writes.** Every objection in `10-the-write-path.md` applies:
`knowledge.ts:39`, `AGENTS.md:115`, `qc.py`'s ERROR families, the missing
`.git`. Making the input honest does not make the output licensed.

## The variant that is nearly a recommendation

Option C has a form that removes almost every objection: **write the transcribed
half and not the diagnosed half, and write it here rather than there.** No model
in the loop, no vault write, no clock that spends. That is
`09-option-g-the-recurrence-readout.md`, and it scores as a separate option
because it is a materially different feature — it stops being Dreaming and
becomes a report.

## If it is routed through `src/lib/review.ts`, three defects at HEAD

Checked against the tree at HEAD rather than repeated from
`proposals/ContinuousImprovement`. **All three still reproduce**; one has moved
line and one has a docblock that now contradicts the code.

1. **`assistTimeoutMs` (`src/lib/review.ts:78`–`:79`) is a ternary on one
   member**: `kind === "resolve" ? 0 : REVIEW_TIMEOUT_MS`. A third `AssistKind`
   silently inherits the review's ten-minute clock (`:69`) with no typecheck
   error. The docblock immediately above it, `:65`–`:67`, says the split is made
   at this function "so a third kind cannot inherit a clock by accident" — which
   is what the code does. The comment describes the intent; the ternary
   implements the opposite.
2. **`describeEvent` mislabels it.** `src/lib/logLine.ts:558`–`:561`:
   `const label = p.assist === "resolve" ? "resolve" : "review";`. A third kind
   is logged as a review. **The line number in the earlier survey (`:480`) is
   wrong at HEAD; the defect is at `:561`.**
3. **The install ceiling cannot see it.** `installSpend`
   (`src/lib/installBudget.ts:79`–`:136`) sums `runs`,
   `workflow_instance_blocks` and `chat_turn_spend`, and **not** `run_reviews`.
   `installBudgetRefusal` (`:162`) has no caller in `review.ts` — the callers
   are `workflows.ts`, `orchestrator.ts` and `chat.ts`. And `--max-budget-usd`
   is pushed at exactly one site, `src/lib/cycleInvocation.ts:1117`;
   `spawnAssist`'s argv (`review.ts:612`–`:656`) carries `--permission-mode`,
   `--model`, agent args, `--allowedTools` and sandbox args, and nothing
   denominated in money.

At $0.055 a night the third defect is harmless in this option specifically, and
that is precisely why it is worth naming: **the guard that would have caught an
expensive mistake is not watching, and this option is too cheap to reveal it.**

## Verdict

**Refuse as an automatic writer; keep its input.** Option C picks the right
corpus — machine-established, cheap, non-introspective — and then does the one
thing the evidence says not to do with it. Its transcription half is the best
material in the survey and reappears as the recommendation; its diagnosis half
is unverified, its cadence is a clock, and its sink is a vault that has said no.
