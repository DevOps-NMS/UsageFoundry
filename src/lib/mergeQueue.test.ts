import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isQueueActive,
  planItem,
  selectQueueBatches,
  type BatchSummary,
  type QueueStatus,
} from "./mergeQueue";
import type { LandState } from "./land";

/**
 * Covers the queue's two pure decisions and nothing else.
 *
 * `planItem` is what the worker does with one branch: whether to write into a
 * directory a person owns, whether to spend their money reconciling a branch
 * first, and whether the problem it just hit is one every branch behind this one
 * will hit too. Each of those is expensive to get wrong in a different way — a
 * merge nobody sanctioned, a billed resolution for a merge that was going to be
 * refused anyway, or ten identical refusals scrolling past because the queue
 * kept trying against a checkout that was never going to accept any of them.
 *
 * `selectQueueBatches` is what the operator can see and therefore stop. The
 * worker drains every queued row whatever batch it belongs to, so a batch left
 * out of this answer goes on merging into the operator's checkout with nothing
 * on the page naming it — and `cancelBatch` is scoped by `batch_id`, so a batch
 * the page cannot name is a batch nobody can cancel. Both failures are silent:
 * the page renders a shorter list, correctly, and says nothing about the merges
 * missing from it.
 */

const base: LandState = {
  runId: "r1",
  runStatus: "completed",
  branch: "uf/repo-1234abcd",
  chain: [{ runId: "r1", status: "completed", iterations: 1 }],
  target: "main",
  targetInferred: false,
  branchExists: true,
  ahead: 2,
  behind: 0,
  merged: false,
  landedUnchanged: false,
  preview: { outcome: "clean" },
  checkout: { path: "/workspace/repo", headBranch: "main", dirty: false, readable: true },
  pending: null,
  blocked: null,
  landedAt: null,
  landedInto: null,
  landedStrategy: null,
};

const conflict: LandState = {
  ...base,
  preview: {
    outcome: "conflict",
    files: [
      {
        path: "src/auth.ts",
        type: "contents",
        message: null,
        regions: [],
        regionsOmitted: 0,
        regionsRead: true,
      },
    ],
  },
  blocked: "Merging into main conflicts in 1 file(s). Resolve them on the branch first.",
};

const open = { autoResolve: true, resolutionsRefused: null };

describe("planItem", () => {
  it("lands a branch that is ready", () => {
    assert.deepEqual(planItem(base, open), { action: "land" });
  });

  it("resolves a conflict when that was authorised", () => {
    assert.deepEqual(planItem(conflict, open), { action: "resolve" });
  });

  it("fails a conflict rather than spending when it was not", () => {
    const plan = planItem(conflict, { autoResolve: false, resolutionsRefused: null });
    assert.equal(plan.action, "fail");
    assert.match(plan.action === "fail" ? plan.reason : "", /conflicts in 1 file/);
  });

  it("stops trying to resolve once one refusal applies to all of them", () => {
    // A window at its ceiling refuses every later resolution identically, and
    // each attempt costs a full transcript scan to find that out again.
    const plan = planItem(conflict, {
      autoResolve: true,
      resolutionsRefused: "Your 5-hour window is already at the ceiling you set.",
    });
    assert.equal(plan.action, "fail");
    assert.match(plan.action === "fail" ? plan.reason : "", /ceiling/);
  });

  it("halts the repository on a dirty checkout rather than failing one branch", () => {
    const plan = planItem(
      { ...base, checkout: { ...base.checkout!, dirty: true }, blocked: "dirty" },
      open,
    );
    assert.equal(plan.action, "halt");
    assert.match(plan.action === "halt" ? plan.reason : "", /uncommitted changes/);
  });

  it("halts on a checkout standing on the wrong branch", () => {
    const plan = planItem(
      {
        ...base,
        checkout: { ...base.checkout!, headBranch: "feature/other" },
        blocked: "wrong branch",
      },
      open,
    );
    assert.equal(plan.action, "halt");
    assert.match(plan.action === "halt" ? plan.reason : "", /feature\/other/);
  });

  it("treats an unreadable checkout as a halt, not as one branch's problem", () => {
    const plan = planItem(
      {
        ...base,
        checkout: { ...base.checkout!, readable: false, dirty: true },
        blocked: "unreadable",
      },
      open,
    );
    assert.equal(plan.action, "halt");
  });

  it("checks the checkout before the conflict, so a doomed merge is never paid for", () => {
    // `landRefusal` names the conflict first, which is right for "why can this
    // not be landed". Resolving here would bill a model to reconcile a branch
    // into a checkout that is going to refuse the merge regardless.
    const plan = planItem(
      { ...conflict, checkout: { ...base.checkout!, dirty: true } },
      open,
    );
    assert.equal(plan.action, "halt");
  });

  it("fails, never halts, while the run itself is still going", () => {
    // Its own branch is the problem and the ones behind it are unaffected — and
    // a run that is still committing says nothing about the checkout at all.
    for (const runStatus of ["running", "queued", "paused"] as const) {
      const plan = planItem(
        { ...base, runStatus, blocked: "This run is still active." },
        open,
      );
      assert.equal(plan.action, "fail", `${runStatus} should fail, not halt`);
    }
  });

  it("fails a branch that is already in, without touching anything", () => {
    const plan = planItem(
      { ...base, merged: true, ahead: 0, blocked: "Already in main — there is nothing left to land." },
      open,
    );
    assert.equal(plan.action, "fail");
  });

  it("fails a run that never had a branch", () => {
    assert.equal(planItem(null, open).action, "fail");
  });
});

/**
 * A batch written as the statuses of its rows, which is how the queue is read.
 *
 * `isQueueActive` rather than a list spelled out here: it is the one definition
 * of "the worker still owes this row an answer", and the SQL that builds these
 * summaries is built from the same one.
 */
const batch = (
  batchId: string,
  createdAt: number,
  statuses: QueueStatus[],
): BatchSummary => ({
  batchId,
  createdAt,
  unfinished: statuses.some(isQueueActive),
});

const ids = (batches: BatchSummary[]) => batches.map((b) => b.batchId);

describe("selectQueueBatches", () => {
  it("keeps an earlier batch that is still queued when a newer one is added", () => {
    // The defect this exists for: five branches queued for one repository, three
    // for another while the first was still landing. The worker goes on merging
    // the five into a checkout the page had stopped mentioning.
    const view = selectQueueBatches(
      [
        batch("r1", 1_000, ["landed", "landing", "queued", "queued", "queued"]),
        batch("r2", 2_000, ["queued", "queued", "queued"]),
      ],
      3,
    );
    assert.deepEqual(ids(view), ["r1", "r2"]);
  });

  it("keeps every outstanding batch, however many there are", () => {
    // The tail below bounds finished batches only. Bounding these would be the
    // same defect with a larger number in it.
    const many = Array.from({ length: 6 }, (_, i) =>
      batch(`b${i}`, 1_000 + i, ["queued"]),
    );
    assert.equal(selectQueueBatches(many, 1).length, 6);
  });

  it("keeps a batch whole, so its progress still reads", () => {
    // "2 landed · 1 waiting" is a sentence about a batch; trimmed to its
    // unfinished rows, a batch most of the way through looks like one that has
    // not started.
    const view = selectQueueBatches(
      [batch("r1", 1_000, ["landed", "landed", "queued"])],
      3,
    );
    assert.deepEqual(ids(view), ["r1"]);
  });

  it("orders oldest first, breaking a shared instant on the batch id", () => {
    // Two merge blocks of one workflow instance enqueue in the same synchronous
    // pass, so the timestamps really do collide. Nothing makes one of them the
    // operator's order, but a list that reshuffles between two polls of an
    // unchanged queue is nobody's.
    const view = selectQueueBatches(
      [
        batch("bbb", 2_000, ["queued"]),
        batch("aaa", 2_000, ["queued"]),
        batch("ccc", 1_000, ["queued"]),
      ],
      3,
    );
    assert.deepEqual(ids(view), ["ccc", "aaa", "bbb"]);
  });

  it("drops all but the most recent finished batches", () => {
    const view = selectQueueBatches(
      [
        batch("old", 1_000, ["landed"]),
        batch("mid", 2_000, ["failed"]),
        batch("new", 3_000, ["landed", "cancelled"]),
      ],
      2,
    );
    assert.deepEqual(ids(view), ["mid", "new"]);
  });

  it("counts the tail in finished batches, not in batches", () => {
    // An outstanding batch between two finished ones must not consume the tail:
    // what the tail is for is the report of what landed, and this is the case
    // where the operator has just queued more work on top of it.
    const view = selectQueueBatches(
      [
        batch("done1", 1_000, ["landed"]),
        batch("live", 2_000, ["queued"]),
        batch("done2", 3_000, ["failed"]),
      ],
      2,
    );
    assert.deepEqual(ids(view), ["done1", "live", "done2"]);
  });

  it("is total on the edges", () => {
    assert.deepEqual(selectQueueBatches([], 3), []);
    assert.deepEqual(ids(selectQueueBatches([batch("a", 1, ["landed"])], 0)), []);
    // A tail longer than the queue keeps what there is rather than reading past
    // the start of the list.
    assert.deepEqual(ids(selectQueueBatches([batch("a", 1, ["landed"])], 9)), ["a"]);
    // Cancelled and skipped are terminal: the worker owes them nothing.
    assert.deepEqual(
      ids(selectQueueBatches([batch("a", 1, ["cancelled", "skipped"])], 0)),
      [],
    );
  });
});
