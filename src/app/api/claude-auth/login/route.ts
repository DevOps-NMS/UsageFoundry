import { NextResponse } from "next/server";
import { beginLogin, cancelLogin } from "@/lib/claudeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a sign-in and answer with the link to open.
 *
 * The child that printed the link stays alive behind this response holding the
 * PKCE verifier, which is why this is a POST with a side effect rather than a
 * read that happens to compute a URL: pressing it twice abandons the first
 * link, and a code issued against the abandoned one can no longer be redeemed.
 *
 * 502 rather than 500 on failure: everything that can go wrong here went wrong
 * in the CLI, and the body carries its own sentence about it.
 */
export async function POST() {
  const res = await beginLogin();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json(res.value);
}

/**
 * Abandon a sign-in without completing it.
 *
 * Exists so a closed dialog does not leave a child waiting ten minutes on a
 * line nobody will type — and so the page never has to show a link the
 * operator has already walked away from.
 */
export async function DELETE() {
  cancelLogin();
  return NextResponse.json({ ok: true });
}
