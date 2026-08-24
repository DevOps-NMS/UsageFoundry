"use client";

import type { FilterSavingsDTO, PruneSavingsDTO } from "@/lib/apiTypes";
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

/** One span's net, as a row under the headline. */
function SpanRow({ label, savings }: { label: string; savings: PruneSavingsDTO }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-muted">{label}</span>
      <span className="font-medium tabular-nums text-ink">
        {/* An em dash, never `+$0.00`: a window with no prunes in it and a
            window where pruning earned nothing are different facts, and the
            second one has never been observed. */}
        {savings.prunes === 0 ? "—" : signedUSD(savings.netUSD)}
      </span>
    </div>
  );
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
 * ## Why the two are never added
 *
 * They overlap by construction. Winnow's C1, C3 and B2 rules fire in both, and
 * the filter takes that mass first — it sees the request before Claude Code has
 * finished writing the transcript the pruner reads. The transcript still holds
 * every byte the API never saw, so a prune that removes one of those results
 * counts tokens that were never in the cached prefix and prices re-reads that
 * were never going to happen. Measured across this install's ten largest
 * transcripts that is 4.06% of removed tokens, and the correction needs a
 * `tool_use_id` on each ledger line that winnow does not write yet. Until then
 * a sum is a double count, so the footnote says so rather than letting the
 * adjacency imply otherwise.
 *
 * ## Why the filter leads
 *
 * It acts first, so the pruner's figure is the residual of it rather than the
 * other way round, and it runs on every request where the pruner runs at a
 * cycle boundary — the headline is the half that is always current. It is also
 * the half with no negative term: nothing is edited, so no prefix is thrown
 * away and there is no break-even.
 *
 * ## What it may not do up here
 *
 * `default` against the meters' `primary`, and the footnote, are the two things
 * keeping this away from the money it sits next to. Neither figure is spend:
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

  return (
    <Card>
      <CardTitle>Saved by context control</CardTitle>

      {reason ? (
        <>
          <Stat>—</Stat>
          <StatSub>Intake filter — {reason}</StatSub>
        </>
      ) : (
        <>
          <Stat>{signedUSD(filter.netUSD)}</Stat>
          <StatSub>
            <span className="tabular-nums">
              Intake filter · {spanLabel(filter.totalFrom)} ·{" "}
              {fmtTokens(filter.tokensRemoved)} tokens
            </span>
          </StatSub>
        </>
      )}

      {/* The same hairline the window card puts between its two windows, so
          these read as the rest of one subject rather than as another card's
          worth of figures. The group is labelled because without it "This week"
          would be read as the headline's week, and the headline is the other
          mechanism. */}
      <div className="mt-3 space-y-1.5 border-t border-line pt-2.5 text-sm">
        <div className="text-ink-muted text-xs">Pruning</div>
        {pruning.prunes === 0 ? (
          <div className="text-ink-muted">Nothing pruned yet</div>
        ) : (
          <>
            <SpanRow label={spanLabel(pruningFrom)} savings={pruning} />
            <SpanRow label="This 5-hour window" savings={session} />
            <SpanRow label="This week" savings={weekly} />
          </>
        )}
      </div>

      <div className="mt-3 space-y-1 text-xs text-ink-muted">
        <div>
          Never added: pruning removes from the transcript what the filter had
          already taken off the wire.
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
