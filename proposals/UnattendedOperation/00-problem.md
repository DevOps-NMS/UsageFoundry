# The problem: nine ways to wait for a person who is not there

This app's premise is that a run works while nobody watches. The premise holds
for the *work*. It does not hold for the *endings*: every place a run stops and
needs a decision resolves to the same mechanism, which is that the operator
opens a page. There is no other route out of this container, and this file
enumerates the cost of that, in the only three units that turn out to matter:
how the operator learns, how long the wait can sit, and what the wait holds
while it sits.

Nothing here is a proposal. `01-constraints.md` bounds the field and the option
files argue it.

---

## 1. The table

Nine rows. Each is a state a run, a queue or a container can enter with nobody
looking at it, where the next thing that happens is a human decision. "Holds"
means the resources that stay reserved for the duration — the load-bearing
column, because it is what converts operator latency into a cost that is not
just the operator's attention.

| # | Ending or wait | How the operator learns, today | How long it can sit | What it holds while it sits |
|---|---|---|---|---|
| 1 | **`needs-review`** — the agent's own judgement that the task needs a person (`orchestrator.ts:110-130`) | Opens `/runs`, changes the segment to `needs-review`, or opens the run. It is **not** in the "what needs attention" band: `ACTIVE` is `running`/`queued`/`paused`/`waiting` (`src/app/runs/page.tsx:32-91`), so this ending renders in the *history* table. On stdout it is `opsLog("info","run.status",…)` (`orchestrator.ts:544-546`) — byte-indistinguishable in level from `running` and `completed` | **Unbounded.** Terminal (`TERMINAL_STATUSES`, `orchestrator.ts:3503-3515`), no sweeper, no timer, no expiry | Its branch and worktree slot, because it is landable — `land.ts:811-919` deliberately omits `needs-review` from the active-run refusal. Any `on-success` dependent stays `waiting` for ever: `needs-review` is terminal and is **not** a success (`docs/agent/dependencies.md`) |
| 2 | **A provider refusal parks the run** — `paused` with `resume_at` (`orchestrator.ts:1339-1356`, `1387+`) | The run page, or the `paused` band on `/runs`. There is a 1 Hz countdown, gated on `counting` (`runs/page.tsx`), so a *watched* park is the best-served wait in the app. Unwatched: `opsLog("warn","run.sandbox_refusal",…)` for the sandbox case only (`orchestrator.ts:536-583`); the ordinary park reaches stdout as an `info` status line | Up to `MAX_PAUSES_PER_RUN = 3` rungs of `REFUSAL_BACKOFF_MS = [20m,40m,60m]`, floored at `MIN_REFUSAL_WAIT_MS = 5m` and ceilinged at `MAX_REFUSAL_WAIT_MS = 6h` (`orchestrator.ts:1232-1244`), plus additive jitter. So **up to 6 hours per rung, three rungs**, then `failed` with cause `pauses-spent` | **Its folder.** `activeRuns()` counts `paused` (`orchestrator.ts:2628-2634`), so a parked run reserves its directory against every younger run, plus its worktree slot and one of `maxConcurrentRuns`. This wait is not free |
| 3 | **The 429 ladder retries in place** — `RATE_LIMIT_BACKOFF_MS = [30s,2m,5m,10m]` (`orchestrator.ts:1284`) | An `error` event per rung (`orchestrator.ts:7931-7951`), so the run page's log shows "…— retrying in 30s (1 of 4)." and stdout carries `opsLog("error","run.error",{run_id,message})` (`orchestrator.ts:566-568`). **But no status change**: the run reads `running` on `/runs`, in `/api/status`'s counts and in every state-based reading, for the whole ladder. And the two payload booleans that identify it — `retrying` and `usageLimit` — are **not projected onto the ops line**, so a log router sees an `error` indistinguishable from a real failure unless it parses free text | ~17 minutes at the floor of the jitter band, ~26 at its ceiling (`docs/agent/run-lifecycle.md:28`) | Folder, worktree slot and one of `maxConcurrentRuns` for the whole ladder, deliberately (`docs/agent/run-lifecycle.md:28`). The refusal message names the fix — "lower the concurrent-run limit rather than waiting" (`orchestrator.ts:8010-8015`) — and the operator is the only one who can apply it, and cannot see from any state that it applies |
| 4 | **A guard trip** — spend, cycles, duration or window (`budget.ts`, guard sites in `orchestrator.ts`) | `/runs` shows `stopped` (`setStatus(…, "stopped", …)` at `orchestrator.ts:8367`, `:8382`, `:8395`, `:8770`, `:9639`, `:9656`, `:9670`); `stop_reason` on the run page. This is the **one** ending with a distinguishable stdout line: `opsLog("warn","run.guard_tripped",{code,disposition,reason})` (`orchestrator.ts:552-556`) | **Unbounded.** Terminal | Its branch and worktree slot. Dependents on an `on-success` edge stay `waiting` for ever; `on-finish` dependents are released |
| 5 | **A dependency chain blocked** — an `on-success` parent ended any other way | `/runs`, status `blocked`, `stop_reason` carrying the per-run cascade reason (`blockWaitingRun`, `orchestrator.ts:3999-4013`). Nothing distinguishes it on stdout: it is an `info` status line | **Unbounded.** `blocked` is terminal | Nothing, and that is the design — a `waiting` run "holds nothing", invisible to `activeRuns()`, reserving no folder and no checkout slot (`docs/agent/dependencies.md`). This row's cost is entirely the operator's, which is exactly why it is easy to leave sitting |
| 6 | **The merge queue refuses on a dirty or wrong-branch checkout** | The `/branches` page. `landRefusal` writes the two sentences — "Your checkout has uncommitted changes — commit or stash them first." and "Your checkout is on X, and this work belongs on Y." (`land.ts:811-919`) — and `drainRepo` "still refuses every remaining branch *in that repository* and says so **once**" (`mergeQueue.ts`) | **Unbounded, and deliberately so.** "Nothing on the landing path has a clock on it. Do not add one." (`docs/agent/isolation-and-landing.md`) | One of `MAX_MERGE_WORKERS = 4` for the attempt only, then nothing — but every queued branch behind it in that repository, and each of those pins a worktree slot |
| 7 | **A workflow instance halted** — `HaltCause` is `operator` \| `guard{detail}` \| `fleet` (`workflows.ts:3358-3379`) | The instance page. `instanceIsOpen` is the predicate that matters and `status === "started"` is the trap (`workflows.ts:2384-2416`). A halt is not an `opsLog` event of its own | **Unbounded** | Every unstarted member's place in whatever graph it came from. A `guard` halt is a spend decision waiting on the person who sets budgets |
| 8 | **The container needs a login** — `claudeAuth.ts`'s `pendingLogin` | `/settings`, and only there: the surface is `src/app/settings/page.tsx:1180` and `:1215` via `/api/claude-auth`. **Nothing polls it**, no banner, no other page, no `opsLog` event | **Unbounded**, and it fails *every* run admitted in the interval, so the cost compounds rather than waits | Nothing itself. Everything downstream: each run that spawns against a dead credential burns a work cycle to find out |
| 9 | **A restart closed runs that were mid-cycle** — the boot reconcile | Nothing in the UI names it as an event. It is the one thing in the whole table with a durable structured record: `ops_events` carries `boot.reconciled` with `{"closed":N,"kept":M}` — the single row in the stale database is `(1787154203942,'warn','boot.reconciled','{"closed":2,"kept":0}')` | **Unbounded.** The closed runs are terminal and need `reopenRun` by hand | Nothing, but `reopenPrompt`'s restart branch exists precisely because `reported_done` is stale after a mid-cycle kill (`docs/agent/run-lifecycle.md:44`), so the recovery is not a re-run and cannot be batched blindly |

### Coverage, stated honestly

The brief named eight states. The table has nine: row 9 is added because the
evidence forced it — the one durable structured record of an unattended event in
any readable database on this machine is a boot reconcile, and it is invisible in
the UI as an event.

Two states the brief did not name are **deliberately excluded**, with reasons:

- **An ordinary `completed` run.** It needs a person eventually — somebody lands
  it — but it is a *digest* item, not an interrupt, by the argument in
  `01-constraints.md` §C1. Including it in the table would make every row look
  the same, which is precisely the failure the SLO framing exists to prevent.
- **A `queued` run waiting on `maxConcurrentRuns`.** It resolves itself, needs no
  decision, and holds only its folder reservation, which is the design
  (`docs/agent/dependencies.md` on why admission reserves).

What the table does **not** establish, and no option file may pretend it does:
**which of these nine actually happens, and how often.** See §3.

---

## 2. What already exists to build on

Six mechanisms. The important finding of this section is that the fan-out any
notification needs is already built and has no consumer.

### 2.1 `emit()` persists, then publishes, then projects — and the third sink is the attach point

`orchestrator.ts:505-515`:

```
INSERT INTO run_events …
bus.emit(e.runId, published);
bus.emit("*", published);
logLifecycle(published);
```

Three facts, in ascending order of usefulness.

**The persist-then-publish order is what makes reconnect lossless**
(`docs/agent/architecture.md`), so anything reading the bus is reading something
already durable. A notifier that crashes loses a notification, never an event.

**`bus.emit("*", published)` at `orchestrator.ts:513` has no consumer anywhere in
the tree.** `subscribe(runId, fn)` at `orchestrator.ts:690` takes a string and
would accept `"*"` unchanged. The install-wide fan-out that every push-shaped
option in this survey needs is therefore already emitted, already after the
durable write, and costs zero bus-side code. The only consumer of `subscribe`
today is the per-run SSE route (`src/app/api/runs/[id]/stream/route.ts:148`).

**`logLifecycle` (`orchestrator.ts:536-583`) is the one already-projecting sink,
and its docblock has already made this survey's security argument:**

> A second sink, after the publish and never before it… It **projects** rather
> than serialising the payload, and that is the whole of why it is a function and
> not `JSON.stringify(e)`: `iteration` carries the entire prompt, the creation
> `status` carries the folder, and `assistant` carries the model's own output.

Six cases pass, and `log` / `assistant` / `subagent` / `tool` are excluded by
that reasoning. Any outbound channel that attaches here inherits a projection
somebody has already thought about — which is worth more than it sounds, because
the alternative is a fresh decision about what leaves the machine, made by
whoever writes the notifier.

### 2.2 The stdout line is structured and levelled, and the levels are wrong for this

`opsLog(level, event, fields)` (`src/lib/ops.ts`) writes one JSON object per
line, and `recordOpsEvent` additionally inserts into `ops_events`.
`README.md:232-256` documents twelve alertable conditions against it, with the
example line:

```json
{"ts":…,"event":"run.cycle_finished","run_id":"…","subtype":"success","cost_usd":0.42,"duration_ms":183422}
```

The problem is the levelling. `/workspace2/3 Resources/Debugging and
Observability/Logging and Structured Logs.md` treats level as a **routing**
decision — the field a consumer filters on to decide whether a human is woken.
By that test the table above is mis-routed: **`needs-review`, a park, a
dependency block and an ordinary success all reach stdout at `info` through the
same `run.status` case** (`orchestrator.ts:544-546`).

Reading the six cases (`orchestrator.ts:544-583`) against the nine rows:

- **Row 4** is the one row with a level *and* an identity a router can act on:
  `opsLog("warn","run.guard_tripped",{code,disposition,reason})`.
- **Row 3** reaches `error` level through the `error` case, which is correct
  routing and the wrong identity — the same line carries genuine terminal
  failures, and the `retrying` and `usageLimit` booleans that distinguish a 429
  retry are on the event payload and **dropped by the projection**
  (`orchestrator.ts:566-568` passes `run_id` and a 300-character `message`).
- **Rows 1, 2, 5, 9** are all `info`, all through `run.status`, all
  indistinguishable from an ordinary `completed`.
- **Rows 6, 7, 8** reach stdout not at all: none of them is a run event.

So the cheapest repairs on this page are a `switch` inside the `status` case and
two extra fields on the `error` case. No option in this survey needs to own
either, and neither is a notification channel.

### 2.3 Polls stand down, and SSE is the re-arm

`docs/agent/conventions.md:15`: a poll stands down when its subject can no longer
move, and "the re-arm is the half to design" — the run page's first load sits
above the gate, the last poll after a run settles is what catches its ending, and
SSE is what wakes a poll that has stood down.

This is the invariant that makes an in-app digest cheap and makes a *second*
polling surface expensive. `/runs` already polls unconditionally at 4000 ms
(`runs/page.tsx:549`); the notice precedent `ReadOnlyNotice.tsx` polls
`/api/health` at `POLL_MS = 60_000` and renders nothing on a failed poll.

### 2.4 Two pull surfaces exist, with a hard bound on one of them

`/api/status` behind `UF_STATUS_TOKEN` (`src/lib/status.ts:30-88`), exempt in
`middleware.ts` **only while that variable is set**, and `/api/health`
(`src/lib/health.ts:112`), unauthenticated. The `middleware.ts` exemption comment
is a constraint rather than a description:

> counts of runs by status, whether SQLite responds, whether this process owns
> its data directory, and two timings. No prompt, no folder or mount path, no
> setting, no token, no model name, nothing read off a transcript… Anything added
> to that payload that is not a count makes this line a second unauthenticated
> data route.

So a status *page* that is useful and a status *endpoint* that is unauthenticated
are mutually exclusive, and that is decided, not open.

### 2.5 The PWA install path exists. The service worker does not.

**The brief's premise is half wrong, and it asked to be checked rather than
trusted, so:** `src/app/manifest.ts` is a real Next metadata route producing an
installable manifest — `display: "standalone"`,
`display_override: ["window-controls-overlay","standalone"]`, four icons
including `/icon-maskable-512.png` at `purpose: "maskable"`. `layout.tsx:27-85`
carries `appleWebApp`, `viewportFit: "cover"` and dual `themeColor`. `public/`
holds five rasterised icons and no manifest file, which is correct — the route
generates it.

There is **no service worker**: `grep -rn "serviceWorker\|navigator.serviceWorker" src/` returns
nothing, and `find src public -name 'sw*.{js,ts}'` finds nothing.

The manifest's own docblock adds the fact that decides Option D's shape: the
route is inside `middleware.ts`'s matcher, so an unauthenticated fetch redirects
to `/login`, and "Signing in first is what makes the app installable. The
exemption list is deliberately not widened for this."

### 2.6 `request_log` is capped and evicts on insert

`requestLog.ts:68` and `:115-125`: `RETENTION_ROWS = 20_000`, and every insert
runs `DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?`.
Relevant because it is a worked precedent for a bounded durable table — and
because `docs/agent/chat.md` records that auditing a credential-free refusal into
a self-evicting table "is a lever on the audit log itself". Any option proposing
a new durable queue of notifications inherits that reasoning.

---

## 3. Every number this survey could not get

The brief asked for this explicitly and it bounds every latency claim in every
option file.

| Wanted | Result |
|---|---|
| Live run history | `ls -la /data` → **`Permission denied`**. `DATA_DIR` is unreadable to the agent uid, so there is no live history at all |
| The stale in-checkout copy | `/workspace/UsageFoundry/.data/usagefoundry.db`, dated 2026-08-19, copied read-only to a scratch path. `SELECT COUNT(*) FROM runs` → **0**. `run_events` → **0** |
| `ops_events` | Exactly **one row**: `(1787154203942,'warn','boot.reconciled','{"closed":2,"kept":0}')` |
| How often a run has actually parked | **Not obtainable from any source.** No park has ever been recorded anywhere this agent can read |
| The ending mix across real runs | Not obtainable |
| Queue depth, or dwell time in any of the nine states | Not obtainable |
| Whether any operator has ever missed one of these endings | Not obtainable, and it is the falsifier for the whole survey |

**Consequence, and it is a large one.** Every claim in this proposal about
operator latency is a **mechanism** claim — "this state has no route to a person
and no clock" — and not a **measurement** claim. No option is scored on observed
frequency, because there is none. Where an option's case depends on frequency,
the option file says which measurement would decide it.

The one thing the single `ops_events` row does establish: on the one occasion
this install recorded a restart, it closed two runs and kept none. That is
n = 1 and is not a rate.

---

## 4. The shape that falls out of the table

Three observations that structure the comparison rather than pre-empting it.

**The expensive waits are the ones with no state.** Rows 2 and 3 both hold a
folder, a worktree slot and a concurrency slot. Row 2 has a status and an
excellent countdown, which runs only on a page somebody is already looking at.
Row 3 has **no status at all** — it is a log line inside a run that reads
`running` — so it is invisible to every reading built on `runs.status`, which is
`/runs`'s bands, `/api/status`'s counts, and any digest assembled from state.
Rows 1, 4, 5 and 9, which hold nothing but operator attention, all have a status
the UI can render. **The app is best at reporting the waits that are cheapest to
wait through**, and the mechanism is simply that those are the ones that changed
a row in `runs`.

**Seven of the nine rows have no clock, and one of those is load-bearing.**
(Rows 2 and 3 are the two with one: three park rungs then `failed`, and a
four-rung retry ladder.)
Unbounded is the *correct* answer for row 6 by a documented invariant. So "reduce
the time these sit" is not uniformly a goal, and an option that adds urgency to
the landing path is arguing against `docs/agent/isolation-and-landing.md`.

**One row is a compounding failure rather than a wait.** Row 8, the login: every
run admitted while the credential is dead burns a work cycle to discover it.
Latency there costs money at a rate, and it is surfaced on exactly one page with
nothing polling it. If any single row justifies an interrupt on its own, it is
this one, and it is the one the brief's framing — endings and waits — makes
easiest to miss.
