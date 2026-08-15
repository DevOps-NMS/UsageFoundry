// Relative, not "@/…", for `src/app/api/health/route.ts`'s reason: a route a
// test loads has to import the way src/lib does.
import { jsonNoStore } from "../../../lib/http";
import { statusReport } from "../../../lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the fleet is doing, for something that is not a person.
 *
 * **Its own credential, and that is the point.** Every other stateful route
 * here sits behind `UF_AUTH_TOKEN`, which is the token that can also start
 * billed agents — so wiring a monitor to poll one of them means handing a
 * scraper the master key. `UF_STATUS_TOKEN` is a second, read-only credential
 * that reaches this route and nothing else.
 *
 * `middleware.ts` exempts this path **only while that variable is set**, and
 * this check is the other half of that exemption — the arrangement `/api/mcp`
 * already uses, and it must stay together for the same reason. With no
 * `UF_STATUS_TOKEN` configured there is no exemption and this route sits behind
 * the ordinary gate like everything else, so the failure of an operator who
 * never set one is "my monitor gets a 401", not "my status is public".
 *
 * The comparison is constant-time and against a single configured value, for
 * `middleware.ts`'s reason: a `!==` on a secret leaks its prefix through
 * timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(req: Request): boolean {
  const statusToken = process.env.UF_STATUS_TOKEN ?? "";
  // No read-only token configured: middleware did not exempt this path, so
  // anything reaching here already carried UF_AUTH_TOKEN.
  if (!statusToken) return true;

  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer && timingSafeEqual(bearer, statusToken)) return true;

  // The master token still works, so an operator with a browser session does
  // not have to find the monitor's credential to read this page's data.
  const appToken = process.env.UF_AUTH_TOKEN ?? "";
  if (appToken && bearer && timingSafeEqual(bearer, appToken)) return true;
  const cookie = /(?:^|;\s*)uf_session=([^;]*)/.exec(
    req.headers.get("cookie") ?? "",
  )?.[1];
  return Boolean(appToken && cookie && timingSafeEqual(cookie, appToken));
}

export async function GET(req: Request) {
  if (!authorised(req)) {
    return jsonNoStore({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonNoStore(await statusReport());
}
