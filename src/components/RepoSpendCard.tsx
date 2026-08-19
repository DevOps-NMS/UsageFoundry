"use client";

import { useCallback, useEffect, useState } from "react";
import type { RepoSpendDTO } from "@/lib/apiTypes";
import { fmtUSD, pollFailureMessage } from "@/lib/format";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { ListView, STICKY_HEAD_FLAT } from "@/components/ui/ListView";
import { Notice } from "@/components/ui/Notice";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/Table";

/**
 * What each repository cost, over a span.
 *
 * The figure that was missing between "this run spent $M" and "the account
 * spent $N this week": an operator watching the weekly window pass 80% across
 * fifteen repositories had no way to find out which one was consuming it, so the
 * only available response was to slow everything down.
 *
 * Three things the copy has to keep saying, because each is a way of reading
 * this wrongly:
 *
 *   - **It is a floor.** A cycle in flight has reported nothing and contributes
 *     nothing for its whole duration.
 *   - **It is not the meters.** `runs.spent_usd` is the CLI's own per-cycle
 *     figure for runs this app spawned; the windows above are our price table
 *     over every transcript on the machine. They describe overlapping work, so
 *     adding them double-counts — which is why this is a plain table rather than
 *     a meter, and why it carries no percentage of any window.
 *   - **It is not a limit.** Nothing here reaches a guard. A threshold on a
 *     repository is a limit nobody set.
 *
 * Its own request rather than a field on `/api/usage`, which is `agentSpend`'s
 * precedent: that route re-aggregates the whole transcript history every ten
 * seconds and this is one indexed read that changes when a run ends.
 */

const SPANS: Array<SegmentedOption<string>> = [
  { value: "1", label: "24 hours" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];

export function RepoSpendCard() {
  const [days, setDays] = useState("7");
  const [data, setData] = useState<RepoSpendDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/repo-spend?days=${days}`, {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as Partial<
        RepoSpendDTO & { error: string }
      >;
      if (!res.ok || !json.rows) {
        setError(
          pollFailureMessage(
            res.status,
            json.error ?? (res.ok ? "no rows in the response" : null),
          ),
        );
        return;
      }
      setData(json as RepoSpendDTO);
      setError(null);
    } catch (err) {
      setError(
        pollFailureMessage(null, err instanceof Error ? err.message : String(err)),
      );
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = data?.totals.spentUSD ?? 0;
  const estimated = data?.totals.spentEstUSD ?? 0;

  return (
    // Quiet: `This install, last N hours` leads the band these two share, and
    // it is the one with a ceiling behind it that stops every agent when it
    // trips. This is a report that reaches no guard, which is the same fact the
    // absent meter states.
    <Card emphasis="quiet" className="mb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="mb-0">What each repository cost</CardTitle>
        <SegmentedControl
          options={SPANS}
          value={days}
          onChange={setDays}
          label="Span"
        />
      </div>

      <div role="alert">{error && <Notice tone="danger">{error}</Notice>}</div>

      {!data ? (
        <Empty>Reading runs…</Empty>
      ) : data.rows.length === 0 ? (
        <Empty>No runs were started in this span.</Empty>
      ) : (
        <>
          <ListView box="capped">
            <Table stack>
              <caption className="sr-only">
                What each repository&apos;s runs reported spending over the last{" "}
                {data.days} day{data.days === 1 ? "" : "s"}, highest first
              </caption>
              <THead>
                <tr>
                  <Th className={STICKY_HEAD_FLAT}>Repository</Th>
                  <Th num className={STICKY_HEAD_FLAT}>
                    Runs
                  </Th>
                  <Th num className={STICKY_HEAD_FLAT}>
                    Reported
                  </Th>
                  <Th num className={STICKY_HEAD_FLAT}>
                    Estimated
                  </Th>
                  <Th num className={STICKY_HEAD_FLAT}>
                    Share
                  </Th>
                </tr>
              </THead>
              <TBody>
                {/* Every run lands in a bucket, including the explicit
                    "(not a repository)" row, so the column adds to 100% rather
                    than quietly omitting a remainder. */}
                {data.rows.map((r) => (
                  <Tr key={r.key}>
                    {/* No label: the repository is what the record is.
                        `break-all` below the breakpoint because the label is a
                        path where the row is a repository, and a path has no
                        space in it to wrap at. */}
                    <Td className="max-md:break-all">
                      <span className={r.isRepository ? "mono" : undefined}>
                        {r.label}
                      </span>
                    </Td>
                    <Td num label="Runs">
                      {r.runCount}
                    </Td>
                    <Td num label="Reported">
                      {fmtUSD(r.spentUSD)}
                    </Td>
                    {/* Beside the measured figure and never inside it: a
                        reconciled estimate presented as a measurement is the
                        one thing the split exists to prevent. Em dash rather
                        than $0.00, so "no killed cycles" does not read as a
                        figure somebody could add up. The stacked row keeps them
                        two named lines for the same reason. */}
                    <Td num label="Estimated" className="text-ink-muted">
                      {r.spentEstUSD > 0 ? `+${fmtUSD(r.spentEstUSD)}` : "—"}
                    </Td>
                    <Td num label="Share">
                      {total > 0
                        ? `${Math.round((r.spentUSD / total) * 100)}%`
                        : "—"}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </ListView>
          <p className="mt-3 max-w-[72ch] text-xs text-ink-muted">
            <strong>A floor, not a total.</strong> {fmtUSD(total)} across{" "}
            {data.totals.runCount} run
            {data.totals.runCount === 1 ? "" : "s"} created in this span, as each
            work cycle reported it — a cycle still in flight has reported nothing
            and counts as zero for its whole duration.
            {estimated > 0 && (
              <>
                {" "}
                A further {fmtUSD(estimated)} is reconciled from transcripts for
                cycles killed before they reported, kept in its own column
                because it is an estimate.
              </>
            )}{" "}
            This is not the same reading as the window meters above and must not
            be added to them: those cover every Claude Code transcript on this
            machine, where this covers runs this app started.
          </p>
        </>
      )}
    </Card>
  );
}
