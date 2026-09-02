import { jsonNoStore } from "@/lib/http";
import { scanTouchSequence } from "@/lib/runTouchScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The order this run's tool events named files in, one entry per call.
 *
 * Its own payload rather than a field on `touched` beside it, and the argument
 * is who reads each. `touched` is fetched by the Files tab on every run page and
 * draws one row per file; this is one row per *call*, so folding it into that
 * answer would multiply the tab's payload by however many times the busiest file
 * was read, for rows the table has nowhere to put. Only the map at
 * `/runs/[id]/touched` scrubs, and only that page asks for this.
 *
 * A bare list rather than the `kind` union `touched` answers with, because the
 * three ways of having nothing have already been told apart by the time anything
 * reads this: the map draws only on `touched`'s `report` and `empty`-with-a-diff
 * cases, and a swept or missing run never gets as far as a scrubber. An empty
 * array here means the run named no file, which is the sentence that page is
 * already showing above the map.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return jsonNoStore({ sequence: scanTouchSequence(id) });
}
