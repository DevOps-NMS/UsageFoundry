"use client";

// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib and UsagePeriods.tsx already do.
import type { SessionBlockDTO } from "../lib/apiTypes";
import { Badge } from "./ui/Badge";
import { Card, CardTitle } from "./ui/Card";
import { ListView, STICKY_HEAD } from "./ui/ListView";
import { TBody, THead, Table, Td, Th, Tr } from "./ui/Table";
import { fmtDateTime, fmtTokens, fmtUSD } from "../lib/format";

/** Every table on the dashboard cuts its tail. What is cut is counted rather
 *  than dropped — see the line under the table. */
const MAX_BLOCK_ROWS = 15;

/**
 * Each recorded 5-hour window, newest first.
 *
 * The token column is summed here rather than read off a field, and that is the
 * one thing in this card that can go quietly wrong: `AggregateDTO` carries five
 * token counts and a window's volume is all five, so dropping one — the 1-hour
 * cache write is the easy one to forget — understates the row against the very
 * meter above it that this table is meant to break down. Nothing throws and the
 * column still looks like a number.
 */
export function RecentBlocksCard({ blocks }: { blocks: SessionBlockDTO[] }) {
  const omitted = Math.max(0, blocks.length - MAX_BLOCK_ROWS);

  return (
    <Card emphasis="quiet" className="mb-4">
      <CardTitle>Recent 5-hour blocks</CardTitle>
      <ListView box="capped">
        <Table stack>
          <caption className="sr-only">
            Each recorded 5-hour window, newest first
          </caption>
          <THead>
            <tr>
              <Th className={STICKY_HEAD}>Started</Th>
              <Th num className={STICKY_HEAD}>
                Tokens
              </Th>
              <Th num className={STICKY_HEAD}>
                Cost
              </Th>
              <Th num className={STICKY_HEAD}>
                Turns
              </Th>
              <Th className={STICKY_HEAD}>Models</Th>
            </tr>
          </THead>
          <TBody>
            {blocks.slice(0, MAX_BLOCK_ROWS).map((b) => (
              <Tr key={b.startsAt}>
                {/* No label: when the window started is what identifies the
                    block, and the "live" badge beside it is part of that. */}
                <Td className="whitespace-nowrap tabular-nums">
                  <span title={new Date(b.startsAt).toLocaleString()}>
                    {fmtDateTime(b.startsAt)}
                  </span>
                  {b.isActive && (
                    <>
                      {" "}
                      <Badge tone="ok">live</Badge>
                    </>
                  )}
                </Td>
                <Td num label="Tokens">
                  {fmtTokens(
                    b.agg.tokens.input +
                      b.agg.tokens.output +
                      b.agg.tokens.cacheRead +
                      b.agg.tokens.cacheWrite5m +
                      b.agg.tokens.cacheWrite1h,
                  )}
                </Td>
                <Td num label="Cost">
                  {fmtUSD(b.agg.costUSD)}
                </Td>
                <Td num label="Turns">
                  {b.agg.entryCount}
                </Td>
                {/* Above the value: a window with three model families in it
                    is a longer string than anything else in the row. */}
                <Td label="Models" labelPlacement="above" className="mono">
                  {b.models.map((m) => m.replace("claude-", "")).join(", ")}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </ListView>
      {omitted > 0 && (
        <div className="mt-2 text-xs tabular-nums text-ink-muted">
          {omitted} older {omitted === 1 ? "block is" : "blocks are"} recorded
          but not listed.
        </div>
      )}
    </Card>
  );
}
