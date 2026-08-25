# Option K — build no terminal

No pane, no route, no session, no exec endpoint. The shell an operator needs
already exists and is one command away from the machine they are already logged
into: `docker compose exec`.

Every option file in this directory needs a null hypothesis to beat.
`06-option-build-nothing.md` is the substrate half's; this is the surface half's,
and it is stronger, because the substrate question at least had a gap
(`00-problem.md` §"Missing 4") and this one does not.

## 1. The strongest case

The shell is already shipped. It is `docker compose exec`, and **this repository
documents it twenty-one times across its four operator-facing pages** —
`install.md` 10, `security.md` 4, `README.md` 4, `backup-and-restore.md` 3, and 55
times across the whole tree — including for the exact class of
task the terminal was requested for: `docker compose exec usagefoundry uv tool
list` and `uv tool uninstall` (`docs/install.md:254-255`), `gh extension list` and
`remove` (`:150-151`), a database backup (`README.md:157`), the sandbox probes
(`docs/security.md:59-117`), and the sign-in flow (`docs/install.md:49-50`). It
runs at whichever uid you name, needs no credential the operator does not already
hold, has no transport to build, no session to reap, no output cap to get wrong,
and cannot be reached by anybody who is not already on the host. Building a web
terminal replaces that with a surface that is **strictly weaker on security** —
the host shell requires host access, the web shell requires a cookie — and
**strictly weaker on capability**, because `docker compose exec` can do things no
in-container terminal ever can: restart the container, rebuild the image, inspect
the volumes, and read `/proc/1/environ`. The one thing it lacks is that it is not
in the browser, and *"the operator would prefer not to open a second window"* is
not a reason to add remote code execution to a product.

## 2. Shape

Nothing in `src/`. Documentation, and one honest sentence in the UI:

1. **A section in `docs/install.md`** — "Running commands in the container" —
   giving the `docker compose exec` recipe with the uid read out of the container
   rather than out of the operator's shell, because that mistake is already
   documented as one this page made: *"Not `-u "${UF_UID:-1000}"`, which is where
   this page used to send you. Your own shell expands that, and `.env` is not in
   your shell"* (`docs/install.md:52-56`). The correct pair is at `:49-50`.
2. **A line on the Settings page** naming that recipe, so the operator who is
   looking for a Terminal entry in the left menu finds the answer where they
   looked. This is the only change that touches `src/`, it is a `Field` `hint`,
   and it is the difference between this option being an answer and being a
   refusal.
3. **`06-` §2's four documentation items**, which are this option's substrate half
   and are not re-argued here.
4. **A `docs/security.md` paragraph** stating that this app deliberately exposes no
   shell, and why — because the next person to propose one should find the
   argument rather than re-derive it. `proposals/ContextControl/` is the
   precedent: a survey that closed with a recommendation against every mechanism
   it examined, kept for the argument.

## 3. What persists it, and what discards it

`docker compose exec` is a property of Docker, not of this image, so it survives
all four of `01-constraints.md` §1's events, a fresh host and a `git clone`. It is
the only "surface" in this directory that cannot be broken by a rebuild.

What an operator *installs* through it persists exactly as far as the substrate —
identical to `09-` §3 and `10-` §3, because it is the same shell hitting the same
filesystem. **This option is not worse than the terminal options on persistence;
it is the same, and the terminal options do not improve it.** That is worth
stating plainly, because the operator's sentence links the two ideas and they are
not linked: a shell in the browser makes nothing more durable than a shell on the
host, and neither can rebuild the image (`docker-compose.yml:469-476` — no Docker
socket).

`scripts/backup-db.mjs` is unaffected.

## 4. Reach

Identical to `09-` §4, unchanged, and for the same reason: `PATH` reaches all five
kinds of child untouched (`orchestrator.ts:6244-6246`, `git.test.ts:93`), the uid
decides what is writable, and `acceptEdits` may still refuse the invocation
(`00-problem.md` §"Missing 3").

`docker compose exec` has one reach advantage over every in-container option and
it is not small: **`-u` takes any uid**, so the operator can install as
`UF_AGENT_UID` for the reason `docker-entrypoint.sh:140-144` gives, *and* run a
root command when they genuinely need one, in the same session, deciding each
time. Every option in `09-` to `12-` has to pick one at design time and live with
`08-` §3's consequences.

## 5. Tool state, not the binary

Identical to `09-` §5 and unimproved: `$HOME` is not on a volume except the three
carved subdirectories, and a tool authenticated in the container is
unauthenticated by the next `up --build`.

One genuine advantage: `docker compose exec -it` **has a TTY**, so
`terraform login`, `gh auth login` and `apt-get` without `-y` all work. `10-` §5
cannot do any of the three, and `11-`/`12-` cannot do them either. **The shipped
mechanism is strictly more capable than three of the four things this directory
proposes replacing it with**, and only `09-`'s full PTY matches it.

## 6. What it does to the boundaries

**It does not move them, and that is the whole of the option.**

- `/data` 0700 root — unchanged. A root `exec` can read it; that is host access,
  which is a boundary that already exists and is not being widened.
- The root/`UF_AGENT_UID` split — unchanged. `-u` is a per-invocation choice by
  somebody who already has the host.
- `UF_CHAT_GID`, the CLI sandbox write allowlist, the read guard, worktree
  isolation — all unchanged.
- The folder claim — **and here this option is exactly as bad as `09-` and `10-`.**
  A `docker compose exec` shell writing into a folder a run holds is undetected by
  every mechanism in this app (`08-` §8), because nothing watches the filesystem.
  This is not an argument for the terminal — the hazard exists today and neither
  option removes it — but it is the one place where "no new surface" does not mean
  "no exposure", and it should be counted honestly.
- The suicide case — **also unchanged and also already real.** A root `exec` can
  `pkill` the server today; the measured incident (`orchestrator.ts:5147-5150`)
  came from an agent, not from a shell. What this option preserves is that doing
  it requires host access rather than a cookie.

What it hands an agent that the agent did not have: **nothing.** No new route, no
new credential, no new child.

## 7. The operator's surface

A documented command and a hint in Settings. What they configure: nothing. A
restart does nothing to it.

**The honest cost is discoverability, and it is the same cost `06-` §8 names: it
fails by being ignored.** An operator who asked for a point on the left menu is
being told to open a terminal on the host, and the `.env.example:222-226`
precedent — 213 sessions told a plugin was active against a command that was never
present — is exactly what happens when the answer is a paragraph nobody reads. The
Settings hint in §2 item 2 is not decoration; without it this option is a refusal
wearing a documentation change.

Removal of an installed tool is the tool's own uninstall, or the two documented
`uv tool uninstall` / `gh extension remove` recipes (`docs/install.md:150-151`,
`:254-255`).

## 8. How it fails, and whether loudly

It fails **silently, by being ignored**, which is the same failure `06-` §8
records and the one this repository has already been bitten by once.

The specific silences it leaves standing, all pre-existing and none introduced:

- A `gh` extension or Python tool that fails to install at boot is a stderr line,
  best effort, never fatal (`docker-entrypoint.sh:165-168`, `:305-308`).
- A hook body ending in `|| true` turns a missing command into a hook that exits 0
  having done nothing (`docker-compose.yml:405-408`).
- A missing binary inside a `Bash` call is a tool call the run loop does not read,
  filed as the agent choosing not to use it (`docker-compose.yml:386-391`).
- **`00-problem.md` §"Missing 4" is untouched**: nothing in the app can see what is
  installed. This option's answer to that is "nothing", and it should be scored as
  a loss rather than defended. `12-` is the option that closes it.

What it does *not* leave standing is every failure mode in `09-` §8 and `10-` §8:
no backpressure gap, no session reaper, no output cap, no root-in-a-browser, no
audit-log lever, no keystroke capture, no `upgrade` handler on a server this repo
does not own.

## 9. What it costs to build

**One day**, and most of it is `06-` §2's four documentation items, which are
worth doing regardless of which option wins.

No `src/` change beyond one `Field` hint. No schema, no route, no dependency, no
test, no invariant moved anywhere in `docs/agent/`. It is the only option in this
half of the directory that could ship this week, and — like `06-` — it is the one
whose cost is entirely in the writing.

## 10. What would have to be true

**Promotes it:** that the operator, or anybody else, ever deploys this on anything
but loopback. `docker-compose.yml:76-77` binds `127.0.0.1` by default and the file
warns at length about moving it; `.env.example` calls `UF_ALLOW_NO_AUTH` *"only
ever right for a loopback-bound install on a machine you alone use"*. **On a
`UF_ALLOW_NO_AUTH=1` install — sanctioned, documented, and probably common — a
terminal pane is an unauthenticated root shell for any local process that can open
a TCP connection to port 3000** (`08-` §2). That configuration exists today and
the terminal options each have to answer for it. This one does not.

**Kills it:** the operator not having host access to the container in the first
place. That is the one scenario where `docker compose exec` is not an answer — a
UsageFoundry run on a machine somebody else administers, or a hosted deployment
this repository does not currently have. If that is where this is going, then
every argument in this file collapses at once, because the shipped mechanism is
simply absent and the browser is the only door. **Nobody here knows whether that
is the plan.** It is a question for the operator and it is the single most
decision-relevant thing left unanswered in this proposal — more than the transport
probes, because it decides whether the transport question is worth asking.
