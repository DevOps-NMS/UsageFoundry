import { NextResponse } from "next/server";
import { knowledgeHealth, knowledgeIndex, resolveKnowledgeRoot } from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";

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
export async function GET() {
  const root = resolveKnowledgeRoot(getSettings());
  if (!root.ok) return NextResponse.json({ error: root.reason }, { status: 409 });

  return NextResponse.json(knowledgeHealth(knowledgeIndex(root.root)));
}
