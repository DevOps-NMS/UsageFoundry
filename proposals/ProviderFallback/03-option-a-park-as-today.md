# Option A — park as today, change nothing

Keep `refusalDisposition` exactly as it is. An allowance refusal parks the run,
up to three times, then fails it `pauses-spent`. No second provider, no second
binary, no second credential.

**This is the option to beat, and the measurement in `00-problem.md` §2 makes it
stronger than the brief assumed.**

---

## The strongest case

**Parking is correct, free, and cheaper than the brief thinks.**

The disposition is not an accident of implementation; it is a decision with its
reasoning written down (`src/lib/orchestrator.ts:1766`–`:1794`), and the
reasoning is that a 5-hour subscription window is *the one quantity this app
already reasons about as waitable*. The alternative it replaced — ending the run
— was a real defect: "the ordinary outcome was a fleet written `failed`,
terminally, needing a run page opened per run" (`:1783`–`:1784`).

And what the wait costs is smaller than stated:

- **It does not hold the folder.** `occupantOf` (`:3094`) excludes `paused` by
  design, "a parked run yields its folder" (`:3089`–`:3090`), and
  `FOLDER_TAKEN_REASON` (`:9294`) exists because another run really does take it.
- **It does not hold a concurrency slot.** `selectPromotable` counts
  `status === "running"` only (`:3828`, `:3832`). Parking *frees* one of
  `maxConcurrentRuns`.
- What it holds is **one of 64** checkout slots for that repository
  (`MAX_WORKTREE_SLOTS = 64`, `:3120`; `SlotCensus.heldByRuns` includes paused,
  `:3138`), against a default `maxConcurrentRuns` of 4.

So the fleet-wide picture at a wall is: every run parks, every folder is
released, every concurrency slot is released, and 64-per-repository checkout
headroom absorbs the parked set. **Nothing is blocked by a parked run except the
work that run was doing.**

The remaining cost is latency and wall clock, and only the second of those is a
loss rather than a delay.

## Its shape

No change. For completeness, the code path:

```
cycle refused
  → refusalKind(refusal) === "allowance"                  orchestrator.ts:1540
  → refusalDisposition{pauseCount < 3} → {action:"park"}          :1800
  → resume_at = refusalResumeAt(lastSpendingWindowEnd, …)         :8180
  → status = "paused", iterations -= 1                            :8188, :8191
  → sweepPaused → planPausedRun → {action:"resume"}               :9335
```

## Continuity

**Perfect.** The Claude `session_id` is on the row; the next cycle resumes into
the same conversation with `--resume` (`cycleInvocation.ts:1085`). Nothing is
lost, nothing is re-derived, no handover brief is written and no context is
re-read.

`startsFresh` still gets its say on whether resuming is worth it, off
`contextTokens` (`cycleInvocation.ts:48`–`:68`).

## Guards and metering

**Unchanged and correct.** One provider, one window, three cost sources kept
apart, `--max-budget-usd` bounding the cycle that crosses the threshold, and
`maxDurationMinutes` as the terminus that a parked run cannot outwait.

The one thing worth naming: `maxDurationMinutes` **includes parked time**
(`src/lib/budget.ts:99`–`:101`). A run whose duration cap is shorter than the
window it is waiting for dies while parked. That is deliberate — it is what makes
the cap a terminus for a resuming run — but it is the single mechanism by which
parking loses work rather than delaying it.

## Permission and sandbox parity

Not applicable. One binary, one managed policy
(`/etc/claude-code/managed-settings.json`, `src/lib/sandbox.ts:166`), one
`--permission-mode`, one seccomp story.

## Review and landing

Unchanged. Every branch is Claude-written; nothing has to disclose a provider
because there is only one.

## Credentials

Unchanged — except that the current code has a latent defect **independent of
this proposal**: `childEnv` (`orchestrator.ts:5369`) does not strip `OPENAI_API_KEY` or
`CODEX_API_KEY`, so if either is ever set on the server it reaches all five
`CLAUDE_BIN` children. Option A does not create that; it also does not fix it.
See [`10-permission-and-credentials.md`](10-permission-and-credentials.md)
§"The repair that is owed either way".

## Blast radius

None.

## How it fails, and whether loudly

Three ways, all of them loud:

1. **`pauses-spent`.** Three parks and the wall is still there. The run fails
   with a sentence that says exactly what happened — "Out of waits rather than
   out of allowance" (`orchestrator.ts:1836`) — and the run page shows it.
2. **Wall clock while parked.** `planPausedRun` ends it on a verdict that can
   never clear (`orchestrator.ts:9335`). Loud, and the stop reason names the guard.
3. **A misclassified refusal.** `isUsageLimit`'s veto on
   `spend|credit|credits|balance` (`orchestrator.ts:1439`) is what keeps a credit-balance
   refusal out of the park path, and it is a regex. A refusal reworded upstream
   that matches neither pattern falls to `"other"` and fails the run — loudly,
   with the CLI's own words attached.

None of these is silent, which is the property every other option has to be
compared against.

## What it costs to build

**Zero.** No code, no schema, no dependency, no credential, no image change.

## What would have to be true for this to be the wrong answer

Exactly one of:

- **Walls are frequent and long enough that latency is the binding constraint.**
  Not measurable here — `runs` is empty (`00-problem.md` §5). The query is in
  `14-validation.md`.
- **A material share of runs die on wall clock while parked**, which converts
  delay into loss. Same measurement gap; same query.
- **The 64-slot checkout headroom is actually contended**, so parked runs *do*
  block admission. `slotExhaustionRefusal` is the observable, and
  `MAX_WORKTREE_SLOTS`'s own docblock (`orchestrator.ts:3112`–`:3118`) says the consumer of
  that headroom is retired dirty slots rather than live runs — so this would be
  a finding about cleanup, not about parking.

**All three are unmeasured, and all three are measurable with one SQL statement
each on a live install.** That is the strongest single argument for this option:
its rivals are being weighed against a cost nobody has counted.
