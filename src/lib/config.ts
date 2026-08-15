import path from "node:path";
import os from "node:os";

/**
 * Process-level configuration. Everything here is fixed at boot from the
 * environment; user-editable preferences live in the settings table instead.
 */

const strictNames: string[] = [];

/**
 * Read a variable whose *blank* value is a mistake rather than an answer.
 *
 * The fallback still applies to one — a blank line in an env file and an
 * orchestrator rendering `value: ""` both reach here, and refusing to produce a
 * value at all would leave callers with nothing usable. What changed is that
 * the name is recorded, so `configCheck.ts` can say at boot that the default
 * being used was never asked for. That distinction is the whole of issue #98:
 * `DATA_DIR=` is not a request for `./.data`, it is a typo that puts the
 * database inside the image's writable layer where the next rebuild destroys it.
 */
function env(name: string, fallback: string): string {
  if (!strictNames.includes(name)) strictNames.push(name);
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * Read a variable where blank *is* the answer.
 *
 * Two kinds, and the split is worth naming because only one of them was here
 * originally: blank is an **off switch** for the three credentials
 * (`UF_AUTH_TOKEN`, `ANTHROPIC_ADMIN_KEY`, `UF_GITHUB_TOKEN`, and
 * `UF_GITHUB_TOKENS` beside it), and blank is **"take the default"** for the
 * three that carry a value only an operator tuning something ever sets
 * (`UF_ALLOW_NO_AUTH`, `UF_COOKIE_SECURE`, `UF_TRANSCRIPT_CACHE_MAX_ENTRIES`)
 * plus `UF_UNMOUNTED_WORKSPACES`, which is not an operator value at all. Either
 * way the operator chose it, so it must never be swept into a validation
 * failure — which is precisely why this check belongs in the app, which knows
 * which is which, rather than in compose, which does not.
 *
 * **The pairing with `docker-compose.yml` is what this has to be read against.**
 * Compose cannot omit an environment key conditionally, so every one of these is
 * rendered `${VAR:-}` (or, for `UF_UNMOUNTED_WORKSPACES`, computed from `:+`
 * expansions that produce nothing) and a stock install has all of them
 * explicitly blank. A variable added to that block and read through `env()` is
 * therefore a warning on the dashboard of *every* correct deployment, naming a
 * variable the operator never wrote — and for `UF_UNMOUNTED_WORKSPACES` one they
 * cannot unset from `.env` at all, because any non-blank value there refuses the
 * boot. That is how three of these got here: the block grew and the list did
 * not. `deployment.test.ts` pins the two against each other so the next one
 * cannot.
 */
function optionalEnv(name: string): string {
  return process.env[name] ?? "";
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
  const raw = Number(optionalEnv("UF_TRANSCRIPT_CACHE_MAX_ENTRIES"));
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

/**
 * How many workspace slots `docker-compose.yml` bind-mounts.
 *
 * The ceiling on mounts is the number of volume lines in that file, not a cap
 * in `parseMounts` — which has none, and must not gain one, because a compose
 * override file is a legitimate way to mount more. Compose cannot add a volume
 * conditionally, which is the same asymmetry the empty-label rule above relies
 * on, so the ceiling cannot be raised from `.env` alone.
 *
 * `deployment.test.ts` pins this against the volume lines themselves.
 */
export const MOUNTED_WORKSPACE_SLOTS = 4;

/**
 * Refuse a boot whose `.env` configures workspace slots compose never mounted.
 *
 * Left alone, a fifth slot is a no-op with no error, no warning and no log
 * line: `UF_WORKSPACE_5_NAME` is interpolated by nothing, so `WORKSPACE_ROOTS`
 * never carries the entry, `/workspace5` is never mounted, and the directory
 * simply never appears in the picker — which reads exactly like a directory
 * that *is* mounted and happens to be empty. That is the same silence
 * `${UF_WORKSPACE:?…}` and `${HOME:?…}` already refuse one file over, and it
 * gets the same treatment.
 *
 * Compose forwards the names it could not honour rather than their values: a
 * host path is not a secret, but nothing here needs it, and the sentence has to
 * name the *variable* the operator wrote so they can find it.
 *
 * A deployment that really does mount more — through a `docker-compose.override.yml`,
 * which is the supported route — says so by clearing this, and that is the one
 * thing an override has to remember. Nothing else about it changes.
 */
export function unmountedWorkspaceRefusal(forwarded: string): string | null {
  const names = forwarded.split(/[\s,|]+/).filter(Boolean);
  if (names.length === 0) return null;

  const list = names.join(", ");
  return (
    `${list} ${names.length === 1 ? "is" : "are"} set in .env, but this deployment mounts ` +
    `${MOUNTED_WORKSPACE_SLOTS} workspace slots and a bind mount cannot be added from .env. ` +
    `Unset ${names.length === 1 ? "it" : "them"}, or mount the directory in a ` +
    `docker-compose.override.yml and set UF_UNMOUNTED_WORKSPACES to an empty string there — ` +
    "see README, \"More than four workspaces\"."
  );
}

const unmountedWorkspaces = unmountedWorkspaceRefusal(
  optionalEnv("UF_UNMOUNTED_WORKSPACES"),
);
if (unmountedWorkspaces) throw new Error(unmountedWorkspaces);

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
export const AUTH_TOKEN = optionalEnv("UF_AUTH_TOKEN");

/**
 * The operator's explicit acknowledgement that this install runs with no
 * authentication at all.
 *
 * Not a preference and not a feature: with `UF_AUTH_TOKEN` empty every route
 * here is open, so the absence of a token must be something somebody chose
 * rather than something nobody set. `authBootSignal` refuses to start without
 * one of the two, and the value is compared as an exact string there — see the
 * note beside it for why truthiness would be the wrong reading.
 */
export const ALLOW_NO_AUTH = optionalEnv("UF_ALLOW_NO_AUTH");

/**
 * Override for the session cookie's `Secure` flag: `"1"` forces it on, `"0"`
 * off, anything else leaves the request to decide. See `cookieIsSecure` — the
 * two directions exist for different failures, and neither is a preference.
 */
export const COOKIE_SECURE = optionalEnv("UF_COOKIE_SECURE");

/** Admin API key (sk-ant-admin01-...). Optional. */
export const ADMIN_API_KEY = optionalEnv("ANTHROPIC_ADMIN_KEY");

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
export const GITHUB_TOKEN = optionalEnv("UF_GITHUB_TOKEN");

/**
 * Per-repository GitHub credentials: `folder=token` entries, `|`- or
 * newline-separated.
 *
 * One token for the whole install is one token for the whole fleet. `.env`'s own
 * advice — "a fine-grained token limited to the repositories you run agents
 * against … do not hand it one that reaches your whole account" — yields a
 * one-repository token at one repository and a fifteen-repository token at
 * fifteen, at which point an unattended agent asked to fix a test in one of them
 * holds a credential that can force-push to the other fourteen. Nothing in this
 * app narrowed that, because there was no second credential and no dimension to
 * hang one on.
 *
 * The folder is written absolute as the container sees it
 * (`/workspace/acme/web`) or relative to any mount (`acme/web`), the same
 * vocabulary `isolationCopyGlobsByRepo` takes and for the same reason: it is
 * what the operator is looking at. An entry whose token is **empty** is an
 * answer rather than a typo — it says this repository gets no credential at all,
 * which is otherwise unsayable while an install-wide token exists.
 *
 * Values never leave this map except into a child's environment. Nothing here
 * logs one, and the boot refusal `unmountedWorkspaceRefusal` writes names for
 * the same reason.
 */
function parseGithubTokens(spec: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const raw of spec.split(/[|\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const folder = entry.slice(0, eq).trim().replace(/\/+$/, "");
    if (!folder) continue;
    tokens.set(folder, entry.slice(eq + 1).trim());
  }
  return tokens;
}

export const GITHUB_TOKENS: ReadonlyMap<string, string> = parseGithubTokens(
  optionalEnv("UF_GITHUB_TOKENS"),
);

/**
 * The most specific configured folder key covering `folder`, or null.
 *
 * Shared by the two things that are configured per repository — which GitHub
 * credential a run gets, and which files seed its checkout — because two copies
 * of "does this key name this folder" would be two rules to keep in step, and
 * the one that drifted would be silent in both cases. Compared segment-wise and
 * case-folded, `overlaps`' comparison, because macOS is case-insensitive and
 * these are paths a person typed.
 *
 * A key on a parent directory covers everything under it, so a mount-wide
 * default is expressible and a key on the repository itself still beats it.
 */
export function matchFolderKey(
  folder: string,
  keys: Iterable<string>,
  mounts: WorkspaceMount[],
): string | null {
  const target = path.resolve(folder).split(path.sep).filter(Boolean);
  let best: { key: string; depth: number } | null = null;

  for (const key of keys) {
    const candidates = key.startsWith("/") ? [key] : mounts.map((m) => path.join(m.path, key));
    for (const candidate of candidates) {
      const segments = path.resolve(candidate).split(path.sep).filter(Boolean);
      if (segments.length > target.length) continue;
      if (!segments.every((s, i) => s.toLowerCase() === target[i].toLowerCase())) continue;
      if (!best || segments.length > best.depth) best = { key, depth: segments.length };
    }
  }
  return best?.key ?? null;
}

/** Where the credential a child was handed came from. */
export type GithubTokenScope = "repository" | "install" | "none";

/**
 * Which GitHub credential a child working in `folder` is given.
 *
 * Pure, and taking every input as an argument, because the failure it prevents
 * is not one anything downstream can see: a run handed the wrong token pushes
 * successfully to a repository nobody pointed it at, and the only evidence is a
 * commit in someone else's history.
 *
 * The install-wide token stays the answer for a folder no entry names — that is
 * what keeps an existing deployment's behaviour exactly what it was, and the map
 * empty means every folder takes that path. Narrowing the *whole* install is
 * therefore leaving `UF_GITHUB_TOKEN` blank and naming every repository that
 * should have one, which is the shape `.env.example` now describes.
 *
 * `folder` is null for a child with no repository — the orchestrator chat roams
 * every mount by design — and that takes the install-wide token or nothing.
 */
export function selectGithubToken(
  folder: string | null,
  perRepo: ReadonlyMap<string, string>,
  installToken: string,
  mounts: WorkspaceMount[],
): { token: string; scope: GithubTokenScope; key: string | null } {
  const key = folder === null ? null : matchFolderKey(folder, perRepo.keys(), mounts);
  if (key !== null) {
    const token = perRepo.get(key) ?? "";
    // An entry with no token is "this repository gets none", not "fall through
    // to the install-wide one" — the second reading would make the narrowest
    // thing an operator can write the widest one it does.
    return { token, scope: token ? "repository" : "none", key };
  }
  return installToken
    ? { token: installToken, scope: "install", key: null }
    : { token: "", scope: "none", key: null };
}

/** The credential for a folder, from this process's own configuration. */
export function githubTokenFor(folder: string | null): {
  token: string;
  scope: GithubTokenScope;
  key: string | null;
} {
  return selectGithubToken(folder, GITHUB_TOKENS, GITHUB_TOKEN, WORKSPACE_MOUNTS);
}

/** Path to the Claude Code executable inside the container. */
export const CLAUDE_BIN = env("CLAUDE_BIN", "claude");

/** Path to git, used to give concurrent runs their own checkout. */
export const GIT_BIN = env("GIT_BIN", "git");

export const ANTHROPIC_API_BASE = env("ANTHROPIC_API_BASE", "https://api.anthropic.com");

export const USER_AGENT = "UsageFoundry/0.1.0";

/**
 * Every variable this process actually read through `env()`, in the order it
 * read them.
 *
 * Collected rather than listed, so a variable added to this file cannot be
 * forgotten here — and it is only the ones a *this* configuration reached:
 * `WORKSPACE_ROOT` is read solely when no mount is configured, and a boot that
 * never consulted it has no business reporting on it.
 */
export const STRICT_ENV_VARS: readonly string[] = strictNames;

/**
 * Every variable where an explicitly blank value is a documented answer rather
 * than a mistake — the exact set `optionalEnv` reads, and the set
 * `configCheck.ts` must never report.
 *
 * Listed rather than collected, unlike `STRICT_ENV_VARS`: this one is a
 * *decision* about each name, and a list built by whichever function happened to
 * be called would make that decision by accident. `deployment.test.ts` is what
 * holds it to `docker-compose.yml`, and `configCheck.test.ts` is what holds it
 * against the strict list — the two must stay disjoint.
 */
export const BLANK_MEANINGFUL_ENV_VARS = [
  // Blank is an "off" switch: no auth, no API-account panel, no GitHub.
  "UF_AUTH_TOKEN",
  "ANTHROPIC_ADMIN_KEY",
  "UF_GITHUB_TOKEN",
  "UF_GITHUB_TOKENS",
  // Blank is "take the default": no acknowledgement, let the request decide the
  // cookie flag, and the shipped transcript cache bound.
  "UF_ALLOW_NO_AUTH",
  "UF_COOKIE_SECURE",
  "UF_TRANSCRIPT_CACHE_MAX_ENTRIES",
  // Blank is the *success* case, and it is not an operator value at all:
  // compose computes it from the workspace slots it could not mount, so any
  // non-blank value here refuses the boot. There is no `.env` edit that clears
  // it, which is what made reporting it a warning nobody could act on.
  "UF_UNMOUNTED_WORKSPACES",
] as const;

export const hasAdminKey = () => ADMIN_API_KEY.length > 0;
export const hasGithubToken = () => GITHUB_TOKEN.length > 0 || GITHUB_TOKENS.size > 0;

/**
 * What the Settings header says about GitHub credentials — folders, never
 * values.
 *
 * The one thing an operator cannot see from the outside is *how wide* the
 * credential their agents hold is, and at fifteen repositories that is the whole
 * question. `install: true` with no entries is one token for every repository,
 * which is the state this app shipped with and is worth saying in words.
 */
export function githubTokenSummary(): { install: boolean; repositories: string[] } {
  return { install: GITHUB_TOKEN.length > 0, repositories: [...GITHUB_TOKENS.keys()].sort() };
}
export const authEnabled = () => AUTH_TOKEN.length > 0;
