# Option D — a runner container holding per-run sandboxes

The operator's sketch in full: a second container that runs the agents, *and*
inside it a small sandbox per run so each is contained from the others.

## Shape

`03`'s runner container, plus a supervisor that wraps each child in a per-run
sandbox rather than plain `spawn`. The primitive is bubblewrap or a uid per slot —
the same two levers as `02` and `02x`, applied inside a container holding nothing
else worth reaching. The managed-settings route of `02x` is available here too and
is the cheaper of the two, needing no supervisor code beyond passing `--settings`.
Two services, two `mem_limit`s, one shared `~/.claude`, four shared workspaces,
`/data` mounted only into the server.

## Isolation gained

The strongest of the options that do not change the container runtime, and the
only one stacking a process boundary on a namespace boundary. A run is confined to
its own worktree and the repository's `.git`, to an allowlist of hosts, to its own
`/proc`, and it sits in a container with no database, no server process and no
server environment. Between two runs: closed, by the same mechanism as `02x`.
Kernel surface unchanged — two containers and 25 namespaces still share one kernel.

## The five it must not break

**The credential.** `~/.claude` mounted into the runner; the per-run sandbox can
deny it to sandboxed commands exactly as in `02x`. Same gain, same limit.

**Metering.** Both `03`'s risk and `02x`'s: the transcript directory has to be
mounted at the same path in both containers *and* be inside every run's sandbox
writable set. Two independent ways to produce a dashboard of zeros with nothing
thrown.

**Telemetry.** `03`'s problem, harder. The endpoint moves off loopback onto the
compose network, *and* the sandbox's network policy must permit the runner→server
hop while denying everything else — two allowlists that have to agree, one in
compose and one in per-run settings, with the failure being a live spending guard
reading zero, the case `needsLiveSpendTelemetry`
(`src/lib/orchestrator.ts:4573`) exists to prevent.

**The work.** `03`'s path-identity invariant plus `02x`'s `.git` exposure. Commits
still land at the operator's uid if the runner keeps `UF_AGENT_UID`.

**Toolchain and arithmetic.** `03`'s split limits plus a per-command `bwrap` exec:
at 25 concurrent runs, the most moving parts per run and the same total memory.

## What it requires of the host

`02x`'s seccomp relaxation, applied to the *runner* service only. A genuinely
better placement than `02x` gets in a single-container world — the container whose
syscall surface is widened holds none of this app's own credentials, and the server
keeps Docker's default profile. The single strongest argument for this shape over
`02x`.

## Failure modes

Every one of `03`'s and every one of `02x`'s, and their interaction is the new
risk: a path correct in the server's view, correct in the runner's mount table, and
outside the sandbox's writable set fails at the third step, inside a tool call, on
some repositories and not others. This app's history of exactly that shape —
`githubEnv`'s SSH-versus-HTTPS remote (`src/lib/orchestrator.ts:4670`) — is why the
objection is worth taking seriously rather than treating as an implementation
detail.

## Cost

`03`'s plus `02x`'s minus the overlap: a Dockerfile stage, a compose service, a
supervisor with a protocol, per-run settings generation, and the verification
matrix for all of it. Four to six weeks, and the only option here that cannot be
shipped in useful halves — a runner without sandboxes is `03` and does not close
the case it was built for, while sandboxes without the runner are `02x` and are
most of the value for a tenth of the work. That asymmetry is what decides
`08-recommendation.md`.
