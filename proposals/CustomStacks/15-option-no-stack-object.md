# Option L — there is no stack object; build the read-back instead

Store nothing new. The three `UF_*` lists **are** the stack. What gets built is
the one thing `00-problem.md` §"Missing 4" says is missing: a page that reports,
for every tool the install declares, whether it is `declared`, `present` or
`unverified`.

Every option file in this directory needs a null hypothesis to beat.
`06-option-build-nothing.md` is the substrate half's and `13-option-build-no-terminal.md`
is the surface half's. This is question 3's, and it is the only one of the three
that ships a feature.

## 1. The strongest case

`14-` §1 shows the object model is already decided: `UF_PY_TOOLS` is a
declarative per-ecosystem manifest with five of the six properties a stack needs,
and the missing one is identity, which nothing in this app selects between
(`14-` §7). Adding a table to store what a `.env` line already stores buys a
schema, a route, a page, a lifecycle and a reconcile-host question (`04-` §2) in
exchange for the same list in a different file. Meanwhile `14-` §8 is the
argument nobody in this directory has answered: **the cheap failure is the one
the operator sees and the expensive one is the one nobody does.** A tool that
fails to install costs a boot log line. A tool that is absent costs billed tokens
on every cycle of every run that needed it, silently, 213 sessions at a time
(`.env.example:222-226`). This option spends its entire budget on the second
one — one `stat` per declared tool, three states rendered honestly, and a run
that requires a missing tool refused before it spends anything. It is the
smallest change in this directory that makes the existing mechanism *legible*,
and legibility is the whole of what the operator was missing.

## 2. Shape

- **No schema, no table, no migration.** The declarations stay in `.env`, read by
  `docker-entrypoint.sh` at `:169` and `:241`, exactly as today.
- **`src/lib/toolInventory.ts`** — pure, and this is where the option's whole
  value sits:
  - parse `UF_GH_EXTENSIONS` / `UF_PY_TOOLS` (and `UF_BIN_TOOLS` if `02-` is also
    built) into `{ecosystem, name, version}` entries. The two parsers differ —
    `UF_GH_EXTENSIONS` splits on `|` *and* `,` while `UF_PY_TOOLS` splits on `|`
    only, *"because a comma is meaningful inside a version"*
    (`docker-entrypoint.sh:243`) — and a parser that gets that wrong silently
    installs nothing. **That is a pure function whose failure mode is silent,
    which is `CLAUDE.md`'s bar for a unit test** (`docs/agent/testing.md` is the
    standard).
  - map an entry to the executable name it should produce, and `stat` it.
  - return one of three states per entry, never two: `declared` / `present` /
    `unverified` (`14-` §5).
- **The variables must reach the server**, and today they do not: `childEnv`
  strips `UF_*` from *children* (`01-constraints.md` §3) but the **server** is
  `exec`'d by the entrypoint (`docker-entrypoint.sh:972`) and holds them. So the
  read is `process.env.UF_PY_TOOLS` in a Node-runtime route, which is legal
  precisely because the strip is a child-side rule. **This is the one non-obvious
  fact the option depends on** and it is the reason the option is cheap.
- **`GET /api/tools`** — `runtime = "nodejs"`, `dynamic = "force-dynamic"`,
  through `jsonMaybeGzipped` like the other eighteen, with its own list DTO
  (`docs/agent/conventions.md`).
- **A card on the Settings page**, not a pane — `14-` needs no destination and
  `08-` §6 already refused a tenth one (`panes.ts:12-16`,
  `ui-density-audit.md:159`, `:161`). A `ListGroup` of entries with a state
  badge, inside the seven affordances.
- **Optional, and it is the tier-2 half of `14-` §5:** a `requiredTools: string[]`
  on `Settings` and on `run_templates`, checked **before the spawn and never at
  admission** (`14-` §4), refusing the cycle by name when an entry is not
  `present`. Roughly 20 lines in the run loop.

No volume, no `Dockerfile` edit, no `docker-compose.yml` edit, no entrypoint
edit, no dependency.

## 3. What persists it, and what discards it

| Event | Outcome |
|---|---|
| `docker restart` | unchanged — the declaration is `.env`, the install loop re-runs and skips what is present |
| `up --build` | **survives**, on the existing volumes' terms (`02-` §3) |
| `down -v` | volume destroyed, **declaration intact, next boot reinstalls** |
| fresh host | reinstalled from `.env` |

`scripts/backup-db.mjs` covers nothing here and does not need to: this option
stores nothing. The `requiredTools` half, if built, is a setting and is therefore
in every snapshot (`docs/backup-and-restore.md:14-31`) — and `saveSettings`
stores only what differs from `DEFAULTS` (`CLAUDE.md`), so an install that never
sets it writes nothing.

**Not verified.** No rebuild was performed; Docker is unavailable
(`01-constraints.md` §11 item 1 is the command).

## 4. Reach

Unchanged from today, in every respect: `PATH` reaches all five kinds of child
untouched (`orchestrator.ts:6244-6246`, pinned at `git.test.ts:93`), and the
`acceptEdits` wall stands exactly where `00-problem.md` §"Missing 3" leaves it.

**What this option adds to reach is not a mechanism, it is a fact.** Today
nothing in the app knows what is installed, so `07-`'s `stackTools` allowlist
would be a text box an operator hand-types. With an inventory, the settings page
can offer the declared tools as the candidate grants — *"an allowlist that is
derived from a declaration is maintainable, and one hand-typed into a settings
text box is not"* (`04-` §4). This option is the cheapest thing that makes `07-`
maintainable, and `07-` is the thing the whole survey turns on.

## 5. Tool state, not the binary

**Nothing.** This option installs nothing and relocates nothing. `$HOME` outside
the four carved subdirectories is still discarded by every rebuild
(`01-constraints.md` §8), and `$HOME/.npm` is still on no volume at all.

Worth stating rather than skipping, because it is the option's honest limit: the
inventory can *report* that a tool is present and cannot report that its cache
is durable. A state directory has no executable to `stat`. **The one thing it can
do is name the gap on the same card** — a line saying which of the declared tools
keep state in `$HOME` — and that is documentation with a data source rather than
a check.

## 6. What it does to the boundaries

**It crosses none.** No new writable directory, no new `PATH` entry, no new
volume, no new table, no new child process, no new credential.

- **`/data` 0700** — untouched; nothing is written.
- **root / `UF_AGENT_UID`** — untouched; nothing is installed.
- **`UF_CHAT_GID`**, **CLI sandbox write allowlist**, **read guard**, **worktree
  isolation** — no interaction.
- **The one thing to get right**: `GET /api/tools` reads environment variables
  and `stat`s paths. It must not echo the *values* of anything but the two lists
  it parses — the server's environment holds `UF_AUTH_TOKEN`, `UF_GITHUB_TOKEN`
  and `ANTHROPIC_ADMIN_KEY`, and a route that returned `process.env` would hand
  all three to any holder of the cookie. The route returns a parsed, typed DTO
  and never a raw environment.
- **And it must stay off the MCP surface**, on `04-` §6's rule. A read-only
  inventory is a weaker leak than a manifest a model can write, but it still
  tells a model exactly which binaries are on the box, and `docs/agent/chat.md`'s
  rule is that prompt text is the one half of a run a model may write. Reading
  is a smaller question than writing; excluding it by name costs nothing.

The `requiredTools` half adds one boundary and it is a *narrowing*: a run that
would have spent tokens against a missing tool does not start.

## 7. The operator's surface

A card on Settings that lists every declared tool and its state, plus the two
`.env` variables' current values and the recipe for changing them. Read-back is
the point of the option and it is the whole of the option.

Changing or removing a tool is unchanged: edit `.env`, restart, and remove the
old binary by hand for a version change, because both loops skip an
already-installed entry deliberately (`.env.example:204-207`, `:288-290`;
`02-` §7).

**This is not what was asked for and the file should say so.** They asked to
deploy a stack from the web interface. This shows them what is deployed and lets
them change it in a text file. It closes `00-problem.md` §"Missing 4" and closes
nothing else.

## 8. How it fails, and whether loudly

**The only option in this directory whose entire subject is loudness, judged
against `.env.example:222-226`'s 213 sessions — and it clears that bar
directly**, because the failure that produced those 213 sessions was a plugin
reporting itself active against a command that was never present, and a card
reading `unverified` beside that command is the exact contradiction that was
missing.

Loud:

- A declared tool that never installed reads `declared`, not `present`. That is
  the boot log's `could not install` line arriving on a surface somebody looks
  at.
- A tool whose invocation has never been observed reads `unverified`, never
  `installed` (`14-` §5). The app does not assert what it has not checked.
- With `requiredTools`, a run that needs a missing tool is **refused by name**
  before it spawns — `docs/agent/agents-and-templates.md`'s shape for a deleted
  agent, applied to a missing binary.

Still silent, and the list is short because the option adds so little:

- **A tool present under a different executable name than its package name.** The
  entry-to-executable mapping in §2 is a guess for anything but the common cases,
  and a wrong guess reads `declared` for a tool that is actually there. That is a
  false alarm rather than a false assurance, which is the right direction to fail
  — but it is still wrong on a page.
- **A typo in a variable name.** Compose has no `env_file`, so a name
  `docker-compose.yml` does not forward never reaches the container
  (`docs/agent/environment.md:27`) — the card then shows an empty list, which
  looks identical to declaring nothing. `deployment.test.ts:961` is what catches
  it in the tree and nothing catches it on the card.
- **State 3.** `unverified` is honest and it is not an answer. Nothing here
  measures whether a work cycle can invoke the tool, and nothing can without
  `07-` §10's probe.

## 9. What it costs to build

**Two to three days**, and it is the only option answering question 3 that could
ship this week.

Files: one `src/lib/` module with real unit tests (the two parsers and the
state resolution — three pure functions whose failure is silent), one route, one
DTO, one Settings card. Add a day for the `requiredTools` half, which is a
settings field, a `run_templates` column and a pre-spawn check.

**No `docs/agent/` invariant moves.** `docs/agent/architecture.md` gains a module
line and `docs/agent/conventions.md` gains nothing — a card and a `ListGroup` are
two of the seven affordances.

## 10. What would have to be true

**Promotes it:** that the operator's stack is three or four tools that change
rarely. `14-` §1's whole argument is that identity is earned only when something
selects between stacks, and a single short list selects between nothing. If the
real shape is "Terraform, `kubectl`, and one linter, set once", then every
option below this one is a table and a page in front of a list that fits on one
line, and this is the answer.

**Kills it:** the operator wanting to change the declaration **from the browser**
rather than read it there. That is a fair reading of *"deploy from the web
interface"* and this option refuses it outright — it makes `.env` visible and
leaves it as the only way to edit. If editing is the requirement, this option is
half a feature and `16-` is the smallest complete one.
