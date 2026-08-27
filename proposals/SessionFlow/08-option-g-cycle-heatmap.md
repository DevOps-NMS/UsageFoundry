# Option G — a file × work-cycle grid

An inline-SVG grid: one row per touched file, one column per work cycle, each
cell marked read / edited / both. **The strongest visual candidate in the
survey**, and the only one that draws an actual flow — because the axis is time.

## The strongest case for it

**It is a flow, in the sense the request meant.** Left to right is earlier to
later. A file worked on across five consecutive cycles is a horizontal streak; a
file read once in cycle 1 and never again is a single mark near the left edge.
The picture has direction, which
[06-option-e](06-option-e-file-tool-graph.md)'s force graph structurally cannot.

**It answers a question in five seconds that takes minutes today.** *"Where did
this run start going in circles?"* A run that thrashes — reading and re-editing
the same three files across eight cycles — draws three long dense streaks and
nothing else. Reading that off the Log means scrolling a few hundred tool lines
and holding the pattern in your head. This is the clearest five-seconds-versus-
two-minutes case in the survey and it is the reason this option is not refused.

**It is a chart, not a canvas, and the app has decided how those are built.**
`docs/agent/conventions.md:65`: "**A chart small enough to read at a glance is
inline SVG, and it takes its colours as classes rather than as probed values.**"
`ContextOccupancy`'s sparkline is the named precedent, and it explicitly avoids
everything [C7](01-constraints.md#c7--there-is-one-2d-canvas-in-this-app-and-its-450-lines-of-plumbing-are-private)
makes expensive: no frame loop to end, no backing store to scale, no
`getComputedStyle` probe, no `MutationObserver`, no `ResizeObserver`. Colours are
Tailwind utilities on elements. The whole precedent component "is under 500 lines
including its copy" and there is no charting dependency in `package.json`.

**The data is already shaped for it.** Cycle boundaries are `kind: "iteration"`
rows in the same table (the kind union is at `src/lib/apiTypes.ts:1670-1718`), so
"which cycle" is a running count over the same ordered scan that produces the
paths — no join, no second query. The scan is index-covered per run by
`idx_run_events_run(run_id, id)` (`src/lib/db.ts:624-625`).

**And the accessibility pattern is already solved for exactly this shape.**
`conventions.md:65` describes `ContextOccupancy`'s split: `role="img"` with an
`aria-label` carrying the series' *shape*, plus "a `sr-only` `<Table>` for the
discrete events under it, which is the split a sparkline wants: a transcription
of five hundred coordinates is not a text alternative, and a list of the cuts
is." A grid's screen-reader form is a table — which is
[09-option-h](09-option-h-reconciliation-table.md), already being built.

## Why it is not the first thing built

### 1. Its row count is the number nobody has measured

The grid has one row per touched file. At 30 rows it is excellent. At 400 it is a
wall of pixels needing its own scroll region, sorting and a cap — and a cap on a
grid has to say what it dropped ([C4](01-constraints.md#c4--a-narrowing-control-says-what-it-left-out)),
which means the grid grows a header, a control and a hint, which is the table
underneath it plus a picture.

`/data` is empty ([00-problem.md](00-problem.md#what-this-survey-could-not-do)),
so **the touched-file count per run is unmeasured and this option's viability is
entirely a function of it.** Building the picture first means committing to a
layout before knowing whether it fits.

### 2. Its column count has no bound at all

Columns are work cycles. A run with no cycle cap has nothing bounding how many it
takes — the same fact that forced a per-run insert cap on `context_samples`
(`docs/agent/retention.md:14`: "a run with no cycle cap has nothing bounding how
many turns it takes, and a horizon alone would leave one such run unbounded for
as long as it lives"). A 60-cycle run gives 60 columns in a pane that is at most
a few hundred CSS pixels wide, so each column is under 5px and the "streak"
signal disappears into aliasing.

**Both axes are unbounded and neither has been measured.** That is two guesses in
one layout.

### 3. It reads only the "touched" half, so it inherits C11 alone

The grid is built entirely from tool events, so it goes blank at
`eventRetentionDays: 30` (`src/lib/settings.ts:819`,
`src/lib/retention.ts:145-151`) while the Changes tab beside it still renders
([C11](01-constraints.md#c11--the-two-sources-have-different-lifetimes-f6)). It
cannot show "changed but never touched" at all, because a `Bash` that wrote files
produces no `file_path` event — so the third and most interesting reconciliation
category ([F6](00-problem.md#f6)) is invisible in this view by construction.

### 4. It is strictly downstream of the table

Every cell of the grid is a row of the table plus a cycle index. The query is the
same query. **Nothing in this option is wasted by building the table first, and
the table produces the two numbers that say whether the grid fits.** The reverse
is not true: building the grid first means writing the cap, the sort and the
scroll region blind, then writing the table anyway for the `sr-only` alternative
the precedent requires.

## Verdict

**Not first, and explicitly not refused.** This is the recommended *second* step
and the only visual in the survey that survives its own scrutiny. It becomes
buildable the moment the table has been open on real runs for a week and the row
and column counts are known — at which point it is an inline SVG over a query
that already exists, with its text alternative already written.

If [12-recommendation.md](12-recommendation.md)'s first slice ships and the
median touched-file count comes back under about 60, **build this next and do not
re-survey it.**
