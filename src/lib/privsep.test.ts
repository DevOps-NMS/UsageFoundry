import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveChildCredentials } from "./privsep";

/**
 * The decision behind every spawn in this app, and both ways of getting it
 * wrong are silent in opposite directions.
 *
 * Credentials this process cannot apply fail every spawn with EPERM — loud, but
 * only at the moment a run starts. No credentials at all is the expensive one:
 * the container looks identical, every page reads the same, and one
 * `tr '\0' '\n' < /proc/<server>/environ` inside any agent hands back
 * UF_AUTH_TOKEN, ANTHROPIC_ADMIN_KEY and UF_GITHUB_TOKEN. Nothing downstream
 * can tell a separated install from a shared one.
 */

describe("resolveChildCredentials", () => {
  it("asks for nothing when no agent uid is configured", () => {
    // `npm run dev`, the test suite, and every deployment predating the split.
    assert.equal(
      resolveChildCredentials({
        serverUid: 501,
        agentUid: undefined,
        agentGid: undefined,
      }),
      null,
    );
    assert.equal(
      resolveChildCredentials({ serverUid: 0, agentUid: "  ", agentGid: "1000" }),
      null,
    );
  });

  it("drops to the configured pair when the server is root", () => {
    assert.deepEqual(
      resolveChildCredentials({ serverUid: 0, agentUid: "1000", agentGid: "1000" }),
      { uid: 1000, gid: 1000 },
    );
    assert.deepEqual(
      resolveChildCredentials({ serverUid: 0, agentUid: "501", agentGid: "20" }),
      { uid: 501, gid: 20 },
    );
  });

  it("refuses to run children as root", () => {
    // Not a boundary: it is the server's own identity, which is the thing the
    // split exists to keep away from an agent.
    assert.throws(
      () => resolveChildCredentials({ serverUid: 0, agentUid: "0", agentGid: "0" }),
      /UF_AGENT_UID is 0/,
    );
  });

  it("refuses a uid with no gid beside it", () => {
    // libuv sets gid then uid and never calls setgroups, so a child handed no
    // gid keeps the server's — group 0 on this image.
    assert.throws(
      () =>
        resolveChildCredentials({ serverUid: 0, agentUid: "1000", agentGid: "" }),
      /UF_AGENT_GID/,
    );
  });

  it("refuses a name where an id belongs", () => {
    // `UF_AGENT_UID=node` is the plausible typo, and silently ignoring it is a
    // container that reports privilege separation and has none.
    assert.throws(
      () =>
        resolveChildCredentials({
          serverUid: 0,
          agentUid: "node",
          agentGid: "1000",
        }),
      /numeric id/,
    );
    assert.throws(
      () =>
        resolveChildCredentials({
          serverUid: 0,
          agentUid: "1000",
          agentGid: "-1",
        }),
      /numeric id/,
    );
  });

  it("refuses to start unseparated when separation was asked for", () => {
    // The load-bearing case. An operator who pins `user:` back to their own uid
    // in a compose override, while compose still names an agent uid, gets a
    // server that cannot switch uids — and every boundary in the app quietly
    // stops existing. Throwing puts that at the boot rather than nowhere.
    assert.throws(
      () =>
        resolveChildCredentials({
          serverUid: 1000,
          agentUid: "1000",
          agentGid: "1000",
        }),
      /cannot switch to another/,
    );
  });
});
