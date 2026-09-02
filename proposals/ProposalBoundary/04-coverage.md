# Coverage, and the commands

## The commands, and what each did

Run in this worktree at `0b96534`, in this order.

```sh
NODE_ENV=development npm ci --include=dev
```
**Exit 0.** The `NODE_ENV=development` is the trap `CLAUDE.md` names: this
environment sets `NODE_ENV=production`, under which a bare `npm ci` exits 0
having skipped devDependencies and leaves the next two commands failing with
exit 127 for reasons that have nothing to do with the code.

```sh
npm run typecheck
```
**Exit 0.** `tsc --noEmit`, no output.

```sh
npm test
```
**Exit 0.**

```
# tests 2085
# suites 316
# pass 2085
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 16549.512883
```

Nothing failed that this survey did not cause, and this survey caused nothing —
no file under `src/` was opened for writing.

```sh
node proposals/ProposalBoundary/scripts/cross-turn-settle.cjs             # exit 0 — F1 reproduces
node proposals/ProposalBoundary/scripts/transient-refusal-burns-proposal.cjs   # exit 0 — F2 reproduces
node proposals/ProposalBoundary/scripts/guard-drift.cjs                   # exit 0 — F3 reproduces
node proposals/ProposalBoundary/scripts/rival-continuation.cjs            # exit 0 — F4 reproduces
node proposals/ProposalBoundary/scripts/restart-state.cjs                 # exit 0 — F5 reproduces
```

Each script exits 0 when the behaviour it names reproduces and 1 when it does
not, so they are usable as regression checks against a fix. They depend on
`.test-build/`, which `npm test` produces; they refuse to run without it, and
each asserts `config.DATA_DIR === process.env.DATA_DIR` before writing anything,
which is the same guard `chatTurn.test.ts:44` uses to keep a test out of the
operator's real database.

Docker was not available in this container, so no `docker compose up --build`
smoke test was run. That is the second half of this repository's real
verification loop (`CLAUDE.md`), and its absence is why nothing here claims
anything about the app as deployed.

---

## What the five chat test files cover

`chat.test.ts` — 1,501 lines, and the bulk of the intent. Twenty cases on
`planProposal` covering every guard-resolution branch including the deleted
template, the deleted agent, the decayed agent, an agent the proposal did not
ask for, the empty-string folder, the blank override; two on `composeTask`;
twelve on `planApprovalBatch` covering ordering, sibling versus outside
resolution, the three refusal sentences, the cascade, the loop, self-dependency
and duplicate labels; five on `decisionNote`; four on `chatPrompt`; five on
`staleTurn`; two on `chatOwnsRun`; three on `normalizeChoices`; two on
`answerMessage`; two on `settleQuestions`; three on what a message does to an
open question; three on `sendChatMessage`'s claim; and four on `writeMcpConfig`.

`chatTurn.test.ts` — one case: a turn whose `writeMcpConfig` throws leaves the
row `failed` rather than stranded at `thinking`, with the reason in the thread
and no capability left live.

`chatOrder.test.ts` — three cases on thread ordering, including a burst written
inside one millisecond.

`chatThread.test.ts` — eight cases on where a question is drawn relative to the
messages around it.

`chatRequest.test.ts` — seven cases on the client-side request helper.

The intent this records is consistent and worth stating: **every pure function
on the approval path is tested, and nothing that writes is.**

---

## Invariants above that no test covers

Each of these is exercised only by the scripts in this proposal.

| invariant | where it lives | why the gap matters |
|---|---|---|
| A settle belongs to the turn that produced it | `finishTurn` `src/lib/chat.ts:2329` | **F1.** Nothing in the suite calls `finishTurn`, `claimTurn` or `endTurn` by name; `sendChatMessage`'s three cases exercise `claimTurn` only through the "two messages race" path, which is the case that works |
| A transient refusal must not decide a proposal | `approveProposal` catch `:1278` | **F2.** No test calls `approveProposal` at all except `runOrigin.test.ts:168`, which asserts on `runs.origin` and takes the happy path |
| A batch reports what it started and what it did not | `approveRunBatch` `:1311` | **F2, F4.** Entirely untested. `planApprovalBatch` — the pure half — has twelve cases; the half that writes has none, so the `stillborn` cascade, the `minted` substitution and the terminal marking are all unexercised |
| A boot leaves a chat in a state the operator can act on | `reconcileChatsOnBoot` `:2446` | **F5.** Untested. The two facts that matter — that proposals and questions survive, and that the thread says nothing — are both unasserted |
| A decision is terminal exactly once | `markProposal` `:1476`, `rejectProposal` `:1384` | Neither is tested directly. `markProposal` appears in `chat.test.ts:899` only as a fixture for `chatOwnsRun` |
| A capability dies with its turn | `mintCapability` `:1538`, `revokeCapability` `:1544` | **F6.** `chatTurn.test.ts:91` asserts the map is empty after a turn that never spawned — the only assertion about it anywhere, and the one case where revocation is on the failure path rather than the normal one |

The bar `CLAUDE.md` sets is "a pure function whose failure mode is silent gets a
unit test", and `docs/agent/testing.md` records what each existing one earned. By
that bar the gaps above are not oversights: `finishTurn`, `approveRunBatch`,
`markProposal` and `reconcileChatsOnBoot` all touch SQLite and none is pure. But
`chatTurn.test.ts` exists precisely because one impure path was worth a test —
"a silent, expensive failure with no other way out" — and every row in the table
above meets that description. Four of them are the findings in this proposal.

The cheapest closure is not six new tests. It is one: `chatTurn.test.ts` already
carries the whole bootstrap for a chat test that touches the database, and F1,
F2 and F5 are each a dozen lines inside it. The scripts in
[`scripts/`](scripts/) are those tests written outside `src/`, because this
survey may not write there.
