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
    // It leads its own band on the dashboard and is the only card in it, so
    // `quiet` said "scaffolding" about the one figure on the page that moves
    // while a work cycle is running.
    <Card className="mb-4">
      <CardTitle>
        Live from runs — first-party
        {telemetry.workingRunCount > 0 && (
          <Badge tone="accent">{telemetry.workingRunCount} working</Badge>
        )}
      </CardTitle>

      <LiveTelemetryTotals telemetry={telemetry} now={now} />

      {/* `scrolling` rather than `capped`: this list is already capped at the
          heaviest few runs by `telemetryWindow`, so it has nothing to scroll
          past and a height cap would bound a bound. */}
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

      <div className="mt-3 max-w-[80ch] text-xs text-ink-muted">
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

/**
 * The window's own totals: the dollar figure and the line of volumes under it.
 *
 * One component and not two copies of a `<Stat>`, because two cards draw this
 * now — the band above and `LiveTelemetryAside` beside the meters — and a
 * reader who scrolls from one to the other is checking the same window against
 * itself. Two renderings of `TelemetryWindowDTO` that rounded, pluralised or
 * aged differently would read as two measurements disagreeing, which is the
 * confusion the provenance bands exist to prevent, one source in.
 *
 * The flex wrapper is part of what is shared rather than left to each caller:
 * it is what lets the same block sit on one line in a full-width card and wrap
 * to two in a narrow column, so neither call site has to hold a layout opinion
 * that could drift from the other's.
 */
export function LiveTelemetryTotals({
  telemetry,
  now,
}: {
  telemetry: TelemetryWindowDTO;
  now: number;
}) {
  return (
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
  );
}

/**
 * The same window's headline, in the row of meters at the top of the page.
 *
 * It is up here because this is the only figure on the dashboard that moves
 * *during* a work cycle and it was around 5,700px down — an operator watching a
 * run had to scroll past every derived reading on the page to reach the one
 * number that was still changing. Same division as `ContextControlAside`: the
 * headline rides beside the meters, the per-run derivation stays in its own
 * band, and neither is a second reading of the other because both draw
 * `LiveTelemetryTotals`.
 *
 * The adjacency is the whole risk, and it is worse here than in the band. Down
 * there the separation sentence had four thousand pixels of page between this
 * figure and anything it could be added to; up here the transcript-derived
 * meter is the next box across, so a card that lost the sentence would be a
 * first-party dollar figure standing against a transcript-derived one with
 * nothing in between — see `LiveTelemetry.test.tsx`. Hence the title carries
 * its source and the footnote states the prohibition rather than implying it.
 *
 * `default` against the window card's `primary`, for `ContextControlAside`'s
 * reason: elevation is what says this sits beside the money rather than inside
 * it, and there is at most one `primary` on a screen.
 */
export function LiveTelemetryAside({
  telemetry,
  now,
}: {
  telemetry: TelemetryWindowDTO;
  now: number;
}) {
  return (
    <Card>
      <CardTitle>
        Live from runs — first-party
        {/* The band carries the same badge, and the repetition is the point:
            this card's claim is that it is live, and without the mark it cannot
            tell "a run is spending right now" from "this is what the last five
            hours came to". That distinction is why it is at the top. */}
        {telemetry.workingRunCount > 0 && (
          <Badge tone="accent">{telemetry.workingRunCount} working</Badge>
        )}
      </CardTitle>

      <LiveTelemetryTotals telemetry={telemetry} now={now} />

      <div className="mt-3 space-y-1 text-xs text-ink-muted">
        <div>
          Claude Code&rsquo;s own cost for every API request an agent this app
          spawned made, over the same five hours as the session card.
        </div>
        {/* Word for word the band's claim, minus its direction: "the meters
            above" is true four thousand pixels down and false beside them. */}
        <div>
          Not added to the meters beside it: those are transcript-derived and
          cover every Claude Code session on this machine, so the two measure
          overlapping work in different ways. The budget guard reads the
          transcripts, never this.
        </div>
        {/* Named rather than linked. The band is on this page and an anchor
            would be a control that scrolls, which is not what a reader who has
            just been handed a number needs — they need to know the derivation
            exists and what it is called. */}
        <div>Per run, under &ldquo;Live from runs&rdquo; below.</div>
      </div>
    </Card>
  );
}
