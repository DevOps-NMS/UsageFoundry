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

## Everything else

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
