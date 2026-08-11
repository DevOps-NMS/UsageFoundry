import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { jsonNoStore } from "./http";

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
  }

  it("the chat page polls with cache: no-store, like every other poller", () => {
    assert.match(src("app", "chat", "page.tsx"), /fetch\([^)]*"\/api\/chat"[^)]*cache:\s*"no-store"/);
  });
});
