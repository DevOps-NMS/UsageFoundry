import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatListEntryDTO } from "../../../../lib/apiTypes";

/**
 * The one thing this route has to answer with besides the thread: the list.
 *
 * This is the only route the chat page polls, so what it leaves out is frozen
 * on screen for as long as the page stays open — which is how the list came to
 * be fetched once on mount and never again, under a comment saying it was
 * refetched with the thread. The failure is the kind the rest of this suite is
 * reserved for: nothing throws, nothing fails a typecheck, and the sidebar
 * whose whole job is to say which conversations have work waiting for approval
 * quietly stops being true — a thread stays "Untitled" after `finishTurn` names
 * it, and a waiting count never moves.
 *
 * It is also the first test here that opens a database rather than calling a
 * pure function, and that is the point: the defect was a payload key, so the
 * only test that can see it is one that reads the payload. The database is a
 * throwaway directory and the run is a few milliseconds.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-chat-route-"));

// Config is fixed at boot, so the throwaway database has to be named before the
// first import of anything that reads it — hence the dynamic imports below.
process.env.DATA_DIR = DATA_DIR;

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

type Body = { chat: { id: string }; chats?: ChatListEntryDTO[] };

async function get(id: string): Promise<Body> {
  const { GET } = await import("./route");
  const res = await GET(new Request(`http://localhost/api/chat/${id}`), {
    params: Promise.resolve({ id }),
  });
  return (await res.json()) as Body;
}

function entry(body: Body, id: string): ChatListEntryDTO {
  const found = (body.chats ?? []).find((c) => c.id === id);
  assert.ok(found, "the payload the page polls must carry the chat list");
  return found;
}

test("the thread the page polls comes back with the list beside it", async () => {
  const { createChat, createProposal } = await import("../../../../lib/chat");
  const open = createChat();
  const other = createChat();

  const body = await get(open.id);

  assert.equal(body.chat.id, open.id);
  assert.ok(Array.isArray(body.chats), "chats must be present, not optional");
  assert.equal(entry(body, open.id).pendingCount, 0);
  assert.equal(entry(body, other.id).pendingCount, 0);

  // A proposal made during the page's lifetime is exactly what the list is for.
  createProposal(other.id, {
    templateId: null,
    title: "Fix the parser",
    task: "Fix the parser.",
    promptOverride: null,
    mountId: null,
    folder: null,
  });

  assert.equal(entry(await get(open.id), other.id).pendingCount, 1);
});

test("a title set after the page loaded reaches the list without a reload", async () => {
  const { createChat } = await import("../../../../lib/chat");
  const { db } = await import("../../../../lib/db");
  const chat = createChat();

  assert.equal(entry(await get(chat.id), chat.id).title, null);

  // What `finishTurn` does at the end of a first turn, which is always after
  // the page last loaded the list.
  db()
    .prepare("UPDATE chat_sessions SET title=? WHERE id=?")
    .run("Fix the parser", chat.id);

  assert.equal(entry(await get(chat.id), chat.id).title, "Fix the parser");
});
