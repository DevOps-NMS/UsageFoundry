# Installation and setup

[← Documentation index](README.md)

Getting the container running, signed in, and pointed at your code.

## Quick start

```bash
cp .env.example .env
# edit .env:  UF_AUTH_TOKEN (required), UF_WORKSPACE (required),
#             UF_WORKSPACE_2… (optional, for more than one workspace)

docker compose up --build
open http://localhost:3000
```

Then in the UI: **Settings → Estimate a ceiling from your own history** (press
**Scan history**) to set ceilings, **Runs → New run** to start work.

## Sign in once, inside the container

The dashboard works immediately — it only reads transcripts. **Runs will fail
with `Not logged in` until you authenticate the container's own Claude Code.**

Go to **Settings → Claude account** and press **Sign in**. The container's CLI
prints an Anthropic link, the page shows it, and you approve there and paste the
code it gives you back. The row then names the account every run will bill
against, and carries the **Sign out** that revokes it.

The `~/.claude` mount carries your transcripts, settings, rules, and plugins,
but **not** your credentials. On macOS the OAuth token lives in the login
Keychain rather than in that directory, so there is nothing on disk for the
mount to carry; a Linux container cannot read it either way.

This is a one-time step. The login writes `.credentials.json` into
`/home/node/.claude`, which *is* the mounted `~/.claude`, so it survives
restarts, `docker compose down`, and image rebuilds.

Sign in from the page rather than from a shell. The CLI keeps
`.credentials.json` at mode 0600 owned by whoever wrote it, and the uid that has
to open it afterwards is `UF_UID`/`UF_GID` — every work cycle runs as that uid,
not as the server. The page's sign-in is dropped to it for exactly that reason.
A `docker compose exec` defaults to root, so if you do sign in from a shell,
name the uid rather than relying on the default — and read it out of the
container, which is the only place it is certain to be right:

```bash
uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
docker compose exec -u "$uid" -it usagefoundry claude auth login
```

**Not `-u "${UF_UID:-1000}"`, which is where this page used to send you.** Your
own shell expands that, and `.env` is not in your shell: compose reads that file
to interpolate `docker-compose.yml`, and exports nothing back to the caller. So
on every install that followed *On Linux, set `UF_UID` and `UF_GID`* below, it
resolves to 1000 whatever `.env` says. Sign in as 1000 while the cycles run as
your own uid and the login writes a `.credentials.json` at mode 0600 that no
work cycle can open — every run then fails with `Not logged in`, which is the
symptom of not having signed in at all, so the obvious response is to do it
again the same way.

An API key in the environment outranks all of this. With `ANTHROPIC_API_KEY`
set, that key is what runs bill against and the subscription login is ignored;
the Settings row says so rather than reporting an account nothing uses.

One thing the mount also cannot carry is `~/.claude.json` — it sits *next to*
the directory, not inside it — so user-scoped MCP servers are not available to
the containerised agent.

## Giving a run access to GitHub

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

That advice stops being followable past a couple of repositories: one token for
fifteen of them is a token for fifteen of them, and an agent fixing a test in one
holds a credential that can force-push to the other fourteen. Nothing inside a
run narrows it, because the credential helper answers for `github.com` as a
whole. So name the repositories instead:

```bash
UF_GITHUB_TOKENS=acme/web=github_pat_aaa|acme/api=github_pat_bbb|acme/secret=
```

`folder=token`, separated by `|`, where the folder is written as the picker shows
it or absolute (`/workspace/acme/web`), and covers everything under it. A run
working there gets that token and no other. A folder no entry names falls back to
`UF_GITHUB_TOKEN`, so **leave that blank** to give every unnamed repository no
credential at all; an entry with an empty token excludes one repository while the
rest keep the install-wide one. The Settings header says which of those three
states you are in.

The orchestrator chat still takes `UF_GITHUB_TOKEN`: it looks across every
workspace before it knows which repository it is proposing work in, so there is
no repository to narrow it to.

With it set, each work cycle is spawned with `GH_TOKEN`/`GITHUB_TOKEN` for the
`gh` CLI, a git credential helper for `github.com`, and a rewrite of
`git@github.com:` remotes to HTTPS — the container holds no SSH key, so a
repository cloned over SSH could otherwise never authenticate while one cloned
over HTTPS could, which is what makes this fail on some runs and not others.
Those variables reach the agent and nothing else: not the reviewer, and not the
git this app itself runs, whose children execute repository-controlled hooks.
Settings shows whether a token is configured.

### `gh` extensions

The image carries `gh` itself. Extensions are yours to name, and naming them in
`.env` is the only way that lasts:

```bash
UF_GH_EXTENSIONS=dlvhdr/gh-dash github/gh-copilot@v1.1.0
```

`owner/repo` per extension separated by spaces (commas and `|` also work), with
an optional `@tag` to pin a version. The container installs each one at boot,
into a named volume — `docker compose up --build` therefore keeps them, which is
what installing one by hand in a shell does not do: `gh` keeps extensions in the
container's writable layer, and that command discards it. The failure that
follows an upgrade is the quiet kind this whole page is about, an `unknown
command` inside a tool call, read from outside as the agent choosing not to use
the tool.

It needs `UF_GITHUB_TOKEN` above, even for a public extension: `gh` refuses every
API call without a credential. `UF_GITHUB_TOKENS` cannot stand in, because those
tokens are chosen by the folder a run works in and this happens before any run
exists.

An extension already installed is left alone, including one whose `@tag` has
since moved — a restart is not a good moment to silently replace an executable
that runs with your token in its environment. To move a pin or drop an
extension, edit the line and remove the old one yourself:

```bash
docker compose exec usagefoundry sh -c 'GH_TOKEN=$UF_GITHUB_TOKEN gh extension list'
docker compose exec usagefoundry sh -c 'GH_TOKEN=$UF_GITHUB_TOKEN gh extension remove dash'
```

(`gh` answers nothing at all without a credential, and the container holds the
token under this app's own name rather than gh's — hence the prefix.)

Then restart. `docker compose down -v` discards them all with the volume, and
the next boot reinstalls whatever `.env` still names. What happened at boot is in
`docker compose logs`, one `[usagefoundry]` line per extension installed or
refused.

### Python tools, and the plugins that need them

The same mechanism one language over, and it exists for a plugin rather than for
an agent. A Claude Code plugin registered through `--plugin-dir` speaks to you
through its hooks; a hook that shells out to a Python command finds none here,
because the image ships `python3` for node-gyp and nothing to install a package
with — no `pip`, no `ensurepip`, and Debian's `EXTERNALLY-MANAGED` marker
refusing a system-wide install even if there were.

What makes that worth a variable is how it fails. Hook bodies conventionally end
in `|| true`, so a missing command is not an error anything reads: the hook exits
0 having done nothing, and a plugin that prints "active" on session start goes on
printing it. Measured on one install here — 213 sessions told a plugin was
active against a command that was never present.

```bash
UF_PY_TOOLS=cozempic==1.8.39
```

One PEP 508 requirement per tool, separated by spaces or `|`. **Not commas**,
which is the one place this parts company with `UF_GH_EXTENSIONS` above: a comma
is meaningful inside a version specifier. `uv` installs each one at boot into a
named volume, each in its own environment, with the launchers on the agents'
`PATH` — so a rebuild keeps them, and nothing here changes what `python3` means
for the rest of the fleet.

No token is needed; the container needs outbound network at boot and nothing
else. Pin the version, for the same reason a dependency is pinned.

#### Your own copy of one

A fork you maintain is a **container** path — a directory under a workspace
mount, not a host path:

```bash
UF_PY_TOOLS=/workspace/winnow
```

That is installed *editable* and re-run on every boot. Editable means the
container follows the source instead of copying it, so an edit on the host is
live in the next session with nothing to reinstall — verified: the module
resolves to the mounted tree, and a value changed on the host reads back changed
from the same install. The boot-time re-run is what picks up what editable does
not follow: the dependencies and the console scripts, both fixed at install
time. A tree too broken to build leaves the last good install alone and says so
in the log, so a half-finished edit cannot take the tool away.

For a copy pinned to the state it was installed in, name it and give the path as
a URL. That one is copied once and skipped on later boots, exactly like a
release:

```bash
UF_PY_TOOLS=cozempic@file:///workspace/winnow
```

Worth knowing before choosing the first. The agents can write the mounts, so an
editable install means code under one of them runs on every session start, as a
hook, with no restart in between. That is the same reach a plugin directory
already has — its hooks come from a mount too, and `docs/security.md` covers the
argument — but it is a second door onto it, and the pinned form does not have
it.

Then turn off two things in the tool itself, if it has them. Neither goes in
`.env`: compose reads that file for interpolation only and there is no
`env_file`, so a name `docker-compose.yml` does not forward never reaches the
container. They go in a `docker-compose.override.yml`, which is where one host's
answer to a third-party tool belongs:

```yaml
services:
  usagefoundry:
    environment:
      COZEMPIC_NO_GLOBAL_INIT: "1"
      COZEMPIC_NO_AUTO_UPDATE: "1"
```

From there they reach the agents and their hooks — `childEnv` strips only `UF_`,
`OTEL_` and four named keys. **The auto-updater**, because the pin is only the version
that gets *installed*, and a tool that upgrades on every session start is one
whose version nobody chose. And **anything that installs itself into
`~/.claude`**, which is the sharper one: that directory is a
bind mount of your own, the same file your host's Claude Code reads, so a tool
that wires itself in "globally" on first run is editing your machine's settings
from inside this container — for every session on it, not just this app's. One
`cozempic --version` in a throwaway container wrote 7 hooks into
`~/.claude/settings.json`. Its own plugin hooks already export both; what they do
not cover is an agent, or you, running the command directly.

A tool already installed is left alone, including one whose version has since
moved, on the same argument the extensions above are. To move a pin or drop one:

```bash
docker compose exec usagefoundry uv tool list
docker compose exec usagefoundry uv tool uninstall cozempic
```

Then restart. `docker compose down -v` discards them with the volume. What
happened at boot is in `docker compose logs`, one `[usagefoundry]` line per tool
installed or refused.

## Finding a setting, and not losing an edit

Everything above says **Settings → something**. The page is nine sections on one
long scroll, and there are two things on it worth knowing before you go looking.

**Find a setting**, above the section chips, matches a field's **name and its
description** — never the values in them. Type `weekly`, `plugin`, `retention`;
each result names the section it is in, and pressing one scrolls that field into
view and focuses its control. A match inside one of the four **Prompts** folds
opens the fold. A one-letter query matches most of the page, so the list stops at
eight results and says how many it left out. It is a route to a field and nothing
more: no section is collapsed, reordered or hidden, and the chips still work
exactly as they did.

**One Save commits the whole page**, and while anything is unsaved the changed
fields carry a rail in the margin and the sticky bar at the foot says how many
("*3 unsaved changes, marked in the margin*"). Closing the tab or reloading now
raises the browser's own "leave site?" dialog — its wording is the browser's and
cannot be changed. **A press on the sidebar does not raise it**: that is a
navigation inside the app rather than a page unload, and the rails and the
unsaved count are what tell you there. Press **Save**, or **Discard** to go back
to what is stored.

## Required environment

| Variable | Purpose |
|---|---|
| `UF_WORKSPACE` | Host directory mounted at `/workspace`. Runs are confined to it. Absolute path; compose refuses to start without it. |
| `UF_AUTH_TOKEN` | Shared secret for the UI. Blank makes the server **refuse to start** unless `UF_ALLOW_NO_AUTH=1` is also set. |
| `UF_ALLOW_NO_AUTH` | `1` to run with no authentication at all. Only for a loopback-bound install on a machine you alone use; every page then says so. |
| `UF_STATUS_TOKEN` | Optional. A second, read-only credential, for `/api/status` and nothing else — never point a monitor at any other route, because `UF_AUTH_TOKEN` also starts billed runs. Blank leaves that route behind the ordinary gate, so a monitor gets a 401 rather than the endpoint being public. |
| `UF_BIND_ADDRESS` | Which host interface the port is published on. Default `127.0.0.1` — this machine only. See *Reaching it from another machine* below. |
| `ANTHROPIC_ADMIN_KEY` | Optional. Enables the API-account page. Org Admin key only. |
| `UF_GITHUB_TOKEN` | Optional. What a run pushes, opens PRs and reads issues with. Reaches the agent only, and every repository. |
| `UF_GITHUB_TOKENS` | Optional. `folder=token` entries separated by `\|`, narrowing the credential to the repository a run is working in. |
| `UF_GH_EXTENSIONS` | Optional. `gh` extensions to install at boot, `owner/repo` or `owner/repo@tag`, space-separated. Kept in a named volume, so a rebuild does not lose them. Needs `UF_GITHUB_TOKEN`. |
| `UF_PY_TOOLS` | Optional. Python tools to install at boot, one PEP 508 requirement each, separated by spaces or `\|` (not commas). Kept in a named volume. What a plugin whose hooks shell out to Python needs to work at all. |
| `UF_WEBHOOK_URL` | Optional. Where to POST one signed JSON body per run ending that needs a person. Blank is off, and off is the default. **Not a Discord or Slack webhook URL** — see *Getting told when a run needs you* below. |
| `UF_WEBHOOK_SECRET` | The HMAC key the receiver verifies (`openssl rand -hex 32`). Required whenever the URL is set: with the URL set and this blank, nothing is delivered and every skipped notification is logged as an error. |
| `UF_PUBLIC_URL` | Optional. The base URL this install answers on, e.g. `https://uf.example.com`. Only used to build the `url` field in that body; blank sends it empty rather than a link to somebody else's `localhost`. |
| `UF_INSTALL_LABEL` | Optional. A name for this install, so one receiver can tell two of them apart. Free text, sent verbatim. |
| `UF_NOTIFY_ON_SUCCESS` | Optional. `1` also notifies when a run finished cleanly. Blank is off, and off is the default — see *Getting told when a run needs you* below for why. |
| `UF_UID` / `UF_GID` | **Linux only.** The uid every spawned agent runs as; must own the mounts. The server itself runs as root and drops to this. Default 1000. |
| `UF_CHAT_GID` | The group the orchestrator chat runs in, which owns the per-turn MCP capability file that a concurrent agent must not read. Default 65533. **Must differ from `UF_GID`** — the server refuses to boot when they match rather than hand that file to the group it is being kept from. |
| `UF_BACKUP_DIR` | Host directory mounted at `/backups`, where `scripts/backup-db.mjs` writes. Default `./backups`, which this repository ships. Point it elsewhere and create that directory first: Docker makes a missing bind source root-owned, and the children that write it are `UF_UID`. |
| `UF_MEM_LIMIT` | What the container may take before Docker kills it. Default `10g`, sized for the shipped 4 runs plus 2 other Claude processes. |
| `UF_NODE_HEAP_MB` | The server's own heap ceiling, in MiB. Default 2048. |
| `UF_PIDS_LIMIT` | Tasks the container may hold. Default 2048. |
| `UF_CPUS` | CPUs the container may use. Unset means no quota; Docker refuses a value larger than the host has. |

The last four are one decision with *Settings → Runs at the same time* and
*Settings → Other Claude processes at the same time*: memory is linear in how
many agents run at once, and raising a setting without raising the limit gets
the container OOM-killed under load. The arithmetic, and a worked example at 25
runs, is in README's **Sizing the container**.

Compose also mounts `~/.claude` **read-write** — Claude Code writes new session
transcripts there as runs execute, so a read-only mount breaks runs.

## What the boot checks, and what each failure looks like

The variables above are the ones you set. These are the ones the app *reads*,
and it checks them once, before it serves anything — every one of these used to
present the same way, as a container that starts, answers `/login` and shows an
empty dashboard, which is also what a quiet week looks like.

| Variable | Required | Wrong value | What happens |
|---|---|---|---|
| `DATA_DIR` | **yes** | blank, not a directory, or not writable | **The container exits**, naming the path and the uid. Compose sets it to `/data`. |
| `WORKSPACE_ROOTS` | yes (compose composes it) | an entry whose path is not a directory | Warned at boot and on the dashboard. That workspace's folder picker is empty and no run can start in it. |
| `CLAUDE_HOME` | yes | no `projects/` directory under it | Warned. Every usage figure reads zero; runs, workflows and the merge queue still work. |
| `UF_AUTH_TOKEN` | no | — | Blank means **auth off**. Never reported. |
| `ANTHROPIC_ADMIN_KEY` | no | — | Blank means the API-account page says "not configured". Never reported. |
| `UF_GITHUB_TOKEN` | no | — | Blank means runs cannot use GitHub. Never reported. |
| anything else | no | set to the empty string | Warned. A blank value is read as unset and takes the default, which is a value nobody chose. |

`DATA_DIR` is the one that refuses because it is the one that decides where your
only copy of anything lives — a boot that carries on writing to a directory you
did not name is manufacturing the loss, and in the shipped image the default is
inside the container's writable layer, which `docker compose up --build`
destroys. A missing workspace only warns because compose mounts four slots
unconditionally, a bind source can be temporarily unavailable, and taking the
dashboard away over an empty folder picker is worse than the empty picker.

Writability is tested by an actual write. `mkdirSync(recursive: true)` reports
success for a directory it cannot write to, which is why an ownership mismatch
used to surface later, as an `EACCES` from the server lock rather than as a
statement about the configuration — see `UF_UID` below.

## On Linux, set `UF_UID` and `UF_GID`

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

If `id -g` comes back **65533**, set `UF_CHAT_GID` to some other unused gid in
the same file. That is the default group the orchestrator chat runs in, and it
is chosen to be one no agent is in — so a `UF_GID` that equals it refuses the
boot rather than handing the chat's capability file to the group it is being
kept from. Rare, and the symptom is a container that will not start.

Run compose as yourself, not under `sudo`: `$HOME` comes from your shell, and
`sudo` would point the credential mount at root's home.

**The database volume is handled in the image, not here, and it is deliberately
not yours.** `/data` is a named volume rather than a bind mount, so it does not
carry your host's ownership the way the other two mounts do: Docker copies the
ownership and mode of `/data` *in the image* onto the volume root the first time
it creates it. The image ships it root-owned, mode `0700`, and the server — which
is the only thing in the container running as root — creates the database there.
Every agent is dropped to the `UF_UID`/`UF_GID` you have just set, so none of
them can read or write it. That is the point: the database holds the settings
every guard reads, the budget and status on every run, and the lock that decides
whether a second writer exists. Nothing to configure.

It used to be world-writable, because the whole container ran as your uid and a
fresh volume had to be writable by whatever that was. If your install predates
that change, the existing volume is still `node:node 0777` — Docker initialises
a volume once and never again — and the container's entrypoint reclaims it on
every boot. Nothing to do, and no `chown` to run: `UF_UID` no longer has
anything to do with who owns `/data`.

If you would rather start clean, `docker compose down -v` destroys the volume
along with your run history and settings.

That volume is the only copy of every run, every cost, every template, workflow
and schedule, and nothing backs it up on its own — take a snapshot before you
try either of the commands above, and put one in cron afterwards:
**[Backup and restore](backup-and-restore.md)**.

## Optional: turn on the sandbox

Off by default, unproven, and **two switches rather than one** — the variable on
its own gets you an install that reports a sandbox and confines nothing.

The reason it exists: nothing else here bounds what an agent's shell may touch
below the uid it runs as. With this on, the container writes a root-owned policy
to `/etc/claude-code/managed-settings.json` that puts each command inside Claude
Code's own bubblewrap namespace — a deny over your `.credentials.json`, a read
deny over `/data` and `/backups`, and an egress allowlist if you name one.
[Security](security.md) has the argument and what it still does not close.

**Half one, in `.env`:**

```bash
UF_SANDBOX=1
UF_SANDBOX_ENFORCEMENT=refuse     # the default; "warn" runs unconfined instead
UF_SANDBOX_ALLOWED_DOMAINS=       # blank leaves egress alone
```

Egress is the part to add last. A domain list that is missing something a cycle
needs fails inside a tool call the run loop does not read, so get a run working
first, then start from `api.anthropic.com|github.com|registry.npmjs.org` and
expect to add to it.

**Half two, on the host.** Bubblewrap cannot create a namespace under Docker's
default seccomp profile — it fails "No permissions to create new namespace" as
root and as `UF_UID` alike — so the container needs a widened one.
`uf-seccomp.json` in the repository root is Docker's own default profile with
six syscalls ungated (`clone`, `clone3`, `unshare`, `mount`, `umount2`,
`pivot_root`); what that widens, what it does not, and how to regenerate it for
your engine are in `docker-compose.yml` beside the commented `security_opt`
block. Put it in a `docker-compose.override.yml`, which compose reads
automatically, rather than uncommenting that block — the profile has to be one
your daemon accepts, a rejected one fails the boot, and this is one machine's
answer rather than something to commit:

```yaml
services:
  usagefoundry:
    security_opt:
      - seccomp=./uf-seccomp.json
```

Then `docker compose up -d`. `security_opt` is fixed when the container is
created, so a restart does not pick it up. Deleting the override file and
running that again is how you go back — quietly, so clear `UF_SANDBOX` too.

**The half you do not set.** The profile is necessary and not sufficient: Docker
masks parts of `/proc`, and the CLI's default bubblewrap shape mounts a fresh
procfs, which the kernel refuses under those over-mounts — as root too. The
entrypoint therefore writes `"enableWeakerNestedSandbox": true` into the managed
policy on every boot, unconditionally, which switches the CLI to binding the
existing `/proc`. Nothing to configure. It is named here because it is the
reason the seccomp profile on its own still leaves you with a sandbox that
cannot start, and because it is a real weakening: a sandboxed command sees this
container's `/proc`, so sibling agents' processes are visible in it.

**Then check that it worked, because "on" is a statement about a file.** Both
the boot line and **Settings → Sandbox** read the managed policy, so both say
`on` for a sandbox whose bubblewrap cannot start:

```bash
docker compose logs usagefoundry | grep 'sandbox:'
# [usagefoundry] sandbox: on — enabled by /etc/claude-code/managed-settings.json

# the uid from the container, not from your shell — see *Sign in once* above
uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
docker compose exec --user "$uid" usagefoundry \
  bwrap --dev-bind / / --unshare-user --unshare-pid true && echo ok
# expect ok. "No permissions to create new namespace" means half two never
# arrived — no override file, or a container that was restarted, not recreated.
```

Then start one short run and read its log. A **`sandbox` row** — "bubblewrap
could not build the namespace the sandbox needs, so this command never ran" —
under a failed tool call means every `Bash` call is being wrapped in a program
that exits before the command does. Look for it deliberately: this install spent
fifteen hours in exactly that state — ten runs, 214 failed `Bash` calls,
$407 of spend between them — with nothing anywhere naming the cause, because
`UF_SANDBOX_ENFORCEMENT=refuse` does not catch it. The CLI's availability check
asks whether `bwrap` and `socat` exist and are executable; it never runs one, so
a bubblewrap the kernel refuses is not "unavailable" to it and nothing stops.

**What is not settled.** What has been run under a working sandbox on this
project is one `claude -p` that wrote a file in `/tmp` and read it back, and one
that was refused `.credentials.json` — a file its own uid can otherwise read, so
the deny is enforced rather than merely written down. No **work cycle** has run
under one: no per-run write set has ever reached a live sandbox, the egress
allowlist has never been exercised, and whether the set each child gets is wide
enough for a real cycle — `/tmp`, `$HOME/.npm` and `$GOPATH` are in it for
exactly this reason — is reasoning rather than a measurement. Expect early
cycles to fail inside tool calls, watch the first
one rather than the second, and treat this as an experiment you are running.
`docs/verification.md` carries the steps that would settle it.

## Optional: give `~/.claude` to root

Off by default, and worth understanding before you switch it on, because it is
the one setting here that changes a directory **on your host** that you use
outside this container.

The reason it exists: `~/.claude/settings.json` is one of the files Claude Code
reads its sandbox policy out of, and it belongs to the same uid your agents run
as. A run can append to it, and the next session — its own or another run's —
starts under whatever it wrote. That makes `UF_SANDBOX` and the per-run limits
this app passes each `claude` narrower than what a run can grant itself, and the
same file carries hooks, permission rules and environment for every session.

```bash
UF_LOCK_CLAUDE_HOME=1
```

`1` is the only value that switches it on, and any other non-empty value is off
with a line in the boot log saying so. Nothing else to edit — compose forwards
it. Check that it arrived anyway, because a variable that did not is
indistinguishable from a switch that is off:

```bash
docker compose exec usagefoundry sh -c 'echo "[$UF_LOCK_CLAUDE_HOME]"'   # expect [1]
```

At the next boot the container gives `~/.claude` and its `settings.json` to
root, and hands back — individually — the entries the CLI writes: `projects/`,
`sessions/`, `todos/`, `shell-snapshots/`, `history.jsonl`, `.credentials.json`,
`.claude.json` and `backups/`. `projects/` is the one that matters most: it is
every usage figure, every window and every budget guard on this dashboard, and
it stays yours. It is all or nothing — if any entry cannot be handed back,
nothing is changed at all and the boot log names the entry, the owner it wanted
and the owner it saw.

**Turn it on in this order.** Sign in, and let one real work cycle finish, before
you set the variable. A root-owned `~/.claude` is one the CLI cannot create
anything new in, so every directory it needs has to exist first. The boot
refuses outright if `projects/` is missing, and names the others it did not find
so you can decide whether you need them.

**What changes on your host.** On Linux this is your own `~/.claude`, and the
ownership change is real:

- your own Claude Code keeps working — transcripts, sessions and history are all
  entries that stayed yours;
- you can no longer create anything at the top level of `~/.claude`, and you can
  no longer edit `~/.claude/settings.json`, including through `/config`, without
  `sudo`;
- clearing the variable and restarting undoes it — the container hands the
  directory back on the first boot with it off — and by hand it is two paths
  and no `-R`, since nothing below them was ever taken:

  ```bash
  sudo chown "$(id -u):$(id -g)" ~/.claude ~/.claude/settings.json
  sudo chmod 0700 ~/.claude && sudo chmod 0600 ~/.claude/settings.json
  ```

On macOS, Docker Desktop emulates bind-mount ownership, so the `chown` may never
reach your host files — and may not confine the agents either. The entrypoint
checks from an agent's own uid after it has finished and prints a line saying so
if the change did not take. Read `docker compose logs usagefoundry | grep
LOCK_CLAUDE_HOME` before believing the boundary is there.

None of this has been run against a real container by this project.
`docs/verification.md` carries the steps that would settle it, all of them
unrun.

## Getting told when a run needs you

Unattended runs end quietly. With `UF_WEBHOOK_URL` and `UF_WEBHOOK_SECRET` both
set, this app POSTs one JSON body per ending that actually wants a person:
`needs-review`, `blocked`, `failed`, a `stopped` a **guard** caused (never one you
pressed), and the first rung of a rate-limit wait. A run that finished normally
sends nothing, and neither does a park's intermediate rungs — only the ending
they reach.

That last one is a setting rather than a rule. `UF_NOTIFY_ON_SUCCESS=1` adds
`completed` to the list, so a clean finish arrives as `run.completed`. It is off
by default because the filter's job is to stay worth reading: run twenty-five
agents unattended and a notification per success is twenty-five messages saying
nothing happened, which is how a channel becomes something you scroll past — and
the endings above are then the ones you miss. If you run a handful of runs a day
and want the "it is done" signal, turn it on; it widens `completed` and nothing
else, so the statuses a run passes through stay silent and so does a run you
cancelled yourself. Both variables are required: with the URL set and the secret blank,
nothing is delivered and each skipped notification is logged as an error, because
an unsigned body is one the receiver cannot tell from anybody else's.

The body is six fields and never more:

```json
{
  "install": "kitchen-nuc",
  "event": "run.needs_review",
  "run_id": "r-4f2a9c",
  "status": "needs-review",
  "at": 1787519327529,
  "url": "https://uf.example.com/runs/r-4f2a9c"
}
```

`at` is epoch milliseconds. `url` is empty when `UF_PUBLIC_URL` is unset. There
is deliberately no task text, no folder path, no branch, no repository, no model,
no cost and **no run title** — a title can be written by a model, and this goes
to a system with a different audience and a different lifetime. If you want to
know *what* the run was doing, the link is how you find out.

Every request carries the signature over the exact bytes of that body:

```
X-UF-Signature: sha256=<hex hmac-sha256 of the raw body, keyed with UF_WEBHOOK_SECRET>
```

Same shape as GitHub's, so most receivers already know how to check it.

**Do not point this at a Discord or Slack webhook URL.** Both accept only their
own body shape — Discord wants `{"content": …}`, Slack `{"text": …}` — so a
generic body gets a **400** and the notification is simply lost. This app does
not format for a vendor and will not grow a switch that does: choosing a vendor
in the code is what would turn one signed body into a per-vendor payload nobody
audits. Point it at something that accepts arbitrary JSON, and let *that* fan out
to Discord.

### Discord, with the relay this image ships

For Discord there is one in the box. Set two variables:

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
UF_WEBHOOK_URL=http://127.0.0.1:8787/uf
UF_WEBHOOK_SECRET=<openssl rand -hex 32>
DISCORD_MENTION_USER_ID=<your user id>          # optional, but see below
```

`DISCORD_WEBHOOK_URL` is the switch: with it set, `docker-entrypoint.sh` starts
`scripts/discord-relay.mjs` inside the container at boot and restarts it if it
dies. It listens on **loopback inside the container**, so it is reachable from
nowhere else — not from your LAN, not from the host — and its port is not
published. It verifies `X-UF-Signature` against the same `UF_WEBHOOK_SECRET` the
app signs with, reshapes the six fields into a Discord message, and forwards it.

`UF_WEBHOOK_URL` still has to name the relay. Blank means notifications are off
everywhere else in this app and the entrypoint will not quietly change that, so
setting only `DISCORD_WEBHOOK_URL` starts a relay nothing sends to. The boot log
says so.

Set `DISCORD_MENTION_USER_ID` if you want this to reach a phone. Without it the
message posts to the channel and pings nobody, which is the same silence the
webhook exists to end. It is also the *only* id the relay lets Discord act on:
mentions are sent as a whitelist, so text arriving in the body cannot ping anyone
else. Discord → Settings → Advanced → Developer Mode, then right-click yourself →
Copy User ID.

One thing this deliberately does: the entrypoint hands `DISCORD_WEBHOOK_URL` to
the relay and then **removes it from the environment** before starting the
server. Agents are spawned with a copy of the server's environment, and a webhook
URL posts to your channel on possession alone — so it is present for the relay,
which starts first and runs as root, and absent from everything downstream. A
Discord webhook remains a credential; treat a leaked one the way you would any
other and rotate it in Discord's UI.

Note that a Discord *webhook* posts to its channel and cannot send you a DM. That
needs a bot token and a server you share with the bot, which is a different thing
from what this relays.

### Home Assistant, the reference receiver

`POST /api/webhook/<webhook_id>` takes arbitrary JSON and hands it to an
automation as `trigger.json`. Set:

```
UF_WEBHOOK_URL=http://homeassistant.local:8123/api/webhook/usagefoundry-change-this-id
UF_WEBHOOK_SECRET=<openssl rand -hex 32>
UF_PUBLIC_URL=https://uf.example.com
UF_INSTALL_LABEL=kitchen-nuc
```

and, on the Home Assistant side, one automation:

```yaml
alias: UsageFoundry needs a person
triggers:
  - trigger: webhook
    webhook_id: usagefoundry-change-this-id
    allowed_methods: [POST]
    local_only: true
actions:
  - action: notify.mobile_app_your_phone
    data:
      title: "UsageFoundry {{ trigger.json.install }}: {{ trigger.json.event }}"
      message: "{{ trigger.json.run_id }} is {{ trigger.json.status }}"
      data:
        url: "{{ trigger.json.url }}"
mode: queued
max: 25
```

`mode: queued` with a `max` at least as large as `Runs at the same time` matters:
twenty-five runs can meet the same wall inside the same minute, and Home
Assistant's default `single` would drop all but the first. `local_only: true`
keeps the endpoint off the internet.

One thing to be clear about: Home Assistant's webhook trigger does **not** verify
`X-UF-Signature`. As far as it is concerned the webhook id in the URL *is* the
credential, which is why that id should be long and random and the endpoint
local. The signature is there for a receiver that can check it — a small relay,
or anything in front of the ntfy or Telegram bridges below — and checking it is
what stops anyone who learns the URL from inventing endings you never had.

### Two other receivers, in a line each

- **ntfy** takes a POST with an arbitrary body and treats it as the message text,
  so `https://ntfy.sh/<your-topic>` works immediately and shows the raw JSON on
  your phone; put a proxy in front if you want the signature verified or the
  fields formatted.
- **Telegram** needs a relay — its bot API takes `chat_id` and `text` as its own
  parameters, so like Discord it cannot be pointed at directly.

### When it stops working

Delivery is fire-and-forget: a receiver that has been refusing every POST since
Tuesday produces exactly the same silence as a fleet with nothing wrong. Every
attempt is recorded, and `/api/status` reports the count since the last success:

```json
"webhook": { "configured": true, "consecutiveFailures": 0, "lastAttemptAgeSeconds": 41 }
```

Alert on that count — README's **What to alert on** carries the threshold. Each
attempt is also one line on the container's stdout (`webhook.delivery`), with the
HTTP status and, on a failure, the message; that line is where the receiver's
hostname appears, and it deliberately does not appear on `/api/status`.

None of this has been run against a real Home Assistant instance by this
project. `docs/verification.md` says what *was* measured — a real POST, and its
signature checked by two other implementations — and what was not.

## Reaching it from another machine

Compose publishes the port on `127.0.0.1` by default, so the app answers on the
machine it runs on and nowhere else. `UF_BIND_ADDRESS` moves it — but it is
three settings, not one, and the other two fail silently:

```bash
UF_BIND_ADDRESS=0.0.0.0
UF_AUTH_TOKEN=…      # openssl rand -hex 32; UF_ALLOW_NO_AUTH must be blank
UF_COOKIE_SECURE=0   # 1 here means sign-in appears to work and then does not
```

Then `docker compose up -d` — a port binding is fixed when the container is
created, so a restart does not pick this up. Other machines reach it at
`http://<this machine's LAN address>:3000` and are asked for the token.

`UF_COOKIE_SECURE=0` is not a relaxation you can skip: a browser never returns a
`Secure` cookie over plain HTTP, so at `1` the sign-in POST succeeds, the cookie
is set, and every request after it arrives without one — a redirect loop back to
`/login` with nothing anywhere saying why.

What this is and is not: the token now crosses the network in clear, so anyone
who can watch the traffic has it, and with it the routes that start billed
agents holding write access to your workspaces. That is a defensible trade on a
home or office network you control. It is not one on a network you share with
strangers, and `UF_BIND_ADDRESS` must never name an interface a router forwards
a port to — for anything reachable from outside, put a TLS terminator in front
and set `UF_COOKIE_SECURE` back to blank.

## Multiple workspaces

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

### More than four workspaces

Four is a real ceiling, and it lives in `docker-compose.yml` rather than in the
app: compose cannot add a volume conditionally, so each slot is a hand-written
volume line and `.env` can only switch one on or off. A fifth slot in `.env`
used to be a silent no-op — never mounted, never in the picker, which is
indistinguishable from a mounted directory that happens to be empty. It now
refuses the boot instead, naming the variable:

```
UF_WORKSPACE_5_NAME is set in .env, but this deployment mounts 4 workspace
slots and a bind mount cannot be added from .env.
```

Two ways forward.

**Put the extra repositories under a directory that is already mounted.** One
mount holding fifteen repositories works, and is the simpler answer. The cost is
worth knowing: containment is per mount, so a run started in a mount holding
everything may reach everything in it, and `.uf-worktrees` is per mount, so all
of those repositories share one checkout store.

**Or mount it yourself in a `docker-compose.override.yml`**, which compose reads
automatically alongside the main file:

```yaml
services:
  usagefoundry:
    environment:
      WORKSPACE_ROOTS: "Code=/workspace|Notes=/workspace2|Extra=/workspace5"
      # This deployment really did mount the slot, so the boot must not refuse it.
      UF_UNMOUNTED_WORKSPACES: ""
    volumes:
      - /Users/you/extra:/workspace5
```

Write `WORKSPACE_ROOTS` out in full there — an override replaces the value
rather than appending to it — and clear `UF_UNMOUNTED_WORKSPACES`, which is the
one line that says the mount was actually made. Slots 5–8 are what the app
detects; a slot numbered beyond that is not configuration anyone reaches by
following `.env.example`, and is not detected.


## Windows

`Requirements` names no operating system and this app ships as one container,
so the host OS reaches almost none of it. There is one exception, and it is the
first thing a Windows operator meets.

The `.claude` mount reads **`HOME`** from the shell that invokes compose.
PowerShell and `cmd` set `USERPROFILE` instead, so `docker compose up` refuses
to start with a message about `sudo` — a command you did not run, for an
account Windows does not have. Git Bash and WSL both set `HOME` and are
unaffected.

Set `UF_CLAUDE_DIR` in `.env` instead:

```
UF_CLAUDE_DIR=C:/Users/you
```

Forward slashes: Docker Desktop accepts them, and a backslash here is read as
an escape. The path is the directory *containing* `.claude`, exactly as `HOME`
is on the other platforms, and it must already exist — Docker creates a missing
bind source rather than refusing, and an empty one produces a dashboard of
zeros, which is also what a quiet week looks like.

`UF_WORKSPACE` takes a Windows path in the same form
(`UF_WORKSPACE=C:/Users/you/code`). Everything else in `.env` is read inside
the container and is unaffected by the host.

### Line endings

Git for Windows installs with `core.autocrlf=true`, which rewrites text files to
CRLF as it checks them out. `docker-entrypoint.sh` is copied into the image and
run as PID 1, and a CRLF shebang is not cosmetic: the kernel reads the carriage
return as part of the interpreter's name and the container exits immediately
with

```
/bin/sh: /usr/local/bin/uf-entrypoint: not found
```

which names a file that is plainly there. The missing thing is `/bin/sh\r`, and
the message never says so.

The `.gitattributes` at the repository root pins this tree to LF, so a fresh
clone is already correct and nothing needs doing, and the attribute overrides
`core.autocrlf`, so there is no global Git setting to change.

A clone taken **before** that file existed can still be CRLF on disk. Rebuild
the index against the attributes:

```
git rm --cached -r .
git reset --hard
```

`file docker-entrypoint.sh` should then report `POSIX shell script` with no
`CRLF line terminators`. Note that `git add --renormalize . && git checkout -- .`
— the usual advice — does **not** fix it: renormalize updates the index, but
checkout skips files whose stat data still looks current, so the CRLF copy in
the working tree survives. Both commands were run against a clone made with
`core.autocrlf=true`; only the pair above changed the bytes on disk.

**What is not claimed here.** CI runs on linux/amd64 and linux/arm64, so
neither Windows nor macOS is covered by an automated build. The mount above was
verified by interpolation - `docker compose config` with `HOME` unset and
`UF_CLAUDE_DIR` set resolves the bind source correctly, and with both unset it
still refuses - but no run of this app has been executed on Windows by its
author. If you are the first, the two things worth reporting are whether the
container starts and whether the dashboard shows non-zero usage.
