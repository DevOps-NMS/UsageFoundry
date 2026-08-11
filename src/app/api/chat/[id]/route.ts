import { getChat } from "@/lib/chat";
import { jsonNoStore } from "@/lib/http";
import { chatDTO } from "../dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const chat = getChat(id);
  if (!chat) return jsonNoStore({ error: "Not found" }, { status: 404 });
  return jsonNoStore({ chat: chatDTO(chat) });
}
