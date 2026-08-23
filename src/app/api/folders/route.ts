import { WORKSPACE_ROOT } from "@/lib/config";
import { scanWorkspace } from "@/lib/workspace";
import { jsonMaybeGzipped } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List candidate project folders in every configured workspace mount.
 *
 * The walk itself lives in `lib/workspace.ts` because the orchestrator chat
 * asks the same question through an MCP tool, and two implementations of "what
 * folders exist and who is in them" would drift into the chat proposing runs
 * against folders this form refuses.
 */
export async function GET(req: Request) {
  const { mounts, folders } = await scanWorkspace();
  // Gzipped: 8,261 bytes to 915, measured — a folder list is mostly one shared
  // path prefix repeated, which is the case deflate is best at.
  // `root` predates multiple mounts and still names the first one.
  return jsonMaybeGzipped(req, { root: WORKSPACE_ROOT, mounts, folders });
}
