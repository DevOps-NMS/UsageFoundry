import { jsonNoStore } from "@/lib/http";
import { touchesFor } from "@/lib/runTouchScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What this run's tool events say it touched.
 *
 * Its own route rather than a field on `GET /api/runs/[id]`, for that route's
 * own reason: the run row is polled every three seconds by every open run page,
 * and this is an index range scan over a table written on every tool call of
 * every cycle. It is fetched once, when the Files tab is opened.
 *
 * Only the touch half. The diff half is the numstat the tab has already loaded,
 * and reconciling here would mean a second `runDiff` — several more git
 * processes for a file list the page is holding.
 *
 * Having nothing to say is a 200 with a `kind` naming which nothing it is,
 * never a 404 or a 500, on the same grounds as the diff route beside it: a run
 * whose events aged out, a run that named no file and a run that no longer
 * exists are three ordinary outcomes that render identically as an empty list.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return jsonNoStore({ touched: touchesFor(id) });
}
