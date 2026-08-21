# Option C — a runner container (the operator's sketch, first half)

A second compose service running every `claude` child. The server container keeps
the database, the HTTP surface and the run loop.

## Shape

`usagefoundry-runner`, built from a second stage carrying `gh`, Go, the compiler
and the pinned CLI, mounting the four workspaces and `~/.claude` but **not**
`usagefoundry-data`. The server sheds the agent toolchain and keeps `git`, which
it runs itself (`src/lib/git.ts:124`, `:176`).

How the server reaches the runner is the whole design question. A **supervisor
process in the runner** over a unix socket on a shared volume — `{cwd, argv, env}`
in, stdout stream and exit code out, `signalTree` becoming a message — is the only
variant worth arguing, and it is a **fifth kind of child** in the sense
`docs/agent/architecture.md:102` means it. `docker exec` needs a Docker socket,
which is root on the host (`05-option-per-run-container.md`). The runner polling
the database is out immediately: one writer per `DATA_DIR`, and `createRun`'s
atomicity is one event loop (`docs/agent/concurrency-and-ownership.md:10`, `:14`).

## Isolation gained

The agents lose the server's process table, so `/proc/7/cmdline` and everything
future in it stop existing for them; they lose `/data` by *absence* rather than by
a 0700 mode; and the runner gets its own network policy and its own limits. That
last is an architectural improvement independent of security — today a fleet that
OOMs takes the server with it, which is what `docker-compose.yml:233`'s arithmetic
exists to manage. Split, the server's 2.5 GiB is protected from the agents' 44.

**Between two concurrent runs: nothing changes.** Same container, same uid, same
mounts, same `/proc`. The peer worktree that was writable in `00-problem.md` still
is. That is the option's central weakness and the reason `04` exists. Kernel
surface unchanged — two containers, one kernel.

## The five it must not break

**The credential.** `~/.claude` mounted into the runner whole, and into the server
for `transcripts.ts`. Unchanged exposure, no gain.

**Metering.** Survives *if* both containers mount the same host `~/.claude` at the
same path. If they do not, the runner writes transcripts into its own writable
layer, the scan finds nothing, every window reads zero, every guard compares
against zero, and nothing throws — while `configCheck.ts` only warns on a
`CLAUDE_HOME` with no `projects/` (`docs/agent/environment.md:17`). The worst
failure in this document.

**Telemetry.** `OTLP_SELF_URL` and `MCP_SELF_URL` (`src/lib/config.ts:108`, `:127`)
become `http://usagefoundry:3000/…` across the compose network.
`src/middleware.ts:66` and `:81` exempt both install-wide on the reasoning that
each authenticates itself with a capability — which holds, but the blast radius
changes: a loopback-only tool surface becomes reachable by anything on that
network. Needs an internal network with no other members or a second listener, and
either way it is a change to `middleware.ts`'s five-exemption argument that has to
be written down there.

**The work.** Unchanged if the runner mounts the workspaces at identical paths as
the same `UF_AGENT_UID`. `resolveInMount` (`src/lib/orchestrator.ts:654`) validates
in the *server's* view and the child uses the result in the runner's, so the two
views must be identical or containment is checked against a filesystem the child
does not have — a new invariant, of exactly the silent kind.

**Toolchain and arithmetic.** Better on balance: the server image sheds ~250 MB of
apt plus Go plus the 294,566,840-byte CLI binary, start-up is unchanged (the runner
is long-lived, so a run is still one spawn), and at 25 concurrent runs the memory
arithmetic splits into two limits set independently.

## What it requires of the host

Nothing beyond Docker Compose, in the supervisor variant — no socket, no
privileges, no runtime, no kernel floor. Its second real strength: the only
structural option with a neutral host-security story.

## Failure modes

The transcript-path mismatch above, silent and total. A dead supervisor leaves the
run loop awaiting a stream that never arrives — `runIteration`'s silence watchdog
(`src/lib/orchestrator.ts:4766`) eventually files it as a hung agent. Signal
delivery becomes a message, so `signalTree` (`:4738`) can fail without the loop
knowing, and `cancelled` is checked twice per cycle across a socket. And
`chownForChild` throws in the server for a uid that lives in the runner.

## Cost

The largest of the structural options needing no host privilege: a Dockerfile
stage, a compose service, a long-lived process with its own protocol, and a
rewrite of the spawn paths in `orchestrator.ts`, `review.ts` and `chat.ts` — git
probably stays server-side, since `gitEnv()` already strips everything
(`src/lib/git.ts:51`). Two to three weeks, and it does not close the between-runs
case it was reached for.
