# Implementation sketch

Five phases and one decision between the first two. Each phase is useful alone;
none of the later ones gates the earlier.

> **`10-validation.md` disputes that last clause.** Phase 4 — the run event that
> distinguishes "the policy refused it" from "the agent gave up" — is the only way
> to *see* the failures Phases 2 and 3 introduce, and both of those ship first.
> A too-narrow allowlist fails inside a tool call the run loop does not read, so
> during Phase 2 and Phase 3 an operator has no signal at all. Move Phase 4 ahead
> of Phase 2, or accept that two phases ship blind. Phase 0's boot-line seam is
> not a substitute: it says the sandbox is *on*, not that it just refused
> something.
>
> One item is also **irreversible on an existing install** in a way this sketch
> does not flag. Phase 2 bakes `sandbox.failIfUnavailable: true` into the image
> while the seccomp relaxation lives in `docker-compose.yml`. An operator whose
> Docker rejects or drops the `security_opt` profile gets a fleet where *every*
> `claude` invocation exits non-zero, install-wide, with no off switch that is not
> a rebuild. Generate the managed file in `docker-entrypoint.sh` from an
> environment variable instead, so the enforcement level is something an operator
> can lower without one.

## The operator's three goals, and where this sketch lands against them

Added 2026-08-16, after the survey was written and scored. They are not the
criteria of `07-comparison.md`: **no run may signal another run's processes**;
**no run may write into a checkout that is not its own**; and — later, not now —
**a run should be able to install the tools it needs into a filesystem that is
discarded when it finishes**. The nine weighted criteria contain the second. They
do not contain the first at all, and the third is not an axis anywhere in the
survey. Against these three, Option B as specified below lands one, half-lands
one, and does not address one.

**Signalling — not addressed, and the weakest fit of the three.** What stands
between run A and run B's process tree today is `PROCESS_KILLERS`
(`src/lib/orchestrator.ts:4358`) and `SELF_HOSTING_NOTICE` (`:4383`): a tool deny
and a paragraph of system prompt, which `kill $(pgrep -f …)` walks around by
construction — `:4363`–`4365` says so in as many words. Option B does not change
it. The base bwrap argv read out of the pinned binary is `["--new-session",
"--die-with-parent"]` with **no `--unshare-pid`** (`02x-option-cli-sandbox.md:87`–`89`),
so a sandboxed command keeps the shared `/proc` and keeps signalling siblings at
one uid. The only option in the survey that closes this is **A**, whose
uid-per-slot boundary is a check `kill(2)` performs in the kernel rather than a
mode on a file — which also means the `fakeowner` caveat that is the whole of A's
risk (`02-option-harden-in-place.md:51`) does not apply to this half of it. A
scored 22 against B's 49 and is not recommended.

**The wrong checkout — half, and conditionally.** B closes it for *commands*,
once `~/.claude/settings.json` stops being agent-writable (`10-validation.md`,
finding 1) and *if* the sandbox wraps more than Bash — question 3 below, still
open. If it is Bash-only, a model using `Edit` against a sibling's path is
unconfined, and that is a likelier shape for a confused run than a shell command
is. Neither answer touches the sharper case: a worktree's `.git` is a pointer
into the main repository (`01-constraints.md`), so `<repo>/.git` is in the write
set under every option here, and two runs on one repository can still rewrite
each other's refs. Confining the checkout does not confine the branch. Only a
per-run clone does, and that is a different proposal.

**A discardable filesystem — absent.** Not a criterion, not a scored axis, and in
no option but E, which the survey ranks last on the Docker socket. B allowlists
paths in the filesystem that is already there; there is no writable overlay and
nothing to discard. The requirement is already acknowledged one layer down —
`Dockerfile:85`–`87` carries a 250 MB compiler on the ground that "an agent that
cannot install dependencies … fails at step one" — and what is missing is the
half that throws the result away instead of accumulating it in the image.

### What follows: the survey assumes only the CLI may invoke bubblewrap

Nothing stops this app from calling `bwrap` itself at the five spawn sites,
wrapping the whole `claude` process rather than configuring the CLI to wrap each
Bash call. The shape is the exec-wrapper `10-validation.md` reached for with
Landlock, so `docs/agent/architecture.md:102`'s four kinds of child stay four and
there is no supervisor to argue about. One move answers all three goals:
`--unshare-pid` closes the signalling case for the entire process tree including
the CLI's own file tools; a mount namespace confines `Edit`/`Write` and not only
Bash, which **retires** question 3 rather than waiting on it; and
`--overlay`/`--tmp-overlay` is a writable per-run root that exists for the length
of the process. Its precondition is the one Option B already pays for — Docker's
seccomp profile relaxed for `CLONE_NEWUSER` — so this is a second use of a trade
that is on the table either way, not a new one.

What it gives up is the vendor's `sandbox.credentials` deny. That needs a
boundary *between* the CLI and its children, which an outer wrapper cannot supply
by construction — the same limit `10-validation.md` records for Landlock, for the
same reason — and it is Option B's one headline credential win
(`08-recommendation.md:59`–`62`). This app would also own the `failIfUnavailable`
equivalent, which is the codebase's own rule about boundaries that disappear
quietly and not a nicety. **The two compose**: an outer wrapper for the three
goals above, the CLI's own layer inside it for the credential deny and the domain
allowlist, both behind one seccomp relaxation. Whether they actually nest is
**unverified** — question 8 below.

Nothing in the phases changes order. Phase 1 grows two questions and a decision
point; Phases 2–4 are written for the vendor route and are marked where the
wrapper route differs.

## Phase 0 — worth doing whichever option wins

**Name the between-runs gap in `docs/security.md`.** Its "What an agent can still
reach" lists four things and covers this one only by implication — "treat all four
workspaces as one blast radius" (`docs/security.md:72`). The measured fact is
sharper: a run can write a *concurrent run's checkout*, on a branch that will be
landed. One paragraph, with `00-problem.md`'s `test -w` command as its verification.

**Ship a `cpus` quota.** `docker-compose.yml:297` is `cpus: ${UF_CPUS:-0}` for a
good reason — Docker refuses a value above the host's CPU count — but the effect is
a shipped install with no CPU ceiling, and `README.md`'s own advice (`nproc` minus
one) is not in `.env.example`. Verified rather than proposed: `cat
/sys/fs/cgroup/cpu.max` from inside the container reads `max 100000`, i.e. no
quota, against `nproc` 12 (`10-validation.md`). Worth doing on that measurement
alone.

**Correct the stale rationale on `PROCESS_KILLERS`.**
`src/lib/orchestrator.ts:4344` withholds the killers by name "because there is no
ownership boundary to withhold it by: compose runs a single uid, so an agent and
the server supervising it can signal each other freely." `privsep.ts` has since
made that false for the case it describes — the server stays root and children
drop to `UF_AGENT_UID` (`src/lib/privsep.ts:23`–`33`), so `kill(2)`'s uid check
means the measured incident at `:4339`–`4342` cannot recur that way on an install
where the server is *actually* root. `npm run dev` on a laptop and a container an
operator has pinned back to `user: "1000:1000"` both still get the original
behaviour, which `privsep.ts:41`–`47` states. What the comment describes is now
true only **between two agents**, which is the first of the three goals above. A
stale rationale on a defence is how the defence gets deleted by the next person
who re-reads it, and this one is load-bearing until a PID namespace or a uid per
slot lands. One paragraph, no behaviour change.

**Extend the boot line.** `describeSeparation()` (`src/lib/privsep.ts:180`) states
the privilege arrangement in one line because that boundary disappears silently.
Whatever sandbox lands needs the same sentence from the same place; building the
seam now means the later phases only fill it in.

## Phase 1 — measure the assumption before building on it

Nothing in `02x-option-cli-sandbox.md` was executed; it was read out of the pinned
binary, and `10-validation.md` re-read it adversarially without executing anything
either. Before any code change, one throwaway image — the current `Dockerfile` plus
`apt-get install -y bubblewrap socat` and `npm install -g
@anthropic-ai/sandbox-runtime` — run under a seccomp profile that is Docker's
default with `unshare`/`clone` permitted for `CLONE_NEWUSER`:

    # 0. are the dependencies installable in this image at all?  (apt lists are
    #    removed at Dockerfile:92, so this could not be answered from inside)
    apt-get update && apt-cache policy bubblewrap socat

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

    # 5. does a user-settings write widen the policy?  Put
    #      {"sandbox":{"filesystem":{"allowWrite":["/tmp/probe"]}}}
    #    in ~/.claude/settings.json under a managed policy that does not name it,
    #    and see whether /tmp/probe becomes writable from a sandboxed command.

    # 6. what does the sandbox cost in tasks?  `pids` inside the cgroup during one
    #    sandboxed Bash call that opens a connection — expect bwrap plus two socat
    #    listeners plus one socat child per connection.

    # 7. does the CLI's sandbox unshare PID?  (goal 1; 02x:87-89 leans no)
    #    From inside one sandboxed Bash call: `echo $$`, `ls /proc | wc -l`, and
    #    whether a *sibling run's* pid is visible and signalable from it.

    # 8. can this app wrap the CLI itself, and is a discardable root available?
    #    Costs nothing extra — question 1's probe image already carries bwrap.
    bwrap --version          # bookworm ships 0.8.0, which is also the release
                             # --overlay/--tmp-overlay arrive in: at the boundary,
                             # so print it and try the flag rather than trust it
    bwrap --unshare-user --unshare-pid --die-with-parent \
          --ro-bind / / --proc /proc --dev /dev \
          --tmp-overlay /usr sh -c 'echo $$; touch /usr/probe && echo OVERLAY-OK'
                             # expect pid 1 (goal 1) and a write to /usr that
                             # leaves nothing behind (goal 3)
    #    then the nesting question, which decides whether the two routes compose:
    #    the same wrapper around `claude` with sandbox.enabled true, one Bash call
    #    inside it — does the CLI's own bwrap start inside ours, or fail?

Questions 2–7 are billed cycles and belong against a scratch repository; question
8's commands are not, and question 0 is first because the whole plan rests on it
and costs nothing. Question 5 decides whether Phase 3 confines anything at all —
if a user-settings write widens the policy, the ownership work in Phase 2 below is
not optional and not cosmetic.

Question 3 is still the gate, and what it gates has changed. A session-wide
sandbox confirms the recommendation. A Bash-only sandbox no longer promotes
Option D — D reaches confinement through the same vendor mechanism by its own
account (`04-option-runner-with-per-run-sandboxes.md:13`–`14`) and inherits the
same answer — it promotes the **wrapper route** above, which does not have to ask
the question. Questions 7 and 8 exist so that decision is made on a measurement
rather than on the argv `strings` happened to show.

## The decision Phase 1 gates

Two routes, one seccomp relaxation, and they are not exclusive.

**Configure the vendor's sandbox** — Option B as recommended, Phases 2–4 below as
written. Wins the credential: a `sandbox.credentials.files` deny entry is the only
mechanism in the survey that makes a `cat` of `~/.claude/.credentials.json` fail
from a run's shell while the session still bills. Wins loudness, on
`sandbox.failIfUnavailable`, which is this repository's own rule supplied by the
vendor. Costs the ownership surgery on `~/.claude`, a second vendor contract
(`@anthropic-ai/sandbox-runtime`) on top of `Dockerfile:194`'s pin, and it answers
one of the three goals above.

**Wrap the child ourselves** — a `sandbox.ts` producing bwrap argv, applied at the
five sites where `childCredentials()` is spread today, so the spawned binary is
`bwrap` and `CLAUDE_BIN` is what it execs. Wins all three goals by
construction rather than by measurement: `--unshare-pid` for signalling, a mount
namespace over `Edit` as well as Bash for the wrong checkout, `--tmp-overlay` for
a root that is discarded. Costs the credential deny, which needs a boundary the
outer wrapper cannot draw; costs a `failIfUnavailable` equivalent this app writes
and must keep loud; and costs the policy being ours to get wrong, where the vendor
route inherits a schema someone else maintains.

**Both** is the expected end state and the reason to measure question 8: the
wrapper supplies the three goals, the CLI's own layer inside it supplies the
credential deny and the domain allowlist. If they do not nest, the decision is
between a credential a run's shell cannot read and the three goals — and the
second of those goals is the one `README.md:56` calls "the gap the whole exercise
was reached for", while the credential is a thing every option in the survey
leaves reachable from the process that bills against it.

Two things the third goal costs, worth pricing before it is scheduled rather than
after. A discardable root that agents install into pulls **directly against the
network allowlist** — installing a tool *is* reaching an arbitrary registry, which
is the egress path `07-comparison.md` weights at 2 as the exfiltration route; the
resolution is a per-run allowlist naming registries rather than an off switch. And
any overlay must leave `$CLAUDE_HOME/projects` bound through unmodified, or the
transcript scan reads a discarded filesystem and every window and every budget
guard compares against nothing — `01-constraints.md`'s metering crossing, arriving
by a new door.

## Phase 2 — the image and the immovable policy

Written for the vendor route. Under the wrapper route this phase keeps the apt
line and loses the managed-settings file, the ownership surgery on `~/.claude` and
the second vendor contract; if the two compose, it is unchanged.

`Dockerfile`: `bubblewrap` **and `socat`** on the existing apt line (`:88`–`92`),
`@anthropic-ai/sandbox-runtime` installed globally beside the CLI (`:195`) or its
`vendor/seccomp/*` copied in and named by `sandbox.seccomp.bpfPath`/`applyPath`,
and `/etc/claude-code/managed-settings.json` written root-owned 0644 with
`sandbox.enabled`, `sandbox.failIfUnavailable: true`, a conservative
`sandbox.filesystem` and `sandbox.network`, and a `sandbox.credentials.files` deny
entry for `~/.claude/.credentials.json`. Root ownership is the point: agents are
`UF_AGENT_UID` and cannot write `/etc`, and the binary's own strings say a managed
`sandbox.filesystem` cannot be switched off by project settings — which matters
because a repository's `.claude/settings.json` is agent-writable.
`docker-compose.yml` takes the `security_opt` line, commented in the register of
the file's existing ones, saying what it widens and what it does not.

**And the ownership work `10-validation.md` added.** `~/.claude/settings.json` is
an honored source for `sandbox.filesystem` and is writable by `UF_AGENT_UID` today,
so the managed file above is not the only policy surface until this is done. Making
the *file* root-owned is not enough — a run that owns the directory can delete it
and write its own — so `~/.claude` itself becomes root-owned and the entries the
CLI writes are handed back individually (`projects/` above all, then `sessions/`,
`todos/`, `shell-snapshots/`, `history.jsonl`, `.credentials.json`). This is a
`docker-entrypoint.sh` change, it runs against a **bind-mounted host directory**
the operator also uses outside the container, and every entry that is missed shows
up as a dashboard of zeros rather than an error. Treat it as the riskiest step in
this phase, not a footnote to it.

    docker compose up --build
    docker compose exec --user "${UF_UID:-1000}" usagefoundry \
      sh -c 'echo x >> /etc/claude-code/managed-settings.json'   # expect denied
    docker compose exec --user "${UF_UID:-1000}" usagefoundry \
      sh -c 'echo x >> ~/.claude/settings.json; rm -f ~/.claude/settings.json'
                                                                 # expect both denied
    docker compose exec --user "${UF_UID:-1000}" usagefoundry \
      sh -c 'ls ~/.claude/projects >/dev/null && touch ~/.claude/projects/.probe'
                                                                 # expect BOTH to work
    docker compose logs usagefoundry | grep -i sandbox           # expect the boot line

At the end of this phase every run is sandboxed by one install-wide policy — the
network allowlist and the credential deny apply, and only per-run filesystem
scoping is missing.

## Phase 3 — per-run scoping

A `sandboxSettings(run)` beside `buildArgs` (`src/lib/orchestrator.ts:4396`)
producing the overlay that names this run's `worktree_path` and its `repo_root`'s
`.git` as the writable set — spelled as literal paths, because glob entries are
silently dropped on Linux (`10-validation.md`), which `isolationCopyGlobs`'
`.env.*` makes immediately relevant. Same in `src/lib/review.ts:608` (which runs
`--permission-mode plan` and should get a read-only set) and the one spawn in
`src/lib/chat.ts:1653` — the chat already passes `--add-dir` for every mount
(`src/lib/chat.ts:1632`) and runs `--permission-mode bypassPermissions`
(`:1616`), so its set is deliberately much wider and that difference belongs in a
comment.

The unit test this earns, by `CLAUDE.md`'s rule that a pure function with a silent
failure mode gets one: both ways of being wrong are silent — too narrow fails
inside a tool call the run loop does not read, too wide is a boundary that is not
there. Assert the run's own worktree is writable, a *sibling's* is not, and
`CLAUDE_CONFIG_DIR` is, which is the metering path. Verify by hand with two
concurrent runs: A is asked to write into B's checkout and the tool call fails.

Under the wrapper route this phase is the same function emitting bwrap argv
instead of a settings overlay, spread beside `childCredentials()` at the same five
sites, and it takes the same three assertions. Two differences worth having in
front of whoever writes it: the glob constraint disappears, because bwrap takes
`--bind` paths this app builds rather than a settings array the CLI filters
(`10-validation.md`); and the sibling assertion becomes true of `Edit` as well as
Bash, which is what the test is actually for.

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
runs, and whether `sandbox.seccomp` narrows or widens. Add the `pids` term from
Phase 1's question 6: `README.md:744`'s `256 × (runs + others + 1)` has no term for
a `bwrap` and two `socat` bridges per sandboxed command, and this install's
`pids.max` is 2048 with `memory.max` already above the VM's own `MemTotal`.

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
binary's strings, not executed — Phase 1, question 3. `10-validation.md` adds one
piece of evidence pointing the other way from the Bash-tool prose: a
`getFsReadConfig` export returning `{denyOnly, allowWithinDeny}`, which is the
shape a *file tool* consults rather than a shell wrapper. Still unsettled.
**Whether `sandbox.credentials` can mask the Anthropic OAuth credential** rather
than only deny it; the masking machinery in the strings is sigv4-shaped and its
re-signing proxy is described in AWS terms, so assumed not — though generic
`files` mask entries ("sentinel binds") do exist, so the honest form of the
question is whether a masked token still authenticates. **Whether a per-uid
boundary is
enforced on Docker Desktop's `fakeowner` filesystem**, which affects Option A's
*filesystem* half only — its signalling half is a `kill(2)` uid check the kernel
performs and no bind-mount remapping reaches — and cannot be answered from a
container holding no privilege to change uid.

**Whether bookworm's `bubblewrap` carries `--overlay`/`--tmp-overlay` and whether
overlayfs mounts inside a user namespace work on this kernel.** The base image is
`node:22-bookworm-slim` (`Dockerfile:40`), the flags arrive in bubblewrap 0.8.0,
and unprivileged overlayfs arrives in Linux 5.11 against this kernel's 6.12 — so
both are expected and neither is measured. The risk is not the version, it is the
placement: an upper and work directory over a `fakeowner` bind mount is where this
would fail on the platform this install runs, and nowhere else in the survey does
a claim depend on that filesystem doing something rather than merely presenting
ownership. **Whether the CLI's own bwrap nests inside one this app started**,
which decides whether the two routes compose or choose. Both are question 8.

**Rootless Podman as a third route, not given a file.** Once the seccomp profile
permits `CLONE_NEWUSER`, a per-run *container* no longer needs the Docker socket
that makes Option E net-negative (`05-option-per-run-container.md:14`–`22`), which
is the one objection that sank it. It is left unscored rather than argued because
multi-id mapping wants setuid `newuidmap`/`newgidmap` in the image, a single-id
mapping is most of what bwrap already gives for a fraction of the moving parts,
and Option E's other costs — the mount list per run, the lifecycle surviving a
server restart, `docker compose down` not knowing about it — are unchanged by
where the socket went. Named here so the next reader does not mistake its absence
for a judgement that it is impossible. **What
`sandbox.seccomp` filters.** And **the platform in general**: this install is macOS
Docker Desktop (`fakeowner` over `/run/host_mark/Users`, linuxkit 6.12.76 aarch64),
but `docs/install.md` supports Linux too, and Option E's host-root objection and
Option F's availability both differ by platform.
