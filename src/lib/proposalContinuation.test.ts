import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  rivalContinuation,
  type ContinuationCandidate,
} from "./proposalContinuation";

/**
 * `propose_run`'s rival-continuation refusal, which is the only thing standing
 * between the model and a proposal that cannot be approved. Both failure modes
 * are silent: missed, the operator meets a graph problem at the click in run
 * ids and loses one of the two cards to a terminal `failed`; over-eager, the
 * model is told a chain it could have had is impossible and nothing records
 * that it was told wrongly.
 */

const proposal = (
  over: Partial<ContinuationCandidate> = {},
): ContinuationCandidate => ({
  specId: null,
  title: "Untitled",
  status: "pending",
  dependsOn: [],
  ...over,
});

const carries = (label: string) => [
  { specId: label, edge: "on-success" as const, continueBranch: true },
];

describe("rivalContinuation", () => {
  it("finds the pending proposal already carrying the label's branch", () => {
    const polish = proposal({
      specId: "polish",
      title: "Polish it",
      dependsOn: carries("groundwork"),
    });
    const rival = rivalContinuation("groundwork", [
      proposal({ specId: "groundwork", title: "Lay the groundwork" }),
      polish,
    ]);
    assert.equal(rival, polish);
  });

  it("finds a rival that carries no label of its own", () => {
    // The likeliest shape, not an edge case: a model gives ids to the
    // proposals something points *at* and leaves the leaves unnamed.
    const rival = rivalContinuation("groundwork", [
      proposal({ title: "Polish it", dependsOn: carries("groundwork") }),
    ]);
    assert.equal(rival?.title, "Polish it");
    assert.equal(rival?.specId, null);
  });

  it("is nothing when the batch continues no branch at all", () => {
    assert.equal(
      rivalContinuation("groundwork", [
        proposal({ specId: "groundwork" }),
        proposal({ specId: "polish" }),
      ]),
      null,
    );
  });

  it("does not count a sibling merely waiting on the same label", () => {
    // The ordinary fan-out: both start after `groundwork`, neither takes its
    // branch. Refusing this would refuse the common case.
    assert.equal(
      rivalContinuation("groundwork", [
        proposal({
          specId: "polish",
          dependsOn: [
            { specId: "groundwork", edge: "on-success", continueBranch: false },
          ],
        }),
      ]),
      null,
    );
  });

  it("does not count a sibling continuing a different label", () => {
    assert.equal(
      rivalContinuation("groundwork", [
        proposal({ specId: "polish", dependsOn: carries("scaffold") }),
      ]),
      null,
    );
  });

  it("does not count a rejected or failed proposal", () => {
    // Neither ever became a run, so neither holds a branch — the reading the
    // two checks beside this one already take of a decided proposal.
    for (const status of ["rejected", "failed"] as const) {
      assert.equal(
        rivalContinuation("groundwork", [
          proposal({ specId: "polish", status, dependsOn: carries("groundwork") }),
        ]),
        null,
        status,
      );
    }
  });

  it("does not count an approved proposal, leaving that to admitDependencies", () => {
    // Its run may have been refused at the door with no work cycle behind it,
    // which `admitDependencies` reads as leaving the branch free. Refusing
    // here would refuse a chain the approval would have allowed.
    assert.equal(
      rivalContinuation("groundwork", [
        proposal({
          specId: "polish",
          status: "approved",
          dependsOn: carries("groundwork"),
        }),
      ]),
      null,
    );
  });

  it("names the first rival when a stale batch holds two", () => {
    // Not reachable through `propose_run`, which refuses the second — but the
    // refusal has to name one proposal rather than depend on iteration order.
    const first = proposal({ specId: "polish", dependsOn: carries("groundwork") });
    const second = proposal({ specId: "document", dependsOn: carries("groundwork") });
    assert.equal(rivalContinuation("groundwork", [first, second]), first);
  });
});
