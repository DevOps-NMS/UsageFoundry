# Option F — a VM-grade runtime

Run the agents under gVisor (`runsc`) or Kata, so the boundary is a second kernel
rather than a namespace on the operator's.

## Shape

Either variant of `03`/`05` with `runtime: runsc` (or `kata-runtime`) on the agent
service; everything else — supervisor, mount identity, telemetry hop — is inherited
from whichever option it layers onto, so this file argues only the runtime. Neither
is present today: `command -v runsc kata-runtime crun runc podman docker` finds
none of them, and `/var/run/docker.sock` does not exist.

## Isolation gained

The only option here that moves the kernel axis. Every other option's agents share
the host kernel, so a bug reachable from an unprivileged syscall escapes all of
them at once; gVisor reimplements the syscall surface in user space, Kata gives a
separate kernel outright. Against the threat in `00-problem.md` — a prompt-injected
agent, not a kernel exploit developer — this is the axis that matters least, which
is the honest framing rather than a dismissal: least *for this threat*, and the
only defence that would still hold if the threat changed. Filesystem, network,
process and between-runs isolation are whatever the underlying option provides.

## The five it must not break

**The credential.** Unchanged. A second kernel does not know what a credential is.

**Metering.** Unchanged in principle. gVisor's gofer filesystem is historically its
slow part, and the transcript directory is written by every child and scanned
repeatedly by the server. Not measured here.

**Telemetry.** Whatever the underlying option needs, over a different network
stack. `telemetryEnv()` (`src/lib/orchestrator.ts:4613`) requires nothing exotic.

**The work.** git and a compiler under gVisor work, and are slower — build- and
git-heavy workloads are its documented weak case, and a work cycle is nothing but
builds and git. Unmeasured, and it taxes the billed minute directly.

**Toolchain and arithmetic.** Kata adds a VM's memory per sandbox, a term
`README.md:744` does not have; gVisor adds a Sentry process per sandbox.

## What it requires of the host

An alternate runtime registered with the Docker daemon — a host-level change
outside `docker compose up --build` and outside `docs/install.md`'s current shape.
gVisor wants a Linux host with a modern kernel; whether it is usable at all under
Docker Desktop for macOS is **assumed not**, and was not verified. Kata needs
nested virtualisation. On this install — linuxkit 6.12.76 aarch64, per `uname -r` —
this is at best unsupported. It does **not** require a Docker socket and trades no
host privilege, which distinguishes it sharply from `05`.

## Failure modes

Silent slowness, expensive here in a way it is not elsewhere: a run 40% longer
bills 40% more and reports nothing unusual. An unsupported syscall surfaces as a
tool call failing for a reason nobody can diagnose from the run page. A runtime
that is absent makes the container fail to *start*, which is loud — the one thing
in its favour on this axis.

## Cost

Small here and large everywhere else: `docker-compose.yml` gains a `runtime:` line
and `docs/install.md` gains host prerequisites, a platform matrix and a performance
caveat. It cannot be the default because it does not run on the platform the
shipped compose file targets. Correctly understood as an option an operator on a
Linux host may *add* on top of whichever structural option wins.
