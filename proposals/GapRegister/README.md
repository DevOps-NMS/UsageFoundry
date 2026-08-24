# Where the gaps are

**The question:** where are this app's gaps — across frontend design, backend
logic, growth limits, and features it is missing — and which of them are worth a
survey of their own?

**The state:** the **frontend axis is partially promoted**; everything else is
open. Twenty verified gaps registered, six candidates dropped for lack of
evidence and seven refuted as documented decisions or by probe. Three questions
recommended for a survey, eight things recommended as issues, five refused by
name.

**Four rows were implemented**, on branch
`uf/usagefoundry-721638d11c0b-1-41e5e190`, by two runs after this register was
written:

- **[F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) shipped** — `/api/runs` reads `offset`, `limit`, `status`,
  `q` and `settledBefore`, and the runs page pages the whole history
  (`7405720`, `d77638d`).
- **[F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap) shipped in half** — quick open asks the route for typed
  text, so a run past the hundredth is reachable; its corpus is still panes, runs
  and workflows, so a chat, a branch, an agent, a template and a schedule are
  still unfindable (`f7617fb`).
- **[F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered) shipped** — a text box and a kind picker over the events the
  page already holds, with the truncated-replay count stated when a filter is on
  (`e250524`, `e16fd7f`).
- **[F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field) shipped**, and so did the `beforeunload` prompt it filed as
  an issue rather than a row (`a8f2984`, `bdbdf08`).

**[F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams) and [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) did not ship, and neither did any of B1–B5,
G1–G4 or M1–M6.** Sixteen of the twenty rows are exactly as surveyed, which is
why this directory is not renamed. The invariants behind the four fixes moved to
`docs/agent/conventions.md` and `docs/agent/testing.md`, the operator's half to
`docs/runs.md` and `docs/install.md`, and what a person still has to open and
click to `docs/verification.md`.

**The recommendation below was to survey reachability first, not to implement
it.** The implementation was taken instead. Nothing about that answers Survey 1's
actual question — *what should an operator be able to find, and by what
mechanism, across chats, branches, agents, templates and schedules* — which is
still unanswered, and four point fixes to the run surface are not an answer to
it. The falsifier the recommendation named is also still unrun: nobody has
executed `SELECT COUNT(*) FROM runs` on the live install, so whether reachability
was the right axis to lead with remains unestablished, before or after the work.

## The recommendation

**Survey reachability first** — [06-recommendation.md](06-recommendation.md#survey-1-reachability-what-should-an-operator-be-able-to-find-and-how).
Eight of the twenty rows are one sentence: *the app cannot find what it has
already done.* A hundred-row runs list with no parameters, a search that indexes
two lists, thirty reachable chat threads, a log with no filter, twenty-five
nameable repositories, a settings page with no field search. They share a fix
and the repository already contains the pattern twice — `/api/branches` takes
`repo`/`offset`/`limit`, and `/api/knowledge/search` is a real parameterised
search pointed at the operator's vault rather than at their own runs.

**What would overturn it:** `SELECT COUNT(*) FROM runs` on the live install. If
history is a few hundred rows, reachability is theoretical and the landing
boundary leads instead. That query is one line and **this survey could not run
it** — `DATA_DIR` is unreadable by the agent uid — which makes it the cheapest
falsifier here and the largest hole in the register.

**Runner-up:** the landing boundary
([Survey 2](06-recommendation.md#survey-2-the-landing-boundary-what-must-be-true-before-an-agents-work-leaves-the-machine)) — the register's #1 row, and the
only group whose failure lands in the operator's product rather than in
UsageFoundry.

## The register at a glance

| | |
|---|---|
| Rows | **20** (21 gap ids; one carried once under two framings) |
| Frontend / backend / growth / missing features | 6 / 5 / 4 / 6 |
| Dropped for lack of evidence | 6 |
| Refuted as documented decisions, or by probe | 7 |
| Rows whose failure lands in the operator's product, not this app | **1** |
| Rows that violate a documented invariant | **0** |
| Rows resting on an explicitly assumed premise | 4 |
| Rows already owned by an open issue, squarely | 1 (#78) |
| Rows since implemented | **3 whole, 1 in half** — all frontend |

**Every other count above is as surveyed at `175ba57`, not as it stands today.**
They are what the register said when it was written, and the four implemented
rows are still counted in them — recounting them would make the file disagree
with the twenty sections it indexes. The status lines in
[01-frontend.md](01-frontend.md) and [05-register.md](05-register.md) are the
current reading.

Full table, ranked, with evidence and confidence per row:
[05-register.md](05-register.md).

## The three worth a survey

1. **Reachability** — what should an operator be able to find, and by what
   mechanism? Five genuinely different answers, two of which pull in opposite
   directions, and one of which collides with a documented invariant.
   [→](06-recommendation.md#survey-1-reachability-what-should-an-operator-be-able-to-find-and-how)
2. **The landing boundary** — what must be true before an agent's work leaves
   the machine? Nothing builds or tests a branch before `landRun` merges it
   (`src/lib/land.ts:947-1057`); the setting that sounds like it does has one
   reader and it is the conflict assist (`:1275`); the concurrency guard covers
   one exported door of five; and there is no push and no pull request anywhere
   in `src/`. **Not ExternalValidator's question** — that one is a semantic
   reading of the diff, this one is whether the code builds.
   [→](06-recommendation.md#survey-2-the-landing-boundary-what-must-be-true-before-an-agents-work-leaves-the-machine)
3. **What should check the UI** — 16,529 lines of page code, zero page tests, no
   jsdom, no browser in CI, and four narrow-viewport entries on
   `docs/verification.md`'s "Not yet verified by hand" list. A survey rather than
   "add Playwright", because the operator's own vault has already read the
   coverage literature that stops the obvious answer being taken on faith.
   [→](06-recommendation.md#survey-3-what-should-check-the-ui-and-what-would-it-actually-catch)

## The three biggest things the register says that no single row does

**Nine of twenty rows are reachability.** They would be filed as nine unrelated
tickets and fixed nine times. **Four of them then were** — three whole and one in
half, as four separate changes on one branch — and the four still open include
[G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all), chat threads past the newest 30, which has the same
one-parameter fix as the runs list and did not get it. That is the observation
being demonstrated rather than refuted.

**The chat surface carries four rows and the run surface carries none of the
equivalents.** Incremental persistence, publish-after-persist, a mid-flight
budget check, a paged list — every one exists in this repository, built for
runs, documented in `docs/agent/`. Chat is the newest surface and inherited none
of them. That is why the recommendation for those four is *one issue*, not a
survey: the answer is already written down, one module over.

**Nothing on the register violates a documented invariant.** Every row is
something `docs/agent/` never had an opinion about, and six candidates died
because it did. The invariants hold.

## What this survey could not do

- **Read any run history.** `DATA_DIR` is not readable by the agent uid;
  `.data/usagefoundry.db` in the checkout is stale (last written 2026-08-19) and
  was used only for one schema probe. No row rests on a count of real runs.
- **Run a container.** Docker is unavailable here, so nothing was checked
  against a live fleet, the image `HEALTHCHECK`, or a reproduced collision.
- **Open a browser.** At any viewport. Which is [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything)'s point.

Full accounting, including every command run and its output, what was
deliberately left unread, and every dropped candidate:
[00-method.md](00-method.md).

## Files

| | |
|---|---|
| [00-method.md](00-method.md) | What was read, what was run and what it printed, what could not be reached, what was refuted, what was dropped |
| [01-frontend.md](01-frontend.md) | F1–F6 |
| [02-backend-logic.md](02-backend-logic.md) | B1–B5, and what this axis got right |
| [03-growth.md](03-growth.md) | G1–G4, and two candidates refuted as deliberate ceilings |
| [04-missing-features.md](04-missing-features.md) | M1–M6, judged on capability rather than polish |
| [05-register.md](05-register.md) | The ranked table, how it was ranked, and what its shape says |
| [06-recommendation.md](06-recommendation.md) | Three surveys, eight issues, five refusals by name |

Verification loop on the tree this was written against (`175ba57`):
`npm run typecheck` exit 0; `npm test` 1,578 tests / 230 suites / 0 failures;
`env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` exit 0. The tree is
green, and that is the point — none of these twenty is something a green tree
tells you.

Re-run on `a34e56b`, the head of the branch carrying the four fixes:
`npm run typecheck` exit 0; `npm test` **1,660 tests / 245 suites / 0 failures**;
`env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` exit 0. Also still green,
and 82 more assertions — none of them about anything that renders, which is
[F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything)'s point after roughly 900 more lines of interactive page
code. **No browser was opened and no container was started for any of that work,
at any viewport**; `docs/verification.md`'s "Not yet verified by hand" list is
where that is recorded and it is the list to work through.
