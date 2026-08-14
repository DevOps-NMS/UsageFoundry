import { NextResponse, type NextRequest } from "next/server";

/**
 * Shared-secret gate.
 *
 * This app holds Claude credentials and can execute an agent with write access
 * to mounted code, so it is not something to leave open on a LAN. Auth is on
 * whenever UF_AUTH_TOKEN is set; leaving it unset is only appropriate when the
 * port is bound to loopback.
 *
 * Runs in the edge runtime, so it reads process.env directly rather than
 * importing lib/config (which pulls in node:os / node:path).
 */

const COOKIE = "uf_session";

function timingSafeEqual(a: string, b: string): boolean {
  // Length is not secret here, but keep the comparison constant-time over the
  // shorter of the two to avoid leaking a prefix match.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const token = process.env.UF_AUTH_TOKEN ?? "";
  if (!token) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") {
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

  const cookie = req.cookies.get(COOKIE)?.value ?? "";
  if (cookie && timingSafeEqual(cookie, token)) return NextResponse.next();

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
