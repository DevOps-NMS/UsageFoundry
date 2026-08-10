"use client";

import { useEffect, useState } from "react";
import type { AccountResponse } from "@/lib/apiTypes";
import { fmtTokens, fmtUSD } from "@/lib/format";

const LIMIT_LABELS: Record<string, string> = {
  requests_per_minute: "Requests / min",
  input_tokens_per_minute: "Input tokens / min",
  output_tokens_per_minute: "Output tokens / min",
  enqueued_batch_requests: "Enqueued batch requests",
};

function formatLimit(type: string, value: number): string {
  return type.endsWith("tokens_per_minute")
    ? fmtTokens(value)
    : value.toLocaleString();
}

export default function AccountPage() {
  const [data, setData] = useState<AccountResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/account", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setData({ configured: true, error: String(e) }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="empty">Querying the Admin API…</div>;

  return (
    <>
      <h1>API account</h1>
      <p className="lede">
        Read straight from Anthropic&apos;s Admin API. Unlike the subscription
        figures on the dashboard, these numbers are authoritative — configured
        rate limits and billed cost, not local estimates.
      </p>

      {!data?.configured && (
        <div className="notice" data-tone="info">
          <strong>Not configured.</strong> {data?.reason}
        </div>
      )}

      {data?.configured && data.error && (
        <div className="notice" data-tone="danger">
          <strong>Admin API error.</strong> {data.error}
          <div style={{ marginTop: 6 }}>
            The Admin API requires an organization Admin key
            (<span className="mono">sk-ant-admin01-…</span>) and is unavailable to
            individual accounts. If you only use a Pro/Max subscription, this
            panel will never populate — the dashboard is your view.
          </div>
        </div>
      )}

      {data?.configured && !data.error && (
        <>
          <section className="grid grid-2">
            <div className="card">
              <h2 className="card-title">Billed cost — last 30 days</h2>
              <div className="stat">{fmtUSD(data.cost?.last30dUSD ?? 0)}</div>
              <div className="stat-sub">
                from <span className="mono">/v1/organizations/cost_report</span>
              </div>
              <div className="hint">
                Priority Tier spend is billed differently and is not included in
                this endpoint.
              </div>
            </div>

            <div className="card">
              <h2 className="card-title">Daily cost</h2>
              {!data.cost?.daily?.length ? (
                <div className="empty">No cost data in range.</div>
              ) : (
                <div className="table-wrap" style={{ maxHeight: 200, overflowY: "auto" }}>
                  <table>
                    <tbody>
                      {data.cost.daily
                        .slice()
                        .reverse()
                        .slice(0, 14)
                        .map((d) => (
                          <tr key={d.date}>
                            <td className="mono">{d.date.slice(0, 10)}</td>
                            <td className="num">{fmtUSD(d.usd)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">Configured rate limits</h2>
            {!data.rateLimits?.length ? (
              <div className="empty">No rate limit groups returned.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th>Models</th>
                      <th>Limits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rateLimits.map((g, i) => (
                      <tr key={i}>
                        <td>
                          <span className="badge">{g.group_type}</span>
                        </td>
                        <td className="mono" style={{ maxWidth: 320 }}>
                          {g.models?.join(", ") ?? "—"}
                        </td>
                        <td>
                          {g.limits.map((l) => (
                            <div key={l.type}>
                              <span style={{ color: "var(--fg-muted)" }}>
                                {LIMIT_LABELS[l.type] ?? l.type}:
                              </span>{" "}
                              <span className="mono">
                                {formatLimit(l.type, l.value)}
                              </span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
