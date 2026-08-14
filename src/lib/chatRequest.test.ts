import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chatRequest } from "./chatRequest";

/**
 * The chat page's `busy` flag disables the composer, Approve, Reject and
 * Select-all at once, and the only code that clears it is the two handlers that
 * set it. So the question this pins is not what the request returns but whether
 * it returns at all: `fetch` rejects on any transport failure — a server
 * restarting, a dropped connection, a proxy blip — and a rejection escaping the
 * handler skips its reset, leaving every button on the page disabled until a
 * reload with nothing said about why. Nothing throws where a reader can see it,
 * and the page carries on polling as though it had not happened.
 *
 * The other half is that the *reason* survives. A failed result with no message
 * is indistinguishable from a refusal the server explained, and the caller
 * would have to invent a sentence for both.
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

test("a transport failure comes back as a result, never as a rejection", async () => {
  await withFetch(
    () => Promise.reject(new TypeError("fetch failed")),
    async () => {
      // `assert.rejects`' opposite: the await itself is the assertion, and a
      // rejection here is the failure the chat page could not recover from.
      const result = await chatRequest("/api/chat/c1/message", { message: "hi" });
      assert.equal(result.ok, false);
      assert.equal(
        result.ok === false && result.error,
        "fetch failed",
        "the operator is told why the request did not go",
      );
    },
  );
});

test("a rejection that is not an Error still yields a sentence", async () => {
  await withFetch(
    () => Promise.reject("offline"),
    async () => {
      const result = await chatRequest("/api/chat/c1/message", { message: "hi" });
      assert.deepEqual(result, { ok: false, error: "offline" });
    },
  );
});

test("a refusal the server explained is reported in its own words", async () => {
  await withFetch(
    async () =>
      new Response(JSON.stringify({ error: "That chat is already thinking." }), {
        status: 409,
      }),
    async () => {
      const result = await chatRequest("/api/chat/c1/proposals", {
        action: "approve",
        ids: ["p1"],
      });
      assert.deepEqual(result, {
        ok: false,
        error: "That chat is already thinking.",
      });
    },
  );
});

test("a refusal with no message of its own leaves the sentence to the caller", async () => {
  await withFetch(
    async () => new Response("<html>502</html>", { status: 502 }),
    async () => {
      const result = await chatRequest("/api/chat/c1/message", { message: "hi" });
      assert.deepEqual(result, { ok: false, error: null });
    },
  );
});

test("a bodyless call still POSTs — Stop's route answers 405 to a GET", async () => {
  let seen: { method?: string; body?: unknown } | undefined;
  await withFetch(
    async (_url, init) => {
      seen = { method: init?.method, body: init?.body };
      return new Response(JSON.stringify({ chat: { id: "c1" } }), { status: 200 });
    },
    async () => {
      await chatRequest("/api/chat/c1/cancel");
    },
  );
  assert.equal(seen?.method, "POST");
  assert.equal(seen?.body, undefined);
});

test("Stop's shape releases the flag when the fetch rejects", async () => {
  // The handler itself is under `src/app`, which `tsconfig.test.json` does not
  // compile, so what is driven here is its shape: the flag that disables the
  // composer, Send, Stop, Select-all, Reject and Approve is set, the request is
  // made, and the `finally` is the only thing that clears it. Stop held a bare
  // `fetch` with no `try` and so never reached that line — every control on the
  // page disabled until a reload, with nothing on screen saying why.
  let busy = false;
  let sendError: string | null = null;
  await withFetch(
    () => Promise.reject(new TypeError("fetch failed")),
    async () => {
      busy = true;
      try {
        const result = await chatRequest("/api/chat/c1/cancel");
        if (!result.ok) sendError = result.error ?? "The turn could not be stopped.";
      } finally {
        busy = false;
      }
    },
  );
  assert.equal(busy, false, "the page comes back without a reload");
  assert.equal(sendError, "fetch failed", "and says why the press did nothing");
});

test("a successful request carries the chat back", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ chat: { id: "c1" } }), { status: 200 }),
    async () => {
      const result = await chatRequest("/api/chat/c1/message", { message: "hi" });
      assert.equal(result.ok, true);
      assert.equal(result.ok === true && result.chat?.id, "c1");
    },
  );
});
