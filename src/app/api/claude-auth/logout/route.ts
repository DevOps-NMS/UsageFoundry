import { NextResponse } from "next/server";
import type { ClaudeAuthDTO } from "@/lib/apiTypes";
import { signOut } from "@/lib/claudeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign the container's Claude Code out.
 *
 * Nothing here checks for runs in flight, and that is deliberate rather than
 * missing: this is also the control an operator reaches for when a credential
 * has leaked, and a sign-out that refused while any run existed would be
 * unreachable at exactly the moment it is most needed. What it costs is stated
 * where it is pressed — every run still working will end on `Not logged in` —
 * and the page confirms before sending this.
 *
 * Distinct from `/api/logout`, which ends a *session of this app*. The two are
 * separate credentials and the Settings page keeps them in separate rows.
 */
export async function POST() {
  const res = await signOut();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  const auth: ClaudeAuthDTO = res.value;
  return NextResponse.json({ auth });
}
