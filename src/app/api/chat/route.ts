import { createChat, latestChat } from "@/lib/chat";
import { jsonMaybeGzipped, jsonNoStore } from "@/lib/http";
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
export async function GET(req: Request) {
  const chat = latestChat();
  // Gzipped: 73,565 bytes to 20,011, measured — a thread is model prose and
  // this is polled for as long as the page is open. `Cache-Control` written
  // out rather than taken from `jsonNoStore`, because the directive is what
  // keeps the composer from freezing on `thinking` and it has to survive the
  // change of builder: `jsonNoStore`'s docblock is the argument for it.
  return jsonMaybeGzipped(
    req,
    { chats: chatListDTO(), chat: chatDTO(chat) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Start a fresh thread. Nothing is carried over — not even the session id. */
// Takes the request it does not read, so the audit wrapper has one to log.
async function postHandler(_req: Request) {
  return jsonNoStore({ chat: chatDTO(createChat()) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
