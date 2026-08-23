# Growth

Four gaps, and the first is the shape of the other two.

Two candidates that look like growth limits are documented deliberate ceilings.
They are refuted at the bottom of this file rather than registered, on the same
grounds as the four in
[00-method.md](00-method.md#refuted-or-already-decided). That matters for the
register's credibility: the workflow caps and the `npm audit` gate are the two things a
casual sweep would flag first, and both are already reasoned about in the
repository, in more detail than a flag would have added.

---

## G1 — Nine list routes read parameters; the one for runs does not, and the pattern repeats three times

Not one cap. A class of them.

Every `route.ts` under `src/app/api` was checked for whether it reads
`searchParams`. Ten do. **`src/app/api/runs/route.ts` is the only route in the
tree that returns a capped list and reads none** — its whole body is
`listRuns(100)` at `:49`.

The same shape appears three times, in three modules, with three different
numbers:

| Surface | Cap | Where | Parameter to move it |
|---|---|---|---|
| Runs list | 100 | `src/app/api/runs/route.ts:49` | none |
| Chat threads | 30 | `src/lib/chat.ts:289` (`listChats(limit = 30)`), called with no argument at `src/app/api/chat/dto.ts:89` | none |
| GitHub repositories the chat can name | 25 | `src/lib/workspace.ts:168, :188` | none |

And the counter-example is in the same tree. `/api/branches` takes `repo`,
`offset` and `limit` (`src/app/api/branches/route.ts:25-40`) with a docstring
stating the principle:

> `repo` and `offset` are what make the whole set reachable rather than only its
> newest page.

So does `/api/knowledge/search`, which is a real search — `?q=` over title,
alias, tag and path, `?limit=` defaulting to 50 and capped at 200
(`src/app/api/knowledge/search/route.ts:9-19`). **This repository contains a
working, parameterised, capped search implementation, and it is pointed at the
operator's vault rather than at the operator's own runs.**

**Why this is a growth gap and not three bugs.** Each cap was reasonable when
written and none of them fails; they simply stop being enough as an install
accumulates, and there is no signal at the boundary except the one line the runs
page renders. An install grows into all three at different times, so each is
discovered separately, as a mystery, months apart.

**Blast radius.** Run history, chat history, and which repositories the
orchestrator can reason about.

**Cost of leaving it.** Rising with use, which is the definition of the axis.
An install that has done ten thousand runs has the same window onto them as one
that has done a hundred and one.

**Confidence: high.** The route survey is a loop over `find src/app/api -name
route.ts` grepping for `searchParams`; the three caps are read from source.

**Owned by:** nothing owns the pattern. The runs half is
[F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched)/[F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap), the repositories half is
[B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) and #78.

---

## G2 — Chat threads past the newest 30 cannot be reached at all

Broken out from [G1](#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times) because its ceiling is the lowest and its content is
the least replaceable.

`src/lib/chat.ts:289` is `export function listChats(limit = 30): ChatRow[]`.
`src/app/api/chat/dto.ts:89` calls `listChats()` — no argument, so 30. The route
at `src/app/api/chat/route.ts:16-27` reads nothing from the request and returns
`{ chats: chatListDTO(), chat: chatDTO(chat) }`.

There is no chat search, no date filter, and Quick open does not index chats
([F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap)). A thread is reachable by URL if the operator kept the
id, and otherwise not.

What is in a thread makes this worse than the run list. `docs/agent/chat.md`:
prompt text is *the one half of a run a model may write*, and a proposal that
was approved is a decision with reasoning attached. Thirty threads on an active
install is weeks, not months.

**Blast radius.** Every past orchestrator conversation.

**Cost of leaving it.** The reasoning behind approved runs becomes
unrecoverable on a rolling window nobody chose the width of — 30 was a sensible
default for a list, not a decision about how much history to keep.

**Confidence: high.**

**Owned by:** nothing.

---

## G3 — One process is the hard ceiling, and the usual escape route is not the one that applies

The single-writer design is real and deliberate. `serverLock.ts:214` types
ownership as `"unclaimed" | "owned" | "held" | "lost"`; `:394` records that
*"`unclaimed` is deliberately not a refusal"*; `docs/agent/concurrency-and-ownership.md`
makes "every writer asks the lock at the moment of the write" an invariant, and
the `ReadOnlyNotice` banner is what a second replica gets. That closed #93 and
it is right.

It also means the install's ceiling is **the process**, and every concurrency
constant — `maxConcurrentRuns`, `maxConcurrentAssists`, `MAX_WORKTREE_SLOTS = 64`
(`src/lib/orchestrator.ts:2675`), `MAX_MERGE_WORKERS = 4`
(`src/lib/mergeQueue.ts:613`) — is a ceiling on one machine's one Node process,
several of whose paths are synchronous because better-sqlite3 is.

**What the vault says, and what it says against the obvious framing.**
`3 Resources/Data and Storage/When an Embedded Database Stops Being the Right Answer.md`
names two structural boundaries at which an embedded database stops being the
right answer: **more than one serial write queue is needed**, and **the
filesystem must be shared across hosts**. Neither is crossed here. The write
queue is deliberately serial and the filesystem is deliberately one host's. So
the honest finding is the inverse of the one a growth survey usually reaches:
*SQLite is not the constraint, and swapping it would buy nothing.* The
constraint is that the app has one process and no story for a second one beyond
refusing it.

**Blast radius.** Whether an install can grow past what one machine runs.

**Cost of leaving it.** Zero today, unbounded later, and unusually cheap to
*decide* — the question is whether horizontal scale is a goal at all, and the
answer might well be no. A single-container product with an explicit "one
machine" position is a coherent product. Nothing in `docs/` states that
position, which is the actual gap: the ceiling exists, and it is not written
down anywhere an operator planning capacity would find it.

**Confidence: high** on the mechanism and the constants. **Medium** on
severity — no install was observed near any ceiling, because `DATA_DIR` is
unreadable.

**Owned by:** nothing. This is the row most likely to be refused in
[06-recommendation.md](06-recommendation.md), and it is.

---

## G4 — The audit trail is 20,000 rows deep, evicted on every insert, and identifies no person

`src/lib/requestLog.ts:68` sets `const RETENTION_ROWS = 20_000;` and every
`recordRequest` runs, immediately after its `INSERT`:

```ts
"DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?"
```

at `:119-121`. Nothing in `retention.ts` touches `request_log` — this is the
only eviction, and it is unconditional per write.

The cap is deliberate and `docs/agent/chat.md` explains why it must stay one:
`request_log` evicts on every insert, so auditing a credential-free refusal
would be a lever on the audit log itself, which is why the capability token's
401 is answered *outside* `auditMutation`. Do not raise this number without
reading that.

The gap is that **20,000 rows is the entire audit history and it is measured in
requests, not in time**. A polling browser generates requests continuously; a
fleet under load generates more. How many days 20,000 rows buys on a real
install is unknown here, because `DATA_DIR` is unreadable — and
`docs/verification.md:1033+` lists *"the audit trail on a real database"* among
the things not yet verified by hand, so it is unknown to the project too.

And what survives identifies no person. `requestLog.ts:28-31` is explicit and
correct about why:

> `actor` says **how** a caller authenticated — a session cookie, a bearer
> token, the chat's per-turn capability, or nothing at all — and never with
> what. That is the whole of what an audit needs: which credential class, not
> which secret.

That is right about *secrets*. It is a statement about credentials, not about
identity, and identity is genuinely absent — see [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation).
An audit row says `session` because there is only one thing it could say.

**Blast radius.** Any question of the form "what happened, and when". Incident
review, and any compliance posture that needs a retained trail.

**Cost of leaving it.** Silent. The trail does not fail; it shortens, and the
day you need it is the day you learn how short.

**Confidence: high** on the mechanism. **Low** on how many days 20,000 rows is
— that number is exactly what a survey would have to measure first.

**Owned by:** nothing directly. #91 is open on the operational surface and
should be read alongside.

---

## Refuted on this axis

**The workflow caps are too low.** `MAX_WORKFLOW_NODES = 25`, `MAX_FAN_OUT = 10`,
`MAX_LOOP_PASSES = 20` (`src/lib/apiTypes.ts:980, :991, :1000`). Each carries a
docblock giving the reason, and the reasons are about *safety*, not about
capacity — `MAX_FAN_OUT` is deliberately tighter than `MAX_WORKFLOW_NODES`
because those runs *"are chosen by a model and start with no approval between
the decision and the spawn"*, and `MAX_LOOP_PASSES` bounds *"what one press of
Run can put on the machine over the life of a block whose repetitions nobody
watches."* Raising them is a request for a different risk position, not a fix.
Not a gap.

**The three high-severity npm advisories.** `npm audit` on this tree today
reports `3 high severity vulnerabilities`, all inside `next`'s subtree, fixable
only by `next@16.3.2` — a semver-major move. The CI gate is set at `critical`,
not `high`, and `.github/workflows/ci.yml:126-163` is thirty-seven lines
explaining that decision advisory by advisory: which four postcss GHSAs, why
postcss here only ever sees `src/app/globals.css` and Tailwind's output under an
explicit `@source` with `source(none)`, why nothing under `src/` imports
`next/image` so the only route to `sharp` is an optimiser with empty
`remotePatterns`, and why gating at `high` *"would leave this job red every day
for three advisories a human has already read, which is how a gate stops being
read at all."* The unconditional `npm audit || true` at `:124` keeps `critical`
from being a silent pass.

The only thing today's run changes is the version number — the comment says
`next@16.3.1` as of 2026-08-14 and `npm audit` now says `next@16.3.2`. The
advisory set is unchanged. **Accepted on the record is not a gap**, and this is
the clearest example in the repository of the standard the rest of this register
is trying to meet.
