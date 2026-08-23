# Recommendation

Twenty rows sort into three groups: **three questions worth a survey of their
own**, **eight things somebody should just file**, and **four groups refused by
name**.

## The recommendation

**Survey reachability first.** Eight of the twenty rows are one sentence — *the
app cannot find what it has already done* — and the fix is shared rather than
eight patches. Everything else waits behind it.

**What would overturn it:** `SELECT COUNT(*) FROM runs` on the live install. If
it comes back under a few hundred, reachability is a theoretical problem on a
young install and **Survey 2** leads instead. That query is one line and this
survey could not run it — `DATA_DIR` is unreadable by the agent uid — which
makes it both the cheapest falsifier here and the largest hole in the register.

**Runner-up:** Survey 2, the landing boundary. It carries the register's #1 row
and is the only group whose failure lands in the operator's product rather than
in UsageFoundry.

---

## Worth a survey of their own

### Survey 1 — Reachability: what should an operator be able to find, and how?

**Rows:** 3, 4, 9, 11, 13, 15, 16, 18 — [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched),
[F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap), [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all), [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times),
[G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person), [F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered), [B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25),
[F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field).

**Why it is a survey and not a patch.** There are at least five genuinely
different answers and they lead to different code:

1. Parameterise each list route the way `/api/branches` was
   (`src/app/api/branches/route.ts:25-40`) — smallest change, eight times over,
   and it fixes browsing without fixing search.
2. Build one index and one search route, extending what
   `src/app/api/knowledge/search/route.ts` already does for the vault — fixes
   search across every object at once, and does nothing for a page-by-page walk.
3. A generic paged list DTO plus one component, applied everywhere — most
   consistent, most invasive, and it collides with the deliberate decision that
   a list route ships **the list's own DTO** (`RunListItemDTO`,
   `WorkflowListItemDTO`) which `docs/agent/conventions.md` makes an invariant
   because quick open reads those same lists through an unchecked cast.
4. Keep the caps and add a signal at the boundary — cheapest, and an explicit
   decision that history ages out.
5. Do nothing, and let retention be the answer.

**Why it is worth doing.** The design space above is real, options 2 and 3 pull
in opposite directions, and option 3 has a documented invariant standing against
it. That is exactly the shape a proposal handles and an issue does not.

**What it must establish first**, because this survey could not: the size of
`runs`, `chats` and `request_log` on a live install, and how many days 20,000
audit rows actually buys. Every rank in this group is currently argued from a
cap's existence rather than from a count.

**What it must not re-open:** `docs/agent/conventions.md`'s list-DTO invariant
is a decision, not a constraint to route around. A survey that recommends
option 3 has to argue against it explicitly.

---

### Survey 2 — The landing boundary: what must be true before an agent's work leaves the machine?

**Rows:** 1, 6, 7 — [B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader)/[M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged),
[B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors), [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request).

**Why these three are one question.** They are the same boundary seen three
ways: *what is checked* (nothing), *what is synchronised* (one door of five),
and *where the work goes* (the operator's own checkout, or nowhere). Answering
any one alone constrains the others — a pull-request exit makes the verify gate
CI's job, and a verify gate in `landRun` makes the guard's scope suddenly matter
a great deal more.

**The design space.** A verify command in `landRun`; verification per repository
rather than install-wide, reusing the `perRepo` mechanism that already exists
for tokens at `src/lib/config.ts:424-430`; the reviewer running it, which
`docs/agent/git-and-review.md` currently forbids on purpose; a push and a pull
request instead of a merge; extending the `landing` guard to the other four
doors versus one repository-wide lock. Several are mutually exclusive.

**This is not ExternalValidator's question, and the distinction is the reason
this survey is allowed to exist.** `proposals/ExternalValidator/` asks whether a
finished run should get *a second, adversarial reading of task text against
branch diff* — a semantic judgement about whether the agent did what was asked.
This asks whether the code **builds and its tests pass**, which is mechanical,
has no model in it, and would be owed even if ExternalValidator shipped
tomorrow. A survey here must say so in its first screen or it will read as a
re-opening.

**What it must establish first:** whether any `landRun`/`purgeBranch` collision
has ever occurred. That needs a running container and the live database, neither
of which this survey had, and [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) is ranked at medium
confidence for exactly that reason.

---

### Survey 3 — What should check the UI, and what would it actually catch?

**Row:** 2 — [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything).

**Why a survey rather than "add Playwright".** Because the honest version of
this question is about *coverage*, and the operator's own vault has already done
the reading that stops the obvious answer being taken on faith.
`3 Resources/Web Design/Automated Accessibility Testing Coverage.md` (confidence
medium) puts automated coverage between 13% and 57.38% of real issues depending
on the denominator, and
`3 Resources/Testing and Correctness/The Test Pyramid.md` (confidence low)
supports the *cost* argument for testing low while explicitly declining to
endorse the familiar ratios. So the survey's job is to say what each candidate
buys, not to pick the most fashionable one.

**The design space.** Extend the eight existing `renderToStaticMarkup` tests to
the invariants that have none; add jsdom plus `@testing-library` for interaction
without a browser; Playwright in CI, which means starting the container that
`README.md:967-980` says CI *"never starts"*; visual diffing; or a written
manual checklist in `docs/verification.md`, which is the cheapest and is what
the four unverified narrow-viewport entries at `:1033+` are already asking for.

**Why it ranks second overall and third here.** It is the only row whose cost
grows with the codebase rather than staying flat, so the case for it strengthens
every month. It is third in this list because rows 1 and 3–4 cost something
today and this one costs something later.

---

## File an issue; do not survey it

Eight items with an obvious fix and no design space worth a document — seven
issues to file, and one already owned by #78.

| Row(s) | Issue to file |
|---|---|
| 8, 10, 14 — [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits), [B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap), [F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams) | **One issue: bring the chat path to the run path's contract.** Persist the assistant's text incrementally and publish after persisting, as `emit()` does; write `chat_turn_spend` as the turn proceeds rather than at `src/lib/chat.ts:1978`; add a mid-turn budget check beside the one at `:1492`. Three symptoms, one mechanism, and the mechanism is already in this repository — this is implementation, not a question |
| 15 — [F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered) | A filter box over the events already in client state in `src/components/RunOutput.tsx`. Smallest item on the register |
| 18 — [F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field) | A field search on `src/app/settings/page.tsx`, and separately a `beforeunload` guard — there is none anywhere in `src/app`, and the page already derives `dirty` at `:1576` |
| 12 — [M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first) | A priority column and a reorder action, or an explicit decision that the queue is strictly FIFO and `queuePosition` should stop implying otherwise |
| 16 — [B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) | **Comment is not needed — #78 already owns this.** Its suspicion 2 is confirmed against the current tree at `src/lib/workspace.ts:168, :186-188`. This survey files nothing; it records the confirmation here |
| 13 — [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person) | **Measure before changing anything.** How many days does 20,000 rows buy on the live install? Do **not** raise `RETENTION_ROWS` first — `docs/agent/chat.md` explains why the eviction-per-insert cap is load-bearing, and the capability token's 401 is deliberately answered outside `auditMutation` because of it |
| 17 — [M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) | Not a rotation issue. The cost of rotation is that a restart terminates live runs, so the issue belongs against restart reconciliation — `lastBootReconcile.closed > 0` and #60's territory |
| 19 — [M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) | One outbound webhook firing the ten stdout lifecycle events, for the operator who does not already run a monitor. Nothing larger — `README.md:229-255` is a better-specified alerting design than most products ship and should not be replaced |

---

## Refused by name

### G3 — horizontal scale

[G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) is real, unbounded, and **not worth a survey.** Three
reasons. It costs nothing today. The obvious remedy is wrong — the vault's
`When an Embedded Database Stops Being the Right Answer.md` names two boundaries
at which an embedded database stops being right, *more than one serial write
queue* and *a shared filesystem*, and this app crosses neither, so replacing
SQLite would buy nothing. And building for a second process before anyone wants
one is speculative generality of exactly the kind this codebase avoids
elsewhere.

**What is owed instead is one paragraph in `docs/`** stating that an install is
one container on one machine and what its ceilings are. The gap is an unstated
product position, not a missing mechanism.

### M2 — roles and identity, for now

[M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation) is ranked fifth and is still refused, and the
two are consistent because **its rank is conditional**: high on a team, zero for
a solo operator, and no evidence available here establishes which this install
is. `3 Resources/Software Security/Authentication versus Authorisation.md` sets
the price — authorisation is a per-endpoint coverage problem, so this is an
audit of every route handler and not a middleware line.

**Trigger:** the first concrete request for a second person's access. Until
then, single-operator is a coherent product position and should be written down
as one, which is the same sentence [G3](#g3-horizontal-scale) needs.

### The seven candidates that are documented decisions, or refuted by probe

Named again here so a future sweep does not rediscover them. Five are in
[00-method.md](00-method.md#refuted-or-already-decided): `run_deps` indexing,
refuted by `EXPLAIN QUERY PLAN`; `advanceInstances` being a floating promise,
which is documented as deliberate with the reason on the line; the `⌘`-only
chord restriction, mitigated by a toolbar button carrying
`aria-keyshortcuts`; the absence of a spend chart, which is polish rather than
capability; and accessibility, where the operator's own vault note argues
against reading any scan as a verdict.

Two more are in [03-growth.md](03-growth.md#refuted-on-this-axis): the workflow
caps, whose docblocks are safety arguments rather than capacity ones, and the
three high-severity npm advisories, which `.github/workflows/ci.yml:126-163`
accepts on the record advisory by advisory across thirty-seven lines of
reasoning.

### The five existing proposals' questions

Not re-opened, and named so the boundary is explicit:

- **ContextControl** — what a run carries between cycles, and compaction.
  Nothing in this register touches the argv, the cached prefix or
  `--autocompact`.
- **ContinuousImprovement** — cross-run memory and repeated reading. The two
  vault Inbox notes naming UsageFoundry are this proposal's and
  ContextControl's territory, and are cited nowhere in the register for that
  reason.
- **ModelRouter** — who picks the model. [M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first) is
  about *order*, never about which model runs.
- **ExternalValidator** — a second adversarial reading of a finished run.
  [Survey 2](#survey-2-the-landing-boundary-what-must-be-true-before-an-agents-work-leaves-the-machine) is mechanical verification and must say so first.
- **Sandboxing** — containment of a run. [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) is about
  in-process synchronisation between the app's own doors, not about what a run
  can reach.

---

## What this recommendation is least sure of

Three things, stated once.

**The whole register is argued from code and never from run history.**
`DATA_DIR` is unreadable by the agent uid and `.data/usagefoundry.db` in the
checkout is stale (last written 2026-08-19) and was used only for a schema
probe. Four rows carry an explicitly assumed premise. The falsifier at the top
of this file is the query that would settle the largest of them.

**Nothing was reproduced.** No container ran, no browser opened, no collision
was staged. Every "this can fail" is a reading of code, and
[B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) is marked medium for that reason rather than being
promoted on blast radius.

**The ranking's top three are close.** Rows 1, 2 and 3 are within one judgement
call of each other, and the judgement is that a gap costing something weekly
beats one that is catastrophic and has never fired. An operator who has been
burned by a bad merge should reorder them without needing new evidence.
