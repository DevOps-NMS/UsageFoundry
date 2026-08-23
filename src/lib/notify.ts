import crypto from "node:crypto";

import {
  INSTALL_LABEL,
  NOTIFY_ON_SUCCESS,
  PUBLIC_URL,
  USER_AGENT,
  WEBHOOK_SECRET,
  WEBHOOK_URL,
} from "./config";
import { db } from "./db";
import { opsLog } from "./ops";
import type { PersistedRunEvent, RunStatus } from "./orchestrator";

/**
 * One outbound POST when a run reaches an ending that needs a person.
 *
 * The problem it answers is `proposals/UnattendedOperation/00-problem.md`: at
 * twenty-five unattended runs, an ending that asks for somebody — `needs-review`,
 * a guard that stopped the run, a crash, the 17-26 minute 429 ladder — is
 * visible on the run page, in `run_events` and on container stdout, and in none
 * of those places does it reach a person who is not already looking. Every other
 * option surveyed there needs somebody at a screen. This one needs a receiver
 * the operator already has.
 *
 * **It is vendor-neutral, and that is the whole of its security argument rather
 * than a preference.** One generic signed JSON body goes to one URL the operator
 * named. There is no format switch, no vendor branch and no per-vendor shape,
 * because the moment this file knows what Discord's body looks like, the
 * feature stops being "the operator points us at their own receiver" and becomes
 * "this app talks to third parties". The practical consequence is documented in
 * `docs/install.md` and is not a bug here: Discord's and Slack's incoming
 * webhooks accept only their own body (`{"content": …}` and `{"text": …}`), so a
 * bare Discord URL answers **400** and neither can be pointed at directly. Home
 * Assistant's `POST /api/webhook/<id>` takes arbitrary JSON and is the shaping
 * layer that fans out to whichever of those the operator wants.
 *
 * **Attached beside `logLifecycle` and reading the same `PersistedRunEvent`, on
 * purpose.** That function's projection is an already-reviewed decision about
 * what may leave this container — an `iteration` payload carries the whole
 * prompt and a creation `status` payload carries the folder — and a notifier
 * hung off a route or wrapped around `setStatus` would start that decision over
 * from nothing. What it costs is that this sink sees events rather than
 * transitions, which is why the filter below carries the small amount of state
 * it does.
 */

/**
 * Exactly what goes on the wire, and the list is closed.
 *
 * Six fields, every one of them either an id this app minted, a status from a
 * fixed vocabulary, a clock reading, or a string the *operator* wrote in the
 * environment. The standard is `status.ts`'s, one notch stricter: a webhook body
 * is retained and forwarded by whatever receives it, and unlike `/api/status` it
 * travels to a host this app does not control.
 *
 * **`runs.title` must never be added to this, and it is named here so that
 * refusing it is a decision somebody already took.** A title is model-writable
 * text: `chat.ts` lets a proposal name its own run, so a title is the one field
 * on that row an agent can put arbitrary characters into, and putting it here
 * would send an unattended model's prose to a third-party endpoint. The same
 * refusal covers the task text, the folder path, the branch name, the repository,
 * the model, the cost, the diff and `needs_review_reason` — the run's own page
 * is where those are read, and `url` is how a person gets there.
 */
export interface NotificationBody {
  /** `UF_INSTALL_LABEL`, or empty. Which install; never which repository. */
  install: string;
  /** `run.needs_review`, `run.failed`, … — the reason, from a fixed set. */
  event: string;
  run_id: string;
  /** The status the row carries. `running` for the 429 ladder, which sets none. */
  status: string;
  /** Epoch milliseconds. */
  at: number;
  /** `<UF_PUBLIC_URL>/runs/<id>`, or empty when no public URL is configured. */
  url: string;
}

/**
 * The statuses that always notify, and its own constant.
 *
 * Deliberately **not** `TERMINAL_STATUSES`, which carries `completed` and has
 * five readers deciding whether a dependency chain may start. Joining the two is
 * how the next edit starts POSTing on every success — twenty-five notifications
 * for twenty-five runs that worked, which is how a channel stops being read.
 * `WARN_STATUSES` in `orchestrator.ts` happens to hold the same three today and
 * is also not reused: that one is a *log level*, this one wakes somebody, and
 * the next status added will not necessarily want both.
 *
 * `stopped` is absent here rather than forgotten. It is both an operator's own
 * cancel and a guard trip, and only the second is worth a notification — see
 * `notifiableEvent`.
 *
 * `completed` is absent for the reason above and stays absent from *this*
 * constant even when `UF_NOTIFY_ON_SUCCESS=1` widens the filter. That is not
 * squeamishness about a one-line edit: a set named "the statuses that always
 * notify" whose contents depend on the environment is a constant that lies at
 * every other reader, and the next edit to reach for it would be reading a
 * fleet-scale default that this install happens not to have. The opt-in is a
 * branch in `notifiableEvent`, beside the other status whose notifiability is
 * not a property of the status.
 *
 * Typed `RunStatus` at the literals, so a renamed member is a compile error here
 * rather than a channel that quietly stops firing.
 */
const NOTIFY_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
  "needs-review",
  "blocked",
  "failed",
]);

/** Every ending, for forgetting a run's tracked state. Not a success test. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
  "needs-review",
  "blocked",
  "failed",
  "stopped",
  "completed",
]);

/**
 * The two things this sink has to remember between events, and why it has to.
 *
 * `logLifecycle` is handed events, not transitions, so two of the four
 * notifiable endings are not decidable from the event in hand:
 *
 *  - A `stopped` status says nothing about *who* stopped the run. The guard's own
 *    `budget` event says so and arrives first, so the run is marked when that
 *    verdict lands and the mark is consumed when the status does. An operator's
 *    cancel emits no `budget` event at all, so it can never be marked — which is
 *    the whole point, and is a great deal safer than parsing `stop_reason`, which
 *    is user-facing prose and the one thing here that must never become a parse.
 *  - The 429 ladder retries in place and emits one `error` per rung, four rungs
 *    over ~17-26 minutes. The first rung is the news; the rest are the wait the
 *    first one already announced.
 *
 * `globalThis`-pinned under its own key for the reason every other long-lived
 * singleton here is: module state silently resets on every request under
 * `next dev`, and a latch that resets is not a latch.
 */
export interface NotifyState {
  /** Runs whose latest guard verdict was an enforceable stop. */
  guardStopped: Set<string>;
  /** Runs that have already had a rate-limit notification. */
  rateLimited: Set<string>;
}

/**
 * How many runs' latches are kept.
 *
 * Both sets are emptied when a run settles, so on a healthy install they hold
 * the handful of runs currently in flight. What needs bounding is the run that
 * never settles in *this* process — a container restarted mid-cycle, a guard
 * verdict whose `stopped` never arrived — because those entries have nothing to
 * remove them and a server that runs for weeks accumulates one per occurrence.
 * A `Set` iterates in insertion order, so the oldest is the one dropped.
 */
const MAX_TRACKED_RUNS = 1_000;

const state = ((globalThis as unknown as { __ufNotify?: NotifyState }).__ufNotify ??= {
  guardStopped: new Set<string>(),
  rateLimited: new Set<string>(),
});

function remember(set: Set<string>, runId: string): void {
  set.add(runId);
  while (set.size > MAX_TRACKED_RUNS) {
    const oldest = set.values().next();
    if (oldest.done) return;
    set.delete(oldest.value);
  }
}

/** What a notifiable event is, before the environment is consulted. */
export interface NotifyDecision {
  /** The `event` field: `run.needs_review`, `run.rate_limited`, … */
  event: string;
  /** The `status` field. */
  status: string;
}

/**
 * Whether this event is one somebody should be told about, and as what.
 *
 * Separated from the delivery for the reason `evaluateBudget` is separated from
 * the loop: this is the half whose failure is silent. A filter that is too wide
 * makes the channel noise, which is how an operator stops reading it; one that
 * is too narrow is a channel that looks configured and is not — the failure
 * `proposals/UnattendedOperation/12-validation.md` names, and the reason it is
 * unit-tested rather than checked by hand against a live receiver.
 *
 * Reads *and updates* `s`, which is what makes it a reducer rather than a pure
 * predicate. The state is taken as an argument rather than reached for, so a
 * test can hand it a fresh one and pin the latching directly.
 *
 * **One deviation from `04-option-c-outbound-webhook.md` is deliberate and is
 * here rather than in the docs alone.** That document asks for an `error` whose
 * payload carries `retrying && usageLimit`. That conjunction cannot occur in
 * this tree: the emit site sets `usageLimit: kind === "allowance"`, and
 * `refusalDisposition` answers an allowance refusal with `park` or `fail` and
 * never `retry`, so `retrying` is true exactly when `usageLimit` is false.
 * Implemented literally it would be a channel that never fires for this
 * option's headline row — the cousin of that survey's own failure mode 3. So the
 * test is `retrying === true`, which is every in-place retry: the 429 ladder and
 * the ~85-second transient ladder both, indistinguishable from here because the
 * payload carries no `refusalKind`. Adding one to the emit site is the one-line
 * change that would separate them, and it is deliberately not made here — it
 * would edit a producer outside this sink, and over-reporting a retry is the
 * safe direction for a channel whose purpose is to say a run is stuck.
 */
/**
 * `UF_NOTIFY_ON_SUCCESS=1`, read once. The default of the parameter below rather
 * than read inside it, so a test pins both settings without touching the
 * environment — the same reason `state` is a parameter.
 */
const notifyOnSuccess = NOTIFY_ON_SUCCESS === "1";

export function notifiableEvent(
  e: PersistedRunEvent,
  s: NotifyState = state,
  onSuccess: boolean = notifyOnSuccess,
): NotifyDecision | null {
  const p = e.payload;

  if (e.kind === "budget") {
    // An enforceable stop verdict, which is what a `stopped` status a moment
    // later will have been caused by. `enforceable !== false` rather than
    // `=== true` because two of the three stop emits omit the field entirely,
    // while the one case that sets it false — `no_ceiling`, an unreadable
    // window — is the verdict the run carries on past.
    if (p.allowed === false && p.disposition === "stop" && p.enforceable !== false) {
      remember(s.guardStopped, e.runId);
    }
    return null;
  }

  if (e.kind === "error") {
    // First rung only, and at most one per run: rungs two to four are the wait
    // the first one announced, and a park arrives as up to three `paused` rungs
    // — none of which is in `NOTIFY_STATUSES` — ending in the `failed` that is.
    if (p.retrying !== true) return null;
    if (s.rateLimited.has(e.runId)) return null;
    remember(s.rateLimited, e.runId);
    // The ladder changes no status, so the row really does read `running`
    // everywhere state is read. Saying so beats inventing a status for it.
    return { event: "run.rate_limited", status: "running" };
  }

  if (e.kind !== "status") return null;

  const status = typeof p.status === "string" ? p.status : null;
  if (status === null) return null;

  // Both latches are consumed only by an *ending*, never by a status the run
  // passes through on the way to one. Nothing emits a `running` between a stop
  // verdict and the `stopped` it causes today, and a filter that would start
  // missing guard stops if something did is a filter that fails silently.
  const settled = SETTLED_STATUSES.has(status);
  if (!settled) return null;
  const guardStopped = s.guardStopped.delete(e.runId);
  s.rateLimited.delete(e.runId);

  if (NOTIFY_STATUSES.has(status)) return { event: eventName(status), status };
  // The two statuses whose notifiability is not a property of the status: one
  // decided by how the run got here, one by what the operator asked for. Both
  // sit below the always-notify set so that widening either can never subtract
  // from it.
  if (status === "stopped" && guardStopped) return { event: eventName(status), status };
  if (status === "completed" && onSuccess) return { event: eventName(status), status };
  return null;
}

function eventName(status: string): string {
  return `run.${status.replace(/-/g, "_")}`;
}

/**
 * `X-UF-Signature`, over the exact bytes that go on the wire.
 *
 * GitHub's webhook shape (`sha256=<hex>`) rather than a new one, because every
 * receiver's documentation already has an example of verifying it — including
 * Home Assistant's, which is the reference receiver — and a signature nobody
 * knows how to check is a signature nobody checks.
 *
 * What the receiver gets out of it is the one thing the transport cannot give
 * it: a Home Assistant webhook id is an unauthenticated URL by design, so
 * anything that can reach that instance can POST a run ending to it. The HMAC is
 * how the automation tells this install's POST from that.
 *
 * Takes the serialised body rather than the object, and that is load-bearing:
 * `JSON.stringify` is called **once** and both the signature and the request
 * body are that same string. Stringifying twice is the classic way to ship a
 * signature over bytes the receiver never saw.
 */
export function signBody(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** How long a delivery may take before it is abandoned. */
const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * How many delivery attempts are kept.
 *
 * A cap rather than an age, `request_log`'s reason: what makes this table useful
 * is having the burst from *before* somebody noticed. A few attempts per run
 * ending makes 2,000 months of ordinary operation, and bounding it here rather
 * than leaving it to `retention.ts` is deliberate — a table nobody bounded is
 * the next issue about a database that will not stop growing.
 */
const DELIVERY_RETENTION_ROWS = 2_000;

/**
 * One row per attempt, and it never throws.
 *
 * Bounded on every insert on `recordRequest`'s pattern. Swallowed for
 * `recordRequest`'s reason and only that one: this is the recording path, the
 * line is already on stdout, and a failed write here must not become an
 * unhandled rejection inside the run loop's own event emit.
 */
function recordDelivery(
  runId: string,
  event: string,
  httpStatus: number,
  error: string | null,
): void {
  const ok = error === null;
  opsLog(ok ? "info" : "warn", "webhook.delivery", {
    run_id: runId,
    notify_event: event,
    http_status: httpStatus,
    ok,
    // The receiver's hostname can appear in a fetch failure's message
    // (`getaddrinfo ENOTFOUND …`). This is the operator's own container log, so
    // that is theirs to read — it is `/api/status` that must not carry it.
    message: error,
  });
  try {
    const handle = db();
    handle
      .prepare(
        `INSERT INTO webhook_deliveries (ts, run_id, event, http_status, ok, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), runId, event, httpStatus, ok ? 1 : 0, error);
    handle
      .prepare(
        "DELETE FROM webhook_deliveries WHERE id <= (SELECT MAX(id) FROM webhook_deliveries) - ?",
      )
      .run(DELIVERY_RETENTION_ROWS);
  } catch {
    /* the recording path — see the docblock */
  }
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 300) || "delivery failed with no message";
}

/**
 * Fire the POST and return immediately.
 *
 * **Nothing here is awaited, and this is the one way this feature can break the
 * run loop.** `emit()` is synchronous from the INSERT to the last subscriber,
 * and `createRun` runs from entry to INSERT with no `await` at all — that is
 * what keeps two agents out of one directory. An `await` on this path would put
 * a run ending behind a receiver's DNS lookup, and a receiver that hangs would
 * hold the loop for as long as the socket did. A five-second `AbortSignal` and a
 * `.catch` that records and does nothing else is the whole of the error
 * handling: a lost notification is a lost notification, and the consecutive
 * failure count on `/api/status` is how it stops being silent.
 *
 * The `.then`/`.catch` pair is not a style lapse — it is the explicit form of
 * "this promise is deliberately not awaited". An `async` caller would be a
 * floating promise saying the same thing less clearly.
 */
function deliver(runId: string, decision: NotifyDecision, at: number): void {
  const body = JSON.stringify({
    install: INSTALL_LABEL,
    event: decision.event,
    run_id: runId,
    status: decision.status,
    at,
    url: PUBLIC_URL ? `${PUBLIC_URL.replace(/\/+$/, "")}/runs/${runId}` : "",
  } satisfies NotificationBody);

  fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "x-uf-signature": signBody(body, WEBHOOK_SECRET),
    },
    body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  })
    .then((res) => {
      recordDelivery(runId, decision.event, res.status, res.ok ? null : `HTTP ${res.status}`);
    })
    .catch((err: unknown) => {
      recordDelivery(runId, decision.event, 0, messageOf(err));
    });
}

/** Configured means both halves: a target, and the secret that signs for it. */
export function webhookConfigured(): boolean {
  return WEBHOOK_URL !== "" && WEBHOOK_SECRET !== "";
}

/**
 * The second sink beside `logLifecycle`, and it never throws.
 *
 * Called last in `emit()` for the reason `logLifecycle` is: persist-then-publish
 * is what makes an SSE reconnect lossless, so this is an addition at the end
 * rather than anything reordered. It returns before doing any work at all on a
 * stock install, where `UF_WEBHOOK_URL` is blank — the ordinary case must cost
 * one string comparison per event, and `emit()` is called on every tool call of
 * every cycle.
 */
export function notifyLifecycle(e: PersistedRunEvent): void {
  if (WEBHOOK_URL === "") return;
  try {
    const decision = notifiableEvent(e, state);
    if (decision === null) return;
    if (WEBHOOK_SECRET === "") {
      // Loud per lost notification rather than once, because each line is a
      // real ending nobody was told about. Refusing to deliver is the decision:
      // a Home Assistant webhook id is an unauthenticated URL, so an unsigned
      // body is one the receiver cannot tell from anything else that can reach
      // it — and shipping that silently is worse than shipping nothing.
      opsLog("error", "webhook.unsigned", {
        run_id: e.runId,
        notify_event: decision.event,
        message:
          "UF_WEBHOOK_URL is set and UF_WEBHOOK_SECRET is empty, so nothing is sent",
      });
      return;
    }
    deliver(e.runId, decision, e.ts);
  } catch (err) {
    // A notifier must not be able to fail a run's event emit. Nothing above
    // this line is expected to throw; if something does, the run is what
    // matters and this line is the evidence.
    opsLog("error", "webhook.sink_failed", {
      run_id: e.runId,
      message: messageOf(err),
    });
  }
}

/** What `/api/status` reports about the channel. Counts and clocks only. */
export interface WebhookHealth {
  configured: boolean;
  /** Attempts since the last success, or since the oldest retained row. */
  consecutiveFailures: number;
  lastAttemptAt: number | null;
}

/**
 * Whether the channel is still delivering, derived rather than counted.
 *
 * `04-option-c-outbound-webhook.md` makes this the condition on the whole
 * option: a channel an operator has stopped receiving from is worse than no
 * channel, because it reads as silence meaning nothing is wrong. Derived from
 * the table with one query rather than held in memory on purpose — an in-memory
 * counter resets on the restart, and "this has been dead since Tuesday" is
 * exactly the answer that has to survive one.
 *
 * No error string, and that is the `status.ts` rule rather than an omission: a
 * fetch failure's message carries the receiver's hostname, and this endpoint is
 * retained and forwarded by whatever scrapes it. The message is on stdout and in
 * the table, both of which are the operator's own.
 */
export function webhookHealth(): WebhookHealth {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS failures
         FROM webhook_deliveries
        WHERE id > COALESCE((SELECT MAX(id) FROM webhook_deliveries WHERE ok = 1), 0)`,
    )
    .get() as { failures: number };

  const last = db()
    .prepare("SELECT MAX(ts) AS at FROM webhook_deliveries")
    .get() as { at: number | null };

  return {
    configured: webhookConfigured(),
    consecutiveFailures: row.failures,
    lastAttemptAt: last.at,
  };
}
