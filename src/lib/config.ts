import path from "node:path";
import os from "node:os";

/**
 * Process-level configuration. Everything here is fixed at boot from the
 * environment; user-editable preferences live in the settings table instead.
 */

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/** Root of the Claude Code state directory (transcripts + credentials). */
export const CLAUDE_HOME = env("CLAUDE_HOME", path.join(os.homedir(), ".claude"));

/** Where transcripts live: one subdirectory per project, *.jsonl inside. */
export const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

/** One directory tree the UI may browse and run agents against. */
export interface WorkspaceMount {
  /** Stable slug used on the wire and as a form value. */
  id: string;
  /** Human-facing name shown in the mount picker. */
  label: string;
  /** Absolute path as this process sees it. */
  path: string;
}

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "mount";
}

/**
 * Parse `WORKSPACE_ROOTS`: one mount per entry, entries separated by `|` or a
 * newline, each entry either `Label=/abs/path` or a bare `/abs/path` (which
 * labels itself from its basename).
 *
 * An entry written with an explicitly *empty* label — `=/workspace2` — is
 * skipped rather than labelled from its basename. That asymmetry is what lets
 * `docker-compose.yml` hand every mount slot to the app unconditionally and use
 * an unset `UF_WORKSPACE_N_NAME` to switch a slot off, so adding a second
 * directory is an `.env` edit rather than a compose-file edit.
 */
function parseMounts(spec: string): WorkspaceMount[] {
  const seenPath = new Set<string>();
  const seenId = new Set<string>();
  const mounts: WorkspaceMount[] = [];

  for (const raw of spec.split(/[|\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;

    const eq = entry.indexOf("=");
    let label: string;
    let dir: string;
    if (eq === -1) {
      dir = entry;
      label = path.basename(entry) || entry;
    } else {
      label = entry.slice(0, eq).trim();
      dir = entry.slice(eq + 1).trim();
      if (!label) continue; // disabled slot
    }
    if (!dir) continue;

    const abs = path.resolve(dir);
    // Two slots pointing at the same directory would be two names for one
    // tree — confusing in the picker and meaningless for containment.
    if (seenPath.has(abs)) continue;
    seenPath.add(abs);

    let id = slug(label);
    if (seenId.has(id)) {
      let n = 2;
      while (seenId.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    seenId.add(id);
    mounts.push({ id, label, path: abs });
  }

  return mounts;
}

function legacyMount(): WorkspaceMount {
  const abs = path.resolve(
    env("WORKSPACE_ROOT", path.join(os.homedir(), "workspace")),
  );
  const label = path.basename(abs) || abs;
  return { id: slug(label), label, path: abs };
}

/**
 * Every directory tree the UI may browse and run agents against.
 *
 * Always non-empty: with `WORKSPACE_ROOTS` unset (or every slot disabled) this
 * degrades to the single `WORKSPACE_ROOT` mount, which is what a bare
 * `npm run dev` and every pre-multi-mount deployment gets.
 */
export const WORKSPACE_MOUNTS: WorkspaceMount[] = (() => {
  const configured = parseMounts(env("WORKSPACE_ROOTS", ""));
  return configured.length > 0 ? configured : [legacyMount()];
})();

/** The first mount. Kept for callers that predate multiple mounts. */
export const WORKSPACE_ROOT = WORKSPACE_MOUNTS[0].path;

export function mountById(id: string): WorkspaceMount | null {
  return WORKSPACE_MOUNTS.find((m) => m.id === id) ?? null;
}

/** Persistent data directory (SQLite file lives here). */
export const DATA_DIR = env("DATA_DIR", path.join(process.cwd(), ".data"));

export const DB_PATH = path.join(DATA_DIR, "usagefoundry.db");

/** Shared secret for the UI. Empty string disables auth entirely. */
export const AUTH_TOKEN = env("UF_AUTH_TOKEN", "");

/** Admin API key (sk-ant-admin01-...). Optional. */
export const ADMIN_API_KEY = env("ANTHROPIC_ADMIN_KEY", "");

/** Path to the Claude Code executable inside the container. */
export const CLAUDE_BIN = env("CLAUDE_BIN", "claude");

export const ANTHROPIC_API_BASE = env("ANTHROPIC_API_BASE", "https://api.anthropic.com");

export const USER_AGENT = "UsageFoundry/0.1.0";

export const hasAdminKey = () => ADMIN_API_KEY.length > 0;
export const authEnabled = () => AUTH_TOKEN.length > 0;
