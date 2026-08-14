import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib and the chat route already do.
import { AUTH_TOKEN, COOKIE_SECURE, authEnabled } from "../../../lib/config";
import { createSession } from "../../../lib/sessions";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cookieIsSecure,
  mintSessionCookie,
  newSessionId,
} from "../../../lib/sessionToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!authEnabled()) {
    // Deliberately not a success. This used to answer `{ ok: true }` with an
    // `authDisabled` flag nothing read, so signing in with any string at all
    // looked exactly like signing in — the one screen in this app whose whole
    // subject is the credential said nothing about there not being one. There
    // is no session to issue either: with no token there is nothing to sign a
    // cookie with, so a cookie here would be theatre.
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

  // A handle, not the secret. The cookie used to be UF_AUTH_TOKEN byte for
  // byte, so the browser jar held a thirty-day copy of the credential that
  // opens every route as a bearer header — and the only way to invalidate it
  // was to change the environment variable and restart, killing every run in
  // flight. See sessionToken.ts for what the value is and what it proves.
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const session = createSession(newSessionId(), expiresAt);
  const value = await mintSessionCookie(session.id, expiresAt, AUTH_TOKEN);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    // Conditional rather than off. Off was right for `http://localhost`, where
    // a Secure cookie is never sent back, and wrong everywhere else: without it
    // the cookie rides any plain-HTTP request to a host that also serves TLS,
    // which is the downgrade the flag exists to prevent. Behind a terminator
    // this process sees plain HTTP, so the forwarded protocol is what answers.
    secure: cookieIsSecure({
      forwardedProto: req.headers.get("x-forwarded-proto"),
      protocol: new URL(req.url).protocol,
      override: COOKIE_SECURE,
    }),
  });
  return res;
}
