# Missing features

Six candidates, judged the way the brief asked: **what can the operator not do
today, and what does that cost them.** Nothing here is polish. Every one is a
capability the product does not have at all.

Two of the six are argued down inside their own sections — [M3](#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) because the
product has a documented position that covers most of it, and [M6](#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) because
the alternative is worse than it first looks. They stay in the file because the
honest form of "we do not need this" is the argument, not the omission.

---

## M1 — The app can push nothing and open no pull request

An agent finishes. Its branch is a local `uf/*` ref. The operator's route to
getting that work anywhere is **Land**, which is a merge into their own checkout
on the recorded target branch (`src/lib/land.ts:947-1057`), guarded by
`checkoutStateOf` requiring the checkout to be clean and standing on the target
(`:414-426`, and `docs/agent/isolation-and-landing.md`).

There is no other exit. `grep` over `src/` for `git push`, `gh pr create`,
`pull request` and `createPullRequest` returns three hits and all three are
prose:

- `src/lib/config.ts:322` — a docblock describing what the *agent's* token is
  for: *"it is the agent's `git push`, `gh pr create` and `gh issue view`"*.
- `src/lib/orchestrator.ts:6014` — the same, in the argv reasoning.
- `src/lib/chat.ts:2092` — the chat's system text telling the model it may read
  *"pull requests and CI logs with `gh`"*.

So the capability exists **inside** a run, as something the agent might do with
a shell if the task text asks it to and `UF_GITHUB_TOKEN` is present. It does
not exist as something the app does, tracks, or shows. Nothing in `runs` records
a PR; nothing in the branches page links one; a run whose agent opened a PR is
indistinguishable from one that did not.

**What it costs.** Three things, and the third is structural:

1. **A team whose review gate is a pull request cannot use Land at all.** The
   product's entire finishing move assumes the operator merges to their own
   working copy, which is a solo workflow.
2. **The operator's checkout becomes a required, serialised resource.** Landing
   refuses if it is dirty, if it is on the wrong branch, or if a run is working
   in it (`src/lib/land.ts:963-978`). A fleet of twenty runs converges on one
   directory that a human is probably also using.
3. **Work is stranded on the machine.** Until a land, the output of every run
   exists only in one container's filesystem, and
   `docs/agent/isolation-and-landing.md` records that isolation being *used up*
   throws rather than degrading.

**Confidence: high** that the capability is absent — three greps, three prose
hits. **Assumed:** that operators want it. No operator was consulted and no run
history was readable. That assumption is what a survey would test first, and it
is the reason this row is ranked on cost rather than on demand.

**Owned by:** nothing. Read #99 first; it is open and touches the same surface.

---

## M2 — One credential, no identity, no authorisation

`src/lib/config.ts:286`:

```ts
export const AUTH_TOKEN = optionalEnv("UF_AUTH_TOKEN");
```

That is the model. The session cookie is a handle to that one token
(`src/lib/sessionToken.ts`); `UF_STATUS_TOKEN` is a second, narrower credential
for `/api/status` and nothing else; `middleware.ts` has five documented
exemptions, each paired with the check standing in for it
(`docs/agent/security.md`). Knowing the token is the whole of being allowed in,
and everyone who knows it is the same principal.

Three consequences the operator cannot work around:

- **No read-only access for a colleague.** There is no role, no scope, no second
  credential that sees runs without being able to start, stop, land or change
  settings. The only sharable thing is total control.
- **No revocation of one person.** Rotating `UF_AUTH_TOKEN` logs everyone out
  and requires a restart ([M6](#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs)).
- **No attributable audit.** `request_log.actor` records *how* a caller
  authenticated and never who (`src/lib/requestLog.ts:28-31, :53`) — see
  [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person). It cannot record who, because there is no who.

**What the vault adds, and where it is careful.**
`3 Resources/Software Security/Authentication versus Authorisation.md` makes the
distinction load-bearing rather than pedantic: authentication is one gate you
can get right once, and authorisation is a **per-endpoint coverage problem** —
every handler is a place the predicate can be forgotten, which is why the note
frames complete mediation as the property to aim at rather than a feature to
add. Applied here, that says two useful things at once. The bad news is that
adding roles means auditing every one of the app's route handlers, not adding a
middleware line. The good news is that the current design has *perfect*
coverage of a trivial predicate, so nothing is half-done — there is no partially
enforced authorisation to untangle first.

**What it costs.** The product is single-operator by construction. Every
multi-person use — a team fleet, a reviewer who is not the runner, a monitor
with read access — is out of reach, and the cost of the gap is bounded by
whether that matters, which no evidence here can settle.

**Confidence: high** on the mechanism. **Medium** on the cost, for that reason.

**Owned by:** nothing. #125 is open on the security surface — read it first.

---

## M3 — Nothing this app runs can reach a human, and most of that is on purpose

`grep -rniE "webhook|smtp|nodemailer|slack|pushover|ntfy|web-?push|notificat"`
over `src/`, excluding tests, returns nine hits and **not one is an outbound
channel** — three are MCP transport comments in
`src/app/api/mcp/route.ts:693-729`, three use "slack" to mean spare column
width, and the rest are unrelated prose. There is no email, no webhook, no
browser push, no anything.

**The strongest case against calling this a gap** is `README.md:229-255`, which
is not a shrug but a designed position: a table of twelve alertable conditions,
each named as a field on `/api/status`, each with a suggested threshold and a
note that *"the conditions are the ones that have gone wrong here"* — queue
depth, oldest queued age, sweeper tick age, sweeper and live-guard failure
counts, both `guardFraction`s, three store sizes, `lastBootReconcile.closed`,
and `dataDirOwned`. It even warns that a `guardFraction` of `null` means no
ceiling was configured and must not be alerted on as a number. Below it, ten
lifecycle events go to stdout as one JSON object per line. That is a coherent
pull-based, operator-integrates-it design, and it is better specified than most
products' push notifications.

**What survives that argument** is narrower and still real: **a stock install
produced by the Quick start has no channel, and the conditions the README
itself lists are precisely the unattended ones.** "A restart terminated runs —
each one needs picking up by hand" and "another process took the data directory"
are not conditions you discover by opening the app; they are conditions that
matter because you are *not* watching. The design assumes the operator already
runs Prometheus or equivalent. An operator who does not — which is the operator
`docs/install.md` is written for — gets nothing.

`3 Resources/Debugging and Observability/SLOs and Error Budgets.md` argues that
alerting should fire on user-visible symptoms rather than on causes, which this
table already does. The note rests on a **single vendor book with no
replication**, so this survey takes the framing and not the authority, and
records that it is doing so.

**What it costs.** A run that parked overnight is discovered in the morning. On
a per-run budget that is money; on a schedule that is a missed window.

**Confidence: high** that no channel exists. **This is the row this survey is
least confident *is* a gap**, and it is ranked accordingly.

**Owned by:** partly by `README.md`'s documented position, which is why the
recommendation for this one is "file an issue for a single webhook", not "survey
it".

---

## M4 — Nothing verifies a branch before it is merged

The mechanism is [B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader) and is not repeated. The
capability framing is:

**The operator cannot say "do not land this unless the tests pass."** There is
no field for it, no per-repository setting, no gate in `landRun`, and the one
setting whose name suggests otherwise — `resolveVerifyTools` — has a single
reader that is the conflict-resolution assist and ships as `[]`
(`src/lib/settings.ts:713`, read at `src/lib/land.ts:1275`).

What makes this the sharpest capability gap in the file is the comparison with
what the project does for itself. `.github/workflows/ci.yml` gates every change
to UsageFoundry on `npm run typecheck`, `npm test` and `npm run build`, across
two platforms, plus a Docker build. The product ships an unattended agent that
writes code and merges it, and offers its operator none of the three.

**What it costs.** Unattended merging without a gate is not unattended; it is
deferred attention. That returns the cost the fleet was bought to remove, and it
is the only row in this register whose failure lands in the operator's product
rather than in UsageFoundry.

**Confidence: high.**

**Owned by:** nothing.

---

## M5 — Nothing can be prioritised; the queue is strictly oldest-first

Every selection over `runs` in the orchestrator is ordered by creation time:

| Line | Query |
|---|---|
| `src/lib/orchestrator.ts:626` | `SELECT * FROM runs ORDER BY created_at DESC LIMIT ?` |
| `:2631` | `SELECT * FROM runs WHERE status IN ('queued','running','paused') ORDER BY created_at` |
| `:3950` | `SELECT * FROM runs WHERE status = 'waiting' ORDER BY created_at` |
| `:8665` | `SELECT * FROM runs WHERE status = 'paused' ORDER BY created_at` |
| `:9471` | `… ORDER BY created_at` |

There is no priority column, no reorder endpoint, no "run this next". The
`queuePosition` the UI shows is a report of a position **nothing can change**,
which is a subtly worse affordance than showing no position: it tells the
operator where they are in a line they cannot leave.

The only levers are destructive or oblique — cancel the runs ahead, set them
aside via `set_aside_at`, or raise `maxConcurrentRuns` and let everything
through at once.

**What it costs.** A one-line urgent fix behind twenty queued documentation runs
waits for all twenty. On an install where a schedule fills the queue overnight,
the morning's real work starts last.

**Confidence: high** on the ordering — five `grep` hits, no exceptions.
**Assumed:** that queues get deep enough for this to bite. `DATA_DIR` is
unreadable, so no queue depth was observed, and `README.md:233` suggesting an
alert at `queue.depth > 10` is the closest thing to evidence that they do.

**Owned by:** nothing.

---

## M6 — A credential cannot be rotated without a restart, and a restart ends live runs

Secrets are read at module load and never again. `src/lib/config.ts:286` is a
module-level `const`, as is the `UF_GITHUB_TOKENS` map built at `:366` and
consumed by `selectGithubToken` at `:424-430`. Changing `UF_AUTH_TOKEN`,
`UF_GITHUB_TOKEN`, `UF_GITHUB_TOKENS` or `UF_STATUS_TOKEN` means editing `.env`
and restarting the container. There is no reload endpoint and no re-read.

A restart is not free: `README.md`'s alert table lists
`lastBootReconcile.closed > 0` with the note *"each one needs picking up by
hand"*, which is the app telling the operator that a restart terminates live
runs and leaves work to reclaim.

**So rotation is coupled to an outage of the fleet.**

`3 Resources/Software Security/Secrets Management.md` sharpens why that matters
rather than merely being inconvenient: **rotation is the only real control after
an exposure**, and its own measured figure — 19% of leaked credentials removed
after 16 days — is a statement about how long exposure persists when rotation is
expensive. Environment variables are listed there as an OWASP *fallback* rather
than a recommended store, which is a fair description of what this app does and
is a reasonable choice for a single-container self-hosted product.

**The honest counter-argument**, and it is strong: a config reload endpoint is
new attack surface on the exact values it reloads, and for a single-container
install a restart is thirty seconds. The gap is not "there should be a reload
endpoint". It is that **rotation costs live runs**, and the cheap fix is not a
new feature at all — it is making a restart non-destructive, which is
`lastBootReconcile`'s territory and #60's.

**What it costs.** Measured in reluctance. A rotation that costs the fleet is a
rotation deferred, and the vault note's 16 days is what deferral looks like.

**Confidence: high** on the mechanism. **Medium** on the framing — no restart
was performed, because Docker is unavailable here.

**Owned by:** #89 carries a rotation item over-cap. Read it before opening
anything.

---

## Considered and not argued for

**Per-repository configuration.** Guards, model, permission mode and plugin set
are install-wide. The one dimension that *is* per repository is the GitHub
token — `UF_GITHUB_TOKENS` and the `perRepo` map at `src/lib/config.ts:424-430`,
which resolves a folder to a key via `matchFolderKey`. So the mechanism for
per-repository settings exists and was built for the value that most needed it.
Extending it is a feature request with a clear shape and no evidence behind it
here: nothing in the tree shows an operator wanting a different budget for a
different repository, and inventing that demand is the kind of guess the brief
asked to be dropped. Named so the next survey knows it was considered.
