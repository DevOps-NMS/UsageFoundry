# Option H — the touched/changed reconciliation

**Recommended.** A sorted list with counts, reconciled against the branch diff,
rendered under the existing Changes tab. No pane, no segment, no canvas, no
route of its own.

This is deliberately less than was asked for. The case for it is that it answers
the three questions nothing answers today, it is the shape the data actually is,
and it produces the two measurements that decide whether anything visual is worth
building afterwards.

## What it shows

Four groups over one query, in this order:

**1. Changed, and never touched** — files in `base..branch` with no tool event
naming them. The most interesting group and the one with no surface anywhere
today ([F6](00-problem.md#f6), category 3). Produced by a `Bash` that wrote files
(`sed -i`, a formatter, a codegen step), or by an event that has aged out. Leads,
because it is the group an operator would not have guessed at.

**2. Touched, and changed** — the ordinary case. Collapsed by default; it is the
diff's own file list with counts attached.

**3. Touched, and not changed** — read and never written, or edited and reverted.
This is the context the run paid for and discarded.

**4. Touched outside the checkout** — a count and a list of paths matching
neither `runs.work_dir` nor `runs.folder`. `readCountsFor` already computes
exactly this predicate and throws the result away at its `ELSE NULL`
(`src/lib/fileCostNotice.ts:343`); this is the first reader that wants it.

Columns per row: **path** (the headline the record is identified by, so no
`label` under `Table`'s `stack` — `docs/agent/conventions.md:25`), **reads**,
**writes**, **in diff**, **by** (`main`, or the sub-agent name from
`json_extract(payload, '$.subagent')` — the one thing kept from
[07-option-f](07-option-f-delegation-tree.md)).

## Why a table and not a picture

**Because the data is a set relation and set relations are tables.** Every
edge candidate in `run_events` collapses into a hub spoke, a clique or a
timeline — the argument is
[06-option-e §1](06-option-e-file-tool-graph.md#1-every-candidate-edge-is-either-a-hub-spoke-or-a-clique)
and it is a fact about the payload rather than a preference about rendering. The
three questions in [02-option-a](02-option-a-change-nothing.md#what-beats-it)
are all *set differences*. A set difference drawn as a graph is two clouds and a
gap; drawn as a table it is a heading and a count.

**Because a count is a fact and a cluster is an impression.** "This run changed 4
files it never read" is actionable and checkable. A picture that makes the same
point makes it unfalsifiably.

**And because the app already reached this conclusion for the neighbouring
feature.** `docs/agent/metering.md:44` records that `byTool` was deliberately not
made a sixth rollup; `docs/agent/conventions.md:65` sets the threshold under
which a picture is inline SVG rather than a canvas, and this is under even that.

## The query

One scan, index-covered per run by `idx_run_events_run(run_id, id)`
(`src/lib/db.ts:624-625`), reading `kind = 'tool'` rows and extracting
`$.input.file_path` and `$.name` — the shape `readCountsFor` already proves works
(`fileCostNotice.ts:328-363`). Relativised against `COALESCE(r.work_dir,
r.folder)` then `r.folder`, per the docblock at `fileCostNotice.ts:320-327`:

> Keyed on `runs.folder` rather than on `repo_root`, and that is the difference
> between a working query and an empty one: most runs work in a worktree, so
> their recorded paths are under `runs.work_dir` and share no prefix with the
> repository root at all.

**Differences from `readCountsFor`, each deliberate:**

- Scoped to **one run**, not to a folder across the fleet. That turns the
  measured full scan (38 ms over 131,572 rows, `fileCostNotice.ts:296-297`) into
  an index range scan, because the index leads on `run_id`. There is no index on
  `kind` (`fileCostNotice.ts:119`) and this does not add one — the trade at
  `fileCostNotice.ts:303-308` is decided and it is about the write side
  ([C5](01-constraints.md#c5--a-route-that-costs-seconds-is-fetched-on-demand-never-polled)).
- **Not restricted to `Read`.** `readCountsFor` filters `$.name = 'Read'`
  (`fileCostNotice.ts:350`); this needs `Edit`, `Write` and `NotebookEdit` too, so
  it groups by name rather than filtering to one.
- **Keeps the `ELSE NULL` rows** instead of dropping them; they are group 4.

The diff side is `runDiff(id)`, already exposed at
`src/app/api/runs/[id]/diff/route.ts:22-31` and already fetched by the Changes
tab. **No second git process**: the reconciliation reuses the numstat the tab has
already loaded, so the added cost is the event scan alone.

## What it must say, and where the wording already exists

Three empty states, and the failure they exist to prevent is that all three look
identical to "nothing happened"
([C4](01-constraints.md#c4--a-narrowing-control-says-what-it-left-out)).

**1. Swept.** Decidable without a second query: `run_events` is deleted where
`ts < cutoff AND run_id IN (terminal statuses)`
(`src/lib/retention.ts:145-151`), so a terminal run whose `finished_at` precedes
`retentionCutoff(eventRetentionDays)` (`retention.ts:107-110`) has no events *by
construction*. The route knows this from the run row and the setting, and says so
rather than rendering an empty list.

**2. Truncated.** Not applicable if the route reads the database
([C3](01-constraints.md#c3--the-reader-must-not-be-the-pages-event-array)) — and
that is the reason it must. A client-side derivation over the page's array would
silently draw the newest 2,000 events (`stream/route.ts:17`).

**3. Genuinely empty.** A run that made no file-naming tool call. Says that.

**Adopt the third existing wording, do not invent a fourth.**
`src/components/RunTasks.tsx:102-104` already words this exact problem —
`{n} earlier events never reached this page, so a task that started in them is
missing here.` The two neighbours are `stream/route.ts:135` and
`src/app/runs/[id]/page.tsx:1595`. Three phrasings of one fact is already one too
many.

And the reconciliation itself carries a hedge that belongs in the header rather
than per row
([C10](01-constraints.md#c10--an-edge-means-attempted-not-succeeded-f3-f4)): a
touch is an *attempt*. Success is never recorded (`orchestrator.ts:7343-7344`)
and a failure joins to its call only by a flattened 160-character command string
([F3](00-problem.md#f3)). **The failure column is therefore not built in the
first slice** — a column that is wrong in a retry loop is worse than a column
that is absent.

## Where it renders

**Under the existing Changes tab**, as a `ListGroup` per non-empty category with
a `Table` inside — `stack` on, per `docs/agent/conventions.md:25`, which counts
22 of the app's 25 tables carrying it.

Four reasons this beats both a segment and a sub-route:

- **The sixth segment is banned** ([04-option-c](04-option-c-sixth-tab.md)) and
  a sub-strip inside a tab is banned too (`ui-density-audit.md:178`).
- **The comparison needs both halves on one screen.** Half the content is the
  diff's own file list. Splitting it across two routes is the thing a
  reconciliation exists to prevent
  ([05-option-d](05-option-d-sub-route.md#what-it-costs-that-nobody-will-put-in-the-estimate)).
- **The tab is already the right subject.** `docs/agent/conventions.md:20` puts
  "what the run *produced*" in the pane; a file the run touched is that.
- **Mounting cost is already paid there.** "Only the active tab is mounted, so
  Changes re-reads the repository each time it is opened"
  (`conventions.md:20`) — the operator opening Changes has already accepted a
  fetch, and this adds one indexed scan to it rather than a second page load.

The grouping is inside the vocabulary: `conventions.md:50` allows "a `ListGroup`
with a `label`, for rows sharing a subject the card's title does not name — three
to nine". Four groups, each labelled, each named by something the title
"Changes" does not say.

**The one thing this changes about the tab is its name.** "Changes" no longer
covers its contents once three of the four groups are about things that did *not*
change. `docs/agent/ui-density-audit.md:1122` freezes "**five labels, the
order**" — the count and the order, which a rename does not touch, and
`conventions.md:50` requires that "a label has to cover what the figure under it
contains". **Files** is the honest word. This is the one documented decision the
recommendation asks to reopen, it is reopened by name, and it is a string.

## What it does not do

- **No canvas, no force layout, no fourth renderer**
  ([06-option-e §4](06-option-e-file-tool-graph.md#4-the-cost-is-a-canvas-the-tree-cannot-share)).
- **No index on `run_events`** ([C5](01-constraints.md#c5--a-route-that-costs-seconds-is-fetched-on-demand-never-polled)).
- **No new emit site, no new column, no migration.** Everything read is already
  written ([F1](00-problem.md#f1)).
- **No failure marking** — see above.
- **No fleet-wide view** ([10-option-i](10-option-i-fleet-wide.md)).

## Verdict

**Recommended as the first and only slice.** It is a sorted list with counts
rather than a graph, which is what the brief asked to be recommended if that were
the honest answer, and it is. It answers three questions with no surface today,
costs one route handler and one component, violates nothing, and its output
includes the two numbers that decide whether
[08-option-g](08-option-g-cycle-heatmap.md) is worth building.
