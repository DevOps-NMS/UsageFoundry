import { NextResponse } from "next/server";
import { AUTH_TOKEN, authEnabled } from "@/lib/config";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!authEnabled()) {
    // Deliberately not a success. This used to answer `{ ok: true }` with an
    // `authDisabled` flag nothing read, so signing in with any string at all
    // looked exactly like signing in — the one screen in this app whose whole
    // subject is the credential said nothing about there not being one. There
    // is no session to issue either: with no token there is nothing for the
    // gate to compare a cookie against, so a cookie here would be theatre.
    return NextResponse.json(
      {
        authDisabled: true,
        error:
          "Authentication is disabled on this server: UF_AUTH_TOKEN is unset, " +
          "so no token is required and none is being checked.",
      },
      { status: 409 },
    );
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
