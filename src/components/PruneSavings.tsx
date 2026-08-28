"use client";

import type {
  ContextPrunerDTO,
  PruneActivityDTO,
  PruneSavingsDTO,
} from "@/lib/apiTypes";
import { fmtTokens, fmtUSD, signedUSD } from "@/lib/format";
import { TBody, Table, Td, Tr } from "@/components/ui/Table";
import { pruneStatement, prunerLine } from "@/lib/pruneStatement";

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
  pruner,
  activity,
}: {
  label: string;
  savings: PruneSavingsDTO;
  // Required rather than optional, and deliberately: an optional prop falling
  // back to the old single sentence would leave a call site that forgot it
  // rendering the exact ambiguity this pair exists to end, and typechecking.
  pruner: ContextPrunerDTO;
  activity: PruneActivityDTO;
}) {
  // The span's own outcomes. What is *configured* is named once at the top of
  // the card these rows sit in, not three times down it — `filterShareUSD`'s
  // rule for the mechanism beside this one.
  const statement = pruneStatement(activity);
  const {
    prunes,
    pricedPrunes,
    unsettledPrunes,
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
        {/* Five different claims shared this one sentence: pruning switched
            off, winnow absent from the image, nothing worth removing, every
            boundary declined by the payback gate, and a span no cycle has ended
            in. `noFigureReason` refuses exactly that on the filter's half of
            this same card, and the reasons are the same — they call for
            different actions, or for none. */}
        <div className="text-ink-muted text-sm">
          {/* The breakdown where boundaries were reached and none of them cut,
              and what is switched on where none were. Never the single string
              both used to share. */}
          {statement?.text ?? prunerLine(pruner)}
        </div>
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
              {invalidationUSD > 0 ? (
                <>&minus;{fmtUSD(invalidationUSD)}</>
              ) : unsettledPrunes > 0 ? (
                /* The zero that used to say "nothing — all at cycle
                   boundaries". It asserted a cause the value does not carry:
                   the same 0 is produced by a boundary prune nobody has
                   measured yet, and stating it as an observed nothing is what
                   made a loss unrepresentable on this panel. */
                <span className="text-ink-muted">not settled yet</span>
              ) : (
                <span className="text-ink-muted">nothing — measured</span>
              )}
            </Td>
          </Tr>
          <Tr>
            <Td className="font-medium">
              {unsettledPrunes > 0 ? "Net, at most" : "Net"}
            </Td>
            <Td className="tabular-nums text-right font-medium">
              {signedUSD(netUSD)}
            </Td>
          </Tr>
          {/* An upper bound wearing a net's clothes is the one way this panel
              could mislead in the direction it was built to prevent, so it says
              so on the row and again underneath. */}
          {unsettledPrunes > 0 && (
            <Tr>
              <Td className="text-ink-muted" colSpan={2}>
                {unsettledPrunes} of {pricedPrunes}{" "}
                {pricedPrunes === 1 ? "prune has" : "prunes have"} an
                invalidation cost that has not been settled — a boundary prune
                pays nothing only if a plain resume would have rewritten its
                prefix anyway, and that is decided by resumes with no prune
                before them. Until enough of those have been seen, the net above
                is a ceiling.
              </Td>
            </Tr>
          )}
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
          {/* The denominator for the figures above it: money describes the
              boundaries that cut, and this says how many there were. Without
              it a span where four of twelve boundaries cut reads exactly like
              one where four of four did. */}
          {statement && (
            <Tr>
              <Td className="text-ink-muted" colSpan={2}>
                {statement.text}
              </Td>
            </Tr>
          )}
        </TBody>
      </Table>
    </div>
  );
}
