# Option C — a declared manifest, stored in the database, reapplied at boot

The operator edits a stack in the UI; it is stored as rows; `instrumentation.ts`
or the entrypoint reconciles the volume against it on every boot, installing what
is missing and reporting what failed. The volume is a **cache**; the manifest is
the truth.

This is `UF_PY_TOOLS` with the declaration moved from `.env` into SQLite and a
page put in front of it.

## 1. The strongest case

The two existing loops have the right architecture and the wrong storage. A
declaration is what makes a tool survive `down -v`, survive a move to a new host,
and be answerable to the question "what is installed here" — and `.env` gives all
three. What `.env` does *not* give is the thing the operator actually asked for:
a surface in the web interface, and a read-back that is not a boot log nobody
scrolls. Moving the declaration into the database changes nothing about the
mechanism and everything about the experience: the same idempotent reconcile
loop, the same volume, the same `PATH`, but now with a page that lists what is
declared, what is installed, what failed and why. It is the only option here that
closes `00-problem.md`'s Missing 4 — nothing in the app can see any of this — and
it does so without giving anyone a shell.

## 2. Shape

- **Schema**: one table, `stack_tools` — `name`, `kind` (`binary` | `python` |
  `gh`), `version`, `source`, `created_at`, `last_result`, `last_error`. An
  idempotent `CREATE TABLE IF NOT EXISTS` in `migrate()` in `db.ts`, per
  `CLAUDE.md`'s schema rule.
- **`src/lib/stacks.ts`** — pure resolution: manifest rows → an ordered list of
  install actions, plus a diff against what is on disk. The parsing and the diff
  are exactly the kind of pure function whose failure is silent, so they get unit
  tests (`CLAUDE.md`'s "Always" bar, and `docs/agent/testing.md` is the standard).
- **`/api/stacks`** — `runtime = "nodejs"`, `dynamic = "force-dynamic"`,
  answering through `jsonMaybeGzipped` like the other eighteen
  (`docs/agent/conventions.md`). Its own list DTO, per the list-DTO rule.
- **A pane**, tenth in `src/components/shell/panes.ts:27-38` — and it has no
  shortcut, because there is no digit left: *"Nine is the ceiling and Knowledge
  is the ninth — a tenth destination has no digit, and a row without one is a row
  two of the four readers cannot describe"* (`panes.ts:14-16`). That is a cost
  this option carries rather than a detail of it, and `08-terminal-problem.md` §6
  and `docs/agent/ui-density-audit.md:159` later refuse a tenth pane outright —
  the one thing in this option a later file overturns.
- **The reconciler** — and this is the design's one hard question, §"Where the
  reconcile runs" below.
- **The volume and the `PATH` entry** from Option B (`03-`) §2, unchanged. This
  option is a *layer over* one of the two preceding ones, not a replacement for
  the substrate.

### Where the reconcile runs — the one hard question

Three candidates, and only the third is clean.

**In `docker-entrypoint.sh`.** Matches the existing loops. But the entrypoint
runs before the server and would have to read SQLite itself — the image ships
`sqlite3` (`Dockerfile:130`), so it is possible — and `/data` is root-owned 0700,
which the entrypoint is (`Dockerfile:517-519`). Workable, and it puts the
manifest's reader outside the app that owns the schema, which is the sort of
split that goes stale.

**In `instrumentation.ts` at boot.** The app already does startup work there
(`docs/agent/concurrency-and-ownership.md`). But installing a toolchain is
minutes of network I/O, and the boot path is where the reconcilers that close out
`running` rows live. Blocking it is wrong and not blocking it means the first
run after a boot may start before its tools exist — a race with no error, only a
missing command.

**As a run.** The reconcile is a job: it takes minutes, it can fail, it wants a
log and a status. This app already has a thing that takes minutes, can fail, has
a log and a status. The awkwardness is that it is a *run* in a sense the `runs`
table does not mean — no repository, no branch, no work cycles, no spend — and
`runs.origin` is a required field at every `createRun` call site
(`docs/agent/run-lifecycle.md`). Bending `runs` to hold it is the kind of change
that breaks the retention sweeps and the dependency graph quietly. **A separate
`ops_events`-style record with its own SSE topic is the honest shape**, and it is
more work than it looks.

**This unresolved question is the option's true cost**, and any recommendation
that picks Option C must pick one of the three.

## 3. What persists it, and what discards it

| Event | Outcome |
|---|---|
| `docker restart` | reconcile runs, everything already present, no-op |
| `up --build` | volume survives; reconcile is a no-op |
| `down -v` | volume destroyed — **and the manifest goes with it**, because the manifest is in `usagefoundry-data`, which is also a named volume (`docker-compose.yml:368`) |
| fresh host | **restored, if and only if the operator restored a backup** |

That third row is the trap and it is specific to this option. `.env` survives
`down -v` because it is in the operator's checkout; a database row does not,
because `usagefoundry-data` is destroyed by the same `-v`.

**But this is the one option `scripts/backup-db.mjs` already covers.** A manifest
in SQLite is in every snapshot the operator takes, and
`docs/backup-and-restore.md:139-142` already says the database is the *only* copy
of workflows and schedules and that losing the volume means rebuilding them by
hand. A stack manifest joins that list, under the same warning, with the same
existing remedy. No new backup mechanism is needed — which is more than Option B
can say.

**Not verified.** No rebuild, no restore, no volume destruction was performed
here.

## 4. Reach

Whatever the underlying substrate gives — Option A's or Option B's `PATH` entry,
reaching all five children unmodified.

The manifest adds one reach property the others lack: **the app knows what is
installed**, so it can put that on a page, in a run's prompt, or — see `07-` — on
`--allowedTools`. That last is the reason this option is worth more than its
mechanism suggests: an allowlist that is derived from a declaration is
maintainable, and one hand-typed into a settings text box is not.

`acceptEdits` still gates invocation. This option does not fix it; it makes
fixing it tractable.

## 5. Tool state, not the binary

The manifest is the right place to carry it: a `state_env` column, or a
per-`kind` convention, lets the reconciler write the relocation the tool needs.
But **environment variables cannot be set retroactively on a running server**,
and every child inherits the server's environment (`childEnv` at
`orchestrator.ts:6307`). So a tool added through the UI at 14:00 cannot get its
`TF_PLUGIN_CACHE_DIR` into a run started at 14:05 without a restart.

Two ways out, both real: put the relocations in the image's `ENV` for the
supported `kind`s and accept that new kinds need a release; or have the
reconciler write a config *file* at the tool's default location rather than
setting a variable (`~/.terraformrc`, `~/.config/...`) — which works, and drops
back into the writable layer unless the config file itself is on the volume with
a symlink. Neither is elegant. **This is the sharpest instance of the general
problem in `00-problem.md` §"Missing 2" and no option in this directory solves it
cleanly.**

## 6. What it does to the boundaries

- **A new writable table an agent might reach.** `/data` is 0700 root-owned
  precisely so an agent cannot rewrite a budget or a permission mode straight in
  the database (`Dockerfile:471-477`), and that holds here — but `/api/stacks`
  is an HTTP surface, and the orchestrator chat can make HTTP requests. If a
  stack manifest becomes writable through `/api/mcp`, **a model can install
  software on the host container**, which is a materially different capability
  from anything the MCP surface grants today. `docs/agent/chat.md`'s rule is that
  prompt text is the one half of a run a model may write; a tool manifest must
  not become the second. **Any route added here must be excluded from the MCP
  tool surface by name.**
- **`auditMutation`** wraps 33 exports and every mutation should be one
  (`docs/agent/run-lifecycle.md:11`), so an install is an audit row — which is a
  genuine improvement over both A and B, where an install is a log line at most.
- **The `createRun` no-`await` rule** — nothing in this option may be consulted
  during admission (`docs/agent/concurrency-and-ownership.md`).
- **`saveSettings` stores only what differs from `DEFAULTS`** — if any part of
  this lands in settings rather than its own table, it inherits that.
- **CLI sandbox, read guard, worktree isolation** — as Option B.

## 7. The operator's surface

The best in the directory, and the only one that is actually what was asked for:
a page listing declared tools with a version, a state (`installed` / `failed` /
`pending`), the error text when it failed, and a button that reapplies. Removal
is a row delete plus a reconcile that removes the binary.

Precedent for the whole shape exists: `/api/plugins` and the plugins page are a
stored list of operator-declared directories, proved contained at use time, with
a page in front (`docs/agent/architecture.md`, plugins section).

## 8. How it fails, and whether loudly

**Loudly, by construction, and that is the point of the option.** `last_error` on
the row is the failure the two existing loops throw away into stderr.

What can still fail quietly:

- **The reconcile-timing race** in §2: a run admitted before the reconcile
  finishes meets a missing command. Nothing in the run loop reads that.
- **A manifest that is right and a volume that is stale**, if the reconciler's
  disk-side diff is wrong. The diff is the pure function that gets the unit test.
- **A restore that brings back a manifest for a tool whose release URL has since
  404'd.** Loud on the page, silent to a run started before anybody looks.
- **The state-variable gap in §5** — the tool is installed, the page says
  `installed`, and it re-downloads its providers every cycle.

## 9. What it costs to build

The most expensive option here. A migration, a new `src/lib/` module with tests,
a route, a DTO, a pane, a client page, an SSE or poll for progress, plus the
underlying substrate from A or B, plus the reconcile-host decision in §2 and
whatever that drags in.

**A week to two weeks**, and it moves or adds material in
`docs/agent/architecture.md`, `docs/agent/conventions.md` (a tenth pane) and
`docs/agent/security.md` (§6's MCP exclusion). Against the survey's other
options that is 4-20× the cost, and §"Missing 3" is still unfixed at the end of
it.

## 10. What would have to be true

**Promotes it:** that operators install tools *often enough to need a UI*. Three
tools installed once is an `.env` line; thirty tools across four repositories
changing monthly is a manifest. Nobody here has that number —
`/data` is unreadable from this container, so there is no usage history in this
proposal at all.

**Kills it:** the reconcile-host question in §2 having no clean answer. If
installing a toolchain has to become a `runs` row to get a log and a status, the
cost of this option is not a week — it is a week plus a permanent distortion of
the table three subsystems read.
