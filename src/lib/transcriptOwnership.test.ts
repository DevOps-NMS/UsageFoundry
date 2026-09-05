import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { restoreTranscriptOwnership } from "./contextPruning";

/**
 * Who owns a transcript after the pruner has been over it.
 *
 * The pruner runs as the server, which is root, so every winnow verb that
 * writes leaves the transcript `root:root 0600`. The next work cycle runs as
 * the agent uid, cannot read it, and `claude --resume` answers `No conversation
 * found with session ID: …` — which the orchestrator surfaces as
 * `error_during_execution` at 0 ms and turns into a failed run.
 *
 * MEASURED before this existed: the same task with `contextPruning` on failed
 * at cycle 2 for $0.14; with it off it completed for $0.41; and `chown` alone on
 * the failing session turned the refusal into a successful resume. The failure
 * is the expensive silent kind — the failing cycle bills $0 and the cycle
 * before it reports success, so nothing in the app says what happened.
 *
 * These pin the three outcomes rather than describing them, because the whole
 * point is that the wrong one is invisible: a chown that quietly did nothing
 * looks exactly like a chown that worked.
 */
describe("restoreTranscriptOwnership hands the file back to the agent", () => {
  it("chowns to the child's uid and gid when the install is separated", () => {
    const calls: Array<[string, number, number]> = [];
    const result = restoreTranscriptOwnership("/data/t.jsonl", {
      credentials: () => ({ uid: 1000, gid: 1000 }),
      chown: (target, uid, gid) => calls.push([target, uid, gid]),
    });
    assert.deepEqual(result, { restored: true, reason: null });
    assert.deepEqual(calls, [["/data/t.jsonl", 1000, 1000]]);
  });

  it("does nothing, and says so, when there is no separation to hand over", () => {
    // A UF_UID of 0 is a real supported arrangement — the boot log calls the
    // boundary absent — and chowning would be a no-op at best. The reason is
    // returned rather than left null so a caller can tell this apart from a
    // chown that failed, which is the distinction the silent version lost.
    let called = false;
    const result = restoreTranscriptOwnership("/data/t.jsonl", {
      credentials: () => ({}),
      chown: () => {
        called = true;
      },
    });
    assert.equal(called, false);
    assert.equal(result.restored, false);
    assert.equal(result.reason, "not privilege separated");
  });

  it("never throws when the chown fails, because it runs on the prune path", () => {
    // `chownForChild` throws by design; this must not. It is called from
    // `spawnPrune` and `forkTranscript`, and `observePlan` states the rule the
    // whole path is built to: an observation that could end a cycle is worth
    // less than not taking it. Throwing here would trade a silent bug for a
    // loud one on a path that must never end a run.
    const result = restoreTranscriptOwnership("/data/gone.jsonl", {
      credentials: () => ({ uid: 1000, gid: 1000 }),
      chown: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    assert.equal(result.restored, false);
    assert.match(result.reason ?? "", /ENOENT/);
  });
});
