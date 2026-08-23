# Option C — Raise `maxConcurrentRuns` past 4

**The only ceiling in this survey whose raise is a real decision rather than a
line of code, and the only one gated on a measurement nobody has taken.**

## The state of the number

`maxConcurrentRuns: 4` (`src/lib/settings.ts:711`), with a second ceiling
`maxConcurrentAssists: 2` (`:712`) covering the three kinds of non-work-cycle
child through `assistRefusal` (`review.ts:437-444`).

Two sentences in that file are both true and are about different things.

> `settings.ts:765` — "**Measured, not reasoned.** `8651bcd` raised
> `maxConcurrentRuns` from `null` to 4"

> `settings.ts:205-232` — 4 was chosen against "the memory limit
> `docker-compose.yml` now ships (10 GiB) at roughly 1.5 GiB for a work cycle …
> **That per-child figure is reasoned rather than measured.**"

So: *having* a ceiling was measured. *Where* it sits rests on 1.5 GiB per work
cycle, which is the one number in the concurrency axis that nobody has taken.
`10 GiB ÷ 1.5 GiB ≈ 6.7`, and 4 is that with headroom for the server process —
which this proposal did measure, at **323-372 MB RSS** during a cold transcript
scan (n = 5), against `--max-old-space-size=2048` (`docker-compose.yml:201`).

**So the server is not the term that matters and the children are, and the
children's term is a guess.** Everything about whether 4 should be 6, or 8, or 3
follows from one `docker stats` reading.

## What happens at 4 today

Nothing bad, which is the strongest argument for leaving it alone. Runs past the
cap stay `queued`: `selectPromotable(activeRuns(), cap, newWorkPaused())`
(`orchestrator.ts:3424-3425`) promotes up to the cap and no further, and
`queuePosition` reports how many are ahead of a run **for its folder**
(`:3434-3450`), which is the only count that describes a wait that will actually
happen. `/runs` renders the band. Nothing is lost, nothing is refused, nothing
is silent.

## The case for raising it

**Throughput is the product's whole proposition.** This app exists to run agents
against a folder while nobody watches. At 4, an operator with 12 repositories
gets a third of them moving at once, and the ceiling is not visible as a capacity
decision anywhere — it is a Settings number whose default reads like a safety
rail.

**Two of the three costs that scale with N have already been fixed.** The
snapshot aggregation is single-flighted (`orchestrator.ts:6905-6917`) and the
slot walk is bounded at 4 probes per admission (`:2001`). At the tree #68 read,
raising `maxConcurrentRuns` would have multiplied both. At HEAD it multiplies
neither. That is a genuine change in the argument and it points toward raising.

**The measured event-loop headroom is large.** During a cold transcript scan —
the single largest piece of work this process does — event-loop delay measured
p50 ≈8 ms, p99 29-34 ms, max 36-45 ms (n = 5). Against `HEARTBEAT_MS = 1_000`
(`serverLock.ts:51`) and `STALE_MS` of 120 s (`serverLock.ts:84` × `git.ts:111`),
that is three orders of magnitude of headroom on the liveness budget #68 was
worried about.

## The case against, and it is the stronger one

**The binding constraint is memory, and memory does not degrade gracefully.**
Every other cost in this survey degrades: a queue lengthens, a walk truncates, a
scan takes longer. An OOM kill takes the container down mid-cycle, and
`docker-compose.yml`'s `mem_limit: 10g` (`:423`) means the kernel's OOM killer
scope is the container rather than the host — which is #91's fix working
correctly and is still a killed server. There is no partial version of this
failure to observe on the way to it.

**The vault's budget rule applies and its answer is "not at any median".**
`/workspace2/3 Resources/Service Runtime/Blocking the Event Loop.md` sets the
threshold on the **worst observed** value, not the median, and names the case
that is unaffordable regardless: "**Anything with an unbounded worst case** … not
affordable at any median, because the budget is set by the worst case and the
worst case is not bounded." A work cycle's peak RSS is set by what the agent
reads, which is set by the repository and the task. It has no bound this app
knows. So the honest position is that the per-child figure cannot be replaced by
a formula and has to be *observed* on the install that will run it.

**Nothing about the number is portable.** 1.5 GiB per work cycle on a 2,000-file
repository is not 1.5 GiB on a monorepo, and 10 GiB is `UF_MEM_LIMIT`'s default,
not the operator's machine. Raising the shipped default moves every install; the
operator who needs 8 can already type 8 in Settings.

## What to do instead

**Take the measurement, then decide, and do not ship a new default until it is
taken.** The command is in [12-validation.md](12-validation.md) §2 and cannot be
run in this container:

```sh
# On a host with Docker, with the container up and four runs live:
docker stats --no-stream --format \
  'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}' usagefoundry

# And per-child, which is the figure settings.ts:205-232 calls reasoned:
docker exec usagefoundry sh -c \
  'ps -o pid,rss,args -C claude --no-headers | awk "{print \$1, \$2/1024 \" MiB\"}"'
```

Four runs at four `claude` children, read at the peak of a cycle rather than
between cycles. If the per-child figure comes back near 1.5 GiB, 4 is correct
and this option is closed. If it comes back near 600 MB, the shipped default is
leaving two thirds of a 10 GiB budget unused and this becomes the highest-value
change in the survey.

## Cost

| | |
|---|---|
| Files touched to raise the default | 1 line in `src/lib/settings.ts` |
| Files touched to take the measurement | **0** |
| What blocks it | one `docker stats` reading that cannot be taken from a work cycle |
| Risk if raised without it | container OOM mid-cycle, which is the one failure mode in this survey with no graceful degradation |

**This is the survey's only "raise a ceiling" option that is not refused**, and
it is deferred rather than recommended. The distinction matters: Options E, F
and G are wrong. This one is merely unmeasured.
