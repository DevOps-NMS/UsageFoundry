import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_MOUNTS, type WorkspaceMount } from "./config";
import { activeRuns, conflictKey, overlaps, workDirOf } from "./orchestrator";
import { git } from "./git";
import type { WorkspaceFolderDTO, WorkspaceMountDTO } from "./apiTypes";

/**
 * What the folder picker sees: every mount, every candidate project folder in
 * it, and who is already working there.
 *
 * Extracted from `/api/folders` when the orchestrator chat needed the same
 * answer through a tool call. It is the same walk with the same caps, so the
 * chat and the picker cannot disagree about what exists or what is busy —
 * which matters more here than it looks: the chat proposes runs against these
 * paths, and a second implementation that drifted would propose folders the
 * form would then refuse.
 */

/**
 * Per-mount cap on listed folders. A mount pointed at a large tree would
 * otherwise turn every page load into a full walk and a megabyte of JSON; the
 * response says when it truncated rather than silently showing a partial list.
 */
export const MAX_FOLDERS_PER_MOUNT = 400;

export interface WorkspaceScan {
  mounts: WorkspaceMountDTO[];
  folders: WorkspaceFolderDTO[];
}

/**
 * List candidate project folders in every configured workspace mount.
 *
 * Only descends two levels: deep enough to find `org/repo` layouts, shallow
 * enough that a large mount does not turn a page load into a full tree walk.
 */
export async function scanWorkspace(): Promise<WorkspaceScan> {
  const mounts: WorkspaceMountDTO[] = [];
  const folders: WorkspaceFolderDTO[] = [];

  // Occupancy is a pure string comparison against the live rows, so annotating
  // every folder costs one query rather than a syscall per candidate.
  const active = activeRuns();
  const activeKeys = active.map((r) => ({
    run: r,
    key: conflictKey(workDirOf(r)),
  }));

  function occupancy(abs: string) {
    const key = conflictKey(abs);
    const hits = activeKeys.filter((a) => overlaps(key, a.key));
    // Reported apart, because they mean different things to someone about to
    // start a run here. A running holder blocks: the new run queues behind it.
    // A parked one does not — it has yielded the folder and takes it back when
    // whatever runs next is finished — but it is still worth naming, since the
    // new run will find the tree changed under it when it resumes.
    const running = hits.find((h) => h.run.status === "running");
    const parked = hits.find((h) => h.run.status === "paused");
    return {
      busyRunId: running?.run.id ?? null,
      parkedRunId: parked?.run.id ?? null,
      queuedCount: hits.filter((h) => h.run.status === "queued").length,
    };
  }

  async function scan(
    mount: WorkspaceMount,
    dir: string,
    depth: number,
    count: { n: number },
  ) {
    if (count.n >= MAX_FOLDERS_PER_MOUNT) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count.n >= MAX_FOLDERS_PER_MOUNT) return;
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      const isGitRepo = await fs
        .stat(path.join(full, ".git"))
        .then(() => true)
        .catch(() => false);

      // A bare repository has no `.git` entry, so the test above misses it and
      // the walk below would offer `objects/`, `refs/`, and `hooks/` as run
      // targets. Detect it and stop, without claiming it is a working tree.
      const isBareRepo =
        !isGitRepo &&
        (await Promise.all([
          fs.stat(path.join(full, "HEAD")).then(() => true).catch(() => false),
          fs.stat(path.join(full, "objects")).then(() => true).catch(() => false),
        ]).then(([head, objects]) => head && objects));

      folders.push({
        mountId: mount.id,
        path: path.relative(mount.path, full),
        name: e.name,
        isGitRepo,
        ...occupancy(full),
      });
      count.n += 1;

      // A repo is a leaf for our purposes — don't enumerate its subdirectories.
      if (!isGitRepo && !isBareRepo && depth < 2) {
        await scan(mount, full, depth + 1, count);
      }
    }
  }

  for (const mount of WORKSPACE_MOUNTS) {
    const count = { n: 0 };
    let available = true;
    let error: string | null = null;

    try {
      const st = await fs.stat(mount.path);
      if (!st.isDirectory()) {
        available = false;
        error = `${mount.path} is not a directory.`;
      }
    } catch {
      available = false;
      error = `Nothing is mounted at ${mount.path}.`;
    }

    if (available) await scan(mount, mount.path, 1, count);

    mounts.push({
      id: mount.id,
      label: mount.label,
      path: mount.path,
      available,
      error,
      folderCount: count.n,
      truncated: count.n >= MAX_FOLDERS_PER_MOUNT,
      // A run started on the mount root overlaps every folder beneath it, so
      // the root carries its own occupancy rather than inheriting a child's.
      ...(available
        ? occupancy(mount.path)
        : { busyRunId: null, parkedRunId: null, queuedCount: 0 }),
    });
  }

  folders.sort(
    (a, b) =>
      WORKSPACE_MOUNTS.findIndex((m) => m.id === a.mountId) -
        WORKSPACE_MOUNTS.findIndex((m) => m.id === b.mountId) ||
      a.path.localeCompare(b.path),
  );

  return { mounts, folders };
}

/**
 * How many repositories one scan will read a remote for.
 *
 * Reading a remote is a git child per folder, so this is a spend of processes
 * rather than of bytes. The picker never pays it — only the chat does, once per
 * turn — but a mount holding two hundred repositories would still fork two
 * hundred times, so it is capped and the caller is told what the cap left out.
 */
export const MAX_REMOTES_READ = 25;

/**
 * `owner/name` for each git repository in a scan, as GitHub would name it.
 *
 * The chat needs this and nothing else about a repository: `gh issue list`
 * takes `--repo owner/name`, so supplying it saves the chat a shell round trip
 * per folder — and, more usefully, saves it *guessing*. It could run `git
 * remote` itself now that it runs without an allowlist; what it could not do is
 * be told when the answer is "this is not a GitHub repository".
 *
 * A remote that is not GitHub, or missing, yields no entry — never a guess. The
 * chat is then told it could not identify the repository, which is a sentence
 * an operator can act on; a wrong `owner/name` is a `gh` call against somebody
 * else's project.
 */
export async function githubRemotes(
  folders: WorkspaceFolderDTO[],
): Promise<{ repos: Record<string, string>; notRead: number }> {
  const candidates = folders.filter((f) => f.isGitRepo);
  const read = candidates.slice(0, MAX_REMOTES_READ);

  const mountPath = new Map(WORKSPACE_MOUNTS.map((m) => [m.id, m.path]));
  const repos: Record<string, string> = {};

  await Promise.all(
    read.map(async (f) => {
      const root = mountPath.get(f.mountId);
      if (!root) return;
      const res = await git(path.join(root, f.path), [
        "remote",
        "get-url",
        "origin",
      ]);
      if (!res.ok) return;
      const slug = githubSlug(res.stdout);
      if (slug) repos[`${f.mountId}:${f.path}`] = slug;
    }),
  );

  return { repos, notRead: candidates.length - read.length };
}

/**
 * `owner/name` out of a git remote URL, or null when it is not GitHub.
 *
 * Pure, and matched against both forms the same repository is cloned with —
 * `git@github.com:owner/name.git` and `https://github.com/owner/name`. Anything
 * else is another host: `githubEnv()` credentials a helper keyed to
 * `https://github.com` and nothing else, so claiming a slug for a GitLab remote
 * would produce a `gh` call that fails for a reason the chat cannot explain.
 */
export function githubSlug(url: string): string | null {
  const m = url
    .trim()
    .match(/^(?:git@github\.com:|(?:ssh:\/\/git@|https?:\/\/)(?:[^@/]*@)?github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}
