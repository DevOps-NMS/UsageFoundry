# Security

[← Documentation index](README.md)

This container holds your Claude credentials and runs an agent that can modify
mounted code. Treat it as privileged.

## Which uid runs what

The **server** runs as root inside the container. Every child it spawns — the
work cycle, the reviewer, the orchestrator chat, an orchestrator block's turn,
and the git this app runs on its own behalf — is dropped to
`UF_AGENT_UID`:`UF_AGENT_GID`, which `docker-compose.yml` fills from your own
`UF_UID`/`UF_GID`. Nothing about your files changes: the processes that write
the bind mounts are the uid they always were.

What changes is that they are no longer the server's uid, and three of this
app's defences are file modes that said nothing while they were:

- `/proc/<server>/environ` is mode 0400 owned by the server. `childEnv` deletes
  `UF_*`, `ANTHROPIC_ADMIN_KEY` and `DATA_DIR` from an agent's environment, and
  before the split one `tr '\0' '\n' < /proc/<server pid>/environ` handed every
  one of them back — `UF_AUTH_TOKEN`, the Admin key, the GitHub token.
- `/data` is root-owned `0700`. An agent that can write the database rewrites a
  budget, a run's status or `chatDefaultGuards.permissionMode` with no HTTP
  request and no token, and can edit the lock `serverLock.ts` uses to decide
  whether a second writer exists.
- the MCP capability file is written `0600`, which excludes nobody when the
  reader owns it.

The chat and a workflow's orchestrator block take that same uid and a
**different group**, `UF_CHAT_GID` (65533 in the shipped image, as `ufchat`).
That group owns the per-turn MCP capability file — `0710` on its directory and
`0040` on the file — so a work-cycle agent that knows the exact path fails the
owner check, fails the group check, and is left with the "other" bits, which are
zero. It is a group rather than a second uid because the chat child has to stay
the uid that owns the mounted `~/.claude`: that credential is what it
authenticates and bills with, and a second uid would need a second Claude
account. The server refuses to boot when `UF_CHAT_GID` equals the gid the agents
run as, since the file would then be handed to the group it is kept from.

One visible consequence: files a chat turn writes — its own transcript under the
mounted `~/.claude`, anything it touches in a checkout — carry that group, so
`ls -l` on the host shows `65533` where a group name usually is. Nothing reads
them by group. Every one is still owned by your uid, which is what both the
other agents and the CLI's own 0600 credential file go through.

It has to be this way round. The child must be the uid that owns the bind
mounts, because an isolated run is *ordered* to commit and its commits land in
your own `<repo>/.git`; and the server must be able to read
`~/.claude/.credentials.json`, which the CLI keeps at `0600` owned by that same
uid. Both cannot be it, so the privileged half is the one process running code
from this repository rather than the unattended agents whose prompts came out of
repositories nobody here reviewed.

Verify it on a running container:

```sh
docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
  'tr "\0" "\n" < /proc/$(pgrep -f "next-server" | head -1)/environ | grep -c UF_'
# expect a permission error, not a count

docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
  'test -w /data/usagefoundry.db && echo BAD-writable || echo ok'

# and, with a run working and a chat turn sent at the same time — the config
# a live turn is using, found the way an agent would find it
docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
  'for p in $(pgrep -x claude); do
     tr "\0" "\n" < /proc/$p/cmdline | grep -A1 -x -- --mcp-config | tail -1
   done | while read -r cfg; do
     [ -n "$cfg" ] && { [ -r "$cfg" ] && echo BAD-readable || echo ok; }
   done'
```

**Switching it off is possible and silent by nature**, so the server says which
arrangement it is in on every boot (`privilege separation on: …` / `off: …`).
Clearing `UF_AGENT_UID` runs everything as root, which is worse than the shared
arrangement this replaced; pinning `user:` back to your own uid while leaving
`UF_AGENT_UID` set makes the server refuse to boot rather than start without the
boundary.

## What an agent can still reach

The split is not a sandbox. Three things it does not do are worth sizing before
you run this unattended, because each is a place where a prompt injection — in a
GitHub issue, a README, a dependency's source, anything the agent was told to
read — reaches something that is not this run's business.

- **Your Claude account's own credential.** A work cycle runs as the uid that
  owns the mounted `~/.claude`, so it can read `.credentials.json`: the OAuth
  token for the whole subscription, not for one run. This is not a permission
  that was left open. It is the credential the agent authenticates and bills
  with, so *any* arrangement in which a run can work is one in which it can read
  that token; the only real fix is a credential scoped to a run, which Claude
  Code does not have. `acceptEdits`, the default, auto-approves read-only shell,
  so a `cat` of it raises no prompt.
- **Every mount, not just the one the run started in.** Containment
  (`resolveInMount`, `resolveWorkspaceFolder`) decides the folder a run may be
  *started* in, and therefore its cwd — that part is sound, checked before any
  filesystem access and again after symlink resolution. But a `Bash` call is not
  bounded by cwd, and `--add-dir` names every configured mount. Treat all four
  workspaces as one blast radius.
- **A concurrent run's checkout, and the branch that checkout will land.** This
  is the sharp form of the point above and the one worth stating on its own,
  because it is the case a reader of a *concurrency* feature comes looking for.
  Every isolated run gets a worktree under `<mount>/.uf-worktrees/`, they are all
  in one store on one mount, and every child of every kind is the same uid — so
  there is no boundary between two runs at all, rather than a weak one. A run can
  edit a run that is working beside it: its files, its seeded config, and the
  branch it is committing to. Nothing detects that. The second run's commits are
  simply not what its agent wrote, and Land merges them into your repository like
  any other work. Measure it from an agent's uid against any slot that is not the
  one you are asking about:

  ```sh
  docker compose exec --user "${UF_UID:-1000}" usagefoundry sh -c \
    'test -w /workspace/.uf-worktrees/<another-run>/ && echo BAD-writable || echo ok'
  # expect BAD-writable, today: this is a gap, not a check you are confirming
  ```
- **`UF_GITHUB_TOKEN`, for as long as the cycle lasts.** It is deliberately
  handed to work cycles (and the chat), because `git push` and `gh` cannot work
  without it. An unattended agent can use everything that token can, which is
  why the advice to scope it to the repositories you actually run agents against
  is in `.env.example` rather than here.
- **What a stolen capability would open, if one could be stolen.** This is the
  one in this list that is now closed rather than sized, and it is here because
  the shape of it matters: the config file is no longer in `/tmp`, and it is no
  longer owned by the uid that would read it. An agent that catches a turn in
  flight can still find the path — `--mcp-config <path>` is on the child's
  command line and `/proc/<pid>/cmdline` is world-readable — and opening it
  fails on the group. Clearing `UF_CHAT_GID`, or running without privilege
  separation at all, puts this back: the boot log says which arrangement you are
  in. What a capability opens is bounded by its subject and dies with the turn —
  read-mostly tools for a `chat`, and `emit_runs`, inside the block's own folder
  and fan-out cap, for a `block` — and `get_run_diff` is scoped to the caller's
  own runs, so neither reaches the patch of a run in a repository it was not
  working in.

There is one thing the split *does* close that reads similarly and is worth not
confusing with the above: an agent can no longer read the **server's**
environment out of `/proc`, so `UF_AUTH_TOKEN` and `ANTHROPIC_ADMIN_KEY` — the
app's own master credential and an organisation-wide Admin key, neither of which
has anything to do with the task the agent was given — are no longer reachable.

There is now a switch that reaches the first of the five, and it is **off, and
barely proven**. `UF_SANDBOX=1` (see `.env.example`) has the container write a
root-owned policy that puts each of an agent's commands inside Claude Code's own
bubblewrap namespace, with a deny over `~/.claude/.credentials.json` — the first
mechanism here that makes a `cat` of your token fail inside a run while the
session still bills — plus a read deny over `/data` and `/backups` and, if you
name domains, an egress allowlist.

Switching it on is two things on the host and one that happens for you. It needs
the `security_opt` block from `docker-compose.yml` — best placed in a
`docker-compose.override.yml`, which compose merges automatically — because
bubblewrap cannot create a namespace under Docker's default seccomp profile.
With that profile applied it can, at both uids, measured against this image. The
profile is still not sufficient: Docker masks parts of `/proc`, and the CLI's
default bubblewrap shape mounts a fresh procfs, which the kernel then refuses —
as root as well. So the entrypoint writes `enableWeakerNestedSandbox` into the
managed policy unconditionally, switching the CLI to binding the existing
`/proc`. That is the half you do not configure, and the CLI's name for it is
honest: a sandboxed command sees this container's `/proc`, so a sibling agent's
processes are visible in it — a boundary this container never had anyway, since
every agent here is one uid. `docs/install.md` has the procedure.

**A sandbox reported as "on" is not a sandbox that is working, and the gap is
not theoretical.** The boot line (`sandbox: on — …`) and **Settings → Sandbox**
both read the managed policy file: they say what is *configured*. Whether
bubblewrap can build a namespace is a property of a process, and the CLI does
not check that either — its availability probe asks only whether `bwrap` and
`socat` exist and are executable, never runs one, so `failIfUnavailable`, which
is what `UF_SANDBOX_ENFORCEMENT=refuse` sets, never fires against a bubblewrap
the kernel refuses. Every `Bash` call is instead wrapped in a program that exits
1 before the command runs. On this install that lasted fifteen hours: ten
runs, 214 failed `Bash` calls, $407 of spend, and nothing in
`run_events` naming a cause — from the outside, agents that had stopped being
productive. What surfaces it is a **`sandbox` row on the run's log**, under the
`tool failed` row for the same call, reading "bubblewrap could not build the
namespace the sandbox needs, so this command never ran". Look for it on the
first run after switching this on. Its presence means nothing was executed; its
absence is not evidence that anything was confined, because a policy denial
comes back out of a mount namespace as an ordinary `EACCES` and this app
deliberately does not claim those.

Two things it is still not. It does **not** close the third bullet above: the
policy is install-wide and names no per-run paths, so a run can still write a
concurrent run's checkout. And **no work cycle has yet run under a
sandbox that started here.** What has been executed against this image is
bubblewrap itself and two `claude -p` calls: one ran a shell command through a
live sandbox, and one was refused `.credentials.json` — a file the agent's own
uid can otherwise read — which is the credential deny enforced rather than
reported. Nothing more. The egress allowlist has never been exercised, no
per-run write set has ever reached a live sandbox, and whether the set each
child is given is wide enough for a real work cycle is reasoning rather than a
measurement. Turning it on is an experiment you are
running rather than a control you are enabling. `docs/verification.md` carries
every step that would settle it.

**And one more surface, which is a policy file rather than a path.**
`~/.claude/settings.json` is one of the sources Claude Code merges a sandbox
policy from — the managed file above, `--settings` on the command line, and
*user settings* — and it is owned by the uid the agents run as. A run that
appends `{"sandbox":{"filesystem":{"allowWrite":["/"]}}}` to it widens the
policy every later session starts under, its own and every sibling's; while that
is true, the paragraph above describes a boundary a run can move. The same file
also carries hooks, permission rules and environment for every session, so this
is not only about the sandbox. `UF_LOCK_CLAUDE_HOME=1` closes it by giving
`~/.claude` **and** that file to root at boot, then handing back, individually,
the entries the CLI writes — `projects/` first, because that is the metering
path every window and every guard reads. Both halves are load-bearing: a
root-owned file inside a directory the agents own is a file they can delete and
replace. It is off by default and it is a separate switch from `UF_SANDBOX` in
both directions, because each is worth having without the other. What it costs:
it changes a directory on your **host** that you also use outside this
container, and `docs/install.md` says exactly what you lose and how to undo it.
On macOS the platform emulates bind-mount ownership, so the `chown` may reach
neither your files nor the agents — the entrypoint asks an agent's own uid
whether it can still write that file and says so on the boot log, and that line
is the only evidence here that the boundary exists.

**This app can now put a hook on that path itself, and it ships off.**
Settings → *Read guard* generates a small plugin directory of this app's own —
a `PreToolUse` hook that refuses a whole re-read of a file the session has
already read, and a whole read past a token cap — and hands it to every work
cycle on the same `--plugin-dir` list the vault skill rides. It only ever
refuses, never grants, which is what bounds everything that follows. The code
is written root-owned and `0755` under `/run`, so every agent uid can read it
and none can rewrite it: a sibling able to edit that script would be on the tool
path of every call another run makes. What agents *do* write is the ledger
beside it, in a separate world-writable directory carrying the sticky bit, so
one run cannot unlink or replace another's by name. What a sibling can still do
is write into a ledger whose session id it guessed, and the worst that buys is a
read refused in a run that was not asking for it — which that run gets around
with a ranged read, because a ranged read is always allowed. One thing to know
before you weigh any of that: whether the CLI registers a plugin's *hooks* at
all, as opposed to its skills, has never been observed here, so switching this
on may do nothing whatever. `docs/verification.md` carries what would settle it.

## Everything else

- Compose binds to **`127.0.0.1:3000`**, not `0.0.0.0`. `UF_BIND_ADDRESS` moves
  it, and moving it is three settings rather than one: `UF_AUTH_TOKEN` set,
  `UF_ALLOW_NO_AUTH` blank, and `UF_COOKIE_SECURE` at `0` rather than `1` unless
  there is TLS in front. On a LAN that is a shared secret crossing plain HTTP —
  defensible on a network you control, not a substitute for TLS, and never on an
  interface a router forwards to.
- Set `UF_AUTH_TOKEN` (`openssl rand -hex 32`). Leaving it blank makes the
  server refuse to start; the only way past that is `UF_ALLOW_NO_AUTH=1`, which
  runs with no authentication and puts a banner on every page saying so.
- **`/api/login` is rate-limited.** Ten consecutive failures from one address
  lock that address out for 15 minutes; 100 failures across every address lock
  sign-in install-wide for 60 seconds, which is what still bounds an attacker
  who forges `X-Forwarded-For`. A locked-out attempt answers exactly what a
  wrong token answers, with a `Retry-After`. Failures are kept in the database
  and **Settings → Failed sign-ins** shows the count and when they started and
  stopped. A correct token clears both counters.
- The `uf_session` cookie is a **signed session handle, not the token**: 32
  random bytes naming a row in `auth_sessions`, plus an absolute 24-hour expiry,
  signed with `UF_AUTH_TOKEN`. It cannot be replayed as a bearer credential, and
  **Settings → Sign-in** ends one session or all of them without a restart.
  `Secure` is set whenever the request reached the app over HTTPS
  (`x-forwarded-proto` first, then the URL); `UF_COOKIE_SECURE=1`/`0` overrides
  it either way for a terminator that sets no header, or for loopback.
  One limit worth knowing: the gate runs in the edge runtime and cannot read the
  database, so a revoked session's cookie — if somebody *captured* it — stays
  valid until its own expiry. Rotating `UF_AUTH_TOKEN` invalidates every cookie
  at once, and still costs a restart.
- Folder input is resolved and containment-checked **before** filesystem access,
  and again after symlink resolution. `../`, absolute paths, and symlinks out of
  the tree are all rejected.
- With several workspaces mounted, containment is checked against **one mount at
  a time**, never their union, so a path valid in one workspace is rejected in
  another. That decides which folder a run may be *given*; it does not confine
  what the agent's shell can then touch — see "What an agent can still reach".
- The agent is spawned with an argument array and **no shell**, so a prompt
  containing shell metacharacters is inert.
- `bypassPermissions` lets the agent run any command in the mounted folder
  without asking. The UI warns; the default is `acceptEdits`.
- A run's telemetry exporter authenticates with a capability minted for that
  run and revoked when it ends, never with `UF_AUTH_TOKEN`. It used to carry
  the app's master token, in the agent's own environment, in a variable `env`
  prints. The ingest route is exempt from the shared-secret gate and checks
  that capability itself — as `/api/mcp` does, and for the same reason.
- **A credential-free request to `/api/mcp` is refused without writing to the
  audit log.** That is deliberate and it is the one place a request is
  mutating-shaped and not audited. `request_log` keeps its newest 20,000 lines
  and evicts on every insert, so a row written for a request that passed nothing
  is a lever on the table: twenty thousand refusals, and every line naming a run
  that was started or a sign-in that failed is gone. The refusal is logged to
  stdout instead — visible to whatever reads your container logs, and out of
  reach of the cap. A tool call refused under a capability that *is* valid is
  audited as before.
- `UF_GITHUB_TOKEN` is handed to the agent's work cycles and to nothing else.
  The reviewer does not get it (it cannot write), and neither does the git this
  app runs itself — `worktree add` and `merge` execute hooks the repository
  controls, and this app's own git never touches the network. The credential
  helper is scoped to `https://github.com`, so another host asking for
  credentials gets none.
- *Which* token a work cycle gets is chosen from the repository it is working
  in. `UF_GITHUB_TOKENS` maps a folder to a credential; a run in that folder
  gets that one and no other, and a folder no entry names falls back to
  `UF_GITHUB_TOKEN` — blank there means no credential rather than a wide one.
  This narrows how far a compromised or badly-instructed agent reaches; it does
  not narrow the helper, which still answers for `github.com` as a whole, so the
  token you name has to be scoped on GitHub's side too. The withholding above is
  by namespace, so `UF_GITHUB_TOKENS` never reaches the reviewer or this app's
  own git either.
