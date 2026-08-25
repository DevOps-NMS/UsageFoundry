# Option E — build nothing new

Ship no volume, no variable, no route, no pane. Write down what already works,
fix the two places the existing documentation is wrong, and hand the operator
`UF_PY_TOOLS`, `UF_GH_EXTENSIONS` and a `docker-compose.override.yml`.

Every option file in this directory must have a null hypothesis to beat. This is
it, and it is stronger than it sounds.

## 1. The strongest case

Two thirds of what the operator asked for already ships, has done for some time,
is unit-tested, and is documented across 110 lines of `.env.example` that they
have almost certainly never read — because nothing in the app mentions it and
nothing in the UI leads there. `UF_PY_TOOLS` puts a command on every agent's
`PATH`, surviving `up --build`, reinstalled after `down -v`, reinstalled on a
fresh host, installed as the uid that runs it. That is a *better* mechanism than
a terminal, on every axis except discoverability — and discoverability is a
documentation problem, not an architecture problem. Meanwhile the *hard* half of
the request has nothing to do with persistence at all: it is that a work cycle
under `acceptEdits` may not be permitted to invoke an arbitrary binary
(`00-problem.md` §"Missing 3"), and **not one of Options A through D touches
it.** Building a fourth volume to solve a problem three volumes already solve,
while leaving the actual blocker in place, is the most expensive way available to
change nothing.

## 2. Shape

Four documentation changes and zero code:

1. **A section in `docs/install.md`** — "Tools your agents can use", naming what
   is in the image (`Dockerfile:127-132`, `:162-177`, `:194-208`, `:249-265`,
   `:348-349`, `:439-451`), what `UF_PY_TOOLS` and `UF_GH_EXTENSIONS` add, and
   the `docker-compose.override.yml` route for anything else
   (`.env.example:263-273`, `05-option-image-is-the-stack.md` §2).
2. **A correction to `src/lib/orchestrator.ts:5983-5984`.** Its docblock says the
   two `BUILD_CACHE_DIRS` are pointed *"at a named volume so it survives a
   container it is meant to outlive"*. That is true of `$GOPATH` and **false of
   `$HOME/.npm`**, which is on no volume (`docker-compose.yml:330-423`) and is
   discarded by every `up --build`. Two words in a comment, and it is a comment
   somebody will otherwise reason from.
3. **A correction to `CLAUDE.md`** — "four kinds of agent child process, from
   four modules" is three modules (`orchestrator.ts`, `chat.ts`, `review.ts`);
   `chat.ts` has one `spawn(` serving two kinds. And to
   `src/lib/privsep.ts:238-240`, whose *"both of `chat.ts`'s"* is one, and whose
   *"Every spawn site in the app takes this"* is contradicted 300 lines away by
   `contextPruning.ts:626-627` — *"the one spawn in this app that deliberately
   does not drop to the agent uid"*.
4. **A `docs/verification.md` entry recording that the three tool volumes have
   never been observed surviving a rebuild** — `grep -n
   "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|gocache" docs/verification.md` returns one
   line, `:1371`, about a guard. The "Not yet verified by hand" list is required
   to stay honest (`CLAUDE.md`), and this belongs on it.

None of the four is a feature. All four are things a future editor would
otherwise get wrong.

## 3. What persists it, and what discards it

Whatever `UF_PY_TOOLS` and `UF_GH_EXTENSIONS` persist today, which is the table
in `02-` §3 minus the binary-release case: survives `restart`, survives
`up --build`, reinstalled after `down -v` from the `.env` line, reinstalled on a
fresh host. `scripts/backup-db.mjs` covers none of it and does not need to,
because the declaration is in the operator's checkout.

**What it does not persist is the thing the operator asked about.** Terraform is
not a Python distribution and not a `gh` extension, so `UF_PY_TOOLS` will not
install it and this option's honest answer for Terraform is
`docker-compose.override.yml` — that is, Option D's minimal form, which this
option includes by reference rather than pretending to cover.

**Not verified.** Nothing here observed a rebuild; item 4 in §2 exists precisely
because nobody has.

## 4. Reach

Unchanged from today. All five kinds of child inherit the image's `PATH`
(`Dockerfile:281`, `:223`) through five strip loops that leave `PATH` alone
(`orchestrator.ts:6306`, `chat.ts:2251`, `review.ts:760`, `claudeAuth.ts:258`,
`git.ts:51`; pinned at `git.test.ts:93`).

**And unchanged means the `acceptEdits` wall is still there.** This option does
not fix it either — but unlike A through D it does not spend a week of work
before arriving at it. That is the whole argument: if the blocker survives every
option, build the cheapest thing and go and measure the blocker.

## 5. Tool state, not the binary

Documented rather than fixed. The section in §2 item 1 tells an operator that
`$HOME` outside four subdirectories is discarded on rebuild
(`01-constraints.md` §8), and that the remedy is a `docker-compose.override.yml`
setting the tool's own state variable — which `.env.example:263-273` already
prescribes and confirms reaches the agents.

`$HOME/.npm` remains discarded on every rebuild. That is a real, current,
unfixed cost — every agent working on a Node repository re-fetches its
dependencies after each upgrade, which is the exact failure the Go cache volume
exists to prevent (`docker-compose.yml:370-376`). **This option records it and
does not fix it**, and a reader deciding between options should weigh that: a
fifth volume for `$HOME/.npm` is a two-line change with a measurable payoff and
is arguably owed regardless of which option wins.

## 6. What it does to the boundaries

Nothing. No new writable directory, no new `PATH` entry, no new route, no new
table, no new agent-reachable surface. Every boundary in `01-constraints.md` §4
through §8 stands exactly where it stands today.

That is not a rhetorical point. Options B and C each add an agent-writable
executable directory to the **root** server's `PATH`, reopening the hazard
`contextPruning.ts:76-83` documents; Option C adds an HTTP route that must be
kept off the MCP surface by name or a model can install software on the host.
This option adds neither, and its risk is therefore not "small" but zero.

## 7. The operator's surface

`.env`, `docker-compose.override.yml`, and a restart — plus, for the first time,
documentation in `docs/` that says so where an operator will find it rather than
in a comment block in `.env.example`.

The read-back gap is untouched: the boot log remains the only way to learn
whether an install worked (`docker-entrypoint.sh:297`, `:306-307`). **This
option's answer to `00-problem.md` §"Missing 4" is "nothing", and it should be
scored as a loss, not defended.**

## 8. How it fails, and whether loudly

It fails by being ignored. An operator who wanted a button gets a paragraph, and
if the paragraph does not reach them the state of the world is what it is
today — including the failure that has a number on it: **213 sessions told a
plugin was active against a command that was never present**
(`.env.example:222-226`). Documentation is what would have prevented that and
documentation is what did not.

The specific silent failures it leaves standing:

- A `gh` extension or Python tool that fails to install is a stderr line, best
  effort, never fatal (`docker-entrypoint.sh:165-168`, `:305-308`).
- A hook body ending in `|| true` turns a missing command into a hook that exits
  0 having done nothing (`docker-compose.yml:405-408`).
- A missing binary in a `Bash` call is a tool call the run loop does not read,
  which it files as the agent choosing not to use it
  (`docker-compose.yml:386-391`).

All three are pre-existing and all three stay.

## 9. What it costs to build

**Four documentation edits. One day, including the two corrections in §2 items 2
and 3, which are the kind that go stale if not made now.**

No `src/` change, no schema, no route, no test, no invariant moved. It is the
only option in the directory that could ship this week.

## 10. What would have to be true

**Promotes it:** that a work cycle at `acceptEdits` cannot invoke an arbitrary
binary. If that is confirmed, every other option in this directory delivers a
tool the agents cannot use, and building any of them before fixing the
permission is money spent on a tool nobody can call. Then this option plus `07-`
is the whole correct answer and A-D are premature. **The probe costs one work
cycle** (`07-` §10) and it is the highest-value thing anyone could do to this
survey.

**Kills it:** the operator's real requirement being *interactive* — try a tool,
see whether it helps, keep it or drop it, without editing files or restarting a
container. Nothing about `.env` plus a restart serves that, no amount of
documentation makes it serve that, and if that is the requirement then this
option is a refusal to answer.
