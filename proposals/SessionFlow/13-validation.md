# Validation

What was checked, how, what would count as this survey having been wrong, and
what nobody here could check at all.

## The one number that decides everything

Every argument against a picture in this directory is an argument about node
counts, and **no node count was measured**. This is the query. It is one line, it
needs a running install, and it should be run before
[08-option-g](08-option-g-cycle-heatmap.md) is built or
[06-option-e](06-option-e-file-tool-graph.md)'s refusal is trusted a second time:

```sql
SELECT run_id,
       COUNT(DISTINCT json_extract(payload, '$.input.file_path')) AS files,
       COUNT(*) AS calls
  FROM run_events
 WHERE kind = 'tool'
   AND json_extract(payload, '$.input.file_path') IS NOT NULL
 GROUP BY run_id
 ORDER BY files DESC;
```

Read the **median** and the **90th percentile** of `files`.

| Reading | What it means |
|---|---|
| median under ~60 | The grid ([08](08-option-g-cycle-heatmap.md)) fits. Build it after the table and do not re-survey it |
| median 200–800 **with directory clustering** | The refusal in [06](06-option-e-file-tool-graph.md) still stands for a *force* graph, but a treemap or indented tree over the path hierarchy becomes a serious option this survey never weighed, because it could not know its premise held |
| median over ~2000 | `MAX_DRAWN_NODES = 2500` (`src/lib/knowledgeGraph.ts:705`) is in reach, `capGraph` starts pruning, and every visual option is dead — the table is the only thing that degrades gracefully |

The first slice prints this number in its header (criterion 11,
[12-recommendation.md](12-recommendation.md#acceptance-criteria)), which is the
cheapest way to get it: no query to run by hand, no container to open.

## What was verified, and how

Every claim in this directory carries a `file.ts:42`. These are the ones that
were checked rather than accepted, because each was load-bearing enough that
being wrong about it would move a recommendation.

| Claim | How it was checked | Result |
|---|---|---|
| File paths survive storage | Read `clipToolInput` (`logLine.ts:145-189`) and its shipped tests (`retention.test.ts:44-118`) | **Confirmed.** Field-aware, not a byte slice; `command` first and `file_path` second in `HEADLINE_FIELDS` |
| The extraction query works | Read `readCountsFor` (`fileCostNotice.ts:328-363`) | **Confirmed, and it is already in production** for a different consumer |
| No `tool_use` id on the `tool` row | Read the emit site (`orchestrator.ts:7547-7595`) | **Confirmed.** `b.id` goes into an in-process map at `:7562` and never into the payload |
| Success is never recorded | `orchestrator.ts:7343-7344`, `apiTypes.ts:1695` | **Confirmed**, and it is a stated decision with a stated reason |
| A tenth pane is banned | `docs/agent/ui-density-audit.md:159-170` | **Confirmed**, including the precedent that shows why the ninth was allowed |
| The run strip is capped at five | `docs/agent/conventions.md:50`, `ui-density-audit.md:1122`, and the array at `src/app/runs/[id]/page.tsx:958-970` | **Confirmed by three independent sources** |
| `canvasView.ts` does not exist | `glob src/lib/canvasView.ts` → no files; `grep -rn canvasView src/` → one hit, the comment claiming it exists | **Confirmed** |
| `run_events` is swept | `src/lib/retention.ts:145-151` read against `orchestrator.ts:9876`'s claim that it is not | **Confirmed swept**; the comment is stale |
| Only a run has an event log | `grep -c "run_events\|emit(" src/lib/chat.ts` → **0**; the `chat_*` and `workflow_instance_*` tables at `src/lib/db.ts:26,390,419,463,550,598,1171` | **Confirmed.** A chat has no tool-call log of any kind |
| The graph caps | `knowledge.ts:109` (4000, wire), `knowledgeGraph.ts:705` (2500, drawn), `forceLayout.ts:18-26` (4000 in prose, enforced nowhere in that file) | **Confirmed**, and the brief's likely reading — that `forceLayout` enforces 4000 — is wrong |

Two of the brief's own leads were **wrong and are corrected in the text**:

- *"`clipToolInput` in `src/lib/retention.ts`"* — it is in
  `src/lib/logLine.ts:145-189`. Only its test lives in `retention.test.ts`.
- *"a `Read` that failed and a `Read` that succeeded may be indistinguishable"* —
  they are distinguishable, by a separate `kind: "tool_error"` row
  (`orchestrator.ts:7621-7626`). The real problem is narrower and worse: the two
  rows share no key, so the failure cannot be attributed to a specific call
  ([F3](00-problem.md#f3)).

And one of the brief's framings was resolved rather than split: *"a new tab on
the left" versus "a sixth tab on the run page"* is not a fork with two live
branches. **Both are banned**, by different documents, neither marginally.

## What would count as this survey having been wrong

1. **A run's touched-file count comes back in the low hundreds with real
   directory clustering.** The force-graph refusal survives — the edges are
   still hub spokes — but the survey would have missed a hierarchy option it
   never weighed. This is the most likely way to be wrong and it is the reason
   the number is criterion 11 rather than a follow-up.
2. **Nobody opens the table twice.** If the three questions in
   [02-option-a](02-option-a-change-nothing.md#what-beats-it) turn out not to be
   questions anyone actually has, the recommendation was a better-argued version
   of building the wrong thing, and the null was right.
3. **`changedNotTouched` is empty on every run.** The group leading the table is
   the one predicted to be most interesting. If `Bash`-driven writes and aged-out
   events never produce one, the table has three groups and a weaker case.
4. **The operator wanted the picture more than the answer.** Legitimate, and not
   something a document can settle. [08-option-g](08-option-g-cycle-heatmap.md)
   is the honest picture and it is deferred rather than refused precisely so this
   ending has somewhere to go.

## What could not be checked here

- **No stored payload was seen.** `/data` is readable and empty; no `*.db` or
  `*.sqlite*` exists in the checkout outside `node_modules`; `DB_PATH` would be
  `DATA_DIR/usagefoundry.db` (`src/lib/config.ts:283`) and no `.data/` exists in
  this worktree. Every payload shape here is read from the emit site. **No
  `run_events` row was ever quoted, because none was reachable.**
- **No browser, no container.** Docker is unavailable in this environment.
  Nothing in this directory is a judgement about how anything looks; "hairball"
  is an argument from node counts and `capGraph`'s pruning rule, never from
  having seen one.
- **No cost figure.** Every timing quoted — 38 ms over 131,572 rows
  (`fileCostNotice.ts:296-297`), ~250 frames to settle (`forceLayout.ts:93`) — is
  read from a source comment recording somebody else's measurement, not taken
  here.
- **Whether any run delegates at all.** `src/lib/logLine.ts:32-34` says outright
  that this is unmeasured, which is why
  [07-option-f](07-option-f-delegation-tree.md) survives only as a column.

## Repository checks

Run on the tree this was written against, to prove a prose-only branch broke
nothing.

| Command | Result |
|---|---|
| `NODE_ENV=development npm ci --include=dev` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm test` | **1,796 tests / 265 suites / 0 failures** in 16.5 s |

`NODE_ENV=development` is load-bearing: this environment sets
`NODE_ENV=production`, under which a bare `npm ci` exits 0 having silently
skipped devDependencies, and both scripts then fail with exit 127 for a reason
that has nothing to do with the change. `CLAUDE.md` records the trap.

No file outside `proposals/SessionFlow/` was touched, so a green tree says
nothing about whether this proposal is right — only that it is inert.
