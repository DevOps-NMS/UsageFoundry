import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  costOf,
  costSharesOf,
  costSplitOf,
  resolvePrice,
  type TokenCounts,
} from "./pricing";

/**
 * Where the bill went, and the one property that keeps it honest.
 *
 * The split exists because a loop can be 92% cache reads by volume and still
 * spend half its money on writes - the multipliers are 0.1x and 2.0x, a
 * twentyfold ratio no token chart shows. MEASURED on one install across 90
 * deduplicated frames: writes were 48.1% of the bill from 7% of the tokens.
 *
 * The property that matters more than any single number is that the split and
 * the total are the same arithmetic. A readout that could drift from `costOf`
 * would be two statements of one policy, and the operator would be reading a
 * figure the guard does not believe.
 */
const tokens = (over: Partial<TokenCounts> = {}): TokenCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...over,
});

describe("costSplitOf agrees with costOf, always", () => {
  const price = resolvePrice("claude-opus-4-5");

  it("sums to exactly what costOf charges", () => {
    for (const t of [
      tokens({ input: 1000, output: 500 }),
      tokens({ cacheRead: 2_000_000, cacheWrite1h: 150_000, output: 25_000 }),
      tokens({ cacheWrite5m: 1234, cacheWrite1h: 5678, input: 9, output: 10 }),
      tokens(),
    ]) {
      assert.equal(costSplitOf(t, price).total, costOf(t, price));
    }
  });

  it("charges nothing, and splits nothing, without a price", () => {
    const split = costSplitOf(tokens({ output: 10_000 }), null);
    assert.deepEqual(split, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.equal(costSharesOf(split), null);
  });

  it("puts both write classes on one line, because an operator cannot choose", () => {
    const only5m = costSplitOf(tokens({ cacheWrite5m: 100_000 }), price);
    const only1h = costSplitOf(tokens({ cacheWrite1h: 100_000 }), price);
    const both = costSplitOf(tokens({ cacheWrite5m: 100_000, cacheWrite1h: 100_000 }), price);
    assert.equal(both.cacheWrite, only5m.cacheWrite + only1h.cacheWrite);
    // and the 1-hour class is the dearer of the two, which is why it dominates
    assert.ok(only1h.cacheWrite > only5m.cacheWrite);
  });

  it("shows the shape the measurement found: few write tokens, half the bill", () => {
    // The real reading, rounded: 2,001,198 read / 152,439 written / 25,533 out.
    const split = costSplitOf(
      tokens({ cacheRead: 2_001_198, cacheWrite1h: 152_439, output: 25_533 }),
      price,
    );
    const shares = costSharesOf(split)!;
    const writeTokenShare = 152_439 / (2_001_198 + 152_439);
    assert.ok(writeTokenShare < 0.08, "writes are a small share of tokens");
    assert.ok(shares.cacheWrite > 0.4, "and a large share of the bill");
    assert.ok(shares.cacheWrite > shares.cacheRead, "larger than the reads it dwarfs in volume");
  });
});
