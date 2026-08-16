# Sandboxing a run

**Validated 2026-08-15 (`10-validation.md`). The recommendation stands, at higher
cost and with one precondition it did not have.** 21 claims confirmed, 7 refuted,
6 unverifiable. The codebase claims held; most of what failed was a claim about
the vendor binary, which is where `08-recommendation.md` already said its risk
was. Two things changed materially, and both are folded into the files below:
the sandbox needs **three** dependencies (`bubblewrap`, `socat`, and a seccomp
applier whose absence is only a *warning*), not one; and **`~/.claude/settings.json`
is an honored sandbox settings source that the agent's own uid can rewrite**, so
per-run confinement is decorative until the ownership of that directory changes.
The recommendation is unmoved because every one of those findings lands on the
runner-up too — Option D reaches confinement through the same CLI mechanism.

The survey also missed an option: **Landlock**, which this kernel carries and lists
as an active LSM, and which needs no capability, no user namespace and none of the
seccomp relaxation that is Option B's one host-posture trade. It does not displace
B — it cannot deny the credential to the shell while the CLI still reads it, and
its network control is by port rather than by host — but it is a complement worth
a file, and the comparison was scored without it (`07-comparison.md`).

**Re-read on 2026-08-16 against the operator's three goals, which are not what it
was scored against:** no run may signal another run's processes, no run may write
into a checkout that is not its own, and later a run should install the tools it
needs into a filesystem that is discarded when it finishes. Against those, B lands
one, half-lands one and does not address one; `07-comparison.md` has no criterion
for the first or the third; and the shape that answers all three — **this app
invoking `bwrap` around the `claude` process**, rather than configuring the CLI to
invoke it around Bash — was never considered, though it needs the same seccomp
relaxation B already pays for. It does not overturn the recommendation on the
credential, which is the axis the survey optimised and the one an outer wrapper
cannot win. It does mean `09-implementation-sketch.md` now carries a decision
between Phase 1 and Phase 2, and two more questions in Phase 1 that gate it.

## The recommendation

**Sandbox the child with the CLI's own bubblewrap layer**, enabled and pinned by a
root-owned `/etc/claude-code/managed-settings.json` in the image that the agents
cannot write, and scoped per run by a `--settings` overlay generated at each spawn
site. One container, one image plus `bubblewrap`, `socat` and a seccomp applier, no
new process, no Docker socket, no change to the loopback telemetry and MCP
endpoints, no change to the metering path.

It is recommended because the pinned CLI — 2.1.226, `Dockerfile:194` — already
implements it; because it is the only candidate that crosses none of the five
things a sandbox boundary here has to leave working; and because its
`sandbox.failIfUnavailable` key exits at startup rather than silently running
unsandboxed, which is this repository's own rule about disappearing boundaries
supplied by the vendor. Its central mechanism was **read out of the pinned binary
and not executed** — twice now, by two runs, neither of which started a sandbox.
Phase 1 of `09-implementation-sketch.md` is a measurement, and its third question —
whether the sandbox wraps the session or only Bash — is the fact that would promote
the runner-up, which is the operator's own sketch in full (`04`). The operator's
sketch *without* its second half — a runner container alone (`03`) — is rejected by
name: same container, same uid, same mounts, so a run can still write a concurrent
run's checkout, the gap the whole exercise was reached for.

## What a run can reach today, measured

| | Reachable from a work cycle? |
|---|---|
| `/data` (database, settings, lock) | no — `0:0 700`, `test -r` fails |
| Server's environment (`UF_AUTH_TOKEN`, Admin key) | no — `/proc/7/environ` denied |
| The account's OAuth credential | **yes** — `~/.claude/.credentials.json` readable |
| The CLI's own user settings | **yes** — `~/.claude/settings.json` writable |
| Another run's checkout | **yes** — writable, 20 slots on this install |
| The operator's database backups | **yes** — `/backups`, a sixth bind mount, writable |
| The server's and a sibling's cmdline | **yes** — `/proc/*/cmdline` world-readable |
| The internet, any host | **yes** — `curl https://pypi.org` → 200 |
| New namespaces of any kind | no — `unshare` EPERM, and it is **seccomp**, not capabilities |

Commands and outputs are in `00-problem.md`; the last four rows were added or
corrected by `10-validation.md`, which re-ran every one of them.

## Index

| File | What it is for |
|---|---|
| [00-problem.md](00-problem.md) | What a run reaches today, verified from inside one |
| [01-constraints.md](01-constraints.md) | The five crossings and six architecture properties an option must survive |
| [02-option-harden-in-place.md](02-option-harden-in-place.md) | A: a uid per run slot, one container |
| [02x-option-cli-sandbox.md](02x-option-cli-sandbox.md) | B: the CLI's own bubblewrap sandbox — **recommended** |
| [03-option-runner-container.md](03-option-runner-container.md) | C: a second container for the agents — **rejected by name** |
| [04-option-runner-with-per-run-sandboxes.md](04-option-runner-with-per-run-sandboxes.md) | D: C plus per-run sandboxes — **runner-up** |
| [05-option-per-run-container.md](05-option-per-run-container.md) | E: one container per run |
| [06-option-vm-grade-runtime.md](06-option-vm-grade-runtime.md) | F: gVisor or Kata |
| [07-comparison.md](07-comparison.md) | Weighted criteria, stated before the scores |
| [08-recommendation.md](08-recommendation.md) | The argument, the cost, and what it does not contain |
| [09-implementation-sketch.md](09-implementation-sketch.md) | Phases, hand-verification commands, migration, open questions |
| [10-validation.md](10-validation.md) | An adversarial pass over all of the above: verdict table, environment checks, what is still unmeasured |

Every option file answers the same six headings — shape, isolation gained, the
five it must not break, what it requires of the host, failure modes, cost — so
`07-comparison.md` is a table over a fixed set rather than over six arguments.
