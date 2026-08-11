import { NextResponse } from "next/server";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib and Meter.tsx already do.
import { getChat } from "../../../../lib/chat";
import { chatDTO, chatListDTO } from "../dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One thread, and the list beside it.
 *
 * The list is here because this is the route the page polls: it opens on a
 * thread and then only ever asks for that thread, so a payload of the chat
 * alone leaves the sidebar frozen at whatever was true on mount. Answering with
 * both costs no extra request and no second timer, which is the point — the
 * poll's period follows the thread's status, and the list has no business
 * making the page ask more often than that.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const chat = getChat(id);
  if (!chat) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ chat: chatDTO(chat), chats: chatListDTO() });
}
