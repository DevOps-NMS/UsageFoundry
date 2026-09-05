import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_BASELINE_SAMPLES,
  baselineFrom,
  outlierVerdict,
  taskSignature,
} from "./costBaseline";

/**
 * The guard that knows what a task normally costs.
 *
 * Every one of these pins a decision that fails silently if it is wrong. A
 * signature that changed when a prompt was reflowed would reset an operator's
 * baseline to nothing at the exact moment they were iterating on wording, and
 * nothing would say so - the guard would simply stop firing. A mean instead of
 * a median would be dragged upward by the runs this exists to catch, so two
 * expensive runs would buy a third. And a verdict that fired on one sample
 * would teach an operator to switch guards off, which costs more than the
 * guard ever saves.
 */
describe("taskSignature decides what counts as the same task", () => {
  it("is stable across whitespace, case and reflowing", () => {
    const a = taskSignature("/w/repo", "Fix the flaky test in auth");
    assert.equal(a, taskSignature("/w/repo", "fix the   flaky test in auth"));
    assert.equal(a, taskSignature("/w/repo", "Fix the flaky\n test in auth\n"));
    assert.equal(a, taskSignature("  /w/repo  ", "Fix the flaky test in auth"));
  });

  it("separates different folders and different tasks", () => {
    const a = taskSignature("/w/repo", "Fix the flaky test");
    assert.notEqual(a, taskSignature("/w/other", "Fix the flaky test"));
    assert.notEqual(a, taskSignature("/w/repo", "Fix the flaky build"));
  });

  it("never carries the prompt itself, which can be a product brief", () => {
    const sig = taskSignature("/w/repo", "SECRET-PRODUCT-NAME rewrite");
    assert.doesNotMatch(sig, /SECRET/i);
    assert.match(sig, /^[0-9a-f]{16}$/);
  });
});

describe("baselineFrom takes the median, and says nothing on thin history", () => {
  it("returns null below the sample floor", () => {
    for (let n = 0; n < MIN_BASELINE_SAMPLES; n += 1) {
      assert.equal(baselineFrom(Array(n).fill(0.3)), null, `n=${n}`);
    }
  });

  it("is the median, not the mean, so a tail cannot raise the bar", () => {
    // The case that decides the module: two runaway runs must not make a third
    // acceptable. The mean here is 1.61; the median is 0.30.
    const base = baselineFrom([0.3, 0.28, 0.32, 5.0, 4.8]);
    assert.equal(base?.samples, 5);
    assert.equal(base?.medianUSD, 0.32);
    const mean = (0.3 + 0.28 + 0.32 + 5.0 + 4.8) / 5;
    assert.ok(base!.medianUSD < mean / 4, "median must not be dragged by the tail");
  });

  it("averages the middle pair on an even count", () => {
    assert.equal(baselineFrom([0.2, 0.3, 0.4, 0.5])?.medianUSD, 0.35);
  });

  it("ignores zero and non-finite costs rather than counting them as cheap runs", () => {
    // A run that recorded 0 is a run nothing was priced for, and letting it
    // into the median would halve the bar on an install with a few of them.
    assert.equal(baselineFrom([0, 0, 0.3, 0.3, 0.3])?.samples, 3);
    assert.equal(baselineFrom([0.3, NaN, 0.3, Infinity, 0.3])?.samples, 3);
  });
});

describe("outlierVerdict fires only on a run that has left its distribution", () => {
  const baseline = { medianUSD: 0.3, samples: 6 };

  it("is silent when no factor is configured", () => {
    assert.equal(outlierVerdict({ spentUSD: 99, baseline, factor: null }).over, false);
    assert.equal(outlierVerdict({ spentUSD: 99, baseline, factor: 0 }).over, false);
    assert.equal(outlierVerdict({ spentUSD: 99, baseline, factor: 1 }).over, false);
  });

  it("is silent when there is no baseline to speak from", () => {
    assert.equal(outlierVerdict({ spentUSD: 99, baseline: null, factor: 3 }).over, false);
  });

  it("allows a run inside the band", () => {
    assert.equal(outlierVerdict({ spentUSD: 0.89, baseline, factor: 3 }).over, false);
  });

  it("stops the run at the multiple, and says what it is unlike", () => {
    const v = outlierVerdict({ spentUSD: 0.95, baseline, factor: 3 });
    assert.equal(v.over, true);
    assert.match(v.reason ?? "", /3\.2x what this task has cost before/);
    assert.match(v.reason ?? "", /median of \$0\.30 over 6 runs/);
    assert.match(v.reason ?? "", /unlike itself rather than for reaching a ceiling/);
  });

  it("fires exactly at the boundary, not one cent after it", () => {
    assert.equal(outlierVerdict({ spentUSD: 0.9, baseline, factor: 3 }).over, true);
    assert.equal(outlierVerdict({ spentUSD: 0.8999, baseline, factor: 3 }).over, false);
  });
});
