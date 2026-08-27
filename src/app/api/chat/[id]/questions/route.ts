import { NextResponse } from "next/server";
import { answerChatQuestions, getChat } from "@/lib/chat";
import { chatDTO } from "../../dto";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Answer what the chat asked.
 *
 * The message route with two extra facts, and it is deliberately the same
 * shape: an answer *is* a message — it goes into the thread, it starts a turn
 * against the same resumed session, and it passes the same spend gates. What
 * this door adds is which rows the message settles and a text that quotes each
 * question above its answer, so the model reads what it asked rather than a
 * bare string. Everything that bounds a turn is in `sendChatMessage`, which
 * this reaches through `answerChatQuestions` rather than around.
 *
 * Returns as soon as the child is on its way, exactly as the message route
 * does: a turn takes minutes and the row is the handle the page polls. The
 * refusals that come back with a 400 are the ones a person can act on — a turn
 * already in flight, a window past the ceiling they set, or a question the
 * conversation has already moved past, which is what a stale card sends.
 *
 * The whole call is refused when any id is no longer open rather than the id
 * being dropped, which is where this diverges from the proposals route. There
 * the ids are independent; here they compose one message, so a dropped one is
 * the operator's typed answer silently missing from the text the model reads.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // Read off the wire in the shape the page holds it: one entry per question
  // the operator touched. Anything unreadable becomes an empty list, which is
  // the refusal below rather than a silent partial answer.
  const answers = (Array.isArray(body.answers) ? body.answers : []).map(
    (entry) => {
      const a = (entry ?? {}) as Record<string, unknown>;
      return { id: String(a.id ?? ""), answer: String(a.answer ?? "") };
    },
  );

  const res = await answerChatQuestions(id, answers);
  if (!res.ok) {
    return NextResponse.json({ error: res.reason }, { status: 400 });
  }

  const chat = getChat(id);
  return NextResponse.json({ chat: chat ? chatDTO(chat) : null });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
