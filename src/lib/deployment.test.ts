import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Covers the agreement between `Dockerfile` and `docker-compose.yml` about who
 * may write the data directory, and who may not.
 *
 * It is not a pure function, and it earns its place on the same grounds the
 * rest of this suite does — a failure that is silent, expensive, and invisible
 * to every other check here. `/data` is a *named volume*, so Docker copies the
 * ownership and mode of the image's directory onto the volume root when it
 * first creates it, and nothing afterwards revisits that decision.
 *
 * **This file used to assert the opposite of what it asserts now, and the
 * inversion is deliberate.** The old rule was that `/data` must be
 * world-writable, because compose ran the *whole* container — server and
 * agents alike — as `${UF_UID:-1000}`, and a fresh volume left at `chown
 * node:node` plus the default 0755 belonged to uid 1000 alone: the app could
 * not create its SQLite file under any other uid, and every data route failed
 * for an operator who had just followed the instruction meant to prevent
 * permission problems. That reasoning was sound and its conclusion is now
 * wrong, because the premise moved. The server runs as root and drops its
 * children to `UF_AGENT_UID`, so it needs no grant to create the database —
 * while a world-writable `/data` hands twenty-five unattended agents the
 * settings every guard reads, the budget and status on every run, and the lock
 * `serverLock.ts` uses to decide whether a second writer exists. An agent that
 * can write that file sets `chatDefaultGuards.permissionMode` to
 * `bypassPermissions` with no HTTP request and no token.
 *
 * Nothing else notices either way: it typechecks, it builds, and both
 * arrangements start a container. Docker is not available in the environment
 * this repo's tests run in, so this pins the two halves against each other
 * rather than the behaviour; `docs/verification.md`'s "Not yet verified by
 * hand" carries the commands that check the behaviour itself.
 */

function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `no package.json above ${__dirname}`);
    dir = parent;
  }
  return dir;
}

const root = repoRoot();
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");

/** The container path compose pins `DATA_DIR` to — where the database lands. */
function composeDataDir(): string {
  const match = /^\s*DATA_DIR:\s*"?([^"\s#]+)"?\s*$/m.exec(compose);
  assert.ok(match, "docker-compose.yml no longer sets DATA_DIR");
  return match[1];
}

/**
 * Every `chmod <mode> <paths…>` in the Dockerfile, as (mode, path) pairs. Modes
 * are read as octal so the "other" bits can be tested rather than matched as a
 * string — 0777, 1777 and 0707 all satisfy this invariant.
 */
function chmodGrants(): { mode: number; target: string }[] {
  const grants: { mode: number; target: string }[] = [];
  for (const match of dockerfile.matchAll(/\bchmod\s+(\d{3,4})\s+([^\n&|;]+)/g)) {
    const mode = Number.parseInt(match[1], 8);
    for (const target of match[2].trim().split(/\s+/)) {
      if (target.startsWith("-")) continue;
      grants.push({ mode, target });
    }
  }
  return grants;
}

describe("the image and compose agree on the data volume", () => {
  it("keeps DATA_DIR away from every uid but the server's", () => {
    const dataDir = composeDataDir();
    const grant = chmodGrants().find((g) => g.target === dataDir);

    assert.ok(
      grant,
      `Dockerfile never chmods ${dataDir}. A fresh named volume takes that ` +
        `directory's mode, and the image's default 0755 leaves it readable by ` +
        `every agent this app spawns.`,
    );
    // Group as well as other. The children are dropped to UF_AGENT_GID, which
    // an operator may well set to a group the server is also in, so a 0770 here
    // would read as tightened and grant exactly what it was tightened against.
    assert.equal(
      grant.mode & 0o077,
      0,
      `${dataDir} is chmod ${grant.mode.toString(8)} in the image. The database, ` +
        `the settings every guard reads and the server lock are in it, and an ` +
        `agent that can write them bypasses every approval gate in this app.`,
    );
  });

  it("reclaims a volume created before that mode existed", () => {
    // Only a *fresh* volume takes the image's mode, so the assertion above
    // covers new installs and nothing else: an existing `usagefoundry-data` is
    // `node:node 0777` from the old arrangement and no image pull changes it.
    // Without the entrypoint every deployment that already has data would
    // upgrade into the same open directory, under a Dockerfile stating
    // otherwise — which is worse than the original defect, because it now reads
    // as fixed.
    const dataDir = composeDataDir();
    const entrypoint = fs.readFileSync(
      path.join(root, "docker-entrypoint.sh"),
      "utf8",
    );
    assert.match(entrypoint, new RegExp(`chown\\s+0:0\\s+${dataDir}\\b`));
    assert.match(entrypoint, new RegExp(`chmod\\s+0700\\s+${dataDir}\\b`));
    assert.match(
      dockerfile,
      /^ENTRYPOINT .*uf-entrypoint/m,
      "the image no longer runs the entrypoint that reclaims the volume.",
    );
  });

  it("mounts DATA_DIR as a named volume, which is what makes the mode matter", () => {
    const dataDir = composeDataDir();
    assert.match(
      compose,
      new RegExp(`^\\s*-\\s*[A-Za-z0-9][\\w.-]*:${dataDir}\\s*$`, "m"),
      `${dataDir} is no longer a named volume in docker-compose.yml`,
    );
  });

  it("still hands the operator's uid to whatever writes their files", () => {
    // The other half of the pair, and it moved: `user:` used to carry
    // `${UF_UID}` for the whole container, and now carries root for the server
    // while `UF_AGENT_UID`/`UF_AGENT_GID` carry the operator's uid to every
    // child. Both halves are asserted because dropping either one is silent in
    // its own direction — no root, and the server cannot switch uids at all
    // (`privsep.ts` throws, which is the loud case); no agent uid, and every
    // child runs as root, which is worse than the shared arrangement this
    // replaced. Parameterised, because an unparameterised agent uid
    // reintroduces the bind-mount ownership failure the README describes.
    assert.match(compose, /^\s*user:\s*"0:0"\s*$/m);
    assert.match(compose, /^\s*UF_AGENT_UID:\s*"\$\{UF_UID:-1000\}"\s*$/m);
    assert.match(compose, /^\s*UF_AGENT_GID:\s*"\$\{UF_GID:-1000\}"\s*$/m);
  });

  it("does not drop the server's own uid in the image", () => {
    // A `USER` line in the runner stage would take the privilege the server
    // needs to drop its children, and compose's `user:` would not put it back.
    // The failure is `privsep.ts` throwing at boot — loud, but a build-time
    // assertion is cheaper than finding out from a container that will not
    // start.
    const runner = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
    assert.doesNotMatch(
      runner,
      /^\s*USER\s+(?!root\b|0\b)/m,
      "the runner stage drops to a non-root USER, so the server cannot spawn " +
        "children as another uid.",
    );
  });
});
