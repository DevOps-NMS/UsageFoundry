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
subprocess env scrubbing and isolation"*; and *"project settings … are ignored. If
managed settings configure `sandbox.filesystem` at all, or list any
`sandbox.credentials.files` deny entry, only managed settings can set this."*
There is no `--sandbox` flag on this pin, though the string is in the binary and
would mislead a later reader: `claude --sandbox mcp list` → `error: unknown option
'--sandbox'`. It is configured by settings, and `--settings <file-or-json>` is real
(`claude --help`).

> **Disputed — `10-validation.md`, finding 4.** The third quotation is the
> `describe()` of **`sandbox.filesystem.disabled`**, not of `sandbox.filesystem`.
> It continues "*an admin who deployed filesystem restrictions must not have them
> switched off by a user-writable file*" and ends "*When unset, filesystem
> isolation stays on*": it pins the escape hatch, not the policy. The conclusion
> this file draws from it survives on other evidence — `allowWrite`/`allowRead`
> carry their own "*Only honored from user, managed/policy, or CLI (`--settings`)
> settings — project settings … are ignored*" — but that source list is also
> where this option's largest hole is. See "What it requires of the host" below.

## Shape

One container, one image plus **`bubblewrap`, `socat` and a seccomp applier**,
plus a root-owned `/etc/claude-code/managed-settings.json` enabling
`sandbox.enabled`, `sandbox.failIfUnavailable`, a filesystem write allowlist and a
network domain allowlist. That file is the one policy surface a run cannot edit —
including via `.claude/settings.json` in the repository it is working on, which is
agent-writable and is ignored for sandbox keys. Per-run scoping is a `--settings`
overlay built beside `buildArgs` (`src/lib/orchestrator.ts:4396`), on top of a
managed file it cannot weaken. Four kinds of child stay four, each with one more
argument.

The dependency list is three long, not one — `10-validation.md`, finding 2. The
binary's own check makes a missing `bwrap` **or** a missing `socat` an error, and
a missing seccomp applier a *warning*: `"seccomp not available - unix socket
access not restricted"`, and at wrap time `"[Sandbox Linux] apply-seccomp binary
not available - unix socket blocking disabled. Install
@anthropic-ai/sandbox-runtime globally for full protection."` The third is an npm
global (or a vendored `vendor/seccomp/*` named by `sandbox.seccomp.bpfPath` and
`applyPath`), so `Dockerfile:194`'s pin does not cover it, and it is the piece
that makes the network boundary real rather than advisory.

**And the hole this file originally put in the wrong place.** The repository's
`.claude/settings.json` is ignored, as claimed. `~/.claude/settings.json` is
**not**: user settings are an honored source for `sandbox.filesystem`, `allowWrite`
is documented "*Additional paths to allow writing*" and merges across sources, and
that file is owned and writable by the agent's uid — measured, `00-problem.md`.
A run appends `{"sandbox":{"filesystem":{"allowWrite":["/"]}}}` and the next
session starts confined to nothing. Closing it means root-owning `~/.claude`
*itself* — not just the file, because a run that owns the directory can delete a
root-owned file inside it — and handing back only the subtrees the CLI writes.
That is a Phase 2 item, it is not small, and it is the same directory the metering
path requires to stay writable.

## Isolation gained

Filesystem, per run: a bubblewrap mount namespace whose writable set is this run's
worktree plus the repository's `.git`, everything else read-only or absent — which
closes the between-runs case for the shell and drops three of four mounts out of
reach, *provided* the user-settings hole above is closed first. Network, per run:
`sandbox.network.allowedDomains`, enforced by a proxy the sandboxed command has no
route around rather than by an environment variable — which is the difference
between a policy and a suggestion, but a narrower difference than "enforced by the
namespace". The mechanism is an HTTP and a SOCKS proxy on unix sockets, bridged in
with `socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:<sock>`, optionally
terminating TLS with the CLI's own CA (`sandbox.network.tlsTerminate`,
`caCertPath`). What stops a command dialling the socket directly is the seccomp
filter of the dependency list above, whose absence is a warning rather than an
error (`10-validation.md`, finding 3). Process: a bwrap namespace normally carries
its own `/proc`, so today's `/proc/<pid>/cmdline` capability leak stops being
visible from a sandboxed command; a PID namespace is **assumed**, not determinable
from `strings`, and the base argv that *was* read is `["--new-session",
"--die-with-parent"]` with no `--unshare-pid` in it — which leans against.
`sandbox.seccomp` narrowing rather than widening is assumed too.

**The honest limit.** The evidence describes a sandbox around *commands* — *"By
default, your command will be run in a sandbox"* — and
`sandbox.autoAllowBashIfSandboxed` is about Bash prompting. It is therefore
**assumed** that the CLI process and the non-shell file tools run outside the
namespace. If so, this confines where arbitrary code actually executes and leaves
the model's own `Edit` free of the boundary: good against a compromised
dependency's build script, weaker against an agent simply told the wrong thing.

## The five it must not break

**The credential.** `sandbox.credentials` has `files` deny and mask entries, with a
proxy that re-signs masked ones; the re-signing machinery in the strings is
sigv4-shaped (`credentials.awsPairs`, `credentials.sigv`,
`accessKeyIdVar`/`secretAccessKeyVar`), so masking the Anthropic OAuth token is
**assumed unavailable**. `10-validation.md` marks this *unverifiable* rather than
assumed-false: `files` **mask** entries are generic "sentinel binds" that protect
the bytes independently of AWS, and what is actually unknown is whether a masked
OAuth token still authenticates and bills. A `files` **deny** entry over
`~/.claude/.credentials.json` is available either way — the CLI keeps reading it,
the run's shell cannot. First option here that makes a `cat` of it fail. One
coupling to carry: the binary says a deny entry's read protection is dropped if
`filesystem.disabled` is ever set, so the credential gain and the filesystem
policy are one switch, not two.

**Metering.** Untouched, and this is where it is strongest: same process, same
`CLAUDE_CONFIG_DIR`, same transcripts under `PROJECTS_DIR`, same root server
reading them. The one thing to get right is that `~/.claude` stays *writable* by
the CLI — an allowlist that forgets it produces the silent zero `01-constraints.md`
warns about, and it is the most important line in the verification plan.

That requirement and the user-settings hole above point at the same directory in
opposite directions, which is the sharpest constraint on this option and was not
in this file before `10-validation.md`. Metering needs `~/.claude` writable by the
agent's uid; policy integrity needs the settings file inside it *not* to be. The
resolution is per-entry rather than per-directory — root-own the directory, hand
back `projects/`, `sessions/`, `todos/`, `shell-snapshots/`, `history.jsonl` and
`.credentials.json` — and every entry that is missed fails as a zero, not as an
error.

**Telemetry.** Untouched: same container, same namespace, same loopback
`OTLP_SELF_URL`, and the exporter sits in the CLI process, outside the per-command
sandbox under the assumption above.

**The work.** Untouched — same uid, same worktree, same `chownForChild`, same
commits at the operator's uid. The `.git` pointer (`01-constraints.md`) forces the
repository's real git directory into the writable set, so the boundary is "this
repository" rather than "this checkout": weaker than it first looks, and the same
limit every namespace option hits.

One spelling constraint, from `10-validation.md`: **glob patterns in
`sandbox.filesystem` are silently dropped on Linux** — `"Skipping glob pattern on
Linux/WSL"`, filtered out of `allowWrite` and `denyWrite` both. `isolationCopyGlobs`
is `[".env", ".env.*", "!.env.example"]` (`src/lib/settings.ts:579`), so whatever
generates the per-run overlay has to expand those itself.

**Toolchain and arithmetic.** Three packages, not one — see Shape. The cost is one
`bwrap` exec per Bash call rather than per run — milliseconds, **not measured
here**. `mem_limit`/`cpus` unchanged, because no new process supervises anything.
`pids_limit` is **not** unchanged, and `10-validation.md` refutes the sentence this
paragraph used to end with: each sandboxed command costs a `bwrap`, two `socat`
bridge listeners, and — `TCP-LISTEN:…,fork` — one `socat` child per outbound
connection. `pids_limit` counts tasks and `README.md:744`'s formula is
`256 × (runs + others + 1)`, which has no term for any of that. At 25 concurrent
runs the arithmetic needs re-deriving rather than restating; today's ceiling is
2048 with no CPU quota at all (`/sys/fs/cgroup/pids.max`, `cpu.max`, measured).

## What it requires of the host

A Linux kernel with unprivileged user namespaces, and one real trade. Measured in
the shipped container:

    $ unshare --user --map-root-user id  →  unshare failed: Operation not permitted
    $ grep CapBnd /proc/self/status      →  00000000a80425fb   (no CAP_SYS_ADMIN)

`10-validation.md` confirmed the diagnosis and closed the mechanism question:
plain `unshare -U`, which needs no capability at all, fails the same way;
`/proc/sys/user/max_user_namespaces` is 31734; `Seccomp: 2` with one filter
loaded. So it is the profile and nothing else, and no capability grant is needed
to fix it.

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

`10-validation.md` found the closer case of the same shape: **an empty policy
returns the command unwrapped.** With no network deny, no read or write
restriction and no credential entry, the wrapper short-circuits and there is no
`bwrap` at all. `sandbox.enabled: true` over a policy that resolved to nothing —
a mistyped path, a glob dropped by the Linux filter above — is a sandbox that
silently does nothing, and `failIfUnavailable` does not catch that either, for
exactly the reason in the previous sentence. So is a missing seccomp applier,
which downgrades the network boundary on a warning.

## Cost

`Dockerfile` (**two** apt packages plus a global npm install for the seccomp
applier, one managed-settings file), `docker-compose.yml` (one `security_opt`),
ownership surgery on `~/.claude` so its settings file stops being agent-writable,
a per-run settings overlay beside `buildArgs` repeated for `review.ts` and
`chat.ts`, a boot line in the manner of `describeSeparation()`. **A week** rather
than the two or three days this file first said, on `10-validation.md`'s findings
1 and 2. The real cost is still the verification, because none of the behaviour
above has been executed — only read out of the binary.
