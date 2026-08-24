import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  BLANK_MEANINGFUL_ENV_VARS,
  MOUNTED_WORKSPACE_SLOTS,
  unmountedWorkspaceRefusal,
} from "./config";

/**
 * Covers the agreement between `Dockerfile` and `docker-compose.yml` about who
 * may write the data directory, and who may not — the first of the deployment
 * agreements pinned here, and the only one this comment is about. The backup
 * path, the healthcheck, the mounted workspace slots and the container's memory
 * ceiling against the server's own stated heap each carry their reasoning below.
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

/** The service's `environment:` block, key by key. */
function environmentKeys(): Map<string, string> {
  const start = /^ {4}environment:$/m.exec(compose);
  assert.ok(start, "docker-compose.yml no longer has an environment: block");
  const rest = compose.slice(start.index + start[0].length);
  const end = /^ {4}\S/m.exec(rest);
  const block = end ? rest.slice(0, end.index) : rest;

  const entries = new Map<string, string>();
  for (const [, key, value] of block.matchAll(/^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/gm)) {
    entries.set(key, value.trim().replace(/^"(.*)"$/, "$1"));
  }
  assert.ok(entries.size > 0, "no environment keys were found to check");
  return entries;
}

/**
 * What an operator who sets nothing in `.env` actually gets, which is the only
 * install this file can reason about — and the one every deployment starts as.
 *
 * `${X:-default}` yields its default, `${X:+word}` yields nothing (that form
 * exists precisely to say "only when X is set"), a bare `${X}` yields nothing,
 * and `${X:?message}` aborts `docker compose up` rather than substituting, so
 * it can never reach the app blank.
 */
function resolvedWithEmptyEnv(value: string): string {
  return value
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}]*\}/g, "<aborts>")
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/g, "$1")
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:\+[^}]*\}/g, "")
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "");
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

  it("creates the group the chat runs in, at the gid compose defaults to", () => {
    // Two halves that are only a boundary together, and both fail silently on
    // their own. A compose default naming a gid the image never creates still
    // works — the kernel checks numbers, not /etc/group — so the drift is
    // invisible until someone reads `ls -l` inside the container and sees a
    // number where a group belongs. The reverse, an image group nothing selects,
    // is a boundary that simply does not exist while the boot log reports the
    // uid split as on.
    const created = /groupadd\s+-g\s+(\d+)\s+(\S+)/.exec(dockerfile);
    assert.ok(created, "the image no longer creates a group for the chat child");
    const declared = /^\s*UF_CHAT_GID:\s*"\$\{UF_CHAT_GID:-(\d+)\}"\s*$/m.exec(
      compose,
    );
    assert.ok(declared, "docker-compose.yml no longer names UF_CHAT_GID");
    assert.equal(
      declared[1],
      created[1],
      `compose defaults UF_CHAT_GID to ${declared[1]} and the image creates ` +
        `${created[2]} as ${created[1]}.`,
    );

    // And it must not be the group the agents run in, which is the one value
    // that turns the whole arrangement into a no-op: the capability file would
    // be handed to the group it is kept from. `privsep.ts` refuses that pair at
    // boot; this refuses shipping it as the default, which is the case no
    // operator would ever see a refusal for.
    const agentGid = /^\s*UF_AGENT_GID:\s*"\$\{UF_GID:-(\d+)\}"\s*$/m.exec(compose);
    assert.ok(agentGid, "docker-compose.yml no longer names UF_AGENT_GID");
    assert.notEqual(declared[1], agentGid[1]);
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

/**
 * The healthcheck and the route it probes, pinned against each other.
 *
 * Same grounds as the volume pair above: Docker is not available here, so what
 * can be checked is that the two halves still name one another. Both ways of
 * breaking this are silent — a `HEALTHCHECK` pointed at a path that no longer
 * exists reports every container unhealthy for ever, and one pointed at `/`
 * reports a server that cannot open its database as healthy, because with
 * `UF_AUTH_TOKEN` set that path is a 307 to /login and `curl -f` accepts a
 * redirect.
 */
describe("the image declares a healthcheck against a route that exists", () => {
  const directive = /^HEALTHCHECK\s+([\s\S]*?)$/m.exec(dockerfile);

  it("declares one at all", () => {
    assert.ok(
      directive,
      "Dockerfile has no HEALTHCHECK. `restart: unless-stopped` sees process " +
        "exits only, so without this a wedged server runs indefinitely.",
    );
  });

  it("probes the health route rather than a page", () => {
    const block = dockerfile.slice(dockerfile.indexOf("HEALTHCHECK"));
    assert.match(
      block,
      /\/api\/health/,
      "the healthcheck must probe /api/health — any page path answers 307 to " +
        "/login under UF_AUTH_TOKEN, which `curl -f` treats as success",
    );
    assert.ok(
      fs.existsSync(path.join(root, "src/app/api/health/route.ts")),
      "the route the HEALTHCHECK probes does not exist",
    );
  });

  it("sets all four timings, and stays tolerant of a slow answer", () => {
    const line = dockerfile.slice(dockerfile.indexOf("HEALTHCHECK"));
    for (const flag of ["--interval=", "--timeout=", "--retries=", "--start-period="]) {
      assert.ok(line.includes(flag), `HEALTHCHECK is missing ${flag}`);
    }
    // A restart marks every in-flight run failed and leaves its current cycle's
    // spend unreconciled, so a single slow probe must never be enough.
    const retries = /--retries=(\d+)/.exec(line);
    assert.ok(retries && Number(retries[1]) >= 3, "retries must stay conservative");
  });
});

/**
 * The second agreement between the two files, and it points the other way: the
 * *code* carries a number that only `docker-compose.yml` can make true.
 *
 * `MOUNTED_WORKSPACE_SLOTS` is what `unmountedWorkspaceRefusal` refuses past, so
 * a fifth volume line added without bumping it would refuse a slot the
 * deployment really does mount — the same silence inverted, and louder. Both
 * halves are one edit away from each other and neither typechecks against the
 * other, which is what this is for.
 */
describe("the mounted workspace slots the code assumes", () => {
  /** Slot numbers compose bind-mounts: `/workspace` is 1, `/workspace2` is 2. */
  function mountedSlots(): number[] {
    const slots: number[] = [];
    for (const match of compose.matchAll(/^\s*-\s+\S.*:\/workspace(\d*)\s*$/gm)) {
      slots.push(match[1] ? Number(match[1]) : 1);
    }
    return slots.sort((a, b) => a - b);
  }

  it("matches the number of volume lines in compose", () => {
    assert.deepEqual(
      mountedSlots(),
      Array.from({ length: MOUNTED_WORKSPACE_SLOTS }, (_, i) => i + 1),
      `docker-compose.yml mounts a different set of workspace slots than ` +
        `MOUNTED_WORKSPACE_SLOTS (${MOUNTED_WORKSPACE_SLOTS}) claims. A slot that is ` +
        `mounted and refused, or configured and never mounted, is the failure ` +
        `unmountedWorkspaceRefusal exists to end.`,
    );
  });

  it("forwards the slots beyond it so a boot can refuse them", () => {
    const line = /^\s*UF_UNMOUNTED_WORKSPACES:\s*"(.*)"\s*$/m.exec(compose);
    assert.ok(line, "docker-compose.yml no longer forwards UF_UNMOUNTED_WORKSPACES");

    const forwarded = [...line[1].matchAll(/UF_WORKSPACE_(\d+)_NAME:\+/g)].map((m) =>
      Number(m[1]),
    );
    assert.ok(forwarded.length > 0, "no slot is detected, so a fifth is silent again");
    assert.equal(
      Math.min(...forwarded),
      MOUNTED_WORKSPACE_SLOTS + 1,
      "detection has to start at the first slot compose does not mount",
    );
    // Contiguous, so there is no gap an operator can fall into between the
    // highest mounted slot and the highest detected one.
    assert.deepEqual(
      [...forwarded].sort((a, b) => a - b),
      Array.from({ length: forwarded.length }, (_, i) => MOUNTED_WORKSPACE_SLOTS + 1 + i),
    );
  });

  /**
   * Every `see <file>, "<heading>"` in a string, resolved against the tree.
   *
   * A reference is checked by opening the file and finding the heading, not by
   * matching the filename, so a section that moves or is renamed fails here too
   * — which is the only difference between this and the state it replaces.
   */
  function assertReferencesResolve(source: string, what: string): void {
    const references = [...source.matchAll(/see ([\w./-]+), "([^"]+)"/g)];
    assert.ok(references.length > 0, `${what} no longer points anywhere`);
    for (const [, file, heading] of references) {
      const page = path.join(root, file);
      assert.ok(fs.existsSync(page), `${what} names ${file}, which is not a file in this repo`);
      assert.match(
        fs.readFileSync(page, "utf8"),
        new RegExp(`^#{1,6} ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"),
        `${what} sends the operator to ${file}, "${heading}", and that file has ` +
          `no section by that name`,
      );
    }
  }

  it("sends the refusal to a page that has the section it names", () => {
    // That sentence is the whole of what the operator gets: the refusal throws
    // at module scope, so the container exits before there is a dashboard, an
    // API or a log line to read instead. It named README, which has no
    // workspace section at all — so a boot that will not start pointed at a
    // place that does not exist, which is the failure the refusal was written
    // to end wearing a different hat (#126).
    const refusal = unmountedWorkspaceRefusal("UF_WORKSPACE_5_NAME");
    assert.ok(refusal, "a configured fifth slot must still refuse the boot");
    assertReferencesResolve(refusal, "unmountedWorkspaceRefusal's message");
  });

  it("keeps compose's own pointer on that same page", () => {
    // The comment above UF_UNMOUNTED_WORKSPACES answers the same question for
    // whoever is already reading the file they have to edit, and it drifted in
    // step with the refusal — one edit away, and neither typechecks.
    assertReferencesResolve(compose, "docker-compose.yml");
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

/**
 * The agreement that decides whether a *correct* install accuses itself.
 *
 * Compose cannot omit an environment key conditionally, so every optional
 * variable is rendered `${VAR:-}` and is explicitly blank on a deployment where
 * the operator set nothing. `config.ts` decides what that blank means, one
 * variable at a time: `env()` records the name in `STRICT_ENV_VARS`, and
 * `checkConfig` then warns that it "is a value nobody chose" — on the dashboard,
 * above the meters, on every boot. So each blank-by-default key in that block is
 * one edit away from being a permanent warning on every stock deployment,
 * naming a variable the operator never wrote.
 *
 * Which is exactly what happened, three times, and it is the reason this is
 * pinned rather than described: the block grew — `UF_GITHUB_TOKENS`,
 * `UF_TRANSCRIPT_CACHE_MAX_ENTRIES`, `UF_UNMOUNTED_WORKSPACES` — and
 * `BLANK_MEANINGFUL_ENV_VARS` did not, so three warnings stood on every compose
 * install at once. Nothing noticed, and nothing could: it typechecks, it boots,
 * every page works, and the only symptom is a banner that is *always* on, which
 * is how a banner stops being read at all. `UF_UNMOUNTED_WORKSPACES` is the one
 * that shows the cost has no floor — it is computed by compose from the slots it
 * could not mount, blank is its success case, and any non-blank value refuses
 * the boot, so there was no `.env` edit that could clear the warning it raised.
 *
 * The two halves are one line away from each other in different files and
 * neither typechecks against the other.
 */
describe("compose's blank-by-default variables and config.ts's own env split", () => {
  const configSource = fs.readFileSync(path.join(root, "src", "lib", "config.ts"), "utf8");

  /**
   * The names read through each door, off the source rather than off
   * `STRICT_ENV_VARS`.
   *
   * That constant is collected as the module runs, so it holds only what *this*
   * process reached — `WORKSPACE_ROOT` is read solely when no mount is
   * configured — and a variable read on a branch the tests do not take would
   * pass this silently, which is the failure mode being pinned. `\benv\(` cannot
   * match `optionalEnv(` (the capital E is not `env`, and `l` leaves no word
   * boundary), and neither matches the declarations, whose first argument is not
   * a quoted literal.
   */
  function namesRead(door: "env" | "optionalEnv"): Set<string> {
    const pattern = new RegExp(`\\b${door}\\(\\s*"([A-Z0-9_]+)"`, "g");
    return new Set([...configSource.matchAll(pattern)].map((m) => m[1]));
  }

  it("reads every one of them through the door that treats blank as an answer", () => {
    const strict = namesRead("env");
    const blank = [...environmentKeys()]
      .filter(([, value]) => resolvedWithEmptyEnv(value) === "")
      .map(([key]) => key);

    assert.ok(blank.length > 0, "no blank-by-default keys were found to check");

    const misread = blank.filter((key) => strict.has(key));
    assert.deepEqual(
      misread,
      [],
      `docker-compose.yml sets ${misread.join(", ")} to the empty string on an ` +
        `install that configures nothing, and config.ts reads ${
          misread.length === 1 ? "it" : "them"
        } through env(), which reports blank as a value nobody chose. Every ` +
        `correct deployment would carry that warning on its dashboard for ever. ` +
        `Read ${misread.length === 1 ? "it" : "them"} through optionalEnv() and ` +
        `add ${misread.length === 1 ? "it" : "them"} to ` +
        `BLANK_MEANINGFUL_ENV_VARS — or, if blank really is a mistake there, ` +
        `give the compose entry a non-blank default.`,
    );
  });

  it("keeps the exported list identical to what optionalEnv actually reads", () => {
    // The list is what `checkConfig`'s sentence enumerates, so a name that is
    // read through `optionalEnv` and missing from it makes that sentence claim
    // blank is a mistake for a variable this app deliberately treats as set —
    // and one in the list that nothing reads that way is a name the warning
    // excuses and `env()` still reports. Neither typechecks.
    assert.deepEqual(
      [...namesRead("optionalEnv")].sort(),
      [...BLANK_MEANINGFUL_ENV_VARS].sort(),
    );
  });

  it("forwards every variable of its own that config.ts reads", () => {
    // There is no `env_file:` in docker-compose.yml, so the `environment:` block
    // is the whole of what reaches the container: a name added to `config.ts`
    // and not to that block is read as unset on every compose install, for ever,
    // no matter what the operator put in `.env`. It typechecks, it boots, and
    // the feature behind it is simply off — which for a notifier is silence, the
    // same thing a healthy fleet looks like.
    //
    // Scoped to this app's own prefix on purpose. `CLAUDE_BIN`, `GIT_BIN` and
    // `ANTHROPIC_API_BASE` are escape hatches with code defaults that compose
    // deliberately does not expose, and `PORT` is set in the image.
    const forwarded = new Set(environmentKeys().keys());
    const missing = [...namesRead("env"), ...namesRead("optionalEnv")]
      .filter((name) => name.startsWith("UF_") && !forwarded.has(name))
      .sort();

    assert.deepEqual(
      missing,
      [],
      `config.ts reads ${missing.join(", ")}, and docker-compose.yml's ` +
        `environment: block does not name ${
          missing.length === 1 ? "it" : "them"
        }. There is no env_file, so nothing an operator writes in .env can ` +
        `reach the container.`,
    );
  });
});

/**
 * Where `gh` extensions land, pinned across the three files that have to name
 * one directory for the mechanism to mean anything.
 *
 * `UF_GH_EXTENSIONS` exists because installing an extension in a shell survives
 * `docker restart` and is discarded by `docker compose up --build`, so the tool
 * an operator installed is simply absent after the next upgrade — and what an
 * agent meets is `unknown command` inside a tool call, which the run loop reads
 * as the agent deciding not to use it. The volume is the whole of the fix, and
 * it is worth exactly as much as the agreement between the path the entrypoint
 * installs into, the path compose mounts and the path the image creates. Any
 * one of the three moving leaves a container that boots, installs the
 * extensions, reports them installed, and loses them on the rebuild — the
 * original defect, now wearing a configuration variable that says it is fixed.
 */
describe("gh extensions survive the rebuild that installs them by hand does not", () => {
  const entrypoint = fs.readFileSync(path.join(root, "docker-entrypoint.sh"), "utf8");

  /** The directory the entrypoint treats as gh's, off the entrypoint itself. */
  function ghDataVolume(): string {
    const match = /^GH_DATA_VOLUME=(\S+)$/m.exec(entrypoint);
    assert.ok(match, "docker-entrypoint.sh no longer names a gh data directory");
    return match[1];
  }

  it("mounts a named volume over the directory the entrypoint installs into", () => {
    const target = ghDataVolume();
    assert.match(
      compose,
      new RegExp(`^\\s*-\\s*[A-Za-z0-9][\\w.-]*:${target}\\s*$`, "m"),
      `${target} is not a named volume in docker-compose.yml. Without one it ` +
        `is the image's writable layer, which \`docker compose up --build\` ` +
        `discards along with every extension UF_GH_EXTENSIONS installed.`,
    );
  });

  it("ships that directory in the image, so a fresh volume is not root's", () => {
    // A named volume takes its root's ownership from the directory at the mount
    // point when Docker first creates it. Absent from the image, that root is
    // root-owned 0755 and the children — which are the only thing that runs an
    // extension, and the only thing that installs one — cannot write it.
    const target = ghDataVolume();
    assert.match(
      dockerfile,
      new RegExp(`mkdir -p[^\\n]*(\\\\\\s*\\n[^\\n]*)*${target}`),
      `the image never creates ${target}, so the volume created over it ` +
        `belongs to root and every install fails on a directory it cannot write`,
    );
  });

  it("installs as the uid that will run them, never as root", () => {
    // Root-owned executables in a volume the agents are meant to own leave them
    // unable to upgrade or remove what they run, and the privilege split this
    // image is built around says the children are not root.
    assert.match(
      entrypoint,
      /setpriv --reuid="\$UF_AGENT_UID"/,
      "docker-entrypoint.sh installs gh extensions without dropping to " +
        "UF_AGENT_UID, so the executables an agent runs belong to root",
    );
  });
});

/**
 * Where the tools `UF_PY_TOOLS` names land, pinned across the same three files
 * for the same reason — and one the gh block does not carry, because the two
 * mechanisms fail differently.
 *
 * A `gh` extension that went missing on the rebuild is at least an `unknown
 * command`. These are invoked by a *plugin's hooks*, and a hook body ends in
 * `|| true`: a command that is not there makes the hook exit 0 having done
 * nothing, so a plugin announcing itself on session start keeps announcing
 * itself against a tool that was discarded. That is what was measured on this
 * install before any of this existed — 213 sessions told a plugin was active
 * with the command absent — and it is what a path moving in one of these three
 * files would restore, wearing a configuration variable that says it is fixed.
 *
 * The image's `PATH` is the fourth thing that has to agree, and it is not
 * optional in the way it is for gh: `gh` resolves its own extensions, while
 * `uv` only writes launchers into a directory, and a hook finds them by `PATH`
 * or not at all. `childEnv` copies the server's environment and strips only
 * `UF_*`, `OTEL_*` and four named keys, so a `PATH` set in the image is the one
 * the CLI and its hooks run with.
 */
describe("Python tools survive the rebuild that installs them by hand does not", () => {
  const entrypoint = fs.readFileSync(path.join(root, "docker-entrypoint.sh"), "utf8");

  /** The directory the entrypoint treats as uv's, off the entrypoint itself. */
  function pyToolsVolume(): string {
    const match = /^PY_TOOLS_VOLUME=(\S+)$/m.exec(entrypoint);
    assert.ok(match, "docker-entrypoint.sh no longer names a Python tools directory");
    return match[1];
  }

  it("mounts a named volume over the directory the entrypoint installs into", () => {
    const target = pyToolsVolume();
    assert.match(
      compose,
      new RegExp(`^\\s*-\\s*[A-Za-z0-9][\\w.-]*:${target}\\s*$`, "m"),
      `${target} is not a named volume in docker-compose.yml. Without one it ` +
        `is the image's writable layer, which \`docker compose up --build\` ` +
        `discards along with every tool UF_PY_TOOLS installed.`,
    );
  });

  it("ships that directory in the image, so a fresh volume is not root's", () => {
    // Same mechanics as the gh volume: Docker copies the mount point's
    // ownership onto a fresh volume's root and never revisits it. Absent from
    // the image that root is root-owned, and every install fails on a directory
    // it cannot write.
    const target = pyToolsVolume();
    assert.match(
      dockerfile,
      new RegExp(`mkdir -p[^\\n]*(\\\\\\s*\\n[^\\n]*)*${target}`),
      `the image never creates ${target}, so the volume created over it ` +
        `belongs to root and every install fails on a directory it cannot write`,
    );
  });

  it("points uv at that directory rather than at its own defaults", () => {
    // uv's defaults are under $XDG_DATA_HOME — the writable layer, which the
    // rebuild discards. The volume is worth nothing unless uv is told to use
    // it, and being told is three variables rather than one: the tools, the
    // launchers, and any interpreter uv had to fetch.
    const target = pyToolsVolume();
    for (const key of ["UV_TOOL_DIR", "UV_TOOL_BIN_DIR", "UV_PYTHON_INSTALL_DIR"]) {
      assert.match(
        dockerfile,
        new RegExp(`${key}=${target}/`),
        `${key} does not point inside ${target}, so what it names is the ` +
          `image's writable layer and the next \`up --build\` discards it`,
      );
    }
  });

  it("puts uv's launcher directory on the PATH a hook resolves through", () => {
    // The one requirement gh does not have. `uv tool install` writes launchers
    // into UV_TOOL_BIN_DIR and stops there; nothing resolves them for a hook.
    // Off PATH, every tool this variable installs is present, correct, owned by
    // the right uid, and never found.
    const binDir = /UV_TOOL_BIN_DIR=(\S+)/.exec(dockerfile);
    assert.ok(binDir, "the image no longer names a UV_TOOL_BIN_DIR");
    assert.match(
      dockerfile,
      new RegExp(`ENV PATH="${binDir[1]}:\\$\\{PATH\\}"`),
      `${binDir[1]} is not prepended to PATH in the Dockerfile, so a plugin ` +
        `hook running the command it installed gets "not found" — and, ending ` +
        `in \`|| true\`, reports nothing at all`,
    );
  });

  it("installs as the uid that will run them, never as root", () => {
    // A tool here is an executable a hook invokes. Root-owned files in a volume
    // the agents own leave them unable to upgrade or remove what they run.
    assert.match(
      entrypoint,
      /uv_as_agent\(\)[\s\S]*?setpriv --reuid="\$UF_AGENT_UID"/,
      "docker-entrypoint.sh installs Python tools without dropping to " +
        "UF_AGENT_UID, so the executables a hook runs belong to root",
    );
  });

  it("does not split entries on commas, which belong to version specifiers", () => {
    // The one place this parts company with UF_GH_EXTENSIONS, and it is silent:
    // `cozempic>=1.8,<2` split on commas is two entries, neither installable,
    // both reported as a failed tool rather than as a mis-parsed line.
    const loop = /UF_PY_TOOLS:-[^\n]*\n(?:.*?\n)*?\s*for entry in \$\(echo "\$UF_PY_TOOLS"[^)]*\)/s.exec(
      entrypoint,
    );
    assert.ok(loop, "docker-entrypoint.sh no longer loops over UF_PY_TOOLS");
    assert.doesNotMatch(
      loop[0],
      /tr '[^']*,/,
      "the UF_PY_TOOLS loop treats a comma as a separator, which splits a " +
        "single pinned requirement into two unpinnable ones",
    );
  });
});

/**
 * The sandbox switch, pinned across the four files that have to agree for it to
 * mean anything — and, first, for it to stay *off*.
 *
 * Same grounds as the gh block above, one boundary over and with more at stake
 * in both directions. `UF_SANDBOX` is read by `docker-entrypoint.sh` and by
 * nothing in the app, so a variable an operator sets in `.env` reaches the
 * container only if compose forwards it: dropped, it is a security control
 * switched on in a file, never written, and never applied — the
 * `UF_WORKSPACE_5_NAME` silence wearing a policy. The path is the same shape of
 * agreement pointing the other way: `src/lib/sandbox.ts` reports what confines
 * this install by *reading that file*, so a path that moves in one of the two
 * makes an install with a live policy report that it has none, which is the one
 * thing that row exists to prevent.
 *
 * And the direction this run had to get right at all: the switch ships off, and
 * `security_opt` ships commented. An uncommented seccomp line would make every
 * stock `docker compose up` depend on a profile file the daemon may reject, for
 * a sandbox nobody asked for. That reading is now measured rather than argued:
 * with the profile applied `bwrap` starts and without it the same command fails
 * at both uids, so the line decides something on every install that has one.
 * An operator who wants it puts it in a `docker-compose.override.yml`, which is
 * why this assertion did not have to move to enable a sandbox here. Docker is
 * not available where these tests run, so this pins the files against each
 * other; `docs/verification.md` carries the commands that check the behaviour,
 * and two of them now have answers.
 *
 * The forwarding assertion below is no longer about `UF_SANDBOX` alone. It
 * covers every `UF_` name the entrypoint reads, because the one that went
 * missing was the one no prefix had been written for.
 */
describe("winnow is in the image, because nothing else bounds a cycle now", () => {
  /**
   * The three-file agreement behind context pruning, and it earns a group of
   * its own for a reason `UF_PY_TOOLS`' does not have.
   *
   * That mechanism installs at boot and is best-effort: a tool that fails to
   * arrive costs the operator a plugin. This one replaced `--autocompact`, so an
   * install where it is absent has **nothing at all** bounding a work cycle's
   * context — a long cycle runs to the model's whole window, no error, no failed
   * run, just a bill. So the paths `contextPruning.ts` executes and the paths the
   * Dockerfile builds have to be the same paths, and a rename in either file
   * alone produces exactly that silence.
   */
  const module = fs.readFileSync(path.join(root, "src/lib/contextPruning.ts"), "utf8");

  /** The interpreter path the run loop actually spawns, off the module itself. */
  function winnowRoot(): string {
    const match = /^export const WINNOW_ROOT = "([^"]+)";$/m.exec(module);
    assert.ok(match, "contextPruning.ts no longer names a winnow root");
    return match[1];
  }

  it("builds winnow into the directory the run loop runs it from", () => {
    const target = winnowRoot();
    assert.ok(
      dockerfile.includes(`${target}/venv`),
      `The Dockerfile does not build a virtualenv under ${target}, which is ` +
        `where contextPruning.ts spawns \`${target}/venv/bin/python\`. A run ` +
        `would report pruning unavailable on every cycle, and with --autocompact ` +
        `gone nothing would bound the context at all.`,
    );
  });

  it("keeps that directory off every named volume", () => {
    // The trap this exists for, and it has already caught one design: a volume
    // takes its contents from the image exactly once, at creation, so a
    // build-time install underneath a mount point is masked by whatever the
    // existing volume holds. Installing winnow into `/home/node/pytools` would
    // build correctly, pass every other test here, and be invisible at runtime
    // on any machine that had already created that volume.
    const target = winnowRoot();
    const mounts = [...compose.matchAll(/^\s*-\s*[A-Za-z0-9][\w.-]*:(\/\S+?)(?::\w+)?\s*$/gm)]
      .map((m) => m[1]);
    for (const mount of mounts) {
      assert.ok(
        target !== mount && !target.startsWith(`${mount}/`),
        `${target} is under the named volume mounted at ${mount}. A volume ` +
          `takes the image's contents only when it is first created, so on any ` +
          `machine whose volume already exists the build would be masked and ` +
          `winnow would silently not be there.`,
      );
    }
  });

  it("pins the checkout to a commit, not a branch", () => {
    // `CLAUDE_CLI_VERSION`'s argument. The run loop measures what this tool
    // removes and prices it, so an unpinned rebuild moves that contract with
    // nothing announcing it — and a tier that started removing more or less
    // would show up only as a KPI that had quietly changed shape.
    const match = /^ARG WINNOW_REF=(\S*)$/m.exec(dockerfile);
    assert.ok(match, "the Dockerfile no longer takes a WINNOW_REF");
    assert.match(
      match[1],
      /^[0-9a-f]{40}$/,
      `WINNOW_REF defaults to "${match[1]}", which is not a full commit sha.`,
    );
  });

  it("lets an operator build without it, rather than only by editing the image", () => {
    // The escape hatch for a build host that cannot reach GitHub. `${VAR-default}`
    // and deliberately not `${VAR:-default}`: the whole point is that an
    // explicitly empty WINNOW_REF stays empty, and the colon form would
    // substitute the default right back over it.
    assert.match(
      compose,
      /WINNOW_REF:\s*"\$\{WINNOW_REF-[^}]*\}"/,
      "docker-compose.yml must pass WINNOW_REF through with ${VAR-default}, " +
        "or `WINNOW_REF=` in .env cannot switch the bundling off.",
    );
  });

  it("no longer sends --autocompact, which pruning replaced", () => {
    // Read off `buildArgs` in the source rather than from its output, because
    // this is the deployment group's own question: the image and the argv have
    // to agree that exactly one mechanism bounds a cycle. Both running means the
    // CLI summarises a conversation moments before this app ends the cycle to
    // prune it, and the run pays for both.
    const orchestrator = fs.readFileSync(
      path.join(root, "src/lib/orchestrator.ts"),
      "utf8",
    );
    assert.ok(
      !/args\.push\("--autocompact"/.test(orchestrator),
      "buildArgs emits --autocompact again. contextPruning.ts owns the ceiling; " +
        "running both is worse than either.",
    );
  });
});

describe("the sandbox ships off, and its switch reaches the container", () => {
  const entrypoint = fs.readFileSync(path.join(root, "docker-entrypoint.sh"), "utf8");

  it("forwards every UF_ variable the entrypoint reads", () => {
    // Derived from the entrypoint rather than listed here, and widened from the
    // `UF_SANDBOX` prefix it used to match, because a prefix only covers the
    // variables somebody already thought of: `UF_LOCK_CLAUDE_HOME` — the other
    // half of this same sandbox — shipped unforwarded past this assertion and
    // could not be given a value by any operator until #125. Comment lines are
    // dropped first, so the `docker compose exec --user "${UF_UID:-1000}"`
    // advice the entrypoint prints for an operator is not read as a variable
    // this container is given.
    const read = new Set(
      [...entrypoint.replace(/^\s*#.*$/gm, "").matchAll(/\$\{?(UF_[A-Z0-9_]+)/g)].map(
        (m) => m[1],
      ),
    );
    assert.ok(read.size > 0, "docker-entrypoint.sh no longer reads any UF_ variable");

    const forwarded = new Set(
      [...compose.matchAll(/^ {6}(UF_[A-Z0-9_]*):/gm)].map((m) => m[1]),
    );
    const dropped = [...read].filter((name) => !forwarded.has(name));
    assert.deepEqual(
      dropped,
      [],
      `docker-compose.yml does not forward ${dropped.join(", ")}, so setting ` +
        `${dropped.length === 1 ? "it" : "them"} in .env changes nothing at all — ` +
        `an operator would be reading a variable they set against a fleet that ` +
        `never saw it.`,
    );
  });

  it("leaves all of them blank, so a stock install writes no policy", () => {
    for (const [key, value] of [...environmentKeys()].filter(([k]) =>
      k.startsWith("UF_SANDBOX"),
    )) {
      assert.equal(
        resolvedWithEmptyEnv(value),
        "",
        `docker-compose.yml gives ${key} the default "${value}". The sandbox is ` +
          `an opt-in whose failure mode is a fleet that cannot run a command, and ` +
          `nothing in the image may turn it on.`,
      );
    }
  });

  it("writes the policy where the app looks for it", () => {
    const sandboxSource = fs.readFileSync(path.join(root, "src", "lib", "sandbox.ts"), "utf8");
    const read = /MANAGED_SETTINGS_PATH\s*=\s*"([^"]+)"/.exec(sandboxSource);
    assert.ok(read, "src/lib/sandbox.ts no longer names a managed settings path");

    const written = /^MANAGED_SETTINGS_FILE="([^"]+)"$/m.exec(entrypoint);
    assert.ok(written, "docker-entrypoint.sh no longer names a managed settings file");
    assert.equal(
      written[1].replace("$MANAGED_SETTINGS_DIR", dirName(entrypoint)),
      read[1],
      "the entrypoint writes the sandbox policy somewhere src/lib/sandbox.ts does " +
        "not read, so an install with a live policy reports that it has none",
    );
  });

  /** The directory `MANAGED_SETTINGS_DIR` is set to, for the path above. */
  function dirName(source: string): string {
    const match = /^MANAGED_SETTINGS_DIR=(\S+)$/m.exec(source);
    assert.ok(match, "docker-entrypoint.sh no longer names a managed settings directory");
    return match[1];
  }

  it("carries the two dependencies a missing one of which is an error", () => {
    // The CLI's own dependency check reports a missing `bwrap` or `socat` as an
    // error rather than a warning, so an install that switched the sandbox on
    // without them meets that failure inside a tool call — which is the shape
    // of failure this image carries a compiler and `gh` to avoid.
    const packages = runtimePackages();
    for (const name of ["bubblewrap", "socat"]) {
      assert.ok(
        packages.includes(name),
        `the runtime image no longer installs ${name}, so UF_SANDBOX=1 produces a ` +
          `fleet whose every command fails on a missing sandbox dependency`,
      );
    }
    // The third is an npm global and is pinned for the reason the CLI is: this
    // adds the sandbox settings schema to what that pin protects.
    assert.match(
      runnerStage(),
      /@anthropic-ai\/sandbox-runtime@\$\{SANDBOX_RUNTIME_VERSION\}/,
      "the seccomp applier is no longer installed at a pinned version, and its " +
        "absence downgrades the network boundary on a warning",
    );
  });

  it("ships the seccomp line commented, next to a profile that exists", () => {
    assert.doesNotMatch(
      compose,
      /^\s*security_opt:/m,
      "docker-compose.yml applies a seccomp profile by default. A stock install " +
        "must not depend on a profile file the operator has not chosen to supply.",
    );
    const line = /^\s*#\s*-\s*seccomp=(\S+)\s*$/m.exec(compose);
    assert.ok(line, "docker-compose.yml no longer carries the commented seccomp line");
    assert.ok(
      fs.existsSync(path.join(root, line[1])),
      `the commented security_opt line names ${line[1]}, which this repository ` +
        `does not ship — an operator who uncomments it gets a container that ` +
        `will not start`,
    );
  });
});

/**
 * The Discord relay's three files agreeing, and the third assertion is the one
 * that matters.
 *
 * `notify.ts` sends one generic signed body and will not learn a vendor's shape,
 * so reaching Discord needs a process in between; that process now lives in this
 * image and is started by the entrypoint, because the arrangement it replaces —
 * an operator running it beside the container — failed twice in a row by simply
 * not being running, which is silent at the sending end and at the receiving
 * one. What is pinned here is the agreement between the path the Dockerfile
 * copies to, the path the entrypoint runs, and the condition that starts it.
 *
 * **The unset is the reason this block is a test rather than a comment.**
 * `orchestrator.ts` builds every agent's environment as `{ ...process.env }`, so
 * a variable the server process still holds is one every unattended agent can
 * read, and `DISCORD_WEBHOOK_URL` posts to a channel on possession alone. The
 * entrypoint therefore hands it to the relay and removes it before `exec`. A
 * later edit that reorders those two lines, or that drops the `unset` while
 * keeping everything working, is invisible in every other way: the channel still
 * receives its notifications, and the credential is merely also readable by
 * twenty-five unattended models.
 */
describe("the Discord relay ships, starts, and does not leak its credential", () => {
  const entrypoint = fs.readFileSync(path.join(root, "docker-entrypoint.sh"), "utf8");
  const RELAY_PATH = "/app/scripts/discord-relay.mjs";

  it("copies the relay into the image the entrypoint runs it from", () => {
    assert.match(
      dockerfile,
      /^COPY .*scripts\/discord-relay\.mjs .*\.\/scripts\/$/m,
      `the image no longer ships scripts/discord-relay.mjs, so the entrypoint ` +
        `starts a relay that is not there and every notification is lost with ` +
        `"fetch failed" — the app records the attempt and nothing else says why`,
    );
    assert.ok(
      fs.existsSync(path.join(root, "scripts/discord-relay.mjs")),
      "Dockerfile copies scripts/discord-relay.mjs, which this repository does not ship",
    );
  });

  it("starts it only when DISCORD_WEBHOOK_URL names a channel", () => {
    assert.match(
      entrypoint,
      /if \[ -n "\$\{DISCORD_WEBHOOK_URL:-\}" \]; then/,
      "docker-entrypoint.sh no longer gates the relay on DISCORD_WEBHOOK_URL, " +
        "so a stock install starts a process that can only fail",
    );
    assert.ok(
      entrypoint.includes(`node ${RELAY_PATH}`),
      `docker-entrypoint.sh no longer runs ${RELAY_PATH}, the path the ` +
        `Dockerfile copies the relay to`,
    );
  });

  it("removes the credential from the environment before exec'ing the server", () => {
    const unset = entrypoint.indexOf("unset DISCORD_WEBHOOK_URL");
    assert.notEqual(
      unset,
      -1,
      "docker-entrypoint.sh no longer unsets DISCORD_WEBHOOK_URL. " +
        "orchestrator.ts spawns agents with { ...process.env }, so the server " +
        "holding it hands a channel-posting credential to every unattended agent.",
    );
    const started = entrypoint.indexOf(`node ${RELAY_PATH}`);
    assert.ok(
      started !== -1 && started < unset,
      "docker-entrypoint.sh unsets DISCORD_WEBHOOK_URL before starting the " +
        "relay, which leaves the relay with nothing to forward to",
    );
    assert.ok(
      unset < entrypoint.lastIndexOf('exec "$@"'),
      "docker-entrypoint.sh unsets DISCORD_WEBHOOK_URL after exec'ing the " +
        "server, which never runs — the variable reaches every agent",
    );
  });

  it("forwards both Discord variables from compose, or .env cannot reach them", () => {
    // There is no env_file: a key an operator writes in .env reaches this
    // container only when a line here interpolates it. The same omission that
    // configCheck.test.ts pins for every variable config.ts reads, for the two
    // it does not.
    for (const name of ["DISCORD_WEBHOOK_URL", "DISCORD_MENTION_USER_ID"]) {
      assert.match(
        compose,
        new RegExp(`^\\s*${name}: "\\$\\{${name}:-\\}"\\s*$`, "m"),
        `docker-compose.yml does not forward ${name}, so setting it in .env ` +
          `does nothing at all and the boot log says the relay is off`,
      );
    }
  });
});
