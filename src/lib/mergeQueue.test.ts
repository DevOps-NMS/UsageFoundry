import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planItem } from "./mergeQueue";
import type { LandState } from "./land";

/**
 * Covers `planItem`, and only that.
 *
 * It is the merge queue's whole decision: whether to write into a directory a
 * person owns, whether to spend their money reconciling a branch first, and
 * whether the problem it just hit is one every branch behind this one will hit
 * too. Each of those is expensive to get wrong in a different way — a merge
 * nobody sanctioned, a billed resolution for a merge that was going to be
 * refused anyway, or ten identical refusals scrolling past because the queue
 * kept trying against a checkout that was never going to accept any of them.
 */

const base: LandState = {
  runId: "r1",
  runStatus: "completed",
  branch: "uf/repo-1234abcd",
  target: "main",
  targetInferred: false,
  branchExists: true,
  ahead: 2,
  behind: 0,
  merged: false,
  landedUnchanged: false,
  preview: { outcome: "clean" },
  checkout: { path: "/workspace/repo", headBranch: "main", dirty: false, readable: true },
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
