# Sandbox probe — runbook

[← Verification log](../../docs/verification.md) ·
[the proposal this measures](../../proposals/Sandboxing/09-implementation-sketch.md)

`proposals/Sandboxing/` recommends letting the pinned Claude CLI sandbox itself
with bubblewrap (Option B). **Every claim about that mechanism was read out of
the pinned binary's strings and none of it has ever been executed.** Two runs
have now written about it without starting one. This directory is the harness
for the measurement — Phase 1, questions 0 through 8 of
`09-implementation-sketch.md:134`–`200` — and running it is a person's job on a
machine with Docker, not an agent's.

**Nothing here has been executed either.** No question in it has an answer. The
container this was written in has no `docker` binary, no `/var/run/docker.sock`,
no root for `apt-get`, and `unshare --user` returns `Operation not permitted`
under Docker's default seccomp profile — which is the very thing question 1 is
about. What *has* been exercised is the script's answer logic against stubs
(`probe.test.sh`, 37 assertions) and the seccomp profile's derivation against
moby's published default (`seccomp-diff.mjs`). Neither of those is a measurement
of the CLI.

## What is in here

| File | What it is |
|---|---|
| `Dockerfile.probe` | Two throwaway images: the repository's base and CLI pin, plus `bubblewrap`, `socat` and `@anthropic-ai/sandbox-runtime` (`probe`), and the same without them (`probe-nobwrap`, which is the only way to ask question 2). |
| `uf-seccomp.json` | Docker's default seccomp profile with user namespaces permitted, and nothing else. Read its `_comment`. |
| `seccomp-diff.mjs` | Proves that file is your Docker's default plus four named blocks. Step 1 below. |
| `probe.sh` | The nine questions. One `Q<n>: TOKEN` line each. |
| `probe.test.sh` | Drives `probe.sh`'s answer logic against stubbed binaries. No Docker, no money. |

Nothing here ships. `docker-compose.yml`, `Dockerfile`, `docker-entrypoint.sh`
and `src/` are untouched by this directory, and **no sandbox is enabled by
running any of it**.

## Before you start

On the machine that runs UsageFoundry, or any machine with the same Docker and
the same architecture. You need:

- Docker, and the ability to pass `--security-opt seccomp=…` (Docker Desktop and
  Docker Engine both allow it; some managed environments do not).
- A working `~/.claude/.credentials.json` — i.e. `claude -p 'hi'` succeeds on
  that machine. Steps 4 and 5 authenticate as you and bill you.
- About 20 minutes, and under a dollar.

Two things this harness deliberately does *not* touch. It never uses your real
`~/.claude` as the CLI's config directory — the probe writes a user-settings
file and seven transcripts, and those belong in a container that gets thrown
away. And it never opens `.credentials.json`: Docker bind-mounts that one file,
read-only, into the throwaway config directory, so the session authenticates as
you while the script itself never reads a byte of it.

---

## Step 1 — check the seccomp profile against your own Docker (2 minutes, free)

`uf-seccomp.json` was derived from moby **v28.5.2**'s copy of the default
profile — sha256 `01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28`,
byte-identical to `profiles/seccomp/default.json` at v28.3.3. The default moves
between engine releases — measured, by running the check below against three
tags: v28.1.1 to v28.5.2 gained twelve names including three `lsm_*`, and
v24.0.7 allowed the `io_uring` family that v28 no longer does. A profile derived
from the wrong one either denies something your containers rely on or permits
something nobody read. Check it before you use it:

```sh
docker version --format '{{.Server.Version}}'      # note the version

# engines up to 28.3.x:
curl -fsSL -o /tmp/upstream.json \
  https://raw.githubusercontent.com/moby/moby/v<VERSION>/profiles/seccomp/default.json
# engines from 28.4.0 on, where the profile moved into its own module:
curl -fsSL -o /tmp/upstream.json \
  https://raw.githubusercontent.com/moby/moby/v<VERSION>/vendor/github.com/moby/profiles/seccomp/default.json

node scripts/sandbox-probe/seccomp-diff.mjs /tmp/upstream.json
```

No node on that machine? Do it after step 2, in the image, which has one:

```sh
docker run --rm --entrypoint node \
  -v "$PWD/scripts/sandbox-probe:/p" -v /tmp/upstream.json:/u.json \
  usagefoundry:probe /p/seccomp-diff.mjs /u.json /p/uf-seccomp.json
```

Expect `OK: everything outside those 4 blocks is /tmp/upstream.json verbatim.`
If it reports drift, re-derive from *your* upstream: take the four blocks it
printed, append them to your `default.json`, and widen nothing else. The four
are two `clone` rules and one `unshare` rule gated on `CLONE_NEWUSER`, and one
block permitting `mount`, `umount2` and `pivot_root`.

**Why that last block exists**, since the proposal does not mention it: Docker's
default gates `mount`/`umount2` behind `CAP_SYS_ADMIN` and does not list
`pivot_root` at all, and those capability gates are resolved by the daemon
against the container's bounding set when it generates the profile — so in a
container with no `CAP_SYS_ADMIN` they are simply absent and every one of them
returns `EPERM`. A profile carrying only the `clone`/`unshare` relaxation would
fail at bubblewrap's first `mount`, not at its `clone`, and question 1 would
report a blocked sandbox for the wrong reason. Permitting the syscall is not
permitting the operation: the kernel still requires `CAP_SYS_ADMIN` over the
user namespace that owns the caller's mount namespace, which these processes
only ever hold inside a namespace they created themselves. **This reasoning is
derived, not executed. Question 1 is what tests it**, and if `Q1` comes back
`BWRAP-BLOCKED` with user namespaces working, this block is the first place to
look.

## Step 2 — build the two images (5 minutes, free)

```sh
docker build -f scripts/sandbox-probe/Dockerfile.probe \
  --target probe -t usagefoundry:probe scripts/sandbox-probe
docker build -f scripts/sandbox-probe/Dockerfile.probe \
  --target probe-nobwrap -t usagefoundry:probe-nobwrap scripts/sandbox-probe
```

A build failure here is already an answer: the `probe` target's apt line failing
is question 0 answered `UNAVAILABLE`, and the `apply-seccomp` assertion failing
means `@anthropic-ai/sandbox-runtime` ships nothing for this architecture, which
is the dependency whose absence downgrades the network boundary to a warning.

## Step 3 — the free questions (2 minutes, free)

```sh
docker run --rm \
  --security-opt seccomp=./scripts/sandbox-probe/uf-seccomp.json \
  usagefoundry:probe --free
```

Answers `Q0`, `Q1`, `Q8a`, `Q8b`, `Q8c`. **Stop here and read them.** If `Q1` is
not `BWRAP-OK`, questions 3 through 7 will be measuring a sandbox that never
started, and their answers will look like "the sandbox does not confine
anything". Fix that first.

Worth running the same command **without** `--security-opt` once, as a control:
it should report `Q1: BWRAP-BLOCKED … user-namespaces-refused-too`, which is
what the relaxation is buying. If it does not, the profile is not being applied
and neither is anything else you measure afterwards.

## Step 4 — question 2, in the image without bubblewrap (billed)

```sh
docker run --rm -it \
  --security-opt seccomp=./scripts/sandbox-probe/uf-seccomp.json \
  -v "$HOME/.claude/.credentials.json:/probe-home/.claude/.credentials.json:ro" \
  usagefoundry:probe-nobwrap --only 2 --billed
```

The profile is passed here too, even though nothing in this image can use it, so
that the only difference between this run and step 5 is bubblewrap's presence.
Without `--yes-bill` the script asks for a typed `BILL` — that is what `-it` is
for. `--yes-bill` skips the question if you are scripting it.

## Step 5 — the billed questions (10 minutes, under a dollar)

```sh
docker run --rm -it \
  --security-opt seccomp=./scripts/sandbox-probe/uf-seccomp.json \
  -v "$HOME/.claude/.credentials.json:/probe-home/.claude/.credentials.json:ro" \
  usagefoundry:probe --billed
```

Seven `claude -p` turns, each capped with `--max-budget-usd 0.20` on `sonnet`,
all of them inside a scratch git repository in the container's own filesystem.
The script refuses to run them against anything this app mounts.

If a turn fails to authenticate, the likeliest cause is the `:ro` on the
credential mount: the CLI refreshes an expiring OAuth token by rewriting that
file. Run `claude -p 'hi'` on the host first to refresh it, then re-run. Drop
the `:ro` only if you accept that a probe container can then rewrite your live
credential.

---

## What each answer decides

| Line | Answer | Decides |
|---|---|---|
| `Q0` | `AVAILABLE` / `UNAVAILABLE` | Whether any of this is buildable. `UNAVAILABLE` ends the option. |
| `Q1` | `BWRAP-OK` / `BWRAP-BLOCKED` | Whether Option B has a floor. Everything after it depends on this. |
| `Q2` | `REFUSED` / `RAN-UNSANDBOXED` | Whether `sandbox.failIfUnavailable` is the loud failure this repository's own rule asks for, or a string in a binary. `RAN-UNSANDBOXED` means the enforcement level has to be this app's job. |
| `Q3` | `SESSION-WIDE` / `BASH-ONLY` | **The gate. See below.** |
| `Q4` | `DENY-WORKS` / `DENY-INEFFECTIVE` | Option B's one headline win: a `cat` of `~/.claude/.credentials.json` failing from a run's shell while the session still bills. `DENY-INEFFECTIVE` removes the main reason to prefer the vendor route over an outer wrapper. |
| `Q5` | `USER-SETTINGS-WIDEN` / `USER-SETTINGS-IGNORED` | Whether Phase 2's ownership surgery on `~/.claude` is load-bearing or cosmetic. `WIDEN` means a run can append `{"sandbox":{"filesystem":{"allowWrite":["/"]}}}` to its own settings and the next session is confined to nothing — and that the surgery, which runs against a bind-mounted host directory and fails as a dashboard of zeros, is not optional. |
| `Q6` | `MEASURED baseline=… peak=… bwrap_max=… socat_max=…` | The term `README.md:744`'s `256 × (runs + others + 1)` does not have. Feeds `pids_limit` at 25 concurrent runs. |
| `Q7` | `PID-SHARED` / `PID-ISOLATED` | Goal 1, "no run may signal another run's processes". `PID-SHARED` — which the argv read out of the binary leans towards — means the vendor route does not address it at all. |
| `Q8a` | `BWRAP-VERSION <v>` | Whether `--overlay`/`--tmp-overlay` exist. They arrive in 0.8.0 and bookworm ships 0.8.0, which is the boundary rather than a margin. |
| `Q8b` | `OVERLAY-OK` / `OVERLAY-UNAVAILABLE` / `OVERLAY-REFUSED` | Goals 1 and 3 for the wrapper route: `pid=1` and a write to `/usr` that leaves nothing behind. `OVERLAY-REFUSED` on Docker Desktop is the interesting failure — an overlay's upper and work directory over a `fakeowner` bind mount is the one place in this survey where a claim depends on that filesystem *doing* something rather than merely presenting ownership. |
| `Q8c` | `NEST-OK` / `NEST-BLOCKED` | The cheap half of the nesting question: whether this kernel and this profile permit a second user namespace inside the first. Necessary, not sufficient. |
| `Q8d` | `NEST-OK` / `NEST-FAILED` | **The real nesting answer. See below.** |

## The two that decide the shape

**Question 3 and question 8.** Everything else refines a route; these two choose
between them.

`Q3: SESSION-WIDE` confirms the recommendation: the vendor's sandbox wraps the
model's own file tools as well as Bash, Option B stands alone, and Phases 2–4 of
the sketch are written correctly as they are.

`Q3: BASH-ONLY` means a model using `Edit` against a sibling run's checkout is
unconfined — a likelier shape for a confused run than a shell command is — and
the answer is no longer Option D (which reaches confinement through the same
vendor mechanism and inherits the same answer) but the **outer wrapper**: this
app calling `bwrap` itself at the five spawn sites, which does not have to ask
the question at all.

`Q8d` then decides whether that is a choice or a composition. `NEST-OK` and the
two layers compose: the wrapper supplies the PID namespace, the mount namespace
over `Edit` and the discardable root, and the CLI's own layer inside it supplies
the credential deny and the domain allowlist, both behind the one seccomp
relaxation this file is about. `NEST-FAILED` and the decision is between a
credential a run's shell cannot read (`Q4`) and the three operator goals — with
`Q8b` deciding whether the third of those goals is even on the table.

Read `Q7` and `Q8b` together with them: if `Q7` is `PID-SHARED` and `Q8b` is
`OVERLAY-OK`, the wrapper route is the only one of the two that answers goals 1
and 3, whatever `Q3` says.

## Afterwards — write it down

The last block the script prints is the one to transcribe. Copy those `Q<n>:`
lines, the CLI version, the bubblewrap version and the kernel line into
`docs/verification.md` — the results table under *The CLI's own sandbox* is
empty and marked unmeasured, and it stays that way until somebody runs this.
While you are there, move whatever the answers settle out of that file's *Not
yet verified* list, and leave whatever they do not.

Then `docker image rm usagefoundry:probe usagefoundry:probe-nobwrap`. The
throwaway config directory, the scratch repository and every transcript the
probe wrote go with the container.

## What this harness cannot tell you

- **Whether a *masked* credential still authenticates.** Question 4 reports
  readable or denied and nothing else, because telling a mask from a real read
  means reading the bytes, and this script does not do that at any verbosity.
- **Anything about 25 concurrent runs.** Question 6 measures one sandboxed
  command in an idle container. The arithmetic at fleet scale is still
  arithmetic.
- **Whether `sandbox.seccomp` narrows or widens.** Not asked here; it is on
  `docs/verification.md`'s list and stays there.
- **The settings schema.** Every `sandbox.*` key this script writes was read out
  of the binary's strings by a proposal, not from a specification. A key the CLI
  silently ignores looks exactly like a policy that does not confine — which is
  why `Q3` answers `INCONCLUSIVE` rather than `BASH-ONLY` when *both* writes
  land, and why `Q1` and `Q2` are worth reading before the rest.
- **The uid.** The probe runs everything as root; the shipped image runs the
  server as root and drops children to `UF_AGENT_UID`. Question 5 is the one
  where that difference could matter.
