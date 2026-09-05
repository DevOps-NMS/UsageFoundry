import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { landVerdict, parseVerifyCommand } from "./landGate";

/**
 * The gate in front of Land, and the two ways it could fail quietly.
 *
 * Both halves decide whether somebody's work merges, and both fail silently if
 * they are wrong: a parser that dropped a metacharacter would run a different
 * command from the one the operator read back in Settings, and a verdict that
 * treated "could not run" as "passed" would hand back an open door to an
 * operator who had asked for a gate. Neither throws, neither fails to
 * typecheck, and the button looks the same.
 *
 * So these assert the enumeration in BOTH directions — the shapes that must be
 * refused and the shapes that must be allowed — because a refusal that admits
 * everything measures nothing and one that refuses everything is not a feature.
 */
describe("parseVerifyCommand takes argv and refuses a shell line", () => {
  it("splits an ordinary command into argv", () => {
    assert.deepEqual(parseVerifyCommand("npm test"), { ok: true, argv: ["npm", "test"] });
    assert.deepEqual(parseVerifyCommand("  npx  tsc --noEmit "), {
      ok: true,
      argv: ["npx", "tsc", "--noEmit"],
    });
  });

  it("treats an empty command as unconfigured rather than as a pass", () => {
    for (const raw of ["", "   ", "\t"]) {
      const parsed = parseVerifyCommand(raw);
      assert.equal(parsed.ok, false);
      assert.match(parsed.ok === false ? parsed.reason : "", /no verify command/);
    }
  });

  it("refuses every shell metacharacter rather than escaping it", () => {
    // One per character class that changes what runs. `a && b` is the honest
    // case — an operator wanting it is asking for a shell — and the backtick
    // one is the reason refusing beats escaping: a repository whose name
    // carries it would otherwise be executed.
    for (const raw of [
      "npm test && npm run build",
      "npm test; rm -rf /",
      "echo `whoami`",
      "npm test | tee out",
      "npm test > out",
      "sh -c $(cat cmd)",
      "npm test\nrm -rf /",
    ]) {
      const parsed = parseVerifyCommand(raw);
      assert.equal(parsed.ok, false, `should have refused: ${raw}`);
      assert.match(parsed.ok === false ? parsed.reason : "", /argv, never a shell/);
    }
  });
});

describe("landVerdict never turns 'could not check' into 'passed'", () => {
  const parsed = parseVerifyCommand("npm test");

  it("is a pass, and did not run, when nothing is configured", () => {
    const v = landVerdict({
      configured: false,
      parse: parseVerifyCommand(""),
      exitCode: null,
      timedOut: false,
      tail: "",
    });
    assert.deepEqual(v, { ran: false, passed: true, reason: "" });
  });

  it("passes on exit 0", () => {
    const v = landVerdict({ configured: true, parse: parsed, exitCode: 0, timedOut: false, tail: "" });
    assert.equal(v.passed, true);
    assert.equal(v.ran, true);
  });

  it("refuses on a non-zero exit and carries the output", () => {
    const v = landVerdict({
      configured: true,
      parse: parsed,
      exitCode: 1,
      timedOut: false,
      tail: "2 tests failed",
    });
    assert.equal(v.passed, false);
    assert.match(v.reason, /exited 1/);
    assert.match(v.reason, /2 tests failed/);
  });

  it("refuses a timeout rather than guessing", () => {
    const v = landVerdict({ configured: true, parse: parsed, exitCode: null, timedOut: true, tail: "" });
    assert.equal(v.passed, false);
    assert.match(v.reason, /did not finish in time/);
  });

  it("refuses a command it could not parse — the door does not open on a typo", () => {
    // The case that decides whether this module is worth having. An operator
    // configured a gate; their string was malformed; the answer is not to land.
    const v = landVerdict({
      configured: true,
      parse: parseVerifyCommand("npm test && npm run build"),
      exitCode: null,
      timedOut: false,
      tail: "",
    });
    assert.equal(v.passed, false);
    assert.match(v.reason, /not runnable/);
  });
});
