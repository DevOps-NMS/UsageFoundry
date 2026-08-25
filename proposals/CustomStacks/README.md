# Persistent custom stacks

**Open, and incomplete — this is the first of three passes.** The substrate
question is surveyed (`00-` to `07-`); the Terminal pane and the stack object
model are not, and neither is the comparison, the recommendation or the
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
| 1 | **Substrate** — what persists, and what reaches the agents | `00-`–`07-` (this pass) |
| 2 | **Terminal pane** — the surface and its security model | run 2, from `08-` |
| 3 | **Stack object model, deploy, lifecycle** — plus comparison, recommendation, sketch, validation | run 3 |

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

## What could not be reached

**This container has no Docker.** No rebuild, no volume creation, no volume
destruction, no image build, and no seccomp application was observed anywhere in
this pass. Every persistence claim is reasoned from the compose file's own
statements and says so at the point it is made; `01-constraints.md` §11 lists the
five commands a human would run instead. Also unreached: any real stack tool,
`/data` and therefore all run history, and the `acceptEdits` probe above.

One gap in the repository's own record rather than in this survey:
`grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|gocache" docs/verification.md` returns
one line, and it is about a guard. **The three tool volumes have never been
observed surviving a rebuild** — they are pinned by a unit test over file
contents (`deployment.test.ts:664`, `:733`) and nothing else.
