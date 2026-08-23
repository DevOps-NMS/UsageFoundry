import { NextResponse } from "next/server";
import type { KnowledgeNodeKindDTO } from "../../../../lib/apiTypes";
import {
  knowledgeGraphView,
  knowledgeIndex,
  resolveKnowledgeRoot,
  MAX_GRAPH_NODES,
} from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";
import { jsonMaybeGzipped } from "../../../../lib/http";

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

  // Gzipped: 8,837,734 bytes to 488,202, measured — 94.5% off, the largest
  // saving anywhere in this app. A link graph is an adjacency list of the same
  // few thousand note paths written over and over, which is the shape deflate
  // reduces best, and it is also the one body big enough that the sync form of
  // zlib would have been a visible stall. See `jsonMaybeGzipped`.
  return jsonMaybeGzipped(req, view);
}
