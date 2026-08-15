import { NextResponse, type NextRequest } from "next/server";
// Edge-safe by construction: Web Crypto and string handling, no node builtins
// and no lib/config. That is what lets the gate below decide about a cookie
// without a database it cannot reach — see the note in that file.
import { SESSION_COOKIE, readSessionCookie } from "./lib/sessionToken";

/**
 * Shared-secret gate.
 *
 * This app holds Claude credentials and can execute an agent with write access
 * to mounted code, so it is not something to leave open on a LAN. Auth is on
 * whenever UF_AUTH_TOKEN is set; leaving it unset makes the server refuse to
 * boot unless UF_ALLOW_NO_AUTH=1 says the operator meant it, so an unset token
 * reaching this function is a state somebody chose and every page announces.
 *
 * Two credentials, and they are deliberately different things. The bearer
 * header is UF_AUTH_TOKEN itself — what a script presents. The cookie is a
 * signed session handle that is *not* the token and cannot be replayed as one,
 * which is the whole of what changed: it used to be a thirty-day plaintext copy
 * of the master secret sitting in a browser jar.
 *
 * The per-turn and per-run capabilities the two exempted paths below take are
 * neither of those, which is why each of them is checked in its own route.
 *
 * Runs in the edge runtime, so it reads process.env directly rather than
 * importing lib/config (which pulls in node:os / node:path).
 */

function timingSafeEqual(a: string, b: string): boolean {
  // Length is not secret here, but keep the comparison constant-time over the
  // shorter of the two to avoid leaking a prefix match.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function middleware(req: NextRequest) {
  const token = process.env.UF_AUTH_TOKEN ?? "";
  if (!token) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") {
    return NextResponse.next();
  }

  // Ending a session must not need one: a cookie whose signature has gone stale
  // is exactly the cookie somebody is trying to clear, and the route revokes
  // only the id it is handed.
  if (pathname === "/api/logout") {
    return NextResponse.next();
  }

  // The orchestrator chat's tool endpoint authenticates itself, because the
  // credential it takes is not this one: it is a capability minted per chat
  // turn and revoked when that turn's child exits, so a leaked copy opens
  // nothing afterwards — where UF_AUTH_TOKEN opens every route in the app for
  // as long as it is set. That check needs SQLite and module state, neither of
  // which exists in the edge runtime, so it cannot happen here.
  //
  // This is an exemption from *this* gate, not from authentication. If the
  // check in `/api/mcp` is ever removed, this line makes the whole tool surface
  // public — keep the two together.
  if (pathname === "/api/mcp") {
    return NextResponse.next();
  }

  // The same exemption, for the same reason, for the telemetry a run exports.
  // The exporter used to authenticate with UF_AUTH_TOKEN — which meant this
  // app's master credential sat in the agent's own environment, in a variable
  // `env` prints, for a Claude Code session with `Bash`. It now carries a
  // capability minted per run, revoked when that run's loop ends, opening
  // nothing but writes to that run's own telemetry.
  //
  // Exemption from *this* gate, not from authentication: the route checks the
  // capability itself, and needs SQLite and module state to do it, neither of
  // which exists in the edge runtime. If that check is ever removed, this line
  // makes `otlp_requests` openly writable — keep the two together.
  if (pathname === "/api/otlp/v1/logs") {
    return NextResponse.next();
  }

  // The signature proves this server issued it and the signed expiry proves it
  // is still inside its window — neither of which a comparison against the
  // token could say, because the token has no window and every copy of it is
  // identical.
  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  if (cookie && (await readSessionCookie(cookie, token, Date.now()))) {
    return NextResponse.next();
  }

  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer && timingSafeEqual(bearer, token)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
