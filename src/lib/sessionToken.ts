/**
 * The `uf_session` cookie: what it is, and what the gate may conclude from it.
 *
 * It used to be `UF_AUTH_TOKEN` itself, set for thirty days. So the browser jar
 * held the master credential — the same string that opens every route as a
 * bearer header, that `telemetryEnv` hands a spawned agent, and that the
 * operator would have to change (and restart the container, killing every run
 * in flight) to invalidate. Anything that ever read that cookie held the app
 * for a month.
 *
 * What replaces it is a *handle*: 32 random bytes naming a row in
 * `auth_sessions`, an absolute expiry, and an HMAC over both keyed by
 * `UF_AUTH_TOKEN`. Three properties follow, and each answers one half of the
 * old shape:
 *
 * - the value is not the token, so a captured cookie is not a bearer credential
 *   and opens nothing that keys on the token itself;
 * - the expiry is *inside* the signature, so a cookie that outlives its window
 *   is refused by the server rather than merely deleted by a browser that may
 *   never be asked;
 * - the id names a row, so a sign-out is a revocation somebody can see and
 *   count, rather than an operation with no server-side referent at all.
 *
 * It is signed rather than looked up because of where the check happens.
 * `middleware.ts` runs in the edge runtime and cannot reach SQLite — the same
 * constraint that produced the `/api/mcp` exemption — so the gate has to be
 * able to decide from the cookie alone. Everything here is therefore Web
 * Crypto and string handling and imports nothing: no `node:crypto`, no
 * `lib/config`, nothing that would pull `node:fs` into the edge bundle.
 *
 * What that costs is written down rather than absorbed: a revoked session's
 * cookie, if it was *captured*, is still signature-valid at the edge until its
 * own expiry, because the gate that admits it cannot read the revocation. The
 * window is `SESSION_TTL_MS` rather than the thirty days it was, revocation is
 * recorded and visible, and closing the gap properly means moving the gate off
 * the edge runtime — a change to what `middleware.ts` *is*, not to this file.
 */

/** How long an issued session is good for, absolutely — no sliding renewal. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "uf_session";

/**
 * The format marker, and it is inside the signed payload rather than beside it.
 * A version that could be edited without invalidating the signature would be a
 * downgrade path to whatever the next format's weakest predecessor was.
 */
const VERSION = "v1";

export interface SessionClaim {
  /** The `auth_sessions` row this cookie names. */
  id: string;
  /** Epoch ms. Signed, so it is the server's statement rather than the jar's. */
  expiresAt: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The CryptoKey, kept for as long as the key material is the same one.
 *
 * `importKey` on every request would be a needless few hundred microseconds on
 * a gate that runs for every page and every poll. The comparison is against a
 * process-level configuration value rather than anything a caller supplies, so
 * there is nothing here for a timing attack to learn.
 */
let cached: { material: string; key: CryptoKey } | null = null;

async function hmacKey(material: string): Promise<CryptoKey> {
  if (cached && cached.material === material) return cached.key;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cached = { material, key };
  return key;
}

async function sign(payload: string, material: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(material),
    new TextEncoder().encode(payload),
  );
  return toBase64Url(new Uint8Array(signature));
}

/** 32 random bytes, `mintCapability`'s size and for its reason. */
export function newSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** The cookie value for a session. Never the token, and never derived from it. */
export async function mintSessionCookie(
  id: string,
  expiresAt: number,
  material: string,
): Promise<string> {
  const payload = `${VERSION}.${id}.${Math.floor(expiresAt / 1000)}`;
  return `${payload}.${await sign(payload, material)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * What a cookie value proves, or null.
 *
 * Null for every reason there is — wrong shape, wrong version, unparseable
 * expiry, bad signature, expired — because the caller's only useful question is
 * whether to let the request through, and a gate that distinguished "forged"
 * from "stale" in its return type would be a gate with two ways to be wrong.
 */
export async function readSessionCookie(
  value: string,
  material: string,
  now: number,
): Promise<SessionClaim | null> {
  // An empty key would make every value verifiable against a key of nothing.
  // Unreachable today — the gate returns before this on an empty token — and
  // cheap to make unreachable by construction.
  if (!value || !material) return null;

  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [version, id, exp, signature] = parts;
  if (version !== VERSION || !id || !exp || !signature) return null;

  const expiresAt = Number(exp);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;

  // Signature before expiry, so an attacker learns nothing from how long the
  // answer took about whether the id they guessed was ever a real one.
  const expected = await sign(`${version}.${id}.${exp}`, material);
  if (!constantTimeEqual(signature, expected)) return null;

  if (expiresAt * 1000 <= now) return null;
  return { id, expiresAt: expiresAt * 1000 };
}

/**
 * Whether to set `Secure` on the cookie being issued.
 *
 * It was unconditionally off, under a comment whose reasoning is right for a
 * laptop on `http://localhost` and wrong for the deployment this app is for: a
 * cookie without `Secure` is sent over any plain-HTTP request to the same host,
 * which is exactly the downgrade the flag exists to stop. Behind a TLS
 * terminator the request reaching this process is plain HTTP, so the protocol
 * on the URL cannot answer on its own and `x-forwarded-proto` is what does.
 *
 * The override is both ways round on purpose. `"1"` is for a terminator that
 * does not set the header; `"0"` is for the one case where getting this wrong
 * locks the operator out — a browser will not send a `Secure` cookie back over
 * HTTP, so a false positive is an install where signing in appears to work and
 * every subsequent request is unauthenticated.
 */
export function cookieIsSecure(o: {
  forwardedProto: string | null;
  protocol: string;
  override: string;
}): boolean {
  if (o.override === "1") return true;
  if (o.override === "0") return false;
  // A proxy chain appends, so the client-facing hop is the first entry.
  const hop = (o.forwardedProto ?? "").split(",")[0].trim().toLowerCase();
  if (hop) return hop === "https";
  return o.protocol === "https:";
}
