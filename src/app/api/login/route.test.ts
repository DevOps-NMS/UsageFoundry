import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * What `POST /api/login` puts in the browser's jar, and what it does with a
 * wrong guess.
 *
 * Both defects behind this file are silent. The cookie *was* `UF_AUTH_TOKEN`
 * byte for byte, so a captured one was the master credential — replayable as a
 * bearer header against every route, good for thirty days, and revocable only
 * by changing the environment and restarting the container. And the handler
 * accepted unlimited guesses at that same secret with no counter, no lockout
 * and no record: the 400 ms sleep is an `await` on a timer, so it serialises
 * nothing and two hundred concurrent connections guess at the rate of the event
 * loop.
 *
 * It opens the database rather than calling a pure function because what it
 * pins is the *response* — a `Set-Cookie` value and a status code are the whole
 * of what a browser and an attacker respectively see, and neither is reachable
 * from the pure halves this suite otherwise prefers. `DATA_DIR` and
 * `UF_AUTH_TOKEN` are read into `config.ts` at module load, so they are set
 * before the first import and the assertion in `before` is what stops a change
 * to that writing into the operator's own database.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";

let root: string;
let route: typeof import("./route");
let logout: typeof import("../logout/route");
let sessions: typeof import("../../../lib/sessions");
let sessionToken: typeof import("../../../lib/sessionToken");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-login-route-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.UF_AUTH_TOKEN = TOKEN;
  process.env.UF_COOKIE_SECURE = "";

  const config = await import("../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  assert.equal(config.AUTH_TOKEN, TOKEN);

  route = await import("./route");
  logout = await import("../logout/route");
  sessions = await import("../../../lib/sessions");
  sessionToken = await import("../../../lib/sessionToken");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A fresh source per case: the limiter counts per address, so cases must not share one. */
let nextSource = 0;
const newSource = () => `10.0.0.${++nextSource}`;

async function post(
  token: string,
  o: { source?: string; proto?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": o.source ?? newSource(),
  };
  if (o.proto) headers["x-forwarded-proto"] = o.proto;
  return route.POST(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
    }),
  );
}

function setCookie(res: Response): string {
  const header = res.headers.get("set-cookie");
  assert.ok(header, "a successful sign-in must set a cookie");
  return header;
}

const cookieValue = (header: string) =>
  header.slice(header.indexOf("=") + 1).split(";")[0];

test("the cookie is not the configured token", async () => {
  const res = await post(TOKEN);
  assert.equal(res.status, 200);

  const header = setCookie(res);
  const value = cookieValue(header);

  assert.notEqual(value, TOKEN);
  assert.equal(
    header.includes(TOKEN),
    false,
    "the master secret must not appear anywhere in the Set-Cookie header",
  );
  // And it is a real session rather than an opaque string nothing knows about:
  // the id inside it names a row that a sign-out can revoke.
  const claim = await sessionToken.readSessionCookie(value, TOKEN, Date.now());
  assert.ok(claim, "the cookie must verify against the server's own key");
  assert.ok(sessions.getSession(claim.id), "the session must be recorded");
});

test("two sign-ins are two sessions", async () => {
  const before = sessions.activeSessionCount();
  await post(TOKEN);
  await post(TOKEN);
  assert.equal(sessions.activeSessionCount(), before + 2);
});

test("a sign-out revokes the session it was given", async () => {
  const value = cookieValue(setCookie(await post(TOKEN)));
  const claim = await sessionToken.readSessionCookie(value, TOKEN, Date.now());
  assert.ok(claim);

  const res = await logout.POST(
    new Request("http://localhost/api/logout", {
      method: "POST",
      headers: { cookie: `uf_session=${value}` },
    }),
  );
  assert.equal(res.status, 200);
  assert.notEqual(
    sessions.getSession(claim.id)?.revokedAt ?? null,
    null,
    "signing out must end the session server-side, not only in the jar",
  );
  // The browser is told to drop it as well, with the path it was set with.
  const header = res.headers.get("set-cookie") ?? "";
  assert.match(header, /uf_session=/);
  assert.match(header, /Max-Age=0/i);
});

test("Secure is set when the request reached us over HTTPS", async () => {
  assert.equal(
    /;\s*Secure/i.test(setCookie(await post(TOKEN, { proto: "https" }))),
    true,
  );
  // …and not on the loopback HTTP case, where a Secure cookie would never come
  // back and sign-in would appear to work and then not.
  assert.equal(/;\s*Secure/i.test(setCookie(await post(TOKEN))), false);
});

test("the cookie is httpOnly and SameSite=Lax", async () => {
  const header = setCookie(await post(TOKEN));
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=lax/i);
});

test("a wrong token is refused", async () => {
  const res = await post("wrong");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});
