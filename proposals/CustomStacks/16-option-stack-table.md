# Option M — a `stacks` table: the full object, with identity

A stack is a named row with an ordered list of typed entries. It is stored in
SQLite, edited from a page, applied by an additive reconciler, and reports a
state per entry. This is the option the operator's phrase describes literally:
*persistent custom stacks that the user can deploy from the web interface.*

It is `04-option-declared-manifest.md` with the two things that file leaves
open decided — identity, and the reconcile host — plus `14-`'s three states and
`14-` §6's additive-only policy.

## 1. The strongest case

Every other option in this directory answers a narrower question than the one
that was asked, and says so in its own §10. This one answers the sentence. An
operator opens a page, types `terraform 1.9.8`, presses Deploy, watches it
install, and sees `present` beside it afterwards — on every container they ever
start, because the row is the truth and the volume is a cache
(`14-` §1). It is the only option that closes `00-problem.md` §"Missing 4"
without qualification, the only one where removal is a button rather than a
`docker compose exec` and a hand-deleted file, and the only one where two people
sharing an install can both see what the install holds. The precedent is exact
and it is four files long: the plugins feature is an operator-declared list
stored under a settings key rather than as a `Settings` field, served by a
`nodejs`-runtime route wrapped in `auditMutation`, rendered as a Settings
section that saves on press rather than on Save, with containment re-proved at
read time (`src/lib/plugins.ts:39`, `src/app/api/plugins/route.ts:62`,
`src/app/settings/page.tsx:3359`, `plugins.ts:153-174`). A stacks feature is
that shape with a different payload, and the shape is known to work.

## 2. Shape

- **Schema — one table, `stacks`, plus one child table.** Idempotent
  `CREATE TABLE IF NOT EXISTS` inside the big `db.exec()` in `migrate()`
  (`src/lib/db.ts:136-688`), per `CLAUDE.md`'s rule and in the company of the
  five that are already there. Columns: `id`, `name`, `created_at`,
  `updated_at`, `enabled`. Entries in `stack_entries`: `stack_id`, `position`,
  `ecosystem`, `name`, `version`, `source`, `last_result`, `last_error`,
  `last_seen_at`.
  - **`ecosystem` is a column, not a key in a JSON blob**, on the reasoning
    `run_templates.permission_mode` already carries: *"Stored beside the budget
    rather than inside it … because this is the one field on a template that
    decides what a spawned agent is allowed to do. A column is greppable; a key
    in a JSON blob is not"* (`src/lib/db.ts:249-252`). `ecosystem` decides which
    argv template runs. Same weight, same treatment.
  - **`last_result` and `last_error` are on the entry, not the stack.** A
    four-tool stack where one tool failed is not a failed stack, and a stack-level
    status would round that to one word.
- **`src/lib/stacks.ts`** — pure, and the module is mostly validators:
  - a typed entry → a **constant argv template** with the operator's input in
    exactly one position. This is `11-`'s design and its whole safety argument,
    imported here rather than re-argued: `CLAUDE.md:134`'s *"Never a shell.
    Argv arrays only"* is obeyed rather than reconciled.
  - per-field validation by name, refusing loudly: a tool name against
    `^[A-Za-z0-9._-]+$`, a `gh` extension against `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`,
    a URL required to be `https:` with a host from an operator-configured list
    (`11-` §2).
  - the **disk-side diff**: declared entries vs. what is present. Additive and
    never-upgrading (`14-` §6), so the diff is a set difference and never a
    version comparison.
  - **Every one of those is a pure function whose failure mode is silent**,
    which is `CLAUDE.md`'s "Always" bar. `docs/agent/testing.md` is the standard
    they are written to, and §9 says which ones actually earn a test rather than
    proposing a suite.
- **`/api/stacks`** — `runtime = "nodejs"`, `dynamic = "force-dynamic"`, through
  `jsonMaybeGzipped`, its own list DTO (`docs/agent/conventions.md`). The
  mutating half wrapped in `auditMutation`, exactly as
  `src/app/api/plugins/route.ts:62` is and for the identical reason: the request
  that changed what every agent can reach belongs on the audit log.
- **A Settings section, not a pane.** `08-` §6 settled that there is no tenth
  pane (`panes.ts:12-16`, `ui-density-audit.md:159`, `:161`), and the plugins
  section is the precedent for an operator-declared list living in Settings
  (`src/app/settings/page.tsx:109`, `:3359`). Cards, a `ListGroup` and a
  `Disclosure` are three of the seven affordances.
- **The reconciler — and `04-` §2 calls its host *"the design's one hard
  question"*. This option answers it.** It runs in `instrumentation.ts`, in the
  `ownsDataDir()` block, beside the seven boot reconcilers at `:101-164`, after
  `claimDataDir()` at `:94`. That placement is not a preference; it is forced:
  - the entrypoint cannot host it, because the declaration is in SQLite and the
    entrypoint would have to read the database (`04-` §2);
  - a `runs` row cannot host it, because bending `runs` to hold an install
    distorts a table retention's three sweeps, the dependency graph and the loop
    block all read (`04-` §10, `12-` §9);
  - **`instrumentation.ts` is already the place where boot work that needs the
    database happens**, it is already gated on the data-directory claim so only
    one server does it, and `startRetentionSweeper()` at `:164` proves that a
    long-running periodic job is allowed to live there.
  - **The reconcile is `await`ed inside the boot block and the server serves
    afterwards.** That is the same trade the entrypoint already makes for the two
    `UF_*` loops (`14-` §4) — with one improvement: it is *after* `listen()` in
    wall-clock terms only if it is not awaited, and it must be awaited, because a
    run admitted mid-reconcile meets a missing command (`04-` §8). **`newWorkPaused`
    is the lever that already exists for exactly this** — hold new work until the
    reconcile settles, then release.
- **The substrate underneath is `03-`'s volume** (`/opt/stacks`, `PATH`, the
  entrypoint chown) or `02-`'s fourth volume. This option is a layer over one of
  them and does not replace either.

## 3. What persists it, and what discards it

| Event | Outcome |
|---|---|
| `docker restart` | declaration survives, install survives, reconcile finds nothing to do |
| `up --build` | declaration **survives** (the volume holding SQLite is named), install survives |
| `down -v` | **declaration destroyed with the install** — both live in named volumes |
| fresh host | **nothing**, unless a backup is restored |

**Row 3 is this option's central weakness and it is worse than it first
looks.** `.env` survives `down -v` because it is a file in the operator's
checkout; a table does not. The mechanism that makes `UF_PY_TOOLS` better than a
terminal — *the declaration outlives the volume* — is exactly what moving the
declaration into SQLite gives up (`14-` §3).

What buys it back is the backup, and only the backup:
`scripts/backup-db.mjs` writes one `VACUUM INTO` of the database
(`docs/backup-and-restore.md:14-31`), so **`stacks` is covered and a
`DATA_DIR` file would not have been** — which is `14-` §3's finding that a file
under `DATA_DIR` is strictly dominated. An operator who takes backups loses
nothing to `down -v`. An operator who does not loses their stack, and this
option's own page is where that has to be said.

**Not verified.** No rebuild, no `down -v`, no restore was performed; Docker is
unavailable (`01-constraints.md` §11).

## 4. Reach

Identical to `03-`'s, because the substrate is `03-`'s: `PATH` reaches all five
kinds of child untouched (`orchestrator.ts:6244-6246`, pinned at
`git.test.ts:93`), and the `acceptEdits` wall stands where
`00-problem.md` §"Missing 3" leaves it.

**What this option adds is that the allowlist can be derived rather than
typed.** `07-`'s `stackTools` entries can be offered from the declared list, and
an entry that names a tool no stack declares can be flagged. That is the same
gain `15-` §4 claims, with a stronger source: a table can be joined against,
where a parsed environment variable cannot.

## 5. Tool state, not the binary

**This is the heading where the option is honest or it is not.** A `stacks` row
records a tool; it does not record where that tool keeps its cache, its config,
its plugin directory or its credentials, and none of those are on a volume
unless somebody put them there. `$HOME` outside the four carved subdirectories is
discarded by every rebuild (`01-constraints.md` §8) and `$HOME/.npm` is on no
volume at all (`06-` §2 item 2).

Two possible treatments and the file should choose:

- **A `state_dir` column per entry**, set by the app from a per-ecosystem table
  (`TF_PLUGIN_CACHE_DIR` for Terraform, and so on), pointed inside the stacks
  volume. Correct, and it is a per-tool research task with no end — every tool
  has a different variable and the app would carry a growing table of them.
- **Nothing, and say so on the page.** A line per entry reading *"state
  directory not managed"*, which is `14-` §5's honest-rendering rule applied to
  the half the app does not control.

**The second.** The first is the shape that makes a page assert something it has
not checked, which is the failure `14-` §5 names as the worst one available
here. An operator who needs a state directory relocated can set the variable in
`.env`, and the page can say that.

## 6. What it does to the boundaries

- **`/data` 0700** — the table lives inside it, written by the server as root.
  Unchanged.
- **root / `UF_AGENT_UID`** — the installs run under `setpriv` to the agent uid,
  the entrypoint's own idiom (`docker-entrypoint.sh:147`, `:218`), so an
  installed binary is owned by the uid that will run it. **The server spawning
  them is root**, which is a fourth kind of non-`claude` child and is the one
  security fact this option adds. `docs/agent/security.md` gains it.
- **`UF_CHAT_GID`, the CLI sandbox write allowlist, the read guard, worktree
  isolation** — no interaction. Nothing here writes into a mount.
- **The MCP surface, and this one is load-bearing.** A `stacks` table is
  operator-declared configuration that decides what code every agent can run.
  `docs/agent/chat.md`'s rule is that **prompt text is the one half of a run a
  model may write**; a stack manifest is not prompt text and must not become the
  second. **`/api/stacks` is excluded from the MCP surface by name**, on the
  reasoning `04-` §6 gives and `plugins.ts` already lives by.
- **One structural trap, and it is not obvious.** `src/lib/plugins.ts:141-147`
  duplicates `resolveInMount` rather than calling it, *"because `orchestrator`
  imports this module for the spawn argv, so importing back would close a
  cycle."* A `stacks.ts` reached from the spawn path — which it is, if `15-`'s
  pre-spawn check is built — hits the same cycle and needs the same treatment.

## 7. The operator's surface

A Settings section listing every stack, each expandable to its entries, each
entry showing `declared` / `present` / `unverified` (`14-` §5) with the error
text when an install failed. A Deploy button per stack. Removal is a row delete
plus a reconcile pass that removes the binary.

Two decisions the page has to get right, both taken from the plugins section:

- **Saved on press, not on Save.** The plugins section says so in its own lede
  (`src/app/settings/page.tsx:3361`) and the module explains why the list is not
  a `Settings` field: *"the settings page sends the whole object on Save, so a
  field in that blob is one that an unrelated edit from a stale tab silently
  clears"* (`src/lib/plugins.ts:30-36`). A stack is that class of data exactly.
  **It is therefore its own table and never a `Settings` key**, which is a
  stronger version of the same rule.
- **A footnote with the honest sentence in it**, in the shape of the plugins
  one — *"A plugin's hooks run inside the container with the same access an
  agent has"* (`:3390`). The stacks equivalent: an installed tool is on every
  agent's `PATH`, and the app has not checked that a work cycle may invoke it.

## 8. How it fails, and whether loudly

**Loud, by construction, and this is the option's second real strength** —
`last_error` on the entry is what the two existing loops throw away into stderr
(`docker-entrypoint.sh:206-207`, `:306-307`, and nothing in `src/` reads either).

- An install that fails writes its error to the row and the page shows it.
- A declared tool that is not present reads `declared`, never `installed`.
- A tool never invoked reads `unverified` (`14-` §5).
- The mutation is on the audit log via `auditMutation`, as plugins' is.

What still fails quietly, and the list is longer than any other option's here
because the option is larger:

- **The reconcile-timing race.** Mitigated by awaiting the reconcile and holding
  new work (`newWorkPaused`), and *not eliminated* — a second server that does
  not own the data directory serves immediately and does not reconcile
  (`instrumentation.ts:165-180`).
- **Manifest right, volume stale**, if the disk-side diff is wrong. That diff is
  the pure function that earns a test.
- **A verb that "succeeds" and installs nothing.** `uv tool install` on a name
  resolving to an empty distribution exits 0 (`11-` §8). The four-line
  post-install `stat` is the difference between the page being true and being
  the fourth silent failure.
- **`down -v` with no backup**, §3.
- **A restore bringing back a row for a release URL that has since 404'd** —
  loud on the page, silent to a run started before anybody looks.
- **The state-directory gap**, §5, now named on the page rather than hidden.
- **The reach gap** (`00-problem.md` §"Missing 3"), and the page saying
  `present` makes it *worse* here than anywhere else, because the app is now
  asserting in a UI what it has not measured.

## 9. What it costs to build

**A week to two weeks**, and it is the most expensive option answering question
3 — as `04-` said of its own smaller version.

Files: a migration (two tables), `src/lib/stacks.ts` with tests, a route pair,
a DTO, a Settings section, an SSE or poll for deploy progress, the reconciler in
`instrumentation.ts`, plus the substrate from `02-` or `03-` underneath — which
is a `Dockerfile`, a `docker-compose.yml` and a `docker-entrypoint.sh` edit on
top.

**Which phases earn a test**, against `docs/agent/testing.md`'s bar rather than
a general convention: the argv composition (a wrong template is a wrong command
and nothing catches it), the field validators (a regex that accepts one
character too many is a silent widening of the safety argument), and the
disk-side diff (wrong in the safe direction is a re-install, wrong in the unsafe
direction is a page that lies). **Three functions, not a suite.** The route, the
page and the reconciler get none — they are I/O, and this repository does not
test I/O.

Invariants that move: `docs/agent/architecture.md` (a module, a route, and a
fourth kind of non-`claude` child), `docs/agent/security.md` (that child, and
the MCP exclusion), `docs/agent/conventions.md` (nothing — cards and a
`ListGroup` are inside the seven). `CLAUDE.md`'s "Before you edit" list gains a
line.

## 10. What would have to be true

**Promotes it:** that an operator installs tools **often enough, or across
enough machines, to need a UI** — `04-` §10's fact, unresolved there and
unresolved here. Three tools set once is an `.env` line; thirty tools across
four repositories changing monthly is this. **Nobody has the number**, because
`/data` is unreadable from this container and there is no usage history in this
proposal at all (`01-constraints.md` §5).

**Kills it:** `14-` §7's finding holding — that nothing in this app selects
between two stacks. Identity is the only thing this option buys over `15-` plus
`02-`, and identity with nothing to select between it is a table with one row in
it, a page in front of that row, a reconciler behind it, and a week of work for
a list that fits on one `.env` line. **The question that settles it is one
sentence to the operator: do you have one toolchain, or four?** It has not been
asked (`14-` §9).
