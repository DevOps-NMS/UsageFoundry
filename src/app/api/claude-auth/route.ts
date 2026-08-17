import { NextResponse } from "next/server";
import type { ClaudeAuthStateDTO } from "@/lib/apiTypes";
import { pendingLogin, readAuthStatus } from "@/lib/claudeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who the container's Claude Code is signed in as.
 *
 * Its own route rather than a field on `GET /api/settings` for the reason
 * `/api/storage` is its own: that one is read on every load of a form somebody
 * is about to save, and this spawns a process. It is also the one block on the
 * Settings page that changes without the form being touched — a sign-in
 * finishing, a credential expiring — so it reloads on its own.
 *
 * Never cached. `AccountProfileDTO` holds its reading for 60 s because a plan
 * name does not move; this answer moves the moment either button below is
 * pressed, and a stale "signed in" is exactly the wrong thing to show somebody
 * whose runs have started failing.
 */
export async function GET() {
  const status = await readAuthStatus();
  const body: ClaudeAuthStateDTO = {
    auth: status.ok ? status.value : null,
    error: status.ok ? null : status.error,
    pending: pendingLogin(),
  };
  return NextResponse.json(body);
}
