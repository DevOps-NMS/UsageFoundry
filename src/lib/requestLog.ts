import { db } from "./db";
import { opsLog } from "./ops";

/**
 * A durable line per mutating request: what was asked, of what, by whom, from
 * where.
 *
 * Nothing recorded an authenticated request anywhere in this app. With
 * twenty-five agents landing code in many repositories, a bad commit could not
 * be traced back to an authorisation, and a token used to create runs left
 * nothing that separated those runs from legitimate ones. `runs.origin` answers
 * *which gate*; this answers *which request*, including for the routes that
 * create nothing — a stop, a delete, a settings change, a branch purge.
 *
 * **What a line holds, exhaustively**: the method, the URL's `pathname`, the
 * response status, the id the request named or created, how the caller
 * authenticated, the first-hop source address, and how long it took.
 *
 * **What it must never hold, and why each one is named rather than assumed**:
 *
 *  - *The request body.* Every run's prompt goes through `POST /api/runs`, and
 *    `POST /api/login` carries the master token in its body. A body-logging
 *    line here would write the credential this app exists to protect into a
 *    table and onto stdout.
 *  - *The query string.* `pathname` is taken deliberately rather than the whole
 *    URL: a query string is where a credential ends up when somebody puts one
 *    there by mistake, and once it is here it is here for good.
 *  - *Cookies and the `authorization` header.* `actor` says **how** a caller
 *    authenticated — a session cookie, a bearer token, the chat's per-turn
 *    capability, or nothing at all — and never with what. That is the whole of
 *    what an audit needs: which credential class, not which secret.
 *  - *Anything read out of a response.* Only the `x-uf-subject` header a
 *    handler sets on purpose, which is an id.
 */

/** How a caller proved it was allowed in. Never what it proved it with. */
export type RequestActor =
  /** A browser session cookie. */
  | "session"
  /** An `Authorization: Bearer` token. */
  | "bearer"
  /** The chat's per-turn capability, which authenticates inside `/api/mcp`. */
  | "capability"
  /** No credential at all — auth is off, or the route is the login itself. */
  | "open";

export interface RequestLogEntry {
  ts: number;
  method: string;
  path: string;
  status: number;
  subject: string | null;
  actor: RequestActor;
  address: string | null;
  durationMs: number;
}

/**
 * How many lines are kept.
 *
 * A cap rather than an age, because what makes this table useful is having the
 * burst that happened *before* somebody noticed, and an install that is quiet
 * for a month should not lose it. 20,000 is weeks of ordinary operation and a
 * few megabytes at worst. Bounding it here rather than leaving it to #62's
 * retention work is deliberate: an audit table nobody bounded is the next
 * issue about a database that will not stop growing.
 */
const RETENTION_ROWS = 20_000;

/**
 * The first hop of `x-forwarded-for`, or `x-real-ip`.
 *
 * The first hop is the client as the nearest proxy saw it; the rest of that
 * header is whatever the client felt like sending and is not evidence of
 * anything. Truncated, because the header is attacker-controlled and this is a
 * column, not a parser.
 */
export function sourceAddress(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  const address = first || headers.get("x-real-ip")?.trim() || "";
  return address ? address.slice(0, 64) : null;
}

/** Which credential class the caller used. Reads headers, stores neither. */
export function actorOf(req: Request, path: string): RequestActor {
  // Named by path rather than by header, and that is only honest because
  // `/api/mcp` answers a request carrying no live capability with a 401 from
  // *outside* this wrapper. Wrap that route's refusal and this line starts
  // calling an unauthenticated caller a capability holder — and every such
  // caller starts spending the row cap below.
  if (path === "/api/mcp") return "capability";
  if ((req.headers.get("authorization") ?? "").startsWith("Bearer ")) return "bearer";
  if (/(?:^|;\s*)uf_session=/.test(req.headers.get("cookie") ?? "")) return "session";
  return "open";
}

export function recordRequest(entry: RequestLogEntry): void {
  try {
    const handle = db();
    handle
      .prepare(
        `INSERT INTO request_log
           (ts, method, path, status, subject, actor, address, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts,
        entry.method,
        entry.path,
        entry.status,
        entry.subject,
        entry.actor,
        entry.address,
        entry.durationMs,
      );
    handle
      .prepare(
        "DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?",
      )
      .run(RETENTION_ROWS);
  } catch {
    // Swallowed for `recordOpsEvent`'s reason and only that one: this is the
    // recording path, the line is already on stdout, and a failed audit write
    // must not turn a request that worked into a 500 the caller retries.
  }
  opsLog(entry.status >= 400 ? "warn" : "info", "http.mutation", {
    method: entry.method,
    path: entry.path,
    status: entry.status,
    subject: entry.subject,
    actor: entry.actor,
    address: entry.address,
    duration_ms: entry.durationMs,
  });
}

/** The most recent lines, newest first. */
export function recentRequests(limit = 50): RequestLogEntry[] {
  const rows = db()
    .prepare(
      `SELECT ts, method, path, status, subject, actor, address,
              duration_ms AS durationMs
         FROM request_log ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as RequestLogEntry[];
  return rows;
}

/**
 * The header a handler sets to name what it created.
 *
 * Every route that acts on an existing row has that row's id in its path, which
 * this wrapper reads. A *creation* does not — `POST /api/runs` mints the id
 * inside the handler — and reading it back out of the response body would mean
 * parsing a body this file has just spent a paragraph refusing to touch. So the
 * handler says so explicitly, in one header, which is stripped before the
 * response leaves.
 */
export const SUBJECT_HEADER = "x-uf-subject";

type Handler<A extends unknown[]> = (...args: A) => Promise<Response>;

/**
 * Wrap a mutating route handler so the request it answers is recorded.
 *
 * Applied at the export (`export const POST = auditMutation("runs", handler)`)
 * rather than called inside each handler, because a handler has several return
 * paths and the one that would get missed is a refusal — which is exactly the
 * line an audit wants. Wrapping catches every one of them, including a throw.
 *
 * The subject is the id from the route's own params where there is one, and
 * otherwise whatever the handler named through `SUBJECT_HEADER`. Both are ids
 * this app minted; neither is user text.
 */
export function auditMutation<A extends unknown[]>(handler: Handler<A>): Handler<A> {
  return async (...args: A): Promise<Response> => {
    const started = Date.now();
    const req = args[0] as Request;
    // `pathname` and never the whole URL — see the note at the top of this file.
    const path = new URL(req.url).pathname;

    let response: Response;
    try {
      response = await handler(...args);
    } catch (err) {
      // Recorded before it is re-thrown: a request that blew up is a request
      // that happened, and it is the one a person looking for a cause wants.
      recordRequest({
        ts: started,
        method: req.method,
        path,
        status: 500,
        subject: await subjectFromParams(args[1]),
        actor: actorOf(req, path),
        address: sourceAddress(req.headers),
        durationMs: Date.now() - started,
      });
      throw err;
    }

    const named = response.headers.get(SUBJECT_HEADER);
    if (named !== null) response.headers.delete(SUBJECT_HEADER);

    recordRequest({
      ts: started,
      method: req.method,
      path,
      status: response.status,
      subject: named ?? (await subjectFromParams(args[1])),
      actor: actorOf(req, path),
      address: sourceAddress(req.headers),
      durationMs: Date.now() - started,
    });
    return response;
  };
}

/**
 * The id a dynamic route names, from its own params.
 *
 * `instanceId` is preferred over `id` where both are present: on the workflow
 * instance routes `id` is the workflow and `instanceId` is the thing being
 * acted on, and an audit line has to name what changed.
 */
async function subjectFromParams(ctx: unknown): Promise<string | null> {
  const params = (ctx as { params?: Promise<Record<string, string>> } | undefined)
    ?.params;
  if (!params) return null;
  try {
    const resolved = await params;
    const value = resolved.instanceId ?? resolved.id;
    return typeof value === "string" ? value.slice(0, 128) : null;
  } catch {
    return null;
  }
}
