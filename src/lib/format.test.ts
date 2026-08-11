import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fmtCycleInFlight, fmtCycles } from "./format";
import type { RunDTO } from "./apiTypes";

/**
 * What a running run says about the work cycle it has open.
 *
 * It earns a test on the same grounds as the rest of this repo's short list:
 * the failure is silent, typechecks, and is expensive to the reader. `iterations`
 * counts cycles that *finished*, so a run tens of minutes into cycle 1 reads
 * `0/N` — bit-for-bit what a run that was marked running and never started
 * reads, which is the exact question an operator opens the page to answer. The
 * two ways of getting this wrong are saying nothing (the bug) and trusting the
 * column on a row that is no longer running (a finished run that claims to be
 * working, which is the same lie pointing the other way).
 */

const RUNNING: Pick<RunDTO, "status" | "max_iterations" | "active_iteration"> = {
  status: "running",
  max_iterations: 2,
  active_iteration: 1,
};

test("a run in its first cycle names that cycle rather than reading zero", () => {
  const said = fmtCycleInFlight(RUNNING);
  assert.equal(said, "cycle 1 of 2 in flight");
  // The count beside it is still the completed one, and the two must not be
  // readable as the same quantity — "in flight" is what keeps them apart.
  assert.equal(fmtCycles(0, 2), "0/2");
  assert.match(said!, /in flight/);
});

test("no cycle in flight means nothing is claimed", () => {
  // Between cycles: the pre-cycle transcript scan takes seconds and no child
  // exists, so naming the cycle that just returned would be a live spinner over
  // finished work.
  assert.equal(fmtCycleInFlight({ ...RUNNING, active_iteration: null }), null);
  // Rows written before the column existed, and a run that has not spawned yet.
  assert.equal(
    fmtCycleInFlight({ ...RUNNING, active_iteration: undefined }),
    null,
  );
});

test("a stale value on a run that is no longer running is not trusted", () => {
  // Nothing clears the row when the container dies mid-cycle: `reconcileOnBoot`
  // marks the run failed and the number stays behind it.
  for (const status of ["failed", "stopped", "completed", "paused"] as const) {
    assert.equal(
      fmtCycleInFlight({ ...RUNNING, status, active_iteration: 3 }),
      null,
      `${status} must not report a cycle in flight`,
    );
  }
});

test("an uncapped run names the cycle without inventing a limit", () => {
  // 0 is the stored sentinel for "no cap"; "cycle 3 of 0" would read as spent.
  assert.equal(
    fmtCycleInFlight({ status: "running", max_iterations: 0, active_iteration: 3 }),
    "cycle 3 in flight",
  );
});
