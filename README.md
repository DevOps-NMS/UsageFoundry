# UsageFoundry

Usage-aware orchestration for Claude Code. Point it at a folder, give it a task
and a budget, and it runs Claude Code headlessly until the work is done or the
budget guard stops it — with live limit tracking throughout.

Ships as a single Docker container.

---

## The one thing to understand first

There are **two unrelated things** called "your Anthropic limits", and this tool
treats them separately on purpose:

| | Claude Code subscription (Pro/Max) | Console API account |
|---|---|---|
| What a "limit" is | 5-hour session window, weekly quota | rate limits (RPM / ITPM / OTPM), spend |
| Official API | **none** — Anthropic publishes no endpoint and no numeric quota value | `/v1/organizations/rate_limits`, `/usage_report/messages`, `/cost_report` |
| How this tool reads it | parses `~/.claude/projects/**/*.jsonl` locally | Admin API, with an `sk-ant-admin01-…` key |
| Accuracy | **volumes and costs are exact; percentages are estimates** | authoritative |

The **Dashboard** is the subscription view. The **API account** page is the
Console view, and stays empty unless you set an Admin key. They are never summed
together.

### ⚠️ What the subscription view can and cannot see

Your 5-hour and weekly limits are **shared across every Claude surface**. Only
Claude Code writes local transcripts, so only Claude Code is measurable here:

| Surface | Local data | Counted |
|---|---|---|
| Claude Code (terminal) | `~/.claude/projects/**/*.jsonl` | ✅ |
| Claude Code SDK | same, `entrypoint: sdk-cli` | ✅ |
| **Cowork** | Electron profile — no transcript, no usage ledger | ❌ |
| **Cowork scheduled tasks** | run in the cloud, device offline | ❌ |
| Claude Desktop / web / mobile | server-side | ❌ |

This is structural, not an oversight — there is no local file to parse, and the
authoritative figure lives behind the same undocumented endpoint the in-session
`/usage` command calls. The CLI exposes no scriptable equivalent.

**It fails unsafe.** If Cowork has consumed half your weekly window, the
dashboard still reads ~20% and an 80% guard will happily start a run that
overruns the real limit.

**Mitigation: reserved headroom.** Settings → *Reserved headroom* holds back a
percentage of every window for usage this tool cannot see. It shrinks the
effective ceiling everywhere — meters, guards, and projection — so guards trip
early instead of late. Set it roughly to the share of your Claude usage that
happens outside the terminal. Capped at 95%.

Numbers below are always a **floor** on real consumption.

**It also cannot see a window that was reset for you.** The 5-hour block is
derived from your own turns: it opens at the first one after a gap and runs five
hours. Changing subscription tier restarts that window on Anthropic's side, and
nothing about it is written to a transcript — the entries still describe one
continuous block while the limit is being enforced against a window that started
later. Settings → *5-hour window reset (override)* takes the reset time
`/usage` prints and splits the block there: earlier work stays in history but
leaves the current window and the budget guard. It is inert once that reset has
passed, and the weekly quota is not touched.

### Ceilings are denominated in cost, not tokens

A Claude Code workload is **~98% cache reads**, which bill at 0.1×. A raw-token
ceiling therefore measures conversation length far more than it measures work,
and its ratio to any real limit drifts with context size. Cost already applies
the 0.1× / 1.25× / 2× multipliers, so it is the stabler proxy.

This is not a theoretical concern. On the same real usage, with two
plausible-looking ceilings:

| Ceiling | Reading |
|---|---|
| $50 equivalent API cost | **45%** |
| 20M raw tokens | **143%** |

Same work, 3.2× disagreement. Cost is the primary metric everywhere; raw-token
ceilings remain available as a fallback and render as a secondary line when both
are set.

### Why percentages need configuration at all

Token counts and dollar costs come straight from your transcripts and are exact.
But a *percentage* needs a denominator, and Anthropic does not publish what a
Max plan's quota is in any unit. So:

- With no ceiling configured, meters render **hatched** ("no ceiling set"), not
  at 0%. An empty bar would read as "plenty left", which is the opposite of
  "we don't know".
- **Settings → Calibrate** derives a ceiling from your own peak usage: the
  costliest fully-elapsed 5-hour block, and the peak trailing-7-day total. Those
  are **lower bounds** on the real limit (you reached them without being cut
  off), so percentages computed against them read *high* rather than low — a
  guard trips early rather than late.
- Any budget rule expressed as a fraction (`stop at 80% of weekly`) is **refused
  outright** when no ceiling exists, rather than silently passing. A guard you
  believe is active but isn't is worse than no guard.

---

## Quick start

```bash
cp .env.example .env
# edit .env:  UF_AUTH_TOKEN (recommended), UF_WORKSPACE (required),
#             UF_WORKSPACE_2… (optional, for more than one workspace)

docker compose up --build
open http://localhost:3000
```

Then in the UI: **Settings → Calibrate** to set ceilings, **Runs → New run** to
start work.

### Sign in once, inside the container

The dashboard works immediately — it only reads transcripts. **Runs will fail
with `Not logged in` until you authenticate the container's own Claude Code:**

```bash
docker compose exec -it usagefoundry claude
# then: /login
```

The `~/.claude` mount carries your transcripts, settings, rules, and plugins,
but **not** your credentials. On macOS the OAuth token lives in the login
Keychain rather than in that directory, so there is nothing on disk for the
mount to carry; a Linux container cannot read it either way.

This is a one-time step. The login writes `.credentials.json` into
`/home/node/.claude`, which *is* the mounted `~/.claude`, so it survives
restarts, `docker compose down`, and image rebuilds.

One thing the mount also cannot carry is `~/.claude.json` — it sits *next to*
the directory, not inside it — so user-scoped MCP servers are not available to
the containerised agent.

### Required environment

| Variable | Purpose |
|---|---|
| `UF_WORKSPACE` | Host directory mounted at `/workspace`. Runs are confined to it. Absolute path; compose refuses to start without it. |
| `UF_AUTH_TOKEN` | Shared secret for the UI. Blank disables auth — only acceptable on loopback. |
| `ANTHROPIC_ADMIN_KEY` | Optional. Enables the API-account page. Org Admin key only. |
| `UF_UID` / `UF_GID` | **Linux only.** The uid the container runs as; must own the mounts. Default 1000. |

Compose also mounts `~/.claude` **read-write** — Claude Code writes new session
transcripts there as runs execute, so a read-only mount breaks runs.

### On Linux, set `UF_UID` and `UF_GID`

The container writes to both bind mounts: your `~/.claude`, and your workspaces.
macOS Docker Desktop remaps bind-mount ownership onto the container user, so the
default uid 1000 is correct there no matter what your host uid is. Linux
preserves the host uid, and a mismatch is silent in a way that wastes an evening
— git refuses every repository, `/login` never persists, and the first write of a
run fails. So on Linux:

```bash
echo "UF_UID=$(id -u)" >> .env
echo "UF_GID=$(id -g)" >> .env
```

Run compose as yourself, not under `sudo`: `$HOME` comes from your shell, and
`sudo` would point the credential mount at root's home.

### Multiple workspaces

Up to four host directories can be mounted, and the New run form picks one
before picking a folder inside it. A run is confined to the single workspace it
started in — containment is checked against that mount's root alone, never
against the union of all of them.

Each slot needs **both** a name and a path in `.env`; a slot with no name is not
offered in the UI regardless of its path:

```bash
UF_WORKSPACE_NAME=Code            # slot 1 — always on
UF_WORKSPACE=/Users/you/Documents/GIT

UF_WORKSPACE_2_NAME=Notes         # slot 2 — on, because it is named
UF_WORKSPACE_2=/Users/you/Documents/Notes
```

Compose translates those into `WORKSPACE_ROOTS`, which is what the app actually
reads: `Label=/path` entries separated by `|`, an empty label meaning "skip this
slot". Outside Docker — `npm run dev` — set it directly:

```bash
WORKSPACE_ROOTS='Code=/Users/you/GIT|Notes=/Users/you/Notes' npm run dev
```

With `WORKSPACE_ROOTS` unset the app falls back to the single `WORKSPACE_ROOT`
mount, so existing deployments behave exactly as before.

---

## How a run works

The UI calls an iteration a **work cycle**, because that is the unit a first-time
user has to reason about: Claude works, reports back, and the budget decides
whether it gets another one. Internally — settings, API payloads, the database —
it stays `iteration`.

1. You supply a workspace, a folder inside it, a task, and a budget policy.
2. Before **each** iteration, the budget is evaluated. If it fails, the run stops
   (or is refused before iteration 1, which is reported distinctly as `blocked`).
3. Otherwise one `claude -p … --output-format stream-json` process is spawned in
   that folder. Its output streams to the browser over SSE.
4. Cost and tokens are read from Claude Code's own `result` event — not
   re-derived — then accumulated.
5. Iteration 2+ sends the continuation prompt and `--resume`s the same session,
   so context carries across. The run ends when the agent replies `DONE`, the
   iteration cap is hit, or a guard fires.

### The guarantee, stated honestly

**No mode here is a hard cap.** Each run picks one of three, under *When a limit
is reached*:

**Let the cycle finish, then stop** — the default, and the original behaviour.
Guards are checked **between** iterations, not during one, so what this gives you
is *"no new work starts past the threshold"* — **not** *"spend never exceeds the
threshold"*. Overshoot is bounded by one iteration **per run that was active at
the time**. Size the cap accordingly. It is also the only mode whose accounting
is exact: every cycle runs to completion and reports what it cost.

**Stop the cycle in flight** — guards are re-read about once a minute while
Claude is working, and it is killed as soon as one trips. The bound becomes *one
model turn plus one check interval plus the kill*, which on a long cycle is a
large improvement. It is still not instant, and the reason is structural: usage
is read from the transcript files Claude Code writes as each turn *completes*, so
a turn that is still thinking or still running a tool has contributed nothing to
read yet. The work in the interrupted cycle is lost. Its cost is recovered from
your transcripts afterwards and shown separately from the figure Claude Code
reported — close, but reconstructed rather than measured.

**Stop the cycle, carry on next window** — as above, except that filling your
5-hour window parks the run instead of ending it. It resumes where it left off,
same conversation and same checkout, when the next 5-hour window opens, so one
task can stretch across several of them until the weekly percentage (or the time
limit, or the cycle cap) ends it for good.

Only the 5-hour window is ever waited out, because it is the only limit here that
refills on its own, on a schedule, without being told anything. A weekly window
takes days to refill — and unless you have set your reset day in Settings it has
no reset instant at all, only a trailing total that decays. Your spend, your
cycles and the clock only move one way. So those all end a run; the 5-hour
window is the one that can pause it.

A parked run steps out of the way. It has no agent running and is spending
nothing, so a run you start afterwards on the same folder goes straight to work
rather than queuing behind it for hours; the parked one takes the folder back
once that run finishes. Only its own isolated checkout stays reserved, since its
commits live there. It survives a restart of UsageFoundry for 24 hours by
default, and its budget is re-checked from scratch before it starts spending
again, so it can also come back only to step aside once more.

The trade is worth knowing: if the parked run was working in the folder directly
rather than in its own checkout, it resumes into a tree the other run may have
changed. Its own conversation is intact; the files may not be what it left.

Concurrency multiplies the overshoot in every mode. `maxRunCostUSD` applies to
each run separately, so three runs with a $5 limit each is a $15 worst case, not
$5. Set **Runs allowed at the same time** in Settings if you want that bounded;
it is unlimited by default, and a run over the limit waits rather than being
refused. A parked run does not count against it — it is spending nothing.

### Running until the limit rather than until the agent says stop

*When Claude says the task is done* can be switched from ending the run to
sending it back in. `DONE` then stops meaning anything, and the run ends only
when a limit is reached. It is worth being clear about what that is: an agent
told to carry on past a task it believes finished will find work, and not all of
that work is good. The prompt it gets (Settings → **Carry-on prompt**) points it
at verification, tests and edge cases rather than at new features, and an
isolated checkout is strongly advised so the output arrives as a branch you can
throw away.

Because `DONE` no longer ends the run, something else has to. A run with no cycle
limit is refused unless it has a time limit — the clock is the only limit that
keeps advancing whether or not a cycle survived long enough to report what it
spent.

Stopping a run signals the current work cycle and prevents any further one. If
the stop lands between cycles there is no process to signal, but the run still
ends — it is recorded as `stopped`, not as a failure.

### Picking a run back up

A run that ended — because it crashed, because Claude Code exited non-zero,
because UsageFoundry restarted under it, because you stopped it, or because it
hit one of its own limits — has a **Resume** button on its page. It keeps its
folder, its isolated checkout and branch, its spend so far, and its Claude Code
session, so it continues the conversation rather than starting a new one. A run
that died before it had a session to continue starts again from the original
task instead, and says so.

Resuming asks for the limits again, pre-filled from the run, because the usual
reason a run needs picking up is that its own limits ended it. They are totals,
not top-ups: a run that used 1 of 1 cycles needs the cycle limit raised above 1,
and the button refuses and says so rather than queueing a run that would stop
again on its first check. The time limit is the exception — it runs from the
moment it starts again, since counting the hours it spent dead would refuse
every run older than its own limit. Everything else carries over untouched.

A run that reported `DONE` has no Resume button. Sending an agent back into work
it believes finished needs a different prompt, which is what *When Claude says
the task is done* above is for.

---

## Two runs, one project

Several runs can be in flight at once. What happens when two of them want the
same folder depends on whether that folder is a git repository.

**A git repository — they run in parallel.** Each run gets its own `git worktree`
on its own branch, under `.uf-worktrees/` beside the repository, and works there.
Your own checkout is never touched: your uncommitted changes stay yours, and you
stay on your branch. When the run ends you get a handoff card with the commands
to review the branch and, if your checkout is clean, to merge it. **UsageFoundry
never merges anything itself.**

Two consequences worth knowing before you rely on it:

- A worktree starts from your **last commit**. Uncommitted work is not carried
  over, and neither is anything gitignored — no `node_modules`, no build output.
  Your `.env` files are copied across (configurable in Settings) so the first
  command does not fail on a missing variable; everything else the agent installs
  itself. Checkouts are reused between runs, so that cost is paid once per slot.
- Work the agent leaves **uncommitted** stays in the worktree and never reaches
  your branch. That is why the isolated-run preamble tells it to commit as it
  goes — keep that instruction if you edit the wording.

A checkout under `.uf-worktrees/` is usable **from inside the container only**.
`git worktree` records an absolute path to its gitdir, and the container knows
your repository as `/workspace/…` while you know it as whatever you mounted — so
`cd`-ing into one of those directories on the host gives you `fatal: not a git
repository`. Nothing is lost: the *branch* lives in the real repository, which is
what the handoff card hands you. The same asymmetry runs the other way, so a
worktree **you** created on the host is not usable by a run either, and the
folder picker will say so rather than offering isolation. Two habits follow from
it: review the branch from your own checkout, not by opening the worktree, and do
not run `git worktree prune` on the host while a run is in flight — from there
those registrations point at paths that do not exist.

You can turn this off per run with **Isolation → work in the folder itself**, in
which case it behaves like the case below.

**Anything else — they take turns.** A plain folder has no repository to branch
from, so a second run on it is **queued**, not refused, and starts on its own when
the folder frees up. The folder picker marks what is busy and what is waiting, and
the run page shows a queued run's position in line.

"The same folder" is more inclusive than string equality, deliberately: a run
started on the **whole workspace** holds every folder inside it, two workspaces
pointing at one directory count as one, and on macOS a name differing only in case
is the same folder. Queueing is strictly first-come — a run waiting on the whole
workspace is not overtaken by smaller runs submitted after it.

If the server restarts mid-run, the run is closed out as failed rather than left
holding its folder forever, and the stop reason carries the `claude --resume`
command to pick the session up by hand. Queued runs are cancelled rather than
started later, so nothing spawns unattended from a prompt you have forgotten about.

### Budget policy

| Rule | Behaviour |
|---|---|
| `maxIterations` | Cap on iterations. `null` disables it, but only alongside `maxDurationMinutes`. |
| `maxRunCostUSD` | Stop when this run's own spend reaches it. `null` disables it. |
| `maxDurationMinutes` | Wall-clock cap, **including time spent parked**. `null` disables it. |
| `maxWeeklyFraction` | Stop at N% of the weekly window (cost-denominated). **Requires a configured ceiling.** Always ends the run. |
| `maxSessionFraction` | Stop at N% of the 5-hour window (cost-denominated). **Requires a configured ceiling.** Parks the run instead under `live-resume`. |
| `enforcement` | `between-cycles` \| `live` \| `live-resume` — when a tripped rule is acted on. Under `live-resume` a run also parks when **Claude itself** refuses a cycle for want of allowance, which needs no fraction and no ceiling. |
| `continueAfterDone` | Ignore the agent's `DONE` and send it back to the same task. |

`maxRunCostUSD` is the one guard that needs **no ceiling** — it is absolute. Use
it on day one, before you have enough history to calibrate.

The loop always needs a **monotone terminus**: at least one of `maxIterations` or
`maxDurationMinutes`. Those two are the only quantities that move one way and
keep moving — this run's own spend stops accruing the moment a cycle is killed
before it could report, and both window fractions can fall. A policy with
neither is refused at creation, and refused again as `no_terminus` if it reaches
the guard by some other route.

---

## Accuracy notes

Two details that materially change the numbers, both handled:

**Deduplication.** Claude Code writes the same assistant message to disk more
than once (resumed sessions, sidechain replay, snapshot rewrites). Every copy
carries an identical `message.id` + `requestId`, which is used as the dedupe key.
On the transcripts this was developed against, **99 raw records deduplicated to
31** — summing naively would have over-reported by roughly 3×.

**Cache TTL pricing.** `cache_creation` splits into `ephemeral_5m` and
`ephemeral_1h`, which bill at **1.25×** and **2×** input respectively. Claude
Code leans on 1h writes, so collapsing both into one number understates spend on
exactly this workload. Cache reads are billed at 0.1×. Older records with no TTL
split are attributed to the cheaper 5m bucket, so an unsplit record understates
rather than overstates.

Models with no known price contribute **$0 to every reported figure and are
listed in a banner** — dollar totals are a floor, never a silent guess.

**The budget guard is the one exception, deliberately.** A displayed $0 means a
window consisting entirely of an unpriced model reads as 0% used, and no
threshold can ever be crossed — so the guard would quietly cease to exist the
week a new model ships. For guard purposes only, an unrecognised model is
charged a conservative **$10/$50 per Mtok**: the most expensive
current-generation rate in the table, so an unknown can never look cheaper than
something known. The meters draw that as a hatched band past the solid fill, so
a run stopped before the visible bar looks full is explained rather than
mysterious. Nothing shown as a dollar amount is ever the fallback rate.

**Cost attribution.** Beyond model and project, each turn is broken down by
**reasoning effort**, **sub-agent**, and **skill** — all three recorded by Claude
Code on the transcript record itself, so the tables cover full history rather
than starting from the day they were added. Turns with no sub-agent or skill get
explicit `(main thread)` / `(no skill)` buckets, so every column reconciles to
the window total instead of quietly omitting a remainder. Effort is typically
the largest single lever; excluding sub-agent turns in Settings empties the
by-agent table, which the card says outright.

**Agent self-reporting (optional, off by default).** Claude Code computes a cost
for every API request and will push it to any OTLP endpoint. Turning on *Agent
self-reporting* in Settings points agents this app spawns back at this server,
which records one row per request — a first-party number that needs no price
table, no dedupe key, and no file polling. It is shown as its own card on the
run page and is **never** merged into `spent_usd`, the dashboard, or the budget
guard, all of which stay transcript-derived.

Its one real advantage: per-iteration spend normally comes from the CLI's
terminal `result` event, so a work cycle killed before that event reports $0.
Telemetry arrives per request as the run proceeds, so it captures that work. A
telemetry figure *higher* than the run's own total is the expected outcome of an
interrupted run, not a discrepancy.

It cannot replace the transcript scan: there is no historical backfill, no `cwd`
so no per-project attribution, and `cache_creation_tokens` is a single number
with the 5m/1h split collapsed. The payload also carries `user.email` and
account UUIDs — none of which are stored.

Provider-decorated model IDs are canonicalised before lookup — Bedrock's
`us.anthropic.claude-…-v1:0` and Agent Platform's `claude-…@20250929` resolve to
the same rates as the first-party IDs. No short catch-all keys are used: a
hypothetical `claude-opus-4` key would price an unreleased `claude-opus-4-9` at
a confident wrong number instead of surfacing it as unknown.

---

## Security

This container holds your Claude credentials and runs an agent that can modify
mounted code. Treat it as privileged.

- Compose binds to **`127.0.0.1:3000`**, not `0.0.0.0`. Change that only behind
  auth and TLS.
- Set `UF_AUTH_TOKEN` (`openssl rand -hex 32`) for anything beyond loopback.
- Folder input is resolved and containment-checked **before** filesystem access,
  and again after symlink resolution. `../`, absolute paths, and symlinks out of
  the tree are all rejected.
- With several workspaces mounted, containment is checked against **one mount at
  a time**, never their union. A run is confined to the workspace it started in,
  so a path valid in one workspace is rejected in another.
- The agent is spawned with an argument array and **no shell**, so a prompt
  containing shell metacharacters is inert.
- `bypassPermissions` lets the agent run any command in the mounted folder
  without asking. The UI warns; the default is `acceptEdits`.

---

## Architecture

```
src/lib/
  transcripts.ts   JSONL parser — incremental byte-offset reads, dedupe
  windows.ts       5-hour block + weekly rollups, burn rate, projection
  pricing.ts       per-model rates, cache-TTL multipliers, fast mode
  adminApi.ts      Admin API client (rate limits, usage, cost) w/ pagination
  budget.ts        policy evaluation
  orchestrator.ts  run loop, process spawn, stream-json parsing, SSE bus
  db.ts            SQLite (runs, events, settings)
src/app/api/       usage · account · runs · calibrate · settings · folders
```

Transcripts are re-read incrementally: only bytes appended since the last scan
are parsed, and a partial trailing line is left unconsumed for the next pass.

---

## Verified

Built and exercised against real transcripts:

- Cost math cross-checked by hand — `$12.843618` computed independently vs
  `$12.8436175` from the API, on 54 input / 83,517 output / 12,072,025 cache-read
  / 471,941 cache-1h tokens.
- Dedup verified (99 → 31 records).
- Incremental re-scan picks up records appended mid-session.
- Budget refusal returns `blocked` with 0 iterations and 0 spend.
- Metric selection: cost ceiling wins when both are set; falls back to tokens
  when cost is cleared; null when neither is set.
- Budget guard evaluated against the cost fraction — allowed at an 80% guard,
  refused at 5% with the window at 11.2%.
- Unpriced-model guard fallback, 17 assertions against the compiled modules: a
  window of 90M output tokens from an unknown model still reports `$0` and
  `fraction = 0` (so the pre-fix guard could never fire) while `guardFraction`
  reads 45× a $100 ceiling and the guard blocks with `weekly_fraction`. A fully
  priced window keeps `guardFraction === fraction` exactly, an under-threshold
  window is still allowed, and a fraction guard with no ceiling still refuses
  with `no_ceiling` rather than being satisfied by the fallback.
- Model-ID canonicalisation: `us.anthropic.claude-opus-5-20260101-v1:0`,
  `anthropic.claude-sonnet-4-5`, and `claude-sonnet-4-5@20250929` all resolve;
  `claude-nextgen-9` stays unknown; `claude-opus-4-1` keeps its own $15/$75.
- A zero-token turn (`<synthetic>`) no longer counts as an unpriced model, and
  incurs no fallback charge.
- Attribution tables against real transcripts: effort, sub-agent, and skill each
  reconcile to the window total to within a rounding error ($138.3639 over 998
  turns), every turn lands in exactly one bucket per breakdown (998 = 998), and
  the `groupBy` refactor left `byModel` / `byProject` reconciling as before.
- Stop path, end to end against a stub CLI that ignores SIGTERM: the run now
  reaches `stopped` about 8s after the stop (5s escalation + 2s drain grace),
  where it previously stayed `running` indefinitely. Two independent causes
  were needed — the `!child.killed` test made the SIGKILL escalation dead code,
  and even once SIGKILL was delivered, an orphaned grandchild still holding the
  inherited stdout pipe kept `close` from ever firing, so the iteration is now
  settled from `exit` as well.
- Operator stop records `stopped` with the interrupted-cost note in
  `stop_reason`, not `failed`.
- Child environment, dumped from a real spawned process: 97 variables reach the
  agent with `PATH` and `HOME` intact, while a sentinel `ANTHROPIC_ADMIN_KEY`,
  `UF_AUTH_TOKEN`, and every `OTEL_*` are absent.
- Normal accounting path unaffected: a stub emitting a `result` event records
  $0.42 / 35 tokens, completes on `DONE`, and adds no interrupted-cost note.
- OTLP ingest over HTTP: a captured batch inserts 1 row, replaying it inserts
  0, a garbage body yields `seen: 0`, and a non-JSON body still returns 200 so
  the exporter does not retry it forever. The stored row has no column for
  `user.email` or any account UUID.
- OTLP transport captured from a real headless `claude -p` run on CLI v2.1.226,
  not taken from the docs. Telemetry *does* initialise under `-p`; a base
  endpoint of `/api/otlp` receives `POST /api/otlp/v1/logs` and
  `/api/otlp/v1/metrics`, so the CLI appends the signal suffix itself; the body
  is uncompressed `application/json`. The docs name the event
  `claude_code.api_request`, but on the wire that string is the record *body*
  and the `event.name` attribute is the bare `api_request` — the parser accepts
  both. `OTEL_RESOURCE_ATTRIBUTES` lands on the resource *and* on each record,
  and the parser merges both so run attribution does not depend on which.
- OTLP parser run against those captured payloads, 13 assertions: extracts the
  priced request with its `req_…` id, first-party cost, tokens and run id;
  drops `user.email` / `user.account_uuid` at the parser; a redelivered batch
  inserts 0 rows (delivery is at-least-once); an unknown run returns null
  rather than a zero row; and malformed or null payloads return empty instead
  of throwing, since a rejected batch would be retried forever.
- Plan detection reads `Claude Max 20x` from `.credentials.json` with no email,
  name, or account UUID crossing the wire; caches for 60s including misses (the
  CLI writes these files lazily); and degrades to "plan unknown" with no error
  when the config directory holds neither file. The legacy `~/.claude.json` is
  consulted only while the config directory is still the default — a redirected
  `CLAUDE_HOME` reports no plan rather than the wrong one.
- Path traversal rejected in every form tested: `../` escape, absolute path
  outside all mounts, a symlink pointing out of the tree, a folder belonging to a
  *different* mount, an unknown mount id, an unmounted workspace, and a path
  inside a workspace slot that is configured but disabled.
- Multiple workspaces: slots parse and are listed independently, a disabled slot
  is skipped, a missing one is reported as unavailable rather than empty, and a
  run's folder maps back to its workspace even when the mount is reached through
  a symlink.
- Folder collision (`npm test`, 8 cases): a folder collides with itself, not with
  a sibling, with its own parent and child in both directions, with the same
  directory reached through a second workspace, and with a name differing only in
  case; a nested mount reached through an alias keeps its parent-relative prefix,
  so the one directory named two ways still collides and the parent mount still
  contains it; two isolated checkouts do not collide with each other or with the
  repository, but all of them collide with a run on the whole workspace.
- Concurrency, against a real database with a stub agent: two runs on one plain
  folder → the second queues and is promoted automatically when the first ends;
  a run on a different folder starts immediately; a run on the workspace root
  queues behind both and still runs rather than being starved; `session_id` is
  persisted.
- Isolation, against a real repository with uncommitted work and a gitignored
  `.env`: two runs on one repo both start, in different slots, each on its own
  `uf/…` branch; the seeded `.env` is present in the checkout; the operator's
  modified file and current branch are untouched; `.uf-worktrees/` does not
  appear in `git status`.
- Restart recovery: a row left `running` is closed out as `failed` with the
  `claude --resume <id>` command in its stop reason, freeing the folder.
- Concurrency limit and stopping: with the limit at 1, runs on two further idle
  folders queue rather than being refused, and exactly one is promoted when a
  slot frees; stopping a live run records `stopped` rather than `failed`, and a
  run whose agent leaves a grandchild holding its output still terminates.
- The **standalone** build (what the container runs) boots and serves, native
  SQLite binding included.
- **One real billed run**, end to end: 1 iteration, exit 0, stopped at the
  iteration cap, $0.067 / 13,983 tokens accounted correctly.
- Reserved headroom: 50% reserve halves the effective ceiling ($200 → $100),
  doubling the reading (13.8% → 27.5%) and converting a 20% guard from allow to
  refuse. Out-of-range input (400%) clamps to 95%.
- Budget policy and guard ordering (`npm test`, 11 cases): `normalizePolicy` is
  idempotent across a JSON round trip for every field, an explicit `null` cycle
  cap survives while blank / zero / negative / missing all still mean one cycle,
  a string `"false"` for `continueAfterDone` reads as off, and an unknown
  enforcement mode degrades to `between-cycles`. `evaluateBudget` refuses
  `no_terminus` ahead of every other check, parks on the 5-hour window only
  under `live-resume` and never on the weekly one, **ends** rather than parks a
  run that is also out of time, still refuses a fraction guard with no ceiling,
  and blocks on reconciled spend that `spent_usd` alone would have missed.
- Provider refusals (`npm test`, 11 cases): `isUsageLimit` matches both the
  wording the CLI renders and the wording in its own error taxonomy, including a
  model label it has never seen; leaves `Not logged in`, a spend cap and a
  credit balance to fail as themselves; and treats a 429, an overloaded upstream
  and a plain rate limit as transient rather than as an exhausted allowance —
  money and blips are the two things that must not be waited out.
  `refusalResumeAt` waits for a window still open, backs
  off 20/40/60 minutes for one already passed or invisible, never re-spawns
  inside five minutes, and never holds a folder past six hours.

### Not yet verified by hand

The live-enforcement and pause/resume paths typecheck, build (including the
standalone bundle), and are covered by the unit tests above, but the following
have **not** been exercised against a real CLI. They are the list to work
through before trusting this unattended:

- Whether `claude -p` flushes its `result` event on `SIGINT`. If it does, an
  interrupted cycle keeps its measured cost and the transcript reconciliation
  becomes a fallback rather than the norm.
- **What a subscription-limit refusal actually says.** The `<synthetic>` marker
  is confirmed from a real record on this machine, but the only refusal ever
  seen here is `Not logged in · Please run /login`. The wording `isUsageLimit()`
  matches was read out of the shipped binary's own strings, not observed on the
  wire, and the `usage limit reached|<epoch>` form the ecosystem keys on is not
  in that binary at all. A refusal it fails to classify still reports honestly —
  it just fails instead of waiting. The `error` run event records the text, the
  exit code and whether the pattern matched, so the first real occurrence is
  enough to correct it.
- Whether a refusal ever arrives on stderr alone rather than as a `<synthetic>`
  assistant turn. `refusalInStderr` covers that case but has never fired.
- Whether `claude --resume` accepts a session whose transcript was truncated by
  a mid-turn kill. The recovery ladder retries once and then stops, naming the
  command — it deliberately does not start a fresh session.
- A run parking and resuming across a real 5-hour boundary, in the same
  worktree, on the same branch, with its commits intact.
- A paused run surviving `docker compose restart`, and a stale one being closed
  out once past `resumeGraceHours`.
- A parked run taking its folder back: that it stays parked while the run that
  took the folder is still working, and starts within a sweep of that one
  finishing. The hand-over in the other direction — a new run starting straight
  away instead of queuing — was reproduced against the live container.
- Resuming a finished run into a real agent: that `--resume` picks the session
  back up, and that an isolated one lands in its own checkout still on its own
  branch. The refusals around it — an exhausted cycle or spend limit, a checkout
  another run has taken, a `completed` run offering no button — were checked
  against the live container.
- `detached: true`: that Ctrl-C during `npm run dev` still kills the agent (via
  the new `instrumentation.ts` handler) and that a long command the agent
  started dies with it.

There is no linter run in this repo, and `npm test` covers four things: the
folder-collision predicate, which queued runs may start, the budget policy, and
how a provider refusal is classified and backed off from. `npm run typecheck` plus
a `docker compose up --build` smoke test is still the real verification loop,
and the list above records what was checked by hand.

---

## License

Source-available, not open source — see [LICENSE](LICENSE).

You may use, self-host, modify and study it for your own personal,
non-commercial purposes. **Distributing it, and using it commercially or inside
an organisation, both need written permission** — ask, and it may well be given.

Releases before this change were MIT, and this does not withdraw rights anyone
already has in a copy they received under those terms.
