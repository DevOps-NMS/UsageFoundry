import { NextResponse } from "next/server";
import { cancelChatTurn, getChat } from "@/lib/chat";
import { chatDTO } from "../../dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Stop the turn a chat is waiting on.
 *
 * The chat's counterpart to `DELETE /api/runs/[id]`, and the only request that
 * can move a `thinking` row. Without it the recovery for a turn whose child
 * died without a `close` event is restarting the server, which stops every run
 * in flight to clear one thread.
 *
 * Returns the thread rather than a bare ok, so the composer comes back in the
 * same round trip the click made — the operator's next action is almost always
 * to re-send.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const res = cancelChatTurn(id);
  if (!res.ok) {
    return NextResponse.json({ error: res.reason }, { status: 400 });
  }

  const chat = getChat(id);
  // "cleared" is a success, not a fallback: a stranded turn has no child left
  // to signal, and that is the case this route was added for.
  return NextResponse.json({
    outcome: res.outcome,
    chat: chat ? chatDTO(chat) : null,
  });
}
