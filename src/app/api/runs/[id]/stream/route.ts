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
 * Server-sent events for one run.
 *
 * Replays persisted history first, then tails live events. The replay matters:
 * without it, a page opened after a run started would show an empty log even
 * though the work is well underway, and a reconnect after a dropped connection
 * would silently lose everything emitted during the gap.
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
      let closed = false;
      const send = (data: unknown, eventId?: number) => {
        if (closed) return;
        try {
          const idLine = eventId !== undefined ? `id: ${eventId}\n` : "";
          controller.enqueue(
            encoder.encode(`${idLine}data: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

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
      if (history.dropped > 0) {
        send({
          kind: "log",
          runId: id,
          ts: Date.now(),
          payload: {
            message: `… ${history.dropped.toLocaleString()} earlier events not shown. The full log is in the database.`,
          },
        });
      }
      for (const e of history.events) send(e, e.id);
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
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed by the runtime */
        }
      };

      req.signal.addEventListener("abort", cleanup);
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
