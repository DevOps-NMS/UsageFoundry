# Recommendation

**Do not build a visual flow graph.** Build
[Option H](09-option-h-reconciliation-table.md), the touched/changed
reconciliation, as a sorted list with counts under the run page's existing
Changes tab — not a tenth pane, not a sixth tab, not a canvas.

## The one sentence for the operator

The events that would feed a flow view are already recorded and already
queryable, but the only relations in them are "a tool touched a file" and "a
sub-agent was delegated to" — a bipartite star and a two-level tree — so the
picture that data can honestly draw is a table, and the table answers three
questions the Log and Changes tabs cannot answer at all.

## What is refused, by name

| Refused | On what ground |
|---|---|
| **A tenth pane** | `docs/agent/ui-density-audit.md:159-161` names it. No tenth digit; and it fails the `/knowledge` test — it *is* about an existing pane — in the same paragraph that granted the only exception ever granted |
| **A sixth tab** | `docs/agent/conventions.md:50` caps a strip at five; `docs/agent/ui-density-audit.md:1122` freezes this strip at "five labels, the order"; `:178` closes the sub-strip escape |
| **A node-and-edge canvas** | Every candidate edge is a hub spoke, a clique or a timeline; `capGraph` prunes hubs-first, which is backwards here; an edge cannot say "attempted"; and the cost is a second copy of a 450-line canvas whose shareable half (`canvasView.ts`) was documented at `src/lib/forceLayout.ts:7` and never written |
| **A fleet-wide view** | Different subject, the full scan `fileCostNotice.ts:303-308` already refused an index for, and no `base..branch` to reconcile against |
| **A per-call failure mark, in the first slice** | `run_events` stores no `tool_use` id (`orchestrator.ts:7576-7594`), so a failure joins to its call only by a 160-character flattened command string — wrong exactly in a retry loop |
| **An index on `run_events`** | `fileCostNotice.ts:303-308` decided this and the reasoning is about the write side, which a read feature does not reopen |

## What is deferred rather than refused

[Option G](08-option-g-cycle-heatmap.md), the file × cycle grid. It is the only
visual in the survey that survives its own scrutiny, it genuinely has direction
in it — which is what "flow" asked for — and it is inline SVG rather than a
canvas, on the `ContextOccupancy` precedent at `docs/agent/conventions.md:65`.

It is deferred for one reason: **both of its axes are unbounded and neither has
been measured.** The first slice prints both numbers. If the median touched-file
count comes back under about 60 and the median cycle count under about 25, build
it next and do not re-survey it.

## What would overturn this

**One number: the distinct-file count of a real run's tool events, and its
spread across runs.** Every argument against a picture here is an argument about
node counts and pruning, made from an empty database — `/data` holds nothing
(`ls -la /data`) and no `*.db` exists in the checkout, so **nothing in this
directory has seen a stored payload**.

If a typical run touches 200–800 distinct files *and those files cluster by
directory*, then the file tree itself is a real hierarchy present in the paths,
and a treemap or an indented tree becomes a serious option. That is a different
option from the force graph refused in
[06-option-e](06-option-e-file-tool-graph.md), and this survey did not weigh it
because it could not know whether its premise held.

The query that settles it is in
[13-validation.md](13-validation.md#the-one-number-that-decides-everything) and
is one line.

## Two corrections to file, found while looking for something else

Neither blocks anything; both cost an hour to rediscover.

1. **`src/lib/orchestrator.ts:9876`** asserts "`run_events` has no retention." in
   the docblock over `FOLDER_TAKEN_REASON`. `src/lib/retention.ts:145-151`
   deletes `run_events` on a 30-day horizon. The argument the comment supports is
   unaffected; the fact is false.
2. **`src/lib/forceLayout.ts:6-8`** says the world/screen transform and hit
   testing "lives in `canvasView.ts` and is imported by both". That module does
   not exist (`glob src/lib/canvasView.ts` → nothing; a repo-wide grep for
   `canvasView` returns only the comment), and there is no "both" — there is one
   2D canvas in the app.

And three documents disagree about the pane ceiling in ways worth fixing if
anyone touches `panes.ts` again: `panes.ts:15-16` says "Knowledge is the ninth"
when Knowledge is seventh (`panes.ts:36`) and Settings is ninth (`panes.ts:38`);
`docs/agent/conventions.md:50` still says the list is "closed at eight" and still
bans "a ninth pane" while `conventions.md:57` in the same file counts nine.
`docs/agent/ui-density-audit.md:159-170` is the one that is right and it is the
one carrying the reasoning.

---

# The first shippable slice

One sitting, one follow-up run. Written so an agent with no memory of this survey
can implement and verify it without reading the rest of the directory.

## Scope

A per-run reconciliation of the files a run's tool events named against the files
its branch diff changed, shown under the existing Changes tab on
`/runs/[id]`. **No new pane, no new tab segment, no canvas, no new route
directory beyond the one handler, no schema change, no new emit site, no index.**

## Build

**1. `src/lib/runTouches.ts`** — new module. Two exports:

- `runTouches(runId: string): TouchRow[]` — reads `run_events` for that run,
  `kind = 'tool'`, extracting `json_extract(payload, '$.name')`,
  `json_extract(payload, '$.input.file_path')` and
  `json_extract(payload, '$.subagent')`. Relativise the path against
  `COALESCE(runs.work_dir, runs.folder)` then `runs.folder`, exactly as
  `src/lib/fileCostNotice.ts:334-344` does — copy that CASE expression rather
  than reinventing it, and read the docblock at `fileCostNotice.ts:320-327`
  first, because keying on the wrong column returns an empty result for every
  worktree-isolated run and looks like a working query. **Unlike
  `readCountsFor`, keep the rows the CASE leaves NULL** — those are touches
  outside the checkout and they are group 4 — and do **not** filter to
  `$.name = 'Read'`.
- `reconcileTouches(touches: TouchRow[], changed: readonly string[]): TouchReport`
  — **pure**, no database, no filesystem. Groups into `changedNotTouched`,
  `touchedAndChanged`, `touchedNotChanged`, `outsideCheckout`, each sorted by
  descending total call count then by path.

**2. `GET /api/runs/[id]/touched`** — `src/app/api/runs/[id]/touched/route.ts`.
`export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`
(`docs/agent/conventions.md:11`). Answers 200 with a `kind` discriminant, never a
404 or 500 for an ordinary empty outcome — the pattern and its reasoning are at
`src/app/api/runs/[id]/diff/route.ts:11-21`. Four `kind`s:

- `"swept"` — the run is terminal **and** `finished_at` precedes
  `retentionCutoff(getSettings().eventRetentionDays)`
  (`src/lib/retention.ts:107-110`), so its events were deleted by
  `retention.ts:145-151`. Decidable from the run row and the setting; no second
  query.
- `"empty"` — events present, none naming a file.
- `"none"` — no such run, or the run has no branch to diff.
- `"report"` — the four groups.

**3. `src/components/RunTouches.tsx`** — one `ListGroup` with a `label` per
non-empty group, a `Table` inside each with `stack` on
(`docs/agent/conventions.md:25`), rendered under `RunDiff` inside the Changes
tab. The **path** cell carries no `label`, being the headline the record is
identified by; every other cell carries one. Fetch on mount of that tab only —
the tab is already the only one mounted (`docs/agent/conventions.md:20`) — and
do not add it to the 3-second poll.

**4. Rename the tab label from `Changes` to `Files`.** The `RunTab` union value
stays `"changes"`; only the label string at
`src/app/runs/[id]/page.tsx:963` changes. Three of the four groups are about
files that did *not* change and a label has to cover what is under it
(`docs/agent/conventions.md:50`). This reopens one clause of
`docs/agent/ui-density-audit.md:1122` by name — that line freezes "five labels,
the order", and this changes a label without changing the count or the order.

**5. `src/lib/runTouches.test.ts`** — unit tests over `reconcileTouches` only.
It is a pure function whose every failure mode is silent, which is the bar
`CLAUDE.md` sets and `docs/agent/testing.md` records; read that file before
adding anything beyond it.

## Acceptance criteria

Numbered so a reviewer can check them one at a time. 1–7 are verifiable by
`npm test` and `npm run typecheck` alone; 8–11 need a container and a run.

1. **Given** a run whose events include `Read` of `<work_dir>/src/a.ts` and
   `Edit` of `<work_dir>/src/b.ts`, **and** a branch diff listing `src/b.ts` and
   `src/c.ts`, **when** `reconcileTouches` is called, **then**
   `changedNotTouched` is `["src/c.ts"]`, `touchedAndChanged` is `["src/b.ts"]`,
   `touchedNotChanged` is `["src/a.ts"]`, and `outsideCheckout` is empty.
2. **Given** a touch of `/tmp/scratch.txt` (matching neither `work_dir` nor
   `folder`), **then** it appears in `outsideCheckout` and in none of the other
   three groups.
3. **Given** a file read three times and edited once, **then** its row reports
   `reads: 3`, `writes: 1`, and it sorts above a file with one read.
4. **Given** a touch whose event payload carries `subagent: "Explore"`, **then**
   its row's `by` is `"Explore"`; **given** one with `parentToolUseId` and no
   `subagent`, **then** `by` is `"delegated"`; **given** neither, `"main"`.
5. **Given** an empty `changed` list, **then** `changedNotTouched` is empty and
   every touched file lands in `touchedNotChanged` — not in
   `touchedAndChanged`.
6. **Given** the same path reached once as `work_dir`-relative and once as
   `folder`-relative, **then** it produces **one** row, not two.
7. `npm run typecheck` exits 0 and `npm test` reports zero failures.
8. **Given** a terminal run finished longer ago than `eventRetentionDays`,
   **when** the Files tab is opened, **then** the page states that this run's
   tool events were removed on the event horizon — and does **not** render an
   empty list. The sentence follows the wording already used for the same class
   of problem at `src/components/RunTasks.tsx:102-104`; do not invent a fourth
   phrasing, and read the two neighbours at
   `src/app/api/runs/[id]/stream/route.ts:135` and
   `src/app/runs/[id]/page.tsx:1595` first.
9. **Given** a run that made tool calls but named no file, **then** the tab says
   so in words distinct from criterion 8's.
10. **Given** any run, **then** the header states once that a touch means a call
    was *attempted*, because no successful tool result is recorded anywhere
    (`src/lib/orchestrator.ts:7343-7344`). No per-row success or failure mark is
    rendered in this slice.
11. **Given** a run with events, **then** the header prints the **distinct
    touched-file count** and the run's **work-cycle count**. These two numbers
    are the point of the slice as much as the groups are: they are what decides
    whether [08-option-g](08-option-g-cycle-heatmap.md) is buildable, and
    without them that decision is a guess.

## Explicitly out of scope for this slice

A canvas or any graph rendering; a new pane; a new tab segment; a sub-route; any
index on `run_events`; any change to an emit site, a column or `migrate()`; a
per-call failure mark; a fleet-wide view; and any change to `RunDiff` beyond
rendering the new component beneath it.
