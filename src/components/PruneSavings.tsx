"use client";

import type { PruneSavingsDTO } from "@/lib/apiTypes";
import { fmtDate, fmtTokens, fmtUSD } from "@/lib/format";
import { Card, CardTitle, Stat, StatSub } from "@/components/ui/Card";
import { TBody, Table, Td, Tr } from "@/components/ui/Table";

/**
 * The net, signed.
 *
 * U+2212 rather than a hyphen so the minus is the same width as the plus and a
 * column of these does not shift by a pixel as a run's figure crosses zero.
 */
function signedUSD(netUSD: number): string {
  return `${netUSD >= 0 ? "+" : "−"}${fmtUSD(Math.abs(netUSD))}`;
}

/**
 * One span's pruning figures.
 *
 * ## Why the net leads and the gross is under it
 *
 * Every other tool of this kind reports bytes removed and stops. That number is
 * not a saving and can be the opposite of one: an edit to a cached conversation
 * invalidates everything after the cut, so removing a little from a lot costs
 * more than it earns. What is worth reading is the netted figure, so it is the
 * row in the strong weight and the two halves that produce it sit above it,
 * signed, where a reader can see which way each went.
 *
 * `tokensRemoved` is kept because it answers a different question — how much
 * conversation actually went — and because a net of $0.02 over 40,000 removed
 * tokens is a legible statement about a short run, where the net alone reads as
 * nothing happening.
 *
 * ## The two things this must never imply
 *
 * It is **not spend**, and nothing here may be added to a meter. It is the value
 * of an intervention against a counterfactual: the same work without the prune.
 *
 * And a saving is only as final as the run behind it. `turnsAfter` is turns that
 * have already happened, so a live run's figure grows as it works. The caption
 * says so rather than letting a number that moves between two page loads look
 * like a bug.
 */
export function PruneSavingsRows({
  label,
  savings,
}: {
  label: string;
  savings: PruneSavingsDTO;
}) {
  const {
    prunes,
    pricedPrunes,
    tokensRemoved,
    turnsAfter,
    cacheSavedUSD,
    invalidationUSD,
    netUSD,
  } = savings;

  if (prunes === 0) {
    return (
      <div className="mb-3">
        <div className="text-ink-muted text-sm">{label}</div>
        <div className="text-ink-muted text-sm">Nothing pruned in this window.</div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="text-ink mb-1 text-sm font-medium">{label}</div>
      <Table>
        <TBody>
          <Tr>
            <Td>Conversation removed</Td>
            <Td className="tabular-nums text-right">
              {fmtTokens(tokensRemoved)} tokens over {prunes}{" "}
              {prunes === 1 ? "prune" : "prunes"}
            </Td>
          </Tr>
          <Tr>
            <Td>Re-reads it avoided</Td>
            <Td className="tabular-nums text-right">
              +{fmtUSD(cacheSavedUSD)}{" "}
              <span className="text-ink-muted">
                over {turnsAfter} later {turnsAfter === 1 ? "turn" : "turns"}
              </span>
            </Td>
          </Tr>
          <Tr>
            <Td>Restarts it paid for</Td>
            <Td className="tabular-nums text-right">
              {invalidationUSD === 0 ? (
                <span className="text-ink-muted">nothing — all at cycle boundaries</span>
              ) : (
                <>&minus;{fmtUSD(invalidationUSD)}</>
              )}
            </Td>
          </Tr>
          <Tr>
            <Td className="font-medium">Net</Td>
            <Td className="tabular-nums text-right font-medium">
              {signedUSD(netUSD)}
            </Td>
          </Tr>
          {/* Only when it would otherwise mislead. The money above covers the
              priced prunes alone, and a reader has no way to know some were left
              out — a total that silently omits part of its own subject is worse
              than one that says how much it omits. */}
          {pricedPrunes < prunes && (
            <Tr>
              <Td className="text-ink-muted" colSpan={2}>
                Money covers {pricedPrunes} of {prunes} prunes — the rest ran on a
                model with no price here, so what they saved is unknown rather
                than nothing.
              </Td>
            </Tr>
          )}
        </TBody>
      </Table>
    </div>
  );
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
 * Everything pruning has been worth, as a tile for the top of the dashboard
 * beside the window meters.
 *
 * ## Why this is a second surface and not a move
 *
 * The band lower down is the breakdown, and it has to stay one: a net is four
 * figures netted, and a reader deciding whether pruning is worth leaving on
 * needs to see which way each went. What was wrong was that the *conclusion*
 * only existed at the bottom of the page, under three cost-source bands, where
 * nobody scrolling for it knew it was there. So the conclusion comes up here
 * and the arithmetic stays down there.
 *
 * ## What it may not do up here
 *
 * It sits next to money that *is* spend, which is the one adjacency this figure
 * must not borrow from. Hence `default` against the meters' `primary` — the
 * window card still leads, and a second `primary` would mean neither does —
 * and hence the footnote, which is not decoration: it is the only thing on the
 * tile saying this number belongs to no meter beside it.
 *
 * ## Why the total is the headline and the windows are rows
 *
 * The card to its left leads with the 5-hour window because that is the
 * allowance that refills on its own — a *window* is the subject there. Here it
 * is not. "Is pruning worth leaving on" is not a question about this week, and
 * an install that pruned hard a fortnight ago and idled since would have
 * answered it with a dash. So the headline is every receipt still priceable and
 * the two windows stay underneath, where they say whether it is still earning.
 *
 * The total is a **floor** and `totalFrom` is where it starts: past the
 * transcript horizon a receipt cannot be priced at all — see the route. Null
 * means nothing bounded it, and the label says "all time" rather than a date
 * this component invented.
 *
 * Money it could not price at all reads as an em dash, on `SpanRow`'s rule and
 * for a second reason: `+$0.00` under a caption naming a few hundred thousand
 * removed tokens reads as a bug in the arithmetic rather than as a missing
 * price list.
 */
export function PruneSavingsAside({
  total,
  totalFrom,
  session,
  weekly,
}: {
  total: PruneSavingsDTO;
  totalFrom: number | null;
  session: PruneSavingsDTO;
  weekly: PruneSavingsDTO;
}) {
  const span = totalFrom === null ? "All time" : `Since ${fmtDate(totalFrom)}`;
  const removed = `${fmtTokens(total.tokensRemoved)} tokens removed`;

  return (
    <Card>
      <CardTitle>Saved by pruning</CardTitle>

      {total.pricedPrunes === 0 ? (
        <>
          <Stat>—</Stat>
          <StatSub>
            <span className="tabular-nums">{removed}</span>, on a model with no
            price here
          </StatSub>
        </>
      ) : (
        <>
          <Stat>{signedUSD(total.netUSD)}</Stat>
          <StatSub>
            <span className="tabular-nums">
              {span} · {removed}
            </span>
          </StatSub>
        </>
      )}

      {/* The same hairline the window card puts between its two windows, so
          these read as the rest of one subject rather than as another card's
          worth of figures. */}
      <div className="mt-3 space-y-1.5 border-t border-line pt-2.5 text-sm">
        <SpanRow label="This 5-hour window" savings={session} />
        <SpanRow label="This week" savings={weekly} />
      </div>

      <div className="mt-3 space-y-1 text-xs text-ink-muted">
        <div>Re-reads that did not happen, less what the edits cost.</div>
        <div>Not spend, and added to nothing beside it.</div>
        {/* Shortened deliberately: the band carries the counts. What a reader
            needs here is only that the figure is a floor. */}
        {total.pricedPrunes > 0 && total.pricedPrunes < total.prunes && (
          <div>
            Some prunes ran on a model with no price here, so this is a floor.
          </div>
        )}
      </div>
    </Card>
  );
}
