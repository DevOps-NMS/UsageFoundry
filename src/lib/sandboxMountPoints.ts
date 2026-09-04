import fs from "node:fs";
import path from "node:path";
import { chownForChild } from "./privsep";

/**
 * The empty files the CLI's sandbox needs to find, so that constructing one
 * does not fail.
 *
 * Claude Code's sandbox makes its own configuration surface unwritable by
 * bind-mounting `/dev/null` over a fixed list of paths **inside every tree it
 * exposes** — an agent that can rewrite `settings.json`, `hooks/` or `skills/`
 * can rewrite its own permission boundary, so the boundary is overmounted
 * rather than merely denied. bwrap needs a target inode for each of those
 * binds, and creates one where it finds nothing. When that create is refused it
 * aborts the whole sandbox, **before the command runs at all** — which reaches
 * this app as a `Bash` tool call that failed with bwrap's exit code and an
 * error naming a settings file the command never touched:
 *
 *     Exit code 1
 *     bwrap: Can't create file at /workspace/.uf-worktrees/x-1/.claude/skills: Permission denied
 *
 * Measured on this install: 255 such results over 2026-08-25 to 2026-09-04,
 * 15-56 a day, naming 261 paths between them, 252 of which are one of the
 * twelve names below inside a project tree. The commands were `cat`, `sed -n`,
 * `grep` and `git log`.
 *
 * Creating the mount points first removes the step that fails. It cannot make
 * the sandbox weaker: an empty file that gets `/dev/null` bound over it is
 * exactly what bwrap would have made itself, and the twelve paths are
 * unreadable inside any sandboxed session either way.
 *
 * Why *all twelve* rather than the ones seen failing: bwrap stops at the first
 * mount point it cannot create, so the name in the message is whichever it
 * reached first. Leaving one out moves the failure rather than removing it.
 *
 * **The config directory is deliberately not covered.** Eight of the 261 name
 * `policy-limits.json`, `local`, `seed-admin` or `mcp-skill-archives` under
 * `$CLAUDE_CONFIG_DIR`, and the sandbox's
 * list for that directory also holds `CLAUDE.md`, `projects` and `plugins` —
 * the operator's own global memory, their transcripts and their installed
 * plugins, in a bind mount of their real `~/.claude`. Creating empty files
 * under those names to save 3% of the failures is a trade nothing here should
 * make.
 *
 * Read out of the CLI's own sandbox construction at 2.1.260, and confirmed
 * against what a live sandboxed session leaves on disk: each of these paths is
 * a character device with `rdev=1,3` while a session holds it. The list is
 * therefore *this* CLI's, and a version that adds a name would start failing on
 * it again — visibly, as the same error, which is the direction that can be
 * noticed.
 */
export const SANDBOX_MOUNT_POINT_NAMES: readonly string[] = [
  "settings.json",
  "settings.local.json",
  "skills",
  "commands",
  "agents",
  "hooks",
  "launch.json",
  "workflows",
  "routines",
  "output-styles",
  "scheduled_tasks.json",
  "loop.md",
];

/**
 * What keeps the placeholders out of the run's own commits.
 *
 * An isolated run is ordered to commit, and `git add -A` stages whatever is
 * untracked: without this, twelve empty files would land on the run's branch in
 * the eleven of fourteen repositories here whose `.gitignore` says nothing
 * about `.claude/`. Worse than noise — an empty file named `skills` is a
 * directory that no longer works for whoever checks that branch out.
 *
 * A `.gitignore` *inside* `.claude/` rather than a line in the repository's own
 * or in `.git/info/exclude`: the first is a tracked file this app must not
 * edit, and the second is shared with the operator's checkout by every linked
 * worktree (git reads `info/exclude` from the common directory, not the
 * worktree's). This file is confined to the directory the placeholders are in.
 *
 * The entries are anchored and named one by one rather than written as `*`, so
 * that a repository which genuinely tracks something under `.claude/` keeps
 * seeing it. Ignoring cannot hide a *tracked* file in any case; what it hides
 * is a new untracked one at exactly one of the twelve paths, and at those paths
 * a placeholder is already in the way.
 */
const GITIGNORE_BODY = [
  "# Written by UsageFoundry, and safe to delete when nothing here is a run's",
  "# checkout. These are the paths Claude Code's sandbox binds /dev/null over;",
  "# they exist as empty files only so constructing the sandbox does not fail on",
  "# creating them. Ignored so that a run's `git add -A` cannot commit them.",
  "/.gitignore",
  "/.cc-writes/",
  ...SANDBOX_MOUNT_POINT_NAMES.map((name) => `/${name}`),
  "",
].join("\n");

/**
 * Which trees the sandbox will neutralise, given one the child is spawned with.
 *
 * The CLI walks from the working directory to the filesystem root and applies
 * the list at every level, which is why a run in `.uf-worktrees/x-1` fails on
 * `/workspace/.claude/settings.local.json` — the mounts' parent, and the single
 * most frequent path in the measurement above.
 *
 * The ancestor half is **guarded on `.claude` already existing**, and that is
 * this function's whole containment argument rather than an optimisation: the
 * CLI guards it the same way, so an ancestor without one is not a tree the
 * sandbox touches, and creating a `.claude` there would be this app inventing a
 * configuration directory in somebody's home or at `/`. Only the directory the
 * child actually runs in gets one made for it, and the CLI makes that one
 * anyway for its own atomic-write staging.
 *
 * Pure, with the filesystem passed in, because both ways of being wrong are
 * silent: too few directories and the failures continue with nothing saying
 * why, too many and this app writes into trees nobody asked it to.
 */
export function sandboxMountPointDirs(
  cwd: string,
  hasClaudeDir: (dir: string) => boolean,
): string[] {
  const dirs = [cwd];
  for (let dir = path.dirname(cwd); ; dir = path.dirname(dir)) {
    if (hasClaudeDir(dir)) dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
  }
  return dirs;
}

/** What one pass did, for the run's log. */
export interface MountPointResult {
  /** Absolute paths created, empty when there was nothing left to create. */
  created: string[];
  /** What could not be created, as `<path>: <reason>`. */
  problems: string[];
}

/** True when `<dir>/.claude` is a directory, and false for every other answer. */
function hasClaudeDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, ".claude")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create what is missing in one tree, and say what happened.
 *
 * `wx` rather than a check and a write: two cycles can be spawned against
 * neighbouring trees at once, and an existence test followed by a truncating
 * write is how a placeholder becomes a way to empty a file somebody else just
 * put there. `EEXIST` is the ordinary answer here and is not a problem.
 *
 * Owned by the child's uid for `chownForChild`'s reason at every other write
 * this server makes into a bind mount: the server is root under compose and the
 * agent is not, and a root-owned file in the tree an agent works in is a
 * surprise waiting for whoever hits it. It is not load-bearing for the mount
 * itself — bwrap binds over a file it does not own — so a chown that fails is
 * reported and the placeholder kept, rather than thrown the way `seedWorktree`
 * throws for a checkout the agent must be able to write.
 */
function fillOneTree(dir: string, result: MountPointResult): void {
  const claude = path.join(dir, ".claude");
  let madeSomething = false;
  for (const name of SANDBOX_MOUNT_POINT_NAMES) {
    const target = path.join(claude, name);
    try {
      fs.writeFileSync(target, "", { flag: "wx" });
      result.created.push(target);
      madeSomething = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") continue;
      result.problems.push(`${target}: ${(err as Error).message}`);
      continue;
    }
    try {
      chownForChild(target);
    } catch (err) {
      result.problems.push(`${target}: created, but ${(err as Error).message}`);
    }
  }

  // This tree's own count, not the run's: a second tree that needed nothing
  // must not get a `.gitignore` because the first one did.
  if (!madeSomething) return;
  try {
    fs.writeFileSync(path.join(claude, ".gitignore"), GITIGNORE_BODY, { flag: "wx" });
    chownForChild(path.join(claude, ".gitignore"));
  } catch (err) {
    // EEXIST is the second run in the same tree and means the file this would
    // have written is already there. Anything else leaves the placeholders in
    // place and visible to git, which is worth a line on the log.
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
      result.problems.push(`${claude}/.gitignore: ${(err as Error).message}`);
    }
  }
}

/**
 * Give the sandbox its mount points in every tree a child is about to be handed.
 *
 * Called immediately before the spawn rather than once when a checkout is made:
 * what has to be true is the state of the tree at the moment bwrap constructs
 * the sandbox, and between two cycles a session can remove what the last one
 * left. It costs a dozen `open(O_CREAT|O_EXCL)` calls per tree on the first
 * cycle and a dozen `EEXIST`s afterwards.
 *
 * Never throws. Every failure here leaves the install exactly where it was —
 * bwrap tries the create itself and the run behaves as it did before — so
 * refusing to spawn over one would trade a recoverable tool-call failure for an
 * unrecoverable run.
 */
export function ensureSandboxMountPoints(cwds: readonly string[]): MountPointResult {
  const result: MountPointResult = { created: [], problems: [] };
  const seen = new Set<string>();

  for (const cwd of cwds) {
    for (const dir of sandboxMountPointDirs(cwd, hasClaudeDir)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      // Only ever for the working directory itself, and only when it is not
      // already there: `sandboxMountPointDirs` returns an ancestor only when it
      // has one, and an existing directory is the operator's or the CLI's — not
      // this app's to re-own.
      if (!hasClaudeDir(dir)) {
        try {
          fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
          chownForChild(path.join(dir, ".claude"));
        } catch (err) {
          result.problems.push(`${dir}/.claude: ${(err as Error).message}`);
          continue;
        }
      }
      fillOneTree(dir, result);
    }
  }

  return result;
}
