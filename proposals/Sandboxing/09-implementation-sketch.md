# Implementation sketch

Five phases. Each is useful alone; none of the later ones gates the earlier.

## Phase 0 — worth doing whichever option wins

**Name the between-runs gap in `docs/security.md`.** Its "What an agent can still
reach" lists four things and covers this one only by implication — "treat all four
workspaces as one blast radius" (`docs/security.md:72`). The measured fact is
sharper: a run can write a *concurrent run's checkout*, on a branch that will be
landed. One paragraph, with `00-problem.md`'s `test -w` command as its verification.

**Ship a `cpus` quota.** `docker-compose.yml:297` is `cpus: ${UF_CPUS:-0}` for a
good reason — Docker refuses a value above the host's CPU count — but the effect is
a shipped install with no CPU ceiling, and `README.md`'s own advice (`nproc` minus
one) is not in `.env.example`. Verify with `docker exec usagefoundry cat
/sys/fs/cgroup/cpu.max`.

**Extend the boot line.** `describeSeparation()` (`src/lib/privsep.ts:180`) states
the privilege arrangement in one line because that boundary disappears silently.
Whatever sandbox lands needs the same sentence from the same place; building the
seam now means the later phases only fill it in.

## Phase 1 — measure the assumption before building on it

Nothing in `02x-option-cli-sandbox.md` was executed; it was read out of the pinned
binary. Before any code change, one throwaway image — the current `Dockerfile` plus
`apt-get install -y bubblewrap` — run under a seccomp profile that is Docker's
default with `unshare`/`clone` permitted for `CLONE_NEWUSER`:

    # 1. does bubblewrap work at all under the relaxed profile?
    docker run --rm --security-opt seccomp=./uf-seccomp.json usagefoundry:probe \
      bwrap --unshare-user --ro-bind / / --dev /dev true && echo BWRAP-OK

    # 2. does the CLI refuse to start when it cannot sandbox? (image WITHOUT bwrap)
    claude --settings '{"sandbox":{"enabled":true,"failIfUnavailable":true}}' \
      -p 'print ok' ; echo "exit=$?"        # expect non-zero, with a reason

    # 3. is the sandbox around the session or only around Bash?
    #    One write outside the allowlist via Bash, one via the Write tool.

    # 4. does a credentials deny entry stop a shell reading the token
    #    while the session still authenticates and bills?

Questions 2–4 are billed cycles and belong against a scratch repository. Question 3
is the gate: a session-wide sandbox confirms the recommendation, a Bash-only
sandbox promotes Option D to a live decision.

## Phase 2 — the image and the immovable policy

`Dockerfile`: one apt line for `bubblewrap` beside the existing block
(`:88`–`92`), and `/etc/claude-code/managed-settings.json` written root-owned 0644
with `sandbox.enabled`, `sandbox.failIfUnavailable: true`, a conservative
`sandbox.filesystem` and `sandbox.network`, and a `sandbox.credentials.files` deny
entry for `~/.claude/.credentials.json`. Root ownership is the point: agents are
`UF_AGENT_UID` and cannot write `/etc`, and the binary's own strings say a managed
`sandbox.filesystem` cannot be switched off by project settings — which matters
because a repository's `.claude/settings.json` is agent-writable.
`docker-compose.yml`: the `security_opt` line, commented in the register of the
file's existing ones, saying what it widens and what it does not.

    docker compose up --build
    docker compose exec --user "${UF_UID:-1000}" usagefoundry \
      sh -c 'echo x >> /etc/claude-code/managed-settings.json'   # expect denied
    docker compose logs usagefoundry | grep -i sandbox           # expect the boot line

At the end of this phase every run is sandboxed by one install-wide policy — the
network allowlist and the credential deny apply, and only per-run filesystem
scoping is missing.

## Phase 3 — per-run scoping

A `sandboxSettings(run)` beside `buildArgs` (`src/lib/orchestrator.ts:4396`)
producing the overlay that names this run's `worktree_path` and its `repo_root`'s
`.git` as the writable set. Same in `src/lib/review.ts:608` (which runs
`--permission-mode plan` and should get a read-only set) and both spawns in
`src/lib/chat.ts:1653` — the chat already passes `--add-dir` for every mount
(`src/lib/chat.ts:1632`), so its set is deliberately wider and that difference
belongs in a comment.

The unit test this earns, by `CLAUDE.md`'s rule that a pure function with a silent
failure mode gets one: both ways of being wrong are silent — too narrow fails
inside a tool call the run loop does not read, too wide is a boundary that is not
there. Assert the run's own worktree is writable, a *sibling's* is not, and
`CLAUDE_CONFIG_DIR` is, which is the metering path. Verify by hand with two
concurrent runs: A is asked to write into B's checkout and the tool call fails.

## Phase 4 — report it on the page

A sandbox that is on and one that is off must not look the same. The boot line from
Phase 0, a Settings row in the manner of the privilege-separation and GitHub-token
headers, and — the one that matters — a run event when a tool call fails for a
sandbox reason, so an operator can tell "the agent gave up" from "the policy
refused it". Without it a too-narrow allowlist is indistinguishable from an
unproductive run, the failure `seedReport` (`src/lib/orchestrator.ts:2434`) was
written to remove for seeding.

## What stays unverified, and the migration

`npm run typecheck` and `npm test` exercise none of this — the suite covers pure
functions (`docs/agent/testing.md`) and a sandbox is a property of a process.
`docs/verification.md` takes the manual results, and its "Not yet verified" list
should carry at least `bwrap`'s per-command overhead, behaviour at 25 concurrent
runs, and whether `sandbox.seccomp` narrows or widens.

Migration is light: no schema change, nothing in `migrate()`, worktrees keeping the
same paths, uid and `chownForChild`, and the fleet moving the way it does on every
upgrade — `docker compose up --build` restarts, `reconcileOnBoot` marks in-flight
runs failed, `stop_grace_period: 30s` (`docker-compose.yml:308`) gives the shutdown
handler its accounting window. One genuine risk: an install whose repositories keep
gitignored config outside the paths `settings.isolationCopyGlobs` names will find
those paths outside the write set too — a first-run failure inside a tool call,
which is why Phase 4 comes before this is called finished.

## Open questions this run could not determine

**Whether the CLI's sandbox wraps the session or only Bash.** Read out of the
binary's strings, not executed. Phase 1, question 3.

**Whether `sandbox.credentials` can mask the Anthropic OAuth credential** rather
than only deny it. The masking machinery in the strings is sigv4-shaped and its
re-signing proxy is described in AWS terms. Assumed not.

**Whether a per-uid boundary is enforced on Docker Desktop's `fakeowner`
filesystem.** Affects Option A only, and cannot be answered from a container
holding no privilege to change uid.

**What `sandbox.seccomp` filters**, and **the platform in general**: this install
is macOS Docker Desktop (`fakeowner` over `/run/host_mark/Users`, linuxkit 6.12.76
aarch64), but `docs/install.md` supports Linux too, and Option E's host-root
objection and Option F's availability both differ by platform.
