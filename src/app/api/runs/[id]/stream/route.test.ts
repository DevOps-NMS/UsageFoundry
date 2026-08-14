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
 * The connection's own teardown earns a place here on the same grounds. A
 * connection that dies by a failed `enqueue` rather than by `abort` leaves
 * nothing behind that anything reports: the bus has `setMaxListeners(0)`, so
 * Node never warns about the listener, and a leaked 15-second interval is
 * indistinguishable from a healthy one until the process is profiled. Both
 * accumulate per reconnect, and `EventSource` reconnects on its own.
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

/**
 * The bus every connection subscribes to, reached the way the orchestrator's
 * own module state is: `globalThis.__ufBus`. Only the count is wanted, and a
 * leaked listener is exactly what a count is the evidence for.
 */
const bus = (globalThis as unknown as {
  __ufBus: { listenerCount(name: string): number };
}).__ufBus;

/**
 * Drive the route's `start(controller)` by hand, against a controller whose
 * `enqueue` throws — the socket-reset case, which no in-process client can
 * produce, since a `ReadableStream` a test holds a reader on never errors.
 *
 * The route builds its own stream, so the way in is the global constructor:
 * capture the underlying source and hand `super()` nothing, so the real stream
 * never runs `start` and the test owns the only call to it.
 *
 * `clearInterval` stays patched past the return, because the clearing under
 * test happens at `abort` — after this function is done. The caller restores
 * it; everything else goes back before the return.
 */
async function startWithDeadSocket(runId: string): Promise<{
  abort: AbortController;
  heartbeat: NodeJS.Timeout;
  cleared: unknown[];
  restore: () => void;
}> {
  const RealReadableStream = globalThis.ReadableStream;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;

  const captured: UnderlyingSource<Uint8Array>[] = [];
  let heartbeat: NodeJS.Timeout | null = null;
  const cleared: unknown[] = [];

  class Capturing<R> extends RealReadableStream<R> {
    constructor(src?: UnderlyingSource<R>) {
      super();
      captured.push(src as UnderlyingSource<Uint8Array>);
    }
  }

  const abort = new AbortController();
  try {
    globalThis.ReadableStream = Capturing as unknown as typeof ReadableStream;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      heartbeat = realSetInterval(fn, ms);
      return heartbeat;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((handle: NodeJS.Timeout) => {
      cleared.push(handle);
      realClearInterval(handle);
    }) as unknown as typeof clearInterval;

    const res = await GET(
      new Request(`http://localhost/api/runs/${runId}/stream`, {
        signal: abort.signal,
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    assert.equal(res.status, 200);
    const source = captured[0];
    assert.ok(source?.start, "the route's stream source was not captured");

    source.start({
      enqueue() {
        throw new TypeError("Invalid state: Controller is already closed");
      },
      close() {},
      error() {},
      desiredSize: 1,
    } as unknown as ReadableStreamDefaultController<Uint8Array>);
  } finally {
    globalThis.ReadableStream = RealReadableStream;
    globalThis.setInterval = realSetInterval;
  }

  assert.ok(heartbeat, "the route started no heartbeat");
  return {
    abort,
    heartbeat,
    cleared,
    restore: () => {
      globalThis.clearInterval = realClearInterval;
    },
  };
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

  it("stops at the byte budget and counts what that dropped too", async () => {
    const runId = newRun();
    // Far under REPLAY_LIMIT, so the row cap contributes nothing and the whole
    // notice is the byte cap's doing. Half a megabyte each is the shape of a
    // `tool` event that read a large file, not an invented one.
    const total = 12;
    const blob = "x".repeat(512 * 1024);
    const insert = db().prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
    );
    db().transaction(() => {
      for (let i = 0; i < total; i++) {
        insert.run(runId, Date.now(), "tool", JSON.stringify({ message: `e${i}`, blob }));
      }
    })();

    const conn = await Connection.open(runId, null);
    try {
      const replayed = await conn.replay();
      const notice = replayed[0];
      assert.match(
        String(notice.data.payload.message),
        /earlier events not shown/,
        "a replay cut by the byte budget must say so, exactly as a row-capped one does",
      );
      const events = replayed.slice(1);
      const dropped = Number(
        String(notice.data.payload.message).replace(/[^0-9]/g, ""),
      );
      assert.ok(dropped > 0, "12 events of 512 KiB must not all fit the budget");
      assert.equal(events.length + dropped, total, "nothing goes missing uncounted");
      assert.deepEqual(
        events.map((f) => f.data.payload.message),
        Array.from({ length: events.length }, (_, i) => `e${total - events.length + i}`),
        "the budget keeps the newest events, the same rule the row cap follows",
      );
    } finally {
      conn.close();
    }
  });
});

describe("a connection whose socket is already gone", () => {
  it("still unsubscribes and clears its heartbeat when abort arrives", async () => {
    const runId = newRun();
    const before = bus.listenerCount(runId);

    const { abort, heartbeat, cleared, restore } = await startWithDeadSocket(runId);
    try {
      // Every `enqueue` in `start` threw. The subscription happened anyway,
      // which is the whole hazard: it is live and nothing has removed it.
      assert.equal(
        bus.listenerCount(runId),
        before + 1,
        "the failed replay must not have stopped the tail being subscribed",
      );
      assert.equal(
        heartbeat.hasRef(),
        false,
        "a connection's heartbeat must not hold the event loop open",
      );

      abort.abort();

      assert.equal(
        bus.listenerCount(runId),
        before,
        "abort must unsubscribe even when the stream died by a failed enqueue",
      );
      assert.deepEqual(
        cleared,
        [heartbeat],
        "the heartbeat must be cleared exactly once",
      );

      // Idempotence is now the cleanup flag's own job, not a side effect of
      // the flag the error path sets.
      abort.abort();
      assert.equal(cleared.length, 1);
    } finally {
      restore();
    }
  });

  it("leaves the bus where it found it across repeated connections", async () => {
    const runId = newRun();
    const before = bus.listenerCount(runId);
    for (let i = 0; i < 5; i++) {
      const { abort, restore } = await startWithDeadSocket(runId);
      abort.abort();
      restore();
    }
    assert.equal(bus.listenerCount(runId), before);
  });
});
