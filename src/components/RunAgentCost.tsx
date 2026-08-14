"use client";

import { useEffect, useState } from "react";
import type { RunAgentSpendDTO } from "@/lib/apiTypes";
import {
  agentOriginBadge,
  fmtRelative,
  fmtTokens,
  fmtUSD,
  pollFailureMessage,
} from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { Meter } from "@/components/Meter";
import { Badge } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Table, Td, Th, Tr } from "@/components/ui/Table";

/**
 * What this run's own turns cost, split by who produced them.
 *
 * The run page already says what the run spent twice over — `runs.spent_usd`,
 * which is what Claude Code reported for each cycle that finished, and
 * telemetry, which is its own per-request figure. Neither can answer "how much
 * of this did the main thread produce itself", because neither records which
 * agent produced a turn. The transcripts do: `attributionAgent` is on the
 * assistant record
 * already, which is why this reading is the *same* source the dashboard meters
 * come from rather than a new one, scoped to one session id.
 *
 * So it is a reading beside the other two and never a correction to either. The
 * three measure the same run by three routes and disagreeing is the expected
 * outcome; adding any pair of them counts the same work twice, which is what the
 * copy at the foot of this card has to keep saying.
 *
 * Its own poll, on its own cadence, for the reason the route documents: this
 * costs a full transcript scan, and the run page's row poll runs every three
 * seconds against an agent competing for the same CPU.
 */

/**
 * Slower than the row poll by an order of magnitude, and deliberately so.
 *
 * A turn only reaches a transcript when Claude Code flushes it, so nothing here
 * moves faster than a completed model turn anyway — polling this at the row's
 * cadence would re-walk `~/.claude` twenty times a minute to learn nothing. The
 * same argument `liveGuardIntervalSeconds` is set by.
 */
const POLL_MS = 30_000;

export function RunAgentCost({
  runId,
  /** Re-read when the run stops, so a finished run settles on its final split. */
  active,
  now,
  /**
   * The agent this run was started as, by name, or null for the ordinary run.
   *
   * Read for one sentence at the foot of the card and by nothing else — the
   * rows, the share and the meter are the transcript's own answer and this must
   * never move a figure. What it buys is that the two readings `--agent` makes
   * possible stop looking like faults: a single row under the agent's name with
   * `(main thread)` empty, and a lone `(main thread)` row on a run whose page
   * says it is the reviewer, are the same card telling the truth about what
   * Claude Code wrote. Which of the two it writes is unmeasured, so the sentence
   * states the run's agent and claims nothing about where its turns landed.
   */
  startedAs = null,
}: {
  runId: string;
  active: boolean;
  now: number;
  startedAs?: string | null;
}) {
  const [spend, setSpend] = useState<RunAgentSpendDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await jsonRequest<{ spend?: RunAgentSpendDTO | null }>(
        `/api/runs/${runId}/agent-cost`,
      );
      if (!alive) return;
      if (!res.ok) {
        // The last good split stays on screen and the notice says the read
        // failed. Blanking it would turn "we could not look" into "there is no
        // agent work", which is the one thing this card must never say.
        setError(pollFailureMessage(res.status, res.error));
        setRead(true);
        return;
      }
      setSpend(res.data.spend ?? null);
      setError(null);
      setRead(true);
    };
    void load();
    if (!active) return () => void (alive = false);
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [runId, active]);

  // Unknown is never zero. Three different things reach this bar as null — the
  // read has not landed, it failed, or the run has no session to read — and each
  // of them is "we do not know what the split is", which is the hatched
  // indeterminate bar rather than a share of 0%.
  const share =
    spend && spend.costUSD > 0 ? spend.delegatedCostUSD / spend.costUSD : null;
  const upperShare =
    spend && spend.costGuardUSD > 0
      ? spend.delegatedCostGuardUSD / spend.costGuardUSD
      : null;

  return (
    <>
      {/* "Outside the main thread" rather than "handed to a specialist",
          because the figure is literally the spend that did not land in
          `MAIN_THREAD_BUCKET` and nothing here knows why it did not. Under
          `--agent` that matters: whether a run started as an agent files its
          own turns under that agent's name is unmeasured, so a label naming
          delegation would be a claim this card cannot support the day the
          answer is "it does". The label says what was counted. */}
      <Meter
        size="compact"
        label="Outside the main thread"
        fraction={share}
        // The gap an unpriced model opens, drawn as the hatched band every other
        // meter here draws it as — the displayed figure stays a floor.
        upperFraction={upperShare}
        unknownHint={
          error
            ? "could not read"
            : !read
              ? "reading…"
              : spend === null
                ? "no session yet"
                : spend.entryCount === 0
                  ? "nothing recorded yet"
                  : // Turns were recorded and our price table placed none of
                    // them, so there is no denominator to take a share of. Said
                    // as its own state rather than folded into "nothing yet",
                    // which would blame the run for a gap in the price table.
                    "no priced turns"
        }
        detail={
          spend
            ? `${fmtUSD(spend.delegatedCostUSD)} of ${fmtUSD(spend.costUSD)} across ${spend.entryCount} ${spend.entryCount === 1 ? "turn" : "turns"}, ${fmtTokens(spend.tokens)} tokens`
            : undefined
        }
      />

      {error && (
        <Notice tone="warn" quiet className="mt-2">
          {error}
        </Notice>
      )}

      {spend && spend.rows.length === 0 && !error && (
        <Empty>
          {active
            ? "No turns recorded for this run yet."
            : "No turns were recorded for this run."}
        </Empty>
      )}

      {spend && spend.rows.length > 0 && (
        <div className="mt-3 overflow-auto rounded-sm border border-line">
          <Table>
            <caption className="sr-only">
              What this run&rsquo;s turns cost, by who produced them, dearest
              first
            </caption>
            <thead>
              <tr>
                <Th>Who</Th>
                <Th num>Cost</Th>
                <Th num>Turns</Th>
              </tr>
            </thead>
            <tbody>
              {spend.rows.map((r) => {
                const mark = agentOriginBadge(r.origin);
                return (
                  <Tr key={r.agent}>
                    <Td>
                      <span className="mono">{r.agent}</span>
                      {mark && (
                        <>
                          {" "}
                          <Badge tone={mark.tone}>{mark.text}</Badge>
                        </>
                      )}
                    </Td>
                    <Td num>{fmtUSD(r.costUSD)}</Td>
                    <Td num>{r.entryCount}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}

      <p className="mt-2 text-xs leading-snug text-ink-muted">
        Priced from your own transcripts for this run&rsquo;s session, so every
        turn lands in a row and the rows add up to the total. A third reading
        beside the two above, never added to either — they measure the same work
        through Claude Code&rsquo;s own reporting.
        {startedAs &&
          ` Started as ${startedAs}, so these rows may sit entirely under that name or entirely under (main thread) — which Claude Code writes is its own bookkeeping.`}
        {spend?.excludedFromTotals &&
          " Sub-agent turns are excluded from the dashboard totals in Settings; they are counted here."}
        {spend ? ` Read up to ${fmtRelative(spend.to, now)}.` : ""}
      </p>
    </>
  );
}
