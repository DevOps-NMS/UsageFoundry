import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime.
import {
  isKnowledgeSort,
  knowledgeBrowse,
  knowledgeIndex,
  resolveKnowledgeRoot,
} from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The browse list: one page of notes, plus every value the filters offer.
 *
 * `?folder=`, `?tag=`, `?type=`, `?q=`, `?sort=`, `?offset=`, `?limit=`.
 *
 * Read-only, like everything under `/api/knowledge`: there is no POST, PUT,
 * PATCH or DELETE anywhere below this directory, and the vault it reads is a
 * store a person edits in another application.
 *
 * A `sort` this does not know falls back to the default rather than answering
 * 400. It is a presentation choice with no correctness behind it, and a page
 * that fails to load because a stale bookmark named an order that has since
 * been renamed is a worse answer than the list in a different order.
 */
export async function GET(req: Request) {
  const root = resolveKnowledgeRoot(getSettings());
  if (!root.ok) return NextResponse.json({ error: root.reason }, { status: 409 });

  const params = new URL(req.url).searchParams;
  const sort = params.get("sort");
  const offsetRaw = Number(params.get("offset"));
  const limitRaw = Number(params.get("limit"));

  const view = knowledgeBrowse(knowledgeIndex(root.root), {
    folder: params.get("folder"),
    tag: params.get("tag"),
    type: params.get("type"),
    q: params.get("q"),
    sort: isKnowledgeSort(sort) ? sort : undefined,
    offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined,
  });

  return NextResponse.json(view);
}
