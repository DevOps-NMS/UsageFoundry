import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CACHE_READ_MULTIPLIER,
  UNKNOWN_MODEL_PRICE,
  ZERO_TOKENS,
  cacheReadMultiplierOf,
  costOf,
  resolvePrice,
} from "./pricing";

/**
 * The cache read rate, which stopped being a constant when the 5.1 pair
 * shipped at 0.025× against everything else's 0.10×.
 *
 * Every failure below is silent in the way this suite exists for: the model
 * resolves, the price resolves, the two visible columns — $10 input, $50 output
 * — are identical between Claude Fable 5 and Claude Fable 5.1, and the only
 * symptom of getting it wrong is a dollar figure that is 4× too large on the
 * one line item a Claude Code workload is almost entirely made of. Nothing
 * throws, nothing fails to typecheck, and a budget guard refuses a run against
 * a ceiling it never reached.
 *
 * Rates are `docs/verification.md`'s, read from the published pricing table
 * rather than derived: Fable 5.1 and Mythos 5.1 charge $0.25/MTok for a cache
 * hit, every other model 0.10× its own input.
 */
describe("the cache read rate is a property of the model", () => {
  const MTOK = { ...ZERO_TOKENS, cacheRead: 1_000_000 };

  it("resolves claude-fable-5-1 to its own entry, not the claude-fable-5 prefix", () => {
    // The trap this exists for. `PREFIXES` is sorted longest-first, so the 5.1
    // entry only wins because it is longer — a table re-ordered by hand, or a
    // `sort` that lost its comparator, would silently fall through to the 5
    // entry, whose input and output are the same $10/$50. Both figures a person
    // can see on the page would still be right.
    const fable51 = resolvePrice("claude-fable-5-1");
    assert.ok(fable51);
    assert.equal(cacheReadMultiplierOf(fable51), 0.025);

    const fable5 = resolvePrice("claude-fable-5");
    assert.ok(fable5);
    assert.equal(cacheReadMultiplierOf(fable5), CACHE_READ_MULTIPLIER);

    // Same $10/$50 on both, which is exactly why the multiplier needs pinning.
    assert.deepEqual(
      { input: fable51.input, output: fable51.output },
      { input: fable5.input, output: fable5.output },
    );
  });

  it("charges a million cache-read tokens $0.25 on 5.1 and $1.00 on 5", () => {
    assert.equal(costOf(MTOK, resolvePrice("claude-fable-5-1")), 0.25);
    assert.equal(costOf(MTOK, resolvePrice("claude-mythos-5-1")), 0.25);
    assert.equal(costOf(MTOK, resolvePrice("claude-fable-5")), 1);
    assert.equal(costOf(MTOK, resolvePrice("claude-mythos-5")), 1);
  });

  it("keeps the discount through a dated snapshot and a provider prefix", () => {
    // `canonicalModelId` strips decoration and the prefix match then has to land
    // on the longer key again. A Bedrock-served 5.1 priced at the 5 rate is the
    // same 4× error arriving through a different door.
    for (const id of [
      "claude-fable-5-1-20260901",
      "us.anthropic.claude-fable-5-1",
      "claude-fable-5-1@20260901",
    ]) {
      const price = resolvePrice(id);
      assert.ok(price, `${id} did not resolve`);
      assert.equal(cacheReadMultiplierOf(price), 0.025, id);
    }
  });

  it("does not let the unknown-model rate inherit the discount", () => {
    // `UNKNOWN_MODEL_PRICE` shares the 5.1 pair's $10/$50 and must not share
    // its cache read rate: the whole point of that entry is to be the dearest
    // plausible shape, so a model nothing can price cannot slip under a cost
    // ceiling. 0.10× on a $10 input is dearer than 0.025× on one.
    assert.equal(cacheReadMultiplierOf(UNKNOWN_MODEL_PRICE), CACHE_READ_MULTIPLIER);
    assert.equal(costOf(MTOK, UNKNOWN_MODEL_PRICE), 1);
  });
});
