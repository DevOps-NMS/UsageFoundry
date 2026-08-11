import { NextResponse } from "next/server";
import { createChat, latestChat, listChats, pendingProposals } from "@/lib/chat";
import type { ChatListEntryDTO } from "@/lib/apiTypes";
import { chatDTO } from "./dto";

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
  const chats: ChatListEntryDTO[] = listChats().map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updated_at,
    status: c.status,
    costUSD: c.cost_usd,
    pendingCount: pendingProposals(c.id).length,
  }));
  return NextResponse.json({ chats, chat: chatDTO(chat) });
}

/** Start a fresh thread. Nothing is carried over — not even the session id. */
export async function POST() {
  return NextResponse.json({ chat: chatDTO(createChat()) });
}
