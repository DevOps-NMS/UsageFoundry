# What a run can reach today

Everything below was verified from inside a live work cycle — a `claude` child this
app spawned, running as `UF_AGENT_UID` in the shipped container — on 2026-08-15.
Commands and their output are quoted rather than described.

## The shape

One container. `docker-compose.yml:49` runs it as `user: "0:0"`;
`src/lib/privsep.ts:154`'s `childCredentials()` is spread into all five spawn sites
— the work cycle (`src/lib/orchestrator.ts:4799`), the reviewer
(`src/lib/review.ts:613`), the chat's, which serves an orchestrator block too
(`src/lib/chat.ts:1659`), and both of git's (`src/lib/git.ts:127`, `:179`) —
dropping each to the operator's own uid. The server stays root. A work cycle is
`spawn(CLAUDE_BIN, args, …)`, no shell, `stdio: ["ignore","pipe","pipe"]`, own
process group, `cwd` a git worktree under `<mountRoot>/.uf-worktrees/`
(`src/lib/orchestrator.ts:1736`, `:4793`).

> Corrected by `10-validation.md`, which counted them: **five**, not six.
> `privsep.ts:148`–`149` says "both of `chat.ts`'s" and is itself stale — there is
> one `spawn` in `chat.ts`, and `docs/agent/architecture.md:102` explains why
> (`runOrchestratorChild` exists so a block is the same call site, not a fifth).

**Six** host bind mounts, one named volume for the database, one for Go's caches
(`docker-compose.yml:163`–`231`): the four workspaces, `~/.claude`, and
`${UF_BACKUP_DIR:-./backups}` at `/backups`.
`grep " /workspace" /proc/self/mountinfo` shows three of the four workspace slots
resolving to the *same* host directory, and every bind mount carried over
`fakeowner /run/host_mark/Users` — Docker Desktop for macOS, the remapping
`docs/agent/environment.md:22` describes. It matters below, because it means
bind-mount uid ownership inside the container is *presented* rather than enforced
by the host filesystem.

## What is already closed, and it is not nothing

The privilege split does what `docs/security.md:8`–`55` says. Measured from an
agent:

    $ stat -c '%u:%g %a' /data     →  0:0 700
    $ test -r /data                →  not readable
    $ tr '\0' '\n' < /proc/7/environ
      /bin/bash: /proc/7/environ: Permission denied

The database, the settings every guard reads, the server lock, `UF_AUTH_TOKEN` and
`ANTHROPIC_ADMIN_KEY` are all out of reach. Any proposal that trades this away has
gone backwards.

## What is open

**The account's OAuth credential**, as `docs/security.md:64` says it must be:

    $ test -r /home/node/.claude/.credentials.json  →  READABLE by uid 1000

**Another run's work — the case with no boundary at all.** Every child of every
kind takes the same uid, and every worktree lives in one store on one mount:

    $ ls /workspace/.uf-worktrees/ | wc -l          →  19
    $ test -w /workspace/.uf-worktrees/ghtranslator-3064a683ade3-1/
                                                    →  WRITABLE by uid 1000

A run can edit a concurrent run's checkout, its branch and its seeded config, and
nothing detects it: the second run's commits are simply not what its agent wrote,
and `land.ts` will merge them. `docs/security.md:72` covers this by implication —
"treat all four workspaces as one blast radius" — but does not name it, and the
between-runs case is the one a reader of a *concurrency* feature goes looking for.

**The settings file the CLI itself reads.** Added by `10-validation.md`, and the
one that decides whether any of the options below can work:

    $ ls -ld /home/node/.claude              →  drwx------ node node
    $ test -w /home/node/.claude/settings.json  →  WRITABLE by uid 1000
    $ env | grep CLAUDE_CONFIG_DIR           →  CLAUDE_CONFIG_DIR=/home/node/.claude

Every one of the 25 entries under `~/.claude` is owned by the agent's uid,
because that is the same directory the CLI writes transcripts into and the whole
metering path depends on its being writable. A run can therefore rewrite the
user-level settings the *next* session — its own or a sibling's — starts under.

**The operator's database backups.** `/backups` is a sixth bind mount onto a host
directory, absent from the table in `README.md` until `10-validation.md` added it:

    $ test -w /backups                       →  WRITABLE by uid 1000

Nothing writes there unless the operator runs `scripts/backup-db.mjs`, which
bounds it. But that script defaults to `/backups` whenever it is a directory
(`scripts/backup-db.mjs:96`–`104`), and what it puts there is a copy of the
database that `/data`'s `0:0 700` exists to keep out of reach.

**A sibling's capability token.** `/proc/<pid>/cmdline` is world-readable and
carries `--mcp-config <path>`; the file behind it is 0600 owned by the same uid
that would read it (`docs/security.md:87`). The server's cmdline is readable too —
`tr '\0' ' ' < /proc/7/cmdline` gives `next-server (v…)` — which is what makes the
deny of `Bash(pkill:*)`/`Bash(killall:*)` (`src/lib/orchestrator.ts:4482`) a
tool-policy rule rather than a kernel one.

**The network, entirely**, plus `UF_GITHUB_TOKEN` in the cycle's environment
(`githubEnv()`, `src/lib/orchestrator.ts:4698`) for as long as it lasts:

    $ curl -o /dev/null -w '%{http_code}' https://example.com  →  200
    $ curl -o /dev/null -w '%{http_code}' https://pypi.org     →  200

**The kernel.** Default Docker confinement and no more:

    $ grep CapBnd /proc/self/status        →  00000000a80425fb  (Docker's default set)
    $ unshare --user --map-root-user id    →  unshare failed: Operation not permitted
    $ stat -fc %T /sys/fs/cgroup           →  cgroup2fs
    $ uname -r                             →  6.12.76-linuxkit  (aarch64)

`CAP_SYS_ADMIN` is absent, so no option below can create a mount namespace without
a capability grant or a seccomp change. `CAP_SYS_CHROOT` *is* in the bounding set,
a smaller lever than it looks: a chroot with no mount namespace cannot hide
`/proc`.

`10-validation.md` re-ran these and closed the question of *which* mechanism
refuses. It is seccomp, and only seccomp:

    $ unshare -U true                        →  Operation not permitted   (needs no capability)
    $ cat /proc/sys/user/max_user_namespaces →  31734                     (kernel permits them)
    $ grep -E 'CapEff|Seccomp' /proc/self/status
      CapEff: 0000000000000000  Seccomp: 2  Seccomp_filters: 1

So the lever the options below reach for is `security_opt`, not `cap_add` — and
`CapEff` being zero is worth reading beside `CapBnd`, which is what the process
*may* acquire rather than what it holds.

## The threat this is actually about

Not a malicious operator, but a prompt-injected or simply confused agent,
unattended at `acceptEdits`, whose instructions came out of a GitHub issue, a
README or a dependency's source nobody here reviewed — the population
`src/lib/privsep.ts:32` calls "the twenty-five unattended agents". What such a run
can do today that has nothing to do with its task includes reading the subscription
credential, rewriting a sibling run's branch, exfiltrating anything under three
host directories to any host on the internet, and holding `UF_GITHUB_TOKEN` while
doing it.
