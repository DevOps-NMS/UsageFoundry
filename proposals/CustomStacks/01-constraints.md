# What any option has to survive

Everything below was checked against the tree at `fe52cab`. Where a claim could
not be checked — and several central ones could not, because **this container has
no Docker** — the sentence says so at the point it is made.

---

## 1. The four events an option is scored against

"Persistent" is not one property here. It is four, and the existing volumes
satisfy three of them and not the fourth. Every option file states which of these
it survives, under heading 3.

| Event | What it destroys | What survives it |
|---|---|---|
| `docker restart` | nothing on disk | everything, including the writable layer |
| `docker compose up --build` | **the writable layer** | image layers, bind mounts, named volumes |
| `docker compose down -v` | **named volumes** | image layers, bind mounts |
| a fresh host, `git clone` + `up` | named volumes *and* the writable layer | image layers, and only what the repository can rebuild |

The middle row is the operator's stated problem and it is the row the three
existing volumes were created for (`docker-compose.yml:370-409`). The bottom row
is the one no existing mechanism satisfies except through the boot-time install
loops, and it is why a proposal that ends at "a writable volume on `PATH`" is
answering half the question.

**Not checked here.** No `docker compose up --build` was run, no volume was
created and none was destroyed. Docker is not installed in this container. The
table is the documented semantics of those commands plus this repository's own
statements of them (`docker-compose.yml:370-382`, `.env.example:212-213`,
`docs/backup-and-restore.md:8`), and nothing in this proposal is written as
though a rebuild had been observed.

## 2. The volume-masking trap, which is the sharpest constraint in the file

**A named volume takes its contents from the image exactly once, at creation.**
So a file written into an image path that is also a volume mount point is
*masked* by whatever the existing volume already holds, on every install that has
run before.

This is not inferred. It is written down twice, in the two places that had to
work around it:

> `/opt` rather than `/home/node/pytools`, and that is the whole reason it
> survives: that path is a named volume, and a volume takes its contents from the
> image exactly once, at creation. An install written there during a build is
> masked by whatever the existing volume already holds — which is precisely the
> "installed by hand, lost on rebuild" failure this is meant to end.
> — `Dockerfile:303-309`

and again for the Playwright browsers, which are in `/opt/playwright/browsers`
and not a fifth volume for the same reason (`docs/agent/environment.md:33`).

`src/lib/deployment.test.ts:892` pins it: *"keeps that directory off every named
volume"*.

**The consequence for this survey.** Any option that says "ship a default
toolchain in the image *and* let the operator add to it in a volume at the same
path" is broken on every existing install and correct on a fresh one — which is
the worst available failure, because the developer testing it has a fresh
install. An option must put the image's contents and the operator's contents at
**different paths**, or accept that the image half never upgrades.

## 3. `childEnv` strips `UF_*`, and that closes one obvious design

`childEnv` (`src/lib/orchestrator.ts:6306-6321`) copies the server's whole
environment, sets `FORCE_COLOR=0`, and deletes six classes:

```
UF_*   OTEL_*   ANTHROPIC_ADMIN_KEY   CLAUDE_CODE_ENABLE_TELEMETRY
DATA_DIR   NODE_OPTIONS
```

`chatEnv` (`src/lib/chat.ts:2251-2266`) is the same six, plus `githubEnv()`.

Two things follow.

**`PATH` passes through untouched.** It is not on the strip list, and the
docblock says so by name: *"Everything else passes through. The CLI needs PATH,
HOME, CLAUDE_CONFIG_DIR, proxy and CA settings, and locale to function at all, so
an allowlist would fail in ways that are tedious to diagnose from inside a
container"* (`src/lib/orchestrator.ts:6244-6246`). This is what makes
`Dockerfile:281`'s `ENV PATH="/home/node/pytools/bin:${PATH}"` reach an agent's
shell at all, and the Dockerfile comment states the mechanism in the same words
(`Dockerfile:271-274`).

**A `UF_`-named variable cannot be read by the child.** So an option shaped
"`UF_STACK_DIR=/opt/stacks`, and the agent's tooling reads it" does not work: the
child never sees it. The variable can be read by `docker-entrypoint.sh` (which
runs before `exec` and is not subject to the strip) or by the server, and the
result has to reach the child as `PATH`, as some non-`UF_` variable, or as a file
on disk. This is the same rule `UF_GH_EXTENSIONS`, `UF_PY_TOOLS`, `UF_SANDBOX*`
and `UF_LOCK_CLAUDE_HOME` already live under — the wildcard is three names, so
all six are consumed entirely by the entrypoint and read by nothing in `src/`
(`docs/agent/environment.md:26-31`).

It is also the rule that keeps them off the blank-by-default warning surface: a
variable `config.ts` reads through `env()` and compose renders as `${VAR:-}`
becomes a permanent dashboard warning on every stock install
(`docs/agent/environment.md:17`). A new variable in this area should be
entrypoint-only for that reason as well as this one.

## 4. The uid split, and what a root-installed file does to an agent

The container runs as root — `user: "0:0"` (`docker-compose.yml:64`) — and the
agent children are dropped to `UF_AGENT_UID:UF_AGENT_GID`, which compose fills
from `${UF_UID:-1000}` / `${UF_GID:-1000}` (`docker-compose.yml:263-264`).

The repository has already decided how an operator-installed executable must be
owned, and decided it twice, in the same words:

> Every install runs as the uid that will *run* the extension — an extension is
> an executable an agent invokes, and root-owned files here would leave the
> agents unable to remove or upgrade what they run.
> — `docker-entrypoint.sh:140-144`, and again at `:213-215` for `uv`

Both loops therefore install under `setpriv --reuid --regid --clear-groups`
(`docker-entrypoint.sh:145-153`, `:216-224`).

And the opposite decision, for the one binary the *run loop* invokes rather than
the agent:

> Root-owned and 0755: every agent uid reads it, none writes it. A tool the run
> loop shells out to on every cycle boundary, sitting in a directory a sibling
> agent could rewrite, would be a way for one run to put its own code on every
> other run's transcript.
> — `Dockerfile:311-314`

So there are two correct ownerships and which one applies is decided by **who
invokes the binary**, not by where it lives. An option that ships one directory
for both kinds of tool has to say which rule it takes.

Reading and executing a root-owned 0755 file is not the problem; *upgrading and
removing* it is. That is the failure both loops are written to avoid.

## 5. `/data` is 0700 root-owned and is not available

`/data` ships root-owned 0700 and `docker-entrypoint.sh` reclaims it on every
boot, because a volume created by an earlier release is `node:node 0777` and
stays that way through any number of image pulls (`docker-compose.yml:358-368`,
`Dockerfile:517-519`). The mode is *"the whole of what keeps an agent out of the
database, the settings the guards read and the server lock"*
(`docker-compose.yml:363-364`).

The Go cache comment states the corollary for a tool volume directly: *"not
inside /data, [which] is root-owned 0700 precisely to keep the agents out — while
this is the one directory they must be able to write"* (`docker-compose.yml:378-381`).

**No option may put an agent-writable toolchain under `/data`.** Confirmed from
inside this container: `ls -la /data` returns `Permission denied`, which is the
same reading three earlier proposals took (`proposals/GrowthLimits/00-problem.md:138`).

## 6. Nothing backs up a named volume

`scripts/backup-db.mjs` writes one file: a `VACUUM INTO` snapshot of
`/data/usagefoundry.db` into the `/backups` bind mount
(`docs/backup-and-restore.md:14-31`, `:118-123`). `docs/backup-and-restore.md:129-142`
enumerates what is deliberately excluded — the agents' git branches, and
`~/.claude` — on the grounds that both have other copies.

**A toolchain volume would have neither a backup nor another copy.** It is the
first thing this app would hold that is neither in the image, nor in git, nor on
the host, nor in the database. `docker compose down -v` destroys it and
`docs/backup-and-restore.md:8` describes that command as the one the whole backup
path exists to survive.

Every option states, under heading 3, what its answer to that is. There are only
three honest ones: the volume is a **cache** and the declaration is the durable
thing; the volume is **backed up** by something new; or the operator is told
plainly that it is not.

## 7. The seccomp profile does not stop an arbitrary binary running

Measured here, by parsing `uf-seccomp.json` with `python3 -c` (`json.load`, one
pass, 2026-08-25):

| | |
|---|---|
| `defaultAction` | `SCMP_ACT_ERRNO`, `defaultErrnoRet: 1` (EPERM) |
| Syscall rules | 29 groups, **every one `SCMP_ACT_ALLOW`** — no explicit deny rule exists |
| Names on the allow list | 443 |
| `execve`, `execveat`, `fork`, `vfork` | **allowed, ungated** |
| `statx`, `openat2`, `faccessat2`, `memfd_create` | allowed, ungated |
| `clone`, `clone3`, `unshare`, `mount`, `umount2` | present **twice** — once behind Docker's capability gate, once ungated (the appended pair) |
| `pivot_root` | present **once**, ungated — the sixth appended name, in no gated rule |
| `userfaultfd`, `keyctl` | **absent from the list**, so `defaultAction` denies them |

So an operator-installed binary runs. Nothing in this profile is a barrier to
Terraform, to a language runtime, or to a compiler.

Two qualifications that matter more than the table.

**The profile is commented out.** `docker-compose.yml:490-491` ships
`security_opt` disabled, so a stock install runs Docker's *default* profile,
which also allows `execve`. The relaxation exists for bubblewrap and nothing
else, and the compose comment says a stock `docker compose up` must not fail on a
profile file a daemon rejects (`docker-compose.yml:429-438`).

**What is denied is namespaces, at both settings.** Docker gates the whole
namespace-and-mount family behind CAP_SYS_ADMIN, this container holds no
capabilities, and the compose comment reports the measurement: plain `unshare -U`
fails, `/proc/sys/user/max_user_namespaces` is 31734, `Seccomp: 2` with one
filter loaded (`docker-compose.yml:453-468`). A tool that wants to build its own
container, chroot, or sandbox — and several "stack" tools do — will fail here in
a way no volume fixes. **Not re-measured by this proposal; quoted from the
compose file's own record.**

## 8. The CLI sandbox's write allow-list already names two tool caches, and
neither is persistent

When `UF_SANDBOX=1`, a write config of any kind makes the CLI bind `/`
read-only and rw-bind only the allow set, so every path a build touches must be
named or the build fails inside a tool call (`src/lib/orchestrator.ts:5979-5982`).
`BUILD_CACHE_DIRS` is that concession:

```ts
const BUILD_CACHE_DIRS = [
  path.join(os.homedir(), ".npm"),
  process.env.GOPATH || path.join(os.homedir(), "go"),
];
```
— `src/lib/orchestrator.ts:5996-5999`

`GOPATH` is `/home/node/go`, which is the `usagefoundry-gocache` volume.
**`$HOME/.npm` is not a volume and not a bind mount** — it is the writable layer,
so npm's cache is discarded by every `docker compose up --build`. The docblock's
own sentence is correct as written: *"which the image points at a named volume so
it survives a container it is meant to outlive"* attaches to `GOPATH`, the clause
immediately before it, and claims nothing about npm. But it reads on a fast pass
as covering both, which is the misreading to avoid.

That is the shape of the fourth persistence problem, in the tree already: **a
tool's own state directory is a separate question from its binary**, it lands in
`$HOME` by default, and `$HOME` for both server and children is `/home/node`
(`Dockerfile:47`, `src/lib/orchestrator.ts:5986-5990`), of which exactly four
subdirectories are persistent:

| Path | What it is | Survives `up --build`? |
|---|---|---|
| `/home/node/.claude` | bind mount of the operator's own `~/.claude` | yes — and it is the **host's** file |
| `/home/node/go` | `usagefoundry-gocache` | yes |
| `/home/node/.local/share/gh` | `usagefoundry-gh` | yes |
| `/home/node/pytools` | `usagefoundry-pytools` | yes |
| **everything else under `/home/node`** — `.npm`, `.cache`, `.config`, `.terraform.d`, `.aws`, `.kube` | writable layer | **no** |

A stack tool that keeps a provider cache, a plugin directory or a credential in
`$HOME` therefore re-downloads or loses it on the rebuild, and the operator's
symptom is a slow work cycle rather than an error. Every option file answers this
under heading 5.

`/home/node/.claude` deserves its own warning, and `.env.example:279-286` already
carries it: a tool that "wires itself in globally" on first run is editing the
**host's** Claude Code settings for every session on the machine, not just this
app's. Measured there: one `cozempic --version` in a throwaway container wrote 7
hooks into `~/.claude/settings.json`.

## 9. Invariants from `CLAUDE.md` an option could break silently

Each of these fails with nothing thrown and nothing failing to typecheck.

- **`createRun` runs from entry to INSERT with no `await`.** Anything that
  probes for a tool, stats a volume or shells out during admission puts two
  agents in one directory. `docs/agent/concurrency-and-ownership.md` owns it. A
  "which stack does this run need" check belongs anywhere but there.
- **Two flags ride every cycle's argv because `--resume` restores none of them**
  — `--plugin-dir` and the four-notice `--append-system-prompt` (one flag; a
  second is a replacement). An option that tells the agent about the stack in a
  system-prompt notice is editing a **cached prefix**: `runs.file_cost_notice` is
  generated once at `createRun` and never rebuilt at a spawn, because text that
  differed between two cycles of one run would cold-start a 190,000-token
  context. Any generated notice about installed tools inherits that rule.
- **`--add-dir` grants write, and a stored path is proved contained in a mount
  again at use time** (`docs/agent/architecture.md`, plugins section). A stack
  directory reachable by `--add-dir` is a stack directory an agent can rewrite.
- **The three cost sources are never summed or mixed.** No stack mechanism may
  put a figure on a card that reads as spend.
- **`saveSettings` stores only what differs from `DEFAULTS`.** If any part of a
  stack becomes a setting rather than an environment variable, it inherits that.

## 10. The two existing loops are pinned by a test that reads three files

`src/lib/deployment.test.ts` carries two suites and two further assertions that
are precisely the pin any new persistence mechanism would have to extend:

- `describe("gh extensions survive the rebuild that installs them by hand does not")` — `:664`
- `describe("Python tools survive the rebuild that installs them by hand does not")` — `:733`
- `it("keeps that directory off every named volume")` — `:892`
- `it("forwards every UF_ variable the entrypoint reads")` — `:961`

The last one is the trap `UF_LOCK_CLAUDE_HOME` was caught by: compose has no
`env_file`, so a variable in `.env` that `docker-compose.yml`'s `environment:`
block does not name never reaches the container at all — *"a security control
switched on in a file, never applied, and indistinguishable from one that is
off"* (`docs/agent/environment.md:27`).

**A new `UF_` variable that the entrypoint reads must be added to four files in
the same commit** — `.env.example`, `docker-compose.yml`'s `environment:` block,
`docker-entrypoint.sh`, and `deployment.test.ts` — and the test is what makes
forgetting one of them loud.

## 11. What could not be reached, and the commands that would reach it

Every item here is a claim this survey makes on documentation and code rather
than on observation. A human with Docker runs these.

1. **That anything survives `docker compose up --build`.** Nothing in this
   proposal watched a volume outlive a rebuild.
   ```bash
   docker compose -p ufstack up -d --build
   docker compose -p ufstack exec -T usagefoundry sh -c 'echo hi > /home/node/pytools/bin/probe && echo hi > /home/node/probe-writable-layer'
   docker compose -p ufstack up -d --build --force-recreate
   docker compose -p ufstack exec -T usagefoundry sh -c 'ls /home/node/pytools/bin/probe /home/node/probe-writable-layer'
   #   expected: the first exists, the second is gone
   docker compose -p ufstack down -v
   ```
2. **That the volume-masking trap is real on this engine.** Add a `RUN touch
   /home/node/pytools/bin/from-image` to the Dockerfile, rebuild against an
   *existing* volume, and check whether the file is visible. The repository
   asserts it is not (`Dockerfile:303-309`).
3. **That a boot-installed binary is executable by the agent uid inside a work
   cycle.** `docker compose exec -T -u "$(docker compose exec -T usagefoundry
   printenv UF_AGENT_UID)" usagefoundry sh -c 'command -v <tool> && <tool>
   --version'` — and note `docs/agent/environment.md:22` forbids taking that uid
   from `-u "${UF_UID:-1000}"` in the operator's own shell, because `.env` is
   compose's input rather than an exported environment.
4. **That the seccomp profile is accepted and a new binary still runs under it.**
   Uncomment `docker-compose.yml:490-491` and repeat 3.
5. **Anything about a real stack tool.** No Terraform, no `mise`, no `asdf`, no
   `apt-get` was run anywhere in this proposal.

And one gap in the repository's own record rather than in this survey:
**`docs/verification.md` contains no entry verifying that `usagefoundry-gh` or
`usagefoundry-pytools` survives a rebuild.** `grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|gocache" docs/verification.md`
returns one line, `:1371`, and it is about a guard rather than about persistence.
The mechanism this proposal builds on is pinned by a unit test over file
*contents* and has never been executed against a real rebuild. That is not an
argument against it — it is the reason item 1 above is item 1.

---

## The fixed heading list

**Every option file in this directory answers these ten headings, in this order,
under these names.** Runs 2 and 3 follow it. A comparison table later in the
directory is then over a fixed set rather than over N arguments, which is the
whole reason the list is fixed here and not negotiated per file. An option with
nothing to say under a heading writes "Nothing" under it rather than dropping it.

1. **The strongest case** — one paragraph, written as its advocate would write
   it, with no hedging and no rebuttal.
2. **Shape** — what is actually built or configured: which files, which
   variables, which volumes, which lines of `src/`.
3. **What persists it, and what discards it** — the four events in §1 above,
   one line each, plus whether `scripts/backup-db.mjs` covers it.
4. **Reach** — which of the five kinds of child sees the tool, named one by one,
   and what carries it there (`PATH`, `childEnv`/`chatEnv`, the agent uid, a
   `--add-dir`). See `00-problem.md` §"Which children have to see it".
5. **Tool state, not the binary** — where the tool's own cache, config, plugin
   directory and credentials land, and whether that persists on the same terms as
   the executable. §8 above is the shape of the question.
6. **What it does to the boundaries** — `/data` 0700, the root/`UF_AGENT_UID`
   split, `UF_CHAT_GID`, the CLI sandbox's write allow-list, the read guard, and
   worktree isolation. Which of them it crosses, and what it hands an agent that
   the agent did not have.
7. **The operator's surface** — what they configure and where, what a restart
   does with it, and how they change or remove a tool once installed.
8. **How it fails, and whether loudly** — every silent failure mode named. The
   bar is set by `.env.example:222-226`: a missing command inside a `|| true`
   hook body is a plugin that reports itself active against a command that was
   never present, 213 times.
9. **What it costs to build** — files touched, whether `deployment.test.ts`
   grows, whether any `docs/agent/` invariant moves, and whether the work is a
   day, a week or longer.
10. **What would have to be true** — the single fact that would promote this
    option, and the single fact that would kill it. Both stated as something
    somebody could go and check.
