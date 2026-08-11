import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * The run log's position on the wire.
 *
 * It earns a test on the same grounds as the rendering tests in
 * `src/components`: what it pins is something a reader acts on, and getting it
 * wrong throws nothing and typechecks. A live frame with no `id:` line leaves a
 * browser's Last-Event-ID pinned to the final replayed event, so the next
 * reconnect — a proxy timeout, a laptop waking, a container restart — replays
 * the whole live portion of the log on top of itself. The log is the only
 * record of what an unattended agent did, and a duplicated block is
 * indistinguishable from an agent that genuinely did the same thing twice.
 *
 * The environment has to be configured before the modules load: `config.ts`
 * reads DATA_DIR once at import.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-stream-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(ws, { recursive: true });
process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(tmp, "data");

// `require`, not `import`: imports are hoisted above the environment setup.
const { db } = require("../../../../../lib/db") as typeof import("../../../../../lib/db");
const { emitRunEvent, runEvents } =
  require("../../../../../lib/orchestrator") as typeof import("../../../../../lib/orchestrator");
const { GET } = require("./route") as typeof import("./route");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let seq = 0;

/** A minimal `runs` row — the route only needs `getRun` to find one. */
function newRun(): string {
  const id = `run-${++seq}`;
  db()
    .prepare(
      "INSERT INTO runs (id, folder, prompt, status, budget, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, ws, "task", "running", "{}", Date.now());
  return id;
}

interface Frame {
  /** null when the frame carried no `id:` line — the bug this file pins. */
  id: number | null;
  data: { kind: string; payload: Record<string, unknown> };
}

function parseFrame(raw: string): Frame {
  const lines = raw.split("\n");
  const idLine = lines.find((l) => l.startsWith("id: "));
  const dataLine = lines.find((l) => l.startsWith("data: "));
  assert.ok(dataLine, `frame has no data line: ${JSON.stringify(raw)}`);
  return {
    id: idLine === undefined ? null : Number(idLine.slice("id: ".length)),
    data: JSON.parse(dataLine.slice("data: ".length)),
  };
}

/**
 * One connection, modelling the half of `EventSource` that matters here: the
 * last-event-id pointer advances **only** on a frame carrying an `id:` line,
 * and is what the next connection sends back.
 */
class Connection {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buf = "";
  private at = 0;
  lastEventId: number | null = null;

  private constructor(
    body: ReadableStream<Uint8Array>,
    private readonly abort: AbortController,
  ) {
    this.reader = body.getReader();
  }

  static async open(runId: string, lastEventId: number | null): Promise<Connection> {
    const abort = new AbortController();
    const headers: Record<string, string> = {};
    if (lastEventId !== null) headers["last-event-id"] = String(lastEventId);
    const res = await GET(
      new Request(`http://localhost/api/runs/${runId}/stream`, {
        headers,
        signal: abort.signal,
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    assert.equal(res.status, 200);
    assert.ok(res.body);
    return new Connection(res.body, abort);
  }

  /** The next event frame, skipping heartbeat comments. */
  async frame(): Promise<Frame> {
    for (;;) {
      const end = this.buf.indexOf("\n\n", this.at);
      if (end >= 0) {
        const raw = this.buf.slice(this.at, end);
        this.at = end + 2;
        if (raw.startsWith(":")) continue;
        const frame = parseFrame(raw);
        if (frame.id !== null) this.lastEventId = frame.id;
        return frame;
      }
      this.buf = this.buf.slice(this.at);
      this.at = 0;
      const { value, done } = await this.reader.read();
      if (done) throw new Error("stream closed before the expected frame");
      this.buf += this.decoder.decode(value, { stream: true });
    }
  }

  /** Everything replayed before `replay-complete`, in order. */
  async replay(): Promise<Frame[]> {
    const seen: Frame[] = [];
    for (;;) {
      const frame = await this.frame();
      if (frame.data.kind === "replay-complete") return seen;
      seen.push(frame);
    }
  }

  close() {
    this.abort.abort();
  }
}

/** The id SQLite gave the newest row for this run. */
function newestRowId(runId: string): number {
  const events = runEvents(runId).events;
  const last = events.at(-1);
  assert.ok(last, "expected at least one persisted event");
  return last.id;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("live events", () => {
  it("carry the id of the row that was just written", async () => {
    const runId = newRun();
    const conn = await Connection.open(runId, null);
    try {
      assert.deepEqual(await conn.replay(), []);

      emitRunEvent({
        runId,
        ts: Date.now(),
        kind: "log",
        payload: { message: "first live event" },
      });

      const frame = await conn.frame();
      assert.equal(frame.data.payload.message, "first live event");
      assert.equal(
        frame.id,
        newestRowId(runId),
        "a live frame must carry its run_events.id, or Last-Event-ID never moves",
      );
    } finally {
      conn.close();
    }
  });

  it("leave a reconnect with nothing to replay", async () => {
    const runId = newRun();
    const first = await Connection.open(runId, null);
    const delivered: string[] = [];
    try {
      await first.replay();
      for (const message of ["one", "two", "three"]) {
        emitRunEvent({ runId, ts: Date.now(), kind: "log", payload: { message } });
        delivered.push(String((await first.frame()).data.payload.message));
      }
      assert.deepEqual(delivered, ["one", "two", "three"]);
    } finally {
      first.close();
    }

    // What a browser sends after the connection drops: the last id it saw.
    const second = await Connection.open(runId, first.lastEventId);
    try {
      assert.deepEqual(
        (await second.replay()).map((f) => f.data.payload.message),
        [],
        "a reconnect must resume, not re-send what was already displayed",
      );
      emitRunEvent({
        runId,
        ts: Date.now(),
        kind: "log",
        payload: { message: "four" },
      });
      const frame = await second.frame();
      assert.equal(frame.data.payload.message, "four");
      assert.equal(frame.id, newestRowId(runId));
    } finally {
      second.close();
    }
  });
});

describe("a fresh connection", () => {
  it("replays history with ids, says what it dropped, then completes", async () => {
    const runId = newRun();
    // More than the route's REPLAY_LIMIT, so the truncation notice fires. The
    // exact limit is the route's business; what is asserted is that nothing
    // goes missing without being counted.
    const total = 2_100;
    const insert = db().prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
    );
    db().transaction(() => {
      for (let i = 0; i < total; i++) {
        insert.run(runId, Date.now(), "log", JSON.stringify({ message: `e${i}` }));
      }
    })();

    const conn = await Connection.open(runId, null);
    try {
      const replayed = await conn.replay();
      const notice = replayed[0];
      assert.match(
        String(notice.data.payload.message),
        /earlier events not shown/,
        "a truncated replay must say it was truncated",
      );
      const events = replayed.slice(1);
      const dropped = Number(
        String(notice.data.payload.message).replace(/[^0-9]/g, ""),
      );
      assert.equal(events.length + dropped, total);
      assert.ok(
        events.every((f) => f.id !== null),
        "every replayed frame carries its row id",
      );
      assert.equal(events.at(-1)?.id, newestRowId(runId));
    } finally {
      conn.close();
    }
  });
});
