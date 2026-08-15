import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gitArgs, gitEnv } from "./git";

/**
 * Covers what every git call this app makes carries, and only that.
 *
 * Both halves fail silently. A missing `-c` is a repository-controlled command
 * executed by this server's own git child — a `post-checkout` fired by the
 * `worktree add` of a run that did not write it, or a `post-merge` fired inside
 * the operator's live checkout — with no permission mode, no tool lists and no
 * line in `run_events` to say it happened. And a variable that survives the
 * scrub is that command handed this app's configuration: `DATA_DIR` is the
 * address of the database `serverLock.ts` exists to protect, and a run that
 * closes out every other run's rows looks exactly like a container restart.
 *
 * Nothing here can observe the agent's own git, which keeps its hooks
 * deliberately — that spawn is `buildArgs`, and it passes no config at all.
 */

describe("gitArgs", () => {
  it("disables hooks and fsmonitor before whatever it was asked to run", () => {
    // Order matters only in that config precedes the subcommand: `git checkout
    // -c x=y` is a checkout of a branch called `-c`, not a configured checkout.
    assert.deepEqual(gitArgs(["worktree", "add", "/tmp/x", "-b", "b"]), [
      "-c",
      "core.fsmonitor=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "safe.directory=*",
      "worktree",
      "add",
      "/tmp/x",
      "-b",
      "b",
    ]);
  });

  it("carries the same config for a call that takes no arguments of its own", () => {
    assert.deepEqual(gitArgs([]), [
      "-c",
      "core.fsmonitor=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "safe.directory=*",
    ]);
  });
});

describe("gitEnv", () => {
  it("withholds the same set the agent's and the reviewer's children withhold", () => {
    // Set on this process rather than passed in, because reading `process.env`
    // is the whole of what this function does: a version that scrubbed a copy
    // nobody handed it would pass any test that supplied one.
    const planted = {
      UF_AUTH_TOKEN: "shared-secret",
      UF_GITHUB_TOKEN: "ghp_x",
      // The per-repository map is withheld by the same namespace rule, which is
      // why a second credential shape needed no second exclusion.
      UF_GITHUB_TOKENS: "acme/web=ghp_y",
      ANTHROPIC_ADMIN_KEY: "sk-admin",
      ANTHROPIC_API_KEY: "sk-x",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_RESOURCE_ATTRIBUTES: "a=b",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      DATA_DIR: "/data",
    };
    for (const [k, v] of Object.entries(planted)) process.env[k] = v;
    try {
      const env = gitEnv();
      for (const k of Object.keys(planted)) {
        assert.equal(env[k], undefined, `${k} reached a git child`);
      }
    } finally {
      for (const k of Object.keys(planted)) delete process.env[k];
    }
  });

  it("passes through what git needs and disables the credential prompt", () => {
    // A git child with no stdin that is asked for a password hangs until the
    // 20s timeout, which reads as a slow repository rather than a missing
    // credential. PATH and HOME are how git finds itself and its own config.
    process.env.PATH ??= "/usr/bin";
    process.env.HOME ??= "/home/node";
    const env = gitEnv();
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
  });
});
