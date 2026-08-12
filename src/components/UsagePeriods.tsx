"use client";

import { useCallback, useRef } from "react";
import type { KeyboardEvent } from "react";
import Link from "next/link";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib and Meter.tsx already do.
import type {
  PeriodGranularityDTO,
  PeriodSeriesDTO,
} from "../lib/apiTypes";
import {
  fmtPct,
  fmtPeriodLabel,
  fmtTokens,
  fmtUSD,
} from "../lib/format";
import { Meter } from "./Meter";
import { Badge } from "./ui/Badge";
import { Card, CardTitle, Empty, Stat, StatSub } from "./ui/Card";
import { Table, TableWrap, Td, Th, Tr } from "./ui/Table";

/**
 * Spend per calendar day, week or month, with each period's share of the
 * ceiling beside it.
 *
 * The two meters above this on the dashboard answer "may I start a run right
 * now"; this answers "what has this been costing me", which is a question the
 * 5-hour block table could only be read sideways to answer. Nothing here feeds
 * a guard — see `buildPeriods`.
 *
 * The load-bearing copy is the ceiling sentence. Anthropic enforces a 5-hour
 * window and a weekly one and nothing in between, so a day's and a month's
 * percentage are measured against the weekly ceiling spread evenly over that
 * span. That is a rate the operator's own configured number implies, not a
 * published allowance, and a reader who takes "82% of today" for an allowance
 * they are about to exhaust has been told something false. `limitBasis` comes
 * off the same computation that produced the fraction, so the sentence cannot
 * drift from the arithmetic.
 */

/** Fixed order, so the tab strip and its keyboard navigation cannot disagree. */
const GRANULARITIES: PeriodGranularityDTO[] = ["day", "week", "month"];

const TAB_LABEL: Record<PeriodGranularityDTO, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** What one bucket is called in a sentence about it. */
const NOUN: Record<PeriodGranularityDTO, string> = {
  day: "day",
  week: "week",
  month: "month",
};

/** Spelled out rather than `${noun}ly`, which produces "dayly". */
const ADJECTIVE: Record<PeriodGranularityDTO, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
};

const HEADING: Record<PeriodGranularityDTO, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

/**
 * Name the ceiling the percentages are measured against, and say when it is a
 * rate rather than a limit.
 *
 * `limit` is the effective ceiling — `limitConfig()` has already taken reserved
 * headroom off the weekly value before it was spread — so a reserve is named
 * here for the same reason the session and weekly cards name it: a meter that
 * disagrees with the figure in Settings reads as a broken calculation.
 */
function ceilingDetail(
  series: PeriodSeriesDTO,
  limit: number | null,
  metric: "cost" | "tokens" | null,
  spanDays: number,
  reserve: number,
): string {
  if (limit === null || metric === null) {
    return "Set a weekly ceiling in Settings to see a percentage.";
  }
  const value = metric === "cost" ? fmtUSD(limit) : `${fmtTokens(limit)} tokens`;
  const afterReserve = reserve > 0 ? ", after reserved headroom" : "";

  if (series.limitBasis === "weekly") {
    return `Ceiling: ${value} for the week${afterReserve} — your configured estimate.`;
  }
  return `Ceiling: ${value} — your weekly ceiling${afterReserve} spread over ${spanDays} ${spanDays === 1 ? "day" : "days"}. Anthropic sets no ${ADJECTIVE[series.granularity]} limit, so this is a pace rather than an allowance.`;
}

export function UsagePeriods({
  series,
  granularity,
  onGranularityChange,
  reservedHeadroomFraction,
}: {
  series: PeriodSeriesDTO;
  granularity: PeriodGranularityDTO;
  onGranularityChange: (g: PeriodGranularityDTO) => void;
  reservedHeadroomFraction: number;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /**
   * Roving tabindex plus arrow keys, because the strip already claims
   * `role="tablist"` and a tablist that answers only to Tab is a promise to a
   * screen reader that the page does not keep.
   */
  const onTabKey = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
      const last = GRANULARITIES.length - 1;
      let next: number;
      if (e.key === "ArrowRight") next = i === last ? 0 : i + 1;
      else if (e.key === "ArrowLeft") next = i === 0 ? last : i - 1;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = last;
      else return;
      e.preventDefault();
      onGranularityChange(GRANULARITIES[next]);
      tabRefs.current[next]?.focus();
    },
    [onGranularityChange],
  );

  const strip = (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label="Period length">
      {GRANULARITIES.map((g, i) => (
        <button
          key={g}
          ref={(el) => {
            tabRefs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`period-tab-${g}`}
          aria-selected={granularity === g}
          aria-controls="period-panel"
          tabIndex={granularity === g ? 0 : -1}
          onKeyDown={(e) => onTabKey(e, i)}
          onClick={() => onGranularityChange(g)}
          // 32px tall in both states, and bordered in both, so selecting one
          // does not nudge the strip. Full class strings either side: Tailwind
          // scans source as text and emits nothing for an interpolated
          // fragment.
          className={`inline-flex h-8 cursor-pointer items-center rounded-full border px-3 text-xs font-medium ${
            granularity === g
              ? "border-accent bg-accent-dim text-ink"
              : "border-line bg-inset text-ink-muted hover:border-line-strong hover:text-ink"
          }`}
        >
          {TAB_LABEL[g]}
        </button>
      ))}
    </div>
  );

  const title = (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <CardTitle className="mb-0">Usage by period</CardTitle>
      {strip}
    </div>
  );

  // The newest bucket is the one in progress, and `buildPeriods` never trims
  // it — but an empty history is still reachable through a mount with no
  // transcripts under it.
  const current = series.buckets[0];
  if (!current) {
    return (
      <Card className="mb-4">
        {title}
        <Empty>No usage recorded yet.</Empty>
      </Card>
    );
  }

  const spanDays = Math.round((current.endsAt - current.startsAt) / 86_400_000);
  const noun = NOUN[series.granularity];

  return (
    <Card className="mb-4">
      {title}

      {/* The direct answer, above the history: what this period has cost and
          what share of the ceiling that is. */}
      <div
        id="period-panel"
        role="tabpanel"
        aria-labelledby={`period-tab-${granularity}`}
        // The panel holds nothing focusable, so it takes focus itself — else a
        // keyboard user arrows through the strip and can never reach what the
        // strip is switching.
        tabIndex={0}
      >
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <Stat>{fmtUSD(current.costUSD)}</Stat>
            <StatSub>
              <span className="tabular-nums">
                {fmtTokens(current.tokens)} tokens ·{" "}
                {current.entryCount.toLocaleString()} turns
              </span>
            </StatSub>
          </div>
          <div className="text-right text-sm font-medium tabular-nums text-ink">
            {fmtPeriodLabel(
              series.granularity,
              current.startsAt,
              current.endsAt,
            )}
            <div className="mt-0.5 text-xs font-normal text-ink-muted">
              this {noun}, so far
            </div>
          </div>
        </div>

        <Meter
          label={`${HEADING[series.granularity]} consumed`}
          fraction={current.fraction}
          upperFraction={current.guardFraction}
          unknownHint="no weekly ceiling set"
          detail={ceilingDetail(
            series,
            current.limit,
            current.fractionMetric,
            spanDays,
            reservedHeadroomFraction,
          )}
        />

        <div className="mt-4">
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{HEADING[series.granularity]}</Th>
                  <Th num>Cost</Th>
                  <Th num>Tokens</Th>
                  <Th num>Turns</Th>
                  <Th num>Used</Th>
                </tr>
              </thead>
              <tbody>
                {series.buckets.map((b) => {
                  // Only meaningful when it exceeds the known reading; equal
                  // values are the normal, fully-priced case. Same rule the
                  // meter's hatched band follows.
                  const hasUpper =
                    b.fraction !== null &&
                    b.guardFraction !== null &&
                    b.guardFraction > b.fraction;
                  return (
                    <Tr key={b.key}>
                      <Td className="whitespace-nowrap tabular-nums">
                        {fmtPeriodLabel(
                          series.granularity,
                          b.startsAt,
                          b.endsAt,
                        )}
                        {b.isCurrent && (
                          <>
                            {" "}
                            <Badge tone="ok">so far</Badge>
                          </>
                        )}
                      </Td>
                      <Td num>{fmtUSD(b.costUSD)}</Td>
                      <Td num>{fmtTokens(b.tokens)}</Td>
                      <Td num>{b.entryCount.toLocaleString()}</Td>
                      <Td num className="whitespace-nowrap">
                        {fmtPct(b.fraction)}
                        {hasUpper && (
                          <span className="text-ink-muted">
                            {" "}
                            – {fmtPct(b.guardFraction)}
                          </span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </div>
      </div>

      <div className="mt-3 max-w-[80ch] text-xs text-ink-muted">
        Calendar {noun}s in <span className="mono">{series.timeZone}</span>,
        priced from the same transcripts as the meters above — so the same floor
        applies.{" "}
        {series.limitBasis === null ? (
          <>
            <Link href="/settings">Set a weekly ceiling</Link> to put a
            percentage against each one.
          </>
        ) : (
          <>
            No budget guard reads these: {ADJECTIVE[series.granularity]} spend is
            history, and what stops a run is the 5-hour and weekly window above.
          </>
        )}
      </div>
    </Card>
  );
}
