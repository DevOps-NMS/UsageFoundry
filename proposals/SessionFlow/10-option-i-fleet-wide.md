# Option I — a fleet-wide flow, across runs

Not one run's touches but the install's: which files the fleet works on, which
runs collide on the same paths, where the work is concentrated. The brief asks
for this to be weighed and it is refused — with the note that **a third of it is
already shipped and unexposed**, which is the more useful finding.

## The strongest case for it

**This is the reading that would actually justify a graph.** At fleet scale the
node set is files across months and the edges are runs — a genuine
many-to-many with real clustering, unlike the per-run bipartite star
([06-option-e §1](06-option-e-file-tool-graph.md#1-every-candidate-edge-is-either-a-hub-spoke-or-a-clique)).
"Which parts of this repository does the fleet keep returning to" is a shape
question with a shape answer.

**And the query exists.** `readCountsFor` (`src/lib/fileCostNotice.ts:328-363`)
is *already* fleet-wide: it is keyed on `runs.folder` and spans
`READ_HISTORY_DAYS`, joining `run_events` to `runs`. Its output — a
`Map<relativePath, readCount>` over every run the operator ever pointed at that
directory — is precisely the corpus this option wants, and it is computed on
every `createRun`.

**Its one consumer uses it for something else.** It feeds a file cost notice
handed to the agent. `docs/agent/architecture.md` (routed from `CLAUDE.md`)
records that `runs.file_cost_notice` is frozen against the cached prefix, so the
notice is fixed for the life of the run. **The ranking is computed, cached for 60
seconds (`fileCostNotice.ts:310`), consumed by a prompt, and never shown to the
operator.** A read-only card printing the top of that map is a genuinely small
change with a real reader.

## Why it is refused as a feature here

### 1. It is a different question with a different subject

The request names "the session". [F7](00-problem.md#f7) establishes that only a
run has an event log, so "the session" resolves to a run. A fleet-wide view is
not a bigger version of that; it is a view of the *install*, which is the
dashboard's subject (`docs/agent/conventions.md:50` on regions and the three cost
sources). Building it here would answer a question nobody asked while leaving the
asked one open.

### 2. Its cost is the one measurement in the tree that says "don't"

`fileCostNotice.ts:296-301`:

> The query underneath is a full scan of `run_events` — 38ms against 131,572
> rows here, measured in process rather than through `docker exec` — and its
> caller sits inside `createRun`'s no-`await` window, which is the whole server
> for as long as it runs.

Fleet-wide means no `run_id` predicate, and `idx_run_events_run(run_id, id)`
(`src/lib/db.ts:624-625`) is the only index — there is none on `kind`
(`fileCostNotice.ts:119`) and none on `ts`. So this is the full scan, and
`fileCostNotice.ts:303-308` has already refused the index that would fix it,
because "that table is written on every tool call of every cycle — far the busier
side of the trade."

The per-run option ([09](09-option-h-reconciliation-table.md)) is an index range
scan on the same table. **The two options differ by roughly the whole cost of the
feature**, and the expensive one is the one nobody asked for.

### 3. It has no `base..branch` to reconcile against

The "changed" half is `runDiff`, which is per-run and per-branch
(`src/app/api/runs/[id]/diff/route.ts:22-31`). There is no fleet-wide equivalent
— the branches page enumerates branches (`/api/branches`) but nothing sums
diffs across runs, and `docs/agent/conventions.md:50` makes summing across a
boundary structurally wrong on the dashboard: "no figure, meter, badge, total or
comparison is drawn at region level […] a total across a boundary is visibly
wrong rather than merely undocumented."

So a fleet-wide view can show **touched** and cannot show **changed**, which
means it cannot answer the request's second half at all.

### 4. Retention bites harder here, not less

Thirty days of events (`src/lib/settings.ts:819`,
`src/lib/retention.ts:145-151`) is a long time for one run and a short one for a
fleet history. A card claiming to show what the install works on, showing one
month, on a horizon the operator can change in Settings, is
`docs/agent/retention.md:12`'s dashboard problem again — solved there by
`PeriodSeries.completeFrom` carrying the cutoff and the card saying so. That is
the right pattern and it is a second feature's worth of care.

## What is worth filing rather than building

**One issue, not a survey:** `readCountsFor`'s ranking has an operator-facing
reader and does not have one. Printing the top N of the existing 60-second-cached
map on `/settings` beside the storage figures, or on the dashboard, is a small
change to an already-computed value.

It is **not** part of this recommendation and should not be smuggled into it.
Filed here so the next survey of the dashboard finds it, because the thing that
makes it cheap — the map already existing — is exactly the thing that makes it
invisible to anyone looking for it.

## Verdict

**Refused.** Different subject, the one cost measurement in the tree that argues
against it, no `changed` half to reconcile against, and a retention story needing
its own design. The finding worth keeping is that its data already exists and
feeds a prompt instead of a person.
