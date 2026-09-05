import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { queueOrder } from "./orchestrator";

/**
 * The order the queue is considered in.
 *
 * Its failure mode is the quiet one: a comparator that ignored `priority`
 * behaves identically to a working one on every install where nobody has set
 * one, which is every install today. So the first case here is the one that
 * would catch that, and the last is the one that would catch the opposite
 * mistake — a priority sort that quietly stopped being stable and started
 * reordering runs an operator never touched.
 */
const at = (created_at: number, priority = 0, id = String(created_at)) =>
  ({ id, created_at, priority });

describe("queueOrder puts priority first and keeps age as the tie-break", () => {
  it("promotes a higher priority ahead of an older run", () => {
    const order = queueOrder([at(100, 0, "old"), at(200, 5, "urgent")]);
    assert.deepEqual(order.map((r) => r.id), ["urgent", "old"]);
  });

  it("leaves an untouched queue in exactly arrival order", () => {
    // The property that makes this safe to ship: with no priority set anywhere,
    // the queue behaves precisely as it did before the column existed.
    const arrival = [at(1), at(2), at(3), at(4)];
    assert.deepEqual(
      queueOrder(arrival).map((r) => r.id),
      arrival.map((r) => r.id),
    );
  });

  it("orders equal priorities by age, oldest first", () => {
    const order = queueOrder([at(300, 7, "c"), at(100, 7, "a"), at(200, 7, "b")]);
    assert.deepEqual(order.map((r) => r.id), ["a", "b", "c"]);
  });

  it("treats a missing or null priority as 0 rather than as last", () => {
    // Rows written before the column existed read back as 0 through the
    // DEFAULT, but a null arriving from anywhere else must not sink a run to
    // the bottom of a queue silently.
    const order = queueOrder([
      { id: "null", created_at: 100, priority: null },
      { id: "zero", created_at: 200, priority: 0 },
      { id: "neg", created_at: 50, priority: -1 },
    ]);
    assert.deepEqual(order.map((r) => r.id), ["null", "zero", "neg"]);
  });

  it("does not mutate the array it was given", () => {
    const runs = [at(200, 1, "b"), at(100, 9, "a")];
    const before = runs.map((r) => r.id);
    queueOrder(runs);
    assert.deepEqual(runs.map((r) => r.id), before);
  });
});
