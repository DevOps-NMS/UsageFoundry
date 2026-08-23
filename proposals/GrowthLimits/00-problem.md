# The problem

**The question:** what breaks first as this install grows — more concurrent
runs, more repositories, more months of history — and which ceiling is worth
raising before it is hit?

The question contains an assumption worth testing before answering it: that
something breaks. Thirty-one bounds were found and catalogued in
[01-ceilings.md](01-ceilings.md). **None of them breaks.** Every one either
degrades visibly, queues, truncates and says so, or is unreachable under the
retention defaults the app already ships. Two announce nothing when they are
reached, and both were measured to be an order of magnitude away on the only two
repositories this container can read.

So the honest shape of the answer is not a ranked list of failures. It is a
ranked list of *readings nobody has*, and one ceiling whose raise is a genuine
decision somebody has already half-taken in writing.

## The three axes, and what each one is measured at here

### Months of history — measured

The corpus is `~/.claude/projects`, which is a bind mount of the host's real
`~/.claude` (`CLAUDE.md`, and `config.ts:59, :62`). It is readable from a work
cycle, which makes it the one growth axis with a real rate behind it.

```
find ~/.claude/projects -name '*.jsonl' | wc -l         → 1236
find ~/.claude/projects -name '*.jsonl' -printf '%s\n' | paste -sd+ | bc
                                                        → 973785312   (973.8 MB)
find ~/.claude/projects -name '*.jsonl' -printf '%TY-%Tm-%Td\n' | sort -u | wc -l
                                                        → 14 distinct days
```

**≈88 transcript files and ≈69.6 MB per day**, over 14 days of continuous use.
That is this install's real growth rate on the history axis, and it is the only
rate in this proposal that is not reasoned.

### More repositories — bounded at four, and the fourth is a deployment file

`MOUNTED_WORKSPACE_SLOTS = 4` (`src/lib/config.ts:213`), and the ceiling is the
number of `volume:` lines in `docker-compose.yml`, not a cap in `parseMounts` —
which has none, "and must not gain one, because a compose override file is a
legitimate way to mount more" (`config.ts:205-209`).

Two mounts are readable from this container: `/workspace` and `/workspace2`.
Their sizes, which matter for one of the bounds below:

```
find /workspace/UsageFoundry -path '*/node_modules' -prune -o -path '*/.git' -prune -o -print | wc -l
                                                        → 1951
find /workspace2 -path '*/node_modules' -prune -o -path '*/.git' -prune -o -print | wc -l
                                                        → 1247
```

### More concurrent runs — shipped at four, and the number was chosen against a
memory figure the code itself calls reasoned

`maxConcurrentRuns: 4` and `maxConcurrentAssists: 2` in `DEFAULTS`
(`src/lib/settings.ts:711-712`). The doc comment at `:205-232` says 4 was
"chosen against the memory limit `docker-compose.yml` now ships (10 GiB) at
roughly 1.5 GiB for a work cycle", and then says of that per-child figure:
**"That per-child figure is reasoned rather than measured."** `settings.ts:765`
records the change itself as "Measured, not reasoned. `8651bcd` raised
`maxConcurrentRuns` from `null` to 4".

Both sentences are true and they are about different things. The *decision to
have a ceiling* was measured. The *number* rests on a per-child memory figure
nobody has taken. That is the gap [05-option-c](05-option-c-raise-the-run-ceiling.md)
is about, and it is the only place in this proposal where raising a number is
the recommendation-shaped answer.

## What was measured, and how

Every figure below was taken in this container, from harnesses under
`/tmp/uf-721638d11c0b-1/` importing the app's own compiled modules from
`.test-build/lib/`, read-only. Reported as intervals over repeated samples, per
`/workspace2/3 Resources/Debugging and Observability/Benchmarking Honestly.md`,
which asks for the interval rather than the best run and for the cold and
steady-state phases to be reported separately rather than averaged together.

| Measurement | Result | n |
|---|---|---|
| `scanUsage()` **cold** (fresh process, 1,236 files, 973.8 MB) | **2,985–3,041 ms** | 5 processes |
| `scanUsage()` **warm** (same process, second call) | **82.5–88.9 ms** | 5 |
| Ratio cold : warm | **≈36×** | |
| `buildSnapshot()` over the 52,469 entries that scan returns | min 12.67, **p50 13.09**, max 31.40 ms | 12 |
| Peak RSS / heap during a cold scan | **323–372 MB** / 149–205 MB | 5 |
| Event-loop delay *during* a cold scan | p50 ≈8, p90 17–20, p99 29–34, max 36–45 ms | 5 |
| Transcript cache occupancy after one scan | **101,658** entries of `TRANSCRIPT_CACHE_MAX_ENTRIES` 500,000, **0 evictions** | 1 |
| `fileCostNotice()` on `/workspace/UsageFoundry`, first call | **45.61 ms** | 1 |
| `fileCostNotice()` steady (memo warm) | **14.08–16.87 ms** | 7 |
| `readCountsFor()` against an **empty** `run_events` | 8.29 ms | 1 |

Three things about that table, because they are what makes it usable rather than
decorative.

**The cold figure is the one nobody had.** `transcripts.ts:256-268` already
carries a measurement of this path taken in this container against a nearly
identical tree — "505 directories, 2,185 files, 1,174 transcripts" against
today's 1,236 — and reports the directory walk at 49 ms parallelised, the stats
at 9 ms, the dedupe at 8 ms, the sort at 3 ms, and `GET /api/usage` at 164-186 ms.
Those are all **warm** figures: the per-file offset cache means a steady-state
scan stats every file and reads only what was appended. My 82.5 ms warm
reconciles with them. The 3,000 ms cold does not contradict them, it is a phase
they do not cover, and it is paid on **every container restart** because the
cache is process-local (`transcripts.ts:672-676` says so: "the cache is
process-local, so the first scan after one reads every file from byte 0").

**52,469 and 101,658 are both correct and count different things.** `scanUsage()`
returns 52,469 entries after the cross-file dedupe on the `message.id` +
`requestId` pair (`transcripts.ts:24-26`); the cache retains 101,658 per-file
records, which is what `retainedEntries()` reports and therefore what the
500,000 bound is compared against. 14,341 of the returned entries are
sidechains.

**The `fileCostNotice` figure is `walkRepo` and nothing else.** `readCountsFor`
reaches `run_events` through a `json_extract` over 30 days of payloads, and
against an **empty** table that costs 8.29 ms. That is a floor, not a
measurement of the thing that grows, and the figure that matters is not mine:
`fileCostNotice.ts:290-291` records **38 ms against 131,572 rows, "measured in
process rather than through `docker exec`"**. `run_events` is written on every
tool call of every cycle of every run and no index can serve
`json_extract(e.payload, '$.input.file_path')` — the docblock refuses one because
it "would move the cost onto every `run_events` insert instead".

So the growth term here is a **product of two axes inside `createRun`'s
no-`await` window**, and the docblock states it: the memo is per folder, so "a
workflow instantiating twenty nodes is one synchronous pass through `createRun`
and would pay it twenty times, blocking the event loop for the sum." At
`MAX_WORKFLOW_NODES = 25` (`apiTypes.ts:980`) and the project's own 38 ms, that
is **≈950 ms of blocked event loop** on one press, at one install's row count.
Nothing here re-measured it — that is [12-validation.md](12-validation.md) §1,
and it is the largest single synchronous cost this survey found.

## What could not be reached

- **Any run history.** `ls -la /data` returns `Permission denied`; the
  in-checkout `.data/usagefoundry.db` is a stale 2026-08-19 copy with zero
  `runs` rows. So there is no queue depth, no admission rate, no `run_events`
  row count and no `request_log` depth anywhere in this proposal, and every
  claim that would need one says so at the point it is made. **No growth curve
  here is built on run history**, because there is none to build on.
- **A load test.** Docker is unavailable in this container. The exact commands a
  human would run are in [12-validation.md](12-validation.md) §2, and nothing in
  this proposal is phrased as though they had been run.
- **Container-level memory under concurrency.** Which is the measurement that
  decides `maxConcurrentRuns`, and it needs `docker stats` against a running
  fleet. `/usr/bin/time -v` does not exist in this image either, so even the
  single-child figure was taken from `process.memoryUsage()` inside a harness
  rather than from the outside.
- **More than two repositories.** The repository axis is measured at n = 2, both
  of them roughly 1,200-2,000 entries. Nothing here knows what a 100,000-file
  monorepo does, which is exactly the case the two silent truncations are for.

## Where this sits next to the three proposals already on this branch

[GapRegister](../GapRegister/03-growth.md) surveyed this axis first and its four
rows are the starting point, not competition. This proposal **confirms G1 and G2
unchanged** (`src/app/api/runs/route.ts:49` is still `listRuns(100)` with no
`searchParams`), **agrees with G3 and adds nothing to it**, and **refines G4
with two facts G4 could not have had** — see
[02-issue-map.md](02-issue-map.md) §G4 and
[09-option-g](09-option-g-time-based-audit-horizon.md). It does not re-derive any
of the four.

The one thing this proposal adds to the register's framing: G3 concluded that
*SQLite is not the constraint*, from the vault's two structural boundaries. That
holds, and it is now checkable rather than argued —
[08-option-f](08-option-f-sqlite-write-path.md) shows both of the vault's
concrete SQLite failure modes have a **precondition that is absent from this
tree**, one of them provably (`grep -c '\.iterate(' src/ -r` → 0).
