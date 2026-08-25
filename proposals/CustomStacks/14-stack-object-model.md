# The stack itself — object model, deploy, lifecycle

**This is question 3 of the three in `00-problem.md` §"The three-way split".** It is
the analogue of `00-problem.md` and `08-terminal-problem.md` for the object half,
and like them it **does not answer the ten headings** — the option files `15-` to
`19-` do. The comparison table in `20-` skips this file and reads those.

Questions 1 and 2 asked where a tool lives and how a human reaches a shell.
Neither asks what a *stack* is as a thing the app stores, shows, redeploys and
reasons about. That is this file.

Everything below was checked against the tree at `7c2c295`. Four claims were
measured by reading `docker-entrypoint.sh` in this container and say so;
everything that could not be reached is in §9.

## 1. The object model is already answered twice, and the answer is "no object"

`UF_PY_TOOLS=cozempic==1.8.39 ruff==0.6.9` is **a declarative manifest of packages
per ecosystem** — the third of the four shapes the question offers — for two
ecosystems. It already carries five of the six properties a stack needs:

| Property | In `UF_PY_TOOLS` today |
|---|---|
| a name per entry | yes |
| a version per entry | yes, `==1.8.39` |
| an ecosystem | yes, implied by *which variable* |
| an order | yes, the order of the string |
| idempotence | yes — an already-installed entry is skipped deliberately |
| **identity** | **no** |

There is no stack you can name, point at, or have two of. `UF_PY_TOOLS` is one
list per install and the install is the only scope there is.

**So "what is a stack" is not really the question. The question is whether the
thing needs identity, and what buys it.** Identity costs a table, a page, a
lifecycle, a removal path and an attachment rule. It is earned only if something
in the app *selects between* two of them — and §7 is the finding that nothing
does, and that the three places it could are each closed by name.

**The answer to the framing question, stated plainly: a stack is a
generalisation of `UF_GH_EXTENSIONS` and `UF_PY_TOOLS`, not a different thing
beside them** — on one condition. What makes those two work is not the volume, it
is that **the declaration is durable and the installation is a cache**
(`.env.example:212-213`, `:296-297`; `02-` §3). Every shape that stores the
installation rather than the declaration loses `down -v` and a fresh host, which
is `03-` §3's central weakness and is not recoverable by adding a page in front
of it.

The one way a stack would be a *different* thing beside them is if it carried
**scope** — per-folder, per-template, per-run. The two lists are install-wide by
construction. Scope is a new axis rather than a generalisation, and §7 is why
this survey refuses it.

## 2. Five shapes a stack could take, and which two already exist

| Shape | In the tree? | Expresses | Cannot express |
|---|---|---|---|
| **An ordered list of shell steps** | no | anything | anything the app can reason about — and it needs a shell, which `CLAUDE.md:134` forbids composing (`08-` §4) |
| **A Dockerfile fragment** | yes — `05-` | anything, reproducibly, root-owned | interactivity; and it is not a stored object at all, it is a file in the operator's checkout |
| **A declarative manifest of packages per ecosystem** | **yes, twice** | whatever each ecosystem's installer takes | anything with no ecosystem — which is exactly Terraform (`00-` §"Missing 1") |
| **A set of requirements** — name plus a version predicate, with no installer behind it | no | "this must be present, and here is how to tell" | installing it |
| **A name plus a pointer to one of the above** | no | identity | nothing on its own — it is a wrapper, and §7 is whether the wrapper is earned |

Row 3 is the shape the repository already chose, twice, and rows 1 and 2 are the
two ends questions 1 and 2 already surveyed. **Row 4 is the one nothing in this
directory has proposed and it is the one §5 argues is worth the most**, because
the expensive failure in this whole survey is not a tool that fails to install —
it is a tool that is absent and nobody finds out.

## 3. Where it is stored — and one of the four candidates is strictly dominated

| Store | `up --build` | `down -v` | In `scripts/backup-db.mjs`? | Who may write it | May a model write it? |
|---|---|---|---|---|---|
| **`.env` / a `UF_*` variable** | survives | **survives** — it is a file in the operator's checkout | n/a, and does not need to be | the operator, on the host | **no** — no route in this app touches `.env` |
| **A SQLite table** | survives | **destroyed** — `usagefoundry-data` is a named volume | **yes** | the server, and anything holding the cookie | **only if a route reaches the MCP surface** — `04-` §6 |
| **A file under `DATA_DIR`** | survives | **destroyed** | **no** — the backup writes one `VACUUM INTO` of the database and nothing else (`docs/backup-and-restore.md:14-31`) | the server, root 0700 | as above |
| **A committed manifest in a mounted repo** | survives | **survives** | n/a — it is in git | the operator **and every agent** | **yes, trivially** |

Two findings, and both are decisive rather than decorative.

**Row 3 is strictly dominated by row 2.** A file under `DATA_DIR` has every
property of the table and one fewer: the backup covers the table and does not
cover the file. There is no reason to choose it, and this survey does not give it
an option file.

**Row 4 is the most durable store available and it is the one an agent can
edit.** A `.usagefoundry/stack.toml` in a mounted repository survives all four
events in `01-constraints.md` §1, travels with the repository, is reviewable in a
diff and needs no schema — and an agent writes files in that mount as its whole
job. `docs/agent/chat.md`'s rule is that **prompt text is the one half of a run a
model may write**; a stack manifest inside the mount is a second half arriving
through the back door, and it arrives with the merge queue's own blessing. `18-`
is the option that argues this is fine and says exactly what has to be true for
it.

## 4. When it is applied — and the boot path is already unbounded

Three candidates. The first is what ships, and reading it turned up two things
that are not written down anywhere.

**At boot, in the entrypoint.** What both existing loops do (`docker-entrypoint.sh:169`
for `UF_GH_EXTENSIONS`, `:241` for `UF_PY_TOOLS`). Three properties, measured by
reading the file in this container on 2026-08-25:

- **They sit ahead of the server.** `exec "$@"` is `docker-entrypoint.sh:972`,
  the last line of a 972-line file; both loops are hundreds of lines above it. A
  slow install is a container that is not yet serving, and nothing distinguishes
  that from a hang.
- **Neither loop has a timeout.** `grep -n "timeout\|--max-time\|--connect-timeout"`
  over the whole entrypoint returns one line, `:951`, and it is a one-second
  socket probe for winnow's port — not on either install path. A registry that
  hangs holds the boot open indefinitely.
- **The failure sink is stderr and nothing in `src/` reads it.** The success line
  and the `could not install` line beside it are the whole read-back
  (`00-` §"Missing 4").

None of that is an argument against the boot path. It is an argument that **the
boot path's cost is unbounded and unattributed today, and it is tolerable only
because the two lists are short.** A stack of twenty tools is the same code with
a different constant, and it is the constant that was never chosen.

**On demand, from the UI.** Needs a job with a status and a log, which is `04-`
§2's *"design's one hard question"* and is unresolved for a reason: the only
thing in this app that takes minutes, can fail, and has a log and a status is a
`runs` row, and bending `runs` to hold an install distorts a table that
retention's three sweeps, the dependency graph and the loop block all read.

**Lazily, before a run spawns.** Half of this is refused by name and half of it is
free, and the two halves are usually confused:

> **Admission may not `await`. The spawn may.**

`createRun` runs from entry to INSERT with **no `await`**, and anything that
probes for a tool during admission puts two agents in one directory
(`docs/agent/concurrency-and-ownership.md`). So *choosing* a stack at admission
is refused. But the run loop is full of awaits, and a `stat` of one path
immediately before the spawn costs microseconds and breaks nothing. **Verifying a
stack before the spawn is legal; selecting one during admission is not**, and
every option below that touches a run takes the first and not the second.

## 5. Loudness — the strongest argument in this survey, and it has three tiers

`docker-compose.yml:385-409` records the two existing failures precisely and both
are silent: `gh` gives an agent `unknown command` inside a tool call nothing
reads, which the run loop files as the agent choosing not to use it
(`:386-391`); and a missing `uv` tool is a hook that exits 0 having done nothing,
on every session start (`:405-408`), which has a number on it — **213 sessions on
one install told a plugin was active against a command that was never present**
(`.env.example:222-226`).

**A stacks feature that adds a third silent failure is worse than no feature.**
That sentence is the strongest thing available to any option here and it is also
the easiest to fail while believing you have passed it, because the obvious
read-back — a page that says `installed` — is the third silent failure wearing a
badge.

### The three states, and only two of them are cheap

| State | What it asserts | What can check it | Cost |
|---|---|---|---|
| `declared` | a row or a line says this tool should be here | reading the declaration | free |
| `present` | the named executable is on `PATH` and is `+x` | one `stat` — `11-` §8's four-line post-install probe | microseconds |
| `invokable` | a work cycle at `acceptEdits` is permitted to run it | **one work cycle** | billed tokens (`07-` §10) |

`uv tool install` on a name that resolves to an empty distribution **exits 0**
(`11-` §8). So an install command's exit code proves `declared`, not `present`.
And nothing anywhere proves `invokable` without spending money.

**Every option in this directory that puts `installed` on a page asserts state 2
and implies state 3.** The honest rendering is the one the metering rules already
require of every meter in this app: *unknown renders as a hatched indeterminate
meter, never a 0% bar* (`docs/agent/metering.md`). Applied here that is one word:
a tool whose invocation has never been observed reads **`unverified`**, never
`installed`. It is the difference between the read-back being true and being the
fourth silent failure.

### What a loud failure actually looks like, and all three surfaces exist

1. **A warning where the operator already looks.** A variable read through
   `env()` that compose renders as `${VAR:-}` becomes a permanent dashboard
   warning on every stock install (`docs/agent/environment.md:17`) — the tree
   treats that as a *hazard* to be avoided, which means the surface is known to
   work. A stack that declared four tools and found three belongs on it.
2. **A refusal at the door.** This app refuses by name rather than degrading:
   a deleted agent is *"refused by name at every door, never dropped to none"*
   (`docs/agent/agents-and-templates.md`), and `no_ceiling` is refused at the
   door and never acted on afterwards (`docs/agent/budgets-and-guards.md`). A run
   whose template names a stack that is not present can be refused the same way,
   before a token is spent.
3. **A terminal status that is not a success.** `needs-review` is terminal and is
   **not** a success — `on-success` stays blocked and `on-finish` starts
   (`docs/agent/dependencies.md`). A run that finished having never been able to
   invoke the tool it was given is that shape exactly, and the rung already
   exists.

Tier 2 is the one worth the most and costs the least. **A run that cannot use its
tool should not start.** It is a synchronous check against a declaration the app
already holds, it spends nothing, and it converts the most expensive silent
failure in this survey into a refusal with a name on it.

## 6. Drift, and why reconciliation here can only be additive

Four ways the declaration and the container diverge. Only one of them is a case
reconciliation actually fixes.

- **After a rebuild.** The volume survives, the declaration survives, nothing
  drifts — *unless* the image's own copy of the tool moved, in which case
  `01-constraints.md` §2's volume-masking trap arrives as a version conflict
  rather than as a missing file: the image's install is masked by whatever the
  existing volume holds, on every install that has run before and on none of the
  fresh ones a developer tests with.
- **After a hand install.** Somebody `docker compose exec`s and installs
  something the declaration does not name. This is the case that decides the
  whole policy, and it has two possible answers: **authoritative** (remove what
  is not declared) or **additive** (install what is missing, leave the rest).
  Authoritative is what "declarative" usually means and it is **wrong here**,
  because the image itself ships tools nobody declared and an authoritative sweep
  over `/home/node/pytools/bin` would remove `uv`'s own.
- **After an image upgrade brings a newer version.** The shipped policy is
  already *"never upgrade in place"*: both loops skip an already-installed entry
  deliberately, because *"a restart is not a good moment to silently swap out an
  executable that holds a token"* (`.env.example:204-207`, repeated at
  `:288-290`). **A stack that upgrades on drift contradicts a decision this
  repository made in writing, twice.**
- **After a `down -v`.** The volume is empty and the declaration is intact. This
  is the one drift reconciliation handles perfectly, and it is the entire reason
  the declaration must not live inside the volume.

**So reconciliation here is additive and never-upgrading, or it breaks a rule the
tree already states.** Which means "reapply" means "install what is missing" —
there is no drift *correction* available, only drift *detection*. That is not a
loss. Detection is the half that makes §5's failure loud, and it is the cheap
half.

## 7. Where a stack may attach — and the three doors are each closed by name

A stack is a **capability**. It is not a role, not a guard and not a budget. This
app has an explicit position on where capabilities attach, and it is stated three
times in three places:

- **Not on an agent.** *"An agent carries a role, never a capability: no `tools`,
  no permission mode, no folder. A `tools` field is refused by name at save"*
  (`docs/agent/agents-and-templates.md`).
- **Not on a workflow node.** *"A node holds no permission mode, no budget and no
  model — guards come from its template"*
  (`docs/agent/workflows-and-schedules.md`).
- **Not chosen at admission.** `createRun` entry-to-INSERT with no `await`
  (§4 above).

That leaves **the template**, which is where guards already live, and **the
install**, which is where the container already is. And the container is the
thing that decides: **there is one `PATH`, one filesystem and one set of volumes
per container, so an installation cannot be per-folder however the record is
scoped.** A per-template *stack* would be a record that reads as a guarantee and
is not one.

**The resolution this survey takes: the installation is install-wide, always. A
per-template field, if one is ever added, may name what a run *requires* — never
what it installs.** Requirements are per-template legitimately, because a
requirement is a precondition and preconditions are exactly what a template's
guards already are.

### The frozen-copy question, which has a different answer here than for agents

`runs.agent` is a frozen copy and `run_templates.agent_id` is a reference
(`docs/agent/agents-and-templates.md`). The reason freezing is right for an agent
is that the agent's text *is* what the run was given, so the frozen copy makes
the run legible after the agent changes.

**A frozen stack declaration would not have that property.** It would record
"this run declared `terraform@1.9.8`" and would not record what was on `PATH`,
because the container is shared and the tool is install-wide whatever the row
says. It would read as a guarantee and be a wish.

So: **if a run records a stack at all, it records what was observed present at
spawn, not what was declared.** That is evidence, in `retention.ts`'s sense —
*"nothing deletes a `runs` row; what expires is the evidence behind it"*
(`docs/agent/retention.md`) — and it belongs on an evidence horizon rather than
in a frozen column.

### What it does to the guards

Nothing, on the spend side. A stack has no cost ceiling, contributes to no
window, and must never put a figure on a card that reads as spend — the three
cost sources are never summed or mixed (`docs/agent/architecture.md`).

One place it touches a guard, and it is `07-`'s: `stackTools` on
`--allowedTools`. **`07-` §10 explicitly hands run 3 the question of whether that
grant is per-run or install-wide, and this survey settles it: install-wide, in
the shape of `resolveVerifyTools`.** The reasons are that the grant is about what
the *container* holds, that `resolveVerifyTools` ships empty for the same reason
and has not needed scoping, and that `saveSettings` stores only what differs from
`DEFAULTS`, so an install that never sets it is byte-identical to today. The
per-template version is a legal later addition — a template already carries
guards — and it should wait for an operator who asks for it rather than being
built against `07-` §10's hypothetical fourth repository.

## 8. Cost and time — and the asymmetry is the whole argument

Neither of the two costs here is metered anywhere.

**Boot wall-clock.** Every declared tool is installed on every container start
that finds it missing, on an unbounded, untimed path ahead of `exec` (§4).
Nothing in this app displays a boot duration, and `docs/agent/metering.md`'s
three cost sources are all about model spend — there is no place a wall-clock
figure could go that would not read as one of them.

**Billed tokens against a missing tool.** An agent that meets `unknown command`
in a `Bash` call burns the rest of that work cycle, and the run loop files it as
the agent choosing not to use the tool (`docker-compose.yml:386-391`). Nothing
meters that either. The nearest number anyone has is 213 sessions
(`.env.example:222-226`) and it carries no dollar figure, because the thing it
counts was never priced.

**The asymmetry decides where the effort goes.** A boot-time install costs
seconds of wall-clock, once per restart, paid by an operator who is watching a
terminal. A missing tool costs billed tokens on every cycle of every run that
needed it, paid silently, discovered by nobody. **The cheap failure is the one
the operator sees and the expensive one is the one nobody does.** Every hour
spent on the installer buys less than an hour spent on the read-back, and that
ordering is the single most useful thing this file has to say to whoever
implements any of it.

## 9. What could not be reached

- **Any container start.** Docker is unavailable here (`00-` §"What could not be
  reached"), so no boot was timed, no install was run and no volume was created.
  §4's three properties are read out of `docker-entrypoint.sh` rather than
  observed running.
- **Whether anybody wants two stacks.** §1 makes identity conditional on
  something selecting between stacks, and §7 finds nothing that does — but
  nobody in this survey has asked the operator whether they have one toolchain or
  four. `09-` §10, `10-` §10 and `11-` §10 each name the same unasked question
  from their own direction, and it is still unasked.
- **Any usage history.** `/data` is unreadable from this container
  (`01-constraints.md` §5), so there is no figure anywhere in this proposal for
  how many runs would have used a stack tool, how often an operator installs one,
  or how long a boot currently takes.
- **The `acceptEdits` probe**, inherited from `00-` §"Missing 3" and unchanged:
  state 3 in §5's table has never been observed for any binary. One work cycle
  settles it and the recipe is `07-` §10.
