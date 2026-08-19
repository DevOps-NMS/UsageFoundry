# Validator spike — score against proposals/ExternalValidator/validator-baseline.md §3

model: claude-sonnet-4-5 · transport: file · testimony: given

cases: 8 · answered: 8 · unparseable: 0 · awaiting: 0
held out — this harness cannot vouch the model saw the whole diff: 2 (cases 2, 24)

## Agreement

- scored set: **6/6** (100.0%)
- including reconstruction failures: 7/8 (87.5%)
- trivial baseline (always answer `finished`): 0/6 (0.0%)

## Confusion (rows = label, columns = verdict)

| label | finished | not-finished | unjudgeable | n |
|---|---:|---:|---:|---:|
| finished | 0 | 0 | 0 | 0 |
| not-done | 0 | 1 | 0 | 1 |
| unjudgeable | 0 | 0 | 5 | 5 |

## false-finished — said finished, the label says the work was not done

**0 of 1** such rows.

## false-not-finished — said not-finished, the label says finished

**0 of 0** such rows.

## Rows the labels call `unjudgeable` (5)

- case 1 → **unjudgeable** — Task asked for an analysis, not a commit; empty diff is consistent with both a completed review and a no-op run.
- case 6 → **unjudgeable** — Deliverable was a stdout report never committed; only testimony given is 'DONE', no report content to check against the required sections.
- case 10 → **unjudgeable** — Deliverable is GitHub issues, task forbids commits, diff is empty either way; only testimony claims filing, which isn't evidence
- case 15 → **unjudgeable** — Deliverable is GitHub issues, not a commit; empty diff can't confirm or refute the run's own testimony about what it filed
- case 31 → **unjudgeable** — Task asked a question with no repo deliverable; empty diff can't distinguish a real answer from a no-op, and the final message is unverifiable testimony.

## Cost, wall clock, and diff size

- cost per verdict: median $0.0918, total $0.72 over 8
  - priced from measured totals at Sonnet list ($3/$15 per Mtok), 450 tokens of it treated as output
  - tokens per verdict: median 28788, min 26272, max 31276
- wall clock per verdict: median 18.3 s, min 15.8 s, max 24.9 s
- prompt size: median 16309 chars
- diff size (whole branch diff, before shortening): median null B, max -Infinity B over 0 non-empty
- shortened to fit: 0 of 8
- empty diffs: 8 · chained branches: 1

## Every verdict

| # | label | verdict | ok | diff | diff B | reason |
|---|---|---|---|---|---:|---|
| 1 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task asked for an analysis, not a commit; empty diff is consistent with both a completed review and a no-op run. |
| 2 | not-done | not-finished | ✓ | unattributed | 0 | Branch diff is empty; task required a committed fix, and the run's own testimony confirms nothing was committed. |
| 6 | unjudgeable | unjudgeable | ✓ | complete | 0 | Deliverable was a stdout report never committed; only testimony given is 'DONE', no report content to check against the required sections. |
| 10 | unjudgeable | unjudgeable | ✓ | complete | 0 | Deliverable is GitHub issues, task forbids commits, diff is empty either way; only testimony claims filing, which isn't evidence |
| 15 | unjudgeable | unjudgeable | ✓ | complete | 0 | Deliverable is GitHub issues, not a commit; empty diff can't confirm or refute the run's own testimony about what it filed |
| 24 | finished | not-finished | — | unattributed | 0 | Task demanded committed source/CLI/widget/schema/docs artefacts; branch diff is empty and repo started with nothing. |
| 31 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task asked a question with no repo deliverable; empty diff can't distinguish a real answer from a no-op, and the final message is unverifiable testimony. |
| 34 | not-done | not-finished | ✓ | complete | 0 | Empty diff; task required docs/08-track-b-shape.md and poc/README.md updates plus a commit, neither exists. |
