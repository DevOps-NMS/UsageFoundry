# Option N — a stack is a *requirement*, and the app installs nothing

Invert the feature. A stack is a named set of **preconditions** — this run needs
`terraform` on `PATH` — that a template may point at. The app checks them, and
**refuses a run whose stack is not satisfied, before it spawns.** How the tool
got there is not the app's business: `.env`, a `Dockerfile.stack`, a
`docker compose exec`, whatever the operator likes.

This is `14-` §2's fourth shape, which nothing in this directory had proposed,
and `14-` §7's resolution — *a per-template field may name what a run requires,
never what it installs* — taken as the whole design rather than as a footnote.

## 1. The strongest case

`14-` §8 is the finding this option is built on and it has not been answered by
anything else here: **the cheap failure is the one the operator sees and the
expensive one is the one nobody does.** An install that fails costs a boot log
line. A tool that is absent costs billed tokens on every cycle of every run that
needed it, discovered by nobody, 213 sessions at a time
(`.env.example:222-226`). Every other option in this directory spends most of
its budget on the installer — the half that already works twice
(`docker-entrypoint.sh:169-211`, `:241-310`) and whose failures are visible — and
gets the read-back as a by-product. This one spends all of it on the expensive
half and builds no installer at all. It is also the only option whose central
mechanism this app already has three working instances of: **refusal at the
door.** A deleted agent is *"refused by name at every door, never falls back to
none"* (`docs/agent/agents-and-templates.md`); `no_ceiling` is *refused at the
door and never acted on afterwards* (`docs/agent/budgets-and-guards.md`); a
missing template is refused by `planProposal`. A missing binary is the same
shape, and the rung already exists.

## 2. Shape

- **A `requirements` field, and the smallest honest version has no table at
  all.** `requiredTools: string[]` on `run_templates` — a column, not a key in
  the budget blob, on `permission_mode`'s own reasoning: *"this is the one field
  on a template that decides what a spawned agent is allowed to do. A column is
  greppable; a key in a JSON blob is not"* (`src/lib/db.ts:249-252`). A tool
  requirement decides whether a run may start. Same weight, same treatment.
  - **Named sets are the optional half.** If an operator has three templates
    sharing one requirement list, a `stacks` table with a `stack_id` on the
    template is the ordinary normalisation. It is *not* the object model in
    `16-`: no installer, no reconcile, no deploy button, no `last_error`. Build
    it if two templates ever share a list, and not before.
- **`src/lib/toolInventory.ts`** — `15-` §2's module, unchanged and shared. A
  requirement name → the executable it implies → a `stat` → present or not.
  Pure, silent on failure, and therefore tested (`CLAUDE.md`'s "Always" bar;
  `docs/agent/testing.md` is the standard).
- **The check, and its placement is the design decision.** Immediately before
  the spawn, inside the run loop, **never during admission**. `createRun` runs
  entry-to-INSERT with no `await` and adding one silently puts two agents in one
  directory (`docs/agent/concurrency-and-ownership.md`); a `stat` in the loop is
  a few microseconds and breaks nothing. `14-` §4 states the split: *admission
  may not `await`; the spawn may*.
- **The refusal.** A `RefusalCause` in the existing set, in the shape of
  `rate-limited` — *"a distinct `RefusalCause` naming that setting"*
  (`CLAUDE.md`). It parks the run with the missing tool named, and the operator
  fixes `.env` and reopens.
- **Optionally, `stackTools` from `07-` derived rather than typed.** A
  requirement list is exactly the candidate set for `--allowedTools`, which is
  `15-` §4's argument and is stronger here because the list is per-template and
  therefore narrow.

No volume, no `Dockerfile` edit, no `docker-compose.yml` edit, no entrypoint
edit, no installer, no dependency, no new child process.

## 3. What persists it, and what discards it

| Event | Outcome |
|---|---|
| `docker restart` | requirement survives (a template column); satisfaction re-checked at every spawn |
| `up --build` | **survives** |
| `down -v` | **destroyed with the database** — restore from backup |
| fresh host | restore from backup, or re-enter |

`scripts/backup-db.mjs` covers it: it is a column on an existing table and the
backup is one `VACUUM INTO` of the whole database
(`docs/backup-and-restore.md:14-31`).

**And the row that matters is not in the table.** This option's persistence
story is *deliberately thin*, because what it stores is not the tool. The tool's
persistence is whichever of `02-` through `06-` the operator chose, and this
option is agnostic between them — it works identically over a `UF_PY_TOOLS`
entry, an image layer, and something installed by hand at 3am. **That is the
option's structural property, not a gap**: a precondition does not care how it
came to be true.

## 4. Reach

Unchanged in mechanism — `PATH` reaches all five kinds of child untouched
(`orchestrator.ts:6244-6246`, pinned at `git.test.ts:93`).

**Changed in outcome, and this is the only option in the directory that changes
it.** Today a run whose tool is missing runs anyway, meets `unknown command`
inside a tool call the run loop does not read, and is filed as the agent
choosing not to use the tool (`docker-compose.yml:386-391`). Under this option
that run does not start. **The reach gap is not closed — it is made
unreachable**, which is a weaker claim and a cheaper one.

The `acceptEdits` wall (`00-problem.md` §"Missing 3") is untouched and is the
option's honest limit: a tool can be `present` and still be un-invokable, and
nothing here measures that. `14-` §5's three states apply exactly — this option
checks state 2 and cannot check state 3.

## 5. Tool state, not the binary

**Nothing, and it is the one option where that is the right answer rather than
an evasion.** This option installs nothing, so it relocates nothing and has no
state directory to own. The gap is real, it belongs to whichever substrate
option is chosen underneath, and `01-constraints.md` §8's table is where it
lives.

The one thing worth adding: a requirement could name a *directory* as well as an
executable — `TF_PLUGIN_CACHE_DIR` exists and is writable — which turns §5 from
"nothing" into "one more `stat`". That is a legal extension and it should wait
for an operator who asks for it.

## 6. What it does to the boundaries

**It crosses none, and it narrows one.**

- **`/data` 0700, root/`UF_AGENT_UID`, `UF_CHAT_GID`, the CLI sandbox write
  allowlist, the read guard, worktree isolation** — no interaction with any of
  them. Nothing is installed, nothing is written outside the database, no child
  is spawned.
- **The narrowing**: a run that would have spent tokens against a missing tool
  does not start. That is a strictly smaller set of runs, not a larger one.
- **The MCP surface.** A requirement list is guard-adjacent — it decides whether
  a run may start — so it must not be model-writable. `docs/agent/chat.md`'s
  rule is that prompt text is the one half of a run a model may write, and
  `docs/agent/workflows-and-schedules.md` puts guards on the template rather
  than the node for the same reason. **Requirements are template data and the
  template surface is already the guarded one**, so this costs nothing new — it
  inherits an exclusion that exists.
- **One thing to be careful of.** A refusal message names the missing tool, and
  a refusal is visible to whoever can read the run. That leaks the fact that a
  binary is absent, which is not a secret and is the point of the feature.

## 7. The operator's surface

A field on the run-template form: the tools this template's runs require. A
refusal on the run when one is missing, naming it.

Removing a requirement is clearing the field. There is no deploy, no reapply, no
removal path for the tool itself, because the app never installed it.

**This is emphatically not what was asked for, and the file should say so
first.** They asked to deploy a stack from the web interface. This never
installs anything and refuses runs when somebody else's install did not happen.
Its answer to *"deploy from the web interface"* is **no**, and its answer to
*"available to all runs"* is that the app will now tell you, loudly, when it is
not.

## 8. How it fails, and whether loudly

**This option is nothing but a loudness mechanism, so it has to be judged
harder here than anywhere else, not softer.**

Loud:

- A run that requires a missing tool is refused by name before it spawns. That
  is the 213-session failure (`.env.example:222-226`) converted from a silent
  no-op into a refusal with a tool name in it, and it is the strongest
  contradiction of that failure available anywhere in this directory.
- The refusal is a `RefusalCause` and therefore lands in the run's own events,
  which persist before they publish (`CLAUDE.md`) — so it survives a reconnect
  and is on the page.

Silent, and the list is short but two entries on it are serious:

- **A wrong executable-name mapping refuses a run whose tool is present.** A
  false refusal is a run that does not start for no reason, and an operator who
  cannot see why will delete the requirement rather than debug it. **This is the
  option's worst failure and it is worse than it sounds**, because the mitigation
  — make the mapping configurable — is the thing that turns a checked
  precondition back into a hand-typed string.
- **State 3 (`14-` §5).** `present` is checked; `invokable` is not. A run passes
  the check, starts, and meets the `acceptEdits` wall anyway. **The feature's
  promise is stronger than what it verifies**, and a requirement check that
  passes is a stronger assertion than a page reading `present` — so this option
  carries `14-` §5's honest-rendering problem in its sharpest form.
- **A template with no requirements is silent by construction**, which is
  correct and means the feature only helps operators who use it.
- **The second-server case**: a server that does not own the data directory
  (`instrumentation.ts:165-180`) reads the same templates and does the same
  `stat` against its own filesystem — which is the same container, so this is
  fine today and would not be if the app were ever run as two containers.

## 9. What it costs to build

**Two to three days**, and it shares `15-`'s module, so building both is not
double.

Files: `src/lib/toolInventory.ts` with unit tests (the name→executable mapping
and the state resolution — two pure functions whose failure is silent, and the
first of them is where the false-refusal risk in §8 lives, which is exactly what
earns it a test rather than a convention), one `addColumn` in `migrate()`, one
check in the run loop, one `RefusalCause`, one template-form field.

**Which of those earns a test, precisely**: the mapping and the state
resolution. Not the run-loop check: this repository does test a route when the
defect is one only a payload can show (`src/app/api/health/route.test.ts`), and
a `stat` before a spawn is not that shape. Two functions, not a suite (`docs/agent/testing.md`).

**No `docs/agent/` invariant moves.** `docs/agent/run-lifecycle.md` gains a
sentence naming a new `RefusalCause`; `docs/agent/agents-and-templates.md` gains
a line saying a template may carry a requirement and may not carry an installer,
which is `14-` §7's rule written down where the rule lives.

## 10. What would have to be true

**Promotes it:** that runs are actually failing against missing tools today.
Nobody knows — `/data` is unreadable from this container so there is no usage
history in this proposal at all (`01-constraints.md` §5) — but the 213-session
figure is evidence that *this exact class of failure has already happened on a
real install and went unnoticed for a long time*
(`.env.example:222-226`). If a human can grep a real `/data` for runs whose logs
contain `command not found` and find any, this option is the highest-value thing
in the directory and everything else is second.

**Kills it:** the false-refusal risk in §8 being unmanageable. A precondition
check that is wrong in the refusing direction is worse than no check, because it
stops work that would have succeeded — and this app's own rule for a guard that
cannot read its input is to **hold** rather than refuse (`no_ceiling` is held
and returned only once every readable guard has passed,
`docs/agent/budgets-and-guards.md`). **If the mapping cannot be made reliable,
the correct version of this option is not a refusal but a warning on the run**,
which is `15-` with a per-template field — a smaller feature, and one this file
would then be arguing for instead of its own.
