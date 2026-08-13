import { strict as assert } from "node:assert";
import { test } from "node:test";
import { actionFailureMessage, jsonRequest } from "./jsonRequest";

/**
 * Every page here reports a failed request by rendering a sentence, and there
 * are two ways to end up rendering nothing at all. `fetch` rejects on a dropped
 * connection, a restarting container or a proxy blip, and a handler that never
 * catches it leaves the page exactly as it was — the press did nothing visible,
 * which is what a press that did nothing also looks like. A response that is
 * unsuccessful, or successful and not JSON, is the same failure arriving by the
 * other door.
 *
 * So what this pins is that the function *returns*, in every one of those
 * cases, carrying enough to say which happened: `status: null` is nobody
 * answered, a number is somebody refused. The callers need that split because
 * they render different copy for it — `pollFailureMessage(null, …)` on a poll,
 * and a sentence about a request that may or may not have been carried out on a
 * Land, a Purge or a Delete, which is the one press here with no undo.
 */

async function withFetch(stub: typeof fetch, run: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("a transport failure comes back as a result with no status", async () => {
  await withFetch(
    () => Promise.reject(new TypeError("Failed to fetch")),
    async () => {
      // `assert.rejects`' opposite: the await itself is the assertion, and a
      // rejection here is the one the pages could not recover from.
      const result = await jsonRequest("/api/branches/queue", {
        method: "POST",
        body: { runIds: ["r1"] },
      });
      assert.deepEqual(result, {
        ok: false,
        status: null,
        error: "Failed to fetch",
      });
    },
  );
});

test("a rejection that is not an Error still yields a sentence", async () => {
  await withFetch(
    () => Promise.reject("offline"),
    async () => {
      const result = await jsonRequest("/api/runs/r1/land");
      assert.deepEqual(result, { ok: false, status: null, error: "offline" });
    },
  );
});

test("a refusal keeps the server's own words and its status", async () => {
  await withFetch(
    async () =>
      new Response(JSON.stringify({ error: "Your checkout is not clean." }), {
        status: 400,
      }),
    async () => {
      const result = await jsonRequest("/api/runs/r1/land", {
        method: "POST",
        body: { action: "land" },
      });
      assert.deepEqual(result, {
        ok: false,
        status: 400,
        error: "Your checkout is not clean.",
      });
    },
  );
});

test("a refusal with no message of its own leaves the sentence to the caller", async () => {
  await withFetch(
    async () => new Response("<html>502</html>", { status: 502 }),
    async () => {
      const result = await jsonRequest("/api/runs/r1/land");
      assert.deepEqual(result, { ok: false, status: 502, error: null });
    },
  );
});

test("a success that is not JSON is a failure, not an empty payload", async () => {
  await withFetch(
    async () => new Response("<html>hello</html>", { status: 200 }),
    async () => {
      const result = await jsonRequest("/api/runs/r1/land");
      // The land card read `await res.json()` unguarded, so this threw out of a
      // `void load()` and the card kept rendering the last snapshot. Reported
      // as a failure it is a sentence instead.
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.status, 200);
    },
  );
});

test("a successful answer carries the payload back", async () => {
  await withFetch(
    async () =>
      new Response(JSON.stringify({ state: null, defaultStrategy: "merge" }), {
        status: 200,
      }),
    async () => {
      const result = await jsonRequest<{ defaultStrategy: string }>(
        "/api/runs/r1/land",
      );
      assert.equal(result.ok, true);
      assert.equal(result.ok === true && result.data.defaultStrategy, "merge");
    },
  );
});

test("the request goes out as the caller described it", async () => {
  let seen: { url: string; init: RequestInit | undefined } | null = null;
  await withFetch(
    async (url, init) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    async () => {
      // The merge queue is cancelled with a DELETE carrying a body, so neither
      // the method nor the body can be assumed from the other.
      await jsonRequest("/api/branches/queue", {
        method: "DELETE",
        body: { batchId: "b1" },
      });
    },
  );
  const sent = seen as unknown as { url: string; init: RequestInit };
  assert.equal(sent.url, "/api/branches/queue");
  assert.equal(sent.init.method, "DELETE");
  assert.equal(sent.init.body, JSON.stringify({ batchId: "b1" }));
  // Every read here is a poll of state that moves; a cached answer is a page
  // that has stopped refreshing without saying so.
  assert.equal(sent.init.cache, "no-store");
});

test("a read with no body is a GET", async () => {
  let method: string | undefined;
  await withFetch(
    async (_url, init) => {
      method = init?.method;
      return new Response("{}", { status: 200 });
    },
    async () => {
      await jsonRequest("/api/runs/r1/land");
    },
  );
  assert.equal(method, "GET");
});

test("a request that never arrived says so, and says it may have arrived", async () => {
  const msg = actionFailureMessage(
    { ok: false, status: null, error: "Failed to fetch" },
    "That did not work.",
  );
  assert.match(msg, /Failed to fetch/);
  // Purge destroys committed work. An operator who cannot tell whether the
  // request landed must not be nudged into pressing it a second time.
  assert.match(msg, /may/i);
  assert.doesNotMatch(msg, /That did not work/);
});

test("a refusal the server explained is rendered in its own words", async () => {
  assert.equal(
    actionFailureMessage(
      { ok: false, status: 400, error: "Your checkout is not clean." },
      "That did not work.",
    ),
    "Your checkout is not clean.",
  );
});

test("a refusal with nothing to say falls back to the caller's sentence", async () => {
  assert.equal(
    actionFailureMessage({ ok: false, status: 500, error: null }, "Could not queue those."),
    "Could not queue those.",
  );
  // `{"error":""}` is a server that answered and explained nothing — the same
  // hole `pollFailureMessage` refuses to leave on a poll.
  assert.equal(
    actionFailureMessage({ ok: false, status: 500, error: "" }, "Could not queue those."),
    "Could not queue those.",
  );
});

test("a lapsed session is named, because it is the one the operator can fix", async () => {
  assert.match(
    actionFailureMessage({ ok: false, status: 401, error: null }, "That did not work."),
    /[Ss]ign/,
  );
});
