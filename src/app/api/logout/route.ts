import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the login route.
import { AUTH_TOKEN, COOKIE_SECURE, authEnabled } from "../../../lib/config";
import { revokeAllSessions, revokeSession } from "../../../lib/sessions";
import {
  SESSION_COOKIE,
  cookieIsSecure,
  readSessionCookie,
} from "../../../lib/sessionToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * End a session.
 *
 * There was nothing to end before: the cookie *was* `UF_AUTH_TOKEN`, so the
 * only way to invalidate an issued one was to change the environment variable
 * and restart the container — which kills every run in flight for a credential
 * that leaked. Now a sign-in is a row, and this is what closes it.
 *
 * `all: true` closes every outstanding one, which is the operator action for a
 * cookie that got out rather than for the browser in front of you.
 *
 * Exempt from `middleware.ts` on purpose: signing out must not require a valid
 * session, or the one state you can never leave is the one where your cookie
 * has gone stale. It grants nothing — the id it revokes comes from the cookie
 * the caller already holds, and `all` only ever *removes* access.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { all?: boolean };

  if (authEnabled()) {
    if (body.all === true) {
      revokeAllSessions();
    } else {
      const cookie = readCookie(req);
      const claim = cookie
        ? await readSessionCookie(cookie, AUTH_TOKEN, Date.now())
        : null;
      if (claim) revokeSession(claim.id);
    }
  }

  const res = NextResponse.json({ ok: true });
  // Cleared with the same attributes it was set with: a browser matches a
  // deletion on name, path and domain, so a `path` that disagreed would leave
  // the cookie in the jar and the sign-out silently half done.
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: cookieIsSecure({
      forwardedProto: req.headers.get("x-forwarded-proto"),
      protocol: new URL(req.url).protocol,
      override: COOKIE_SECURE,
    }),
  });
  return res;
}

/** A plain `Request` has no cookie jar, only the header. */
function readCookie(req: Request): string {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return "";
}
