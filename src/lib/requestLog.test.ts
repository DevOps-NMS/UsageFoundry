import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * What a mutating request leaves behind, and — the half that matters more —
 * what it does not.
 *
 * The audit line is the only record that a request happened at all, so it is
 * the one place in this app where *adding* a field is the dangerous direction.
 * Every mutating request goes through this wrapper: `POST /api/runs` carries
 * the prompt of every run, `POST /api/login` carries the master token in its
 * body, and a query string is where a credential ends up when somebody puts one
 * there by mistake. A body-logging line here would write the credential this
 * app exists to protect into a table and onto stdout, and nothing would fail —
 * it would typecheck, pass every other test, and be discovered by whoever reads
 * the logs.
 *
 * So this drives the wrapper against handlers that are handed exactly those
 * things and asserts the row is method, path, status, subject, actor class,
 * address and duration, with the secret nowhere in it.
 *
 * Its own file with `DATA_DIR` set before the first import, for
 * `runOrigin.test.ts`'s reason.
 */

let root: string;
let requestLog: typeof import("./requestLog");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-request-log-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  requestLog = await import("./requestLog");
  dbMod = await import("./db");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM request_log").run();
});

const SECRET = "s3cret-token-value";

/** The whole row, as SQLite holds it — not the DTO the wrapper was handed. */
function rows(): Array<Record<string, unknown>> {
  return dbMod
    .db()
    .prepare("SELECT * FROM request_log ORDER BY id")
    .all() as Array<Record<string, unknown>>;
}

describe("a mutating request leaves one line", () => {
  it("names the method, path, status, actor and source address", async () => {
    const handler = requestLog.auditMutation(async (_req: Request) =>
      Response.json({ ok: true }, { status: 201 }),
    );

    await handler(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "x-forwarded-for": "203.0.113.7, 10.0.0.1",
        },
        body: JSON.stringify({ prompt: "do the thing" }),
      }),
    );

    const [row] = rows();
    assert.equal(row.method, "POST");
    assert.equal(row.path, "/api/runs");
    assert.equal(row.status, 201);
    // The credential *class*, never the credential.
    assert.equal(row.actor, "bearer");
    // The first hop only: the rest of that header is whatever the client felt
    // like sending and is not evidence of anything.
    assert.equal(row.address, "203.0.113.7");
    assert.equal(typeof row.duration_ms, "number");
  });

  it("carries no body, no query string, no token and no cookie", async () => {
    const handler = requestLog.auditMutation(async (_req: Request) =>
      Response.json({ ok: true }),
    );

    await handler(
      new Request(`http://localhost/api/login?token=${SECRET}`, {
        method: "POST",
        headers: { cookie: `uf_session=${SECRET}` },
        body: JSON.stringify({ token: SECRET, prompt: "do the secret thing" }),
      }),
    );

    const [row] = rows();
    const serialised = JSON.stringify(row);
    assert.ok(
      !serialised.includes(SECRET),
      `the audit row carries the credential: ${serialised}`,
    );
    assert.ok(
      !serialised.includes("do the secret thing"),
      `the audit row carries the request body: ${serialised}`,
    );
    // `pathname` and nothing after it, so a credential somebody put in a query
    // string does not become permanent.
    assert.equal(row.path, "/api/login");
    assert.equal(row.actor, "session");
  });

  it("names the row a dynamic route acted on", async () => {
    const handler = requestLog.auditMutation(
      async (_req: Request, _ctx: { params: Promise<{ id: string }> }) =>
        Response.json({ ok: true }),
    );

    await handler(
      new Request("http://localhost/api/runs/run-42", { method: "DELETE" }),
      { params: Promise.resolve({ id: "run-42" }) },
    );

    assert.equal(rows()[0].subject, "run-42");
  });

  it("prefers the instance over the workflow, which is what changed", async () => {
    const handler = requestLog.auditMutation(
      async (
        _req: Request,
        _ctx: { params: Promise<{ id: string; instanceId: string }> },
      ) => Response.json({ ok: true }),
    );

    await handler(
      new Request("http://localhost/api/workflows/w-1/instances/i-9/stop", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "w-1", instanceId: "i-9" }) },
    );

    assert.equal(rows()[0].subject, "i-9");
  });

  it("takes the created id from the header a handler names, and strips it", async () => {
    // The one case a path cannot supply: a creation mints the id inside the
    // handler, and the wrapper will not read a response body to find it.
    const handler = requestLog.auditMutation(async (_req: Request) => {
      const res = Response.json({ run: { id: "new-run" } });
      res.headers.set(requestLog.SUBJECT_HEADER, "new-run");
      return res;
    });

    const res = await handler(
      new Request("http://localhost/api/runs", { method: "POST" }),
    );

    assert.equal(rows()[0].subject, "new-run");
    assert.equal(
      res.headers.get(requestLog.SUBJECT_HEADER),
      null,
      "the audit header must not leave with the response",
    );
  });

  it("records a refusal, which is the line an audit most wants", async () => {
    const handler = requestLog.auditMutation(async (_req: Request) =>
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );
    await handler(new Request("http://localhost/api/settings", { method: "PUT" }));

    const [row] = rows();
    assert.equal(row.status, 401);
    // No credential at all is its own answer, and a distinct one.
    assert.equal(row.actor, "open");
  });

  it("records a handler that threw, then lets it through", async () => {
    const handler = requestLog.auditMutation(async (_req: Request) => {
      throw new Error("something went wrong");
    });

    await assert.rejects(
      handler(new Request("http://localhost/api/templates", { method: "POST" })),
      /something went wrong/,
    );

    const [row] = rows();
    assert.equal(row.status, 500);
    assert.equal(row.path, "/api/templates");
  });

  it("calls the chat's per-turn capability what it is", async () => {
    const handler = requestLog.auditMutation(async (_req: Request) => Response.json({}));
    await handler(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );

    // Not "bearer": that route's credential is minted per chat turn and dies
    // with it, which is a different thing to have been used than the token that
    // opens every route in the app.
    assert.equal(rows()[0].actor, "capability");
  });
});
