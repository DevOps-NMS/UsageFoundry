import { NextResponse } from "next/server";
import { getRun } from "@/lib/orchestrator";
import { listReviews, startReview } from "@/lib/review";
import { auditMutation } from "../../../../../lib/requestLog";
import { jsonMaybeGzipped } from "../../../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Every review of this run, newest first. Cheap: one indexed read. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Gzipped: `text` is a whole model-written review per row and nothing caps
  // how many rows a run accumulates, so this is prose that only grows. A run
  // with no review at all answers 14 bytes and stays under the floor.
  return jsonMaybeGzipped(req, {
    reviews: listReviews(id, "review").map((r) => ({
      id: r.id,
      kind: r.kind,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      status: r.status,
      model: r.model,
      costUSD: r.cost_usd,
      tokens: r.tokens,
      text: r.text,
      error: r.error,
      diffFiles: r.diff_files,
      diffShown: r.diff_shown,
      truncated: r.truncated === 1,
      // Both belong to a conflict resolution. This route serves reviews only,
      // and a review changes nothing by construction.
      paths: [],
      changed: null,
    })),
  });
}

/**
 * Start one. Spends money, so it exists only behind a deliberate POST — there
 * is no code path anywhere that reaches it on its own.
 *
 * Returns as soon as the child is on its way rather than holding the connection
 * for the minutes a review takes; the row is the handle and the page polls it.
 * Refusals are 400 with a sentence, because each one names something the
 * operator can act on: a window already spent, a review already running, or a
 * run with nothing committed to review.
 */
async function postHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outcome = await startReview(id);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, id: outcome.id });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
