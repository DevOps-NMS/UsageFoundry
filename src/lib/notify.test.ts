import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { notifiableEvent, signBody, type NotifyState } from "./notify";
import type { PersistedRunEvent, RunStatus } from "./orchestrator";

/**
 * Covers the two halves of the outbound webhook that decide anything, and
 * nothing else in that file.
 *
 * Both are pure and both fail silently, which is the bar this suite is built to.
 * The filter is the one `proposals/UnattendedOperation/12-validation.md` names as
 * this feature's own failure mode: too wide and the channel is noise, which is
 * how an operator stops reading it; too narrow and it is a channel that looks
 * configured and never fires, which is indistinguishable from a fleet with
 * nothing wrong — and neither direction throws, fails to typecheck or shows on
 * any page. There is no place in the UI where a missed notification is visible.
 *
 * The signature fails the other way and once for everybody: a receiver verifying
 * the HMAC rejects every POST, and the symptom is a channel that delivers 400s
 * for ever with the app reporting the delivery attempted. The vectors are
 * therefore **frozen hex**, computed once and pasted, rather than recomputed here
 * from `node:crypto` — a test that recomputes the answer with the same call the
 * code makes passes whatever that call does, and what has to stay fixed is the
 * bytes on the wire.
 */

/** A fresh pair of latches, so no case can depend on another's leftovers. */
function freshState(): NotifyState {
  return { guardStopped: new Set<string>(), rateLimited: new Set<string>() };
}

function event(
  kind: PersistedRunEvent["kind"],
  payload: Record<string, unknown>,
  runId = "r-1",
): PersistedRunEvent {
  return { id: 1, runId, ts: 1_700_000_000_000, kind, payload };
}

function status(s: RunStatus, runId = "r-1"): PersistedRunEvent {
  return event("status", { status: s }, runId);
}

describe("which run event is worth telling somebody about", () => {
  it("notifies on the three endings that always need a person", () => {
    for (const [ending, name] of [
      ["needs-review", "run.needs_review"],
      ["blocked", "run.blocked"],
      ["failed", "run.failed"],
    ] as Array<[RunStatus, string]>) {
      assert.deepEqual(notifiableEvent(status(ending), freshState()), {
        event: name,
        status: ending,
      });
    }
  });

  it("says nothing about a run that finished", () => {
    // The whole reason this filter has its own constant rather than reusing
    // `TERMINAL_STATUSES`, which carries `completed` and has five readers.
    assert.equal(notifiableEvent(status("completed"), freshState()), null);
  });

  it("announces a run that finished when UF_NOTIFY_ON_SUCCESS asks it to", () => {
    assert.deepEqual(notifiableEvent(status("completed"), freshState(), true), {
      event: "run.completed",
      status: "completed",
    });
  });

  it("widens nothing except `completed` when that opt-in is on", () => {
    // The direction the opt-in could fail in. Sitting the branch below the
    // always-notify set makes subtracting from it impossible; what is left to
    // get wrong is adding to it, and a channel that POSTs on the statuses a run
    // passes through is a POST per cycle — the noise failure that costs an
    // operator the three endings this exists for.
    for (const passing of ["waiting", "queued", "running", "paused"] as RunStatus[]) {
      assert.equal(notifiableEvent(status(passing), freshState(), true), null);
    }
    // Still an operator's own cancel, which no setting about *success* may reach.
    assert.equal(notifiableEvent(status("stopped"), freshState(), true), null);
  });

  it("says nothing about the states a run passes through", () => {
    for (const s of ["waiting", "queued", "running", "paused"] as RunStatus[]) {
      assert.equal(notifiableEvent(status(s), freshState()), null);
    }
  });

  it("ignores every kind of event that is not an ending or a refusal", () => {
    // The kinds that arrive per tool call and per assistant turn. One of these
    // reaching the filter is a POST per tool call at twenty-five runs.
    for (const kind of [
      "log",
      "assistant",
      "subagent",
      "tool",
      "tool_error",
      "sandbox",
      "iteration",
      "result",
    ] as Array<PersistedRunEvent["kind"]>) {
      assert.equal(
        notifiableEvent(event(kind, { message: "x", status: "failed" }), freshState()),
        null,
        `${kind} is not an ending`,
      );
    }
  });

  it("treats an operator's own cancel as nothing to report", () => {
    // A cancel emits no `budget` event at all, which is the whole mechanism:
    // `stop_reason` is user-facing prose and must never become a parse.
    assert.equal(notifiableEvent(status("stopped"), freshState()), null);
  });

  it("reports a stop a guard caused", () => {
    const s = freshState();
    assert.equal(
      notifiableEvent(
        event("budget", {
          allowed: false,
          code: "max_cost_usd",
          disposition: "stop",
          enforceable: true,
        }),
        s,
      ),
      null,
      "the verdict itself is not the notification — the status it causes is",
    );
    assert.deepEqual(notifiableEvent(status("stopped"), s), {
      event: "run.stopped",
      status: "stopped",
    });
  });

  it("does not report a stop on a verdict the run carries on past", () => {
    // `no_ceiling` — an unreadable window — is held rather than acted on, so the
    // run keeps going and no `stopped` follows. Reading an absent `enforceable`
    // as false is the trap in the other direction: two of the three stop emits
    // omit the field entirely.
    const held = freshState();
    notifiableEvent(
      event("budget", {
        allowed: false,
        code: "no_ceiling",
        disposition: "stop",
        enforceable: false,
      }),
      held,
    );
    assert.equal(notifiableEvent(status("stopped"), held), null);

    const absent = freshState();
    notifiableEvent(
      event("budget", { allowed: false, code: "instance_max_cost_usd", disposition: "stop" }),
      absent,
    );
    assert.deepEqual(notifiableEvent(status("stopped"), absent), {
      event: "run.stopped",
      status: "stopped",
    });
  });

  it("does not report a stop on a verdict that parks the run", () => {
    const s = freshState();
    notifiableEvent(
      event("budget", {
        allowed: false,
        code: "session_fraction",
        disposition: "pause",
        enforceable: true,
      }),
      s,
    );
    assert.equal(notifiableEvent(status("stopped"), s), null);
  });

  it("does not report a stop on the guard verdict of a different run", () => {
    const s = freshState();
    notifiableEvent(
      event("budget", { allowed: false, disposition: "stop" }, "other-run"),
      s,
    );
    assert.equal(notifiableEvent(status("stopped", "r-1"), s), null);
  });

  it("consumes the guard mark, so a later cancel of the same run is silent", () => {
    // A stopped run can be reopened and cancelled by hand, and the second stop
    // is an operator's. A mark that survived would file it as the guard's.
    const s = freshState();
    notifiableEvent(event("budget", { allowed: false, disposition: "stop" }), s);
    assert.ok(notifiableEvent(status("stopped"), s));
    assert.equal(notifiableEvent(status("stopped"), s), null);
  });

  it("reports the first rung of an in-place retry and no later one", () => {
    const s = freshState();
    assert.deepEqual(
      notifiableEvent(event("error", { message: "429", retrying: true }), s),
      { event: "run.rate_limited", status: "running" },
      "the ladder changes no status, so `running` is what the row really says",
    );
    for (const rung of [2, 3, 4]) {
      assert.equal(
        notifiableEvent(event("error", { message: "429", retrying: true }), s),
        null,
        `rung ${rung} is the wait the first one announced`,
      );
    }
  });

  it("distinguishes a refusal that will not be retried from one with no answer", () => {
    // `retrying: false` is a refusal that parks or fails, and the ending it
    // reaches notifies on its own. An *absent* `retrying` is not a refusal at
    // all — it is a spawn failure — and reading it as false would be the same
    // collapse `logLifecycle`'s three readings exist to prevent.
    assert.equal(
      notifiableEvent(event("error", { message: "wall", retrying: false }), freshState()),
      null,
    );
    assert.equal(
      notifiableEvent(event("error", { message: "spawn failed" }), freshState()),
      null,
    );
  });

  it("lets a reopened run report a retry again once the first one settled", () => {
    const s = freshState();
    assert.ok(notifiableEvent(event("error", { retrying: true }), s));
    assert.ok(notifiableEvent(status("failed"), s));
    assert.ok(
      notifiableEvent(event("error", { retrying: true }), s),
      "the latch is per attempt at the run, not for the life of the process",
    );
  });

  it("stays silent through a park's rungs and reports the ending they reach", () => {
    // Up to three `paused` rungs and then `failed`: the brief's "notify on the
    // last rung or on the failed, not on each" needs no state at all, because
    // `paused` is not one of the three endings.
    const s = freshState();
    for (let rung = 0; rung < 3; rung += 1) {
      assert.equal(notifiableEvent(event("error", { retrying: false }), s), null);
      assert.equal(notifiableEvent(status("paused"), s), null);
    }
    assert.deepEqual(notifiableEvent(status("failed"), s), {
      event: "run.failed",
      status: "failed",
    });
  });

  it("bounds the runs it remembers", () => {
    // A run that never settles in this process — a container restarted
    // mid-cycle, a guard verdict whose `stopped` never arrived — leaves an entry
    // nothing removes. The cap is what keeps that from being a leak on a server
    // that runs for weeks, and an eviction loop is easy to write so it never
    // terminates.
    const s = freshState();
    for (let n = 0; n < 1_200; n += 1) {
      notifiableEvent(
        event("budget", { allowed: false, disposition: "stop" }, `run-${n}`),
        s,
      );
    }
    assert.equal(s.guardStopped.size, 1_000);
    assert.ok(!s.guardStopped.has("run-0"), "the oldest is the one dropped");
    assert.ok(s.guardStopped.has("run-1199"));
  });
});

describe("the signature a receiver verifies", () => {
  const secret = "hunter2";

  it("signs the exact body bytes, in GitHub's header shape", () => {
    const body =
      '{"install":"laptop","event":"run.needs_review","run_id":"r-1",' +
      '"status":"needs-review","at":1700000000000,' +
      '"url":"https://uf.example.com/runs/r-1"}';
    assert.equal(
      signBody(body, secret),
      "sha256=a807f55eb3a319b66a3ed057831bf5ef4a51c89b6dce6998f653caf4fadb6f71",
    );
  });

  it("signs the UTF-8 bytes of a body that is not ASCII", () => {
    // `UF_INSTALL_LABEL` is text an operator typed, so this is reachable. The
    // frozen answer is what makes a change of encoding a failure here: signing
    // the same string as latin1 yields f7a24d11…, which every receiver rejects
    // while this app records the delivery as attempted.
    const body = '{"install":"büro","event":"run.failed","run_id":"r-2","status":"failed","at":1,"url":""}';
    assert.equal(
      signBody(body, secret),
      "sha256=9414a11d31c7cb9ca1f5d630e96825f40cac91520a7d89d2628f2c8addda368b",
    );
  });

  it("depends on the secret and on every byte of the body", () => {
    const body = '{"run_id":"r-1"}';
    assert.notEqual(signBody(body, secret), signBody(body, "hunter3"));
    assert.notEqual(signBody(body, secret), signBody('{"run_id":"r-2"}', secret));
  });
});
