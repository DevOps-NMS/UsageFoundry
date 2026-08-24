"use client";

import type {
  FilterSavingsDTO,
  FilterWindowDTO,
  PruneSavingsDTO,
} from "@/lib/apiTypes";
import { fmtDate, fmtTokens, fmtUSD, signedUSD } from "@/lib/format";
import { Card, CardTitle, Stat, StatSub } from "@/components/ui/Card";
import { TBody, Table, Td, Tr } from "@/components/ui/Table";

/** "All time", or the date the figures start on. */
function spanLabel(totalFrom: number | null): string {
  return totalFrom === null ? "All time" : `Since ${fmtDate(totalFrom)}`;
}

/**
 * Why the filter half has no figure, in the reader's terms.
 *
 * Four states and four sentences, because they call for four different actions:
 * switch it on, look at why the file cannot be opened, wait, or add a price.
 * None of them is `$0.00` — a filter that has never run and a filter that
 * earned nothing are not the same claim, and the second has never been
 * observed.
 */
function noFigureReason(filter: FilterSavingsDTO): string | null {
  if (filter.ledger === "unreadable") {
    return "the ledger is there and this server cannot read it";
  }
  if (!filter.running && filter.ledger === "missing") {
    return "the intake filter is not running here";
  }
  if (filter.ledger === "missing" || filter.ledger === "empty") {
    return "nothing filtered yet";
  }
  if (filter.pricedResults === 0) {
    return `${filter.results} results, on a model with no price here`;
  }
  return null;
}

/** One span's combined net, as a row under the headline. */
function SpanRow({ label, usd }: { label: string; usd: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-muted">{label}</span>
      <span className="font-medium tabular-nums text-ink">
        {/* An em dash, never `+$0.00`: a span with nothing in it and a span
            where context control earned nothing are different facts, and the
            second one has never been observed. */}
        {usd === null ? "—" : signedUSD(usd)}
      </span>
    </div>
  );
}

/** How much of the row above it the filter is responsible for. */
function ShareRow({ usd }: { usd: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 pl-3 text-xs text-ink-muted">
      <span>of which intake filter</span>
      <span className="tabular-nums">{signedUSD(usd)}</span>
    </div>
  );
}

/**
 * The filter's share of one span, or null when this app cannot say what it is.
 *
 * Null in three different situations and deliberately not distinguished here:
 * the ledger could not be read, nothing was filtered inside the span, or what
 * was ran on a model with no price here. All three mean the same thing to the
 * figure above — it is short by an unknown amount — and the headline's own
 * sentence is where the reason is spelled out, once, rather than three times
 * down the card.
 */
function filterShareUSD(
  filter: FilterSavingsDTO,
  span: FilterWindowDTO,
): number | null {
  if (filter.ledger !== "read") return null;
  if (span.results === 0 || span.pricedResults === 0) return null;
  return span.netUSD;
}

/**
 * One span's two halves, added.
 *
 * A half that cannot be read contributes nothing rather than making the row
 * unreadable: every figure on this card is a floor already — unjoined
 * requests, swept transcripts, unpriced models — and a row that vanished
 * because one of two mechanisms had no reading would hide the other one's
 * work. Null only when neither half has anything to say.
 */
function combinedUSD(
  pruning: PruneSavingsDTO,
  share: number | null,
): number | null {
  if (pruning.prunes === 0 && share === null) return null;
  return (pruning.prunes > 0 ? pruning.netUSD : 0) + (share ?? 0);
}

/**
 * What context control has been worth, as a tile for the top of the dashboard
 * beside the window meters.
 *
 * ## Why the title is "context control" and not "pruning"
 *
 * Two mechanisms sit under it. The **intake filter** rewrites a request on its
 * way to the API, replacing a tool result with a pointer past the last cache
 * breakpoint so it is never written and never re-read. The **pruner** edits the
 * transcript between work cycles so the next one resumes a shorter
 * conversation. A card titled for one of them may not carry the other's figure,
 * so the title names the subject both belong to.
 *
 * ## Why the two are added here, and what that costs
 *
 * They overlap by construction. Winnow's C1, C3 and B2 rules fire in both, and
 * the filter takes that mass first — it sees the request before Claude Code has
 * finished writing the transcript the pruner reads. The transcript still holds
 * every byte the API never saw, so a prune that removes one of those results
 * counts tokens that were never in the cached prefix and prices re-reads that
 * were never going to happen. Measured across this install's ten largest
 * transcripts that is 4.06% of pruned tokens, and it is an upper bound; the
 * correction needs a `tool_use_id` on each ledger line that winnow does not
 * write yet.
 *
 * So the sum is wrong by a bounded, measured, known-sign amount, and the choice
 * is between a figure that is a few per cent high with the overstatement
 * printed under it and two figures nobody can combine — which is the question
 * this card exists to answer. It leads with the sum and names the error. The
 * split stays on the card, as a share under each span, because an operator
 * deciding whether to leave *either* mechanism on needs the halves.
 *
 * ## Why the week leads and the filter's share follows
 *
 * The week is the window an operator's allowance is measured in, so it is the
 * span where "what has this been worth" has an answer they can act on. The
 * five-hour window is the one they are inside right now. The all-time total is
 * last because it is history: it answers whether to leave this on, which is
 * decided once.
 *
 * The filter's share hangs off each of those rather than leading, because it
 * acts first and the pruner's figure is the residual of it — a share is what it
 * is, and it moves with how tool-heavy the week was rather than with anything
 * an operator chose.
 *
 * ## What it may not do up here
 *
 * `default` against the meters' `primary`, and the footnote, are the two things
 * keeping this away from the money it sits next to. Neither half is spend:
 * the meters are priced from `usage` frames, which report the request the
 * filter had already rewritten, so both of these are counterfactuals whose
 * value is already absent from every number beside them.
 *
 * The derivation of both stays in a band lower down. A net is three or four
 * figures netted, and an operator deciding whether to leave either on is
 * deciding on which way each went, not on their sum.
 */
export function ContextControlAside({
  filter,
  pruning,
  pruningFrom,
  session,
  weekly,
}: {
  filter: FilterSavingsDTO;
  pruning: PruneSavingsDTO;
  pruningFrom: number | null;
  session: PruneSavingsDTO;
  weekly: PruneSavingsDTO;
}) {
  const reason = noFigureReason(filter);
  const weeklyShare = filterShareUSD(filter, filter.weekly);
  const sessionShare = filterShareUSD(filter, filter.session);
  const weeklyNet = combinedUSD(weekly, weeklyShare);
  // `FilterSavingsDTO` is the total span's own `FilterWindowDTO`, which is what
  // `extends` there is for — the whole reading and one window inside it are the
  // same arithmetic over different spans.
  const totalShare = filterShareUSD(filter, filter);

  return (
    <Card>
      <CardTitle>Saved by context control</CardTitle>

      <Stat>{weeklyNet === null ? "—" : signedUSD(weeklyNet)}</Stat>
      <StatSub>
        <span className="tabular-nums">
          This week ·{" "}
          {weeklyShare !== null ? (
            <>{signedUSD(weeklyShare)} of it from the intake filter</>
          ) : (
            /* Never a share of `+$0.00`. A filter that has not run, one whose
               ledger cannot be read and one that dropped nothing this week are
               three different claims, and none of them is that it earned
               nothing — which has never been observed. */
            <>intake filter: {reason ?? "nothing filtered this week"}</>
          )}
        </span>
      </StatSub>

      {/* The same hairline the window card puts between its two windows, so
          these read as the rest of one subject rather than as another card's
          worth of figures. */}
      <div className="mt-3 space-y-1.5 border-t border-line pt-2.5 text-sm">
        <SpanRow
          label="This 5-hour window"
          usd={combinedUSD(session, sessionShare)}
        />
        {sessionShare !== null && <ShareRow usd={sessionShare} />}
        <SpanRow
          label={spanLabel(pruningFrom)}
          usd={combinedUSD(pruning, totalShare)}
        />
      </div>

      <div className="mt-3 space-y-1 text-xs text-ink-muted">
        <div>
          Up to 4% high: some of what the pruner removed, the filter had already
          taken off the wire, and both count it.
        </div>
        <div>Not spend, and added to nothing beside it.</div>
        {/* Only when the adjacency would otherwise mislead. A history read off a
            ledger nothing is appending to is still worth reading, but it is not
            a reading of now. */}
        {!filter.running && filter.ledger === "read" && (
          <div>The intake filter is not running now; this is its history.</div>
        )}
      </div>
    </Card>
  );
}

/**
 * The intake filter's arithmetic, for the band that carries derivations.
 *
 * ## Why three rows and not one
 *
 * The saving is `2.0·D − 1.0·D + 0.1·D·T`, and the middle term is a real cost:
 * the filter still sends each result once, uncached, before it becomes a
 * pointer. Blending the three would hide that the mechanism pays for itself on
 * the very first request, which is the one property that makes it different
 * from a prune — and a reader has no way to check a figure whose parts are not
 * on the page.
 *
 * ## Why "results" and not "requests"
 *
 * The filter is stateless: it re-drops the same result on every later request
 * that still carries it. Counting ledger lines charges one removal once per
 * surviving request, which overstated this install by 24.8×. Each repeat is
 * already in the third row, at a tenth of the rate, which is what it is worth.
 *
 * Three qualifications sit under the table, each printed only when it is true.
 * They are the difference between a total that is incomplete and one that is
 * wrong, which is the same reason `PruneSavingsRows` prints its own.
 */
export function FilterSavingsRows({ filter }: { filter: FilterSavingsDTO }) {
  if (filter.ledger !== "read" || filter.results === 0) {
    return (
      <div className="text-ink-muted text-sm">
        {noFigureReason(filter) ?? "nothing filtered yet"}.
      </div>
    );
  }

  return (
    <Table>
      <TBody>
        <Tr>
          <Td>Kept out of the request</Td>
          <Td className="tabular-nums text-right">
            {fmtTokens(filter.tokensRemoved)} tokens over {filter.results}{" "}
            {filter.results === 1 ? "result" : "results"}
          </Td>
        </Tr>
        {/* The four money rows are omitted whole rather than printed at zero.
            Every one of them is `× 0` when nothing could be priced, and a
            column of `+$0.00` under a real token count asserts the filter saved
            nothing — which is the one thing this reading has never observed and
            cannot say. The tokens above are a measurement and stay. */}
        {filter.pricedResults === 0 ? (
          <Tr>
            <Td className="text-ink-muted" colSpan={2}>
              What that came to is unknown: every one of them ran on a model
              with no price here, or on a request no transcript still holds.
            </Td>
          </Tr>
        ) : (
          <>
            <Tr>
              <Td>Cache write it avoided</Td>
              <Td className="tabular-nums text-right">
                +{fmtUSD(filter.cacheWriteAvoidedUSD)}
              </Td>
            </Tr>
            <Tr>
              <Td>The one uncached send</Td>
              <Td className="tabular-nums text-right">
                &minus;{fmtUSD(filter.uncachedSendUSD)}
              </Td>
            </Tr>
            <Tr>
              <Td>Re-reads it avoided</Td>
              <Td className="tabular-nums text-right">
                +{fmtUSD(filter.cacheReadAvoidedUSD)}{" "}
                <span className="text-ink-muted">
                  over {filter.turnsAfter} later{" "}
                  {filter.turnsAfter === 1 ? "turn" : "turns"}
                </span>
              </Td>
            </Tr>
            <Tr>
              <Td className="font-medium">Net</Td>
              <Td className="tabular-nums text-right font-medium">
                {signedUSD(filter.netUSD)}
              </Td>
            </Tr>
            {filter.pricedResults < filter.results && (
              <Tr>
                <Td className="text-ink-muted" colSpan={2}>
                  Money covers {filter.pricedResults} of {filter.results}{" "}
                  results — the rest ran on a model with no price here, or on a
                  request no transcript still holds, so what they saved is
                  unknown rather than nothing.
                </Td>
              </Tr>
            )}
          </>
        )}
        {filter.deferredOnly > 0 && (
          <Tr>
            <Td className="text-ink-muted" colSpan={2}>
              {filter.deferredOnly} more were held for a turn and never dropped
              again. The filter moves the cache breakpoint in front of those
              instead, and the ledger does not record whether that worked, so
              they are left out.
            </Td>
          </Tr>
        )}
        {filter.fallbackKeyed > 0 && (
          <Tr>
            <Td className="text-ink-muted" colSpan={2}>
              {filter.fallbackKeyed} of {filter.results} carried no tool id and
              were matched on tool, rule and size instead, which counts two
              identical outputs in one session once.
            </Td>
          </Tr>
        )}
      </TBody>
    </Table>
  );
}
