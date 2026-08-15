import { randomBytes, timingSafeEqual } from "node:crypto";

import { db } from "./db";

/**
 * Receiver for Claude Code's own OpenTelemetry export.
 *
 * Claude Code computes a cost for every API request and will push it to any
 * OTLP/HTTP endpoint. That is a first-party number: it needs no price table,
 * no `${message.id}:${requestId}` dedupe, and no byte-offset file reads. It is
 * strictly a *complement* to the transcript scan, never a replacement — it
 * cannot backfill history, carries no `cwd`, and collapses the 5m/1h cache
 * split that `pricing.ts` weights 1.25x against 2x. `scanUsage()` remains the
 * only input to the windows, and to every guard except one: `telemetrySpendSince`
 * feeds the mid-cycle half of a run's *own* spend under live enforcement, which
 * is the single figure no other source produces before a cycle ends. See the
 * comment on that function.
 *
 * Shapes here were taken from a captured POST from CLI v2.1.226, not from the
 * documentation, which disagrees on one detail that matters: the docs call the
 * event `claude_code.api_request`, and that string is indeed the log record's
 * *body* — but the `event.name` attribute holds the bare `api_request`. Both
 * are accepted below so a change on either side does not silently stop
 * matching.
 */

/* ---------------------------------------------------------------- */
/* Who may post                                                      */
/* ---------------------------------------------------------------- */

/**
 * What lets one run's exporter reach the ingest route, and nothing else.
 *
 * The exporter used to authenticate with `UF_AUTH_TOKEN`, put into the agent's
 * own environment as `OTEL_EXPORTER_OTLP_HEADERS` — the app's master credential,
 * handed to a Claude Code session with `Bash`, in a variable `env` prints. That
 * contradicted the rule stated directly above `childEnv`, which strips `UF_*`
 * from every child precisely because that token opens every route in the app:
 * `POST /api/runs`, `PUT /api/settings`, every other run's diff, the approval
 * route, branch deletion.
 *
 * This is `chat.ts`'s capability applied to a narrower subject. 32 random bytes,
 * held in memory, compared in constant time against every live token rather than
 * looked up by key (a `Map.get` on a secret leaks its prefix through timing),
 * and it opens exactly one thing: writing telemetry records *for its own run*.
 * The route takes the run id from the token, so a record claiming another run's
 * `uf.run_id` cannot move spend onto it.
 *
 * On `globalThis` for the reason every other long-lived singleton here is —
 * `next dev` would otherwise re-evaluate the module and invalidate a live run's
 * credential mid-cycle. It never outlives the process, so nothing recovered from
 * a captured environment after a restart ingests anything.
 *
 * There is deliberately **no** expiry while a run is live. A run may last hours,
 * and a token that timed out would stop telemetry arriving with nothing to say
 * so — which is a live spending guard silently reading zero, the exact failure
 * `needsLiveSpendTelemetry` exists to prevent. It is revoked when the run's loop
 * ends instead, on a short grace: the exporter batches on a one-second timer, so
 * revoking on the instant would drop the tail of the last cycle and understate
 * the run.
 */
interface IngestToken {
  runId: string;
  /** `Infinity` while the run is live; a near instant once it has ended. */
  expiresAt: number;
}

const ingestTokens = ((
  globalThis as unknown as { __ufOtlpTokens?: Map<string, IngestToken> }
).__ufOtlpTokens ??= new Map<string, IngestToken>());

/**
 * How long a finished run's exporter may still be believed.
 *
 * `OTEL_LOGS_EXPORT_INTERVAL` is 1000ms and the request itself takes some of
 * that, so this is a batch or two of slack rather than a policy.
 */
const INGEST_GRACE_MS = 30_000;

/**
 * The token for a run, minted on first use and stable for the rest of the run.
 *
 * One per run rather than one per work cycle: every cycle exports to the same
 * endpoint for the same run id, and a token per cycle would be one more thing
 * to revoke on each of the paths a cycle can end on.
 */
export function ingestTokenFor(runId: string): string {
  for (const [token, entry] of ingestTokens) {
    if (entry.runId === runId && entry.expiresAt === Infinity) return token;
  }
  const token = randomBytes(32).toString("base64url");
  ingestTokens.set(token, { runId, expiresAt: Infinity });
  return token;
}

/** Called from `startRun`'s `finally`, on every path a run's loop can leave by. */
export function revokeIngestTokens(runId: string): void {
  const until = Date.now() + INGEST_GRACE_MS;
  for (const entry of ingestTokens.values()) {
    if (entry.runId === runId && entry.expiresAt === Infinity) {
      entry.expiresAt = until;
    }
  }
}

/**
 * Which run a bearer token speaks for, or null.
 *
 * Sweeps expired entries as it goes, which is what bounds the map: nothing else
 * runs on a timer, and the only writer is a run starting.
 */
export function runForIngestToken(token: string): string | null {
  if (!token) return null;
  const offered = Buffer.from(token);
  const now = Date.now();
  let found: string | null = null;

  for (const [candidate, entry] of ingestTokens) {
    if (entry.expiresAt < now) {
      ingestTokens.delete(candidate);
      continue;
    }
    const known = Buffer.from(candidate);
    if (known.length === offered.length && timingSafeEqual(known, offered)) {
      found = entry.runId;
    }
  }
  return found;
}

/* ---------------------------------------------------------------- */
/* OTLP/HTTP-JSON wire shapes (the subset we read)                   */
/* ---------------------------------------------------------------- */

interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface KeyValue {
  key?: string;
  value?: AnyValue;
}

interface LogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  body?: AnyValue;
  attributes?: KeyValue[];
}

interface LogsPayload {
  resourceLogs?: Array<{
    resource?: { attributes?: KeyValue[] };
    scopeLogs?: Array<{ logRecords?: LogRecord[] }>;
  }>;
}

/** One priced API request, as Claude Code reported it. */
export interface TelemetryRequest {
  requestId: string;
  ts: number;
  runId: string | null;
  sessionId: string | null;
  model: string | null;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number | null;
  querySource: string | null;
  speed: string | null;
  effort: string | null;
}

/**
 * Identity attributes present in every record and deliberately never read:
 * `user.email`, `user.account_uuid`, `user.account_id`, `user.id`,
 * `organization.id`. Storing them would turn a cost table into a personal
 * record for no gain — the run id already answers "whose spend is this".
 */
const str = (v?: AnyValue): string | null =>
  typeof v?.stringValue === "string" && v.stringValue ? v.stringValue : null;

const num = (v?: AnyValue): number | null => {
  if (v === undefined) return null;
  if (typeof v.doubleValue === "number" && Number.isFinite(v.doubleValue)) {
    return v.doubleValue;
  }
  // intValue is a string in OTLP/JSON — int64 does not survive JSON numbers.
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

function flatten(attrs: KeyValue[] | undefined): Map<string, AnyValue> {
  const out = new Map<string, AnyValue>();
  for (const a of attrs ?? []) {
    if (a?.key) out.set(a.key, a.value ?? {});
  }
  return out;
}

function isApiRequest(rec: LogRecord, attrs: Map<string, AnyValue>): boolean {
  const name = str(attrs.get("event.name"));
  const body = str(rec.body);
  return (
    name === "api_request" ||
    name === "claude_code.api_request" ||
    body === "claude_code.api_request"
  );
}

/**
 * Pull the priced-request records out of one OTLP logs payload.
 *
 * Anything unrecognised is skipped rather than raising: this endpoint is fed
 * by a batch exporter that retries on failure, so rejecting a payload for one
 * odd record would cost the whole batch repeatedly.
 */
export function parseLogsPayload(
  payload: unknown,
  fallbackTs = Date.now(),
): TelemetryRequest[] {
  const root = (payload ?? {}) as LogsPayload;
  const out: TelemetryRequest[] = [];

  for (const rl of root.resourceLogs ?? []) {
    // `uf.run_id` is delivered via OTEL_RESOURCE_ATTRIBUTES, and the SDK is
    // free to place those on the resource rather than on each record. Merging
    // resource attributes underneath the record's own covers both without
    // depending on which one a given CLI release chooses; record-level keys
    // win, since those are the per-request facts.
    const resourceAttrs = flatten(rl?.resource?.attributes);

    for (const sl of rl?.scopeLogs ?? []) {
      for (const rec of sl?.logRecords ?? []) {
        const attrs = new Map([...resourceAttrs, ...flatten(rec?.attributes)]);
        if (!isApiRequest(rec, attrs)) continue;

        // Without a request id there is no dedupe key, and OTLP delivery is
        // at-least-once. Dropping is the safe choice: the docs note request_id
        // is "present only when the API returns one", so a record without it
        // is one we cannot promise to count exactly once.
        const requestId = str(attrs.get("request_id"));
        if (!requestId) continue;

        const nano = rec.timeUnixNano ?? rec.observedTimeUnixNano;
        const ts = nano ? Math.round(Number(nano) / 1e6) : fallbackTs;

        out.push({
          requestId,
          ts: Number.isFinite(ts) ? ts : fallbackTs,
          // Stamped by the orchestrator via OTEL_RESOURCE_ATTRIBUTES; absent
          // for the operator's own interactive sessions.
          runId: str(attrs.get("uf.run_id")),
          sessionId: str(attrs.get("session.id")),
          model: str(attrs.get("model")),
          costUSD: num(attrs.get("cost_usd")) ?? 0,
          inputTokens: num(attrs.get("input_tokens")) ?? 0,
          outputTokens: num(attrs.get("output_tokens")) ?? 0,
          cacheReadTokens: num(attrs.get("cache_read_tokens")) ?? 0,
          cacheCreationTokens: num(attrs.get("cache_creation_tokens")) ?? 0,
          durationMs: num(attrs.get("duration_ms")),
          querySource: str(attrs.get("query_source")),
          speed: str(attrs.get("speed")),
          effort: str(attrs.get("effort")),
        });
      }
    }
  }

  return out;
}

/**
 * Persist a batch. `INSERT OR IGNORE` on the request-id primary key is what
 * makes a redelivered batch a no-op — the exporter retries up to five times,
 * so this will happen.
 */
export function recordTelemetry(rows: TelemetryRequest[]): number {
  if (rows.length === 0) return 0;

  const stmt = db().prepare(
    `INSERT OR IGNORE INTO otlp_requests
       (request_id, ts, run_id, session_id, model, cost_usd,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        duration_ms, query_source, speed, effort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertAll = db().transaction((batch: TelemetryRequest[]) => {
    let inserted = 0;
    for (const r of batch) {
      inserted += stmt.run(
        r.requestId,
        r.ts,
        r.runId,
        r.sessionId,
        r.model,
        r.costUSD,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheCreationTokens,
        r.durationMs,
        r.querySource,
        r.speed,
        r.effort,
      ).changes;
    }
    return inserted;
  });

  return insertAll(rows);
}

export interface RunTelemetry {
  requests: number;
  costUSD: number;
  tokens: number;
  firstAt: number | null;
  lastAt: number | null;
}

/** First-party totals for one run. Reported beside, never merged into, `spent_usd`. */
export function telemetryForRun(runId: string): RunTelemetry | null {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(cost_usd), 0) AS costUSD,
              COALESCE(SUM(input_tokens + output_tokens
                           + cache_read_tokens + cache_creation_tokens), 0) AS tokens,
              MIN(ts) AS firstAt,
              MAX(ts) AS lastAt
         FROM otlp_requests WHERE run_id = ?`,
    )
    .get(runId) as RunTelemetry | undefined;

  return row && row.requests > 0 ? row : null;
}

/** What one run has reported since an instant. Zeroes when nothing has arrived. */
export interface TelemetrySpend {
  requests: number;
  costUSD: number;
  tokens: number;
}

/**
 * One run's first-party spend since `since`, for the live guard.
 *
 * This is the one place telemetry informs a budget decision, and it is confined
 * to the one quantity nothing else can report in time. A run's own spend lands
 * on `runs.spent_usd` only when the CLI emits its terminal `result` event, so
 * for the whole duration of a cycle `maxRunCostUSD` is compared against a
 * number that stopped moving when the previous cycle ended — which made
 * `run_cost` and `run_tokens` between-cycles guards wearing a live label.
 * Telemetry arrives per request while the agent works, so bounding the *current
 * cycle* by `since` and adding it to the completed cycles' total gives the
 * ticker a figure that actually moves.
 *
 * Deliberately not a window input and not a display figure: the caller adds it
 * to `spentGuardUSD`/`spentGuardTokens`, never to `spentUSD`, so `runs.spent_usd`
 * stays a floor of what Claude Code itself measured. Same display-vs-guard split
 * as `costUSD`/`costGuardUSD`, and for the same reason.
 *
 * `since` must be the current cycle's start. Passing the run's start would
 * double-count every cycle that already reported its own cost.
 *
 * The token sum matches what `handleStreamLine` accumulates from the `result`
 * event's `usage`, so the two halves of `spentGuardTokens` are the same unit.
 * `cache_creation_tokens` collapses the 5m/1h split, which the transcript
 * pipeline weights differently — irrelevant here, because this is a token count
 * rather than a price.
 */
export function telemetrySpendSince(runId: string, since: number): TelemetrySpend {
  const row = db()
    .prepare(
      // Covered by idx_otlp_requests_run_ts; this runs once per live run per
      // tick, alongside a full transcript scan that costs orders more.
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(cost_usd), 0) AS costUSD,
              COALESCE(SUM(input_tokens + output_tokens
                           + cache_read_tokens + cache_creation_tokens), 0) AS tokens
         FROM otlp_requests WHERE run_id = ? AND ts >= ?`,
    )
    .get(runId, since) as TelemetrySpend | undefined;

  return row ?? { requests: 0, costUSD: 0, tokens: 0 };
}

/** One run's first-party total inside a window, with the run's current status. */
export interface TelemetryRunTotal {
  runId: string;
  /** `null` only if the run row has gone; runs are not deleted, so in practice set. */
  status: string | null;
  requests: number;
  costUSD: number;
  tokens: number;
  lastAt: number;
}

export interface TelemetryWindow {
  requests: number;
  costUSD: number;
  tokens: number;
  lastAt: number;
  /** Distinct runs that reported inside the window, including finished ones. */
  runCount: number;
  /** How many of those are still `running` — i.e. the figure is still moving. */
  workingRunCount: number;
  /** Heaviest first, capped at `TOP_RUNS`. `runCount` is the honest total. */
  runs: TelemetryRunTotal[];
}

/**
 * The dashboard shows only the heaviest few runs by name. Beyond that the card
 * is a list rather than a reading, and `runCount` still reports the whole set.
 */
const TOP_RUNS = 6;

/**
 * First-party totals for every run that reported inside a window.
 *
 * This exists because a run in flight has *nothing else* to show. Per-cycle
 * spend lands on `runs.spent_usd` only when the CLI emits its terminal `result`
 * event, so a work cycle that is still going contributes $0 there for its whole
 * duration; telemetry arrives per request while it works. Reading that on the
 * dashboard is what makes the page move during a run rather than in one jump at
 * the end of each cycle.
 *
 * It stays a *separate reading*, not a correction to the meters. The window
 * bounds are taken from the transcript-derived snapshot so the two describe the
 * same five hours, but the numbers are never added: one is Claude Code's own
 * per-request cost for agents this app spawned, the other is our price table
 * applied to every transcript on the machine, and the work they cover overlaps.
 * Nothing here reaches `buildSnapshot()`, `evaluateBudget()` or `spent_usd`.
 *
 * Rows with no `run_id` are excluded. The orchestrator stamps one onto every
 * agent it spawns, so an unattributed record means something else was pointed
 * at this endpoint by hand — and this card claims to describe runs.
 */
export function telemetryWindow(since: number): TelemetryWindow | null {
  const groups = db()
    .prepare(
      // `r.status` is a bare column under GROUP BY, which SQLite allows and
      // which is unambiguous here: status is functionally dependent on run_id,
      // so every row in a group carries the same one.
      `SELECT o.run_id AS runId,
              r.status AS status,
              COUNT(*) AS requests,
              COALESCE(SUM(o.cost_usd), 0) AS costUSD,
              COALESCE(SUM(o.input_tokens + o.output_tokens
                           + o.cache_read_tokens + o.cache_creation_tokens), 0) AS tokens,
              MAX(o.ts) AS lastAt
         FROM otlp_requests o
         LEFT JOIN runs r ON r.id = o.run_id
        WHERE o.ts >= ? AND o.run_id IS NOT NULL
        GROUP BY o.run_id
        ORDER BY costUSD DESC`,
    )
    .all(since) as TelemetryRunTotal[];

  if (groups.length === 0) return null;

  // Totalled from the groups rather than by a second aggregate query: the two
  // could then disagree about the window if a batch landed between them, and
  // the card puts the total next to the list it is the total of.
  let requests = 0;
  let costUSD = 0;
  let tokens = 0;
  let lastAt = 0;
  let workingRunCount = 0;
  for (const g of groups) {
    requests += g.requests;
    costUSD += g.costUSD;
    tokens += g.tokens;
    if (g.lastAt > lastAt) lastAt = g.lastAt;
    if (g.status === "running") workingRunCount += 1;
  }

  return {
    requests,
    costUSD,
    tokens,
    lastAt,
    runCount: groups.length,
    workingRunCount,
    runs: groups.slice(0, TOP_RUNS),
  };
}
