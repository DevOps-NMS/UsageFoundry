import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sandboxArrangement,
  sandboxRefusal,
  type ManagedSettings,
} from "./sandbox";

/**
 * Covers the two pure readings in `sandbox.ts`, and only those.
 *
 * Both earn a test on the same grounds and both are asserted in **both**
 * directions, because each has two silent failure modes that point opposite
 * ways. The detector: miss a sandbox refusal and an operator is back to reading
 * a run that spent money and wrote nothing with no way to tell a policy from an
 * unproductive agent — the failure `seedReport` was written to end for seeding —
 * and match too eagerly and every ordinary permission error in every run is
 * filed as a policy decision, which is a signal that fires on everything. The
 * arrangement: a policy that is switched on and names nothing runs every command
 * unwrapped, and an unreadable policy file is not evidence of absence, so both
 * have to be distinguishable from a working sandbox and from a stock install.
 *
 * Most of the literals below were read out of the pinned CLI binary in
 * `proposals/Sandboxing/` and have never been executed. The `bwrap:` ones are
 * the exception and the reason the rest are worth having: they are copied out
 * of this install's own `run_events`, where a sandbox that could not start
 * produced 214 failed tool calls and no `sandbox` row at all. What this pins
 * either way is that the matcher is exactly as wide as the evidence, no wider.
 */

describe("sandboxRefusal", () => {
  it("names the seccomp applier from the CLI's wrap-time message", () => {
    const text =
      "[Sandbox Linux] apply-seccomp binary not available - unix socket " +
      "blocking disabled. Install @anthropic-ai/sandbox-runtime globally for " +
      "full protection.";
    const refusal = sandboxRefusal(text);

    assert.equal(refusal?.kind, "seccomp-unavailable");
    // The more precise of the two true things about a message carrying both
    // the tag and the applier string.
    assert.equal(refusal?.matched, "apply-seccomp binary not available");
    // Verbatim: this recognises text read out of one build and never run, so
    // what it decided has to be checkable against what the tool said.
    assert.equal(refusal?.reason, text);
  });

  it("names it from the dependency check's own wording too", () => {
    const refusal = sandboxRefusal(
      "seccomp not available - unix socket access not restricted",
    );
    assert.equal(refusal?.kind, "seccomp-unavailable");
  });

  it("separates a sandbox that could not start from one that refused", () => {
    assert.equal(
      sandboxRefusal(
        "Sandbox required but unavailable: bwrap exited 1. Set " +
          "sandbox.failIfUnavailable=false to allow unsandboxed execution.",
      )?.kind,
      "sandbox-unavailable",
    );
    assert.equal(
      sandboxRefusal(
        "sandbox.failIfUnavailable is set — refusing to start without a " +
          "working sandbox.",
      )?.kind,
      "sandbox-unavailable",
    );
  });

  it("names a missing dependency as one, not as a refusal", () => {
    assert.equal(
      sandboxRefusal("bubblewrap (bwrap) not installed")?.kind,
      "dependency-missing",
    );
    assert.equal(sandboxRefusal("socat not installed")?.kind, "dependency-missing");
  });

  it("names a bubblewrap that could not start, which is what actually happened", () => {
    // The whole recorded line, copied out of `run_events` rather than trimmed
    // to the needle: this is the text the matcher has to survive, and the
    // `Exit code 1` prefix in front of it is the CLI's, not bwrap's.
    const text =
      "Exit code 1 bwrap: No permissions to create new namespace, likely " +
      "because the kernel does not allow non-privileged user namespaces. See " +
      "<https://deb.li/bubblewrap> or " +
      "<file:///usr/share/doc/bubblewrap/README.Debian.gz>.";
    const refusal = sandboxRefusal(text);

    assert.equal(refusal?.kind, "bwrap-failed");
    assert.equal(refusal?.matched, "bwrap: No permissions to create new namespace");
    assert.equal(refusal?.reason, text);

    // The failure after the seccomp profile is applied: the namespace is
    // created and the procfs mount inside it is refused.
    assert.equal(
      sandboxRefusal("bwrap: Can't mount proc on /newroot/proc: Operation not permitted")
        ?.kind,
      "bwrap-failed",
    );
    assert.equal(
      sandboxRefusal("bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)")
        ?.kind,
      "bwrap-failed",
    );
  });

  it("does not fire on the word bwrap, which this repository also carries", () => {
    // The same argument the bare word "sandbox" is refused by, and it applies
    // harder here: the needles now live in this file, in `sandbox.ts` and in
    // `scripts/sandbox-probe/`, so a run grepping its own source must not
    // report a policy failure.
    assert.equal(sandboxRefusal("src/lib/sandbox.ts:88:  needle: \"bwrap: \""), null);
    assert.equal(sandboxRefusal("bwrap: --version"), null);
    assert.equal(sandboxRefusal("/usr/bin/bwrap: not found"), null);
  });

  it("keeps a tagged message this app has never read", () => {
    // The catch-all, and the direction it fails in: a message under the CLI's
    // own tag that nothing here recognises is reported as a sandbox message
    // rather than dropped, which costs a precise label and not the signal.
    const refusal = sandboxRefusal("[Sandbox Linux] some future sentence");
    assert.equal(refusal?.kind, "sandbox-message");
    assert.equal(refusal?.matched, "[Sandbox Linux]");
  });

  it("leaves an ordinary permission error alone", () => {
    // The expensive direction. A policy denial out of a mount namespace is
    // *also* an EACCES, so matching this would be the only way to catch one —
    // and would relabel every genuinely missing permission in every run as a
    // policy decision. It stays unmatched until there is a measured string to
    // match; see docs/verification.md.
    assert.equal(sandboxRefusal("EACCES: permission denied, open '/etc/hosts'"), null);
    assert.equal(sandboxRefusal("bash: /usr/local/bin/x: Permission denied"), null);
    assert.equal(
      sandboxRefusal(
        "Claude requested permissions to use Bash, but you haven't granted it yet.",
      ),
      null,
    );
  });

  it("does not match the bare word, which this repository is full of", () => {
    // A run working on UsageFoundry greps its own source. Every marker is a
    // sentence for exactly this reason.
    assert.equal(sandboxRefusal("src/lib/sandbox.ts:1:import fs"), null);
    assert.equal(sandboxRefusal("npm ERR! path /app/sandbox"), null);
    assert.equal(sandboxRefusal(""), null);
  });
});

describe("sandboxArrangement", () => {
  const absent: ManagedSettings = { kind: "absent" };
  const present = (json: unknown): ManagedSettings => ({ kind: "present", json });

  it("says none on a stock install", () => {
    assert.equal(sandboxArrangement(absent).state, "none");
    assert.equal(sandboxArrangement(absent).failIfUnavailable, null);
  });

  it("says none for a managed file that configures something else", () => {
    assert.equal(sandboxArrangement(present({ model: "opus" })).state, "none");
    assert.equal(
      sandboxArrangement(present({ sandbox: { enabled: false } })).state,
      "none",
    );
  });

  it("refuses to read a policy that names nothing as a sandbox", () => {
    // The finding this state exists for: with no filesystem, network or
    // credential entry the wrapper hands the command back unwrapped, so
    // `enabled: true` alone is an install that believes it is confined and is
    // not — and `failIfUnavailable` does not catch it, because a sandbox that
    // was never asked for anything is not one that failed.
    const reading = sandboxArrangement(present({ sandbox: { enabled: true } }));
    assert.equal(reading.state, "empty");
    assert.notEqual(reading.state, "on");
    // Absent defaults to on in the binary, so a missing key must not report a
    // refusal to start as a warning.
    assert.equal(reading.failIfUnavailable, true);
  });

  it("says on for a policy that names a path, a domain or a credential", () => {
    for (const sandbox of [
      { enabled: true, filesystem: { allowWrite: ["/workspace"] } },
      { enabled: true, network: { allowedDomains: ["registry.npmjs.org"] } },
      { enabled: true, network: { allowManagedDomainsOnly: true } },
      { enabled: true, credentials: { files: [{ path: "~/.claude" }] } },
    ]) {
      assert.equal(sandboxArrangement(present({ sandbox })).state, "on");
    }
  });

  it("does not take an empty list for an entry", () => {
    assert.equal(
      sandboxArrangement(present({ sandbox: { enabled: true, filesystem: { allowWrite: [] } } }))
        .state,
      "empty",
    );
  });

  it("carries failIfUnavailable rather than folding it into the state", () => {
    // Two different facts: whether a sandbox is configured, and whether an
    // install finds out when it cannot start. A false here is a fleet running
    // unsandboxed on a warning nobody reads.
    const reading = sandboxArrangement(
      present({
        sandbox: {
          enabled: true,
          failIfUnavailable: false,
          filesystem: { denyRead: ["/data"] },
        },
      }),
    );
    assert.equal(reading.state, "on");
    assert.equal(reading.failIfUnavailable, false);
    assert.match(reading.detail, /still runs/);
  });

  it("says unknown for a policy file it could not read", () => {
    // Never "none": a file that exists and cannot be parsed is the one case
    // where this app does not know what confines a run, and a confident zero
    // there is the same failure as a 0% meter over a window with no reading.
    const reading = sandboxArrangement({
      kind: "unreadable",
      problem: "Unexpected end of JSON input",
    });
    assert.equal(reading.state, "unknown");
    assert.equal(reading.failIfUnavailable, null);
    assert.match(reading.detail, /Unexpected end of JSON input/);
  });

  it("reads a sandbox key that is not an object as no policy", () => {
    // Hand-edited files are the case this arrives from, and the direction that
    // is safe is understating a boundary rather than claiming one.
    assert.equal(sandboxArrangement(present({ sandbox: true })).state, "none");
    assert.equal(sandboxArrangement(present("not settings at all")).state, "none");
    assert.equal(sandboxArrangement(present(null)).state, "none");
  });
});
