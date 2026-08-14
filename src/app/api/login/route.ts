import { NextResponse } from "next/server";
import { AUTH_TOKEN, authEnabled } from "@/lib/config";
import { auditMutation } from "../../../lib/requestLog";

export const runtime = "nodejs";

async function postHandler(req: Request) {
  if (!authEnabled()) {
    return NextResponse.json({ ok: true, authDisabled: true });
  }

  const body = (await req.json().catch(() => ({}))) as { token?: string };
  if (body.token !== AUTH_TOKEN) {
    // Uniform delay keeps a wrong token from being distinguishable by timing.
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("uf_session", AUTH_TOKEN, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    // Left off deliberately: this is commonly served over plain HTTP on
    // localhost, where a Secure cookie would never be sent back.
    secure: false,
  });
  return res;
}

/**
 * Wrapped for the *failures*. A burst of 401s from one address is the earliest
 * evidence of somebody trying tokens, and it was recorded nowhere. The wrapper
 * logs the status and the source address and never the body, which on this one
 * route is the token itself.
 */
export const POST = auditMutation(postHandler);
