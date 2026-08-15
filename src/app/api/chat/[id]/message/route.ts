import { NextResponse } from "next/server";
import { getChat, sendChatMessage } from "@/lib/chat";
import { chatDTO } from "../../dto";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Say something to the chat.
 *
 * Returns as soon as the child is on its way, not when it answers: a turn takes
 * minutes and the row is the handle the page polls. The refusals that come back
 * with a 400 are the ones a person can act on — a turn already in flight, or a
 * window already past the ceiling they set.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const res = await sendChatMessage(id, String(body.message ?? ""));
  if (!res.ok) {
    return NextResponse.json({ error: res.reason }, { status: 400 });
  }

  const chat = getChat(id);
  return NextResponse.json({ chat: chat ? chatDTO(chat) : null });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
