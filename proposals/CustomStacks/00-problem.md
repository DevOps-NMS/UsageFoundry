# The problem

**The question:** an operator wants to install a tool — Terraform is their
example — from inside the web interface, and have it be there for every run
afterwards, including after `docker compose up --build`.

The idea, in their words:

> Persistent custom stacks that the user can deploy from the web interface. My
> imagination of it is that there is a point on the left menu called Terminal
> where users can run terminal commands on the container's CLI. The things
> installed by that CLI — let's take Terraform for an example — should then be
> available to all runs and sandboxed runs, and survive a rebuild of the
> container.

There are three separable questions inside that sentence, and they have
different answers. This file states the split, then answers the first one.

## The three-way split

**1. Substrate — what persists, and what reaches the agents.** *This run.*
What makes an operator-installed binary survive a rebuild, and what makes it
reach each of the kinds of child process this app spawns. Files `00-` to `07-`.

**2. The Terminal pane — the surface and its security model.** *Run 2, from
`08-`.* A shell in the left menu is a remote code execution endpoint on a
container that runs as root (`docker-compose.yml:64`), holds the operator's
`~/.claude` credential as a bind mount (`:339`), and mounts up to four of their
repositories read-write. `middleware.ts`'s auth is a single shared bearer token
(`src/middleware.ts:41`, `:128-129`). That is run 2's problem and it is a bigger
one than it looks; nothing in this file pre-empts it.

**3. Stack object model, deploy and lifecycle.** *Run 3.* What a "stack" is as a
stored, redeployable thing — a named set of tools with a version, a state, a
deploy button and a removal path — plus the comparison table over the fixed
headings, the recommendation, the implementation sketch and the validation pass
that close the survey.

The split matters because **question 1 is mostly already answered and question 2
is mostly unbuilt**, and a proposal that treats them as one feature would price
the easy half and the hard half together.

## What already exists — and it is more than the operator thinks

Three named volumes exist for exactly this problem, and the compose file argues
each one out at length (`docker-compose.yml:370-409`, top-level declarations at
`:572-576`):

| Volume | Mounted at | Holds | Line |
|---|---|---|---|
| `usagefoundry-gocache` | `/home/node/go` | `GOPATH` + `GOCACHE` | `docker-compose.yml:383` |
| `usagefoundry-gh` | `/home/node/.local/share/gh` | `gh` extensions | `:397` |
| `usagefoundry-pytools` | `/home/node/pytools` | uv-installed Python tools, their bin dir, and a fetched interpreter | `:409` |

Two of the three have a **declarative, boot-time install loop** behind them
(`docker-entrypoint.sh:169-211` for `UF_GH_EXTENSIONS`, `:241-310` for
`UF_PY_TOOLS`). So an operator can already write

```
UF_PY_TOOLS=cozempic==1.8.39 ruff==0.6.9
UF_GH_EXTENSIONS=dlvhdr/gh-dash github/gh-copilot@v1.1.0
```

in `.env`, restart, and have those commands on every agent's `PATH`, surviving
every rebuild, reinstalled automatically on a fresh host. The mechanism is
better than a shell would be: the declaration is in a file the operator keeps,
so it is reproducible, and the tool is reinstalled after `docker compose down -v`
rather than lost with the volume (`.env.example:212-213`, `:296-297`).

The compose comments say why the writable layer is not good enough, and they say
it in the language of the failure rather than the mechanism:

> the default location is inside the writable layer, which `docker compose up
> --build` discards. An extension installed by hand in a shell therefore works
> until the next upgrade and is then simply gone — and what an agent sees at that
> point is `unknown command`, inside a tool call nothing here reads, which the
> run loop files as the agent choosing not to use it.
> — `docker-compose.yml:386-391`

and the quieter version, for the Python tools:

> These are invoked by a plugin's hooks, and a hook body ends in `|| true` — so a
> missing command is not an error the run loop can read, it is a hook that exits
> 0 having done nothing, on every session start.
> — `docker-compose.yml:405-408`

That second failure has a number on it: **213 sessions on one install were told a
plugin was active against a command that was never present**
(`.env.example:222-226`).

**So the honest first finding is that a meaningful part of this request already
ships.** For anything installable by `uv tool install` or `gh extension install`,
the answer today is two lines in `.env` and a restart, and it is a *better*
answer than a terminal because it is declarative. That is a finding, not a
failure — but it does not cover Terraform, and the next section is why.

## What is genuinely missing

### Missing 1 — there is no general installer

The two loops are tied to two package managers. `uv tool install` installs
Python distributions; `gh extension install` installs `gh` extensions. **Neither
installs a statically-linked binary from a release tarball, which is what
Terraform, `kubectl`, `helm`, `mise`, `terragrunt` and most of the tools an
operator means by "a stack" actually are.**

The container has the pieces to do it — `curl`, `jq` and `git` from the runtime
image's own apt line (`Dockerfile:127-132`), and `tar`, `sha256sum` and `install`
from the Debian base beneath it, all three already used by the image's own
installers (`Dockerfile:173-175`) — and `Dockerfile:162-177` is a worked example
of the pattern for `gh` itself: download a pinned release, verify a checksum,
`install -m 0755` it into `/usr/local/bin`. What is missing is a version of that
loop whose target is a **volume** rather than an image layer, and whose input is
an operator's list.

### Missing 2 — the fourth persistence problem: the tool's own state

A binary is not a toolchain. Terraform downloads providers; `kubectl` reads a
kubeconfig; `mise` keeps a tool registry; `npm` keeps a cache. All of them
default to `$HOME`, and **`$HOME` is `/home/node` for the server and for every
child alike** (`Dockerfile:47`, and the reasoning at
`src/lib/orchestrator.ts:5986-5990`) — of which exactly four subdirectories are
persistent and everything else is the writable layer. `01-constraints.md` §8 has
the table.

The tree already contains the shape of this bug and a half-fix for it.
`BUILD_CACHE_DIRS` (`src/lib/orchestrator.ts:5996-5999`) names `$HOME/.npm` and
`$GOPATH` as the two caches a build touches, and its own docblock is correct as
written — *"which the image points at a named volume so it survives a container
it is meant to outlive"* attaches to `GOPATH`, the clause immediately before it
— but reads on a fast pass as covering both. **`$HOME/.npm` is on no volume**
(`docker-compose.yml:330-423`) and is discarded by every rebuild. Every
image-level answer here relocates state out of `$HOME` onto something durable:
`GOCACHE` explicitly rather than
`$HOME/.cache/go-build` (`Dockerfile:224-225`), `UV_TOOL_DIR` under
`/home/node/pytools` (`:282-284`), Playwright browsers to `/opt/playwright/browsers`
(`:440`), winnow's state forced out of `$HOME` (`src/lib/contextPruning.ts:86`).
A stack mechanism that ships a binary and not that relocation ships half a tool.

### Missing 3 — and this is the real one — **a work cycle probably cannot run it**

This is the finding that most contradicts the operator's mental model, so it
gets stated bluntly.

The shipped permission mode for a run is `acceptEdits`
(`src/lib/settings.ts:730`, applied `src/lib/orchestrator.ts:3538`, fallback at
`:8105`). What that mode does is documented twice in the tree, both times with a
measurement attached:

> `acceptEdits` auto-approves file edits and read-only shell, and holds mutating
> git for a human — `git add` and `git commit` both come back "This command
> requires approval", and a `-p` child has nobody to give it. […] Measured, not
> reasoned: one run tried seven times, in five phrasings, and was refused every
> time, finished as `completed`, and left its whole change sitting uncommitted.
> — `src/lib/orchestrator.ts:5082-5089`

> `resolveConflicts` pins `acceptEdits`, which auto-approves file edits and
> read-only shell and holds everything else for a human — and a `-p` child has
> nobody to ask. So the resolver could edit the conflicted files and could not
> run a single command against the result. **Measured across this install's whole
> window: 19 of 58 completed resolutions, $109.94 of $233.85, say in their own
> report text that they could not compile or test what they had merged.**
> — `src/lib/settings.ts:290-296`

The app's answer to that has, both times, been a **named grant on
`--allowedTools`**, never a mode change: `ISOLATED_GIT_TOOLS = ["Bash(git
add:*)", "Bash(git commit:*)"]` (`src/lib/orchestrator.ts:5104`, pushed at
`:5527`) and `resolveVerifyTools`, an operator-configured list that ships empty
(`src/lib/settings.ts:314`, `:743`, read at `src/lib/land.ts:1275`).

So the reach chain has **three links, not one**, and every existing mechanism
solves only the first two:

1. the binary exists on disk after a rebuild — solved, by a volume;
2. it is on the child's `PATH` — solved, by `Dockerfile:281` and by `childEnv`
   passing `PATH` through untouched (`src/lib/orchestrator.ts:6306-6321`; the
   docblock at `:6244-6246` names `PATH` as deliberately pass-through, and
   `Dockerfile:271-274` depends on it in writing);
3. **the agent is permitted to invoke it** — *not* solved, and nothing in the
   `UF_PY_TOOLS` path addresses it.

Link 3 does not bite the existing loops because of *how* their tools are
invoked: a `gh` extension or a Python tool installed by `UF_PY_TOOLS` is reached
by a **plugin hook**, which the CLI runs itself rather than as a `Bash` tool call
(`Dockerfile:271-274`, `.env.example:219-226`). Terraform is not a hook. It is a
command a model types into `Bash`, and that is the path `acceptEdits` gates.

**What is not established, and it decides how bad this is.** Nobody here has
measured what the pinned CLI classifies as "read-only shell". `terraform
version` and `terraform plan` may well pass where `terraform apply` does not.
The two measurements above are of `git commit` and of "a command against the
merge result" — neither is an arbitrary unknown binary. Docker is unavailable
here and no `claude` process was spawned by this proposal, so **this is reasoned
from two adjacent measurements rather than measured.** The exact probe a human
would run is in `07-option-make-it-runnable.md` §10 and it costs one work cycle.

### Missing 4 — nothing in the app can see any of it

There is no left-menu pane for tools: the nav is nine fixed entries
(`src/components/shell/panes.ts:27-38`), and there is no `/api` route that
reports what is installed (`ls src/app/api/` — 23 directories, none of them
tools or terminal). An operator who sets `UF_PY_TOOLS` and restarts learns
whether it worked by reading the container's boot log for
`[usagefoundry] installed Python tool …` (`docker-entrypoint.sh:297`) or the
`could not install` line beside it (`:306-307`). That is the whole read-back.

## Which children have to see it

Five kinds of `claude` child, from three modules — the "four modules" in
`CLAUDE.md` is off by one, and `src/lib/privsep.ts:237`'s "both of
`chat.ts`'s" is off by one in the other direction; `chat.ts` has a single
`spawn(`, and it is `review.ts`'s single one that serves two of the kinds.
Plus three non-agent children. Every one of them
gets the image's `PATH` unchanged.

| # | Child | Spawn site | env fn | Drops to `UF_AGENT_UID`? | Mode |
|---|---|---|---|---|---|
| 1 | Work cycle | `src/lib/orchestrator.ts:6558` | `childEnv({…telemetryEnv, …githubEnv})` | yes (`:6564`) | `acceptEdits` |
| 2 | Reviewer | `src/lib/review.ts:660` | `reviewEnv()` (`:760`) | yes (`:665`) | `plan` (`review.ts:238`) |
| 3 | Conflict resolver | same site, `spawnAssist` | `reviewEnv()` | yes | `acceptEdits` (`land.ts:1284`) |
| 4 | Orchestrator chat turn | `src/lib/chat.ts:1709` | `chatEnv()` (`:2251`) | uid yes, **gid `UF_CHAT_GID`** (`:1718`) | `bypassPermissions` (`:1652-1653`) |
| 5 | Workflow orchestrator block | same site | `chatEnv()` | same | `bypassPermissions` |
| — | `claude auth` / login | `claudeAuth.ts:302`, `:414` | `authEnv()` (`:258`) | yes (`:289`) | n/a |
| — | git | `git.ts:124`, `:210` | `gitEnv()` (`:51`) | yes | n/a |
| — | winnow prune | `contextPruning.ts:610` | `pruneEnv()` (`:503`) | **no — root** (`:626-627`) | n/a |

Five copies of the same strip loop exist and are never factored out —
`childEnv`, `chatEnv`, `reviewEnv`, `authEnv`, and `gitEnv` (which
deliberately differs: it strips `ANTHROPIC_*` as a whole prefix, `git.ts:55`,
and seeds `GIT_TERMINAL_PROMPT=0`). **`PATH` survives all five.** `git.test.ts:93`
pins it with `assert.equal(env.PATH, process.env.PATH)`.

**So `PATH` is not the problem, and an option that only fixes `PATH` fixes
nothing that is broken.** The two things that differ across these five children
are the **permission mode** — which is what decides whether the tool can be
invoked — and, if `UF_SANDBOX` is ever switched on, the **write set**, which
decides whether the tool can write its own cache.

There is one live hazard on this list worth flagging to run 2, because a terminal
pane makes it easier to reach. `/home/node/pytools/bin` is on the **server's**
`PATH` too, and it is agent-writable. `contextPruning.ts:76-83` names this and
works around it by resolving an absolute interpreter rather than a name — and
`contextPruning.ts:610` is also the one spawn in the app that does **not** drop
to the agent uid (`:626-627`). The two facts sit on the same call. Any new
volume that goes on `PATH` for a root process inherits that hazard, and the
mitigation is the same one: absolute paths, never names.

## "Sandboxed runs" names at least six different things

The operator's phrase does not resolve. Resolving it is worth doing here rather
than three files later, because two of the six change the answer to this
proposal and four do not.

1. **Git worktree isolation** — `resolveIsolation`
   (`src/lib/orchestrator.ts:1919-2030`), `ensureWorktree` (`:2438`). Two modes
   only, `"worktree" | "none"` (`:1867`). The worktree lands at
   `<mount>/.uf-worktrees/<slug>-<n>` (`:2171`, `:3146`), **inside** the mount by
   refusal (`:2249`). **On by default** (`src/app/runs/new/page.tsx:171`, and an
   omitted field reads as on too — `src/lib/settings.ts:934`). It changes cwd and
   nothing else — not `PATH`, not `$HOME`, not the uid. *No effect on this
   proposal.*
2. **Permission modes** — always in force, and per §"Missing 3" the one thing
   that actually decides whether a tool can be run. *Decisive.*
3. **The uid split** — server root, children at `UF_AGENT_UID`
   (`docker-compose.yml:64`, `:263-264`, `src/lib/privsep.ts:207`). On in the
   container. *Decides who may upgrade or remove an installed tool*, which is
   why both existing loops install under `setpriv` (`docker-entrypoint.sh:145-153`,
   `:216-224`).
4. **The CLI's bubblewrap sandbox** — `UF_SANDBOX`, read only by
   `docker-entrypoint.sh:362`; `src/` reads the written *file*, never the
   variable (`src/lib/sandbox.ts:232-273`). **Shipped off**, and its host-side
   prerequisite is commented out too (`docker-compose.yml:490-491`). *Decisive
   if ever switched on*, because a write config binds `/` read-only and rw-binds
   only the allow set (`src/lib/orchestrator.ts:5979-5982`) — and neither
   `/home/node/pytools` nor any tool state directory is in that set
   (`:6043-6068`, `:5996-5999`).
5. **The read guard** — `readGuard`, default `false`
   (`src/lib/settings.ts:164`, `:736`). A `PreToolUse` hook on the `Read` tool
   only (`src/lib/readGuard.ts:225`), and a ranged read is never refused
   (`:436`). *No effect: it does not see Bash.*
6. **`UF_LOCK_CLAUDE_HOME`** — root-owns `~/.claude` so a run cannot widen its
   own honored settings (`docker-entrypoint.sh:490-517`, gate at `:554`). Off by
   default. *No effect.*

The sentence to lead with when correcting the mental model is the module
header's own: **"Nothing here turns a sandbox on. This app configures none."**
(`src/lib/sandbox.ts:8-9`). A "sandboxed run" on a stock install is a run in a
git worktree under `acceptEdits`, sharing a uid, a `$HOME`, a `PATH` and a
filesystem with every other run. `docs/security.md:104-119` says so directly and
gives a probe returning `BAD-writable`.

**Two consequences for this survey.** First, "available to all runs and sandboxed
runs" is not two cases: there is no isolation mechanism here that a `PATH` entry
does not already cross. Second, the *one* configuration in which it would be two
cases — `UF_SANDBOX=1` — is exactly the one where an installed tool's write path
breaks, and it breaks inside a tool call the run loop does not read. Every option
file answers that under heading 6.

## What this run wrote, and where run 2 starts

| File | What it argues |
|---|---|
| `00-problem.md` | this file — the split, the prior art, the four gaps |
| `01-constraints.md` | what any option must survive, and **the fixed heading list** every option file in this directory answers |
| `02-option-widen-the-existing-lists.md` | a third `UF_*` list, in the shape of the two that exist |
| `03-option-persistent-opt-volume.md` | one general-purpose writable volume on `PATH` |
| `04-option-declared-manifest.md` | a manifest in the database, reapplied at boot |
| `05-option-image-is-the-stack.md` | build args and a layer; the operator's stack is a rebuild |
| `06-option-build-nothing.md` | **build nothing new** — document the two loops, fix the docs |
| `07-option-make-it-runnable.md` | the reach half alone: an allowlist for the tools, no new persistence at all |

**Run 2 starts at `08-`.**

## What could not be reached

- **Any rebuild.** Docker is not installed in this container, so no claim about
  what survives `docker compose up --build` or `down -v` was observed. Every one
  is reasoned from the compose file's own statements and Docker's documented
  semantics, and says so where it is made. `01-constraints.md` §11 has the five
  commands a human would run.
- **Whether an arbitrary binary is invokable under `acceptEdits`** — the single
  most decisive unknown in this survey, reasoned from two adjacent measurements
  (`orchestrator.ts:5082-5089`, `settings.ts:290-296`) rather than probed. One
  work cycle settles it; the recipe is `07-`'s §10.
- **Terraform, or any real stack tool.** None was downloaded, installed or run.
  Its state-directory layout is taken from its published behaviour, not from
  observation here.
- **The seccomp profile in action.** It was parsed
  (`01-constraints.md` §7) and never applied — `docker-compose.yml:490-491`
  ships it commented out, and this container is not the one it would apply to.
- **`/data`, and therefore any run history.** `ls -la /data` →
  `Permission denied`, the same reading `proposals/GrowthLimits/00-problem.md:138`
  took. So there is no figure anywhere in this proposal for how many runs would
  have used a stack tool.
- **One gap in the repository's own record, not this survey's.**
  `grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|gocache" docs/verification.md` returns
  exactly one line, `:1371`, and it is about a guard rather than about
  persistence. The mechanism this whole proposal builds on is pinned by a unit
  test over file *contents* (`src/lib/deployment.test.ts:664`, `:733`) and has
  never been executed against a real rebuild.
