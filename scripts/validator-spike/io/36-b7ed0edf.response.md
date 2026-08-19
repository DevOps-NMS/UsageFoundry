The diff (branch-wide, per the evidence note, but this run's task is "Implement WF2" and the 7 attributed commits span exactly this feature end to end) delivers every named piece: `InstanceBudgetDTO` with `maxInstanceCostUSD`/`maxSessionFraction`/`maxWeeklyFraction` in `apiTypes.ts`; a `workflows`/`workflow_instances`.`instance_budget` migration in `db.ts` plus `runs.active_started_at` to feed telemetry-based in-flight spend into the guard; `orchestrator.ts` wiring an `enforceInstanceBudget` call between cycles (the between-nodes check the task asked for), emitting a `scope: "workflow"` budget event and routing a trip through the existing `stopInstance` halt path rather than a new one; `route.ts` refusing `no_ceiling` at Run via `currentSnapshot()`; `WorkflowEditor.tsx` as the only place the limits can be set (with a warning when no ceiling exists to measure against); and README/CLAUDE.md sections documenting the between-nodes bound, the deliberate absence of a live mode, and the deliberate absence of a terminus. `budget.test.ts` contains all six scenarios the task's Tests section names, matched almost verbatim: cap not reached, reached exactly, reached with a run in flight, no-ceiling refusal, fallback-under-limit after tripping, and estimate-only spend. `budget.ts`, `workflows.ts` and `CLAUDE.md` bodies are omitted from the patch, but the diffstat lists them as changed and the test surface (`evaluateInstanceBudget`, `normalizeInstanceBudget`, `INSTANCE_ENFORCEABLE_CODES`, shared codes `session_fraction`/`weekly_fraction`/`no_ceiling`) confirms the implementation exists and reuses the run-level code vocabulary rather than inventing a parallel one. I cannot confirm `npm test`/`npm typecheck` actually passed — no command output is in evidence — but the task's own bar for a diff-only judgement is presence, not passing, and every named deliverable is present and consistent with the spec.

```json
{
  "verdict": "finished",
  "reason": "All named deliverables present: instance budget DTO/migration/orchestrator wiring/UI/docs, and all 6 required test scenarios in budget.test.ts",
  "evidence": [
    "src/lib/apiTypes.ts: InstanceBudgetDTO with maxInstanceCostUSD/maxSessionFraction/maxWeeklyFraction",
    "src/lib/db.ts: migrate() adds workflows.instance_budget, workflow_instances.instance_budget, runs.active_started_at",
    "src/lib/orchestrator.ts: enforceInstanceBudget(id, snapshot) called before each cycle, emits scope: 'workflow' budget event, routes through existing stopInstance",
    "src/app/api/workflows/[id]/run/route.ts: currentSnapshot() passed to startWorkflow to refuse no_ceiling at the door",
    "src/components/WorkflowEditor.tsx: only place instanceBudget fields are set, with no-ceiling warning",
    "src/lib/budget.test.ts: 6 tests matching task's exact list (cap unreached, reached exactly, in-flight, no ceiling, fallback under limit, estimate-only spend)",
    "README.md 'Limits for the whole workflow' and CLAUDE.md diffstat (43554 bytes, omitted body) documenting live-mode and terminus decisions",
    "budget.ts and workflows.ts patch bodies omitted from evidence (shortened) but diffstat confirms both changed"
  ]
}
```
