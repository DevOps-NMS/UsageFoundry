# Option E — one container per run

The server creates a container per run, runs the cycle in it, destroys it after.

## Shape

`startRun` stops calling `spawn` and starts calling a container runtime. The
container gets the run's worktree, the repository's `.git`, `~/.claude`, a network
and nothing else, and is destroyed when the run ends — or when the *cycle* ends, if
a resumed session must not inherit a compromised filesystem, which doubles the
start-up count.

Whatever creates it needs a control socket, and each way of having one has a price.
**Mounting `/var/run/docker.sock` is root on the host**: anything that can talk to
that socket can start a privileged container bind-mounting `/`. The server would be
trading a container boundary for host root, which makes this option's security
story **net negative**, and no care in the calling code changes it — the socket's
authority is the socket's. Docker-in-Docker needs `--privileged` and arrives at the
same place. Only a **filtering socket proxy** (or rootless Podman with a user
socket) is worth arguing: fixed image, fixed mount set, no `--privileged`, no
`exec`. A real reduction, and a new security-critical component this app would own,
of the class where one missing check restores host root.

## Isolation gained

The strongest filesystem and process isolation short of `06`: own mount table, own
`/proc`, own pid 1, own network stack, own cgroup — so `pids_limit` and `mem_limit`
become **per run** rather than per fleet, which no other option here achieves. A
fork bomb in agent-authored code takes down one run instead of eating the
container's shared 2048 tasks (`docker-compose.yml:286`). Between two runs: closed,
as completely as containers close anything. Kernel surface unchanged, with 25 more
attack surfaces on it.

## The five it must not break

**The credential.** `~/.claude` mounted into each container, so 25 hold the account
credential where one does today — worse on the axis that matters most, unless
paired with `02x`'s deny entry, which needs no containers.

**Metering.** `03`'s silent-zero failure multiplied by the run count and by every
code path that assembles a mount list.

**Telemetry.** The exporter reaches the server from a separate network namespace,
so `OTLP_SELF_URL` becomes a host-gateway address or a shared network and
`src/middleware.ts:81`'s exemption opens onto it. The MCP surface is the same
problem with a worse payload — `emit_runs` and the folder walk
(`docs/agent/chat.md`) — reachable from any per-run container that guesses the URL.

**The work.** The `.git` pointer (`01-constraints.md`) forces the whole repository
into the mount set, so two runs on one repository each mount the same `.git`
writable and can rewrite each other's refs. A substantial hole in the option's
headline claim, structural rather than configurable.

**Toolchain and arithmetic.** The image is the runner image: ~250 MB of apt plus Go
plus a 294,566,840-byte CLI binary. Creation from a warm local image is fast; the
CLI's own start-up is not, and now happens behind a cold page cache each time. At
25 concurrent runs `docker-compose.yml`'s single-container arithmetic stops
applying — `mem_limit` no longer bounds the fleet and the host becomes the only
ceiling, a *regression* in what `docker-compose.yml:233`–`271` exists to provide
unless per-run limits are set with equal care.

## What it requires of the host

A container control socket, which is the whole objection. On Docker Desktop for
macOS — the platform this install runs, per `00-problem.md`'s `fakeowner` mount —
that socket is the VM's Docker, so "host root" means root in the Docker Desktop VM
rather than on macOS: a real mitigation on that platform and **not** one on Linux,
where it is root on the operator's machine. An install document saying "this is
safe" would need a platform matrix, which `docs/security.md` has nowhere else.

## Failure modes

A mount list assembled per run can omit something, and every omission fails inside
a tool call. A container outliving its run leaks until the host fills. And `docker
compose down` does not know about dynamically created containers, so it leaves 25
agents running against the operator's repositories with no server watching and no
`reconcileOnBoot` to close them out — the shutdown accounting in
`docs/agent/concurrency-and-ownership.md:16` assumes the children are this
process's, and here they are not.

## Cost

The largest in the survey: a new spawn abstraction across four call sites, a socket
proxy this app owns and must keep correct, per-run limits, a lifecycle that
survives a server restart, an install document with a platform matrix, and a
rewrite of `README.md`'s sizing section. Six weeks is optimistic, and the security
story is negative unless the proxy is right.
