# Option E — The smallest thing that beats reading the log

Not a tree on a canvas. A **timeline of the run's turning points**, built from
`run_events` alone, in the panel style the run page already uses.

The test this option has to pass is not "is it a decision tree". It is: *does an
operator learn more from this in thirty seconds than from scrolling the log?* If
yes, it is worth shipping regardless of what else follows — and everything else
in this proposal can be built on top of it rather than instead of it.

---

## The insight

`00-problem.md` §5 established that `run_events` is already a typed per-run
stream. Its `kind` union (`src/lib/apiTypes.ts:1711`) is:

```
status | log | assistant | subagent | tool | tool_error | sandbox
      | iteration | budget | result | handoff | land | review | error | replay-complete
```

Read that as a decision vocabulary rather than a log vocabulary and most of the
work is done:

| kind | what it is, for a reader |
|---|---|
| `iteration` | **a work cycle began** — the top-level grouping, already a row |
| `assistant` | **the run said something** — its prose, already separated from its tools |
| `subagent` | **it delegated** — and this exists *nowhere in the transcript* |
| `tool_error` | **something failed** |
| `sandbox` | **the policy refused something** — its own kind, deliberately |
| `budget` | **the guard spoke** |
| `handoff` | **the run passed work on** |
| `result` | **it finished, and how** |
| `review` / `land` | **what happened to the work afterwards** |

Nine kinds, seven of which are turning points by construction. Someone already
did the hard part of deciding what matters in a run; it is sitting in a table
that only the log tab reads, and `runTasks(events): RunTask[]`
(`src/lib/runTasks.ts:189`) already proves the derivation pattern.

## What a node is

**One turning point.** A row whose `kind` is in the set above, rendered as a
line in a vertical timeline grouped by work cycle:

```
▸ WORK CYCLE 1                                                         02:05
  ⟩ "I'll start by reading the ground rules and the current state…"    assistant
  ✔ commit  Give the invisible t…                                      tool · git
  ✔ commit  Audit                                                      tool · git
  ✖ node -e '…'  → SyntaxError                                         tool_error
▸▸ COMPACTION  167,284 → 11,135 tok  ·  156,149 dropped                seam
▸ WORK CYCLE 2                                                         02:29
  ⟩ "Now the score table and the sensitivity paragraph:"               assistant
  ✔ commit  Hold the recommendation, a…                                tool · git
  …
▸ RESULT  done · 13 commits · 11 files · +1634 −74                     result
```

Not a graph. A list with two levels of nesting, which is what
`docs/agent/conventions.md`'s table-stacking rules already cover and what
`RunTasks.tsx` already looks like.

## What an edge means

**Nothing — there are no edges.** Sequence is the vertical axis and indentation
is containment. That is the entire simplification, and it is why this option is a
third the size of the others: no layout, no canvas, no `autoLayout`, no
`edgeGeometry`, no hit-testing, no pan/zoom, none of what
`docs/agent/conventions.md` requires of a `<canvas>`.

## Where the "why" comes from, and how faithful

Three first-hand sources, no inference at all:

| source | in run A | provenance |
|---|---:|---|
| `assistant` rows | 13 | **quoted** |
| commit subjects, from `tool` rows | 14 | **quoted** |
| `iteration` / `result` / seam metadata | 5 / 1 / 4 | **exact** |

Twenty-seven quoted lines and ten exact ones for a 58-minute run. Every line is
the run's own bytes or a number. The provenance chip (`08-…`) reads `quoted` or
`structural`, and the option cannot produce `inferred` because it never asks
anything to infer.

**A caveat that must be stated rather than glossed.** `run_events` has no
`tool_use.input`. A `tool` row carries what the orchestrator's stdout parser
extracted, not the full `file_path` / `old_string` / `new_string` / `command`.
Whether commit *messages* are recoverable from `tool` payloads alone is
**unverified** (`11-validation.md`), and if they are not, Option E either reads
the transcript for that one field — reintroducing the retention dependency for
the richest source — or shows the commits without their messages, which loses
the best `why` in the run. This is the option's sharpest open question.

## Sub-agents, forks, resumes

**Sub-agents: Option E's standout, and the thing that makes it more than a
consolation prize.** The transcript has zero sidechain records in 266,362. But
`kind = 'subagent'` rows exist (`src/lib/orchestrator.ts:7620`), written from
stdout as the sub-agent speaks.

So Option E shows something **no transcript-derived option can show at any
price**: what a delegated agent said while it worked, rather than a 2,288-byte
`<persisted-output>` stub pointing at a file the retention sweep does not know
about. Options A, B and C all draw a delegation as an opaque leaf. Option E draws
it as a nested set of lines.

For a fleet that delegates, this reverses the ranking entirely.

**Resumes:** `run_events` is keyed on `run_id`. A resumed run's events are one
stream with no work required — no session-id resolution, no double-count
hazard, no `resolveSessionTranscript` returning `null`. Option E is the only
option that gets resume right by construction rather than by handling it.

**Forks:** not present.

## The compaction seam, explicitly

Here is the wrinkle, and it is a genuine gap. **`run_events` has no compaction
kind.** The seam metadata that `02-…` §1 shows to be the richest structural
signal in the run — `preTokens`, `postTokens`, `cumulativeDroppedTokens`,
`preservedMessages.uuids` — lives only in the transcript.

Three ways out, in increasing order of cost:

1. **Say nothing.** The timeline shows cycles and turning points, with no seam.
   Loses C5, and loses the best explanation for apparently-redundant work.
2. **Read the seams from the transcript when it is there.** One targeted pass
   for `subtype === "compact_boundary"` records only — a filter over 1,292 lines,
   not a full fold — merged into the timeline. Degrades to (1) when the
   transcript is gone, and says so.
3. **Emit a `compaction` event kind.** `contextPruning.ts` already runs at the
   cycle boundary and `liveGuardTick`'s ceiling already watches context
   (`docs/agent/run-lifecycle.md`). Adding one `emit` at the boundary makes seams
   durable, first-party, and available to every option. One line in a closed
   union, one `emit` call.

**(3) is the right answer and it is small.** It also happens to be the single
highest-leverage change in this whole proposal: it makes compaction visible to
*every* option, and `docs/agent/run-lifecycle.md` already treats the boundary as
a first-class moment with a priced `trigger`.

## Cost per run

| | |
|---|---|
| model tokens | **zero** |
| storage | **zero new** — the rows exist |
| migration | **none**, unless (3) above |
| view-time | one `SELECT … WHERE run_id = ?`, already indexed |
| transcript read | **none**, unless the seam or commit-message gaps force it |

The cheapest option on every axis, including the one Option A loses on: it does
not put a 3.8 MB parse in front of the Land button (C3).

## Cost to build

| piece | size | notes |
|---|---|---|
| `runDecisions.ts` — fold over `RunEventDTO[]` | ~200 lines | `runTasks.ts:189` is the template, same input type |
| reuse the events the log tab already fetches | 0 | no new route needed if the panel shares the fetch |
| `RunDecisions.tsx` | ~250 lines | a list, not a canvas — no `docs/agent/conventions.md` canvas obligations |
| tab strip | 3 lines | `page.tsx:415`, `:474`, `:958` |
| `compaction` event kind (optional, recommended) | ~15 lines | union + one `emit` at the `contextPruning.ts` boundary |
| tests | ~150 lines | the fold is pure |

**1–2 days.** A third of Option A, an eighth of Option C.

## How it degrades

| situation | what the operator sees |
|---|---|
| transcript compacted | the timeline, complete. Seams only if (2) or (3) |
| **transcript swept by retention** | **the timeline, complete and unchanged.** `run_events` cascades on `runs`, not on the transcript |
| run crashed mid-task | every event up to the crash, plus the `error`/`result` row that says so — the orchestrator emits those on the failure paths |
| run reopened | events append; nothing to reconcile |
| run resumed under a new session | one stream, correct, no handling |
| run predates `run_events` for a kind | that kind's lines are missing; the rest renders |
| `emit()` dropped an event | a gap, silently — `docs/agent/architecture.md`'s persist-then-publish order is what bounds this |

Two blank rows fewer than every other option. This is what "smallest useful
thing" buys.

## What it deliberately does not do

- **No `rejected`.** Nothing in `run_events` records a path not taken. The brief
  asks for discards and this option does not attempt them.
- **No causal edges.** No `because`.
- **No graph.** An operator wanting to see branching structure visually gets a
  nested list instead.
- **No sub-branch structure within a cycle.** Option A's file-branch folding —
  "these 8 edits all concerned `16-comparison.md`" — needs `tool_use.input`,
  which `run_events` does not carry.

Those four omissions are the whole gap between E and the brief. They are also
exactly what A adds, which is why the two compose rather than compete.

## Where it is strongest

- **It ships in two days** and immediately beats the log tail.
- **It is immune to retention**, resume, and session-id ambiguity — the three
  things that break transcript-derived options.
- **It shows sub-agent output**, which no transcript-derived option can.
- **It costs nothing per run** and adds no state.
- **It cannot lie**, having nothing to infer with.
- **It is a foundation, not a dead end.** A/B/C/D all render into the same panel;
  E is the substrate they annotate.

## Where it is weakest

- **It is not a tree.** It answers "what were the turning points" and not "where
  did it branch and what did it discard".
- **It has no seams** without the `compaction` event kind.
- **Commit-message recovery from `tool` payloads is unverified**, and commit
  messages are the densest `why` in the run.
- **It depends on `emit()` having fired**, and `docs/agent/architecture.md`'s
  persist-then-publish order is the only thing guaranteeing it did.
