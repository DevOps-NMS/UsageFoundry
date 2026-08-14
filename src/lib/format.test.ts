import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  fmtCycleInFlight,
  fmtCycles,
  guardBadge,
  pollFailureMessage,
} from "./format";
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

/**
 * The one thing in `format.ts` whose failure is silence.
 *
 * Every other helper here is wrong loudly — a mis-rounded percentage is on the
 * screen to be read. This one is rendered as `{message && <Notice…>}`, so a
 * return of `""` puts nothing on the page at all, which is precisely the defect
 * it was written for: the chat page discarded every failed poll and left a
 * thread frozen on "Thinking…", indistinguishable from a turn still working.
 * A blank message reinstates that, throws nothing, and typechecks.
 */

test("a rejected fetch says the server was not reached, never a status", () => {
  const msg = pollFailureMessage(null, "Failed to fetch");
  assert.match(msg, /could not be reached/);
  assert.match(msg, /Failed to fetch/, "the cause is the operator's only clue");
  assert.doesNotMatch(msg, /answered/, "there was no answer to report");
});

test("a 401 names the one failure the operator can clear", () => {
  const msg = pollFailureMessage(401, "Unauthorized");
  assert.match(msg, /[Ss]ign in again/);
});

test("the server's own error text is carried through", () => {
  assert.match(pollFailureMessage(500, "no such chat"), /no such chat/);
  assert.match(pollFailureMessage(500, "no such chat"), /500/);
});

test("a status with no error text still names the status", () => {
  assert.match(pollFailureMessage(404), /404/);
});

test("every failure produces a sentence, whatever the body carried", () => {
  // A blank message renders as no Notice at all, which is the swallowed poll
  // this function replaced. `{"error":""}` and a whitespace-only body are both
  // reachable from a server that means to say something and fails to.
  for (const detail of [undefined, null, "", "   "]) {
    for (const status of [null, 401, 404, 500, 502]) {
      const msg = pollFailureMessage(status, detail);
      assert.ok(msg.trim().length > 0, `blank message for ${status}/${detail}`);
      assert.doesNotMatch(msg, /\(\s*\)|—\s*\./, "no empty slot left where the cause would go");
    }
  }
});

test("the message says the page is no longer current", () => {
  // Without this the notice reads as one bad request rather than as a page
  // that has stopped tracking the thread, which is what the operator acts on.
  assert.match(pollFailureMessage(500, "boom"), /out of date/);
  assert.match(pollFailureMessage(401, "Unauthorized"), /out of date/);
});

/**
 * Which guard set a block runs under, and the state that is neither present
 * nor absent.
 *
 * The failure this pins is silent and typechecks: with two states, the list a
 * page has not read yet is indistinguishable from a list with nothing in it, so
 * every templated block on the workflow page wore a red "template deleted" —
 * permanently when the request failed, and for a frame on every cold load. That
 * badge is the one thing on the page that says the workflow will not run, and
 * it was untrue; Run worked. The deleted case has to stay loud for the opposite
 * reason, because `planNode` really does refuse such a node by name.
 */

const TEMPLATES = [
  { id: "t1", name: "Careful guards" },
  { id: "t2", name: "Cheap guards" },
];

test("an unread list is not an empty one", () => {
  assert.deepEqual(guardBadge("t1", null), {
    text: "guards not read",
    tone: "neutral",
  });
  // The same id against a list that really has been read and does not hold it.
  assert.deepEqual(guardBadge("t1", []), {
    text: "template deleted",
    tone: "danger",
  });
});

test("a template that is there is named, and says nothing alarming", () => {
  assert.deepEqual(guardBadge("t2", TEMPLATES), {
    text: "Cheap guards",
    tone: "neutral",
  });
});

test("a block naming no template takes the untemplated set, read or not", () => {
  // `null` here is the operator's own choice — Settings guards — and must not
  // be confused with the unread list, which is the other null in this call.
  for (const templates of [null, [], TEMPLATES]) {
    assert.deepEqual(guardBadge(null, templates), {
      text: "Settings guards",
      tone: "neutral",
    });
  }
});

test("only a template that is genuinely absent is called deleted", () => {
  const deleted = guardBadge("gone", TEMPLATES);
  assert.equal(deleted.tone, "danger");
  // Nothing else may reach the danger tone: it is what an operator reads as
  // "this graph will be refused at Run".
  for (const badge of [
    guardBadge("gone", null),
    guardBadge(null, null),
    guardBadge("t1", TEMPLATES),
  ]) {
    assert.equal(badge.tone, "neutral");
  }
});
