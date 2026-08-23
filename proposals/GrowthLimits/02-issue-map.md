# The issue map

Seven open issues already describe parts of this question. Read with
`export GH_PAGER=cat; gh issue view <N> --repo Xapicc/UsageFoundry`.
**Nothing was filed, closed or commented on.**

One verdict per issue: **supersede** (the finding no longer reproduces against
HEAD), **refine** (it holds, and a measurement or a line reference changes what
to do about it), or **leave alone** (it holds and this proposal adds nothing).

| Issue | Title | Verdict |
|---|---|---|
| [#68](https://github.com/Xapicc/UsageFoundry/issues/68) | Concurrency and state integrity at 25 simultaneous runs | **Supersede in four of five mechanisms; refine the rest** |
| [#78](https://github.com/Xapicc/UsageFoundry/issues/78) | Multi-repository operation | **Refine** — 4 of its 9 hard limits have moved, 5 are unchanged |
| [#114](https://github.com/Xapicc/UsageFoundry/issues/114) | Consolidated: multi-repo, 25 concurrent runs | **Refine** — its growth-axis blockers are addressed; its premise is not the shipped configuration |
| [#91](https://github.com/Xapicc/UsageFoundry/issues/91) | Container memory, cpu and pids limits | **Supersede in mechanism, leave the sizing question open** |
| [#99](https://github.com/Xapicc/UsageFoundry/issues/99) | Deployment, resource limits and operations | **Refine** — the retention half is closed; the rest is out of this axis |
| [#89](https://github.com/Xapicc/UsageFoundry/issues/89) | Security and credential blast radius | **Leave alone** — a different axis, and not one a growth survey should touch |
| [#77](https://github.com/Xapicc/UsageFoundry/issues/77) | A fifth workspace mount is silently ignored | **Supersede** — fixed, documented and unit-tested |

---

## #68 — Concurrency and state integrity at 25 simultaneous runs

The most substantial of the seven, and the one whose reconciliation is most of
this proposal's value. It named five mechanisms. **Four no longer reproduce.**

**Superseded: the liveness argument.** #68's central claim is that "three
separate routes all converge on the same 15-second number" because
`serverLock.STALE_MS` is 15 s at `serverLock.ts:56` while `gitSync` has a
20-second ceiling. Both halves have moved. `STALE_MS = GIT_SYNC_TIMEOUT_MS * 6`
(`serverLock.ts:84`) against `GIT_SYNC_TIMEOUT_MS = 20_000` (`git.ts:111`) is
**120 s**, so the staleness window is now defined *as a multiple of* the git
ceiling rather than sitting under it. One slow `git status` can no longer exceed
it on its own; six consecutive ones would be needed.

**Superseded: `beat()` never rechecks.** `heartbeat()` now reads the lock and
takes `heartbeatVerdict(held, state.ownerId)`, standing down on `"lost"` before
writing. That was #59 and it is closed.

**Superseded: the slot walk.** "`allocateSlotPath` can chain up to 64 of them in
a single HTTP request" is now bounded by `MAX_SLOT_PROBES_PER_ADMISSION = 4`
(`orchestrator.ts:2001`), whose docblock describes #68's exact scenario in the
past tense: "every admission re-examined every one of them, for ever — 64 slots
at git's own 20-second ceiling in the limit". That was #61.

**Superseded: the snapshot aggregation.** "`currentSnapshot()` adds five full
passes over the entire parsed history per run per cycle" is coalesced by the
single-flight on `__ufSnapshotInflight` (`orchestrator.ts:6905-6917`), whose
docblock names the interaction: "N runs reaching a cycle boundary together did N
full-history aggregations back to back, on the one event loop". That was #63.
**Measured cost of one such pass today: p50 13.09 ms over 52,469 entries** (n =
12), so the pre-fix cost at 25 runs would have been ≈330 ms of event-loop time
per cycle boundary, and it is now ≈13 ms shared.

**Superseded with a measurement: the memory wall.** This is the verdict the brief
asks for by name. #68 reports "peak RSS tracks total on-disk transcript bytes
1:1 (849 MB for 800 MB of files)" from an unbounded `Promise.all` at
`transcripts.ts:340`. The scan now goes through
`mapWithLimit(files, SCAN_CONCURRENCY, …)` at `transcripts.ts:759` with
`SCAN_CONCURRENCY = 12` (`:684`). **Measured at HEAD: 367 MB peak RSS, 201 MB
peak heap, against 973.8 MB of transcripts in 1,236 files.** The 1:1
relationship is gone, and `transcripts.ts:666-680` explains why in the terms #68
used. That was #58, and #68's "a container hits its memory ceiling in weeks —
and it hits at boot, so the server never comes up" does not follow from a
0.38:1 ratio against a 10 GiB `mem_limit`.

**Superseded: `run_deps.run_id` has no index.** #68's suspected finding 1 asked
for an `EXPLAIN QUERY PLAN`. It has now been run, and the answer is that the
index exists:

```
SEARCH d USING INDEX sqlite_autoindex_run_deps_1 (run_id=?)
```

`PRIMARY KEY (run_id, depends_on)` (`db.ts:349`) is an implicit unique index led
by `run_id`, so both hot queries — `orchestrator.ts:3815-3818` and `:3956-3957` —
search rather than scan, and `idx_run_deps_depends_on` (`db.ts:655-656`) exists
precisely because `depends_on` is the side the autoindex cannot serve. **Nothing
is owed here.**

Recorded at length rather than quietly, because this proposal reached the same
conclusion by the wrong route first: it inferred a scan from the absence of a
`CREATE INDEX` on `run_id` in `migrate()`, which is the wrong place to look, and
[12-validation.md](12-validation.md) §3 keeps the correction visible.

**Refined, still open: WAL growth under long-lived readers.** #68's suspected
finding 5 says "not investigated at all". It now is, to the extent it can be
without a load test: checkpoint starvation requires a reader whose transaction
outlives a checkpoint attempt, and

```
grep -rc "\.iterate(" src/ | awk -F: '{s+=$2} END {print s}'   → 0
```

**there is no `.iterate()` anywhere in `src/`.** Every read in this app is a
`.get()` or `.all()`, which completes inside one statement. The precondition for
starvation is provably absent, which is a stronger statement than a measurement
of its absence would have been. See
[08-option-f](08-option-f-sqlite-write-path.md).

**Credited, not re-derived.** #68 measured `busy_timeout` at 5000 ms on a fresh
handle with this repository's build, and measured 0.02 ms per `run_events`
insert. Both are used in this proposal as its numbers, not re-taken.

---

## #78 — Multi-repository operation

Its verdict — "**nothing about correctness. Everything about reclamation and
reach**" — holds, and this proposal has nothing to add to the correctness half.
Its hard-limit table is what needed checking, because every line reference in it
has moved. Nine rows, re-read against HEAD:

| #78's row | Value at HEAD | Verdict |
|---|---|---|
| checkout slots per repository, 64, `orchestrator.ts:1592` | `MAX_WORKTREE_SLOTS = 64`, `orchestrator.ts:2675` | **unchanged**, now a named constant |
| branches per inventory, 60, `land.ts:1873`, "`/api/branches` accepts no parameters at all" | `MAX_INVENTORY = 60`, `land.ts:2119` | **superseded on the parameters**: `/api/branches` takes `repo`, `offset` and `limit` (`src/app/api/branches/route.ts:25-40`). The whole set is reachable |
| runs the inventory looks back over, 400, `land.ts:1931` (`listRuns(400)`) | gone — replaced by "a query of its own rather than `listRuns(400)` and a filter" (`land.ts:2421`) | **superseded** |
| runs on `/api/runs`, 100, `route.ts:19` | `listRuns(100)`, `src/app/api/runs/route.ts:50` | **unchanged**. [GapRegister G1](../GapRegister/03-growth.md) owns it |
| folders per mount, 400, `workspace.ts:25` | `MAX_FOLDERS_PER_MOUNT = 400`, `workspace.ts:25` | **unchanged**, same line |
| repositories per chat scan, 25, `workspace.ts:168` | `MAX_REMOTES_READ = 25`, `workspace.ts:168` | **unchanged**, same line |
| merge workers, 1 per process, `mergeQueue.ts:341` | `MAX_MERGE_WORKERS = 4`, `mergeQueue.ts:613` | **superseded** — that was #67 |
| GitHub credentials, 1 per install, `config.ts:186` | `UF_GITHUB_TOKENS` and `selectGithubToken(...)` at `config.ts:366, :422`, keyed off `runs.repo_root` (`chat.ts:2238`) | **superseded** — a per-repository dimension exists |
| workspace mounts, 4, "a fifth is silently discarded (#77)" | `MOUNTED_WORKSPACE_SLOTS = 4`, `config.ts:213`, and a fifth **refuses the boot** | **superseded** — see #77 below |

**Four superseded, five unchanged.** The five that are unchanged are all
*reach* limits, which is exactly the half #78 said was the problem, and four of
those five are owned by GapRegister rows. **This proposal leaves #78's
substantive finding alone** and contributes only the corrected table above.

---

## #114 — Consolidated: multi-repo, 25 concurrent runs

**Refine.** Its answer — "No. Do not deploy this at 25 concurrent runs" — was
right about the tree it read and is the wrong question to ask of HEAD, for two
reasons.

**Its premise is not the shipped configuration.** #114 lists #64 as belonging on
its blocker list "because *the target configuration cannot be expressed today*:
`maxConcurrentRuns` ships as `null`". It now ships as **4**
(`settings.ts:711`), with a second ceiling `maxConcurrentAssists: 2` (`:712`)
covering the other three kinds of child through `assistRefusal`
(`review.ts:437-444`). `settings.ts:765` records the change as "Measured, not
reasoned". So 25 concurrent runs is not a configuration this install has, and
asking what breaks at 25 is asking about a setting an operator would have to
raise by a factor of six first — which is
[05-option-c](05-option-c-raise-the-run-ceiling.md)'s question, and the answer
there is that one measurement should come before it.

**Its growth-axis blockers are addressed; its security blockers are not this
proposal's axis.** Of the seventeen issues on its shortest-deployable list,
**#79-#87 are security** and belong to #89 — this proposal takes no position on
them and does not count them as closed. Of the rest: #58 (superseded, measured
above), #64 (superseded, `maxConcurrentRuns: 4`), #59 (superseded,
`heartbeatVerdict`), #60 (superseded in mechanism — `stop_grace_period: 30s` at
`docker-compose.yml:460`, which #68 named as the co-requisite), #91 (superseded,
below), #92 (`docs/backup-and-restore.md` exists), #90 (`NODE_OPTIONS:
--max-old-space-size` is explicit at `docker-compose.yml:201`), #93 (closed —
[GapRegister G3](../GapRegister/03-growth.md) records it and the
`ReadOnlyNotice` path).

What #114 got right and this proposal confirms rather than re-derives: **"the
mutual-exclusion design is sound and does not need to change."** `createRun`
still runs from entry to INSERT with no `await`, and the two bounds that keep it
that way — `MAX_SLOT_PROBES_PER_ADMISSION = 4` and `walkRepo`'s
`MAX_WALK_ENTRIES = 20_000` — are rows 14 and 18 of
[01-ceilings.md](01-ceilings.md). **This proposal's one measured concern about
that window is row 27**: `walkRepo` costs 14.08-16.87 ms of synchronous
event-loop time per admission, and it is the only item in there that scales with
a repository's size.

---

## #91 — Container memory, cpu and pids limits before running 25 agents

**Supersede in mechanism.** Every limit it asks for is now in
`docker-compose.yml`:

| #91 asks for | At HEAD |
|---|---|
| memory limit | `mem_limit: ${UF_MEM_LIMIT:-10g}` — `:423` |
| pids limit | `pids_limit: ${UF_PIDS_LIMIT:-2048}` — `:438` |
| cpu limit | `cpus: ${UF_CPUS:-0}` — `:449` |
| an explicit heap ceiling | `NODE_OPTIONS: "--max-old-space-size=${UF_NODE_HEAP_MB:-2048}"` — `:201` |
| a stop grace period long enough to reconcile | `stop_grace_period: 30s` — `:460` |

**What it leaves open, and this proposal does not close:** whether 10 GiB is the
right number. `settings.ts:205-232` says 4 concurrent runs was chosen against
that limit "at roughly 1.5 GiB for a work cycle" and then says the per-child
figure "is reasoned rather than measured". Taking it needs `docker stats`
against a running fleet, which is impossible here. The command is in
[12-validation.md](12-validation.md) §2 and it is the measurement that decides
[05-option-c](05-option-c-raise-the-run-ceiling.md).

One figure this proposal can contribute to that sizing: **the server process's
own peak is 323-372 MB RSS during a cold transcript scan at 973.8 MB of
history** (n = 5), against the 2,048 MB heap ceiling. So the server is not the
term in the memory budget that matters; the children are.

---

## #99 — Deployment, resource limits and operations

**Refine.** Its retention half is closed and its operations half is largely
built, but neither is this proposal's contribution to make.

- **Closed:** "zero `DELETE` statements anywhere" (#62, quoted in #68's table).
  `src/lib/retention.ts` now sweeps on three horizons —
  `eventRetentionDays: 30`, `checkoutRetentionDays: 7`,
  `transcriptRetentionDays: 30` (`settings.ts:726-728`) — and every sweep asks
  the database what is live rather than reading a file's age
  (`docs/agent/retention.md`). `request_log` is bounded separately at
  `requestLog.ts:117-121`.
- **Closed:** no backup path. `docs/backup-and-restore.md` exists.
- **Built:** `/api/health` unauthenticated and bounded to counts,
  `/api/status` behind `UF_STATUS_TOKEN`, and twelve documented alertable
  conditions in `README.md`.
  [UnattendedOperation](<../implemented - UnattendedOperation/00-problem.md>) audited that
  surface row by row and owns the finding that four of nine endings are outside
  it. **This proposal does not restate it.**

**The refinement this proposal adds** is one number and it is about retention
rather than deployment: the three horizons do more than bound disk. They bound
*three of the four costs that grow with history* —
[01-ceilings.md](01-ceilings.md) group 4 — which is why the answer to the
brief's question is "nothing breaks". #99 filed retention as a storage problem.
It is also the app's growth-axis answer, and nothing in `docs/` says so.

---

## #89 — Security and credential blast radius

**Leave alone.** Its axis is what an agent can reach, not what grows, and its
findings do not become more or less true with scale — which is the reason a
growth survey should not touch them. One row is genuinely shared and it belongs
to #89: `docs/agent/security.md`'s note that
`SELF_HOSTING_NOTICE` "carries no literal an agent could `pgrep -f`" applies to
the file price list too, "because it is a list of repo-relative paths every run
on that repository shares". That is a property of the notice this proposal wants
to change ([04-option-b](04-option-b-report-the-truncation.md) adds a
truncation marker to it), so **any truncation marker must be a count, never a
path** — recorded here so it is not lost, and it is a constraint on this
proposal rather than a finding about #89.

---

## #77 — A fifth workspace mount is silently ignored rather than refused

**Supersede. Fixed, documented, and unit-tested.** The brief listed this as an
open description of the repository axis; it is not one any more.

- `unmountedWorkspaceRefusal(forwarded)` at `config.ts:234-247` builds a refusal
  naming the variable the operator set, and `config.ts:248-251` **throws at
  module load**, so the boot fails.
- Compose forwards the *names* it could not honour rather than their values, for
  slots 5 through 8: `docker-compose.yml:178`.
- `docs/install.md:493-505` is a section titled "More than four workspaces" that
  quotes the refusal text and documents the `docker-compose.override.yml` route.
- `src/lib/config.test.ts:22-60` pins the message, including that it names
  `MOUNTED_WORKSPACE_SLOTS`.

The docblock at `config.ts:214-232` states #77's own argument back: a fifth slot
was "a no-op with no error, no warning and no log line", which "reads exactly
like a directory that *is* mounted and happens to be empty".

**So the repository ceiling is now four *and raisable*, with a documented route
and a loud refusal if you take the wrong one.** That removes the only candidate
in this survey for a ceiling worth raising in code — see
[07-option-e](07-option-e-raise-the-mount-ceiling.md), which is refused for
exactly this reason.

---

## What the reconciliation adds up to

| | |
|---|---|
| Issues read | 7 |
| Superseded outright | **1** (#77) |
| Superseded in the majority of their mechanisms | **2** (#68, #91) |
| Refined | **3** (#78, #114, #99) |
| Left alone | **1** (#89) |
| Distinct sub-issues whose finding no longer reproduces at HEAD | **10** — #58, #59, #61, #62, #63, #64, #67, #77, #92, #93 |
| Findings from those issues that **still hold** and this proposal carries forward | **1** — the sizing of `mem_limit`/`maxConcurrentRuns` (#91, #114). #68's suspected finding 1 was carried forward and then closed by running its own `EXPLAIN QUERY PLAN`; #68's suspected finding 5 was closed by `grep -rc "\.iterate(" src/` → 0 |
| Filed, closed or commented on | **0** |

Ten of the twelve growth-axis findings across these issues have been fixed since
they were written, and four of them left a docblock behind that names the growth
problem in the past tense. **That is the fact that should decide what this
proposal recommends**: the project's response to this question has historically
been to measure the cost and bound it, and the two things it has never done are
report an occupancy against a bound it cannot reach, and take the one memory
measurement everything else about concurrency rests on.
