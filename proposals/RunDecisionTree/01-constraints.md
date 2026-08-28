# Constraints

What any design has to satisfy. These are not preferences; each one is either a
measured property of the data (`00-problem.md`), an invariant this codebase
already enforces, or a product commitment that follows from what the feature
claims to be. An option that breaks one is not a cheaper option — it is a
different, worse feature.

---

## C1. Inferred reasoning must be visually distinct from first-hand reasoning

The load-bearing constraint, and the one most likely to be quietly dropped.

A decision tree whose nodes say "chose X because Y" is making a claim about a
past run. `00-problem.md` §1 establishes that no such claim can be read off the
transcript for the model this app runs. So every `why` in the view is one of:

- **quoted** — the run's own bytes, verbatim, with an anchor;
- **structural** — derived from the shape of what happened (a file edited, then
  edited again; a command that failed, then a different command);
- **inferred** — a second model's account of what the first model was probably doing.

The third can be confidently wrong. A reconstruction that reads `git checkout -b
uf/x` → `Edit a.ts` → `git commit` and writes *"decided to branch before editing
so the change could be reverted"* is plausible, unfalsifiable, and possibly
untrue — the run may have branched because the harness told it to. (In this
codebase it does: the system prompt orders a branch before committing.) An
operator who cannot tell that sentence apart from a quoted one will trust it the
same amount, and the feature's value inverts: it becomes a machine for
manufacturing confident explanations of runs nobody checked.

`08-marking-inference.md` is the whole treatment. The constraint here is the
floor: **provenance is a property of every node, it is rendered, and it is not
collapsible into a footnote.**

The repository already holds this line elsewhere. `docs/agent/git-and-review.md`
records that no row may carry a success mark it did not earn, and that the three
ways of having nothing may never render as an empty list. Same instinct.

## C2. `unknown` renders as unknown

`docs/agent/metering.md` records the rule for the cost surfaces: a figure that
cannot be computed is shown as unknown rather than as zero. The same applies
here, sharpened by §2 of the problem: **most nodes will have no first-hand
rationale, and that must be visible rather than filled.**

A tree in which every node carries a confident sentence is, given 5,578 bytes of
prose across 297 tool calls, a tree in which ~290 sentences were invented. The
honest rendering of run A is mostly nodes that say what happened and decline to
say why.

## C3. No clock on the landing path, and no clock here either

`docs/agent/isolation-and-landing.md` records that nothing on the land path may
have a clock on it. A decisions view sits beside `review` and `land` in the same
tab strip (`src/app/runs/[id]/page.tsx:415`) and an operator reads it *before*
pressing Land. If building the tree can block, time out, or half-render, it will
do so at exactly the moment the operator is deciding whether to merge.

Concretely: a view-time derivation that walks a 3.8 MB transcript on every tab
click, or a model pass that runs when the tab opens, both put an unbounded wait
in front of a decision. Whatever the option, **opening the tab must be bounded
and must degrade to a partial tree rather than a spinner.**

## C4. The transcript is not permanent; the view must survive its deletion

`expiredTranscripts` (`src/lib/retention.ts:554`) deletes transcripts past the
horizon for sessions no run or chat may resume. `retentionCutoff` (`:107`)
returns `null` only when the operator has turned the horizon off.

So for every option, the question "what does an operator see for a run whose
transcript is gone?" has an answer, and **"an error" is not one of them**. The
acceptable answers are: the stored tree (if the option stored one), the
`run_events`-derived tree (which survives, §5 of the problem), or an explicit
*"the transcript for this run was swept on <date>; here is what the event log
still knows"*.

`docs/agent/retention.md` records what expires and what never does. A decisions
artifact is new state and has to be placed on that map deliberately — see C9.

## C5. The parent chain breaks, and the break must be shown, not smoothed

Run A compacted four times; `parentUuid` is null at each boundary and
`logicalParentUuid` resolves at all four (`00-problem.md` §6). Two failure modes
follow and both are forbidden:

- **Silently fragmenting** — following `parentUuid` alone yields five
  disconnected components and a tree that looks like five unrelated runs.
- **Silently bridging** — following `logicalParentUuid` without saying so
  produces one smooth tree across a seam where 156,149 tokens of context were
  dropped, which is a lie about what the run could see when it made the next
  decision.

The boundary is itself a decision-shaped event — the harness chose to drop
context — and `compactMetadata` already carries everything needed to render it:
`trigger`, `preTokens`, `postTokens`, `cumulativeDroppedTokens`,
`preservedSegment`. **A compaction is a node.**

## C6. A resumed session must not be counted twice

`00-problem.md` §6 shows resume writing a second copy of the history under a
derived (version-5) session id: `00ffb053…` and `db276def-3f4a-50ed…` hold 1,544
records and 252 tool calls each. And `resolveSessionTranscript`
(`src/lib/transcripts.ts:1062`) returns `null` when a basename matches more than
one file, by design.

So an option that walks transcripts must state, for a resumed run, whether it
produces one tree, two, or none — and the answer must not be "two", which shows
an operator the same 252 decisions twice under different headings.

`docs/agent/run-lifecycle.md` records `startsFresh` and which flags `--resume`
does not restore; a decisions artifact keyed on the wrong identity inherits that
whole class of bug.

## C7. Sub-agent work is a leaf in the transcript and a subtree in `run_events`

Zero sidechain records in 266,362 (`00-problem.md` §4). A transcript-derived
tree can draw a delegation as one node and nothing more; when the sub-agent's
report exceeded ~50 KB even the report is a `<persisted-output>` pointer.

`run_events` has a `subagent` kind (`src/lib/apiTypes.ts:1711`, emitted at
`src/lib/orchestrator.ts:7620`). So the *app* has material the transcript does
not.

The constraint is that the option says which it used, and that the view does not
render a leaf as if it were a complete account of a delegated decision. A node
reading `Agent "Explore orchestrator run loop" → 40,268 bytes returned` is
honest. The same node with an invented three-branch subtree beneath it is not.

## C8. Nothing new spawns a model call the operator did not ask for

`docs/agent/budgets-and-guards.md` records what counts as "off" and what asks
for an uncapped loop; `docs/agent/architecture.md` records the kinds of agent
child process and what bounds each. A reconstruction pass is a **new class of
model call** — one made by the app about a run, rather than by a run about a
repo.

It therefore has to answer, before it exists: what budget does it draw on, does
it respect the install ceiling's rolling 24 hours, does it run when the operator
is over budget, and can the operator turn it off. `05-option-c…` §"Where the
cost lands" is where that is settled; the constraint is that it *is* settled and
not left to the implementation.

Measured stake: an Opus 5 reconstruction of run A costs **$0.42** against a run
that cost **$43.51** — under 1%. Cheap is not the same as automatic.

## C9. New persistent state goes on the retention map and through `migrate()`

`CLAUDE.md`: schema changes are idempotent statements in `migrate()` in
`db.ts`, and a destructive one runs inside a single `db.transaction`.
`docs/agent/retention.md` records what expires and on which horizon.

An option that stores a tree adds a table or a column, and both a migration and
a retention answer are part of its cost — not follow-up work. An option that
stores nothing skips both, and that is a real part of its case.

## C10. The tab strip's vocabulary is closed and the copy says "work cycle"

`type RunTab = "log" | "report" | "changes" | "review" | "land"`
(`src/app/runs/[id]/page.tsx:415`), consumed at `:474`, `:703`, `:958`. Adding a
sixth member is a one-line change in three places plus a panel — cheap, and the
right slot: between `report` (what the run says) and `changes` (what it did).

`CLAUDE.md`: **the UI says "work cycle", the code says "iteration".** The tree's
top-level grouping is the work cycle — run A had five, one per SDK prompt — and
the rendered label is "work cycle" while the `run_events` kind stays
`iteration`.

`docs/agent/conventions.md` governs the rest: how variants are typed, what a
`"use client"` file may import, how a `<canvas>` reads a colour and sizes itself
and stops, and when a poll stands down. A decisions canvas is a `<canvas>` and
inherits all of it.

## C11. Reuse the layout that ships

`autoLayout(blocks: readonly {id}[], links: readonly {from, to}[]): Map<string,
Point>` (`src/lib/canvasGraph.ts:149`) is a layered DAG layout that already
tolerates cycles and missing endpoints, with `layoutBounds` (`:243`) and
`edgeGeometry` (`:283`) beside it. A decision tree is `{id}[]` plus
`{from, to}[]`. **There is no new layout algorithm in this feature**, and an
option that proposes one is proposing avoidable work.

`forceLayout.ts` (`createSimulation` `:151`, Barnes-Hut `buildQuadtree` `:224`)
is the wrong instrument: a run's decisions are rooted, ordered and temporal, and
a force simulation deliberately discards all three.

## C12. Read-only, and no second reading of the repository

The view explains a finished run. It does not re-run anything, does not touch
the worktree, and does not run `git` commands that could race the merge queue.
Where it wants commit messages, it reads them the way `src/lib/git.ts` already
does, under the flags `docs/agent/git-and-review.md` fixes — pinned pathspecs,
`GIT_CONFIG_COUNT`, and the rule about which call site may run a check.

## C13. Scale: the biggest artifact must not be the one that breaks

Run A: 1,292 records, 297 tool calls, 3.84 MB. Run B: 1,464 records, 484 tool
calls. The largest transcript in the corpus is 2,450 records with 433 tool
calls. `MAX_TRANSCRIPT_FILES = 20_000` (`src/lib/retention.ts:574`) is the
existing bound on a walk of the tree of transcripts.

A tree with ~300–500 leaf nodes is not a rendering problem; it is a *reading*
problem. Whatever the option, the default view cannot be 300 nodes on a canvas —
it has to collapse to the branch points and expand on demand. `07-option-e…`
takes that constraint seriously enough to make it the entire design.

---

## What is explicitly out of scope

- **Live decisions during a running run.** The reader in the brief is opening a
  *finished* run. A live view has different guards (`liveGuardTick`, the poll
  rules in `docs/agent/conventions.md`) and is a separate feature.
- **Cross-run comparison.** "How did this run differ from the last one" is a
  fleet question, not a run-page question.
- **Changing what the agent is allowed to do.** Option D changes what the agent
  is *asked to write* (`08`, `06`); no option changes its permissions, its
  argv beyond an added flag, or the guard order in `orchestrator.ts`.
