import { gzip } from "node:zlib";
import { promisify } from "node:util";

/**
 * JSON responses for the routes a page polls.
 *
 * `export const dynamic = "force-dynamic"` governs Next's *own* server-side
 * caching and puts nothing on the wire, so a polled route answers with no
 * freshness information and no validator — which leaves every cache between
 * the browser and the app free to decide for itself. That is only ever
 * noticed as a page that stopped updating, and on the chat page the state it
 * can freeze on is `thinking`, which disables the composer: a spinner that
 * never clears and a thread that cannot be typed into.
 *
 * `no-store` rather than `no-cache` because there is nothing here worth
 * revalidating — every one of these bodies describes a row that may have
 * changed since the last poll, which is the reason it is being polled.
 */
export function jsonNoStore(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

const gzipAsync = promisify(gzip);

/**
 * The floor below which gzip is refused.
 *
 * Two measurements, not a guess. Against the running container, the small
 * bodies round-trip through `gzip -6` as 111→120, 169→178, 283→215, 374→264,
 * 586→336: below roughly 250 bytes the deflate header and the trailer cost
 * more than the redundancy they buy, and the answer comes back *larger*. That
 * puts the break-even near 250, which would be the floor if bytes were the
 * only thing being spent.
 *
 * They are not, and the second measurement is the one that sets the number. A
 * body under one TCP segment — an Ethernet MSS is about 1460 bytes — already
 * crosses the wire in a single packet, so compressing it saves no round trip
 * at all; what it costs is a threadpool hop, a second allocation of the whole
 * body, and a `Vary` that splits any cache entry in front of the app in two.
 * 1400 is one segment with room for the headers, and every route this is
 * wired into answers either far below it (`/api/knowledge/note` on a missing
 * path, 59 bytes) or far above it (`/api/runs`, 698 KB). Nothing here sits
 * near the line, which is why the exact value is not delicate.
 */
const GZIP_FLOOR_BYTES = 1400;

/**
 * Whether a body of this size may be gzipped for a client sending this
 * `Accept-Encoding`.
 *
 * Split out from the response builder because it is the whole of the decision
 * and its failure mode is silent in both directions: refusing gzip where it
 * was wanted just makes responses large again, and *offering* it to a client
 * that asked for `identity` — or spelled `gzip;q=0`, which is the documented
 * way to refuse a coding it nonetheless has to name — hands back a body that
 * client will not decode. Both look like a working server.
 *
 * `q=0` means "not acceptable", and an explicit `gzip` entry outranks a `*`
 * however the two are ordered, per RFC 9110 §12.5.3. An absent header is not
 * a wildcard here: it means the client never said, and a client that never
 * said gets the bytes it can certainly read.
 */
export function acceptsGzip(acceptEncoding: string | null | undefined): boolean {
  if (!acceptEncoding) return false;

  let wildcard: boolean | null = null;
  for (const part of acceptEncoding.split(",")) {
    const [token, ...params] = part.split(";");
    const coding = token.trim().toLowerCase();
    if (coding !== "gzip" && coding !== "*") continue;

    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="));
    // A malformed weight is treated as a refusal rather than as absent: the
    // client wrote something about this coding and it could not be read.
    const weight = q === undefined ? 1 : Number(q.slice(2));
    const acceptable = Number.isFinite(weight) && weight > 0;

    if (coding === "gzip") return acceptable;
    wildcard = acceptable;
  }
  return wildcard === true;
}

export function shouldGzip(
  byteLength: number,
  acceptEncoding: string | null | undefined,
): boolean {
  if (byteLength < GZIP_FLOOR_BYTES) return false;
  return acceptsGzip(acceptEncoding);
}

/**
 * A JSON response, gzipped when the client accepts it and the body is worth
 * the pass. Otherwise byte-identical to what `NextResponse.json` would have
 * sent, minus the encoding headers.
 *
 * ## Why this exists at all
 *
 * Next installs its `compression` hook on **every** request — `router-server.js`
 * calls it unconditionally unless `config.compress === false`, which this app
 * does not set — and HTML from this same server does come back gzipped. No
 * `/api` response ever did, and the tell was the absent `Vary: Accept-Encoding`
 * rather than the absent `Content-Encoding`: the hook sets `Vary` *before* it
 * checks the size threshold, so a response missing `Vary` never reached the
 * threshold check.
 *
 * The reason is not that route handlers flush their own headers — they do, in
 * `pipe-readable.js`, but that happens through the patched `writeHead` and the
 * hook fires normally. It is that `sendResponse` copies a route handler's
 * headers across with `NodeNextResponse.appendHeader`, which stores **every**
 * value as an array (`base-http/node.js`): the raw response then holds
 * `content-type: ['application/json']`, `compression`'s default filter asks
 * `compressible()` about it, and `compressible()` returns false for anything
 * that is not a string. Every app-router route handler in this version is
 * filtered out of compression by a one-element array. Reproduced against
 * Next 15.5.23's own `sendResponse` and its own bundled `compression`, with
 * `DEBUG=compression` printing `not compressible` then `no compression:
 * filtered` for the handler path and `gzip compression` for a plain
 * `res.end()` on the same server.
 *
 * That also means this helper cannot be double-compressed: the hook bails on
 * the array before it looks at anything else, and were a future Next to fix
 * `appendHeader`, the next thing it checks is `Content-Encoding !== identity`,
 * which this sets. Both roads end in `nocompress`.
 *
 * ## Why the async zlib
 *
 * `gzipSync` would be one line shorter and is refused. This process runs the
 * fleet: twenty-five agents' worth of guards, the SSE bus, and the run loop's
 * own budget checks all live on this event loop, and a guard that evaluates
 * late is a run that spends past its ceiling. Measured here, `gzipSync` on the
 * 8.8 MB `/api/knowledge/graph` body blocks for 30.6 ms and fires **zero**
 * timer callbacks while it does, against 43 in an idle 50 ms; `/api/runs` at
 * 698 KB blocks for 10 ms. The promisified form costs the same wall clock
 * (28.7 ms and 10.3 ms) and spends it on the libuv threadpool instead. Note
 * that the threadpool is four wide by default and shared with every `fs` call
 * this app makes, which is the reason for the size floor above as much as the
 * byte count is.
 *
 * ## Vary
 *
 * Set on the uncompressed branch too. Nothing caches in front of a stock
 * install — compose binds 127.0.0.1 and the browser is the only client — but
 * an operator terminating TLS in front of this app is exactly the deployment
 * `next.config.ts` already sends HSTS for, and a shared cache that stored one
 * client's gzipped `/api/runs` and served it to a client that did not ask for
 * gzip would hand over a body that client cannot read. Announcing it on one
 * branch only is the version of that bug that survives testing, because the
 * response you test with is the compressed one.
 */
export async function jsonMaybeGzipped(
  request: Request,
  body: unknown,
  init?: ResponseInit,
): Promise<Response> {
  const raw = Buffer.from(JSON.stringify(body), "utf8");

  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.append("Vary", "Accept-Encoding");

  if (!shouldGzip(raw.byteLength, request.headers.get("accept-encoding"))) {
    return new Response(raw, { ...init, headers });
  }

  const packed = await gzipAsync(raw);
  headers.set("Content-Encoding", "gzip");
  // Safe to state because the whole body is in hand: a Content-Length that
  // disagreed with what is written would break the connection rather than the
  // page. Route handlers otherwise answer chunked, so this is also what lets
  // a browser draw a progress bar on the 494 KB graph.
  headers.set("Content-Length", String(packed.byteLength));
  return new Response(packed, { ...init, headers });
}
