# Method

What was read, what was run and what it printed, and what could not be reached.

## The rule this survey held itself to

Every row in [05-register.md](05-register.md) points at a file and line, a
command whose output is quoted here, or a documented invariant it contradicts.
A candidate that could not be tied to one of those three was dropped, and every
drop is listed in [§ Dropped for lack of evidence](#dropped-for-lack-of-evidence)
rather than left out silently — a register that only shows its survivors reads
as exhaustive when it is not.

A gap that `docs/agent/` records as a deliberate choice is not a gap. Three
candidates died that way and are named in
[§ Refuted or already decided](#refuted-or-already-decided).

## Commands run, and their output

All from `/workspace/.uf-worktrees/usagefoundry-721638d11c0b-1`, a linked
worktree level with `origin/main` at `175ba57`, on 2026-08-23. Dependencies
installed with `NODE_ENV=development npm ci --include=dev`, because a bare
`npm ci` under this image's `NODE_ENV=production` exits 0 having skipped
devDependencies and the two scripts below then fail with exit 127.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0, no output beyond the banner |
| `npm test` | `# tests 1578`, `# suites 230`, `# pass 1578`, `# fail 0`, `# skipped 0`, `# duration_ms 16537.254841` |
| `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` | exit 0 |
| `npm audit` | `3 high severity vulnerabilities` |

The tree is green. Nothing in this register is a broken build, a failing test or
a type error, and that is the point of running the loop first: what follows is
what a green tree does not tell you.

`npm audit`'s three, verbatim from its tail:

```
node_modules/next/node_modules/postcss
  next  9.3.4-canary.0 - 16.3.0-preview.10
  Depends on vulnerable versions of postcss
  Depends on vulnerable versions of sharp
  node_modules/next

sharp  <0.35.0
Severity: high
sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328,
CVE-2026-35590, CVE-2026-35591
...
Will install next@16.3.2, which is a breaking change
```

Those three are **not** a register row. `.github/workflows/ci.yml:126-163`
accepts them on the record, advisory by advisory, and the argument is set out in
[03-growth.md](03-growth.md#refuted-on-this-axis).

### One probe, run to refute a suspicion rather than to confirm one

GitHub issue #68 suspects that `run_deps` is queried by `run_id` without an
index. It is not. From `.data/usagefoundry.db` — the stale in-checkout copy,
which is fine for a plan because the schema is what is being asked about:

```
sqlite> EXPLAIN QUERY PLAN SELECT * FROM run_deps WHERE run_id = 'x';
SEARCH run_deps USING COVERING INDEX sqlite_autoindex_run_deps_1 (run_id=?)
```

The composite `PRIMARY KEY (run_id, depends_on)` at `src/lib/db.ts:344-351`
creates that autoindex, and `run_id` is its leading column. The explicit
`idx_run_deps_depends_on` at `:655-656` covers the other direction. Both
directions are indexed; the suspicion is wrong and is not in the register.

A shell script was copied into the repository root to run this — `/tmp` is
outside the module resolution root, so `require("better-sqlite3")` from there
fails with `ERR_MODULE_NOT_FOUND` — and deleted in the same command. `git
status` is clean.

## What was read

- `CLAUDE.md` in full, and every file in `docs/agent/` — `architecture.md`,
  `metering.md`, `budgets-and-guards.md`, `run-lifecycle.md`,
  `concurrency-and-ownership.md`, `retention.md`, `dependencies.md`,
  `isolation-and-landing.md`, `agents-and-templates.md`, `chat.md`,
  `workflows-and-schedules.md`, `git-and-review.md`, `security.md`,
  `conventions.md`, `environment.md`, `testing.md`.
- `docs/verification.md`, in particular its "Not yet verified by hand" list from
  `:1033`. Four of the twenty-two register rows lean on it.
- `proposals/README.md` and the READMEs of all five existing proposals. Their
  open questions are owned and are excluded by name in
  [06-recommendation.md](06-recommendation.md#the-five-existing-proposals-questions).
- `HEALTH-CHECK.md`, the dated audit at `267b901`, 2026-08-11. Every finding
  taken from it was re-checked against this tree; several are fixed.
- Open and closed GitHub issues via
  `export GH_PAGER=cat; gh issue list --repo Xapicc/UsageFoundry --state all
  --limit 300 --json number,title,state`, then `gh issue view` on the twelve
  named in the brief plus the umbrella sweeps. That loop's output was 105.4 KB
  and exceeded the tool result limit; it was persisted and read back in
  sections.
- The operator's vault at `/workspace2`, which **is** readable from this
  checkout. Notes cited by path where used; nothing was written into it.
- Source: `orchestrator.ts` (9,710 lines) in the regions the register cites
  rather than whole, `chat.ts` (2,397), `land.ts` (2,708), `workflows.ts`
  (6,010) likewise, and `settings/page.tsx` (3,502), `runs/page.tsx`,
  `chat/page.tsx`, the `src/app/api/` route handlers, `src/components/shell/`,
  `src/components/ui/`, `config.ts`, `db.ts`, `requestLog.ts`, `otlp.ts`,
  `transcripts.ts`, `workspace.ts`, `mergeQueue.ts`, `settings.ts`.

## What could not be reached

- **The live install's `runs` table.** `DATA_DIR` is not readable by the agent
  uid. `.data/usagefoundry.db` inside the checkout is a stale copy last written
  2026-08-19 and was used **only** for the schema probe above. No row in this
  register rests on a count of real runs, a real run's duration, or a real
  ending status. Where a figure like that would have decided a rank, the row
  says so and the rank is held down accordingly — this is the single largest
  hole in the survey and it is the same hole ModelRouter records.
- **Docker.** Not available in this container, so nothing here was checked
  against a running container, a real fleet, or the image's `HEALTHCHECK`.
- **A browser.** None was driven, at any viewport. Every claim about what a page
  renders comes from reading its source or from `docs/verification.md`, and
  [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) is precisely about the fact that nothing else in this
  repository does either.
- **A linter.** There is none; `eslint.ignoreDuringBuilds` is on. No row here is
  a lint finding.

## What was deliberately left unread

Named so the next reader knows where the survey stops rather than assuming it
stopped nowhere.

- `orchestrator.ts` outside the guard sites, the run loop, the queue selections
  and `createRun` — roughly two thirds of the file.
- `workflows.ts` outside `advanceInstances`, `planLoopPass` and the instance
  status derivation.
- `src/lib/windows.ts`, `pricing.ts`, `planUsage.ts` and `repoSpend.ts` beyond
  their doc invariants. The metering axis is the best-documented area in the
  repository and ContextControl and ModelRouter have both already surveyed it
  with real measurements this survey cannot take.
- `src/app/branches/page.tsx`, `WorkflowEditor.tsx` and `canvasGraph.ts` beyond
  what the caps refuted in
  [03-growth.md](03-growth.md#refuted-on-this-axis) required.
- The 200-odd closed issues, except the ones the umbrella sweeps reference.

## Refuted or already decided

Candidates that looked like gaps and are not. They are recorded here rather than
in the register because a register row implies work is owed.

**`run_deps` is unindexed on `run_id`** (#68, finding 1). Refuted by the
`EXPLAIN QUERY PLAN` above.

**`advanceInstances` is a floating promise that creates runs** (#68, finding 2).
It is floating, and deliberately so, with a `.catch()` and four lines of reason
at `src/lib/orchestrator.ts:3933-3942`: *"deliberately not awaited: the advance
is its own synchronous pass in a later turn, so nothing it does can interleave
with a folder claim being made in this one."* That is the
`concurrency-and-ownership.md` invariant about `createRun` running from entry to
INSERT with no `await`, holding. Awaiting it would be the bug.

**Keyboard shortcuts are `⌘`-only.** `isPlainCommandChord` in
`src/components/shell/shortcuts.ts` requires `metaKey`, which strands a Linux or
Windows operator — except the affordance is reachable without it:
`src/components/shell/Toolbar.tsx:115-135` renders a visible Quick open button
carrying `aria-keyshortcuts="Meta+K"`. `docs/agent/conventions.md` records the
chord restriction as a decision. Not a gap.

**No time-series chart of spend.** The data is rendered — `UsagePeriods.tsx` and
`/account` show it as tables with meters, and `docs/agent/metering.md` is
explicit that an unknown ceiling renders as a hatched indeterminate meter rather
than a bar. Wanting a line chart instead is polish, and the brief asked the
missing-features axis for capability rather than polish.

**Accessibility is unaddressed.** Attribute coverage in `src/components/` is
strong on inspection. The operator's own note —
`3 Resources/Web Design/Automated Accessibility Testing Coverage.md`, confidence
medium, updated 2026-08-23 — is a warning against exactly the claim a survey
would want to make here: automated coverage lands somewhere between 13% and
57.38% of real issues depending which denominator you pick, so neither a green
scan nor an unrun one is a verdict. The honest finding is [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything),
which is about nothing being checked at all, not about accessibility specifically.

## Dropped for lack of evidence

Six candidates that are plausible and are not in the register, because nothing
in the tree or in a command's output establishes them.

1. **Long-run memory pressure in `orchestrator.ts`'s event buffers.** Would need
   a live process to measure; `retention.ts` bounds the persisted side and the
   in-memory side was not read closely enough to claim anything.
2. **Whether the 100-run list is actually hit on the live install.** That is a
   `SELECT COUNT(*) FROM runs`, and `DATA_DIR` is unreadable.
   [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) is argued from the cap's existence and the page's own
   admission, never from a row count.
3. **Query performance anywhere.** No `EXPLAIN` beyond the one refutation, no
   timings, and better-sqlite3 is synchronous so a slow query blocks the
   process. Suspected; not measured; not filed.
4. **Whether the merge queue's four workers have ever collided.** Needs run
   history. [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) argues the guard's *scope* from the
   code, which is verifiable, and does not claim an incident.
5. **Whether any operator has wanted a pull request.** [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request)
   argues the capability is absent, which is verifiable, and marks its own
   demand as assumed.
6. **Whether the settings page is slow to render at 3,502 lines.** No profile
   was taken. [F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field) argues findability, not performance.

## The vault

`/workspace2` is readable. Notes used, each cited again at the point of use:

| Note | Used by |
|---|---|
| `3 Resources/Testing and Correctness/The Test Pyramid.md` | [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) |
| `3 Resources/Web Design/Automated Accessibility Testing Coverage.md` | [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything), and the refutation above |
| `3 Resources/Data and Storage/When an Embedded Database Stops Being the Right Answer.md` | [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person) |
| `3 Resources/Software Security/Authentication versus Authorisation.md` | [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation) |
| `3 Resources/Software Security/Secrets Management.md` | [M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) |
| `3 Resources/Debugging and Observability/SLOs and Error Budgets.md` | [M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) |

The two notes in `3 Resources/Questions/Inbox` that name UsageFoundry were read.
Both are ContinuousImprovement and ContextControl territory — cross-run memory
and what a cycle carries — and neither opens a question those two proposals do
not already own, so nothing in this register cites them as new.

Each note carries its own confidence and grade. Where one is thin — the SLO note
rests on a single vendor book with no replication, and the test-pyramid note's
cost claim is supported while its ratios were never measured — the row using it
says so rather than borrowing certainty the note does not have.
