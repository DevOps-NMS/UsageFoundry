# Sandboxing a run

## The recommendation

**Sandbox the child with the CLI's own bubblewrap layer**, enabled and pinned by a
root-owned `/etc/claude-code/managed-settings.json` in the image that the agents
cannot write, and scoped per run by a `--settings` overlay generated at each spawn
site. One container, one image plus `bubblewrap`, no new process, no Docker
socket, no change to the loopback telemetry and MCP endpoints, no change to the
metering path.

It is recommended because the pinned CLI — 2.1.226, `Dockerfile:194` — already
implements it; because it is the only candidate that crosses none of the five
things a sandbox boundary here has to leave working; and because its
`sandbox.failIfUnavailable` key exits at startup rather than silently running
unsandboxed, which is this repository's own rule about disappearing boundaries
supplied by the vendor. Its central mechanism was **read out of the pinned binary
and not executed**: Phase 1 of `09-implementation-sketch.md` is a measurement, and
its third question — whether the sandbox wraps the session or only Bash — is the
fact that would promote the runner-up, which is the operator's own sketch in full
(`04`). The operator's sketch *without* its second half — a runner container alone
(`03`) — is rejected by name: same container, same uid, same mounts, so a run can
still write a concurrent run's checkout, the gap the whole exercise was reached
for.

## What a run can reach today, measured

| | Reachable from a work cycle? |
|---|---|
| `/data` (database, settings, lock) | no — `0:0 700`, `test -r` fails |
| Server's environment (`UF_AUTH_TOKEN`, Admin key) | no — `/proc/7/environ` denied |
| The account's OAuth credential | **yes** — `~/.claude/.credentials.json` readable |
| Another run's checkout | **yes** — writable, 19 slots on this install |
| The server's and a sibling's cmdline | **yes** — `/proc/*/cmdline` world-readable |
| The internet, any host | **yes** — `curl https://pypi.org` → 200 |
| New mount or user namespaces | no — `unshare` EPERM, no `CAP_SYS_ADMIN` |

Commands and outputs are in `00-problem.md`.

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

Every option file answers the same six headings — shape, isolation gained, the
five it must not break, what it requires of the host, failure modes, cost — so
`07-comparison.md` is a table over a fixed set rather than over six arguments.
