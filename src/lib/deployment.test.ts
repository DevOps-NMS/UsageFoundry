import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Covers the deployment agreements nothing else here can see: that the
 * directory compose points `DATA_DIR` at is writable by whatever uid compose
 * runs the container as, and that the memory ceiling compose gives the
 * container is a ceiling the server's own stated heap fits inside.
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

/**
 * A compose value with its `${VAR:-default}` interpolations resolved to the
 * default — i.e. what an operator who sets nothing in `.env` actually gets,
 * which is the only figure this file can reason about.
 */
function shippedDefault(key: string): string {
  const match = new RegExp(`^\\s*${key}:\\s*"?([^"#\\n]+?)"?\\s*$`, "m").exec(compose);
  assert.ok(match, `docker-compose.yml no longer sets ${key}`);
  return match[1].replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/g, "$1");
}

/** Docker's own byte-size spelling: a number and an optional binary suffix. */
function bytes(spec: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i.exec(spec.trim());
  assert.ok(match, `cannot read "${spec}" as a byte size`);
  const scale: Record<string, number> = { k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 };
  return Number(match[1]) * (match[2] ? scale[match[2].toLowerCase()] : 1);
}

/** MiB from compose's `NODE_OPTIONS`, which is where the server's heap is set. */
function heapCeilingBytes(): number {
  const options = shippedDefault("NODE_OPTIONS");
  const match = /--max-old-space-size=(\d+)/.exec(options);
  assert.ok(
    match,
    `NODE_OPTIONS is "${options}" and no longer states a heap ceiling. Left to ` +
      `V8, the server's ceiling is derived from the *host's* RAM, so the ` +
      `memory limit below stops being sized against anything.`,
  );
  return Number(match[1]) * 2 ** 20;
}

describe("the container's memory ceiling and the server's heap agree", () => {
  it("leaves the container room for the children it exists to supervise", () => {
    const limit = bytes(shippedDefault("mem_limit"));
    const heap = heapCeilingBytes();

    // Half is not a tuning choice, it is the weakest form of the actual
    // requirement: this container exists to carry a fleet of `claude` children
    // and their builds, and a server permitted to claim most of the cgroup on
    // its own has no room for them. Past that point V8 never throws its own
    // heap error — the cgroup kills the container first, `restart:
    // unless-stopped` brings it back, and `reconcileOnBoot` fails every run in
    // flight, so a slow leak becomes a restart loop that re-bills each fleet's
    // first cycle. Nothing else here notices: it typechecks, it builds, and it
    // is one `.env` figure away either way.
    assert.ok(
      heap * 2 <= limit,
      `the server may claim ${(heap / 2 ** 30).toFixed(1)} GiB of a ` +
        `${(limit / 2 ** 30).toFixed(1)} GiB container. Raise mem_limit or ` +
        `lower --max-old-space-size; README's "Sizing the container" has the ` +
        `arithmetic both numbers came from.`,
    );
  });

  it("states a ceiling that swap cannot quietly double", () => {
    // Docker defaults the swap limit to twice `mem_limit` when it is not set,
    // so an unset `memswap_limit` means the number above is a RAM ceiling with
    // an equal amount of swap behind it. Equal to `mem_limit` is how Docker
    // spells "no swap", and it is what makes the sizing arithmetic describe the
    // container rather than half of it.
    assert.equal(
      shippedDefault("memswap_limit"),
      shippedDefault("mem_limit"),
      "memswap_limit must equal mem_limit, or the container can swap as much " +
        "again as the memory limit it was given.",
    );
  });
});
