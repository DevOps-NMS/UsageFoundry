// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib already does.
import { healthReport } from "../../../lib/health";
import { jsonNoStore } from "../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness probe. Unauthenticated, and exempt in `middleware.ts` — the comment
 * beside that exemption states why it is safe and what must never be added
 * here. Keep the two together.
 *
 * `healthReport` documents in full what this does and does not detect. The one
 * thing worth repeating at the route: a server whose event loop is blocked
 * outright never reaches this handler at all, so what catches that case is the
 * probe's own timeout rather than anything in the body.
 *
 * 503 rather than 500 for an unhealthy answer: this is a statement about the
 * server's own state, not about the request that asked.
 */
export async function GET() {
  const report = await healthReport();
  return jsonNoStore(report, { status: report.ok ? 200 : 503 });
}
