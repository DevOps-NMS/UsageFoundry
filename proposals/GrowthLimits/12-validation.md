# Validation

Five measurements would confirm or overturn this proposal. **None of the five
could be taken in this container**, and each is phrased so that a different
answer falsifies a specific claim rather than merely adding colour.

Then the commands that *were* run, with what they returned when this was
written, so a reader on a different tree can tell whether the ground moved.

## §1 — `readCountsFor` at a real `run_events` row count

**The largest synchronous cost this survey found, and the only one where the
project's own figure is better than mine.**

`fileCostNotice.ts:290-291` records 38 ms against 131,572 rows, "measured in
process rather than through `docker exec`". Measured here: 8.29 ms against an
**empty** table, which is a floor and nothing more — `DATA_DIR` is unreadable to
the agent uid, so the query never met a row.

```sh
# Row count, and the query's plan and time at that count. Run as the uid that
# owns DATA_DIR, on the live database, not on .data/usagefoundry.db.
sqlite3 "$DATA_DIR/usagefoundry.db" \
  "SELECT COUNT(*) FROM run_events WHERE kind = 'tool';"

sqlite3 "$DATA_DIR/usagefoundry.db" <<'SQL'
.timer on
EXPLAIN QUERY PLAN
SELECT rel, COUNT(*) AS n FROM (
  SELECT CASE
    WHEN instr(json_extract(e.payload, '$.input.file_path'),
               COALESCE(r.work_dir, r.folder) || '/') = 1
      THEN substr(json_extract(e.payload, '$.input.file_path'),
                  length(COALESCE(r.work_dir, r.folder)) + 2)
    WHEN instr(json_extract(e.payload, '$.input.file_path'), r.folder || '/') = 1
      THEN substr(json_extract(e.payload, '$.input.file_path'),
                  length(r.folder) + 2)
    ELSE NULL END AS rel
  FROM run_events e JOIN runs r ON r.id = e.run_id
  WHERE e.kind = 'tool' AND e.ts >= 0
    AND json_extract(e.payload, '$.name') = 'Read')
WHERE rel IS NOT NULL GROUP BY rel;
SQL
```

**What overturns what.** The claim is that this costs ≈38 ms per *distinct
folder* inside `createRun`'s no-`await` window, so a workflow instantiating 25
nodes across 25 folders blocks the event loop for ≈950 ms. If the query comes
back at 300 ms rather than 38 ms — a plausible outcome on an install with ten
times the events — then 25 nodes is 7.5 s of blocked server and this stops being
a catalogue row and becomes the survey's recommendation, ahead of Option A.
`/workspace2/3 Resources/Service Runtime/Blocking the Event Loop.md` is the
threshold to apply, on the **worst observed** value rather than the median.

If instead it comes back near 38 ms and the operator never instantiates a
multi-folder workflow, the memo at `READ_COUNTS_TTL_MS = 60_000` absorbs it and
nothing needs doing.

## §2 — Per-child memory under real concurrency

**The measurement the whole concurrency axis rests on, and the one
`settings.ts:205-232` admits is reasoned rather than measured.**

Docker is unavailable in this container. This was **not** run here.

```sh
# On the host, container up, four runs live, read at the peak of a cycle
# rather than between cycles.
docker stats --no-stream --format \
  'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}' usagefoundry

docker exec usagefoundry sh -c \
  'ps -o pid,rss,args -C claude --no-headers | awk "{print \$1, \$2/1024 \" MiB\"}"'

# And the two limits it is being read against:
docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}' usagefoundry
```

**What overturns what.** `settings.ts:205-232` sizes `maxConcurrentRuns: 4`
against ≈1.5 GiB per work cycle inside `mem_limit: 10g`
(`docker-compose.yml:423`). Near 1.5 GiB and 4 is right and
[Option C](05-option-c-raise-the-run-ceiling.md) closes. Near 600 MB and two
thirds of the budget is unused and Option C becomes the highest-value change in
the survey. The server's own contribution is already measured — **323-372 MB RSS
during a cold scan**, n = 5 — so the children are the whole of the unknown.

**Read it at the peak.** A figure taken between cycles measures a sleeping
process and would license a raise the running one cannot survive.

## §3 — `run_deps` on the `run_id` side

`db.ts:655-656` indexes `run_deps(depends_on)` and nothing indexes
`run_deps(run_id)`. Two hot queries filter on the unindexed side:
`orchestrator.ts:3815-3818` (`WHERE d.run_id IN (…)`) and `:3956-3957`
(`WHERE run_id IN (SELECT id FROM runs WHERE status = 'waiting')`).

This proposal **reasoned** that it does not matter — edges per instance are
bounded by `MAX_WORKFLOW_NODES = 25` and SQLite scans a few thousand narrow rows
in tens of microseconds — and #68 asked for the same check. It is arithmetic, not
a measurement, and catalogue row 31 is marked `I` for that reason.

```sh
sqlite3 "$DATA_DIR/usagefoundry.db" "SELECT COUNT(*) FROM run_deps;"
sqlite3 "$DATA_DIR/usagefoundry.db" \
  "EXPLAIN QUERY PLAN SELECT d.run_id, d.depends_on, d.edge FROM run_deps d
     JOIN runs r ON r.id = d.depends_on WHERE d.run_id IN ('x');"
```

**What overturns what.** A `SCAN run_deps` in the plan is expected and is not the
finding — the finding would be a row count in the hundreds of thousands, which
would mean workflow instances are accumulating edges faster than
`MAX_WORKFLOW_NODES` suggests. At that point the index is one idempotent
`CREATE INDEX IF NOT EXISTS` in `migrate()`.

## §4 — `request_log` depth and where its rows come from

The claim in [Option G](09-option-g-time-based-audit-horizon.md) is that
`RETENTION_ROWS = 20_000` is nowhere near reached at this install's size, and
that the rate driver is `POST /api/mcp` rather than browser traffic. The second
half is measured by grep at HEAD; the first half is arithmetic on a run count
taken from the transcript corpus.

```sh
sqlite3 "$DATA_DIR/usagefoundry.db" "SELECT COUNT(*) FROM request_log;"
sqlite3 "$DATA_DIR/usagefoundry.db" \
  "SELECT path, method, COUNT(*) n FROM request_log
    GROUP BY path, method ORDER BY n DESC LIMIT 15;"
sqlite3 "$DATA_DIR/usagefoundry.db" \
  "SELECT MIN(ts), MAX(ts), COUNT(*) FROM request_log;"
```

**What overturns what.** A count at or near 20,000 means the table has already
evicted and the trail is shorter than its whole history, which is
[GapRegister G4](../GapRegister/03-growth.md)'s concern arriving. If
`/api/mcp` is not at the top of the second query, this proposal's correction to
G4 is wrong and the rate driver is something else. The third query is the one
figure nobody has: **how many days 20,000 rows buys.**
`docs/verification.md` already lists "the audit trail on a real database" among
the things not verified by hand.

## §5 — Repositories per mount

`MAX_FOLDERS_PER_MOUNT = 400` (`workspace.ts:25`, applied `:73` and `:81`) is the
repository axis's one bound that no surface reports and that this survey has
almost no data on: **n = 2 mounts, one repository each.** A survey with n = 2 on
an axis should be read as having no opinion about it, which is why
[Option E](07-option-e-raise-the-mount-ceiling.md) is refused rather than argued.

```sh
# Per mount, the count scanWorkspace() is bounded against:
for m in /workspace /workspace2 /workspace3 /workspace4; do
  [ -d "$m" ] && printf '%s %s\n' "$m" \
    "$(find "$m" -maxdepth 2 -name .git -prune | wc -l)"
done
```

**What overturns what.** Anything above ≈300 in one mount and folder discovery
starts truncating at a bound that, unlike `retention.ts`'s, this proposal did not
check for a `partial` flag. That would be a third silent truncation and would
belong in [01-ceilings.md](01-ceilings.md) group 3 beside rows 18 and 19.

## The commands that were run, and what they returned

All read-only, all from harnesses under `/tmp/uf-721638d11c0b-1/` importing from
a scratch `.test-build/`, nothing written inside the repository.

```
# 1. Corpus size and growth rate — the denominator under every extrapolation.
find ~/.claude/projects -name '*.jsonl' | wc -l                        → 1236
… total bytes                                                          → 973,785,312
… distinct mtime days                                                  → 14
                                                        ⇒ ≈88 files/day, ≈69.6 MB/day

# 2. Cold vs warm scanUsage(), five separate processes each.
cold                                                                   → 2,985-3,041 ms
warm, same process                                                     → 82.5-88.9 ms
                                                                       ⇒ ratio ≈36×

# 3. buildSnapshot() over the returned entries, n = 12.
min / p50 / max                                                        → 12.67 / 13.09 / 31.40 ms

# 4. Peak memory during a cold scan, from process.memoryUsage() inside the harness
#    (/usr/bin/time -v does not exist in this container).
RSS / heapUsed                                                         → 323-372 MB / 149-205 MB

# 5. Event-loop delay during a cold scan, n = 5.
p50 / p90 / p99 / max                                                  → ≈8 / 17-20 / 29-34 / 36-45 ms

# 6. Cache occupancy against TRANSCRIPT_CACHE_MAX_ENTRIES.
transcriptCacheStats()  → {files:1236, entries:101658, toolCalls:63504,
                           maxEntries:500000, evictions:0}              ⇒ 20.3%, zero evictions

# 7. scanUsage()'s own return, reconciled against the cache's retention.
entries / toolCalls / sidechains                                        → 52,469 / 63,504 / 14,341

# 8. fileCostNotice() on this repository.
first call / steady (n = 7) / notice length                             → 45.61 ms / 14.08-16.87 ms / 1,482 chars

# 9. readCountsFor() against an EMPTY run_events — a floor, see §1.
                                                                        → 8.29 ms

# 10. Mount entry counts against MAX_WALK_ENTRIES = 20,000.
find /workspace/UsageFoundry -path '*/node_modules' -prune -o -path '*/.git' -prune -o -print | wc -l
                                                                        → 1951  (9.8%)
find /workspace2 -path '*/node_modules' -prune -o -path '*/.git' -prune -o -print | wc -l
                                                                        → 1247  (6.2%)

# 11. Who writes to request_log.
grep -rn "recordRequest(" src/ --include=*.ts | grep -v test            → 3, all inside requestLog.ts
grep -rn "export const [A-Z]* = auditMutation" src/app/api --include=route.ts | wc -l
                                                                        → 33
… by method                                  → POST 20, DELETE 7, PUT 5, PATCH 1, GET 0
… files containing those exports                                        → 26
… plus /api/mcp's POST, wrapped inside the handler at route.ts:671      → 1
                                                       ⇒ 34 audited handlers over 27 route files

# 12. Whether any long-lived SQLite cursor exists (Option F's precondition).
grep -rc "\.iterate(" src/ | awk -F: '{s+=$2} END {print s+0}'          → 0

# 13. Route surface.
find src/app/api -name route.ts | wc -l                                 → 56

# 14. The stale in-checkout database, opened read-only to confirm it holds no
#     history worth a curve. It does not.
runs / run_events / run_deps / request_log / ops_events                  → 0 / 0 / 0 / 8 / 1
ls -la /workspace/UsageFoundry/.data/  → usagefoundry.db 278,528 bytes (Aug 19 16:35)
                                          usagefoundry.db-wal 0 bytes
```

**On that last line, because it looks like a §-free answer to Option F and is
not.** The only `-wal` file reachable from this container is 0 bytes, and it
belongs to an idle 278 KB copy with no rows in it. A checkpointed WAL on an idle
database measures nothing about a busy one;
[Option F](08-option-f-sqlite-write-path.md)'s refusal still rests on the
`.iterate(` count and the single-writer invariant, not on this.

## What would count as this survey having failed

Three outcomes, in descending order of how likely they are.

**The per-child memory figure comes back low and nobody raised the ceiling.**
Then the recommendation's Step 3 was the whole value of the proposal and the two
instrumentation steps were a distraction from a raise that was available all
along. This is the most likely way this is wrong.

**Something breaks that is not in [01-ceilings.md](01-ceilings.md).** The
catalogue claims 31 bounds and 0 failures. A 32nd bound that *does* fail — a
throw, a corruption, a silently dropped write — means the catalogue's method
missed a class, and the method was: read every constant on the growth paths named
in `CLAUDE.md`'s gate list and ask what happens at each one. A miss would most
likely be somewhere `CLAUDE.md` does not gate.

**The install grows on an axis this proposal did not name.** Three were given —
concurrent runs, repositories, months of history. A fourth (operators, plugins,
workflow instances, chat threads) growing faster than any of them would make the
ranking wrong without making any individual measurement wrong.

## What this survey deliberately did not check

**Anything requiring a browser.** No page was rendered at any viewport. Claims
about what the home page shows come from reading `src/app/page.tsx:876-882`, not
from seeing it.

**Anything requiring a second process.** The whole of
[Option F](08-option-f-sqlite-write-path.md) rests on there being one writer, and
that was established by reading the ownership invariant rather than by starting a
second container and watching it refuse.

**The WAL file.** `ls -la /data` returns `Permission denied`, so
`usagefoundry.db-wal` was never sized. Option F's refusal rests on the mechanism,
not on an observation of the file, and says so.

**The stale in-checkout database, past confirming it is empty.**
`/workspace/UsageFoundry/.data/usagefoundry.db` is a 278 KB 2026-08-19 copy
holding 0 `runs`, 0 `run_events`, 0 `run_deps`, 8 `request_log` and 1
`ops_events` row. It was opened read-only once, for those counts, and then left
alone: a growth curve built on it would be a growth curve built on nothing.
