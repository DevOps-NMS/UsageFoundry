import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  STALE_MS,
  lockVerdict,
  parseLock,
  stillBeating,
  type ServerLock,
} from "./serverLock";

/**
 * Covers the lock's decision, and only that.
 *
 * It earns a test on the same grounds `planItem` and `landRefusal` do: it is
 * pure, and both ways of getting it wrong are silent and expensive in opposite
 * directions. Claim while another server is alive and the four boot reconcilers
 * mark every in-flight run failed while its agent keeps working and keeps
 * billing — which is the incident this exists to prevent, and which typechecks,
 * throws nothing, and reads afterwards exactly like a server that restarted.
 * Refuse while nobody is there and the reconcilers never run at all, so a run
 * killed by a crash holds its folder for ever and every later run queues behind
 * an empty directory.
 */

const NOW = 1_700_000_000_000;

const held: ServerLock = {
  pid: 7,
  ownerId: "owner-a",
  startedAt: NOW - 60_000,
  heartbeatAt: NOW - 500,
};

describe("parseLock", () => {
  it("reads a well-formed record", () => {
    assert.deepEqual(parseLock(JSON.stringify(held)), held);
  });

  it("treats an unreadable lock as no lock", () => {
    // Each of these is reachable: a truncated write, a full disk, a file from a
    // build that recorded different fields. None is evidence of a live owner,
    // and reading one as an owner would strand every run behind it.
    for (const raw of ['{"pid":7', "", "null", "[]", '{"pid":"7","ownerId":"a"}']) {
      assert.equal(parseLock(raw), null, `expected null for ${JSON.stringify(raw)}`);
    }
  });

  it("rejects an empty ownerId, which would make every owner look identical", () => {
    assert.equal(parseLock(JSON.stringify({ ...held, ownerId: "" })), null);
  });
});

describe("lockVerdict", () => {
  const self = { pid: 7804, now: NOW };

  it("claims a directory nobody has locked", () => {
    assert.equal(lockVerdict(null, self, false), "claim");
  });

  it("claims when the last heartbeat is older than the stale window", () => {
    const old = { ...held, heartbeatAt: NOW - STALE_MS - 1 };
    assert.equal(lockVerdict(old, self, true), "claim");
  });

  it("holds off for a live owner on another pid", () => {
    // The incident: the server is pid 7 and still working, an agent's `npm run
    // dev` comes up as pid 7804 and inherits DATA_DIR.
    assert.equal(lockVerdict(held, self, true), "held");
  });

  it("claims its own pid back after a restart", () => {
    // A container restart lands the server on the same pid in a fresh
    // namespace, so the lock its predecessor left is fresh and names *us*. A
    // live stranger cannot be holding our pid — pids are unique among live
    // processes — so this is our own lock and reconciling is the whole point
    // of the boot.
    assert.equal(lockVerdict(held, { pid: 7, now: NOW }, true), "claim");
  });

  it("watches a fresh lock whose pid has gone", () => {
    assert.equal(lockVerdict(held, self, false), "observe");
  });
});

describe("stillBeating", () => {
  it("sees a heartbeat advance", () => {
    assert.equal(stillBeating(held, { ...held, heartbeatAt: held.heartbeatAt + 1 }), true);
  });

  it("sees the lock change hands even without a later timestamp", () => {
    assert.equal(stillBeating(held, { ...held, ownerId: "owner-b" }), true);
  });

  it("reports silence when nothing moved", () => {
    assert.equal(stillBeating(held, { ...held }), false);
  });

  it("treats a released lock as silence", () => {
    // Absence is the clean-shutdown signal, not a reason to wait longer.
    assert.equal(stillBeating(held, null), false);
  });
});
