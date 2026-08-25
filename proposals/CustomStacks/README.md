# Persistent custom stacks

**Open, and incomplete — two of three passes are in.** The substrate question is
surveyed (`00-` to `07-`) and the Terminal pane is (`08-` to `13-`); the stack
object model is not, and neither is the comparison, the recommendation or the
validation. Do not read this directory as a decision yet.

**The question:** an operator wants to install a tool — Terraform is their
example — from the web interface, have it reach every run, and have it survive
`docker compose up --build`.

## The two findings that reframe the request

**Persistence is largely solved and nobody knows it.** Three named volumes exist
for this exact problem and the compose file argues each one out
(`docker-compose.yml:370-409`). Two have a declarative boot-time install loop
behind them (`docker-entrypoint.sh:169-190`, `:241-310`), so `UF_PY_TOOLS=ruff`
in `.env` already puts a command on every agent's `PATH`, surviving every
rebuild and reinstalled after `docker compose down -v` — which is *better* than a
terminal, because the declaration outlives the volume. What it does not cover is
a release-tarball binary, which is what most "stack" tools are.

**Reach is not solved, and it is not about `PATH`.** `PATH` passes through all
five kinds of agent child untouched (`orchestrator.ts:6244-6246`, pinned at
`git.test.ts:93`). What may stop a tool being used is the shipped permission
mode: a work cycle runs `acceptEdits` (`settings.ts:730`), which this tree has
twice measured as refusing commands outright, because a `-p` child has nobody to
approve them — seven refusals in one run over `git commit`
(`orchestrator.ts:5082-5089`), and **19 of 58 conflict resolutions, $109.94 of
$233.85, unable to run a single command against the merge they had written**
(`settings.ts:290-296`). Whether that also refuses an arbitrary installed binary
is **the single unmeasured fact this survey turns on**, and the probe costs one
work cycle (`07-` §10).

## The three-way split

| | Question | Files |
|---|---|---|
| 1 | **Substrate** — what persists, and what reaches the agents | `00-`–`07-` |
| 2 | **Terminal pane** — the surface and its security model | `08-`–`13-` |
| 3 | **Stack object model, deploy, lifecycle** — plus comparison, recommendation, sketch, validation | run 3, from `14-` |

## The finding that reframes the second question

**There is no room on the left menu, and the operator's own word for the feature
is the one thing that is refused.** `panes.ts:12-16` closes the list at nine
because ⌘1…⌘9 has nine digits and four modules read that file;
`ui-density-audit.md:159` puts *"a tenth pane"* on the may-never-be-used list and
`:161` gives the alternative — *"New destinations are sub-routes under an existing
pane."* Every option below assumes a sub-route and none re-argues it. The second
finding is that the real cost of a browser terminal is neither the native module
(`better-sqlite3` already compiles in both image stages) nor the security model
(three routes already execute arbitrary code from a browser form) but the
**transport**: nothing in this repo has ever opened an HTTP upgrade, and there is
no custom server to attach one to.

## Files

| File | What it argues |
|---|---|
| [00-problem.md](00-problem.md) | the split, the prior art, the four gaps, and the six things "sandboxed run" turns out to mean |
| [01-constraints.md](01-constraints.md) | what any option must survive — and **the fixed ten-heading list** every option file here answers |
| [02-…widen-the-existing-lists](02-option-widen-the-existing-lists.md) | **Option A** — a third `UF_*` list for release binaries, in the shape of the two that work |
| [03-…persistent-opt-volume](03-option-persistent-opt-volume.md) | **Option B** — one general-purpose writable volume on `PATH`; cheapest, and lost to `down -v` |
| [04-…declared-manifest](04-option-declared-manifest.md) | **Option C** — a manifest in the database, reapplied at boot; the only one with a read-back, and the most expensive |
| [05-…image-is-the-stack](05-option-image-is-the-stack.md) | **Option D** — build args and a layer; survives all four events, and is furthest from what was asked |
| [06-…build-nothing](06-option-build-nothing.md) | **Option E** — build nothing new; document what ships, fix three wrong claims in the tree |
| [07-…make-it-runnable](07-option-make-it-runnable.md) | **Option F** — fix the *reach* instead: a `stackTools` allowlist. Orthogonal; pairs with any of A-E |
| [08-terminal-problem.md](08-terminal-problem.md) | the surface question: the four real deltas, the uid trap, **"never a shell" reconciled**, the transport survey, and why there is no tenth pane |
| [09-…full-pty](09-option-full-pty.md) | **Option G** — `node-pty` and xterm.js; answers the request exactly, and its cost estimate has a hole nobody here can close |
| [10-…one-shot-exec](10-option-one-shot-exec.md) | **Option H** — one command, one exit code, no PTY. No transport risk; cannot express a pipeline |
| [11-…allowlisted-installer](11-option-allowlisted-installer.md) | **Option I** — four typed verbs, no command line. The only option that never has to argue with `CLAUDE.md:134` |
| [12-…manifest-transcript](12-option-manifest-transcript.md) | **Option J** — the pane as a *view* onto `04-`'s manifest. Looks like a terminal, has no input |
| [13-…build-no-terminal](13-option-build-no-terminal.md) | **Option K** — **build nothing.** `docker compose exec` is shipped, documented 21 times, and strictly more capable than three of the four above |

## What could not be reached

**This container has no Docker.** No rebuild, no volume creation, no volume
destruction, no image build, and no seccomp application was observed anywhere in
either pass. Every persistence claim is reasoned from the compose file's own
statements and says so at the point it is made; `01-constraints.md` §11 lists the
five commands a human would run instead. Also unreached: any real stack tool,
`/data` and therefore all run history, and the `acceptEdits` probe above.

**Run 2 adds four unreached questions and one measurement.** Unreached: whether
Next's generated standalone server can carry an HTTP upgrade, whether `node-pty`
builds and traces into `.next/standalone`, whether an agent-uid shell can write
anything worth writing, and what an unread output stream does to server memory.
`08-terminal-problem.md` §9 has the exact command for each. Measured, inside this
container at the agent uid: `/proc/1/cmdline` is world-readable and
`/proc/1/environ` is not — which is why a one-shot exec route publishes the
operator's command line to every agent here and a PTY does not.

One gap in the repository's own record rather than in this survey:
`grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|gocache" docs/verification.md` returns
one line, and it is about a guard. **The three tool volumes have never been
observed surviving a rebuild** — they are pinned by a unit test over file
contents (`deployment.test.ts:664`, `:733`) and nothing else.
