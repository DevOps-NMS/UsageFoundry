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
| Official API | `/api/oauth/usage` — **percentages only**, no numeric quota value | `/v1/organizations/rate_limits`, `/usage_report/messages`, `/cost_report` |
| How this tool reads it | percentages from that endpoint; volumes and costs by parsing `~/.claude/projects/**/*.jsonl` locally | Admin API, with an `sk-ant-admin01-…` key |
| Accuracy | **volumes and costs are exact; percentages are the provider's own, or estimates when it cannot be reached** | authoritative |

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

**The reset time is derived, and can disagree with `/usage` by minutes.**
Anthropic sends the exact reset instant back on every API response, and Claude
Code reads it from there — but it lands on no transcript record, in no config
file, and in none of the telemetry the CLI exports, so there is nothing local to
copy it from. What this app does instead is apply the published rule: the window
opens with your first turn and runs five hours. Two things move that away from
the figure `/usage` shows, in opposite directions. It reads **late** by the
length of the turn that opened the window, because the transcript records the
response rather than the request — seconds, usually. And it reads **early**
whenever the window was really opened by a surface from the table above, which
this app cannot see at all. If the two are far apart, Settings → *5-hour window
reset (override)* pins the boundary to what `/usage` says.

> This used to round a window's start down to the top of the hour, which put the
> reset time up to 59 minutes early *and* rolled the window over that much too
> soon — showing an empty session, and re-arming the budget guard, while
> Anthropic was still counting the old one. If you recognise that, it is fixed;
> nothing needs re-configuring.

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

### Where percentages come from

Token counts and dollar costs come straight from your transcripts and are exact.
A *percentage* needs a denominator, and Anthropic still publishes no numeric
value for a Max quota in any unit — but it will tell you the percentage itself.

`GET /api/oauth/usage`, authenticated with the OAuth token Claude Code already
keeps in `.credentials.json`, returns what `claude /usage` and claude.ai show:
utilisation and a reset instant for the 5-hour window, the week, and any weekly
wall scoped to one model family. That is a **first-party figure for the whole
account**, so unlike anything derived here it also counts the surfaces that
share your allowance and write nothing to this disk — the web app, Desktop,
Cowork. It leads every meter, and its reset instants anchor both windows.

This was not a refinement. Measured on one machine: the provider reported 5.0%
of the 5-hour window while the dashboard, dividing local spend by a hand-typed
$650 ceiling, showed 1.3%. The arithmetic behind that $8.49 was fine —
cross-checking 4,995 turns against Claude Code's own per-request OTLP cost put
`pricing.ts` within **0.8%** in aggregate — and the derived window boundary was
53 seconds off the provider's. The denominator was simply a guess, and no
adjustment to a token weight can repair a guessed denominator.

Three things to know about that source:

- **It is percentages, not numbers.** There is still no ceiling to read, and
  nothing here ever populates one by itself. **Settings → Calibrate** can now
  *divide* by it — a window that cost $71 and took 15% of the allowance implies
  a ~$474 ceiling — which is a measurement rather than the observed-peak lower
  bound below it. It errs the same way and for a new reason: the cost is Claude
  Code's and the percentage is every surface's, so a window that also held web
  or Desktop work divides part of the spend by all of the usage.
- **It can be unreachable** — an expired login, an offline container, or its own
  rate limiter (a handful of requests inside a minute earns a `429`). It is
  therefore cached on Claude Code's own cadence, a failure re-serves the last
  good reading rather than blanking a meter, and past an hour it falls back to
  the derived reading instead of passing off a stale percentage as current.
- **It is undocumented**, so every failure is a miss and never an error.

Turn it off with **Settings → "Read plan usage from Anthropic"**, and everything
below is what you get back — which is also what you get for a window the
provider did not answer for:

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

Percentages for a *calendar* day, week or month are a separate question with a
separate answer — see [Usage by period](#accuracy-notes) under *Accuracy notes*.

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

### Giving a run access to GitHub

The same gap applies to git hosting, and it bites later in a run rather than at
the start of one. `~/.claude` carries your Claude login; it does not carry
`~/.gitconfig`, `~/.ssh` or `~/.config/gh`. So an agent that tries to push a
branch, open a pull request or read an issue gets an authentication failure
*inside a tool call* — which nothing in the run loop reads. From the outside the
cycle simply ends without the PR you asked for.

Set one token in `.env`:

```bash
UF_GITHUB_TOKEN=github_pat_…
```

Scope it to the repositories you run agents against — Contents: read and write,
plus Pull requests and Issues if the agent should open them (a classic token
needs `repo`). An unattended agent can use everything the token can.

With it set, each work cycle is spawned with `GH_TOKEN`/`GITHUB_TOKEN` for the
`gh` CLI, a git credential helper for `github.com`, and a rewrite of
`git@github.com:` remotes to HTTPS — the container holds no SSH key, so a
repository cloned over SSH could otherwise never authenticate while one cloned
over HTTPS could, which is what makes this fail on some runs and not others.
Those variables reach the agent and nothing else: not the reviewer, and not the
git this app itself runs, whose children execute repository-controlled hooks.
Settings shows whether a token is configured.

### Required environment

| Variable | Purpose |
|---|---|
| `UF_WORKSPACE` | Host directory mounted at `/workspace`. Runs are confined to it. Absolute path; compose refuses to start without it. |
| `UF_AUTH_TOKEN` | Shared secret for the UI. Blank disables auth — only acceptable on loopback. |
| `ANTHROPIC_ADMIN_KEY` | Optional. Enables the API-account page. Org Admin key only. |
| `UF_GITHUB_TOKEN` | Optional. What a run pushes, opens PRs and reads issues with. Reaches the agent only. |
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

**The database volume is handled in the image, not here.** `/data` is a named
volume rather than a bind mount, so it does not carry your host's ownership the
way the other two mounts do: Docker copies the ownership and mode of `/data`
*in the image* onto the volume root the first time it creates it. That used to
be uid 1000, mode 0755 — unwritable by the uid you have just set, which meant
the app could not create its SQLite file and every data route failed. The image
now marks that one directory world-writable, so a fresh volume works under any
`UF_UID`. Nothing to configure.

**Changing `UF_UID` on an install that already has data** is the one case that
still needs a hand. Docker only initialises a volume once, so an existing
`usagefoundry-data` keeps the files uid 1000 wrote, and the new uid cannot write
them. Hand the volume over once:

```bash
docker compose down
docker compose run --rm --user 0:0 --entrypoint sh usagefoundry \
  -c "chown -R $(id -u):$(id -g) /data"
docker compose up -d
```

Double quotes, so `$(id -u)` is expanded by your shell rather than inside the
container. If you do not mind losing run history and settings, `docker compose
down -v` and starting again does the same thing by destroying the volume.

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

A dropped connection is a third thing again, and it is handled in every mode.
`API Error: Connection closed mid-response`, an overloaded upstream, a burst of
429s — none of these say anything about your allowance or about the task, and
all of them clear in seconds.

Often Claude Code has already dealt with it before UsageFoundry sees it: when a
stream drops part-way, the CLI finalises what it had and carries the work cycle
on, leaving the error behind as a note. A cycle that ends that way — its own
`result`, a clean exit — is a cycle that **worked**, and the run simply carries
on with a line in its log saying what happened. (Runs used to die there, on the
note rather than on the fault.)

When the cycle really was cut short, the run waits 5, then 20, then 60 seconds
and spawns again into the same conversation, rather than ending. It
never parks for one (there is no window to wait out, and parking would hand its
folder to whatever is queued behind it), and it never retries more than three
times **in a row** — a cycle that gets through resets the count, so a long run
that meets a blip an hour is unaffected, while an upstream that is genuinely
down ends the run inside a minute and a half and says how many attempts it made.
Each attempt is one line in the run log. A bad key, a malformed request or an
exhausted credit balance is not in this category and still fails immediately:
retrying those buys three more copies of the same answer.

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
because UsageFoundry restarted under it, because you stopped it, because it hit
one of its own limits, or because the agent reported the task done — has a
button on its page: **Resume**, or **Ask for more** when it completed. It keeps
its folder, its isolated checkout and branch, its spend so far, and its Claude
Code session, so it continues the conversation rather than starting a new one.
The session is recorded as soon as Claude Code names it, not when the work cycle
finishes, so a run that crashed — or that UsageFoundry restarted underneath —
still has one to continue.

A run that genuinely never got that far starts again from the original task
instead, and says so on its page. When it had already worked, the agent is told:
the prompt opens by naming how many cycles the previous attempt ran and where its
output is — the run's own branch when it is isolated, the folder otherwise — and
tells it to read that before doing anything. There is no conversation left to
carry any of it, and an agent handed a bare task does the first thing the task
says, which is the work it is standing on.

If the session exists but Claude Code will not resume it — a transcript truncated
by a mid-turn kill is the known way that happens — the run tries once more and
then stops, saying so and naming the `claude --resume <id>` command to pick it up
by hand. It does not quietly start a fresh session: that would lose the
conversation the resume existed to keep, and it is what "picking a run back up"
means here.

The form takes a message as well as the limits. Whatever you write is sent
verbatim as the next turn of the same conversation — that is how you keep
talking to a run after it has finished, when looking at what it built shows up
the next thing to ask for. Leave it blank and a run that was cut off mid-task is
simply told to continue.

A run that reported `DONE` is the one case where blank is not "continue": the
continuation prompt asks for `DONE` when the work is complete, so replying to a
`DONE` with it buys an immediate second `DONE` and a billed cycle that did
nothing. Blank there sends the same pushback prompt as *When Claude says the
task is done* above — re-read the task, run the tests, fix what fails — which
you can edit in Settings.

That is what the agent said, not how the run ended. A run that stopped because
it used up its work cycles is *finished* in the same green sense and said
nothing of the kind, so blank tells it to continue like any other run cut off
mid-task — the pushback would open by telling it that it had reported the task
complete, and then forbid it from starting the work it was reopened to do.

Resuming asks for the limits again, pre-filled from the run, because the usual
reason a run needs picking up is that its own limits ended it. They are totals,
not top-ups: a run that used 1 of 1 cycles needs the cycle limit raised above 1,
and the button refuses and says so rather than queueing a run that would stop
again on its first check. The time limit is the exception — it runs from the
moment it starts again, since counting the hours it spent dead would refuse
every run older than its own limit. Everything else carries over untouched.

### Running the same task again

Two ways, and the cheap one is worth knowing first.

**Start another like this** — a link in the header of any run page. It opens the
new-run form pre-filled from that run: the same task, the same workspace and
folder, the same isolation, the same limits, the same permission mode. Nothing
happens until you press *Start run*, and nothing about the original run changes.
This is not a resume — it is a new run that happens to be configured identically,
which is what you want when last week's task comes round again but you would
rather not touch the run that already finished.

**Templates** — a named, saved version of the same thing. The *Templates* card at
the top of the new-run form loads one into the form, or saves whatever the form
is currently holding under a name. Loading a template fills in every field and
starts nothing; you can edit anything before you run it, and editing the form
does not write back to the template.

What a template holds is the task, the limits, how it behaves, and — optionally —
the folder. *Remember the workspace and folder* is a switch on the save row,
because both answers are right for different tasks: "update the changelog for
this project" wants a folder recorded, "run the test suite and fix what fails"
wants to be asked. A template with no folder leaves the picker alone rather than
guessing.

Three things it does **not** do, each on purpose:

- **It does not carry the model.** That is a single global setting
  (Settings → *Model*), and a second place to set it is how the two drift.
- **It does not apply a live-enforcement mode quietly.** There is deliberately no
  global "default enforcement", because one edit that turns *every* run into a
  cycle-killing run is a mistake with no undo. A template is a second way to
  inherit that choice, so a template carrying *Stop the cycle in flight* (or
  *…carry on next window*) says so in a banner above the form, with a button that
  puts it back to the mode that loses no work. Same for `bypassPermissions`,
  which gets the danger banner it gets everywhere else.
- **It does not let you save something that cannot run.** A template with no
  cycle limit and no time limit is refused when you save it, with the same
  message `POST /api/runs` would give — the point of validating twice is that the
  error arrives while you are still looking at the form that caused it, rather
  than the week you finally use the template.

A template is form input and nothing more. It holds no folder, blocks no run,
occupies no concurrency slot, and deleting one cannot affect anything that has
already started — a run copies every value it needs the moment it is created.

---

## Two runs, one project

Several runs can be in flight at once. What happens when two of them want the
same folder depends on whether that folder is a git repository.

**A git repository — they run in parallel.** Each run gets its own `git worktree`
on its own branch, under `.uf-worktrees/` beside the repository, and works there.
Your own checkout is never touched while the run works: your uncommitted changes
stay yours, and you stay on your branch. When it finishes, the run page shows
what it changed and can bring the branch home — see [Reviewing and landing what a
run did](#reviewing-and-landing-what-a-run-did).

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

## Workflows

A **workflow** is a saved graph of run blocks. Pressing *Run* on one creates
every block as a run, in one pass, with the dependencies between them already
wired: the first ones queue immediately, the rest sit `waiting` until the blocks
they follow have settled. It is the answer to "the same four steps, in the same
order, every time" — the thing templates cannot do, because a template is one
run and this is the shape of several.

### What a block holds, and what it does not

A block holds the **work**: a name, a workspace and folder, a task, and
optionally a prompt that replaces its template's own for this block. That is the
whole list, and the omission is the point.

A block does **not** hold a budget, a permission mode, an isolation choice or a
model. It **names a template**, and every guard comes from that template; a block
naming no template runs under the untemplated guard set in Settings → *Chat
defaults*, exactly as an untemplated chat proposal does. This is the same rule
the orchestrator chat follows and it is worth stating in full, because it is the
reason a workflow can be edited freely without anyone re-reading it for safety:

> The graph picks **what work to do**. Something a person wrote picks **what an
> agent may do**.

`--permission-mode` already has three narrowings and exactly two routes to it —
the run form and a saved template — and a workflow node was not going to become
a third. So a block that names a template which has since been deleted is
**refused by name** when you press Run, rather than quietly falling back to the
Settings guards: you saved a graph that said "under these guards", and a run
started under different ones is what the refusal exists to prevent. The detail
page marks such a block in red before you press anything.

### Links between blocks

A link says "start this block after that one", and carries two things:

| | |
|---|---|
| **Condition** | *Only if it completes* (`on-success`) or *once it finishes, either way* (`on-finish`). Never defaulted: `on-success` would end a chain the operator meant to run regardless, `on-finish` would start a run on top of a dependency that crashed, and both mistakes are silent. |
| **Carry on its branch** | The successor extends the predecessor's branch instead of cutting a new one from the target. At most one link into a block may set it, and at most one block may take over any given branch. |

A block with no incoming link starts as soon as its folder is free. **Several
such blocks is the parallel case** — there is no separate "parallel" concept to
configure, and none in the interface. A block with two incoming links is a
fan-in; it starts when both have settled.

The editor is a list, and a block may only wait for blocks **above** it. That is
not a restriction on the graph — every acyclic graph can be written that way —
it is what makes a loop unwritable rather than something to be refused after the
fact. Reordering a block above one it waits for drops that link, visibly.

### What is refused, and when

A workflow that can be saved but never started fails weeks away from the form
that caused it, so both moments check the same things: a name, at least one
block, a task on every block, a template that exists, a workspace that is
mounted and a folder that resolves inside it, a condition on every link, no
block waiting for itself, no loop, and no branch hand-over between blocks whose
guards do not isolate. Every refusal names the block it is about.

### Pressing Run

One press creates every run in a single synchronous pass, in topological order,
so each block's dependencies already exist as rows by the time it is admitted.
That pass has no `await` in it, and that is a correctness requirement rather
than a style: the folder claim that keeps two agents out of one directory is
only atomic within one event-loop turn.

It is **all or nothing**. Everything checkable is checked before anything is
created, so a failure part-way through should be unreachable; if one happens
anyway, the runs already created are stopped and the instance is recorded as
`not started` with the reason. Half a graph is not a smaller workflow — its
successors were never created, so what would be left running is a prefix nobody
asked for.

Starting a workflow whose previous press still has unfinished runs is
**refused**, with a count and a sentence. The second instance would point the
same blocks at the same folders, and a block set to carry on a branch would be
refused mid-pass because the first instance's run already continues it.

### Watching one

Every press of Run gets its own page, listing each block with its run's live
status, what it waited for, its cycles and its spend, and a link through to the
run itself. The runs also appear on the *Runs* page like any others — a chain
reads there as `blocked`-then-`queued` as it advances, since a `waiting` run
holds no folder, no checkout and no place in the queue until the runs ahead of
it settle.

The instance keeps its own copy of the graph and of the workflow's name, so
editing or renaming the workflow afterwards cannot rewrite what it says
happened. Deleting a workflow takes those records with it and **no run**: the
runs carry their own prompt, guards and history. It is refused while runs it
started are still going, because those records are the only thing saying where
those runs came from.

### Stopping one

*Stop all* on an instance page halts the whole press of Run, whatever state each
block happens to be in. There is one of it, and only the recorded reason differs
between an operator pressing it and an instance budget guard tripping — a second
implementation of "which blocks does this take down" is a second chance to miss
one, and a missed block goes on spending under a workflow the page says is
stopped.

What each kind of block becomes:

| Block was | Becomes | How |
|---|---|---|
| working now | `stopped` | The same kill ladder the *Stop* button on a run uses — `SIGINT` first, so a cycle that can still report its own cost does |
| queued or parked | `stopped` | Closed out before it can spawn |
| still `waiting` | `blocked` | Nothing ran and nothing was spent, which is what that status says. Everything behind it gets its own reason naming the block in front of it |
| already finished | untouched | Rewriting a completed block as stopped would destroy the record of work that landed |

**The door is closed before anything is signalled.** The instance is marked
*stopping* first, in the same event-loop turn that then walks the blocks, so
nothing can join it behind the stop — and the blocks still `waiting` are closed
out *before* the working ones are signalled, because stopping a run releases
whatever was waiting on it and a block released a moment too early would start
*because* the workflow was stopped. Pressing Stop twice does nothing the second
time.

**What survives it.** Anything an agent committed is on its branch, untouched.
Anything it had not committed is still in its checkout, on that run's own branch,
and the run page's *Commit* is how it gets onto the branch — the halt never
commits, never removes a checkout and never touches a branch. Spend is accounted
for the same way a single *Stop* accounts for it: a cycle killed before Claude
Code reports its cost is estimated from the transcript into `spent_usd_est` and
never into `spent_usd`. A merge already in flight is left to finish; queued
merges for those branches are cancelled.

The instance records that it was stopped, by what, and when. A block's own
reason says which of the three it was — halted with its workflow, halted by that
workflow's budget guard, or stopped on its own run page — because ten rows
reading "Stopped by operator" say nothing about whether someone stopped ten runs
or one thing stopped all of them.

Stopping is terminal. There is no pause-and-resume for an instance: a stopped
one cannot be un-stopped, and starting the workflow again is a fresh press of
Run with fresh runs.

There is no scheduling. A workflow runs when someone presses Run.

---

## The orchestrator chat

Filling in the run form once is fine. Filling it in eleven times, once per open
GitHub issue, is the part nobody does. The **Orchestrator** page is a chat that
can read your issues and propose a run for each one — and then stops, because
proposing and starting are deliberately different things here.

Ask it something like *"check the open bugs on acme/api and propose a run for
each one that has a reproduction"*. It will list your folders, run `gh issue
list`, and write one proposal per issue into the panel beside the conversation.
Nothing is running at that point. You tick the ones you want and press Approve,
and those become real runs — queued behind whatever is already working, under
the concurrency limit you already set.

**A proposal carries a task, not a policy.** This is the whole reason the feature
is safe to have. Every guard a proposed run will start under — its budget, its
work-cycle limit, its permission mode, whether it gets its own checkout — comes
from something *you* wrote: the **template** the proposal names, or, when it
names none, the **default guard set** under Settings → Run defaults. The chat
picks which of those applies and what the work is; it cannot set, raise or
invent a single guard, and there is no field on a proposal that would let it.
Every proposal card says which guard set it will run under, spelling the
untemplated one out in full — an approval gate that does not show what is being
approved is a gate that gets clicked through.

**The prompt is the exception, deliberately.** Prompt text is the half of a run
a model may write. So a proposal can rewrite the template's prompt for that one
run when the template nearly fits — the card marks it — and `save_template` can
write a prompt back for reuse. Neither can touch a guard: a new template takes
your default guard set, and an existing one keeps the guards it already has.

**The approval is per batch and there is no way to turn it off.** Not a setting
left switched on by default — there is no setting. The route takes the explicit
list of proposals the page was showing when you clicked, so anything the chat
added in between is not swept into a decision you did not see.

**What the chat itself may do: anything, and it is told not to.** It runs with no
tool allowlist at all — every tool the CLI has, this app's own alongside them —
because the job of an orchestrator is to find out enough to propose good work,
and the allowlist this replaced (this app's tools, `Read`/`Glob`/`Grep`,
read-only `gh`, three `git` subcommands) refused every question it had not
anticipated: a build log, a CI run, `gh api`, `git -C <path> log`. A proposal
written without looking is still a proposal you then approve.

So the limit is the instruction rather than the mode. The system prompt says its
job is to look and propose: read code, read issues, run whatever tells it
whether something is broken — and not to edit a workspace, commit, push, or act
on anything on GitHub, because a task small enough to just fix is a proposal that
says it is small. Everything else that bounds it is unchanged and is not a matter
of instruction: nothing it can call starts a run, its MCP surface is only this
app's, its credential dies with the turn, and `chatTurnBudgetUSD` caps the spend.
The cost of the trade is worth stating plainly — the chat can now write into a
checkout you also work in, and the GitHub token in its environment authenticates
writes as well as reads.

**It can look before it proposes.** `get_usage` gives it the 5-hour and weekly
windows, so it can tell you that approving ten runs into a nearly-spent window
means ten runs that stop on their first guard check. `get_run` and `get_run_diff`
give it a finished run's log, spend and patch, so "why did that one fail, and
what should we do about it" is a question it can actually answer.

**A turn that is not going to finish can be stopped.** While the chat is
working, **Stop** appears beside Send. It signals the process answering — and
everything that process started, the same ladder a run's Stop button uses — and
fails the turn out with "you stopped this message", so the thread is usable
again immediately. It is a way to *end* a turn, never a way to send around one:
the chat still refuses a second message while a turn is in flight, which is what
stops two billed children on one conversation.

There is a deadline under it as well. A turn that has been in flight for more
than ten minutes is failed out by a sweeper that reads the row rather than
waiting on the child, so the bound holds even when the child dies in a way that
never reports back — the case where the only recovery used to be restarting the
server, which stops every run in flight to clear one thread. Nothing is resumed
or re-asked either way: a chat turn is a question you put minutes ago, and
re-asking it unattended is spend nobody is present to want.

**It costs money, and the cost is shown apart.** A chat turn spends against the
same 5-hour window as everything else. It is refused outright when that window is
already past the ceiling you configured, and `chatTurnBudgetUSD` (default $2,
blank for none) caps a single turn. What it has spent appears on the chat page
only — never added to a run's spend and never to the dashboard meters, the same
separation reviews already get.

---

## Reviewing and landing what a run did

A finished run tells you it spent $3.40 over four work cycles and put six commits
on `uf/foo-1`. It does not tell you whether any of that is worth keeping. Four
things on the run page answer that.

**The agent's own report.** The last thing each work cycle said, rendered as the
markdown it was written as — headings, numbered steps, code fences. That text is
in the live log too, but as one monospace line per content block among the tool
calls, which makes the one paragraph explaining what a cycle did the hardest
thing on the page to find. The most recent cycle is open and earlier ones fold
away, but each is still there: the cycle where an agent said it was stuck is
rarely the last one. It is derived from the events already on disk, so it works
on runs that finished before it existed, and it costs nothing — no fetch, no
second source, no spend.

There is no markdown dependency behind it, and that is deliberate rather than
frugal. The renderer emits React nodes, so there is no `dangerouslySetInnerHTML`
and no sanitiser to keep current — which matters precisely because this text is
model-written and unreviewed. It understands fenced code, headings, list items
and inline code/bold/italic, and anything else falls through as plain text
rather than as markup it guessed at. Underscore emphasis is excluded on purpose:
`snake_case_name` would otherwise render as a corrupted identifier.

**The diff.** `<base>...<branch>` as a file list you can expand, which for an
isolated run is exactly that run's work and nothing else. A run that worked
directly in your folder gets a file list of the folder's current state with the
caveat attached — your own edits are in there too and nothing records which is
which, so no patch is shown rather than a confident diff of the wrong thing.

Large changes are budgeted: every changed file is always listed, and patch bodies
stop at a size limit. When that happens the page says how many files are listed
without contents, because a diff that quietly shows twelve of forty reads as a run
that touched twelve.

**The review.** A button that runs Claude once against the diff, the task the run
was given, and how it ended, and asks what changed, what to look at first, and
what looks risky. It is on demand only and never automatic — it is billed, and a
review nobody asked for is spend nobody authorised. It cannot edit anything
(`--permission-mode plan`), and **its cost is shown separately and never added to
the run's own spend**, which counts work cycles. If the diff was too large to send
whole, the reviewer is told which files it did not see, and the card repeats that
above the review.

A review is refused outright if either window is already at a ceiling you set —
it spends against the same 5-hour allowance your runs do.

**Landing.** UsageFoundry used to refuse to merge on principle. It now merges,
and everything that principle protected is a check rather than a caveat:

- The merge is previewed with `git merge-tree`, entirely in memory. You find out
  whether it fast-forwards, merges cleanly, or conflicts — and for a conflict,
  which files, what kind of conflict each one is, and the `<<<<<<<` blocks
  themselves — with nothing written to any working tree. That last part is free:
  the tree `merge-tree` writes holds each file exactly as a real merge would
  leave it, so the conflict can be read before deciding anything. (Needs git
  2.38+; an older one says so rather than guessing.)
- Landing needs your checkout **clean** and **on the branch the run started
  from**, which is recorded when the run is created. Anything else is refused with
  the reason, not greyed out. "Could not read your checkout" counts as dirty.
- A branch belonging to a run that is still `running`, `queued` or `paused` is
  never landable — it can gain commits at any moment.
- A merge that conflicts is aborted immediately and the conflicting files
  reported. Your checkout is left as it was found.
- Merge or squash, defaulted in Settings. Merging keeps the run's commits, so the
  diff above still means something afterwards; squashing gives your history one
  commit per run.

**Several branches can be queued, and a queue is not a batch.** Tick them on the
Branches page in the order you want them landed and they go through one at a
time, each re-previewed against git at its own turn rather than against whatever
the page showed when you queued them — because every landing changes the base for
the one behind it. Every check above still applies to every one of them, taken
fresh.

Two failures are told apart deliberately. A branch that cannot be landed is
reported and the queue carries on to the next. A problem with your *checkout* —
uncommitted changes, or standing on the wrong branch — would refuse every
remaining branch in that repository for the same reason, so the queue stops
there and says so once instead of ten times. Nothing is left half-merged either
way, and the queue never resumes itself after a restart: queued merges are
cancelled, because a server coming back up and merging four branches into the
tree you are working in is the one thing it must not do on its own.

Optionally — and it is a toggle on the form, not a setting — a conflict can be
sent to Claude as it comes up, resolved on the run's branch exactly as below, and
then landed. That spends money unattended, so the toggle carries the warning, the
cost lands on each queue row, and nothing switches it on for you.

**Conflicts can be resolved by Claude, and never in your checkout.** When the
preview reports a conflict, *Resolve with Claude* merges the target branch
**into the run's branch**, the opposite direction from landing, inside an
isolated checkout — the run's own if it still has it, otherwise a throwaway one
that is deleted afterwards. Claude edits the conflicted files and nothing else;
it is not allowed to run git. UsageFoundry then checks that no conflict marker
survived and makes the commit itself. If anything is still unresolved the merge
is rolled back and the branch is exactly as it was — an agent that says "done"
without doing it cannot get past that check. When it works, the branch now
contains the target, so landing it is a plain fast-forward under all the checks
above.

Your own checkout is not involved at any point, and a resolution that goes badly
costs a branch nobody has landed. Like a review, it is billed and shown with its
own cost — never added to the run's spend.

Afterwards the card shows both halves of it: what Claude says it kept and why,
and the diff of the merge commit it made, against the branch as it stood before
the merge. The first is an account of the work; the second is the work, and it
is what landing will bring across.

**Work an agent never committed can be committed for it.** An isolated run is
now granted `git add` and `git commit`, but a run from before that — or one whose
agent simply never got round to it — finishes with a full checkout and an empty
branch, which reads as a run that did nothing. Both the run page and the
Branches page show what is sitting there, uncommitted, and commit it onto the
run's own branch under the run's task as the subject (the run page lets you write
your own). Nothing is written to your checkout. It is also how you get the
checkout slot back: one with work left in it cannot be reused by the next run.

The commit is refused if the slot has since been taken over by another run —
what is uncommitted in it is then that run's, and committing it here would put
one run's work on another's branch.

**The Branches page** lists every `uf/*` branch across runs: which run made it,
what it lands into, how far ahead it is, whether it is merged, and how much is
uncommitted in its checkout. It is also where the merge queue lives.

Two ways out of a branch, and they are not the same button. **Delete** appears
once git can see the work is in the target — it removes the branch and frees its
checkout slot, and it is refused the moment the branch gains a commit that has
not landed. **Purge** is the other door, for the attempt that went nowhere: it
deletes the branch, its commits and its checkout whatever state they are in. It
takes two presses, the second one saying how many commits go with it, and it is
not offered for a run that is still going. Nothing here can put any of it back.

A squashed branch is a special case worth knowing: git cannot see a squash as a
merge, so the tool records the branch tip it took instead. That is what lets a
squashed branch show as landed and be deleted — and it stops being true the
moment the branch gains a commit, which is exactly when deleting would lose
something.

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

**Usage by period (day / week / month).** The two meters answer *may I start a
run right now*; the **Usage by period** card answers *what has this been
costing me*. It cuts the same deduplicated, same-priced entries into calendar
buckets — a fortnight of days, a quarter of weeks, a year of months — and shows
each one's cost, tokens, turns, and share of the ceiling. The toggle switches
between the three without a request: all three series ship on the same poll.

Two details are load-bearing.

*The buckets are cut in your timezone, not the container's.* The container runs
in UTC, so a 22:30 UTC turn is already tomorrow in Berlin, and bucketing it in
UTC would file an evening's work under the wrong day. The browser sends its own
zone (`/api/usage?tz=`), the server rejects anything that is not one and falls
back to its own, and the label is rendered from the same zone the boundary was
cut in. DST is handled by taking each bucket's end from the next bucket's
start, so the series is contiguous by construction — the 25-hour day when the
clocks go back is 25 hours long and nothing falls between two buckets.

*A day and a month have no published allowance, so their percentage is a pace.*
Anthropic enforces a 5-hour window and a weekly one and nothing in between. The
weekly ceiling is therefore the only configured number a calendar bucket can be
measured against: a **week** uses it as it stands, and a **day** and a **month**
get it spread evenly over their own length. The card says so in words on every
non-weekly view — *"your weekly ceiling spread over 31 days. Anthropic sets no
monthly limit, so this is a pace rather than an allowance"* — and the wording is
driven by the same value that produced the fraction, so the two cannot drift.
Nothing here reaches `evaluateBudget`: no guard has ever had a daily threshold
and this does not add one. With no weekly ceiling set, every bucket reads as the
hatched indeterminate meter, never 0%.

Weekly buckets follow the **weekly reset day** when one is configured, rather
than a calendar Monday, so the newest bucket is the same seven hours-to-the-
minute as the weekly meter above it. Buckets that closed before your first
recorded turn are dropped rather than shown as `$0.00`, so a fresh install sees
the days it has instead of thirteen empty ones above them.

**Agent self-reporting (optional, off by default).** Claude Code computes a cost
for every API request and will push it to any OTLP endpoint. Turning on *Agent
self-reporting* in Settings points agents this app spawns back at this server,
which records one row per request — a first-party number that needs no price
table, no dedupe key, and no file polling. It is shown as its own card on the
run page and its own card on the dashboard, and is **never** merged into
`spent_usd`, the dashboard's meters, or the budget guard, all of which stay
transcript-derived.

Its one real advantage: per-iteration spend normally comes from the CLI's
terminal `result` event, so a work cycle killed before that event reports $0.
Telemetry arrives per request as the run proceeds, so it captures that work. A
telemetry figure *higher* than the run's own total is the expected outcome of an
interrupted run, not a discrepancy.

The same property is why it is on the dashboard. Because per-cycle spend is only
reported when a cycle *ends*, a run that has been working for twenty minutes
reads $0 everywhere until it finishes — so nothing on the page attributed the
week's most expensive activity to the thing currently doing it. The **Live from
runs** card covers the same five hours as the session meter, lists the heaviest
runs by name with their status, and says how long ago the last request landed.
It is a third reading rather than a correction: the meters count every Claude
Code session on this machine through our price table, the card counts one class
of session through Anthropic's own, and the work overlaps — so the two are shown
side by side and never added. While a run is working the dashboard polls every
5s instead of 10s; the rest of the time it does not, because rebuilding the
snapshot competes with the agent for the same CPU.

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
- `UF_GITHUB_TOKEN` is handed to the agent's work cycles and to nothing else.
  The reviewer does not get it (it cannot write), and neither does the git this
  app runs itself — `worktree add` and `merge` execute hooks the repository
  controls, and this app's own git never touches the network. The credential
  helper is scoped to `https://github.com`, so another host asking for
  credentials gets none.

---

## Architecture

```
src/lib/
  transcripts.ts   JSONL parser — incremental byte-offset reads, dedupe
  windows.ts       5-hour block + weekly rollups, burn rate, projection,
                   calendar day/week/month history (display only)
  pricing.ts       per-model rates, cache-TTL multipliers, fast mode
  adminApi.ts      Admin API client (rate limits, usage, cost) w/ pagination
  budget.ts        policy evaluation
  orchestrator.ts  run loop, process spawn, stream-json parsing, SSE bus
  git.ts           the one way this app runs git — argv only, environment scrubbed
  diff.ts          a run's <base>...<branch> as a budgeted file list + patches
  review.ts        the on-demand reviewer (a third, deliberate child process)
  land.ts          merge preview, landing, branch deletion, branch inventory
  chat.ts          the orchestrator chat (a fourth, deliberate child process)
  workflows.ts     saved graphs of run blocks — form input, never a run
  workspace.ts     the folder walk, shared by the picker and the chat's tools
  db.ts            SQLite (runs, events, reviews, chats, proposals, workflows,
                   settings)
src/app/api/       usage · account · runs · branches · calibrate · settings ·
                   folders · chat · mcp · workflows
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
- **5-hour boundaries no longer rounded to the hour.** That resets are not
  hour-aligned was established from the shipped CLI itself: it reads
  `anthropic-ratelimit-unified-reset` off each API response, and its own
  formatter emits the minutes whenever they are non-zero — dead code if a reset
  always landed on `:00`. That the instant is unreadable locally was established
  the same way: no transcript record carries it (the assistant record's fields
  were enumerated across 205 files), no file under `~/.claude` holds it, and the
  CLI's OTLP export defines eight metrics and six event names, none of them
  rate-limit state. The effect on 4,663 real deduped turns: the four derived
  windows moved from a `17:00 / 22:00 / 03:00 / 08:00` grid onto the turns that
  actually opened them (`17:17:14 / 22:17:24 / 03:29:12 / 08:31:16`), the
  current window's reported reset moved 31 minutes later, and **86 turns moved
  back into the window that was really open** — at 22:00 the old rule showed a
  fresh empty session, and re-armed the session guard, 17 minutes before
  Anthropic's window closed.
- Attribution tables against real transcripts: effort, sub-agent, and skill each
  reconcile to the window total to within a rounding error ($138.3639 over 998
  turns), every turn lands in exactly one bucket per breakdown (998 = 998), and
  the `groupBy` refactor left `byModel` / `byProject` reconciling as before.
- **Calendar periods against 9,200 real deduped turns from 303 files**, in
  `Europe/Berlin` while the machine ran UTC. Every day boundary landed on local
  midnight (`00:00:00` Berlin, i.e. `22:00` UTC the day before under CEST), all
  three granularities were contiguous with no gap between adjacent buckets, and
  every turn in each series' span landed in exactly one bucket (9,200 = 9,200,
  three times). Pro-rating checked against a $700 weekly ceiling: a day read
  $100.00 and a 31-day August read $3,100.00. The weekly bucket's total matched
  the weekly meter's exactly ($1,228.79), the `limitBasis` was `weekly` for
  weeks and `prorated` for the other two, and the day series was three buckets
  rather than fourteen because the transcripts start on 10 August. Nine unit
  tests cover the same ground plus the DST case, an anchored week, and the
  no-ceiling case (`fraction === null`, never `0`).
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
- The dashboard's **Live from runs** card, against a real database with batches
  pushed through the live ingest route: the window total counts only the five
  requests inside the 5-hour window and attributed to a run, so a record seven
  hours old, a record carrying no `uf.run_id`, and a redelivered `request_id`
  are each left out; per-run rows carry the run's real status from the `runs`
  join (`running`, `completed`, and `—` when no row matches) and are ordered
  heaviest first; eight runs in the window list six and still report `runCount`
  8; `workingRunCount` counts the one `running` row, which is what switches the
  poll to 5s. The transcript-derived `session.costUSD` in the same response
  contains none of it, and the card disappears entirely when *Agent
  self-reporting* is switched back off.
- That card's own rendering (`npm test`, 5 cases): the first-party figure never
  renders without all three sentences that stop it being read as an addend to
  the meters; a list capped by `TOP_RUNS` names the number of runs it left out
  and a complete list claims no omission; a telemetry row with no matching
  `runs` row renders `—` rather than inventing a status; and nothing is
  described as "working" when `workingRunCount` is 0.
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
- Provider refusals (`npm test`, 18 cases): `isUsageLimit` matches both the
  wording the CLI renders and the wording in its own error taxonomy, including a
  model label it has never seen; leaves `Not logged in`, a spend cap and a
  credit balance to fail as themselves; and treats a 429, an overloaded upstream
  and a plain rate limit as transient rather than as an exhausted allowance —
  money and blips are the two things that must not be waited out.
  `isTransientApiError` picks those blips back up: all five stream-truncation
  sentences the CLI can render, the statuses and `error.type` names the provider
  documents as retryable, and a connection that never reached a status — while
  leaving a bad key, a malformed request and an empty credit balance to fail as
  themselves, and reading neither `Wrote 500 lines` nor `429 tests passed` as a
  status. `refusalResumeAt` waits for a window still open, backs
  off 20/40/60 minutes for one already passed or invisible, never re-spawns
  inside five minutes, and never holds a folder past six hours.
- Reviewing and landing, exercised end to end against real scratch repositories
  (the compiled modules driven directly, with a stub CLI standing in for
  `claude` so nothing was billed):
  - A diff over a change containing an edit, a rename, a binary file and a
    filename containing a tab: file list, statuses, line counts and per-file
    patches all correct, and the tab-containing name survives intact.
  - Landing refused while the checkout was dirty, and refused again while it was
    on a different branch — naming both branches. A clean fast-forward landed and
    the tree matched.
  - A conflicting branch: previewed as conflicting in `f.txt` with nothing
    written, and the merge attempt refused with the checkout left clean and HEAD
    unmoved.
  - A squash land: one commit on the target, the run's task as its subject, and
    the branch then deletable by tip comparison — with its worktree removed
    first, and refused while that worktree held uncommitted work.
  - A run predating target recording: the target deduced from the base commit and
    flagged as inferred.
  - The branch inventory reporting merged/ahead state, and `branch -d` after it.
  - The review path with a stub CLI: prompt assembled with the task and the whole
    diff, `--output-format json --permission-mode plan` on the command line, cost
    and tokens recorded to `run_reviews`, `running`/`completed` events emitted,
    and a second concurrent review refused.
  - Conflict resolution, both ways, with stub CLIs: one that resolves the
    markers — the branch gained a merge commit, the preview went from
    *conflicts* to *fast-forward*, the temporary checkout was removed, the
    operator's tree stayed clean throughout, and the branch then landed — and
    one that reported success without touching anything, which was caught, the
    merge rolled back, the branch left byte-identical, and the cost still
    recorded.
  - The run page, the branches page and the land/delete actions driven through
    the browser against that fixture.
- Parsers and budgets under `npm test` (24 further assertions): NUL-separated
  numstat and name-status records including renames, binaries and a tab in a
  filename; patch splitting that does not split on a `diff --git` line *inside* a
  hunk; the size budget naming what it left out; `merge-tree` output read as
  clean, conflicting, or undetermined-on-an-old-git; and every `landRefusal`
  branch.
- The merge queue, against a five-branch scratch repository on a live dev server,
  with the stub CLI standing in for the resolver. Three branches queued in an
  order that was not the list's — one clean, one conflicting, one clean — landed
  in exactly that order: the conflict was resolved in a throwaway checkout, its
  $0.07 recorded on the queue row and never on the run, and the two clean merges
  went either side of it. With the resolver toggled off, the conflicting branch
  failed with its own reason and the branch behind it still landed. With the
  operator's checkout deliberately dirtied, both queued branches were skipped
  with one reason between them, nothing was written, and the conflicting one was
  **not** paid to be resolved — the checkout is tested before the conflict
  precisely so that a merge which was going to be refused is never billed for
  first. Driven through the browser as well as the API, including the selection
  order badges and the inventory re-reading itself once the queue stopped.
- The conflict display, against a scratch repository with a content conflict and
  a modify/delete conflict in the same merge, on git 2.50. `merge-tree
  --write-tree -z` was run for real and its output fed through
  `parseMergeTree`: both files listed once, `contents` and `modify/delete` read
  off the informational records, git's explanation kept only where it says
  something the type and the path do not, and the `<<<<<<<` block read back out
  of the merged tree. Then the same fixture through a live dev server and a
  browser: the conflict list, the type, the clash count and the block itself all
  render on the run page, with the modify/delete file showing git's sentence and
  no block.
- The resolution display, from a `run_reviews` row written straight into SQLite
  with the merge commit of a by-hand resolution: `GET /api/runs/<id>/land`
  returned the resolution's own diff against the branch's pre-merge tip,
  restricted to the recorded conflicted paths, and the run page rendered it under
  the model's prose. The row was seeded rather than produced by a real agent —
  which the *Not yet verified* list below already covers.
- Run templates against a live dev server on a scratch workspace: create, list
  (ordered by name, case-insensitively), update, and delete, with a second
  delete answering 404. Every refusal came back as a 400 with the sentence the
  form shows — a duplicate name differing only in case, a blank prompt, an
  unknown permission mode, and the no-cycle-limit-and-no-time-limit pair that
  `POST /api/runs` refuses. Read-time narrowing was checked by writing a row
  straight into SQLite with `permission_mode = 'bypassEverything'` and a corrupt
  budget blob: it comes back as `plan` (the only mode that cannot write) and one
  work cycle, rather than as a wider permission or a throw. `normalizeTemplateInput`
  and `rowToTemplate` also have 20 assertions under `npm test`.
- The GitHub credential block, driven into a real `git` (2.39.5) in a scratch
  repository rather than only asserted in a test: `git credential fill` for
  `github.com` returns the token even when the repository's own config names a
  helper the image does not have (`osxkeychain`), which is the reset entry
  earning its place; `store`/`erase` are accepted as no-ops; both
  `git@github.com:owner/repo` and `ssh://git@github.com/owner/repo` rewrite to
  HTTPS under `ls-remote --get-url`; and a request for `gitlab.com` gets no
  credential at all and fails immediately instead of prompting. Plus six
  assertions in `npm test` on the block itself — the count matching its pairs is
  the silent one, since git discards the whole block if it does not.
- Layout, measured rather than eyeballed: every page of the production build
  rendered in a headless browser against fabricated API responses (each status a
  run can hold, a conflicting land preview, a working merge queue) at twelve
  widths from 1440px to 380px, in both themes, with the geometry read back out of
  the DOM — box intersections between in-flow siblings, boxes escaping their
  parent's padding box, and the document scrolling sideways. Three defects were
  found this way and are fixed here: the run page's accounting row sat at a 0px
  gap from the card above it where every other block on that page has 24px (the
  legacy `section + section` rule cannot see the component-kit cards that were
  inserted above it); the merge queue's *Cancel the N still waiting* button left
  its card by 92px at 380px wide and took the horizontal scrollbar with it (a
  card heading is a flex row and a button will not shrink below its own label);
  and the settings save bar was translucent over the card it floats across,
  which in dark mode read as a card torn in half. After the fix no card heading
  overflows at any tested width, no page scrolls sideways, and the run page's
  vertical rhythm is 24px throughout. The remaining reported intersections are
  inline text boxes wrapping inside a paragraph, and the save bar overlaying the
  page as a sticky bar is meant to.

- **The orchestrator chat, end to end against the real CLI.** A template was
  saved, a chat asked to list what it could see and propose one run, the
  proposal was approved, and the resulting run started and completed — $0.22 for
  the chat turn, $0.165 for the run. The chat's own tool calls landed on
  `/api/mcp` (the hand-written `initialize` / `tools/list` / `tools/call`
  handlers answer the pinned CLI 2.1.226 correctly), `list_folders` identified
  the repository's GitHub remote, and the proposal recorded the right template
  and folder.
- **The order a chat thread renders in** (`npm test`, 3 cases, against a real
  database under a temporary `DATA_DIR`): a reply and the denial note that
  annotates it, appended under a frozen clock, come back in that order rather
  than by the coin toss the random `id` was; ten messages written in one
  millisecond come back in insert order, and still do after the connection is
  closed and reopened; and rows carrying a null `seq` — the state a deployed
  database is in between the `ALTER TABLE` and the backfill — come back in the
  order they were written, with a message appended afterwards landing below them
  rather than among them. The migration itself was driven separately against a
  hand-built database file predating the column, using the three rows read out
  of the live deployment: it gains `seq`, they backfill to 1/2/3 in insert
  order, and the assistant reply that used to render *below* the denial note now
  renders above it.
- **That the chat could not write, under the configuration it had then.** Asked
  directly, in the same turn, to create a file inside the workspace, it reported
  `No such tool available: Write. Write is disabled for this session, in
  subagents as well as here.` and the file did not exist afterwards. That
  measurement stands as a measurement of `manual` plus an allowlist, and **no
  longer describes what ships**: the chat now runs `bypassPermissions` with no
  tool list, and what keeps it out of a checkout is the system prompt. The
  equivalent question — whether an orchestrator told to look and not build
  actually leaves files alone when a fix is one edit away — has not been
  measured and is in the list below.
- **That `--permission-mode plan` cannot be used for this.** Measured, not
  assumed: the first attempt ran the chat in plan mode and every MCP call came
  back `Cannot call mcp__uf__list_templates while in plan mode`, which would
  have left the chat able to read GitHub and not this app. That is why the
  read-only-looking mode is not an option here, and why removing the allowlist
  left nothing mechanical in its place.

- **That an isolated run under `acceptEdits` could not commit, and now can.**
  Found in the wild rather than reasoned about: four runs finished `completed`
  on their own branches with nothing on them and their whole change sitting
  uncommitted in the worktree. The transcripts say why — seven `git add` / `git
  commit` attempts across five phrasings, every one answered `This command
  requires approval`, which in a `-p` child nobody can give. `acceptEdits`
  auto-approves edits and read-only shell and holds mutating git for a human, so
  the isolation preamble was ordering work the permission mode forbade.
  Confirmed in the same transcripts that the other 59 Bash calls *did* run, so
  this is specifically mutating git and not "acceptEdits blocks the shell".

  The fix was then verified against the real CLI for $0.02, in a throwaway
  repository: `--permission-mode acceptEdits --allowedTools "Bash(git add:*)"
  "Bash(git commit:*)"` wrote the file, committed it, and had its `git push`
  refused — which establishes all three things it needed to. The grant works,
  it grants only what it names, and `--allowedTools` is *additive* rather than
  exhaustive when the mode is not `manual` (`Write` still ran, having never been
  named). The same run confirmed the `stream-json` `result` event carries
  `permission_denials`, with `tool_name: "Bash"` and the command under
  `tool_input.command` — which is why the log line names the command.

- **The two git formats behind committing and purging, read off git 2.39.5
  rather than the manual.** `git status --porcelain -z` was captured from a
  scratch repository holding an unstaged edit, a rename and an untracked file
  with a space in its name: the record is `XY <space> path NUL`, a rename's
  source follows as its **own** field with the current path first, and the
  leading space of `" M path"` is load-bearing. Passing that same output through
  `.trim()` — which every other caller of `git()` gets — silently drops the
  unstaged file from the list entirely, which is what `trim: false` exists for.
  Separately: `git worktree remove` refuses a checkout with modified *or*
  untracked files and a single `--force` removes it, and `git branch -d` refuses
  an unmerged branch where `-D` deletes it. Those four exit codes are the
  difference between Delete and Purge.
- **Workflows end to end against a live dev server**, on a scratch workspace with
  two throwaway git repositories and `CLAUDE_BIN` pointed at a stub that speaks
  `stream-json` — so every run below is a real run of the real loop, with no
  spend and no network. Saving refuses each case by name and in the operator's
  words: no blocks, a blank task, a template that does not exist, a workspace
  that is not mounted, a folder that does not resolve inside it, a link with no
  condition, and a loop (`B → A → B`). A four-block graph — two roots, one
  `on-success` link carrying the branch over, one `on-finish` link into another
  repository — created four runs in one pass: the two roots went straight to
  `running` in parallel, the two dependents sat `waiting`, and all four reached
  `completed`. The continuation landed on its predecessor's branch
  (`uf/repo-a-1-a89cd5db` for both, `continues_run` set on the second, and one
  branch in the repository rather than two). Pressing Run again while the first
  press was still going was refused with the count; deleting the workflow was
  refused the same way and succeeded once they had finished, taking the instance
  records and **no run** with it (the runs were still on `/api/runs`
  afterwards). Editing the workflow — renaming it and renaming a block — left
  the instance reporting the name and the block names it actually ran with, and
  an instance id requested under another workflow's id answered 404. The cascade
  was checked with a stub that exits non-zero: the root ended `failed`, its
  `on-success` dependent ended `blocked` with *"Set to start only after run
  274b3840 succeeded (on-success); it ended failed"*, and its `on-finish`
  dependent started anyway and failed on its own — which is exactly what the two
  conditions are for. All five pages compiled and answered 200.

### Not yet verified by hand

The live-enforcement and pause/resume paths typecheck, build (including the
standalone bundle), and are covered by the unit tests above, but the following
have **not** been exercised against a real CLI. They are the list to work
through before trusting this unattended:

- **The whole of "The agent's own report" above — including that it compiles.**
  It was written by a run whose permission allowlist carried no `npm`, so
  `npm run typecheck`, `npm test` and `npm run build` were never executed against
  `src/lib/cycles.ts`, `src/components/Markdown.tsx`,
  `src/components/RunOutput.tsx` or their two test files. They were read for type
  errors by hand and by nothing else, and no browser has rendered the card. The
  same run could not reach `gh`, so the issue it was written from was never read
  either — what is here follows the task text's summary of it. Run the three
  commands and open one finished run's page before trusting any of it.
- **The Usage by period card in a browser.** The rollup behind it was exercised
  against 9,200 real turns (see *Verified*) and `npm run typecheck` and
  `npm test` both pass, but no browser has rendered it: the sandbox it was
  written in cannot execute Next's edge runtime at all (`EvalError: Code
  generation from strings disallowed`, the same limitation noted below for
  `/api/mcp`), which takes `next build` and every page request with it. What
  has not been seen is the layout — the tab strip beside the card title at a
  narrow width, a fourteen-row daily table, and a meter reading 798% of a
  pro-rated day, which is a real figure from those transcripts and clamps to a
  full bar.
- Whether `claude -p` flushes its `result` event on `SIGINT`. If it does, an
  interrupted cycle keeps its measured cost and the transcript reconciliation
  becomes a fallback rather than the norm.
- **The chat's `/api/mcp` middleware exemption under an actual `UF_AUTH_TOKEN`.**
  The end-to-end run above was done with auth off, because the sandbox it was
  done in cannot execute Next's edge runtime at all (`EvalError: Code generation
  from strings disallowed`), which takes `middleware.ts` out of the picture along
  with the exemption. The capability check in the route itself is what was
  exercised — every tool call carried one and was accepted. What has *not* been
  watched is a token-protected deployment letting an unauthenticated `/api/mcp`
  request through to that check. Worth ten minutes with `UF_AUTH_TOKEN` set
  before trusting it, since the failure mode if the exemption is wrong in the
  other direction is a chat whose every tool call 401s.
- **The chat against a repository with a large number of open issues.**
  `MAX_PENDING_PROPOSALS` (25) and `MAX_REMOTES_READ` (25) were reasoned about
  rather than hit. What a chat does when it reaches the proposal cap mid-answer —
  whether it reports the refusal usefully or simply stops — has not been seen.
- **The chat's inspection tools, and proposals with no template.** `get_run`,
  `get_run_diff`, `get_usage`, `list_proposals` and `save_template` answer from
  the same functions the pages already use, and they typecheck — but no real CLI
  has called one. Two things to watch. Whether a turn asked about three runs
  stays inside `chatTurnBudgetUSD` now that a single tool call can return 60KB
  of patch; and whether the untemplated path gets used where a template would
  have been better, since it is the branch with no form behind it and its guard
  set is the one thing on a proposal card an operator has to *read* rather than
  recognise.
- **That an unrestricted chat stays an orchestrator.** It now runs
  `bypassPermissions` with no tool list, so the only thing stopping it fixing a
  one-line bug itself — in a checkout you may also be working in — is the
  paragraph in `systemPrompt()` telling it that its job is to look and propose.
  That has not been tested against a real CLI, and it is the assumption this
  whole feature now rests on. Two things to watch, both of which show up as a
  dirty working tree rather than as an error: whether it edits when a fix is
  smaller than the proposal describing it, and whether it runs `git` writes
  while investigating (it has the credentials to push, since `githubEnv()`
  reaches this child).
- **Stopping a whole workflow instance against real runs.** `haltPlan` — which
  members a stop selects and what each becomes — is unit tested over an instance
  holding one running, one queued, one parked, one waiting, one completed and one
  failed block, plus a stop arriving mid-instantiation and a second stop on an
  instance already stopping. The writes around it typecheck and nothing else has
  been exercised: no child has been signalled by `stopInstance`, and the sandbox
  it was written in cannot run this app at all — `npm run dev` starts and every
  request 500s with `EvalError: Code generation from strings disallowed`, the
  same edge-runtime limitation noted above for `/api/mcp` and the period card,
  which takes `instrumentation.ts` and the middleware with it. What a human
  should run, against a scratch `DATA_DIR`, `CLAUDE_HOME` and workspace, with
  `CLAUDE_BIN` pointed at a stub that speaks `stream-json` and stays alive:

  ```bash
  docker compose up --build          # or: npm run dev, where the edge runtime works
  # Settings → 1 concurrent run, so one block queues behind another.
  # Save a workflow: a quick block, a slow one, a second slow one, and a fourth
  # set to start after the first slow one. Press Run, wait for one `running`,
  # one `queued` and one `waiting`, then press Stop all.
  ```

  Four things to watch, none of which the unit test can see. That the signalled
  child actually dies and its run lands `stopped` rather than `failed` — a
  SIGTERM'd child closes with a null code that reads as `-1`, and the `cancelled`
  check ahead of the exit-code test is what keeps a deliberate stop from being
  filed as a crash. That a killed cycle's spend arrives in `spent_usd_est` and
  not in `spent_usd`. That the block which was `waiting` reads `blocked` with a
  reason naming the workflow, and that nothing was promoted into `running` on the
  way out. And that a stopped run's uncommitted work is still in its checkout
  afterwards, offered by the run page's Commit under that run's own branch.
- **Stopping a chat turn, in either of its two forms.** `staleTurn` is unit
  tested and the rest typechecks, but no real CLI child has been signalled by
  `cancelChatTurn` and no sweep has fired against a live row. Two things to
  watch. Whether the SIGINT/SIGTERM/SIGKILL ladder actually reaches a chat
  child's whole process group the way it does an agent's — the chat spawns
  `detached` under the same `killProcessGroup` setting, so it should, but the
  agent path is the one that has been watched. And whether the sweeper ever
  fires on a turn that was merely slow: it waits a minute past the ten-minute
  bound, and the in-closure timer should have settled the row long before, so an
  entry saying the chat "did not answer within 10 minutes" that arrives with no
  preceding kill means the two paths disagree about when a turn began. Putting a
  row into `thinking` by hand (`sqlite3 $DATA_DIR/usagefoundry.db "update
  chat_sessions set status='thinking', turn_started_at=… where id=…"`) and
  loading `/chat` exercises the no-child half of both without spending anything.
- **The `chat_proposals` rebuild on a database that predates it.** Dropping the
  NOT NULL from `template_id` needs a table rebuild, which was exercised against
  SQLite directly — rows preserved, index recreated, foreign key and its cascade
  intact, a null `template_id` accepted afterwards — but not through
  better-sqlite3 in a running container, because the environment it was written
  in has a native module built for another platform. The first `docker compose
  up` on an existing `.data` is the test.
- **The derived 5-hour boundary against a live `/usage` reading.** Removing the
  hour rounding was argued from the CLI's own header handling and rendering, not
  from watching the two side by side, and what is left over — the opening turn's
  latency, and any window opened by a surface with no local transcript — has
  never been measured against the real reset time. A residual offset that is
  *steady* is the tell that the rule is still wrong somewhere; one that varies
  run to run is the invisible usage this app already documents. Until someone
  compares them, the override in Settings is the answer to a disagreement.
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
- **What a dropped stream does to the cycle around it.** The five sentences
  `isTransientApiError` matches were read out of the shipped binary's own
  strings, and one of them (`Connection closed mid-response`) is confirmed from
  a real run — which this app then filed as `failed`. The binary also shows the
  CLI finalising a partial response and carrying on rather than aborting, which
  is why a cycle that still reports success is now treated as having recovered.
  What has not been watched end to end is which of the two paths that real run
  actually took, or whether `--resume` accepts a session a drop truncated
  mid-turn — and so whether a retry carries on or lands in the resume-failure
  ladder above. Every outcome is recorded either way: a recovery is a log line
  naming the error, each retry is an `error` event carrying its backoff, and the
  stop reason names the attempt count if all of them fail.
- Whether `claude --resume` accepts a session whose transcript was truncated by
  a mid-turn kill. The recovery ladder retries once and then stops, naming the
  command — it deliberately does not start a fresh session. That ladder now also
  covers a run picked up by hand rather than only one coming back from a pause,
  which makes this the failure an operator is most likely to meet: a run that
  cannot be resumed cannot be reopened into either, and the manual command is
  the only way out of it.
- **Switching threads in the Orchestrator, in a browser.** The proposal
  selection is now cleared where the "Earlier chats" button switches thread, and
  a batch whose ids are none of the target chat's is a 400 naming which of them
  belong to another thread rather than a 200 claiming they were already decided.
  The sentence that refusal is written with is unit-tested; the click that
  produces it, and the red banner the page then shows, have not been watched.
- **Which session id `claude -p --resume <id>` reports back.** Every cycle's
  stream is read for one and the run adopts it; a value differing from the one
  passed to `--resume` is written to the run log and otherwise treated as
  normal, because nothing here has watched a real resume on the wire. If it
  turns out the CLI always mints a fresh id, that line is noise and should
  become a debug-level detail rather than a log entry per resumed cycle.
- Whether a session id reported by an `init` event that is then killed seconds
  later is resumable at all. It is now persisted, so such a run is reopened as a
  continuation rather than a restart — which is the point — but the conversation
  it attaches to holds only the original task, and a continuation prompt that
  restates nothing is relying on that first user turn having been flushed.
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
  another run has taken — were checked against the live container.
- Picking a `completed` run back up with a follow-up message: that the note
  arrives as the next turn of the same conversation rather than as a new task,
  and that leaving it blank sends the DONE pushback only to a run whose agent
  really replied `DONE` — a run that merely used up its work cycles gets the
  continuation. The branch that decides this is unit-tested, and the column it
  reads was watched being written end to end against a *stub* CLI printing the
  two `stream-json` events the loop reads. Neither the recording nor the
  delivery has been through a real `claude`.
- `detached: true`: that Ctrl-C during `npm run dev` still kills the agent (via
  the new `instrumentation.ts` handler) and that a long command the agent
  started dies with it.
- **A review or a conflict resolution against the real CLI.** The spawn, the flags, the JSON result shape
  and the accounting were exercised with a stub that prints the same object the
  `stream-json` `result` event carries — but no real `claude -p … --output-format
  json --permission-mode plan` has been run through this path, so neither the
  quality of the review nor `plan` mode's behaviour in print mode is confirmed.
  The same goes for whether a real agent under `acceptEdits` resolves conflict
  markers well; that it cannot get a bad resolution *committed* is verified.
- Landing inside the container, where git is 2.39 rather than the 2.50 the
  scratch repositories above were driven with. `merge-tree --write-tree` and its
  conflict format both date from 2.38, and an older git is reported rather than
  guessed at, but that path has not been run against 2.39 itself. The conflict
  *types* are the part most likely to differ: they come from the `-z`
  informational records, whose field layout was captured from 2.50. A 2.39 that
  writes them differently loses the type and the explanation and still lists
  every conflicting file, because that list comes from the stage records — but
  which of those two happens on 2.39 is unconfirmed.
- A repository large enough to hit the diff's size budget in the wild.
- **Committing and purging through the app itself.** The two git formats they
  turn on are confirmed against 2.39.5 above, and the three decisions
  (`parseStatusZ`, `commitRefusal`, `purgeRefusal`) are unit-tested — but no
  branch has been committed to or purged through a running server, so the
  wiring in between is unconfirmed: whether the leftovers a real agent leaves
  come back as the list the card renders, whether the commit satisfies
  `ensureWorktree`'s reuse check on the next run into that slot, and whether a
  purged slot is re-created cleanly rather than tripping the "checkout is gone"
  guard for a run that had already worked in it. `next build` could not be run
  here at all — it fails with `TypeError: generate is not a function` on the
  unmodified tree too, so it says nothing either way about these changes.
- **The Live from runs card in a browser, fed by a real telemetry-enabled run.**
  Its query was driven against a real database through the real ingest route and
  its markup was rendered and read, but the batches were synthesised from the
  captured payload rather than pushed by a live `claude -p`, and the card has
  not been *looked at* on the page. What that leaves unconfirmed is how it reads
  next to the meters — whether the separation is as plain on screen as it is in
  the copy — and whether the figure visibly moves during a single work cycle at
  the 5s poll.
- **The in-flight cycle line on a real run.** `runs.active_iteration` is written
  at the spawn and cleared when the cycle returns, and `fmtCycleInFlight` is
  unit-tested for every branch including the stale-row one — but no agent has
  been started through a running server to watch the card go from nothing to
  "cycle 1 of 2 in flight" and back to a plain count between cycles. Two things
  to watch: that the line disappears during the pre-cycle transcript scan rather
  than lingering over finished work, and that a run killed with the container
  down comes back reading `failed` with no cycle claimed. Start a run and open
  `/runs` during cycle 1.
- The new-run form's template UI driven through a browser: that loading a
  template fills every field, that *Start another like this* pre-fills from a
  run without the folder and settings loaders racing it, and that the two
  banners — a carried live-enforcement mode, a carried `bypassPermissions` —
  appear on load and clear when the control is touched. The routes underneath
  were exercised directly; only the client wiring is unconfirmed.
- The *Earlier chats* rows in a browser. Each one is now two lines — a
  truncating title, then the time and a *waiting* badge — because a single
  truncated line in the 360px column was all title. The metadata sits outside
  the truncating element and every utility it needs is in the built stylesheet,
  but no browser has rendered it at that width, so how the two-line rows read
  against the 6px gap between them is unmeasured.
- **The image with `gh` in it.** The install layer, the checksum check and the
  arch mapping have not been built — no Docker on the machine this was written
  on — so `docker compose up --build` is the first thing to run against this.
- A real agent using the token: a `git push` of a run's branch, and a `gh` call
  that needs authentication. The credential block itself was driven into a real
  git (above); what has not been watched is the CLI's own git picking it up out
  of the environment mid-run.
- The chat page recovering from a dropped request, in a browser. That a rejected
  `fetch` comes back as a result rather than a rejection is unit-tested, and the
  `finally` that clears `busy` is plain control flow — but nobody has stopped the
  server, pressed Send, and watched the composer, Approve, Reject and Select-all
  stay usable with the reason on screen.
- **The chat page's failed-poll notice in a browser.** A poll that fails now
  puts a sentence on the page and stops the thread claiming to be thinking, and
  the sentence itself is unit-tested — but no browser has been pointed at a
  stopped server or at a `UF_AUTH_TOKEN` deployment with the `uf_session` cookie
  deleted, which are the two reproductions. What that leaves unconfirmed is the
  client wiring rather than the copy: that the notice appears within one poll,
  that it clears on the next successful one, and that a page opened while the
  server is down recovers by itself once the server is back.
- The chat page's "Earlier chats" list going stale-free in a browser. The route
  it polls now answers with the list, and that is unit-tested against the
  handler itself — what has not been watched is the sidebar picking up a title
  and a waiting count on the 10s poll without a reload.
- **That a fresh `usagefoundry-data` volume is writable under a non-1000
  `UF_UID`.** The image marks `/data` mode 0777 so that Docker copies a
  world-writable root onto the volume when it first creates it; that Docker does
  copy the mount point's mode and not only its ownership is the step this rests
  on, and no `docker build` has been run since the change — Docker was not
  available on the machine it was made on. `src/lib/deployment.test.ts` pins the
  image and compose halves against each other, which is a different claim. The
  check is four commands, on a Linux host where `id -u` is not 1000:

  ```bash
  UF_UID=1001 UF_GID=1001 UF_PORT=3100 UF_CONTAINER_NAME=usagefoundry-uidtest \
    docker compose -p uf-uidtest up --build -d
  docker compose -p uf-uidtest exec usagefoundry ls -ld /data   # expect drwxrwxrwx
  curl -fsS localhost:3100/api/usage >/dev/null && echo OK      # with UF_AUTH_TOKEN blank
  docker compose -p uf-uidtest down -v
  ```

  `UF_PORT`/`UF_CONTAINER_NAME` are there because `container_name` is *not*
  namespaced by the compose project, so without them this collides with an
  instance already running. Run it a second time with the two uid variables
  unset to confirm the 1000 default is unchanged.
- **The workflow editor in a browser.** Every page it lives on compiled and
  answered 200 in `next dev`, and the API underneath was driven end to end (see
  *Verified*), but no browser has rendered the form: what is unconfirmed is the
  interaction rather than the data. Three things to try first — moving a block
  above one it waits for, which drops that link and should visibly do so;
  turning on *Carry on its branch* for one link when another already has it,
  which clears the other; and removing a block that later blocks depend on. All
  three are refused or repaired again by the server, so the risk is a form that
  disagrees with what gets saved, not a bad graph.
- **A workflow instantiated against the real CLI.** Every run in the *Verified*
  entry above came from a stub, deliberately: it is the loop, the folder claims,
  the dependency wiring and the branch hand-over that were being tested, and a
  real agent adds spend without adding coverage of any of them. What a stub
  cannot show is a real work cycle's timing — in particular whether the
  `on-success` dependent's first `git log` shows its predecessor's commits, since
  the stub committed nothing. Run a two-block workflow with a branch hand-over
  and read the second run's opening prompt.
- **The rollback path.** It is written to be unreachable — the graph, the
  templates, the mounts, every folder and both ends of every branch hand-over are
  checked before the first `createRun` — and nothing contrived reached it in
  testing, so the stop-everything-and-record-`failed` branch has never actually
  run. The cheapest way to exercise it is to delete a mount from
  `WORKSPACE_ROOTS` between the pre-flight and the pass, which is not a thing an
  operator can do; short of that, read it rather than trust it.

There is no linter run in this repo, and `npm test` covers a deliberately short
list: the folder-collision predicate, which queued runs may start, the budget
policy, how a provider refusal is classified and backed off from, which prompt a
work cycle spawns with, the GitHub credentials handed to a work cycle, how a
run's diff is parsed and budgeted, whether a saved graph of run blocks can run at
all and the order its runs are created in, when a branch may be landed, what a
queued merge does with the branch it reaches, what counts as a conflict marker — both
for deciding whether one was really resolved and for deciding what to show — and
the two renderings that would lie quietly about a number: an unconfigured
ceiling, and a first-party figure shown beside the meters. Two entries are
neither a function nor a rendering: the order a chat's thread renders in, driven
against a real database because what it pins is in the SQL rather than in any
function; and that the image leaves the data volume writable by whatever uid
compose runs the container as, which is otherwise checked by nothing here and
fails only on Linux, only under a non-1000 `UF_UID`, and only by refusing every
data route. `npm run typecheck`
plus a `docker compose up --build` smoke test is still the real verification
loop, and the list above records what was checked by hand.

---

## License

Source-available, not open source — see [LICENSE](LICENSE).

You may use, self-host, modify and study it for your own personal,
non-commercial purposes. **Distributing it, and using it commercially or inside
an organisation, both need written permission** — ask, and it may well be given.

Releases before this change were MIT, and this does not withdraw rights anyone
already has in a copy they received under those terms.
