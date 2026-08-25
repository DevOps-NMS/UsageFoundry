# Option O — the manifest lives in the repository, not in the app

A stack is a file in the mounted repository — `.usagefoundry/stack.toml`,
committed. The app reads it, installs what it names, and reports what it found.
The repository that needs Terraform is the thing that says it needs Terraform.

This is `14-` §3's fourth store, and it is the only one of the four that
survives every event in `01-constraints.md` §1.

## 1. The strongest case

Every other option in this directory answers "where does the operator's stack
live?" with somewhere inside the container, and then spends a section explaining
what happens to it when the container goes away. This one does not have that
section, because the manifest is a file in a git repository the operator already
backs up, already reviews, already moves between machines, and already treats as
the source of truth for everything else about how that project is built. A
repository that needs Terraform 1.9.8 needs it on the CI runner, on the
developer's laptop and in this container, and the answer everywhere else in the
industry is a file in the repository — `.tool-versions`, `.mise.toml`,
`flake.nix`, `renovate.json`. **`14-` §7's whole difficulty is that a stack looks
like a capability and this app puts capabilities nowhere**; a file in the mount
sidesteps it entirely, because the app is not attaching a capability to
anything. It is reading a declaration that was already there. It is also the
only option that answers the operator's real underlying shape — four mounted
repositories that need different tools — without inventing a scope this app has
refused three times.

## 2. Shape

- **`.usagefoundry/stack.toml` at the repository root**, or `stack.json` if a
  parser is the objection: nothing in `package.json` parses TOML today, and
  adding a dependency for a config file is a cost this option should not pay
  when JSON is free.
- **Read at spawn, not at admission** (`14-` §4). `resolveInMount()` for the path
  — containment on the resolved path **and again** after `realpathSync`, both
  load-bearing (`docs/agent/security.md:11`). A manifest is a stored path that
  becomes an install, which is the plugins module's exact situation and gets the
  plugins module's exact treatment (`src/lib/plugins.ts:153-174`).
- **`src/lib/repoStack.ts`** — pure: parse, validate every field by name, and
  produce a typed request. `11-` §2's validators, unchanged, and this is where
  the entire safety argument sits, so it is where the tests go.
- **The install is `11-`'s closed verb list, never a script.** A manifest that
  can name a shell command is a repository that can run arbitrary code on the
  container by being cloned, which is not a feature, it is a supply chain. The
  verbs are `uv-tool`, `gh-extension`, `release-tarball`, and the argv is a
  constant template with the manifest's value in exactly one position
  (`CLAUDE.md:134`).
- **And the gate, which is the whole option**: a manifest is **inert until an
  operator approves it**, per repository, from the app. First sighting produces a
  notice, not an install. That approval is a settings row keyed by mount and by
  the manifest's content hash, so **a changed manifest is a new approval**.
- **The installation itself is install-wide**, because there is one `PATH` and
  one filesystem per container (`14-` §7). Four repositories declaring four
  stacks produce one union on one `PATH`. **The manifest is per-repository; the
  installation is not, and the page has to say so** or an operator will read the
  file as isolation and it is not.

## 3. What persists it, and what discards it

| Event | Outcome |
|---|---|
| `docker restart` | manifest survives (it is in the mount); install survives |
| `up --build` | **survives** — bind mounts are untouched by a rebuild |
| `down -v` | **manifest survives** — it is not in a named volume. Install destroyed, reinstalled on next approval-checked spawn |
| fresh host | **survives**, and this is unique — `git clone` brings it |

**This is the strongest persistence story in the directory and it is not close.**
`.env` survives `down -v` and does not travel to a colleague's checkout without
being copied by hand; a committed manifest does both. `scripts/backup-db.mjs`
covers none of it and does not need to — *"other copies"* is exactly why the
backup deliberately excludes branches and `~/.claude`
(`docs/backup-and-restore.md:129-142`), and a manifest in a repository is the
same argument.

The approval rows *are* in the database, so a restore is needed to avoid
re-approving after a `down -v`. That is the correct split: the declaration is
durable, the trust decision is local.

**Not verified.** No rebuild, no `down -v`; Docker is unavailable
(`01-constraints.md` §11).

## 4. Reach

Identical to whichever substrate is underneath, since the install lands in the
same volume `02-` or `03-` provides: `PATH` reaches all five kinds of child
untouched (`orchestrator.ts:6244-6246`, pinned at `git.test.ts:93`).

**One thing it adds and one thing it cannot.** It adds a natural source for
`07-`'s `stackTools` — a manifest names the tools, so the allowlist is derived
rather than typed, and derived per repository. It cannot make the *grant* per
repository without reopening `14-` §7's scope question, and this survey settled
that install-wide is the answer. So a manifest in repository A widens the
allowlist for runs in repository B. **That is a real widening and this option
must own it**: the mitigation is that `stackTools` remains an operator setting
and is never written from a manifest, only *suggested* by one.

## 5. Tool state, not the binary

Same as `16-` §5 and with the same resolution: **the app does not manage state
directories, and the page says so.** A manifest could carry a `state_dir` per
entry and the app could set the variable, and it should not, for the reason
`16-` §5 gives — a per-ecosystem table of cache variables is a research task
with no end, and a page asserting a managed cache it has not verified is
`14-` §5's worst failure.

**One thing this option makes worse than any other.** A repository's manifest
naturally wants to name a state directory *inside the repository* — that is what
`.terraform/` is. That directory is in a mount, is written by the agent already,
and is subject to worktree isolation: a run in a worktree gets a *different*
checkout, so a cache under the repository root is per-worktree and re-downloads
per run. **Nothing in this option fixes that and it should not try.** Name it,
and let the operator point the variable at `03-`'s volume.

## 6. What it does to the boundaries

**This option crosses the most boundaries of any in the directory and the
approval gate is the only thing holding it.** Stated plainly rather than
softened:

- **A model may write this file.** `docs/agent/chat.md`'s rule is that **prompt
  text is the one half of a run a model may write**. An agent writing
  `.usagefoundry/stack.toml` in the mount it is working in is a second half, and
  it arrives with the merge queue's blessing because it is a file in a diff.
  **The content-hash approval is the answer and it has to be exact**: an
  installed manifest is approved by hash, an agent's edit changes the hash, and
  the changed manifest is inert until a human approves it.
- **A cloned repository is untrusted input.** `docs/agent/security.md` is built
  around a stored path being proved contained at use time; a manifest is
  strictly more than a path, so it gets strictly more: containment, per-field
  validation by name, a closed verb list, and approval.
- **`/data` 0700, root/`UF_AGENT_UID`, `UF_CHAT_GID`** — the installs run under
  `setpriv` to the agent uid (`docker-entrypoint.sh:147`, `:218`), unchanged from
  `16-` §6.
- **The CLI sandbox write allowlist.** Under `UF_SANDBOX=1` the write config
  binds `/` read-only with a named allowlist, and an installed tool's own state
  path is not in it (`01-constraints.md` §6, `00-problem.md` §"Missing 3"). A
  manifest does not change that and cannot.
- **Worktree isolation.** A worktree is a different checkout of the same
  repository, so a manifest committed on one branch and not another means the
  same repository declares different stacks depending on the branch a run is on.
  **That is a genuine surprise**, and the approval-by-hash gate is what stops it
  being a silent one — a branch with a different manifest is a different hash and
  is inert.
- **The MCP surface.** Excluded by name, on `04-` §6's rule, and here it is not
  a formality: a route that approved a manifest would let a model approve its own
  edit.

## 7. The operator's surface

A card listing every mounted repository, the manifest it declares (or none), and
its approval state. Approving is a button; a changed manifest returns to
`pending` and says which entries changed.

Removing a tool means removing it from the manifest, committing, and
re-approving — which is slower than a button and is the price of the manifest
being reviewable.

**What this gives that no other option does**: the answer to *"why is Terraform
on this box"* is a line in a commit with an author and a date on it.

**What it refuses**: an operator who wants to try something once, without
committing to a repository, cannot. That is `06-` §10's and `09-` §10's fact
arriving a third time, and this option is the furthest of all from serving it.

## 8. How it fails, and whether loudly

Loud:

- An unapproved manifest is a notice naming the repository and the tools. That
  is a *discovery* the other options cannot make at all: the app can tell an
  operator that a repository they mounted wants tools they do not have.
- An install failure is recorded against the entry and shown, as `16-` §8.
- A changed manifest returns to `pending` and names the diff.

Silent, and the list is the longest in the directory because the surface is the
widest:

- **Two repositories declaring conflicting versions.** `terraform@1.9.8` and
  `terraform@1.5.0` produce one binary on one `PATH`, and the loser's runs are
  wrong rather than refused, because both loops skip an already-installed entry
  (`.env.example:204-207`, `:288-290`) and `14-` §6 forbids upgrading on drift.
  **This is the option's worst failure**, it is created by the option, and the
  only honest mitigation is to detect the conflict at approval and refuse the
  second one by name.
- **The branch case in §6** — mitigated by hash, not eliminated.
- **A manifest whose tool is present from another repository's manifest** reads
  `present` and is not attributable to anything.
- **A verb that exits 0 having installed nothing** (`11-` §8), inherited.
- **State 3** (`14-` §5) — `invokable` is unmeasured here as everywhere.
- **A repository unmounted while its tools stay installed.** Nothing removes
  them, because §6's additive-only rule (`14-` §6) forbids an authoritative
  sweep. The tools become unattributable.

## 9. What it costs to build

**A week to two weeks**, comparable to `16-`, and the cost is in different
places: less schema (approvals are rows keyed by mount and hash, not a stack
model), more validation, and an approval flow that has to be right.

Files: `src/lib/repoStack.ts` with real tests, an approvals table or settings
key, a route, a Settings card, the installer verbs from `11-`, plus the
substrate from `02-` or `03-` underneath.

**Which of those earns a test, precisely**: the manifest parser and its field
validators (untrusted input from a repository — the single highest-value test in
this directory), the content-hash computation (a hash that is stable across a
reformat silently approves an edit, and a hash that is unstable makes every
whitespace change a re-approval), and the version-conflict detector from §8. Not
the route, not the card. **Three functions** (`docs/agent/testing.md`).

Invariants that move: `docs/agent/security.md` (untrusted input from a mount
becoming an install — the largest single addition any option here makes),
`docs/agent/architecture.md` (a module, a route, a child kind),
`docs/agent/chat.md` or its neighbour (the model-writable boundary, which this
option is the first thing to genuinely press on).

## 10. What would have to be true

**Promotes it:** that different mounted repositories genuinely need different
tools. That is the shape `14-` §7 could not attach anywhere and the shape
`07-` §10 raised from the other side — *"an operator with four mounted
repositories and one that needs Terraform has a fair objection"*. If it is the
real shape, this is the only option in the directory that expresses it, and
every other one answers a question about a single install.

**Kills it:** the approval gate not being closable. The entire security argument
is one sentence — *a manifest is inert until a human approves its exact
content* — and every convenience someone will ask for afterwards attacks it:
auto-approve for trusted mounts, approve a repository rather than a hash,
approve minor version bumps. **Each of those is individually reasonable and
collectively they turn a mounted repository into an installer.** If the gate
cannot be held, this option should be rejected rather than weakened — and
`16-`'s table, which nothing outside the app can write, is what it degrades to.
