import fs from "node:fs";
import { BYTES_PER_TOKEN } from "./fileCostNotice";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  resolvePrice,
} from "./pricing";
import { scanUsage, type UsageEntry } from "./transcripts";

/**
 * What winnow's intake filter kept off the wire, read from its own ledger.
 *
 * ## What this is a reading of, and why it is not a fourth cost source
 *
 * Every agent this container spawns talks to `ANTHROPIC_BASE_URL`, which the
 * entrypoint points at a loopback proxy — winnow's intake filter. The filter
 * replaces a tool result's content with a pointer *after* the last
 * `cache_control` breakpoint, so the API never writes it to cache and never
 * reads it again. It appends one JSON line per rewritten request to a ledger.
 *
 * **The money the filter saved is already absent from every meter here.** The
 * windows are priced from `usage` frames, and a `usage` frame is the API's
 * report of the request it actually received — the filtered one. So this figure
 * is new information rather than a double count, and it is a *counterfactual*
 * in `byAgent.counterfactualUSD`'s sense: the same work without the filter. It
 * reaches no meter, no guard, no window, `buildSnapshot()` or `runs.spent_usd`.
 *
 * The one figure it is added to is the pruner's, on the context-control card,
 * where the two are the halves of one intervention and a reader asking what it
 * was worth is asking about both. That sum overstates by the mass the two
 * mechanisms both remove — measured at 4.06% of pruned tokens across this
 * install's ten largest transcripts, an upper bound — and the card prints that
 * rather than implying the halves are disjoint. Nothing else may add it to
 * anything.
 *
 * ## The arithmetic
 *
 * With `D` the tokens of one tool result and `T` the assistant turns that
 * followed the request it first appeared on:
 *
 * ```
 * baseline   2.0·D  one cache write, at the one-hour class this install writes at
 *          + 0.1·D·T  a cache read on every later turn
 * filtered   1.0·D  sent uncached exactly once, then a pointer for ever
 * ```
 *
 * There is no break-even term, unlike a prune: nothing is edited, so no prefix
 * is invalidated. The three parts are reported separately rather than blended,
 * because a single netted figure hides that the filter pays for itself on the
 * very first request and a reader has no way to check the claim.
 *
 * `2.0` is `CACHE_WRITE_1H_MULTIPLIER` and not the list-price 1.25×, for
 * `netReceipt`'s measured reason: every main-thread turn across 26,194 on this
 * install wrote at the one-hour class.
 *
 * ## Why the same result must be counted once
 *
 * The filter is stateless. It re-drops the same result on every later request
 * that still carries it, so a ledger line is a *request*, not a removal, and
 * summing `bytes_dropped` down the file charges one removal once per surviving
 * request. Measured on this install's ledger at 125 lines, 2026-08-24: 372
 * occurrences over 15 distinct results, a 24.8× overstatement. The factor is
 * not a constant — it is roughly how many requests a result survives, so it
 * grows with session length. The repeats are not a second saving:
 * they *are* the `0.1·D·T` term, at a tenth of the rate, and counting them at
 * `1.0·D` prices each one as a fresh cache write.
 *
 * So identity is `tool_use_id` where winnow wrote one, and `(session, tool,
 * rule, bytes)` where it did not — every line older than the change that added
 * the field, which on this install is all of them. The fallback pools two
 * byte-identical outputs of one tool in one session into a single result, which
 * errs low, and `fallbackKeyed` says how much of the figure rests on it.
 *
 * ## Where the clock comes from
 *
 * The ledger has no timestamp of its own. `request_id` joins to `requestId` on
 * an assistant record in the transcripts, and that record's instant, model and
 * session are what date and price the result — the same join `priceReceipts`
 * makes, main thread only for the same reason: a sub-agent's context is
 * discarded when it answers, so turns after it would never have re-read
 * anything. A request that joins to nothing is counted and left unpriced,
 * never guessed.
 */

/**
 * Where the entrypoint tells winnow to write, as a literal.
 *
 * `docker-entrypoint.sh` passes `--ledger /data/winnow/filter.jsonl` — the
 * named volume, hardcoded there, and *not* read from `DATA_DIR`. Copying the
 * literal is what keeps the two agreeing: deriving it from `DATA_DIR` or
 * `os.homedir()` would silently point somewhere else the moment either differs
 * from what the entrypoint passed.
 *
 * The two disagreeing is not hypothetical. The ledger moved here from
 * `/home/node/.winnow`, which a restart discards, and this constant did not
 * move with it: the reading fell to `ledger: "missing"` on an install whose
 * filter was rewriting every request, because a path that is not there is a
 * legitimate state rather than an error. Change one of the two and the other
 * says nothing — so when this literal changes, `grep` the entrypoint.
 */
const LEDGER_PATH = "/data/winnow/filter.jsonl";

/**
 * The switch that stops the filter rewriting without stopping the proxy.
 *
 * The entrypoint documents `touch` on this file as the way to turn the filter
 * off on a live container, which leaves `ANTHROPIC_BASE_URL` still pointing at
 * a proxy that now passes everything through. Both halves are checked, because
 * either one alone reports a filter that is not filtering as one that is.
 *
 * Beside the ledger, and on the same literal-copying rule: `--off-file`.
 */
const OFF_FILE = "/data/winnow/filter-off";

/**
 * How long a reading is reused.
 *
 * The dashboard polls every ten seconds and the ledger is append-only — every
 * request each agent in the fleet makes puts another line on it — so a
 * poll-rate reading re-reads and re-joins a growing file six times a minute for
 * a figure that moves by fractions of a cent. A minute is short enough that
 * nothing on screen is stale in a way an operator would act on, since nothing
 * here is actionable at all.
 */
const LEDGER_TTL_MS = 60_000;

/** One tool result the filter took off one request, as the ledger records it. */
export interface LedgerResult {
  tool: string;
  rule: string;
  bytes: number;
  /**
   * Present only on lines written since winnow began recording it. Null is the
   * ordinary case on an install that has been running a while, and it is what
   * puts a result on the `(session, tool, rule, bytes)` fallback.
   */
  toolUseId: string | null;
  /** `true` for a `dropped` entry, `false` for a `deferred` one. */
  dropped: boolean;
}

/** One ledger line: one request the filter rewrote. */
export interface LedgerRequest {
  requestId: string;
  /**
   * `dropped` and `deferred` pooled. A deferred result is the newest match,
   * kept in full this turn and dropped on the next — one result appearing
   * twice, never two.
   */
  results: LedgerResult[];
}

function readResultArray(value: unknown, dropped: boolean): LedgerResult[] {
  if (!Array.isArray(value)) return [];
  const out: LedgerResult[] = [];
  for (const item of value) {
    const rec = item as {
      tool?: unknown;
      rule?: unknown;
      bytes?: unknown;
      tool_use_id?: unknown;
    };
    const bytes =
      typeof rec.bytes === "number" && Number.isFinite(rec.bytes) ? rec.bytes : 0;
    // A zero-byte removal saved nothing and would still take a slot in the
    // fallback key, where it would pool with every other zero.
    if (bytes <= 0) continue;
    out.push({
      tool: typeof rec.tool === "string" ? rec.tool : "",
      rule: typeof rec.rule === "string" ? rec.rule : "",
      bytes,
      toolUseId:
        typeof rec.tool_use_id === "string" && rec.tool_use_id
          ? rec.tool_use_id
          : null,
      dropped,
    });
  }
  return out;
}

/**
 * The ledger, line by line, in the order it was appended.
 *
 * Order is load-bearing and is the only ordering signal there is: a line
 * carries no timestamp, so "the request that first carried this result" — the
 * one the baseline would have cached it on — is decided by position in the
 * file.
 *
 * A line that will not parse, or that carries no `request_id`, is skipped
 * rather than throwing: the file is appended to by another process and the last
 * line may be half-written, and a request with no id can be joined to nothing.
 */
export function parseLedger(text: string): LedgerRequest[] {
  const out: LedgerRequest[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = record as {
      request_id?: unknown;
      dropped?: unknown;
      deferred?: unknown;
    };
    const requestId =
      typeof rec.request_id === "string" ? rec.request_id : "";
    if (!requestId) continue;
    const results = [
      ...readResultArray(rec.dropped, true),
      ...readResultArray(rec.deferred, false),
    ];
    if (results.length === 0) continue;
    out.push({ requestId, results });
  }
  return out;
}

/** What the transcripts said about the request a result first rode on. */
export interface RequestAnchor {
  sessionId: string;
  /** Epoch milliseconds of the assistant turn that answered the request. */
  ts: number;
  model: string;
  speed?: string;
  /** Main-thread assistant turns that followed it in the same session. */
  turnsAfter: number;
}

/** One result, however many requests carried it. */
export interface UniqueResult {
  key: string;
  bytes: number;
  /** The first request that carried it — where the baseline would have cached it. */
  requestId: string;
  anchor: RequestAnchor | null;
  /** How many requests carried it, dropped or deferred. */
  occurrences: number;
  /**
   * Whether any request dropped it.
   *
   * A result seen only as `deferred` is not proved to have escaped the cache:
   * the filter moves the breakpoint in front of it, but that move fails
   * silently when the request already holds the maximum number of breakpoints,
   * and the ledger does not record which happened. A saving this app cannot
   * prove is not one it prints — see `deferredOnly`.
   */
  everDropped: boolean;
  /** Identity came from `(session, tool, rule, bytes)`, not a `tool_use_id`. */
  fallbackKeyed: boolean;
}

/**
 * One entry per distinct result, in first-seen order.
 *
 * `anchorOf` is passed in rather than read here so the whole of the de-dupe is
 * testable without a transcript tree — and because the session it returns is
 * part of the fallback key, which is the one thing that keeps two byte-
 * identical outputs of one tool in *different* sessions apart.
 */
export function dedupeResults(
  requests: LedgerRequest[],
  anchorOf: (requestId: string) => RequestAnchor | null,
): UniqueResult[] {
  const byKey = new Map<string, UniqueResult>();
  const anchors = new Map<string, RequestAnchor | null>();

  for (const request of requests) {
    if (!anchors.has(request.requestId)) {
      anchors.set(request.requestId, anchorOf(request.requestId));
    }
    const anchor = anchors.get(request.requestId) ?? null;
    // An unjoined request has no session, so every unjoined result pools into
    // one namespace. That errs low, which is the direction everything on this
    // figure errs in — and those results are unpriced anyway.
    const sessionId = anchor?.sessionId ?? "";

    for (const result of request.results) {
      const fallbackKeyed = result.toolUseId === null;
      const key = fallbackKeyed
        ? `fb:${sessionId}|${result.tool}|${result.rule}|${result.bytes}`
        : `id:${result.toolUseId}`;
      const seen = byKey.get(key);
      if (seen) {
        seen.occurrences += 1;
        seen.everDropped ||= result.dropped;
        continue;
      }
      byKey.set(key, {
        key,
        bytes: result.bytes,
        requestId: request.requestId,
        anchor,
        occurrences: 1,
        everDropped: result.dropped,
        fallbackKeyed,
      });
    }
  }

  return [...byKey.values()];
}

/** What the filter was worth, netted. */
export interface FilterNet {
  /** Distinct results proved to have been kept out of the cache. */
  results: number;
  /** How many of those the money below covers. */
  pricedResults: number;
  /** Results seen only as `deferred`, so excluded — see `UniqueResult.everDropped`. */
  deferredOnly: number;
  /** How many of `results` were identified without a `tool_use_id`. */
  fallbackKeyed: number;
  tokensRemoved: number;
  /** Turns the read saving is measured over, summed across results. */
  turnsAfter: number;
  /** `2.0·D` — the cache write that never happened. */
  cacheWriteAvoidedUSD: number;
  /** `1.0·D` — sending it once, uncached, which the filter still pays. */
  uncachedSendUSD: number;
  /** `0.1·D·T` — the reads on later turns that never happened. */
  cacheReadAvoidedUSD: number;
  netUSD: number;
}

export const NO_FILTER_NET: FilterNet = {
  results: 0,
  pricedResults: 0,
  deferredOnly: 0,
  fallbackKeyed: 0,
  tokensRemoved: 0,
  turnsAfter: 0,
  cacheWriteAvoidedUSD: 0,
  uncachedSendUSD: 0,
  cacheReadAvoidedUSD: 0,
  netUSD: 0,
};

/**
 * `1.0·D + 0.1·D·T` over every distinct result, priced at each one's own model.
 *
 * The rate is looked up at the anchor turn's instant rather than at now, on
 * `netReceipt`'s rule: a rate read at display time prices last month's saving
 * at this month's list. A model with no price here contributes tokens and no
 * dollars, so `pricedResults` below `results` is the gap to render rather than
 * a reason to guess.
 */
export function netFilterSavings(results: UniqueResult[]): FilterNet {
  const net: FilterNet = { ...NO_FILTER_NET };

  for (const result of results) {
    if (!result.everDropped) {
      net.deferredOnly += 1;
      continue;
    }
    const tokens = Math.round(result.bytes / BYTES_PER_TOKEN);
    net.results += 1;
    net.tokensRemoved += tokens;
    if (result.fallbackKeyed) net.fallbackKeyed += 1;

    const anchor = result.anchor;
    const price = anchor
      ? resolvePrice(anchor.model, { at: anchor.ts, speed: anchor.speed })
      : null;
    if (!anchor || !price) continue;

    const perToken = price.input / 1_000_000;
    net.pricedResults += 1;
    net.turnsAfter += anchor.turnsAfter;
    net.cacheWriteAvoidedUSD += tokens * perToken * CACHE_WRITE_1H_MULTIPLIER;
    net.uncachedSendUSD += tokens * perToken;
    net.cacheReadAvoidedUSD +=
      tokens * anchor.turnsAfter * perToken * CACHE_READ_MULTIPLIER;
  }

  net.netUSD =
    net.cacheWriteAvoidedUSD - net.uncachedSendUSD + net.cacheReadAvoidedUSD;
  return net;
}

/**
 * The results whose anchor turn landed at or after `from`.
 *
 * A result that joined to no transcript turn is **dropped** here rather than
 * kept. It stays in the total, where being undated costs nothing, but a window
 * is a claim about a span and a result nothing can place in one has not been
 * shown to belong to it. Every window figure is therefore a floor by more than
 * the total is — short by whatever the unjoined requests saved, which on this
 * install is most of them, because the filter's B2 rule fires hardest on the
 * tool-heavy sub-agent turns the main-thread join excludes.
 */
export function resultsSince(
  results: UniqueResult[],
  from: number,
): UniqueResult[] {
  return results.filter((r) => r.anchor !== null && r.anchor.ts >= from);
}

/** Whether the ledger could be read at all, which is three different facts. */
export type LedgerState = "missing" | "unreadable" | "empty" | "read";

/** The whole reading, as the route ships it. */
export interface FilterSavings extends FilterNet {
  /** Whether this container's own environment routes agents through the filter. */
  running: boolean;
  ledger: LedgerState;
  /** Ledger lines carrying at least one result. */
  requests: number;
  /** Requests that matched no assistant turn in the transcripts. */
  unjoinedRequests: number;
  /** Earliest instant the figures cover, or null when nothing bounded them. */
  totalFrom: number | null;
  /**
   * The same arithmetic over the two windows the meters draw, so the card can
   * show what share of a window's saving the filter is responsible for.
   *
   * One join, three nets: the anchor instant each result already carries is
   * what places it, so the windows cost a filter over an array rather than a
   * second read of the ledger and a second pass over every transcript.
   */
  session: FilterNet;
  weekly: FilterNet;
}

/** The three spans one reading covers, all measured from the same join. */
export interface FilterSpans {
  /** The transcript horizon, or null when nothing bounded it. */
  from: number | null;
  /** Start of the snapshot's own 5-hour window. */
  sessionFrom: number;
  /** Start of the snapshot's own weekly window. */
  weeklyFrom: number;
}

/**
 * Whether agents spawned from this process would reach the filter.
 *
 * Children are spawned with `{ ...process.env }`, so this process's own
 * `ANTHROPIC_BASE_URL` is theirs — which makes it the honest thing to read.
 * Loopback specifically: an install pointing agents at some other gateway is
 * not running this filter, and its ledger would be history.
 */
function filterRunning(): boolean {
  const base = process.env.ANTHROPIC_BASE_URL ?? "";
  if (!base.includes("127.0.0.1") && !base.includes("localhost")) return false;
  return !fs.existsSync(OFF_FILE);
}

/** Ascending `ts` per session, so `turnsAfter` is a binary search per result. */
function sessionTimelines(entries: UsageEntry[]): Map<string, number[]> {
  const bySession = new Map<string, number[]>();
  for (const entry of entries) {
    const list = bySession.get(entry.sessionId);
    if (list) list.push(entry.ts);
    else bySession.set(entry.sessionId, [entry.ts]);
  }
  for (const list of bySession.values()) list.sort((a, b) => a - b);
  return bySession;
}

/** How many of `sorted` are strictly greater than `ts`. */
function countAfter(sorted: number[], ts: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= ts) low = mid + 1;
    else high = mid;
  }
  return sorted.length - low;
}

async function measureFilter(spans: FilterSpans): Promise<FilterSavings> {
  const from = spans.from;
  const running = filterRunning();
  const base = {
    ...NO_FILTER_NET,
    running,
    requests: 0,
    unjoinedRequests: 0,
    totalFrom: from,
    session: NO_FILTER_NET,
    weekly: NO_FILTER_NET,
  };

  let text: string;
  try {
    text = fs.readFileSync(LEDGER_PATH, "utf8");
  } catch (err) {
    // A file that is not there and a file this uid may not open are different
    // facts and the card says which: the first is a filter that has written
    // nothing here, the second is a figure that exists and cannot be read.
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return { ...base, ledger: missing ? "missing" : "unreadable" };
  }

  const requests = parseLedger(text);
  if (requests.length === 0) return { ...base, ledger: "empty" };

  // Main thread only, `priceReceipts`' reason: a sub-agent's context is
  // discarded when it answers, so no later turn would have re-read anything the
  // filter took off one of its requests.
  const { entries } = await scanUsage();
  const mainThread = entries.filter((e) => !e.isSidechain);
  const byRequest = new Map<string, UsageEntry>();
  for (const entry of mainThread) {
    if (entry.requestId && !byRequest.has(entry.requestId)) {
      byRequest.set(entry.requestId, entry);
    }
  }
  const timelines = sessionTimelines(mainThread);

  let unjoined = 0;
  const anchorOf = (requestId: string): RequestAnchor | null => {
    const entry = byRequest.get(requestId);
    if (!entry) {
      unjoined += 1;
      return null;
    }
    return {
      sessionId: entry.sessionId,
      ts: entry.ts,
      model: entry.model,
      speed: entry.speed,
      turnsAfter: countAfter(timelines.get(entry.sessionId) ?? [], entry.ts),
    };
  };

  const unique = dedupeResults(requests, anchorOf);
  // The same horizon the prune total is bounded at, applied to the anchor turn:
  // past it the transcript has been swept and there is nothing to price
  // against. A result that joined to nothing has no instant to test, and stays
  // in — counted, unpriced, and visible in the gap between `results` and
  // `pricedResults`.
  const withinSpan =
    from === null
      ? unique
      : unique.filter((r) => r.anchor === null || r.anchor.ts >= from);

  return {
    ...netFilterSavings(withinSpan),
    session: netFilterSavings(resultsSince(withinSpan, spans.sessionFrom)),
    weekly: netFilterSavings(resultsSince(withinSpan, spans.weeklyFrom)),
    running,
    ledger: "read",
    requests: requests.length,
    unjoinedRequests: unjoined,
    totalFrom: from !== null && from > 0 ? from : null,
  };
}

/**
 * `globalThis`-pinned for the transcript cache's reason: module state that is
 * not pinned silently resets on every request in dev, which is where a reading
 * that has just been made shareable goes back to being made once per reader.
 * A new key rather than a reused one, since nothing has held this shape before.
 */
const ledgerCache = ((globalThis as unknown as {
  __ufIntakeFilterSavingsV2?: {
    value: FilterSavings | null;
    measuredAt: number;
    spans: FilterSpans | null;
    inFlight: Promise<FilterSavings> | null;
  };
}).__ufIntakeFilterSavingsV2 ??= {
  value: null,
  measuredAt: 0,
  spans: null,
  inFlight: null,
});

/**
 * The grain the transcript horizon is read at, and why it is not read exactly.
 *
 * `spans.from` is the retention cutoff, which the route computes as `now` minus
 * the retention — a different millisecond on every request. The cache below
 * keys on the spans it measured, correctly, so those two together made every
 * reading a miss: the dashboard's ten-second heartbeat re-read the ledger and
 * re-ran the join over every transcript entry six times a minute, which is the
 * exact cost `LEDGER_TTL_MS` exists to avoid. Nothing looked wrong — the
 * figures were right, and a cache that never hits is only ever visible as load.
 *
 * So the horizon is floored to the same minute the reading is reused for. What
 * that costs is up to a minute of extra history at the far edge of a span
 * measured in weeks, on a bound that is approximate in the same direction
 * anyway: what makes it true is a sweep that runs on its own schedule, so a
 * result just inside it is as likely to still have its transcript as one just
 * outside. Floored rather than rounded, so the horizon only ever moves outward
 * within a grain and a result cannot leave a reading and come back on the next
 * poll.
 *
 * The two window starts are not touched. They move when their windows roll
 * over, which is a real change of subject and must miss.
 */
const HORIZON_GRAIN_MS = LEDGER_TTL_MS;

/** `spans` with its horizon floored to `HORIZON_GRAIN_MS`. */
function alignSpans(spans: FilterSpans): FilterSpans {
  if (spans.from === null) return spans;
  return {
    ...spans,
    from: Math.floor(spans.from / HORIZON_GRAIN_MS) * HORIZON_GRAIN_MS,
  };
}

/**
 * The reading, at most one read of the ledger a minute and at most one at a
 * time.
 *
 * Different spans are a miss rather than a hit: the cached figures describe
 * three of them, and serving them under others would silently answer a
 * question nobody asked. The 5-hour window's start moves, so a reading is
 * discarded when it rolls over rather than a minute later.
 *
 * The horizon is aligned before any of that, `HORIZON_GRAIN_MS`' reason, and
 * the aligned value is what is measured as well as what is compared — a cache
 * key that described a span other than the one the figures cover is the thing
 * the paragraph above refuses.
 */
export function readFilterSavings(
  requested: FilterSpans,
  now: number,
): Promise<FilterSavings> {
  const spans = alignSpans(requested);
  const cached = ledgerCache.value;
  const sameSpans =
    ledgerCache.spans !== null &&
    ledgerCache.spans.from === spans.from &&
    ledgerCache.spans.sessionFrom === spans.sessionFrom &&
    ledgerCache.spans.weeklyFrom === spans.weeklyFrom;
  if (cached && sameSpans && now - ledgerCache.measuredAt < LEDGER_TTL_MS) {
    return Promise.resolve(cached);
  }
  // Single-flight, the Storage card's shape: the join runs over every entry in
  // the transcript scan, so two readers arriving together should share one pass
  // rather than each make their own.
  ledgerCache.inFlight ??= measureFilter(spans)
    .then((value) => {
      ledgerCache.value = value;
      ledgerCache.measuredAt = now;
      ledgerCache.spans = spans;
      return value;
    })
    .finally(() => {
      ledgerCache.inFlight = null;
    });
  return ledgerCache.inFlight;
}
