# Validator spike — score against docs/validator-baseline.md §3

model: claude-sonnet-4-5 · transport: file · testimony: withheld

cases: 40 · answered: 40 · unparseable: 0 · awaiting: 0
held out — this harness cannot vouch the model saw the whole diff: 3 (cases 2, 18, 24)

## Agreement

- scored set: **34/37** (91.9%)
- including reconstruction failures: 35/40 (87.5%)
- trivial baseline (always answer `finished`): 29/37 (78.4%)

## Confusion (rows = label, columns = verdict)

| label | finished | not-finished | unjudgeable | n |
|---|---:|---:|---:|---:|
| finished | 28 | 0 | 1 | 29 |
| not-done | 0 | 1 | 0 | 1 |
| unjudgeable | 2 | 0 | 5 | 7 |

## false-finished — said finished, the label says the work was not done

**0 of 1** such rows.

## false-not-finished — said not-finished, the label says finished

**0 of 29** such rows.

## Rows the labels call `unjudgeable` (7)

- case 1 → **unjudgeable** — Task asks for a code-quality review; an empty diff is consistent with both a completed analysis and a no-op run.
- case 6 → **unjudgeable** — Task mandates a stdout-only report and forbids any commit; empty diff is indistinguishable from doing nothing.
- case 8 → **finished** — stopInstance/haltPlan wired through route, DTOs, UI, orchestrator/mergeQueue reuse, and a full haltPlan test suite matching the task's exact scenarios
- case 10 → **unjudgeable** — Task forbids repo edits; deliverable is GitHub issues, and an empty diff can't show whether they were filed
- case 15 → **unjudgeable** — Task forbids repo edits and delivers via GitHub issues/stdout; empty diff can't distinguish success from no-op
- case 31 → **unjudgeable** — Task asks a conversational question with no in-repo deliverable; empty diff is consistent with both a correct answer and no work at all.
- case 36 → **finished** — All named deliverables present: instance budget DTO/migration/orchestrator wiring/UI/docs, and all 6 required test scenarios in budget.test.ts

## Cost, wall clock, and diff size

- cost per verdict: median $0.1250, total $5.27 over 40
  - priced from measured totals at Sonnet list ($3/$15 per Mtok), 450 tokens of it treated as output
  - tokens per verdict: median 39875, min 24255, max 78879
- wall clock per verdict: median 49.5 s, min 11.9 s, max 108.0 s
- prompt size: median 37431 chars
- diff size (whole branch diff, before shortening): median 76804 B, max 274202 B over 32 non-empty
- shortened to fit: 19 of 40
- empty diffs: 8 · chained branches: 13

## Every verdict

| # | label | verdict | ok | diff | diff B | reason |
|---|---|---|---|---|---:|---|
| 1 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task asks for a code-quality review; an empty diff is consistent with both a completed analysis and a no-op run. |
| 2 | not-done | not-finished | ✓ | unattributed | 0 | Task required a committed code fix + regression test, but the branch diff is empty — nothing landed. |
| 3 | finished | finished | ✓ | complete | 3035 | Diff restructures the Earlier-chats row into title line + separate time/Badge line, exactly the clipped-metadata fix the issue names. |
| 4 | finished | finished | ✓ | complete | 26384 | Cancel route, UI Stop button, signal-safe endTurn, sweeper, and a staleTurn regression test are all present in the diff. |
| 5 | finished | finished | ✓ | complete | 16443 | chat.ts wraps the pre-promise throw window, revokes the capability, and chatTurn.test.ts pins the exact stranded-thinking scenario |
| 6 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task mandates a stdout-only report and forbids any commit; empty diff is indistinguishable from doing nothing. |
| 7 | finished | finished | ✓ | complete | 90221 | Both owned files show large, scoped diffs; account/page.tsx (shown in full) and commit messages match the task's named deliverables. |
| 8 | unjudgeable | finished | ✗ | complete | 87272 | stopInstance/haltPlan wired through route, DTOs, UI, orchestrator/mergeQueue reuse, and a full haltPlan test suite matching the task's exact scenarios |
| 9 | finished | finished | ✓ | complete | 62170 | reply/notes/decided fields, blockSettlement, and the instance-page summary line together answer why an orchestrator block emitted nothing. |
| 10 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task forbids repo edits; deliverable is GitHub issues, and an empty diff can't show whether they were filed |
| 11 | finished | finished | ✓ | complete | 4636 | RunLand.tsx adds nullable strategy + defaultStrategy and a single effectiveStrategy feeding both the select and act's POST body. |
| 12 | finished | finished | ✓ | complete | 59320 | Diff (scoped to the 5 named files only) shows lead primary card, ListGroup rollups, list-view tables, SegmentedControl pickers, and the RunCard primary-emphasis fix, all matching the task's bullets. |
| 13 | finished | finished | ✓ | complete | 11710 | zonedTime fix uses zonedParts as described; both named zones and all three named test cases are added in schedules.test.ts |
| 14 | finished | finished | ✓ | complete | 123375 | agentId threaded through node type, normalizeWorkflowInput, planEmission, planNode, editor UI and both test files exactly as the task specified |
| 15 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task forbids repo edits and delivers via GitHub issues/stdout; empty diff can't distinguish success from no-op |
| 16 | finished | finished | ✓ | complete | 54551 | duePausedRuns/planPausedRun extracted, exported, and tested for all four issue branches; sweepPaused rewritten to use them unchanged; CLAUDE.md list updated |
| 17 | finished | finished | ✓ | complete | 101273 | Diff delivers VACUUM INTO backup, guarded restore, operator docs, and tests/verification matching every restated acceptance point in the prompt. |
| 18 | finished | not-finished | — | 1 ambiguous | 82324 | TRANSIENT_BACKOFF_MS (the #104 retry ladder) is never passed through jitterMs; only refusalResumeAt's park path got jitter, and only 2 of the required 3 commits exist. |
| 19 | finished | unjudgeable | ✗ | complete | 108961 | Readme.md/DECISIONS.md/SPEC.md are verifiably committed, but the required 6-10 filed GitHub issues + index cannot be confirmed from a git diff |
| 20 | finished | finished | ✓ | complete | 169258 | Golden id file and diffstat show both referential (#4) and pr/commit/comment (#5) ids and files landed, matching spec sections named in the task. |
| 21 | finished | finished | ✓ | complete | 109072 | Diff fixes both causes of a stuck merge-queue row (git() throwing, drainRepo throw escaping) and the frozen-panel polling, with new tests proving it. |
| 22 | finished | finished | ✓ | complete | 36540 | docs/00-shape.md is present with every required section (problem, appetite, goals/non-goals, checkable comprehension test, integration criteria, milestones, DoD) |
| 23 | finished | finished | ✓ | complete | 136567 | digest.go, digest/{classify,query,render,digest}.go, root.go wiring, and section/footer/predicate tests are all present and on-target for issue #10. |
| 24 | finished | not-finished | — | unattributed | 0 | Task required a full walking skeleton committed to the repo; branch diff is empty, so none of it landed. |
| 25 | finished | finished | ✓ | complete | 150155 | Six red/green trap-test commits, unrelated-histories + fabricated-unknown fixtures, boundaries test update, and schema-freeze commit/CLAUDE.md all match the DoD's named deliverables. |
| 26 | finished | finished | ✓ | complete | 128275 | Both mandatory deliverables (D2 settled w/ quote, D12 memo w/ position) are visible; best-effort items match diffstat + cross-refs |
| 27 | finished | finished | ✓ | complete | 274202 | All five deliverables (schema+D13 split, isolated two-party harness, adversary scenarios, decidability probe with a reported finding, labelled-placeholder verification) are present and cross-corroborated in the diff/tests. |
| 28 | finished | finished | ✓ | complete | 2144 | Both fixes present: mb-4 spacing on Checkout slots Card, and relative containment on AppShell's main pane fixing the double-scrollbar overscroll. |
| 29 | finished | finished | ✓ | complete | 115775 | All 4 deliverables present under scripts/sandbox-probe/ plus docs/verification.md, matching every specific requirement named in the task |
| 30 | finished | finished | ✓ | complete | 14462 | docs/verification.md gets every Q1-Q4 token, versions, /backups test, Phase-4 honesty, and probe.test.sh result the task demanded, in one committed diff |
| 31 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task asks a conversational question with no in-repo deliverable; empty diff is consistent with both a correct answer and no work at all. |
| 32 | finished | finished | ✓ | complete | 40910 | docs/fundamentals-premise.md contains every required section (verdict, ground truth, redundant/contributes table, test results with file:line discrepancies, timing, gaps list) |
| 33 | finished | finished | ✓ | complete | 76804 | Both fully-visible files (00-shape.md amendment, CLAUDE.md current-state) hit every required point; plan.md's 279-line change is diffstat-confirmed and cross-referenced by name (§3.8.x, WP11). |
| 34 | not-done | not-finished | ✓ | complete | 0 | Task required committed doc updates (README.md, 08-track-b-shape.md) and the branch diff is empty — nothing committed. |
| 35 | finished | finished | ✓ | complete | 18965 | claimTurn() makes the check-and-claim atomic in chat.ts, and a concurrent-message spawnCount test targets exactly that race. |
| 36 | unjudgeable | finished | ✗ | complete | 131502 | All named deliverables present: instance budget DTO/migration/orchestrator wiring/UI/docs, and all 6 required test scenarios in budget.test.ts |
| 37 | finished | finished | ✓ | complete | 14425 | Both fixes land as specified: chatRequest+try/finally for stop, three-state guardBadge helper with tests wired into the workflow page, out-of-scope files untouched. |
| 38 | finished | finished | ✓ | complete | 67448 | docker-compose.yml gets mem_limit/memswap_limit/pids_limit/cpus with justified numbers, plus matching docs, .env.example and new deployment.test.ts assertions. |
| 39 | finished | finished | ✓ | complete | 87308 | docs/01-implementation-plan.md was created (1175 lines) exactly as named, diffstat complete, commit message engages the task's core decisions |
| 40 | finished | finished | ✓ | complete | 73059 | docs/08-track-b-shape.md (486 lines, new) plus docs/06/07/03 and research/sources.md edits cross-reference its §II.0–II.6, matching every required item |
