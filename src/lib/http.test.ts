import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acceptsGzip, jsonNoStore, shouldGzip } from "./http";

/**
 * Covers `jsonNoStore`, and the wiring of the one page that has nothing but a
 * poll to learn from.
 *
 * The chat page has no SSE stream to correct it, so a cached body is the last
 * thing it ever sees; the status it can freeze on is `thinking`, which
 * disables the composer. That failure is silent by construction — every layer
 * involved is behaving correctly, the response simply never said not to store
 * it — which is the bar the rest of this suite is reserved for.
 *
 * The wiring half reads source text, which no other test here does. The
 * handlers cannot be called from `node --test`: they import through the `@/`
 * alias, which plain CommonJS does not resolve, and reaching one would open
 * SQLite. A header on the wire has no pure function behind it to test, so the
 * choice is a text assertion or no regression test at all.
 */

const src = (...parts: string[]) => readFileSync(join(process.cwd(), "src", ...parts), "utf8");

describe("jsonNoStore", () => {
  it("declares the body uncacheable", () => {
    const res = jsonNoStore({ ok: true });
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  });

  it("still answers with the body and status the caller asked for", async () => {
    const res = jsonNoStore({ error: "Not found" }, { status: 404 });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found" });
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  });

  it("keeps the caller's other headers", () => {
    const res = jsonNoStore({}, { headers: { "X-Thing": "kept" } });
    assert.equal(res.headers.get("x-thing"), "kept");
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  });
});

describe("the chat routes and the chat poll opt out of the HTTP cache", () => {
  // `dynamic = "force-dynamic"` governs Next's own caching and puts nothing on
  // the wire, so a JSON reply built any other way ships with no directive.
  for (const route of [["app", "api", "chat", "route.ts"], ["app", "api", "chat", "[id]", "route.ts"]]) {
    it(`${route.join("/")} answers through jsonNoStore`, () => {
      const text = src(...route);
      assert.match(text, /jsonNoStore\(/);
      assert.doesNotMatch(
        text,
        /NextResponse\.json\(/,
        "a polled chat route must not answer with a response carrying no cache directive",
      );
    });

    // The poll itself moved off `jsonNoStore` onto `jsonMaybeGzipped`, which
    // knows nothing about caching, so the assertion above no longer covers the
    // one response that matters — the small 404 and the POST still match it.
    // The directive has to be written at the call site now, and losing it is
    // silent in exactly the way the whole file describes.
    it(`${route.join("/")}'s compressed reply still declares no-store`, () => {
      const text = src(...route);
      for (const call of text.match(/jsonMaybeGzipped\([\s\S]*?\n  \);/g) ?? []) {
        assert.match(
          call,
          /"Cache-Control": "no-store"/,
          "a gzipped chat reply carries no cache directive of its own",
        );
      }
      assert.match(text, /jsonMaybeGzipped\(/, "the chat poll is the body worth compressing");
    });
  }

  it("the chat page polls with cache: no-store, like every other poller", () => {
    assert.match(src("app", "chat", "page.tsx"), /fetch\([^)]*"\/api\/chat"[^)]*cache:\s*"no-store"/);
  });
});

/**
 * The compress-or-not decision, which is the whole of `jsonMaybeGzipped` that
 * can be wrong quietly.
 *
 * Both directions fail in silence. Declining gzip where it was wanted only
 * makes the responses large again — nothing breaks, the saving simply never
 * appears, and the page still works. *Offering* it to a client that said
 * `identity`, or that spelled `gzip;q=0` — which is how RFC 9110 §12.5.3 has a
 * client refuse a coding it must nonetheless name — hands back bytes that
 * client will not decode, and what the operator sees is one browser rendering
 * a page and another showing nothing.
 *
 * The zlib round trip is deliberately not covered: it is Node's, it either
 * works or throws, and a test of it would assert that gzip is gzip. What is
 * tested here is the header grammar and the floor.
 */
describe("shouldGzip decides on the header and the size", () => {
  const BIG = 100_000;
  const SMALL = 300;

  it("compresses a large body for a client that asked plainly", () => {
    assert.equal(shouldGzip(BIG, "gzip"), true);
    assert.equal(shouldGzip(BIG, "gzip, deflate, br"), true);
    assert.equal(shouldGzip(BIG, "br;q=1.0, gzip;q=0.8, *;q=0.1"), true);
  });

  it("leaves a small body alone however willing the client is", () => {
    // Measured: 169 bytes of JSON gzips to 178 — the answer gets *larger*, and
    // even where it does not, a body inside one TCP segment saves no round trip.
    assert.equal(shouldGzip(SMALL, "gzip"), false);
    assert.equal(shouldGzip(0, "gzip"), false);
  });

  it("treats the floor as the first size that pays", () => {
    assert.equal(shouldGzip(1399, "gzip"), false);
    assert.equal(shouldGzip(1400, "gzip"), true);
  });

  it("refuses a client that did not offer gzip", () => {
    assert.equal(shouldGzip(BIG, null), false);
    assert.equal(shouldGzip(BIG, undefined), false);
    assert.equal(shouldGzip(BIG, ""), false);
    assert.equal(shouldGzip(BIG, "identity"), false);
    assert.equal(shouldGzip(BIG, "deflate, br"), false);
  });
});

describe("acceptsGzip reads the header the way RFC 9110 asks", () => {
  it("honours q=0 as a refusal, not as a preference", () => {
    // The trap: `"gzip;q=0".includes("gzip")` is true, and a substring check
    // here would compress a body for the one client that spelled out it must
    // not be. `q=0.0` and `q=0.000` are the same refusal.
    assert.equal(acceptsGzip("gzip;q=0"), false);
    assert.equal(acceptsGzip("gzip;q=0.0"), false);
    assert.equal(acceptsGzip("gzip; q=0.000"), false);
    assert.equal(acceptsGzip("gzip;q=0.001"), true);
  });

  it("accepts a wildcard, and lets an explicit gzip overrule it either way round", () => {
    assert.equal(acceptsGzip("*"), true);
    assert.equal(acceptsGzip("*;q=0"), false);
    // An explicit entry outranks the wildcard whichever order they arrive in.
    assert.equal(acceptsGzip("*, gzip;q=0"), false);
    assert.equal(acceptsGzip("gzip;q=0, *"), false);
    assert.equal(acceptsGzip("*;q=0, gzip"), true);
    assert.equal(acceptsGzip("gzip, *;q=0"), true);
  });

  it("ignores case and whitespace, which a client is free to vary", () => {
    assert.equal(acceptsGzip("GZIP"), true);
    assert.equal(acceptsGzip("  gzip  ;  Q=0.5 "), true);
    assert.equal(acceptsGzip("deflate,gzip"), true);
  });

  it("does not mistake another coding for gzip", () => {
    // `x-gzip` is a real alias in the wild and is deliberately not honoured:
    // nothing this app answers speaks it, and matching loosely on "gzip" is
    // what would make `not-gzip` acceptable too.
    assert.equal(acceptsGzip("x-gzip"), false);
    assert.equal(acceptsGzip("gzipped"), false);
    assert.equal(acceptsGzip("br, zstd"), false);
  });

  it("reads an unparseable weight as a refusal rather than as absent", () => {
    // The client said something about gzip that could not be read. Answering
    // with an encoding on the strength of a header nobody could parse is the
    // version of this that produces an unreadable page.
    assert.equal(acceptsGzip("gzip;q=banana"), false);
    assert.equal(acceptsGzip("gzip;q="), false);
  });
});
