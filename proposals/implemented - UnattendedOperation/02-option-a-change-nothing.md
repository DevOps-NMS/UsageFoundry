# Option A: change nothing

The null, at its strongest. It is stronger here than in most surveys, because the
absence being surveyed is not an oversight — `README.md:231-253` is a written
position with thresholds, and `proposals/GapRegister/04-missing-features.md`
already scored it as the register's **lowest-confidence gap** for that reason.

## The case

**Five of the nine rows already reach a monitoring system, and one of them is on
the README's own list.** From C12's row-by-row check against
`src/lib/status.ts:60-88`: rows 1, 2, 4, 5 and 9 are all visible as fields on
`/api/status`, because `runs` is `Record<string, number>` over *every* status —
so `runs["needs-review"] > 0` is an alertable condition today, with no code
change, on an endpoint that already has a purpose-built read-only credential.

**The credential story is already solved and solved narrowly.**
`UF_STATUS_TOKEN` reaches `/api/status` and nothing else, checked in the route
rather than in the edge middleware, and with the variable unset the route is not
exempt at all — a monitor gets a 401 rather than the endpoint becoming public
(`README.md:228-229`). Every other option in this survey either mints a new
secret or holds a third party's. This one holds none.

**Nothing leaves the box.** Zero bytes of task text, repository name or diff
content cross the container boundary, which means C3 is satisfied trivially
rather than argued. For an install whose whole premise is running agents against
the operator's own private repositories, that is not a small thing to give up.

**The operator this app is built for probably has a monitoring system.** This
ships as a single Docker container that the operator runs for themselves
(`docker-compose.yml` binds `127.0.0.1:3000`). A person self-hosting an agent
runner behind a shared secret is a person with somewhere to point a scrape job,
and pointing one at a documented JSON endpoint is less work than any option below
is to *build*, let alone to operate.

**Every alternative adds a failure mode that fails silently.** A webhook that
stops delivering, a push subscription that expires, an SMTP password that rotates,
a bot removed from a channel — each of those turns "the operator was not told"
into "the operator was told they would be told, and was not". That is strictly
worse than the current state, and none of the options below carries delivery
monitoring, because monitoring the notifier is the same problem one level up.

## What beats it

Four rows, and they are the wrong four.

**Rows 3, 6, 7 and 8 are invisible to a `/api/status` monitor** — no field, no
event, no status change. Under C1 those include both interrupt-shaped rows: the
429 ladder, which holds a folder, a worktree slot and one of `maxConcurrentRuns`
for ~17-26 minutes while reading `running` on every surface, and the dead login,
which is a compounding failure surfaced on one page nothing polls
(`src/app/settings/page.tsx:1180`). Option A's coverage is real and it is
concentrated in exactly the rows C1 classifies as digest material.

**`needs-review` renders in the history table.** `ACTIVE` is
`running`/`queued`/`paused`/`waiting` (`src/app/runs/page.tsx:32-91`), so the one
ending whose entire content is "a person should look at this" is not in the band
whose "job is 'what needs attention'". A segment exists for it, and the code
comment says why: "without a segment of its own the one state whose entire content
is *a person should look at this* is reachable only under 'All'." An operator who
does open the page still has to change a filter to see it.

**The stdout levels are mis-routed**, per `00-problem.md` §2.2: `needs-review`, a
park, a block and an ordinary success all reach stdout at `info` through the same
`run.status` case (`orchestrator.ts:544-546`). One row of nine — the guard trip —
has a level a log router could act on.

**And the precedent for exactly this failure is in the tree, written down.**
`src/components/shell/ReadOnlyNotice.tsx`'s docblock: it exists "because the only
signal used to be one `console.warn` at boot, phrased reassuringly, into a
container whose stdout nobody is tailing." That component is this repository
having already decided, once, that a structured line into an untailed stdout is
not a signal. Option A's case rests on a stdout and a scrape endpoint being
enough; the app has a component whose reason for existing is that they were not.

## The two things Option A should absorb rather than concede

Neither is a notification channel, and both are cheaper than every option below.

**Level the stdout lines.** `logLifecycle`'s `status` case is one `opsLog("info",…)`
for all nine statuses (`orchestrator.ts:544-546`). Routing `needs-review`,
`blocked` and `failed` at `warn` — which is what
`/workspace2/3 Resources/Debugging and Observability/Logging and Structured Logs.md`
means by level as a routing decision — makes four of the nine rows filterable by
any log shipper. It is a `switch` inside an existing `case`, no new event names,
no schema, no dependency, no payload change and nothing new leaving the box.

**Add the missing conditions to `README.md`'s table.** `runs["needs-review"] > 0`
and `runs.blocked > 0` are on the wire and not on the list of twelve. That is a
documentation change with a real effect on an operator who reads it once.

Both are inside this survey's boundaries only as recommendations, since the brief
forbids `src/` and `docs/` edits here. They are named in `11-recommendation.md`.

## Verdict

Not refused, and it is the baseline every option must beat by more than its own
operating cost. Its precise failure is narrow and stated: **it covers the rows
where latency is cheap and misses the rows where latency costs money.**
