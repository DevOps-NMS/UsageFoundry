# Option A — Raise nothing; put a number on the one cost that grows

**Raise no ceiling. Report the cold transcript scan's duration on the two
payloads that already carry its siblings, so the first install to grow past
this one says so instead of being noticed.**

This is the option the brief invited ("be willing to recommend raising nothing
and instrumenting instead") and it is the recommendation. The case for it is
that of the thirty-one bounds in [01-ceilings.md](01-ceilings.md), the one with
the steepest measured slope is also the only one with **no reading anywhere**.

## What is missing, precisely

`GET /api/usage` already answers with a memory reading:

```ts
cache: transcriptCacheStats(),        // src/app/api/usage/route.ts:150
// → { files, entries, toolCalls, maxEntries, evictions }
```

and the home page already renders the one field of it that is a warning
(`src/app/page.tsx:876-882`, on `evictions > 0`). So the pattern, the payload
slot, the DTO shape (`apiTypes.ts:310`) and the render site all exist.

**What that reading does not include is how long the scan took.** Measured here:

| Phase | Measured | n |
|---|---|---|
| Cold, fresh process, 1,236 files / 973.8 MB | **2,985-3,041 ms** | 5 processes |
| Warm, same process | **82.5-88.9 ms** | 5 |
| Ratio | **≈36×** | |

Reported as two phases rather than one average, because
`/workspace2/3 Resources/Debugging and Observability/Benchmarking Honestly.md`
is explicit that mixing a cold phase into a steady-state figure produces a
number that describes neither, and because here the two differ by a factor of
36. An average would be a lie in both directions.

## Why this figure and not another

Four reasons, in order of how much they matter.

**It is paid on every restart, on whichever path asks first.** The cache is
process-local — `transcripts.ts:672-676` says so directly: "the cache is
process-local, so the first scan after one reads every file from byte 0". So the
first `GET /api/usage`, the first `/api/status`, the first pre-cycle budget
guard, or the first `assistRefusal()` after a `docker compose up` pays 3.0 s
here. Which of the four gets it is a race, and three of them are on a path an
operator is waiting on.

**It is on the admission path of every non-work-cycle child.** `assistRefusal()`
(`review.ts:437-444`) is `assistBudgetRefusal` then `windowRefusal`, and
`windowRefusal` is `currentSnapshot()` (`review.ts:469-471`), which is the scan.
`chat.ts:1492`, `land.ts:1232` and the review path all go through it.
`chat.test.ts:993` names the property in a test comment: "`assistRefusal()`,
which rescans every transcript under `CLAUDE_HOME`".

**It grows linearly in the axis and nothing in the app knows its own value.**
Extrapolating the measured rate — 88 files and 69.6 MB per day
([00-problem.md](00-problem.md)) — against `transcriptRetentionDays: 30`
(`settings.ts:728`) gives a plateau of ≈2,650 files / ≈2.1 GB and a cold scan
of **≈6.4 s**. That is arithmetic on a measurement, not a measurement. An
install with three operators, or one that raised the retention horizon, or one
whose `~/.claude` predates the app, sits somewhere this proposal cannot compute.

**It is the one place where a growth problem would present as something else.**
A 6-second first page load reads as "the container is slow to start". A
6-second `assistRefusal()` before a chat turn reads as "the orchestrator is
slow". Neither reads as "the transcript corpus grew", which is what it is, and
which one number would say.

## What to add

Two fields, one shape, two payloads.

1. **`scanMs` and `scanWasCold` on `transcriptCacheStats()`'s return**
   (`transcripts.ts:656-664`), recorded by `runScan` at `:759` from the same
   `hrtime` pair a harness would use. The struct is already the module's
   self-report and already has a DTO.
2. **The same two fields on `/api/status`**, which is the surface behind
   `UF_STATUS_TOKEN` that an alert rule reads, and which
   [UnattendedOperation](../UnattendedOperation/00-problem.md) established is
   the app's designed pull-based position. `README.md` documents twelve
   alertable conditions; this makes a thirteenth possible without adding a
   channel.

**What not to add.** No threshold, no warning colour, no `Notice`. A cold scan
of 6 s is not a fault and an app that calls it one will be wrong on the install
where it is 900 ms. The `evictions > 0` notice is a warning because an eviction
means a bound was *reached*; a duration means nothing until an operator compares
two of them. Report it, do not judge it.

## Cost

| | |
|---|---|
| Files touched | 4 — `transcripts.ts`, `apiTypes.ts`, `src/app/api/usage/route.ts`, the status route |
| New dependencies | 0 |
| Schema changes | 0 |
| Settings added | 0 |
| Risk to a growth axis | none — `process.hrtime.bigint()` twice per scan |
| Test it earns | one, and `docs/agent/testing.md`'s bar is met the same way `transcriptCache.test.ts` met it: the arithmetic that decides cold-versus-warm is a branch with a silent failure mode (report a warm scan as cold and every reading is wrong by 36×) |

## What it does not do

**It raises nothing, so it prevents nothing.** If the answer to the brief's
question turns out to be a ceiling after all, this option is the instrument that
finds it and not the fix. That is the intended trade and it is only defensible
because [01-ceilings.md](01-ceilings.md) found no bound reachable within 30 days
at this install's measured rate.

**It measures one axis of three.** The repository axis's equivalent reading
would be `walkRepo`'s entry count against its 20,000 bound, which is
[04-option-b](04-option-b-report-the-truncation.md), and the concurrency axis's
is a per-child memory figure, which cannot be taken from inside the process at
all ([05-option-c](05-option-c-raise-the-run-ceiling.md)).

**It is worth nothing on an install nobody looks at.** A number on a payload is
a pull, and every criticism
[UnattendedOperation](../UnattendedOperation/02-option-a-change-nothing.md) makes
of the pull-based position applies here. The mitigation is that this figure moves
on a timescale of months, so a monthly glance is a sufficient cadence — which is
not true of anything in that survey.
