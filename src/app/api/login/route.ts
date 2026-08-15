import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib and the chat route already do.
import { AUTH_TOKEN, COOKIE_SECURE, authEnabled } from "../../../lib/config";
import {
  checkLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
} from "../../../lib/loginAttempts";
import { auditMutation } from "../../../lib/requestLog";
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

const uniformDelay = () => new Promise((r) => setTimeout(r, 400));

/**
 * Constant-time, because `middleware.ts` goes to the trouble for the same
 * secret and two paths comparing one token should not differ in how.
 *
 * The 400 ms sleep does mask the difference in practice — this is nanoseconds
 * against that floor — so the reason to fix it is that the app already owns the
 * primitive, and a `!==` beside a hand-written constant-time helper is an
 * invitation to copy the wrong one next time.
 */
function tokenMatches(offered: unknown): boolean {
  if (typeof offered !== "string") return false;
  const a = Buffer.from(offered);
  const b = Buffer.from(AUTH_TOKEN);
  // Length is not secret, and `timingSafeEqual` throws on a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Who is guessing, as far as this process can tell.
 *
 * `x-forwarded-for` is set by a reverse proxy and is *also* settable by a
 * client when there is no proxy in front, so this bucket can be evaded by
 * rotating the header. That is not a flaw in reading it — there is nothing
 * better available to a Node process behind an arbitrary terminator — it is the
 * reason the install-wide budget in `loginLimiter.ts` exists.
 */
function clientSource(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0].trim();
  if (first) return first.slice(0, 100);
  const real = (req.headers.get("x-real-ip") ?? "").trim();
  return real ? real.slice(0, 100) : "unknown";
}

async function postHandler(req: Request) {
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

  // Before the body is even read, and long before the token is compared: a
  // caller inside a lockout must learn nothing at all about their guess.
  const source = clientSource(req);
  const verdict = checkLoginAllowed(source);
  if (!verdict.allow) {
    await uniformDelay();
    // The same body as a wrong token, on purpose — the two must not be
    // distinguishable by what an attacker can read out of the response. The
    // status differs because a caller who *is* the operator needs to know that
    // waiting will help, and Retry-After is what says how long.
    return NextResponse.json(
      { error: "Invalid token" },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil(verdict.retryAfterMs / 1000)) },
      },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { token?: string };
  if (!tokenMatches(body.token)) {
    recordLoginFailure(source);
    // Uniform delay keeps a wrong token from being distinguishable by timing.
    // It is not the rate limit and never was: it is an `await` on a timer, so
    // it delays one request and serialises nothing.
    await uniformDelay();
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  clearLoginFailures(source);

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

/**
 * Wrapped for the *failures*. A burst of 401s from one address is the earliest
 * evidence of somebody trying tokens, and it was recorded nowhere. The wrapper
 * logs the status and the source address and never the body, which on this one
 * route is the token itself.
 */
export const POST = auditMutation(postHandler);
