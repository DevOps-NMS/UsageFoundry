# Comparison

## The criteria, and their weights, stated before the scoring

Nine criteria, weighted 1–3. The weights encode a judgement about *this* app and
*this* threat — a prompt-injected unattended agent, not a kernel exploit — and
disagreeing with them is the cleanest way to disagree with the recommendation.

| Criterion | Weight | Why that weight |
|---|---|---|
| Between two runs | 3 | The only axis with **no** boundary today (`00-problem.md`). |
| Filesystem reach | 3 | The bind mounts are the operator's own directories. |
| Network egress | 2 | The exfiltration path, but the credential is exfiltrable by commit too. |
| Credential containment | 3 | The single most valuable thing a run can steal. |
| Fit with the architecture | 3 | Loopback endpoints, one event loop, four kinds of child, one image. |
| Loudness of failure | 3 | This repo's standing complaint; a silent guard is worse than none. |
| Host security posture | 3 | An option that trades host root is worse than doing nothing. |
| Build cost | 2 | Real, but a one-off. |
| Run cost | 2 | Image size, per-run start-up, the 25-run arithmetic. |

Kernel surface is deliberately **not** scored. Only `06` moves it, `06` cannot run
on the shipped platform, and scoring an axis one option wins by default would let
it carry a recommendation the threat model does not support. It is argued in its
own file instead.

## Scores

0 = no change from today, 3 = closed. Host posture and loudness are signed:
negative means worse than today.

| | A: harden in place | B: CLI sandbox | C: runner | D: runner + sandboxes | E: per-run container | F: VM runtime |
|---|---|---|---|---|---|---|
| Between two runs (×3) | 2 | 2 | 0 | 3 | 3 | 0 |
| Filesystem reach (×3) | 0 | 3 | 0 | 3 | 2 | 0 |
| Network egress (×2) | 1 | 3 | 1 | 3 | 2 | 0 |
| Credential containment (×3) | 0 | 2 | 0 | 2 | −1 | 0 |
| Fit with architecture (×3) | 2 | 3 | 0 | 0 | −1 | 1 |
| Loudness of failure (×3) | 0 | 2 | −2 | −2 | −2 | 1 |
| Host posture (×3) | 0 | −1 | 0 | −1 | −3 | 0 |
| Build cost (×2) | 1 | 3 | 0 | −1 | −2 | 2 |
| Run cost (×2) | 3 | 2 | 2 | 1 | −1 | −2 |
| **Weighted total** | **22** | **49** | **0** | **21** | **−8** | **6** |

F's total is not a rank: it scores well on build cost and fit because it *is* only
a `runtime:` line, and it cannot run on the platform the shipped compose file
targets. A and D finishing a point apart is worth naming rather than smoothing
over — D's runner container buys defence in depth A does not have, and pays for it
in build cost and in a second way for metering to read zero.

Reading the interesting cells rather than the totals: **B scores 3 on filesystem
and network** because `sandbox.filesystem.allowWrite` and
`sandbox.network.allowedDomains` are per-session policy inside a namespace — finer
than a per-container network, stronger than a proxy environment variable — and **2
rather than 3 between two runs** because the sandbox is assumed to wrap commands
rather than the whole session (`02x-option-cli-sandbox.md`). **B is the only
positive on loudness**, on `sandbox.failIfUnavailable`; every structural option
scores negative there, because each adds a way for the transcript scan to read zero
with nothing thrown.

> **Disputed — `10-validation.md`.** Three corrections to the cells above, none of
> which reorders the table. The key is `sandbox.filesystem.allowWrite`, not
> `…write.allowOnly` (fixed in place). The network enforcement is a proxy the
> sandboxed command has no route around, not namespace-level filtering, and it
> depends on a seccomp component whose absence is a warning — so B's 3 on network
> is conditional. And B's 3 on filesystem and 2 on between-two-runs both hold only
> once `~/.claude/settings.json` stops being agent-writable; today a run can widen
> its own write set from that file, which would make both cells 0. The scores are
> left as written because they describe the option *implemented as specified in
> Phase 2*, and Phase 2 now carries the fix. **Option D takes every one of these
> corrections too** — it reaches confinement through the same CLI mechanism — which
> is why the ordering does not move.

**C scores 0 on fit** rather than negative: it changes the
loopback endpoints and adds a fifth kind of child, but it also splits the memory
limits, and those roughly cancel. **E's −3 on host posture** is the Docker socket,
unrecoverable by careful calling code, and its −1 on credential containment is that
25 containers hold `~/.claude` where one does today.

## Two candidates not given a file

**Landlock**, added by `10-validation.md` and the survey's one real omission. It
is compiled into this kernel and in its active LSM list — `CONFIG_SECURITY_LANDLOCK=y`,
`CONFIG_LSM="…,landlock"`, measured from `/proc/config.gz` — and it needs no
capability, no user namespace and therefore **none of the `security_opt`
relaxation that is the whole of Option B's −1 on host posture**. Two more
properties it alone has: its ruleset is inherited across `execve` and by every
descendant, so the open question about whether the CLI's sandbox wraps the session
or only Bash cannot be asked of it; and the shape is an exec-wrapper rather than a
supervisor, so `docs/agent/architecture.md:102`'s four kinds of child stay four
with no argument about a fifth. It is not scored above because it does not
displace B on the two axes B wins: its network control is by TCP port rather than
by host, and its inheritance — the same property that confines the session — makes
it unable to deny `~/.claude/.credentials.json` to the run's shell while the CLI
still reads it. Read as a **complement** to B rather than a rival: a filesystem
floor that costs no host posture, under a CLI layer that supplies the credential
deny and the domain allowlist. It should have had a file, and the scores above
were reached without it.

A **hosted or remote execution target** — the pinned CLI exposes `--cloud` and
`--environment ccpool_…` (`claude --help`) — would remove the agent from the
operator's machine entirely. Excluded rather than scored because it contradicts
the product: this app reads local transcripts to meter a local subscription
(`src/lib/transcripts.ts:17`) and runs against bind-mounted host directories. A
run whose files and transcripts live elsewhere has no dashboard, no windows and no
guards. That is a different application, not a sandbox for this one.
