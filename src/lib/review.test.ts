import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseReviewOutput } from "./review";

/**
 * Covers reading the CLI's own result object, and only that.
 *
 * The failure mode is the same one `spent_usd` guards against elsewhere: a
 * review that was billed and recorded at $0. Cost is read from
 * `total_cost_usd` — the CLI's own figure — and never re-derived from tokens,
 * so a shape this parser does not recognise is spend that silently vanishes.
 */

const ok = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "## What changed\nIt renamed a file.",
  total_cost_usd: 0.0421,
  usage: {
    input_tokens: 120,
    output_tokens: 80,
    cache_read_input_tokens: 9_000,
    cache_creation_input_tokens: 10,
  },
});

describe("parseReviewOutput", () => {
  it("takes the cost from the CLI and sums every token bucket", () => {
    const r = parseReviewOutput(ok, "", 0);
    assert.equal(r.status, "completed");
    assert.equal(r.costUSD, 0.0421);
    // Cache reads are the bulk of any Claude Code invocation; dropping them
    // would understate the review by two orders of magnitude.
    assert.equal(r.tokens, 9_210);
  });

  it("still records what a failed review cost", () => {
    // It was billed whether or not it produced anything readable.
    const failed = JSON.stringify({
      subtype: "error_during_execution",
      result: "the model refused",
      total_cost_usd: 0.01,
      usage: { input_tokens: 5 },
    });
    const r = parseReviewOutput(failed, "", 1);
    assert.equal(r.status, "failed");
    assert.equal(r.costUSD, 0.01);
    assert.match(r.error ?? "", /refused/);
  });

  it("falls back to stderr when there is no JSON at all", () => {
    const r = parseReviewOutput("", "command not found: claude\n", 127);
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /command not found/);
  });

  it("does not report an empty result as a review", () => {
    const empty = JSON.stringify({ subtype: "success", result: "", total_cost_usd: 0.5 });
    const r = parseReviewOutput(empty, "", 0);
    assert.equal(r.status, "failed");
    assert.equal(r.costUSD, 0.5);
  });
});
