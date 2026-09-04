"use client";

import Link from "next/link";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib and Meter.tsx already do.
import type { TelemetryWindowDTO } from "../lib/apiTypes";
import { STATUS_TONE, fmtRelative, fmtTokens, fmtUSD } from "../lib/format";
import { Badge } from "./ui/Badge";
import { Card, CardTitle, Stat } from "./ui/Card";
import { ListView, STICKY_HEAD } from "./ui/ListView";
import { TBody, THead, Table, Td, Th, Tr } from "./ui/Table";

/**
 * What runs have spent inside the dashboard's 5-hour window, as Claude Code
 * itself reported it: the window's own total, and the run-by-run derivation of
 * it. One card, in the row of meters at the top of the page.
 *
 * It exists because a run in flight has nothing else to show. Per-cycle spend
 * lands on `runs.spent_usd` only when the CLI emits its terminal `result`
 * event, so a cycle that is still going reads $0 for its whole duration — and
 * on the dashboard, where the meters cover every session on the machine, the
 * most expensive thing happening right now was invisible as a *cause*. It is at
 * the top for the same reason: it is the only figure on this page that moves
 * *during* a work cycle, and in a band of its own it was around 5,700px down.
 *
 * It is a third reading, never a correction to the meters. The meters price
 * every transcript on this machine with our own table, this counts one class of
 * session with Anthropic's, and the work overlaps — so a reader who adds the
 * two gets a number that means nothing. Beside the meters rather than four
 * thousand pixels below them, that addition is one glance away.
 *
 * The card no longer argues that at length. It carried a footnote stating the
 * prohibition and the operator deleted it (2026-09-04): a card in this row is a
 * title and a figure, and three lines of grey prose under one is what the
 * provenance regions further down the page are for. What is left of the claim
 * is two words of the title, so `— first-party` is load-bearing copy rather
 * than a flourish and is pinned in `LiveTelemetry.test.tsx` in its own right.
 * The summing hazard is not reduced by the deletion — the same trade, made the
 * same way and for the same reason, is on record in `ContextOccupancy.tsx`.
 *
 * The per-run table is on this card and not a second one, which is the other
 * half of that edit: two cards under the same heading, one of them a strict
 * subset of the other, are read as two measurements. The cell is narrow — 533px
 * at 1920px, `minmax(0,1fr)` from `xl` and the whole row between `lg` and `xl`
 * — so the table keeps the `ListView`/`stack` pair it had in the wide band
 * rather than dropping columns: sideways scroll above `md`, one block per run
 * below it, and no column of the breakdown lost at any width.
 *
 * `default` against the window card's `primary`, for `ContextControlAside`'s
 * reason: elevation is what says this sits beside the money rather than inside
 * it, and there is at most one `primary` on a screen.
 */
export function LiveTelemetry({
  telemetry,
  now,
}: {
  telemetry: TelemetryWindowDTO;
  now: number;
}) {
  const unlisted = telemetry.runCount - telemetry.runs.length;

  return (
    <Card>
      <CardTitle>
        Live from runs — first-party
        {/* This card's claim is that it is live, and without the mark it cannot
            tell "a run is spending right now" from "this is what the last five
            hours came to". That distinction is why it is at the top. */}
        {telemetry.workingRunCount > 0 && (
          <Badge tone="accent">{telemetry.workingRunCount} working</Badge>
        )}
      </CardTitle>

      {/* The flex wrap is what lets the headline sit on one line in a wide card
          and take two in this column, which is the width it actually has. */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Stat>{fmtUSD(telemetry.costUSD)}</Stat>
        {/* Tabular: every figure on this line moves as the card polls, and a
            proportional digit set shifts the whole sentence sideways when a 1
            becomes an 8. */}
        <div className="text-xs tabular-nums text-ink-muted">
          {telemetry.requests} API{" "}
          {telemetry.requests === 1 ? "request" : "requests"} ·{" "}
          {fmtTokens(telemetry.tokens)} tokens · {telemetry.runCount}{" "}
          {telemetry.runCount === 1 ? "run" : "runs"} · last request{" "}
          {fmtRelative(telemetry.lastAt, now)}
        </div>
      </div>

      {/* `scrolling` rather than `capped`: this list is already capped at the
          heaviest few runs by `telemetryWindow`, so it has nothing to scroll
          past and a height cap would bound a bound. Its sideways scroll is what
          the narrow column is handled with. */}
      <ListView box="scrolling">
        <Table stack>
          <caption className="sr-only">
            Each run&rsquo;s own first-party cost inside this window, heaviest
            first
          </caption>
          <THead>
            <tr>
              <Th className={STICKY_HEAD}>Run</Th>
              <Th className={STICKY_HEAD}>Status</Th>
              <Th num className={STICKY_HEAD}>
                Cost
              </Th>
              <Th num className={STICKY_HEAD}>
                Requests
              </Th>
              <Th num className={STICKY_HEAD}>
                Last request
              </Th>
            </tr>
          </THead>
          <TBody>
            {telemetry.runs.map((r) => (
              <Tr key={r.runId}>
                {/* No label: the run's own id is what the record is. */}
                <Td className="mono whitespace-nowrap">
                  <Link href={`/runs/${r.runId}`}>{r.runId.slice(0, 8)}</Link>
                </Td>
                <Td label="Status">
                  {/* A telemetry row can outlive nothing — runs are never
                      deleted — but the join is a LEFT JOIN, so say "unknown"
                      rather than inventing a status. */}
                  {r.status ? (
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td num label="Cost">
                  {fmtUSD(r.costUSD)}
                </Td>
                <Td num label="Requests">
                  {r.requests}
                </Td>
                <Td num label="Last request" className="whitespace-nowrap">
                  {fmtRelative(r.lastAt, now)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </ListView>

      {/* The total above is over every run in the window; this table is not.
          Same rule as a shortened diff: what was left out is counted, not
          dropped, or the list reads as the whole set. */}
      {unlisted > 0 && (
        <div className="mt-2 text-xs text-ink-muted">
          {unlisted} cheaper {unlisted === 1 ? "run is" : "runs are"} in the
          total above but not listed.
        </div>
      )}
    </Card>
  );
}
