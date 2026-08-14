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

/** The runner stage alone — the two earlier stages never reach the image. */
function runnerStage(): string {
  const start = dockerfile.indexOf("AS runner");
  assert.notEqual(start, -1, "the Dockerfile no longer has a stage named `runner`");
  return dockerfile.slice(start);
}

/**
 * The packages the runner stage's `apt-get install` names, as whole tokens.
 * Tokenised rather than matched as a substring, because `better-sqlite3` — the
 * npm package, named in the comments there — contains `sqlite3` behind a word
 * boundary and would satisfy any looser test.
 */
function runtimePackages(): string[] {
  const stage = runnerStage();
  const start = stage.indexOf("apt-get install");
  assert.notEqual(start, -1, "the runner stage no longer installs anything");
  const end = stage.indexOf("rm -rf /var/lib/apt/lists", start);
  assert.notEqual(end, -1, "the runner stage's apt-get install has no recognisable end");
  return stage
    .slice(start + "apt-get install".length, end)
    .split(/[\s\\&]+/)
    .filter((token) => token && !token.startsWith("-"));
}

/** The container path a compose volume line binds something to. */
function mountTarget(pattern: RegExp): string | null {
  const match = pattern.exec(compose);
  return match ? match[1] : null;
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
 * The second agreement, and the one whose failure is unrecoverable rather than
 * merely loud: the database can be copied out of a live container, and the copy
 * lands somewhere `docker compose down -v` does not reach.
 *
 * Every part of it is a file this repository ships and nothing else checks. The
 * scripts are useless if the image does not carry them — `docker compose exec
 * usagefoundry node scripts/backup-db.mjs` is `Cannot find module`, discovered
 * by an operator who believes they have had nightly backups for a month. A
 * backup written into the data volume is destroyed by the one command it exists
 * to survive. And `sqlite3` is what the manual procedures in the docs are
 * written in; without it in the image, `docker exec … sqlite3` is `command not
 * found` and the only documented way out of a wedged row fails at the first
 * word. Docker is not available where these tests run, so this pins the files
 * against each other; docs/verification.md carries the commands that check the
 * behaviour itself.
 */
describe("the image can back its own database up", () => {
  it("carries the backup and restore scripts", () => {
    const stage = runnerStage();
    for (const script of ["backup-db.mjs", "restore-db.mjs"]) {
      assert.ok(
        fs.existsSync(path.join(root, "scripts", script)),
        `scripts/${script} is gone, and the image and the docs both name it`,
      );
      assert.ok(
        stage.includes(`scripts/${script}`),
        `the runner stage no longer copies scripts/${script} into the image`,
      );
    }
  });

  it("carries sqlite3, which the documented manual procedures need", () => {
    assert.ok(
      runtimePackages().includes("sqlite3"),
      "the runtime image no longer installs sqlite3, so every `docker exec … " +
        "sqlite3 …` in the docs is `command not found`",
    );
  });

  it("writes backups outside the volume that `down -v` destroys", () => {
    const target = mountTarget(/^\s*-\s*\$\{UF_BACKUP_DIR:-[^}]+\}:(\S+)\s*$/m);
    assert.ok(target, "docker-compose.yml no longer bind-mounts a backup directory");
    assert.notEqual(
      target,
      composeDataDir(),
      "backups are being written into the data volume, which is the thing they " +
        "exist to survive",
    );
    assert.ok(
      !target.startsWith(`${composeDataDir()}/`),
      `${target} is inside ${composeDataDir()}, so a backup dies with the volume`,
    );
    assert.ok(
      fs.readFileSync(path.join(root, "scripts", "backup-db.mjs"), "utf8").includes(target),
      `the backup script does not know about ${target}, so its default lands ` +
        "somewhere compose does not mount",
    );
  });
});
