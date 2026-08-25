# Persistent custom stacks

**Closed.** Three questions surveyed across three runs — where a tool persists,
what surface installs it, and what a "stack" is as a stored object — fifteen
options, one comparison, one recommendation, and a validation pass that resolved
every citation in the directory and fixed 39.

**The question:** an operator wants to install a tool — Terraform is their
example — from the web interface, have it reach every run, and have it survive
`docker compose up --build`.

> Persistent custom stacks that the user can deploy from the web interface. My
> imagination of it is that there is a point on the left menu called Terminal
> where users can run terminal commands on the container's CLI. The things
> installed by that CLI — let's take Terraform for an example — should then be
> available to all runs and sandboxed runs, and survive a rebuild of the
> container.

## The recommendation

**Spend one work cycle measuring whether a work cycle can invoke an arbitrary
binary, then build the read-back and the documentation — a Settings card that
reports what is installed, and two sections in `docs/install.md` naming the three
routes that already work.** Do not build the Terminal pane, the stacks table or
the repository manifest: persistence is already solved twice for two ecosystems
and a `Dockerfile.stack` covers the rest, a shell on the container is shipped and
documented twenty times, and what is genuinely missing is that **nothing in this
app can see what is installed** — so a tool that is absent fails inside a tool
call the run loop does not read, silently, 213 sessions at a time.

Six to nine days, against `16-`'s and `18-`'s week to two weeks and `09-`'s
open-ended estimate. Full case in [20-recommendation.md](20-recommendation.md);
phases in [21-implementation-sketch.md](21-implementation-sketch.md).

## What would overturn it

**The operator not having host access to the container.** Every argument for
`docker compose exec` collapses at once, and `10-`'s one-shot exec route becomes
the cheapest door. One sentence settles it and nobody has asked.

Three more, in `20-` "What would overturn this": the five commands they actually
expect to type not being four `uv tool install`s; the probe finding that reach is
*not* broken (which shortens the recommendation rather than reversing it); and
their having four toolchains rather than one, which is the only shape `18-`
expresses and no other option does.

## The four findings that reframe the request

**Persistence is largely solved and nobody knows it.** Three named volumes exist
for this exact problem and the compose file argues each one out
(`docker-compose.yml:370-409`). Two have a declarative boot-time install loop
behind them (`docker-entrypoint.sh:169-211`, `:241-310`), so `UF_PY_TOOLS=ruff`
in `.env` already puts a command on every agent's `PATH`, surviving every rebuild
and reinstalled after `docker compose down -v` — **better** than a terminal,
because the declaration outlives the volume. What it does not cover is a
release-tarball binary, which is what most "stack" tools are — and a
`Dockerfile.stack` covers that for half a day of documentation.

**Reach is not solved, and it is not about `PATH`.** `PATH` passes through all
five kinds of agent child untouched (`orchestrator.ts:6244-6246`, pinned at
`git.test.ts:93`). What may stop a tool being used is the shipped permission
mode: a work cycle runs `acceptEdits` (`settings.ts:730`), which this tree has
twice measured as refusing commands outright — seven refusals in one run over
`git commit` (`orchestrator.ts:5082-5089`), and **19 of 58 conflict resolutions,
$109.94 of $233.85, unable to run a single command against the merge they had
written** (`settings.ts:290-296`). Whether that also refuses an arbitrary
installed binary is **the single unmeasured fact this survey turns on**, and the
probe costs one work cycle (`07-` §10).

**There is no room on the left menu, and the operator's own word for the feature
is the one thing that is refused.** `panes.ts:12-16` closes the list at nine
because ⌘1…⌘9 has nine digits and four modules read that file;
`ui-density-audit.md:159` puts *"a tenth pane"* on the may-never-be-used list and
`:160-161` gives the alternative — *"New destinations are sub-routes under an
existing pane."* The real cost of a browser terminal is neither the native module
nor the security model but the **transport**: nothing in this repo has ever
opened an HTTP upgrade, and there is no custom server to attach one to.

**The object model is already answered twice, and the answer is "no object".**
`UF_PY_TOOLS` is a declarative per-ecosystem manifest carrying five of the six
properties a stack needs; the missing one is **identity**, and nothing in this
app selects between two stacks. Identity costs a table, a page, a lifecycle and
an attachment rule — and `14-` §7 finds all three doors it could attach to closed
by name. The asymmetry that decides where effort goes: **an install that fails
costs a boot log line an operator is watching; a tool that is absent costs billed
tokens on every cycle of every run that needed it, discovered by nobody.**

## Files

| File | What it argues |
|---|---|
| [00-problem.md](00-problem.md) | the three-way split, the prior art, the four gaps, and the six things "sandboxed run" turns out to mean |
| [01-constraints.md](01-constraints.md) | what any option must survive — and **the fixed ten-heading list** every option file here answers |
| [02-…widen-the-existing-lists](02-option-widen-the-existing-lists.md) | **Option A** — a third `UF_*` list for release binaries, in the shape of the two that work |
| [03-…persistent-opt-volume](03-option-persistent-opt-volume.md) | **Option B** — one general-purpose writable volume on `PATH`; cheapest, and lost to `down -v` |
| [04-…declared-manifest](04-option-declared-manifest.md) | **Option C** — a manifest in the database, reapplied at boot; the reconcile host left open |
| [05-…image-is-the-stack](05-option-image-is-the-stack.md) | **Option D** — build args and a layer; survives all four events, and is furthest from what was asked |
| [06-…build-nothing](06-option-build-nothing.md) | **Option E** — build nothing new; document what ships, fix what is wrong in the tree |
| [07-…make-it-runnable](07-option-make-it-runnable.md) | **Option F** — fix the *reach* instead: a `stackTools` allowlist. Orthogonal; pairs with any of A-E |
| [08-terminal-problem.md](08-terminal-problem.md) | the surface question: the four real deltas, the uid trap, **"never a shell" reconciled**, and the transport survey |
| [09-…full-pty](09-option-full-pty.md) | **Option G** — `node-pty` and xterm.js; answers the request exactly, and its estimate has a hole nobody here can close |
| [10-…one-shot-exec](10-option-one-shot-exec.md) | **Option H** — one command, one exit code, no PTY. No transport risk; cannot express a pipeline |
| [11-…allowlisted-installer](11-option-allowlisted-installer.md) | **Option I** — four typed verbs, no command line. **The runner-up**, and the only option that never argues with `CLAUDE.md:134` |
| [12-…manifest-transcript](12-option-manifest-transcript.md) | **Option J** — the pane as a *view* onto `04-`'s manifest. Looks like a terminal, has no input |
| [13-…build-no-terminal](13-option-build-no-terminal.md) | **Option K** — **build no terminal.** `docker compose exec` is shipped and strictly more capable than three of the four above |
| [14-stack-object-model.md](14-stack-object-model.md) | the object question: identity, the four stores, when a stack is applied, **the three states**, additive-only drift, and where a capability may attach |
| [15-…no-stack-object](15-option-no-stack-object.md) | **Option L** — no stack object; build the read-back instead. **Highest-scoring, and the recommendation's core** |
| [16-…stack-table](16-option-stack-table.md) | **Option M** — a `stacks` table with identity, a page and a boot reconciler. Answers `04-`'s hard question, and is rejected anyway |
| [17-…requirements-not-installs](17-option-requirements-not-installs.md) | **Option N** — a stack is a *precondition*; refuse the run, install nothing. Second-highest, and deferred on one risk |
| [18-…repo-manifest](18-option-repo-manifest.md) | **Option O** — a committed manifest in the mounted repository. Strongest persistence, widest boundary |
| [19-comparison.md](19-comparison.md) | **the weights stated before the scores**, four collapses, twelve scored rows, and what no reweighting changes |
| [20-recommendation.md](20-recommendation.md) | the case, what overturns it, the runner-up, **what is rejected by name**, and what a person must accept to overrule it |
| [21-implementation-sketch.md](21-implementation-sketch.md) | five phases, the invariant each must not break, what the operator sees, and **the three functions that earn a test** |
| [22-validation.md](22-validation.md) | every citation resolved; the 39 that were wrong, fixed in place; what this container cannot check, and the commands that would |

## Corrections

`22-validation.md` resolved roughly 390 citations across `00-` to `13-` and found
**39 wrong**. All are fixed in place. Six changed an argument rather than a
reference; five of those made the recommendation easier and one made it harder.

| | What was wrong | Direction |
|---|---|---|
| `02-` | the closed table's precedent does not exist — every pinned download verifies the **publisher's** digest, never one this repository chose | easier |
| `05-` | the minimal form needs no manual tagging: `docker-compose.yml:37` already tags the build `usagefoundry:latest` | **easier, and it moved a score** |
| `06-` | one of its three "wrong claims in the tree" is a misreading — `orchestrator.ts:5983-5984`'s clause is Go's and the comment is right | easier |
| `09-`/`10-`/`11-` | `terminalEnv()`'s strip list is **six**, not five; the missing name is `NODE_OPTIONS`, which is code execution into any Node child a terminal starts | easier |
| `08-`/`13-` | a quotation attributed to `.env.example` that **does not exist there**, under a load-bearing argument for rejecting the terminal | **harder** |
| `13-` | the `docker compose exec` counts: twenty, not twenty-one; the tree figure is over a hundred, not 55 | easier on net |

The other 33: sixteen wrong line numbers, three quotes attributed to the wrong
file, five wrong counts, two right claims with the wrong citation, one citation
covering 40% of what it was cited for, **one command that returns zero matches**,
one incomplete seccomp table, one example that demonstrated the failure it
existed to avoid, one correction that was itself wrong, and one stale provenance
line. None was unresolvable — every cited file, symbol, line range and test name
exists.

## What could not be reached

**This container has no Docker.** No rebuild, no volume creation, no volume
destruction, no image build, no seccomp application. Every persistence claim in
the directory is reasoned from the compose file's own statements and says so at
the point it is made; `22-validation.md` §5 has the exact commands a human should
run, in the order they buy the most.

Also unreached: **the `acceptEdits` probe** — the single most decisive unknown,
and eleven of `19-`'s twelve rows score 0-3 on it; **any real stack tool**;
**`/data`, and therefore all run history**, so there is no figure anywhere for how
many runs would have used a stack tool or how long a boot takes; and **`09-`'s
four transport probes** (`08-` §9).

And two questions that are not about the tree at all, cost a sentence each, and
settle more than any command: **does the operator have host access to the
container**, and **what are the five commands they expect to type?** `09-` §10,
`10-` §10, `11-` §10 and `13-` §10 each name one of them from their own
direction. **None of the three runs that wrote this directory asked either.**

One gap in the repository's own record rather than in this survey:
`grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|gocache" docs/verification.md` returns
one line, and it is about a guard. **The three tool volumes have never been
observed surviving a rebuild** — they are pinned by a unit test over file contents
(`deployment.test.ts:664`, `:733`) and nothing else.
