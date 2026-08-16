import { randomUUID } from "node:crypto";
import path from "node:path";
import { db } from "./db";
import {
  composeTask,
  getProposal,
  markProposal,
  mintCapability,
  revokeCapability,
  runOrchestratorChild,
  type ChatProcess,
  type TurnResult,
} from "./chat";
import { assistBudgetFull, windowRefusal } from "./review";
import { installBudgetRefusal } from "./installBudget";
import {
  DEPENDENCY_EDGES,
  blockWaitingRun,
  createRun,
  currentSnapshot,
  dependencyCycle,
  describeFolder,
  edgeSatisfied,
  getRun,
  probeIsolation,
  promoteQueued,
  releaseDependents,
  resolveWorkspaceFolder,
  revivableDependents,
  signalTree,
  stopRun,
  TERMINAL_STATUSES,
  topologicalOrder,
  RUN_ORIGINS,
  type CreateRunInput,
  type RunOrigin,
  type DependencyEdge,
  type DependencyLink,
  type DependencyState,
  type RunStatus,
} from "./orchestrator";
import {
  batchRows,
  cancelQueuedFor,
  enqueue,
  isQueueActive,
  type QueueRow,
} from "./mergeQueue";
import { landState, type LandStrategy } from "./land";
import {
  INSTANCE_ENFORCEABLE_CODES,
  evaluateInstanceBudget,
  instanceBudgetIsOff,
  normalizeInstanceBudget,
  type BudgetVerdict,
  type InstanceBudgetPolicy,
  type InstanceProgress,
} from "./budget";
import {
  agentDefinition,
  agentKnowledgeOf,
  agentRefusal,
  currentAgentKnowledge,
  getAgent,
  getAgentByName,
  listAgents,
  type AgentDefinition,
  type AgentFacts,
  type AgentKnowledge,
  type RegistryAgent,
} from "./agents";
import { telemetrySpendSince } from "./otlp";
import type { UsageSnapshot } from "./windows";
import {
  chatGuards,
  getSettings,
  newWorkPaused,
  type RunGuards,
} from "./settings";
import { getTemplate, listTemplates, type RunTemplate } from "./templates";
import { WORKSPACE_MOUNTS, mountById } from "./config";
import { dataDirRefusal } from "./serverLock";
import {
  MAX_FAN_OUT,
  MAX_WORKFLOW_NAME,
  MAX_WORKFLOW_NODES,
  type WorkflowNodeKind,
} from "./apiTypes";

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
 *
 * **A node can also decide what the next runs should be, and they start without
 * an approval.** An orchestrator block is a short agent turn — the chat's child,
 * invoked without a thread — whose only tool that writes anything emits run
 * specs: a title, a task, a folder inside the block's own mount, and the
 * dependency edges among the runs it is emitting. The server creates them and
 * they enter the queue. Nothing is proposed and nobody clicks Approve, and the
 * reason that is defensible is that the approval moved rather than disappeared:
 * a person saved a graph naming this block's folder, its guard set and the
 * largest number of runs it may ever start. What has *not* moved is the rule
 * every other route here follows — **no value the model emits sets a budget, a
 * permission mode or an isolation choice.** Those come from the block's named
 * template, or from `settings.chatDefaultGuards` when it names none, exactly as
 * `planProposal` and `planNode` resolve them. The orchestrator *chat* still
 * proposes and still starts nothing; this is a different thing with a different
 * gate in front of it.
 *
 * **And a node can land what the nodes in front of it built.** A merge block
 * spawns no agent and holds no task: it takes the branches its predecessors' runs
 * left behind and puts each one onto the target that run recorded when it cut its
 * branch — never a target named here, for the reason `landState` never assumes
 * one. It goes through `mergeQueue.enqueue`, so it inherits every protection the
 * Branches page has and adds none of its own: one merge in flight, each item
 * re-previewed against git at *its* turn, a conflict reconciled on the run's own
 * branch in a throwaway checkout, and the operator's own checkout refusing the
 * whole repository if it is dirty or standing on the wrong branch. That last one
 * is the honest cost of an unattended merge and is not weakened here — landing
 * onto the wrong branch is the one mistake in this app with no undo.
 *
 * Its one expense is optional and is authorised the same way an orchestrator
 * block's runs are: `mergeAutoResolve` on the saved graph is a person agreeing,
 * once, that a conflict may be reconciled by a model. It is on the node rather
 * than in settings for `merge_queue.auto_resolve`'s reason — configuration that
 * could change under a graph already running is not authorisation.
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
  /**
   * A fixed run, a turn that decides what runs to start, or a merge of what the
   * blocks in front of it built. See `WorkflowNodeKind` and the two notes above.
   */
  kind: WorkflowNodeKind;
  /** The template supplying every guard, or null for `chatDefaultGuards`. */
  templateId: string | null;
  /**
   * The workspace this block works in. `""` on a merge block, which works in
   * whichever repository each branch it lands came from — recorded on the run
   * that cut the branch, and never named here.
   */
  mountId: string;
  /** Path within the mount. `""` is the mount root, and is a real answer. */
  folder: string;
  /** What this block is asked to do, or to decide. `""` on a merge block. */
  task: string;
  /**
   * Standing instructions this node's task is appended to, replacing the
   * template's prompt for this one node. Prompt text is the half of a run that
   * is *work* rather than permission, which is why this is here and a budget
   * is not — the same split `chat_proposals.prompt_override` makes.
   *
   * On an orchestrator block it is the prompt every run it emits starts with,
   * for the same reason: the emitted task is the specific instance and this is
   * what stands above it.
   */
  promptOverride: string | null;
  /**
   * A saved agent this block's own child is started **as**, or null.
   *
   * On the **work** side of the node — beside the mount, the folder, the task
   * and the prompt override — and deliberately not on the guard side. That
   * placement was re-decided when the flag became `--agent` rather than carried
   * over: the child now *is* this agent, which makes the field a larger fact
   * and not a different kind of one. An agent still carries no capability at
   * all — it holds no tool list and no permission mode — so what it changes is
   * who the child is and never what the block may do. The three narrowings of
   * `--permission-mode` stay three, the two routes to it stay two, and
   * `guardsFor` still returns the same three fields.
   *
   * **It is the node's own and is never inherited from its template**, which is
   * the mount and folder's rule rather than the prompt's. What decides it is
   * what a template answers *here*: the run form applies one as a seed for every
   * field, where a node reads one for exactly two things — its guards, and the
   * standing instructions `promptOverride` replaces. It supplies neither the
   * mount nor the folder, for the stated reason that a template edited months
   * later would silently move a saved block's run to another repository, and an
   * agent is the same shape of change one field over: it decides who does the
   * work, it points into a registry that is edited somewhere else entirely, and
   * a saved graph whose agent moved with nothing in the graph changing is
   * exactly that surprise. The canvas states this field in the sentence a press
   * of Run is approved against, which it could not do honestly for a value that
   * lives on another record.
   *
   * An **id** rather than a copy, which is `run_templates.agent_id`'s rule and
   * the opposite of `runs.agent`'s, for that pair's reason: a saved graph is
   * form input applied again and again, so an operator who fixes their
   * reviewer's prompt expects the next press of Run to use the fixed one. The
   * copy is taken where it always is — `createRun` freezes the whole definition
   * onto the run — so an agent deleted between two blocks of one instance
   * cannot reach a run that has already started.
   *
   * Which child it is differs by kind, and the field does not. On a run block it
   * is what that run itself is started as. On an orchestrator block it is the
   * **deciding turn's**, because that turn is the child this block spawns; the runs it
   * emits name their own, one per spec, which is the only per-run answer
   * available to a block that has not decided on them yet. That is the opposite
   * way round from `promptOverride`, which an orchestrator block holds on behalf
   * of the runs it emits — standing instructions are what a run is *asked*, and
   * the deciding turn is asked by `blockSystemPrompt` instead. A merge block
   * spawns no child at all, so one named there is refused rather than dropped;
   * see `normalizeWorkflowInput`.
   */
  agentId: string | null;
  /**
   * How many runs an orchestrator block may start. Null on a run block.
   *
   * Never null on an orchestrator block, and that is enforced at *save* rather
   * than at Run — the reasoning `normalizeTemplateInput` applies to the
   * `no_terminus` pair, with more at stake: this is the one block whose runs
   * start with nothing between the decision and the spawn, so a missing ceiling
   * is an unbounded number of billed agents from one press of Run.
   */
  fanOut: number | null;
  /**
   * How a merge block puts each branch onto its target. Null on every other
   * kind, never null on a merge one.
   *
   * Recorded on the graph rather than read from `settings.landStrategy` when the
   * block runs, which is the treatment the mount and folder already get and for
   * the same reason: a workflow is saved once and run for months, and a setting
   * edited in between would silently change what a saved graph does to a
   * repository with nothing in the graph changing.
   */
  mergeStrategy: LandStrategy | null;
  /**
   * Whether a merge block may pay a model to reconcile a conflict. False on
   * every other kind.
   *
   * The one thing a merge block can spend, and it is authorised here for
   * `merge_queue.auto_resolve`'s reason: queueing with the box ticked is the
   * authorisation, recorded next to the work it authorises rather than read from
   * configuration that could have changed since. Saving a graph with this on is
   * the same act, one level up.
   */
  mergeAutoResolve: boolean;
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
  /**
   * Limits on the whole press of Run, as against a node's.
   *
   * The **one** thing on a workflow that is a guard, and it is here rather than
   * on a node for the reason the node-level ones are on a template: it bounds
   * something no per-run limit can see. Ten blocks under a $5 run limit is a $50
   * workflow, and nothing before this stood between the operator and that
   * number. It is still not a fourth route to `--permission-mode`, holds no
   * permission mode, no isolation choice and no model, and nothing a model
   * emits can reach it — see `startWorkflow`.
   */
  instanceBudget: InstanceBudgetPolicy;
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
  /**
   * The agent registry, for a node that names an agent.
   *
   * Injected like the templates and for the identical reason, and read through
   * the same `agentRefusal` the run door and the template door read — so a
   * saved graph, a saved template and a started run all say the same sentence
   * about an agent that has gone.
   */
  agents: AgentKnowledge;
}


export type WorkflowNormalization =
  | { ok: true; value: WorkflowInput }
  | { ok: false; error: string };

/** Node ids travel in messages and are React keys; keep them readable. */
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The kinds a block may be, as a value rather than three literal comparisons.
 *
 * One list, so adding a kind cannot leave the wire gate accepting a value the
 * scheduler has no branch for — the `as const` makes every reader exhaustive
 * against `WorkflowNodeKind` at the same time.
 */
const NODE_KINDS = ["run", "orchestrator", "merge"] as const satisfies readonly WorkflowNodeKind[];

const MAX_NODE_NAME = 60;

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

    // Absent is `run`, and it has to be: every graph saved before orchestrator
    // blocks existed says nothing here, and the other reading would turn a saved
    // workflow into one that starts agents nobody wrote.
    const rawKind = String(n.kind ?? "run");
    if (!(NODE_KINDS as readonly string[]).includes(rawKind)) {
      return {
        ok: false,
        error: `“${nodeName}” is not a kind of block this app has: ${rawKind}.`,
      };
    }
    const kind = rawKind as WorkflowNodeKind;

    // A merge block is told nothing. What it lands is whatever the blocks in
    // front of it left on a branch, and where each branch belongs was recorded
    // when its run cut it — so there is no task here for a person to write and
    // an empty one is the right answer rather than a missing one.
    const task = kind === "merge" ? "" : String(n.task ?? "").trim();
    if (kind !== "merge" && !task) {
      return {
        ok: false,
        error:
          kind === "orchestrator"
            ? `“${nodeName}” has nothing to decide. An orchestrator block with no brief is a billed turn that starts whatever it feels like.`
            : `“${nodeName}” has no task. A block with nothing to do is a run that spends a work cycle finding that out.`,
      };
    }

    // The fan-out cap: required on an orchestrator block, refused on a run one.
    //
    // Refused at *save* rather than at Run, and this is the sharpest case of
    // that rule in the file. Every other block puts one agent on the machine,
    // written out by a person. This one starts as many as it decides to, with
    // nothing between the decision and the spawn — so the number a person
    // agreed to has to exist before the graph can be saved at all, exactly as
    // the run loop refuses a policy with no monotone terminus.
    let fanOut: number | null = null;
    if (kind === "orchestrator") {
      const raw = Number(n.fanOut);
      if (!Number.isInteger(raw) || raw < 1) {
        return {
          ok: false,
          error:
            `“${nodeName}” needs a limit on how many runs it may start. It is ` +
            "the only block whose runs start with no approval, so a missing " +
            "limit is an unbounded number of agents from one press of Run.",
        };
      }
      if (raw > MAX_FAN_OUT) {
        return {
          ok: false,
          error:
            `“${nodeName}” may start at most ${MAX_FAN_OUT} runs; it is set to ` +
            `${raw}.`,
        };
      }
      fanOut = raw;
    }

    // How a merge block lands, and whether it may pay for a resolution.
    //
    // The strategy is required rather than defaulted to `settings.landStrategy`
    // — see `WorkflowNode.mergeStrategy` — and the editor pre-fills the picker
    // from that setting so the graph records what the operator was shown.
    // `=== true` for the reason `continueBranch` is read that way: it authorises
    // billed spend, so a string off the wire must fail safe.
    let mergeStrategy: LandStrategy | null = null;
    let mergeAutoResolve = false;
    if (kind === "merge") {
      const raw = String(n.mergeStrategy ?? "");
      if (raw !== "merge" && raw !== "squash") {
        return {
          ok: false,
          error: `“${nodeName}” needs to say how it lands a branch: merge or squash.`,
        };
      }
      mergeStrategy = raw;
      mergeAutoResolve = n.mergeAutoResolve === true;
    }

    // Null is "no template — use the guards in Settings", which is a real
    // answer rather than a missing one. Anything else has to exist now: a
    // graph naming a template nobody can find is one that can be saved and
    // never started.
    //
    // A merge block names none and can name none: guards decide what an agent
    // may do, this block starts no agent, and the one child it can cause —
    // `resolveConflicts`' — runs under that function's own fixed mode.
    const templateId =
      kind === "merge" ||
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

    // A merge block works in whichever repository each branch came from, so it
    // names no workspace at all rather than one it would never read. Requiring
    // one would make a block refusable — at save and at every Run — over a mount
    // that decides nothing about it.
    const mountId = kind === "merge" ? "" : String(n.mountId ?? "");
    if (kind !== "merge") {
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
    }

    const promptOverride =
      kind === "merge" ? "" : String(n.promptOverride ?? "").trim();

    // The agent this block's own child is started as.
    //
    // Refused rather than dropped on a merge block, and that is the one place
    // this loop's habit of coercing a field the kind does not hold stops. A
    // template on a merge block decides nothing, because no agent runs under
    // it; an agent named on a block that spawns no child at all is a choice the
    // operator made that no process will ever act on — which is the exact shape
    // `agents.ts` exists to refuse, and dropping it here would be this app
    // discarding it in silence at the one door built to end that. The sentence
    // changed shape with the flag and the refusal did not: under `--agents` the
    // objection was that there was nobody to hand the subtask to, and under
    // `--agent` it is that there is no child for the agent to *be*. Both ends
    // of a `continueBranch` edge are refused by name below on the same grounds.
    const namedAgent =
      n.agentId === null || n.agentId === undefined || String(n.agentId).trim() === ""
        ? null
        : String(n.agentId).trim();
    if (namedAgent !== null && kind === "merge") {
      return {
        ok: false,
        error:
          `“${nodeName}” lands the branches in front of it and starts no agent ` +
          "of its own, so there is nothing for that agent to be. Remove it, or " +
          "put it on the block that does the work.",
      };
    }
    const agentId = kind === "merge" ? null : namedAgent;
    if (agentId !== null) {
      // The same wording the run door and the template door give, prefixed with
      // the block — a graph is read as a list of steps, so every refusal here
      // names the one it is about.
      const refusal = agentRefusal(agentId, known.agents);
      if (refusal) return { ok: false, error: `“${nodeName}”: ${refusal}` };
    }

    nodes.push({
      id,
      name: nodeName,
      kind,
      templateId,
      agentId,
      mountId,
      // The empty string is the mount root — the one selection that blocks
      // every other run in the tree — so it is kept rather than collapsed into
      // "no folder", exactly as a template's is.
      folder: kind === "merge" ? "" : String(n.folder ?? ""),
      task,
      promptOverride: promptOverride || null,
      fanOut,
      mergeStrategy,
      mergeAutoResolve,
    });
    byId.set(id, nodes[nodes.length - 1]);
  }

  const edges: WorkflowEdge[] = [];
  const seenPairs = new Set<string>();
  /** The one dependency each node takes its branch from, by node id. */
  const branchFrom = new Map<string, string>();

  /**
   * Whether this node's runs get a checkout of their own — so whether there is
   * ever a branch to hand over, carry on, or land.
   *
   * Read off the guards rather than off the node, because that is where the
   * answer lives: a node names a template or names none and takes
   * `chatDefaultGuards`. It holds for an orchestrator block too — the runs it
   * emits take that same guard set, which is the whole of `guardsFor`'s point.
   */
  const isolated = (node: WorkflowNode) =>
    node.templateId === null
      ? known.defaultIsolate
      : (known.templates.get(node.templateId)?.isolate ?? false);

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
      // Only a run block has a checkout of its own. An orchestrator block
      // decides and spends nothing on disk; a merge block writes into somebody
      // else's checkout and cuts no branch. Refused by name at either end rather
      // than left to the isolation test below, which would say "its guards work
      // directly in the folder" — true of neither and misleading about what
      // would have to change.
      for (const node of [source, target]) {
        if (node.kind === "run") continue;
        return {
          ok: false,
          error:
            node.kind === "orchestrator"
              ? `“${node.name}” decides what to run rather than working in a ` +
                "checkout, so it has no branch to hand over or carry on."
              : `“${node.name}” lands other blocks' branches rather than ` +
                "working in a checkout of its own, so it has no branch to hand " +
                "over or carry on.",
        };
      }

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

  // A merge block lands what is in front of it, so what is in front of it has to
  // exist and has to have left a branch.
  //
  // Both halves are refused at *save* rather than at Run, which is this file's
  // standing rule and bites in the usual way: a merge block with nothing to land
  // is a block that reaches the front of the graph and can only report that it
  // was pointless, and a merge block behind runs that work directly in the
  // operator's folder is one that will find every predecessor branchless an hour
  // in. Both are answerable now, from the guards a person already chose.
  //
  // A merge block *may* sit behind another merge block — that is sequencing, and
  // it contributes no branches — so the requirement is one predecessor that
  // produces runs, not one predecessor.
  for (const node of nodes) {
    if (node.kind !== "merge") continue;
    const sources = edges
      .filter((e) => e.to === node.id)
      .map((e) => byId.get(e.from)!);
    const producers = sources.filter((s) => s.kind !== "merge");
    if (producers.length === 0) {
      return {
        ok: false,
        error:
          `“${node.name}” has no block in front of it whose work it could ` +
          "land. A merge block lands the branches its predecessors left, so it " +
          "needs at least one predecessor that runs something.",
      };
    }
    const bare = producers.find((s) => !isolated(s));
    if (bare) {
      return {
        ok: false,
        error:
          `“${bare.name}” leaves no branch for “${node.name}” to land — its ` +
          "guards work directly in the folder rather than in a checkout of " +
          "their own.",
      };
    }
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

  // Total, never a refusal: `null`/`""`/`0` all mean off, and a fraction guard
  // with no ceiling behind it is refused at *Run* rather than at Save. That is
  // the one place this file's "refuse at save what instantiation refuses" rule
  // does not apply, and deliberately: a ceiling is a Settings value that can be
  // typed at any time, so a graph saved without one is not unstartable — it is
  // unstartable *today*. The editor says so beside the field.
  const instanceBudget = normalizeInstanceBudget(o.instanceBudget);

  return { ok: true, value: { name, graph: { nodes, edges }, instanceBudget } };
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
    agents: currentAgentKnowledge(),
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
    // A merge block names no workspace: it works in whichever repository each
    // branch it lands came from, which `landRun` reads off that branch's own run.
    if (node.kind === "merge") continue;
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
/* A workflow the chat wrote                                           */
/* ------------------------------------------------------------------ */

/**
 * How a graph the chat proposed reads on the card the operator approves.
 *
 * Everything here is a *guard-shaped* fact — where a block runs, what it may
 * do, how many agents it may start, whether it may spend on a conflict — and it
 * is assembled here rather than in the page for `defaultGuardsLabel`'s reason:
 * an approval gate that does not show what is being approved is a gate that
 * gets clicked through, and the guards are not on the graph, they are on the
 * templates it names.
 */
export interface ProposedBlockSummary {
  name: string;
  kind: WorkflowNodeKind;
  /** The template's name, or what the untemplated guard set permits. */
  guardsLabel: string;
  /**
   * The agent this block's child is started as, by name, or null for none.
   *
   * Separate from `guardsLabel` rather than folded into it, which is the same
   * separation `BlockStatement` makes in the editor and for the same reason: an
   * agent bounds nothing, so a phrase inside the guard clause would claim it
   * does. `"agent deleted"` when the id names nothing, which is what
   * `guardsLabel` already says one field over about a template — approval
   * refuses it by name either way.
   */
  agentLabel: string | null;
  /** Where it runs, as the folder picker words it. Null on a merge block. */
  folderLabel: string | null;
  /** How many runs a deciding block may start. Null on every other kind. */
  fanOut: number | null;
  /** Whether a merge block may pay a model to reconcile a conflict. */
  mergeAutoResolve: boolean;
  /** The blocks it starts after, by name. */
  after: string[];
}

export type WorkflowProposalPlan =
  | { ok: true; input: WorkflowInput }
  | { ok: false; reason: string };

/**
 * Turn a proposed graph into the workflow it asks for, or say why not.
 *
 * `planProposal` one level up, and the same division of labour: the chat says
 * what work to do and something a person wrote says what an agent may do. Every
 * guard in the graph comes from a block's named template or from
 * `settings.chatDefaultGuards`, exactly as `planNode` resolves them — there is
 * no permission mode, budget, isolation choice or model anywhere on a node for
 * a model to reach, which is what makes a graph safe to let one write.
 *
 * **Approving it saves a workflow and starts nothing.** That is deliberate and
 * is the whole reason this is allowed at all: an orchestrator block's runs start
 * with nobody looking *because a person fixed its folder, its guard set and its
 * fan-out cap when they saved the graph*, and a graph a model wrote has no such
 * person in it. Saving rather than starting puts one back — the operator reads
 * the card, then opens the canvas, then presses Run — so by the time an agent
 * exists, two separate human decisions stand behind every number in it.
 *
 * The instance budget is **not** carried from the proposal, and there is
 * nothing on the wire that could carry it: it is a limit on billed spend, which
 * is the one class of value no route here lets a model set. `startWorkflow`
 * still refuses a fraction guard with no ceiling, and a schedule still refuses a
 * workflow whose budget sets nothing, so what an approved proposal produces is a
 * workflow that runs by hand and cannot yet be scheduled. The card says so.
 *
 * Re-normalized rather than trusted: the graph was checked when it was
 * proposed, and the templates and mounts it names can be gone by the time
 * anyone clicks — the same window `planProposal`'s missing-template refusal
 * covers, and refused the same way rather than falling back to guards nobody
 * chose.
 */
export function planWorkflowProposal(
  proposal: { title: string; graph: string | null },
  known: WorkflowKnowledge,
): WorkflowProposalPlan {
  if (!proposal.graph) {
    return { ok: false, reason: "This proposal carries no workflow to save." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(proposal.graph);
  } catch {
    return { ok: false, reason: "This proposal's workflow could not be read." };
  }

  const parsed = normalizeWorkflowInput(
    // The name is the proposal's title, so what the operator approved and what
    // appears in the workflow list are the same string.
    { name: proposal.title, graph: raw, instanceBudget: null },
    known,
  );
  if (!parsed.ok) return { ok: false, reason: parsed.error };
  return { ok: true, input: parsed.value };
}

/** What the chat proposed, in the terms the card has to show. */
export function summarizeProposedGraph(
  graph: WorkflowGraph,
  known: WorkflowKnowledge,
  untemplatedLabel: string,
): ProposedBlockSummary[] {
  const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
  return graph.nodes.map((node) => ({
    name: node.name,
    kind: node.kind,
    guardsLabel:
      node.kind === "merge"
        ? "no agent"
        : node.templateId === null
          ? untemplatedLabel
          : (known.templates.get(node.templateId)?.name ?? "template deleted"),
    // The registry's own spelling rather than the graph's id, because the id is
    // a thing only this app's forms hold and the card is read by a person.
    agentLabel: node.agentId
      ? (known.agents.get(node.agentId)?.name ?? "agent deleted")
      : null,
    folderLabel:
      node.kind === "merge"
        ? null
        : `${mountById(node.mountId)?.label ?? node.mountId}${
            node.folder ? `/${node.folder}` : " (mount root)"
          }`,
    fanOut: node.fanOut,
    mergeAutoResolve: node.mergeAutoResolve,
    after: graph.edges
      .filter((e) => e.to === node.id)
      .map((e) => names.get(e.from) ?? e.from),
  }));
}

export type WorkflowApproval =
  | { ok: true; workflowId: string; name: string }
  | { ok: false; reason: string };

/**
 * Save the workflow a proposal asks for, and record what it became.
 *
 * Synchronous like `approveProposal`, though nothing here claims a folder: it
 * runs inside the same pass, and a route that is synchronous throughout is one
 * that cannot grow an `await` between two approvals of the same folder later.
 */
export function approveWorkflowProposal(id: string): WorkflowApproval {
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, reason: "No such proposal." };
  if (proposal.kind !== "workflow") {
    return { ok: false, reason: "This proposal is a run, not a workflow." };
  }

  const plan = planWorkflowProposal(proposal, currentKnowledge());
  if (!plan.ok) {
    markProposal(id, "failed", { error: plan.reason });
    return { ok: false, reason: plan.reason };
  }

  // The folder check the save route runs, for the reason it runs it there: a
  // block's folder is what its run will use and nothing asks about it again.
  const missing = folderRefusal(plan.input.graph);
  if (missing) {
    markProposal(id, "failed", { error: missing });
    return { ok: false, reason: missing };
  }

  try {
    const workflow = createWorkflow(plan.input);
    markProposal(id, "approved", { workflowId: workflow.id });
    return { ok: true, workflowId: workflow.id, name: workflow.name };
  } catch (err) {
    // A duplicate name arrives here as the sentence the form would show.
    const reason = err instanceof Error ? err.message : String(err);
    markProposal(id, "failed", { error: reason });
    return { ok: false, reason };
  }
}

/* ------------------------------------------------------------------ */
/* One node becomes one run                                            */
/* ------------------------------------------------------------------ */

export type NodePlan =
  | { ok: true; input: Omit<CreateRunInput, "dependsOn" | "origin"> }
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
 * a budget, a permission mode or an isolation choice. The agent is not one of
 * those and never becomes one: it is resolved by the caller for the reason the
 * template is — this function stays pure — and it reaches the run as a
 * definition rather than as a capability.
 */
export function planNode(
  node: WorkflowNode,
  template: RunTemplate | null,
  defaults: RunGuards,
  agent: RegistryAgent | null,
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

  // Refused by name for the template's reason and the registry's own: a run
  // that was to be started as an agent and is started as nobody is bit-for-bit
  // a run that was never given one, and nothing downstream can tell them apart
  // — not the event log, not the cost, not the transcript's own attribution.
  // Under `--agent` the other half is louder: a decayed definition reaches the
  // argv and the spawn fails, every cycle, with the reason only in stderr.
  //
  // Read as truthy rather than against null, unlike the template above it: a
  // graph blob copied onto an instance before this field existed has no key
  // here at all, and `undefined !== null` would refuse every block of every
  // instance still in flight across the upgrade.
  if (node.agentId) {
    const refusal = agentRefusal(node.agentId, agentKnowledgeOf(agent));
    if (refusal) return { ok: false, reason: `“${node.name}”: ${refusal}` };
  }

  const task = node.task.trim();
  if (!task) return { ok: false, reason: `“${node.name}” has no task.` };

  const guards = guardsFor(template, defaults);
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
      // And this one comes from the node and from nowhere else, because it is
      // work rather than permission — see `WorkflowNode.agentId`. Frozen onto
      // the run by `createRun`, so the row keeps what it was started with.
      agent: node.agentId && agent ? agentDefinition(agent) : null,
    },
  };
}

/**
 * The guards a block's runs go under: its template's, or the operator's own.
 *
 * One function rather than the same three-field literal in three places,
 * because the *absence* of a fourth field is what the whole design rests on.
 * `planProposal` states it, `planNode` states it, and an orchestrator block's
 * emitted runs now state it too — and a fourth copy of a spread is a fourth
 * chance for a value off the wire to join it.
 */
function guardsFor(
  template: RunTemplate | null,
  defaults: RunGuards,
): RunGuards {
  return template
    ? {
        permissionMode: template.permissionMode,
        isolate: template.isolate,
        budget: template.budget,
      }
    : defaults;
}

/**
 * Turn one emitted spec into the run it asks for.
 *
 * `planNode` with the *task and folder* coming off the spec instead of off the
 * node — which is exactly and only what an orchestrator block's turn is allowed
 * to decide. Everything else is read from the block a person saved: the mount,
 * the standing instructions, and every guard.
 *
 * There is deliberately no branch in here that reads a guard, a permission mode
 * or an isolation choice off the spec, for the reason `planProposal` has none:
 * `--permission-mode` is not a thing a model should be able to reach for, and
 * this is the one path in the app where nobody looks at the answer before it
 * becomes a process.
 *
 * The **agent is the third thing the turn decides** — who the emitted run *is*
 * — and it belongs with the task and the folder rather than with the guards: an
 * agent is a description and a prompt, it carries no tool list and no permission
 * mode, and every guard below still comes off the block a person saved. It is
 * resolved by
 * the caller — `planEmission` has already refused a name the registry does not
 * have, and this takes the definition that name resolved to.
 */
export function planEmittedRun(
  node: WorkflowNode,
  spec: RunSpec,
  template: RunTemplate | null,
  defaults: RunGuards,
  agent: AgentDefinition | null,
): Omit<CreateRunInput, "dependsOn" | "origin"> {
  const guards = guardsFor(template, defaults);
  const base = node.promptOverride?.trim() || template?.prompt || null;
  return {
    folder: spec.folder,
    mountId: node.mountId,
    prompt: composeTask(base, spec.task),
    permissionMode: guards.permissionMode,
    isolate: guards.isolate,
    budget: guards.budget,
    agent,
  };
}

/* ------------------------------------------------------------------ */
/* What an orchestrator block may emit — pure                          */
/* ------------------------------------------------------------------ */

/**
 * One run an orchestrator block asks for.
 *
 * Five fields, and the list is the boundary rather than a starting point: a
 * title, the brief, a folder, an agent, and which of its siblings it starts
 * after. There is no template id, no budget, no permission mode, no isolation
 * choice and no model, because the block's own template already answered all of
 * those and a spec that could answer them again would be a fifth route to
 * `--permission-mode` reached by a model with nobody reading the result.
 *
 * The agent is not one of those and cannot become one. An agent is a description
 * and a prompt — the registry refuses a tool list at the door and has no column
 * for a permission mode — so naming one is the same class of act as writing the
 * task text beside it: it decides who the run *is*, and every guard still comes
 * from the block a person saved.
 */
export interface RunSpec {
  /** Stable within one emission; the edges below name it. */
  id: string;
  /** Short label, shown on the instance page in place of a block name. */
  title: string;
  /** The whole brief for the agent, appended to the block's standing prompt. */
  task: string;
  /** Path within the *block's* own folder. `""` is the mount root. */
  folder: string;
  /**
   * A saved agent to start this run **as**, by **name**, or null.
   *
   * A name rather than an id because a name is what the turn was shown — see
   * `blockSystemPrompt` — and it is the registry's own spelling of it rather
   * than the turn's, because the name is the key of the object `--agents` takes
   * *and* the word `--agent` is handed to select it. A misspelling that reached
   * the argv would not be quietly ignored; it would fail the spawn.
   */
  agent: string | null;
  /** Siblings in this same emission that must settle first. */
  dependsOn: Array<{ id: string; edge: DependencyEdge }>;
}

export type EmissionPlan =
  | { ok: true; specs: RunSpec[] }
  | { ok: false; reason: string };

/** What a block is measured against when it emits. Injected, so this is pure. */
export interface EmissionLimits {
  blockName: string;
  /** The cap a person saved. Never null — `normalizeWorkflowInput` sees to it. */
  fanOut: number;
  /**
   * Why this folder cannot be used, or null when it can.
   *
   * Injected rather than called, for the reason `WorkflowKnowledge` is: the
   * containment decision is a syscall (`resolveWorkspaceFolder`, run against the
   * block's own mount and no other), and everything else here has to stay
   * testable without one.
   */
  folderRefusal: (folder: string) => string | null;
  /**
   * The registry, as the turn was shown it.
   *
   * Data rather than an injected function, unlike `folderRefusal` beside it:
   * containment is a syscall and this is a list, which is the same split
   * `WorkflowKnowledge` makes between its templates and `folderRefusal`. Only
   * the two fields a refusal is written from — a spec that names an agent gets
   * the whole definition later, from the registry, at the moment its run is
   * created.
   */
  agents: readonly AgentFacts[];
}

/** How many characters of a spec's own fields are worth keeping. */
const MAX_SPEC_TITLE = 80;

/**
 * Read what a block emitted, refusing anything that could not be started.
 *
 * Pure and unit-tested, and it earns that harder than anything else in this
 * file: it is the step where text a model wrote becomes N processes with write
 * access to a directory, with **no person between the two**. Every branch here
 * is silent when it is wrong — a spec past the cap is an agent the operator
 * never agreed to, a folder outside the block's own is an agent in a repository
 * this block was never pointed at, and a loop among the specs is a set of runs
 * that would sit `waiting` for each other for ever.
 *
 * The cap is checked before anything else about the specs, because it is the
 * one refusal the model can act on by emitting fewer.
 *
 * An empty emission is **legal**: "there is nothing to do" is a real answer and
 * the alternative is a block that has to invent work to say so. What it means
 * for the blocks behind it is a separate decision, and `planInstanceStep` makes
 * it.
 */
export function planEmission(raw: unknown, limits: EmissionLimits): EmissionPlan {
  const list = Array.isArray(raw) ? raw : null;
  if (!list) {
    return {
      ok: false,
      reason: "runs has to be a list of run specs, even if it is empty.",
    };
  }

  if (list.length > limits.fanOut) {
    return {
      ok: false,
      reason:
        `“${limits.blockName}” may start at most ${limits.fanOut} run(s) and ` +
        `this asks for ${list.length}. That limit was set when the workflow ` +
        "was saved and cannot be raised from here. Emit the most important " +
        `${limits.fanOut} and say what you left out.`,
    };
  }

  const specs: RunSpec[] = [];
  const byId = new Map<string, RunSpec>();

  for (const [index, entry] of list.entries()) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const where = `Run ${index + 1}`;

    const id = String(e.id ?? "").trim();
    if (!NODE_ID.test(id)) {
      return {
        ok: false,
        reason: `${where} has no usable id. An id is 1–64 letters, digits, hyphens or underscores, and the dependsOn entries name it.`,
      };
    }
    if (byId.has(id)) {
      return {
        ok: false,
        reason: `Two runs share the id “${id}”, so a dependsOn naming it names both.`,
      };
    }

    const title = String(e.title ?? "").trim();
    if (!title) return { ok: false, reason: `${where} needs a title.` };

    const task = String(e.task ?? "").trim();
    if (!task) {
      return {
        ok: false,
        reason: `“${title}” has no task. It is the whole brief the agent gets, and it cannot ask a follow-up question.`,
      };
    }

    // `""` is the mount root and a real answer, exactly as it is on a node — so
    // it is never collapsed into "no folder named".
    const folder = String(e.folder ?? "");
    const refusal = limits.folderRefusal(folder);
    if (refusal) {
      return {
        ok: false,
        reason:
          `“${title}” names a folder that cannot be used: ${refusal} A run ` +
          `this block starts has to be inside “${limits.blockName}”'s own ` +
          "workspace; use a folder exactly as list_folders gives it.",
      };
    }

    // The agent, checked here beside the cap and the folder because this is the
    // last moment before these become processes. Refused by name rather than
    // dropped, which is `agentRefusal`'s rule reached from the one door where
    // nobody is looking: a run emitted "as the reviewer" and started as nobody
    // is indistinguishable afterwards from a run that named none.
    const namedAgent = String(e.agent ?? "").trim();
    let agent: string | null = null;
    if (namedAgent !== "") {
      // Case-folded because `idx_agents_name` is, so the name the turn typed
      // and the name the operator saved are one agent here too.
      const match = limits.agents.find(
        (a) => a.name.toLowerCase() === namedAgent.toLowerCase(),
      );
      if (!match) {
        return {
          ok: false,
          reason:
            `“${title}” asks for an agent this install does not have: ` +
            `${namedAgent}. Name one of the agents listed in your instructions, ` +
            "or leave it out — a run started as no agent is the ordinary run.",
        };
      }
      if (!match.usable) {
        return {
          ok: false,
          reason:
            `“${title}” asks for the “${match.name}” agent, which is missing ` +
            "its description or its prompt. Claude Code will not register such " +
            "an agent, so the run would fail the moment it spawned. Name " +
            "another, or leave it out.",
        };
      }
      // The registry's spelling, not the turn's — see `RunSpec.agent`.
      agent = match.name;
    }

    specs.push({
      id,
      title: title.slice(0, MAX_SPEC_TITLE),
      task,
      folder,
      agent,
      dependsOn: [],
    });
    byId.set(id, specs[specs.length - 1]);
  }

  const seenPairs = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const spec = specs[index];
    const links = Array.isArray(e.dependsOn) ? e.dependsOn : [];

    for (const link of links) {
      const l = (link ?? {}) as Record<string, unknown>;
      const from = String(l.id ?? "");
      const target = byId.get(from);
      if (!target) {
        return {
          ok: false,
          reason:
            `“${spec.title}” is set to start after “${from}”, which is not one ` +
            "of the runs being emitted. A run can only wait for its siblings " +
            "in this same emission.",
        };
      }
      if (from === spec.id) {
        return { ok: false, reason: `“${spec.title}” is set to start after itself.` };
      }
      const pair = `${from} ${spec.id}`;
      if (seenPairs.has(pair)) {
        return {
          ok: false,
          reason: `“${spec.title}” is set to start after “${target.title}” twice, so it is unclear which condition applies.`,
        };
      }
      seenPairs.add(pair);

      const edge = String(l.edge ?? "");
      if (!(DEPENDENCY_EDGES as readonly string[]).includes(edge)) {
        return {
          ok: false,
          reason: `“${spec.title}” needs a condition for starting after “${target.title}”: ${DEPENDENCY_EDGES.join(" or ")}.`,
        };
      }
      spec.dependsOn.push({ id: from, edge: edge as DependencyEdge });
    }
  }

  // The same detector the run graph and the saved graph use, given the spec ids.
  //
  // This is where "acyclic by construction" stops being an argument. `createRun`
  // mints a run's id *after* reading its edges, so nothing can already point at
  // it — which was the whole reason a cycle was impossible. That still holds for
  // each individual insert, but the graph being inserted is now one a **model**
  // wrote, and creating a cyclic set in topological order is not possible at
  // all: the first spec would name a run that does not exist yet and
  // `createRun` would refuse it as a missing run rather than as the loop it is.
  // So the loop is named here, before anything is created, and
  // `admitDependencies` re-runs the same check over the live graph at every one
  // of those inserts.
  const loop = dependencyCycle(
    specs.flatMap((s) =>
      s.dependsOn.map((d) => ({ runId: s.id, dependsOn: d.id, edge: d.edge })),
    ),
  );
  if (loop) {
    return {
      ok: false,
      reason:
        "These runs wait for each other in a loop, so none of them could ever " +
        `start: ${loop.map((id) => byId.get(id)?.title ?? id).join(" → ")}.`,
    };
  }

  // Returned in the order they will be created, so every spec is created after
  // everything it waits for — the property `startWorkflow` needs of a graph, for
  // the identical reason.
  const { order } = topologicalOrder({
    nodes: specs,
    edges: specs.flatMap((s) => s.dependsOn.map((d) => ({ from: d.id, to: s.id }))),
  });
  return { ok: true, specs: order.map((id) => byId.get(id)!) };
}

/* ------------------------------------------------------------------ */
/* What the instance does next — pure                                  */
/* ------------------------------------------------------------------ */

/**
 * Where one non-run block of an instance has got to.
 *
 * A lifecycle rather than an orchestrator's vocabulary, which is why a merge
 * block reuses it verbatim instead of adding two statuses of its own: `thinking`
 * is "a child of this block is in flight", `emitted` is "it finished and did its
 * thing". Every liveness query, every halt and every boot reconciler keys on
 * those two words, and a fourth and fifth would be five more places to remember
 * — one of them missed being a merge running under an instance the page says is
 * stopped. The page says "merging" and "merged" for a merge block; the column
 * says what the machinery reads.
 */
export type BlockStatus =
  | "waiting"
  | "thinking"
  | "emitted"
  | "failed"
  | "blocked";

/** One node of an instance as the scheduler sees it. */
export interface InstanceNodeState {
  /** The run this node became, or null when it has not been created. */
  run: DependencyState | null;
  /**
   * The ledger row: an orchestrator block's turn, or a run block that was
   * never created because nothing in front of it could hand it any work.
   */
  block: {
    status: BlockStatus;
    /** The runs an orchestrator block started, as their rows stand now. */
    emitted: readonly DependencyState[];
    /** Why it ended this way, for the sentence its successors carry. */
    error: string | null;
  } | null;
}

/** One node that may now be created, with the edges it resolves to. */
export interface InstanceCreation {
  nodeId: string;
  dependsOn: Array<{
    runId: string;
    edge: DependencyEdge;
    continueBranch: boolean;
  }>;
}

/** One merge block that may now run, with the runs whose branches it lands. */
export interface InstanceMerge {
  nodeId: string;
  /**
   * The runs its satisfied edges resolved to, in the order the graph declared
   * them — which becomes the queue's `position`, so two presses of Run on one
   * graph land the same branches in the same order.
   *
   * Taken from the same `dependsOn` a run block would have been created with,
   * rather than re-derived from the edges: which runs an orchestrator block
   * turned out to emit is a fact only `edgeVerdict` has, and a second reading of
   * it is a second chance to land a different set.
   */
  runIds: string[];
}

export interface InstanceStep {
  /** Orchestrator blocks whose turn may start now. */
  spawn: string[];
  /** Merge blocks whose branches may now be queued. */
  merge: InstanceMerge[];
  /** Run blocks that may now be created. */
  create: InstanceCreation[];
  /** Nodes that can never start, each with the sentence naming what stopped it. */
  block: Array<{ nodeId: string; reason: string }>;
}

/** What an edge into a node says about whether that node may go ahead. */
type EdgeVerdict =
  | { kind: "satisfied" }
  | { kind: "pending" }
  | { kind: "blocked"; reason: string };

const PENDING: EdgeVerdict = { kind: "pending" };
const SATISFIED: EdgeVerdict = { kind: "satisfied" };

/**
 * What an instance may do right now: which turns to start, which blocks to
 * create, and which can never happen at all.
 *
 * Pure and unit-tested, and it is `releasableRuns` for the half of a graph that
 * is not runs yet — with the same two silent failures. A block released too
 * early is an agent started on work that has not happened; a block neither
 * released nor terminated is a row that sits `waiting` for ever, which for an
 * orchestrator block means the whole subgraph behind it never starts and
 * nothing on the page says why.
 *
 * **An orchestrator block that emitted nothing blocks what is behind it.** That
 * is a decision rather than a fallout, and it is `edgeSatisfied`'s rule read one
 * level up: a dependency that ran no work cycle satisfies nothing, because the
 * successor's whole reason for existing is work that did not happen. A block
 * behind a fan-out is there to review it, land it, or follow it up; started with
 * nothing in front of it, it spends a billed cycle discovering that. Blocked
 * costs nothing and says which block decided there was nothing to do.
 *
 * A node is considered only when every edge into it is *satisfied* rather than
 * merely resolvable, which is why the runs an orchestrator block emitted have to
 * finish before the block behind them is created. That costs nothing — a node
 * that has not been created holds no folder, no checkout and no place in the
 * queue, which is exactly what `waiting` was invented for — and it means the
 * edges are recorded on a run that `admitDependencies` then re-checks.
 *
 * The pass repeats to a fixed point, and that loop is the cascade: a node
 * blocked here is a settled predecessor that produced nothing, so everything
 * behind it blocks on the next pass with its own sentence naming the node in
 * front of it rather than one shared verdict about a block it never heard of.
 */
export function planInstanceStep(
  graph: WorkflowGraph,
  state: ReadonlyMap<string, InstanceNodeState>,
): InstanceStep {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const list = incoming.get(e.to);
    if (list) list.push(e);
    else incoming.set(e.to, [e]);
  }

  // A working copy, so a node blocked in one pass is a blocked *predecessor* in
  // the next without writing anything.
  const live = new Map<string, InstanceNodeState>();
  for (const node of graph.nodes) {
    live.set(node.id, state.get(node.id) ?? { run: null, block: null });
  }

  const step: InstanceStep = { spawn: [], merge: [], create: [], block: [] };
  const decided = new Set<string>();

  for (;;) {
    let changed = false;

    for (const node of graph.nodes) {
      if (decided.has(node.id)) continue;
      const own = live.get(node.id)!;
      // Already a run, or a block that has started or settled: not this
      // function's business any more. `releasableRuns` owns a created run from
      // here on, and a `thinking` block owns itself until its child returns.
      // A `waiting` ledger row is the *only* state that is still open, and it
      // means the same thing for both kinds — nothing has happened yet.
      if (own.run || (own.block && own.block.status !== "waiting")) continue;

      let stopper: string | null = null;
      let pending = false;
      const dependsOn: InstanceCreation["dependsOn"] = [];

      for (const edge of incoming.get(node.id) ?? []) {
        const from = byId.get(edge.from)!;
        const verdict = edgeVerdict(from, live.get(from.id)!, edge, dependsOn);
        if (verdict.kind === "blocked") {
          stopper = verdict.reason;
          break;
        }
        if (verdict.kind === "pending") pending = true;
      }

      if (stopper !== null) {
        step.block.push({ nodeId: node.id, reason: stopper });
        live.set(node.id, {
          run: null,
          block: { status: "blocked", emitted: [], error: stopper },
        });
      } else if (pending) {
        continue;
      } else if (node.kind === "orchestrator") {
        step.spawn.push(node.id);
      } else if (node.kind === "merge") {
        // Deduplicated, because two edges can resolve to one run: a diamond
        // whose branches meet again at the merge block. Queueing a branch twice
        // is refused by `enqueue` anyway, which would refuse the *whole* merge.
        step.merge.push({
          nodeId: node.id,
          runIds: [...new Set(dependsOn.map((d) => d.runId))],
        });
      } else {
        step.create.push({ nodeId: node.id, dependsOn });
      }
      decided.add(node.id);
      changed = true;
    }

    if (!changed) return step;
  }
}

/**
 * What one edge says, and — when it says "go ahead" — which runs it resolves to.
 *
 * The three kinds of predecessor answer differently. A run block is one run,
 * decided when the graph was written; an orchestrator block is however many runs
 * it turned out to emit, and a successor waits for *all* of them, which is
 * `admitDependencies`' fan-in rule applied to a fan-in nobody could write down.
 * A merge block resolves to **no runs at all** — it created none — so it can
 * only sequence what follows it, which is exactly what a block set to run "after
 * the work has landed" is asking for.
 */
function edgeVerdict(
  from: WorkflowNode,
  state: InstanceNodeState,
  edge: WorkflowEdge,
  dependsOn: InstanceCreation["dependsOn"],
): EdgeVerdict {
  if (from.kind === "merge") {
    const block = state.block;
    if (!block || block.status === "waiting" || block.status === "thinking") {
      return PENDING;
    }
    if (block.status === "blocked") {
      return {
        kind: "blocked",
        reason: `“${from.name}” never ran: ${block.error ?? "no reason recorded."}`,
      };
    }
    // A merge block that failed still *finished*, having tried, which is what
    // separates it from one that never ran — the same distinction
    // `edgeSatisfied` draws between a run that did a cycle and a run that did
    // not. So `on-finish` is satisfied by it and `on-success` is not, and the
    // condition on the edge decides rather than one blanket rule: "review it
    // whether or not it landed" and "only once it is on main" are both things a
    // person writes, and there is no defensible default between them.
    if (block.status === "failed" && edge.edge === "on-success") {
      return {
        kind: "blocked",
        reason: `“${from.name}” did not land everything it was given: ${block.error ?? "the merge failed."}`,
      };
    }
    // Nothing is pushed onto `dependsOn`: a merge block created no run, so a
    // successor of it depends on no run through this edge. A successor with no
    // other predecessor is created with an empty dependency list, which is an
    // ordinary queued run — "start once the work has landed".
    return SATISFIED;
  }

  if (from.kind === "run") {
    if (!state.run) {
      // Not created yet. Still `waiting` means it is behind a decision that has
      // not been made; anything else means it never will be, which is the
      // cascade one link along.
      if (state.block && state.block.status !== "waiting") {
        return {
          kind: "blocked",
          reason: `Set to start after “${from.name}”, which never ran: ${state.block.error ?? "no reason recorded."}`,
        };
      }
      return PENDING;
    }
    if (edgeSatisfied(state.run, edge.edge)) {
      dependsOn.push({
        runId: state.run.id,
        edge: edge.edge,
        continueBranch: edge.continueBranch,
      });
      return SATISFIED;
    }
    if (TERMINAL_STATUSES.includes(state.run.status)) {
      return {
        kind: "blocked",
        reason: `Set to start after “${from.name}”, which ended ${state.run.status}.`,
      };
    }
    return PENDING;
  }

  const block = state.block;
  if (!block || block.status === "waiting" || block.status === "thinking") {
    return PENDING;
  }
  if (block.status === "failed") {
    return {
      kind: "blocked",
      reason: `“${from.name}” could not decide what to start: ${block.error ?? "the turn failed."}`,
    };
  }
  if (block.status === "blocked") {
    return {
      kind: "blocked",
      reason: `“${from.name}” never ran: ${block.error ?? "no reason recorded."}`,
    };
  }

  // Emitted. Nothing to follow is the deliberate refusal — see `planInstanceStep`.
  if (block.emitted.length === 0) {
    return {
      kind: "blocked",
      reason:
        `“${from.name}” decided there was nothing to start, so there is no ` +
        "work for this block to follow.",
    };
  }

  let pending = false;
  for (const run of block.emitted) {
    if (edgeSatisfied(run, edge.edge)) continue;
    if (TERMINAL_STATUSES.includes(run.status)) {
      return {
        kind: "blocked",
        reason: `Set to start after every run “${from.name}” started; one of them ended ${run.status} without qualifying.`,
      };
    }
    pending = true;
  }
  if (pending) return PENDING;

  for (const run of block.emitted) {
    dependsOn.push({ runId: run.id, edge: edge.edge, continueBranch: false });
  }
  return SATISFIED;
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
  instance_budget: string | null;
}

const WORKFLOW_COLUMNS =
  "id, name, graph, created_at, updated_at, instance_budget";

/**
 * A stored budget blob as a policy. Null, unparseable and `{}` all read the
 * same: every limit off, which is what a workflow saved before this column
 * existed had.
 */
function parseInstanceBudget(raw: string | null): InstanceBudgetPolicy {
  if (!raw) return normalizeInstanceBudget(null);
  try {
    return normalizeInstanceBudget(JSON.parse(raw));
  } catch {
    return normalizeInstanceBudget(null);
  }
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
    instanceBudget: parseInstanceBudget(row.instance_budget),
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
      `SELECT ${WORKFLOW_COLUMNS} FROM workflows ORDER BY name COLLATE NOCASE`,
    )
    .all() as WorkflowRow[];
  return rows.map(rowToWorkflow);
}

export function getWorkflow(id: string): Workflow | null {
  const row = db()
    .prepare(`SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE id = ?`)
    .get(id) as WorkflowRow | undefined;
  return row ? rowToWorkflow(row) : null;
}

export function createWorkflow(input: WorkflowInput): Workflow {
  const id = randomUUID();
  const now = Date.now();
  withNameConflict(input.name, () =>
    db()
      .prepare(
        `INSERT INTO workflows (id, name, graph, instance_budget, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.graph),
        JSON.stringify(input.instanceBudget),
        now,
        now,
      ),
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
        "UPDATE workflows SET name = ?, graph = ?, instance_budget = ?," +
          " updated_at = ? WHERE id = ?",
      )
      .run(
        input.name,
        JSON.stringify(input.graph),
        JSON.stringify(input.instanceBudget),
        Date.now(),
        id,
      ),
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

  return createWorkflow({
    name,
    graph: source.graph,
    instanceBudget: source.instanceBudget,
  });
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
 * Four of the six are read off the members rather than stored, for one reason:
 * `workflow_instances.status` records what has been *done to* an instance — it
 * was rolled back, or a halt closed its door — and never what its members have
 * got to, which is a fact about the runs and the blocks. Nothing would write
 * that second fact: a signalled child takes seconds to die, and a graph whose
 * last member settles has nobody left to run a closing pass at all, least of
 * all after a restart.
 *
 * So `stopping` and `stopped` are one halted row, told apart by whether a
 * member is still live; and `started`, `finished` and `blocked` are one unhalted
 * row, told apart by whether anything is still live and whether anything was
 * written off. `finished` says the graph reached its end, not that every member
 * succeeded — how a member ended is on the member's own row, and a word here
 * that claimed otherwise would be this app reporting a failed run as work that
 * landed.
 */
export type WorkflowInstanceStatus =
  | "started"
  | "finished"
  | "blocked"
  | "failed"
  | "stopping"
  | "stopped";

/**
 * Whether anything may still happen to this instance.
 *
 * The three unhalted readings are one fact to everything that *acts* on an
 * instance: nobody has stopped it, so it may still create runs, spend, and be
 * stopped. Each of those sites tested `status === "started"` when that was the
 * only word for an unhalted row, and each would have quietly closed a door that
 * is open the moment `finished` and `blocked` were split out of it — a stop
 * answering "this run is already stopping" over a graph that had finished on
 * its own, a deferred block never created behind a member that had settled.
 * Named rather than repeated, so widening the vocabulary again is one edit.
 */
function instanceIsOpen(status: WorkflowInstanceStatus): boolean {
  return status === "started" || status === "finished" || status === "blocked";
}

/** What halted an instance. `null` on an instance nobody has stopped. */
export type HaltCauseKind = "operator" | "guard" | "fleet";

export interface WorkflowInstanceNode {
  nodeId: string;
  nodeName: string;
  position: number;
  runId: string;
  /** The orchestrator block that started this run, or null for a saved block. */
  emittedBy: string | null;
}

/** One block of an instance that is not a run. See `workflow_instance_blocks`. */
export interface WorkflowInstanceBlock {
  nodeId: string;
  nodeName: string;
  position: number;
  kind: WorkflowNodeKind;
  status: BlockStatus;
  startedAt: number | null;
  finishedAt: number | null;
  /** The turn's own spend. Never a run's, never a meter's. */
  costUSD: number;
  tokens: number;
  /** How many runs it started. 0 is an answer, not "not yet". */
  emitted: number;
  /**
   * Whether the turn ever called `emit_runs`. What separates the two ways a
   * block starts nothing: one decided there was nothing worth doing, the other
   * never got as far as deciding. Both read `emitted: 0`.
   */
  decided: boolean;
  /** What the turn replied, verbatim. Null on a turn that failed or said nothing. */
  reply: string | null;
  /** This app's own record of the turn — a refusal, a denial. Never the model's. */
  notes: string[];
  /** Branches a merge block put onto their target. 0 on every other kind. */
  branchesLanded: number;
  /**
   * Branches a merge block did not land, including the ones the queue never
   * attempted because the checkout stopped that repository. Counted apart from
   * `branchesLanded` rather than subtracted, because "landed three of four" and
   * "landed three of three" are different facts and only one needs attention.
   */
  branchesFailed: number;
  error: string | null;
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
  /**
   * Members that never ran, because something in front of them did not satisfy
   * its edge. What separates a graph that reached its end from one whose tail
   * was written off — both have nothing live, and only this says which.
   */
  blockedCount: number;
  /**
   * The limits this press of Run was started under — a copy taken then, never
   * the live workflow's. Editing the workflow must not move the guard an
   * instance is already being measured against, which is the rule the `graph`
   * blob beside it already follows.
   */
  instanceBudget: InstanceBudgetPolicy;
  /**
   * Which press of Run started it, and what authorised that press. Copied onto
   * every member's own `runs.origin`, and read again when a deferred node
   * becomes a run hours later. Null on instances written before the column.
   */
  origin: RunOrigin | null;
  originRef: string | null;
  /** What its blocks have spent: a measured floor and the guard's figure. */
  spend: InstanceProgress;
  nodes: WorkflowInstanceNode[];
  /** Orchestrator turns, and blocks that never became runs. */
  blocks: WorkflowInstanceBlock[];
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
  instance_budget: string | null;
  origin: string | null;
  origin_ref: string | null;
}

/**
 * What one press of Run has spent, in the two figures a budget decision needs.
 *
 * `spentUSD` is the sum of what each member's own CLI measured and reported
 * through its `result` event — a **floor**, because a cycle in flight has
 * reported nothing and contributes zero for its whole duration. `spentGuardUSD`
 * adds the two readings that exist precisely for that gap:
 *
 *  - `spent_usd_est`, a member's reconciled estimate for cycles that were
 *    killed before they could report, and
 *  - `telemetrySpendSince(runId, active_started_at)` for the cycle a member has
 *    in flight right now — the only reading in this app that moves *during* a
 *    cycle.
 *
 * That second one is a deliberate widening of the telemetry door. It was one
 * run reading its own current cycle for its own live guard; it is now also an
 * instance reading each member's current cycle for the instance guard. Same
 * function, same per-run and per-cycle bound, same destination — a `*Guard*`
 * figure that no display and no meter ever sees. Nothing here reaches
 * `runs.spent_usd`, `buildSnapshot()` or the dashboard.
 *
 * Bounded to `running` members for the telemetry half, for the reason
 * `fmtCycleInFlight` refuses the column on any other status: nothing clears
 * `active_started_at` when the container dies mid-cycle, so a `failed` row can
 * still name a cycle that ended hours ago.
 */
export function instanceSpend(instanceId: string): InstanceProgress {
  const rows = db()
    .prepare(
      `SELECT r.id AS id, r.status AS status, r.spent_usd AS spent,
              r.spent_usd_est AS est, r.active_started_at AS cycleStartedAt
         FROM workflow_instance_runs w
         JOIN runs r ON r.id = w.run_id
        WHERE w.instance_id = ?`,
    )
    .all(instanceId) as Array<{
    id: string;
    status: string;
    spent: number;
    est: number;
    cycleStartedAt: number | null;
  }>;

  let spentUSD = 0;
  let spentGuardUSD = 0;
  for (const row of rows) {
    spentUSD += row.spent;
    spentGuardUSD += row.spent + row.est;
    if (row.status === "running" && row.cycleStartedAt !== null) {
      spentGuardUSD += telemetrySpendSince(row.id, row.cycleStartedAt).costUSD;
    }
  }

  // What this instance's orchestrator blocks spent deciding.
  //
  // In **both** figures rather than neither, and that is a deliberate reading of
  // "a block's spend is not a run's". It is not: it never touches
  // `runs.spent_usd`, it is never summed into `buildSnapshot()` and no dashboard
  // meter sees it. But it is money this press of Run spent, measured by the same
  // `total_cost_usd` the CLI reports for a work cycle, and leaving it out would
  // give a graph with several deciding blocks a total that quietly understates
  // itself against the one limit meant to bound the whole thing. It is in the
  // measured figure as well as the guard's because it *is* measured — a turn
  // that ended reported its own cost, and the display-versus-guard split exists
  // for readings that are estimated, not for readings that are inconvenient.
  const blocks = db()
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM workflow_instance_blocks WHERE instance_id = ?",
    )
    .get(instanceId) as { spent: number };
  return {
    spentUSD: spentUSD + blocks.spent,
    spentGuardUSD: spentGuardUSD + blocks.spent,
  };
}

/** What an instance's members are doing, in the two counts a reading needs. */
export interface InstanceMemberTally {
  /** Runs still going, plus blocks still deciding or still waiting to. */
  live: number;
  /** Members written off because something in front of them satisfied nothing. */
  blocked: number;
}

/**
 * How much of this instance has not finished, and how much of it never ran.
 *
 * The block half of `live` is not decorative. `stopped` is derived from "nothing
 * is live", so a halt that left an orchestrator turn running would read as
 * *stopped* while a billed child was still deciding what to start — and
 * `startWorkflow`'s refusal of a second press reads the same count.
 *
 * `blocked` is counted over both halves for the same reason, one status along:
 * a dependency that did no work satisfies nothing, and either half of the graph
 * can be written off for it — a run by `releasableRuns`, a node still in the
 * ledger by `planInstanceStep`. An instance that counted only one of them would
 * report a graph missing its tail as a graph that reached its end.
 */
function memberTally(instanceId: string): InstanceMemberTally {
  const runs = db()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN r.status IN
                (${LIVE_STATUSES.map(() => "?").join(",")})
              THEN 1 ELSE 0 END), 0) AS live,
              COALESCE(SUM(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END), 0)
                AS blocked
         FROM workflow_instance_runs w
         JOIN runs r ON r.id = w.run_id
        WHERE w.instance_id = ?`,
    )
    .get(...LIVE_STATUSES, instanceId) as InstanceMemberTally;
  const blocks = db()
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN status IN ('waiting','thinking')" +
        " THEN 1 ELSE 0 END), 0) AS live," +
        " COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0)" +
        " AS blocked" +
        " FROM workflow_instance_blocks WHERE instance_id = ?",
    )
    .get(instanceId) as InstanceMemberTally;
  return {
    live: runs.live + blocks.live,
    blocked: runs.blocked + blocks.blocked,
  };
}

/**
 * Which of the six readings a stored row is, given what its members are doing.
 *
 * Pure and unit-tested for `haltPlan`'s reason: every way of being wrong here
 * typechecks, throws nothing and renders. A graph that finished an hour ago, one
 * whose tail was written off, and one with an agent working in it right now were
 * one word between them until this split, and that word is the whole of what an
 * operator reads to decide whether to wait, to look at a block, or to press Run
 * again.
 *
 * A halt outranks the members: an instance stopped with a member already written
 * off is `stopped`, because what ended it is the headline and the member says
 * the rest on its own row. An unrecognised stored value reads as an unhalted
 * one, the same forgiving default the graph blob gets — this is a record, and it
 * has to keep rendering.
 */
export function instanceStatus(
  stored: string,
  members: InstanceMemberTally,
): WorkflowInstanceStatus {
  if (stored === "failed") return "failed";
  if (stored === "stopping") return members.live > 0 ? "stopping" : "stopped";
  if (members.live > 0) return "started";
  return members.blocked > 0 ? "blocked" : "finished";
}

/** Every non-run block of one instance, in the order the graph declared them. */
export function blocksOf(instanceId: string): WorkflowInstanceBlock[] {
  const rows = db()
    .prepare(
      `SELECT node_id AS nodeId, node_name AS nodeName, position, kind, status,
              started_at AS startedAt, finished_at AS finishedAt,
              cost_usd AS costUSD, tokens, emitted_specs AS specs, error,
              merge_batch_id AS batchId, reply, notes,
              -- Read back off the queue's own rows rather than counted into the
              -- block as it went: those rows carry git's answer for each branch,
              -- and a copy on the block would be a second thing to keep in step
              -- with a worker that re-decides every item at its own turn.
              (SELECT COUNT(*) FROM merge_queue q
                WHERE q.batch_id = b.merge_batch_id AND q.status = 'landed')
                AS branchesLanded,
              (SELECT COUNT(*) FROM merge_queue q
                WHERE q.batch_id = b.merge_batch_id AND q.status <> 'landed')
                AS branchesFailed
         FROM workflow_instance_blocks b
        WHERE instance_id = ? ORDER BY position`,
    )
    .all(instanceId) as Array<
    Omit<WorkflowInstanceBlock, "emitted" | "decided" | "notes"> & {
      specs: string | null;
      batchId: string | null;
      notes: string | null;
    }
  >;
  return rows.map(({ specs, batchId, notes, ...row }) => ({
    ...row,
    emitted: parseSpecs(specs).length,
    // The column itself, not its contents: `[]` is a turn that called the tool
    // and named nothing, which is a decision, and null is a turn that never
    // reached one.
    decided: specs !== null,
    notes: splitNotes(notes),
    // A block with no batch has no branches either way, and the correlated
    // counts above answer 0 for it — but only because `merge_batch_id` is null
    // and nothing matches. Stated rather than relied on.
    branchesLanded: batchId ? row.branchesLanded : 0,
    branchesFailed: batchId ? row.branchesFailed : 0,
  }));
}

/** Stored notes as lines. One per fact, in the order they happened. */
function splitNotes(raw: string | null): string[] {
  return raw ? raw.split("\n").filter((line) => line.trim() !== "") : [];
}

/** Stored specs as a list. Unreadable and absent both read as "emitted none". */
function parseSpecs(raw: string | null): RunSpec[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RunSpec[]) : [];
  } catch {
    return [];
  }
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
      `SELECT node_id AS nodeId, node_name AS nodeName, position, run_id AS runId,
              emitted_by AS emittedBy
         FROM workflow_instance_runs WHERE instance_id = ? ORDER BY position`,
    )
    .all(row.id) as WorkflowInstanceNode[];

  const members = memberTally(row.id);

  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    graph,
    createdAt: row.created_at,
    origin: (RUN_ORIGINS as readonly string[]).includes(row.origin ?? "")
      ? (row.origin as RunOrigin)
      : null,
    originRef: row.origin_ref,
    // Four of the six are read off the members — see `instanceStatus`, which is
    // the whole of that decision and is pure so it can be tested.
    status: instanceStatus(row.status, members),
    error: row.error,
    stoppedAt: row.stopped_at,
    stopCause:
      row.stop_cause === "operator" || row.stop_cause === "guard"
        ? row.stop_cause
        : null,
    stopReason: row.stop_reason,
    liveRunCount: members.live,
    blockedCount: members.blocked,
    instanceBudget: parseInstanceBudget(row.instance_budget),
    spend: instanceSpend(row.id),
    nodes,
    blocks: blocksOf(row.id),
  };
}

const INSTANCE_COLUMNS =
  "id, workflow_id, workflow_name, graph, created_at, status, error," +
  " stopped_at, stop_cause, stop_reason, instance_budget";

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

/**
 * Blocks of this workflow that have not settled.
 *
 * The other half of "is anything from this workflow still going", and it is not
 * covered by the runs: a block still deciding has started nothing yet and is
 * about to start several. A second press of Run while one is thinking would
 * point the same blocks at the same folders and put two deciding turns on one
 * repository, which is the collision `liveRunsOf` exists to refuse one step
 * earlier than it can see.
 */
export function liveBlocksOf(workflowId: string): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM workflow_instance_blocks b
         JOIN workflow_instances i ON i.id = b.instance_id
        WHERE i.workflow_id = ? AND b.status IN ('waiting','thinking')`,
    )
    .get(workflowId) as { n: number };
  return row.n;
}

/* ------------------------------------------------------------------ */
/* Instantiating                                                       */
/* ------------------------------------------------------------------ */

export type StartOutcome =
  | { ok: true; instance: WorkflowInstance }
  | { ok: false; reason: string };

/**
 * Who pressed Run.
 *
 * A discriminated union rather than an optional schedule id, so the two cases
 * cannot both be absent and a caller cannot claim a schedule without naming
 * one. It carries authorisation and nothing else — no guard, no permission
 * mode, no budget — which is what keeps "a schedule is the same
 * `startWorkflow`" true.
 */
export type WorkflowTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; scheduleId: string };

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
 *
 * **`snapshot` is the only argument, and the instance budget is not among
 * them.** It is read off the saved workflow and nowhere else. There is no field
 * on the wire, no override on this function and no route that writes an
 * instance's copy of it, which is the strongest form of "nothing a model emits
 * may set it": an orchestrator block cannot raise its own instance's budget
 * because there is nothing to raise it *with*. The saved workflow is a person's
 * form, and the copy taken here is what the guard measures against for the life
 * of the instance, so editing the workflow mid-run cannot move it either.
 *
 * The snapshot is passed in rather than read, because this function is
 * synchronous from entry to the last `createRun` and `currentSnapshot()` is not
 * — the route awaits it and hands it over. It is used once, at the door: a
 * fraction guard with no ceiling behind it is refused here, where there is an
 * error channel, rather than tripping at the first block's guard check and
 * halting a graph that never should have started.
 *
 * `trigger` records *which* press of Run this was, and it grants nothing: there
 * is still no field on it that can reach a guard, a permission mode or an
 * isolation choice, so a schedule remains "the same `startWorkflow`, with
 * nobody present" rather than a second way of starting work. It is copied onto
 * the instance so a node created hours later, behind an orchestrator block's
 * decision, records the trigger the instance actually had.
 */
export function startWorkflow(
  id: string,
  snapshot: UsageSnapshot,
  trigger: WorkflowTrigger = { kind: "manual" },
): StartOutcome {
  // Before the instance row exists. `createRun` refuses too, but that refusal
  // would arrive mid-pass and take the rollback path — an instance recorded
  // `failed` and a graph half built — where this one is a sentence beside the
  // button, which is what every other reason a press of Run cannot happen gets.
  const notOwner = dataDirRefusal();
  if (notOwner) return { ok: false, reason: notOwner };

  const workflow = getWorkflow(id);
  if (!workflow) return { ok: false, reason: "No such workflow." };

  // A second instance would aim the same blocks at the same folders: the runs
  // would queue behind the first instance's on the folder claim, and a block
  // set to carry on a branch would be refused by `admitDependencies` because
  // the first instance's run already continues it. Refused here as a sentence,
  // rather than discovered four nodes into the pass.
  const live = liveRunsOf(id);
  const liveBlocks = liveBlocksOf(id);
  if (live.length + liveBlocks > 0) {
    return {
      ok: false,
      reason:
        `${live.length} run(s) and ${liveBlocks} block(s) from an earlier press ` +
        "of Run have not finished yet. Starting this workflow again would point " +
        "the same blocks at the same folders. Wait for them, or stop that run of " +
        "the workflow.",
    };
  }

  // The install-wide ceiling, before anything else about this workflow is
  // decided. `createRun` refuses every member individually, which would abort
  // the pass part-way and record the instance `failed` — a rollback in the
  // record for a limit that has nothing to do with this graph. Refused here it
  // is one sentence and no instance at all.
  const installRefusal = installBudgetRefusal();
  if (installRefusal) return { ok: false, reason: installRefusal };

  const known = currentKnowledge();
  const checked = normalizeWorkflowInput(workflow, known);
  if (!checked.ok) {
    return {
      ok: false,
      reason: `This workflow cannot be started as saved: ${checked.error}`,
    };
  }
  const graph = checked.value.graph;
  const instanceBudget = checked.value.instanceBudget;

  // The workflow-wide guard, read once before anything exists. Nothing has been
  // spent yet, so the only two verdicts reachable are the ones that are about
  // the *configuration* and the *window* rather than about this instance:
  //
  //   `no_ceiling` — a fraction guard with nothing behind it. Refused, not
  //   ignored, which is this app's standing rule: silently passing would leave
  //   the operator believing a guard is active. Refused *here* because this is
  //   the moment with an error channel; leaving it to the first block's check
  //   would create every run, spend a transcript scan, and then halt the whole
  //   graph with a sentence nobody was waiting for.
  //
  //   `weekly_fraction` / `session_fraction` — the window is already past the
  //   guard. Starting would create N runs and halt them before the first one
  //   worked, which is a workflow instance in the record for no reason.
  if (!instanceBudgetIsOff(instanceBudget)) {
    const verdict = evaluateInstanceBudget(instanceBudget, snapshot, {
      spentUSD: 0,
      spentGuardUSD: 0,
    });
    if (!verdict.allowed) {
      return {
        ok: false,
        reason: `This workflow's own limits will not let it start: ${verdict.reason}`,
      };
    }
  }

  // Planned in full before anything is created. A refusal here costs nothing;
  // the same refusal three nodes into the pass costs a rollback.
  //
  // An orchestrator block is planned too, even though it becomes no run: what
  // `planNode` refuses for it — a template that has been deleted — is refused
  // for the runs it will *emit*, which take their guards from that same
  // template, and finding that out an hour into the graph would mean a turn
  // billed for a decision nothing can act on.
  //
  // A merge block is the one kind that is not, and there is nothing left to
  // plan: it names no template, no mount, no folder and no task, so every
  // refusal `planNode` has is about a field it does not hold.
  const defaults = chatGuards();
  const plans = new Map<string, Omit<CreateRunInput, "dependsOn" | "origin">>();
  for (const node of graph.nodes) {
    if (node.kind === "merge") continue;
    const plan = planNode(
      node,
      node.templateId ? getTemplate(node.templateId) : null,
      defaults,
      // Resolved to a definition here and frozen onto the run by `createRun`,
      // so an agent deleted while this instance is working cannot reach a run
      // that has already started. `normalizeWorkflowInput` above has refused a
      // graph naming one that is already gone; this is the same refusal for the
      // row that goes between the two reads.
      node.agentId ? getAgent(node.agentId) : null,
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
  // A schedule firing and a person pressing Run are the same instantiation with
  // different authorisation behind them, which is the whole of what `origin`
  // records. The reference is the schedule, because "which schedule started
  // this" is the question a scheduled instance raises and the instance id
  // answers nothing.
  const origin: RunOrigin = trigger.kind === "schedule" ? "schedule" : "workflow";
  const originRef = trigger.kind === "schedule" ? trigger.scheduleId : instanceId;
  db()
    .prepare(
      `INSERT INTO workflow_instances
         (id, workflow_id, workflow_name, graph, instance_budget, created_at,
          status, error, origin, origin_ref)
       VALUES (?, ?, ?, ?, ?, ?, 'started', NULL, ?, ?)`,
    )
    .run(
      instanceId,
      id,
      workflow.name,
      JSON.stringify(graph),
      // The copy, taken once. Everything after this reads the instance's own,
      // so an edit to the workflow cannot move the guard under a running graph
      // — the same reason the graph blob is copied rather than joined to.
      JSON.stringify(instanceBudget),
      now,
      origin,
      originRef,
    );

  const addBlock = db().prepare(
    `INSERT INTO workflow_instance_blocks
       (instance_id, node_id, node_name, position, kind, status)
     VALUES (?, ?, ?, ?, ?, 'waiting')`,
  );

  // Which nodes cannot be created yet: every node with a block that is not a run
  // somewhere behind it. Its dependency edges name runs that do not exist — a
  // model has not decided on them, or a merge block will create none at all — so
  // it is created when they do, by `advanceInstances`. Everything else is
  // created here, in the one synchronous pass, exactly as before.
  const deferred = deferredNodes(graph);

  const runIds = new Map<string, string>();
  try {
    for (const [position, nodeId] of order.entries()) {
      const node = byId.get(nodeId)!;
      if (node.kind !== "run" || deferred.has(nodeId)) {
        addBlock.run(instanceId, nodeId, node.name, position, node.kind);
        continue;
      }
      const dependsOn = (incoming.get(nodeId) ?? []).map((e) => ({
        // Every predecessor is earlier in the topological order, so its run
        // already exists. That is the whole reason the order is computed.
        runId: runIds.get(e.from)!,
        edge: e.edge,
        continueBranch: e.continueBranch,
      }));
      const run = createRun({ ...plans.get(nodeId)!, dependsOn, origin, originRef });
      runIds.set(nodeId, run.id);
      recordMember(instanceId, {
        nodeId,
        nodeName: node.name,
        position,
        runId: run.id,
        emittedBy: null,
      });
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
    // The blocks too: nothing has spawned yet, so every one of them is
    // `waiting`, and a row left saying so under a `failed` instance is a block
    // the page reports as about to happen and nothing will ever pick up.
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='blocked', finished_at=?, error=?" +
          " WHERE instance_id=? AND status='waiting'",
      )
      .run(Date.now(), `${rolledBack}.`, instanceId);
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

  // And the other half of "start whatever can start": an orchestrator block
  // with nothing in front of it is ready the moment the graph exists. Outside
  // the creating pass, because it spawns.
  advanceInstances();
  return { ok: true, instance: getInstance(instanceId)! };
}

/** One block's run, recorded against the instance it belongs to. */
function recordMember(instanceId: string, node: WorkflowInstanceNode): void {
  db()
    .prepare(
      `INSERT INTO workflow_instance_runs
         (instance_id, node_id, node_name, position, run_id, emitted_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      instanceId,
      node.nodeId,
      node.nodeName,
      node.position,
      node.runId,
      node.emittedBy,
    );
}

/**
 * Nodes that cannot be created until a block in front of them has finished.
 *
 * Everything reachable *from* a block that is not a run, transitively. A node
 * here has at least one dependency that is not a run — an orchestrator block's
 * decision that may turn out to be several runs, or a merge block that creates
 * none at all — so there is nothing for `createRun` to name, and admitting it as
 * `waiting` with no edges would release it immediately: a run started ahead of
 * the decision that was supposed to shape it, or ahead of the merge it was meant
 * to follow.
 *
 * Costing nothing is what makes the deferral safe: a node that has not been
 * created holds no folder, no checkout slot and no place in the queue, which is
 * the same property `waiting` was invented for one level down.
 */
function deferredNodes(graph: WorkflowGraph): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const list = out.get(e.from);
    if (list) list.push(e.to);
    else out.set(e.from, [e.to]);
  }

  const deferred = new Set<string>();
  const queue = graph.nodes
    .filter((n) => n.kind !== "run")
    .flatMap((n) => out.get(n.id) ?? []);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (deferred.has(id)) continue;
    deferred.add(id);
    queue.push(...(out.get(id) ?? []));
  }
  return deferred;
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
  | { kind: "guard"; detail: string }
  /**
   * Taken down with everything else, by one install-wide stop.
   *
   * A third kind rather than `operator` with different words, because the
   * question it answers afterwards is a different one: an operator who finds
   * twenty-five stopped runs needs to know whether somebody stopped *this*
   * workflow or reached for the switch that stops everything, and only the
   * stored cause can say so once the sentence has scrolled off.
   */
  | { kind: "fleet" };

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
export type HaltStepOf<T> =
  | (T & { action: "stop" | "block"; reason: string })
  | (T & { action: "leave"; reason: null });

export type HaltStep = HaltStepOf<HaltMember>;

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
  if (cause.kind === "fleet") {
    return `Stopped by the operator with every run in flight, workflow “${workflowName}” among them`;
  }
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
  instance: {
    status: WorkflowInstanceStatus;
    workflowName: string;
    /**
     * Orchestrator blocks still deciding, or still waiting to. Counted here
     * because "nothing is live, so there is nothing to halt" must not be
     * answered from the runs alone: a graph whose only remaining member is a
     * block with a billed child in flight would otherwise be told it had
     * already finished, and the child would go on to start runs.
     */
    liveBlocks: number;
  },
  members: readonly HaltMember[],
  cause: HaltCause,
): HaltDecision {
  const attribution = haltCause(cause, instance.workflowName);

  // Idempotence, stated as a decision rather than left to the UPDATE that
  // enforces it: a second stop must be a no-op, not a second kill ladder run
  // over children that are already dying.
  if (!instanceIsOpen(instance.status)) {
    const note =
      instance.status === "failed"
        ? "This workflow run never started — its blocks were rolled back when it was created."
        : instance.status === "stopped"
          ? "This workflow run has already been stopped."
          : "This workflow run is already stopping.";
    return { act: false, note, cause: attribution, steps: [] };
  }

  // Nothing is live, so there is no door to close: every member has settled and
  // no block is left to create another, so nothing can move again. Recording a
  // halt here would put "stopped by the operator" on a run of a workflow that
  // finished on its own, which is a false thing to say about work that landed.
  if (
    instance.liveBlocks === 0 &&
    !members.some((m) => m.status && LIVE_STATUSES.includes(m.status))
  ) {
    return {
      act: false,
      note: "Every block of this workflow run has already finished.",
      cause: attribution,
      steps: [],
    };
  }

  return {
    act: true,
    note: null,
    cause: attribution,
    steps: haltSteps(members, attribution),
  };
}

/**
 * What happens to each row, given the attribution it will be recorded under.
 *
 * Generic over the row, and exported, because "which rows does this take down"
 * now has a second caller: an install-wide stop covers runs that belong to no
 * workflow at all. A second copy of these three branches would be a second
 * chance to rewrite a `completed` row as stopped, or to hand `stopRun` a member
 * that never ran and record it as though it had — and both are silent.
 */
export function haltSteps<T extends { status: RunStatus | null }>(
  members: readonly T[],
  attribution: string,
): Array<HaltStepOf<T>> {
  return members.map((member): HaltStepOf<T> => {
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

/** Statuses a run has not finished in — it will spend, or is waiting to. */
export { LIVE_STATUSES };

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
  /** Orchestrator blocks written off: waiting ones, and turns in flight. */
  blocksHalted: number;
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
  const liveBlocks = instance.blocks.filter(
    (b) => b.status === "waiting" || b.status === "thinking",
  ).length;
  const plan = haltPlan({ ...instance, liveBlocks }, members, cause);
  const report: HaltReport = {
    instanceId,
    workflowName: instance.workflowName,
    acted: plan.act,
    note: plan.note,
    signalled: [],
    cancelled: [],
    blocked: [],
    untouched: [],
    blocksHalted: 0,
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

  walkMembers(plan.steps, plan.cause, report, instanceId);
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
  instanceId: string,
): void {
  // Blocks before anything else, and for a sharper version of the reason
  // waiting members go before running ones: a block does not merely get
  // *released* by a stop, it creates runs. One left `thinking` while the walk
  // ran could emit into a workflow that is being taken down, and every run it
  // started would be a member the halt had already walked past.
  report.blocksHalted = haltBlocks(instanceId, cause);

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
 * Take down every block of an instance that has not settled.
 *
 * `blocked` for a block that never started — the status this app already writes
 * for work refused before it cost anything, and the true thing to say — and
 * `failed` for one whose child was in flight, because that turn was billed and
 * saying it never ran would hide the spend already on its row. Both are written
 * *before* the child is signalled, so the guarded UPDATE in `emitBlockRuns` and
 * the one in `settleBlock` both refuse whatever the dying turn still tries to do.
 *
 * The signal ladder is the one every other child here gets, `SIGINT` first.
 */
function haltBlocks(instanceId: string, cause: string): number {
  const now = Date.now();
  // The wording is per kind and the statement is not: what a block was doing is
  // what the operator needs to read, but *which* blocks come down is one rule,
  // and two statements per status would be two chances to add a kind to one and
  // not the other.
  const halted =
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='blocked', finished_at=?," +
          " error = CASE kind WHEN 'merge' THEN ? ELSE ? END" +
          " WHERE instance_id=? AND status='waiting'",
      )
      .run(
        now,
        `${cause} before it landed anything.`,
        `${cause} before it started deciding.`,
        instanceId,
      ).changes +
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='failed', finished_at=?," +
          " error = CASE kind WHEN 'merge' THEN ? ELSE ? END" +
          " WHERE instance_id=? AND status='thinking'",
      )
      .run(
        now,
        // The merges already queued are cancelled by `walkMembers` a moment
        // later; one in flight is left to finish, exactly as `cancelBatch` has
        // it, so the batch's own rows stay the record of which branches landed.
        `${cause} while it was landing branches.`,
        `${cause} while it was deciding what to start.`,
        instanceId,
      ).changes;

  for (const [key, child] of blockTurns) {
    if (!key.startsWith(`${instanceId}:`)) continue;
    blockTurns.delete(key);
    const running = () => child.exitCode === null && child.signalCode === null;
    signalTree(child, "SIGINT");
    setTimeout(() => {
      if (running()) signalTree(child, "SIGTERM");
    }, 3_000).unref?.();
    setTimeout(() => {
      if (running()) signalTree(child, "SIGKILL");
    }, 8_000).unref?.();
  }

  return halted;
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
    const liveBlocks = blocksOf(row.id).filter(
      (b) => b.status === "waiting" || b.status === "thinking",
    ).length;
    if (
      liveBlocks === 0 &&
      !members.some((m) => m.status && LIVE_STATUSES.includes(m.status))
    ) {
      continue;
    }
    const cause = haltCause(
      row.stop_cause === "guard"
        ? { kind: "guard", detail: "" }
        : row.stop_cause === "fleet"
          ? { kind: "fleet" }
          : { kind: "operator" },
      row.workflow_name,
    );
    walkMembers(
      haltSteps(members, cause),
      cause,
      {
        instanceId: row.id,
        workflowName: row.workflow_name,
        acted: true,
        note: null,
        signalled: [],
        cancelled: [],
        blocked: [],
        untouched: [],
        blocksHalted: 0,
        mergesCancelled: 0,
      },
      row.id,
    );
  }
}

/* ------------------------------------------------------------------ */
/* The workflow-wide guard                                             */
/* ------------------------------------------------------------------ */

/**
 * The instance a run belongs to, if any, with everything the guard reads.
 *
 * Null for a run started any other way, which is every run in this app except a
 * workflow's. One indexed lookup on the join table, and it is the first thing
 * the guard does, so the ordinary case costs one query and stops.
 */
function guardedInstanceOf(runId: string): {
  instanceId: string;
  status: string;
  budget: InstanceBudgetPolicy;
} | null {
  const row = db()
    .prepare(
      `SELECT i.id AS instanceId, i.status AS status,
              i.instance_budget AS budget
         FROM workflow_instance_runs w
         JOIN workflow_instances i ON i.id = w.instance_id
        WHERE w.run_id = ?`,
    )
    .get(runId) as
    | { instanceId: string; status: string; budget: string | null }
    | undefined;
  if (!row) return null;

  const budget = parseInstanceBudget(row.budget);
  if (instanceBudgetIsOff(budget)) return null;
  return { instanceId: row.instanceId, status: row.status, budget };
}

/**
 * Stop the whole workflow if this member is about to push it past its limits.
 *
 * **Between nodes, not during one.** Called from `startRun`'s pre-cycle guard,
 * off the snapshot that check has just read, at the one moment a member is
 * about to commit to spending and nothing has been spawned yet. For the default
 * `maxIterations: 1` a run has exactly one cycle boundary — its start — so this
 * is literally "before the next block starts work"; for a multi-cycle block it
 * is every boundary, which is tighter and never looser.
 *
 * There is deliberately **no live mode**. `liveGuardTick` reads one run's policy
 * against that run's own progress and interrupts that one child, and every code
 * on `LIVE_ENFORCEABLE_CODES` is a fact about a run; extending it to halt a
 * whole instance would kill every member mid-cycle, turning each one's measured
 * `result` cost into a reconciled estimate, in exchange for a bound that is
 * already one cycle in the ordinary case. What that costs is stated rather than
 * hidden: a block already working keeps working until some block reaches a cycle
 * boundary, so the total can overshoot by up to one work cycle for each block
 * running at the time — and several blocks at once multiply it. The instance
 * page says exactly that, in those words.
 *
 * Returns what happened, so the caller can put it in this run's log; null when
 * there was nothing to check or the guard passed. It does not signal this run
 * itself: `stopInstance` is the one door a halt goes through and it stops every
 * member including this one, which `startRun`'s pre-spawn checkpoint then sees
 * as an ordinary interrupt.
 */
export type InstanceGuardOutcome = {
  /**
   * `halted` — the workflow is being taken down, this run with it.
   * `unenforceable` — the verdict is real but is not one an instance may be
   * halted on. See `INSTANCE_ENFORCEABLE_CODES`; today that is `no_ceiling`
   * alone, and the caller says so in the log rather than acting on it.
   */
  kind: "halted" | "unenforceable";
  verdict: BudgetVerdict & { allowed: false };
};

export function enforceInstanceBudget(
  runId: string,
  snapshot: UsageSnapshot,
): InstanceGuardOutcome | null {
  const instance = guardedInstanceOf(runId);
  if (!instance) return null;
  return guardInstance(instance.instanceId, instance.status, instance.budget, snapshot);
}

/**
 * The same guard, at the boundary the three above cannot see: a member has
 * just **finished spending**.
 *
 * Every other call site is "before something spends", and for the ordinary
 * graph that is not a boundary at all. A member with `maxIterations: 1` — which
 * is what `normalizePolicy` answers when a template says nothing, and the run
 * form's own default — reaches `startRun`'s pre-cycle guard exactly once,
 * before its only cycle; the pass that would have seen that cycle's cost is
 * refused on `iterations` and `break`s out *ahead* of the instance check. So a
 * graph of single-cycle blocks released together checked the instance budget N
 * times, all of them against a total of zero, and never again. The
 * workflow-wide limit could not fire at all — `CLAUDE.md` named that as the
 * limiting case, and at 25 nodes with a 25-way concurrency cap it is the
 * ordinary one.
 *
 * Called from `startRun`'s `finally`, after the status write has put this
 * member's spend on its row, so `instanceSpend` reads it. That turns "the guard
 * never fires" into "the guard fires one cycle late", which is the bound the
 * documentation already claims and the same bound the pre-cycle check gives a
 * multi-cycle block.
 *
 * Async only because the window fractions need a reading, and a member settling
 * is a far rarer event than a cycle boundary — the transcript scan is paid once
 * per finished run, not once per cycle. `guardedInstanceOf` is one indexed
 * lookup and answers null for every run that is not a member and every instance
 * whose budget is off, so an install with no workflows pays a single query.
 */
export async function enforceInstanceBudgetAfterMember(
  runId: string,
): Promise<InstanceGuardOutcome | null> {
  const instance = guardedInstanceOf(runId);
  if (!instance) return null;
  // Asked before the snapshot rather than left to `guardInstance`: a halted or
  // rolled-back instance has nothing to decide, and a full transcript scan to
  // find that out is the one cost worth avoiding here.
  if (instance.status !== "started") return null;
  return guardInstance(
    instance.instanceId,
    instance.status,
    instance.budget,
    await currentSnapshot(),
  );
}

/**
 * The same guard, at the other kind of block boundary.
 *
 * An orchestrator block is about to spend and is not a member run, so the check
 * above — which hangs off `startRun`'s pre-cycle guard — cannot see it. Left
 * out, a graph of nothing but deciding blocks would have a workflow-wide limit
 * that never fires, and a graph past its limit could still pay for one more
 * decision before the first run it started reached a cycle boundary.
 *
 * Deliberately the same door and the same verdict vocabulary: an instance limit
 * with its own words for "no ceiling configured" would be a second set of budget
 * rules to keep in step.
 */
export function enforceInstanceBudgetForBlock(
  instanceId: string,
  snapshot: UsageSnapshot,
): InstanceGuardOutcome | null {
  const row = db()
    .prepare(
      "SELECT status, instance_budget AS budget FROM workflow_instances WHERE id = ?",
    )
    .get(instanceId) as { status: string; budget: string | null } | undefined;
  if (!row) return null;

  const budget = parseInstanceBudget(row.budget);
  if (instanceBudgetIsOff(budget)) return null;
  return guardInstance(instanceId, row.status, budget, snapshot);
}

function guardInstance(
  instanceId: string,
  status: string,
  budget: InstanceBudgetPolicy,
  snapshot: UsageSnapshot,
): InstanceGuardOutcome | null {
  // `started` only. A `stopping` instance is already being taken down and a
  // second halt would run a second kill ladder; a `failed` one was rolled back.
  if (status !== "started") return null;

  const verdict = evaluateInstanceBudget(
    budget,
    snapshot,
    instanceSpend(instanceId),
  );
  if (verdict.allowed) return null;
  if (!INSTANCE_ENFORCEABLE_CODES.includes(verdict.code)) {
    return { kind: "unenforceable", verdict };
  }

  // The halt function, called rather than re-implemented: an operator's stop
  // and this differ only in the cause recorded, and a second selection of "which
  // members does this take down" is a second chance to miss one.
  stopInstance(instanceId, { kind: "guard", detail: verdict.reason });
  return { kind: "halted", verdict };
}

/* ------------------------------------------------------------------ */
/* Orchestrator blocks: deciding, then starting what was decided        */
/* ------------------------------------------------------------------ */

/**
 * A block turn that has not answered in this long is not going to.
 *
 * The chat's bound, not a second one: it is the same child doing the same kind
 * of work, and a separate number here would be a second thing to keep in step
 * with a timeout that already exists.
 */
const BLOCK_TIMEOUT_MS = 10 * 60_000;

const BLOCK_TIMED_OUT =
  `This block did not decide within ${BLOCK_TIMEOUT_MS / 60_000} minutes and was stopped.`;

/**
 * The block turns this process can still signal.
 *
 * The row says a turn is in flight; this says whether anything is still there to
 * stop. On `globalThis` for the reason `chat.ts`'s registry is — a dev hot
 * reload would otherwise lose the handle on a live, billed child and leave a
 * halt with nothing to signal.
 */
const blockTurns = ((globalThis as unknown as {
  __ufBlockTurns?: Map<string, ChatProcess>;
}).__ufBlockTurns ??= new Map<string, ChatProcess>());

const turnKey = (instanceId: string, nodeId: string) => `${instanceId}:${nodeId}`;

/** One block's row, as the scheduler and the emit tool read it. */
interface BlockRow {
  instance_id: string;
  node_id: string;
  node_name: string;
  position: number;
  kind: WorkflowNodeKind;
  status: BlockStatus;
  cost_usd: number;
  emitted_specs: string | null;
  error: string | null;
  notes: string | null;
}

function getBlock(instanceId: string, nodeId: string): BlockRow | null {
  return (
    (db()
      .prepare(
        "SELECT * FROM workflow_instance_blocks WHERE instance_id = ? AND node_id = ?",
      )
      .get(instanceId, nodeId) as BlockRow | undefined) ?? null
  );
}

/**
 * Add one line to what this app recorded about a turn.
 *
 * Appended rather than set, because these arrive one at a time from three places
 * across the life of a turn — the guard before it spawns, each `emit_runs` this
 * app refuses while it runs, `settleBlock` when it ends — and the operator is
 * reading them to find out why nothing started. A note that overwrote the last
 * one would answer that question with whichever refusal happened to be last.
 */
function noteBlock(instanceId: string, nodeId: string, line: string): void {
  db()
    .prepare(
      "UPDATE workflow_instance_blocks" +
        " SET notes = TRIM(COALESCE(notes || char(10), '') || ?)" +
        " WHERE instance_id=? AND node_id=?",
    )
    .run(line, instanceId, nodeId);
}

/**
 * Put every deferred node blocked behind `roots` back to `waiting`, so the next
 * advance pass decides it again on what is true now.
 *
 * `reviveBlockedDependents` for the half of a graph that is not runs yet, and it
 * exists for that function's reason exactly: a `blocked` ledger row is a
 * sentence about an ending that reopening a run has just undone, and nothing
 * else in this app would ever revisit it. `planInstanceStep` skips any node
 * whose row is not `waiting`, and this is the only writer that puts one back —
 * so without it a node deferred behind an orchestrator or a merge block is
 * skipped for ever once anything writes it off, the instance reaches the end of
 * its graph with the tail missing, and the row still names a failure the
 * operator has since reversed.
 *
 * Deliberately not a release, the same way the run half is not: this reopens the
 * *question*. `advanceInstance` still answers it, creating the node if the
 * dependency now satisfies its edge and blocking it again — with a sentence
 * about the current ending — if it does not. So the worst this can do is
 * rewrite a stale reason.
 *
 * The halt exclusion is the membership condition and it is stated positively:
 * only an instance still `started` is walked. A `stopping` one is left alone,
 * whose every open block `haltBlocks` has just written off, and so is a `failed`
 * one, rolled back as it was created. There is no way back into a halted
 * workflow through a member, and this must not become one.
 *
 * Reachability is `revivableDependents` over the graph's own edges rather than
 * over `run_deps`: a deferred node has no run, so it has no dependency rows yet.
 * It walks only through the rows it is reviving, for that function's reason. A
 * root that is an *emitted* run enters the graph at the block that emitted it —
 * `emitted_by` — because that block's node is what the edges behind it were
 * drawn from; the emitted run's own `node_id` names no node in the graph.
 */
export function reviveBlockedBlocks(roots: readonly string[]): number {
  if (roots.length === 0) return 0;

  const rows = db()
    .prepare(
      `SELECT w.instance_id AS instanceId,
              COALESCE(w.emitted_by, w.node_id) AS nodeId
         FROM workflow_instance_runs w
         JOIN workflow_instances i ON i.id = w.instance_id
        WHERE i.status = 'started'
          AND w.run_id IN (${roots.map(() => "?").join(",")})`,
    )
    .all(...roots) as Array<{ instanceId: string; nodeId: string }>;
  if (rows.length === 0) return 0;

  const byInstance = new Map<string, string[]>();
  for (const row of rows) {
    const list = byInstance.get(row.instanceId);
    if (list) list.push(row.nodeId);
    else byInstance.set(row.instanceId, [row.nodeId]);
  }

  const reopen = db().prepare(
    "UPDATE workflow_instance_blocks SET status='waiting', error=NULL, finished_at=NULL" +
      " WHERE instance_id=? AND node_id=? AND status='blocked'",
  );

  let revived = 0;
  for (const [instanceId, nodes] of byInstance) {
    const instance = getInstance(instanceId);
    if (!instance) continue;

    const candidates = instance.blocks
      .filter((b) => b.status === "blocked")
      .map((b) => b.nodeId);
    if (candidates.length === 0) continue;

    const links = instance.graph.edges.map((e) => ({
      runId: e.to,
      dependsOn: e.from,
      edge: e.edge,
    }));
    for (const nodeId of revivableDependents(nodes, candidates, links)) {
      // Guarded on `blocked` for `upsertBlock`'s reason: a row that settled
      // between the read and the write keeps its own answer.
      revived += reopen.run(instanceId, nodeId).changes;
    }
  }
  return revived;
}

/**
 * Move every started instance as far as it can go, right now.
 *
 * Synchronous from end to end, and that is the same requirement `createRun`'s
 * folder claim imposes everywhere else: this creates runs, and one `await` in
 * the middle would let two passes both decide a folder was free. The turns it
 * starts are the exception and are deliberately fire-and-forget — a turn claims
 * its block with a guarded UPDATE *before* anything asynchronous happens, so a
 * second pass arriving a millisecond later finds the block `thinking` and leaves
 * it alone.
 *
 * Called from three places: the end of `startWorkflow` (a block with nothing in
 * front of it is ready immediately), `releaseDependents` (every terminal run
 * transition in the app, which is where a block's dependencies settle), and the
 * settling of a block turn (which may release the next one).
 */
export function advanceInstances(): void {
  const rows = db()
    .prepare(
      `SELECT DISTINCT b.instance_id AS id
         FROM workflow_instance_blocks b
         JOIN workflow_instances i ON i.id = b.instance_id
        WHERE b.status = 'waiting' AND i.status = 'started'`,
    )
    .all() as Array<{ id: string }>;
  for (const row of rows) advanceInstance(row.id);
}

/** One instance: apply whatever `planInstanceStep` says can happen now. */
function advanceInstance(instanceId: string): void {
  const instance = getInstance(instanceId);
  if (!instance || !instanceIsOpen(instance.status)) return;

  const step = planInstanceStep(instance.graph, instanceState(instance));

  // Blocked first, for `stopInstance`'s reason turned around: a node written
  // off here is a settled predecessor, and doing it before anything is created
  // means the cascade has already reached the bottom of the chain when the
  // creations happen rather than one pass later.
  for (const { nodeId, reason } of step.block) {
    const node = instance.graph.nodes.find((n) => n.id === nodeId);
    upsertBlock(instanceId, node, "blocked", reason);
  }

  const defaults = chatGuards();
  for (const creation of step.create) {
    const node = instance.graph.nodes.find((n) => n.id === creation.nodeId);
    if (!node) continue;
    const plan = planNode(
      node,
      node.templateId ? getTemplate(node.templateId) : null,
      defaults,
      // Read now rather than at `startWorkflow`: this node is being created
      // hours later, behind a decision, so the registry is asked again and an
      // agent that has gone since blocks this one block by name instead of
      // starting a run that is quietly not the thing the graph named.
      node.agentId ? getAgent(node.agentId) : null,
    );
    if (!plan.ok) {
      upsertBlock(instanceId, node, "blocked", plan.reason);
      continue;
    }
    try {
      const run = createRun({
        ...plan.input,
        dependsOn: creation.dependsOn,
        // The instance's own, not this moment's: a node created hours after the
        // press of Run that authorised it belongs to that press, and a
        // scheduled instance's late nodes are still the schedule's. Rows from
        // before the column existed read as a manual press, which is what every
        // instance was until schedules arrived.
        origin: instance.origin ?? "workflow",
        originRef: instance.originRef ?? instanceId,
      });
      // The ledger row held this node's place while it was waiting on a
      // decision, so it carries the position the graph gave it; the row itself
      // goes, because a node in both tables is a block shown twice on the page
      // and counted as live for ever.
      const held = getBlock(instanceId, node.id);
      db()
        .prepare(
          "DELETE FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?",
        )
        .run(instanceId, node.id);
      recordMember(instanceId, {
        nodeId: node.id,
        nodeName: node.name,
        position: held?.position ?? nextPosition(instanceId),
        runId: run.id,
        emittedBy: null,
      });
    } catch (err) {
      // `createRun` refuses a folder that has gone and a dependency graph it
      // cannot satisfy. Either way this block will never run, and a row saying
      // so is the difference between that and a block that quietly vanished.
      upsertBlock(
        instanceId,
        node,
        "blocked",
        `It could not be started: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Claimed synchronously, spawned after. The claim is what makes this
  // re-entrant safe; the spawn is what makes it worth doing.
  //
  // The budget is asked before each claim rather than once for the batch,
  // because the claim itself is what fills it: `claimBlock` writes `thinking`,
  // which is the row `liveAssistChildren` counts, so the next question already
  // knows about the last answer. A block over the budget is left `waiting` and
  // not written off — this is a shortage of memory rather than a decision about
  // the work, and `blocked` here would end the branch of the graph behind it for
  // a condition that clears in minutes. Whatever frees a slot advances again.
  const claimed: string[] = [];
  for (const nodeId of step.spawn) {
    if (assistBudgetFull()) break;
    if (claimBlock(instanceId, nodeId)) claimed.push(nodeId);
  }
  for (const nodeId of claimed) {
    void startBlockTurn(instanceId, nodeId).catch((err) => {
      settleBlock(instanceId, nodeId, {
        status: "failed",
        error: `The block could not be started: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }

  // The same shape for the merges, and the same claim: `startMergeBlock` reads
  // git and awaits the queue, so two advance passes arriving together would
  // otherwise both queue the same branches — which `enqueue` refuses as a whole
  // rather than half.
  for (const merge of step.merge) {
    if (!claimBlock(instanceId, merge.nodeId)) continue;
    void startMergeBlock(instanceId, merge.nodeId, merge.runIds).catch((err) => {
      finishMergeBlock(instanceId, merge.nodeId, {
        ok: false,
        note: `This block could not start merging: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }
}

/** Every node of an instance, in the terms `planInstanceStep` reads. */
function instanceState(
  instance: WorkflowInstance,
): Map<string, InstanceNodeState> {
  const state = new Map<string, InstanceNodeState>();

  const runs = db()
    .prepare(
      `SELECT w.node_id AS nodeId, w.emitted_by AS emittedBy, r.id AS id,
              r.status AS status, r.iterations AS iterations
         FROM workflow_instance_runs w
         LEFT JOIN runs r ON r.id = w.run_id
        WHERE w.instance_id = ?`,
    )
    .all(instance.id) as Array<{
    nodeId: string;
    emittedBy: string | null;
    id: string | null;
    status: RunStatus | null;
    iterations: number | null;
  }>;

  const emitted = new Map<string, DependencyState[]>();
  for (const row of runs) {
    // A row whose run has been deleted is treated as gone rather than as
    // finished, the same reading `releasableRuns` gives a missing dependency:
    // "not found" is not "settled", and a block released on the strength of one
    // would start on work nobody can show.
    if (!row.id || !row.status) continue;
    const run: DependencyState = {
      id: row.id,
      status: row.status,
      iterations: row.iterations ?? 0,
    };
    if (row.emittedBy) {
      const list = emitted.get(row.emittedBy);
      if (list) list.push(run);
      else emitted.set(row.emittedBy, [run]);
    } else {
      state.set(row.nodeId, { run, block: null });
    }
  }

  for (const block of blocksOf(instance.id)) {
    state.set(block.nodeId, {
      run: null,
      block: {
        status: block.status,
        emitted: emitted.get(block.nodeId) ?? [],
        error: block.error,
      },
    });
  }

  return state;
}

/** Where a run created after the graph was instantiated sits in the list. */
function nextPosition(instanceId: string): number {
  const row = db()
    .prepare(
      `SELECT MAX(p) AS n FROM (
         SELECT MAX(position) AS p FROM workflow_instance_runs WHERE instance_id = ?
         UNION ALL
         SELECT MAX(position) AS p FROM workflow_instance_blocks WHERE instance_id = ?
       )`,
    )
    .get(instanceId, instanceId) as { n: number | null };
  return (row.n ?? -1) + 1;
}

/**
 * Record a block's ending, creating the row if the node never had one.
 *
 * A deferred *run* block has no row until something writes it off — that is the
 * whole reason `workflow_instance_blocks` holds two kinds — so this is an upsert
 * rather than an update. Guarded on the status it is leaving, so a block that
 * settled between the plan and the write keeps its own answer.
 */
function upsertBlock(
  instanceId: string,
  node: WorkflowNode | undefined,
  status: BlockStatus,
  reason: string,
): void {
  const now = Date.now();
  const changed = db()
    .prepare(
      "UPDATE workflow_instance_blocks SET status=?, error=?, finished_at=?" +
        " WHERE instance_id=? AND node_id=? AND status IN ('waiting','thinking')",
    )
    .run(status, reason, now, instanceId, node?.id ?? "").changes;
  if (changed > 0 || !node) return;

  db()
    .prepare(
      `INSERT OR IGNORE INTO workflow_instance_blocks
         (instance_id, node_id, node_name, position, kind, status, finished_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      instanceId,
      node.id,
      node.name,
      nextPosition(instanceId),
      node.kind,
      status,
      now,
      reason,
    );
}

/**
 * Take a block's turn, or return false because something else already has.
 *
 * A conditional UPDATE whose `changes` count decides, exactly as `claimTurn`
 * claims a chat and `startRun` claims a queued run. Two overlapping advance
 * passes are ordinary here — every terminal run transition triggers one — and
 * without this each would spawn its own billed child for the same block.
 */
function claimBlock(instanceId: string, nodeId: string): boolean {
  return (
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='thinking', started_at=?," +
          " error=NULL, reply=NULL, notes=NULL" +
          " WHERE instance_id=? AND node_id=? AND status='waiting'",
      )
      .run(Date.now(), instanceId, nodeId).changes === 1
  );
}

/**
 * Spawn one block's turn.
 *
 * The gate in front of it is a chat turn's and no more: the host process budget
 * — taken at `advanceInstance`'s claim rather than here, so a shortage defers
 * this turn instead of failing it — `windowRefusal()`, the operator's own
 * configured ceiling already spent, and `installBudgetRefusal()`, the
 * install-wide rolling-day ceiling this is the fifth door of. There is
 * deliberately no `evaluateBudget` here — this is not a work cycle and
 * inventing a per-block
 * fraction would be a threshold nobody set — and the instance's own budget is
 * checked where every other instance-wide decision is, at a member's cycle
 * boundary. What bounds the spend is `settings.chatTurnBudgetUSD`, inside the
 * CLI, for the reason a chat turn's is: it is the same child answering the same
 * kind of question.
 */
async function startBlockTurn(instanceId: string, nodeId: string): Promise<void> {
  const instance = getInstance(instanceId);
  const node = instance?.graph.nodes.find((n) => n.id === nodeId);
  if (!instance || !node || node.kind !== "orchestrator" || node.fanOut === null) {
    settleBlock(instanceId, nodeId, {
      status: "failed",
      error: "This block is no longer in the workflow this run was started from.",
    });
    return;
  }

  // The agent this turn itself *is* — the block's own child, so its own field.
  // Asked before anything is spent and refused by name rather than dropped:
  // failing here costs nothing and says what happened, where a turn deciding as
  // something other than the agent the operator gave it is the one failure
  // shape nothing downstream can report.
  const own = node.agentId ? getAgent(node.agentId) : null;
  if (node.agentId) {
    const missing = agentRefusal(node.agentId, agentKnowledgeOf(own));
    if (missing) {
      settleBlock(instanceId, nodeId, { status: "failed", error: missing });
      return;
    }
  }

  // `windowRefusal` and not `assistRefusal`: the process budget gated this turn
  // at `advanceInstance`'s claim, and this block's own row has been `thinking`
  // — and so counted — ever since. Asking the budget again here would have a
  // block refuse itself whenever it was the one that filled it.
  //
  // The install-wide ceiling is the other half and is *not* deferred by that
  // claim: it bounds what the whole install spends in a rolling day rather than
  // how many children exist, so nothing upstream has already asked it on this
  // block's behalf and a block holding its slot must still be refused by it.
  const refusal = (await windowRefusal()) ?? installBudgetRefusal();
  if (refusal) {
    settleBlock(instanceId, nodeId, { status: "failed", error: refusal });
    return;
  }

  // The workflow-wide guard, at the other kind of block boundary. This is the
  // one moment before a deciding block spends, and it is exactly what
  // `enforceInstanceBudget` is for a member run's cycle boundary — same door,
  // same verdict, and the halt it triggers takes this block down with the rest.
  const guard = enforceInstanceBudgetForBlock(instanceId, await currentSnapshot());
  if (guard?.kind === "halted") return;
  if (guard?.kind === "unenforceable") {
    // Logged rather than acted on, the answer this app already gives a live
    // spending limit whose telemetry never arrived: `no_ceiling` on a stock
    // install means the provider's percentage was not readable this minute, and
    // halting every fraction-guarded workflow over an unreachable host is worse
    // than the guard being unenforceable for one block boundary.
    //
    // A note rather than an error, because it is neither the turn failing nor
    // anything the turn said — and because `error` is what `settleBlock` writes
    // when the turn ends, which is where this used to go and where it was wiped
    // by every turn that did not itself fail.
    noteBlock(
      instanceId,
      nodeId,
      `Its workflow has a limit that could not be read here: ${guard.verdict.reason}`,
    );
  }

  // Re-read after the awaits: a halt may have closed the door while the
  // transcript scan above was running, and a turn that starts into a stopping
  // instance is a billed child deciding work for a workflow that is being
  // taken down.
  const fresh = getInstance(instanceId);
  if (!fresh || !instanceIsOpen(fresh.status)) {
    // Written off rather than settled: nothing was spawned and nothing spent,
    // which is what `blocked` says and `failed` would not. `upsertBlock`'s
    // guard also means a halt that got here first keeps its own wording.
    upsertBlock(
      instanceId,
      node,
      "blocked",
      "The workflow was stopped before this block could start deciding.",
    );
    return;
  }

  const template = node.templateId ? getTemplate(node.templateId) : null;
  const settings = getSettings();
  const key = turnKey(instanceId, nodeId);

  runOrchestratorChild({
    subject: { kind: "block", instanceId, nodeId },
    prompt: node.task,
    appendSystemPrompt: blockSystemPrompt(
      node,
      template,
      instance.workflowName,
      own,
      // What it may start an *emitted* run as, which is a different question
      // from the line above — that one is what this turn itself is — and is
      // answered by the same registry. Read here so the prompt and
      // `emitBlockRuns`' own check describe one list.
      listAgents(),
    ),
    cwd: safeFolder(node),
    // What this deciding turn *is*, not a specialist it may call on: the node's
    // agent is selected with `--agent`, so the saved prompt is the turn's own.
    // Everything bounding this child — its tool surface, its capability token,
    // `--max-budget-usd`, and `blockSystemPrompt` above, which still reaches a
    // session started this way — is unchanged by it. The runs this block emits
    // name their own agent per spec, which is the opposite way round from
    // `promptOverride` and stays that way.
    agent: own ? agentDefinition(own) : null,
    maxBudgetUSD: settings.chatTurnBudgetUSD,
    timeoutMs: BLOCK_TIMEOUT_MS,
    timedOutMessage: BLOCK_TIMED_OUT,
    onSpawn: (child) => blockTurns.set(key, child),
    onSettle: (result) => {
      blockTurns.delete(key);
      settleBlock(instanceId, nodeId, result);
    },
  });
}

/** The block's folder on disk, or null when it cannot be resolved any more. */
function safeFolder(node: WorkflowNode): string | undefined {
  try {
    return resolveWorkspaceFolder(node.folder, node.mountId);
  } catch {
    // The turn still runs — it decides rather than works — and
    // `runOrchestratorChild` falls back to the first mount. Its emitted specs
    // go through `resolveWorkspaceFolder` again and would be refused there.
    return undefined;
  }
}

/** What one settled orchestrator turn leaves on its row. */
export interface BlockSettlement {
  status: Extract<BlockStatus, "emitted" | "failed">;
  /** The model's own words. */
  reply: string | null;
  /** This app's, one per line. */
  notes: string[];
  /** Set only when the turn itself failed. */
  error: string | null;
}

/**
 * What a finished turn is recorded as.
 *
 * Pure and unit-tested because every way of being wrong here is silent, and the
 * one this app shipped with was the worst of them: the turn's reply was read off
 * stdout, handed to this function's caller and dropped. A block that spent money
 * and started nothing left `emitted`, zero runs and no sentence — identical, on
 * the page, to a block that decided there was nothing to do, and identical again
 * to one whose every `emit_runs` call this app refused. All three end the branch
 * of the graph behind them, and only one of them is the model's fault.
 *
 * So the three voices stay three fields. `reply` is what the turn said, which is
 * the answer to "why did it start nothing" whenever the turn had a reason;
 * `notes` is what this app did to it, which is the answer whenever it did not;
 * `error` is the turn failing, which is neither. Folding any two together loses
 * exactly the distinction the operator is reading for.
 *
 * `failed` is reserved for a turn that failed **and** emitted nothing: specs
 * accepted while the child was alive are a decision it took deliberately, and a
 * CLI that errored on its way out afterwards says nothing about them — but a
 * block recorded `failed` blocks what is behind it, so a turn whose runs are
 * about to start must not be.
 */
export function blockSettlement(
  result: TurnResult,
  emitted: number,
  priorNotes: readonly string[],
): BlockSettlement {
  const notes = [...priorNotes];

  // The chat surfaces these for the reason a block needs them more: it runs
  // with no allowlist, so a denial is the CLI declining on its own — and "I was
  // not allowed to look" reads exactly like "there was nothing to find" to
  // someone reading a block that emitted nothing.
  const denied = [...new Set(result.denials ?? [])];
  if (denied.length > 0) {
    notes.push(
      `The CLI declined these tool calls: ${denied.join(", ")}. Nothing here ` +
        "restricts its tools, so that was its own decision.",
    );
  }

  return {
    status: result.status === "failed" && emitted === 0 ? "failed" : "emitted",
    reply: result.text?.trim() || null,
    notes,
    error: result.error ?? null,
  };
}

/**
 * Record what a turn said and cost, then start what it asked for.
 *
 * The emission is honoured even when the turn itself came back `failed` — see
 * `blockSettlement`, which decides that. The one thing that does withdraw the
 * specs is the instance no longer being `started`: a halt closed the door, and a
 * block that started runs into a stopping workflow is the member the halt would
 * then have to chase.
 *
 * Latched on `status='thinking'`, so a settle arriving after a halt already
 * wrote the block off changes nothing — the same shape `finishTurn` uses on a
 * chat row, and for the same reason: the answer that got there first is the one
 * the operator was shown.
 *
 * Exported for `sweepPaused`'s reason and no other: this is the only door to
 * `createEmitted`, and its other end is a real child process exiting. Without a
 * way in, what a block's emission actually writes onto a run cannot be pinned
 * at all.
 */
export function settleBlock(
  instanceId: string,
  nodeId: string,
  result: TurnResult,
): void {
  const row = getBlock(instanceId, nodeId);
  const specs = parseSpecs(row?.emitted_specs ?? null);
  // Read back and written whole rather than left alone, because everything
  // recorded during the turn lives in this column: a refused emission, and the
  // guard `startBlockTurn` could not read. This used to write `error` flat,
  // which wiped that guard note on every turn that did not itself fail.
  const settlement = blockSettlement(result, specs.length, splitNotes(row?.notes ?? null));
  const settled =
    db()
      .prepare(
        `UPDATE workflow_instance_blocks
            SET status=?, finished_at=?, error=?, session_id=COALESCE(?, session_id),
                reply=?, notes=?,
                cost_usd = cost_usd + ?, tokens = tokens + ?
          WHERE instance_id=? AND node_id=? AND status='thinking'`,
      )
      .run(
        settlement.status,
        Date.now(),
        settlement.error,
        result.sessionId ?? null,
        settlement.reply,
        settlement.notes.join("\n") || null,
        result.costUSD ?? 0,
        result.tokens ?? 0,
        instanceId,
        nodeId,
      ).changes > 0;
  if (!settled) return;

  // `instanceIsOpen` rather than a test for `started`, and the difference is
  // load-bearing here in a way it is nowhere else: the UPDATE above has just
  // settled this block, so if it was the last live member the instance reads
  // `finished` on this very line. A halt is the only thing that may stop the
  // runs it decided on from being created.
  const instance = getInstance(instanceId);
  if (instance && instanceIsOpen(instance.status) && specs.length > 0) {
    createEmitted(instanceId, nodeId, specs);
  }

  promoteQueued();
  advanceInstances();
}

/* ------------------------------------------------------------------ */
/* Merge blocks: landing what the blocks in front of them built         */
/* ------------------------------------------------------------------ */

/**
 * The rows are written by the worker, not by us, so this is a poll.
 *
 * There is no deadline beside it, deliberately. A merge block waits for its
 * branches for as long as merging them takes — the worker is one sequential
 * loop for the whole process, so this block's rows can sit behind somebody
 * else's batch and a conflict resolution takes as long as it takes, and none of
 * that is a reason to stop watching. It used to give up at an hour, or fifteen
 * minutes a branch, and what that bought was a block reporting its branches as
 * not landed while the queue was still landing them — a graph that carried on
 * past a merge it said had failed.
 *
 * What the ceiling was actually protecting against is a block stuck `thinking`
 * for ever, and that has an answer that is somebody's decision rather than a
 * clock's: `stopInstance` writes the block off, which this loop tests on every
 * pass, and the queue's own Cancel takes the batch. A clock could not tell the
 * difference between a wedged block and a large merge; an operator can.
 */
const MERGE_POLL_MS = 2_000;

/** What became of one branch a merge block was handed. */
export interface BranchOutcome {
  /** The branch, or the run's short id when it never had one to name. */
  branch: string;
  /**
   * `landed` — it is on its target. `skipped` — there was nothing to put there,
   * which is not a failure. `failed` — there was, and it did not get there.
   */
  result: "landed" | "skipped" | "failed";
  reason: string | null;
}

/** How many branches a summary names before it starts counting them instead. */
const MAX_NAMED_BRANCHES = 4;

/**
 * Whether a merge block succeeded, and the sentence that says what happened.
 *
 * Pure and unit-tested, for `landRefusal`'s reason one level up: this decides
 * whether the blocks *behind* a merge start, and both ways of being wrong are
 * silent. Read as failed, a chain that landed cleanly stops with nothing left to
 * do; read as succeeded, a follow-up run starts on a target that never received
 * the work it was written against.
 *
 * **A branch with nothing to land is a success.** A run that completed and
 * committed nothing, and a branch already on its target, both leave the operator
 * with exactly what they asked for — the work is where it belongs — so calling
 * either a failure would stop a graph over a merge that had no work to do. What
 * is *not* a success is a predecessor that should have had a branch and has
 * none: that is the isolation this block was saved against having quietly
 * degraded, and reporting it as fine is the "a run that looks like it did
 * nothing" failure this app keeps meeting.
 *
 * The note is null only when every branch landed and none was skipped — silence
 * means the plain thing happened, and anything else is written down.
 */
export function mergeBlockOutcome(branches: readonly BranchOutcome[]): {
  ok: boolean;
  note: string | null;
} {
  if (branches.length === 0) {
    return { ok: true, note: "There was no branch to land." };
  }

  const failed = branches.filter((b) => b.result === "failed");
  const skipped = branches.filter((b) => b.result === "skipped");
  const landed = branches.filter((b) => b.result === "landed");

  if (failed.length > 0) {
    const named = failed
      .slice(0, MAX_NAMED_BRANCHES)
      .map((b) => `${b.branch} — ${b.reason ?? "no reason recorded"}`);
    const rest = failed.length - named.length;
    return {
      ok: false,
      note:
        `Landed ${landed.length} of ${branches.length - skipped.length} branch(es). ` +
        named.join("; ") +
        (rest > 0 ? `; and ${rest} more` : "") +
        ".",
    };
  }

  if (skipped.length === 0) return { ok: true, note: null };
  const named = skipped
    .slice(0, MAX_NAMED_BRANCHES)
    .map((b) => `${b.branch} — ${b.reason ?? "nothing to land"}`);
  const rest = skipped.length - named.length;
  return {
    ok: true,
    note:
      `Landed ${landed.length} branch(es); ${skipped.length} had nothing to land: ` +
      named.join("; ") +
      (rest > 0 ? `; and ${rest} more` : "") +
      ".",
  };
}

/**
 * Land the branches the blocks in front of this one left behind.
 *
 * Everything that decides whether a branch may be landed is
 * `mergeQueue`/`land.ts`'s and is deliberately not restated here: one merge in
 * flight for the whole process, every item re-previewed against git at its own
 * turn, a conflict reconciled on the run's own branch in a throwaway checkout,
 * and a dirty operator checkout — or one standing on the wrong branch — refusing
 * every branch in that repository. This function's whole job is choosing *which*
 * runs go into the queue and reading back what happened.
 *
 * The two awaits before the queue matter and are ordered the way `startBlockTurn`
 * orders its own: the instance is re-read after them, because a halt may have
 * closed the door while git was being asked, and queueing into a stopping
 * workflow is a write into somebody's checkout for a workflow being taken down.
 */
async function startMergeBlock(
  instanceId: string,
  nodeId: string,
  runIds: readonly string[],
): Promise<void> {
  const instance = getInstance(instanceId);
  const node = instance?.graph.nodes.find((n) => n.id === nodeId);
  if (!instance || !node || node.kind !== "merge" || !node.mergeStrategy) {
    finishMergeBlock(instanceId, nodeId, {
      ok: false,
      note: "This block is no longer in the workflow this run was started from.",
    });
    return;
  }

  // The workflow-wide guard, at this kind of block boundary — but only when the
  // block can actually spend. A merge with no resolution authorised costs
  // nothing, and halting a graph at a free step would leave the work it already
  // paid for unlanded for the sake of a limit this block cannot move. The blocks
  // *behind* it are still checked at their own cycle boundary, so nothing
  // escapes the guard by standing behind a merge.
  let guardNote: string | null = null;
  if (node.mergeAutoResolve) {
    const guard = enforceInstanceBudgetForBlock(
      instanceId,
      await currentSnapshot(),
    );
    if (guard?.kind === "halted") return;
    if (guard?.kind === "unenforceable") {
      // Logged rather than acted on, the same answer `startBlockTurn` gives.
      guardNote = `Its workflow has a limit that could not be read here: ${guard.verdict.reason}`;
    }
  }

  const candidates: BranchOutcome[] = [];
  const queueable: string[] = [];
  for (const runId of runIds) {
    const verdict = await branchVerdict(runId);
    if (verdict.result === "queue") queueable.push(runId);
    else candidates.push(verdict.outcome);
  }

  const fresh = getInstance(instanceId);
  if (!fresh || !instanceIsOpen(fresh.status)) {
    upsertBlock(
      instanceId,
      node,
      "blocked",
      "The workflow was stopped before this block could land anything.",
    );
    return;
  }

  if (queueable.length === 0) {
    finishMergeBlock(instanceId, nodeId, {
      ...withNote(mergeBlockOutcome(candidates), guardNote),
    });
    return;
  }

  const queued = enqueue(queueable, {
    strategy: node.mergeStrategy,
    autoResolve: node.mergeAutoResolve,
  });
  if (!queued.ok) {
    finishMergeBlock(instanceId, nodeId, {
      ok: false,
      note: `Its branches could not be queued: ${queued.reason}`,
    });
    return;
  }

  // Recorded before the wait, so a restart or a halt leaves the block pointing
  // at the rows that say what happened to each branch.
  db()
    .prepare(
      "UPDATE workflow_instance_blocks SET merge_batch_id=?" +
        " WHERE instance_id=? AND node_id=? AND status='thinking'",
    )
    .run(queued.batchId, instanceId, nodeId);

  const rows = await awaitBatch(queued.batchId, instanceId, nodeId);
  for (const row of rows) {
    candidates.push({
      branch: branchLabel(row.run_id),
      result: row.status === "landed" ? "landed" : "failed",
      reason:
        row.status === "landed"
          ? null
          : // Nothing here stops waiting on a clock any more, so a row still
            // active is the workflow having been halted out from under it — not
            // a verdict, but a branch that is not on its target, which is the
            // only question a successor's condition asks.
            isQueueActive(row.status)
            ? "still in the merge queue when this workflow was stopped"
            : (row.message ?? row.status),
    });
  }

  finishMergeBlock(instanceId, nodeId, {
    ...withNote(mergeBlockOutcome(candidates), guardNote),
    costUSD: rows.reduce((sum, r) => sum + r.resolve_cost, 0),
  });
}

/** A note the block has to carry regardless of how the merge itself went. */
function withNote(
  outcome: { ok: boolean; note: string | null },
  extra: string | null,
): { ok: boolean; note: string | null } {
  if (!extra) return outcome;
  return {
    ok: outcome.ok,
    note: outcome.note ? `${outcome.note} ${extra}` : extra,
  };
}

/**
 * Whether one predecessor run has a branch worth queueing.
 *
 * Two answers, carrying three things that can be true of a finished run, and
 * only one of them is the block's problem. `queue` is a branch with commits on
 * it. `settled` is the other two, already in the words the report uses:
 * `skipped` is a branch with nothing on it, or one already on its target —
 * the work is where the operator wanted it, so there is nothing to do and
 * nothing wrong. `failed` is a run that was supposed to leave a branch and did
 * not: `normalizeWorkflowInput` refuses a merge block whose predecessors' guards
 * do not isolate, so reaching this means the isolation *degraded* at run time —
 * `resolveIsolation` falls back to working in the folder when a folder turns out
 * not to be a repository — and that is exactly the case where saying nothing
 * leaves an operator believing work landed that never did.
 */
async function branchVerdict(
  runId: string,
): Promise<{ result: "queue" } | { result: "settled"; outcome: BranchOutcome }> {
  const label = branchLabel(runId);
  const skip = (reason: string) => ({
    result: "settled" as const,
    outcome: { branch: label, result: "skipped" as const, reason },
  });
  const fail = (reason: string) => ({
    result: "settled" as const,
    outcome: { branch: label, result: "failed" as const, reason },
  });

  let state: Awaited<ReturnType<typeof landState>>;
  try {
    state = await landState(runId);
  } catch (err) {
    return fail(
      `its branch could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!state) {
    return fail(
      "it worked directly in the folder rather than on a branch of its own, so " +
        "there is no branch to land",
    );
  }
  if (!state.branchExists) return fail("its branch no longer exists");
  if (state.merged || state.landedUnchanged) {
    return skip(`already on ${state.target ?? "its target"}`);
  }
  if (state.ahead === 0) return skip("it left no commits of its own");
  return { result: "queue" };
}

/** How a branch is named in a report, falling back to the run's short id. */
function branchLabel(runId: string): string {
  return getRun(runId)?.worktree_branch ?? runId.slice(0, 8);
}

/**
 * Wait for one batch to drain.
 *
 * Two ways out, and neither of them is a clock. Every row terminal is the merge
 * having finished, which is the answer this exists to wait for however long it
 * takes. The block no longer `thinking` is a halt, which has already written
 * the row and whose answer wins — `finishMergeBlock`'s guarded UPDATE would
 * refuse ours anyway, and returning here saves reading git for a workflow being
 * taken down.
 */
async function awaitBatch(
  batchId: string,
  instanceId: string,
  nodeId: string,
): Promise<QueueRow[]> {
  for (;;) {
    const rows = batchRows(batchId);
    if (!rows.some((r) => isQueueActive(r.status))) return rows;
    if (getBlock(instanceId, nodeId)?.status !== "thinking") return rows;
    await new Promise((resolve) => setTimeout(resolve, MERGE_POLL_MS).unref?.());
  }
}

/**
 * Record what a merge block did.
 *
 * `settleBlock`'s shape and its latch: guarded on `status='thinking'`, so a halt
 * that wrote the block off while the queue was draining keeps its own wording.
 * `emitted` for a success and `failed` for anything else, reusing the vocabulary
 * every liveness query and every reconciler already reads — see `BlockStatus`.
 */
function finishMergeBlock(
  instanceId: string,
  nodeId: string,
  result: { ok: boolean; note: string | null; costUSD?: number },
): void {
  const settled =
    db()
      .prepare(
        `UPDATE workflow_instance_blocks
            SET status=?, finished_at=?, error=?, cost_usd = cost_usd + ?
          WHERE instance_id=? AND node_id=? AND status='thinking'`,
      )
      .run(
        result.ok ? "emitted" : "failed",
        Date.now(),
        result.note,
        result.costUSD ?? 0,
        instanceId,
        nodeId,
      ).changes > 0;
  if (!settled) return;

  promoteQueued();
  advanceInstances();
}

/**
 * Create the runs a block emitted, in one synchronous pass.
 *
 * `startWorkflow`'s pass, for a graph a model wrote rather than a person: no
 * `await` from the first `createRun` to the last, because the folder claim is
 * only atomic inside one event-loop turn, and the specs arrive already in
 * topological order so every one is created after everything it waits for.
 *
 * It is **not** all-or-nothing, and that is the one place it diverges. A graph
 * that half exists is a prefix nobody asked for, so `startWorkflow` rolls back;
 * here each spec is an independent piece of work that a block decided on
 * separately, and throwing away four runs because a fifth named a folder that
 * has since gone would lose the whole point of the block. A spec that cannot be
 * created is logged against the block instead — including for the specs behind
 * it, whose edges now name a run that does not exist.
 */
function createEmitted(
  instanceId: string,
  nodeId: string,
  specs: readonly RunSpec[],
): void {
  const instance = getInstance(instanceId)!;
  const node = instance.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const template = node.templateId ? getTemplate(node.templateId) : null;
  const defaults = chatGuards();
  const runIds = new Map<string, string>();
  const failures: string[] = [];

  for (const spec of specs) {
    const missing = spec.dependsOn.filter((d) => !runIds.has(d.id));
    if (missing.length > 0) {
      failures.push(
        `“${spec.title}” was not started: the run(s) it waits for could not be started either.`,
      );
      continue;
    }
    // Resolved now rather than when the spec was accepted, for the reason the
    // template beside it is read at this moment: a row can go between a turn
    // ending and its runs being created. That spec fails by name — a run
    // started as nobody when it was emitted "as the reviewer" is the silent
    // drop this app refuses at every other door — and the others still start,
    // which is this pass's whole difference from `startWorkflow`'s.
    let agent: AgentDefinition | null = null;
    if (spec.agent) {
      const saved = getAgentByName(spec.agent);
      if (!saved || !saved.usable) {
        failures.push(
          `“${spec.title}” was not started: the “${spec.agent}” agent it was ` +
            "emitted with is no longer usable, and a run that is not the agent " +
            "it was emitted as cannot be told from one that never named one.",
        );
        continue;
      }
      agent = agentDefinition(saved);
    }

    try {
      // Every one of these edges names a run created moments ago in this same
      // pass, whose id was minted after its own edges were read — so no insert
      // here can close a loop. `admitDependencies` re-runs `dependencyCycle`
      // over the whole live graph regardless, which is what keeps acyclicity a
      // property of the data now that a graph written by a model reaches it;
      // `planEmission` has already refused a cyclic emission by name.
      const run = createRun({
        ...planEmittedRun(node, spec, template, defaults, agent),
        dependsOn: spec.dependsOn.map((d) => ({
          runId: runIds.get(d.id)!,
          edge: d.edge,
        })),
        // Not the instance's origin, even inside a scheduled one: what
        // authorised *this* run is a model's decision taken moments ago, which
        // is the one origin here that no person chose run by run. The block's
        // node is the reference, matching `workflow_instance_runs.emitted_by`
        // and readable without that join.
        origin: "orchestrator-block",
        originRef: nodeId,
      });
      runIds.set(spec.id, run.id);
      recordMember(instanceId, {
        nodeId: `${nodeId}#${spec.id}`,
        nodeName: spec.title,
        position: nextPosition(instanceId),
        runId: run.id,
        emittedBy: nodeId,
      });
    } catch (err) {
      failures.push(
        `“${spec.title}” could not be started: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (failures.length > 0) {
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET error = TRIM(COALESCE(error, '') || ' ' || ?)" +
          " WHERE instance_id=? AND node_id=?",
      )
      .run(failures.join(" "), instanceId, nodeId);
  }
}

export type EmissionOutcome =
  | { ok: true; accepted: number }
  | { ok: false; reason: string };

/**
 * Why an emitted folder cannot be used by this block, or null when it can.
 *
 * Two bounds, not one, and the second is the one a person actually set. The
 * mount is the containment guarantee — `resolveInMount`, twice, before and after
 * the symlink is resolved — and it is deliberately no narrower than a mount,
 * because widening or narrowing it would change what every other caller of
 * `resolveWorkspaceFolder` is permitted to touch. But a mount holds every
 * repository on it, and what the operator saved on this block was a *folder*.
 * This is the one place that knows which block is asking, so it is the only
 * place that check can be made — and it is the same bound `blockSystemPrompt`
 * promises the model in words, which until now nothing enforced.
 *
 * A block saved on the mount root (`folder === ""`) is bounded by its mount and
 * nothing narrower, which is what its own prompt tells it.
 *
 * `resolve` is injected for the reason `EmissionLimits.folderRefusal` is: it is
 * a syscall, and the decision it feeds has to stay testable without one.
 * Containment is decided on the *resolved* paths, so a symlink inside the
 * block's folder that points at a sibling is refused rather than read as inside.
 */
export function emittedFolderRefusal(
  blockFolder: string,
  folder: string,
  resolve: (folder: string) => string,
): string | null {
  let resolved: string;
  try {
    resolved = resolve(folder);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  if (blockFolder === "") return null;

  let root: string;
  try {
    root = resolve(blockFolder);
  } catch {
    // The block's own folder has gone since the graph was saved. Nothing can be
    // shown to be inside it, so nothing is — refusing is the direction that
    // cannot start an agent in a repository nobody pointed it at.
    return `This block works in “${blockFolder}”, which cannot be found any more, so no folder can be shown to be inside it.`;
  }

  // The `resolveInMount` idiom, applied one level in. Compared exactly rather
  // than case-folded, unlike `overlaps`: over-refusing costs a sentence the
  // model can act on, where case-folding on a case-sensitive filesystem would
  // accept a genuinely different sibling directory.
  const rel = path.relative(root, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return null;
  const named = folder === "" ? "The workspace root" : `Folder “${folder}”`;
  return `${named} is outside “${blockFolder}”, which is where this block works.`;
}

/**
 * The one tool an orchestrator block has that writes anything.
 *
 * It **records** the specs rather than creating the runs, and they are created
 * when the turn ends. Two reasons, and both are about the shape rather than the
 * timing: `createRun` has to run in one uninterrupted event-loop turn and a tool
 * call is in the middle of an HTTP handler, and a block that started runs
 * half-way through its own thinking would leave the operator watching agents
 * appear from a decision that had not been made yet.
 *
 * Exactly one successful call per block. A refused call records nothing, so a
 * turn told its list was too long can emit a shorter one; an accepted one closes
 * the tool, because a second list is a second decision and the cap bounds a
 * decision rather than a call.
 */
export function emitBlockRuns(
  instanceId: string,
  nodeId: string,
  raw: unknown,
): EmissionOutcome {
  const instance = getInstance(instanceId);
  if (!instance) return { ok: false, reason: "This workflow run no longer exists." };
  if (!instanceIsOpen(instance.status)) {
    return {
      ok: false,
      reason:
        "This workflow run is being stopped, so nothing further can be started from it.",
    };
  }

  const block = getBlock(instanceId, nodeId);
  const node = instance.graph.nodes.find((n) => n.id === nodeId);
  if (!block || !node || node.fanOut === null) {
    return { ok: false, reason: "This block is not part of this workflow run." };
  }
  if (block.status !== "thinking") {
    return { ok: false, reason: "This block's turn has already ended." };
  }
  // The install-wide hold, at this block's door rather than inside
  // `planEmission`: it is a fact about the machine and not about the specs, the
  // same class of refusal as the two above it. Recorded through `noteBlock` for
  // the reason a rejected emission is, and the turn is told plainly — a model
  // that reads "refused" with no cause tries again in a different shape.
  if (newWorkPaused()) {
    noteBlock(
      instanceId,
      nodeId,
      "It tried to emit runs while new work was held across the install, and was refused.",
    );
    return {
      ok: false,
      reason:
        "New work is held across this install, so nothing can be started from " +
        "here. Say in your reply what you would have started.",
    };
  }
  if (block.emitted_specs !== null) {
    noteBlock(
      instanceId,
      nodeId,
      "It called emit_runs a second time and was refused — a block emits once.",
    );
    return {
      ok: false,
      reason:
        "This block has already emitted its runs. Say what else you would have " +
        "started in your reply instead.",
    };
  }

  const plan = planEmission(raw, {
    blockName: node.name,
    fanOut: node.fanOut,
    // Against **this block's own mount** and no other, which is what makes "a
    // folder inside the block's mount" mean something: containment is decided
    // per mount by `resolveInMount`, twice, before and after the symlink is
    // resolved. And then against the block's own folder, which is the bound the
    // operator actually set and the one its prompt states.
    folderRefusal: (folder) =>
      emittedFolderRefusal(node.folder, folder, (f) =>
        resolveWorkspaceFolder(f, node.mountId),
      ),
    // The whole registry, which is exactly the list `blockSystemPrompt` showed
    // this turn — two fields of it, because that is all a refusal is written
    // from. An emitted run may name any saved agent for the reason it may write
    // any task: an agent carries no capability, and every guard still comes off
    // the block a person saved.
    agents: listAgents().map((a) => ({ name: a.name, usable: a.usable })),
  });
  if (!plan.ok) {
    // The one refusal that most needs recording. Everything above is a turn
    // arriving too late or twice; this is a turn that decided what to run and
    // had it rejected — a fan-out over the cap, a folder outside the block's
    // own, a loop among the specs. The model is told why and may well give up
    // without saying so, and then this is the only trace that it ever meant to
    // start anything at all.
    noteBlock(instanceId, nodeId, `It tried to emit runs and was refused: ${plan.reason}`);
    return { ok: false, reason: plan.reason };
  }

  // Guarded on `thinking` again: the halt between the read above and here would
  // otherwise have its written-off block quietly re-armed with an emission.
  const stored = db()
    .prepare(
      "UPDATE workflow_instance_blocks SET emitted_specs=? WHERE instance_id=? AND node_id=? AND status='thinking'",
    )
    .run(JSON.stringify(plan.specs), instanceId, nodeId).changes;
  if (stored === 0) {
    return { ok: false, reason: "This block's turn ended while it was emitting." };
  }
  return { ok: true, accepted: plan.specs.length };
}

/**
 * What the block is, in the absence of a mechanism that makes it so.
 *
 * The chat's system prompt states a role because its allowlist was removed; this
 * one states a role because the *consequences* were removed. Nothing here waits
 * for a person: what this turn emits starts. So the paragraph that matters is
 * not "you may not" but "these will run, under these guards, in this folder,
 * and there are at most N of them" — the facts it needs to make a decision it
 * cannot take back.
 *
 * The mount, the folder, the guard set and the cap are generated rather than
 * left to a prompt an operator can edit, for the reason `continuedWorkNotice`'s
 * facts are: a placeholder that can be deleted is a notice that can silently
 * stop saying the true thing.
 */
function blockSystemPrompt(
  node: WorkflowNode,
  template: RunTemplate | null,
  workflowName: string,
  own: RegistryAgent | null,
  registry: readonly RegistryAgent[],
): string {
  const guards = template
    ? `the “${template.name}” template`
    : "the operator's default guard set in Settings";

  // The agents an emitted run may be started as, named because a name is what
  // `emit_runs` takes — and what `--agent` itself takes, so a name that got
  // through here and is not in the registry would fail that run's spawn.
  // Descriptions are shortened for the reason `MAX_AGENT_DESCRIPTION` exists at
  // all — every one of them rides in this turn's context — and the whole of one
  // reaches the run that names it, on its own argv, when it spawns. An unusable
  // row is left out: the CLI will not register it, so offering it would be
  // offering a run that cannot start.
  const choices = registry.filter((a) => a.usable);
  const agentChoices =
    choices.length === 0
      ? []
      : [
          "",
          "Agents you may start a run as, by name in `agent` — the agent's prompt",
          "becomes that run's own. This changes who a run is and never what it may",
          "do, and leaving it out is the ordinary run:",
          ...choices.map(
            (a) =>
              `- ${a.name} — ${
                a.description.length > 200
                  ? `${a.description.slice(0, 200)}…`
                  : a.description
              }`,
          ),
        ];
  // Exactly the bound `emittedFolderRefusal` enforces for this block and no
  // other. A block saved on a folder is held to that folder, the workspace root
  // included — so "" is a refusal there rather than the bad idea it is for a
  // block whose own folder really is the root.
  const folderBounds =
    node.folder === ""
      ? [
          `- Every run works in the “${node.mountId}” workspace, anywhere in it.`,
          "  A folder outside it is refused. Call list_folders and use a path",
          '  exactly as it gives one; "" is the workspace root, which blocks every',
          "  other run in the tree and is almost never what you want.",
        ]
      : [
          `- Every run works in the “${node.mountId}” workspace, at or under`,
          `  ${node.folder}. A folder outside that one is refused, and so is "" —`,
          "  that is the workspace root, which is outside it. Call list_folders",
          "  and use a path exactly as it gives one.",
        ];
  return [
    "You are an orchestrator block inside UsageFoundry, a tool that runs",
    "unattended Claude Code agents against folders on this machine. You are one",
    `step of the workflow “${workflowName}”, and nobody is reading this turn.`,
    "",
    "Your job is to decide which runs should happen next and to emit them with",
    "emit_runs. What you emit **starts immediately**. There is no approval step,",
    "no proposal card and no operator between your answer and a billed agent",
    "writing files. Decide as if you were the last person to look at it, because",
    "you are.",
    "",
    "The bounds you are working inside, none of which you can change:",
    `- At most ${node.fanOut} run(s). emit_runs refuses more, and the limit was`,
    "  set when the workflow was saved.",
    ...folderBounds,
    `- Every run gets its guards — budget, work-cycle limit, permission mode,`,
    `  whether it works in a checkout of its own — from ${guards}. There is no`,
    "  argument on emit_runs that touches any of them, deliberately.",
    ...(own
      ? [
          `- You are the “${own.name}” agent: the operator gave this block that`,
          "  role, and its prompt is your own. It says who you are and changes",
          "  none of the bounds above, which still apply exactly as written.",
        ]
      : []),
    ...agentChoices,
    "",
    "Emitting:",
    "- One run per unit of work, with a short specific title.",
    "- The task text is the whole brief the agent gets. Include the file, the",
    "  issue number, the URL and what done looks like. It is read by an agent",
    "  that cannot ask you a follow-up question.",
    "- dependsOn orders the runs you are emitting against each other, and only",
    "  against each other. Use it when two of them would edit the same files;",
    "  runs with no link between them start in parallel.",
    "- Call emit_runs once, with the whole list. Emitting nothing is a real",
    "  answer when there is nothing worth doing — say so plainly, and know that",
    "  any block set to start after this one will be stopped rather than run",
    "  with nothing to work on.",
    "",
    "Before you emit, look. You have every tool the CLI offers and you are",
    "trusted with them because your job is to decide, not to build: read files,",
    "grep, run read-only commands, read issues and CI logs with `gh`, read",
    "history with `git log`. Do not do the work yourself — do not edit, stage,",
    "commit, push or act on GitHub. The runs you emit are what does the work.",
    "",
    "Reply with a short list of what you emitted and what you deliberately left",
    "out. Nobody will answer you.",
  ].join("\n");
}

/** One instance a restart found holding at least one `waiting` block. */
export interface BootBlockInstance {
  id: string;
  status: WorkflowInstanceStatus;
  /** Its member runs, as this same boot's run reconciler has just left them. */
  memberStatuses: readonly RunStatus[];
}

/** What a restart does with each instance's `waiting` blocks. */
export interface BootBlockPlan {
  /** Nothing of this instance survived the boot: its blocks are closed out. */
  abandoned: string[];
  /** Stopping or failed before the restart: closed out, and told so. */
  settled: string[];
  /** A member survived the boot, so the blocks behind it are left waiting. */
  spared: string[];
}

/**
 * Which instances a restart leaves nothing that could ever wake a `waiting`
 * block, and which it leaves something.
 *
 * The whole of `reconcileBlocksOnBoot`'s new question, pure for the reason
 * `haltPlan` is: every way of getting it wrong typechecks, throws nothing, and
 * is invisible until a graph settles with its tail missing weeks later. Both
 * errors are silent and each is expensive in the opposite direction — a block
 * spared where nothing survived sits `waiting` for ever, and a block closed out
 * where something did survive destroys the tail of a workflow that was still
 * working, under a sentence about a predecessor that is not true.
 *
 * A member is what decides it, because a member is the only thing that can
 * still reach `releaseDependents` and so `advanceInstances`. `LIVE_STATUSES` is
 * the same reading `liveMemberCount` and `reconcileHaltsOnBoot` take, rather
 * than a test for `paused` — which is the only status that can be live at this
 * point in the boot, but by way of a rule in `reconcileOnBoot` that this
 * function must not restate.
 *
 * An instance that is not `started` is closed out however live its members are.
 * Its blocks have no future either way: a `stopping` one is being taken down
 * and `reconcileHaltsOnBoot` runs behind this on the strength of its members
 * alone, and a `failed` one is `startWorkflow`'s own rollback, which wrote
 * every other block off already. Reviving half a graph nobody finished building
 * is the failure the positive test for `started` exists to have none of.
 */
export function bootBlockPlan(
  instances: readonly BootBlockInstance[],
): BootBlockPlan {
  const plan: BootBlockPlan = { abandoned: [], settled: [], spared: [] };
  for (const instance of instances) {
    if (instance.status !== "started") plan.settled.push(instance.id);
    else if (instance.memberStatuses.some((s) => LIVE_STATUSES.includes(s)))
      plan.spared.push(instance.id);
    else plan.abandoned.push(instance.id);
  }
  return plan;
}

/**
 * Close out block turns a restart left mid-flight.
 *
 * `reconcileOnBoot`'s rule for a `waiting` run, applied one level up and for the
 * identical reason. A `thinking` block's child died with the process that
 * started it, so the row is a decision that will never arrive. A `waiting` block
 * is waiting on rows this same boot has just failed or stopped, so nothing will
 * ever wake it — and re-deciding unattended, hours later, is spend nobody is
 * present to want, which is the queued-run rule arrived at from the other side.
 *
 * Every `waiting` row of such an instance goes, not only the ones directly
 * behind a `thinking` one, and that is what keeps this consistent with the
 * queued-run rule rather than merely similar to it. A block behind a fan-out
 * whose runs the same boot has just failed could otherwise be released by the
 * next advance — `on-finish` is satisfied by a run that did a cycle and then
 * died with the container — and what that starts is an unattended agent nobody
 * is present to have wanted. Closed out, there is nothing left for a pass to
 * release.
 *
 * **Unless a member survived the same boot**, which is `reconcileOnBoot`'s own
 * exception rather than a second one: a `paused` run inside
 * `settings.resumeGraceHours` is kept, because it is a run the operator started
 * in a mode chosen precisely so it would carry on across a restart, and the
 * sweeper resumes it. Every premise above fails for the blocks behind it —
 * nothing it waits for has been closed out, something *will* wake it, and the
 * agent the next advance starts is the one the operator is already paying for
 * and waiting on. Closing them out anyway wrote off the tail of a live graph
 * and recorded a sentence about the paused run that was not true. So the
 * question is asked per instance, and this pass mirrors that grace rather than
 * overriding it; the block itself is decided later by `planInstanceStep`, off
 * what is actually true when the member settles.
 *
 * Ordering makes that readable rather than guessed at: `src/instrumentation.ts`
 * runs `reconcileOnBoot` first, so a run row that is still live here is one that
 * boot decided to keep.
 */
export function reconcileBlocksOnBoot(): void {
  const now = Date.now();
  const thinking = db()
    .prepare(
      "UPDATE workflow_instance_blocks SET status='failed', finished_at=?," +
        " error = CASE kind WHEN 'merge' THEN ? ELSE ? END" +
        " WHERE status='thinking'",
    )
    .run(
      now,
      // `reconcileMergeQueueOnBoot` has already cancelled this batch's queued
      // rows and failed whatever was mid-merge, for the reason a queued run is
      // never resumed: a server coming back up must not merge into a checkout
      // somebody works in. So the block really is finished, however far it got.
      "The server restarted while this block was landing branches. Its queued merges were cancelled — check the branches before queueing them again.",
      "The server restarted while this block was deciding what to start.",
    ).changes;

  // Read after the sweep above, so a block that was deciding counts as the
  // decision that will never arrive rather than as something still to come.
  // One row per member; instances with no `waiting` block are not asked about.
  const rows = db()
    .prepare(
      `SELECT i.id AS id, i.status AS status, r.status AS memberStatus
         FROM workflow_instances i
         LEFT JOIN workflow_instance_runs w ON w.instance_id = i.id
         LEFT JOIN runs r ON r.id = w.run_id
        WHERE EXISTS (SELECT 1 FROM workflow_instance_blocks b
                       WHERE b.instance_id = i.id AND b.status = 'waiting')`,
    )
    .all() as Array<{
    id: string;
    status: WorkflowInstanceStatus;
    memberStatus: RunStatus | null;
  }>;
  const gathered = new Map<
    string,
    { status: WorkflowInstanceStatus; memberStatuses: RunStatus[] }
  >();
  for (const row of rows) {
    let entry = gathered.get(row.id);
    if (!entry) {
      entry = { status: row.status, memberStatuses: [] };
      gathered.set(row.id, entry);
    }
    if (row.memberStatus) entry.memberStatuses.push(row.memberStatus);
  }
  const plan = bootBlockPlan(
    [...gathered].map(([id, entry]) => ({ id, ...entry })),
  );

  const closeOut = (ids: readonly string[], error: string): number => {
    if (ids.length === 0) return 0;
    return db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='blocked', finished_at=?, error=?" +
          ` WHERE status='waiting' AND instance_id IN (${ids.map(() => "?").join(",")})`,
      )
      .run(now, error, ...ids).changes;
  };
  const waiting =
    closeOut(
      plan.abandoned,
      "The server restarted while this block was waiting for earlier work, and everything this workflow still had in flight was closed out by the same restart.",
    ) +
    closeOut(
      plan.settled,
      "The server restarted while this block was waiting for earlier work, and its workflow was no longer running.",
    );

  if (thinking + waiting > 0) {
    console.warn(
      `[usagefoundry] Closed out ${thinking + waiting} workflow block(s) interrupted by a restart.`,
    );
  }
  if (plan.spared.length > 0) {
    // Every `waiting` row left is one of theirs, both statements above having
    // run — so this is counted rather than carried through the plan.
    const left = db()
      .prepare(
        "SELECT COUNT(*) AS n FROM workflow_instance_blocks WHERE status='waiting'",
      )
      .get() as { n: number };
    console.warn(
      `[usagefoundry] Left ${left.n} workflow block(s) waiting in ${plan.spared.length} ` +
        "instance(s) with a run that survived the restart; they are decided when it settles.",
    );
  }
}

/**
 * A run's live state for the instance view, or null when the row has gone.
 *
 * `activeIteration` and `startedAt` are here for the reason `fmtCycleInFlight`
 * exists: `iterations` counts cycles that *returned*, so a run tens of minutes
 * into its first one reads `0/N` and `$0.00`, which is bit-for-bit what a run
 * that was marked running and never started reads. On this page that matters
 * more than on the runs list, because a run an orchestrator block started is one
 * nobody clicked Create on and this is the only place it is listed against the
 * decision that made it.
 *
 * The folder is split the same way `/api/runs` splits it — a run a block emitted
 * took its folder from the model's own spec within the block's mount, so where
 * it is working is not derivable from the graph the operator saved.
 */
export function runStateOf(runId: string): {
  status: RunStatus;
  stopReason: string | null;
  iterations: number;
  maxIterations: number;
  activeIteration: number | null;
  startedAt: number | null;
  mountLabel: string | null;
  relPath: string;
  spentUSD: number;
} | null {
  const run = getRun(runId);
  if (!run) return null;
  const { mountLabel, relPath } = describeFolder(run.folder);
  return {
    status: run.status,
    stopReason: run.stop_reason,
    iterations: run.iterations,
    maxIterations: run.max_iterations,
    activeIteration: run.active_iteration,
    startedAt: run.started_at,
    mountLabel,
    relPath,
    spentUSD: run.spent_usd,
  };
}
