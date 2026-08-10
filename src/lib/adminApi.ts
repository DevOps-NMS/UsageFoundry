import { ADMIN_API_KEY, ANTHROPIC_API_BASE, USER_AGENT } from "./config";

/**
 * Client for the Anthropic Admin API surfaces this tool reads:
 *
 *   GET /v1/organizations/rate_limits            configured RPM / ITPM / OTPM
 *   GET /v1/organizations/usage_report/messages  token counts by bucket
 *   GET /v1/organizations/cost_report            billed cost in USD
 *
 * All three need an Admin key (`sk-ant-admin01-…`), which is distinct from a
 * regular API key and is unavailable to individual (non-organization) accounts.
 * Every function throws AdminApiError rather than returning a partial result,
 * so a misconfigured key surfaces in the UI instead of rendering as $0.
 */

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

async function adminGet<T>(
  pathname: string,
  params: Record<string, string | string[] | undefined> = {},
): Promise<T> {
  if (!ADMIN_API_KEY) {
    throw new AdminApiError("No Admin API key configured", 0);
  }

  const url = new URL(pathname, ANTHROPIC_API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    // Array params use the repeated `key[]=` form.
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(`${k}[]`, item);
    else url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: {
      "x-api-key": ADMIN_API_KEY,
      "anthropic-version": "2023-06-01",
      "user-agent": USER_AGENT,
    },
    cache: "no-store",
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const detail =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      res.statusText;
    throw new AdminApiError(`Admin API ${res.status}: ${detail}`, res.status, body);
  }
  return body as T;
}

/* ------------------------------------------------------------------ */
/* Rate limits                                                         */
/* ------------------------------------------------------------------ */

export interface RateLimitEntry {
  type: string;
  group_type: "model_group" | "batch" | "token_count" | "files" | "skills" | "web_search";
  models: string[] | null;
  limits: Array<{ type: string; value: number }>;
}

export async function fetchRateLimits(): Promise<RateLimitEntry[]> {
  const out: RateLimitEntry[] = [];
  let page: string | undefined;
  // Responses are single-page today, but the docs ask clients to follow
  // next_page so they keep working when that changes.
  do {
    const res = await adminGet<{ data: RateLimitEntry[]; next_page: string | null }>(
      "/v1/organizations/rate_limits",
      { page },
    );
    out.push(...(res.data ?? []));
    page = res.next_page ?? undefined;
  } while (page);
  return out;
}

/* ------------------------------------------------------------------ */
/* Usage report                                                        */
/* ------------------------------------------------------------------ */

export interface UsageBucket {
  starting_at: string;
  ending_at: string;
  results: Array<Record<string, unknown>>;
}

export type BucketWidth = "1m" | "1h" | "1d";

export async function fetchUsageReport(opts: {
  startingAt: Date;
  endingAt?: Date;
  bucketWidth?: BucketWidth;
  groupBy?: string[];
  limit?: number;
}): Promise<UsageBucket[]> {
  const buckets: UsageBucket[] = [];
  let page: string | undefined;

  do {
    const res = await adminGet<{
      data: UsageBucket[];
      has_more: boolean;
      next_page: string | null;
    }>("/v1/organizations/usage_report/messages", {
      starting_at: opts.startingAt.toISOString(),
      ending_at: opts.endingAt?.toISOString(),
      bucket_width: opts.bucketWidth ?? "1d",
      group_by: opts.groupBy,
      limit: opts.limit ? String(opts.limit) : undefined,
      page,
    });
    buckets.push(...(res.data ?? []));
    page = res.has_more ? (res.next_page ?? undefined) : undefined;
  } while (page);

  return buckets;
}

/* ------------------------------------------------------------------ */
/* Cost report                                                         */
/* ------------------------------------------------------------------ */

export interface CostBucket {
  starting_at: string;
  ending_at: string;
  results: Array<{
    /** Decimal string in USD cents, per the API contract. */
    amount?: string;
    currency?: string;
    description?: string;
    workspace_id?: string | null;
    model?: string | null;
    [k: string]: unknown;
  }>;
}

export async function fetchCostReport(opts: {
  startingAt: Date;
  endingAt?: Date;
  groupBy?: string[];
}): Promise<CostBucket[]> {
  const buckets: CostBucket[] = [];
  let page: string | undefined;

  do {
    const res = await adminGet<{
      data: CostBucket[];
      has_more: boolean;
      next_page: string | null;
    }>("/v1/organizations/cost_report", {
      starting_at: opts.startingAt.toISOString(),
      ending_at: opts.endingAt?.toISOString(),
      group_by: opts.groupBy,
      page,
    });
    buckets.push(...(res.data ?? []));
    page = res.has_more ? (res.next_page ?? undefined) : undefined;
  } while (page);

  return buckets;
}

/**
 * Sum a cost report into dollars.
 *
 * `amount` is documented as a decimal string in the currency's lowest unit
 * (cents), so it is divided by 100 and never parsed as a float-dollar value.
 */
export function sumCostUSD(buckets: CostBucket[]): number {
  let cents = 0;
  for (const b of buckets) {
    for (const r of b.results ?? []) {
      if (!r.amount) continue;
      if (r.currency && r.currency.toUpperCase() !== "USD") continue;
      const v = Number(r.amount);
      if (Number.isFinite(v)) cents += v;
    }
  }
  return cents / 100;
}
