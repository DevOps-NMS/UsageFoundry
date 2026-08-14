# Installation and setup

[← Documentation index](README.md)

Getting the container running, signed in, and pointed at your code.

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

## Sign in once, inside the container

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

With it set, each work cycle is spawned with `GH_TOKEN`/`GITHUB_TOKEN` for the
`gh` CLI, a git credential helper for `github.com`, and a rewrite of
`git@github.com:` remotes to HTTPS — the container holds no SSH key, so a
repository cloned over SSH could otherwise never authenticate while one cloned
over HTTPS could, which is what makes this fail on some runs and not others.
Those variables reach the agent and nothing else: not the reviewer, and not the
git this app itself runs, whose children execute repository-controlled hooks.
Settings shows whether a token is configured.

## Required environment

| Variable | Purpose |
|---|---|
| `UF_WORKSPACE` | Host directory mounted at `/workspace`. Runs are confined to it. Absolute path; compose refuses to start without it. |
| `UF_AUTH_TOKEN` | Shared secret for the UI. Blank disables auth — only acceptable on loopback. |
| `ANTHROPIC_ADMIN_KEY` | Optional. Enables the API-account page. Org Admin key only. |
| `UF_GITHUB_TOKEN` | Optional. What a run pushes, opens PRs and reads issues with. Reaches the agent only. |
| `UF_UID` / `UF_GID` | **Linux only.** The uid every spawned agent runs as; must own the mounts. The server itself runs as root and drops to this. Default 1000. |

Compose also mounts `~/.claude` **read-write** — Claude Code writes new session
transcripts there as runs execute, so a read-only mount breaks runs.

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
