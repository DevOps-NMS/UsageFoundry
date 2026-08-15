import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { UsageSnapshot } from "./windows";

/**
 * Covers how many times one aggregation runs for N concurrent callers, and only
 * that.
 *
 * `scanUsage` coalesces the *file reads* and nothing coalesced what comes after
 * them, which is the expensive half on a large history: a filter and a full
 * allocation per caller, then `buildSessionBlocks` plus two more filters plus
 * five `groupBy` rollups over every entry the process has ever parsed. The
 * pre-cycle guard is the path every run takes, so N runs reaching a cycle
 * boundary together did N full-history aggregations back to back on the one
 * event loop — `liveGuardTick` states that exact property one function over and
 * works around it for its own callers.
 *
 * What is pinned is a *count*, deliberately, and never a wall clock: the whole
 * defect is invisible from any value the app produces — every one of those N
 * aggregations returns the same answer — so a timing assertion is the only other
 * way to see it and a timing assertion in CI is a flake.
 *
 * Its own file for one reason: the question is what a *cold* process does with
 * N simultaneous callers, and any other test in the same process that reached
 * `currentSnapshot()` first would have already answered it. It also replaces
 * `buildSnapshot` module-wide, which every other case beside it would then be
 * counted through.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-snap-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to the ambient one: `planUsage` looks for
// an OAuth token in this directory, and a unit test must not send a request on
// the operator's own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");

// `require`, not `import`: imports are hoisted above the environment above, and
// `config.ts` fixes `DATA_DIR` and `CLAUDE_HOME` at load.
const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to run against the real database",
);

const windows = require("./windows") as Record<string, unknown>;
const realBuildSnapshot = windows.buildSnapshot as (
  ...args: unknown[]
) => UsageSnapshot;

const { currentSnapshot } =
  require("./orchestrator") as typeof import("./orchestrator");

after(() => {
  windows.buildSnapshot = realBuildSnapshot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Count the aggregations, without replacing what they compute.
 *
 * `orchestrator.ts` calls `buildSnapshot` through the module object under the
 * test build's CommonJS emit, so wrapping it here is what every caller goes
 * through. A wrapper rather than a stub: the snapshot has to be the real one, or
 * the identity assertions below would be about a fixture rather than about
 * whether two callers were handed one reading.
 */
let aggregations = 0;
windows.buildSnapshot = (...args: unknown[]) => {
  aggregations += 1;
  return realBuildSnapshot(...args);
};

describe("currentSnapshot", () => {
  it("aggregates once for callers that arrive together", async () => {
    const before = aggregations;
    const all = await Promise.all(
      Array.from({ length: 25 }, () => currentSnapshot()),
    );

    assert.equal(
      aggregations - before,
      1,
      "25 concurrent pre-cycle guards must share one full-history aggregation",
    );
    // Same object, not merely equal: that is what says they shared the work
    // rather than each doing it and arriving at the same numbers.
    for (const snapshot of all) assert.equal(snapshot, all[0]);
  });

  it("does not go on serving a reading it already gave out", async () => {
    // The other half, and the one a cache with a window would put at risk: a
    // caller that arrives after the aggregation has settled reads the
    // transcripts again. The guard is at most one refresh stale, which is what
    // `scanUsage` already accepts — never a fixed age.
    const first = await currentSnapshot();
    const before = aggregations;
    const second = await currentSnapshot();

    assert.equal(aggregations - before, 1);
    assert.notEqual(first, second);
  });

  it("does not latch a failure", async () => {
    // A rejected promise left in the slot would refuse every budget evaluation
    // for the life of the process — every run's pre-cycle guard, every live
    // tick, every press of Run on a workflow — off one transient failure. The
    // `finally` is what clears it, and nothing else in the app would ever say
    // so.
    windows.buildSnapshot = () => {
      aggregations += 1;
      throw new Error("aggregation failed");
    };
    await assert.rejects(currentSnapshot(), /aggregation failed/);

    windows.buildSnapshot = (...args: unknown[]) => {
      aggregations += 1;
      return realBuildSnapshot(...args);
    };
    const recovered = await currentSnapshot();
    assert.ok(recovered.session, "the next caller gets a real reading");
  });
});
