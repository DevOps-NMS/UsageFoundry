<h1 align="center">UsageFoundry</h1>

<p align="center">
  <strong>A self-hosted dashboard and headless run orchestrator for Claude Code.</strong><br>
  See where your Pro/Max allowance is going, then spend it deliberately —
  agents that run to a budget and stop.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: source-available" src="https://img.shields.io/badge/license-source--available-blue"></a>
  <img alt="Docker" src="https://img.shields.io/badge/deploy-single%20container-2496ED?logo=docker&logoColor=white">
  <img alt="Next.js 15" src="https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Self-hosted" src="https://img.shields.io/badge/data-stays%20local-brightgreen">
</p>

<!-- SCREENSHOT: a dashboard shot belongs here — it is the single biggest thing
     still missing from this page. Same image as the repo's social preview. -->

---

## What it does

**Track the allowance.** Parses Claude Code's own transcripts (`~/.claude/projects/**/*.jsonl`)
into exact token volumes and costs, and reads your real utilisation percentage
from the same first-party endpoint `claude /usage` calls. 5-hour window, weekly
quota, burn rate, projected exhaustion, and breakdowns by model, project, agent,
skill and reasoning effort.

**Spend it deliberately.** Point a run at a folder, give it a task and a budget,
and it drives `claude -p` headlessly in a loop — re-checking the guard before
every work cycle and stopping when the money, the cycles, the clock or the
window runs out.

**Keep runs out of each other's way.** Each run gets its own git worktree and
branch, so several agents work one repository at once. Review the diff, resolve
conflicts, and merge from the UI when you're ready.

**Chain the work.** Saved workflows are graphs of run blocks — including blocks
that *decide* what to run next, blocks that *repeat* one task until the agent
reports it done, and blocks that land what the ones before them built. Run one on
a schedule, under a budget that covers the whole graph.

**Bring the tooling you already have.** Claude Code plugins sitting in your
mounted folders are found and listed under **Settings → Plugins**. Switching one
on puts it on every work cycle this app starts from the next cycle onward,
including runs already in flight — nothing is installed into `~/.claude`, and
nothing outside your mounts is ever offered.

Everything runs on your machine, in one Docker container. No account, no
telemetry back to us, no third-party service.

---

## Quick start

```bash
git clone https://github.com/Xapicc/UsageFoundry.git
cd UsageFoundry
cp .env.example .env
# edit .env:  UF_WORKSPACE (required — the code you want agents to work on)
#             UF_AUTH_TOKEN (required: openssl rand -hex 32)

docker compose up --build
open http://localhost:3000
```

**`UF_AUTH_TOKEN` is no longer optional.** With it blank every route here is
open to whoever can reach the port, including the one that starts billed agents
with write access to your workspaces — so the server now refuses to start rather
than serve that without saying so. If you genuinely want no authentication (a
loopback-bound install on a machine you alone use), set `UF_ALLOW_NO_AUTH=1`
alongside it: the app then starts, logs a block at boot, and puts a banner on
every page saying it is unauthenticated. Nothing else accepts that state.

The port is published on `127.0.0.1` for the same reason. To reach the app from
another machine on your network, set `UF_BIND_ADDRESS=0.0.0.0` — with a token
set, `UF_ALLOW_NO_AUTH` blank, and `UF_COOKIE_SECURE=0`, since a browser never
returns a `Secure` cookie over plain HTTP. [Reaching it from another
machine](docs/install.md#reaching-it-from-another-machine) has the whole of it,
including what a shared secret over HTTP does and does not buy.

The dashboard works immediately. **Runs need one extra step** — the `~/.claude`
mount carries your transcripts but not your credentials, so sign the container
in once, in **Settings → Claude account → Sign in**: it opens an Anthropic link,
you approve, you paste the code back. The same row signs it out again.

That login is what every run bills against, and an agent can read it: a work
cycle runs as the uid that owns the mounted `~/.claude`, which is the only way
it can authenticate at all. The server runs as a *different* uid from the agents
so that the app's own secrets — `UF_AUTH_TOKEN`, `ANTHROPIC_ADMIN_KEY` — are out
of their reach, but your Claude account, every mounted workspace and
`UF_GITHUB_TOKEN` are inside the trust boundary of anything you run unattended.
**[docs/security.md](docs/security.md)** sizes all of it.

**A plugin you switch on is inside that boundary too.** It is a directory found
in one of your mounted workspaces, and enabling it means the container runs
whatever that directory ships — hooks, agents, skills, commands, an MCP server —
as the agents' uid, on every work cycle from the next one onward, runs already
in flight included. The Plugins tab says which of those each one carries before
you press it, and the switch is saved the moment you press it rather than on
*Save*.

Full setup, including Linux `UF_UID`, multiple workspaces and GitHub access, is
in **[docs/install.md](docs/install.md)**.

### The configuration is checked before the server serves

Exactly one variable is **required** and refuses to start when it is wrong:
`DATA_DIR`, which decides where the only copy of your runs, settings, workflows
and schedules lives. It is set to `/data` by `docker-compose.yml`, and the
container exits with a message naming the path and the uid if it is blank, is
not a directory, or cannot be written:

```
[usagefoundry] Refusing to start. DATA_DIR is set to the empty string, which is
read as unset — so the database would be created at /app/.data … destroyed by
the next `docker compose up --build`.
```

Everything else is **reported and kept running**, on stdout at boot and in a
banner on the dashboard: a workspace whose path is not a directory (Docker
creates a missing bind source rather than refusing, so a typo in `UF_WORKSPACE`
looks exactly like an empty one), a `CLAUDE_HOME` with no `projects/` under it
(every usage figure reads zero), and any variable set to the empty string where
blank is not an answer. Eight variables are where blank *is* an answer, and none
of them is ever reported: `UF_AUTH_TOKEN`, `ANTHROPIC_ADMIN_KEY`,
`UF_GITHUB_TOKEN` and `UF_GITHUB_TOKENS`, where it means *off*;
`UF_ALLOW_NO_AUTH`, `UF_COOKIE_SECURE` and `UF_TRANSCRIPT_CACHE_MAX_ENTRIES`,
where it means *take the default*; and `UF_UNMOUNTED_WORKSPACES`, which compose
computes rather than you, and where blank is the success case — a non-blank
value there refuses the boot. `BLANK_MEANINGFUL_ENV_VARS` in `src/lib/config.ts`
is the list.

Two of those are ones the Quick start above tells you to set, so read the silence
carefully: a blank `UF_ALLOW_NO_AUTH` or `UF_COOKIE_SECURE` is *taken as the
default*, not reported, and nothing at boot distinguishes it from a value that
arrived.

The full table is in [docs/install.md](docs/install.md#required-environment).

---

## Back up the database

Everything this app knows about itself — every run and its event log, what each
one cost, your ceilings and guards, your templates, specialists, workflows and
schedules — is one SQLite file in one Docker volume. There is no second copy.
`docker compose down -v` destroys it in one command, and saved workflows and
schedules exist nowhere else: not in git, not in a file, not in an export.

Take a snapshot, safely, while runs are working:

```bash
docker compose exec usagefoundry node scripts/backup-db.mjs /backups
```

It writes `./backups/usagefoundry-<timestamp>.db` on the host — a bind mount, so
it survives the command that destroys the volume. Put it in cron, keeping the
last 14:

```cron
15 3 * * * cd /path/to/UsageFoundry && docker compose exec -T usagefoundry node scripts/backup-db.mjs /backups --keep 14 >> backups/backup.log 2>&1
```

**Nothing runs it for you.** Restore, onto a fresh container and a fresh volume:

```bash
docker compose down
docker compose run --rm --entrypoint node usagefoundry \
  scripts/restore-db.mjs /backups/usagefoundry-20260814T031500Z.db
docker compose up -d
```

**`cp` is not a backup here, and neither is `docker cp`.** The database is in WAL
mode, so a copy of `usagefoundry.db` is missing every transaction since the last
checkpoint — it opens cleanly, passes `integrity_check`, and is silently short of
the newest runs. Measured against a live writer: 25 runs in the copy, 386 in a
snapshot taken at the same instant, both files reporting `ok`. The command above
uses SQLite's own `VACUUM INTO`, which is consistent by construction.

Why, in full, and what a restore refuses to do:
**[docs/backup-and-restore.md](docs/backup-and-restore.md)**.

---

## Operating it unattended

At one operator watching one page, the operator *is* the monitoring. Left
running with agents working on their own, nothing is looking — so two endpoints
answer without you.

**`GET /api/health`** — unauthenticated, counts only, and the container's own
`HEALTHCHECK` probes it. It answers **503** when SQLite cannot be read or
written, and 200 with `"status": "degraded"` when something is wrong but a
restart would cost more than it fixes — this process no longer owning its data
directory, parked runs whose sweeper has stopped, sweeps that are throwing, or a
congested event loop.

```bash
curl -sf http://127.0.0.1:3000/api/health | jq .
docker inspect --format '{{.State.Health.Status}}' usagefoundry
```

A loop blocked *outright* cannot be reported by any field in that body, because
the request is never handled — that case is the probe's own `--timeout`, which
is what turns the silence into an unhealthy container. And note that Docker
Engine **surfaces** health state without acting on it: `restart: unless-stopped`
restarts on process exit only. Wiring an unhealthy container to a restart is
your supervisor's job, and it is left to you deliberately — a restart here marks
every in-flight run `failed` and leaves the cycle it was mid-way through
unreconciled.

**`GET /api/status`** — what the fleet is *doing*: queue depth, how long the
oldest queued run has waited, the two live windows' spend and fractions, the
three stores' sizes, sweeper liveness, and the last restart's reconciliation
count. Set **`UF_STATUS_TOKEN`** in `.env` to give it a read-only credential of
its own; that is what a monitor should hold, because `UF_AUTH_TOKEN` is the
token that can also start billed agents.

```bash
curl -s -H "Authorization: Bearer $UF_STATUS_TOKEN" \
  http://127.0.0.1:3000/api/status | jq .
```

With `UF_STATUS_TOKEN` unset the route is not exempt from the ordinary gate at
all — a monitor gets a 401 rather than the endpoint being public.

### What to alert on

Every one of these is a field on `/api/status`. The thresholds are a starting
point; the *conditions* are the ones that have gone wrong here.

| Condition | Field | Suggested threshold |
|---|---|---|
| The queue is backing up | `queue.depth` | `> 10`, or `> maxConcurrentRuns × 2` |
| A run has been queued and never started | `queue.oldestQueuedAgeSeconds` | `> 3600` |
| Parked runs are not being reconsidered | `sweeper.lastTickAgeSeconds` | `> 180` while `runs.paused > 0` |
| Every sweep is failing (parked runs never resume) | `sweeper.failures` | any increase |
| A live guard has stopped reading | `liveGuard.failures` | any increase |
| The 5-hour allowance is nearly spent | `windows.session.guardFraction` | `> 0.9` |
| The weekly allowance is nearly spent | `windows.weekly.guardFraction` | `> 0.9` |
| The database is growing without bound (#62) | `stores.databaseBytes` | `> 2e9` |
| Checkouts are filling the disk (#69) | `stores.checkoutsBytes` | site-specific — compare against free space |
| Transcripts are filling the disk (#95) | `stores.transcriptsBytes` | site-specific |
| A restart terminated runs | `lastBootReconcile.closed` | `> 0` — each one needs picking up by hand |
| Another process took the data directory | `dataDirOwned` | `false` |

A `guardFraction` of `null` means *no ceiling is configured and the provider
reported nothing* — it is not zero, and an alert that treats it as a number will
read a window nobody can measure as a window at rest.

### Logs

Lifecycle events are written to container stdout as **one JSON object per
line**, beside the existing `[usagefoundry] …` prose:

```json
{"ts":"2026-08-14T09:12:03.114Z","level":"info","event":"run.cycle_finished","run_id":"…","subtype":"success","cost_usd":0.42,"duration_ms":183422}
```

Ten events in all: `run.status`, `run.cycle_started`, `run.cycle_finished`,
`run.guard_tripped`, `run.error`, `run.sandbox_refusal`, `sweep.failed`,
`live_guard_tick.failed`, `boot.reconciled`, `http.mutation`. The
noisy kinds — the agent's own output, every tool call, every log line — are
deliberately **not** on stdout; they are in `run_events` and on the run page,
where they are readable. `run.sandbox_refusal` is the one tool failure that
crosses that line, and it is there for the reason a tripped guard is: a policy
that refuses the work fails *inside* tool calls, and at twenty-five unattended
runs the run page is not where anyone finds that out. Filter it out and a
sandbox refusing every agent's calls looks like runs that quietly do less work.
What is on stdout is projected field by field rather
than dumped, so no prompt text, folder path or credential reaches it.

### Who started what

Every run records the gate it came through, so the question "who authorised
this" is one query rather than three joins:

```bash
sqlite3 "$DATA_DIR/usagefoundry.db" "SELECT origin, count(*) FROM runs GROUP BY origin;"
```

`form`, `chat`, `workflow`, `orchestrator-block`, `schedule` — the last three
start an agent with nobody at the keyboard. `origin_ref` names the proposal,
instance, schedule or block behind it, and survives that record being deleted.
Picking a finished run up again does **not** rewrite either: it stamps
`reopened_at`, because a reopen is a second authorisation and not a different
creation. The run page states it in words.

Every mutating request leaves a line beside it — method, path, status, the id it
affected, which credential class was used, and the source address:

```bash
sqlite3 "$DATA_DIR/usagefoundry.db" \
  "SELECT ts, method, path, status, subject, actor, address FROM request_log
     ORDER BY id DESC LIMIT 20;"
```

Never a request body, a query string, a cookie or a token: `actor` says *how* a
caller authenticated (`session`, `bearer`, `capability`, `open`) and never with
what. The table keeps its newest 20,000 lines.

---

## Read this before you trust a number

Your 5-hour and weekly limits are **shared across every Claude surface**, but
only Claude Code writes local transcripts. Work done in Claude Desktop, the web
app, or Cowork spends the same allowance and is **invisible here** — so every
locally-derived figure is a *floor* on real consumption, and a guard set at 80%
can start a run that overruns the real limit.

Two things soften that. The utilisation *percentage* is read from Anthropic's
own endpoint and therefore covers the whole account, including surfaces this
tool cannot see. And **Settings → Reserved headroom** holds back a slice of
every window for the rest, so guards trip early instead of late.

Where a number is exact, where it is estimated, and where it is a guess with a
name on it: **[docs/limits-and-accuracy.md](docs/limits-and-accuracy.md)**.

---

## Disk and retention

Agents produce data on three different volumes, and all three grow with the work
rather than with your settings. What each one is bounded by is on
**Settings → Storage**, which also shows what is in it right now.

| Store | Where | Grows with | Kept for |
|---|---|---|---|
| Run logs (`run_events`, telemetry) | the `usagefoundry-data` named volume | tool calls, replies, agent stderr | 30 days after a run finishes |
| Isolated checkouts (`.uf-worktrees`) | **your workspace**, beside your own code | one per concurrent run per repository | 7 days after the run finishes |
| Session transcripts | **`~/.claude/projects`**, beside your credentials | one file per session, growing as it runs | 30 days after the file was last written |

The horizons are per store because the media are. Blank means *keep for ever*,
which is what shipped before this existed. **A run that has not finished is
never swept**, however old its rows are, and **no sweep ever removes a run's own
record** — its spend, its cycle count, how it ended and where its branch went
stay for as long as the database does. What a horizon discards is the evidence
behind those figures.

**What to provision.** A run log is roughly 1 KB per tool call plus whatever the
agent's own build output comes to, and a stored tool input is cut at 4 KB, so a
busy single-operator install settles around a few hundred megabytes. Twenty-five
concurrent runs is ~11,000 tool events an hour: about **1 GB a week** at the
30-day default, an order of magnitude more without one.

Checkouts are the big one and they are on *your* disk. A Node repository with
its dependencies installed is 300 MB–1.5 GB, and every concurrent run on a
repository takes its own — so a day of 25 runs is tens of gigabytes on the
volume holding your real work. **Reclaiming one removes only the directory**:
its branch, its commits and anything not yet landed stay in the repository, and
a checkout an active run holds, or one with uncommitted work in it, or one whose
branch still carries commits its target does not have, is never touched. What
you lose by reclaiming is the installed dependency tree the next run in that
slot would have reused, which is why the horizon is a week rather than a day.

Transcripts are on your home directory, and they are measured: **233 MB in four
days** at well under 25 concurrent runs, at a mean of 0.62 MB and a p90 of 1.58
MB per session. At 25 runs — roughly 1,800 sessions a day — that is **1–3 GB a
day, 30–85 GB a month**, unbounded, on the filesystem that also holds
`~/.claude/.credentials.json`. Provision for a month of it at your own
concurrency, or shorten the horizon. Two consequences of pruning are worth
knowing before you do:

- **A pruned transcript ends any chance of resuming that conversation.** The
  sweep never takes one belonging to a run that has not finished, or to any
  chat. For a *finished* run it clears the stored session id along with the
  file, so reopening that run starts a fresh session and is told, in its first
  prompt, which branch the earlier attempt's commits are on — the same restart
  this app already does when a session id was never recorded.
- **It shortens the dashboard's calendar history.** That card offers twelve
  months and the horizon is thirty days, so buckets older than the cutoff are
  priced from files that are gone. The card says which ones rather than
  quietly understating them, and periods with nothing left in them drop off it.

**None of this is a backup.** Retention bounds what the volume grows to; it does
not give you a second copy of it. That is [Back up the
database](#back-up-the-database) above, and it is the one thing here nothing does
for you.

**Reclaiming the space.** Retention frees SQLite's pages for reuse, so the
database stops growing — but the file only shrinks when it is rewritten, and
this app deliberately never does that on its own: `VACUUM` blocks the single
writer for as long as it takes, on a process that is also carrying live budget
guards. Run it by hand when the figure on Settings → Storage warrants it, with a
fresh snapshot taken first:

```bash
docker compose exec usagefoundry node scripts/backup-db.mjs /backups
docker compose stop usagefoundry
VOL=$(docker volume ls -q | grep usagefoundry-data | head -1)
docker run --rm -v "$VOL":/data alpine \
  sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 /data/usagefoundry.db "VACUUM;"'
docker compose start usagefoundry
```

---

## Agents

An **agent** is a saved role a run takes: a name, a description, a prompt, and
optionally a model. Start a run as one and the saved prompt *is* the run's own
system prompt — same process, same working directory, same permission mode, same
limits, same cost, but doing the work as your reviewer or your tidier rather
than as Claude Code's ordinary self.

It reaches the CLI as two flags that travel together: `--agents` defines the
agent and `--agent` selects it. Both are needed, because a name is only
selectable once something has defined it — `--agent` resolves against Claude
Code's own built-ins, whatever is in your `~/.claude/agents/`, and whatever the
same command line defined. Send only the name and the run fails at the spawn.

The description is what *you* read on the picker when you choose. The prompt is
what makes the run different from the one that would have happened anyway.

**Starting a run as an agent changes who the run is. It never changes what the
run may do.** That is the line the whole feature is built on, and it is enforced
by absence: a saved agent has no tool list, no permission mode, no budget, no
folder and no isolation choice — there are no columns for them, so there is
nothing on the wire that could carry one. The permission mode, the isolation
grant of `git add`/`git commit`, the `pkill` deny list and the self-hosting
notice that explains it are all decided elsewhere and are untouched by the flag;
the unit tests assert each of them again with an agent selected. So everywhere
this app names an agent it is stated *beside* the guards and never among them.
Being the run rather than a helper inside it makes that a larger fact than it
was — it does not make it the kind of fact a guard row is.

The one thing an agent holds that a template deliberately does not is a
**model**, and it is the one field whose meaning changed when the flag did. It
used to be the model a delegated sub-turn ran on; selected, it is the session's.
What stops that being a second place to set the run's model is that an explicit
`--model` outranks it, so it fills a gap you left rather than overruling a choice
you made. It moves cost, not capability, and every cost guard already covers it.

### Defining one

**Agents** in the sidebar (⌘5). The table lists what is saved, *New agent* opens
a form with the four fields an agent has — name, description, prompt, model — and
picking a row edits it. Delete asks first, and says what it costs: the prompt
goes with it, a run already in flight keeps its own copy, and anything that
*names* the agent refuses to start rather than quietly starting without one.

There is nothing else on that form, and the absence is the design: no permission
mode, no budget, no folder, no isolation choice, no tool list. What the agent may
do comes from the guard set on the run it is started as, and a control here would
be a second place deciding it.

The same page lists what your own `~/.claude/agents/` holds, which is in play
whatever you save here and cannot be picked — see below. A saved name that a file
on disk also uses is marked *name clash* rather than refused.

The routes are still there, and are what the page uses:

```bash
curl -sX POST localhost:3000/api/agents \
  -H 'content-type: application/json' \
  -d '{
    "name": "reviewer",
    "description": "Reviews a diff for correctness bugs. Use before landing.",
    "prompt": "You review changes. Report what is wrong and nothing else.",
    "model": "claude-sonnet-5"
  }'
```

`GET` lists them, `PUT /api/agents/<id>` replaces one, `DELETE` removes one. With
`UF_AUTH_TOKEN` set, send it as a bearer token like any other route.

Three things are refused when you save, because Claude Code will not register
such an agent at all — which means `--agent` cannot select it, so a run started
as one dies at the spawn on every work cycle, with the reason nowhere but the
CLI's own stderr:

- **No description**, or **no prompt**. Either one and the member is not
  registered. Measured: `claude --agents '{"uf-nodesc":{"prompt":"p"}}' --agent
  uf-nodesc -p hi` answers `--agent 'uf-nodesc' not found` and exits 1, before
  any API call.
- **No name**, which registers as an empty entry rather than as an error. That
  one was measured while the flag was still `--agents` alone and has not been
  re-checked since; what it would select is the empty string.
- **A name Claude Code already answers to** — `claude`, `Explore`,
  `general-purpose`, `Plan`, `statusline-setup`. Such a member shows up **once**
  in the CLI's own list of available agents, not twice, so `--agent Explore`
  selects *an* Explore and nothing says whether it is yours or the built-in.
  That is the difference between a run being the agent you wrote and a run being
  something else entirely, under a name you chose.

A fourth is this tool's own decision rather than the CLI's: **a `tools` list**.
`--agents` members accept one and this refuses to store one, because what a run
may do comes from a guard set you wrote and not from a role you picked. The
singular flag makes that firmer, not looser: a tool list on a helper inside a run
would at least still sit under that run's own mode and lists, where a tool list
on the definition the run *is* would be a statement about the whole session —
inside a record a chat proposal or a workflow block can name. It is refused by
name rather than dropped, so nobody ends up believing their agent is narrowed
when it is not.

`model` is free-form — an alias (`sonnet`), a full id, or omitted to inherit
whatever the run has. Blank means inherit; it is never sent as a JSON `null`,
which is a fifth thing the CLI will not register, measured the same way as the
first two.

### Where one can be chosen

| Surface | What it names | When it is resolved |
|---|---|---|
| New-run form → *Agent* | what the run is started as | at *Start run* |
| Settings → *Default agent* | what the run form starts on | pre-filled, and you can change or clear it |
| A template | what the run form starts on when you load it | at load |
| Workflow block (a run block's run, or a deciding block's own turn) | what that block's child is started as | at each press of *Run* |
| A deciding block's emitted runs | one per run, by name, chosen by the block | as each run is created |
| A repeating block's passes | the block's own agent, on every pass | as each pass is created |
| Orchestrator chat | what the proposed run is started as | at *Approve* |

In the chat, type `@` in the composer to insert a name — Tab inserts, Enter still
sends. The mention is ordinary text; what makes it work is that the chat can read
the registry and proposes the run under the agent you named. The proposal card
says which agent the run will be started as, outside the guard line. The chat's
*own* turn is never started as one, and that is deliberate rather than an
omission: it is the one child here bounded by nothing but its own prompt, so
making some saved prompt its role is exactly the thing that prompt prevents.

A **merge block** is the one place naming an agent is refused rather than
ignored: it starts no child at all, so there is nothing for the agent to be.

**An agent that has been deleted, or that has decayed into something Claude Code
will not register, is refused by name at every one of those doors — never quietly
replaced with none.** You started the run that said "as the reviewer"; a run that
silently is not the reviewer is indistinguishable afterwards from a run that was
never given one, and that is the failure the whole registry exists to prevent.
The single exception is the Settings default: if the agent it names is deleted
later, the new-run form starts as no agent and *says so*, because the alternative
is a page nobody can start a run from until they visit Settings.

A run keeps a **copy** of the definition it was started with, so editing or
deleting the agent afterwards cannot reach a run already in flight, and picking
that run back up months later still starts it as what it was. That matters more
than it looks: a run spawns a child per work cycle, so an id here would leave the
cycle after a deletion selecting a name nothing defines. Everything that is form
input — a template, a workflow block, a chat proposal, the Settings default —
keeps a **reference**, so fixing your reviewer's prompt reaches the next run
started from it.

### The agents you already have

Your own `~/.claude/agents/` is mounted into the container, so anything defined
there already reaches every run, chat turn, deciding block and review this app
spawns — and always has, since before this feature existed. An isolated run's
checkout carries the repository's own `.claude/agents/` for the same reason.
Naming a saved agent **merges** with that set rather than replacing it, and
`--agent` resolves its name against the merged set — the CLI's own refusal line
lists the built-ins, whatever it found on disk and the agent this app defined,
all together. So starting a run *as* your reviewer withdraws nothing.

They are deliberately left in play. The only way to exclude them on this CLI is
`--setting-sources` with an empty value, and that flag governs settings *whole* —
it would take your `settings.json`, your hooks, your permissions and your
environment out of every run along with the agents, which is a much bigger change
than the one being made and one nothing would report. So instead the app
*declares* them: every picker says what else is in play beside it ("Your own
~/.claude also carries 5 agents (reviewer, tidier, docs and 2 more), in play
whatever you pick here"), and the chat's `list_agents` reports them as a group
that cannot be named.

One consequence worth knowing: if you save an agent under a name a file on disk
also uses, which definition Claude Code actually runs is **not established
here**. The app will not pick a winner; it marks the row *name clash* wherever
that name shows up in a cost table, because you are the only one who can resolve
it.

There is a second one, and this app does not yet say it anywhere: your
`settings.json` can name a session agent too. `claude --help` describes `--agent`
as overriding "the 'agent' setting", and on the pin that setting is real — an
`agent` key in `~/.claude/settings.json` starts the session as that agent, with
no flag involved. Because the same `~/.claude` is mounted, it reaches every child
this app spawns. Measured on 2.1.226, with a probe agent whose whole prompt was
"reply with exactly BANANA":

| | |
|---|---|
| `agent` key set, no flag | `BANANA` — the setting selects the session's agent |
| key absent | an ordinary greeting |
| key set, `--agent other` | the other one — the flag wins, as the help says |
| key set, `--agents` only | `BANANA` — the plural flag does **not** override it |
| key naming an agent that does not exist | an ordinary greeting, exit 0 — silently ignored, where the same name on `--agent` exits 1 before any API call |

What that means here: a run, block or chat turn this app starts **as** an agent
is unaffected, because it passes `--agent` and the flag wins. Anything this app
starts as *nobody* — an agentless run, every chat turn, a review — is started as
whatever that key names, and no page in this app knows. It is not declared, and
the reason is under [Not yet verified](docs/verification.md): saying it would be
a new read, a new field on `/api/agents`, a second argument threaded through the
one sentence four pickers share — and the sentence would be false on the picker
that carries it, since choosing an agent there is exactly what overrides the key.
If you use it, know that clearing an agent picker in this app does not mean the
run has none.

### What it costs, and where that shows up

Being an agent costs a run nothing extra and buys it nothing extra. The run's
own spend limit, cycle cap, window guards and workflow budget are the same
numbers they would have been; there is no separate ceiling for an agent and no
way for one to extend a run. The only thing it can move is the model, and only
where you left the run's own blank.

The three places below are about turns a run **delegates** — which is a
different thing from the agent the run *is*, and still happens: your
`~/.claude/agents/` reaches every run whatever you started it as. None of this
machinery reads which agent the session is.

**The run log.** A sub-agent's output is forwarded into the run's stream and set
apart — indented behind a rule, under the sub-agent's name — so it can be read
as somebody else answering a question the main thread asked. Without it a
delegation is a `Task` call followed by silence for as long as the sub-agent
takes. A sub-agent's words are never the run's own report and can never end the
run: the `DONE` test runs against the main thread only. Turn it off in
Settings → *Sub-agent output in the run log* if you would rather have the shorter
log.

**The run page's *Agent work* card.** What this run's turns cost, split by who
produced them, priced from your own transcripts for that run's session — so every
turn lands in a row and the rows add up. It is a *third* reading beside what the
CLI reported and what telemetry reported, never added to either: all three
measure the same work by different routes, so summing any pair double-counts it.
A run with no session yet reads as the hatched indeterminate meter, not as 0%.
Whether a run started as an agent files its own turns under that agent's name or
under *(main thread)* is Claude Code's bookkeeping and has not been checked; this
app never guesses a name, so the card will say whichever the transcript says.

**The dashboard's by-agent breakdown**, which says where each name's definition
lives: *saved* for one in this registry, *on disk* for one only your `~/.claude`
has, *name clash* for both. Unmarked is the ordinary case — a Claude Code
built-in, a repository's own `.claude/agents`, or an agent since deleted — and
the card says so in a footnote. The bucket a turn lands in is whatever Claude
Code recorded on it; the mark is a fact about your registry, so renaming a saved
agent moves no money between rows.

### What has been measured

Seven probes against the pinned CLI (`@anthropic-ai/claude-code@2.1.226`), run
by hand, each one deciding a design question that would otherwise have been a
guess. The first four refuse before any API call, which is how the built-in list
was derived in the first place.

**That `--agent` can select a definition supplied on the same command line.** The
whole shape of this feature turned on it: if it could not, wiring it would have
meant writing agent files into your mounted `~/.claude` or into a checkout.

```bash
claude --agents '{"uf-probe-agent":{"description":"…","prompt":"…"}}' \
       --agent uf-probe-typo -p hi
# --agent 'uf-probe-typo' not found. Available agents: claude, Explore,
# general-purpose, Plan, statusline-setup, typescript, uf-probe-agent
```

That line also settles the ambient question from the other side: `typescript` is
not a built-in, it is a definition on that machine's disk, so the set `--agent`
resolves against is the built-ins *and* what is on disk *and* what this argv
defined, merged.

**That an unregistrable member fails the spawn rather than being dropped.** Same
command with a member missing its `description`, named on `--agent`, answered
`--agent 'uf-nodesc' not found` and **exited 1** — identically for a missing
`prompt` and for a `model` of JSON `null`. This is the one place the move to the
singular flag made the failure *better*: each of those used to cost a run the
agent it was given at exit 0, with nothing anywhere saying so.

**That a member named after a built-in still shows once, not twice.**
`--agents '{"Explore":{…}}'` listed one `Explore`, so `--agent Explore` would
select *an* Explore with nothing saying which. Refused at the door for that.

**That `--append-system-prompt` still reaches a `--agent` session.** An agent
whose prompt told it to answer with a secret word stated only in the appended
text answered `BANANA ZEBRA`. That flag carries the self-hosting notice — the
`pkill` deny list's explanation *and the safe recipe that replaces it* — so had
the agent's own prompt swallowed it, a run started as an agent would have been a
run never told why a name-matched kill is denied or what to do instead.

**That `--agent` survives `--resume`.** The same probe resumed answered
`BANANA ZEBRA` again with a success subtype. An agent that reached only the first
cycle would be a run that silently stopped being what it was started as.

**That the run's own `--model` outranks the agent's**, read off the `system`/`init`
event before any request: the definition alone reported `claude-opus-5[1m]`,
`--agent uf-m` reported `claude-sonnet-5`, and `--model opus … --agent uf-m`
reported `claude-opus-5`. This is what keeps an agent's model from being a second
place to set the run's.

**That a name with a space in it registers and resolves** —
`--agents '{"uf spaced":{…}}' --agent "uf spaced"` — which is only true because
nothing here goes through a shell.

### What has not been checked

**No `claude` child has ever been spawned with either flag from this app**, and
no browser has rendered the Agents page, the run form's *Agent* row, the Settings
default, the canvas inspector, the chat's `@` popover, the *Agent work* card or
the dashboard's marks. The probes above were run by hand, outside this app.

- **The two remaining drops**, both measured under `--agents` alone and not
  re-checked since the singular flag: an empty name registering as an empty
  entry, and a `--agents` value that is not JSON being ignored outright. If
  either is wrong the refusal is stricter than it needs to be, which is the safe
  direction and still a form saying no for a reason that has stopped being true.
- **Whether a `--agent` session records its own name on the turns it produces.**
  The *Agent work* card and the dashboard's by-agent column both read whatever
  Claude Code wrote to the transcript, and nothing here infers a bucket — so this
  changes what those cards say and no code branches on it.
- **Whether a `--agent` session delegates at all.** If it does, the forwarding
  and the by-agent split cover it exactly as before; if it does not, that
  machinery goes quiet rather than wrong.
- **That a delegated turn is bound by the run's own guards.** Reasoned from the
  delegation happening inside the same process, not measured. The deny list is
  the one to check first: deny is verified to beat `--permission-mode` for the
  main thread and has never been watched applying to a sub-agent's turn — which
  is also why a `tools` list is refused rather than stored and narrowed.
- **A forwarded sub-agent line off a real stream.** No `parent_tool_use_id` has
  been parsed from a live CLI. Two things to watch on the first real delegation:
  that the forwarded text is set apart under the sub-agent's name rather than
  folded into the run's own report, and that a sub-agent writing `DONE` on a line
  of its own does not end the run.
- **The Agents page in a browser.** The routes are unit tested against a
  throwaway database — a create, an edit, a delete and every refusal, including
  the duplicate name — and `curl` has driven a create, a list, the `tools`
  refusal and the duplicate-name refusal against a `next dev` server, which
  answered with the sentences the form is built to show. What has *not* happened
  is a browser: nothing has rendered the form, typed into it, saved from it, or
  seen the name-clash annotation or the delete sheet. The page's own server
  render was checked for a 200 and for the sidebar row carrying ⌘5, which is not
  the same thing.

The [verification log](docs/verification.md) carries the same split.

---

## Sizing the container

Every unit of work here is a `claude` child process — a full Node process — and
a work cycle's agent starts builds, test suites and dev servers of its own
inside the same container. Two settings bound how many exist at once, and
`docker-compose.yml` bounds what they may take:

| | Default | Covers |
|---|---|---|
| **Settings → Runs at the same time** | 4 | Work cycles. Over the limit a run waits in the queue; queued and parked runs cost nothing and do not count |
| **Settings → Other Claude processes at the same time** | 2 | A review, a merge-conflict resolution, a chat turn, a workflow orchestrator block's deciding turn. The first three are refused while it is full and say so; a workflow block waits for a slot |
| `UF_MEM_LIMIT` in `.env` | `10g` | The container's memory ceiling. compose pins `memswap_limit` to the same figure, which is how Docker spells *no swap* — unset it defaults to twice, and the stated ceiling would quietly have that much swap behind it |
| `UF_NODE_HEAP_MB` in `.env` | `2048` | The **server's** own heap. Stated rather than inherited: left to V8 it is derived from the *host's* RAM, so the one term of the arithmetic below that belongs to this process would change with the machine. It does not scale with the fleet |
| `UF_PIDS_LIMIT` in `.env` | `2048` | The container's task ceiling — threads, not just processes |
| `UF_CPUS` in `.env` | unset | No quota. Docker refuses a value larger than the host has, so no positive number is safe to ship; set it to `nproc` minus one or two if you want the machine to stay responsive while several agents compile |

The two settings are the ceiling on Claude processes; the limits are what
happens if that ceiling is set higher than the machine can carry. Docker
OOM-kills the container, `restart: unless-stopped` brings it back, and the runs
it was carrying are closed out with a reason on each — which is a bad hour
rather than a host to go and rescue. Without them the kernel's OOM killer
chooses its victim from *every* process on the machine, which may be an
unrelated database, or the server that is supposed to be guarding the runs.

**Raising the fleet means raising the first four together** — the server's heap
does not scale with it, and `UF_CPUS` is about the host staying responsive. The
arithmetic, per container:

```
memory ≈ 2.5 GiB  (the server: a 2 GiB heap ceiling plus what lives outside it)
       + 1.5 GiB × runs at the same time
       + 0.5 GiB × other Claude processes
pids   ≈ 256 × (runs + other Claude processes + 1)
```

So 25 simultaneous runs with 5 other Claude processes wants roughly
`UF_MEM_LIMIT=44g` and `UF_PIDS_LIMIT=8192`, on a host with that much to give.
If the machine cannot spare it the answer is fewer runs rather than a bigger
number: a limit above what the host can supply is not a limit. The per-child
figures are estimates rather than measurements — `claude --help` on the pinned
CLI peaks at 309 MB before it has held a conversation or made a request, and a
real cycle also holds the context window, the transcript it is writing and every
tool result, so watch `docker stats` against your own repositories and adjust.
A work cycle's real footprint is mostly whatever *your* build does.

That the limits are actually applied, rather than merely present in the YAML:

```bash
docker exec usagefoundry cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max
docker stats --no-stream usagefoundry
```

`memory.max` reading `max` means no limit is in force.

Two notes:

- An install that saved its settings before this version keeps the value it
  stored, which for **Runs at the same time** was *No limit*. Open Settings and
  check it; the new default only reaches an install that never saved.
- Leaving either setting blank still means *no limit*. That is a deliberate
  opt-out, not the state to leave a fresh install in.

---

## Documentation

| | |
|---|---|
| **[Installation and setup](docs/install.md)** | Docker, signing in, environment, multiple workspaces, GitHub access |
| **[Backup and restore](docs/backup-and-restore.md)** | The one file that has no second copy, how to snapshot it safely, and how to put it back |
| **[Limits and accuracy](docs/limits-and-accuracy.md)** | What the two views measure, what they cannot see, and how exact each figure is |
| **[Runs](docs/runs.md)** | The run loop, budget policy, pausing and resuming, two runs on one project |
| **[Workflows](docs/workflows.md)** | Graphs of blocks, orchestrator, repeating and merge blocks, whole-graph budgets, schedules |
| **[The orchestrator chat](docs/orchestrator-chat.md)** | A conversation that proposes work; nothing starts without approval |
| **[Reviewing and landing](docs/review-and-land.md)** | Diffs, AI review, conflict resolution, the merge queue |
| **[Architecture](docs/architecture.md)** | Module map and how transcripts are parsed |
| **[Security](docs/security.md)** | Which uid runs the server and which runs the agents, what the container holds, and what an agent can still reach |
| **[Verification log](docs/verification.md)** | What has been checked by hand — **and what has not** |

That last one is not boilerplate. It carries an explicit *"Not yet verified"*
list, which is the honest boundary of what this has been exercised against.
Read it before running anything unattended.

The newest thing on that boundary is **Needs review**, a fourth way a run can
end. A run that meets a wall it cannot pass — a credential that is not there, a
permission it does not have, a decision that is not its to make — says so and
stops, instead of spending the rest of its cycle cap restating the problem or
finishing green beside runs that did the job. [docs/runs.md](docs/runs.md) has
the whole of it. What is unverified is the part that decides it: the ending
turns entirely on the agent replying `NEEDS_REVIEW` on a line of its own, and
**no `claude` child has ever produced that token for this app.** The matcher,
the precedence between it and the other endings, and the workflow-loop stop are
unit tested; what the wording actually produces in a real agent is reasoned
from how `DONE` behaved over 251 runs, and reasoned is not measured. It can be
wrong in two directions: an agent that withholds it spends its whole cycle cap
against the wall exactly as before, and one that reaches for it cheaply turns
your completions into a queue of questions. The reason the agent gives is the
evidence either way. Nothing on that path has been seen in a browser either.

The **repeating block** is on the same boundary and has also never been run
against a real CLI. Its pass decision and the scheduling around it are unit
tested, and the wiring was driven once by hand against a real database and
a real git workspace — in a throwaway script, under a concurrency cap that held
every pass `queued`. No page has rendered a repeating block, no browser has
saved one, and no `claude` child has ever worked a pass. What to watch on the
first real one is what ends it. A block stops repeating when the agent replied
`DONE`, when a pass ended as anything other than `completed` (**Needs review**
among them, which stops the loop rather than waiting for it), when a pass
started no run at all, or when it runs out of passes. And a run that merely used up its
work-cycle limit is written `completed` as well — so a block that quietly gave
up after one pass and a block that finished the job look the same until you read
what the agent said.

---

## How it fits together

```
Claude Code transcripts ──► parse + dedupe ──► cost & token rollups ──┐
                                                                      ├──► Dashboard
Anthropic /api/oauth/usage ──► first-party utilisation % ─────────────┘
                                          │
                                          ▼
                                   budget guard ──► run loop ──► claude -p
                                                        │         (own worktree,
                                                        │          own branch)
                                                        ▼
                                              review · resolve · merge
```

Three cost sources, **never summed**: transcript-derived costs (the dashboard),
the Admin API (a separate Console-account page), and Claude Code's own OTLP
export (per-request cost for runs this app spawned). Each is shown as itself.

---

## One process, one data directory

**This runs as exactly one process. It cannot be scaled horizontally**, and a
second replica behind a load balancer is not a supported deployment.

The reason is the folder claim — the check that keeps two agents out of one
directory. It is a synchronous check-then-insert, and it is atomic because one
Node event loop runs it to completion, not because SQLite enforces it. Two
processes have two event loops: each decides a folder is free, each inserts, and
two billed agents start work in the same checkout. Nothing reports it.

So exactly one process may write. The first to boot claims `DATA_DIR/server.lock`
and heartbeats it; any other process sharing that directory is **read-only** —
it serves every page and refuses every write, naming the owner's pid. You can
see which one you are looking at:

```bash
curl -s localhost:3000/api/health    # 200 + "ownership": "owned", or 503 with "error" and the owner's pid
```

A read-only second server is deliberately still allowed to boot, because it is
useful: pointing a development build at the live database to check a change is
the workflow that found this bug. What it must never do is close out the other
server's runs, and now it cannot.

**When one container is not enough**, the answer is a second *independent*
instance, not a second replica — its own data directory, its own workspaces:

```bash
UF_PORT=3100 UF_CONTAINER_NAME=usagefoundry-b UF_IMAGE_TAG=b \
  docker compose -p usagefoundry-b up -d --build
```

`docker compose -p` namespaces the data volume, so the two share no database and
no folder claim. Point them at different workspaces — two instances against one
directory tree is the collision above with extra steps.

---

## Requirements

- Docker and Docker Compose
- A Claude Code subscription (Pro or Max) — the dashboard is about *subscription*
  windows
- Optionally an `sk-ant-admin01-…` Admin key for the separate Console-account page
- Optionally a GitHub token, if you want runs to open pull requests

---

## Continuous integration

Two workflows, both under [`.github/workflows/`](.github/workflows).

**[`ci.yml`](.github/workflows/ci.yml)** runs on every push and every pull
request, on **linux/amd64 and linux/arm64 in parallel**, and fails on a
non-zero exit from any of `NODE_ENV=development npm ci --include=dev`,
`npm run typecheck`, `npm test` and `npm run build`. Both architectures rather
than one, because the project nominates no deployment platform: the
`Dockerfile` branches on `dpkg --print-architecture` and `better-sqlite3`
either finds a prebuild or compiles from source, so which of the two you are on
is a real difference and it is the operator's host that decides it. A separate
job runs `npm audit`, prints every advisory unconditionally, and gates on
`critical` — the three current high-severity advisories are inside `next`'s own
subtree, are fixed only by a `next@16` major, and the reasoning for accepting
them is written out in full beside the step rather than left implied.

**[`docker.yml`](.github/workflows/docker.yml)** runs `docker compose build` on
both architectures, weekly and on any change to `Dockerfile`,
`docker-compose.yml`, `.dockerignore`, `package.json` or `package-lock.json` —
not on every push, because `ci.yml`'s `npm run build` is the same command the
builder stage runs, so a source change that would break the image already fails
there. What this covers is what that command cannot see: the apt layers, the
`gh` release fetch and its checksum, the pinned Claude CLI, and the build
context.

### What it does not cover

CI **never starts the container and never exercises a run.** It does not sign
in, does not touch a transcript, does not spawn `claude`, and does not merge
anything. Nothing here can tell you that a guard fires, that a window boundary
lands where it should, or that an isolated run commits to its own branch — the
[verification log](docs/verification.md), and in particular its *"Not yet
verified"* list, stays the record for everything a human checked by hand. A
green tick means the tree typechecks, the unit tests pass and both artefacts
build. It means nothing beyond that.

There is no lint step, because there is no linter: `eslint.ignoreDuringBuilds`
is on and no config exists to run.

> **A build failure that is not a build failure.** If `npm run build` fails for
> you with `[TypeError: generate is not a function]` while CI is green, the
> shell is the difference and not the tree. `.next/standalone/server.js` line 14
> does `process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)`,
> so every child process of a *running* standalone server inherits it —
> including an agent this app spawns, which is where five separate audits hit
> this and concluded the build was broken. Next's `loadConfig` then early-returns
> `JSON.parse` of that string instead of merging defaults; JSON cannot carry a
> function, `generateBuildId` is the only function-valued default, and
> `getBuildId` calls it unconditionally.
> `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` is the check, and it
> exits 0 on this tree.

---

## Contributing

Issues and discussion are welcome. Before opening a PR, read
[`CLAUDE.md`](CLAUDE.md) — it records *why* the load-bearing decisions were made,
and most of them encode a failure that was measured rather than a preference.

CI runs the same four commands you should run locally, and nothing more — see
[Continuous integration](#continuous-integration) above for what that leaves to
a human.

---

## License

Source-available, not open source — see [LICENSE](LICENSE).

You may use, self-host, modify and study it for your own personal,
non-commercial purposes. **Distributing it, and using it commercially or inside
an organisation, both need written permission** — ask, and it may well be given.

Releases before this change were MIT, and this does not withdraw rights anyone
already has in a copy they received under those terms.
