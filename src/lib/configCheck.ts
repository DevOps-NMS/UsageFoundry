import fs from "node:fs";
import path from "node:path";

import {
  BLANK_MEANINGFUL_ENV_VARS,
  CLAUDE_HOME,
  DATA_DIR,
  PROJECTS_DIR,
  STRICT_ENV_VARS,
  WORKSPACE_MOUNTS,
} from "./config";

/**
 * What a boot makes of the configuration it was handed.
 *
 * `config.ts` made no filesystem call at all and treated an explicitly blank
 * variable as identical to an unset one, so every way of pointing this app at
 * the wrong place presented the same way: a container that starts, answers
 * `/login`, and shows an empty dashboard — which is also what a quiet week
 * looks like. The expensive one is `DATA_DIR=`, which reads as a request for
 * the default, puts the SQLite file inside the image's writable layer, and
 * loses every run, setting and workflow on the next `docker compose up --build`.
 *
 * **Which check refuses and which warns is the decision this module makes, and
 * it is not one rule applied evenly.**
 *
 * `DATA_DIR` **refuses**: it is the one value that decides where this app's
 * only copy of anything lives. A boot that carries on writing to a directory
 * the operator did not name is a boot that is manufacturing the data loss, and
 * every minute it serves adds rows to the wrong file. Refusing costs a restart;
 * continuing costs the history. It is also the check that can be made without
 * ambiguity — a directory this process cannot create a file in is not a matter
 * of degree.
 *
 * A **mount** and `CLAUDE_HOME` only **warn**, and the asymmetry is deliberate.
 * A workspace is optional by design: compose mounts four slots unconditionally
 * and three of them usually point at the same host directory, a bind source can
 * be temporarily unavailable (an unmounted disk, a network share still coming
 * up), and `CLAUDE_HOME/projects` legitimately does not exist until the machine
 * has run Claude Code once. Refusing there would take the dashboard, the run
 * history, the merge queue and every other page away from an operator whose
 * install is *degraded* rather than broken — and it would do it for a folder
 * picker that would merely have been empty. So they are reported: loudly on
 * stdout at boot, and on the dashboard, which is where somebody is actually
 * looking. An explicitly blank variable other than `DATA_DIR` warns for the
 * same reason: it is almost always a mistake, and it is never the mistake that
 * destroys anything.
 */

export type ConfigSeverity = "refuse" | "warn";

export interface ConfigProblem {
  severity: ConfigSeverity;
  /** The variable a reader has to edit. Not a path — the thing they can change. */
  variable: string;
  /** One sentence: what was expected, and what was seen. */
  message: string;
}

/** What a probe found at one path. */
export type PathProbe =
  | { kind: "dir" }
  | { kind: "file" }
  | { kind: "missing" }
  /** Present, and could not be read — a permission or an I/O fault. */
  | { kind: "error"; code: string };

export interface DataDirProbe {
  path: string;
  /** The variable was set to the empty string rather than left unset. */
  blank: boolean;
  at: PathProbe;
  /**
   * The outcome of an actual write, or null where nothing was attempted
   * because the path is not a directory.
   */
  write: { ok: true } | { ok: false; code: string } | null;
  /** The uid this process runs as, or null on a platform without them. */
  uid: number | null;
}

export interface MountProbe {
  id: string;
  label: string;
  path: string;
  at: PathProbe;
}

/**
 * Everything the pure check is allowed to know. A stubbed one is what the test
 * hands it, which is the whole reason the filesystem calls are in
 * `inspectConfig` rather than in here.
 */
export interface ConfigView {
  dataDir: DataDirProbe;
  mounts: MountProbe[];
  claudeHome: { path: string; at: PathProbe; projects: PathProbe };
  /** Variables explicitly set to "" where blank is not a meaningful value. */
  blankVars: string[];
}

/**
 * Which of `names` the environment sets to the empty string.
 *
 * Takes the map and the names rather than reading `process.env` and
 * `STRICT_ENV_VARS`, so the one case that matters can be asserted directly: the
 * three variables where blank means "off" are not in `names` and can never
 * appear here however they are set.
 */
export function explicitlyBlank(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string[] {
  return names.filter((n) => env[n] === "");
}

function describe(at: PathProbe): string {
  switch (at.kind) {
    case "dir":
      return "a directory";
    case "file":
      return "a file, not a directory";
    case "missing":
      return "nothing — the path does not exist";
    case "error":
      return `unreadable (${at.code})`;
  }
}

/** The whole decision, pure: which configurations are refused, and why. */
export function checkConfig(view: ConfigView): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const { dataDir } = view;
  const who = dataDir.uid === null ? "this process" : `uid ${dataDir.uid}`;

  // Refused ahead of the path checks below, because the path it would report on
  // is one this app invented: the operator named nothing, so naming the default
  // back at them would read as though it were their own value being rejected.
  if (dataDir.blank) {
    problems.push({
      severity: "refuse",
      variable: "DATA_DIR",
      message:
        `DATA_DIR is set to the empty string, which is read as unset — so the ` +
        `database would be created at ${dataDir.path}, derived from this ` +
        `process's working directory rather than from anything you configured. ` +
        `In the shipped image that is inside the container's writable layer, ` +
        `and every run, setting, workflow and schedule in it is destroyed by ` +
        `the next \`docker compose up --build\`. Expected an absolute path to a ` +
        `persistent directory (the image uses /data); unset the variable if you ` +
        `meant to take the default.`,
    });
  } else if (dataDir.at.kind !== "dir") {
    problems.push({
      severity: "refuse",
      variable: "DATA_DIR",
      message:
        `DATA_DIR (${dataDir.path}) could not be used: expected a directory ` +
        `this process can create, found ${describe(dataDir.at)}. The SQLite ` +
        `database and the server lock both live there.`,
    });
  } else if (dataDir.write && !dataDir.write.ok) {
    problems.push({
      severity: "refuse",
      variable: "DATA_DIR",
      message:
        `DATA_DIR (${dataDir.path}) is not writable by ${who}: a test write ` +
        `failed with ${dataDir.write.code}. Expected a directory this process ` +
        `can create files in. On Linux set UF_UID/UF_GID to the owner of the ` +
        `volume, or hand the volume over — docs/install.md has the command.`,
    });
  }

  for (const mount of view.mounts) {
    if (mount.at.kind === "dir") continue;
    problems.push({
      severity: "warn",
      variable: "WORKSPACE_ROOTS",
      message:
        `Workspace "${mount.label}" points at ${mount.path}, where there is ` +
        `${describe(mount.at)}. Its folder picker will be empty and no run can ` +
        `start in it. Docker creates a missing bind source rather than ` +
        `refusing, so a typo in UF_WORKSPACE_N looks exactly like this.`,
    });
  }

  const home = view.claudeHome;
  if (home.at.kind !== "dir") {
    problems.push({
      severity: "warn",
      variable: "CLAUDE_HOME",
      message:
        `CLAUDE_HOME (${home.path}): expected the Claude Code state directory ` +
        `— the one holding projects/ and .credentials.json — found ` +
        `${describe(home.at)}. Every usage figure on the dashboard reads zero ` +
        `until it names one.`,
    });
  } else if (home.projects.kind !== "dir") {
    problems.push({
      severity: "warn",
      variable: "CLAUDE_HOME",
      message:
        `CLAUDE_HOME (${home.path}) has no projects/ directory, so there are ` +
        `no transcripts to read and every usage figure reads zero. That is ` +
        `correct on a machine that has never run Claude Code, and a mount ` +
        `pointed one level too high otherwise.`,
    });
  }

  for (const name of view.blankVars) {
    // DATA_DIR already refused above; saying it twice would bury the refusal.
    if (name === "DATA_DIR") continue;
    problems.push({
      severity: "warn",
      variable: name,
      message:
        `${name} is set to the empty string, which is read as unset and takes ` +
        `the default. Only ${BLANK_MEANINGFUL_ENV_VARS.join(", ")} treat blank ` +
        `as "switched off"; for anything else it is a value nobody chose.`,
    });
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* The filesystem half                                                 */
/* ------------------------------------------------------------------ */

function probePath(p: string): PathProbe {
  try {
    return fs.statSync(p).isDirectory() ? { kind: "dir" } : { kind: "file" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "error", code: code ?? "UNKNOWN" };
  }
}

/**
 * Exported for the test that pins the one thing this could not be written
 * without: `mkdirSync(recursive: true)` reports success for a directory it
 * cannot write to, so the write has to be real.
 */
export function probeDataDir(dir: string, blank: boolean): DataDirProbe {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;

  // Created here rather than only checked, because both `open()` and
  // `claimDataDir()` create it and a first boot on a fresh install has nothing
  // there yet — refusing a directory this app would have made itself would fail
  // every one of them.
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* whatever went wrong is described by the probe below */
  }

  const at = probePath(dir);
  if (at.kind !== "dir") return { path: dir, blank, at, write: null, uid };

  // An actual write, because `mkdirSync(recursive: true)` reports success for a
  // directory that already exists whatever its mode is — measured, and the
  // reason this failure currently surfaces one call later as an EACCES out of
  // `writeLock` rather than as a statement about the configuration.
  const probeFile = path.join(dir, `.uf-write-probe.${process.pid}`);
  try {
    fs.writeFileSync(probeFile, "");
    fs.unlinkSync(probeFile);
    return { path: dir, blank, at, write: { ok: true }, uid };
  } catch (err) {
    return {
      path: dir,
      blank,
      at,
      write: { ok: false, code: (err as NodeJS.ErrnoException).code ?? "UNKNOWN" },
      uid,
    };
  }
}

/** Read the configuration this process booted with off the filesystem. */
export function inspectConfig(): ConfigView {
  return {
    dataDir: probeDataDir(DATA_DIR, process.env.DATA_DIR === ""),
    mounts: WORKSPACE_MOUNTS.map((m) => ({ ...m, at: probePath(m.path) })),
    claudeHome: {
      path: CLAUDE_HOME,
      at: probePath(CLAUDE_HOME),
      projects: probePath(PROJECTS_DIR),
    },
    blankVars: explicitlyBlank(process.env, STRICT_ENV_VARS),
  };
}

/**
 * `globalThis` for the reason every other long-lived singleton here uses it,
 * and cached for one of its own: the probe writes a file, and `/api/usage` is
 * polled every ten seconds.
 */
const cache = globalThis as unknown as { __ufConfigProblems?: ConfigProblem[] };

/**
 * The boot verdict, computed once.
 *
 * Read by `instrumentation.ts`, which decides what to do about a refusal, and
 * by `/api/usage`, which puts the warnings on the dashboard — the half of "not
 * only on stdout" that can be built today. A health endpoint is #96 and will
 * want this same list.
 */
export function configProblems(): ConfigProblem[] {
  return (cache.__ufConfigProblems ??= checkConfig(inspectConfig()));
}
