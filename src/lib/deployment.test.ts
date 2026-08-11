import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Covers one agreement between `Dockerfile` and `docker-compose.yml`: that the
 * directory compose points `DATA_DIR` at is writable by whatever uid compose
 * runs the container as.
 *
 * It is not a pure function, and it earns its place on the same grounds the
 * rest of this suite does — a failure that is silent, expensive, and invisible
 * to every other check here. `/data` is a *named volume*, so Docker copies the
 * ownership and mode of the image's directory onto the volume root when it
 * first creates it. Left at `chown node:node` and the default 0755, that hands
 * the database to uid 1000 alone, while compose's `user: "${UF_UID:-1000}…"`
 * runs the container as the uid Linux operators are told to set to their own.
 * The app then cannot create its SQLite file and every data route fails —
 * after the operator followed the instruction meant to prevent exactly that.
 *
 * Nothing else notices: it typechecks, it builds, it passes on macOS (where
 * Docker Desktop's remapping makes 1000 right whatever the host uid is), and it
 * is one Dockerfile edit away from coming back. Docker is not available in the
 * environment this repo's tests run in, so this pins the two halves against
 * each other rather than the behaviour; README's "Not yet verified by hand"
 * carries the command that checks the behaviour itself.
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
  it("gives DATA_DIR a mode any uid can write", () => {
    const dataDir = composeDataDir();
    const grant = chmodGrants().find((g) => g.target === dataDir);

    assert.ok(
      grant,
      `Dockerfile never chmods ${dataDir}. A fresh named volume takes that ` +
        `directory's mode, so without this the container cannot create its ` +
        `database under any UF_UID other than 1000.`,
    );
    // 0o002 — the other-write bit. Ownership is uid 1000's either way, so this
    // is the only bit that makes an arbitrary uid able to create the file.
    assert.equal(
      grant.mode & 0o002,
      0o002,
      `${dataDir} is chmod ${grant.mode.toString(8)} in the image; a uid other ` +
        `than 1000 cannot create a file in it.`,
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

  it("still runs the container as a configurable uid", () => {
    // The other half of the pair. If `user:` ever stops being parameterised the
    // test above is guarding nothing — but removing it reintroduces the
    // bind-mount ownership failure the README describes, so it must not happen
    // quietly either.
    assert.match(compose, /^\s*user:\s*"\$\{UF_UID:-1000\}:\$\{UF_GID:-1000\}"\s*$/m);
  });
});
