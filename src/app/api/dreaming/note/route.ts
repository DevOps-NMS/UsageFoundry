import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime.
import { forgetNote } from "../../../../lib/dreamingLedger";
import { auditMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Forget a note this app recorded writing.
 *
 * **Deletes the row, never the file.** Retraction in the vault is a person
 * moving a file in Obsidian — that store's own conventions use a `_to_delete/`
 * folder for it — and an app that deleted from a mount it does not own would be
 * doing something heavier than anything else in this codebase, against a store
 * with no version control to undo it with.
 *
 * What forgetting buys is that the signature stops being suppressed: the next
 * night on which it still qualifies will write it again. That is the intended
 * use — a note that came out wrong is deleted in Obsidian and forgotten here,
 * and the feature gets another go at it.
 */
export const DELETE = auditMutation(async (req: Request) => {
  const signature = new URL(req.url).searchParams.get("signature");
  if (!signature) {
    return NextResponse.json({ error: "A signature is required." }, { status: 400 });
  }
  if (!forgetNote(signature)) {
    return NextResponse.json({ error: "No such note is recorded." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
});
