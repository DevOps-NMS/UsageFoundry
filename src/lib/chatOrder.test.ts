import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers the order `listMessages` returns a thread in, and only that.
 *
 * It earns a test on the same grounds as the rest of this suite: it is wrong in
 * a way that throws nothing, typechecks, and changes what the operator is told.
 * `finishTurn` appends the reply, an error and a denial note inside one
 * synchronous block, so all three carry the same `Date.now()`; the query used to
 * break that tie with `id`, which is a random UUID. Half the time the thread
 * therefore rendered "Refused tool calls this turn" *above* the reply it is a
 * footnote to, which reads as "the tool was refused, and separately here is an
 * answer" rather than "here is the answer, and a tool was refused producing it".
 * Observed on the live database, not reasoned about.
 *
 * This is the one test here that opens a database, because the defect is in the
 * SQL. That is also why it is its own file rather than a case in
 * `chat.test.ts`: `config.ts` reads `DATA_DIR` at module load, and that file
 * imports `./chat` statically, so by the time any test body ran the path would
 * already be bound to the repository's own `.data` directory — which on a
 * developer's machine is the real one.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uf-chat-order-"));
process.env.DATA_DIR = dataDir;

type ChatModule = typeof import("./chat");
type DbModule = typeof import("./db");

let chat: ChatModule;
let dbMod: DbModule;

before(async () => {
  chat = await import("./chat");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Every message a turn writes shares one `Date.now()`. Make that certain. */
function atFixedClock<T>(ms: number, fn: () => T): T {
  const realNow = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

/** Drop the connection so the next `db()` reopens the file and re-migrates. */
function reopen() {
  const g = globalThis as { __ufDb?: Database.Database };
  g.__ufDb?.close();
  delete g.__ufDb;
}

describe("chat thread order", () => {
  // The pair observed on the live database. A pair is what the defect looks
  // like, but it is also a coin toss, so it only failed against the old
  // ordering about half the time — the burst below is what makes the
  // regression fail deterministically.
  it("keeps a denial note below the reply it annotates", () => {
    const id = chat.createChat().id;
    atFixedClock(1_786_466_494_717, () => {
      chat.appendMessage(id, "assistant", "I couldn't complete either half.");
      chat.appendMessage(id, "system", "Refused tool calls this turn: Bash.");
    });

    const messages = chat.listMessages(id);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["assistant", "system"],
    );
    // Without this the test could pass by the clock having moved on, which is
    // the case that was never broken.
    assert.equal(messages[0].ts, messages[1].ts);
  });

  it("orders a burst written in one millisecond by insert order", () => {
    const id = chat.createChat().id;
    const texts = Array.from({ length: 10 }, (_, i) => `message ${i}`);
    atFixedClock(1_786_467_097_624, () => {
      for (const text of texts) chat.appendMessage(id, "assistant", text);
    });

    assert.deepEqual(
      chat.listMessages(id).map((m) => m.text),
      texts,
    );

    // Stable across reloads, which the random tiebreak was not: it was fixed
    // per row, but it was decided by a coin toss at insert time.
    reopen();
    assert.deepEqual(
      chat.listMessages(id).map((m) => m.text),
      texts,
    );
  });

  it("orders rows written before the sequence column existed", () => {
    const id = chat.createChat().id;
    const ts = 1_786_467_917_028;
    // The state a deployed database is in immediately after ALTER TABLE adds
    // the column and before the backfill runs: rows with a null `seq`, in
    // `rowid` order, whose ids sort against the order they were written.
    const insert = dbMod
      .db()
      .prepare(
        "INSERT INTO chat_messages (id, chat_id, ts, seq, role, text)" +
          " VALUES (?, ?, ?, NULL, ?, ?)",
      );
    insert.run(`zzz-${id}`, id, ts, "user", "first");
    insert.run(`mmm-${id}`, id, ts, "assistant", "second");
    insert.run(`aaa-${id}`, id, ts, "system", "third");

    reopen();

    assert.deepEqual(
      chat.listMessages(id).map((m) => m.text),
      ["first", "second", "third"],
    );
    // A message appended afterwards continues past them rather than landing
    // among them, which is what makes the backfill and the counter one scale.
    chat.appendMessage(id, "user", "fourth");
    assert.deepEqual(
      chat.listMessages(id).map((m) => m.text),
      ["first", "second", "third", "fourth"],
    );
  });
});
