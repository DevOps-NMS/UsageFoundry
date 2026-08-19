"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AccountResponse } from "@/lib/apiTypes";
import { fmtTokens, fmtUSD } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle, Empty, Stat, StatSub } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import {
  TBody,
  THead,
  Table,
  TableWrap,
  Td,
  Th,
  Tr,
} from "@/components/ui/Table";

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

/** How many days of the cost report the table shows. The rest are summed above. */
const DAILY_ROWS = 14;

/**
 * Why this page exists beside the dashboard, said once.
 *
 * An operator who does not trust the dashboard's percentages arrives here
 * expecting authoritative numbers and finds either an empty panel or figures
 * that describe something else entirely. Both readings are correct and neither
 * is obvious, so the relationship between the two views is the page's lede
 * rather than a footnote under a table.
 */
function Lede() {
  return (
    <div className="mb-5 max-w-[70ch] space-y-2 text-ink-muted">
      <p>
        Read straight from Anthropic&apos;s Admin API: what your organization
        was billed, and the rate limits it is configured with. These numbers are
        authoritative.
      </p>
      {/* Folded, and this is the one paragraph on the page that may be: it is
          read once, it explains why something is *not* here, and no decision on
          this page is approved against it — there are no controls on this page
          at all while it is working. Three sentences of standing prose above
          four figures is what somebody arrives here to read past. The `Not
          configured` state keeps its own full explanation, because that is the
          state where the sentence is load-bearing. */}
      <Disclosure summary="Why a Pro or Max subscription is not shown here">
        <p className="mt-2 text-xs leading-relaxed">
          A Pro or Max subscription is invisible here — Anthropic publishes no
          endpoint for one, and no numeric value for its limits. That is why the
          dashboard estimates from local transcripts instead, and why the
          ceilings under Settings have to be calibrated from your own history
          rather than read from an account. The two views are never added
          together.
        </p>
      </Disclosure>
    </div>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <>
      <h1 className="mb-2 text-xl font-semibold tracking-tight">API account</h1>
      <Lede />
      {children}
    </>
  );
}

export default function AccountPage() {
  const [data, setData] = useState<AccountResponse | null>(null);
  const [loading, setLoading] = useState(true);
  /** A failure reaching *this server*, as against one the Admin API reported. */
  const [fetchError, setFetchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/account", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as AccountResponse | null;
      // A 401 comes back as `{error:"Unauthorized"}` with no `configured` key,
      // which would otherwise render as "not configured" and send the operator
      // looking for an admin key they have already set.
      if (res.status === 401) {
        setFetchError("Signed out. Sign in again to read this page.");
        return;
      }
      if (!json) {
        setFetchError(`The server answered ${res.status} with no readable body.`);
        return;
      }
      setData(json);
    } catch (err) {
      setFetchError(
        `The server could not be reached — ${err instanceof Error ? err.message : String(err)}.`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Page>
        <Card>
          <Empty>Querying the Admin API…</Empty>
        </Card>
      </Page>
    );
  }

  if (fetchError) {
    return (
      <Page>
        <Card>
          <Notice tone="danger">
            <strong>This page could not be loaded.</strong> {fetchError}
          </Notice>
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </Card>
      </Page>
    );
  }

  if (!data?.configured) {
    return (
      <Page>
        <Card>
          <CardTitle>Not configured</CardTitle>
          <p className="mb-3 max-w-[70ch] text-sm text-ink-muted">
            {data?.reason ??
              "No Admin API key is set, so there is nothing to read."}
          </p>
          <p className="max-w-[70ch] text-xs leading-relaxed text-ink-faint">
            Set <span className="mono">ANTHROPIC_ADMIN_KEY</span> and restart
            the container — process configuration is read once at boot. If you
            only have a Pro or Max subscription there is no such key to set, and
            this page will stay as it is: the dashboard is your view.
          </p>
        </Card>
      </Page>
    );
  }

  if (data.error) {
    return (
      <Page>
        <Card>
          <Notice tone="danger">
            <strong>The Admin API refused the request.</strong> {data.error}
          </Notice>
          <p className="mb-3 max-w-[70ch] text-xs leading-relaxed text-ink-muted">
            This surface needs an organization Admin key (
            <span className="mono">sk-ant-admin01-…</span>), which is a
            different credential from a regular API key and is unavailable to
            individual accounts.
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </Card>
      </Page>
    );
  }

  const daily = data.cost?.daily ?? [];
  const recent = daily.slice().reverse().slice(0, DAILY_ROWS);

  return (
    <Page>
      <section className="mt-0 mb-4 grid gap-4 md:grid-cols-2">
        <Card emphasis="primary">
          <CardTitle>Billed cost — last 30 days</CardTitle>
          {/* Absent is not zero: an empty cost report and a month with no
              spend are different facts, and only one of them is $0.00. */}
          <Stat size="large">
            {data.cost ? fmtUSD(data.cost.last30dUSD) : "—"}
          </Stat>
          <StatSub>
            from <span className="mono">/v1/organizations/cost_report</span>
          </StatSub>
          <p className="mt-3 max-w-[52ch] text-xs leading-relaxed text-ink-faint">
            Priority Tier spend is billed separately and is not in this figure.
          </p>
        </Card>

        <Card>
          <CardTitle>
            Daily cost
            {daily.length > DAILY_ROWS && (
              <Badge>
                latest {DAILY_ROWS} of {daily.length}
              </Badge>
            )}
          </CardTitle>
          {recent.length === 0 ? (
            <Empty>No cost data in range.</Empty>
          ) : (
            // Deliberately not a `stack` table, and the one on this page that
            // is not: it has no `<thead>` at all, so there is no column name to
            // lose below the breakpoint — and a date beside a dollar figure is
            // already two short columns that fit a 390px pane. Stacking it
            // would turn every row into two lines to name what a date and a
            // dollar sign say on their own.
            <div className="max-h-[200px] overflow-y-auto">
              <Table>
                <tbody>
                  {recent.map((d) => (
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
            <Table stack>
              <THead>
                <tr>
                  <Th>Group</Th>
                  <Th>Models</Th>
                  <Th>Limits</Th>
                </tr>
              </THead>
              <TBody>
                {data.rateLimits.map((g, i) => (
                  <Tr key={i}>
                    {/* No label: the group is what the record is. */}
                    <Td>
                      <Badge>{g.group_type}</Badge>
                    </Td>
                    {/* Both names sit above their values: one is a comma list of
                        model ids and the other is a block of label/figure rows,
                        and neither survives being squeezed into the right half
                        of a 390px row. */}
                    <Td
                      label="Models"
                      labelPlacement="above"
                      className="mono max-w-[320px] max-md:max-w-none"
                    >
                      {g.models?.join(", ") ?? "—"}
                    </Td>
                    <Td label="Limits" labelPlacement="above">
                      {g.limits.map((l) => (
                        <div key={l.type} className="flex gap-2">
                          <span className="text-ink-muted">
                            {LIMIT_LABELS[l.type] ?? l.type}
                          </span>
                          <span className="mono ml-auto">
                            {formatLimit(l.type, l.value)}
                          </span>
                        </div>
                      ))}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </Page>
  );
}
