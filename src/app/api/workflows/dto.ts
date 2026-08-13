import type {
  WorkflowDTO,
  WorkflowInstanceBlockDTO,
  WorkflowInstanceDTO,
  WorkflowInstanceNodeDTO,
  WorkflowScheduleDTO,
} from "@/lib/apiTypes";
import { getSchedule, scheduleView, type ScheduleView } from "@/lib/schedules";
import {
  lastRunAt,
  liveBlocksOf,
  liveRunsOf,
  runStateOf,
  type Workflow,
  type WorkflowInstance,
} from "@/lib/workflows";

/**
 * The wire shapes, in one place so the five routes cannot disagree about them.
 *
 * The same job `src/app/api/chat/dto.ts` does, and shaped the same way: the
 * server types carry a nested `graph`, the DTO flattens it, and the client
 * never imports a module that opens SQLite.
 */

export function scheduleDTO(view: ScheduleView): WorkflowScheduleDTO {
  return {
    spec: view.spec,
    timeZone: view.timeZone,
    paused: view.paused,
    description: view.description,
    nextFireAt: view.nextFireAt,
    lastCode: view.lastCode,
    lastReason: view.lastReason,
    lastAt: view.lastAt,
    lastFireAt: view.lastFireAt,
    lastInstanceId: view.lastInstanceId,
    streak: view.streak,
    streakSince: view.streakSince,
    refusal: view.refusal,
  };
}

export function workflowDTO(workflow: Workflow): WorkflowDTO {
  const schedule = getSchedule(workflow.id);
  return {
    id: workflow.id,
    name: workflow.name,
    nodes: workflow.graph.nodes,
    edges: workflow.graph.edges,
    instanceBudget: workflow.instanceBudget,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    liveRunCount: liveRunsOf(workflow.id).length + liveBlocksOf(workflow.id),
    lastRunAt: lastRunAt(workflow.id),
    schedule: schedule ? scheduleDTO(scheduleView(schedule, workflow)) : null,
  };
}

export function instanceDTO(instance: WorkflowInstance): WorkflowInstanceDTO {
  // Read off the instance's own graph snapshot, not the live workflow: the
  // blocks may have been renamed or rewired since, and this is a record of what
  // ran.
  const waits = new Map<string, string[]>();
  for (const edge of instance.graph.edges) {
    const list = waits.get(edge.to);
    if (list) list.push(edge.from);
    else waits.set(edge.to, [edge.from]);
  }

  const nodes: WorkflowInstanceNodeDTO[] = instance.nodes.map((n) => ({
    nodeId: n.nodeId,
    nodeName: n.nodeName,
    position: n.position,
    runId: n.runId,
    run: runStateOf(n.runId),
    // A run an orchestrator block emitted is in no edge of the saved graph — it
    // did not exist when the graph was written — so what it waits for is read
    // off the block that started it instead.
    waitsFor: n.emittedBy
      ? [n.emittedBy]
      : (waits.get(n.nodeId) ?? []),
    emittedBy: n.emittedBy,
  }));

  const blocks: WorkflowInstanceBlockDTO[] = instance.blocks.map((b) => ({
    nodeId: b.nodeId,
    nodeName: b.nodeName,
    position: b.position,
    kind: b.kind,
    status: b.status,
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
    costUSD: b.costUSD,
    emitted: b.emitted,
    error: b.error,
    waitsFor: waits.get(b.nodeId) ?? [],
  }));

  return {
    id: instance.id,
    workflowId: instance.workflowId,
    workflowName: instance.workflowName,
    createdAt: instance.createdAt,
    status: instance.status,
    error: instance.error,
    stoppedAt: instance.stoppedAt,
    stopCause: instance.stopCause,
    stopReason: instance.stopReason,
    liveRunCount: instance.liveRunCount,
    instanceBudget: instance.instanceBudget,
    spentUSD: instance.spend.spentUSD,
    spentGuardUSD: instance.spend.spentGuardUSD,
    nodes,
    blocks,
  };
}
