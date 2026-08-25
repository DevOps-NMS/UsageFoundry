# The recommendation

**Spend one work cycle measuring whether a work cycle can invoke an arbitrary
binary, and then build the read-back and the documentation — not the terminal,
not the table, and not the manifest.** The operator's request has three parts and
the tree already answers two of them: persistence is solved twice over for two
ecosystems and a third route exists for everything else
(`docker-entrypoint.sh:169-211`, `:241-310`, and a `Dockerfile.stack` that
`FROM`s the shipped image), while a shell on the container is shipped, documented
twenty times, and strictly more capable than anything a browser tab could offer
(`13-` §1). What is genuinely missing is the third part, and it is not a surface:
**nothing in this app can see what is installed, so a tool that is absent fails
inside a tool call the run loop does not read and is filed as the agent choosing
not to use it** (`docker-compose.yml:386-391`) — 213 sessions of it on one
install, unnoticed (`.env.example:222-226`). `14-` §8 is the asymmetry that
decides where the effort goes: an install that fails costs a boot log line an
operator is watching, and a tool that is absent costs billed tokens on every
cycle of every run that needed it, discovered by nobody. So the recommendation
spends everything on the second and nothing on the first, and it comes to **six
to nine days** against `16-`'s and `18-`'s week to two weeks and `09-`'s
open-ended estimate.

## What to build, in order

**0. The probe — one work cycle, and nothing else should start before it.**
`07-` §10's recipe, unchanged: install `ruff` via `UF_PY_TOOLS`, start a run at
`acceptEdits`, ask it to run `ruff --version` and `ruff check .`, and read the
log for a refusal. Four outcomes and each decides a different thing. **This is
the highest-value action available to anyone reading this directory** and it
costs less than the cheapest option in it.

**1. The documentation — one to two days, and it does not wait for the probe.**
`06-` §2's four items and `13-` §2's four, which overlap, plus `05-`'s minimal
form as the answer for anything without a package manager. Concretely: a "Tools
your agents can use" section in `docs/install.md`; a "Running commands in the
container" section giving the `docker compose exec` recipe with the uid read out
of the container (`docs/install.md:49-50`, and the mistake that page already
records at `:52-56`); the `Dockerfile.stack` + `docker-compose.override.yml`
recipe; a `docs/verification.md` entry recording that the three tool volumes have
**never been observed surviving a rebuild**; and the three code-comment
corrections `06-` §2 collects — as corrected by `22-validation.md`, which found
one of them to be a misreading and two to have wrong line numbers.

**2. `15-`'s inventory and read-back — two to three days.** `toolInventory.ts`,
`GET /api/tools`, a Settings card. Three states per declared tool, and the
honest rendering is the whole point: **a tool whose invocation has never been
observed reads `unverified`, never `installed`** (`14-` §5). This is the piece
that closes `00-problem.md` §"Missing 4", and it is the only piece here that
could not have been written as documentation.

**3. `07-`'s `stackTools` — one to two days, if and only if the probe says
reach is broken.** Install-wide, in the shape of `resolveVerifyTools`, shipping
empty. `07-` §10 left the per-run-versus-install-wide question to this run and
`14-` §7 settles it: install-wide, because the grant is about what the
*container* holds. If the probe's third outcome comes back — both commands
allowed — **this phase is deleted, not deferred**, and the recommendation is one
day shorter.

**4. Nothing else, yet.** `17-`'s refusal is the one deferred item with a date on
it: build it once `15-`'s card has run long enough to show the
name-to-executable mapping is reliable, because a precondition check that is
wrong in the refusing direction stops work that would have succeeded
(`17-` §8, §10). Until then the card *reports* and does not *refuse*.

## What would overturn this

Four things, in descending order of how likely they are to be true.

**The operator has no host access to the container.** `13-` §10 calls this *"the
single most decision-relevant thing left unanswered in this proposal"* and it is
right. Every argument for `docker compose exec` collapses at once if the shell is
simply absent — a hosted deployment, or a machine somebody else administers. Then
`10-`'s one-shot exec becomes the cheapest door and the recommendation is wrong
in its central claim. **One sentence to the operator settles it.**

**The five commands they expect to type are not four `uv tool install`s.**
`09-` §10, `10-` §10 and `11-` §10 each name this from their own direction and
nobody has asked. If the answer is `apt-get`, a login, or a two-step install,
then the installer options are all answering a smaller question than the one
being asked and the honest reply is `13-`'s: use the shell that ships.

**The probe's third outcome.** If a work cycle can already invoke an arbitrary
binary, phase 3 disappears and the survey's most-cited unknown resolves in the
convenient direction. That does not overturn the recommendation — it shortens it.

**They have four toolchains, not one.** `14-` §1 makes identity conditional on
something selecting between stacks and `14-` §7 finds nothing that does. If four
mounted repositories genuinely need four different toolchains, `18-` is the only
option in the directory that expresses it, and this recommendation has answered a
question about a single install.

## The runner-up

**`11-` — the allow-listed installer, at 75.** Four typed verbs, no command
line, the operator's stated example served directly because Terraform is a
release tarball, and — uniquely — an option that never has to argue with
`CLAUDE.md:134`'s *"Never a shell. Argv arrays only"*, because it obeys it. It
is also the quietest option in the set against `docs/agent/`: `11-` §9's *"almost
none"* survived validation.

**What promotes it:** the operator answering the ten-minute question in
`11-` §10 with four verbs' worth of commands. If the five things they expect to
type are `uv tool install`, `gh extension install`, a tarball and a removal, then
`11-` *is* the feature, three to five days buys it, and phases 1 and 2 above are
its documentation and its read-back rather than a substitute for it.

**What holds it back today:** it is a surface built for a demand nobody has
measured, and its own §10 says the closed list *"has to be closable, and if it is
not, this option should be rejected rather than widened."* Building it before
asking is the shape of decision this directory has been trying to avoid.

## What is rejected, by name

**`09-` — the full PTY pane. Rejected.** Not primarily on security: `08-` §2
establishes that three routes already execute arbitrary code from a browser form
and that a shell dropped to `UF_AGENT_UID` is narrower than
`POST /api/chat/[id]/message`. It is rejected because **its cost has an unbounded
tail** — if Next's generated standalone server cannot carry an HTTP upgrade, the
option becomes owning a custom server entry point, which is *"not a week of work,
it is a permanent maintenance commitment against Next's release cadence, taken
for one pane"* (`09-` §9) — and because on a `UF_ALLOW_NO_AUTH=1` install, which
is sanctioned and documented, it is an unauthenticated root shell for any local
process that can open a TCP connection to port 3000 (`13-` §10).

**`10-` — the one-shot exec route. Rejected**, and it is the closest call in this
file. It has no transport risk, no hole in its estimate, and an exit code is a
real read-back. It is rejected because it is `docker compose exec` with fewer
capabilities and a new attack surface, and because `10-` §4's pipeline gap means
the first three things anyone types — `curl … | tar xz`, `cd foo && make`,
`export PATH=…` — are refused in three different ways. **If the "no host access"
overturn above turns out to be true, this is the option to build**, and nothing
in this rejection should be read as an argument against it in that world.

**`16-` and `04-` — the stacks table. Rejected**, and this is the survey's
central refusal. It answers the operator's sentence exactly, scores 5 on
"Asked", and is rejected anyway, because identity is the only thing it buys over
phase 2 and `14-` §7 finds nothing in this app that selects between two stacks.
A week to two weeks, a migration, a route, a page, a boot reconciler, a fourth
kind of root-spawned child and three `docs/agent/` files moved — **for a list
that today fits on one `.env` line**, and which `down -v` destroys where `.env`
survives it (`16-` §3).

**`12-` — the manifest transcript. Rejected with `16-`**, since it is a two-day
layer over a rejected week. Its own insight survives and is worth keeping: what
the operator wanted from a terminal was *feedback*, and phase 2 is that feedback
at a twentieth of the cost.

**`18-` — the repository manifest. Rejected, and it is the one rejection that
may not last.** Strongest persistence in the directory — the only option
surviving a fresh host through `git clone` — and the widest boundary: a cloned
repository becomes an installer, held by one sentence (*a manifest is inert until
a human approves its exact content*) that every reasonable convenience request
afterwards attacks. Rejected on cost and boundary, not on idea. If the
four-toolchain overturn is true, this is what to build.

**`03-` — the bare `/opt/stacks` volume. Rejected as a standalone.** Dominated by
`02-`: same substrate, one fewer property, and its own §8 calls it *"the option
with the worst failure profile in the directory."*

**`02-` — `UF_BIN_TOOLS`. Deferred, not rejected**, and the distinction matters
because it is the only thing in the directory that installs Terraform
declaratively. It sits behind `05-`'s minimal form in phase 1: a
`Dockerfile.stack` serves the same case for half a day of documentation instead
of two to three days of code plus a checksum table this repository would be the
first to own — validation found that every existing pinned download verifies
against the *publisher's* digest, never one the repository chose
(`22-validation.md`, correction 12). **If operators try the Dockerfile route and
reject it, `02-` is the next thing to build.**

## What a person would have to accept to overrule this

Stated as plainly as possible, so that overruling it is a decision rather than a
drift.

**To build the terminal (`09-`), accept all four:**
1. That a cost estimate whose ceiling is *"a permanent maintenance commitment
   against Next's release cadence"* is acceptable for one pane.
2. That on a `UF_ALLOW_NO_AUTH=1` install — sanctioned, documented and probably
   common — the app ships an unauthenticated root shell on port 3000.
3. That four `docs/agent/` files moving, including a fourth kind of non-`claude`
   child and the first reconciliation `CLAUDE.md:134` has ever needed, is
   proportionate.
4. That `docker compose exec`, documented twenty times across four
   operator-facing pages, is not already the answer.

**To build the table (`16-`), accept both:**
1. That identity is worth a week to two weeks when nothing in the app selects
   between two stacks, and the alternative is one line in `.env`.
2. That moving the declaration from a file that survives `docker compose down -v`
   into a database that does not is an improvement, on the strength of a backup
   the operator has to be taking.

**To skip the probe, accept one thing:** that it is reasonable to build a way to
install tools without knowing whether a work cycle may run them. Eleven of the
twelve rows in `19-`'s table score 0-3 on reach. **That is the whole directory
resting on one unmeasured fact**, and the measurement costs a single work cycle.

## What in the operator's idea should not be built

**The Terminal pane, as described, should not be built.** Not the pane — there is
no tenth slot for it (`panes.ts:12-16`, `ui-density-audit.md:159`, `:160-161`) —
and not the shell behind it. The container's CLI the operator wants to reach is
already reachable, from the machine they are already logged into, with more
capability than any in-container terminal could have: `docker compose exec` can
restart the container, rebuild the image, inspect the volumes and read
`/proc/1/environ`, none of which a pane can (`13-` §1).

**And the deploy button should not be built either**, which is the harder half to
say. *"Deploy from the web interface"* is answered in this recommendation by a
card that shows what is deployed and does not let you change it there. That is
deliberate: the thing worth having is the read-back, and the thing that costs a
week is the button. If the operator reads phase 2 and says the button was the
point, then `11-` is the runner-up above and this recommendation was wrong about
which half of their sentence carried the weight — **but that is a question to ask
them, not to guess at, and it has been guessed at in this directory fifteen
times.**
