import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SESSION_TTL_MS,
  cookieIsSecure,
  mintSessionCookie,
  newSessionId,
  readSessionCookie,
} from "./sessionToken";

/**
 * What the `uf_session` cookie may and may not be.
 *
 * The defect these pin is not a crash: the cookie *was* `UF_AUTH_TOKEN`, set
 * for thirty days with `secure: false`, and everything about that typechecked
 * and worked. What it cost was that a captured cookie was the master
 * credential — replayable as a bearer header, unexpiring in practice, and
 * revocable only by editing `.env` and restarting the container.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const NOW = 1_760_000_000_000;

test("the cookie is not the token, and does not contain it", async () => {
  const cookie = await mintSessionCookie(newSessionId(), NOW + 1000, TOKEN);
  assert.notEqual(cookie, TOKEN);
  assert.equal(
    cookie.includes(TOKEN),
    false,
    "a captured cookie must not hand over the secret it was signed with",
  );
});

test("two sign-ins with one token yield different cookies", async () => {
  const a = await mintSessionCookie(newSessionId(), NOW + 1000, TOKEN);
  const b = await mintSessionCookie(newSessionId(), NOW + 1000, TOKEN);
  // The old cookie was the same constant for every browser on every install,
  // which is why revoking one meant revoking all of them.
  assert.notEqual(a, b);
});

test("a cookie this server signed proves its id and its expiry", async () => {
  const id = newSessionId();
  const expiresAt = NOW + SESSION_TTL_MS;
  const claim = await readSessionCookie(
    await mintSessionCookie(id, expiresAt, TOKEN),
    TOKEN,
    NOW,
  );
  assert.ok(claim);
  assert.equal(claim.id, id);
  // Seconds on the wire, so the instant comes back floored rather than equal.
  assert.equal(claim.expiresAt, Math.floor(expiresAt / 1000) * 1000);
});

test("the token itself is not a valid session cookie", async () => {
  // The other half of "the cookie is not the token": presenting the secret in
  // the cookie slot must not work either, or the change would be cosmetic.
  assert.equal(await readSessionCookie(TOKEN, TOKEN, NOW), null);
});

test("a cookie signed with another token is refused", async () => {
  const cookie = await mintSessionCookie(newSessionId(), NOW + 1000, "other");
  assert.equal(await readSessionCookie(cookie, TOKEN, NOW), null);
});

test("an edited expiry is refused, because the expiry is signed", async () => {
  const id = newSessionId();
  const cookie = await mintSessionCookie(id, NOW + 1000, TOKEN);
  const [v, , , sig] = cookie.split(".");
  const forged = [v, id, String(Math.floor(NOW / 1000) + 99_999), sig].join(".");
  assert.equal(await readSessionCookie(forged, TOKEN, NOW), null);
});

test("an expired cookie is refused by the server, not left to the browser", async () => {
  const cookie = await mintSessionCookie(newSessionId(), NOW - 1000, TOKEN);
  assert.equal(await readSessionCookie(cookie, TOKEN, NOW), null);
});

test("garbage is refused rather than thrown on", async () => {
  for (const value of ["", "..", "v1.a.b", "v2.a.1.b", "v1..1.sig", "x"]) {
    assert.equal(
      await readSessionCookie(value, TOKEN, NOW),
      null,
      `"${value}" must be refused`,
    );
  }
});

test("an empty signing key verifies nothing", async () => {
  // Unreachable while the gate returns early on an empty token, and the one
  // case where a mistake would make every forged cookie valid at once. Web
  // Crypto refuses to import a zero-length HMAC key, so the guard is what
  // stands between a caller that passed "" and a thrown request.
  const cookie = await mintSessionCookie(newSessionId(), NOW + 1000, TOKEN);
  assert.equal(await readSessionCookie(cookie, "", NOW), null);
});

test("Secure follows the request, and the override answers both ways", () => {
  const at = (o: Partial<Parameters<typeof cookieIsSecure>[0]>) =>
    cookieIsSecure({
      forwardedProto: null,
      protocol: "http:",
      override: "",
      ...o,
    });

  // Loopback HTTP sign-in still works — the case the flag was left off for.
  assert.equal(at({}), false);
  assert.equal(at({ protocol: "https:" }), true);
  // Behind a terminator this process sees plain HTTP, so this is the only
  // signal that the browser's hop was TLS.
  assert.equal(at({ forwardedProto: "https" }), true);
  assert.equal(at({ forwardedProto: "https, http" }), true, "first hop wins");
  assert.equal(at({ forwardedProto: "http", protocol: "https:" }), false);
  assert.equal(at({ override: "1" }), true);
  assert.equal(at({ override: "0", protocol: "https:" }), false);
  // Anything else is not an answer and must not be read as one.
  assert.equal(at({ override: "true" }), false);
});
