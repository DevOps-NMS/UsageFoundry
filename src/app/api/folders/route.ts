import { NextResponse } from "next/server";
import { WORKSPACE_ROOT } from "@/lib/config";
import { scanWorkspace } from "@/lib/workspace";

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
export async function GET() {
  const { mounts, folders } = await scanWorkspace();
  // `root` predates multiple mounts and still names the first one.
  return NextResponse.json({ root: WORKSPACE_ROOT, mounts, folders });
}
