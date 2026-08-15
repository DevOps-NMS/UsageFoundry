# Recommendation

**Sandbox the child with the CLI's own bubblewrap layer, pinned by an admin-owned
managed-settings file the agents cannot write, scoped per run by a `--settings`
overlay at each spawn site.** Option B, `02x-option-cli-sandbox.md`.

## Why this one, from the constraints rather than from preference

`01-constraints.md` lists five things that cross every candidate boundary and six
architecture properties that break silently. This is the only option in the survey
that crosses **none** of them.

Metering is the sharpest test. The transcript scan feeds every window and every
budget guard (`src/lib/transcripts.ts:3`, `src/lib/config.ts:62`), and its failure
mode is a dashboard of zeros with nothing thrown. Option B keeps the child in the
same process tree, container and `CLAUDE_CONFIG_DIR`, writing the same files, read
by the same root server. C, D and E each add at least one new way for that path to
be mismatched, and `configCheck.ts` warns rather than refuses on exactly that
condition (`docs/agent/environment.md:17`).

Telemetry is the second. `src/middleware.ts:66`/`:81` exempt `/api/mcp` and the
OTLP path from the shared-secret gate on the argument that each authenticates
itself with a capability — an argument written for a *loopback* surface
(`src/lib/config.ts:108`, `:127`). Every structural option moves it onto a network,
which has to be re-argued in `middleware.ts`; Option B does not touch it. The
single-writer rule decides the rest: `createRun` is atomic because one event loop
covers it (`docs/agent/concurrency-and-ownership.md:10`), which is why the MCP
tools run in-process (`src/lib/config.ts:120`), and Option B adds no process.

And loudness. This repository refuses boundaries that disappear with the page
looking identical — `describeSeparation()` (`src/lib/privsep.ts:180`) exists for
that. The pinned binary has the matching key in its own strings: *"Exit with an
error at startup if `sandbox.enabled` is true but the sandbox cannot start."* A
vendor-supplied version of this codebase's own rule, and the reason Option B is the
only positive loudness score in `07-comparison.md`.

What it delivers is not small: per-run filesystem confinement to the run's own
worktree, a network allowlist enforced inside a namespace rather than by an
environment variable, and — for the first time — a `cat` of
`~/.claude/.credentials.json` from a run's shell that fails.

## What it costs

An apt package, a root-owned file in `/etc/claude-code/`, a `security_opt` line, a
per-spawn settings overlay beside `buildArgs` repeated in `review.ts` and
`chat.ts`, a settings surface and a boot line. Two or three days of code.

The real cost is elsewhere. **Docker's default seccomp profile has to be relaxed**
so bubblewrap can create a user namespace — verified: `unshare --user
--map-root-user id` returns `Operation not permitted` in the shipped container, and
`CapBnd` is `00000000a80425fb`, Docker's default set with no `CAP_SYS_ADMIN`. The
fix is a custom profile permitting `unshare`/`clone` with `CLONE_NEWUSER`, which
widens the container's own syscall surface: much smaller than `--cap-add
SYS_ADMIN`, far smaller than `--privileged`, not comparable to Option E's Docker
socket — but a real trade, and it belongs in `docs/security.md` in those words.
Second, it adds the CLI's sandbox settings schema to what `Dockerfile:194`'s
version pin protects: a renamed key would leave runs unsandboxed, and
`failIfUnavailable` would not catch it, because a sandbox never asked for is not
one that failed.

## What it does not contain

In the habit of `docs/security.md:57`. **The credential, from the CLI process**: a
work cycle bills against the account token, so the process making the request must
read it. A `files` deny entry takes it from the run's *shell*, not from the
session, and a model that decides to print it has a tool that is not Bash; the only
real fix is a run-scoped credential, which does not exist. **The repository, as
opposed to the checkout**: a worktree's `.git` is a pointer into the main
repository (`01-constraints.md`), so the writable set must include `<repo>/.git`,
and two runs on one repository can still rewrite each other's refs — closing that
needs a per-run clone, a different proposal costing disk and time on every run.
**The CLI's own file tools**, assumed and the largest assumption here: the sandbox
wraps commands, so `Edit`/`Write` sit outside it. **The kernel**: 25 sandboxes on
one kernel, and only Option F moves that. **The database and the server's
environment** are already closed by privilege separation, verified in
`00-problem.md`; this adds nothing there and must not take anything away.

## The runner-up, and the one fact that flips it

**Option D — a runner container holding per-run sandboxes** (`04`), the operator's
own sketch. It scored a point below Option A and 28 below B, the gap being almost
entirely build cost and the two new ways it gives metering to read zero. What it
has that B does not is *placement*: the seccomp relaxation lands on a container
holding no database and no server process, and `/data` is excluded by absence
rather than by a file mode.

**The fact that flips it:** if the CLI's sandbox wraps only Bash and not the
session — the assumption named above — then a compromised *model*, as opposed to a
compromised subprocess, is unconfined by B, and the confinement must come from
outside the CLI process. Option D is the shape that provides it, and Phase 1 of
`09-implementation-sketch.md` is written to answer that before anything is built on
the answer.

**Option C alone — a runner container without per-run sandboxes — is rejected by
name.** It is the operator's sketch minus its second half and does not close the
case the sketch was reached for: same container, same uid, same mounts, so a run
can still write a sibling's checkout exactly as measured in `00-problem.md`. It
buys a better memory arithmetic and defence in depth around `/data`, for two to
three weeks and a rewrite of the telemetry hop. Those are worth having; they are
not sandboxing, and shipping them as sandboxing would be the worst outcome
available here.
