import { randomUUID } from "node:crypto";
import { db } from "./db";
import { composeTask } from "./chat";
import {
  DEPENDENCY_EDGES,
  blockWaitingRun,
  createRun,
  dependencyCycle,
  getRun,
  probeIsolation,
  promoteQueued,
  releaseDependents,
  resolveWorkspaceFolder,
  stopRun,
  type CreateRunInput,
  type DependencyEdge,
  type DependencyLink,
  type RunStatus,
} from "./orchestrator";
import { cancelQueuedFor } from "./mergeQueue";
import { chatGuards, type RunGuards } from "./settings";
import { getTemplate, listTemplates, type RunTemplate } from "./templates";
import { WORKSPACE_MOUNTS } from "./config";
import { MAX_WORKFLOW_NAME, MAX_WORKFLOW_NODES } from "./apiTypes";

/**
 * A saved, re-runnable graph of run blocks.
 *
 * The third thing in this app that is **form input, never a run** — after
 * `run_templates` and `chat_proposals`, and it follows both of them exactly. A
 * workflow holds no folder claim, consumes no concurrency slot, and nothing
 * derived from `activeRuns()` can see it. Pressing Run is what turns it into
 * runs, and from that moment the runs carry every value themselves: editing or
 * deleting the workflow afterwards cannot reach them.
 *
 * **A node holds the work, and something a person wrote holds the guards.** A
 * node names a template for its budget, permission mode and isolation, or names
 * none and takes `settings.chatDefaultGuards` — which is `planProposal`'s rule,
 * reused rather than restated. Nothing on a node sets a guard, and there is
 * deliberately no `permissionMode` column here: `--permission-mode` is narrowed
 * three times in this codebase already, `reopenRun` refuses to become a third
 * route to it, and a workflow node would be a fourth. A node naming a template
 * that has since been deleted is refused **by name** at instantiation rather
 * than falling back to the untemplated guard set, for the reason a proposal is:
 * the operator saved a graph that said "under these guards", and a run started
 * under different ones is what this gate exists to prevent.
 *
 * What a node *does* hold is the work — the mount, the folder, the task, and an
 * optional prompt override. The mount and folder are on the node rather than
 * inherited from the template, unlike a proposal's: a proposal is approved
 * minutes after it is written, where a workflow is saved once and run for
 * months, and a template edited in between would silently move a node's run to
 * a different repository with nothing in the graph changing.
 */

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

/** One block of work: a task, where it runs, and the guards it runs under. */
export interface WorkflowNode {
  /**
   * Stable within this graph and referenced by every edge. Supplied by the
   * editor rather than minted here, because the edges are written against it in
   * the same form submission.
   */
  id: string;
  /** What the operator calls this step. Shown wherever a node is named. */
  name: string;
  /** The template supplying every guard, or null for `chatDefaultGuards`. */
  templateId: string | null;
  mountId: string;
  /** Path within the mount. `""` is the mount root, and is a real answer. */
  folder: string;
  /** What this block is asked to do. */
  task: string;
  /**
   * Standing instructions this node's task is appended to, replacing the
   * template's prompt for this one node. Prompt text is the half of a run that
   * is *work* rather than permission, which is why this is here and a budget
   * is not — the same split `chat_proposals.prompt_override` makes.
   */
  promptOverride: string | null;
}

/** "Start `to` after `from` has settled." */
export interface WorkflowEdge {
  from: string;
  to: string;
  edge: DependencyEdge;
  /** Whether `to` carries on `from`'s branch instead of cutting a new one. */
  continueBranch: boolean;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowInput {
  name: string;
  graph: WorkflowGraph;
}

export interface Workflow extends WorkflowInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** What a node's template contributes to validation, and nothing else. */
export interface TemplateFacts {
  name: string;
  isolate: boolean;
}

/**
 * Everything `normalizeWorkflowInput` compares a graph against.
 *
 * Injected rather than read, for the reason `planProposal` takes its template as
 * an argument: the whole decision is then pure and testable, and the two callers
 * — the save route and the instantiation — pass the *same* knowledge read at
 * two different moments, which is what makes "saved but no longer startable" a
 * sentence rather than a surprise.
 */
export interface WorkflowKnowledge {
  templates: ReadonlyMap<string, TemplateFacts>;
  mountIds: readonly string[];
  /** Whether `settings.chatDefaultGuards` isolates — a node naming no template. */
  defaultIsolate: boolean;
}

export type WorkflowNormalization =
  | { ok: true; value: WorkflowInput }
  | { ok: false; error: string };

/** Node ids travel in messages and are React keys; keep them readable. */
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_NODE_NAME = 60;

/* ------------------------------------------------------------------ */
/* Order — pure, and the reason this file has a test                   */
/* ------------------------------------------------------------------ */

/**
 * The order the runs are created in: every node after everything it waits for.
 *
 * Kahn's algorithm, with ties broken by the node's position in `nodes` — the
 * order the operator arranged them in. The determinism is not a nicety: runs
 * are admitted oldest-first and a queued run reserves its folder against
 * everything younger, so an unstable order would make two presses of Run on one
 * graph produce two different queues on the same repository.
 *
 * `unplaced` is every node the pass could not reach: a member of a dependency
 * loop, or anything waiting on one. Nothing downstream of a loop can ever start
 * — `releasableRuns` reaches a fixed point and leaves those rows asleep for
 * ever — so a graph that produces any is refused at the door rather than
 * instantiated into runs that will sit `waiting` until someone notices.
 *
 * Defensive about edges naming nodes that are not here: validation refuses
 * those separately, and an order that silently mis-sequenced a graph would
 * start an agent before the work it extends exists.
 */
export function topologicalOrder(graph: WorkflowGraph): {
  order: string[];
  unplaced: string[];
} {
  const known = new Set(graph.nodes.map((n) => n.id));
  const seen = new Set<string>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const n of graph.nodes) incoming.set(n.id, 0);

  for (const e of graph.edges) {
    if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) continue;
    // A repeated pair is one dependency stated twice, not two: counted twice it
    // would leave its dependent unplaceable and report a healthy graph as a loop.
    const key = `${e.from} ${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    const list = outgoing.get(e.from);
    if (list) list.push(e.to);
    else outgoing.set(e.from, [e.to]);
  }

  const order: string[] = [];
  // Re-scanned each pass rather than kept as a queue, which is what makes the
  // tie-break the declaration order instead of the order things were released.
  // A placed node is marked -1, so it can never match again however many
  // successors are decremented afterwards.
  for (;;) {
    const next = graph.nodes.find((n) => incoming.get(n.id) === 0);
    if (!next) break;
    order.push(next.id);
    incoming.set(next.id, -1);
    for (const to of outgoing.get(next.id) ?? []) {
      incoming.set(to, (incoming.get(to) ?? 0) - 1);
    }
  }

  return {
    order,
    unplaced: graph.nodes.filter((n) => !order.includes(n.id)).map((n) => n.id),
  };
}

/* ------------------------------------------------------------------ */
/* Validation — pure                                                   */
/* ------------------------------------------------------------------ */

/**
 * Read a workflow off the wire, refusing anything that could not be run.
 *
 * Never throws, and every refusal names something the operator can change —
 * usually by the node's own name, because a graph is read as a list of steps and
 * "node 3" is a thing only the editor can see. It is deliberately as strict as
 * instantiation: a workflow that can be saved and never started fails weeks
 * away from the form that caused it, which is the reasoning
 * `normalizeTemplateInput` already applies to the `no_terminus` pair.
 *
 * The one check it does *not* do is whether the folder is there — that is a
 * syscall, and this is pure. The save route runs `resolveWorkspaceFolder` for
 * every node immediately after this, which is the same call `createRun` will
 * make.
 */
export function normalizeWorkflowInput(
  raw: unknown,
  known: WorkflowKnowledge,
): WorkflowNormalization {
  const o = (raw ?? {}) as Record<string, unknown>;

  const name = String(o.name ?? "").trim();
  if (!name) return { ok: false, error: "A workflow needs a name." };
  if (name.length > MAX_WORKFLOW_NAME) {
    return {
      ok: false,
      error: `A workflow name is at most ${MAX_WORKFLOW_NAME} characters.`,
    };
  }

  const rawGraph = (o.graph ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(rawGraph.nodes) ? rawGraph.nodes : [];
  const rawEdges = Array.isArray(rawGraph.edges) ? rawGraph.edges : [];

  if (rawNodes.length === 0) {
    return { ok: false, error: "A workflow needs at least one block of work." };
  }
  if (rawNodes.length > MAX_WORKFLOW_NODES) {
    return {
      ok: false,
      error:
        `A workflow runs at most ${MAX_WORKFLOW_NODES} blocks; this one has ` +
        `${rawNodes.length}. Every block becomes a run in one pass, and each ` +
        "one claims a folder.",
    };
  }

  const nodes: WorkflowNode[] = [];
  const byId = new Map<string, WorkflowNode>();

  for (const [index, entry] of rawNodes.entries()) {
    const n = (entry ?? {}) as Record<string, unknown>;
    const position = `Block ${index + 1}`;

    const id = String(n.id ?? "");
    if (!NODE_ID.test(id)) {
      return {
        ok: false,
        error: `${position} has no usable id. An id is 1–64 letters, digits, hyphens or underscores.`,
      };
    }
    if (byId.has(id)) {
      return {
        ok: false,
        error: `Two blocks share the id “${id}”, so an edge naming it names both.`,
      };
    }

    const nodeName = String(n.name ?? "").trim();
    if (!nodeName) {
      return { ok: false, error: `${position} needs a name.` };
    }
    if (nodeName.length > MAX_NODE_NAME) {
      return {
        ok: false,
        error: `A block name is at most ${MAX_NODE_NAME} characters (“${nodeName.slice(0, 20)}…”).`,
      };
    }

    const task = String(n.task ?? "").trim();
    if (!task) {
      return {
        ok: false,
        error: `“${nodeName}” has no task. A block with nothing to do is a run that spends a work cycle finding that out.`,
      };
    }

    // Null is "no template — use the guards in Settings", which is a real
    // answer rather than a missing one. Anything else has to exist now: a
    // graph naming a template nobody can find is one that can be saved and
    // never started.
    const templateId =
      n.templateId === null ||
      n.templateId === undefined ||
      String(n.templateId) === ""
        ? null
        : String(n.templateId);
    if (templateId !== null && !known.templates.has(templateId)) {
      return {
        ok: false,
        error:
          `“${nodeName}” names a template that no longer exists, so there are ` +
          "no guards to start it under. Pick another, or none, which uses the " +
          "guards in Settings.",
      };
    }

    const mountId = String(n.mountId ?? "");
    if (!mountId) {
      return {
        ok: false,
        error: `“${nodeName}” names no workspace, so there is nowhere to start it.`,
      };
    }
    if (!known.mountIds.includes(mountId)) {
      return {
        ok: false,
        error: `“${nodeName}” names a workspace that is not mounted: ${mountId}.`,
      };
    }

    const promptOverride = String(n.promptOverride ?? "").trim();

    nodes.push({
      id,
      name: nodeName,
      templateId,
      mountId,
      // The empty string is the mount root — the one selection that blocks
      // every other run in the tree — so it is kept rather than collapsed into
      // "no folder", exactly as a template's is.
      folder: String(n.folder ?? ""),
      task,
      promptOverride: promptOverride || null,
    });
    byId.set(id, nodes[nodes.length - 1]);
  }

  const edges: WorkflowEdge[] = [];
  const seenPairs = new Set<string>();
  /** The one dependency each node takes its branch from, by node id. */
  const branchFrom = new Map<string, string>();

  for (const [index, entry] of rawEdges.entries()) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const from = String(e.from ?? "");
    const to = String(e.to ?? "");
    const where = `Link ${index + 1}`;

    const source = byId.get(from);
    const target = byId.get(to);
    if (!source || !target) {
      return {
        ok: false,
        error: `${where} joins a block that is not in this workflow.`,
      };
    }
    if (from === to) {
      return {
        ok: false,
        error: `“${source.name}” is set to start after itself.`,
      };
    }
    const pair = `${from} ${to}`;
    if (seenPairs.has(pair)) {
      return {
        ok: false,
        error:
          `“${target.name}” is set to start after “${source.name}” twice, so ` +
          "it is unclear which condition applies.",
      };
    }
    seenPairs.add(pair);

    // Required rather than defaulted, the same treatment `POST /api/runs` gives
    // it: `on-success` terminates a chain the operator meant to run regardless,
    // `on-finish` starts a run on top of a dependency that crashed, and a silent
    // default is wrong half the time in both directions.
    const edge = String(e.edge ?? "");
    if (!(DEPENDENCY_EDGES as readonly string[]).includes(edge)) {
      return {
        ok: false,
        error:
          `“${target.name}” needs a condition for starting after “${source.name}”: ` +
          `${DEPENDENCY_EDGES.join(" or ")}.`,
      };
    }

    // `=== true` for the reason `POST /api/runs` reads it that way: it decides
    // which branch a billed agent commits to, so a string off the wire fails
    // safe.
    const continueBranch = e.continueBranch === true;
    if (continueBranch) {
      const rival = branchFrom.get(to);
      if (rival) {
        return {
          ok: false,
          error:
            `“${target.name}” is set to carry on two branches — ` +
            `“${byId.get(rival)!.name}”'s and “${source.name}”'s. It can only continue one.`,
        };
      }
      branchFrom.set(to, from);

      // Both ends need a checkout of their own: the predecessor has to have a
      // branch to hand over and the successor has to be able to hold one.
      // Refused here rather than left to `admitDependencies`, which would throw
      // half way through creating the graph.
      const isolated = (node: WorkflowNode) =>
        node.templateId === null
          ? known.defaultIsolate
          : (known.templates.get(node.templateId)?.isolate ?? false);
      if (!isolated(source)) {
        return {
          ok: false,
          error:
            `“${source.name}” has no branch to hand to “${target.name}” — its ` +
            "guards work directly in the folder rather than in a checkout of " +
            "their own.",
        };
      }
      if (!isolated(target)) {
        return {
          ok: false,
          error:
            `“${target.name}” cannot carry on “${source.name}”'s branch: its ` +
            "guards work directly in the folder rather than in a checkout of " +
            "their own.",
        };
      }
    }

    edges.push({ from, to, edge: edge as DependencyEdge, continueBranch });
  }

  // Two runs on one ref is a branch git will not check out twice, and it leaves
  // the landing rules with no last link to name. `admitDependencies` refuses it
  // between live runs; this is the same rule inside one graph, where both would
  // be created in the same pass.
  const continued = new Set<string>();
  for (const from of branchFrom.values()) {
    if (continued.has(from)) {
      const source = byId.get(from)!;
      const takers = edges
        .filter((e) => e.continueBranch && e.from === from)
        .map((e) => `“${byId.get(e.to)!.name}”`);
      return {
        ok: false,
        error:
          `${takers.join(" and ")} are both set to carry on “${source.name}”'s ` +
          "branch. Two runs cannot extend one branch.",
      };
    }
    continued.add(from);
  }

  // The same loop detector the run graph uses, given the node ids in place of
  // run ids — so "what counts as a cycle" has one definition and one test.
  const links: DependencyLink[] = edges.map((e) => ({
    runId: e.to,
    dependsOn: e.from,
    edge: e.edge,
  }));
  const loop = dependencyCycle(links);
  if (loop) {
    return {
      ok: false,
      error:
        "These blocks wait for each other in a loop, so none of them could " +
        `ever start: ${loop.map((id) => byId.get(id)?.name ?? id).join(" → ")}.`,
    };
  }

  // Belt and braces: the order the instantiation uses has to be total, and the
  // cycle check above is the only thing that can make it not be. A graph that
  // reached here with an unplaceable node would be instantiated into runs that
  // sit `waiting` for ever.
  const { unplaced } = topologicalOrder({ nodes, edges });
  if (unplaced.length > 0) {
    return {
      ok: false,
      error:
        "These blocks could never start, because what they wait for can never " +
        `settle: ${unplaced.map((id) => byId.get(id)!.name).join(", ")}.`,
    };
  }

  return { ok: true, value: { name, graph: { nodes, edges } } };
}

/**
 * What a graph is validated against right now.
 *
 * One reader, so the save route and the instantiation cannot be comparing a
 * graph against two different pictures of the same install.
 */
export function currentKnowledge(): WorkflowKnowledge {
  return {
    templates: new Map(
      listTemplates().map((t) => [t.id, { name: t.name, isolate: t.isolate }]),
    ),
    mountIds: WORKSPACE_MOUNTS.map((m) => m.id),
    defaultIsolate: chatGuards().isolate,
  };
}

/**
 * Why a block's folder cannot be worked in, or null when every one resolves.
 *
 * Not part of `normalizeWorkflowInput`, which is pure — this is the filesystem
 * check, and it is the same `resolveWorkspaceFolder` call `createRun` makes. It
 * runs at *save* as well as at instantiation, which is a deliberate divergence
 * from `run_templates`: a template records a folder as a preference that the
 * run form asks about again, where a workflow block's folder is what the run
 * will use and is never asked about a second time.
 */
export function folderRefusal(graph: WorkflowGraph): string | null {
  for (const node of graph.nodes) {
    try {
      resolveWorkspaceFolder(node.folder, node.mountId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `“${node.name}” cannot start: ${detail}`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* One node becomes one run                                            */
/* ------------------------------------------------------------------ */

export type NodePlan =
  | { ok: true; input: Omit<CreateRunInput, "dependsOn"> }
  | { ok: false; reason: string };

/**
 * Turn one node into the run it asks for, or say why not.
 *
 * `planProposal` with the folder moved onto the node — same division of labour,
 * same refusal for a template that has gone, same `composeTask` so the standing
 * instructions and the specific task are joined identically wherever a run is
 * started from something other than the form. Pure: it takes the template and
 * the untemplated guard set rather than reading either.
 *
 * The branch that matters is the one that is not here. No value off a node sets
 * a budget, a permission mode or an isolation choice.
 */
export function planNode(
  node: WorkflowNode,
  template: RunTemplate | null,
  defaults: RunGuards,
): NodePlan {
  if (node.templateId !== null && !template) {
    return {
      ok: false,
      reason:
        `“${node.name}” names a template that no longer exists, so there are ` +
        "no guards to start it under. Edit the workflow to pick another, or " +
        "none, which uses the guards in Settings.",
    };
  }

  const task = node.task.trim();
  if (!task) return { ok: false, reason: `“${node.name}” has no task.` };

  const guards: RunGuards = template
    ? {
        permissionMode: template.permissionMode,
        isolate: template.isolate,
        budget: template.budget,
      }
    : defaults;

  const base = node.promptOverride?.trim() || template?.prompt || null;

  return {
    ok: true,
    input: {
      folder: node.folder,
      mountId: node.mountId,
      prompt: composeTask(base, task),
      // Every one of these comes from the template or from settings, and none
      // of them from the node.
      permissionMode: guards.permissionMode,
      isolate: guards.isolate,
      budget: guards.budget,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

interface WorkflowRow {
  id: string;
  name: string;
  graph: string;
  created_at: number;
  updated_at: number;
}

/**
 * A stored row as the rest of the app sees it.
 *
 * An unreadable blob yields an empty graph rather than throwing: the list page
 * has to keep rendering, and a workflow with no blocks is refused by every
 * route that would start it.
 */
function rowToWorkflow(row: WorkflowRow): Workflow {
  let graph: WorkflowGraph = { nodes: [], edges: [] };
  try {
    const parsed = JSON.parse(row.graph) as Partial<WorkflowGraph>;
    graph = {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    /* left empty — see above */
  }
  return {
    id: row.id,
    name: row.name,
    graph,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Turn SQLite's unique-index violation into the sentence the form shows. */
function withNameConflict<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = String((err as { code?: unknown } | null)?.code ?? "");
    if (code.startsWith("SQLITE_CONSTRAINT")) {
      throw new Error(
        `A workflow called “${name}” already exists. Rename this one, or ` +
          `open that workflow and edit it.`,
      );
    }
    throw err;
  }
}

export function listWorkflows(): Workflow[] {
  const rows = db()
    .prepare(
      "SELECT id, name, graph, created_at, updated_at FROM workflows ORDER BY name COLLATE NOCASE",
    )
    .all() as WorkflowRow[];
  return rows.map(rowToWorkflow);
}

export function getWorkflow(id: string): Workflow | null {
  const row = db()
    .prepare(
      "SELECT id, name, graph, created_at, updated_at FROM workflows WHERE id = ?",
    )
    .get(id) as WorkflowRow | undefined;
  return row ? rowToWorkflow(row) : null;
}

export function createWorkflow(input: WorkflowInput): Workflow {
  const id = randomUUID();
  const now = Date.now();
  withNameConflict(input.name, () =>
    db()
      .prepare(
        `INSERT INTO workflows (id, name, graph, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, JSON.stringify(input.graph), now, now),
  );
  return getWorkflow(id)!;
}

/** Null when there is no such workflow — the caller answers 404. */
export function updateWorkflow(
  id: string,
  input: WorkflowInput,
): Workflow | null {
  if (!getWorkflow(id)) return null;
  withNameConflict(input.name, () =>
    db()
      .prepare(
        "UPDATE workflows SET name = ?, graph = ?, updated_at = ? WHERE id = ?",
      )
      .run(input.name, JSON.stringify(input.graph), Date.now(), id),
  );
  return getWorkflow(id);
}

/**
 * A copy, named so it can be saved beside the original.
 *
 * Node ids are kept: they are unique within a graph and nothing outside one
 * refers to them, so renaming them would only make the copy diff differently
 * from the original for no benefit.
 */
export function duplicateWorkflow(id: string): Workflow | null {
  const source = getWorkflow(id);
  if (!source) return null;

  const taken = new Set(
    listWorkflows().map((w) => w.name.toLocaleLowerCase()),
  );
  let name = `${source.name} copy`;
  for (let n = 2; taken.has(name.toLocaleLowerCase()); n++) {
    name = `${source.name} copy ${n}`;
  }
  // The name is bounded, and "copy" pushes a long one over the limit. Trimmed
  // from the original rather than refused: a duplicate that cannot be made
  // because the name is long is a dead end on a button with one job.
  if (name.length > MAX_WORKFLOW_NAME) {
    name = name.slice(0, MAX_WORKFLOW_NAME);
  }

  return createWorkflow({ name, graph: source.graph });
}

/**
 * Deleting a workflow takes its instance records with it and touches no run.
 *
 * The runs it started carry their own prompt, guards and history, exactly as a
 * template's do — so nothing becomes unreadable and no work is lost. What goes
 * is this workflow's own record of having been pressed, which is the relation
 * `chat_proposals` has to `chat_sessions`.
 */
export function deleteWorkflow(id: string): boolean {
  const res = db().prepare("DELETE FROM workflows WHERE id = ?").run(id);
  return res.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Instances                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where one press of Run has got to.
 *
 * `stopping` and `stopped` are the same stored row: the halt writes `stopping`
 * and the difference is whether any member is still live, which is a fact about
 * the runs rather than something a second pass writes. A signalled child takes
 * seconds to die, and after a restart nothing would run that second pass at all.
 */
export type WorkflowInstanceStatus =
  | "started"
  | "failed"
  | "stopping"
  | "stopped";

/** What halted an instance. `null` on an instance nobody has stopped. */
export type HaltCauseKind = "operator" | "guard";

export interface WorkflowInstanceNode {
  nodeId: string;
  nodeName: string;
  position: number;
  runId: string;
}

export interface WorkflowInstance {
  id: string;
  workflowId: string;
  /** The workflow's name when Run was pressed. */
  workflowName: string;
  /** The graph as it was then, so a later edit cannot rewrite the record. */
  graph: WorkflowGraph;
  createdAt: number;
  status: WorkflowInstanceStatus;
  error: string | null;
  /** When the halt closed the door — not when the last child died. */
  stoppedAt: number | null;
  stopCause: HaltCauseKind | null;
  /** A guard's verdict in full. Null for an operator's stop, which needs none. */
  stopReason: string | null;
  /** Members that have not finished. Non-zero under `stopping`. */
  liveRunCount: number;
  nodes: WorkflowInstanceNode[];
}

interface InstanceRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  graph: string;
  created_at: number;
  status: string;
  error: string | null;
  stopped_at: number | null;
  stop_cause: string | null;
  stop_reason: string | null;
}

/** How many of this instance's runs are still going, in one query. */
function liveMemberCount(instanceId: string): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM workflow_instance_runs w
         JOIN runs r ON r.id = w.run_id
        WHERE w.instance_id = ?
          AND r.status IN (${LIVE_STATUSES.map(() => "?").join(",")})`,
    )
    .get(instanceId, ...LIVE_STATUSES) as { n: number };
  return row.n;
}

function rowToInstance(row: InstanceRow): WorkflowInstance {
  let graph: WorkflowGraph = { nodes: [], edges: [] };
  try {
    const parsed = JSON.parse(row.graph) as Partial<WorkflowGraph>;
    graph = {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    /* an unreadable snapshot still lists its runs */
  }

  const nodes = db()
    .prepare(
      `SELECT node_id AS nodeId, node_name AS nodeName, position, run_id AS runId
         FROM workflow_instance_runs WHERE instance_id = ? ORDER BY position`,
    )
    .all(row.id) as WorkflowInstanceNode[];

  const live = liveMemberCount(row.id);

  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    graph,
    createdAt: row.created_at,
    // `stopped` is derived rather than stored — see WorkflowInstanceStatus. An
    // unrecognised value reads as `started`, the same forgiving default the
    // graph blob gets: this is a record, and it has to keep rendering.
    status:
      row.status === "failed"
        ? "failed"
        : row.status === "stopping"
          ? live > 0
            ? "stopping"
            : "stopped"
          : "started",
    error: row.error,
    stoppedAt: row.stopped_at,
    stopCause:
      row.stop_cause === "operator" || row.stop_cause === "guard"
        ? row.stop_cause
        : null,
    stopReason: row.stop_reason,
    liveRunCount: live,
    nodes,
  };
}

const INSTANCE_COLUMNS =
  "id, workflow_id, workflow_name, graph, created_at, status, error," +
  " stopped_at, stop_cause, stop_reason";

/** Statuses a run has not finished in — it will spend, or is waiting to. */
const LIVE_STATUSES: readonly RunStatus[] = [
  "waiting",
  "queued",
  "running",
  "paused",
];

export function listInstances(workflowId: string, limit = 20): WorkflowInstance[] {
  const rows = db()
    .prepare(
      `SELECT ${INSTANCE_COLUMNS} FROM workflow_instances
        WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workflowId, limit) as InstanceRow[];
  return rows.map(rowToInstance);
}

/**
 * When this workflow was last started, or null.
 *
 * Its own query rather than `listInstances(id, 1)[0]`: the list page asks it
 * once per workflow, and building a whole instance — parsing its graph snapshot
 * and reading its node rows — to take one timestamp off it is work per row that
 * nothing on that page displays.
 */
export function lastRunAt(workflowId: string): number | null {
  const row = db()
    .prepare(
      "SELECT MAX(created_at) AS at FROM workflow_instances WHERE workflow_id = ?",
    )
    .get(workflowId) as { at: number | null } | undefined;
  return row?.at ?? null;
}

export function getInstance(id: string): WorkflowInstance | null {
  const row = db()
    .prepare(`SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE id = ?`)
    .get(id) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

/**
 * Runs this workflow started that have not finished.
 *
 * Both gates read it: starting a second instance while the first is still going
 * would aim the same nodes at the same folders, and deleting a workflow while
 * its runs are in flight throws away the only record of where they came from.
 */
export function liveRunsOf(
  workflowId: string,
): Array<{ runId: string; status: RunStatus; instanceId: string }> {
  return db()
    .prepare(
      `SELECT w.run_id AS runId, r.status AS status, w.instance_id AS instanceId
         FROM workflow_instance_runs w
         JOIN workflow_instances i ON i.id = w.instance_id
         JOIN runs r ON r.id = w.run_id
        WHERE i.workflow_id = ?
          AND r.status IN (${LIVE_STATUSES.map(() => "?").join(",")})
        ORDER BY w.position`,
    )
    .all(workflowId, ...LIVE_STATUSES) as Array<{
    runId: string;
    status: RunStatus;
    instanceId: string;
  }>;
}

/* ------------------------------------------------------------------ */
/* Instantiating                                                       */
/* ------------------------------------------------------------------ */

export type StartOutcome =
  | { ok: true; instance: WorkflowInstance }
  | { ok: false; reason: string };

/**
 * Turn a workflow into runs — every block, in one synchronous pass.
 *
 * Synchronous from the first `createRun` to the last, with no `await` between
 * them, and that is a correctness requirement rather than a style: `createRun`'s
 * folder claim is only atomic because one event-loop turn covers deciding a
 * folder is free and recording that it was taken. The chat's approval route
 * batches for the same reason.
 *
 * **All or nothing.** Everything that can be checked is checked before anything
 * is created — the graph against the templates and mounts that exist right now,
 * every folder through the same `resolveWorkspaceFolder` the run will use, and
 * every node's guards — so a failure in the middle should be unreachable. If one
 * happens anyway the runs already created are stopped and the instance is
 * recorded `failed` with the reason, because half a graph is not a smaller
 * workflow: its successors were never created, so what is left running is a
 * prefix nobody asked for. The runs are *stopped* rather than deleted — one may
 * already hold a checkout and a child process, and the row is what the kill path
 * and `reconcileOnBoot` need.
 */
export function startWorkflow(id: string): StartOutcome {
  const workflow = getWorkflow(id);
  if (!workflow) return { ok: false, reason: "No such workflow." };

  // A second instance would aim the same blocks at the same folders: the runs
  // would queue behind the first instance's on the folder claim, and a block
  // set to carry on a branch would be refused by `admitDependencies` because
  // the first instance's run already continues it. Refused here as a sentence,
  // rather than discovered four nodes into the pass.
  const live = liveRunsOf(id);
  if (live.length > 0) {
    return {
      ok: false,
      reason:
        `${live.length} run(s) from an earlier press of Run have not finished ` +
        "yet. Starting this workflow again would point the same blocks at the " +
        "same folders. Wait for them, or stop them on the Runs page.",
    };
  }

  const known = currentKnowledge();
  const checked = normalizeWorkflowInput(workflow, known);
  if (!checked.ok) {
    return {
      ok: false,
      reason: `This workflow cannot be started as saved: ${checked.error}`,
    };
  }
  const graph = checked.value.graph;

  // Planned in full before anything is created. A refusal here costs nothing;
  // the same refusal three nodes into the pass costs a rollback.
  const defaults = chatGuards();
  const plans = new Map<string, Omit<CreateRunInput, "dependsOn">>();
  for (const node of graph.nodes) {
    const plan = planNode(
      node,
      node.templateId ? getTemplate(node.templateId) : null,
      defaults,
    );
    if (!plan.ok) return { ok: false, reason: plan.reason };
    plans.set(node.id, plan.input);
  }

  // The same resolution `createRun` performs, run early so a folder that has
  // been moved or deleted since the workflow was saved names its block instead
  // of aborting a half-built graph.
  const missing = folderRefusal(graph);
  if (missing) return { ok: false, reason: missing };

  // The one remaining thing that can only be answered by looking at the disk: a
  // hand-over needs a *branch* at both ends, and whether a folder can have one
  // is `probeIsolation`'s answer rather than the guards'. Its failures are
  // ordinary — a subdirectory of a repository, submodules, no commits yet — and
  // every one of them would otherwise surface as a throw part-way through the
  // creating pass. Read-only, so asking early costs a few git processes.
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const link of graph.edges.filter((e) => e.continueBranch)) {
    for (const node of [nodeById.get(link.from)!, nodeById.get(link.to)!]) {
      const probe = probeIsolation(
        resolveWorkspaceFolder(node.folder, node.mountId),
      );
      if (probe.mode !== "worktree") {
        return {
          ok: false,
          reason:
            `“${node.name}” is part of a branch hand-over, which needs a ` +
            `checkout of its own. ${probe.reason ?? "It cannot have one."}`,
        };
      }
    }
  }

  const { order } = topologicalOrder(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const e of graph.edges) {
    const list = incoming.get(e.to);
    if (list) list.push(e);
    else incoming.set(e.to, [e]);
  }

  const instanceId = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO workflow_instances
         (id, workflow_id, workflow_name, graph, created_at, status, error)
       VALUES (?, ?, ?, ?, ?, 'started', NULL)`,
    )
    .run(instanceId, id, workflow.name, JSON.stringify(graph), now);

  const addNode = db().prepare(
    `INSERT INTO workflow_instance_runs
       (instance_id, node_id, node_name, position, run_id)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const runIds = new Map<string, string>();
  try {
    for (const [position, nodeId] of order.entries()) {
      const node = byId.get(nodeId)!;
      const dependsOn = (incoming.get(nodeId) ?? []).map((e) => ({
        // Every predecessor is earlier in the topological order, so its run
        // already exists. That is the whole reason the order is computed.
        runId: runIds.get(e.from)!,
        edge: e.edge,
        continueBranch: e.continueBranch,
      }));
      const run = createRun({ ...plans.get(nodeId)!, dependsOn });
      runIds.set(nodeId, run.id);
      addNode.run(instanceId, nodeId, node.name, position, run.id);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Newest first, so a run is stopped before the one it was told to start
    // after — otherwise stopping the dependency releases the dependent into the
    // queue on its way out. The attribution says which of the three stops this
    // was: not the operator, not a guard, but a graph that could not be built.
    const rolledBack = `Stopped because workflow “${workflow.name}” could not be started in full`;
    for (const runId of [...runIds.values()].reverse()) {
      stopRun(runId, rolledBack);
    }
    db()
      .prepare(
        "UPDATE workflow_instances SET status = 'failed', error = ? WHERE id = ?",
      )
      .run(reason, instanceId);
    return {
      ok: false,
      reason:
        `${reason} Nothing from this workflow is left running — the ` +
        `${runIds.size} run(s) already created were stopped.`,
    };
  }

  // `createRun` promotes after each admission; this is what starts whatever the
  // last one made startable, exactly as the chat's approval route relies on.
  promoteQueued();
  return { ok: true, instance: getInstance(instanceId)! };
}

/* ------------------------------------------------------------------ */
/* Halting — one door, whatever state the instance is in               */
/* ------------------------------------------------------------------ */

/**
 * Why an instance is being halted.
 *
 * The one thing an operator's stop and a tripped guard differ by. Everything
 * else about the halt — which members it selects, what each becomes, what it
 * refuses to touch — is identical, which is why there is one function and not
 * two: a second implementation is a second chance to forget a member, and a
 * missed member goes on spending.
 */
export type HaltCause =
  | { kind: "operator" }
  /** The guard's verdict, in full. Recorded on the instance, once. */
  | { kind: "guard"; detail: string };

/** One member as the decision sees it: an id, a name, and a status. */
export interface HaltMember {
  runId: string;
  nodeName: string;
  /** Null when the run row has gone — the mapping is a historical record. */
  status: RunStatus | null;
}

/**
 * What happens to one member, and what gets written on it.
 *
 * Three actions, and each is a decision this app has already made once:
 *
 *   `stop` hands it to `stopRun`. A run with a child in flight gets the kill
 *   ladder — `SIGINT` first, so a CLI that handles it can still print `result`
 *   and have its cycle *measured* rather than reconciled — and a run that has
 *   not spawned takes one of that function's pre-spawn branches. There is
 *   deliberately no second way to signal a child anywhere in this app.
 *
 *   `block` is for a member that never started and now never will: `blocked`,
 *   with nothing spent. `stopRun` would write `stopped` here, which is right
 *   when the operator is stopping *that run* — but a halted member was not
 *   singled out and it never ran, and `blocked` is what this app already writes
 *   for a run refused before its first work cycle. It also keeps it out of
 *   `REOPENABLE`, which is the honest answer: reopening one link of a chain
 *   whose predecessors were just stopped would start it on work that never
 *   happened.
 *
 *   `leave` is a member already terminal, or one whose run row has gone.
 *   Rewriting a `completed` member as stopped destroys the record of work that
 *   landed, which is the silent half of getting this wrong.
 *
 * A union rather than an optional field, so a member left alone cannot carry a
 * reason and a member being ended cannot lack one. For `block` the reason is the
 * whole sentence; for `stop` it is the attribution handed to `stopRun`, which
 * appends the clause saying what the run was doing when the halt landed.
 */
export type HaltStep =
  | (HaltMember & { action: "stop" | "block"; reason: string })
  | (HaltMember & { action: "leave"; reason: null });

/** What a halt does to one member, for a caller that wants to name it. */
export type HaltAction = HaltStep["action"];

export interface HaltDecision {
  /** False when there is nothing to do: already stopping, or never started. */
  act: boolean;
  /** Why not, in the operator's words. Null when `act` is true. */
  note: string | null;
  /** The attribution every stopped member carries. */
  cause: string;
  /** Empty when `act` is false — an instance is halted once. */
  steps: HaltStep[];
}

/**
 * Who stopped this run, in the words that go on the row.
 *
 * A **fragment**, because `stopRun` completes it with the clause naming what the
 * run was doing ("… before it started."). Three endings have to be tellable
 * apart on sight, and these are two of them; the third is `stopRun`'s own
 * default, `Stopped by operator`, which is what a run stopped on its own page
 * says. A guard's verdict is deliberately *not* pasted in here — it is one fact
 * about one instance and lives on the instance row, rather than repeated across
 * ten member rows where it would read as ten separate findings.
 */
export function haltCause(cause: HaltCause, workflowName: string): string {
  return cause.kind === "operator"
    ? `Stopped by the operator with all of workflow “${workflowName}”`
    : `Stopped by the budget guard on workflow “${workflowName}”`;
}

/**
 * What a halt does to each member — the whole decision, and nothing that writes.
 *
 * Pure and unit-tested for the reason `releasableRuns` and `selectPromotable`
 * are: both ways of being wrong are silent and expensive. A member the selection
 * misses goes on spending under a workflow the operator believes is stopped; a
 * `completed` member rewritten as stopped destroys the record of work that
 * landed, and there is nothing on the page afterwards to say it ever happened.
 *
 * `members` is the instance's run list *as it stands*, which is what makes a
 * stop arriving mid-instantiation a non-event: a block whose `createRun` has not
 * happened is not in the table, so it is not selected — and it is never created
 * either, because `startWorkflow` holds the event-loop turn from its first
 * `createRun` to its last and a rolled-back pass leaves the instance `failed`,
 * which this refuses.
 */
export function haltPlan(
  instance: { status: WorkflowInstanceStatus; workflowName: string },
  members: readonly HaltMember[],
  cause: HaltCause,
): HaltDecision {
  const attribution = haltCause(cause, instance.workflowName);

  // Idempotence, stated as a decision rather than left to the UPDATE that
  // enforces it: a second stop must be a no-op, not a second kill ladder run
  // over children that are already dying.
  if (instance.status !== "started") {
    const note =
      instance.status === "failed"
        ? "This workflow run never started — its blocks were rolled back when it was created."
        : instance.status === "stopped"
          ? "This workflow run has already been stopped."
          : "This workflow run is already stopping.";
    return { act: false, note, cause: attribution, steps: [] };
  }

  return {
    act: true,
    note: null,
    cause: attribution,
    steps: memberSteps(members, attribution),
  };
}

/** What happens to each member, given the attribution it will be recorded under. */
function memberSteps(
  members: readonly HaltMember[],
  attribution: string,
): HaltStep[] {
  return members.map((member) => {
    if (member.status === null) {
      return { ...member, action: "leave" as const, reason: null };
    }
    if (member.status === "waiting") {
      return {
        ...member,
        action: "block" as const,
        reason: `${attribution} while it was waiting for another run.`,
      };
    }
    if (LIVE_STATUSES.includes(member.status)) {
      return { ...member, action: "stop" as const, reason: attribution };
    }
    return { ...member, action: "leave" as const, reason: null };
  });
}

/** What a halt did, per member, for the caller to report. */
export interface HaltReport {
  instanceId: string;
  workflowName: string;
  /** False when nothing was done; `note` says why. */
  acted: boolean;
  note: string | null;
  /** Members whose child got the kill ladder. */
  signalled: string[];
  /** Members closed out before they could spawn. */
  cancelled: string[];
  /** Members that were still waiting, now `blocked`. */
  blocked: string[];
  /** Members already finished, or whose row has gone. */
  untouched: string[];
  /** Queued merges belonging to these runs, cancelled. */
  mergesCancelled: number;
}

export type HaltOutcome =
  | { ok: true; report: HaltReport }
  | { ok: false; reason: string };

/**
 * Halt a whole workflow instance, whatever state each of its members is in.
 *
 * **The one door.** An operator control and a tripped instance guard both call
 * this, and differ only in the `cause` recorded — the alternative is two
 * implementations of a selection whose failure modes are silent.
 *
 * **The door is closed before anything is signalled.** The instance is marked
 * `stopping` first, by an UPDATE guarded on `status='started'`, and from there
 * to the last member there is **no `await`** — the property `createRun`'s folder
 * claim documents, for the same reason: one event-loop turn is what makes a
 * check-then-act atomic here, and a member that starts after the stop began is
 * exactly the bug the ordering prevents. The guarded UPDATE is also the
 * idempotence: a second stop changes no rows and does nothing.
 *
 * **Waiting members are blocked before any of the others are touched.** Stopping
 * a run releases its dependents, and a dependent released a moment before the
 * halt reaches it would be admitted, promoted and spawned — a member starting
 * *because* the workflow was stopped. Blocked first, there is nothing left to
 * release.
 *
 * Stopping a queued member can still promote another queued member into
 * `running` inside this same turn, since `stopRun` frees the folder reservation
 * and `promoteQueued` acts on it. That is harmless and deliberately not designed
 * around: `stopRun` re-reads the row, so it takes the `running` branch and
 * registers an interrupt, and `startRun`'s pre-spawn checkpoint sees it before
 * any child is spawned. The cost is a transcript scan, not a billed work cycle.
 *
 * What it does **not** do: it never removes a checkout, never touches a branch,
 * and never commits. Work an agent left uncommitted stays in its slot with its
 * own branch checked out, where `slotIsDirty` keeps the next run out of it and
 * the run page's Commit — which goes through `commitRefusal`, the function that
 * already settled whose work is in a slot — is the way it reaches the branch.
 * Committing ten runs from here would need ten `await`s in the middle of the one
 * stretch that must not have any.
 */
/** Every member of one instance, with the status its run row has now. */
function membersOf(instanceId: string): HaltMember[] {
  return db()
    .prepare(
      `SELECT w.run_id AS runId, w.node_name AS nodeName, r.status AS status
         FROM workflow_instance_runs w
         LEFT JOIN runs r ON r.id = w.run_id
        WHERE w.instance_id = ? ORDER BY w.position`,
    )
    .all(instanceId) as HaltMember[];
}

export function stopInstance(instanceId: string, cause: HaltCause): HaltOutcome {
  const instance = getInstance(instanceId);
  if (!instance) return { ok: false, reason: "No such workflow run." };

  const members = membersOf(instanceId);
  const plan = haltPlan(instance, members, cause);
  const report: HaltReport = {
    instanceId,
    workflowName: instance.workflowName,
    acted: plan.act,
    note: plan.note,
    signalled: [],
    cancelled: [],
    blocked: [],
    untouched: [],
    mergesCancelled: 0,
  };
  if (!plan.act) return { ok: true, report };

  // The door. Guarded on the status the plan was decided from, so the decision
  // and the write cannot disagree — nothing in this process can interleave with
  // the read above, and the guard is what makes that a statement rather than an
  // assumption. Zero changes means another writer got here first, which is the
  // second stop this is idempotent against.
  const claimed = db()
    .prepare(
      `UPDATE workflow_instances
          SET status='stopping', stopped_at=?, stop_cause=?, stop_reason=?
        WHERE id=? AND status='started'`,
    )
    .run(
      Date.now(),
      cause.kind,
      cause.kind === "guard" ? cause.detail : null,
      instanceId,
    );
  if (claimed.changes !== 1) {
    return {
      ok: true,
      report: {
        ...report,
        acted: false,
        note: "This workflow run is already stopping.",
      },
    };
  }

  walkMembers(plan.steps, plan.cause, report);
  return { ok: true, report };
}

/**
 * Carry out a plan: the writes, in the order the halt needs them.
 *
 * Synchronous from the first member to the last, and separated from
 * `stopInstance` only so a restart that caught a halt part-way can finish the
 * same walk rather than a second version of it.
 */
function walkMembers(
  steps: readonly HaltStep[],
  cause: string,
  report: HaltReport,
): void {
  // Waiting first — see `stopInstance`. Nothing between here and the end of the
  // walk yields to the event loop.
  for (const step of steps) {
    if (step.action !== "block") continue;
    if (blockWaitingRun(step.runId, step.reason)) report.blocked.push(step.runId);
    else report.untouched.push(step.runId);
  }

  for (const step of steps) {
    if (step.action !== "stop") continue;
    const outcome = stopRun(step.runId, cause);
    if (outcome === "signalled") report.signalled.push(step.runId);
    else if (outcome === "cancelled") report.cancelled.push(step.runId);
    else report.untouched.push(step.runId);
  }

  for (const step of steps) {
    if (step.action === "leave") report.untouched.push(step.runId);
  }

  // A merge already in flight is left alone, exactly as cancelling a batch
  // leaves it: it is a multi-step write into the operator's own checkout, and
  // stopping half way through is worse than the second it takes to finish.
  report.mergesCancelled = cancelQueuedFor(
    steps.map((s) => s.runId),
    `${cause}.`,
  );

  // A run outside this instance may have been told to start after one of these.
  // `stopRun`'s pre-spawn branches call both already; blocking a waiting member
  // does not, and neither runs at all when every member had a child in flight.
  releaseDependents();
  promoteQueued();
}

/**
 * Finish a halt the process died in the middle of.
 *
 * The walk holds its event-loop turn from the first member to the last, so this
 * needs a crash *inside* that block — but the residue is a member of a stopped
 * workflow that goes on spending, which is the one outcome the halt exists to
 * have none of. `reconcileOnBoot` closes out `running`, `queued` and `waiting`
 * rows already; what it deliberately spares is a recently `paused` one, and the
 * sweeper would then re-queue it under a workflow the page says is stopped.
 *
 * Runs **after** `reconcileOnBoot`, so what is left is only that residue, and it
 * re-uses the recorded cause rather than inventing one: the halt was the
 * operator's or the guard's, and a restart is neither.
 */
export function reconcileHaltsOnBoot(): void {
  const rows = db()
    .prepare(
      "SELECT id, workflow_name, stop_cause FROM workflow_instances WHERE status = 'stopping'",
    )
    .all() as Array<{ id: string; workflow_name: string; stop_cause: string | null }>;

  for (const row of rows) {
    const members = membersOf(row.id);
    if (!members.some((m) => m.status && LIVE_STATUSES.includes(m.status))) {
      continue;
    }
    const cause = haltCause(
      row.stop_cause === "guard" ? { kind: "guard", detail: "" } : { kind: "operator" },
      row.workflow_name,
    );
    walkMembers(memberSteps(members, cause), cause, {
      instanceId: row.id,
      workflowName: row.workflow_name,
      acted: true,
      note: null,
      signalled: [],
      cancelled: [],
      blocked: [],
      untouched: [],
      mergesCancelled: 0,
    });
  }
}

/** A run's live state for the instance view, or null when the row has gone. */
export function runStateOf(runId: string): {
  status: RunStatus;
  stopReason: string | null;
  iterations: number;
  maxIterations: number;
  spentUSD: number;
} | null {
  const run = getRun(runId);
  if (!run) return null;
  return {
    status: run.status,
    stopReason: run.stop_reason,
    iterations: run.iterations,
    maxIterations: run.max_iterations,
    spentUSD: run.spent_usd,
  };
}
