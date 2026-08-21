# Option A — harden in place

Keep one container. Push the existing privilege split further: a uid per
concurrent run slot instead of one uid for every child, mount modes that exclude a
sibling, and an egress proxy the children are pointed at.

## Shape

`childCredentials(run)` hands out `UF_AGENT_UID_BASE + slot`, where slot is the
worktree slot `allocateSlotPath` already assigns and `MAX_WORKTREE_SLOTS = 64`
(`src/lib/orchestrator.ts:2603`) already bounds. The worktree store becomes
group-writable and setgid to a shared `uf-agents` gid so the operator can still
read and remove what a run left, and `chownForChild` (`src/lib/privsep.ts:173`)
chowns each slot to that run's uid. Egress goes through a proxy the server runs
in-process, injected as `HTTPS_PROXY` by `childEnv`. Nobody new spawns anybody.

## Isolation gained

Between two concurrent runs — the case with no boundary today — this is the only
option here that closes it without a new container: uid A cannot write uid B's
worktree, read uid B's 0600 capability file, or signal uid B's process tree. The
largest single gain for the smallest structural change, and worth stating before
the objections.

Filesystem beyond that is unchanged: every run still sees all four mounts and
`~/.claude`, because a uid boundary is not a namespace. Network gains only what the
proxy enforces, and a proxy set by an environment variable is advisory — `curl
--noproxy` and a raw socket both walk past it. Process: `/proc` stays shared, so
the capability *file* is protected while its *path* stays public. Kernel:
unchanged.

## The five it must not break

**The credential.** Unchanged and in one respect worse: `~/.claude` is 0600 owned
by the operator's uid, so a run at uid 10007 cannot read it — which means it cannot
run. That directory has to become group-readable to `uf-agents`, which hands it to
every run rather than to one. No gain, one new way to get it wrong.

**Metering.** Same directory, now written by several uids; the server is root and
reads regardless, so a per-uid umask leaving a transcript 0600 still works.

**Telemetry.** Untouched, and the option's quiet strength: same network namespace,
same loopback `OTLP_SELF_URL`, same per-run capability. `src/lib/config.ts:108`/
`:127` and both middleware exemptions need no thought at all.

**The work.** Where it hurts. Commits land in the operator's `.git` authored by uid
10007, so objects under `<repo>/.git/objects` are owned by a uid the operator is
not, and their own `git gc` cannot repack them. Mitigable with a shared gid, setgid
directories and `umask 002` — each of which is silent when it slips: one file at
0644 and the next `gc` fails on a file it cannot remove. On Docker Desktop's
`fakeowner` filesystem (`00-problem.md`) it is **assumed** that per-uid ownership
is not enforced at all, which would make the whole boundary decorative on the
platform this install runs.

**Toolchain and arithmetic.** Untouched — one image, one container, one
`mem_limit`; at 25 concurrent runs `README.md:744` stands as written. The only
option here that costs nothing on that axis.

## What it requires of the host

Nothing: no Docker socket, no runtime, no capability grant, no kernel floor, no
seccomp change. It works identically on macOS and Linux to the extent that the
underlying filesystem enforces uid ownership — the caveat above and the whole of
its risk.

## Failure modes

A uid absent from `/etc/passwd` makes `os.homedir()` unreliable, already flagged
for the current uid at `docs/agent/environment.md:22`; past that, `spawn` fails
EPERM and the run fails loudly. The silent ones are ownership slips: a seeded
`.env` chowned to the wrong slot's uid reads as a configured worktree right up to
the first write — the failure `seedWorktree` already deletes the file to avoid
(`src/lib/orchestrator.ts:2370`–`2380`) — and with 64 uids there are 64 ways to get
it wrong. A slot reused by a different uid inherits a directory the new uid cannot
write, which `ensureWorktree` reads as uncommitted work. And an agent that bypasses
`HTTPS_PROXY` gets the network it always had, with the settings page saying egress
is restricted.

## Cost

`privsep.ts` roughly doubles; `orchestrator.ts` threads a run through every
`childCredentials()` and `chownForChild` call site; `git.ts`, `review.ts` and
`chat.ts` each need a decision about which uid a non-work-cycle child takes (a
reviewer has no slot). A week, most of it in ownership edge cases rather than code,
and it buys the between-runs boundary and nothing else.
