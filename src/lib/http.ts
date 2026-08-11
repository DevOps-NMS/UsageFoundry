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
