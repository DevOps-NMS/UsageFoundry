# The ceilings

Every bound found, where it is, what happens when it is reached, and which
growth axis reaches it. Thirty-one rows, grouped by what happens at the bound,
because that grouping is the finding.

**Measured / inferred** is per row and it is the column to read first. *Measured*
means a number in this proposal was taken against it in this container.
*Inferred* means the behaviour was read from the code and the arithmetic done on
paper. Nothing here was taken from a running container under load, because
Docker is unavailable — see [12-validation.md](12-validation.md).

---

## Group 1 — Bounds that queue or refuse, visibly

Reaching these produces a state an operator can see and act on. None of them is
a failure and none is worth raising without a reason from outside the code.

| # | Bound | Where | At the bound | Axis | M/I |
|---|---|---|---|---|---|
| 1 | `maxConcurrentRuns: 4` | `src/lib/settings.ts:711` | Further runs stay `queued`. `selectPromotable(activeRuns(), cap, …)` at `orchestrator.ts:3424-3425` promotes only up to the cap, and `queuePosition` tells a run how many are ahead **of it for its folder** (`:3434-3450`) | concurrency | I |
| 2 | `maxConcurrentAssists: 2` | `src/lib/settings.ts:712` | `assistBudgetRefusal` returns a sentence naming the Settings field; a review, a conflict assist, a chat turn and a workflow's deciding block share the budget (`review.ts:405-410`) | concurrency | I |
| 3 | `MOUNTED_WORKSPACE_SLOTS = 4` | `src/lib/config.ts:213` | A fifth slot in `.env` **refuses the boot** with a sentence naming the variable (`config.ts:234-247`), and `docs/install.md:493-505` documents the override route | repositories | I |
| 4 | Isolation slots per repository | `MAX_WORKTREE_SLOTS = 64`, `orchestrator.ts:2675` | Isolation *used up* throws; isolation *unavailable* degrades to `mode: "none"` (`docs/agent/isolation-and-landing.md`). Slot pressure is on `/branches` through `CheckoutStoreSummary` | concurrency × repositories | I |
| 5 | `MAX_WORKFLOW_NODES = 25` | `src/lib/apiTypes.ts:980` | Instantiation refuses; all or nothing (`docs/agent/workflows-and-schedules.md`) | concurrency | I |
| 6 | `MAX_FAN_OUT = 10` | `src/lib/apiTypes.ts:991` | Refused at validation. Deliberately tighter than row 5 because those runs "are chosen by a model and start with no approval between the decision and the spawn" | concurrency | I |
| 7 | `MAX_LOOP_PASSES = 20` | `src/lib/apiTypes.ts:1000` | The loop block stops | concurrency | I |
| 8 | `MAX_MERGE_WORKERS = 4` | `src/lib/mergeQueue.ts:613` | Queue items wait | concurrency | I |
| 9 | `RATE_LIMIT_BACKOFF_MS` | `src/lib/orchestrator.ts:1284` | Four rungs, ~17-26 minutes, then the run parks with a stop reason naming `maxConcurrentRuns` as "the N this whole failure is proportional to" (`:1276-1279`) | concurrency | I |

Row 9 is the only one in this group whose *cost* rises with the axis rather than
its likelihood: a parked-in-place retry holds the folder, a worktree slot and one
of `maxConcurrentRuns` for the whole ladder
([UnattendedOperation](../UnattendedOperation/00-problem.md) row 3 owns that
finding and this proposal does not restate it).

---

## Group 2 — Bounds that truncate and say so

The good pattern. Each caps per-request work and reports that it stopped, so a
reader knows the answer is partial.

| # | Bound | Where | At the bound | Axis | M/I |
|---|---|---|---|---|---|
| 10 | `MAX_WALK_ENTRIES = 120_000` (storage walk) | `src/lib/retention.ts:725` | `treeSize` returns `{ bytes, partial }` — **`partial: true` is the signal**, and the docblock says the walk "says when it stopped" because "'the figure took a minute' is how an operator learns not to open the card that exists to warn them" (`:716-723`) | history × repositories | I |
| 11 | `MAX_INVENTORY = 60` branches per request | `src/lib/land.ts:2119` | Clamped at `:2397-2398`, and `/api/branches` takes `repo`, `offset` and `limit` so the whole set stays reachable | repositories | I |
| 12 | `MAX_PENDING_PROBES = 20` | `src/lib/land.ts:2121` | Applied by `selectProbeTargets(pending, MAX_PENDING_PROBES)` at `:2651`, **in one synchronous pass before the first probe is dispatched** (`:2466-2479`) — a counter spread across awaits caps nothing and makes *which* branch was probed a function of the event loop | repositories | I |
| 13 | `MAX_SLOT_PROBES = 48` | `src/lib/land.ts:2123` | Slot status unread past the bound; the card shows what it examined | repositories | I |
| 14 | `MAX_SLOT_PROBES_PER_ADMISSION = 4` | `src/lib/orchestrator.ts:2001` | Past the bound a slot is `census.unexamined` rather than `dirty`. The docblock is a growth record: before it, "every admission re-examined every one of them, for ever — 64 slots at git's own 20-second ceiling in the limit" (`:1992-1995`) | concurrency × repositories | I |
| 15 | `MAX_LIST_PROMPT` clip on `/api/runs` | `src/app/api/runs/route.ts:43-46, :76-78` | The prompt arrives clipped with an ellipsis, marked. Carries its own measurement: "522,541 bytes of a 696,197-byte response" | history | I (repo's own measurement) |
| 16 | `MAX_LISTED_FILES = 24`, `MAX_NOTICE_CHARS = 2_400` | `src/lib/fileCostNotice.ts:100, :111` | The price list is the top 24 by price, capped in characters. Measured notice length on this repository: **1,482 chars** | repositories | M |
| 17 | `TRANSCRIPT_CACHE_MAX_ENTRIES = 500_000` | `src/lib/config.ts:84-87` | `evictToBound()` (`transcripts.ts:616`) drops whole files LRU-style after the result is built (`:822`), and `evictions` is reported on `/api/usage` `meta.memory.cache` (`route.ts:150`) and rendered on the home page (`src/app/page.tsx:876-882`) | history | **M** |

Row 17 is the one bound in this proposal with a live occupancy reading *and* a
measurement of that reading:

```
{ files: 1236, entries: 101658, toolCalls: 63504, maxEntries: 500000, evictions: 0 }
```

**20.3% occupied, zero evictions, at 973.8 MB of transcripts.** Extrapolated
linearly to the `transcriptRetentionDays: 30` plateau of ≈2,650 files / ≈2.1 GB
(from 00-problem's measured 88 files/day), it reaches ≈218,000 of 500,000.
**The bound is unreachable under the shipped retention default**, and that is
arithmetic on a measurement rather than a measurement.

---

## Group 3 — Bounds that truncate silently

Two rows. This is the only group in the catalogue where reaching the bound
changes an answer without saying it did, and it is the group worth acting on.

| # | Bound | Where | At the bound | Axis | M/I |
|---|---|---|---|---|---|
| 18 | `MAX_WALK_ENTRIES = 20_000` (file price list) | `src/lib/fileCostNotice.ts:182` | `walkRepo` stops and **returns a plain `RepoFile[]` with no truncation flag** (`:368-404`). The queue is FIFO (`queue.shift()`), so a truncated walk is breadth-first: shallow directories only. The notice then names "the largest files" of a fraction of the tree, in a prompt that is frozen for the life of the run and byte-identical on every cycle's argv | repositories | **M** (distance from the bound) |
| 19 | `MAX_REMOTES_READ = 25` | `src/lib/workspace.ts:168`, applied `:188` | The chat can name the first 25 repositories, always the same 25. No parameter moves it | repositories | I |

**How far away row 18 is.** Measured, and it is the reason this is insurance
rather than a fix:

```
/workspace/UsageFoundry   1951 entries   (9.8% of 20,000)
/workspace2               1247 entries   (6.2% of 20,000)
```

Both an order of magnitude clear, and `SKIP_DIRS`/`SKIP_EXTENSIONS`
(`fileCostNotice.ts:132`, `:156`) remove `node_modules` and `.git` before the
count.
A repository ten times this one's size reaches it. Nobody here has one.

**Why row 18 is worth a line of code anyway.** The same constant name, in the
same repository, with the same justification in its docblock — "a mount pointed
at something enormous must cost a truncated list rather than a stalled server"
(`fileCostNotice.ts:174-181`) versus "the walk is bounded and says when it
stopped" (`retention.ts:716-723`) — reaches **opposite** conclusions about
whether to report the truncation. One of the two is wrong about the same
question, and the one that reports is the one whose output an operator reads
directly, while the one that does not is the one whose output goes into an
agent's system prompt where nobody will ever see that it was short.

Row 19 is [GapRegister G1](../GapRegister/03-growth.md)'s third cap and is left
to it.

---

## Group 4 — Bounds that evict

| # | Bound | Where | At the bound | Axis | M/I |
|---|---|---|---|---|---|
| 20 | `RETENTION_ROWS = 20_000` on `request_log` | `src/lib/requestLog.ts:68` | An unconditional `DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?` after **every** insert (`:117-121`). Nothing in `retention.ts` touches this table | history | **M** (the row source, not the depth) |
| 21 | `eventRetentionDays: 30` | `src/lib/settings.ts:726` | `run_events` older than the horizon is swept; the `runs` row stays | history | I |
| 22 | `checkoutRetentionDays: 7` | `src/lib/settings.ts:727` | Checkouts the database says are not live are removed | history × repositories | I |
| 23 | `transcriptRetentionDays: 30` | `src/lib/settings.ts:728` | `sweepTranscripts` unlinks expired files, keeping `resumableSessions()`, clears `session_id` on terminal runs, then `forgetTranscriptFiles(gone)` | history | I |

**The measured fact about row 20**, which is what changes its severity: the audit
log's row source is mutation handlers only.

```
grep -rhn "= auditMutation(" src/app/api --include=*.ts | sed 's/.*const \([A-Z]*\).*/\1/' | sort | uniq -c
   → 20 POST, 7 DELETE, 5 PUT, 1 PATCH        (33 exports across 26 route files)
```

Plus `/api/mcp`'s POST, which wraps itself at `route.ts:671` rather than at the
export so that the credential-free 401 above it stays out of the table — **34
audited handlers over 27 route files.**

**Zero `GET` handlers are wrapped.** A polling browser generates no audit rows
at all — `/api/runs` on its four-second poll, `/api/status`, `/api/usage` and
every other read are absent from this table by construction. So 20,000 rows is
20,000 *operator actions and agent-initiated mutations*, which is what
`requestLog.ts:58-67` means by "20,000 is weeks of ordinary operation". How many
days it is on a real install is still unknown, because the table is unreadable
from here — but the rate is one to two orders of magnitude lower than a
request-per-poll reading of it would suggest.

Rows 21-23 are the load-bearing rows of this whole catalogue and the reason the
answer to the brief's question is "nothing":

> **The retention defaults bound the history axis, so three of the four costs
> that grow with history plateau at 30 days rather than growing without bound.**
> The transcript corpus plateaus (row 23), the transcript cache plateaus with it
> (row 17), and the `run_events` scan behind the file price list plateaus at
> `eventRetentionDays` (row 21 against `READ_HISTORY_DAYS = 30`,
> `fileCostNotice.ts:122` — the query's own window and the sweep's horizon are
> the same 30 days, which is either a coincidence or somebody's good judgement).

What does **not** plateau: the `runs` table itself. "Nothing deletes a `runs`
row" is a documented invariant (`docs/agent/retention.md`), so that table grows
monotonically for the life of the install. Row 24 below is why that is fine.

---

## Group 5 — Costs that grow with an axis and have no bound at all

These are not ceilings. They are the slopes, and they are where the measurements
in this proposal actually landed.

| # | Cost | Where | How it grows | Axis | M/I |
|---|---|---|---|---|---|
| 24 | `runs` table size | never swept | Monotone for the install's life. But `idx_runs_status ON runs(status)` (`db.ts:648-649`) and `idx_runs_created ON runs(created_at DESC)` (`:645-646`) cover the two hot queries: `activeRuns()` is `status IN ('queued','running','paused')` (`orchestrator.ts:2628-2634`) and its result set is bounded by `maxConcurrentRuns` plus queue depth, **not** by table size | history | I |
| 25 | **Cold `scanUsage()`** | `src/lib/transcripts.ts:759` | Linear in transcript bytes. **Measured 2,985-3,041 ms at 973.8 MB / 1,236 files** (n = 5 processes); warm 82.5-88.9 ms; **≈36× ratio**. Extrapolates to ≈6.4 s at the 30-day plateau. Paid on the first `/api/usage`, `/api/status`, pre-cycle guard or `assistRefusal()` **after every container restart**, because the cache is process-local (`:672-676`) | history | **M** |
| 26 | `buildSnapshot()` | `src/lib/windows.ts` | Linear in deduped entries. **Measured min 12.67 / p50 13.09 / max 31.40 ms** over 52,469 entries (n = 12). Coalesced across callers by `currentSnapshot()`'s single-flight on `__ufSnapshotInflight` (`orchestrator.ts:6905-6917`) — the docblock names the exact growth interaction it fixes: "N runs reaching a cycle boundary together did N full-history aggregations back to back, on the one event loop" | history × concurrency | **M** |
| 27 | `walkRepo` inside `createRun`'s no-`await` window | `src/lib/fileCostNotice.ts:418-421`, called unconditionally at `orchestrator.ts:3196` | Linear in directory entries. **Measured 14.08-16.87 ms steady, 45.61 ms first call** on 1,951 entries. Synchronous, so it is event-loop time, and N runs created by one press pay N of them | repositories × concurrency | **M** |
| 28 | `readCountsFor`'s `run_events` scan | `src/lib/fileCostNotice.ts:322-350` | A `json_extract(e.payload, '$.input.file_path')` over 30 days of payloads. **No index can serve it** and the docblock explains why one was refused: an index "would move the cost onto every `run_events` insert instead, and that table is written on every tool call of every cycle". Memoised per folder for `READ_COUNTS_TTL_MS = 60_000` (`:304`). Measured here at 8.29 ms against an **empty** table, which is a floor; **the project's own figure is 38 ms against 131,572 rows** (`:290-291`). The memo is per *folder*, so the docblock's worst case is the one that matters: "a workflow instantiating twenty nodes … would pay it twenty times, blocking the event loop for the sum" — **≈950 ms at `MAX_WORKFLOW_NODES = 25`** on one press. Largest synchronous cost in this survey | history × concurrency | **M (in-tree; floor only here)** |
| 29 | Event-loop delay during a cold scan | — | **Measured p50 ≈8, p90 17-20, p99 29-34, max 36-45 ms** (n = 5). Well inside `HEARTBEAT_MS = 1_000` (`serverLock.ts:51`) and three orders of magnitude inside `STALE_MS = GIT_SYNC_TIMEOUT_MS * 6` = 120 s (`serverLock.ts:84`, `git.ts:111`). The scan is `await`-ed I/O, not a block | history | **M** |
| 30 | Peak RSS during a cold scan | — | **Measured 323-372 MB RSS, 149-205 MB heap** at 973.8 MB of transcripts, against `NODE_OPTIONS: --max-old-space-size=2048` (`docker-compose.yml:201`) and `mem_limit: 10g` (`:423`) | history | **M** |
| 31 | `run_deps` growth on the `run_id` side | `src/lib/db.ts:344-350` (the table), `:655-656` (the one explicit index) | **Not a scan, and this row is a correction — see below.** `PRIMARY KEY (run_id, depends_on)` gives SQLite `sqlite_autoindex_run_deps_1`, which serves `run_id` as its leading column. Both hot queries `SEARCH`. The table is never swept, but edges per instance are bounded by `MAX_WORKFLOW_NODES = 25` | history | **M** |

Row 30 is the one that refutes a prior claim outright. **Peak RSS is not the
size of the transcript tree.** `SCAN_CONCURRENCY = 12` (`transcripts.ts:684`)
bounds the fan-out and the docblock at `:666-680` explains the mechanism it
replaced: an unbounded `Promise.all` held every descriptor and every
whole-remainder buffer at once, so "peak memory was therefore the size of the
tree and peak descriptors its file count". At 973.8 MB of tree, peak RSS
measured **367 MB**, not 974 MB.

**Row 31 is where this catalogue was wrong and then corrected.** It was written
as "`run_deps(run_id)` — no index, full scan on the `run_id` side", reasoned from
`db.ts:655-656` indexing `depends_on` and nothing indexing `run_id`, and marked
`I`. Running the plan settles it the other way:

```
EXPLAIN QUERY PLAN SELECT d.run_id, d.depends_on, d.edge FROM run_deps d
  JOIN runs r ON r.id = d.depends_on WHERE d.run_id IN ('x');
    → SEARCH d USING INDEX sqlite_autoindex_run_deps_1 (run_id=?)
      SEARCH r USING COVERING INDEX sqlite_autoindex_runs_1 (id=?)

EXPLAIN QUERY PLAN SELECT run_id, depends_on, edge FROM run_deps
  WHERE run_id IN (SELECT id FROM runs WHERE status = 'waiting');
    → SEARCH run_deps USING INDEX sqlite_autoindex_run_deps_1 (run_id=?)
      LIST SUBQUERY 1
      SEARCH runs USING INDEX idx_runs_status (status=?)
```

`PRIMARY KEY (run_id, depends_on)` (`db.ts:349`) is an implicit unique index
whose **leading** column is `run_id`, so the queries at
`orchestrator.ts:3815-3818` and `:3956-3957` both search rather than scan.
`idx_run_deps_depends_on` exists precisely because `depends_on` is the one side
the autoindex cannot serve. **The finding was not that the index is unnecessary;
it was that the index already exists and is not written down anywhere.** #68
asked for this plan and it has now been run.

---

## What the catalogue adds up to

| | |
|---|---|
| Bounds catalogued | **31** |
| That fail, throw, corrupt or lose data at the bound | **0** |
| That queue or refuse visibly | 9 |
| That truncate and report it | 8 |
| **That truncate silently** | **2** (rows 18, 19) |
| Measured against in this container | **12** rows |
| Reachable at this install's measured growth rate within 30 days | **0** of the numeric bounds |
| Already exceeded at this install's size | **1**, and it is not in this catalogue: `listRuns(100)` (`src/app/api/runs/route.ts:50`), which [GapRegister G1](../GapRegister/03-growth.md) owns |
| Bounds whose docblock records a growth problem somebody already fixed | **4** (rows 14, 17, 25's `SCAN_CONCURRENCY`, 26's single-flight) |

That last row is the finding that should change how the brief's question is
answered. Four of the bounds in this catalogue exist *because* somebody asked
this proposal's question before and measured the answer. The app is not
approaching its ceilings; it has been walking away from them.
