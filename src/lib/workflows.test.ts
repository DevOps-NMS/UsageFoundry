import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  haltPlan,
  normalizeWorkflowInput,
  topologicalOrder,
  type HaltCause,
  type HaltMember,
  type WorkflowEdge,
  type WorkflowInstanceStatus,
  type WorkflowKnowledge,
} from "./workflows";

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
 * Nothing here opens the database or touches the filesystem. `folderRefusal` is
 * the one check that does, and it is left to the routes for that reason.
 */

const KNOWN: WorkflowKnowledge = {
  templates: new Map([
    ["t-iso", { name: "Isolated", isolate: true }],
    ["t-flat", { name: "In place", isolate: false }],
  ]),
  mountIds: ["work", "other"],
  defaultIsolate: true,
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
) {
  return haltPlan({ status, workflowName: "Nightly" }, members, cause);
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
    const gone = step(
      plan("started", [{ runId: "r-gone", nodeName: "Gone", status: null }]),
      "r-gone",
    );
    assert.equal(gone.action, "leave");
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
});
