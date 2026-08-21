import fs from "node:fs";
import path from "node:path";

import { WORKSPACE_MOUNTS, type WorkspaceMount } from "./config";
import { getJSON, setJSON } from "./db";

/**
 * Claude Code plugins, discovered in the workspace mounts and switched on per
 * install.
 *
 * ## Why this app keeps its own list rather than installing them
 *
 * The obvious implementation is to run `claude plugin install` inside the
 * container and let the CLI's own registry hold the state. It does not work
 * here, and the reason is the mount: compose binds the operator's `~/.claude`
 * onto `/home/node/.claude`, so the CLI's registry is one file shared by the
 * host and the container. That file records **absolute** paths — verified: a
 * host-side install writes `installPath` as `/Users/<user>/.claude/plugins/…`,
 * which does not resolve inside the container, and a container-side install
 * would write `/home/node/.claude/plugins/…`, which does not resolve on the
 * host. Whichever side installs last breaks the other, silently: the CLI logs a
 * skip and exits 0, so every session afterwards runs with no plugin, no error
 * and entirely normal-looking output.
 *
 * So the registry is not shared. This app stores directory paths and passes
 * `--plugin-dir` per spawn, which needs no writes into `~/.claude` at all and
 * survives the container being rebuilt, because the list lives in `DATA_DIR`
 * beside everything else this app persists.
 *
 * ## Its own settings row
 *
 * Deliberately not a key of `Settings`, for `newWorkPaused`'s reason: the
 * settings page sends the whole object on Save, so a field in that blob is one
 * that an unrelated edit from a stale tab silently clears. For a preference
 * that is a nuisance; for the list deciding what code every agent loads it is
 * the failure the separation exists to prevent.
 */

const KEY = "plugins.enabled";

/**
 * Directories below a mount root that are never worth walking into.
 *
 * Exported because `knowledge.ts` walks a mount for the same reason and would
 * otherwise carry a second copy that drifts — a build directory this list grows
 * and that one does not is a vault index that files a `dist/` tree as notes.
 */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".uf-worktrees",
  ".next",
  "dist",
  "build",
  "vendor",
  "target",
  "__pycache__",
]);

/**
 * How far below a mount root to look.
 *
 * 3 covers the two layouts that actually occur — `<mount>/<repo>` and
 * `<mount>/<org>/<repo>` — without turning session start into a full tree walk
 * of every mount on the box.
 */
const MAX_DEPTH = 3;

export interface PluginManifest {
  name: string;
  version: string | null;
  description: string | null;
}

export interface DiscoveredPlugin extends PluginManifest {
  /** Canonical absolute path, as this process sees it. */
  path: string;
  /** Path relative to its mount root, which is what a person recognises. */
  relPath: string;
  mountId: string;
  mountLabel: string;
  /** What the plugin actually ships, so the page can say what enabling it does. */
  components: string[];
  enabled: boolean;
}

/**
 * Read a `plugin.json` the way the CLI would reject it.
 *
 * Separated from the filesystem walk and exported because every way this goes
 * wrong is quiet: a manifest that fails to parse, or carries no name, yields a
 * directory that `--plugin-dir` accepts and then ignores, and the operator sees
 * a plugin listed as enabled doing nothing at all. Refusing here means the page
 * can say which directory is malformed instead.
 */
export function parsePluginManifest(raw: string): PluginManifest | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `plugin.json is not valid JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "plugin.json is not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return { error: "plugin.json has no name" };
  return {
    name,
    version: typeof obj.version === "string" && obj.version.trim() ? obj.version.trim() : null,
    description:
      typeof obj.description === "string" && obj.description.trim()
        ? obj.description.trim()
        : null,
  };
}

/**
 * The argv fragment for a set of plugin directories.
 *
 * Pure and tested for two failure modes that are both silent. An empty list
 * must produce **no** flag rather than a bare `--plugin-dir` with nothing after
 * it, which the CLI reads as the next argument being the path — that would
 * consume `--permission-mode` and hand the run a permission mode of nobody's
 * choosing. And the flag has to repeat per directory rather than take a joined
 * list, which is the shape `claude --help` documents.
 */
export function pluginDirArgs(dirs: readonly string[]): string[] {
  const args: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    args.push("--plugin-dir", dir);
  }
  return args;
}

/**
 * Containment, per mount, both phases.
 *
 * This mirrors `resolveInMount` in `orchestrator.ts` rather than calling it:
 * `orchestrator` imports this module for the spawn argv, so importing back
 * would close a cycle. The duplication is deliberate and the two phases are
 * load-bearing exactly as they are there — the lexical check first, so an
 * escape reports as an escape rather than as whatever ENOENT it produces, and
 * again after `realpathSync`, because a symlink inside the root can still point
 * out of it.
 *
 * It runs at *read* time and not only when a plugin is switched on, because
 * what this path becomes is `--plugin-dir` — a directory whose hooks the
 * container then executes. A stored path is re-proved before it is used.
 */
function containedIn(mount: WorkspaceMount, input: string): string | null {
  let root: string;
  try {
    root = fs.realpathSync(mount.path);
  } catch {
    return null;
  }
  const contained = (p: string) => {
    const rel = path.relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const candidate = path.resolve(root, input);
  if (!contained(candidate)) return null;
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (!contained(real)) return null;
  return real;
}

/** The mount a canonical path belongs to, or null if it is inside none of them. */
function mountFor(p: string): { mount: WorkspaceMount; real: string } | null {
  for (const mount of WORKSPACE_MOUNTS) {
    const real = containedIn(mount, p);
    if (real) return { mount, real };
  }
  return null;
}

function readManifestAt(dir: string): PluginManifest | { error: string } {
  const manifest = path.join(dir, ".claude-plugin", "plugin.json");
  let raw: string;
  try {
    raw = fs.readFileSync(manifest, "utf8");
  } catch (err) {
    return { error: `cannot read .claude-plugin/plugin.json: ${(err as Error).message}` };
  }
  return parsePluginManifest(raw);
}

/**
 * What the plugin ships, named the way the CLI's own `plugin details` names it.
 *
 * Worth surfacing because the kinds differ in what enabling one costs. Skills,
 * agents and MCP servers put definitions into every session's context; hooks
 * and commands do not. An operator deciding whether to switch something on for
 * twenty-five unattended agents should be able to see which they are getting.
 */
function componentsAt(dir: string): string[] {
  const found: string[] = [];
  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(dir, rel));
    } catch {
      return false;
    }
  };
  if (has("hooks/hooks.json")) found.push("hooks");
  if (has("skills")) found.push("skills");
  if (has("agents")) found.push("agents");
  if (has("commands")) found.push("commands");
  if (has(".mcp.json")) found.push("mcp");
  return found;
}

function isPluginDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, ".claude-plugin", "plugin.json")).isFile();
  } catch {
    return false;
  }
}

/** Enabled paths as stored, without proving any of them. */
function storedPaths(): string[] {
  const raw = getJSON<unknown>(KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => String(p)).filter(Boolean);
}

/**
 * Every plugin directory under the workspace mounts, with its on/off state.
 *
 * A directory that holds a manifest but a broken one is **listed with its
 * error** rather than skipped. Skipping it is the behaviour that leaves an
 * operator staring at a mounted plugin that never appears with nothing to
 * explain why.
 */
export function discoverPlugins(): { plugins: DiscoveredPlugin[]; problems: string[] } {
  const enabled = new Set(storedPaths());
  const plugins: DiscoveredPlugin[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const mount of WORKSPACE_MOUNTS) {
    let root: string;
    try {
      root = fs.realpathSync(mount.path);
    } catch {
      problems.push(`Mount "${mount.label}" is not available at ${mount.path}.`);
      continue;
    }

    const walk = (dir: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        // `.claude-plugin` is looked *for*, never walked into, and the rest of
        // the dot-directories are noise.
        if (entry.name.startsWith(".")) continue;

        const child = path.join(dir, entry.name);
        if (isPluginDir(child)) {
          if (seen.has(child)) continue;
          seen.add(child);
          const manifest = readManifestAt(child);
          if ("error" in manifest) {
            problems.push(`${path.relative(root, child)}: ${manifest.error}`);
            continue;
          }
          plugins.push({
            ...manifest,
            path: child,
            relPath: path.relative(root, child),
            mountId: mount.id,
            mountLabel: mount.label,
            components: componentsAt(child),
            enabled: enabled.has(child),
          });
          // A plugin does not nest inside another plugin.
          continue;
        }
        walk(child, depth + 1);
      }
    };

    if (isPluginDir(root)) {
      const manifest = readManifestAt(root);
      if (!("error" in manifest) && !seen.has(root)) {
        seen.add(root);
        plugins.push({
          ...manifest,
          path: root,
          relPath: ".",
          mountId: mount.id,
          mountLabel: mount.label,
          components: componentsAt(root),
          enabled: enabled.has(root),
        });
      }
    }
    walk(root, 1);
  }

  // An enabled path that no longer discovers is reported rather than dropped:
  // a repository renamed or unmounted otherwise takes its plugin with it and
  // the only symptom is agents quietly behaving differently.
  const found = new Set(plugins.map((p) => p.path));
  for (const p of enabled) {
    if (!found.has(p)) problems.push(`Enabled plugin is no longer present: ${p}`);
  }

  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins, problems };
}

/**
 * Switch one plugin on or off.
 *
 * The path is proved contained **before** it is stored, so a path that never
 * belonged in a mount cannot sit in the row waiting to be handed to a spawn.
 * It is proved again on the way out, in `enabledPluginDirs` — a mount can be
 * repointed under a stored path, and only the check at use time sees that.
 */
export function setPluginEnabled(input: string, enabled: boolean): string {
  const resolved = mountFor(input);
  if (!resolved) {
    throw new Error(`Plugin directory is not inside a workspace mount: ${input}`);
  }
  if (!isPluginDir(resolved.real)) {
    throw new Error(`Not a plugin directory (no .claude-plugin/plugin.json): ${input}`);
  }
  const manifest = readManifestAt(resolved.real);
  if ("error" in manifest) {
    throw new Error(`Cannot enable ${input}: ${manifest.error}`);
  }

  const next = new Set(storedPaths());
  if (enabled) next.add(resolved.real);
  else next.delete(resolved.real);
  setJSON(KEY, [...next].sort());
  return resolved.real;
}

/**
 * The directories to hand a spawn, and the enabled ones that did not survive.
 *
 * `missing` is returned rather than swallowed so the caller can put it where an
 * operator will see it. A plugin that stops being passed is invisible from the
 * outside — the agent simply behaves as it did before the plugin existed — and
 * that is the whole failure mode this feature has to avoid reproducing.
 */
export function enabledPluginDirs(): { dirs: string[]; missing: string[] } {
  const dirs: string[] = [];
  const missing: string[] = [];
  for (const stored of storedPaths()) {
    const resolved = mountFor(stored);
    if (!resolved || !isPluginDir(resolved.real)) {
      missing.push(stored);
      continue;
    }
    dirs.push(resolved.real);
  }
  return { dirs, missing };
}
