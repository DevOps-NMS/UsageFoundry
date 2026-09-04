import {
  DEPENDENCY_EDGES,
  dependencyCycle,
  resolveWorkspaceFolder,
  topologicalOrder,
  type DependencyEdge,
  type DependencyLink,
} from "./orchestrator";
import type { LandStrategy } from "./land";
import {
  normalizeInstanceBudget,
  type InstanceBudgetPolicy,
} from "./budget";
import {
  agentRefusal,
  currentAgentKnowledge,
  type AgentKnowledge,
} from "./agents";
import { chatGuards } from "./settings";
import { listTemplates } from "./templates";
import { WORKSPACE_MOUNTS } from "./config";
import {
  MAX_FAN_OUT,
  MAX_LOOP_PASSES,
  MAX_WORKFLOW_NAME,
  MAX_WORKFLOW_NODES,
  type WorkflowNodeKind,
} from "./apiTypes";

/**
 * What a workflow graph *is*, and every refusal that can be decided without
 * touching the disk.
 *
 * Split out of `workflows.ts` because it is the half with no state in it: the
 * shape a graph has on the wire, and `normalizeWorkflowInput`, which is the one
 * authority on whether a saved graph could ever be started. Nothing here reads
 * the database, spawns anything or writes a row, and nothing in here depends on
 * the execution half — which is what makes "refuse at save what instantiation
 * refuses" checkable by reading one file rather than six thousand lines.
 *
 * `workflows.ts` re-exports all of it, so this split is invisible to importers.
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
   * field, where a node reads one for exactly three things — its guards, the
   * standing instructions `promptOverride` replaces, and the model. The model
   * joined that list when `run_templates` grew one, and it belongs there on the
   * ground that keeps it off this field: it moves cost and never capability, and
   * a node has no model of its own for it to override. It supplies neither the
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
  /**
   * How many passes a loop block may take. Null on every other kind.
   *
   * Never null on a loop block, refused at save for `fanOut`'s reason read one
   * level along: a loop manufactures its own next unit of work, so it needs a
   * quantity that moves one way and keeps moving — the same argument that makes
   * `maxIterations` and `maxDurationMinutes` nullable only as a pair. Nothing
   * else here qualifies. Spend can be refunded, a window fraction can fall, and
   * an agent can report `DONE` for ever.
   */
  maxPasses: number | null;
  /**
   * Everything this loop's passes may spend together, or null for no cap.
   *
   * The one number on a node that reads like a budget, and it is not one. A
   * guard decides what an agent *may do* — `--permission-mode`, an isolation
   * choice, a per-run ceiling — and every one of those still comes from the
   * block's template or from `settings.chatDefaultGuards`, exactly as they do
   * for every other kind of block. This is a **terminus**, the same kind of
   * number `fanOut` is: it bounds how many times a block repeats and can only
   * ever end the loop earlier. It cannot raise a run's budget, it is unreachable
   * from anything a model emits, and it never widens the workflow-wide limit —
   * `evaluateInstanceBudget` does not read it, and that guard still halts the
   * whole instance at every member's cycle boundary whatever this says.
   */
  maxLoopCostUSD: number | null;
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
export const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The kinds a block may be, as a value rather than three literal comparisons.
 *
 * One list, so adding a kind cannot leave the wire gate accepting a value the
 * scheduler has no branch for — the `as const` makes every reader exhaustive
 * against `WorkflowNodeKind` at the same time.
 */
const NODE_KINDS = ["run", "orchestrator", "merge", "loop"] as const satisfies readonly WorkflowNodeKind[];

const MAX_NODE_NAME = 60;

/* ------------------------------------------------------------------ */
/* Validation — pure                                                   */
/* ------------------------------------------------------------------ */


/**
 * Whether a block's guards give it a checkout of its own — so whether there is
 * ever a branch to hand over, carry on, or land.
 *
 * Read off the guards rather than off the node, because that is where the
 * answer lives: a node names a template or names none and takes
 * `chatDefaultGuards`. It holds for an orchestrator block too — the runs it
 * emits take that same guard set, which is the whole of `guardsFor`'s point.
 *
 * Asked from four places — a loop block, whose passes hand a branch along;
 * either end of a hand-over edge; and a merge block's predecessors — so it is
 * resolved once, including while a node is still being normalised and has only
 * a template id.
 */
function isolatedTemplate(
  templateId: string | null,
  known: WorkflowKnowledge,
): boolean {
  return templateId === null
    ? known.defaultIsolate
    : (known.templates.get(templateId)?.isolate ?? false);
}

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
    const node = normalizeNode(entry, index, known, byId);
    if (!node.ok) return node;
    nodes.push(node.value);
    byId.set(node.value.id, node.value);
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
      // A run block has a checkout of its own, and so does a loop — its passes
      // are runs on one shared ref, which is the whole of why a non-isolated
      // loop is refused above. An orchestrator block decides and spends nothing
      // on disk; a merge block writes into somebody else's checkout and cuts no
      // branch. Those two are refused by name at either end rather than left to
      // the isolation test below, which would say "its guards work directly in
      // the folder" — true of neither and misleading about what would have to
      // change.
      for (const node of [source, target]) {
        if (node.kind === "run" || node.kind === "loop") continue;
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
      if (!isolatedTemplate(source.templateId, known)) {
        return {
          ok: false,
          error:
            `“${source.name}” has no branch to hand to “${target.name}” — its ` +
            "guards work directly in the folder rather than in a checkout of " +
            "their own.",
        };
      }
      if (!isolatedTemplate(target.templateId, known)) {
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

  const refusal = graphRefusal(nodes, edges, byId, known);
  if (refusal) return { ok: false, error: refusal };

  // Total, never a refusal: `null`/`""`/`0` all mean off, and a fraction guard
  // with no ceiling behind it is refused at *Run* rather than at Save. That is
  // the one place this file's "refuse at save what instantiation refuses" rule
  // does not apply, and deliberately: a ceiling is a Settings value that can be
  // typed at any time, so a graph saved without one is not unstartable — it is
  // unstartable *today*. The editor says so beside the field.
  const instanceBudget = normalizeInstanceBudget(o.instanceBudget);

  return { ok: true, value: { name, graph: { nodes, edges }, instanceBudget } };
}

type NodeNormalization =
  | { ok: true; value: WorkflowNode }
  | { ok: false; error: string };

/**
 * Read one block off the wire, refusing anything that could not be run.
 *
 * Every refusal names the block — by its own name once it has one, and by its
 * position until then — because a graph is read as a list of steps and "block
 * 3" is a thing only the editor can see.
 *
 * `taken` is the ids already accepted from this same graph, and it is the one
 * thing here that is not about a single block: two blocks sharing an id makes
 * every edge naming it name both, and that can only be seen from outside.
 */
function normalizeNode(
  entry: unknown,
  index: number,
  known: WorkflowKnowledge,
  taken: ReadonlyMap<string, WorkflowNode>,
): NodeNormalization {
  const n = (entry ?? {}) as Record<string, unknown>;
  const position = `Block ${index + 1}`;
    const id = String(n.id ?? "");
    if (!NODE_ID.test(id)) {
      return {
        ok: false,
        error: `${position} has no usable id. An id is 1–64 letters, digits, hyphens or underscores.`,
      };
    }
    if (taken.has(id)) {
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
            : kind === "loop"
              ? `“${nodeName}” has no task to repeat. A loop with nothing to do is a billed run per pass that spends a work cycle finding that out.`
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

    // The pass cap and the loop's own spending cap, on a loop block and nowhere
    // else. The first is required for `fanOut`'s reason one level along: this is
    // the block that manufactures its own next unit of work, so without a
    // quantity that only goes up it has no terminus at all — the run loop's own
    // rule, and the reason `maxIterations` may only be null alongside
    // `maxDurationMinutes`. The second is optional because the first already
    // terminates it, and `null`/`""`/`0` all mean off, this app's standing rule
    // for a number that bounds spending.
    let maxPasses: number | null = null;
    let maxLoopCostUSD: number | null = null;
    if (kind === "loop") {
      const raw = Number(n.maxPasses);
      if (!Number.isInteger(raw) || raw < 1) {
        return {
          ok: false,
          error:
            `“${nodeName}” needs a limit on how many times it may repeat. A ` +
            "loop decides for itself whether to start another run, so without " +
            "one it has nothing that has to end.",
        };
      }
      if (raw > MAX_LOOP_PASSES) {
        return {
          ok: false,
          error:
            `“${nodeName}” may take at most ${MAX_LOOP_PASSES} passes; it is ` +
            `set to ${raw}.`,
        };
      }
      maxPasses = raw;

      const cost = Number(n.maxLoopCostUSD);
      maxLoopCostUSD =
        n.maxLoopCostUSD === null ||
        n.maxLoopCostUSD === undefined ||
        String(n.maxLoopCostUSD) === "" ||
        !Number.isFinite(cost) ||
        cost <= 0
          ? null
          : cost;
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

    // A loop accumulates: every pass carries on the previous pass's branch,
    // through the same `continue_branch` mechanism a hand-over edge uses. Guards
    // that work directly in the folder have no branch to carry, so the loop
    // would be a run repeated on top of itself with no record of what each pass
    // added. Refused here rather than at the first pass, where it would surface
    // as a throw in the middle of an instance that had already started.
    if (kind === "loop" && !isolatedTemplate(templateId, known)) {
      return {
        ok: false,
        error:
          `“${nodeName}” repeats, and each pass carries on the one before it — ` +
          "which needs a checkout of its own. Its guards work directly in the " +
          "folder instead.",
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

  return {
    ok: true,
    value: {
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
          maxPasses,
          maxLoopCostUSD,
    },
  };
}

/**
 * Why a graph as a whole could never run, or null when nothing is wrong with it.
 *
 * The checks a single block or a single link cannot see: two links carrying on
 * one branch, a merge block with nothing in front of it to land, and the two
 * orderings. Separated from `normalizeWorkflowInput` because it is the phase
 * that reads the finished graph rather than the wire, and it is the one that
 * grows as the kinds of block do.
 *
 * Shaped like `folderRefusal` — a sentence or null — for the same reason: a
 * refusal here is something the operator can change.
 */
function graphRefusal(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  byId: ReadonlyMap<string, WorkflowNode>,
  known: WorkflowKnowledge,
): string | null {
  // Two runs on one ref is a branch git will not check out twice, and it leaves
  // the landing rules with no last link to name. `admitDependencies` refuses it
  // between live runs; this is the same rule inside one graph, where both would
  // be created in the same pass.
  const continued = new Set<string>();
  for (const e of edges) {
    if (!e.continueBranch) continue;
    if (continued.has(e.from)) {
      const source = byId.get(e.from)!;
      const takers = edges
        .filter((other) => other.continueBranch && other.from === e.from)
        .map((other) => `“${byId.get(other.to)!.name}”`);
      return (
        `${takers.join(" and ")} are both set to carry on “${source.name}”'s ` +
        "branch. Two runs cannot extend one branch."
      );
    }
    continued.add(e.from);
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
      return (
        `“${node.name}” has no block in front of it whose work it could ` +
        "land. A merge block lands the branches its predecessors left, so it " +
        "needs at least one predecessor that runs something."
      );
    }
    const bare = producers.find((s) => !isolatedTemplate(s.templateId, known));
    if (bare) {
      return (
        `“${bare.name}” leaves no branch for “${node.name}” to land — its ` +
        "guards work directly in the folder rather than in a checkout of " +
        "their own."
      );
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
    return (
      "These blocks wait for each other in a loop, so none of them could " +
      `ever start: ${loop.map((id) => byId.get(id)?.name ?? id).join(" → ")}.`
    );
  }

  // Belt and braces: the order the instantiation uses has to be total, and the
  // cycle check above is the only thing that can make it not be. A graph that
  // reached here with an unplaceable node would be instantiated into runs that
  // sit `waiting` for ever.
  const { unplaced } = topologicalOrder({ nodes, edges });
  if (unplaced.length > 0) {
    return (
      "These blocks could never start, because what they wait for can never " +
      `settle: ${unplaced.map((id) => byId.get(id)!.name).join(", ")}.`
    );
  }

  return null;
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
