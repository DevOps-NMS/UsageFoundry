# The register

**Twenty rows.** Twenty-one gap identifiers across the four axis files, with
[B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader) and [M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged) carried once as
one gap with two framings.

Every row points at a file and line, a command whose output is quoted in
[00-method.md](00-method.md), or a documented invariant it contradicts. Six
candidates were dropped for lack of evidence and seven were refuted outright;
five of the refutations are in
[00-method.md](00-method.md#refuted-or-already-decided) and two in
[03-growth.md](03-growth.md#refuted-on-this-axis).

Ranked by *cost of leaving it*, discounted by confidence. Blast radius alone
does not rank a row — [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) has the widest and sits sixth
because no failure was reproduced, and [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) has an unbounded
one and sits last because it costs nothing today.

**Four rows have since been implemented and are marked in the table below**:
rows 3 ([F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched)), 15 ([F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered)) and 18
([F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field)) shipped, and row 4 ([F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap)) shipped in
half — the hundred-row cap on run search is gone, the two-list corpus is not. All
four are on branch `uf/usagefoundry-721638d11c0b-1-41e5e190`; each section in
[01-frontend.md](01-frontend.md) carries the commits and what the fix actually
was. **Nothing else on the register moved**, and every figure in this file — the
row count, the axis split, the confidences, the ranking — is **as surveyed** at
`175ba57` rather than as it stands today. Read a marked row's status line before
acting on its rank.

One unmarked row is now **contradicted in its evidence** by that work and is
otherwise unchanged: row 11 ([G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)) reads "`/api/runs` is the only
route in the tree returning a capped list and reading no `searchParams`", and
`/api/runs` now reads five of them (`src/app/api/runs/route.ts:73-93`). The row's
actual claim — that this is a pattern rather than an incident, recurring at 100 /
30 / 25 — survives with its first instance struck: the 30 in `src/lib/chat.ts:289`
and the 25 in `src/lib/workspace.ts:168, :188` are untouched, so the pattern is
now two instances and a demonstration that fixing one at a time is what the row
predicted.

## Ranked

| # | ID | Axis | Gap | Evidence | Blast radius | Cost of leaving it | Conf. | Already owned? |
|---|---|---|---|---|---|---|---|---|
| 1 | [B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader) / [M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged) | backend / feature | Nothing builds or tests a branch before it is merged; `resolveVerifyTools` has one reader and it is the conflict assist | `src/lib/land.ts:1275`; `src/lib/settings.ts:713`; `landRun` at `:947-1057` reads it nowhere | every landed branch on every repository | high — the only row whose failure lands in the operator's product; unattended merging without a gate is deferred attention | high | no |
| 2 | [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) | frontend | Nothing that renders is checked by anything: 16,529 lines of page code, 0 page tests, no jsdom, no browser in CI | `find`/`wc -l`; `npm test` = 1,578/230/0; `README.md:967-980`; `docs/verification.md:1033+` | every visual and interactive regression | high and **rising with the code** — the only row whose cost grows rather than staying flat | high | #155, adjacent |
| 3 | [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) | frontend | **SHIPPED** (`7405720`, `d77638d`) — Run history stops at 100 rows; no paging, no server filter, no search | `src/app/api/runs/route.ts:49`; `src/app/runs/page.tsx:82, :840-844`; contrast `src/app/api/branches/route.ts:19-23` | every retrospective question about a run | high — history accumulates and becomes unreachable, silently, until the cap starts mattering | high | no |
| 4 | [F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap) | frontend | **SHIPPED IN HALF** (`f7617fb`) — the cap is gone, the two-list corpus is not — Quick open, the only global search, indexes two lists and inherits the 100 cap | `src/components/shell/QuickOpen.tsx:82-83`; contrast the real search at `src/app/api/knowledge/search/route.ts:9-19` | all navigation that is not a click | high — a miss is indistinguishable from an absence | high | no |
| 5 | [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation) | feature | One credential, no identity, no authorisation, no per-person revocation | `src/lib/config.ts:286`; `src/lib/requestLog.ts:28-31, :53` | every multi-person use of the product | high on a team, zero solo — the product is single-operator by construction | high mechanism / medium cost | #125, adjacent |
| 6 | [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) | backend | The `landing` guard covers `landRun` and none of the other four exported doors into the same repository | `src/lib/land.ts:224, :975, :978, :1053`; the four at `:1182, :1642, :1748, :1936`; `MAX_MERGE_WORKERS = 4` at `src/lib/mergeQueue.ts:613` | a repository's git state — refs, worktree admin, the operator's index | low frequency, high consequence, hard to diagnose after the fact | **medium** — scope read from source, no collision reproduced | #68, third concern only |
| 7 | [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request) | feature | No push and no pull request; Land is a merge into the operator's own clean checkout | three prose-only hits: `src/lib/config.ts:322`, `src/lib/orchestrator.ts:6014`, `src/lib/chat.ts:2092` | any team whose review gate is a PR | high for them, zero for a solo operator — and it makes one directory a serialised resource for the whole fleet | high absence / **assumed** demand | #99, adjacent |
| 8 | [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits) | backend | A chat turn exists nowhere durable until the child exits — text, `chat_turn_spend` and the thread total are lost together | `src/lib/chat.ts:1731`, `:330-331`, `:1973-1978`; contrast the `emit()` ordering in `docs/agent/architecture.md` | orchestrator chat, where a model writes half a run | rare and total — a turn lands whole or vanishes whole, and the money is spent either way | high | no |
| 9 | [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all) | growth | Chat threads past the newest 30 cannot be reached at all — no paging, no search, no index | `src/lib/chat.ts:289`; `src/app/api/chat/dto.ts:89`; `src/app/api/chat/route.ts:16-27` | every past orchestrator conversation | high — approved proposals carry reasoning, on a rolling window nobody chose the width of | high | no |
| 10 | [B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap) | backend | The install ceiling is checked once per chat turn, before it; a turn has no cap and chat has no `live-resume` equivalent | `src/lib/chat.ts:1492` is the only call site; `docs/agent/budgets-and-guards.md` | the install's 24-hour ceiling | bounded by how expensive one turn can get — **which nobody has measured** | high mechanism / medium severity | #87, adjacent |
| 11 | [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times) | growth | A pattern, not an incident: `/api/runs` is the only route in the tree returning a capped list and reading no `searchParams`; the same shape recurs at 100 / 30 / 25 | route survey over `src/app/api/**/route.ts`; `:49`; `src/lib/chat.ts:289`; `src/lib/workspace.ts:168, :188` | runs, chats, and which repositories the chat can name | rising with use; each instance is discovered separately, months apart | high | partly — #78 owns the third |
| 12 | [M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first) | feature | Nothing can be prioritised; every selection is `ORDER BY created_at`, and `queuePosition` reports a place nothing can leave | `src/lib/orchestrator.ts:626, :2631, :3950, :8665, :9471` | scheduling under load | urgent work waits behind a night's schedule | high mechanism / **assumed** queue depth | no |
| 13 | [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person) | growth | The audit trail is 20,000 rows, evicted on every insert, measured in requests rather than time, and names no person | `src/lib/requestLog.ts:68, :119-121`; nothing in `retention.ts`; `docs/verification.md:1033+` | incident review; any retained-trail requirement | silent — the trail shortens rather than failing | high mechanism / **low** on how many days | no; #91 adjacent |
| 14 | [F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams) | frontend | A chat turn renders nothing until it ends; the run path has SSE and lossless reconnect, chat has neither half | `src/lib/chat.ts:1731`; `src/app/chat/page.tsx:362, :765`; contrast `src/app/api/runs/[id]/stream/route.ts` | every orchestrator chat turn | moderate — the newest surface feels the least alive, and the mechanism is one route away | high mechanism / **assumed** turn length | no; #114 adjacent |
| 15 | [F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered) | frontend | **SHIPPED** (`e250524`, `e16fd7f`) — A run's log cannot be searched or filtered | no filter in `src/components/ui/Log.tsx` or `src/components/RunOutput.tsx`; `runEvents` drops with a count at `src/lib/orchestrator.ts:640-665` | post-mortem on any long run | small; cheapest row here to close | high absence / medium severity | no |
| 16 | [B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) | backend | The chat can name only the first 25 git repositories, in scan order, permanently — no offset, no filter | `src/lib/workspace.ts:168, :186-188, :208` | installs with 25+ repositories mounted | absolute past the boundary, invisible from the UI, reads to the operator as a broken repository | high mechanism / **low** on how many installs cross it | **#78**, suspicion 2 — confirmed here |
| 17 | [M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) | feature | A credential cannot be rotated without a restart, and a restart terminates live runs | module-level consts at `src/lib/config.ts:286, :366, :424-430`; `README.md` alert on `lastBootReconcile.closed > 0` | every secret the install holds | measured in reluctance; the vault's 19%-after-16-days is what deferral looks like | high mechanism / medium framing | #89, over cap |
| 18 | [F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field) | frontend | **SHIPPED** (`a8f2984`, `bdbdf08` — the `beforeunload` prompt this row filed as an issue rather than a row) — Settings is nine sections in 3,502 lines with no field search | `src/app/settings/page.tsx:100-111, :1857` | configuration, on the most consequential page | small and constant | high structure / medium severity | no |
| 19 | [M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) | feature | Nothing this app runs can reach a human — no webhook, no email, no push | grep over `src/` returns nine hits, none an outbound channel; **but** `README.md:229-255` is a designed pull-based position with twelve alertable conditions | unattended operation on a stock install | low where a monitor already exists; real for the operator `docs/install.md` is written for | high absence / **lowest confidence that it is a gap** | mostly by `README.md`'s own position |
| 20 | [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) | growth | One process is the hard ceiling, and the ceiling is written down nowhere an operator planning capacity would find it | `src/lib/serverLock.ts:214, :394`; `MAX_WORKTREE_SLOTS = 64`, `MAX_MERGE_WORKERS = 4` | whether an install can grow past one machine | **zero today**, unbounded later; the real gap is an unstated product position, not a missing mechanism | high mechanism / medium severity | no |

## How the ranking was made

Three inputs, in this order.

**Cost of leaving it, now.** Not blast radius. A gap that is catastrophic and
has never fired ranks below one that costs something every week. This is why
row 1 beats row 6, and why row 20 is last despite being the only unbounded one.

**Confidence, as a discount rather than a filter.** A medium-confidence row
stays on the register and moves down. Two rows are explicitly marked as resting
on an assumption — [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request)'s demand and
[M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first)'s queue depth — and both are ranked as if that
assumption is even money.

**Whether something already owns it, as a tiebreak only.** An owned gap is still
a gap; it just should not become a new proposal. Four rows carry an issue
number, and only [B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) is owned squarely rather than
adjacently.

## What the shape of the register says

Three observations that no individual row carries.

**Nine of twenty rows are one sentence: the app cannot find what it has already
done.** Rows 3, 4, 9, 11, 13, 15, 16 and 18 are all reachability — a cap without
a parameter, a corpus without an index, a log without a filter, a page without
a search. Row 2 is the same failure applied to the code itself. This is the
single largest theme and it is not how any of them would be filed individually.

Three of those eight have since been closed whole (3, 15, 18) and one in half
(4), which leaves rows 2, 9, 11, 13 and 16 open plus the corpus half of row 4 —
and leaves the observation itself intact, because they *were* fixed as four
separate changes. [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all) — chat threads past the newest 30 — has the
same one-parameter fix as row 3 and did not get it.

**The chat surface carries four rows (8, 10, 14, and half of 9) and the run
surface carries none of the equivalent ones.** Every mechanism chat lacks —
incremental persistence, publish-after-persist, a mid-flight guard, a paged
list — exists in this repository, built for runs, documented in
`docs/agent/architecture.md` and `docs/agent/budgets-and-guards.md`. Chat is the
newest surface and it did not inherit them.

**Nothing on the register is a violation of a documented invariant.** Every one
is something `docs/agent/` never had an opinion about. That is a strong signal
about where the next hour of documentation is worth spending, and it is the
reason four candidates died as documented decisions rather than surviving as
rows.
