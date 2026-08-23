// Relative, not "@/lib/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a file with a test beside it has to
// import the way src/lib and the tested components already do.
import {
  getRun,
  runEvents,
  subscribe,
  type PersistedRunEvent,
} from "../../../../../lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Most recent events replayed to a client with no `Last-Event-ID`. */
const REPLAY_LIMIT = 2_000;

/**
 * Ceiling on the bytes one replay may put on the wire.
 *
 * Rows are not bytes, and the row cap alone does not bound the response it was
 * written to bound. An ordinary `log` event is a couple of hundred bytes, so
 * REPLAY_LIMIT of them is well under a megabyte and the row cap is the one that
 * bites; a `tool` event carries whatever the agent read or wrote, and 2,000 of
 * those at a few kilobytes each is exactly the multi-hundred-megabyte response
 * the row cap exists to prevent — once per open run page, since
 * `controller.enqueue` buffers rather than applying backpressure, so the bytes
 * sit in the stream's queue until the client drains them.
 */
const REPLAY_BYTE_BUDGET = 4 * 1024 * 1024;

/**
 * Server-sent events for one run.
 *
 * Replays persisted history first, then tails live events. The replay matters:
 * without it, a page opened after a run started would show an empty log even
 * though the work is well underway, and a reconnect after a dropped connection
 * would silently lose everything emitted during the gap.
 *
 * **Never `jsonMaybeGzipped`, and never any encoding at all.** This is the one
 * route here whose body has no end: a run's log arrives frame by frame over
 * minutes or hours, and gzip is a stream cipher over a sliding window that
 * emits nothing until it has something to emit. Compressing this would hold
 * each `log` line in a deflate buffer until the next one pushed it out — a
 * live log that runs one event behind, and a run that goes quiet showing its
 * last line only when the run ends. The replay would land in one lump and the
 * tail would stall. The frames are also small enough individually that the
 * floor in `http.ts` would decline every one of them anyway; this comment is
 * here because the *right* answer is not "the floor catches it", it is that
 * buffering a stream to compress it is the wrong shape.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(req.url);
  const lastEventId = Number(
    req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0,
  );

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Two facts, two flags. `writable` is "the stream still takes frames" and
      // is what a failed `enqueue` sets; `cleaned` is "cleanup has run". One
      // variable served both, and the error path set it — so an `enqueue` that
      // threw before `abort` arrived (the runtime errors the stream on a socket
      // reset) disarmed the cleanup that abort was about to do, and the bus
      // listener and the heartbeat survived for the life of the process.
      let writable = true;
      let cleaned = false;

      const write = (bytes: Uint8Array) => {
        if (!writable) return;
        try {
          controller.enqueue(bytes);
        } catch {
          writable = false;
        }
      };
      const frame = (data: unknown, eventId?: number) =>
        encoder.encode(
          `${eventId !== undefined ? `id: ${eventId}\n` : ""}data: ${JSON.stringify(data)}\n\n`,
        );
      const send = (data: unknown, eventId?: number) =>
        write(frame(data, eventId));

      // 1. Replay everything the client has not seen, newest REPLAY_LIMIT of
      //    it. A run that works for days across hundreds of cycles accumulates
      //    tens of thousands of events, and replaying all of them on every page
      //    load is a multi-hundred-megabyte response. What was dropped is
      //    announced rather than silently omitted — a truncated log that does
      //    not say it is truncated reads as a complete one.
      const history = runEvents(
        id,
        Number.isFinite(lastEventId) ? lastEventId : 0,
        REPLAY_LIMIT,
      );

      //    The byte budget is the second half of that cap, applied newest-first
      //    so it keeps what the row cap keeps. Each frame is encoded once and
      //    measured as the bytes it will actually enqueue, so the budget is the
      //    wire size rather than a guess at it. The newest event is sent even
      //    when it alone exceeds the budget: the overshoot is then bounded by
      //    one event, where the alternative is an empty log on a run that is
      //    working. Whatever either cap dropped goes into the one notice below,
      //    because a reader cares that the log is truncated and not which of
      //    the two limits truncated it.
      const frames: Uint8Array[] = [];
      let bytes = 0;
      let droppedForBytes = 0;
      for (let i = history.events.length - 1; i >= 0; i--) {
        const e = history.events[i];
        const encoded = frame(e, e.id);
        if (frames.length > 0 && bytes + encoded.byteLength > REPLAY_BYTE_BUDGET) {
          droppedForBytes = i + 1;
          break;
        }
        bytes += encoded.byteLength;
        frames.push(encoded);
      }
      frames.reverse();

      const dropped = history.dropped + droppedForBytes;
      if (dropped > 0) {
        send({
          kind: "log",
          runId: id,
          ts: Date.now(),
          payload: {
            message: `… ${dropped.toLocaleString()} earlier events not shown. The full log is in the database.`,
          },
        });
      }
      for (const encoded of frames) write(encoded);
      send({ kind: "replay-complete", runId: id, ts: Date.now(), payload: {} });

      // 2. Tail live events, each carrying the id of the row `emit()` just
      //    wrote — the same id the replay above sends. `EventSource` advances
      //    its Last-Event-ID only on a frame that has an `id:` line, so a live
      //    frame without one leaves the client pinned to the final *replayed*
      //    event however many hours of tail follow, and the next reconnect
      //    replays the whole live portion of the log on top of itself.
      const unsubscribe = subscribe(id, (e: PersistedRunEvent) => send(e, e.id));

      // Proxies drop idle connections; a periodic comment keeps it warm
      // without appearing as an event to the client.
      const heartbeat = setInterval(() => write(encoder.encode(": ping\n\n")), 15_000);
      // Every other long-lived timer here is unref'd. One connection's
      // heartbeat must not be a reason the process stays alive.
      heartbeat.unref?.();

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        writable = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed by the runtime */
        }
      };

      req.signal.addEventListener("abort", cleanup);
      // A signal that aborted while the history above was being read has
      // already dispatched: `addEventListener` on it never fires, so without
      // this the listener and the timer are left with nothing to remove them.
      if (req.signal.aborted) cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx buffers SSE by default, which defeats the point.
      "x-accel-buffering": "no",
    },
  });
}
