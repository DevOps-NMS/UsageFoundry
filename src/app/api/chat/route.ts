import { createChat, latestChat } from "@/lib/chat";
import { jsonNoStore } from "@/lib/http";
import { chatDTO, chatListDTO } from "./dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The chat list, plus whichever thread the page should open on.
 *
 * One request rather than two because the page has nothing to show without
 * both, and a second round trip would render an empty thread first.
 */
export async function GET() {
  const chat = latestChat();
  return jsonNoStore({ chats: chatListDTO(), chat: chatDTO(chat) });
}

/** Start a fresh thread. Nothing is carried over — not even the session id. */
export async function POST() {
  return jsonNoStore({ chat: chatDTO(createChat()) });
}
