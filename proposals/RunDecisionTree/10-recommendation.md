# Recommendation

**Ship E, then A-folded-into-E. Do not build C. Run D as an experiment first.**

Concretely, in order:

| phase | what | days | ships what |
|---|---|---:|---:|
| **0** | a `compaction` event kind at the `contextPruning.ts` boundary | 0.5 | seams, to every option |
| **1** | **Option E** — the `run_events` timeline, in a new `decisions` tab | 1–2 | turning points, sub-agents, results |
| **2** | **Option A's fold, merged into E's panel** — file-branches, revisits, commit messages, seams | 2–3 | the tree |
| **3** | *(measure)* **Option D as an experiment** — the appended prompt, on 10 runs, counting compliance | 1 | evidence |
| **4** | **Option D or Option B**, whichever phase 3 argues for | 3–5 | first-hand `why`, or durability |

Phases 0–2 are **3.5 to 5.5 days** and produce a decision tree with 27 quoted
annotations, four rendered seams, expandable sub-agents, and no inference
anywhere. That is the feature.

---

## Why E first, when it is not the brief

The brief asks for a tree. Option E is a list. Shipping it first is not a retreat
from the ask; it is a consequence of two measurements.

**`run_events` is already a decision vocabulary.** Its `kind` union
(`src/lib/apiTypes.ts:1711`) separates `assistant` from `tool` from `tool_error`
from `subagent` from `iteration` from `sandbox` from `result`. Somebody already
decided what matters in a run, wrote it down as a closed type, and wired the
orchestrator's stdout parser to emit it (`src/lib/orchestrator.ts:7483–7812`).
The log tab is the only thing that reads it. Building a decisions view that
ignores this and re-derives everything from a 3.8 MB file would be strange.

**It is the only cheap option that gets the three structural problems right.**

- *Retention*: `run_events` cascades on `runs`, not on the transcript.
  `expiredTranscripts` (`src/lib/retention.ts:554`) will eventually delete every
  finished run's transcript; E does not notice.
- *Resume*: keyed on `run_id`, so a resumed run is one stream. No
  `resolveSessionTranscript` returning `null`, no double-count, no session-id
  reconciliation.
- *Sub-agents*: **zero sidechain records in 266,362**, and `kind = 'subagent'`
  rows exist anyway. E shows what a delegated agent said. No transcript-derived
  option can do this at any price, and two of run A's peer sessions had their
  sub-agent reports replaced by `<persisted-output>` stubs pointing at files
  nothing tracks.

Two days for that, before anything else is built, is the best trade in the set.

## Why A's fold on top, not instead

E alone leaves the brief's actual ask unanswered — it has no branches, no
revisits, and no seams. A's fold supplies exactly those, and needs the one thing
`run_events` lacks: `tool_use.input`.

Three things become possible only with the transcript, and all three are the
richest structural signals in run A:

- **File-branches and revisits.** Ten of run A's twelve edited files were touched
  more than once. A file edited, left, and returned to is the clearest structural
  evidence of a reconsidered decision in the whole dataset, and it needs
  `file_path`.
- **Commit messages.** Fourteen commits, eleven with heredoc bodies, sitting in
  `tool_use.input.command`. `"Retire the PreCompact hook from Phase 0b, and count
  the fields"` states a decision and its scope. This is the densest first-hand
  `why` in the run and **no existing panel shows it** — `RunDiff` shows the
  range, `RunTouches` shows files, neither shows what the run said when it
  committed.
- **Seam detail.** `preservedMessages.uuids` — which four records survived — is
  what turns "it compacted" into "the run below this line could not see the 22
  files it read above it."

Merged into E's panel rather than replacing it: E's rows are the spine, A's fold
adds nesting and annotation, and when the transcript is gone the spine remains
and the panel says so. That is C4 satisfied without B's schema.

## Why phase 0 is first, and half a day

Emitting a `compaction` event kind — one member of a closed union, one `emit`
call at the boundary `contextPruning.ts` already owns — makes the seam durable
and available to every option including E.

Run A compacted **four times in 58 minutes**, dropping 626,408 cumulative tokens.
This is not a corner case; after the tool call it is the most common structural
event in a long run. Fifteen lines make it permanent, first-party, and
independent of whether the transcript still exists. It should be done first
because everything downstream renders it.

## Why not C — the runner-up, and why it lost

**Option C is the runner-up on ambition and it lost on trust, not on money.**

It is the only option that attempts what the brief actually asks for: *what was
rejected, and why*. It is the only one that produces a readable annotated page
rather than a structured one. And it is genuinely cheap — measured, not
estimated: **$0.42 per run on Opus 5 against a run that cost $43.51**, 0.96%;
$0.08 on Haiku 4.5. At fifty runs a week that is $1,088 a year on the most
expensive model. Nobody would decline this feature over the money and it would be
dishonest to pretend otherwise.

It lost for four reasons, in order of weight.

**1. It can be confidently wrong and nothing detects it.** Run A's five tool
errors are all shell typos — a stray `ls` flag, an unterminated `node -e`, a
mistyped `grep`. Every one of them presents to a reconstruction as *"tried X,
found it inadequate, narrowed to Y"*, which is exactly the sentence the feature
promises and exactly the sentence that is false here. **Five fabrication
opportunities in one run**, all in the shape a model most wants to narrativise.
The only defence is the provenance chip, and the only test of the provenance chip
is whether a human notices.

**2. There is very little for it to be right about.** The reconstruction reads
5,578 bytes of prose and 14 commit messages. That is the same first-hand material
Options A and E read for free. C's added value is entirely in the gaps — and a
model asked to explain 297 acts from 13 sentences is being asked to invent, by
construction. Given more material to work with (Option D's declarations), C
becomes a much better idea; given run A as it stands, it is mostly generation.

**3. It cannot expand a sub-agent, but will look like it could.** Handed
*"Agent 'Design live-kill and pause/resume', prompt 9,145 B, result: Output too
large (52.4 KB), saved to …"*, a model has everything it needs to write a
confident account of a delegated decision and no information about it at all.
Option E shows what that sub-agent actually said; C would explain what it
probably thought.

**4. It is eight to twelve days whose riskiest component is a prompt that
nothing tests.** Every other option's core is a pure function with a failing
test — `CLAUDE.md`'s stated bar. C's core is English, and ~600 of its lines are
the provenance rendering that exists solely to contain its own failure mode.

**What would change this verdict.** C becomes the right call if (a) Option D
ships and the runs start producing declarations, so C is verifying and linking
quotes rather than filling gaps; or (b) the acceptance test in
`08-marking-inference.md` — *show an operator a tree with one fabricated
rationale; can they find it?* — passes convincingly. Both are cheap to check and
neither has been checked. **C is deferred, not rejected**, and the sequencing
above is what makes deferring it safe: phases 0–2 build the substrate C would
render into.

## Why D is an experiment before it is a phase

Option D scores second (146 to E's 153) and has the best `why` in the entire
set — first-hand, at the moment of the decision, at **under $0.05 a run**. It
also sees inside sub-agents and handles resume for free. On the numbers it is the
best annotation strategy available.

Three things are unknown about it, and all three are cheap to find out:

1. **Will the agent comply?** Run A wrote eleven "Now the score table…" narration
   blocks and zero `TodoWrite` calls under a prompt that did not ask for either
   pattern. Whether an explicit `⟦decision⟧` instruction produces useful
   declarations or more stage direction is an empirical question with an
   empirical answer: ship the prompt to ten runs and count.
2. **Does the appended prompt reach sub-agents?** The claim that a delegated
   agent's markers reach `run_events` is **unverified** (`11-validation.md`) and
   it is one of D's two best properties.
3. **Does it change what the runs decide?** Unmeasurable in advance, and the only
   real objection to the whole approach.

**One day of experiment gates three to five days of build**, and the experiment's
result also decides the phase-4 branch: if compliance is good, build D; if it is
poor, build B and accept a durable-but-thin tree.

## Why not B, for now

Option B is Option A's fold with a table under it. It is correct, and its case is
entirely retention: when `expiredTranscripts` runs, A's tree vanishes and B's
does not.

But the phase-2 merge already covers most of that gap. E's spine — cycles,
turning points, sub-agents, results, and (after phase 0) seams — survives
retention without any new schema. What is lost when the transcript goes is
file-branches, revisits and commit messages. That is a real loss and it is a
*degradation*, not a blank page, and the panel can say which state it is in.

B costs a table, a migration, a retention-map entry
(`docs/agent/retention.md`), extraction hooks on every terminal path including
the failure and set-aside paths, and idempotence against `reopenPrompt`. It also
**freezes an interpretation before the interpretation has been iterated on** —
and the window to re-derive closes exactly when the transcript does.

The right time to build B is after the fold has stopped changing. Building it in
phase 2 would bake version one of a fold into every historical run.

The one configuration where this reverses: if the operator's retention horizon is
short and the fleet's history matters, B moves ahead of D in phase 4. The
sensitivity table in `09-comparison.md` shows the flip.

## Why not A alone

`09-comparison.md`'s sensitivity table has no row in which A alone is the best
move. With retention on it goes permanently blank; with retention off it beats B
and still loses to E. It also puts a 3.84 MB parse in front of the Land button
(C3), which E does not.

A's fold is the right *component* — phase 2 — and the wrong whole.

## What the operator gets at each phase

**After phase 1 (2 days).** A `decisions` tab showing run A as five work cycles,
each with the run's own sentences, its commits, its failures, sandbox refusals,
budget events, and — where a run delegated — what the sub-agent said. Every line
is the run's bytes or a number. Compared to the log tail this is not a small
improvement; it is the difference between 1,292 records and roughly forty lines.

**After phase 2 (5 days).** The same, as a tree: cycles containing file-branches
containing acts, with revisit edges on the ten files run A returned to,
compaction seams carrying their dropped-token counts and the *"could not see"*
sentence, and commit messages as the terminus of each branch. Twenty-seven quoted
annotations, four seams, twelve branches, fourteen termini, zero inferences.

**After phase 4.** Either a first-hand `why` on the branch points of every new
run (D), or a durable tree for every run regardless of retention (B).

## What is deliberately not being built

- **No causal edges.** Nothing in the data licenses "because", and
  `08-marking-inference.md` explains why an unlicensed "because" is worse than
  silence.
- **No `rejected` column** until D ships. A path not taken leaves no trace;
  guessing at it is the fabrication risk in its purest form.
- **No canvas in phase 1.** `docs/agent/conventions.md`'s canvas obligations —
  how a `<canvas>` reads a colour, sizes itself and stops — are real work, and a
  nested list answers the question for two days' effort. Phase 2 adds the canvas
  using `autoLayout` (`src/lib/canvasGraph.ts:149`) unchanged.
- **No new layout algorithm**, in any phase. `autoLayout` takes `{id}[]` and
  `{from, to}[]`; a decision tree is that.

## The one-line version

The reasoning is gone, the narration is 5.5 KB per 297 acts, and the sub-agents
are invisible in the transcript and visible in the database — so build the tree
out of what the app already recorded, put the transcript's structure on top of
it, and do not let a second model fill the silence until something has given it
words to work from.
