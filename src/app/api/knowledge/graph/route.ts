import { NextResponse } from "next/server";
import type { KnowledgeNodeKindDTO } from "../../../../lib/apiTypes";
import {
  knowledgeGraphView,
  knowledgeIndex,
  resolveKnowledgeRoot,
  MAX_GRAPH_NODES,
} from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS: readonly KnowledgeNodeKindDTO[] = ["note", "phantom", "tag", "attachment"];

/**
 * The link graph, filtered.
 *
 * `?kinds=note,phantom` (default `note`), `?tag=`, `?q=`, `?limit=`.
 *
 * Read-only, like everything under `/api/knowledge` in this release: there is
 * no POST, PUT, PATCH or DELETE anywhere below this directory, and the vault it
 * reads is a store a person edits in another application.
 */
export async function GET(req: Request) {
  const root = resolveKnowledgeRoot(getSettings());
  if (!root.ok) return NextResponse.json({ error: root.reason }, { status: 409 });

  const params = new URL(req.url).searchParams;
  const kinds = (params.get("kinds") ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k): k is KnowledgeNodeKindDTO => (KINDS as readonly string[]).includes(k));
  const limitRaw = Number(params.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : MAX_GRAPH_NODES;

  const view = knowledgeGraphView(knowledgeIndex(root.root), {
    kinds,
    tag: params.get("tag"),
    q: params.get("q"),
    limit,
  });

  return NextResponse.json(view);
}
