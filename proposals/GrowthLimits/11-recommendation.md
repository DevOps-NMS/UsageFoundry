# Recommendation

**Raise nothing. Instrument two axes, take one measurement that cannot be taken
from inside the process, and revisit `maxConcurrentRuns` only after it comes
back.**

The question was "what breaks first as this install grows, and which ceiling is
worth raising before it is hit". The measured answer to the first half is
**nothing** — 31 bounds found, 0 that fail, throw, corrupt or lose data, and 0
numeric bounds reachable within 30 days at the measured rate of ≈88 transcript
files and ≈69.6 MB per day ([01-ceilings.md](01-ceilings.md)). The answer to the
second half is therefore **none of them yet**, and the useful work is making the
first install that does grow past this one say so.

Three steps and one question, in order. Steps 1 and 2 are independent of each
other and of everything else.

## Step 1. Put a number on the cold transcript scan — [Option A](03-option-a-instrument-the-axes.md)

Two fields, `scanMs` and `scanWasCold`, on `transcriptCacheStats()`'s return
(`transcripts.ts:656-664`) and on `/api/status`. `apiTypes.ts:310` and
`src/app/api/usage/route.ts:150` are the DTO and the payload slot, both already
present.

Measured here: cold **2,985-3,041 ms** (n = 5 fresh processes), warm
**82.5-88.9 ms** (n = 5), a factor of 36. Reported as two phases because
`/workspace2/3 Resources/Debugging and Observability/Benchmarking Honestly.md`
refuses an average across a cold and a steady-state phase, and at 36× an average
would be wrong in both directions.

**Two implementation notes that are the difference between this working and
looking like it works.**

The timing belongs on the module's existing self-report, not on the cache map.
`scanHealth` is already pinned as `__ufScanHealth`
(`transcripts.ts:522-527`) and `lastScanReadFailures()`'s docblock (`:529-539`)
already argues the exact pattern this needs: "a second way to reach the same
field `ScanResult` already carries, for the callers that are handed a
`UsageSnapshot` instead of a scan". A scan duration is the same kind of fact for
the same set of callers.

But widening `__ufScanHealth` means **taking a new key** — `__ufScanHealthV2` —
because `CLAUDE.md`'s rule is explicit and `transcripts.ts:136-143` is the
in-tree precedent for obeying it: `??=` only initialises when absent, so a
pre-upgrade `{readFailures: []}` survives a dev hot reload and every reader of
the new field sees `undefined`. Here that would not throw, it would silently
report every scan as 0 ms, which is worse. **The cost is one cold rebuild.**

Report the number and do not judge it: no threshold, no warning colour, no
`Notice`. A 6-second cold scan is a fact about a corpus, not a fault, and the
install where it is 900 ms would be told it has a problem.

## Step 2. Make the file price list confess a short walk — [Option B](04-option-b-report-the-truncation.md)

`walkRepo` (`fileCostNotice.ts:368-404`) stops at `MAX_WALK_ENTRIES = 20_000`
(`:182`) and returns a plain `RepoFile[]`. Change the return to
`{ files, partial }` and let `renderFileCostNotice` (`:256`) append one clause.

This is second rather than first because it is **insurance, not a fix**: measured
occupancy is 9.8% on `/workspace/UsageFoundry` (1,951 entries) and 6.2% on
`/workspace2` (1,247), both an order of magnitude clear. If this reads as urgent
it has been misread.

It is nonetheless on the list rather than refused, for one reason: it is one of
only **two** silent truncations in the whole survey, its reader is an agent
rather than a person, the notice is frozen for the life of the run, and the same
repository reached the opposite conclusion for the same constant name with the
same justification — `retention.ts:716-723` returns `{bytes, partial}` and its
docblock says the walk "says when it stopped". One of the two is wrong and it is
not the one that reports.

**The clause must be a count and never a path.** `docs/agent/security.md`
extends the `SELF_HOSTING_NOTICE` rule to all three notices on that flag, the
file price list included, and a sentence naming the directory where the walk
gave up would put a new `pgrep -f` pattern on every sibling's argv.

## Step 3. Ask the operator, or the host, for one reading

Not a code change and not a decision — the reading that closes
[Option C](05-option-c-raise-the-run-ceiling.md) in one direction or the other.
`settings.ts:765` says having a ceiling was "**Measured, not reasoned**", and
`settings.ts:205-232` says where it sits rests on ≈1.5 GiB per work cycle, which
"**is reasoned rather than measured**". Everything about whether 4 should be 3 or
8 follows from that one figure.

**Docker is unavailable in this container, so this was not run here.** The exact
commands are in [12-validation.md](12-validation.md) §2 and are, on a host with
the container up and four runs live at the peak of a cycle:

```sh
docker stats --no-stream --format \
  'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}' usagefoundry

docker exec usagefoundry sh -c \
  'ps -o pid,rss,args -C claude --no-headers | awk "{print \$1, \$2/1024 \" MiB\"}"'
```

**Then:** near 1.5 GiB per child and 4 is correct and Option C closes. Near
600 MB and two thirds of a 10 GiB budget is going unused, and raising the
shipped default becomes the highest-value change in this survey. Do not ship a
new default before the reading, because the failure mode on the wrong side of it
is a container OOM mid-cycle — the one failure in this survey with no partial
version to observe on the way to it.

## Handed back, not refused: [Option D](06-option-d-make-the-history-reachable.md)

`listRuns(100)` (`src/app/api/runs/route.ts:50`) against a measured 294 runs is
**the one ceiling this install has already gone past**, and it scores second in
[10-comparison.md](10-comparison.md) on the strength of it. It is not
recommended here because it is [GapRegister](../GapRegister/03-growth.md) G1 and
G2 verbatim, ranked first of that survey's own three, and a second vote by the
same voter is not evidence.

This proposal's contribution to it is one measurement, already in the route's own
comments and worth reading before the paging argument is re-made: a 100-row
response measured **696,197 bytes**, of which the prompt field alone was
**522,541** (`route.ts:78`). Somebody has since removed the three largest fields.
So the reason to page is no longer payload size — it is reach, which is what
GapRegister said, and the size objection has been dissolved by an unrelated
change.

## Refused, by name

**[Option E](07-option-e-raise-the-mount-ceiling.md), raise the four-mount
ceiling.** There is nothing in `src/` to raise. `parseMounts` has no limit and
`config.ts:205-211` forbids it gaining one, because "a compose override file is a
legitimate way to mount more". #77's silent fifth slot is fixed
(`config.ts:234-251` throws at module load), documented
(`docs/install.md:493-505`) and unit-tested (`config.test.ts:22-60`). Shipping
eight volume lines would put four unused bind mounts into every install to buy
what an override already buys.

**[Option F](08-option-f-sqlite-write-path.md), harden the SQLite write path.**
The two failure modes the literature warns about each need a precondition this
tree does not have. `SQLITE_BUSY` needs a second writing connection, and a second
process that does not own `DATA_DIR` refuses to write at all. Checkpoint
starvation needs a long-lived reader, and `grep -rc "\.iterate(" src/` sums to
**0** — there is no cursor API in use anywhere, which closes the class more
firmly than a load test would have. #68 already measured the timeout at 5000 ms
and correctly recorded it as not a gap.

**[Option G](09-option-g-time-based-audit-horizon.md), put `request_log` on a
time horizon.** `requestLog.ts:58-67` chose rows over age deliberately — "what
makes this table useful is having the burst that happened *before* somebody
noticed" — and `src/app/api/mcp/route.ts:639-651` makes the cap a term in a
security argument, which is why that route's 401 is answered outside
`auditMutation`. Changing the shape re-opens that to buy an ordering the table
does not want.

G leaves one finding behind rather than nothing, and it is a correction to
[GapRegister G4](../GapRegister/03-growth.md) rather than an option: **a polling
browser writes no audit rows at all.** `recordRequest` has no caller outside
`requestLog.ts`, `auditMutation` wraps 33 exports across 26 route files plus
`/api/mcp`'s POST inside its handler — 34 audited handlers — and the GET count is
**zero**. The rate driver is `POST /api/mcp`, one row per JSON-RPC
call, which is agent traffic rather than human traffic — so the install that
loses its audit history first is the one using the orchestrator chat hardest,
which is the install whose history is most worth having.

## What would overturn this

Five things. Each is a check somebody can run, not an opinion.

1. **A per-child memory figure near 600 MB.** Then Step 3 inverts and the
   recommendation becomes "raise `maxConcurrentRuns`", with Options A and B still
   worth doing. This is the single most likely way this recommendation is wrong.
2. **A repository or mount past ≈15,000 walk entries.** Then Option B stops being
   insurance and moves above Option A. `find <mount> -path '*/node_modules'
   -prune -o -path '*/.git' -prune -o -print | wc -l` is the check, and it
   returned 1,951 and 1,247 here.
3. **`transcriptRetentionDays` raised above 30, or a `~/.claude` older than this
   app.** Three of the four history-growing costs plateau *because of* that
   default ([01-ceilings.md](01-ceilings.md) group 5). Remove it and the
   plateau goes with it, and Option A becomes a fix rather than an instrument.
4. **An eviction on `/api/usage`'s `cache.evictions`.** Measured 0 here at 20.3%
   occupancy, and extrapolated to ≈218,000 of 500,000 at the 30-day plateau, so
   `TRANSCRIPT_CACHE_MAX_ENTRIES` should be unreachable under the shipped
   default. A non-zero reading means the arithmetic in
   [00-problem.md](00-problem.md) is wrong somewhere.
5. **A `.iterate(` or a second `new Database(` appearing in `src/`.** Then Option
   F's refusal loses its ground and `wal_autocheckpoint` becomes a real question.

And the honest limit on all five: **no run history was readable.**
`.data/usagefoundry.db` in the checkout is a stale 2026-08-19 copy and `/data`
is `Permission denied` to the agent uid. Every growth rate in this proposal was
derived from the transcript corpus on disk, which is a proxy for the run history
and not the run history.
