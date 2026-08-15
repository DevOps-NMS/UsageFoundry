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
and network** because `sandbox.filesystem.write.allowOnly` and
`sandbox.network.allowedDomains` are per-session policy inside a namespace — finer
than a per-container network, stronger than a proxy environment variable — and **2
rather than 3 between two runs** because the sandbox is assumed to wrap commands
rather than the whole session (`02x-option-cli-sandbox.md`). **B is the only
positive on loudness**, on `sandbox.failIfUnavailable`; every structural option
scores negative there, because each adds a way for the transcript scan to read zero
with nothing thrown. **C scores 0 on fit** rather than negative: it changes the
loopback endpoints and adds a fifth kind of child, but it also splits the memory
limits, and those roughly cancel. **E's −3 on host posture** is the Docker socket,
unrecoverable by careful calling code, and its −1 on credential containment is that
25 containers hold `~/.claude` where one does today.

## One candidate not given a file

A **hosted or remote execution target** — the pinned CLI exposes `--cloud` and
`--environment ccpool_…` (`claude --help`) — would remove the agent from the
operator's machine entirely. Excluded rather than scored because it contradicts
the product: this app reads local transcripts to meter a local subscription
(`src/lib/transcripts.ts:17`) and runs against bind-mounted host directories. A
run whose files and transcripts live elsewhere has no dashboard, no windows and no
guards. That is a different application, not a sandbox for this one.
