import { NextResponse } from "next/server";
import { knowledgeIndex, resolveKnowledgeRoot, searchKnowledge } from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";

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

  return NextResponse.json({ hits: searchKnowledge(knowledgeIndex(root.root), q, limit) });
}
