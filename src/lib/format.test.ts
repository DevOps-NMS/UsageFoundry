import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pollFailureMessage } from "./format";

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
