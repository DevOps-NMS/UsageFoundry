import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ADMIN_API_KEY,
  ALLOW_NO_AUTH,
  AUTH_TOKEN,
  BLANK_MEANINGFUL_ENV_VARS,
  COOKIE_SECURE,
  GITHUB_TOKEN,
  GITHUB_TOKENS,
  STRICT_ENV_VARS,
  TRANSCRIPT_CACHE_MAX_ENTRIES,
  authEnabled,
  hasAdminKey,
  hasGithubToken,
} from "./config";
import {
  checkConfig,
  explicitlyBlank,
  probeDataDir,
  type ConfigProblem,
  type ConfigView,
  type PathProbe,
} from "./configCheck";

/**
 * Which configurations boot and which are refused, against a stubbed view of
 * the filesystem.
 *
 * The decision is pure for the reason `selectPromotable` and `landRefusal` are:
 * both ways of being wrong are silent and neither throws. Refusing something
 * ordinary makes a working install unbootable — a bind source that has not
 * mounted yet, a machine that has never run Claude Code — and permitting a
 * `DATA_DIR` this process was never given is the data loss the check exists to
 * end: the app runs perfectly and every row is destroyed by the next rebuild.
 * So each case here asserts the *severity* as well as the fact, because "warn"
 * and "refuse" are two different products.
 */

const dir: PathProbe = { kind: "dir" };

function view(over: Partial<ConfigView> = {}): ConfigView {
  return {
    dataDir: {
      path: "/data",
      blank: false,
      at: dir,
      write: { ok: true },
      uid: 1000,
    },
    mounts: [{ id: "workspace", label: "Workspace", path: "/workspace", at: dir }],
    claudeHome: { path: "/home/node/.claude", at: dir, projects: dir },
    blankVars: [],
    ...over,
  };
}

const of = (problems: ConfigProblem[], variable: string) =>
  problems.filter((p) => p.variable === variable);

describe("checkConfig", () => {
  it("accepts the shipped configuration", () => {
    assert.deepEqual(checkConfig(view()), []);
  });

  it("refuses an explicitly blank DATA_DIR, naming what it would have used", () => {
    const problems = checkConfig(
      view({
        dataDir: {
          path: "/app/.data",
          blank: true,
          at: dir,
          write: { ok: true },
          uid: 1000,
        },
      }),
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0].severity, "refuse");
    assert.equal(problems[0].variable, "DATA_DIR");
    // The path it would have used, and the loss, both have to be in the
    // sentence: the operator set nothing, so "DATA_DIR is invalid" tells them
    // about a variable they will not find in their own configuration.
    assert.match(problems[0].message, /\/app\/\.data/);
    assert.match(problems[0].message, /destroyed/);
  });

  it("refuses a DATA_DIR that is not a directory", () => {
    for (const at of [
      { kind: "file" } as const,
      { kind: "missing" } as const,
      { kind: "error", code: "EACCES" } as const,
    ]) {
      const problems = checkConfig(
        view({
          dataDir: { path: "/data", blank: false, at, write: null, uid: 1000 },
        }),
      );
      assert.equal(problems.length, 1, `${at.kind} should be refused`);
      assert.equal(problems[0].severity, "refuse");
      assert.match(problems[0].message, /\/data/);
    }
  });

  it("refuses a DATA_DIR that exists and cannot be written, naming the uid", () => {
    const problems = checkConfig(
      view({
        dataDir: {
          path: "/data",
          blank: false,
          at: dir,
          write: { ok: false, code: "EACCES" },
          uid: 1001,
        },
      }),
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0].severity, "refuse");
    assert.match(problems[0].message, /EACCES/);
    assert.match(problems[0].message, /uid 1001/);
  });

  it("reports a mount that is not a directory, and only warns about it", () => {
    // Warned rather than refused on purpose: compose mounts four slots
    // unconditionally, a bind source can be temporarily absent, and refusing
    // would take the dashboard and the run history away over a folder picker
    // that would merely have been empty.
    const problems = checkConfig(
      view({
        mounts: [
          { id: "a", label: "Workspace", path: "/workspace", at: dir },
          {
            id: "b",
            label: "Notes",
            path: "/hom/user/notes",
            at: { kind: "missing" },
          },
        ],
      }),
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0].severity, "warn");
    assert.equal(problems[0].variable, "WORKSPACE_ROOTS");
    assert.match(problems[0].message, /Notes/);
    assert.match(problems[0].message, /\/hom\/user\/notes/);
  });

  it("warns about a CLAUDE_HOME with no projects directory", () => {
    const problems = checkConfig(
      view({
        claudeHome: {
          path: "/home/node/.claude",
          at: dir,
          projects: { kind: "missing" },
        },
      }),
    );
    assert.equal(of(problems, "CLAUDE_HOME").length, 1);
    assert.equal(problems[0].severity, "warn");
    assert.match(problems[0].message, /projects\//);
  });

  it("warns once for a CLAUDE_HOME that is not there at all", () => {
    const problems = checkConfig(
      view({
        claudeHome: {
          path: "/home/node/.claude",
          at: { kind: "missing" },
          projects: { kind: "missing" },
        },
      }),
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0].severity, "warn");
  });

  it("warns about an explicitly blank variable, and never twice about DATA_DIR", () => {
    const problems = checkConfig(
      view({
        dataDir: {
          path: "/app/.data",
          blank: true,
          at: dir,
          write: { ok: true },
          uid: 1000,
        },
        blankVars: ["DATA_DIR", "CLAUDE_HOME"],
      }),
    );
    assert.equal(of(problems, "DATA_DIR").length, 1);
    assert.equal(of(problems, "DATA_DIR")[0].severity, "refuse");
    assert.equal(of(problems, "CLAUDE_HOME").length, 1);
    assert.equal(of(problems, "CLAUDE_HOME")[0].severity, "warn");
  });

  it("reports every problem rather than the first", () => {
    const problems = checkConfig(
      view({
        dataDir: {
          path: "/data",
          blank: false,
          at: dir,
          write: { ok: false, code: "EROFS" },
          uid: 1000,
        },
        mounts: [
          { id: "a", label: "Workspace", path: "/workspace", at: { kind: "file" } },
        ],
        claudeHome: {
          path: "/home/node/.claude",
          at: dir,
          projects: { kind: "missing" },
        },
        blankVars: ["GIT_BIN"],
      }),
    );
    assert.deepEqual(
      problems.map((p) => [p.severity, p.variable]),
      [
        ["refuse", "DATA_DIR"],
        ["warn", "WORKSPACE_ROOTS"],
        ["warn", "CLAUDE_HOME"],
        ["warn", "GIT_BIN"],
      ],
    );
  });
});

describe("explicitlyBlank", () => {
  it("separates an explicitly blank value from an unset one", () => {
    const env = { DATA_DIR: "", CLAUDE_HOME: "/home/node/.claude" };
    assert.deepEqual(explicitlyBlank(env, ["DATA_DIR", "CLAUDE_HOME"]), [
      "DATA_DIR",
    ]);
    assert.deepEqual(explicitlyBlank({}, ["DATA_DIR"]), []);
  });

  it("never reports the variables where blank is the documented answer", () => {
    // `docker-compose.yml` renders every one of them as `${VAR:-}`, so a stock
    // install has them all explicitly blank. They are not in the strict list,
    // and this is what says a change to that list cannot sweep them in: blank
    // means auth off, the API-account panel off, GitHub off, no acknowledgement,
    // the request deciding the cookie flag, the shipped cache bound, and — for
    // UF_UNMOUNTED_WORKSPACES — every configured slot actually mounted.
    const env = Object.fromEntries([
      ...BLANK_MEANINGFUL_ENV_VARS.map((name) => [name, ""]),
      ["DATA_DIR", ""],
    ]);
    assert.deepEqual(explicitlyBlank(env, ["DATA_DIR"]), ["DATA_DIR"]);
  });
});

describe("config.ts's own env split", () => {
  it("reads every strict variable and none of the blank-meaningful ones", () => {
    // The strict list is collected by `env()` as the module runs, so this also
    // proves the collection happens at all — an empty list would make every
    // blank-variable warning unreachable and nothing else would notice.
    assert.ok(STRICT_ENV_VARS.includes("DATA_DIR"));
    assert.ok(STRICT_ENV_VARS.includes("CLAUDE_HOME"));
    for (const name of BLANK_MEANINGFUL_ENV_VARS) {
      assert.ok(
        !STRICT_ENV_VARS.includes(name),
        `${name} must not be read through env(): blank is its "off" switch`,
      );
    }
  });

  it("reports a blank DATA_DIR and nothing else, against the real list", () => {
    // The stock install, and the case this whole split exists for: compose
    // renders every blank-meaningful variable as `${VAR:-}`, so all of them are
    // explicitly blank on a machine that is configured correctly. Run against
    // the collected `STRICT_ENV_VARS` rather than a stub, because what would
    // break this is someone moving one of them back onto `env()` — which
    // changes no behaviour and starts calling a correct install misconfigured.
    // Three of them were on that side for months, so every compose deployment
    // carried three warnings naming variables nobody had written.
    const env = Object.fromEntries([
      ...BLANK_MEANINGFUL_ENV_VARS.map((name) => [name, ""]),
      ["DATA_DIR", ""],
    ]);
    assert.deepEqual(explicitlyBlank(env, STRICT_ENV_VARS), ["DATA_DIR"]);
  });

  it("blank still means off for the three credentials", () => {
    // Unset and blank both have to reach the same "" — that is the documented
    // behaviour, and it is what says the switch to `optionalEnv` changed
    // nothing an operator can see.
    for (const [name, value, enabled] of [
      ["UF_AUTH_TOKEN", AUTH_TOKEN, authEnabled()],
      ["ANTHROPIC_ADMIN_KEY", ADMIN_API_KEY, hasAdminKey()],
      ["UF_GITHUB_TOKEN", GITHUB_TOKEN, hasGithubToken()],
    ] as const) {
      assert.equal(value, process.env[name] ?? "", name);
      assert.equal(enabled, value.length > 0, name);
    }
  });

  it("blank still takes the default for the four that moved", () => {
    // The same claim for the ones moved off `env()` later, where the risk is the
    // other way round: `env()` supplied a fallback and `optionalEnv` does not,
    // so anything whose fallback was not `""` would change meaning silently.
    // All four fell back to `""` already, and these are the four readings of
    // that empty string that anything downstream actually makes.
    assert.equal(ALLOW_NO_AUTH, process.env.UF_ALLOW_NO_AUTH ?? "");
    assert.equal(COOKIE_SECURE, process.env.UF_COOKIE_SECURE ?? "");
    if (!(process.env.UF_GITHUB_TOKENS ?? "")) assert.equal(GITHUB_TOKENS.size, 0);
    if (!(process.env.UF_TRANSCRIPT_CACHE_MAX_ENTRIES ?? "")) {
      assert.equal(TRANSCRIPT_CACHE_MAX_ENTRIES, 500_000);
    }
    // The fourth is asserted by this module having loaded at all: a non-blank
    // UF_UNMOUNTED_WORKSPACES throws out of `config.ts` at import.
  });
});

describe("probeDataDir", () => {
  it("reports a directory it cannot write to, which mkdirSync does not", (t) => {
    if (process.getuid?.() === 0) {
      // root writes through mode 0500, so there is nothing to observe.
      t.skip("running as root");
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uf-cfg-"));
    try {
      fs.chmodSync(dir, 0o500);
      // The measured fact this whole probe exists for: `recursive: true` treats
      // "already exists" as success without testing the mode, so the current
      // de-facto check in `claimDataDir` passes here and the EACCES only
      // arrives one call later, out of `writeLock`.
      assert.doesNotThrow(() => fs.mkdirSync(dir, { recursive: true }));

      const probe = probeDataDir(dir, false);
      assert.equal(probe.at.kind, "dir");
      assert.deepEqual(probe.write, { ok: false, code: "EACCES" });
      assert.equal(checkConfig(view({ dataDir: probe }))[0].severity, "refuse");
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a directory that is not there yet, and leaves no probe file", () => {
    // A first boot on a fresh install has nothing at DATA_DIR, and both
    // `open()` and `claimDataDir()` create it — refusing one this app would
    // have made itself would fail every one of them.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-cfg-"));
    try {
      const dir = path.join(root, "nested", "data");
      const probe = probeDataDir(dir, false);
      assert.deepEqual(probe.write, { ok: true });
      assert.deepEqual(checkConfig(view({ dataDir: probe })), []);
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
