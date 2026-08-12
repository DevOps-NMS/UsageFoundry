import type {
  WorkflowDTO,
  WorkflowInstanceDTO,
  WorkflowInstanceNodeDTO,
} from "@/lib/apiTypes";
import {
  lastRunAt,
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

export function workflowDTO(workflow: Workflow): WorkflowDTO {
  return {
    id: workflow.id,
    name: workflow.name,
    nodes: workflow.graph.nodes,
    edges: workflow.graph.edges,
    instanceBudget: workflow.instanceBudget,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    liveRunCount: liveRunsOf(workflow.id).length,
    lastRunAt: lastRunAt(workflow.id),
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
    waitsFor: waits.get(n.nodeId) ?? [],
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
  };
}
