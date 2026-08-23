import { NextResponse } from "next/server";
import { knowledgeIndex, resolveKnowledgeRoot, searchKnowledge } from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";
import { jsonMaybeGzipped } from "../../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Notes whose title, alias, tag or path contains `?q=`. `?limit=` caps it. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const q = params.get("q") ?? "";
  if (!q.trim()) return NextResponse.json({ hits: [] });

  const root = resolveKnowledgeRoot(getSettings());
  if (!root.ok) return NextResponse.json({ error: root.reason }, { status: 409 });

  const limitRaw = Number(params.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  // Gzipped: 12,433 bytes to 1,819 for a two-hundred-hit query, measured. The
  // empty-query and 409 branches above stay plain — both are under the floor
  // and would be handed back uncompressed anyway.
  return jsonMaybeGzipped(req, {
    hits: searchKnowledge(knowledgeIndex(root.root), q, limit),
  });
}
