import { db } from "./db";

/**
 * The record behind an issued `uf_session` cookie.
 *
 * `sessionToken.ts` says what the cookie *is*; this says what the server knows
 * about the ones it handed out. The two are separate files because they live in
 * different runtimes: the cookie has to be checkable by the edge middleware,
 * and this touches SQLite, which that runtime cannot reach.
 *
 * What it buys is the thing the old cookie had none of. When the cookie was
 * `UF_AUTH_TOKEN` there was no session — no count, no issue time, no way to end
 * one, and the only remedy for a leaked copy was editing `.env` and restarting
 * the container, which kills every run in flight. A row per sign-in makes
 * "revoke this one" and "how many are outstanding" ordinary questions.
 */

export interface AuthSession {
  id: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

type Row = {
  id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};

const toSession = (r: Row): AuthSession => ({
  id: r.id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

export function createSession(id: string, expiresAt: number): AuthSession {
  const now = Date.now();
  db()
    .prepare(
      "INSERT INTO auth_sessions (id, created_at, expires_at, revoked_at)" +
        " VALUES (?,?,?,NULL)",
    )
    .run(id, now, expiresAt);
  // Signing in is the one moment this table is written on a normal install, so
  // it is where the dead rows go. An expired row can never be presented again —
  // the expiry is inside the cookie's own signature — so keeping it says
  // nothing and grows a table with no retention policy.
  db().prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
  return { id, createdAt: now, expiresAt, revokedAt: null };
}

/**
 * End one session. Idempotent, and it keeps the row: a revocation that deleted
 * its own evidence would leave "was this cookie ever ended, or never issued?"
 * unanswerable at the one moment somebody is asking it.
 */
export function revokeSession(id: string): void {
  db()
    .prepare(
      "UPDATE auth_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
    )
    .run(Date.now(), id);
}

/** End every session at once — the operator action for a credential that leaked. */
export function revokeAllSessions(): number {
  const res = db()
    .prepare(
      "UPDATE auth_sessions SET revoked_at=? WHERE revoked_at IS NULL" +
        " AND expires_at > ?",
    )
    .run(Date.now(), Date.now());
  return res.changes;
}

export function getSession(id: string): AuthSession | null {
  const row = db()
    .prepare("SELECT * FROM auth_sessions WHERE id=?")
    .get(id) as Row | undefined;
  return row ? toSession(row) : null;
}

/** How many sign-ins are outstanding — the question the old cookie could not answer. */
export function activeSessionCount(now = Date.now()): number {
  const row = db()
    .prepare(
      "SELECT COUNT(*) AS n FROM auth_sessions" +
        " WHERE revoked_at IS NULL AND expires_at > ?",
    )
    .get(now) as { n: number };
  return row.n;
}
