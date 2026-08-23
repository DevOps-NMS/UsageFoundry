import { db } from "./db";
import { newWorkPaused, setNewWorkPaused } from "./settings";
import {
  blockWaitingRun,
  getRun,
  promoteQueued,
  releaseDependents,
  reopenRun,
  stopRun,
  type RunRow,
  type RunStatus,
} from "./orchestrator";
import { haltSteps, stopInstance, type HaltReport } from "./workflows";

/**
 * The three things an operator running a fleet can do to it at once.
 *
 * Every stop in this app was per run or per workflow instance, and at
 * twenty-five unattended runs across many repositories that is twenty-five HTTP
 * requests through twenty-five pages — so the only install-wide control was
 * stopping the container, which discards every in-flight cycle's accounting.
 * This module adds the three missing ones and *composes* them out of the
 * transitions that already exist rather than inventing a fourth way for a run to
 * end:
 *
 *   - `stopFleet` walks workflow instances through the one door they already
 *     have (`stopInstance`) and the runs outside them through `stopRun` and
 *     `blockWaitingRun`, choosing between the two with the very same
 *     `haltSteps` a workflow halt uses. There is no new status, no new signal
 *     path and no second answer to "which rows does this take down".
 *   - The hold on new work is `settings.newWorkPaused`, read by the four places
 *     that start work and by nothing else. It is documented beside the flag.
 *   - `reopenFleet` is `reopenRun` in a loop over an explicit list of ids, with
 *     one budget laid over each run's own rather than in place of it.
 *
 * This module sits *above* both `orchestrator.ts` and `workflows.ts` and nothing
 * in either imports it, which is what keeps the graph acyclic. The flag itself
 * lives in `settings.ts` precisely because it has to be readable from below.
 */

/** Statuses a run has not finished in, including the one that holds nothing. */
const FLEET_STATUSES: readonly RunStatus[] = ["waiting", "queued", "running", "paused"];

/**
 * What a fleet stop is recorded as, on a run that belongs to no workflow.
 *
 * A **fragment** with no full stop, `stopRun`'s rule: each of its branches
 * appends the clause saying what the run was doing when the stop landed. It says
 * "every run in flight" rather than "by operator" because that is the one thing
 * distinguishing this afterwards from twenty-five separate presses of Stop, and
 * a run page read a week later has nothing else to go on.
 */
const FLEET_CAUSE = "Stopped by the operator with every run in flight";

export interface FleetStopReport {
  /** Runs whose child got the kill ladder. */
  signalled: string[];
  /** Runs closed out before they could spawn. */
  cancelled: string[];
  /** Runs that were still waiting, now `blocked`. */
  blocked: string[];
  /** Rows that moved between the decision and the write. */
  untouched: string[];
  /** Workflow instances halted whole, each through its own one door. */
  instances: HaltReport[];
}

/** Every run that has not finished, in creation order. */
function liveRuns(): RunRow[] {
  return db()
    .prepare(
      `SELECT * FROM runs WHERE status IN (${FLEET_STATUSES.map(() => "?").join(",")})
        ORDER BY created_at`,
    )
    .all(...FLEET_STATUSES) as RunRow[];
}

/** Workflow instances a halt would still act on. */
function startedInstances(): string[] {
  return (
    db()
      .prepare("SELECT id FROM workflow_instances WHERE status = 'started'")
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

/**
 * Stop everything: every workflow instance, then every run outside one.
 *
 * **Instances first, and each through `stopInstance`.** A workflow is not merely
 * a set of runs — it has orchestrator blocks, which *create* runs, and a block
 * left `thinking` while this walk ran could emit into a fleet that is being
 * taken down, every one of those runs arriving behind the walk. `stopInstance`
 * already closes that door before it signals anything, and reusing it is also
 * what keeps `workflow_instance_blocks`, the queued merges and the instance's
 * own recorded cause in step with the members.
 *
 * **Then waiting rows, before any live run is signalled**, which is `walkMembers`'
 * ordering for `walkMembers`' reason: stopping a run releases its dependents,
 * and a dependent released a moment before this reached it would be admitted,
 * promoted and spawned — a run starting *because* the fleet was stopped. The
 * whole walk is synchronous from the first instance to the last run, so nothing
 * can interleave with it.
 *
 * The one exposure this shares with a workflow halt is a queued run promoted by
 * an earlier stop inside the same turn: `promoteQueued` claims the row
 * synchronously, so the pass below sees it as `running` and `stopRun` reaches
 * it, and `startRun`'s pre-spawn checkpoint sees the interrupt before any child
 * exists. It costs a transcript scan, not a billed cycle.
 *
 * It does **not** set the hold on new work. That is a separate control and a
 * separate decision: an operator stopping a fleet to re-point it wants the
 * queue to carry on afterwards, and one that wants both presses both. The route
 * offers them together; this function does one thing.
 */
export function stopFleet(): FleetStopReport {
  const report: FleetStopReport = {
    signalled: [],
    cancelled: [],
    blocked: [],
    untouched: [],
    instances: [],
  };

  for (const instanceId of startedInstances()) {
    const outcome = stopInstance(instanceId, { kind: "fleet" });
    if (outcome.ok) report.instances.push(outcome.report);
  }

  // Re-read, because the walk above has just moved most of them — and because a
  // dependent of a halted member may have been released into the queue by it.
  const steps = haltSteps(liveRuns(), FLEET_CAUSE);

  for (const step of steps) {
    if (step.action !== "block") continue;
    if (blockWaitingRun(step.id, step.reason)) report.blocked.push(step.id);
    else report.untouched.push(step.id);
  }

  for (const step of steps) {
    if (step.action !== "stop") continue;
    const outcome = stopRun(step.id, FLEET_CAUSE);
    if (outcome === "signalled") report.signalled.push(step.id);
    else if (outcome === "cancelled") report.cancelled.push(step.id);
    else report.untouched.push(step.id);
  }

  return report;
}

/**
 * Set or clear the hold on new work.
 *
 * Clearing it re-asks both questions the hold suppressed, in the order the
 * ordinary path asks them: `releaseDependents` first, because a run it admits
 * joins the queue rather than starting there, and then `promoteQueued`, which is
 * where folder reservation, FIFO order and the concurrency cap live. Without
 * this pair the queue would sit still until the next terminal transition
 * happened to wake it, which on a fleet that has just been stopped is never.
 *
 * `tickSchedules` needs nothing here: its timer keeps running throughout and
 * decides again on its own cadence. Deliberately so — a schedule's missed
 * windows are recorded and not made up, and resuming the fleet is not a reason
 * to press Run for an occurrence that passed while it was held.
 */
export function setFleetPaused(paused: boolean): void {
  setNewWorkPaused(paused);
  if (!paused) {
    releaseDependents();
    promoteQueued();
  }
}

export interface FleetState {
  newWorkPaused: boolean;
  /** Runs not finished, by status. Every key is present, including zeroes. */
  counts: Record<RunStatus, number>;
  /** Workflow instances a stop would still act on. */
  startedInstances: number;
}

/** What the fleet is doing, for a page that has to say whether it is held. */
export function fleetState(): FleetState {
  const counts = {} as Record<RunStatus, number>;
  for (const status of FLEET_STATUSES) counts[status] = 0;
  for (const run of liveRuns()) counts[run.status] = (counts[run.status] ?? 0) + 1;
  return {
    newWorkPaused: newWorkPaused(),
    counts,
    startedInstances: startedInstances().length,
  };
}

export interface FleetReopenReport {
  reopened: string[];
  refused: Array<{ id: string; reason: string }>;
}

/**
 * Pick up several finished runs at once, under one budget.
 *
 * The list is the ids **the page displayed**, which is `POST /api/chat/[id]/approve`'s
 * rule and the same reasoning: a run that reached a terminal state between the
 * render and the click must not be swept into a reopen nobody saw. So there is
 * no "reopen everything failed" selector on the wire — the caller says which,
 * and `reopenRun` still refuses each one on its own terms and by name.
 *
 * The ids the page displayed are still only the page's answer, though, and one
 * of them may be a run the operator has since held back: `set_aside_at` is
 * checked here, against the row, at the moment of the write. Same rule the
 * server lock follows — a list is a reading, and a reading is stale.
 *
 * One budget for all of them, because the usual reason a fleet needs picking up
 * is one thing that ended all of it — a restart, a wall, a spending limit set too
 * low — and re-entering the same numbers twenty-five times is what makes the
 * existing route unusable at this scale rather than merely tedious. The per-run
 * refusals are unchanged: a run that has already used the cycles this budget
 * allows is still refused, and still says so.
 *
 * That one budget is **merged over each run's own stored blob rather than
 * substituted for it**, and the difference is the whole of this function's
 * correctness. `reopenRun` writes `budget=?` from the policy it is handed, so
 * handing it the sheet's two fields would rewrite every run's ceilings to the
 * two the sheet happens to expose and silently drop the rest — a time limit, a
 * token limit, an enforcement mode the operator chose per run, gone on a press
 * aimed at the cycle cap. Spreading the wire over the stored blob keeps an
 * explicit answer explicit (a blank cycle cap arrives as `null` and means "no
 * cycle limit" here exactly as it does anywhere else) while a field the sheet
 * never asked about keeps the value that run was started with. `permissionMode`
 * is untouched by this: it rides on the stored blob, `normalizePolicy` drops it,
 * and `reopenRun` reads it back off the row — reopening is not a second route
 * to `--permission-mode` and merging must not make it one.
 *
 * Sequential and synchronous, `approveProposal`'s rule: `createRun`'s folder
 * claim and `reopenRun`'s checkout check are only atomic inside one event-loop
 * turn, and two runs reopened into one checkout is exactly what that check
 * exists to stop.
 */
export function reopenFleet(
  ids: readonly string[],
  budget: unknown,
): FleetReopenReport {
  const report: FleetReopenReport = { reopened: [], refused: [] };
  const seen = new Set<string>();
  const wire = (budget ?? {}) as Record<string, unknown>;

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const run = getRun(id);
    if (!run) {
      report.refused.push({ id, reason: "No such run." });
      continue;
    }
    // Refused here rather than inside `reopenRun`, and that split is the whole
    // design of the flag: setting a run aside answers the *bulk* pick-ups, so
    // its own page must go on offering Resume — and pressing that is the
    // decision being taken back, which is why `reopenRun` clears the column
    // instead of reading it. Named in the report rather than skipped, because
    // the count on the button came from a list rendered before this press and
    // an operator who set one aside a moment ago is owed the sentence saying so.
    if (run.set_aside_at !== null) {
      report.refused.push({
        id,
        reason: "Set aside. Pick it up on its own page if you want it back.",
      });
      continue;
    }
    // The sheet's fields over this run's own, never in place of them. Parsed
    // unguarded for `reopenRun`'s reason: every `runs.budget` this app writes
    // is JSON it wrote itself, and a row that is not is a corrupted database
    // rather than a refusal to word.
    const stored = JSON.parse(run.budget) as Record<string, unknown>;
    const outcome = reopenRun(id, { ...stored, ...wire });
    if (outcome.ok) report.reopened.push(id);
    else report.refused.push({ id, reason: outcome.reason });
  }

  return report;
}
