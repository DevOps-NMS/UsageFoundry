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

/**
 * Most parsed transcript turns held in memory at once.
 *
 * `transcripts.ts` keeps the records it parses out of each file so the next scan
 * only has to read the bytes appended since the last one. Nothing bounded that,
 * so the heap grew with every turn ever written under `CLAUDE_HOME` and the
 * process eventually died on V8's own limit — weeks on a busy fleet, months on a
 * laptop, and never on a machine restarted daily, which is why it survived this
 * long. Past this bound the coldest files are dropped *whole*, byte offset
 * included, so the next scan that needs them re-reads them from disk and derives
 * exactly the same records: what the bound costs is CPU, never accuracy.
 *
 * Process-level rather than a setting, because what it bounds is the heap this
 * process was given rather than anything the user is choosing. Roughly 330 bytes
 * are retained per turn, so the default is ~165 MB against V8's ~2 GB default
 * limit. Raise it alongside `--max-old-space-size` on a larger host; lower it on
 * a smaller one. A value that is not a positive number falls back to the
 * default, which is the safe direction for a figure only an operator tuning
 * memory ever sets.
 */
export const TRANSCRIPT_CACHE_MAX_ENTRIES = ((): number => {
  const raw = Number(env("UF_TRANSCRIPT_CACHE_MAX_ENTRIES", ""));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500_000;
})();

/**
 * Where the Claude CLI keeps its own config and credential files.
 *
 * `CLAUDE_CONFIG_DIR` is the CLI's variable, not ours, and the container sets
 * it. Falling back to `CLAUDE_HOME` rather than to `~/.claude` directly keeps
 * the account we report tied to the same tree whose transcripts we parse — a
 * `CLAUDE_HOME` pointed elsewhere should yield "plan unknown", not the plan of
 * whoever happens to be logged in on this host.
 */
export const CLAUDE_CONFIG_DIR = env("CLAUDE_CONFIG_DIR", CLAUDE_HOME);

/**
 * Base URL a spawned agent should push its OTLP telemetry to.
 *
 * Loopback by default because the agent runs in this same container — the
 * Dockerfile installs the CLI into the image — so nothing has to be published
 * for this to work. Claude Code appends `/v1/logs` to whatever base it is
 * given, which is why this stops at `/api/otlp`.
 */
export const OTLP_SELF_URL = env(
  "OTLP_SELF_URL",
  `http://127.0.0.1:${env("PORT", "3000")}/api/otlp`,
);

/**
 * Where the orchestrator chat's Claude child reaches this app's MCP tools.
 *
 * Loopback for the same reason `OTLP_SELF_URL` is: the child runs in this
 * container. It points at the full endpoint rather than a base, because unlike
 * the OTLP exporter an MCP client appends nothing.
 *
 * The tools have to run *in this process* rather than in a stdio MCP server of
 * their own. `createRun`'s folder claim — the thing that keeps two agents out of
 * one directory — is a synchronous check-then-insert that is only atomic because
 * one Node event-loop turn runs to completion. A second process doing
 * check-then-insert against the same SQLite file would silently permit exactly
 * the collision it prevents. See the note at the top of `db.ts`.
 */
export const MCP_SELF_URL = env(
  "MCP_SELF_URL",
  `http://127.0.0.1:${env("PORT", "3000")}/api/mcp`,
);

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

/**
 * GitHub credential handed to spawned agents, or empty when unset.
 *
 * Read from `UF_GITHUB_TOKEN` rather than from `GH_TOKEN` directly, and the
 * namespace is the whole point: `gitEnv()` strips `UF_*` from every git child
 * this app runs, and those children execute repository-controlled code —
 * `worktree add` fires `post-checkout`, `merge` fires `pre-merge-commit`. A
 * token named `GH_TOKEN` in the environment of this server would be inherited
 * by all of them. Named this way it reaches exactly one place, because
 * `githubEnv()` puts it there on purpose.
 *
 * Nothing this app itself does with git touches the network, so it never needs
 * the token: it is the agent's `git push`, `gh pr create` and `gh issue view`
 * that fail without one.
 */
export const GITHUB_TOKEN = env("UF_GITHUB_TOKEN", "");

/** Path to the Claude Code executable inside the container. */
export const CLAUDE_BIN = env("CLAUDE_BIN", "claude");

/** Path to git, used to give concurrent runs their own checkout. */
export const GIT_BIN = env("GIT_BIN", "git");

export const ANTHROPIC_API_BASE = env("ANTHROPIC_API_BASE", "https://api.anthropic.com");

export const USER_AGENT = "UsageFoundry/0.1.0";

export const hasAdminKey = () => ADMIN_API_KEY.length > 0;
export const hasGithubToken = () => GITHUB_TOKEN.length > 0;
export const authEnabled = () => AUTH_TOKEN.length > 0;
