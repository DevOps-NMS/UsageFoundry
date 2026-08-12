import fs from "node:fs/promises";
import path from "node:path";
import { CLAUDE_CONFIG_DIR } from "./config";
import type { PlanUsage, PlanWindow } from "./windows";

/**
 * What the provider says this account has used, straight from the provider.
 *
 * Everything else in this app derives a percentage: our price table over local
 * transcripts, divided by a ceiling somebody typed. That was wrong by ~4x on
 * the machine this was written against — 5.0% reported against 1.3% derived —
 * and it could not have been anything else, because Anthropic publishes no
 * numeric value for a Pro/Max limit and the typed ceiling is a guess. The
 * arithmetic was never the problem; the denominator was.
 *
 * `GET /api/oauth/usage` is what Claude Code's own `/usage` screen reads and
 * what the web app's usage page shows. It answers with a percentage per window
 * and the instant each one resets, for the whole account — including the
 * surfaces that share the allowance and write nothing to this disk (the web
 * app, Desktop, Cowork). That is the number a user is comparing us against.
 *
 * Three properties of this source drive the design below.
 *
 *  1. **It is the account's, not this app's.** The credential is Claude Code's
 *     own OAuth token, read from the same tree whose transcripts we scan, so
 *     the answer describes the same account. The token is never refreshed
 *     here: refresh rotates it, and rotating a credential out from under the
 *     CLI to draw a meter is not a trade worth making. An expired token is a
 *     miss.
 *  2. **It is rate limited.** Hitting it a handful of times inside a minute
 *     earns a 429, and this app polls its dashboard every 5–10 seconds. So it
 *     is cached on Claude Code's own cadence — the CLI refreshes at most every
 *     5 minutes and treats a cached reading as usable for an hour, both read
 *     out of the shipped binary — and a failure serves the last good value
 *     rather than blanking the meter.
 *  3. **It is undocumented.** Same discipline as `account.ts`: every failure
 *     is a null, never an exception and never a zero. A window we cannot read
 *     falls back to the derived reading, which is what shipped before this.
 */

/** Where the CLI keeps the OAuth credential, alongside its other state. */
function credentialsPath(): string {
  return path.join(CLAUDE_CONFIG_DIR, ".credentials.json");
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Matches the CLI's own minimum age before it re-reads utilisation. */
export const REFRESH_MS = 300_000;

/**
 * How stale a reading may be and still be shown. Also the CLI's own bound.
 *
 * Past this the meter goes back to the derived reading rather than reporting
 * an hour-old percentage as current — a window can go from empty to full in
 * well under an hour.
 */
export const MAX_STALE_MS = 3_600_000;

/** Back-off after a refusal, so a 429 is not answered with more requests. */
const ERROR_BACKOFF_MS = 60_000;

/**
 * Read the access token, or null.
 *
 * Only `CLAUDE_CONFIG_DIR` is consulted — never `~/.credentials.json` as a
 * fallback — for the reason `account.ts` restricts its own last candidate:
 * once someone points this app at another machine's transcript tree, the
 * home-directory credential belongs to whoever is logged in *here*, and a
 * confident percentage for the wrong account is worse than none. On macOS the
 * CLI may keep this in the Keychain instead, in which case there is no file
 * and this reports a miss.
 */
async function readAccessToken(now: number): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(credentialsPath(), "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = raw.claudeAiOauth;
    if (!oauth) return null;

    const token = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
    if (!token) return null;

    // Expired tokens are skipped rather than sent. The request would 401, and
    // the only cure is a refresh this module deliberately does not do.
    const expiresAt = Number(oauth.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) {
      return null;
    }
    return token;
  } catch {
    return null; // missing, unreadable, mid-write, or a shape we do not know
  }
}

/**
 * Numbers only, never a coercion.
 *
 * `Number(null)` is 0 and `Number("")` is 0, so coercing here would turn "this
 * window has no reading" into "this window is empty" — a hatched meter
 * replaced by a confident, wrong 0%, which is the one substitution this whole
 * codebase is built to refuse.
 */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Turn the provider's percentage into the 0–1 fraction the rest of the app
 * uses.
 *
 * Negative readings are floored at 0; a reading above 100% is kept, because a
 * window can legitimately be over its wall and clamping it would report a run
 * that is being refused as one that is merely at the line.
 */
function fractionOfPercent(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.max(0, n / 100);
}

function resetsAt(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? at : null;
}

function windowOf(raw: unknown): PlanWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const utilization = fractionOfPercent(o.utilization);
  if (utilization === null) return null;
  return { utilization, resetsAt: resetsAt(o.resets_at) };
}

/**
 * Parse the payload. Pure, and the whole of what this module gets wrong when
 * the shape moves, which is why it is the part under test.
 *
 * `five_hour` and `seven_day` are read from the top level because that is
 * where the reset instants are. The model-scoped weekly walls come from the
 * `limits` array instead of from the `seven_day_opus` / `seven_day_sonnet`
 * keys beside them: the array carries a display name and a `kind`, so a model
 * family this build has never heard of still reaches the guard, where a
 * key-per-model reader would silently miss it.
 */
export function parsePlanUsage(raw: unknown, fetchedAt: number): PlanUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const session = windowOf(o.five_hour);
  const weekly = windowOf(o.seven_day);

  const scopedWeekly: PlanUsage["scopedWeekly"] = [];
  if (Array.isArray(o.limits)) {
    for (const entry of o.limits) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (e.kind !== "weekly_scoped") continue;

      const utilization = fractionOfPercent(e.percent);
      if (utilization === null) continue;

      const scope = (e.scope ?? {}) as Record<string, unknown>;
      const model = (scope.model ?? {}) as Record<string, unknown>;
      const label =
        typeof model.display_name === "string" && model.display_name
          ? model.display_name
          : "scoped";

      scopedWeekly.push({
        label,
        window: { utilization, resetsAt: resetsAt(e.resets_at) },
      });
    }
  }

  // A payload that named no window at all is a shape we do not understand,
  // not an account at 0%.
  if (!session && !weekly && scopedWeekly.length === 0) return null;

  return { session, weekly, scopedWeekly, fetchedAt };
}

interface CacheEntry {
  /** When the last request was attempted, successful or not. */
  attemptedAt: number;
  /** Last good reading, kept across failures until it goes stale. */
  value: PlanUsage | null;
}

// Survives dev hot reload, like every other long-lived singleton here: a fresh
// cache per module evaluation would re-request on every request in dev and
// earn the 429 this cache exists to avoid.
const cache = ((globalThis as unknown as { __ufPlanUsage?: { v?: CacheEntry } })
  .__ufPlanUsage ??= {});

let inflight: Promise<PlanUsage | null> | null = null;

async function fetchPlanUsage(now: number): Promise<PlanUsage | null> {
  const token = await readAccessToken(now);
  if (!token) return null;

  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}` },
    // Next patches `fetch` and caches through it. The staleness policy for
    // this reading is the one above — five minutes to refresh, an hour before
    // it stops being shown — and a second, invisible cache underneath it would
    // freeze the meter with nothing on screen to say so.
    cache: "no-store",
    // The CLI's own timeout for this call. A dashboard poll and a pre-cycle
    // budget read both wait on it, so it must fail faster than either cares.
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;

  return parsePlanUsage(await res.json(), now);
}

/**
 * The provider's reading, cached.
 *
 * Never throws and never rejects: a caller gets a reading or null, and null
 * means "measure it the old way". Concurrent callers share one request —
 * the run loop reads this before every work cycle while the dashboard polls,
 * and they arrive together.
 */
export async function planUsage(now = Date.now()): Promise<PlanUsage | null> {
  const hit = cache.v;
  const value = hit?.value ?? null;
  // Two separate brakes, and the second one is load-bearing: a reading that
  // has aged past `REFRESH_MS` while every request is being refused would
  // otherwise re-request on every dashboard poll, which is how a transient 429
  // becomes a permanent one.
  const fresh = value !== null && now - value.fetchedAt < REFRESH_MS;
  const justTried = hit !== undefined && now - hit.attemptedAt < ERROR_BACKOFF_MS;
  if (fresh || justTried) return usable(value, now);

  if (!inflight) {
    inflight = fetchPlanUsage(now)
      .catch(() => null)
      .then((value) => {
        // A failure keeps the last good reading — it is what makes a blip, a
        // brief 429 or a dropped connection invisible — but the attempt is
        // recorded either way so the next caller backs off rather than
        // retrying immediately.
        cache.v = { attemptedAt: now, value: value ?? cache.v?.value ?? null };
        return usable(cache.v.value, now);
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Drop a reading that has aged past the point of describing the present. */
function usable(value: PlanUsage | null, now: number): PlanUsage | null {
  if (!value) return null;
  return now - value.fetchedAt <= MAX_STALE_MS ? value : null;
}

/** Drop the cache — used by tests and after a settings change. */
export function invalidatePlanUsage(): void {
  cache.v = undefined;
}
