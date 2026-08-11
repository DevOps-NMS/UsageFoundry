"use client";

import Link from "next/link";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib and Meter.tsx already do.
import type { TelemetryWindowDTO } from "../lib/apiTypes";
import { STATUS_TONE, fmtRelative, fmtTokens, fmtUSD } from "../lib/format";
import { Badge } from "./ui/Badge";
import { Card, CardTitle, Stat } from "./ui/Card";
import { Table, TableWrap, Td, Th, Tr } from "./ui/Table";

/**
 * What runs have spent inside the dashboard's 5-hour window, as Claude Code
 * itself reported it.
 *
 * This card exists because a run in flight has nothing else to show. Per-cycle
 * spend lands on `runs.spent_usd` only when the CLI emits its terminal `result`
 * event, so a cycle that is still going reads $0 for its whole duration — and
 * on the dashboard, where the meters cover every session on the machine, the
 * most expensive thing happening right now was invisible as a *cause*.
 *
 * It is a third reading, never a correction to the meters, and the copy has to
 * keep saying so. The meters price every transcript on this machine with our own
 * table; this counts one class of session with Anthropic's; the work overlaps,
 * so a reader who adds the two gets a number that means nothing. That sentence
 * is the load-bearing part of this component — see `LiveTelemetry.test.tsx`.
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
    <Card emphasis="quiet" className="mb-4">
      <CardTitle>
        Live from runs — first-party
        {telemetry.workingRunCount > 0 && (
          <Badge tone="accent">{telemetry.workingRunCount} working</Badge>
        )}
      </CardTitle>

      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Stat>{fmtUSD(telemetry.costUSD)}</Stat>
        <div className="text-xs text-ink-muted">
          {telemetry.requests} API{" "}
          {telemetry.requests === 1 ? "request" : "requests"} ·{" "}
          {fmtTokens(telemetry.tokens)} tokens · {telemetry.runCount}{" "}
          {telemetry.runCount === 1 ? "run" : "runs"} · last request{" "}
          {fmtRelative(telemetry.lastAt, now)}
        </div>
      </div>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>Run</Th>
              <Th>Status</Th>
              <Th num>Cost</Th>
              <Th num>Requests</Th>
              <Th num>Last request</Th>
            </tr>
          </thead>
          <tbody>
            {telemetry.runs.map((r) => (
              <Tr key={r.runId}>
                <Td className="mono">
                  <Link href={`/runs/${r.runId}`}>{r.runId.slice(0, 8)}</Link>
                </Td>
                <Td>
                  {/* A telemetry row can outlive nothing — runs are never
                      deleted — but the join is a LEFT JOIN, so say "unknown"
                      rather than inventing a status. */}
                  {r.status ? (
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td num>{fmtUSD(r.costUSD)}</Td>
                <Td num>{r.requests}</Td>
                <Td num>{fmtRelative(r.lastAt, now)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>

      {/* The total above is over every run in the window; this table is not.
          Same rule as a shortened diff: what was left out is counted, not
          dropped, or the list reads as the whole set. */}
      {unlisted > 0 && (
        <div className="mt-2 text-xs text-ink-faint">
          {unlisted} cheaper {unlisted === 1 ? "run is" : "runs are"} in the
          total above but not listed.
        </div>
      )}

      <div className="mt-3 max-w-[80ch] text-xs text-ink-faint">
        Claude Code&rsquo;s own cost for every API request an agent this app
        spawned made, over the same five hours as the session card. It is the
        only figure here that moves <em>during</em> a work cycle — a run&rsquo;s
        own spend is reported when its cycle ends, so a run in flight reads $0
        until then. Kept apart from the meters above rather than added to them:
        those are transcript-derived and cover every Claude Code session on this
        machine, so the two measure overlapping work in different ways. The
        budget guard reads the transcripts, never this.
      </div>
    </Card>
  );
}
