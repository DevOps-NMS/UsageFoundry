"use client";

import type { ReactNode } from "react";
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
import { Table, Td, Th, Tr } from "./ui/Table";

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

/**
 * What the page's picker offers, in a fixed order.
 *
 * The picker itself is rendered by the page and handed in as `control` — see
 * the prop — but the vocabulary belongs to the card that reads it, so the two
 * cannot come to disagree about what a bucket is called.
 */
export const PERIOD_OPTIONS: ReadonlyArray<{
  value: PeriodGranularityDTO;
  label: string;
}> = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

/** What one bucket is called in a sentence about it. */
const NOUN: Record<PeriodGranularityDTO, string> = {
  day: "day",
  week: "week",
  month: "month",
};

/** "this day" is not English. Spelled out for the same reason ADJECTIVE is. */
const THIS_PERIOD: Record<PeriodGranularityDTO, string> = {
  day: "today",
  week: "this week",
  month: "this month",
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
 * A Finder-style list view: a bordered, rounded box that owns its own scroll
 * region, rather than a full-width web table bleeding to the card's edges.
 *
 * The height cap is what gives the sticky header something to stick inside.
 * `overflow-auto` rather than `overflow-y-auto`, because these tables also
 * overflow sideways on a narrow window — which is what `TableWrap` used to do,
 * and it cannot be used here: a scroll container with no height constraint
 * never scrolls vertically, so a header sticking to its top never moves.
 *
 * Stated here, in `LiveTelemetry` and in the dashboard page separately: the
 * three files that draw a list view are the three the run may touch, and a
 * shared module for them would be a fourth.
 */
const LIST_VIEW = "mt-4 max-h-80 overflow-auto rounded-sm border border-line";

/**
 * `bg-surface` because the rows scroll under it, and the inset shadow because a
 * `border-b` on a sticky cell is not reliably painted under `border-collapse` —
 * the two are the same hairline in the same place wherever both do render.
 */
const STICKY_HEAD =
  "sticky top-0 z-10 bg-surface shadow-[inset_0_-1px_0_var(--border)]";

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
  control,
  reservedHeadroomFraction,
}: {
  series: PeriodSeriesDTO;
  /**
   * The granularity picker, drawn beside the title.
   *
   * It is handed in rather than built here because the kit's
   * `SegmentedControl` reaches `Icon` through a path alias, and this component
   * is unit-tested by `node --test` against the plain CommonJS
   * `tsconfig.test.json` emits — where nothing rewrites that alias. The page
   * already owns the selected granularity, so it renders the control too.
   */
  control?: ReactNode;
  /**
   * Retained so `UsagePeriods.test.tsx` still compiles; both are unread now
   * that the picker is the page's. `series.granularity` is the same value and
   * arrives with the data it describes.
   */
  granularity?: PeriodGranularityDTO;
  onGranularityChange?: (g: PeriodGranularityDTO) => void;
  reservedHeadroomFraction: number;
}) {
  const title = (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <CardTitle className="mb-0">Usage by period</CardTitle>
      {control}
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
          what share of the ceiling that is. It used to sit inside a
          `role="tabpanel"` div carrying its own tabindex, because the picker
          above claimed to be a tablist; the picker is a radiogroup now, so the
          panel is gone with it — a focusable region holding nothing focusable
          is a dead tab stop, and the list names itself with a caption. */}
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
            {THIS_PERIOD[series.granularity]}, so far
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

      <div className={LIST_VIEW}>
        <Table>
          <caption className="sr-only">
            Spend per calendar {noun}, newest first
          </caption>
          <thead>
            <tr>
              <Th className={STICKY_HEAD}>{HEADING[series.granularity]}</Th>
              <Th num className={STICKY_HEAD}>
                Cost
              </Th>
              <Th num className={STICKY_HEAD}>
                Tokens
              </Th>
              <Th num className={STICKY_HEAD}>
                Turns
              </Th>
              <Th num className={STICKY_HEAD}>
                Used
              </Th>
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
                    {fmtPeriodLabel(series.granularity, b.startsAt, b.endsAt)}
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
      </div>

      {/* The meter's own detail already handles the no-ceiling case and the
          page already carries one "set a ceiling" notice, so this says the two
          things neither of them does: which zone the days were cut in, and —
          only where it could be misread — that a pro-rated percentage stops no
          run. Said for a week too, it would imply the weekly window is
          unguarded, which is the opposite of true. */}
      <div className="mt-3 max-w-[80ch] text-xs text-ink-muted">
        Calendar {noun}s in <span className="mono">{series.timeZone}</span>,
        priced from the same transcripts as the meters above — so the same floor
        applies.
        {series.limitBasis === "prorated" && (
          <>
            {" "}
            No budget guard reads a {noun}: what stops a run is the 5-hour and{" "}
            <Link href="/settings">weekly</Link> window above.
          </>
        )}
        {series.completeFrom !== null && (
          <>
            {" "}
            {/* The one thing the buckets themselves cannot say. Transcripts are
                pruned on their own horizon, and a bucket that predates the
                cutoff is priced from files that are no longer there — so it
                reads low rather than reading as missing. */}
            Anything before{" "}
            {new Date(series.completeFrom).toLocaleDateString()} is incomplete:
            transcripts are pruned on the{" "}
            <Link href="/settings#storage">retention horizon</Link>.
          </>
        )}
      </div>
    </Card>
  );
}
