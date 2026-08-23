#!/usr/bin/env node
// Turn this app's one signed notification into a Discord message.
//
// `notify.ts` sends one generic body to one URL and will not grow a vendor
// branch — the reasoning is in its docblock and in `docs/agent/run-lifecycle.md`,
// and it is a security argument rather than a preference. The practical cost is
// that a Discord webhook URL cannot be used directly: Discord's incoming
// webhooks accept only their own shape, so the six-field body answers
// **400 `Cannot send an empty message` (code 50006)** and the notification is
// lost silently. Measured against a live webhook on 2026-08-24; a Discord-shaped
// control body to the same URL answered 204.
//
// This is the shaping layer, kept deliberately outside `src/` so that nothing
// the app builds or ships knows what Discord's body looks like. It verifies the
// HMAC, reshapes, and forwards. It is the smallest thing that closes the gap;
// Home Assistant (`docs/install.md`) remains the reference receiver for anyone
// who wants fan-out to more than one place.
//
// The two URLs are separate variables on purpose. `UF_WEBHOOK_URL` names
// *this relay* and stays free to point somewhere else entirely, while
// `DISCORD_WEBHOOK_URL` names the channel this relay happens to forward to.
// Collapsing them would mean the app's target and the vendor's target could
// never differ, which is the coupling the split exists to prevent.
//
// Usage:
//   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... \
//   UF_WEBHOOK_SECRET=<the same value the app has> \
//   node scripts/discord-relay.mjs
//
// Then, in the app's .env:
//   UF_WEBHOOK_URL=http://host.docker.internal:8787/uf   (Docker Desktop)
//   UF_WEBHOOK_SECRET=<the same value>
//   UF_PUBLIC_URL=http://localhost:3000                  (or the link is empty)

import crypto from "node:crypto";
import http from "node:http";

function fail(message) {
  console.error(`discord-relay: ${message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name] ?? "";
  if (value === "") fail(`${name} is required and was empty`);
  return value;
}

/**
 * Blank means unset, and that is the whole reason this exists.
 *
 * `.env.example` ships every optional key present and empty, so `??` is the
 * wrong operator against this file: `""` is not nullish, and `Number("")` is
 * `0` — a relay that binds a random port while `UF_WEBHOOK_URL` still names
 * 8787, which looks like a listener that started fine and receives nothing.
 * Same convention the app uses for its own optional variables.
 */
function optionalEnv(name, fallback) {
  const value = process.env[name] ?? "";
  return value === "" ? fallback : value;
}

const DISCORD_WEBHOOK_URL = requiredEnv("DISCORD_WEBHOOK_URL");
const WEBHOOK_SECRET = requiredEnv("UF_WEBHOOK_SECRET");

/**
 * Who to ping, and it is what makes this reach a phone.
 *
 * A message in a channel is seen when somebody looks at the channel, which is
 * the same failure the whole feature exists to fix. A mention is what Discord
 * turns into a push. Optional, because a shared channel may not want one.
 */
const MENTION_USER_ID = optionalEnv("DISCORD_MENTION_USER_ID", "");

/** Its own name rather than PORT, so sourcing the app's .env cannot collide. */
const PORT = Number(optionalEnv("RELAY_PORT", "8787"));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  fail(`RELAY_PORT must be a port number, and was ${JSON.stringify(process.env.RELAY_PORT)}`);
}

/**
 * Loopback by default, matching `UF_BIND_ADDRESS`.
 *
 * Measured on 2026-08-24: the container reaches a loopback-bound listener here
 * through `host.docker.internal`, so the default needs no widening on Docker
 * Desktop. Set `0.0.0.0` only if some other runtime routes that name to an
 * address a strictly loopback-bound listener never sees. Widening it is
 * defensible here and only here: every accepted request has already proved it
 * holds the shared secret.
 */
const BIND = optionalEnv("RELAY_BIND", "127.0.0.1");

/** A notification is ~200 bytes. Anything approaching this is not one. */
const MAX_BODY_BYTES = 16 * 1024;

/** The app abandons a delivery at 5s, so nothing here may take that long. */
const FORWARD_TIMEOUT_MS = 4_000;

/**
 * Over the exact bytes received, which is the half that is easy to get wrong.
 *
 * `notify.ts` signs the one string it also sends. Re-serialising the parsed
 * object to check it works until some key's order or some number's formatting
 * differs, and then fails for no visible reason — so the raw buffer is what is
 * hashed here, and it is parsed only after the signature has passed.
 */
function signatureMatches(raw, header) {
  const expected = `sha256=${crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`;
  const received = Buffer.from(String(header ?? ""));
  const want = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first; a length is not the secret.
  return received.length === want.length && crypto.timingSafeEqual(received, want);
}

/** The app's closed six-field list, checked because this is a boundary. */
function readNotification(raw) {
  const body = JSON.parse(raw.toString("utf8"));
  if (typeof body !== "object" || body === null) throw new Error("body is not an object");
  for (const field of ["event", "run_id", "status"]) {
    if (typeof body[field] !== "string" || body[field] === "") {
      throw new Error(`${field} is missing or not a non-empty string`);
    }
  }
  return body;
}

function describe(n) {
  const where = typeof n.install === "string" && n.install !== "" ? ` on ${n.install}` : "";
  const link = typeof n.url === "string" && n.url !== "" ? `\n${n.url}` : "";
  const ping = MENTION_USER_ID === "" ? "" : `<@${MENTION_USER_ID}> `;
  return `${ping}**${n.event}**${where}\nrun \`${n.run_id}\` — ${n.status}${link}`;
}

async function forward(content) {
  const body = JSON.stringify({
    content,
    // Structural rather than a filter: whatever ends up in the text, the only
    // mention Discord will act on is the one id configured here. An `install`
    // label reading `@everyone` is then just characters.
    allowed_mentions: MENTION_USER_ID === "" ? { parse: [] } : { parse: [], users: [MENTION_USER_ID] },
  });
  const post = () =>
    fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });

  let res = await post();
  // Discord rate-limits a webhook at roughly 5 requests per 2 seconds, and run
  // endings arrive in bursts — a fleet hitting its weekly wall settles several
  // at once. Dropping those is exactly the silence this feature exists to end,
  // so the one retry Discord itself tells us to make is honoured. Once only:
  // the app is already counting down its own 5s abort.
  if (res.status === 429) {
    const after = Number((await res.clone().json().catch(() => ({}))).retry_after ?? 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(after, 2) * 1000));
    res = await post();
  }
  if (!res.ok) throw new Error(`Discord answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

http
  .createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const raw = Buffer.concat(chunks);
      if (!signatureMatches(raw, req.headers["x-uf-signature"])) {
        console.error("discord-relay: rejected a body whose signature did not match");
        res.writeHead(401).end();
        return;
      }
      let notification;
      try {
        notification = readNotification(raw);
      } catch (err) {
        console.error(`discord-relay: unreadable body: ${err.message}`);
        res.writeHead(400).end();
        return;
      }
      // Answered before Discord is called, not after. The app aborts at five
      // seconds and never retries, so a slow Discord must not be able to turn
      // a delivered notification into a lost one.
      res.writeHead(204).end();
      forward(describe(notification))
        .then(() => console.log(`discord-relay: forwarded ${notification.event} ${notification.run_id}`))
        .catch((err) => console.error(`discord-relay: forward failed: ${err.message}`));
    });
  })
  .listen(PORT, BIND, () => console.log(`discord-relay: listening on ${BIND}:${PORT}`));
