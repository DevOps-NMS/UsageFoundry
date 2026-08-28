# Option A — Derived at view time from the transcript, nothing stored

Open the tab; the server reads the run's transcript, folds it into a tree, and
returns it. No table, no migration, no background work, no model call. The tree
is a **pure function of the transcript**, recomputed on every request.

This is the option the codebase's own instincts point at. `runTasks(events):
RunTask[]` (`src/lib/runTasks.ts:189`) is exactly this shape already — a pure
derivation over a stream, called at read time — and `docs/agent/testing.md`'s bar
("a pure function whose failure mode is silent gets a unit test") is a bar this
option can actually meet.

---

## What a node is

A node is **one act the run took**, folded upward into the smallest structure a
reader can hold. Four levels, all derived:

| level | node | derived from |
|---|---|---|
| 0 | the run | `runs` row |
| 1 | **work cycle** | a `user` record with string content and `promptSource: "sdk"` — 5 in run A |
| 2 | **branch** | a maximal contiguous stretch of tool calls sharing a subject: a `file_path` for Read/Edit/Write, a first-token+first-argument key for Bash (`git commit`, `npm run typecheck`, `node -e`) |
| 3 | **act** | a single `tool_use`, its `tool_result`, and any assistant `text` block that immediately precedes it |

Plus two node kinds that are not acts and must not be folded into them:

- **seam** — a `system/compact_boundary` record. Carries `trigger`, `preTokens`,
  `postTokens`, `cumulativeDroppedTokens` and the `preservedMessages.uuids`
  list, all present in `compactMetadata` (`02-…` §1).
- **terminus** — a branch that ends in a commit. Detected as a Bash `tool_use`
  whose command matches `git commit`, with the message lifted out of the
  command string (heredoc-aware — eleven of run A's fourteen commits use
  `git commit -F - <<'EOF'`).

Run A folds 1,292 records → **5 cycles, 12 file-branches + ~30 command-branches,
297 acts, 4 seams, 14 termini**. The default view shows levels 0–2; level 3
expands on click. That collapse is not a nicety — C13 says a 300-node canvas is
unreadable, and level 2 is the level at which run A fits on one screen.

## What an edge means

**Sequence, within a scope.** Edge `a → b` reads *"b is the next act in the same
branch"*, or at level 2, *"this branch followed that one in the same cycle"*.

It deliberately does **not** mean causation. Nothing in the transcript licenses
"the run edited `16-comparison.md` *because* the read of `01-constraints.md`
returned X" — that is the inference C1 forbids unmarked, and Option A does not
make it at all.

Two edge kinds carry more than sequence, and both are structural rather than
inferred:

- **revisit** — a branch whose subject was already the subject of an earlier
  branch in the same run. Ten of run A's twelve edited files were touched more
  than once. A revisit is the strongest structural evidence of a reconsidered
  decision anywhere in the data, and it is free.
- **crossing** — an edge that passes through a seam. Rendered differently, per
  C5, with the dropped-token count on it.

## Where the "why" comes from, and how faithful

Four sources, all first-hand, in descending order of density:

| source | in run A | faithfulness |
|---|---:|---|
| commit message (from `tool_use.input.command`) | 14, most multi-paragraph | **verbatim** — the run's own words about a completed decision |
| assistant `text` block | 13 blocks, 5,578 B | **verbatim**, but eleven-twelfths is stage direction |
| the final report | 1 block, 4,873 B | **verbatim**, and it is the run's *summary*, not its reasoning |
| `compactMetadata` | 4 seams | **exact** — numbers, not prose |

And that is the whole list. Option A has **no** inferred `why` at all, which is
its central property: every sentence in the view is a quote or a number. The
provenance chip on every node (`08-marking-inference.md`) reads `quoted` or
`structural`, never `inferred`, and the tab can honestly say so at the top.

The cost is bluntness. Run A's tree has 13 quoted annotations for 297 acts.
Roughly 95% of nodes will render *what* and, per C2, an explicit "no rationale
recorded" rather than a filled-in one.

**Commit messages are the quiet win here.** They are the only dense first-hand
source in the run, they are not surfaced by any existing panel (`RunDiff` shows
the range, `RunTouches` shows files, neither shows the message), and Option A
gets them for free because they are already sitting in the Bash `tool_use`
inputs the walk is reading anyway.

## Sub-agents, forks, resumes

**Sub-agents: a leaf, and it says so.** Zero sidechain records in 266,362
(`00-…` §4). A `Task`/`Agent` call becomes one node: the description, the prompt
length, the result length, and the result's first lines. When the result is a
`<persisted-output>` stub the node says *"report was 52.4 KB, written to a file
outside the transcript"* rather than pretending 2,288 bytes is the report. **The
node is explicitly marked as unexpandable** — otherwise an operator reads a
delegated decision's absence as a delegated decision's simplicity.

Option A leaves `run_events`' `subagent` rows (`src/lib/apiTypes.ts:1711`,
emitted `src/lib/orchestrator.ts:7620`) on the table. That is the seam where
Option E beats it.

**Forks: not a thing in this corpus.** No transcript here branches within itself;
resume-forks appear as separate files (below).

**Resumes: the real hazard, and Option A's worst failure mode.** A resume writes
a *second copy* of the history under a version-5 session id (`00-…` §6:
`00ffb053…`/`db276def-3f4a-50ed…`, 1,544 records and 252 tool calls each). Two
outcomes, both bad if unhandled:

- `resolveSessionTranscript` (`src/lib/transcripts.ts:1062`) matches on basename
  and returns `null` unless **exactly one** file matches. `runs.session_id` holds
  one id, so it resolves that one file and the duplicate is simply another
  session — no double count. **This is the saving grace and it is already in the
  code.**
- But the tree then covers only the segment `runs.session_id` points at. A run
  resumed under a new id, whose `session_id` was updated, shows the *post*-resume
  work as the whole run — silently. Option A must render *"this run's transcript
  begins at a resume; N earlier records are in session `<prev>`"*, detectable
  because a resumed transcript's first records replay a history whose
  `sessionId` differs from the filename. If it does not, the tree lies by
  omission about where the run started.

## The compaction seam, explicitly

Follow `parentUuid`, and run A becomes five disconnected components (102 null
parents). Follow `logicalParentUuid` at boundaries — which resolves 4 times out
of 4 — and it becomes one tree with four marked seams.

Option A does the second, and renders the seam as a node carrying
`156,149 / 309,026 / 467,899 / 626,408` cumulative dropped tokens and the five
uuids that crossed. The sentence an operator gets is *"the run below this line
could not see the 22 files it read above it"*, and it is derived exactly from
`preservedMessages.uuids`, not estimated.

## Cost per run

**Zero model tokens. Zero storage.** The only cost is the walk.

Run A: 3,838,145 bytes, 1,292 records, JSON-parsed once. On the order of
40–80 ms of CPU and ~4 MB of transient memory in Node — measurable, not free,
and paid **on every tab open and every refresh**. `docs/agent/conventions.md`
governs when a poll stands down; a decisions panel must not poll a finished run
at all, which makes this once per navigation rather than once per second.

The honest risk is the tail: `MAX_TRANSCRIPT_FILES = 20_000`
(`src/lib/retention.ts:574`) bounds the tree-of-transcripts walk, but
`resolveSessionTranscript` calls `listTranscriptFiles(PROJECTS_DIR)` — a
directory walk — *before* it opens anything. On a machine with 875 transcript
files that is cheap; it is not obviously cheap at 20,000, and C3 forbids an
unbounded wait in front of the Land button. The mitigation is the existing
offset cache in `transcripts.ts`, not a new one.

## Cost to build

The smallest of the five. No migration, no table, no new child process, no
model integration.

| piece | size | notes |
|---|---|---|
| `runDecisions.ts` — the pure fold | ~350–450 lines | mirrors `runTasks.ts`; reuses `parseToolRecord` (`toolComposition.ts:124`) |
| `GET /api/runs/[id]/decisions` | ~40 lines | must export what `docs/agent/conventions.md` requires and set its own `Cache-Control` |
| `RunDecisions.tsx` + canvas | ~400–500 lines | `autoLayout` (`canvasGraph.ts:149`) unchanged; `edgeGeometry` (`:283`), `layoutBounds` (`:243`) |
| tab strip | 3 lines | `RunTab` union at `page.tsx:415`, `:474`, `:958` |
| DTOs | ~60 lines | `apiTypes.ts`, list-DTO conventions |
| unit tests | ~250 lines | the fold is pure and silent-failing — `docs/agent/testing.md`'s bar, met |

Call it **2–3 days**, and it is the only option whose core is a pure function
with a test that can actually fail.

## How it degrades

| situation | what the operator sees |
|---|---|
| transcript compacted | the full tree, with seams marked and dropped-token counts — **the good case**, because the metadata is richer than the records it replaced |
| transcript swept by retention | **nothing.** `resolveSessionTranscript` returns `null` and the tab is empty. This is Option A's defining weakness and it is not a bug — the state genuinely is gone |
| run crashed mid-task | a partial tree, ending wherever the transcript ends, with the last branch open. Nothing special is needed: the fold has no terminator |
| run never got a session id | empty, same as the log tab already does |
| session id ambiguous across projects | `null` by design (`transcripts.ts:1062`); render *"this run's transcript could not be resolved unambiguously"* |
| 484-tool-call run (run B) | fine — the fold is linear and run B has fewer prose nodes, not more |

The retention row is the one that decides whether this option can stand alone.
`expiredTranscripts` (`src/lib/retention.ts:554`) will eventually delete every
finished run's transcript unless the operator turns the horizon off, and on that
day every decisions tab in the history goes blank at once. Option B exists
because of that row; Option E dodges it by not depending on the transcript.

## Where it is strongest

- **It cannot lie.** Every annotation is a quote or a number. In a feature whose
  main hazard is manufactured explanation (C1), an option that structurally
  *cannot* infer is worth a great deal.
- **It is reversible.** Nothing is stored, so a bad fold is a deploy away from
  fixed — including retroactively, for every historical run. Options B and D
  bake their decisions into rows that a later improvement cannot reach.
- **It is testable.** A pure fold over a fixture transcript is exactly the kind
  of function `src/lib/transcriptWalk.test.ts` already covers.

## Where it is weakest

- **It goes blank on retention**, permanently and for every historical run at once.
- **13 annotations for 297 acts.** It shows the shape of the reasoning and
  almost none of the reasoning.
- **It re-walks 3.8 MB on every tab open**, in front of the Land button.
- **It leaves `run_events` unused**, including the `subagent` rows that are the
  only record of delegated work anywhere in the system.
