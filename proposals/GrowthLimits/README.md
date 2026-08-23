# Growth limits

**The question:** what breaks first as this install grows — more concurrent runs,
more repositories, more months of history — and which ceiling is worth raising
before it is hit?

**The state:** open. Thirty-one bounds catalogued with file, line and what
happens at each one; seven options scored; one recommendation in three ordered
steps; three options refused by name and one handed back to the proposal that
owns it. **Nothing here is a decision and no product code changed.**

**The short answer:** nothing breaks. **Zero** of the thirty-one bounds fail,
throw, corrupt or lose data, and **zero** numeric bounds are reachable within
thirty days at this install's measured growth rate. So no ceiling is worth
raising yet, and the work worth doing is making the first install that does grow
past this one say so.

## The recommendation

**Three steps, and the third is a reading rather than a change**,
[11-recommendation.md](11-recommendation.md).

1. **Put a number on the cold transcript scan** — [Option A](03-option-a-instrument-the-axes.md).
   `scanMs` and `scanWasCold` on `transcriptCacheStats()`'s return
   (`transcripts.ts:656-664`) and on `/api/status`. Measured here: cold
   **2,985-3,041 ms**, warm **82.5-88.9 ms**, a factor of **36**. Paid on the
   first `/api/usage`, `/api/status`, pre-cycle guard or `assistRefusal()` after
   every container restart, because the cache is process-local. The DTO slot, the
   payload field and the render site all already exist. **Take a new
   `globalThis` key** rather than widening `__ufScanHealth`, for the reason
   `transcripts.ts:136-143` records.
2. **Make the file price list confess a short walk** — [Option B](04-option-b-report-the-truncation.md).
   `walkRepo` returns `{files, partial}` instead of `RepoFile[]`; one clause in
   the notice, a count and never a path. Insurance rather than a fix: measured
   occupancy is **9.8%** and **6.2%** on the two readable repositories. On the
   list anyway because it is one of only **two** silent truncations in the
   survey, its reader is an agent rather than a person, and the same repository
   reached the opposite conclusion for the identically-named constant in
   `retention.ts`.
3. **Take one `docker stats` reading, then decide `maxConcurrentRuns`** —
   [Option C](05-option-c-raise-the-run-ceiling.md). `settings.ts:765` says
   having a ceiling was "**Measured, not reasoned**"; `settings.ts:205-232` says
   where it sits rests on ≈1.5 GiB per work cycle and that figure "**is reasoned
   rather than measured**". Near 1.5 GiB and 4 is right. Near 600 MB and two
   thirds of a 10 GiB budget is unused and this becomes the survey's highest-value
   change. **Docker is unavailable in this container; the commands are in
   [12-validation.md](12-validation.md) §2 and were not run.**

**What would overturn it:** the per-child memory figure coming back low, which is
the most likely way this is wrong. Also a repository past ≈15,000 walk entries, a
`transcriptRetentionDays` raised above 30, a non-zero `cache.evictions`, or a
`.iterate(` appearing in `src/`. All five are checks, in
[11-recommendation.md](11-recommendation.md).

**Refused by name:** raising the four-mount ceiling (already raisable, and #77 is
fixed, documented and unit-tested), hardening the SQLite write path (both failure
modes lack their preconditions, one provably), and putting `request_log` on a time
horizon (the shape was chosen deliberately and is a term in a security argument).

## The findings at a glance

| | |
|---|---|
| Bounds catalogued, with file and line | **31** |
| That fail, throw, corrupt or lose data at the bound | **0** |
| That queue or refuse visibly | 9 |
| That truncate and report it | 8 |
| **That truncate silently** | **2** — `walkRepo`'s 20,000 and `MAX_REMOTES_READ` |
| That evict | 4 |
| Costs that grow with an axis and have **no** bound at all | 8 |
| Measured against in this container | **11** rows |
| Reachable at the measured growth rate within 30 days | **0** of the numeric bounds |
| Already exceeded at this install's size | **1** — `listRuns(100)` against 294 measured runs, which [GapRegister](../GapRegister/03-growth.md) owns |
| Bounds whose docblock records a growth problem somebody already fixed | **4** |
| Measured growth rate of the history axis | **≈88 transcript files and ≈69.6 MB per day** (1,236 files / 973.8 MB over 14 distinct mtime days) |
| Open issues reconciled | **7** — 1 superseded outright, 2 superseded in the majority of their mechanisms, 3 refined with a measurement, 1 left alone |
| Distinct sub-issues across those seven that no longer reproduce at HEAD | **10** |
| Issues filed, closed or commented on | **0**, **0**, **0** |
| Runs whose history could be read | **0**. `/data` is `Permission denied`; the stale in-checkout copy holds 0 `runs`, 0 `run_events`, 8 `request_log` and 1 `ops_events` row |
| Load tests run, containers started, concurrent runs observed | **0**, **0**, **0** |

Full catalogue: [01-ceilings.md](01-ceilings.md). The measured figures and how
they were taken: [00-problem.md](00-problem.md).

## The four findings that shape everything else

**The retention defaults bound the history axis, and that is why nothing
breaks.** `eventRetentionDays: 30`, `checkoutRetentionDays: 7` and
`transcriptRetentionDays: 30` (`settings.ts:726-728`) mean three of the four
history-growing costs **plateau** rather than grow. Extrapolating the measured
rate against the 30-day horizon gives ≈2,650 transcript files, ≈2.1 GB, a cold
scan of ≈6.4 s, and cache occupancy of ≈218,000 of 500,000 —
so `TRANSCRIPT_CACHE_MAX_ENTRIES` is **unreachable under the shipped default**.
That is arithmetic on a measurement, and it is the single fact that turns the
brief's question from "which ceiling" into "which instrument".

**Four bounds exist because somebody already asked this question.** Rows 14 and
17 of the catalogue, `SCAN_CONCURRENCY = 12` and `currentSnapshot()`'s
single-flight each carry a docblock naming a growth problem in the past tense.
The single-flight's is the clearest: "N runs reaching a cycle boundary together
did N full-history aggregations back to back, on the one event loop." **The app is
not approaching its ceilings; it has been walking away from them**, and the two
costs that would have multiplied with `maxConcurrentRuns` at the tree #68 read
now multiply with neither.

**The one already-exceeded ceiling is a reach problem, not a resource problem.**
`listRuns(100)` (`src/app/api/runs/route.ts:50`) against
[ContinuousImprovement](../ContinuousImprovement/README.md)'s measured 294 runs
means this install cannot see two thirds of its own history through its own API.
It scores second in [10-comparison.md](10-comparison.md) and is handed back to
[GapRegister](../GapRegister/03-growth.md) G1/G2 rather than recommended, on the
ownership criterion alone. [10-comparison.md](10-comparison.md) §2 says plainly
what that means: if the reader disagrees that a neighbour's ownership matters,
**Option D is this survey's recommendation and Option A is second.**

**Peak memory is not the size of the transcript tree, and #68's measurement of it
is superseded.** Measured **323-372 MB RSS** (n = 5) against 973.8 MB of
transcripts, because `SCAN_CONCURRENCY = 12` bounds the fan-out that used to hold
every descriptor and every whole-remainder buffer at once. `transcripts.ts:666-680`
describes the mechanism it replaced in exactly those terms.

## What already exists to build on

Recorded because it is why one option is nearly free and three are refused.

- **A memory reading is already on a payload and already rendered.**
  `cache: transcriptCacheStats()` (`src/app/api/usage/route.ts:150`), the DTO at
  `apiTypes.ts:310`, and the home page renders the one field of it that is a
  warning, on `evictions > 0` (`src/app/page.tsx:876-882`). Option A adds two
  fields to a shape that exists for exactly this purpose.
- **The identically-named bound in `retention.ts` already reports its
  truncation.** `MAX_WALK_ENTRIES = 120_000` (`retention.ts:725`), `treeSize`
  returning `{bytes, partial}` (`:759`), and a docblock arguing that a walk
  "says when it stopped". Option B is that pattern, copied.
- **The four-mount ceiling is already raisable and #77 is closed in fact.**
  `parseMounts` has no cap and `config.ts:205-211` forbids it gaining one;
  `config.ts:234-251` throws at module load naming the variable the operator set;
  `docs/install.md:493-505` documents the override; `config.test.ts:22-60` pins
  the message.
- **There is exactly one SQLite writer, and no cursor API in use anywhere.**
  `grep -rc "\.iterate(" src/` sums to **0**, which closes checkpoint
  starvation's precondition more firmly than a load test would have.

## What this survey could not do

- **Read any run history.** `ls -la /data` → `Permission denied`. The stale
  in-checkout copy holds 0 `runs`, 0 `run_events`, 0 `run_deps`, 8 `request_log`
  and 1 `ops_events` row, opened read-only once for those counts. **No growth
  curve here is built on run history**, because there is none to build on. Every
  growth rate in this proposal comes from the transcript corpus on disk, which is
  a proxy for the run history and not the run history.
- **Run a load test, or observe two concurrent runs.** Docker is unavailable in
  this container. Every figure was taken single-process, from harnesses under
  `/tmp/`, and the exact commands a human would run instead are
  [12-validation.md](12-validation.md) §2.
- **Measure container memory under concurrency.** Which is the one reading the
  whole concurrency axis rests on, and the reason
  [Option C](05-option-c-raise-the-run-ceiling.md) is deferred rather than
  recommended or refused.
- **Say anything about more than two repositories.** n = 2 mounts, one repository
  each, both an order of magnitude below `MAX_WALK_ENTRIES` and two below
  `MAX_FOLDERS_PER_MOUNT = 400`. A survey with n = 2 on an axis should be read as
  having no opinion about it, and [12-validation.md](12-validation.md) §5 is the
  reading that would give it one.
- **Time `readCountsFor` against a real `run_events`.** 8.29 ms against an empty
  table is a floor. The project's own figure — 38 ms against 131,572 rows
  (`fileCostNotice.ts:290-291`) — is better than mine, and the arithmetic on it
  (≈950 ms of blocked event loop at `MAX_WORKFLOW_NODES = 25`) makes it the
  largest synchronous cost in the survey and
  [12-validation.md](12-validation.md) §1.

## Files

| | |
|---|---|
| [00-problem.md](00-problem.md) | The three axes, every figure measured here with its n, the reconciliation of the two entry counts, and everything that could not be reached |
| [01-ceilings.md](01-ceilings.md) | **The spine.** Thirty-one bounds in five groups — queue or refuse, truncate and report, truncate silently, evict, and grow unbounded — each with file, line, what happens at the bound, the axis that reaches it, and whether it was measured or inferred |
| [02-issue-map.md](02-issue-map.md) | The seven open issues, one verdict each: #77 superseded outright, #68 and #91 superseded in the majority of their mechanisms, #78, #114 and #99 refined with a measurement, #89 left alone. Ten sub-issues that no longer reproduce, two findings carried forward, nothing filed |
| [03-option-a-instrument-the-axes.md](03-option-a-instrument-the-axes.md) | **Recommended first.** Two fields, no threshold, no warning colour — report the number, do not judge it |
| [04-option-b-report-the-truncation.md](04-option-b-report-the-truncation.md) | **Recommended second.** One boolean out of `walkRepo`, and the honesty asymmetry against `retention.ts` that makes it a defect rather than a nicety |
| [05-option-c-raise-the-run-ceiling.md](05-option-c-raise-the-run-ceiling.md) | The survey's only non-refused raise, deferred on one reading. Why "measured, not reasoned" and "reasoned rather than measured" are both true of the same number |
| [06-option-d-make-the-history-reachable.md](06-option-d-make-the-history-reachable.md) | The one ceiling already passed, handed back to GapRegister with one measurement added: a 100-row response was 696,197 bytes and the prompt field alone was 522,541 |
| [07-option-e-raise-the-mount-ceiling.md](07-option-e-raise-the-mount-ceiling.md) | Refused. Zero files to change, and the asymmetry that makes the refusal safe is the one that makes the ceiling raisable |
| [08-option-f-sqlite-write-path.md](08-option-f-sqlite-write-path.md) | Refused. The strongest-looking option in the survey; both failure modes lack their precondition and `grep -rc "\.iterate(" src/` → 0 proves one of them absent |
| [09-option-g-time-based-audit-horizon.md](09-option-g-time-based-audit-horizon.md) | Refused, with a correction to GapRegister G4: a polling browser writes **no** audit rows: `POST /api/mcp` is the rate driver, and that is agent traffic |
| [10-comparison.md](10-comparison.md) | Eight weighted criteria, justified before the scores, and four places the table misleads — starting with the fact that it returns the answer the brief invited |
| [11-recommendation.md](11-recommendation.md) | Three steps, three refusals by name, one option handed back, five falsifiers |
| [12-validation.md](12-validation.md) | Five measurements that would confirm or overturn this and could not be taken here, fourteen commands that were run with what they returned, and what would count as this survey having failed |

## Neighbours

[GapRegister](../GapRegister/) owns three rows this survey touches, and none of
them is overturned. **G1 and G2** (reachability, `listRuns(100)`,
`listChats(30)`, `MAX_REMOTES_READ`) are confirmed unchanged at HEAD and handed
back with one measurement added; [06-option-d](06-option-d-make-the-history-reachable.md)
records that the payload-size objection to paging has since been dissolved by an
unrelated change, so the case is now reach alone — which is what G1 said. **G3**
read the same vault note on embedded databases and reached the same conclusion
this proposal's [Option F](08-option-f-sqlite-write-path.md) reaches; Option F
adds the two preconditions and the `.iterate(` count. **G4** is refined rather
than refuted: its mechanism is exactly right and its rate premise is not, because
`auditMutation` wraps no `GET` handler and a polling browser therefore writes
nothing to `request_log`.

[UnattendedOperation](../UnattendedOperation/) established `/api/status` as the
app's designed pull-based position and enumerated twelve alertable conditions in
`README.md`. [Option A](03-option-a-instrument-the-axes.md) puts its two fields
there for that reason and makes a thirteenth possible without adding a channel.
Its criticisms of the pull-based position all apply; the mitigation is that a
scan duration moves on a timescale of months, so a monthly glance is a sufficient
cadence, which is not true of anything in that survey.

[ContinuousImprovement](../ContinuousImprovement/) contributes the only run-count
figure in this proposal — 294 runs, measured from the transcript corpus rather
than the database — and it is what makes `listRuns(100)` an exceeded ceiling
rather than a distant one.

[OperatorInterface](../OperatorInterface/) is not touched. Its subject is what a
second reader can see; this one's is what a larger install can survive.

None of the four is edited by this proposal beyond these cross-references, and
none of their central findings is re-derived here.

Verification loop on the tree this was written against (`ffe6687`):
`npm run typecheck` exit 0; `npm test` **1,578 tests / 230 suites / 0 failures**
in 16.55 s. **This proposal changes no `src/`**, so a red tree here would be
somebody else's change, not this one's — and green tells you nothing about any of
it, since nothing in this repository has ever been load-tested and every ceiling
above was measured from outside the app.
