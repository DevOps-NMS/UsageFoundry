import { NextResponse } from "next/server";
import { knowledgeHealth, knowledgeIndex, resolveKnowledgeRoot } from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";
import { jsonMaybeGzipped } from "../../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Orphans, broken links and notes with no frontmatter — each counted whole and
 * listed to a cap.
 *
 * Separate from `/api/knowledge/status`, which the settings page reads for the
 * headline figures. This one carries the *rows*: a count of 212 broken links
 * tells an operator there is work, and only the note, the target and the line
 * tell them where it is.
 */
export async function GET(req: Request) {
  const root = resolveKnowledgeRoot(getSettings());
  if (!root.ok) return NextResponse.json({ error: root.reason }, { status: 409 });

  // Gzipped: 45,982 bytes to 3,980, measured — the highest ratio of anything
  // here, because these rows are thousands of repetitions of the same handful
  // of vault paths. The 409 above stays plain.
  return jsonMaybeGzipped(req, knowledgeHealth(knowledgeIndex(root.root)));
}
