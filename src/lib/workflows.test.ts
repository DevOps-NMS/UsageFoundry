import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  blockSettlement,
  bootBlockPlan,
  emittedFolderRefusal,
  haltPlan,
  instanceStatus,
  mergeBlockOutcome,
  normalizeWorkflowInput,
  planEmission,
  planInstanceStep,
  planNode,
  planLoopPass,
  planWorkflowProposal,
  summarizeProposedGraph,
  type BlockStatus,
  type BranchOutcome,
  type EmissionLimits,
  type HaltCause,
  type HaltMember,
  type InstanceNodeState,
  type LoopDecision,
  type LoopPass,
  type LoopPassInput,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowInstanceStatus,
  type WorkflowKnowledge,
  type WorkflowNode,
} from "./workflows";
import { topologicalOrder, type RunStatus } from "./orchestrator";
import type { TurnResult } from "./chat";
import type { RunGuards } from "./settings";
import type { RunTemplate } from "./templates";

/**
 * The three decisions a workflow makes with nothing spawned yet: whether the
 * graph can run at all, in what order its blocks become runs, and — once they
 * are runs — which of them a halt takes down and what each becomes.
 *
 * All three clear the bar the rest of `npm test` sets — pure functions whose
 * failure modes are silent and expensive. A wrong order starts an agent *before
 * the work it extends exists*: the run is admitted, its dependency list names
 * runs that have not been created, and what the operator sees is a run that
 * started on an empty branch and did the first thing its task said. A graph that
 * validates when it should not is the same failure one step earlier — a loop
 * instantiated into rows that sit `waiting` for ever, because `releasableRuns`
 * reaches a fixed point and leaves them alone, which is precisely the row this
 * whole design has none of. And a halt is silent in both directions at once: a
 * member the selection misses goes on spending under a workflow the operator
 * has been told is stopped, while a `completed` member rewritten as stopped
 * destroys the record of work that landed, with nothing on the page afterwards
 * to say it ever happened.
 *
 * Nothing here opens the database or touches the filesystem. Resolving a folder
 * against a mount is the one step that would, and it is injected — so the
 * decision built on top of it is pinned here while the syscall itself stays
 * with the routes.
 */

const KNOWN: WorkflowKnowledge = {
  templates: new Map([
    ["t-iso", { name: "Isolated", isolate: true }],
    ["t-flat", { name: "In place", isolate: false }],
  ]),
  mountIds: ["work", "other"],
  defaultIsolate: true,
  // The registry as a saved graph is measured against it. `a-broken` is the row
  // that has decayed into something the CLI would drop in silence — `rowToAgent`
  // reports rather than repairs, so a graph naming it has to be refused here
  // too, or the block starts as an agent the CLI cannot resolve.
  agents: new Map([
    ["a-rev", { name: "Reviewer", usable: true }],
    ["a-broken", { name: "Half a thing", usable: false }],
  ]),
};

/** A block with everything filled in, so a case states only what it varies. */
function node(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id.toUpperCase(),
    templateId: "t-iso",
    mountId: "work",
    folder: "repo",
    task: `Do ${id}`,
    promptOverride: null,
    ...extra,
  };
}

/** An orchestrator block, with the cap a saved graph must carry. */
function decider(id: string, extra: Record<string, unknown> = {}) {
  return node(id, { kind: "orchestrator", fanOut: 3, ...extra });
}

/** A merge block, with the strategy a saved graph must carry. */
function merger(id: string, extra: Record<string, unknown> = {}) {
  return node(id, { kind: "merge", mergeStrategy: "merge", ...extra });
}

/** A loop block, with the pass cap a saved graph must carry. */
function repeater(id: string, extra: Record<string, unknown> = {}) {
  return node(id, { kind: "loop", maxPasses: 3, ...extra });
}

function edge(
  from: string,
  to: string,
  opts: { edge?: WorkflowEdge["edge"]; continueBranch?: boolean } = {},
): WorkflowEdge {
  return {
    from,
    to,
    edge: opts.edge ?? "on-success",
    continueBranch: opts.continueBranch ?? false,
  };
}

function graph(nodes: unknown[], edges: unknown[] = []) {
  return { name: "Nightly", graph: { nodes, edges } };
}

/** Unwrap a normalization that is expected to succeed. */
function value(raw: unknown) {
  const res = normalizeWorkflowInput(raw, KNOWN);
  assert.ok(res.ok, `expected ok, got: ${res.ok ? "" : res.error}`);
  return res.value;
}

/** The refusal for input expected to be rejected. */
function error(raw: unknown): string {
  const res = normalizeWorkflowInput(raw, KNOWN);
  assert.ok(!res.ok, "expected a refusal");
  return res.error;
}

/* ------------------------------------------------------------------ */
/* Order                                                               */
/* ------------------------------------------------------------------ */

describe("topologicalOrder — every block after what it waits for", () => {
  it("orders a chain regardless of how it was declared", () => {
    // Declared tail-first, which is what an editor produces when a block is
    // inserted above another. The run for `c` must still be created last.
    const g = {
      nodes: [node("c"), node("b"), node("a")],
      edges: [edge("a", "b"), edge("b", "c")],
    };
    const { order, unplaced } = topologicalOrder(g);
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.deepEqual(unplaced, []);
  });

  it("keeps independent blocks in the order they were written", () => {
    // Three roots is the parallel case, and it is not a separate concept — it
    // falls out of a graph with no edges. The order still has to be stable:
    // runs are admitted oldest-first and a queued run reserves its folder
    // against everything younger, so two presses of Run on one graph must not
    // produce two different queues.
    const g = { nodes: [node("x"), node("y"), node("z")], edges: [] };
    assert.deepEqual(topologicalOrder(g).order, ["x", "y", "z"]);
  });

  it("places a fan-in after both of its dependencies", () => {
    const g = {
      nodes: [node("join"), node("left"), node("right")],
      edges: [edge("left", "join"), edge("right", "join")],
    };
    const { order } = topologicalOrder(g);
    assert.equal(order.at(-1), "join");
    assert.deepEqual(order.slice(0, 2).sort(), ["left", "right"]);
  });

  it("counts a repeated edge once", () => {
    // Counted twice, the dependent's indegree never reaches zero and a healthy
    // graph is reported as a loop.
    const g = {
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b"), edge("a", "b")],
    };
    assert.deepEqual(topologicalOrder(g).order, ["a", "b"]);
  });

  it("ignores an edge naming a block that is not in the graph", () => {
    const g = { nodes: [node("a")], edges: [edge("ghost", "a")] };
    assert.deepEqual(topologicalOrder(g).order, ["a"]);
  });

  it("leaves a loop unplaced rather than guessing an order", () => {
    const g = {
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b"), edge("b", "a")],
    };
    const { order, unplaced } = topologicalOrder(g);
    assert.deepEqual(order, []);
    assert.deepEqual(unplaced.sort(), ["a", "b"]);
  });

  it("leaves everything downstream of a loop unplaced too", () => {
    // The unreachable case: `c` is not in the loop and is not in trouble on its
    // own, but nothing will ever satisfy it.
    const g = {
      nodes: [node("a"), node("b"), node("c"), node("free")],
      edges: [edge("a", "b"), edge("b", "a"), edge("b", "c")],
    };
    const { order, unplaced } = topologicalOrder(g);
    assert.deepEqual(order, ["free"]);
    assert.deepEqual(unplaced.sort(), ["a", "b", "c"]);
  });
});

/* ------------------------------------------------------------------ */
/* Identity and substance                                              */
/* ------------------------------------------------------------------ */

describe("normalizeWorkflowInput — name and blocks", () => {
  it("requires a name", () => {
    assert.match(error({ ...graph([node("a")]), name: "  " }), /needs a name/);
  });

  it("requires at least one block", () => {
    assert.match(error(graph([])), /at least one block/);
  });

  it("requires a task on every block", () => {
    assert.match(error(graph([node("a", { task: "   " })])), /no task/);
  });

  it("requires a name on every block", () => {
    assert.match(error(graph([node("a", { name: "" })])), /needs a name/);
  });

  it("refuses two blocks with one id", () => {
    assert.match(
      error(graph([node("a"), node("a", { name: "Second" })])),
      /share the id/,
    );
  });

  it("reads a block with no kind as a run block", () => {
    // Every graph saved before orchestrator blocks existed says nothing here,
    // and the other reading would turn one of them into a graph that starts
    // agents nobody wrote.
    const v = value(graph([node("a")]));
    assert.equal(v.graph.nodes[0].kind, "run");
    assert.equal(v.graph.nodes[0].fanOut, null);
  });

  it("refuses an orchestrator block with no fan-out cap", () => {
    // The `no_terminus` rule, applied where it bites hardest: this is the one
    // block whose runs start with nothing between the decision and the spawn,
    // so a missing ceiling is an unbounded number of billed agents from one
    // press of Run. Refused at *save*, so it fails in the form that caused it.
    for (const bad of [undefined, null, "", 0, -1, 2.5]) {
      assert.match(
        error(graph([decider("a", { fanOut: bad })])),
        /needs a limit on how many runs it may start/,
        `fanOut ${String(bad)} should be refused`,
      );
    }
  });

  it("refuses a fan-out cap past the ceiling, and keeps one below it", () => {
    assert.match(error(graph([decider("a", { fanOut: 99 })])), /at most 10 runs/);
    assert.equal(value(graph([decider("a", { fanOut: 4 })])).graph.nodes[0].fanOut, 4);
  });

  it("refuses a branch hand-over at either end of an orchestrator block", () => {
    // It decides rather than works, so it has no checkout and no branch. Said
    // by name rather than left to the isolation test, which would claim its
    // guards work directly in the folder — true of nothing here.
    assert.match(
      error(
        graph(
          [decider("a"), node("b")],
          [edge("a", "b", { continueBranch: true })],
        ),
      ),
      /no branch to hand over or carry on/,
    );
    assert.match(
      error(
        graph(
          [node("a"), decider("b")],
          [edge("a", "b", { continueBranch: true })],
        ),
      ),
      /no branch to hand over or carry on/,
    );
  });

  it("requires a brief on an orchestrator block, in its own words", () => {
    assert.match(
      error(graph([decider("a", { task: "  " })])),
      /nothing to decide/,
    );
  });

  it("trims the task but keeps the mount root as a folder", () => {
    // "" is the mount root — the one selection that blocks every other run in
    // the tree — so it must survive as a real answer rather than read as "no
    // folder recorded".
    const v = value(graph([node("a", { task: "  tidy up  ", folder: "" })]));
    assert.equal(v.graph.nodes[0].task, "tidy up");
    assert.equal(v.graph.nodes[0].folder, "");
  });

  it("keeps a prompt override and normalises a blank one to null", () => {
    const v = value(
      graph([
        node("a", { promptOverride: " Read first. " }),
        node("b", { promptOverride: "   " }),
      ]),
    );
    assert.equal(v.graph.nodes[0].promptOverride, "Read first.");
    assert.equal(v.graph.nodes[1].promptOverride, null);
  });

  it("carries the workflow-wide limits, and reads a blank field as off", () => {
    // The one guard a workflow itself holds, and the only value on this form
    // that is not about *what work to do*. It earns its place here rather than
    // on a node because it bounds something no per-block guard can see: ten
    // blocks under a $5 block limit is a $50 workflow.
    const set = value({
      ...graph([node("a")]),
      instanceBudget: {
        maxInstanceCostUSD: "12.5",
        maxSessionFraction: 80,
        maxWeeklyFraction: "",
      },
    });
    assert.deepEqual(set.instanceBudget, {
      maxInstanceCostUSD: 12.5,
      // Typed as a percentage, stored as a fraction — the same conversion a
      // run's guards make, because the form asks the same question.
      maxSessionFraction: 0.8,
      maxWeeklyFraction: null,
    });

    // Absent is every limit off. A workflow saved before this existed reads the
    // same way, which is the behaviour it had.
    assert.deepEqual(value(graph([node("a")])).instanceBudget, {
      maxInstanceCostUSD: null,
      maxSessionFraction: null,
      maxWeeklyFraction: null,
    });
  });

  it("does not refuse a fraction guard at save for want of a ceiling", () => {
    // The one place this file's "refuse at save what Run refuses" rule does not
    // apply. A ceiling is a Settings value that can be typed at any moment, so
    // a graph saved without one is not unstartable — only unstartable today,
    // and `startWorkflow` says so with a real snapshot in hand.
    const v = value({
      ...graph([node("a")]),
      instanceBudget: { maxWeeklyFraction: 60 },
    });
    assert.equal(v.instanceBudget.maxWeeklyFraction, 0.6);
  });
});

/* ------------------------------------------------------------------ */
/* Guards come from something a person wrote                           */
/* ------------------------------------------------------------------ */

describe("normalizeWorkflowInput — templates and mounts", () => {
  it("refuses a template that no longer exists, by block name", () => {
    const message = error(graph([node("a", { templateId: "gone" })]));
    assert.match(message, /“A”/);
    assert.match(message, /no longer exists/);
  });

  it("accepts no template at all, which means the guards in Settings", () => {
    const v = value(graph([node("a", { templateId: null })]));
    assert.equal(v.graph.nodes[0].templateId, null);
  });

  it("reads an empty template id as none rather than as a missing template", () => {
    assert.equal(value(graph([node("a", { templateId: "" })])).graph.nodes[0]
      .templateId, null);
  });

  it("refuses a workspace that is not mounted", () => {
    assert.match(error(graph([node("a", { mountId: "elsewhere" })])), /not mounted/);
  });

  it("refuses a block naming no workspace", () => {
    assert.match(error(graph([node("a", { mountId: "" })])), /names no workspace/);
  });
});

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

/**
 * What a block's own child *is*, which is not what that child may do.
 *
 * Every failure here is the one this app's whole agent registry exists to end,
 * arriving from a saved graph rather than from the CLI: a block given
 * an agent it does not have is bit-for-bit a block that was never given one,
 * and nothing downstream can tell them apart — not the event log, not the cost,
 * not the transcript's own attribution. So a name that resolves to nothing is
 * refused rather than dropped, and it is refused *at save*, where a person is
 * looking, as well as at every Run afterwards.
 *
 * The merge case is the same fault in its cheapest form. That block spawns no
 * child at all, so an agent named on it has nothing to be —
 * accepting it silently would be this app performing the CLI's own silent drop
 * at the one door built to stop it.
 */
describe("normalizeWorkflowInput — the agent a block's child is started as", () => {
  it("carries an agent the registry has", () => {
    const v = value(graph([node("a", { agentId: "a-rev" })]));
    assert.equal(v.graph.nodes[0].agentId, "a-rev");
  });

  it("reads no agent, an empty one and a blank one all as none", () => {
    // `""` is the picker's own empty option rather than a missing answer, the
    // same absence `templateId` collapses one field up.
    assert.equal(value(graph([node("a")])).graph.nodes[0].agentId, null);
    assert.equal(
      value(graph([node("a", { agentId: "" })])).graph.nodes[0].agentId,
      null,
    );
    assert.equal(
      value(graph([node("a", { agentId: "   " })])).graph.nodes[0].agentId,
      null,
    );
  });

  it("refuses an agent that has been deleted, by block name and by refusal", () => {
    // The same sentence the run door and the template door give, so an operator
    // who meets it in three places meets one wording. Never a fallback to none:
    // the graph says "and hand the review to the reviewer".
    const message = error(graph([node("a", { agentId: "a-gone" })]));
    assert.match(message, /“A”/);
    assert.match(message, /no longer exists/);
    assert.match(message, /a-gone/, "and names the id that resolved to nothing");
  });

  it("refuses one that has decayed into what the CLI will not register", () => {
    // `rowToAgent` reports rather than repairs, so an unusable row reaches here
    // as a row that exists. Accepted, it would produce a block whose run is
    // started as an agent the CLI cannot resolve, which fails at the spawn.
    const message = error(graph([node("a", { agentId: "a-broken" })]));
    assert.match(message, /Half a thing/);
    assert.match(message, /will not register/);
  });

  it("lets an orchestrator block name one for its own deciding turn", () => {
    const v = value(graph([decider("a", { agentId: "a-rev" })]));
    assert.equal(v.graph.nodes[0].agentId, "a-rev");
  });

  it("refuses one on a merge block, which spawns no child to hand it to", () => {
    // Refused rather than dropped, unlike the template on the same block: a
    // template there decides nothing because no agent runs under it, where a
    // agent named here is one the operator believes is in play.
    const message = error(
      graph([node("a"), merger("m", { agentId: "a-rev" })], [edge("a", "m")]),
    );
    assert.match(message, /“M”/);
    assert.match(message, /starts no agent of its own/);
  });

  it("still accepts a merge block that names none", () => {
    const v = value(graph([node("a"), merger("m")], [edge("a", "m")]));
    assert.equal(v.graph.nodes[1].agentId, null);
  });
});

/* ------------------------------------------------------------------ */
/* Edges                                                               */
/* ------------------------------------------------------------------ */

describe("normalizeWorkflowInput — links", () => {
  it("requires a condition rather than defaulting one", () => {
    // Either default is wrong half the time and silent both times: on-success
    // ends a chain the operator meant to run regardless, on-finish starts a run
    // on top of a dependency that crashed.
    // Written out rather than built by the helper: the point of the case is a
    // value the type does not allow, arriving off the wire.
    assert.match(
      error(
        graph(
          [node("a"), node("b")],
          [{ from: "a", to: "b", continueBranch: false }],
        ),
      ),
      /needs a condition/,
    );
    assert.match(
      error(
        graph(
          [node("a"), node("b")],
          [{ from: "a", to: "b", edge: "on-done", continueBranch: false }],
        ),
      ),
      /needs a condition/,
    );
  });

  it("accepts both conditions", () => {
    const v = value(
      graph(
        [node("a"), node("b"), node("c")],
        [edge("a", "b", { edge: "on-finish" }), edge("b", "c")],
      ),
    );
    assert.equal(v.graph.edges[0].edge, "on-finish");
    assert.equal(v.graph.edges[1].edge, "on-success");
  });

  it("refuses a link to a block that is not in the workflow", () => {
    assert.match(
      error(graph([node("a")], [edge("ghost", "a")])),
      /not in this workflow/,
    );
  });

  it("refuses a block set to start after itself", () => {
    assert.match(
      error(graph([node("a")], [edge("a", "a")])),
      /start after itself/,
    );
  });

  it("refuses the same pair twice, which states two conditions for one wait", () => {
    assert.match(
      error(
        graph(
          [node("a"), node("b")],
          [edge("a", "b"), edge("a", "b", { edge: "on-finish" })],
        ),
      ),
      /twice/,
    );
  });

  it("names the blocks in a loop, in the order they wait", () => {
    const message = error(
      graph(
        [node("a"), node("b"), node("c")],
        [edge("a", "b"), edge("b", "c"), edge("c", "a")],
      ),
    );
    assert.match(message, /loop/);
    assert.match(message, /A/);
    assert.match(message, /B/);
    assert.match(message, /C/);
  });
});

/* ------------------------------------------------------------------ */
/* Carrying a branch over                                              */
/* ------------------------------------------------------------------ */

describe("normalizeWorkflowInput — continuing a branch", () => {
  it("accepts one hand-over per block", () => {
    const v = value(
      graph(
        [node("a"), node("b")],
        [edge("a", "b", { continueBranch: true })],
      ),
    );
    assert.equal(v.graph.edges[0].continueBranch, true);
  });

  it("reads anything but true as false, so a wire value fails safe", () => {
    const v = value(
      graph(
        [node("a"), node("b")],
        [{ from: "a", to: "b", edge: "on-success", continueBranch: "true" }],
      ),
    );
    assert.equal(v.graph.edges[0].continueBranch, false);
  });

  it("refuses a block set to carry on two branches", () => {
    assert.match(
      error(
        graph(
          [node("a"), node("b"), node("c")],
          [
            edge("a", "c", { continueBranch: true }),
            edge("b", "c", { continueBranch: true }),
          ],
        ),
      ),
      /only continue one/,
    );
  });

  it("refuses two blocks carrying on one branch", () => {
    // Two runs on one ref is a branch git will not check out twice, and it
    // leaves the landing rules with no last link to name.
    assert.match(
      error(
        graph(
          [node("a"), node("b"), node("c")],
          [
            edge("a", "b", { continueBranch: true }),
            edge("a", "c", { continueBranch: true }),
          ],
        ),
      ),
      /cannot extend one branch/,
    );
  });

  it("refuses a hand-over from guards that work in the folder", () => {
    // The predecessor has no branch to give: its template turns isolation off.
    assert.match(
      error(
        graph(
          [node("a", { templateId: "t-flat" }), node("b")],
          [edge("a", "b", { continueBranch: true })],
        ),
      ),
      /no branch to hand/,
    );
  });

  it("refuses a hand-over to guards that work in the folder", () => {
    assert.match(
      error(
        graph(
          [node("a"), node("b", { templateId: "t-flat" })],
          [edge("a", "b", { continueBranch: true })],
        ),
      ),
      /cannot carry on/,
    );
  });

  it("takes an untemplated block's isolation from the settings guard set", () => {
    const flat: WorkflowKnowledge = { ...KNOWN, defaultIsolate: false };
    const res = normalizeWorkflowInput(
      graph(
        [node("a", { templateId: null }), node("b")],
        [edge("a", "b", { continueBranch: true })],
      ),
      flat,
    );
    assert.ok(!res.ok, "expected a refusal");
    assert.match(res.error, /no branch to hand/);
  });
});

/* ------------------------------------------------------------------ */
/* Merge blocks                                                        */
/* ------------------------------------------------------------------ */

/**
 * A merge block writes into the operator's own checkout and can bill for a
 * conflict resolution, so what it may be saved as is worth the same care as an
 * orchestrator block's fan-out cap — and for the same reason, which is that both
 * refusals are only available at *save*.
 *
 * The two that matter most are the ones a graph cannot recover from later. A
 * merge block with nothing in front of it that runs anything is a block that
 * reaches the front of the graph and can only report that it was pointless; one
 * behind runs whose guards work directly in the folder finds every predecessor
 * branchless an hour in, having already spent the work. Both are answerable from
 * the guards a person has already chosen, which is exactly the case this file's
 * "refuse at save what instantiation refuses" rule exists for.
 */
describe("normalizeWorkflowInput — merge blocks", () => {
  it("needs a block in front of it that runs something", () => {
    assert.match(
      error(graph([merger("land")])),
      /no block in front of it whose work it could land/,
    );
  });

  it("does not count another merge block as something to land", () => {
    // Sequencing one merge behind another is legal — it contributes no
    // branches, which is the whole point — but it cannot be the *only* thing in
    // front of one, or the second block has nothing to do.
    assert.match(
      error(graph([node("a"), merger("one"), merger("two")], [
        edge("a", "one"),
        edge("one", "two"),
      ])),
      /no block in front of it whose work it could land/,
    );
  });

  it("accepts a merge block behind a merge block when a run also feeds it", () => {
    const g = value(
      graph([node("a"), node("b"), merger("one"), merger("two")], [
        edge("a", "one"),
        edge("one", "two"),
        edge("b", "two"),
      ]),
    );
    assert.equal(g.graph.nodes.length, 4);
  });

  it("refuses a predecessor whose guards leave no branch", () => {
    assert.match(
      error(
        graph([node("a", { templateId: "t-flat" }), merger("land")], [
          edge("a", "land"),
        ]),
      ),
      /leaves no branch for “LAND” to land/,
    );
  });

  it("takes an untemplated predecessor's isolation from the settings guards", () => {
    const flat: WorkflowKnowledge = { ...KNOWN, defaultIsolate: false };
    const res = normalizeWorkflowInput(
      graph([node("a", { templateId: null }), merger("land")], [
        edge("a", "land"),
      ]),
      flat,
    );
    assert.ok(!res.ok, "expected a refusal");
    assert.match(res.error, /leaves no branch/);
  });

  it("requires a strategy, so the graph records what the operator was shown", () => {
    assert.match(
      error(
        graph([node("a"), merger("land", { mergeStrategy: "" })], [
          edge("a", "land"),
        ]),
      ),
      /how it lands a branch/,
    );
  });

  it("refuses a merge block at either end of a branch hand-over", () => {
    // It has no checkout of its own: it writes into somebody else's and cuts
    // nothing. Named rather than left to the isolation test, which would say
    // something true of neither end.
    const asSource = error(
      graph([node("a"), merger("land"), node("b")], [
        edge("a", "land"),
        edge("land", "b", { continueBranch: true }),
      ]),
    );
    assert.match(asSource, /lands other blocks' branches/);
    const asTarget = error(
      graph([node("a"), merger("land")], [
        edge("a", "land", { continueBranch: true }),
      ]),
    );
    assert.match(asTarget, /lands other blocks' branches/);
  });

  it("holds no task, template, workspace, folder or prompt", () => {
    // Every one of them decides something about an agent, and this block starts
    // none. Dropped rather than refused, because the editor sends whatever the
    // block was carrying before the kind was switched.
    const g = value(
      graph(
        [
          node("a"),
          merger("land", {
            task: "merge everything please",
            templateId: "t-iso",
            mountId: "work",
            folder: "repo",
            promptOverride: "be careful",
          }),
        ],
        [edge("a", "land")],
      ),
    );
    const land = g.graph.nodes[1];
    assert.equal(land.task, "");
    assert.equal(land.templateId, null);
    assert.equal(land.mountId, "");
    assert.equal(land.folder, "");
    assert.equal(land.promptOverride, null);
    assert.equal(land.fanOut, null);
  });

  it("authorises a resolution only on a literal true", () => {
    // It is billed spend with nobody watching, so a string off the wire fails
    // safe — the reading `continueBranch` and `auto_resolve` both take.
    const on = value(
      graph([node("a"), merger("land", { mergeAutoResolve: true })], [
        edge("a", "land"),
      ]),
    );
    assert.equal(on.graph.nodes[1].mergeAutoResolve, true);

    for (const wire of ["true", 1, "yes", null, undefined]) {
      const off = value(
        graph([node("a"), merger("land", { mergeAutoResolve: wire })], [
          edge("a", "land"),
        ]),
      );
      assert.equal(
        off.graph.nodes[1].mergeAutoResolve,
        false,
        `${JSON.stringify(wire)} must not authorise spend`,
      );
    }
  });

  it("carries no merge settings on a block that is not one", () => {
    const g = value(
      graph([node("a", { mergeStrategy: "squash", mergeAutoResolve: true })]),
    );
    assert.equal(g.graph.nodes[0].mergeStrategy, null);
    assert.equal(g.graph.nodes[0].mergeAutoResolve, false);
  });
});

/**
 * What a merge block reports, and therefore whether the blocks behind it start.
 *
 * Both ways of being wrong are silent. Read as failed, a chain that landed
 * cleanly stops with nothing left to do; read as succeeded, a follow-up run
 * starts on a target that never received the work it was written against.
 *
 * The distinction that carries the weight is skipped-versus-failed. A branch
 * with nothing on it and a branch already on its target both leave the operator
 * with what they asked for, so stopping a graph over either would refuse work
 * for the sake of a merge that had none to do — while a predecessor that should
 * have had a branch and has none is isolation having degraded at run time, which
 * is the one case where saying nothing leaves someone believing work landed.
 */
describe("mergeBlockOutcome — what a merge block reports", () => {
  const landed = (branch: string): BranchOutcome => ({
    branch,
    result: "landed",
    reason: null,
  });

  it("says nothing when every branch landed", () => {
    const out = mergeBlockOutcome([landed("uf/a"), landed("uf/b")]);
    assert.equal(out.ok, true);
    assert.equal(out.note, null, "silence means the plain thing happened");
  });

  it("succeeds with a note when a branch had nothing to land", () => {
    const out = mergeBlockOutcome([
      landed("uf/a"),
      { branch: "uf/b", result: "skipped", reason: "it left no commits of its own" },
    ]);
    assert.equal(out.ok, true, "nothing to land is not a failure");
    assert.match(out.note ?? "", /uf\/b — it left no commits/);
  });

  it("fails when a branch that should have landed did not", () => {
    const out = mergeBlockOutcome([
      landed("uf/a"),
      { branch: "uf/b", result: "failed", reason: "it conflicts" },
    ]);
    assert.equal(out.ok, false);
    assert.match(out.note ?? "", /Landed 1 of 2/);
    assert.match(out.note ?? "", /uf\/b — it conflicts/);
  });

  it("counts the skipped branches out of the denominator", () => {
    // "Landed 1 of 2" is about the branches that had work on them. Counting a
    // branch with nothing on it as one this block failed to land would report a
    // shortfall that does not exist.
    const out = mergeBlockOutcome([
      landed("uf/a"),
      { branch: "uf/b", result: "skipped", reason: "already on main" },
      { branch: "uf/c", result: "failed", reason: "it conflicts" },
    ]);
    assert.equal(out.ok, false);
    assert.match(out.note ?? "", /Landed 1 of 2/);
  });

  it("names a few failures and counts the rest", () => {
    const out = mergeBlockOutcome(
      Array.from({ length: 7 }, (_, i) => ({
        branch: `uf/${i}`,
        result: "failed" as const,
        reason: "it conflicts",
      })),
    );
    assert.equal(out.ok, false);
    assert.match(out.note ?? "", /and 3 more/);
  });

  it("treats no branches at all as nothing to do", () => {
    const out = mergeBlockOutcome([]);
    assert.equal(out.ok, true);
    assert.match(out.note ?? "", /no branch to land/);
  });
});

/* ------------------------------------------------------------------ */
/* Loop blocks: what a saved graph may say                             */
/* ------------------------------------------------------------------ */

describe("normalizeWorkflowInput — loop blocks", () => {
  it("keeps both caps on a loop block", () => {
    const v = value(graph([repeater("a", { maxLoopCostUSD: 12.5 })]));
    assert.equal(v.graph.nodes[0].kind, "loop");
    assert.equal(v.graph.nodes[0].maxPasses, 3);
    assert.equal(v.graph.nodes[0].maxLoopCostUSD, 12.5);
  });

  it("refuses a loop with no pass cap", () => {
    // The `no_terminus` rule read one level up: a loop decides for itself
    // whether to start another billed run, so without a quantity that only goes
    // up there is nothing that has to end.
    assert.match(
      error(graph([repeater("a", { maxPasses: null })])),
      /how many times it may repeat/,
    );
    assert.match(
      error(graph([repeater("a", { maxPasses: 0 })])),
      /how many times it may repeat/,
    );
    assert.match(
      error(graph([repeater("a", { maxPasses: 2.5 })])),
      /how many times it may repeat/,
    );
  });

  it("refuses a pass cap past the ceiling", () => {
    assert.match(error(graph([repeater("a", { maxPasses: 99 })])), /at most 20/);
  });

  it("reads a blank, zero or negative spending cap as no cap", () => {
    // The rule every budget field in this app follows: a limit nobody typed is
    // not a limit, and there is no default to restore.
    for (const raw of ["", 0, -5, null, undefined]) {
      const v = value(graph([repeater("a", { maxLoopCostUSD: raw })]));
      assert.equal(v.graph.nodes[0].maxLoopCostUSD, null, `for ${String(raw)}`);
    }
  });

  it("leaves both caps null on every other kind", () => {
    // A `maxPasses` on a run block would be a number nothing reads, which is
    // worse than a refusal: it looks like a limit.
    const v = value(
      graph(
        [
          node("a", { maxPasses: 4, maxLoopCostUSD: 9 }),
          decider("b", { maxPasses: 4, maxLoopCostUSD: 9 }),
          merger("m", { maxPasses: 4, maxLoopCostUSD: 9 }),
        ],
        [edge("a", "m")],
      ),
    );
    assert.deepEqual(
      v.graph.nodes.map((n) => [n.maxPasses, n.maxLoopCostUSD]),
      [
        [null, null],
        [null, null],
        [null, null],
      ],
    );
  });

  it("refuses a loop whose guards work directly in the folder", () => {
    // Every pass carries on the one before it, which needs a checkout of its
    // own. Refused here rather than at the first pass, where it would be a
    // throw inside an instance that had already started.
    assert.match(
      error(graph([repeater("a", { templateId: "t-flat" })])),
      /needs a checkout of its own/,
    );
  });

  it("lets a block carry on a loop's branch", () => {
    // A loop has a branch — its passes share one ref — so unlike an
    // orchestrator block it is a legal end of a hand-over.
    const v = value(
      graph(
        [repeater("a"), node("b")],
        [edge("a", "b", { continueBranch: true })],
      ),
    );
    assert.equal(v.graph.edges[0].continueBranch, true);
  });
});

/* ------------------------------------------------------------------ */
/* Halting                                                             */
/* ------------------------------------------------------------------ */

/**
 * One instance holding every kind of member at once.
 *
 * `Review` waits behind `Build`, which is the case that decides the ordering
 * inside the halt: stopping `Build` releases its dependents, so a waiting member
 * left until last would be admitted, promoted and spawned *because* the workflow
 * was stopped.
 */
const MEMBERS: HaltMember[] = [
  { runId: "r-build", nodeName: "Build", status: "running" },
  { runId: "r-test", nodeName: "Test", status: "queued" },
  { runId: "r-docs", nodeName: "Docs", status: "paused" },
  { runId: "r-review", nodeName: "Review", status: "waiting" },
  { runId: "r-landed", nodeName: "Landed", status: "completed" },
  { runId: "r-broken", nodeName: "Broken", status: "failed" },
];

const OPERATOR: HaltCause = { kind: "operator" };
const GUARD: HaltCause = {
  kind: "guard",
  detail: "This workflow has spent $12.40 of its $10.00 limit.",
};

function plan(
  status: WorkflowInstanceStatus = "started",
  members: readonly HaltMember[] = MEMBERS,
  cause: HaltCause = OPERATOR,
  liveBlocks = 0,
) {
  return haltPlan(
    { status, workflowName: "Nightly", liveBlocks },
    members,
    cause,
  );
}

/** What the halt decided about one member, by run id. */
function step(decision: ReturnType<typeof plan>, runId: string) {
  const found = decision.steps.find((s) => s.runId === runId);
  assert.ok(found, `no step for ${runId}`);
  return found;
}

describe("haltPlan — which members a stop selects, and what each becomes", () => {
  it("covers every member exactly once", () => {
    // The silent half of getting this wrong is a member nobody decided about:
    // it is not stopped, it is not reported, and it goes on spending under a
    // workflow the page says is stopped.
    const decision = plan();
    assert.equal(decision.act, true);
    assert.deepEqual(
      decision.steps.map((s) => s.runId),
      MEMBERS.map((m) => m.runId),
    );
  });

  it("sends the three live statuses through stopRun", () => {
    // One action for all three, because `stopRun` is the one path that signals a
    // child and it re-reads the row itself: a queued member promoted to running
    // by an earlier stop in the same pass still lands on the right branch.
    const decision = plan();
    assert.equal(step(decision, "r-build").action, "stop");
    assert.equal(step(decision, "r-test").action, "stop");
    assert.equal(step(decision, "r-docs").action, "stop");
  });

  it("blocks a waiting member rather than stopping it", () => {
    // `blocked` is the true thing to say: nothing ran and nothing was spent. It
    // also keeps the run out of REOPENABLE, which is honest — picking one link
    // of a halted chain back up would start it on work that never happened.
    const waiting = step(plan(), "r-review");
    assert.equal(waiting.action, "block");
    assert.match(waiting.reason ?? "", /waiting for another run\.$/);
  });

  it("leaves a finished member exactly as it is", () => {
    // Rewriting a completed run as stopped destroys the record of work that
    // landed, and nothing on the page afterwards says it ever happened.
    for (const id of ["r-landed", "r-broken"]) {
      const settled = step(plan(), id);
      assert.equal(settled.action, "leave");
      assert.equal(settled.reason, null);
    }
  });

  it("leaves a member whose run row has gone", () => {
    // Beside a live one, because an instance with nothing live is a no-op —
    // this is about the deleted row, not about whether the halt runs at all.
    const gone = step(
      plan("started", [
        MEMBERS[0],
        { runId: "r-gone", nodeName: "Gone", status: null },
      ]),
      "r-gone",
    );
    assert.equal(gone.action, "leave");
    assert.equal(gone.reason, null);
  });
});

describe("haltPlan — telling the three ways a run can be stopped apart", () => {
  it("names the workflow and the operator", () => {
    const decision = plan();
    assert.equal(
      decision.cause,
      "Stopped by the operator with all of workflow “Nightly”",
    );
  });

  it("names the workflow and the guard", () => {
    const decision = plan("started", MEMBERS, GUARD);
    assert.equal(
      decision.cause,
      "Stopped by the budget guard on workflow “Nightly”",
    );
  });

  it("differs from what a run stopped on its own page says", () => {
    // `stopRun`'s own default is "Stopped by operator", with no workflow in it.
    // The three sentences have to be distinguishable on sight, or ten rows read
    // as ten unrelated decisions.
    for (const cause of [OPERATOR, GUARD]) {
      const { cause: attribution } = plan("started", MEMBERS, cause);
      assert.notEqual(attribution, "Stopped by operator");
      assert.match(attribution, /workflow “Nightly”/);
    }
  });

  it("keeps the attribution a fragment, because stopRun completes it", () => {
    // Each of `stopRun`'s branches appends the clause saying what the run was
    // doing — "… before it started." A sentence here would punctuate mid-line.
    for (const cause of [OPERATOR, GUARD]) {
      assert.doesNotMatch(plan("started", MEMBERS, cause).cause, /[.!?]$/);
    }
  });

  it("keeps a guard's verdict off the member rows", () => {
    // It is one fact about one instance and is recorded there. Copied onto ten
    // rows it reads as ten separate findings.
    const decision = plan("started", MEMBERS, GUARD);
    for (const s of decision.steps) {
      assert.doesNotMatch(s.reason ?? "", /\$12\.40/);
    }
  });
});

describe("haltPlan — a stop that arrives when there is nothing to do", () => {
  it("is a no-op on an instance already stopping", () => {
    // Idempotence: a second press must not run a second kill ladder over
    // children that are already dying.
    const decision = plan("stopping");
    assert.equal(decision.act, false);
    assert.deepEqual(decision.steps, []);
    assert.match(decision.note ?? "", /already stopping/);
  });

  it("is a no-op on an instance whose members have all finished stopping", () => {
    const decision = plan("stopped");
    assert.equal(decision.act, false);
    assert.deepEqual(decision.steps, []);
    assert.match(decision.note ?? "", /already been stopped/);
  });

  it("is a no-op on a graph that was rolled back at creation", () => {
    // `failed` means every run it did create was stopped again in the same pass.
    const decision = plan("failed");
    assert.equal(decision.act, false);
    assert.deepEqual(decision.steps, []);
    assert.match(decision.note ?? "", /never started/);
  });

  it("is a no-op when every block has already finished", () => {
    // Members are created once and these have all settled, so none of them can
    // move again — there is no door to close. Marking the instance stopped would
    // put "stopped by the operator" on a workflow run that finished on its own.
    const decision = plan(
      "started",
      MEMBERS.filter((m) => m.status === "completed" || m.status === "failed"),
    );
    assert.equal(decision.act, false);
    assert.match(decision.note ?? "", /already finished/);
  });

  it("selects only the blocks that exist, mid-instantiation", () => {
    // A stop cannot land inside the creating pass — it holds the event-loop turn
    // from its first createRun to its last — so what it can see is whatever the
    // instance's run table already holds. A block whose run has not been created
    // is not a member, is not selected, and is never created either.
    const decision = plan("started", MEMBERS.slice(0, 2));
    assert.deepEqual(
      decision.steps.map((s) => s.runId),
      ["r-build", "r-test"],
    );
  });

  it("is a no-op on a graph that reached its end, in the word it now reads as", () => {
    // The same instance as the case above, seen through `instanceStatus`: with
    // nothing live it is `finished` rather than `started`, and this is the one
    // place a halt can meet that word. Reading it as "not started" would answer
    // "this run is already stopping" over a graph that stopped on its own.
    const decision = plan(
      "finished",
      MEMBERS.filter((m) => m.status === "completed" || m.status === "failed"),
    );
    assert.equal(decision.act, false);
    assert.match(decision.note ?? "", /already finished/);
  });
});

/* ------------------------------------------------------------------ */
/* Which of the six readings one instance row is                       */
/* ------------------------------------------------------------------ */

/**
 * `instanceStatus` — what a press of Run is reported as.
 *
 * Every way of being wrong here typechecks, throws nothing and renders a page,
 * which is exactly how the defect this pins survived: `started` was the word for
 * every unhalted row, so a graph that finished an hour ago, one whose tail was
 * written off behind a block that decided nothing, and one with a billed agent
 * working in it right now were one green badge between them. That word is what
 * an operator reads to decide whether to wait for it, to go and look at why a
 * block never ran, or to press Run again — and the third of those is money.
 */
describe("instanceStatus — a graph that ended is not a graph still working", () => {
  const tally = (live: number, blocked = 0) => ({ live, blocked });

  it("reads a member still going as started", () => {
    assert.equal(instanceStatus("started", tally(1)), "started");
  });

  it("reads a graph with nothing left to do as finished", () => {
    assert.equal(instanceStatus("started", tally(0)), "finished");
  });

  it("reads a graph whose tail was written off as blocked", () => {
    // The half a `finished` badge would hide: these blocks never ran, because
    // the one in front of them satisfied nothing, and nothing will ever wake
    // them. Reported as finished it reads as a workflow that did its work.
    assert.equal(instanceStatus("started", tally(0, 2)), "blocked");
  });

  it("reads a branch that died beside one still running as started", () => {
    // A blocked member does not end the instance: the rest of the graph is
    // still spending, and `started` is what says the page is worth refreshing.
    assert.equal(instanceStatus("started", tally(1, 1)), "started");
  });

  it("keeps the halt above whatever the members say", () => {
    // Who ended it is the headline. A member written off by the halt itself
    // must not turn "you stopped this" into "a block stopped it".
    assert.equal(instanceStatus("stopping", tally(2, 1)), "stopping");
    assert.equal(instanceStatus("stopping", tally(0, 1)), "stopped");
    assert.equal(instanceStatus("failed", tally(0, 3)), "failed");
    assert.equal(instanceStatus("failed", tally(2)), "failed");
  });

  it("reads an unrecognised stored value off the members", () => {
    // The forgiving default the graph blob gets, for the same reason: this is a
    // record and it has to keep rendering. A row written by another version
    // still says whether anything is live.
    assert.equal(instanceStatus("kicked-off", tally(1)), "started");
    assert.equal(instanceStatus("", tally(0)), "finished");
  });
});

/* ------------------------------------------------------------------ */
/* What an orchestrator block may emit                                 */
/* ------------------------------------------------------------------ */

/**
 * The two decisions that stand between a model's answer and N billed agents.
 *
 * These clear the bar the rest of `npm test` sets by a wider margin than
 * anything else in this file, because there is no person in the loop at all.
 * Every other route that starts a run has one: the run form, the chat's Approve
 * button, the press of Run on a graph a person wrote. Here the graph was
 * approved months ago and what starts is whatever the block decided a minute
 * ago — so a cap read one too high is an agent nobody agreed to, a folder check
 * that passes is an agent in a repository the block was never pointed at, and a
 * block that emits nothing leaves the runs behind it either started on absent
 * work or asleep for ever with nothing on the page to say why.
 */

/** Everything a block is measured against, so a case states only what it varies. */
function limits(over: Partial<EmissionLimits> = {}): EmissionLimits {
  return {
    blockName: "Pick the work",
    fanOut: 3,
    // Stands in for `resolveWorkspaceFolder` against the block's own mount:
    // "outside" is the one path this fixture refuses.
    folderRefusal: (folder) =>
      folder.startsWith("..") ? "It is outside the workspace." : null,
    // The registry as the turn was shown it. Data rather than an injected
    // function, unlike the folder above: one is a syscall and this is a list.
    agents: [
      { name: "Reviewer", usable: true },
      { name: "Half a thing", usable: false },
    ],
    ...over,
  };
}

/** One emitted spec with everything filled in. */
function spec(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: id.toUpperCase(),
    task: `Do ${id}`,
    folder: "repo",
    ...over,
  };
}

/** Unwrap an emission expected to be accepted. */
function emitted(raw: unknown, over: Partial<EmissionLimits> = {}) {
  const res = planEmission(raw, limits(over));
  assert.ok(res.ok, `expected ok, got: ${res.ok ? "" : res.reason}`);
  return res.specs;
}

/** The refusal for an emission expected to be rejected. */
function refused(raw: unknown, over: Partial<EmissionLimits> = {}): string {
  const res = planEmission(raw, limits(over));
  assert.ok(!res.ok, "expected a refusal");
  return res.reason;
}

/* ------------------------------------------------------------------ */
/* One node becomes one run                                            */
/* ------------------------------------------------------------------ */

/** A run block as `planNode` takes one, fully typed. */
const RUN_BLOCK: WorkflowNode = {
  id: "b1",
  name: "Fix the flake",
  kind: "run",
  templateId: "t1",
  mountId: "work",
  folder: "repo",
  task: "Fix the flaky auth test.",
  promptOverride: null,
  agentId: null,
  fanOut: null,
  mergeStrategy: null,
  mergeAutoResolve: false,
  maxPasses: null,
  maxLoopCostUSD: null,
};

/** A template as `planNode` takes one, with every field it reads different. */
const BLOCK_TEMPLATE: RunTemplate = {
  id: "t1",
  name: "Careful",
  prompt: "Work carefully and commit as you go.",
  mountId: "elsewhere",
  folder: "not/this",
  isolate: true,
  permissionMode: "acceptEdits",
  agentId: null,
  model: "claude-sonnet-5",
  budget: {
    maxIterations: 4,
    maxDurationMinutes: 60,
    maxRunCostUSD: 5,
    maxRunCostFactor: null,
    maxRunTokens: null,
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    enforcement: "between-cycles",
    continueAfterDone: false,
  },
  createdAt: 0,
  updatedAt: 0,
};

/** The untemplated set, different from the template's in every field. */
const BLOCK_DEFAULTS: RunGuards = {
  permissionMode: "plan",
  isolate: false,
  budget: {
    maxIterations: 1,
    maxDurationMinutes: 30,
    maxRunCostUSD: 2,
    maxRunCostFactor: null,
    maxRunTokens: null,
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    enforcement: "live",
    continueAfterDone: false,
  },
};

/**
 * What a block inherits from the template it names, and what it does not.
 *
 * The model is the one worth a test rather than a comment, because its failure
 * is silent in the direction that costs money: a template that saved a model,
 * named by a block, quietly starting every one of that block's runs on
 * `settings.defaultModel` instead — the right task at a different price, with
 * nothing on the instance page saying so. The guards beside it are asserted in
 * the same case so a passing model assertion cannot be one read off the wrong
 * record.
 */
describe("planNode — what a block takes from its template", () => {
  it("runs a block on its template's model", () => {
    const plan = planNode(RUN_BLOCK, BLOCK_TEMPLATE, BLOCK_DEFAULTS, null);
    assert.ok(plan.ok);
    assert.equal(plan.input.model, "claude-sonnet-5");
    // Beside the two it already inherited, so the model is reaching the run by
    // the same route rather than by a new one.
    assert.equal(plan.input.permissionMode, "acceptEdits");
    assert.ok(plan.input.prompt.startsWith("Work carefully and commit as you go."));
  });

  it("leaves the model to createRun when the template names none", () => {
    const plan = planNode(
      RUN_BLOCK,
      { ...BLOCK_TEMPLATE, model: null },
      BLOCK_DEFAULTS,
      null,
    );
    assert.ok(plan.ok);
    // Null rather than a default read here: `input.model ?? settings.defaultModel`
    // in `createRun` is the one place that fallback is applied.
    assert.equal(plan.input.model, null);
  });

  it("names no model for a block that names no template", () => {
    // `settings.chatDefaultGuards` is a guard set and holds no model, so a
    // block under the untemplated guards has nothing to inherit.
    const plan = planNode(
      { ...RUN_BLOCK, templateId: null },
      null,
      BLOCK_DEFAULTS,
      null,
    );
    assert.ok(plan.ok);
    assert.equal(plan.input.model, null);
    assert.equal(plan.input.permissionMode, "plan");
  });

  it("still takes the mount and folder off the node, not the template", () => {
    // The asymmetry the model does *not* join: a template edited months later
    // must not move a saved block's run to another repository.
    const plan = planNode(RUN_BLOCK, BLOCK_TEMPLATE, BLOCK_DEFAULTS, null);
    assert.ok(plan.ok);
    assert.equal(plan.input.mountId, "work");
    assert.equal(plan.input.folder, "repo");
  });
});

describe("planWorkflowProposal — a graph a model wrote becomes a saved workflow", () => {
  const proposal = (nodes: unknown[], edges: unknown[] = []) => ({
    title: "Nightly sweep",
    graph: JSON.stringify({ nodes, edges }),
  });

  it("takes the workflow's name from the title the operator approved", () => {
    const plan = planWorkflowProposal(proposal([node("a")]), KNOWN);
    assert.ok(plan.ok);
    assert.equal(plan.input.name, "Nightly sweep");
  });

  it("saves no instance budget, because a budget is not a thing a model may set", () => {
    // Not an oversight and not a default: there is no field on the tool, no
    // column on the row and no argument here that could carry one. A workflow
    // with no budget runs by hand and refuses to be scheduled, which is the
    // cost, and the card says so.
    const plan = planWorkflowProposal(proposal([node("a")]), KNOWN);
    assert.ok(plan.ok);
    assert.deepEqual(plan.input.instanceBudget, {
      maxInstanceCostUSD: null,
      maxSessionFraction: null,
      maxWeeklyFraction: null,
    });
  });

  it("refuses the same graphs the save route refuses, in the same words", () => {
    // The whole point of going through `normalizeWorkflowInput`: a second set
    // of rules about what a workflow may be would be confidently wrong about
    // what approval does the day one of them changed.
    const noCap = planWorkflowProposal(
      proposal([node("a", { kind: "orchestrator" })]),
      KNOWN,
    );
    assert.ok(!noCap.ok);
    assert.equal(
      noCap.reason,
      error(graph([node("a", { kind: "orchestrator" })])),
    );
  });

  it("refuses a template deleted since the proposal was written, rather than falling back", () => {
    const gone: WorkflowKnowledge = { ...KNOWN, templates: new Map() };
    const plan = planWorkflowProposal(proposal([node("a")]), gone);
    assert.ok(!plan.ok);
    assert.match(plan.reason, /names a template that no longer exists/);
  });

  it("refuses a proposal carrying no graph, or one that cannot be read", () => {
    const empty = planWorkflowProposal({ title: "x", graph: null }, KNOWN);
    assert.ok(!empty.ok);
    assert.match(empty.reason, /carries no workflow/);

    const broken = planWorkflowProposal({ title: "x", graph: "{oh dear" }, KNOWN);
    assert.ok(!broken.ok);
    assert.match(broken.reason, /could not be read/);
  });

  it("keeps the edges, so an approved graph runs in the order it was proposed in", () => {
    const plan = planWorkflowProposal(
      proposal([node("a"), node("b")], [edge("a", "b", { continueBranch: true })]),
      KNOWN,
    );
    assert.ok(plan.ok);
    assert.deepEqual(plan.input.graph.edges, [
      { from: "a", to: "b", edge: "on-success", continueBranch: true },
    ]);
  });

  it("keeps a block's agent, and takes no guard from it", () => {
    // The chat may name what the block's child is. It may not name what that
    // child is allowed to do — so the saved node carries the agent and every
    // guard beside it is still the template's id and nothing else.
    const plan = planWorkflowProposal(
      proposal([node("a", { agentId: "a-rev" })]),
      KNOWN,
    );
    assert.ok(plan.ok);
    assert.equal(plan.input.graph.nodes[0].agentId, "a-rev");
    assert.equal(plan.input.graph.nodes[0].templateId, "t-iso");
  });

  it("refuses an agent deleted since the proposal was written, by name", () => {
    // The template's rule one field over, and the same window: the model wrote
    // the card, the operator tidied the registry, then clicked. Falling back to
    // no agent would start the run the card described as the reviewer's
    // with nothing to say it had not been.
    const gone: WorkflowKnowledge = { ...KNOWN, agents: new Map() };
    const plan = planWorkflowProposal(
      proposal([node("a", { agentId: "a-rev" })]),
      gone,
    );
    assert.ok(!plan.ok);
    assert.match(plan.reason, /no longer exists/);
  });

  it("refuses an agent the CLI would drop, and one named on a merge block", () => {
    // Both are the same failure arriving from different directions: a block
    // whose agent the CLI will not register, and a block with no child for
    // an agent to be at all.
    const decayed = planWorkflowProposal(
      proposal([node("a", { agentId: "a-broken" })]),
      KNOWN,
    );
    assert.ok(!decayed.ok);
    assert.match(decayed.reason, /Half a thing/);

    const onMerge = planWorkflowProposal(
      proposal([node("a"), merger("m", { agentId: "a-rev" })], [edge("a", "m")]),
      KNOWN,
    );
    assert.ok(!onMerge.ok);
    assert.match(onMerge.reason, /starts no agent/);
  });
});

describe("summarizeProposedGraph — what the approval card has to show", () => {
  const untemplated = "acceptEdits · own checkout · 1 cycle";

  it("names the template each block's guards come from", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a")])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(a.guardsLabel, "Isolated");
  });

  it("spells the untemplated guard set out, since there is nothing to go and read", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a", { templateId: null })])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(a.guardsLabel, untemplated);
  });

  it("carries the fan-out cap, which is the number the operator is agreeing to", () => {
    // The one figure on the card that bounds agents nobody approves
    // individually. Absent, the decision moves to a canvas that may never be
    // opened.
    const [d] = summarizeProposedGraph(
      value(graph([decider("d", { fanOut: 4 })])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(d.fanOut, 4);
  });

  it("says a merge block may pay to reconcile, and names no folder for it", () => {
    const summary = summarizeProposedGraph(
      value(
        graph(
          [node("a"), merger("m", { mergeAutoResolve: true })],
          [edge("a", "m")],
        ),
      ).graph,
      KNOWN,
      untemplated,
    );
    const m = summary.find((b) => b.kind === "merge")!;
    assert.equal(m.mergeAutoResolve, true);
    assert.equal(m.folderLabel, null);
    assert.deepEqual(m.after, ["A"]);
  });

  it("reports a template deleted since, the same fact approval will refuse on", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a")])).graph,
      { ...KNOWN, templates: new Map() },
      untemplated,
    );
    assert.equal(a.guardsLabel, "template deleted");
  });

  it("names the agent a block's child is started as, apart from its guards", () => {
    // Two fields rather than one string, because an agent bounds nothing: read
    // inside the guard clause it would claim to narrow what the block may do,
    // which is the one thing about an agent that is not true.
    const [a] = summarizeProposedGraph(
      value(graph([node("a", { agentId: "a-rev" })])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(a.agentLabel, "Reviewer");
    assert.equal(a.guardsLabel, "Isolated");
  });

  it("says nothing about an agent where none was named", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a")])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(a.agentLabel, null);
  });

  it("reports an agent deleted since, the same fact approval will refuse on", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a", { agentId: "a-rev" })])).graph,
      { ...KNOWN, agents: new Map() },
      untemplated,
    );
    assert.equal(a.agentLabel, "agent deleted");
  });
});

describe("planEmission — which specs become runs", () => {
  it("accepts a plain list and keeps every field the spec may set", () => {
    const specs = emitted([spec("a"), spec("b", { folder: "repo/api" })]);
    assert.deepEqual(
      specs.map((s) => [s.id, s.title, s.task, s.folder]),
      [
        ["a", "A", "Do a", "repo"],
        ["b", "B", "Do b", "repo/api"],
      ],
    );
    // And nothing else. A spec that could carry a guard would be a route to
    // --permission-mode reached by a model with nobody reading the result.
    // `agent` is on this list and is not one of those: a saved agent holds no
    // tool list and no permission mode, so naming one decides who does a piece
    // of the work exactly as the task text decides what the work is.
    assert.deepEqual(Object.keys(specs[0]).sort(), [
      "agent",
      "dependsOn",
      "folder",
      "id",
      "task",
      "title",
    ]);
    assert.equal(specs[0].agent, null, "a spec that names none carries none");
  });

  it("takes the mount root as a real answer", () => {
    // `""` is the workspace root on a node and on a template, so it is one
    // here too: collapsing it into "no folder named" would silently promote a
    // deliberate choice into something else.
    assert.equal(emitted([spec("a", { folder: "" })])[0].folder, "");
  });

  it("accepts an empty emission", () => {
    // "There is nothing worth doing" is an answer, and the alternative is a
    // block that has to invent work in order to say so.
    assert.deepEqual(emitted([]), []);
  });

  it("refuses one more than the cap, naming both numbers", () => {
    // The cap is the whole of what the operator agreed to when they saved the
    // graph, and it is the one refusal the model can act on by emitting fewer —
    // so it says how many it may have and how many it asked for.
    const reason = refused([spec("a"), spec("b"), spec("c"), spec("d")]);
    assert.match(reason, /at most 3 run\(s\)/);
    assert.match(reason, /asks for 4/);
    assert.match(reason, /cannot be raised from here/);
  });

  it("accepts exactly the cap", () => {
    // Off by one in the other direction is a block that can never use its last
    // slot, which is a quiet, permanent underuse nothing would report.
    assert.equal(emitted([spec("a"), spec("b"), spec("c")]).length, 3);
  });

  it("refuses a folder the mount check rejects, naming the run", () => {
    // Containment is decided per mount by `resolveInMount`, twice. What this
    // pins is that the refusal reaches the model as a sentence it can act on
    // rather than as a run started somewhere nobody pointed it at.
    const reason = refused([spec("a", { folder: "../elsewhere" })]);
    assert.match(reason, /“A” names a folder that cannot be used/);
    assert.match(reason, /outside the workspace/);
    assert.match(reason, /use a folder exactly as list_folders gives it/i);
  });

  it("refuses the whole emission when one spec's folder is refused", () => {
    // Not "start the three that are fine": the block decided on a set, and
    // silently dropping one leaves it reporting work that is not happening.
    assert.match(
      refused([spec("a"), spec("b", { folder: "../out" }), spec("c")]),
      /“B” names a folder that cannot be used/,
    );
  });

  it("refuses a spec with no title or no task", () => {
    assert.match(refused([spec("a", { title: "  " })]), /needs a title/);
    assert.match(refused([spec("a", { task: "" })]), /has no task/);
  });

  it("refuses two specs sharing an id", () => {
    assert.match(
      refused([spec("a"), spec("a")]),
      /Two runs share the id “a”/,
    );
  });

  it("refuses anything that is not a list", () => {
    assert.match(refused(undefined), /has to be a list/);
    assert.match(refused({ a: 1 }), /has to be a list/);
  });

  it("orders the specs so each is created after what it waits for", () => {
    // The property `startWorkflow` needs of a graph, for the same reason:
    // `createRun` names the runs a spec depends on, so one created too early
    // would name a run that does not exist yet.
    const specs = emitted([
      spec("c", { dependsOn: [{ id: "b", edge: "on-success" }] }),
      spec("b", { dependsOn: [{ id: "a", edge: "on-finish" }] }),
      spec("a"),
    ]);
    assert.deepEqual(
      specs.map((s) => s.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(specs[1].dependsOn, [{ id: "a", edge: "on-finish" }]);
  });

  it("names the loop rather than leaving createRun to refuse a missing run", () => {
    // This is where "acyclic by construction" stops being the argument. Each
    // insert still mints its id after reading its edges, but the graph being
    // inserted is one a model wrote — and a cyclic set has no creation order at
    // all, so the first spec would be refused for naming a run that does not
    // exist rather than for the loop it is part of.
    const reason = refused([
      spec("a", { dependsOn: [{ id: "b", edge: "on-success" }] }),
      spec("b", { dependsOn: [{ id: "a", edge: "on-success" }] }),
    ]);
    assert.match(reason, /wait for each other in a loop/);
    assert.match(reason, /A|B/);
  });

  it("refuses a dependency on anything outside this emission", () => {
    // A block orders the runs it is emitting against each other and nothing
    // else. An edge onto a run it did not create is an edge into a graph it
    // cannot see, and it is how a block would reach work another block owns.
    assert.match(
      refused([spec("a", { dependsOn: [{ id: "r-other", edge: "on-success" }] })]),
      /not one of the runs being emitted/,
    );
  });

  it("refuses a dependency with no condition", () => {
    // Required rather than defaulted, the treatment every other edge in this
    // app gets: `on-success` terminates work the operator meant to run
    // regardless, `on-finish` starts a run on top of one that crashed.
    assert.match(
      refused([spec("b", { dependsOn: [{ id: "a" }] }), spec("a")]),
      /needs a condition for starting after/,
    );
  });

  it("refuses a self-dependency", () => {
    assert.match(
      refused([spec("a", { dependsOn: [{ id: "a", edge: "on-finish" }] })]),
      /start after itself|loop/,
    );
  });

  /* ---------------------------------------------------------------- */
  /* …and who each of them is started as                              */
  /* ---------------------------------------------------------------- */

  it("accepts an agent the registry has, in the registry's own spelling", () => {
    // The name is the key of the object `--agents` takes and the string a
    // transcript attributes a delegated turn to, so what reaches the run is
    // what the operator saved rather than the turn's approximation of it.
    assert.equal(emitted([spec("a", { agent: "reviewer" })])[0].agent, "Reviewer");
  });

  it("refuses an agent this install does not have, by the name it asked for", () => {
    // Refused rather than dropped, beside the cap and the loop and for the same
    // reason: there is no person between this answer and the spawn, and a run
    // emitted "as the reviewer" that starts without one cannot be told
    // afterwards from a run that named none.
    const reason = refused([spec("a", { agent: "Auditor" })]);
    assert.match(reason, /“A”/);
    assert.match(reason, /does not have/);
    assert.match(reason, /Auditor/);
  });

  it("refuses one the CLI would drop, rather than emitting a run without it", () => {
    const reason = refused([spec("a", { agent: "Half a thing" })]);
    assert.match(reason, /missing its description or its prompt/);
  });

  it("takes no agent as the ordinary run", () => {
    assert.equal(emitted([spec("a")])[0].agent, null);
    assert.equal(emitted([spec("a", { agent: "" })])[0].agent, null);
  });

  /* ---------------------------------------------------------------- */
  /* …and where those runs may work                                    */
  /* ---------------------------------------------------------------- */

  /**
   * The bound the block's own prompt promises, which for a while nothing
   * enforced: the folder check read the *mount* and never `node.folder`, so a
   * block saved on `projectA` could emit a run in `projectB` — or in `""`, the
   * mount root, which `conflictKey`/`overlaps` treats as containing every other
   * folder and so blocks every other run in the tree. Silent in the worst way
   * available here: an unattended, file-writing agent in a repository nobody
   * pointed it at, started from a graph that names one folder and a prompt that
   * says so in words.
   *
   * `resolve` is injected, so this needs no filesystem — the same reason
   * `EmissionLimits.folderRefusal` is a function rather than a call.
   */
  const MOUNT = "/w";
  /** Folders the mount does not have, for the two "not there" cases. */
  const MISSING = new Set(["gone", "vanished"]);
  /** A symlink inside the block's folder pointing at a sibling's insides. */
  const LINKS: Record<string, string> = { "projectA/vendor": "/w/projectB/src" };

  /** Stands in for `resolveWorkspaceFolder` against the block's own mount. */
  function resolveInFakeMount(folder: string): string {
    const abs = path.posix.resolve(MOUNT, folder);
    if (abs !== MOUNT && !abs.startsWith(`${MOUNT}/`)) {
      throw new Error(`Folder is outside the "work" mount: ${folder}`);
    }
    const rel = path.posix.relative(MOUNT, abs);
    if (MISSING.has(rel)) {
      throw new Error(`No such folder in the "work" mount: ${folder}`);
    }
    // Resolved, as `resolveInMount` returns it: a link inside the block's
    // folder that points at a sibling reads as the sibling.
    return LINKS[rel] ?? abs;
  }

  /** The whole folder check one block would supply, with the syscall stubbed. */
  const bounded = (blockFolder: string): Partial<EmissionLimits> => ({
    folderRefusal: (folder) =>
      emittedFolderRefusal(blockFolder, folder, resolveInFakeMount),
  });

  it("refuses a sibling of the block's own folder, naming that folder", () => {
    // The regression. Accepted before the block's folder was checked at all,
    // and what it starts is an agent writing files in another repository.
    const reason = refused([spec("a", { folder: "projectB" })], bounded("projectA"));
    assert.match(reason, /“A” names a folder that cannot be used/);
    assert.match(reason, /outside “projectA”/);
    assert.match(reason, /projectB/);
  });

  it("accepts the block's own folder and anything under it", () => {
    const specs = emitted(
      [spec("a", { folder: "projectA" }), spec("b", { folder: "projectA/api" })],
      bounded("projectA"),
    );
    assert.deepEqual(
      specs.map((s) => s.folder),
      ["projectA", "projectA/api"],
    );
  });

  it("refuses the mount root from a block that is not on it", () => {
    // `""` is a real answer on a node and stays one here — but it is the one
    // folder that overlaps every other, so a block held to `projectA` reaching
    // for it is the escape that costs the most.
    const reason = refused([spec("a", { folder: "" })], bounded("projectA"));
    assert.match(reason, /outside “projectA”/);
  });

  it("refuses a folder that only lexically looks inside the block's", () => {
    // Two ways to read as inside and not be: climbing back out, and a symlink
    // the mount check resolves. Containment is decided on the resolved path
    // for the second one, which is why the first is not the whole test.
    assert.match(
      refused([spec("a", { folder: "projectA/../projectB" })], bounded("projectA")),
      /outside “projectA”/,
    );
    assert.match(
      refused([spec("a", { folder: "projectA/vendor" })], bounded("projectA")),
      /outside “projectA”/,
    );
  });

  it("takes the whole mount as the bound when the block sits on the root", () => {
    // What that block's own prompt says, so it is what it gets: `folder: ""`
    // names no narrower bound, and refusing a sibling there would be refusing
    // the block the operator saved.
    const specs = emitted(
      [spec("a", { folder: "projectB" }), spec("b", { folder: "" })],
      bounded(""),
    );
    assert.deepEqual(
      specs.map((s) => s.folder),
      ["projectB", ""],
    );
  });

  it("passes the mount refusal through, from either block", () => {
    // The containment guarantee is unchanged and still first: a folder outside
    // the mount is refused in the same words whatever the block's own folder.
    assert.match(
      refused([spec("a", { folder: "../elsewhere" })], bounded("projectA")),
      /outside the "work" mount/,
    );
    assert.match(
      refused([spec("a", { folder: "gone" })], bounded("")),
      /No such folder in the "work" mount/,
    );
  });

  it("refuses everything when the block's own folder has gone", () => {
    // Nothing can be shown to be inside a folder that is not there, and the
    // turn still runs — `safeFolder` lets it — so this is reachable. Refusing
    // is the direction that cannot start an agent somewhere unintended.
    const reason = refused([spec("a", { folder: "projectA" })], bounded("vanished"));
    assert.match(reason, /“vanished”/);
    assert.match(reason, /cannot be found any more/);
  });
});

/* ------------------------------------------------------------------ */
/* What a finished turn leaves behind                                  */
/* ------------------------------------------------------------------ */

/**
 * The evidence a deciding block leaves, which is the only thing standing
 * between the operator and a graph that ended for no visible reason.
 *
 * Every failure here is silent and each one costs the same thing: an
 * orchestrator block that starts nothing stops every block behind it, so a row
 * saying `emitted`, zero runs and nothing else is a whole workflow that ran,
 * billed, and ended with no account of why. Three different endings arrive at
 * that row — the turn said there was nothing worth doing, this app refused the
 * runs it asked for, or the turn failed — and telling them apart is the whole
 * job of the three fields this returns. Dropping the reply, folding a refusal
 * into the failure, or recording `failed` on a turn whose runs are about to
 * start all typecheck and all look identical on the page.
 */
describe("blockSettlement — what a finished turn is recorded as", () => {
  const settled = (result: TurnResult, emitted = 0, notes: string[] = []) =>
    blockSettlement(result, emitted, notes);

  it("keeps the turn's reply, which is its account of what it did not start", () => {
    const out = settled({ status: "idle", text: "Nothing to do: the tests pass." });
    assert.equal(out.status, "emitted");
    assert.equal(out.reply, "Nothing to do: the tests pass.");
    assert.equal(out.error, null);
  });

  it("has no reply for a turn that said nothing", () => {
    // Null rather than "", so the page can leave the panel out entirely instead
    // of drawing an empty one that reads as an answer.
    assert.equal(settled({ status: "idle", text: "   " }).reply, null);
    assert.equal(settled({ status: "idle" }).reply, null);
  });

  it("records a failed turn as failed, with the failure and no reply", () => {
    // `parseTurnOutput` puts the text in `error` when the turn failed, so a
    // reply here would be the same sentence twice under two different headings.
    const out = settled({ status: "failed", error: "The CLI exited 1." });
    assert.equal(out.status, "failed");
    assert.equal(out.error, "The CLI exited 1.");
    assert.equal(out.reply, null);
  });

  it("does not record a failed turn that emitted as failed", () => {
    // The specs were accepted while the child was alive and are about to become
    // runs. `failed` blocks every node behind this one, which would strand the
    // very runs this turn started.
    const out = settled({ status: "failed", error: "It exited 1 afterwards." }, 2);
    assert.equal(out.status, "emitted");
    assert.equal(out.error, "It exited 1 afterwards.", "the failure is still recorded");
  });

  it("carries forward what was recorded while the turn was running", () => {
    // The refusals and the unreadable guard are written to the row as they
    // happen, and this write used to replace them with the turn's own error —
    // which is null on a turn that succeeded, so they vanished.
    const out = settled({ status: "idle", text: "I gave up." }, 0, [
      "It tried to emit runs and was refused: over the cap",
    ]);
    assert.deepEqual(out.notes, ["It tried to emit runs and was refused: over the cap"]);
    assert.equal(out.reply, "I gave up.");
  });

  it("records tool calls the CLI declined, deduplicated", () => {
    // "I was not allowed to look" reads exactly like "there was nothing to
    // find" on a block that emitted nothing, and only one is worth acting on.
    const out = settled({ status: "idle", denials: ["Bash", "Bash", "WebFetch"] });
    assert.equal(out.notes.length, 1);
    assert.match(out.notes[0], /Bash, WebFetch/);
  });

  it("has no notes when nothing happened worth recording", () => {
    // Empty rather than a reassuring line: the page draws every note, and a
    // standing "no problems" would train the eye past the ones that matter.
    assert.deepEqual(settled({ status: "idle", text: "Started one." }, 1).notes, []);
  });
});

/* ------------------------------------------------------------------ */
/* What the instance does next                                         */
/* ------------------------------------------------------------------ */

/** A run node's state: the run it became, as its row stands now. */
function ran(
  id: string,
  status: RunStatus,
  iterations = 1,
): InstanceNodeState {
  return { run: { id, status, iterations }, block: null };
}

/** An orchestrator block's ledger row, with the runs it started. */
function decided(
  status: BlockStatus,
  emittedRuns: Array<[string, RunStatus, number?]> = [],
  error: string | null = null,
): InstanceNodeState {
  return {
    run: null,
    block: {
      status,
      emitted: emittedRuns.map(([id, s, i]) => ({
        id,
        status: s,
        iterations: i ?? 1,
      })),
      error,
    },
  };
}

/** A `WorkflowNode` with everything filled in, so a case states what it varies. */
function graphNode(
  id: string,
  name: string,
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    name,
    kind: "run",
    templateId: null,
    mountId: "work",
    folder: "repo",
    task: name,
    promptOverride: null,
    agentId: null,
    fanOut: null,
    mergeStrategy: null,
    mergeAutoResolve: false,
    maxPasses: null,
    maxLoopCostUSD: null,
    ...extra,
  };
}

/** A graph of one orchestrator block feeding one run block. */
const FAN: WorkflowGraph = {
  nodes: [
    graphNode("pick", "Pick the work", {
      kind: "orchestrator",
      task: "Decide",
      fanOut: 3,
    }),
    graphNode("review", "Review it", { task: "Review" }),
  ],
  edges: [edge("pick", "review", { edge: "on-finish" })],
};

function stepOf(state: Record<string, InstanceNodeState>, g = FAN) {
  return planInstanceStep(g, new Map(Object.entries(state)));
}

describe("planInstanceStep — what an instance may do next", () => {
  it("starts a block with nothing in front of it", () => {
    const step = stepOf({ pick: decided("waiting") });
    assert.deepEqual(step.spawn, ["pick"]);
    // And nothing behind it: the block has not decided, so there is nothing
    // for the run block to be created against.
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("leaves a block alone while its turn is in flight", () => {
    // The claim is a guarded UPDATE, but every terminal run transition in the
    // app triggers an advance — so a second pass that re-selected a thinking
    // block would be racing the claim on every one of them.
    assert.deepEqual(stepOf({ pick: decided("thinking") }).spawn, []);
  });

  it("holds the block behind it until every emitted run has settled", () => {
    // Not "until it emitted": the run block is there to follow the work, and
    // created while that work is still running it would start on a branch
    // nothing has been committed to yet.
    const step = stepOf({
      pick: decided("emitted", [
        ["r-1", "completed"],
        ["r-2", "running"],
      ]),
    });
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("creates the block behind it depending on every run that was emitted", () => {
    // The fan-in nobody could write down: the graph says "after Pick the work"
    // and what that resolves to is however many runs it turned out to emit.
    const step = stepOf({
      pick: decided("emitted", [
        ["r-1", "completed"],
        ["r-2", "failed"],
      ]),
    });
    assert.deepEqual(step.create, [
      {
        nodeId: "review",
        dependsOn: [
          { runId: "r-1", edge: "on-finish", continueBranch: false },
          { runId: "r-2", edge: "on-finish", continueBranch: false },
        ],
      },
    ]);
  });

  it("blocks what is behind an empty emission, naming the block", () => {
    // The decision this feature has to make explicitly. A block behind a
    // fan-out exists to review, land or follow up on what the fan-out
    // produced; started with nothing in front of it, it spends a billed cycle
    // discovering that. `edgeSatisfied`'s rule one level up: a dependency that
    // did no work satisfies nothing.
    const step = stepOf({ pick: decided("emitted", []) });
    assert.deepEqual(step.create, []);
    assert.equal(step.block.length, 1);
    assert.equal(step.block[0].nodeId, "review");
    assert.match(step.block[0].reason, /“Pick the work” decided there was nothing to start/);
  });

  it("blocks what is behind a turn that failed, carrying its reason", () => {
    const step = stepOf({
      pick: decided("failed", [], "The chat did not answer within 10 minutes."),
    });
    assert.match(step.block[0].reason, /could not decide what to start/);
    assert.match(step.block[0].reason, /did not answer within 10 minutes/);
  });

  it("blocks what is behind a run that ended without qualifying", () => {
    const step = stepOf({
      pick: decided("emitted", [
        ["r-1", "completed"],
        ["r-2", "failed"],
      ]),
    }, {
      ...FAN,
      edges: [edge("pick", "review", { edge: "on-success" })],
    });
    assert.deepEqual(step.create, []);
    assert.match(step.block[0].reason, /one of them ended failed/);
  });

  it("cascades a block's verdict to everything behind it, one sentence each", () => {
    // The fixed point is the cascade. Every run in the chain names the block in
    // front of *it* rather than one shared verdict about a block at the head it
    // never heard of — the rule `releasableRuns` already follows.
    const chain: WorkflowGraph = {
      ...FAN,
      nodes: [
        ...FAN.nodes,
        graphNode("land", "Land it", { task: "Land" }),
      ],
      edges: [...FAN.edges, edge("review", "land", { edge: "on-success" })],
    };
    const step = stepOf({ pick: decided("emitted", []) }, chain);
    assert.deepEqual(
      step.block.map((b) => b.nodeId),
      ["review", "land"],
    );
    assert.match(step.block[0].reason, /decided there was nothing to start/);
    assert.match(step.block[1].reason, /“Review it”, which never ran/);
  });

  it("creates a run block that is holding a waiting ledger row", () => {
    // Every node behind an orchestrator block gets one of those at
    // instantiation — it is what puts the block on the page as pending and what
    // makes the instance visible to the advance query at all. Read as "already
    // decided", the whole subgraph behind a fan-out would never be created and
    // nothing would say why.
    const step = stepOf({
      pick: decided("emitted", [["r-1", "completed"]]),
      review: decided("waiting"),
    });
    assert.deepEqual(step.create, [
      {
        nodeId: "review",
        dependsOn: [{ runId: "r-1", edge: "on-finish", continueBranch: false }],
      },
    ]);
  });

  it("waits for a run block that has not been created yet", () => {
    // A `waiting` ledger row on a *predecessor* is "behind a decision that has
    // not been made", not "never ran". Read as the second, a chain of two
    // blocks behind one fan-out would block itself at the first advance.
    const chain: WorkflowGraph = {
      ...FAN,
      nodes: [
        ...FAN.nodes,
        graphNode("land", "Land it", { task: "Land" }),
      ],
      edges: [...FAN.edges, edge("review", "land", { edge: "on-success" })],
    };
    const step = stepOf(
      {
        pick: decided("thinking"),
        review: decided("waiting"),
        land: decided("waiting"),
      },
      chain,
    );
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("never re-creates a node that is already a run", () => {
    // Both passes see the same graph, and this runs after every terminal run
    // transition in the app. A node selected twice is a second agent in the
    // same folder from one press of Run.
    const step = stepOf({
      pick: decided("emitted", [["r-1", "completed"]]),
      review: ran("r-review", "queued", 0),
    });
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("never re-decides a node that has already been written off", () => {
    const step = stepOf({
      pick: decided("emitted", []),
      review: decided("blocked", [], "Already written off."),
    });
    assert.deepEqual(step.block, []);
    assert.deepEqual(step.create, []);
  });

  it("waits for a run block in front of a block before deciding", () => {
    // An orchestrator block is there to decide *after* the earlier work
    // happened. Started before it, it decides against a repository in the state
    // the workflow began in, which is the one thing it exists not to do.
    const g: WorkflowGraph = {
      nodes: [graphNode("build", "Build"), FAN.nodes[0]],
      edges: [edge("build", "pick", { edge: "on-success" })],
    };
    assert.deepEqual(
      stepOf({ build: ran("r-build", "running", 0), pick: decided("waiting") }, g)
        .spawn,
      [],
    );
    assert.deepEqual(
      stepOf({ build: ran("r-build", "completed"), pick: decided("waiting") }, g)
        .spawn,
      ["pick"],
    );
    // And a dependency that can never satisfy it ends the block rather than
    // leaving it waiting on a row that is already terminal.
    const dead = stepOf(
      { build: ran("r-build", "failed"), pick: decided("waiting") },
      g,
    );
    assert.deepEqual(dead.spawn, []);
    assert.match(dead.block[0].reason, /“Build”, which ended failed/);
  });
});

/* ------------------------------------------------------------------ */
/* Merge blocks in the schedule                                         */
/* ------------------------------------------------------------------ */

/**
 * Which runs a merge block is handed, and what an edge out of one means.
 *
 * The first is the whole reason `runIds` comes off `edgeVerdict`'s own
 * `dependsOn` rather than being re-derived from the graph: which runs an
 * orchestrator block turned out to emit is a fact only that pass holds, and a
 * second reading of it is a second chance to land a different set of branches
 * than the one the graph waited for.
 *
 * The second is the edge condition doing real work. A merge block creates no
 * run, so nothing about `edgeSatisfied` applies to it — but "review it whether
 * or not it landed" and "only once it is on main" are both things a person
 * writes, and reading a failed merge as satisfying either would start a run on a
 * target that never received the work.
 */
function mergeNode(id: string, name: string): WorkflowNode {
  return graphNode(id, name, {
    kind: "merge",
    mountId: "",
    folder: "",
    task: "",
    mergeStrategy: "merge",
  });
}

describe("planInstanceStep — merge blocks", () => {
  /** Two run blocks feeding one merge block, with a run block behind it. */
  const LAND: WorkflowGraph = {
    nodes: [
      { ...FAN.nodes[1], id: "left", name: "Left" },
      { ...FAN.nodes[1], id: "right", name: "Right" },
      mergeNode("land", "Land it"),
      { ...FAN.nodes[1], id: "after", name: "After" },
    ],
    edges: [
      edge("left", "land"),
      edge("right", "land"),
      edge("land", "after"),
    ],
  };

  it("hands a merge block every branch its satisfied edges resolved to", () => {
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("waiting"),
      },
      LAND,
    );
    assert.deepEqual(step.merge, [
      { nodeId: "land", runIds: ["r-left", "r-right"] },
    ]);
    assert.deepEqual(step.spawn, [], "a merge block spawns no agent");
    assert.deepEqual(step.create, [], "and it is never created as a run");
  });

  it("waits for every predecessor before landing anything", () => {
    // Landing half the work and then landing the rest is two merges into a base
    // that moved in between, which is the case the queue exists to re-decide —
    // but the block was written as one step and has to behave as one.
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "running", 0),
        land: decided("waiting"),
      },
      LAND,
    );
    assert.deepEqual(step.merge, []);
  });

  it("takes every run an orchestrator block emitted", () => {
    const g: WorkflowGraph = {
      nodes: [FAN.nodes[0], mergeNode("land", "Land it")],
      edges: [edge("pick", "land", { edge: "on-success" })],
    };
    const step = stepOf(
      {
        pick: decided("emitted", [
          ["r-1", "completed"],
          ["r-2", "completed"],
        ]),
        land: decided("waiting"),
      },
      g,
    );
    assert.deepEqual(step.merge, [
      { nodeId: "land", runIds: ["r-1", "r-2"] },
    ]);
  });

  it("names a run once when two edges resolve to it", () => {
    // The diamond: two paths out of one run meet again at the merge block.
    // `enqueue` refuses a run that is already queued and refuses the *whole*
    // batch when it does, so a duplicate here is a merge that never happens.
    const diamond: WorkflowGraph = {
      nodes: [
        { ...FAN.nodes[1], id: "build", name: "Build" },
        mergeNode("land", "Land it"),
      ],
      edges: [
        edge("build", "land", { edge: "on-success" }),
        // A second edge cannot be written in the editor — `normalizeWorkflowInput`
        // refuses a repeated pair — so this is the shape an orchestrator block
        // emitting one run into two paths produces.
        { from: "build", to: "land", edge: "on-finish", continueBranch: false },
      ],
    };
    const step = stepOf(
      { build: ran("r-build", "completed"), land: decided("waiting") },
      diamond,
    );
    assert.deepEqual(step.merge, [{ nodeId: "land", runIds: ["r-build"] }]);
  });

  it("releases what is behind it with no dependency on a run", () => {
    // A merge block created nothing, so a successor of it depends on no run
    // through that edge — it is an ordinary queued run meaning "once the work
    // has landed".
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("emitted"),
      },
      LAND,
    );
    assert.deepEqual(step.create, [{ nodeId: "after", dependsOn: [] }]);
  });

  it("stops an on-success successor when the merge did not land everything", () => {
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("failed", [], "Landed 1 of 2 branch(es)."),
      },
      LAND,
    );
    assert.deepEqual(step.create, []);
    assert.match(step.block[0].reason, /did not land everything/);
  });

  it("releases an on-finish successor of a failed merge", () => {
    const g: WorkflowGraph = {
      ...LAND,
      edges: [
        edge("left", "land"),
        edge("right", "land"),
        edge("land", "after", { edge: "on-finish" }),
      ],
    };
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("failed", [], "Landed 1 of 2 branch(es)."),
      },
      g,
    );
    assert.deepEqual(step.create, [{ nodeId: "after", dependsOn: [] }]);
  });

  it("blocks behind a merge that never ran, whatever the condition", () => {
    // `blocked` is "nothing happened", which satisfies nothing — the same
    // distinction `edgeSatisfied` draws between a run that did a cycle and one
    // that did not.
    for (const condition of ["on-success", "on-finish"] as const) {
      const g: WorkflowGraph = {
        ...LAND,
        edges: [
          edge("left", "land"),
          edge("right", "land"),
          edge("land", "after", { edge: condition }),
        ],
      };
      const step = stepOf(
        {
          left: ran("r-left", "completed"),
          right: ran("r-right", "completed"),
          land: decided("blocked", [], "The workflow was stopped."),
        },
        g,
      );
      assert.deepEqual(step.create, [], condition);
      assert.match(step.block[0].reason, /never ran/);
    }
  });

  it("holds a successor while the merge is still running", () => {
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("thinking"),
      },
      LAND,
    );
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.merge, [], "and it does not claim it twice");
    assert.deepEqual(step.block, []);
  });
});

/* ------------------------------------------------------------------ */
/* What a restart leaves waiting                                        */
/* ------------------------------------------------------------------ */

/**
 * `bootBlockPlan` decides which instances' `waiting` blocks a restart writes
 * off, and it is the one decision in this file whose wrong answer is invisible
 * for weeks. `reconcileOnBoot` keeps a `paused` member inside its grace period
 * on purpose; closing out the blocks behind it destroys the tail of a graph
 * that is still working and records a sentence about a predecessor that is not
 * true. Sparing one nothing survived in is the opposite error and just as
 * silent — a block that sits `waiting` for ever, because nothing is left that
 * could ever reach `advanceInstances` on its behalf.
 */
function instances(
  ...entries: Array<[string, WorkflowInstanceStatus, ...RunStatus[]]>
) {
  return entries.map(([id, status, ...memberStatuses]) => ({
    id,
    status,
    memberStatuses,
  }));
}

describe("bootBlockPlan — which waiting blocks a restart closes out", () => {
  it("spares an instance a member survived the boot in", () => {
    // The exception this exists for: `reconcileOnBoot` kept that run, so its
    // successors are waiting on something that is genuinely still coming.
    const plan = bootBlockPlan(instances(["i", "started", "completed", "paused"]));
    assert.deepEqual(plan.spared, ["i"]);
    assert.deepEqual(plan.abandoned, []);
    assert.deepEqual(plan.settled, []);
  });

  it("reads every live status as a survivor, not just a pause", () => {
    // `paused` is the only one that can reach this point in the boot today, but
    // by way of a rule in `reconcileOnBoot` — restating it here as a test for
    // one status would make this the second place that decides what survives.
    for (const status of ["waiting", "queued", "running", "paused"] as const) {
      const plan = bootBlockPlan(instances(["i", "started", status]));
      assert.deepEqual(plan.spared, ["i"], status);
    }
  });

  it("closes out an instance whose members all ended", () => {
    const plan = bootBlockPlan(
      instances(["i", "started", "completed", "failed", "stopped", "blocked"]),
    );
    assert.deepEqual(plan.abandoned, ["i"]);
    assert.deepEqual(plan.spared, []);
  });

  it("closes out an instance with no members at all", () => {
    // A graph deferred behind an orchestrator block the same boot has just
    // failed: nothing was ever created, so there is nothing to wait for.
    const plan = bootBlockPlan(instances(["i", "started"]));
    assert.deepEqual(plan.abandoned, ["i"]);
  });

  it("closes out an instance that is not started, however live its members", () => {
    // The bound the halt needs: `stopInstance` had already decided this graph
    // was over, and a `failed` one is `startWorkflow`'s own rollback, which
    // wrote every other block off in the same pass. Reviving half of either is
    // the failure the positive test for `started` exists to have none of.
    for (const status of ["stopping", "stopped", "failed"] as const) {
      const plan = bootBlockPlan(instances(["i", status, "running", "paused"]));
      assert.deepEqual(plan.settled, ["i"], status);
      assert.deepEqual(plan.spared, [], status);
    }
  });

  it("decides every instance exactly once", () => {
    // Three lists and one pass: an instance that fell between two branches is a
    // block nothing writes and nothing wakes, which reads on the page exactly
    // like one that is about to run.
    const given = instances(
      ["live", "started", "paused"],
      ["dead", "started", "failed"],
      ["halted", "stopping", "running"],
      ["empty", "started"],
    );
    const plan = bootBlockPlan(given);
    const decided = [...plan.abandoned, ...plan.settled, ...plan.spared];
    assert.equal(decided.length, given.length);
    assert.deepEqual([...decided].sort(), given.map((i) => i.id).sort());
  });
});

/* ------------------------------------------------------------------ */
/* Loop blocks: whether there is another pass                          */
/* ------------------------------------------------------------------ */

/**
 * The decision a loop makes over and over, with nothing else in the picture.
 *
 * It earns a test on the same grounds as `releasableRuns` and `landRefusal`,
 * sharpened by what a *pass* costs: it is not a work cycle, it is a whole run
 * with its own cycles and its own spend. A loop that never terminates bills one
 * of those per pass for ever; a loop that stops one pass early is silent, in the
 * shape a finished-looking branch with the last piece of work missing.
 */

/** One pass, stated as the status its single run ended in. */
function pass(
  n: number,
  status: RunStatus,
  opts: { done?: boolean; iterations?: number } = {},
): LoopPass {
  return {
    pass: n,
    runs: [
      {
        id: `r-${n}`,
        status,
        iterations: opts.iterations ?? 1,
        reportedDone: opts.done ?? false,
      },
    ],
  };
}

function loopOf(
  passes: LoopPass[],
  extra: Partial<LoopPassInput> = {},
): LoopDecision {
  return planLoopPass({
    blockName: "Chip away at it",
    passes,
    maxPasses: 3,
    maxCostUSD: null,
    spentGuardUSD: 0,
    ...extra,
  });
}

describe("planLoopPass — whether a loop takes another pass", () => {
  it("takes the first pass when nothing has run yet", () => {
    assert.deepEqual(loopOf([]), { kind: "pass", pass: 1 });
  });

  it("waits while the last pass is still working", () => {
    // Every other test here reads the outcome of a pass, and there is none yet.
    // Unrolling ahead of it is also what would put two runs on one predecessor's
    // branch, which admission refuses — so the symptom would be a throw rather
    // than a decision.
    for (const status of ["waiting", "queued", "running", "paused"] as const) {
      assert.deepEqual(loopOf([pass(1, status)]), { kind: "wait" }, status);
    }
  });

  it("takes another pass after one that completed without reporting done", () => {
    // The ordinary case, and the one the whole feature exists for: `completed`
    // is also what a run that merely used up its cycle cap is written as.
    assert.deepEqual(loopOf([pass(1, "completed")]), { kind: "pass", pass: 2 });
  });

  it("stops when the agent reported the work complete", () => {
    // Read off `reported_done`, never off the status. `maxIterations` defaults
    // to 1, so a loop keyed on `completed` would stop after every first pass —
    // a loop that does not loop.
    const d = loopOf([pass(1, "completed", { done: true })]);
    assert.equal(d.kind, "stop");
    assert.equal(d.kind === "stop" && d.code, "done");
    assert.match(
      d.kind === "stop" ? d.reason : "",
      /reported the work complete on pass 1/,
    );
  });

  it("prefers done to the pass cap on the last pass", () => {
    // Both hold at once on the final pass. "It finished" is the truer sentence,
    // and the one that tells the operator not to raise the cap.
    const d = loopOf([
      pass(1, "completed"),
      pass(2, "completed"),
      pass(3, "completed", { done: true }),
    ]);
    assert.equal(d.kind === "stop" && d.code, "done");
  });

  it("stops when a run in the body did not complete, rather than trying again", () => {
    // A loop is not a retry mechanism: the transient-error retries and the
    // refusal backoff already sit inside one run, so a fault that got past them
    // is one the next pass would meet too.
    for (const status of ["failed", "stopped", "blocked"] as const) {
      const d = loopOf([pass(1, "completed"), pass(2, status)]);
      assert.equal(d.kind === "stop" && d.code, "failed", status);
      assert.match(
        d.kind === "stop" ? d.reason : "",
        new RegExp(`Pass 2 .*ended ${status}`),
      );
    }
  });

  it("stops on a pass whose run reported it could not finish", () => {
    // Two failures in one, and the first is the expensive one. `needs-review` is
    // terminal, so the rung above must not read it as a pass still working — a
    // loop block that waits for ever holds everything behind it with nothing on
    // any page to say why, and that is exactly what a missing `TERMINAL_STATUSES`
    // entry produces. Given that, the stop is the right answer for the reason
    // every non-completed status is: a loop is not a retry mechanism, and handing
    // the next pass the same wall costs a whole run rather than a work cycle.
    const d = loopOf([pass(1, "completed"), pass(2, "needs-review")]);
    assert.notEqual(d.kind, "wait");
    assert.equal(d.kind === "stop" && d.code, "failed");
    assert.match(d.kind === "stop" ? d.reason : "", /Pass 2 .*ended needs-review/);
  });

  it("reports the stop rather than the completion when the pass did both", () => {
    // The `reportedDone` rung is below this one, so a last pass that did the work
    // *and* asked for review says it stopped. Same precedence as the cycle-outcome
    // ladder, for the same reason: the ending that asks for a person is the one
    // that can be taken back.
    const d = loopOf([pass(1, "needs-review", { done: true })]);
    assert.equal(d.kind === "stop" && d.code, "failed");
  });

  it("stops at the pass cap", () => {
    const d = loopOf([
      pass(1, "completed"),
      pass(2, "completed"),
      pass(3, "completed"),
    ]);
    assert.equal(d.kind === "stop" && d.code, "passes");
    assert.match(d.kind === "stop" ? d.reason : "", /limit of 3 pass\(es\)/);
  });

  it("takes exactly one pass when the cap is one", () => {
    // A cap of 1 is a loop that does not repeat, and it has to be a legal
    // setting rather than an off-by-one: the first pass still happens.
    assert.deepEqual(loopOf([], { maxPasses: 1 }), { kind: "pass", pass: 1 });
    const after = loopOf([pass(1, "completed")], { maxPasses: 1 });
    assert.equal(after.kind === "stop" && after.code, "passes");
  });

  it("stops when the passes have spent their own limit", () => {
    const d = loopOf([pass(1, "completed")], {
      maxCostUSD: 5,
      spentGuardUSD: 5,
    });
    assert.equal(d.kind === "stop" && d.code, "cost");
    assert.match(d.kind === "stop" ? d.reason : "", /5\.00 of its 5\.00 limit/);
  });

  it("carries on below the spending limit, and ignores a null one", () => {
    assert.deepEqual(
      loopOf([pass(1, "completed")], { maxCostUSD: 5, spentGuardUSD: 4.99 }),
      { kind: "pass", pass: 2 },
    );
    assert.deepEqual(
      loopOf([pass(1, "completed")], { maxCostUSD: null, spentGuardUSD: 900 }),
      { kind: "pass", pass: 2 },
    );
  });

  it("stops on a pass that produced no runs at all", () => {
    // The hot loop. A pass whose `createRun` threw, or whose run row has been
    // deleted, has nothing to carry on from — and another pass would be created
    // the same way and fail the same way, for ever, one billed attempt at a
    // time.
    const d = loopOf([{ pass: 1, runs: [] }]);
    assert.equal(d.kind === "stop" && d.code, "empty");
    assert.match(d.kind === "stop" ? d.reason : "", /started no run/);
  });

  it("reads the empty pass before the caps, so the sentence names the cause", () => {
    const d = loopOf([{ pass: 1, runs: [] }], {
      maxPasses: 1,
      maxCostUSD: 1,
      spentGuardUSD: 99,
    });
    assert.equal(d.kind === "stop" && d.code, "empty");
  });
});

describe("planInstanceStep — a loop block among the others", () => {
  /** One loop block, with a run block set to follow it. */
  const LOOP: WorkflowGraph = {
    nodes: [
      graphNode("chip", "Chip away at it", { kind: "loop", maxPasses: 3 }),
      graphNode("review", "Review it"),
    ],
    edges: [edge("chip", "review", { edge: "on-success", continueBranch: true })],
  };

  it("asks for a loop's first pass rather than creating it as a run", () => {
    const step = stepOf({ chip: decided("waiting") }, LOOP);
    assert.deepEqual(step.loop, [{ nodeId: "chip", dependsOn: [] }]);
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.spawn, []);
  });

  it("holds everything behind a loop while it is still repeating", () => {
    // The window that matters: between two passes there is no unsettled run on
    // the branch at all, so a successor released here would review and land a
    // ref that is about to move.
    const step = stepOf(
      { chip: decided("looping", [["r-1", "completed"]]) },
      LOOP,
    );
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("creates the block behind it against the last pass, carrying the branch", () => {
    // The last pass and no other: the passes are a chain, so waiting for it is
    // waiting for all of them, and it is the only run a successor can continue
    // without becoming a second run on one predecessor.
    const step = stepOf(
      {
        chip: decided("emitted", [
          ["r-1", "completed"],
          ["r-2", "completed"],
        ]),
      },
      LOOP,
    );
    assert.deepEqual(step.create, [
      {
        nodeId: "review",
        dependsOn: [{ runId: "r-2", edge: "on-success", continueBranch: true }],
      },
    ]);
  });

  it("blocks what is behind a loop whose last pass did not qualify", () => {
    const step = stepOf(
      {
        chip: decided("emitted", [
          ["r-1", "completed"],
          ["r-2", "failed"],
        ]),
      },
      LOOP,
    );
    assert.deepEqual(step.create, []);
    assert.match(step.block[0].reason, /whose last pass ended failed/);
  });

  it("blocks what is behind a loop that took no passes", () => {
    const step = stepOf({ chip: decided("emitted", []) }, LOOP);
    assert.match(step.block[0].reason, /took no passes/);
  });

  it("never asks for a first pass twice", () => {
    // Every terminal run transition in the app triggers an advance, so a loop
    // selected again while it is repeating is a second run in the same folder.
    assert.deepEqual(stepOf({ chip: decided("looping") }, LOOP).loop, []);
    assert.deepEqual(stepOf({ chip: decided("emitted") }, LOOP).loop, []);
    assert.deepEqual(stepOf({ chip: decided("failed") }, LOOP).loop, []);
  });

  it("waits for what is in front of a loop before its first pass", () => {
    const g: WorkflowGraph = {
      nodes: [graphNode("build", "Build"), ...LOOP.nodes],
      edges: [edge("build", "chip", { edge: "on-success" }), ...LOOP.edges],
    };
    assert.deepEqual(
      stepOf(
        { build: ran("r-build", "running", 0), chip: decided("waiting") },
        g,
      ).loop,
      [],
    );
    assert.deepEqual(
      stepOf({ build: ran("r-build", "completed"), chip: decided("waiting") }, g)
        .loop,
      [
        {
          nodeId: "chip",
          dependsOn: [
            { runId: "r-build", edge: "on-success", continueBranch: false },
          ],
        },
      ],
    );
  });
});
