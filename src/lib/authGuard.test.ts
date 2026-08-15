import { strict as assert } from "node:assert";
import { test } from "node:test";
import { authBootSignal } from "./authGuard";

/**
 * The boot signal fires for an empty token and does not fire for a set one.
 *
 * The failure this pins is the one the whole check exists for and it is silent:
 * an install with no token serves every route to anyone who can reach the port,
 * and before this there was no line, no banner and no refusal anywhere that
 * said so. A regression here typechecks, passes every other suite, and is
 * visible only as a service that is quietly open.
 */

test("a configured token says nothing at all", () => {
  const signal = authBootSignal({ token: "s3cret", allowNoAuth: "" });
  assert.equal(signal.kind, "enabled");
  // The whole point of the enabled arm: no message, so nothing can be printed
  // on a correctly configured install and trained out of the operator's eye.
  assert.equal("message" in signal, false);
});

test("an acknowledgement does not un-say the warning", () => {
  const signal = authBootSignal({ token: "s3cret", allowNoAuth: "1" });
  assert.equal(signal.kind, "enabled");
});

test("an empty token with no acknowledgement refuses to start", () => {
  const signal = authBootSignal({ token: "", allowNoAuth: "" });
  assert.equal(signal.kind, "refused");
  assert.match(signal.message, /REFUSING TO START/);
  // Both ways out have to be in the message: this stops the server, so the line
  // that stops it is the only place the operator will look for what to do.
  assert.match(signal.message, /UF_AUTH_TOKEN/);
  assert.match(signal.message, /UF_ALLOW_NO_AUTH=1/);
});

test("an acknowledged empty token starts, and is announced", () => {
  const signal = authBootSignal({ token: "", allowNoAuth: "1" });
  assert.equal(signal.kind, "unauthenticated");
  assert.match(signal.message, /AUTHENTICATION IS OFF/);
});

test("anything but the exact acknowledgement fails towards refusing", () => {
  // A value that makes the app stop protecting itself is read as a string
  // equality, never as truthiness — `continueAfterDone`'s rule. Every one of
  // these is something an operator plausibly types, and every one of them
  // reaching the "serve openly" arm would be the defect this file is about.
  for (const allowNoAuth of ["true", "yes", "0", "false", " 1", "1 ", "on"]) {
    assert.equal(
      authBootSignal({ token: "", allowNoAuth }).kind,
      "refused",
      `UF_ALLOW_NO_AUTH=${JSON.stringify(allowNoAuth)} must not disable auth`,
    );
  }
});
