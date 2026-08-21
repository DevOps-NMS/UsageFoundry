import { NextResponse } from "next/server";
import { knowledgeIndex, knowledgeNoteView, resolveKnowledgeRoot } from "../../../../lib/knowledge";
import { getSettings } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One note: its frontmatter, its body, and both directions of its links.
 *
 * `?path=` is **vault-relative** and is resolved only by looking it up in the
 * index, never by joining it onto the root. That is the containment argument
 * here: the only paths this route can open are ones the walk already found
 * inside the vault, so a `../../etc/passwd` is not a traversal to defend
 * against — it is a key that is not in a map, and answers 404.
 */
export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path");
  if (!path) return NextResponse.json({ error: "A note path is required." }, { status: 400 });

  const root = resolveKnowledgeRoot(getSettings());
  if (!root.ok) return NextResponse.json({ error: root.reason }, { status: 409 });

  const note = knowledgeNoteView(knowledgeIndex(root.root), path);
  if (!note) {
    return NextResponse.json(
      { error: `No note at "${path}" in the knowledge base.` },
      { status: 404 },
    );
  }
  return NextResponse.json(note);
}
