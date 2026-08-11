import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Covers one thing: what happens to a chat row when starting a turn throws.
 *
 * It earns a place in this suite on the same grounds as the rest of it — a
 * silent, expensive failure with no other way out. `runTurn` mints the
 * capability and writes the MCP config *before* it constructs the promise it
 * returns, and it is not `async`, so a throw from either happens while the call
 * expression is being evaluated and skips the `.catch` attached to its result.
 * The row has already been set to `thinking` by then, `sendChatMessage` refuses
 * to send into a thinking chat, and the only other thing in the codebase that
 * clears that flag is `reconcileChatsOnBoot` — a server restart. One failed
 * `fs.writeFileSync` into `os.tmpdir()` and the thread is dead for good.
 *
 * It lives in its own file rather than in `chat.test.ts` because it is the one
 * test here that touches SQLite: `DATA_DIR` and `CLAUDE_HOME` are read into
 * `config.ts` at module load, so they have to be set before anything requires
 * it, which a file that statically imports `./chat` cannot do. `node --test`
 * gives each file its own process; the assertion in `before` is what makes a
 * change to that fail loudly instead of writing into the operator's own
 * database.
 */

let chat: typeof import("./chat");
let root: string;
let tmpdirBefore: string | undefined;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-chat-turn-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  // Nothing in here should reach a spawn. A `claude` that does not exist is
  // what makes a regression that gets that far a failed test rather than a
  // billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  chat = await import("./chat");
});

after(() => {
  if (tmpdirBefore === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = tmpdirBefore;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("sendChatMessage when the turn cannot be started", () => {
  it("leaves the row failed, not thinking, and says why", async () => {
    const row = chat.createChat();

    // The issue's own reproduction, without patching anything: `writeMcpConfig`
    // writes into `os.tmpdir()`, which reads `TMPDIR` on every call.
    tmpdirBefore = process.env.TMPDIR;
    process.env.TMPDIR = path.join(root, "no-such-directory");

    const res = await chat.sendChatMessage(row.id, "propose some work");

    assert.equal(res.ok, false, "the caller must be told the turn never started");
    if (res.ok) return;
    assert.match(res.reason, /Could not start the turn/);

    const after = chat.getChat(row.id);
    assert.equal(after?.status, "failed");
    assert.match(after?.error ?? "", /Could not start the turn/);
    assert.match(after?.error ?? "", /ENOENT/, "the underlying error must survive");

    // And in the thread, where the operator is looking.
    const said = chat.listMessages(row.id).map((m) => m.text);
    assert.ok(
      said.some((t) => /Could not start the turn/.test(t)),
      "the failure must be visible in the conversation",
    );

    // The capability outlives the turn otherwise: `revokeCapability` is only
    // reachable through `land`, inside the promise this failure never reaches.
    // Read off the singleton because the public reader takes the token, and the
    // token belonged to the turn that failed.
    const caps = (globalThis as unknown as { __ufChatCaps?: Map<string, unknown> })
      .__ufChatCaps;
    assert.equal(caps?.size ?? 0, 0, "a turn that never spawned left a live capability");

    // A second message must go out — the point of not stranding the row.
    assert.notEqual(chat.getChat(row.id)?.status, "thinking");
  });
});
