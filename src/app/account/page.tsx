"use client";

import { useEffect, useState } from "react";
import type { AccountResponse } from "@/lib/apiTypes";
import { fmtTokens, fmtUSD } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Empty, Stat, StatSub } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

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

  if (loading) return <Empty>Querying the Admin API…</Empty>;

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">API account</h1>
      <p className="mb-4 max-w-[68ch] text-ink-muted">
        Read straight from Anthropic&apos;s Admin API. Unlike the subscription
        figures on the dashboard, these numbers are authoritative — configured
        rate limits and billed cost, not local estimates.
      </p>

      {!data?.configured && (
        <Notice tone="info">
          <strong>Not configured.</strong> {data?.reason}
        </Notice>
      )}

      {data?.configured && data.error && (
        <Notice tone="danger">
          <strong>Admin API error.</strong> {data.error}
          <div className="mt-1.5">
            The Admin API requires an organization Admin key (
            <span className="mono">sk-ant-admin01-…</span>) and is unavailable to
            individual accounts. If you only use a Pro/Max subscription, this
            panel will never populate — the dashboard is your view.
          </div>
        </Notice>
      )}

      {data?.configured && !data.error && (
        <>
          <section className="mb-4 grid gap-4 md:grid-cols-2">
            <Card emphasis="primary">
              <CardTitle>Billed cost — last 30 days</CardTitle>
              <Stat size="large">{fmtUSD(data.cost?.last30dUSD ?? 0)}</Stat>
              <StatSub>
                from <span className="mono">/v1/organizations/cost_report</span>
              </StatSub>
              <div className="mt-2 text-xs text-ink-faint">
                Priority Tier spend is billed differently and is not included in
                this endpoint.
              </div>
            </Card>

            <Card>
              <CardTitle>Daily cost</CardTitle>
              {!data.cost?.daily?.length ? (
                <Empty>No cost data in range.</Empty>
              ) : (
                <div className="max-h-[200px] overflow-y-auto">
                  <Table>
                    <tbody>
                      {data.cost.daily
                        .slice()
                        .reverse()
                        .slice(0, 14)
                        .map((d) => (
                          <Tr key={d.date}>
                            <Td className="mono">{d.date.slice(0, 10)}</Td>
                            <Td num>{fmtUSD(d.usd)}</Td>
                          </Tr>
                        ))}
                    </tbody>
                  </Table>
                </div>
              )}
            </Card>
          </section>

          <Card>
            <CardTitle>Configured rate limits</CardTitle>
            {!data.rateLimits?.length ? (
              <Empty>No rate limit groups returned.</Empty>
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>Group</Th>
                      <Th>Models</Th>
                      <Th>Limits</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rateLimits.map((g, i) => (
                      <Tr key={i}>
                        <Td>
                          <Badge>{g.group_type}</Badge>
                        </Td>
                        <Td className="mono max-w-[320px]">
                          {g.models?.join(", ") ?? "—"}
                        </Td>
                        <Td>
                          {g.limits.map((l) => (
                            <div key={l.type}>
                              <span className="text-ink-muted">
                                {LIMIT_LABELS[l.type] ?? l.type}:
                              </span>{" "}
                              <span className="mono">
                                {formatLimit(l.type, l.value)}
                              </span>
                            </div>
                          ))}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>
        </>
      )}
    </>
  );
}
