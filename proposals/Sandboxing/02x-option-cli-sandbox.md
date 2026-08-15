# Option B — let the CLI sandbox itself, pinned by managed settings

Not in the brief's list because it is not visible from the repository. It is
visible from the binary the image pins: **CLI 2.1.226 already implements a
bubblewrap-based Linux sandbox**, configured by settings keys an admin-owned file
can make non-overridable. The evidence, since everything below rests on it —
`strings` over `node_modules/@anthropic-ai/claude-code-linux-arm64/claude`:

    $ strings -n 6 "$B" | grep -oE '\bsandbox\.[a-zA-Z]+' | sort -u
    sandbox.allowUnsandboxedCommands  sandbox.enabled     sandbox.network
    sandbox.autoAllowBashIfSandboxed  sandbox.filesystem  sandbox.seccomp
    sandbox.bwrapPath                 sandbox.credentials sandbox.failIfUnavailable
    $ strings -n 8 "$B" | grep -oE '/etc/claude-code[a-z/.-]*|managed-settings\.json'
    /etc/claude-code   managed-settings.json

and three of its own sentences: *"Exit with an error at startup if
`sandbox.enabled` is true but the sandbox cannot start … When false (default), a
warning is shown and commands run unsandboxed"*; *"bubblewrap is required for
subprocess env scrubbing and isolation"*; and *"project settings … are ignored.
If managed settings configure `sandbox.filesystem` at all, or list any
`sandbox.credentials.files` deny entry, only managed settings can set this."*

There is no `--sandbox` flag on this pin, though the string is in the binary and
would mislead a later reader: `claude --sandbox mcp list` → `error: unknown option
'--sandbox'`. It is configured by settings, and `--settings <file-or-json>` is real
(`claude --help`).

## Shape

One container, one image plus `bubblewrap`, plus a root-owned
`/etc/claude-code/managed-settings.json` enabling `sandbox.enabled`,
`sandbox.failIfUnavailable`, a filesystem write allowlist and a network domain
allowlist. That file is the one policy surface a run cannot edit — including via
`.claude/settings.json` in the repository it is working on, which is
agent-writable and would otherwise be the hole. Per-run scoping is a `--settings`
overlay built beside `buildArgs` (`src/lib/orchestrator.ts:4396`), on top of a
managed file it cannot weaken. Four kinds of child stay four, each with one more
argument.

## Isolation gained

Filesystem, per run: a bubblewrap mount namespace whose writable set is this run's
worktree plus the repository's `.git`, everything else read-only or absent — which
closes the between-runs case for the shell and drops three of four mounts out of
reach. Network, per run: `sandbox.network.allowedDomains`, enforced inside the
namespace rather than by an environment variable, which is the difference between
a policy and a suggestion. Process: a bwrap namespace normally carries its own
`/proc`, so today's `/proc/<pid>/cmdline` capability leak stops being visible from
a sandboxed command; a PID namespace is **assumed**, not determinable from
`strings`, as is `sandbox.seccomp` narrowing rather than widening.

**The honest limit.** The evidence describes a sandbox around *commands* — *"By
default, your command will be run in a sandbox"* — and
`sandbox.autoAllowBashIfSandboxed` is about Bash prompting. It is therefore
**assumed** that the CLI process and the non-shell file tools run outside the
namespace. If so, this confines where arbitrary code actually executes and leaves
the model's own `Edit` free of the boundary: good against a compromised
dependency's build script, weaker against an agent simply told the wrong thing.

## The five it must not break

**The credential.** `sandbox.credentials` has `files` deny and mask entries, with
a proxy that re-signs masked ones; the re-signing machinery in the strings is
sigv4-shaped, so masking the Anthropic OAuth token is **assumed unavailable**. A
`files` **deny** entry over `~/.claude/.credentials.json` is available — the CLI
keeps reading it, the run's shell cannot. First option here that makes a `cat` of
it fail.

**Metering.** Untouched, and this is where it is strongest: same process, same
`CLAUDE_CONFIG_DIR`, same transcripts under `PROJECTS_DIR`, same root server
reading them. The one thing to get right is that `~/.claude` stays *writable* by
the CLI — an allowlist that forgets it produces the silent zero
`01-constraints.md` warns about, and it is the most important line in the
verification plan.

**Telemetry.** Untouched: same container, same namespace, same loopback
`OTLP_SELF_URL`, and the exporter sits in the CLI process, outside the
per-command sandbox under the assumption above.

**The work.** Untouched — same uid, same worktree, same `chownForChild`, same
commits at the operator's uid. The `.git` pointer (`01-constraints.md`) forces the
repository's real git directory into the writable set, so the boundary is "this
repository" rather than "this checkout": weaker than it first looks, and the same
limit every namespace option hits.

**Toolchain and arithmetic.** `bubblewrap` is a small package; the cost is one
`bwrap` exec per Bash call rather than per run — milliseconds, **not measured
here**. `mem_limit`/`pids_limit`/`cpus` unchanged, because no new process
supervises anything, so at 25 concurrent runs `README.md:744` stands as written.

## What it requires of the host

A Linux kernel with unprivileged user namespaces, and one real trade. Measured in
the shipped container:

    $ unshare --user --map-root-user id  →  unshare failed: Operation not permitted
    $ grep CapBnd /proc/self/status      →  00000000a80425fb   (no CAP_SYS_ADMIN)

Docker's default seccomp profile blocks the `CLONE_NEWUSER` path, so bubblewrap
cannot start as shipped. The fix is a custom profile — the default with
`unshare`/`clone` permitted for user namespaces — via `security_opt`. That widens
the container's own syscall surface and must be stated as such; it is materially
smaller than `--cap-add SYS_ADMIN`, far smaller than `--privileged`, and not
comparable to Option E's Docker socket. No socket, no second runtime, no kernel
floor beyond user-namespace support, and it works on Docker Desktop's linuxkit
kernel (6.12.76, verified present) as on a Linux host.

## Failure modes

The one that would normally be fatal here is handled by the vendor:
`sandbox.failIfUnavailable: true` exits at startup rather than warning, which is
why this option survives the "nothing throws and the page looks right" test better
than anything else in the survey.

What stays silent: an allowlist omitting a path or a registry the *work* needs
fails inside a tool call the run loop does not read — the failure `githubEnv`'s
comment describes for a missing `gh` (`src/lib/orchestrator.ts:4655`), where the
cycle ends looking like the agent chose not to build. The vendor dependency is its
own mode: `Dockerfile:194` pins the CLI because the stream-json contract moves
silently, and this adds the sandbox settings schema to what that pin protects. A
renamed key leaves `sandbox.enabled` unread and the run unsandboxed, and
`failIfUnavailable` will not catch it — a sandbox never asked for is not one that
failed.

## Cost

`Dockerfile` (one apt line, one managed-settings file), `docker-compose.yml` (one
`security_opt`), a per-run settings overlay beside `buildArgs` repeated for
`review.ts` and `chat.ts`, a boot line in the manner of `describeSeparation()`.
Two or three days of code. The real cost is the verification, because none of the
behaviour above has been executed — only read out of the binary.
