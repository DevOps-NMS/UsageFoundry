import { createChat, latestChat } from "@/lib/chat";
import { jsonNoStore } from "@/lib/http";
import { chatDTO, chatListDTO } from "./dto";
import { auditMutation } from "../../../lib/requestLog";

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
// Takes the request it does not read, so the audit wrapper has one to log.
async function postHandler(_req: Request) {
  return jsonNoStore({ chat: chatDTO(createChat()) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
