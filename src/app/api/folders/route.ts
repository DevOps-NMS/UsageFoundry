import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_MOUNTS, WORKSPACE_ROOT, type WorkspaceMount } from "@/lib/config";
import type { WorkspaceFolderDTO, WorkspaceMountDTO } from "@/lib/apiTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-mount cap on listed folders. A mount pointed at a large tree would
 * otherwise turn every page load into a full walk and a megabyte of JSON; the
 * response says when it truncated rather than silently showing a partial list.
 */
const MAX_FOLDERS_PER_MOUNT = 400;

/**
 * List candidate project folders in every configured workspace mount.
 *
 * Only descends two levels: deep enough to find `org/repo` layouts, shallow
 * enough that a large mount does not turn a page load into a full tree walk.
 */
export async function GET() {
  const mounts: WorkspaceMountDTO[] = [];
  const folders: WorkspaceFolderDTO[] = [];

  async function scan(mount: WorkspaceMount, dir: string, depth: number, count: { n: number }) {
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

      folders.push({
        mountId: mount.id,
        path: path.relative(mount.path, full),
        name: e.name,
        isGitRepo,
      });
      count.n += 1;

      // A repo is a leaf for our purposes — don't enumerate its subdirectories.
      if (!isGitRepo && depth < 2) await scan(mount, full, depth + 1, count);
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
    });
  }

  folders.sort(
    (a, b) =>
      WORKSPACE_MOUNTS.findIndex((m) => m.id === a.mountId) -
        WORKSPACE_MOUNTS.findIndex((m) => m.id === b.mountId) ||
      a.path.localeCompare(b.path),
  );

  // `root` predates multiple mounts and still names the first one.
  return NextResponse.json({ root: WORKSPACE_ROOT, mounts, folders });
}
