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
- **A concurrent chat turn's MCP capability, if it can find the path.** The
  config file carrying it is no longer in `/tmp` — it is 0600 in a 0700 per-turn
  directory under a base the server owns and nothing else can list, and both go
  when the turn ends. But `--mcp-config <path>` is on the child's command line
  and `/proc/<pid>/cmdline` is world-readable, so an agent that catches a turn
  in flight can still read a capability it did not mint. That closes when a chat
  turn runs as a different uid from a work cycle, which needs a second Claude
  credential a subscription install does not have. What it opens is bounded by
  its subject and dies with the turn: read-mostly tools for a `chat`, and
  `emit_runs` — inside the block's own folder and fan-out cap — for a `block`.

There is one thing the split *does* close that reads similarly and is worth not
confusing with the above: an agent can no longer read the **server's**
environment out of `/proc`, so `UF_AUTH_TOKEN` and `ANTHROPIC_ADMIN_KEY` — the
app's own master credential and an organisation-wide Admin key, neither of which
has anything to do with the task the agent was given — are no longer reachable.

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
