# Option B: an in-app digest of everything awaiting a decision

One place that answers "what needs me", for all nine rows, inside the app. No
credential, no dependency, nothing leaving the box.

This is the option the brief was most likely to expect to lose, because it removes
**zero** latency for an operator who is not looking at the app. That framing is
wrong in one specific way and right in every other, and both halves are below.

## What it is

A single reading, assembled server-side, of every state in `00-problem.md`'s
table that is currently answered by a different page:

| Row | Where it lives today | What the digest reads |
|---|---|---|
| 1 `needs-review` | `/runs`, behind a segment change | `runs` where `status = 'needs-review'` |
| 2 park | `/runs`, `paused` band | `runs` where `status = 'paused'`, with `resume_at` |
| 4 guard trip | `/runs`, `stopped` + `stop_reason` | `runs` where `status = 'stopped'` and the reason is a guard code |
| 5 blocked | `/runs`, `blocked` | `runs` where `status = 'blocked'`, with the cascade reason `blockWaitingRun` wrote (`orchestrator.ts:3999-4013`) |
| 6 merge queue | `/branches` | `queuedRepos()` / `nextQueuedIn()` (`mergeQueue.ts`), plus whether the last `drainRepo` refused |
| 7 halted instance | the instance page | instances where `!instanceIsOpen` and the halt cause is `operator` or `guard` (`workflows.ts:2384-2416`, `:3358-3379`) |
| 8 dead login | `/settings` only, nothing polling | `readAuthStatus()` (`claudeAuth.ts`) |
| 9 restart closed runs | nowhere as an event | `lastBootReconcile` (`status.ts:88`) |
| 3 the 429 ladder | nowhere | **Nothing. It cannot.** See below |

Delivered two ways, and the second is the interesting one:

**A count in the shell**, so the answer is visible from every page rather than
being a place you have to go. **And a section** listing the items with a link
each.

## The three constraints that decide its shape

**It cannot be a tenth pane.** `src/components/shell/panes.ts:12-16`: "Nine is the
ceiling and Knowledge is the ninth — a tenth destination has no digit, and a row
without one is a row two of the four readers cannot describe." `PANES` holds
exactly nine entries with shortcuts 1 through 9, read by four consumers (the
source list, the toolbar's title, ⌘1-9, and quick open). So the digest is either
a **badge on the `/runs` row** plus a section on `/`, or it is a proposal to
renumber the sidebar — which is a change to a documented cap and would be argued,
not assumed. **The badge-plus-section shape is the only one this option offers.**

**It must not poll for ever.** C5, `docs/agent/conventions.md:15`. And an
install-wide count has no clean stand-down condition: its subject can move
whenever any run transitions, and a schedule can start a run with nothing
running. So the honest design is **not to poll at all** — subscribe to
`bus.emit("*", published)` at `orchestrator.ts:513`, which has no consumer and
which `subscribe()` at `:690` would accept unchanged, through one new SSE route
modelled on `src/app/api/runs/[id]/stream/route.ts` (15 s `: ping` heartbeat,
`heartbeat.unref?.()`, cleanup clearing both). SSE is already named as the re-arm
signal for a stood-down poll; here it is the only signal, so there is no poll to
stand down. That is the cheapest correct answer to C5 available to any option in
this survey, and the mechanism it needs is already emitted and orphaned.

Two of the nine rows are not on the bus and need a fallback: row 6 is a merge
queue transition and row 8 is a container credential. A slow poll on those two
(the `ReadOnlyNotice.tsx` shape — `POLL_MS = 60_000`, render nothing on a failed
poll) is the precedent to imitate, and it does stand down, because neither can
change while nothing is running except by operator action in the same browser.

**It is a read, never a control surface.** C8: `docs/agent/run-lifecycle.md:48`
forbids a bulk control from answering `needs-review`, and `REOPENABLE` in
`src/app/runs/page.tsx:32-91` already restricts the bulk pick-up to
`failed`/`stopped` for that reason. A digest with an "acknowledge all" or
"reopen all" button is that invariant's exact violation, and it is the obvious
first feature request after this ships. **The refusal belongs in the same change
as the feature**, in a comment beside the list, or it will be added by somebody
who has not read `run-lifecycle.md`.

## What it actually buys, stated without inflation

It converts **eight pages into one** and **one filter change into zero**. That is
the whole of it, and it is worth more than it sounds for three reasons and less
than it sounds for one.

Worth more, because: rows 6, 7 and 8 live on three different pages today and two
of them are pages an operator visits rarely — nothing takes a person to
`/settings` except a decision to change a setting, which is precisely why a dead
login can sit. Because `needs-review` currently requires knowing that the
*history* table is where it went. And because `/workspace2/3 Resources/Web
Design/Progressive Disclosure.md` orders the moves as Delete, Show, Hide, and this
is a **Show**: nothing is being hidden, one thing is being surfaced that is
currently reachable only by knowing where to look.

Worth less, because: **the operator's latency is unchanged if they do not open the
app.** A digest is a better answer to "what needs me" and no answer at all to
"something needs you". If the failure mode is a run parking at 02:00 and sitting
until 09:00, this option removes none of those seven hours.

## Row 3, and why it is this option's specific blind spot

The 429 ladder does emit — an `error` event per rung at
`orchestrator.ts:7931-7951`, carrying the message "…— retrying in 30s (1 of 4)."
along with `retrying: true` and `usageLimit`. What it does **not** do is change
status: the run reads `running` throughout, so nothing in `runs` moves.

That matters here more than anywhere else in the survey, because **a digest
assembled from state is exactly the reading row 3 is invisible to.** Every other
row in the table above is a `SELECT` on a status; row 3 is a log line inside a run
whose status is fine.

Two ways out, and the honest one is the second. A digest could read `run_events`
for the newest `error` per running run and test `payload.retrying` — correct, but
it makes the assembly function read the event log as well as four tables, for one
row. Or the projection could be fixed instead: `logLifecycle`'s `error` case
(`orchestrator.ts:566-568`) passes `run_id` and a 300-character `message` and drops
the two booleans that identify a 429 retry, so **adding `retrying` and
`usage_limit` to that call makes the most expensive wait in the app filterable by
any log shipper, for two fields.** That is cheaper than this entire option and it
is named in `11-recommendation.md` as coming first.

## Cost

| | |
|---|---|
| Money | Nothing recurring. No third party, no egress |
| Code | One SSE route, one client hook, one component with a `Record<Union, string>` variant map per row kind (C3 of `OperatorInterface/01-constraints.md`), one badge on the `/runs` pane row, one server function assembling the nine reads. Assumed 400-600 lines; no comparable feature was measured for this survey |
| Dependencies | **None** |
| Schema | **None.** Every row is a `SELECT` over tables that exist |
| Leaves the machine | **Nothing** |
| Credential | **None.** It is behind the session gate like every other page |
| New silent failure mode | One: an SSE stream that dies leaves a stale count. The heartbeat in the existing stream route is the mitigation and it is already written |

## Why it is not simply the answer

Because it answers a different question than the one the brief asked. "Nothing it
produces reaches an operator who is not looking at the page" — this option makes
the page better and leaves "not looking" exactly where it was. It is the correct
**foundation** for every other option, since a webhook or a push needs a
server-side notion of "what awaits a decision" and this is that notion; but on
its own it is a usability improvement wearing an availability argument.
