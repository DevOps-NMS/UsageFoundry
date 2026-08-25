# Implementation sketch

Five phases for `20-recommendation.md`, in build order. Each names the invariant
it must not break, what the operator sees when it lands, and whether it earns a
test.

**The test bar is `CLAUDE.md`'s and not a general convention**: a pure function
whose failure mode is silent gets a unit test, and `docs/agent/testing.md`
records what each of the 92 existing ones earned. **Three functions in this whole
plan meet it.**

The bar is not "no I/O tests" — sixteen of the 92 are over routes and
components, and `src/app/api/health/route.test.ts` says why one of them earned
it: the healthcheck *"answers falsely when this server cannot do its job"*, and
*"a route that always answers 200 is indistinguishable from a working one until
the day the database goes read-only."* **Nothing in this plan is that shape.**
Its routes are reads whose failure is a visibly empty card.

---

## Phase 0 — the probe

**One work cycle. Nothing else starts until it lands.**

`07-` §10's recipe verbatim. Set `UF_PY_TOOLS=ruff==0.6.9`, restart, confirm the
boot log line at `docker-entrypoint.sh:297`, start a run at `acceptEdits` and
ask it to run `ruff --version` and then `ruff check .`. Read the log for a
refusal and read the run's own report text.

**Invariant not to break:** none — nothing is changed. This is a measurement.

**Operator sees:** a run, and its log.

**Test:** none. **Output:** a `docs/verification.md` entry, whatever the answer,
because *"whatever it says is new information about the pinned CLI"*
(`07-` §10) and that file's honesty is the point of it.

**What it decides:** whether phase 3 exists at all. Four outcomes and each
resolves a different thing; the third — both commands allowed — deletes phase 3.

---

## Phase 1 — the documentation

**One to two days. Independent of phase 0 and can run beside it.**

Six items, and they are the only ones in this plan that could have been written
at any time in the last year:

1. **`docs/install.md` — "Tools your agents can use."** What is in the image,
   what `UF_PY_TOOLS` and `UF_GH_EXTENSIONS` add, and the
   `docker-compose.override.yml` + `Dockerfile.stack` route for anything without
   a package manager — which is Terraform, the operator's own example
   (`05-` §2, `.env.example:263-273`).
2. **`docs/install.md` — "Running commands in the container."** The
   `docker compose exec` recipe with the uid read out of the container, not out
   of the operator's shell. That page already records making the opposite mistake
   (`docs/install.md:52-56`) and the correct pair is at `:49-50`.
3. **A `Field` hint on the Settings page** naming that recipe, so an operator
   looking for a Terminal entry finds the answer where they looked. **This is the
   only `src/` change in phase 1** and it is the difference between the
   recommendation being an answer and being a refusal (`13-` §2 item 2).
4. **A `docs/security.md` paragraph** stating that this app deliberately exposes
   no in-container shell over HTTP, so that a future reader finds a decision
   rather than an omission.
5. **A `docs/verification.md` entry** recording that the three tool volumes have
   never been observed surviving a rebuild. `grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|gocache" docs/verification.md`
   returns exactly one line, `:1371`, and it is about a guard. The mechanism this
   whole survey builds on is pinned by a unit test over file *contents*
   (`deployment.test.ts:664`, `:733`) and nothing else.
6. **The code-comment corrections**, as corrected by `22-validation.md` — which
   found that one of the three `06-` §2 proposed was itself a misreading. What
   survives: `Dockerfile:10`'s claim that `python3 make g++` *"stay in this stage
   and never reach the runtime image"*, contradicted by `:127-132`, which
   installs all three in the runner; `privsep.ts:236-238`'s two overcounts; and
   `CLAUDE.md:35`'s "four modules", which `docs/agent/architecture.md:203`
   repeats and then contradicts in the same paragraph.

**Invariant not to break:** `docs/README.md` is the index and a list elsewhere is
what drifted last time (`CLAUDE.md`, Docs). New sections go in existing operator
pages; no new file under `docs/` unless one of these outgrows its host.

**Operator sees:** two new sections in `docs/install.md`, and one line on the
Settings page pointing at them.

**Test:** none. Documentation. **But `deployment.test.ts` is where a claim about
the image belongs**, and item 5's entry is prose about something never observed —
so it must be written as *"not verified"* rather than as a verification, which is
what that file's "Not yet verified by hand" list exists for.

---

## Phase 2 — the inventory and the read-back

**Two to three days. This is the feature.**

### `src/lib/toolInventory.ts`

Three functions, and the first two are the only ones in this plan that earn a
test.

```ts
parseToolList(kind, raw)       // "ruff==0.6.9|black" → [{name, version}]
executableFor(entry)           // an entry → the command name it should produce
resolveState(entry, probe)     // → "declared" | "present" | "unverified"
```

**`parseToolList` earns a test, and the grounds are specific.** The two
declarations do not use the same separator: `UF_GH_EXTENSIONS` splits on `|`
*and* `,` (`docker-entrypoint.sh:185`) while `UF_PY_TOOLS` splits on `|` only,
*because a comma is meaningful inside a version* (`:243`, `:252`). A parser that
takes the wrong branch produces entries that do not match anything the entrypoint
installed, so **every tool reads `declared` and the card is uniformly, silently
wrong**. That is a pure function whose failure mode is silent, which is
`CLAUDE.md`'s bar exactly.

**`executableFor` earns a test on a different ground**: it is a mapping, and a
wrong mapping shows `declared` for a tool that is present. Wrong in the
reassuring direction is what `14-` §5 calls the worst failure available here.
The test pins the known cases and pins that an unknown package falls back to its
own name rather than to `undefined`.

**`resolveState` does not earn one.** It is three branches over a boolean and a
never-observed flag; it cannot fail silently because there is nothing in it to
get subtly wrong.

### `GET /api/tools`

`runtime = "nodejs"`, `dynamic = "force-dynamic"`, through `jsonMaybeGzipped`,
its own list DTO (`docs/agent/conventions.md`). Read-only, so no
`auditMutation` — and no MCP exposure: excluded by name, because a read-only
inventory still tells a model exactly which binaries are on the box
(`15-` §6).

**One thing this route must get right and it is not obvious.** It reads
environment variables. The server's environment holds `UF_AUTH_TOKEN`,
`UF_GITHUB_TOKEN` and `ANTHROPIC_ADMIN_KEY`. **It returns a parsed, typed DTO and
never a raw environment**, and the DTO's type is what enforces that.

Note that the variables *are* readable here even though `childEnv` strips `UF_*`:
the strip is a child-side rule and the server is `exec`'d by the entrypoint
holding them (`docker-entrypoint.sh:972`). Checked rather than assumed — compose
forwards both at `docker-compose.yml:123` and `:130`, and the only two variables
the entrypoint unsets before `exec` are `DISCORD_WEBHOOK_URL` and
`DISCORD_MENTION_USER_ID` (`:853`). That asymmetry is what makes this phase cheap
and it should be written down in a comment, because it looks like a bug to anyone
who knows the strip and not the reason for it.

### The card

A Settings section, not a pane. `08-` §6 settled that there is no tenth pane
(`panes.ts:12-16`, `ui-density-audit.md:159`, `:160-161`), and the plugins
section is the precedent for an operator-declared list living in Settings
(`src/app/settings/page.tsx:109`, `:3359`).

- A `ListGroup` of entries, each with a state badge.
- **`unverified`, never `installed`.** The app does not assert what it has not
  checked (`14-` §5), and the shape is the metering rule's: unknown renders as a
  hatched indeterminate meter, never a 0% bar (`docs/agent/metering.md`).
- A footnote in the shape of the plugins one (`:3390`): an installed tool is on
  every agent's `PATH`, and the app has not checked that a work cycle may invoke
  it.

**Invariants not to break:**

- **Variants are typed props with `Record<Union, string>` lookup maps, never
  `data-[…]` Tailwind variants** (`docs/agent/conventions.md`). Three states is a
  union and a lookup map, not three conditional class strings.
- **A caller's class never cancels a component's own spacing** — use a wrapper.
- **`"use client"` files import from `apiTypes.ts` / `format.ts`, never
  `windows.ts` / `transcripts.ts`.** The card is a client component and the
  parser is server-side; the DTO is the boundary.
- **The seven affordances.** A card and a `ListGroup` are two of them; a region
  is a `<div>` with an `<h2>` and never a `<section>`.
- **A poll stands down when its subject can no longer move.** This card's
  subject moves only at a container restart, so **it should not poll at all** —
  it loads once. Adding a poll here would be the easy wrong answer.

**Operator sees:** a Settings card listing every declared tool, its state, and
the error when an install failed — the first time anything in this app has been
able to answer *"what is installed here"* (`00-problem.md` §"Missing 4").

**Test:** two functions, named above. `src/lib/toolInventory.test.ts`, in the
shape of the existing `config.test.ts` and `format.test.ts` — small, pure, one
`describe` per function.

---

## Phase 3 — `stackTools`, conditional on phase 0

**One to two days, and it is deleted rather than deferred if the probe's third
outcome comes back.**

- **`stackTools: string[]` on `Settings`, defaulting to `[]`**, in the shape of
  `resolveVerifyTools` (`settings.ts:314`, `:743`) — the existing operator-owned
  tool-pattern list, which ships empty for a reason worth copying verbatim:
  *"This app runs against whatever repository is mounted, so there is no command
  it could ship that is right for one"* (`settings.ts:300-303`).
- **Validation at save**, against the CLI's `Bash(cmd:*)` pattern form. An entry
  an operator gets wrong is silent otherwise.
- **Pushed onto the existing `--allowedTools` flag** at
  `orchestrator.ts:5525-5529`, after `ISOLATED_GIT_TOOLS` and before
  `SEARCH_TOOLS`. **One flag, never two** — *"a second `--allowedTools` is a
  variadic option the CLI would read as a replacement rather than an addition"*
  (`:5521`).
- **Install-wide, not per-run**, per `14-` §7. `07-` §10 left this to run 3 and
  it is settled: the grant is about what the container holds.
- **The candidates come from phase 2.** An allowlist derived from a declaration
  is maintainable; one hand-typed into a settings text box is not.

**Invariants not to break:**

- **`saveSettings` stores only what differs from `DEFAULTS`** (`CLAUDE.md`).
  Shipping `[]` means an install that never touches this writes nothing, and the
  argv is byte-identical to today's.
- **The `--allowedTools` ordering is asserted by tests** and `SEARCH_TOOLS` is
  deliberately last as *"the entry that is always there"* (`:5520-5524`).
- **`SELF_HOSTING_NOTICE` carries no literal an agent could `pgrep -f`**
  (`docs/agent/security.md`). A settings field that ends up on argv is on every
  sibling's argv too; nothing about a tool pattern offers such a literal today,
  and the reviewer of this phase should confirm it rather than assume it.

**Operator sees:** a settings field, and — if the probe said reach was
broken — runs that can now invoke the tools they installed.

**Test:** one, in the shape of the existing `--allowedTools` ordering
assertions — that a configured `stackTools` lands between `ISOLATED_GIT_TOOLS`
and `SEARCH_TOOLS` on one flag. **The pattern validator does not earn a separate
one**: it is a regex whose failure is a refusal at save, which is loud.

---

## Phase 4 — deferred: the refusal

**Not built now.** `17-`'s pre-spawn refusal is the highest-value thing in this
directory and it is also the one whose failure mode is a run that does not start
for no visible reason. Build it **after phase 2 has run long enough to show that
`executableFor` is reliable in practice** — which the card makes observable,
because an operator who sees `declared` beside a tool they know is installed has
found the bug that phase 4 would otherwise turn into a false refusal.

When it is built:

- `requiredTools` as a **column** on `run_templates` via `addColumn` in
  `migrate()`, not a key in the budget blob, on `permission_mode`'s reasoning:
  *"A column is greppable; a key in a JSON blob is not"* (`src/lib/db.ts:249-252`).
- The check **before the spawn and never at admission** — `createRun` runs
  entry-to-INSERT with no `await` and adding one silently puts two agents in one
  directory (`docs/agent/concurrency-and-ownership.md`).
- A distinct `RefusalCause` naming the missing tool, in the shape of
  `rate-limited` (`CLAUDE.md`).
- **And the fallback that `17-` §10 names**: if the mapping proves unreliable,
  the correct feature is a warning on the run rather than a refusal — because
  this app's own rule for a guard that cannot read its input is to **hold**, not
  refuse (`docs/agent/budgets-and-guards.md`).

**Test:** the mapping already has one from phase 2; that is the one that matters
here.

---

## What is not in this plan, and where it went

| Not built | Why | Where it is argued |
|---|---|---|
| A Terminal pane, in any form | no tenth pane, and `docker compose exec` is shipped and documented twenty times | `20-` "What in the operator's idea should not be built" |
| A `stacks` table | identity with nothing selecting between stacks | `20-`, `14-` §7 |
| A repository manifest | widest boundary, held by one sentence | `20-`, `18-` §10 |
| `UF_BIN_TOOLS` | **deferred behind `05-`'s minimal form**, not rejected | `20-` |
| An installer of any kind | phase 1's `Dockerfile.stack` is the install path | `05-` §2 |

## The order is the argument

Phase 0 before everything, because eleven of the twelve rows in `19-`'s table
score 0-3 on reach and the measurement costs one work cycle. Phase 1 before
phase 2, because if the documentation alone satisfies the operator then phase 2
is optional and two to three days are saved. Phase 3 last among the built
phases, because it is the only one the probe can delete. Phase 4 after phase 2
has been in use, because it is the only one whose failure stops work.

**Nothing here depends on a fact this container could not check**, with one
exception: every persistence claim underneath phase 1's documentation is reasoned
from the compose file's own statements rather than observed, because Docker is
unavailable here. `22-validation.md` lists the commands that settle it.
